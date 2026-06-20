package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"

	"talkd/service/internal/protocol"
)

func main() {
	home, _ := os.UserHomeDir()
	sock := flag.String("sock", filepath.Join(home, ".talkd", "talkd.sock"), "socket path")
	mode := flag.String("mode", "tts", "tts or stt")
	text := flag.String("text", "Hello from the talkd socket service.", "tts text")
	in := flag.String("in", "", "input raw pcm16le mono file for stt")
	out := flag.String("out", "socket-output.pcm", "output raw pcm16le file for tts")
	sampleRate := flag.Int("sample-rate", 16000, "input sample rate for stt raw pcm")
	flag.Parse()

	conn, err := net.Dial("unix", *sock)
	must(err)
	defer conn.Close()

	r := bufio.NewReader(conn)
	w := bufio.NewWriter(conn)

	switch *mode {
	case "tts":
		runTTS(r, w, *text, *out)
	case "stt":
		if *in == "" {
			fatal("-in is required for stt; input must be raw pcm16le mono")
		}
		runSTT(r, w, *in, *sampleRate)
	default:
		fatal("unknown mode: " + *mode)
	}
}

func runTTS(r *bufio.Reader, w *bufio.Writer, text, outPath string) {
	must(protocol.Write(w, protocol.Frame{Type: protocol.TypeTTS, Text: text, Speed: 1}))
	must(w.Flush())

	fout, err := os.Create(outPath)
	must(err)
	defer fout.Close()

	for {
		f := mustReadFrame(r)
		switch f.Type {
		case protocol.TypeTTSStart:
			fmt.Fprintf(os.Stderr, "tts start: %d Hz %s\n", f.SampleRate, f.Format)
		case protocol.TypeAudio:
			buf := make([]byte, f.Bytes)
			_, err := io.ReadFull(r, buf)
			must(err)
			_, err = fout.Write(buf)
			must(err)
		case protocol.TypeTTSEnd:
			fmt.Fprintf(os.Stderr, "wrote %s\n", outPath)
			return
		case protocol.TypeError:
			fatal(f.Error)
		}
	}
}

func runSTT(r *bufio.Reader, w *bufio.Writer, inPath string, sampleRate int) {
	data, err := os.ReadFile(inPath)
	must(err)

	must(protocol.Write(w, protocol.Frame{Type: protocol.TypeSTTStart, SampleRate: sampleRate, Channels: 1, Format: protocol.FormatPCM16LE}))
	must(protocol.Write(w, protocol.Frame{Type: protocol.TypeAudio, Bytes: len(data)}))
	_, err = w.Write(data)
	must(err)
	must(protocol.Write(w, protocol.Frame{Type: protocol.TypeSTTEnd}))
	must(w.Flush())

	for {
		f := mustReadFrame(r)
		switch f.Type {
		case protocol.TypeSTTAck:
		case protocol.TypeSTTFinal:
			fmt.Println(f.Text)
			return
		case protocol.TypeError:
			fatal(f.Error)
		}
	}
}

func mustReadFrame(r *bufio.Reader) protocol.Frame {
	f, err := protocol.Read(r)
	must(err)
	return f
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func fatal(s string) {
	fmt.Fprintln(os.Stderr, s)
	os.Exit(1)
}
