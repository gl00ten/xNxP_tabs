#!/usr/bin/env bash
# Build upload zips for both store branches without changing your current checkout.
#
#   firefox_extension → dist/xnxp tabs firefox-<version>.zip  (AMO)
#   main              → dist/xnxp tabs chrome-<version>.zip   (Chrome Web Store)
#
# Usage (from repo root):
#   ./tools/pack both stores.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/dist"
mkdir -p "$OUT_DIR"

FF_BRANCH="firefox_extension"
CHROME_BRANCH="main"

for b in "$FF_BRANCH" "$CHROME_BRANCH"; do
  if ! git rev-parse --verify --quiet "$b" >/dev/null; then
    echo "error: missing branch $b" >&2
    exit 1
  fi
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/xnxp-pack.XXXXXX")"
cleanup() {
  git worktree remove --force "$TMP/firefox" 2>/dev/null || true
  git worktree remove --force "$TMP/chrome" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "Packing $FF_BRANCH …"
git worktree add --detach "$TMP/firefox" "$FF_BRANCH" >/dev/null
FF_VER="$(python3 -c "import json; print(json.load(open('$TMP/firefox/manifest.json'))['version'])")"
FF_ZIP="$OUT_DIR/xnxp-tabs-firefox-${FF_VER}.zip"
chmod +x "$TMP/firefox/tools/pack-extension.sh"
"$TMP/firefox/tools/pack-extension.sh" "$FF_ZIP"
echo

echo "Packing $CHROME_BRANCH …"
git worktree add --detach "$TMP/chrome" "$CHROME_BRANCH" >/dev/null
CH_VER="$(python3 -c "import json; print(json.load(open('$TMP/chrome/manifest.json'))['version'])")"
CH_ZIP="$OUT_DIR/xnxp-tabs-chrome-${CH_VER}.zip"
chmod +x "$TMP/chrome/tools/pack-extension.sh"
"$TMP/chrome/tools/pack-extension.sh" "$CH_ZIP"
echo

echo "Ready to upload:"
ls -lh "$FF_ZIP" "$CH_ZIP"
echo "  AMO (Firefox):  $FF_ZIP"
echo "  Chrome Web Store: $CH_ZIP"
