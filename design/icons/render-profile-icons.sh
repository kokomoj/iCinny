#!/usr/bin/env bash
# Render design/icons/profile-icons/<color>.svg → build/profile-icons/<color>.png
# at 1024x1024 with transparent corners, using headless Google Chrome.
#
# Chrome renders the SVG inside a 1024x1024 transparent page and screenshots it.
# --default-background-color=00000000 keeps the rounded-tile corners transparent.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SVG_DIR="$ROOT/design/icons/profile-icons"
OUT_DIR="$ROOT/build/profile-icons"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
COLORS=(blue red green purple orange graphite)

[[ -x "$CHROME" ]] || { echo "FAIL: Chrome not found at $CHROME"; exit 1; }
mkdir -p "$OUT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for c in "${COLORS[@]}"; do
  svg="$SVG_DIR/$c.svg"
  [[ -f "$svg" ]] || { echo "FAIL: missing $svg"; exit 1; }
  # Wrap the SVG in a zero-margin 1024x1024 page so the screenshot is exact.
  html="$TMP/$c.html"
  {
    printf '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>'
    cat "$svg"
  } > "$html"
  "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$TMP/chrome-$c" \
    --force-device-scale-factor=1 --window-size=1024,1024 \
    --default-background-color=00000000 \
    --screenshot="$OUT_DIR/$c.png" "file://$html" >/dev/null 2>&1 || {
      echo "FAIL: Chrome render $c"; exit 1; }
  echo "rendered $c → build/profile-icons/$c.png"
done
echo "OK: 6 profile icons in $OUT_DIR"
