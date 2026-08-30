#!/usr/bin/env bash
# Regenerate shipped toolbar/store icons from the design source.
# Not part of the extension package (see .webextignore / pack extension.sh).
#
# Usage (from repo root):
#   ./tools/generate icons.sh
#   ./tools/generate icons.sh path/to/other source.png
#
# Default source (first that exists):
#   tools/icon source/ico_simplified.png
#   tools/icon source/ico_ori.png
# Writes: icons/icon{16,32,48,64,96,128}.png

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/icons"
SIZES=(16 32 48 64 96 128)

if [[ "${1:-}" != "" ]]; then
  SRC="$1"
else
  SRC=""
  for candidate in \
    "$ROOT/tools/icon-source/ico_simplified.png" \
    "$ROOT/tools/icon-source/ico_ori.png"; do
    if [[ -f "$candidate" ]]; then
      SRC="$candidate"
      break
    fi
  done
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick 'magick' not found in PATH" >&2
  exit 1
fi

if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "error: source image not found (expected tools/icon-source/ico_simplified.png or ico_ori.png)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
echo "Source: $SRC"
for s in "${SIZES[@]}"; do
  dest="$OUT_DIR/icon${s}.png"
  magick "$SRC" -resize "${s}x${s}" -strip "$dest"
  echo "  wrote $dest"
done

echo "Done."
