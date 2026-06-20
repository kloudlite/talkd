# talkd installer scripts

## Runtime/assets installer

Installs Sherpa native libraries and model assets into `~/.talkd`:

```bash
./scripts/install-runtime.sh
```

Override install location:

```bash
TALKD_HOME=/opt/talkd ./scripts/install-runtime.sh
```

Installed layout:

```text
~/.talkd/
  bin/
  lib/
    libsherpa-onnx-c-api.{dylib,so}
    libonnxruntime.{dylib,so*}
  models/
    stt/sherpa-onnx-whisper-tiny.en/
    tts/kokoro-en-v0_19/
  talkd.env
```

Supported by the installer: macOS arm64/x64 and Linux x64/arm64. Native Windows is not currently supported by the Unix-socket setup path.

## Pi voice package setup

The Pi package wraps the runtime and binary installers in an idempotent setup script:

```bash
bun --cwd packages/pi-voice run setup:runtime
```

Package installation runs the same setup automatically via `postinstall` when scripts are enabled. Use `TALKD_PI_VOICE_SKIP_SETUP=1` to skip it or `TALKD_PI_VOICE_FORCE_SETUP=1` to force reinstall checks.

The root Dagger gate (`bun run ci`) validates these installer scripts with `bash -n` and checks that distribution-only runtime assets remain installed under `~/.talkd`, not committed as top-level model/vendor folders.

## Binary installer

Copies a built Go service binary into `~/.talkd/bin` and patches its runtime library path to load native libraries from `~/.talkd/lib`.

```bash
cd talkd-service
go build -o bin/talkd-service ./cmd/talkd-service
cd ..

./scripts/install-binary.sh ./talkd-service/bin/talkd-service talkd-service
```

Run:

```bash
~/.talkd/bin/talkd-service
```

The service listens on:

```text
~/.talkd/talkd.sock
```
