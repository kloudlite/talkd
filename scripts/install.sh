#!/usr/bin/env bash
set -euo pipefail

# User-friendly Talkd installer. No git clone: downloads runtime helpers, release
# assets, and a minimal Pi package directory into ~/.talkd.

TALKD_HOME="${TALKD_HOME:-$HOME/.talkd}"
SOURCE_REPO="${TALKD_SOURCE_REPO:-kloudlite/talkd}"
RELEASE_REPO="${TALKD_SERVICE_RELEASE_REPO:-$SOURCE_REPO}"
RELEASE_VERSION="${TALKD_SERVICE_RELEASE_VERSION:-latest}"
REF="${TALKD_REF:-main}"
PACKAGE_DIR="${TALKD_PACKAGE_DIR:-$TALKD_HOME/pi-voice}"
TMP=""

log() { printf '\033[1;34m[talkd install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[talkd install]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[talkd install]\033[0m %s\n' "$*" >&2; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing required command: $1"; exit 1; }
}

cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

detect_platform() {
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64|Darwin:x86_64|Linux:x86_64|Linux:aarch64|Linux:arm64) ;;
    *) err "Unsupported platform: $(uname -s) $(uname -m)"; exit 1 ;;
  esac
}

release_asset_name() {
  local os arch target_os target_arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in Darwin) target_os="darwin" ;; Linux) target_os="linux" ;; *) return 1 ;; esac
  case "$arch" in x86_64|amd64) target_arch="amd64" ;; arm64|aarch64) target_arch="arm64" ;; *) return 1 ;; esac
  printf 'talkd-service-%s-%s.tar.gz\n' "$target_os" "$target_arch"
}

