#!/usr/bin/env bash
set -euo pipefail

# Best-effort installer for @talkd/pi-voice runtime support.
# It is intentionally idempotent: existing runtime assets and binaries are reused.
#
# Env:
#   TALKD_HOME                         install location, default ~/.talkd
#   TALKD_PI_VOICE_SKIP_SETUP=1        skip all work
#   TALKD_PI_VOICE_FORCE_SETUP=1       run even when assets/binary appear present
#   TALKD_SERVICE_RELEASE_VERSION      GitHub release tag to download, default latest
#   TALKD_SKIP_BINARY_DOWNLOAD=1       skip release binary download and build locally

TALKD_HOME="${TALKD_HOME:-$HOME/.talkd}"
FORCE="${TALKD_PI_VOICE_FORCE_SETUP:-0}"
RELEASE_REPO="${TALKD_SERVICE_RELEASE_REPO:-kloudlite/talkd}"
RELEASE_VERSION="${TALKD_SERVICE_RELEASE_VERSION:-latest}"

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

release_asset_name() {
  local os arch target_os target_arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) target_os="darwin" ;;
    Linux) target_os="linux" ;;
    *) return 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) target_arch="amd64" ;;
    arm64|aarch64) target_arch="arm64" ;;
    *) return 1 ;;
  esac
  printf 'talkd-service-%s-%s.tar.gz\n' "$target_os" "$target_arch"
}

release_download_url() {
  local asset="$1"
  if [ "$RELEASE_VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s\n' "$RELEASE_REPO" "$asset"
  else
    printf 'https://github.com/%s/releases/download/%s/%s\n' "$RELEASE_REPO" "$RELEASE_VERSION" "$asset"
  fi
}

verify_checksum() {
  local checksum="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$checksum"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$checksum"
  else
    warn "No sha256 verifier found; cannot safely install release binary."
    return 1
  fi
}

install_release_binary() {
  [ "${TALKD_SKIP_BINARY_DOWNLOAD:-0}" = "1" ] && return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v tar >/dev/null 2>&1 || return 1

  local asset url tmp
  asset="$(release_asset_name)" || return 1
  url="$(release_download_url "$asset")"
  tmp="$(mktemp -d)"

  log "Downloading published service binary: $asset"
  if ! curl -fsSL -o "$tmp/$asset" "$url"; then
    rm -rf "$tmp"
    warn "No published service binary found at $url"
    return 1
  fi
  if ! curl -fsSL -o "$tmp/$asset.sha256" "$url.sha256"; then
    rm -rf "$tmp"
    warn "Checksum not found for $asset; refusing unsafe binary install."
    return 1
  fi

  (cd "$tmp" && verify_checksum "$asset.sha256") || { rm -rf "$tmp"; return 1; }
  if ! tar xzf "$tmp/$asset" -C "$tmp"; then
    rm -rf "$tmp"
    warn "Could not extract $asset"
    return 1
  fi

  if [ -x "$REPO_ROOT/scripts/install-binary.sh" ]; then
    if ! TALKD_HOME="$TALKD_HOME" "$REPO_ROOT/scripts/install-binary.sh" "$tmp/talkd-service" talkd-service; then
      rm -rf "$tmp"
      return 1
    fi
    if [ -f "$tmp/talkd-client" ]; then
      TALKD_HOME="$TALKD_HOME" "$REPO_ROOT/scripts/install-binary.sh" "$tmp/talkd-client" talkd-client || true
    fi
  else
    mkdir -p "$TALKD_HOME/bin"
    cp "$tmp/talkd-service" "$TALKD_HOME/bin/talkd-service"
    [ -f "$tmp/talkd-client" ] && cp "$tmp/talkd-client" "$TALKD_HOME/bin/talkd-client"
    chmod +x "$TALKD_HOME/bin/talkd-service" "$TALKD_HOME/bin/talkd-client" 2>/dev/null || true
    warn "Installed release binary without rpath patching because install-binary.sh was not found."
  fi
  rm -rf "$tmp"
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

  if install_release_binary; then
    log "Installed published talkd-service binary"
    return
  fi

  if [ ! -d "$REPO_ROOT/talkd-service" ]; then
    warn "talkd-service source not found next to this package."
    warn "Set TALKD_SERVICE_CMD or install $TALKD_HOME/bin/talkd-service manually."
    return
  fi

  if ! command -v go >/dev/null 2>&1; then
    warn "Go is not installed and no published service binary was available."
    warn "Install Go, set TALKD_SERVICE_RELEASE_VERSION to an existing release, or set TALKD_SERVICE_CMD."
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
    if [ -x "$REPO_ROOT/talkd-service/bin/talkd-client" ]; then
      TALKD_HOME="$TALKD_HOME" "$REPO_ROOT/scripts/install-binary.sh" "$REPO_ROOT/talkd-service/bin/talkd-client" talkd-client || true
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
