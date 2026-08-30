#!/usr/bin/env bash
# Build a store ready zip with only runtime extension files.
# Excludes tools/, test/, git metadata, and docs.
#
# Usage (from repo root, or any checkout of this tree):
#   ./tools/pack extension.sh
#   ./tools/pack extension.sh xnxp tabs firefox.zip
#   ./tools/pack extension.sh /abs/path/out.zip
#
# Default output: dist/xnxp tabs.zip

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist"
STAGE="$OUT_DIR/stage"

if [[ "${1:-}" == "" ]]; then
  ZIP="$OUT_DIR/xnxp-tabs.zip"
elif [[ "$1" == /* ]]; then
  ZIP="$1"
else
  ZIP="$OUT_DIR/$1"
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/icons" "$STAGE/lib" "$(dirname "$ZIP")"

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

rm -f "$ZIP"
(
  cd "$STAGE"
  zip -r -q "$ZIP" .
)

rm -rf "$STAGE"
echo "Wrote $ZIP"
unzip -l "$ZIP"
