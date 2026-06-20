#!/usr/bin/env bash
set -euo pipefail

# Installs a built talkd service binary into ~/.talkd/bin and patches rpath
# so it loads native libs from ~/.talkd/lib.
#
# Usage:
#   scripts/install-binary.sh ./path/to/binary [installed-name]

TALKD_HOME="${TALKD_HOME:-$HOME/.talkd}"

log() { printf '\033[1;34m[install-binary]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  err "Usage: $0 ./path/to/binary [installed-name]"
  exit 2
fi

src="$1"
name="${2:-$(basename "$src")}"

dst_dir="$TALKD_HOME/bin"
dst="$dst_dir/$name"

if [ ! -f "$src" ]; then
  err "Binary not found: $src"
  exit 1
fi

mkdir -p "$dst_dir" "$TALKD_HOME/lib"
cp "$src" "$dst"
chmod +x "$dst"
log "Installed: $dst"

os="$(uname -s)"
case "$os" in
  Darwin)
    if ! command -v install_name_tool >/dev/null 2>&1; then
      err "install_name_tool not found; install Xcode Command Line Tools"
      exit 1
    fi

    # Remove absolute/module-cache rpaths. Keep existing relative rpaths if any.
    while IFS= read -r rpath; do
      case "$rpath" in
        @executable_path/*|@loader_path/*|@rpath*)
          ;;
        *)
          log "Removing rpath: $rpath"
          install_name_tool -delete_rpath "$rpath" "$dst" 2>/dev/null || true
          ;;
      esac
    done < <(otool -l "$dst" | awk '/cmd LC_RPATH/{getline; getline; sub(/^ *path /, ""); sub(/ \(offset [0-9]+\)$/, ""); print}')

    if ! otool -l "$dst" | grep -q '@executable_path/../lib'; then
      log "Adding rpath: @executable_path/../lib"
      install_name_tool -add_rpath '@executable_path/../lib' "$dst"
    fi
    ;;
  Linux)
    if command -v patchelf >/dev/null 2>&1; then
      log 'Setting rpath: $ORIGIN/../lib'
      patchelf --set-rpath '$ORIGIN/../lib' "$dst"
    else
      log "patchelf not found; set LD_LIBRARY_PATH=$TALKD_HOME/lib when running"
    fi
    ;;
  *)
    log "No rpath patching implemented for $os"
    ;;
esac

log "Done"
printf '\nRun with:\n  %s\n' "$dst"
