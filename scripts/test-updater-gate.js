// Unit check for the updater's Developer-ID / Team-ID provenance gate.
// Exercises updater.gateStagedUpdate(runningApp, stagedApp) against three cases,
// using the REAL codesign probes (appTeamId / verifyStrict) against on-disk apps.
//
// Scenarios (all assume the RUNNING app is a Developer-ID build = our signed app):
//   1. staged = signed test app            → ACCEPT
//   2. staged = build 6 (ad-hoc)           → REJECT (not team 7L57749AJF)
//   3. staged = signed app, one resource   → REJECT (strict verify fails)
//      file tampered
// Plus the inverse: when the RUNNING app is ad-hoc (build 6), the gate ALLOWS
// (legacy path) so build 6 → signed updates still work.
const assert = require('assert');
const u = require('../updater.js');

const SIGNED = process.argv[2];   // release/mac-arm64/Cinny.app (Developer ID)
const ADHOC  = process.argv[3];   // build 6 unzipped (ad-hoc)
const TAMPER = process.argv[4];   // copy of signed app with a modified resource

let failures = 0;
async function expect(name, promise, wantOk) {
  const r = await promise;
  const pass = r.ok === wantOk;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  -> ok=${r.ok} (${r.reason})`);
}

(async () => {
  // Sanity: the signed app really is our team, the ad-hoc one is not.
  const signedTeam = await u.appTeamId(SIGNED);
  const adhocTeam  = await u.appTeamId(ADHOC);
  console.log(`signed app TeamIdentifier = ${signedTeam}`);
  console.log(`ad-hoc app TeamIdentifier = ${adhocTeam}`);
  assert.strictEqual(signedTeam, u.TEAM_ID, 'signed app must be our team');
  assert.notStrictEqual(adhocTeam, u.TEAM_ID, 'ad-hoc app must NOT be our team');

  // Running = signed Developer-ID build:
  await expect('running=signed, staged=signed           (ACCEPT)', u.gateStagedUpdate(SIGNED, SIGNED), true);
  await expect('running=signed, staged=adhoc build6     (REJECT)', u.gateStagedUpdate(SIGNED, ADHOC), false);
  await expect('running=signed, staged=tampered signed  (REJECT)', u.gateStagedUpdate(SIGNED, TAMPER), false);

  // Running = ad-hoc build 6 → legacy path allows (so build6 can update to signed):
  await expect('running=adhoc  build6, staged=signed    (ACCEPT/legacy)', u.gateStagedUpdate(ADHOC, SIGNED), true);

  console.log(failures === 0 ? '\nALL UPDATER GATE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
