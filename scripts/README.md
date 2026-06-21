# talkd installer scripts

## One-command installer

```bash
curl -fsSL https://raw.githubusercontent.com/kloudlite/talkd/main/scripts/install.sh | bash
```

This detects macOS arm64/x64 or Linux x64/arm64, clones Talkd to `~/.talkd/src/talkd`, runs the existing package/runtime setup, downloads the matching verified published service binary when available, and registers the Pi package when the `pi` CLI is available. If no published binary exists, setup falls back to a local Go build when Go is installed.

Overrides:

```bash
TALKD_INSTALL_DIR=/opt/talkd-src TALKD_REF=main TALKD_SERVICE_RELEASE_VERSION=v0.1.0 TALKD_SKIP_PI_INSTALL=1 \
  bash scripts/install.sh
```

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

The Pi package wraps the runtime and binary installers in an idempotent setup script. It tries a verified GitHub release binary first, then falls back to a local Go build:

```bash
bun --cwd packages/pi-voice run setup:runtime
```

Package installation runs the same setup automatically via `postinstall` when scripts are enabled. Use `TALKD_PI_VOICE_SKIP_SETUP=1` to skip it, `TALKD_PI_VOICE_FORCE_SETUP=1` to force reinstall checks, `TALKD_SERVICE_RELEASE_VERSION=vX.Y.Z` to pin a release, or `TALKD_SKIP_BINARY_DOWNLOAD=1` to force source build.

The root Dagger gate (`bun run ci`) validates these installer scripts with `bash -n` and checks that distribution-only runtime assets remain installed under `~/.talkd`, not committed as top-level model/vendor folders.

## Release binary workflow

`.github/workflows/release.yml` builds service archives for `linux-amd64`, `linux-arm64`, `darwin-amd64`, and `darwin-arm64`.

- Manual `workflow_dispatch` with no input: builds and uploads workflow artifacts only. Good dry run; no GitHub Release is published.
- Tag push `v*`: builds artifacts and publishes release assets.
- Manual `workflow_dispatch` with `release_tag`: publishes only if that existing tag starts with `v`; the workflow refuses to create an implicit tag.

Each release asset has a matching `.sha256`; the installer verifies it before installing.

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
