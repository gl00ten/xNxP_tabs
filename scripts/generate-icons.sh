#!/usr/bin/env bash
# Regenerate shipped toolbar/store icons from the design source.
#
# Usage (from repo root):
#   ./scripts/generate-icons.sh
#   ./scripts/generate-icons.sh path/to/other-source.png
#
# Default source: icons/ico_simplified.png
# Writes: icons/icon{16,32,48,64,96,128}.png

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/icons/ico_simplified.png}"
OUT_DIR="$ROOT/icons"
SIZES=(16 32 48 64 96 128)

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick 'magick' not found in PATH" >&2
  exit 1
fi

if [[ ! -f "$SRC" ]]; then
  echo "error: source image not found: $SRC" >&2
  exit 1
fi

echo "Source: $SRC"
for s in "${SIZES[@]}"; do
  dest="$OUT_DIR/icon${s}.png"
  # Lanczos resize; strip junk metadata to keep package small
  magick "$SRC" -resize "${s}x${s}" -strip "$dest"
  echo "  wrote $dest"
done

echo "Done. Manifest should reference icons/icon{16,32,48,64,96,128}.png"
