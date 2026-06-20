package server

import (
	"bufio"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"

	"talkd/service/internal/protocol"
	"talkd/service/internal/speech"
)

type Server struct {
	SocketPath string
	Engine     *speech.Engine
}

func (s *Server) ListenAndServe() error {
	if s.Engine == nil {
		return errors.New("server engine is nil")
	}
	if s.SocketPath == "" {
		return errors.New("socket path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(s.SocketPath), 0o755); err != nil {
		return err
	}
	_ = os.Remove(s.SocketPath)

	ln, err := net.Listen("unix", s.SocketPath)
	if err != nil {
		return err
	}
	defer ln.Close()
	if err := os.Chmod(s.SocketPath, 0o600); err != nil {
		return err
	}

	log.Printf("talkd service listening on unix://%s", s.SocketPath)
	log.Printf("protocol: newline JSON frames + optional binary payload")

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Println("accept:", err)
			continue
		}
		go s.handleConn(conn)
	}
}

func (s *Server) handleConn(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	w := bufio.NewWriter(conn)
	defer w.Flush()

	for {
		f, err := protocol.Read(r)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Println("read frame:", err)
			}
			return
		}

		switch f.Type {
		case protocol.TypePing:
			_ = protocol.Write(w, protocol.Frame{Type: protocol.TypePong})
			_ = w.Flush()
		case protocol.TypeTTS:
			err := s.handleTTS(w, f)
			if err != nil {
				_ = protocol.Write(w, protocol.Frame{Type: protocol.TypeError, Error: err.Error()})
			}
			_ = w.Flush()
		case protocol.TypeSTTStart:
			err := s.handleSTT(r, w, f)
			if err != nil {
				_ = protocol.Write(w, protocol.Frame{Type: protocol.TypeError, Error: err.Error()})
			}
			_ = w.Flush()
		default:
			_ = protocol.Write(w, protocol.Frame{Type: protocol.TypeError, Error: "unknown frame type: " + f.Type})
			_ = w.Flush()
		}
	}
}

func (s *Server) handleTTS(w *bufio.Writer, req protocol.Frame) error {
	sampleRate := s.Engine.TTSSampleRate()
	if err := protocol.Write(w, protocol.Frame{
		Type:       protocol.TypeTTSStart,
		SampleRate: sampleRate,
		Channels:   1,
		Format:     protocol.FormatPCM16LE,
	}); err != nil {
		return err
	}
	if err := w.Flush(); err != nil {
		return err
	}

	_, err := s.Engine.GenerateTTS(speech.TTSRequest{
		Text:  req.Text,
		Speed: req.Speed,
		Sid:   req.Sid,
	}, func(chunk speech.TTSChunk) bool {
		if len(chunk.PCM16LE) == 0 {
			return true
		}
		if err := protocol.Write(w, protocol.Frame{
			Type:     protocol.TypeAudio,
			Bytes:    len(chunk.PCM16LE),
			Progress: chunk.Progress,
		}); err != nil {
			return false
		}
		if _, err := w.Write(chunk.PCM16LE); err != nil {
			return false
		}
		return w.Flush() == nil
	})
	if err != nil {
		return err
	}

	return protocol.Write(w, protocol.Frame{Type: protocol.TypeTTSEnd, SampleRate: sampleRate})
}

func (s *Server) handleSTT(r *bufio.Reader, w *bufio.Writer, start protocol.Frame) error {
	if start.Channels == 0 {
		start.Channels = 1
	}
	if start.Channels != 1 {
		return errors.New("only mono audio is supported")
	}
	if start.Format == "" {
		start.Format = protocol.FormatPCM16LE
	}
	if start.Format != protocol.FormatPCM16LE {
		return errors.New("only pcm_s16le is supported")
	}
	if start.SampleRate == 0 {
		start.SampleRate = 16000
	}

	sess := s.Engine.NewSTTSession(start.SampleRate)
	defer sess.Close()

	for {
		f, err := protocol.Read(r)
		if err != nil {
			return err
		}
		switch f.Type {
		case protocol.TypeAudio:
			if f.Bytes <= 0 {
				return errors.New("audio frame has invalid byte count")
			}
			buf := make([]byte, f.Bytes)
			if _, err := io.ReadFull(r, buf); err != nil {
				return err
			}
			sess.AcceptPCM16LE(buf)
			_ = protocol.Write(w, protocol.Frame{Type: protocol.TypeSTTAck, Bytes: f.Bytes})
			_ = w.Flush()
		case protocol.TypeSTTEnd:
			text, err := sess.Decode()
			if err != nil {
				return err
			}
			return protocol.Write(w, protocol.Frame{Type: protocol.TypeSTTFinal, Text: text})
		default:
			return errors.New("expected audio or stt_end frame, got: " + f.Type)
		}
	}
}
