package protocol

import (
	"bufio"
	"encoding/json"
)

// Frame is the newline-delimited JSON control frame used by the Unix socket
// protocol. Binary payloads, when present, immediately follow the JSON line.
//
// Example audio frame:
//
//	{"type":"audio","bytes":3200}\n<3200 raw bytes>
type Frame struct {
	Type       string  `json:"type"`
	Text       string  `json:"text,omitempty"`
	Bytes      int     `json:"bytes,omitempty"`
	SampleRate int     `json:"sample_rate,omitempty"`
	Format     string  `json:"format,omitempty"`
	Channels   int     `json:"channels,omitempty"`
	Speed      float32 `json:"speed,omitempty"`
	Sid        int     `json:"sid,omitempty"`
	Error      string  `json:"error,omitempty"`
	Progress   float32 `json:"progress,omitempty"`
}

const (
	TypePing     = "ping"
	TypePong     = "pong"
	TypeError    = "error"
	TypeTTS      = "tts"
	TypeTTSStart = "tts_start"
	TypeTTSEnd   = "tts_end"
	TypeSTTStart = "stt_start"
	TypeSTTEnd   = "stt_end"
	TypeSTTAck   = "stt_ack"
	TypeSTTFinal = "stt_final"
	TypeAudio    = "audio"

	FormatPCM16LE = "pcm_s16le"
)

func Read(r *bufio.Reader) (Frame, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return Frame{}, err
	}
	var f Frame
	if err := json.Unmarshal(line, &f); err != nil {
		return Frame{}, err
	}
	return f, nil
}

func Write(w *bufio.Writer, f Frame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	if _, err := w.Write(b); err != nil {
		return err
	}
	return w.WriteByte('\n')
}
