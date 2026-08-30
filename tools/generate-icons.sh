#!/usr/bin/env bash
# Regenerate shipped toolbar/store icons from the design source.
# Not part of the extension package (see .webextignore / pack-extension.sh).
#
# Usage (from repo root):
#   ./tools/generate-icons.sh
#   ./tools/generate-icons.sh path/to/other-source.png
#
# Default source: newest *.png under tools/icon-source/
# Writes: icons/icon{16,32,48,64,96,128}.png

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/icons"
SIZES=(16 32 48 64 96 128)

if [[ "${1:-}" != "" ]]; then
  SRC="$1"
else
  SRC="$(ls -t "$ROOT"/tools/icon-source/*.png 2>/dev/null | head -1 || true)"
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick 'magick' not found in PATH" >&2
  exit 1
fi

if [[ -z "${SRC:-}" || ! -f "$SRC" ]]; then
  echo "error: source image not found in tools/icon-source/" >&2
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
