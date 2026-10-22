// Unit test for the updater's multi-instance quit-request coordination.
// Pure fs/path logic (no electron API needed). Run: node --test scripts/test-quit-request.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const u = require('../updater.js');

test('quitRequestPath points inside "iCinny Profiles"', () => {
  const p = u.quitRequestPath('/AppData');
  assert.strictEqual(p, path.join('/AppData', 'iCinny Profiles', 'quit-request'));
});

test('requestOtherInstancesQuit writes a fresh request file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icinny-quit-'));
  u.requestOtherInstancesQuit(dir);
  const file = u.quitRequestPath(dir);
  assert.ok(fs.existsSync(file));
  const mtime = fs.statSync(file).mtimeMs;
  assert.ok(Math.abs(Date.now() - mtime) < 5000); // just written
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchQuitRequest fires onQuit when a request arrives after start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icinny-quit-'));
  let quit = 0;
  u.watchQuitRequest(dir, () => { quit++; });
  // No request yet → must not fire.
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual(quit, 0, 'should not quit before a request');
  // Default instance asks everyone to quit.
  u.requestOtherInstancesQuit(dir);
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(quit >= 1, 'should quit after a request appears');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchQuitRequest ignores a STALE request file written before start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icinny-quit-'));
  // Pre-existing stale request, mtime well in the past.
  const file = u.quitRequestPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'old');
  const past = Date.now() / 1000 - 3600; // 1h ago
  fs.utimesSync(file, past, past);

  let quit = 0;
  u.watchQuitRequest(dir, () => { quit++; });
  await new Promise((r) => setTimeout(r, 1300));
  assert.strictEqual(quit, 0, 'a stale pre-start request must be ignored');
  fs.rmSync(dir, { recursive: true, force: true });
});
