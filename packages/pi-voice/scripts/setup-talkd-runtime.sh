#!/usr/bin/env bash
set -euo pipefail

# Best-effort installer for @talkd/pi-voice runtime support.
# It is intentionally idempotent: existing runtime assets and binaries are reused.
#
# Env:
#   TALKD_HOME                         install location, default ~/.talkd
#   TALKD_PI_VOICE_SKIP_SETUP=1        skip all work
#   TALKD_PI_VOICE_FORCE_SETUP=1       run even when assets/binary appear present

TALKD_HOME="${TALKD_HOME:-$HOME/.talkd}"
FORCE="${TALKD_PI_VOICE_FORCE_SETUP:-0}"

log() { printf '\033[1;34m[pi-voice setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pi-voice setup]\033[0m %s\n' "$*" >&2; }

if [ "${TALKD_PI_VOICE_SKIP_SETUP:-0}" = "1" ] || [ "${TALKD_SKIP_INSTALL:-0}" = "1" ]; then
  log "Skipping setup by environment override"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." 2>/dev/null && pwd || true)"

runtime_present() {
  [ -d "$TALKD_HOME/models/stt/sherpa-onnx-whisper-tiny.en" ] &&
    [ -d "$TALKD_HOME/models/tts/kokoro-en-v0_19" ] &&
    { [ -f "$TALKD_HOME/lib/libsherpa-onnx-c-api.dylib" ] || [ -f "$TALKD_HOME/lib/libsherpa-onnx-c-api.so" ]; }
}

binary_present() {
  [ -x "$TALKD_HOME/bin/talkd-service" ]
}

install_runtime() {
  if [ "$FORCE" != "1" ] && runtime_present; then
    log "Runtime assets already installed in $TALKD_HOME"
    return
  fi

  if [ -x "$REPO_ROOT/scripts/install-runtime.sh" ]; then
    log "Installing native runtime libraries and model assets"
    if ! TALKD_HOME="$TALKD_HOME" "$REPO_ROOT/scripts/install-runtime.sh"; then
      warn "Runtime asset installation failed. Voice service startup may fail until assets are installed."
    fi
  else
    warn "Runtime installer not found. Expected: $REPO_ROOT/scripts/install-runtime.sh"
    warn "Install runtime assets manually or run from a full talkd checkout."
  fi
}

install_binary() {
  if [ "$FORCE" != "1" ] && binary_present; then
    log "talkd-service binary already installed at $TALKD_HOME/bin/talkd-service"
    return
  fi

  if [ ! -d "$REPO_ROOT/talkd-service" ]; then
    warn "talkd-service source not found next to this package."
    warn "Set TALKD_SERVICE_CMD or install $TALKD_HOME/bin/talkd-service manually."
    return
  fi

  if ! command -v go >/dev/null 2>&1; then
    warn "Go is not installed; cannot build talkd-service."
    warn "Install Go, then run: bun --cwd packages/pi-voice run setup:runtime"
    return
  fi

  log "Building talkd-service"
  if ! (cd "$REPO_ROOT/talkd-service" && go build -o bin/talkd-service ./cmd/talkd-service && go build -o bin/talkd-client ./cmd/talkd-client); then
    warn "talkd-service build failed. Set TALKD_SERVICE_CMD or install the service binary manually."
    return
  fi

  if [ -x "$REPO_ROOT/scripts/install-binary.sh" ]; then
    log "Installing talkd-service binary"
    if ! TALKD_HOME="$TALKD_HOME" "$REPO_ROOT/scripts/install-binary.sh" "$REPO_ROOT/talkd-service/bin/talkd-service" talkd-service; then
      warn "Binary installer failed. Set TALKD_SERVICE_CMD or install the service binary manually."
    fi
  else
    mkdir -p "$TALKD_HOME/bin"
    cp "$REPO_ROOT/talkd-service/bin/talkd-service" "$TALKD_HOME/bin/talkd-service"
    chmod +x "$TALKD_HOME/bin/talkd-service"
    warn "Installed binary without rpath patching because install-binary.sh was not found."
  fi
}

main() {
  mkdir -p "$TALKD_HOME"
  install_runtime
  install_binary
  log "Setup complete"
}

main "$@"
