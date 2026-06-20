# talkd-service

Single-process local speech service using Sherpa ONNX.

## Packages

```text
cmd/talkd-service   service binary
cmd/talkd-client    test client
internal/protocol   newline JSON frame protocol
internal/server     Unix socket server
internal/speech     in-process Sherpa STT/TTS wrapper
```

## Protocol

Transport: Unix domain socket.

Default socket:

```text
~/.talkd/talkd.sock
```

The service accepts multiple client sessions. Each connection is handled independently; STT/TTS inference is coordinated inside the single service process.

Control frames are newline-delimited JSON. If a frame has `bytes`, exactly that many raw bytes follow the newline.

### TTS

Client sends:

```json
{"type":"tts","text":"Hello","speed":1}
```

Server responds:

```json
{"type":"tts_start","sample_rate":24000,"channels":1,"format":"pcm_s16le"}
{"type":"audio","bytes":4096}
<4096 raw PCM16LE bytes>
{"type":"tts_end","sample_rate":24000}
```

### STT

Client sends:

```json
{"type":"stt_start","sample_rate":16000,"channels":1,"format":"pcm_s16le"}
{"type":"audio","bytes":3200}
<3200 raw PCM16LE bytes>
{"type":"stt_end"}
```

Server responds:

```json
{"type":"stt_ack","bytes":3200}
{"type":"stt_final","text":"recognized text"}
```

## Build

Local build:

```bash
go build -o bin/talkd-service ./cmd/talkd-service
go build -o bin/talkd-client ./cmd/talkd-client
```

Containerized distribution build/check/test is run from the repository root through Dagger:

```bash
bun run dagger:build
bun run dagger:test
```

## Run

```bash
./bin/talkd-service
```

## Test

TTS:

```bash
./bin/talkd-client -mode tts -text "Hello from talkd." -out /tmp/talkd.pcm
ffmpeg -y -f s16le -ar 24000 -ac 1 -i /tmp/talkd.pcm /tmp/talkd.wav
afplay /tmp/talkd.wav
```

STT:

```bash
ffmpeg -y -i /tmp/talkd.wav -ar 16000 -ac 1 -f s16le /tmp/talkd-stt.pcm
./bin/talkd-client -mode stt -in /tmp/talkd-stt.pcm -sample-rate 16000
```
