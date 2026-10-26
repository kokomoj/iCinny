// Self-hosted auto-updater for an unsigned (ad-hoc) macOS app.
// Squirrel/electron-updater require an Apple Developer ID signature, which we don't
// have — so this does it directly:
//   1. GET latest.json from the Hub (LAN).
//   2. If newer: download the zip, verify SHA-256 AND an Ed25519 signature made with
//      the release signing key (public key is baked into the app) — a tampered or MITM'd
//      file is rejected.
//   3. Unzip to a staging dir, confirm the bundle id + version.
//   4. On "Restart now" (or next quit): a detached helper waits for this process to
//      exit, swaps the .app bundle in place, clears quarantine, and relaunches.
const { app, dialog, net, Notification } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const BUNDLE_ID = 'app.icinny.mac';
const TEAM_ID = '7L57749AJF'; // Developer ID team: a Developer-ID build must only accept same-team updates.
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const PUBKEY = fs.readFileSync(path.join(__dirname, 'update-pubkey.pem'), 'utf8');
const BUILD = require('./build-info.json');
// Feed URL is configurable via build-info.json (feedUrl); release.sh writes it.
// Default keeps the current LAN Hub feed so existing builds are unaffected.
const FEED_URL = BUILD.feedUrl || 'https://github.com/kokomoj/iCinny/releases/latest/download/latest.json';

let staged = null; // { appPath, version, build }
let checking = false;
let getWindow = () => null;
// Test hook: hidden window, check immediately, install without prompting.
// Only honoured in builds from an explicit test release (never in normal published builds).
const UPDATE_TEST = process.env.CINNY_UPDATE_TEST === '1' && BUILD.allowUpdateTest === true;

const log = (...a) => console.log('[updater]', ...a);

function newer(feed) {
  const a = `${feed.version}`.split('.').map(Number);
  const b = `${BUILD.version}`.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return Number(feed.build) > Number(BUILD.build);
}

function signedPayload(feed) {
  return `${BUNDLE_ID}|${feed.version}|${feed.build}|${feed.sha256}`;
}

function verifyFeed(feed) {
  return crypto.verify(null, Buffer.from(signedPayload(feed)), PUBKEY, Buffer.from(feed.signature, 'base64'));
}

async function fetchJSON(url) {
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`feed HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function download(url, dest) {
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))
  );

// Like run(), but resolves { stdout, stderr } even on non-zero exit (unless the
// binary can't be spawned at all). codesign -dv writes its report to stderr and
// a clean read should still give us that output.
const runCapture = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err && err.code === undefined) return reject(err); // spawn failure
      if (err && /not signed at all|No such file/i.test(stderr || '')) return reject(new Error(stderr));
      resolve({ stdout, stderr });
    })
  );

function currentAppPath() {
  // .../Cinny.app/Contents/MacOS/Cinny → .../Cinny.app
  return path.resolve(path.dirname(process.execPath), '..', '..');
}

// --- Developer ID / Team-ID hardening -------------------------------------
// Parse `codesign -dv` stderr for the TeamIdentifier. Returns the id string,
// or null when the binary is unsigned / ad-hoc (no TeamIdentifier line, or
// TeamIdentifier=not set).
function parseTeamId(codesignStderr) {
  const m = /TeamIdentifier=(\S+)/.exec(codesignStderr || '');
  if (!m) return null;
  return m[1] === 'not' ? null : m[1]; // "TeamIdentifier=not set" → not set
}

// Is the given .app signed with our Developer ID team? Uses codesign -dv
// (which writes to stderr). Returns true only when TeamIdentifier matches.
async function appTeamId(appPath) {
  try {
    // codesign -dv writes the info to stderr and exits non-zero style via execFile
    const { stderr } = await runCapture('/usr/bin/codesign', ['-dvv', appPath]);
    return parseTeamId(stderr);
  } catch (e) {
    // Unsigned app → codesign errors ("code object is not signed at all").
    return null;
  }
}

async function verifyStrict(appPath) {
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
    return true;
  } catch {
    return false;
  }
}

// Gate a staged update against the RUNNING app's provenance.
//   - If the running app is Developer-ID signed with our TEAM_ID, the staged
//     app MUST pass --verify --deep --strict AND carry the same TeamIdentifier.
//   - If the running app is ad-hoc / unsigned (e.g. build 6), keep legacy
//     behaviour: no extra gate, so ad-hoc → signed updates still work.
// Returns { ok: bool, reason: string }.
async function gateStagedUpdate(runningAppPath, stagedAppPath, opts = {}) {
  const probeTeam = opts.appTeamId || appTeamId;
  const probeStrict = opts.verifyStrict || verifyStrict;
  const runningTeam = await probeTeam(runningAppPath);
  if (runningTeam !== TEAM_ID) {
    // Ad-hoc / other: legacy path, allow (sha256 + Ed25519 already enforced).
    return { ok: true, reason: `running app not Developer-ID team ${TEAM_ID} (got ${runningTeam || 'ad-hoc'}); legacy update path` };
  }
  // Running app IS our Developer-ID build → require the same of the staged app.
  const strictOk = await probeStrict(stagedAppPath);
  if (!strictOk) return { ok: false, reason: 'staged app failed codesign --verify --deep --strict' };
  const stagedTeam = await probeTeam(stagedAppPath);
  if (stagedTeam !== TEAM_ID) {
    return { ok: false, reason: `staged app TeamIdentifier ${stagedTeam || 'ad-hoc'} != ${TEAM_ID}` };
  }
  return { ok: true, reason: `staged app is Developer-ID team ${TEAM_ID}` };
}


async function check({ manual = false } = {}) {
  if (checking || staged) {
    if (manual && staged) promptRestart();
    return;
  }
  if (!app.isPackaged) return;
  checking = true;
  try {
    const feed = await fetchJSON(FEED_URL);
    if (!newer(feed)) {
      log('up to date', BUILD.version, BUILD.build);
      if (manual) dialog.showMessageBox({ message: `iCinny is up to date (${BUILD.version} build ${BUILD.build}).` });
      return;
    }
    if (!verifyFeed(feed)) throw new Error('update signature INVALID — refusing');
    log('update available', feed.version, feed.build);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cinny-update-'));
    const zip = path.join(work, 'update.zip');
    const sha = await download(new URL(feed.url, FEED_URL).toString(), zip);
    if (sha !== feed.sha256) throw new Error('update checksum mismatch — refusing');

    const out = path.join(work, 'x');
    fs.mkdirSync(out);
    await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
    // The bundle is iCinny.app since the rename (Cinny.app before); take whichever .app the zip holds.
    const appName = fs.readdirSync(out).find((n) => n.endsWith('.app'));
    if (!appName) throw new Error('update zip contains no .app');
    const newApp = path.join(out, appName);
    const id = (await run('/usr/bin/defaults', ['read', path.join(newApp, 'Contents', 'Info'), 'CFBundleIdentifier'])).trim();
    if (id !== BUNDLE_ID) throw new Error(`unexpected bundle id ${id}`);

    // Developer-ID provenance gate: if THIS running app is Developer-ID signed
    // with our team, the staged app must be too (strict verify + same TeamID).
    // Ad-hoc running builds (e.g. build 6) keep the legacy path so they can
    // still update to the first signed build.
    const gate = await gateStagedUpdate(currentAppPath(), newApp);
    log('provenance gate:', gate.reason);
    if (!gate.ok) throw new Error(`update rejected: ${gate.reason}`);

    staged = { appPath: newApp, version: feed.version, build: feed.build, notes: feed.notes || '' };
    log('staged', staged);
    promptRestart();
  } catch (e) {
    log('check failed:', e.message);
    if (manual) {
      // Plain-language messages; the technical reason stays in the log.
      if (e.status === 404) {
        // No published release on the feed yet (only pre-releases exist).
        dialog.showMessageBox({
          message: 'No updates available',
          detail: `You have iCinny ${BUILD.version} (build ${BUILD.build}). There's no newer release yet.`,
        });
      } else {
        dialog.showMessageBox({
          type: 'warning',
          message: "Couldn't check for updates",
          detail: 'Check your internet connection and try again later.',
        });
      }
    }
  } finally {
    checking = false;
  }
}

