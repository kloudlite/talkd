#!/usr/bin/env bash
set -euo pipefail

# User-friendly Talkd installer. Fetches the source checkout, installs workspace
# deps, reuses the existing runtime setup, and optionally registers the Pi package.

REPO_URL="${TALKD_REPO_URL:-https://github.com/kloudlite/talkd.git}"
REF="${TALKD_REF:-main}"
INSTALL_DIR="${TALKD_INSTALL_DIR:-$HOME/.talkd/src/talkd}"

log() { printf '\033[1;34m[talkd install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[talkd install]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[talkd install]\033[0m %s\n' "$*" >&2; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    err "Missing required command: $1"
    exit 1
  }
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64|Darwin:x86_64|Linux:x86_64|Linux:aarch64|Linux:arm64) ;;
    *)
      err "Unsupported platform: $os $arch"
      err "Talkd setup currently supports macOS arm64/x64 and Linux x64/arm64."
      exit 1
      ;;
  esac
}

checkout_source() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating Talkd checkout: $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
    git -C "$INSTALL_DIR" checkout -q FETCH_HEAD
    return
  fi

  log "Cloning Talkd into: $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
}

install_pi_package() {
  if [ "${TALKD_SKIP_PI_INSTALL:-0}" = "1" ]; then
    warn "Skipping Pi package registration by TALKD_SKIP_PI_INSTALL=1"
    return
  fi
  if ! command -v pi >/dev/null 2>&1; then
    warn "Pi CLI not found; install/register the package manually after installing Pi."
    return
  fi

  log "Registering Talkd with Pi"
  if ! pi install -l "$INSTALL_DIR/packages/pi-voice"; then
    warn "Pi package registration failed; run manually: pi install -l $INSTALL_DIR/packages/pi-voice"
  fi
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
  Talkd checkout: $INSTALL_DIR
  Runtime assets: ${TALKD_HOME:-$HOME/.talkd}
  Pi package:     $INSTALL_DIR/packages/pi-voice

EOF

  if [ "$(uname -s)" = "Linux" ]; then
    cat <<'EOF'
Linux playback note:
  Set TALKD_PLAY_CMD if audio does not play, for example:
    export TALKD_PLAY_CMD='aplay {file}'
    # or
    export TALKD_PLAY_CMD='paplay {file}'

EOF
  fi

  if ! command -v rec >/dev/null 2>&1; then
    cat <<'EOF'
Microphone note:
  The default recorder uses SoX `rec`. Install SoX or set TALKD_RECORD_CMD.

EOF
  fi
}

main() {
  detect_platform
  need_cmd git
  need_cmd bun
  need_cmd curl
  need_cmd tar

  checkout_source
  cd "$INSTALL_DIR"

  log "Installing workspace dependencies"
  TALKD_PI_VOICE_SKIP_SETUP=1 bun install --frozen-lockfile

  log "Installing Talkd runtime assets and service binary"
  bun --cwd packages/pi-voice run setup:runtime
  if [ ! -x "${TALKD_HOME:-$HOME/.talkd}/bin/talkd-service" ]; then
    err "talkd-service binary was not installed. Publish a Talkd release for this OS/arch, install Go for source build fallback, or set TALKD_SERVICE_CMD."
    exit 1
  fi

  install_pi_package
  print_next_steps
}

main "$@"
