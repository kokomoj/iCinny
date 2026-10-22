#!/usr/bin/env bash
# Build + sign + notarize + publish an iCinny release (Cinny in an Electron shell)
# to GitHub Releases on kokomoj/iCinny (the auto-update feed).
#   scripts/release.sh            → rebuild only if Cinny upstream has a newer tag
#   scripts/release.sh --force    → rebuild now (shell changes), bumping the build number
#   scripts/release.sh --prerelease → publish as a GitHub PRE-release (not seen by the
#                                   updater, which follows releases/latest) for testing.
#   scripts/release.sh --build N  → force the build number (must be higher than any used).
#   scripts/release.sh --test     → build a SIGNED+NOTARIZED+STAPLED app with the next
#                                   build number but publish NOTHING to the live feed.
#                                   The zip is copied to <PUB>/test/ only. Implies a build.
# --force and --test may be combined. Output: one line starting with
# RELEASED / UP_TO_DATE / TEST_BUILD / FAILED (cron-friendly).
set -euo pipefail

# ROOT derives from the script location (scripts/.. ), so the worktree copy and
# the main checkout both work without editing a hardcoded path.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="${CINNY_WEB:-$ROOT/../cinny-web}"   # checkout of github.com/cinnyapp/cinny
PUB="${CINNY_TEST_DIR:-$ROOT/release/test-out}"   # where --test copies its zip
KEY="$HOME/.config/cinny-electron/update-signing.pem"
NOTARY_ENV="$HOME/.config/cinny-electron/signing/notary.env"
GH_REPO="kokomoj/iCinny"
# Permanent URL: GitHub redirects releases/latest/download/<asset> to the newest
# non-prerelease release's asset. Baked into each build via build-info.json.
FEED_URL="https://github.com/$GH_REPO/releases/latest/download/latest.json"
STABLE_ZIP="iCinny-mac-arm64.zip"   # same file under a fixed name: the link to give people

# --- arg parsing: accept --force and/or --test in any order --------------------
FORCE=""; TEST=""; PRE=""; BUILD_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE="--force" ;;
    --test)  TEST="--test" ;;
    --prerelease) PRE="--prerelease"; FORCE="--force" ;;
    --build) shift; BUILD_OVERRIDE="${1:?--build needs a number}" ;;
    *) echo "FAILED: unknown arg $1"; exit 1 ;;
  esac
  shift
done

cd "$ROOT"
fail() { echo "FAILED: $*"; exit 1; }

# --- signing material ----------------------------------------------------------
# ALLOW_ADHOC=1 lets a build fall back to ad-hoc signing when the Developer ID
# keychain is unavailable (so dev builds don't hard-fail). An ad-hoc build is
# NEVER notarized or published; --test refuses to run ad-hoc.
SIGN_MODE="devid"
if [[ -f "$NOTARY_ENV" ]]; then
  set -a; source "$NOTARY_ENV"; set +a
else
  SIGN_MODE="adhoc"; echo "WARN: $NOTARY_ENV missing → ad-hoc signing only"
fi
# Confirm the Developer ID identity is actually usable in the keychain.
if [[ "$SIGN_MODE" == "devid" ]]; then
  if ! security find-identity -v -p codesigning "${SIGN_KEYCHAIN:-}" 2>/dev/null | grep -q "${SIGN_IDENTITY:-__none__}"; then
    SIGN_MODE="adhoc"; echo "WARN: Developer ID identity not found in keychain → ad-hoc signing only"
  fi
fi
if [[ "$SIGN_MODE" == "adhoc" ]]; then
  [[ "${ALLOW_ADHOC:-}" == "1" ]] || fail "Developer ID signing unavailable and ALLOW_ADHOC!=1 (refusing ad-hoc build)"
  [[ -n "$TEST" ]] && fail "--test requires Developer ID signing (ad-hoc not allowed for a test build)"
fi

