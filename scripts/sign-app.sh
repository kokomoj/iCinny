#!/usr/bin/env bash
# Sign a packaged Cinny.app inside-out with the Developer ID, hardened runtime
# and a secure timestamp, using the dedicated signing keychain (no UI prompt).
#
# Usage: scripts/sign-app.sh <path/to/Cinny.app>
#
# Requires (from notary.env): SIGN_IDENTITY, SIGN_KEYCHAIN. Keychain password at
# ~/.config/cinny-electron/signing/keychain.pass. Entitlements read relative to
# the repo root (build/entitlements.mac*.plist).
#
# We sign manually (electron-builder keeps identity:null) because electron-builder
# fights the custom keychain from a headless launchd session. Order matters:
# every nested Mach-O / framework / helper must be signed BEFORE the outer app,
# so we sign deepest-first:
#   1. standalone dylibs/.node/.so
#   2. framework bundles
#   3. helper .app bundles (and their executables)
#   4. the main executable, then the outer .app (with the real entitlements)
set -euo pipefail

APP="${1:?usage: sign-app.sh <Cinny.app>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENT="$HERE/build/entitlements.mac.plist"
ENT_INHERIT="$HERE/build/entitlements.mac.inherit.plist"
PASSFILE="$HOME/.config/cinny-electron/signing/keychain.pass"

: "${SIGN_IDENTITY:?SIGN_IDENTITY not set (source notary.env)}"
: "${SIGN_KEYCHAIN:?SIGN_KEYCHAIN not set (source notary.env)}"

[[ -d "$APP" ]] || { echo "sign-app: no such app: $APP" >&2; exit 1; }
[[ -f "$ENT" && -f "$ENT_INHERIT" ]] || { echo "sign-app: entitlements missing" >&2; exit 1; }

# Unlock the dedicated keychain so codesign runs without a UI prompt.
security unlock-keychain -p "$(cat "$PASSFILE")" "$SIGN_KEYCHAIN"

CS=(codesign --force --options runtime --timestamp --keychain "$SIGN_KEYCHAIN" --sign "$SIGN_IDENTITY")

sign_inherit() { "${CS[@]}" --entitlements "$ENT_INHERIT" "$1"; }   # executables / helpers
sign_plain()   { "${CS[@]}" "$1"; }                                 # frameworks / dylibs

echo "sign-app: signing nested code in $APP (deepest-first)"

# 1. Standalone Mach-O files anywhere in the bundle EXCEPT inside helper .app
#    bundles (those are signed as units in step 3). This catches dylibs, .node,
#    .so AND bare executables like the Electron Framework's Helpers/* (e.g.
#    chrome_crashpad_handler, app_shim_loader) which ship ad-hoc/linker-signed
#    and would otherwise fail notarization.
while IFS= read -r -d '' f; do
  # skip files inside a NESTED helper .app bundle (those are signed in step 3);
  # the outer Cinny.app path is under .../Cinny.app/Contents/ so match the
  # helper bundles specifically, which live under Frameworks/<Name>.app/.
  case "$f" in */Frameworks/*.app/*) continue ;; esac
  if file "$f" | grep -q 'Mach-O'; then sign_plain "$f"; fi
done < <(find "$APP/Contents" -type f -print0)

# 2. Framework bundles (their nested dylibs were covered above).
while IFS= read -r -d '' fw; do
  sign_plain "$fw"
done < <(find "$APP/Contents" -type d -name '*.framework' -print0)

# 3. Helper .app bundles: sign the inner executable, then the helper bundle.
while IFS= read -r -d '' h; do
  bin="$h/Contents/MacOS/$(basename "$h" .app)"
  [[ -f "$bin" ]] && sign_inherit "$bin"
  sign_inherit "$h"
done < <(find "$APP/Contents" -type d -name '*.app' -print0)

# 4. Main executable, then the outer app bundle (with the real entitlements).
MAIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
[[ -f "$MAIN" ]] && sign_inherit "$MAIN"
"${CS[@]}" --entitlements "$ENT" "$APP"

echo "sign-app: done"