release_url() {
  local asset="$1"
  if [ "$RELEASE_VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s\n' "$RELEASE_REPO" "$asset"
  else
    printf 'https://github.com/%s/releases/download/%s/%s\n' "$RELEASE_REPO" "$RELEASE_VERSION" "$asset"
  fi
}

raw_url() {
  printf 'https://raw.githubusercontent.com/%s/%s/%s\n' "$SOURCE_REPO" "$REF" "$1"
}

source_archive_url() {
  printf 'https://github.com/%s/archive/%s.tar.gz\n' "$SOURCE_REPO" "$REF"
}

verify_checksum() {
  local checksum="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$checksum"
  else
    shasum -a 256 -c "$checksum"
  fi
}

download_helpers() {
  mkdir -p "$TMP/scripts"
  for script in install-runtime.sh install-binary.sh; do
    curl -fsSL -o "$TMP/scripts/$script" "$(raw_url "scripts/$script")"
    chmod +x "$TMP/scripts/$script"
  done
}

install_runtime() {
  log "Installing runtime assets into $TALKD_HOME"
  TALKD_HOME="$TALKD_HOME" "$TMP/scripts/install-runtime.sh"
}

install_release_binary() {
  [ "${TALKD_SKIP_BINARY_DOWNLOAD:-0}" = "1" ] && return 1
  local asset url
  asset="$(release_asset_name)" || return 1
  url="$(release_url "$asset")"

  log "Downloading published service binary: $asset"
  if ! curl -fsSL -o "$TMP/$asset" "$url"; then
    warn "No published service binary found at $url"
    return 1
  fi
  if ! curl -fsSL -o "$TMP/$asset.sha256" "$url.sha256"; then
    warn "Checksum not found for $asset; refusing unsafe binary install."
    return 1
  fi

  (cd "$TMP" && verify_checksum "$asset.sha256") || return 1
  tar xzf "$TMP/$asset" -C "$TMP" || return 1
  TALKD_HOME="$TALKD_HOME" "$TMP/scripts/install-binary.sh" "$TMP/talkd-service" talkd-service || return 1
  [ -f "$TMP/talkd-client" ] && TALKD_HOME="$TALKD_HOME" "$TMP/scripts/install-binary.sh" "$TMP/talkd-client" talkd-client || true
}

unpack_source_archive() {
  local archive="$TMP/source.tar.gz"
  log "Downloading Talkd source archive for fallback files" >&2
  curl -fsSL -o "$archive" "$(source_archive_url)" || return 1
  tar xzf "$archive" -C "$TMP" || return 1
  find "$TMP" -maxdepth 1 -type d -name 'talkd-*' | head -1
}

install_source_binary() {
  [ "${TALKD_SKIP_SOURCE_BUILD:-0}" = "1" ] && return 1
  command -v go >/dev/null 2>&1 || return 1
  local src
  src="$(unpack_source_archive)"
  log "Building talkd-service from source archive"
  (cd "$src/talkd-service" && go build -o bin/talkd-service ./cmd/talkd-service && go build -o bin/talkd-client ./cmd/talkd-client) || return 1
  TALKD_HOME="$TALKD_HOME" "$TMP/scripts/install-binary.sh" "$src/talkd-service/bin/talkd-service" talkd-service || return 1
  TALKD_HOME="$TALKD_HOME" "$TMP/scripts/install-binary.sh" "$src/talkd-service/bin/talkd-client" talkd-client || true
}

install_binary() {
  if [ -x "$TALKD_HOME/bin/talkd-service" ] && [ "${TALKD_FORCE_INSTALL:-0}" != "1" ]; then
    log "talkd-service already installed at $TALKD_HOME/bin/talkd-service"
    return
  fi
  if install_release_binary; then
    log "Installed published talkd-service binary"
    return
  fi
  if install_source_binary; then
    log "Installed source-built talkd-service binary"
    return
  fi
  err "talkd-service binary was not installed. Publish a Talkd release for this OS/arch, install Go for source build fallback, or set TALKD_SERVICE_CMD."
  exit 1
}

install_release_package() {
  [ "${TALKD_SKIP_PACKAGE_DOWNLOAD:-0}" = "1" ] && return 1
  local asset="talkd-pi-voice.tar.gz" url
  url="$(release_url "$asset")"
  log "Downloading published Pi package: $asset"
  if ! curl -fsSL -o "$TMP/$asset" "$url"; then
    warn "No published Pi package found at $url"
    return 1
  fi
  if ! curl -fsSL -o "$TMP/$asset.sha256" "$url.sha256"; then
    warn "Checksum not found for $asset; refusing unsafe package install."
    return 1
  fi
  (cd "$TMP" && verify_checksum "$asset.sha256") || return 1
  tar xzf "$TMP/$asset" -C "$TMP" || return 1
  rm -rf "$PACKAGE_DIR"
  mkdir -p "$(dirname "$PACKAGE_DIR")"
  cp -R "$TMP/pi-voice" "$PACKAGE_DIR"
}

install_source_package() {
  local src
  src="$(find "$TMP" -maxdepth 1 -type d -name 'talkd-*' | head -1 || true)"
  [ -n "$src" ] || src="$(unpack_source_archive)"
  rm -rf "$PACKAGE_DIR"
  mkdir -p "$(dirname "$PACKAGE_DIR")"
  cp -R "$src/packages/pi-voice" "$PACKAGE_DIR"
}

install_package_files() {
  if [ -d "$PACKAGE_DIR/src" ] && [ "${TALKD_FORCE_INSTALL:-0}" != "1" ]; then
    log "Pi package files already installed at $PACKAGE_DIR"
    return
  fi
  install_release_package || install_source_package
}

install_pi_package() {
  if [ "${TALKD_SKIP_PI_INSTALL:-0}" = "1" ]; then
    warn "Skipping Pi package registration by TALKD_SKIP_PI_INSTALL=1"
    return
  fi
  if ! command -v pi >/dev/null 2>&1; then
    warn "Pi CLI not found; install/register later: pi install $PACKAGE_DIR"
    return
  fi
  log "Registering Talkd with Pi"
  pi install "$PACKAGE_DIR" || warn "Pi package registration failed; run manually: pi install $PACKAGE_DIR"
}

print_next_steps() {
  cat <<EOF

Talkd install complete.

Next steps:
  1. Start or reload Pi:
       pi
       /reload   # if Pi is already running

  2. Press F12 in Pi to record with Talkd.

Useful paths:
  Runtime assets: $TALKD_HOME
  Service binary: $TALKD_HOME/bin/talkd-service
  Pi package:     $PACKAGE_DIR

EOF
  if ! command -v rec >/dev/null 2>&1; then
    cat <<'EOF'
Microphone note:
  The default recorder uses SoX `rec`. Install SoX or set TALKD_RECORD_CMD.

EOF
  fi
}

main() {
  detect_platform
  need_cmd curl
  need_cmd tar
  need_cmd mktemp
  command -v sha256sum >/dev/null 2>&1 || need_cmd shasum

  TMP="$(mktemp -d)"
  mkdir -p "$TALKD_HOME"
  download_helpers
  install_runtime
  install_binary
  install_package_files
  install_pi_package
  print_next_steps
}

main "$@"