# 1. What's the newest Cinny release, and what are we shipping?
LATEST_TAG=$(gh release list -R cinnyapp/cinny --limit 1 --exclude-drafts --exclude-pre-releases --json tagName -q '.[0].tagName') || fail "cannot query cinny releases"
LATEST_VER="${LATEST_TAG#v}"
# GitHub token with Contents write on $GH_REPO, supplied by the caller's
# environment (never stored in this repo). Only used for the GitHub calls below.
KOKO_PAT="${ICINNY_GH_TOKEN:-}"
[[ -n "$KOKO_PAT" || -n "$TEST" ]] || fail "ICINNY_GH_TOKEN is not set"
ghk() { GH_TOKEN="$KOKO_PAT" gh "$@"; }

# Current published release = what the updater sees (releases/latest).
CUR_JSON=$(curl -sfL --max-time 20 "$FEED_URL" 2>/dev/null || echo '{}')
CUR_VER=$(node -p "(JSON.parse(process.argv[1]).version)||''" "$CUR_JSON")
CUR_ELECTRON=$(node -p "(JSON.parse(process.argv[1]).electron)||''" "$CUR_JSON")
# Highest build number ever used for a version: GitHub tags (incl. pre-releases)
# so numbers never go backwards or collide.
TAGS=$( { ghk release list -R "$GH_REPO" --limit 100 --json tagName -q '.[].tagName' 2>/dev/null || true; } | tr '\n' ' ')
max_build_for() { # $1 = version
  local m=0 t b
  for t in $TAGS; do
    [[ "$t" == "v$1-b"* ]] || continue
    b="${t##*-b}"; [[ "$b" =~ ^[0-9]+$ ]] && (( b > m )) && m=$b
  done
  echo "$m"
}

# 1b. Electron (Chromium) security updates: take the newest release within the pinned
#     major (package.json ^44.x). A new major is never taken automatically.
npm update electron --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || fail "npm update electron"
ELECTRON_VER=$(node -p "require('./node_modules/electron/package.json').version")
REASON=""
[[ "$LATEST_VER" != "$CUR_VER" ]] && REASON="Cinny $LATEST_VER"
[[ "$ELECTRON_VER" != "$CUR_ELECTRON" ]] && REASON="${REASON:+$REASON, }Electron $ELECTRON_VER"

# --test always builds (next build number); normal mode only when there's a reason.
if [[ -z "$TEST" && "$FORCE" != "--force" && -z "$REASON" ]]; then
  echo "UP_TO_DATE: Cinny $CUR_VER build $CUR_BUILD, Electron $ELECTRON_VER"
  exit 0
fi
[[ -z "$REASON" ]] && REASON="shell changes"

CUR_BUILD=$(max_build_for "$LATEST_VER")
BUILD=$((CUR_BUILD + 1))
if [[ -n "$BUILD_OVERRIDE" ]]; then
  (( BUILD_OVERRIDE > CUR_BUILD )) || fail "--build $BUILD_OVERRIDE is not higher than build $CUR_BUILD already used"
  BUILD=$BUILD_OVERRIDE
fi
TAG="v$LATEST_VER-b$BUILD"

# 2. Cinny source at the release tag (clean), patched for the Dock badge count.
git -C "$WEB" fetch -q --depth 1 origin "refs/tags/$LATEST_TAG:refs/tags/$LATEST_TAG" || fail "fetch $LATEST_TAG"
git -C "$WEB" checkout -q -f "$LATEST_TAG"
git -C "$WEB" clean -qfd -e node_modules
node scripts/patch-cinny-badge.js "$WEB"
node scripts/patch-cinny-notify.js "$WEB"
node scripts/patch-cinny-oauth.js "$WEB"
(cd "$WEB" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run build >/dev/null 2>&1) || fail "cinny web build"
git -C "$WEB" checkout -q -f -- .   # leave the source tree clean

# 3. Package the shell.
rm -rf web && cp -R "$WEB/dist" web && node scripts/patch-config.js >/dev/null
# build-info.json carries version, build and the (configurable) feed URL.
node -e "require('fs').writeFileSync('build-info.json', JSON.stringify({version:process.argv[1],build:+process.argv[2],feedUrl:process.argv[3]})+'\n')" \
  "$LATEST_VER" "$BUILD" "$FEED_URL"
