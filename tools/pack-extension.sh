#!/usr/bin/env bash
# Build a store-ready zip with only runtime extension files.
# Excludes tools/, test/, git metadata, and docs.
#
# Usage (from repo root):
#   ./tools/pack-extension.sh
# Output: dist/xnxp-tabs.zip

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist"
ZIP="$OUT_DIR/xnxp-tabs.zip"
STAGE="$OUT_DIR/stage"

rm -rf "$STAGE"
mkdir -p "$STAGE/icons" "$STAGE/lib"

cp "$ROOT/manifest.json" "$STAGE/"
cp "$ROOT/background.js" "$STAGE/"
cp "$ROOT/browser-polyfill.js" "$STAGE/"
cp "$ROOT/popup.html" "$STAGE/"
cp "$ROOT/popup.css" "$STAGE/"
cp "$ROOT/popup.js" "$STAGE/"
cp "$ROOT/lib/core.js" "$STAGE/lib/"
cp "$ROOT"/icons/icon*.png "$STAGE/icons/"

# Fail if source/design leftovers snuck into icons/
if compgen -G "$STAGE/icons/ico_*" > /dev/null; then
  echo "error: source icons must not be packed" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$ZIP"
(
  cd "$STAGE"
  zip -r -q "$ZIP" .
)

rm -rf "$STAGE"
echo "Wrote $ZIP"
unzip -l "$ZIP"
