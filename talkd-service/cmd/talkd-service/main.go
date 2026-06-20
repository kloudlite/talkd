package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"

	"talkd/service/internal/server"
	"talkd/service/internal/speech"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	home, _ := os.UserHomeDir()
	defaultHome := filepath.Join(home, ".talkd")
	talkdHome := flag.String("home", getenv("TALKD_HOME", defaultHome), "talkd home directory")
	sockPath := flag.String("sock", "", "Unix socket path; default: $TALKD_HOME/talkd.sock")
	threads := flag.Int("threads", 4, "number of inference threads")
	debug := flag.Int("debug", 0, "1 to enable Sherpa debug logs")
	provider := flag.String("provider", "cpu", "Sherpa provider, e.g. cpu/coreml/cuda")
	flag.Parse()

	if *sockPath == "" {
		*sockPath = filepath.Join(*talkdHome, "talkd.sock")
	}

	engine, err := speech.New(speech.Config{
		STTModelDir: filepath.Join(*talkdHome, "models", "stt", "sherpa-onnx-whisper-tiny.en"),
		TTSModelDir: filepath.Join(*talkdHome, "models", "tts", "kokoro-en-v0_19"),
		Provider:    *provider,
		Threads:     *threads,
		Debug:       *debug,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer engine.Close()

	srv := &server.Server{SocketPath: *sockPath, Engine: engine}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