node -e "const p=require('./package.json');p.version='$LATEST_VER';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
rm -rf release
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir >/tmp/cinny-builder.log 2>&1 || fail "electron-builder (see /tmp/cinny-builder.log)"
APP="release/mac-arm64/iCinny.app"

# 3b. Sign: Developer ID (hardened runtime, inside-out) or ad-hoc fallback.
if [[ "$SIGN_MODE" == "devid" ]]; then
  bash scripts/sign-app.sh "$APP" >/tmp/cinny-sign.log 2>&1 || fail "developer-id signing (see /tmp/cinny-sign.log)"
  codesign --verify --deep --strict "$APP" >/dev/null 2>&1 || fail "post-sign codesign --verify --deep --strict"
  CS_INFO="$(codesign -dvv "$APP" 2>&1 || true)"
  echo "$CS_INFO" | grep -q "TeamIdentifier=${TEAM_ID}" || fail "signed app is not TeamIdentifier $TEAM_ID"
else
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || fail "ad-hoc codesign"
fi

# 4. Smoke test the packaged app before publishing anything.
#    Needs a GUI (Aqua) session — Electron never fires `ready` from a Background
#    launchd session (screen 0x0), so the selftest hangs. In --test mode we skip
#    it with a clear WARN; normal mode keeps the hard gate.
if [[ -n "$TEST" || -n "$PRE" ]]; then
  echo "WARN: --test/--prerelease skip the packaged selftest (requires a GUI/Aqua session; not available here)"
else
  RESULT=$(CINNY_SELFTEST=1 perl -e 'alarm 60; exec @ARGV' "$APP/Contents/MacOS/$(basename "$APP" .app)" 2>/dev/null | grep -o 'SELFTEST_RESULT.*' || true)
  echo "$RESULT" | grep -q '"secure":true' || fail "selftest: not secure context ($RESULT)"
  echo "$RESULT" | grep -q '"swControlling":true' || fail "selftest: service worker not controlling"
  echo "$RESULT" | grep -q '"homeserver":200' || fail "selftest: homeserver unreachable"
  echo "$RESULT" | grep -q "Electron/$ELECTRON_VER" || fail "selftest: app is not running Electron $ELECTRON_VER"
fi

# 5. Zip the app. The published/test zip must contain the STAPLED app, so for a
#    Developer-ID build we notarize+staple BEFORE the final zip.
ZIP="iCinny-$LATEST_VER-b$BUILD-arm64.zip"
[[ -n "$TEST" ]] && ZIP="iCinny-$LATEST_VER-b$BUILD-signed-test-arm64.zip"

if [[ "$SIGN_MODE" == "devid" ]]; then
  # Notarize a zip of the app, then staple the .app on Accepted.
  NZIP="release/notarize-$BUILD.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$NZIP"
  echo "notarize: submitting $NZIP …"
  SUB=$(perl -e 'alarm 900; exec @ARGV' xcrun notarytool submit "$NZIP" \
        --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" \
        --output-format json --wait 2>/tmp/cinny-notary.log) || { cat /tmp/cinny-notary.log; fail "notarytool submit"; }
  NID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).id||'')" "$SUB")
  NSTATUS=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status||'')" "$SUB")
  echo "notarize: id=$NID status=$NSTATUS"
  if [[ "$NSTATUS" != "Accepted" ]]; then
    echo "--- notarytool log $NID ---"
    xcrun notarytool log "$NID" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" 2>&1 | head -60 || true
    fail "notarization $NSTATUS (id $NID)"
  fi
  xcrun stapler staple "$APP" || fail "stapler staple"
  xcrun stapler validate "$APP" >/dev/null 2>&1 || fail "stapler validate after staple"
  rm -f "$NZIP"
fi

ditto -c -k --sequesterRsrc --keepParent "$APP" "release/$ZIP"
SHA=$(shasum -a 256 "release/$ZIP" | cut -d' ' -f1)

