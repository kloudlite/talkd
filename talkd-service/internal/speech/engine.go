package speech

import (
	"errors"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	sherpa "github.com/k2-fsa/sherpa-onnx-go/sherpa_onnx"
)

type Config struct {
	STTModelDir string
	TTSModelDir string
	Provider    string
	Threads     int
	Debug       int
}

type Engine struct {
	stt *sherpa.OfflineRecognizer
	tts *sherpa.OfflineTts

	sttMu sync.Mutex
	ttsMu sync.Mutex
}

type TTSRequest struct {
	Text  string
	Speed float32
	Sid   int
}

type TTSChunk struct {
	PCM16LE  []byte
	Progress float32
}

type TTSChunkFunc func(TTSChunk) bool

type TTSResult struct {
	SampleRate int
	Samples    int
}

func New(cfg Config) (*Engine, error) {
	if cfg.Provider == "" {
		cfg.Provider = "cpu"
	}
	if cfg.Threads <= 0 {
		cfg.Threads = 4
	}

	log.Println("loading STT model from", cfg.STTModelDir)
	sttConfig := sherpa.OfflineRecognizerConfig{}
	sttConfig.FeatConfig.SampleRate = 16000
	sttConfig.FeatConfig.FeatureDim = 80
	sttConfig.ModelConfig.Whisper.Encoder = filepath.Join(cfg.STTModelDir, "tiny.en-encoder.int8.onnx")
	sttConfig.ModelConfig.Whisper.Decoder = filepath.Join(cfg.STTModelDir, "tiny.en-decoder.int8.onnx")
	sttConfig.ModelConfig.Whisper.Language = "en"
	sttConfig.ModelConfig.Whisper.Task = "transcribe"
	sttConfig.ModelConfig.Whisper.TailPaddings = -1
	sttConfig.ModelConfig.Tokens = filepath.Join(cfg.STTModelDir, "tiny.en-tokens.txt")
	sttConfig.ModelConfig.NumThreads = cfg.Threads
	sttConfig.ModelConfig.Debug = cfg.Debug
	sttConfig.ModelConfig.Provider = cfg.Provider
	sttConfig.DecodingMethod = "greedy_search"

	stt := sherpa.NewOfflineRecognizer(&sttConfig)
	if stt == nil {
		return nil, errors.New("failed to create STT recognizer")
	}

	log.Println("loading TTS model from", cfg.TTSModelDir)
	ttsConfig := sherpa.OfflineTtsConfig{}
	ttsConfig.Model.Kokoro.Model = filepath.Join(cfg.TTSModelDir, "model.onnx")
	ttsConfig.Model.Kokoro.Voices = filepath.Join(cfg.TTSModelDir, "voices.bin")
	ttsConfig.Model.Kokoro.Tokens = filepath.Join(cfg.TTSModelDir, "tokens.txt")
	ttsConfig.Model.Kokoro.DataDir = filepath.Join(cfg.TTSModelDir, "espeak-ng-data")
	ttsConfig.Model.Kokoro.LengthScale = 1.0
	ttsConfig.Model.NumThreads = cfg.Threads
	ttsConfig.Model.Debug = cfg.Debug
	ttsConfig.Model.Provider = cfg.Provider
	ttsConfig.MaxNumSentences = 1
	ttsConfig.SilenceScale = 0.2

	tts := sherpa.NewOfflineTts(&ttsConfig)
	if tts == nil {
		sherpa.DeleteOfflineRecognizer(stt)
		return nil, errors.New("failed to create TTS model")
	}

	log.Printf("TTS sample_rate=%d speakers=%d", tts.SampleRate(), tts.NumSpeakers())
	return &Engine{stt: stt, tts: tts}, nil
}

func (e *Engine) Close() {
	if e.tts != nil {
		sherpa.DeleteOfflineTts(e.tts)
		e.tts = nil
	}
	if e.stt != nil {
		sherpa.DeleteOfflineRecognizer(e.stt)
		e.stt = nil
	}
}

func (e *Engine) TTSSampleRate() int {
	return e.tts.SampleRate()
}

func (e *Engine) GenerateTTS(req TTSRequest, cb TTSChunkFunc) (*TTSResult, error) {
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return nil, errors.New("tts text is empty")
	}
	if req.Speed == 0 {
		req.Speed = 1.0
	}

	cfg := sherpa.GenerationConfig{SilenceScale: 0.2, Speed: req.Speed, Sid: req.Sid}

	start := time.Now()
	e.ttsMu.Lock()
	generated := e.tts.GenerateWithConfig(text, &cfg, func(samples []float32, progress float32) bool {
		if cb == nil || len(samples) == 0 {
			return true
		}
		return cb(TTSChunk{PCM16LE: float32ToPCM16LE(samples), Progress: progress})
	})
	e.ttsMu.Unlock()

	if generated == nil {
		return nil, errors.New("tts generation failed")
	}

	log.Printf("tts generated %.2fs audio in %s", float32(len(generated.Samples))/float32(generated.SampleRate), time.Since(start).Round(time.Millisecond))
	return &TTSResult{SampleRate: generated.SampleRate, Samples: len(generated.Samples)}, nil
}

func (e *Engine) NewSTTSession(sampleRate int) *STTSession {
	if sampleRate <= 0 {
		sampleRate = 16000
	}
	return &STTSession{
		engine:     e,
		sampleRate: sampleRate,
		stream:     sherpa.NewOfflineStream(e.stt),
	}
}

type STTSession struct {
	engine     *Engine
	sampleRate int
	stream     *sherpa.OfflineStream
	samples    int
}

func (s *STTSession) AcceptPCM16LE(b []byte) {
	floats := pcm16LEToFloat32(b)
	s.samples += len(floats)
	s.stream.AcceptWaveform(s.sampleRate, floats)
}

func (s *STTSession) Decode() (string, error) {
	if s.stream == nil {
		return "", errors.New("stt stream is closed")
	}
	start := time.Now()
	s.engine.sttMu.Lock()
	s.engine.stt.Decode(s.stream)
	s.engine.sttMu.Unlock()
	result := s.stream.GetResult()
	log.Printf("stt decoded %.2fs audio in %s", float32(s.samples)/float32(s.sampleRate), time.Since(start).Round(time.Millisecond))
	return strings.TrimSpace(result.Text), nil
}

func (s *STTSession) Close() {
	if s.stream != nil {
		sherpa.DeleteOfflineStream(s.stream)
		s.stream = nil
	}
}

func pcm16LEToFloat32(b []byte) []float32 {
	// Kept local to avoid exporting an audio package dependency from speech.
	n := len(b) / 2
	out := make([]float32, n)
	for i := 0; i < n; i++ {
		v := int16(uint16(b[i*2]) | uint16(b[i*2+1])<<8)
		out[i] = float32(v) / 32768.0
	}
	return out
}

func float32ToPCM16LE(samples []float32) []byte {
	out := make([]byte, len(samples)*2)
	for i, s := range samples {
		if s > 1 {
			s = 1
		} else if s < -1 {
			s = -1
		}
		v := int16(s * 32767)
		out[i*2] = byte(v)
		out[i*2+1] = byte(uint16(v) >> 8)
	}
	return out
}