function promptRestart() {
  if (!staged) return;
  if (UPDATE_TEST) {
    log('UPDATE_TEST: installing without prompt');
    app.isQuitting = true;
    app.quit();
    return;
  }
  const win = getWindow();
  dialog
    .showMessageBox(win && win.isVisible() ? win : undefined, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `iCinny update ready (${staged.version} build ${staged.build})`,
      detail: (staged.notes ? staged.notes + '\n\n' : '') + 'Restart now, or it will install the next time you quit.',
    })
    .then(({ response }) => {
      if (response === 0) {
        app.isQuitting = true;
        app.quit();
      }
    });
}

// --- Install on quit -------------------------------------------------------
// There is now a single iCinny process (one Dock icon, a window per profile),
// so a bundle swap only needs to wait for THIS process to exit — no other
// instances to coordinate with. On relaunch the app reopens the profile
// windows that were open (main.js persists that list on quit).

// Called on before-quit: if an update is staged, hand off to the swap helper.
function installOnQuit(opts = {}) {
  if (!staged) return;
  const target = currentAppPath();
  if (!target.endsWith('.app')) return;
  // Install under the new bundle's own name (Cinny.app → iCinny.app on the first renamed build).
  const dest = path.join(path.dirname(target), path.basename(staged.appPath));
  // Paths go in as positional arguments ($1..$4), never spliced into the script
  // text, so an unusual install path can't change what the shell runs.
  //   $1 = our pid     $2 = target .app   $3 = dest .app   $4 = staged .app
  const script = [
    'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done', // wait for us to exit
    'sleep 0.5',
    'rm -rf "$2.old"',
    '[ "$3" != "$2" ] && rm -rf "$3"',
    'mv "$2" "$2.old" && mv "$4" "$3" || { mv "$2.old" "$2"; exit 1; }',
    '/usr/bin/xattr -cr "$3" 2>/dev/null',
    'rm -rf "$2.old"',
    opts.updateTestHook || UPDATE_TEST ? 'echo swapped > "$3.swapped"' : '/usr/bin/open "$3"',
  ].join('\n');
  const child = spawn('/bin/bash', ['-c', script, 'icinny-swap', String(process.pid), target, dest, staged.appPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  staged = null;
  log('swap helper launched for', target);
}

function start(windowGetter, opts = {}) {
  getWindow = windowGetter;
  setTimeout(() => check(), UPDATE_TEST ? 2000 : 15 * 1000);
  setInterval(() => check(), CHECK_EVERY_MS);
}

module.exports = { start, check, installOnQuit, BUILD, gateStagedUpdate, parseTeamId, appTeamId, verifyStrict, TEAM_ID };