# ---------------------------------------------------------------------------
# 6. TEST mode: publish NOTHING to the live feed. Copy the zip to <PUB>/test/.
# ---------------------------------------------------------------------------
if [[ -n "$TEST" ]]; then
  mkdir -p "$PUB"
  cp "release/$ZIP" "$PUB/$ZIP"
  echo "TEST_BUILD: iCinny $LATEST_VER build $BUILD (signed+notarized+stapled, Electron $ELECTRON_VER) → $PUB/$ZIP  sha256=$SHA  (nothing published)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 6'. Publish to GitHub Releases: zip (versioned + stable name) and the signed
#     latest.json feed. --prerelease keeps it out of releases/latest.
# ---------------------------------------------------------------------------
[[ "$SIGN_MODE" == "devid" ]] || fail "refusing to publish an ad-hoc build"
REL_FLAG="--latest"; [[ -n "$PRE" ]] && REL_FLAG="--prerelease"
PAYLOAD="app.icinny.mac|$LATEST_VER|$BUILD|$SHA"
SIG=$(node -e "const c=require('crypto');process.stdout.write(c.sign(null,Buffer.from(process.argv[1]),c.createPrivateKey(require('fs').readFileSync(process.argv[2]))).toString('base64'))" "$PAYLOAD" "$KEY")
ZIP_URL="https://github.com/$GH_REPO/releases/download/$TAG/$ZIP"
NOTES="iCinny $LATEST_VER (build $BUILD) · Cinny $LATEST_VER · Electron $ELECTRON_VER · update: $REASON"
cp "release/$ZIP" "release/$STABLE_ZIP"
node -e "require('fs').writeFileSync('release/latest.json', JSON.stringify({version:process.argv[1],build:+process.argv[2],url:process.argv[3],sha256:process.argv[4],signature:process.argv[5],notes:process.argv[6],electron:process.argv[7],published:new Date().toISOString()},null,2)+'\\n')" \
  "$LATEST_VER" "$BUILD" "$ZIP_URL" "$SHA" "$SIG" "$NOTES" "$ELECTRON_VER"

BODY="Signed and notarized macOS app (Apple Silicon).

**Download:** \`$STABLE_ZIP\` → unzip → drag **iCinny.app** to Applications. Installed copies update themselves.

$NOTES

Built from Cinny $LATEST_TAG (https://github.com/cinnyapp/cinny, AGPL-3.0); shell source in this repo."
ghk release create "$TAG" -R "$GH_REPO" --title "iCinny $LATEST_VER (build $BUILD)" --notes "$BODY" \
  $REL_FLAG \
  "release/$ZIP" "release/$STABLE_ZIP" "release/latest.json" >/dev/null || fail "gh release create $TAG"

# 7. Verify what clients will actually see (downloaded back from GitHub).
CHECK_URL="$FEED_URL"; [[ -n "$PRE" ]] && CHECK_URL="https://github.com/$GH_REPO/releases/download/$TAG/latest.json"
for i in 1 2 3 4 5 6; do
  curl -sfL --max-time 20 "$CHECK_URL" | grep -q "\"sha256\": \"$SHA\"" && OK=1 && break; sleep 10
done
[[ "${OK:-}" == "1" ]] || fail "published feed does not match ($CHECK_URL)"
GOT=$(curl -sfL --max-time 600 "$ZIP_URL" | shasum -a 256 | cut -d' ' -f1)
[[ "$GOT" == "$SHA" ]] || fail "downloaded zip sha mismatch ($GOT)"

git add build-info.json package.json package-lock.json >/dev/null 2>&1 && git commit -qm "release iCinny $LATEST_VER build $BUILD (Electron $ELECTRON_VER)" >/dev/null 2>&1 || true
echo "RELEASED${PRE:+ (PRE-RELEASE)}: iCinny $LATEST_VER build $BUILD, Electron $ELECTRON_VER ($REASON) → https://github.com/$GH_REPO/releases/tag/$TAG"
