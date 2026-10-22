// Unit tests for the profile model (profiles.js). Run: node --test scripts/test-profiles.js
// Pure logic only — no electron, no GUI. Covers slug sanitising, registry
// corrupt-file fallback, and userData path selection.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../profiles.js');

test('sanitizeSlug: lowercases, collapses junk, trims hyphens', () => {
  assert.strictEqual(P.sanitizeSlug('Work'), 'work');
  assert.strictEqual(P.sanitizeSlug('  Work Account!! '), 'work-account');
  assert.strictEqual(P.sanitizeSlug('a___b---c'), 'a-b-c');
  assert.strictEqual(P.sanitizeSlug('---Hello---'), 'hello');
  assert.strictEqual(P.sanitizeSlug('Ünïcode Ñame'), 'unicode-name');
  assert.strictEqual(P.sanitizeSlug('!!!'), '');
  assert.strictEqual(P.sanitizeSlug(null), '');
  assert.strictEqual(P.sanitizeSlug(undefined), '');
});

test('sanitizeSlug: bounds length and never ends in a hyphen', () => {
  const long = P.sanitizeSlug('x'.repeat(200));
  assert.ok(long.length <= 48);
  const hyphenEnd = P.sanitizeSlug('abcdefghij-'.repeat(10));
  assert.ok(!hyphenEnd.endsWith('-'));
});

test('isValidSlug: accepts clean slugs, rejects default/empty/dirty', () => {
  assert.ok(P.isValidSlug('work'));
  assert.ok(P.isValidSlug('work-2'));
  assert.ok(!P.isValidSlug('default')); // reserved
  assert.ok(!P.isValidSlug(''));
  assert.ok(!P.isValidSlug('Work')); // uppercase
  assert.ok(!P.isValidSlug('a b')); // space
  assert.ok(!P.isValidSlug('-x'));
  assert.ok(!P.isValidSlug(42));
});

test('slugFromName: avoids collisions and the reserved default', () => {
  assert.strictEqual(P.slugFromName('Work', []), 'work');
  assert.strictEqual(P.slugFromName('Work', ['work']), 'work-2');
  assert.strictEqual(P.slugFromName('Work', ['work', 'work-2']), 'work-3');
  assert.strictEqual(P.slugFromName('default', []), 'profile'); // can't become default
  assert.strictEqual(P.slugFromName('!!!', []), 'profile');
});

test('sanitizeColor: only the palette, else blue', () => {
  for (const c of P.COLORS) assert.strictEqual(P.sanitizeColor(c), c);
  assert.strictEqual(P.sanitizeColor('chartreuse'), 'blue');
  assert.strictEqual(P.sanitizeColor(''), 'blue');
  assert.strictEqual(P.sanitizeColor(null), 'blue');
});

test('sanitizeName: trims, collapses whitespace, bounds, falls back', () => {
  assert.strictEqual(P.sanitizeName('  Home   Base  ', 'x'), 'Home Base');
  assert.strictEqual(P.sanitizeName('', 'Fallback'), 'Fallback');
  assert.strictEqual(P.sanitizeName(null, 'Fallback'), 'Fallback');
  assert.ok(P.sanitizeName('y'.repeat(200), 'x').length <= 60);
});

test('normalizeRegistry: always exactly one default first, dedupes named', () => {
  const reg = P.normalizeRegistry([
    { slug: 'work', name: 'Work', color: 'red', openAtLaunch: true },
    { slug: 'work', name: 'Dup', color: 'green' }, // duplicate dropped
    { slug: 'default', name: 'Home', color: 'blue' },
    { slug: 'default', name: 'SecondDefault' }, // extra default dropped
    { slug: 'Bad Slug', name: 'nope' }, // invalid slug dropped
    null,
    'garbage',
  ]);
  assert.strictEqual(reg[0].slug, 'default');
  assert.strictEqual(reg[0].name, 'Home');
  const named = reg.filter((p) => p.slug !== 'default');
  assert.strictEqual(named.length, 1);
  assert.strictEqual(named[0].slug, 'work');
  assert.strictEqual(named[0].name, 'Work');
  assert.strictEqual(named[0].color, 'red');
  assert.strictEqual(named[0].openAtLaunch, true);
});

test('normalizeRegistry: synthesizes a default when none present / not an array', () => {
  const a = P.normalizeRegistry([]);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].slug, 'default');
  assert.strictEqual(a[0].name, 'iCinny');
  assert.strictEqual(a[0].color, 'blue');
  const b = P.normalizeRegistry('not an array');
  assert.deepStrictEqual(b, [P.defaultProfile()]);
  const c = P.normalizeRegistry(null);
  assert.deepStrictEqual(c, [P.defaultProfile()]);
});

test('readRegistry: corrupt file → default fallback, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icinny-reg-'));
  const pdir = P.profilesDir(dir);
  fs.mkdirSync(pdir, { recursive: true });

  // (a) missing file
  assert.deepStrictEqual(P.readRegistry(dir), [P.defaultProfile()]);

  // (b) invalid JSON
  fs.writeFileSync(P.registryPath(dir), '{ this is not json ]');
  assert.deepStrictEqual(P.readRegistry(dir), [P.defaultProfile()]);

  // (c) valid JSON, wrong shape
  fs.writeFileSync(P.registryPath(dir), '{"nope": 1}');
  assert.deepStrictEqual(P.readRegistry(dir), [P.defaultProfile()]);

  // (d) array of junk
  fs.writeFileSync(P.registryPath(dir), '[1, "two", null, {"slug": "BAD SLUG"}]');
  assert.deepStrictEqual(P.readRegistry(dir), [P.defaultProfile()]);

  // (e) a real entry survives
  fs.writeFileSync(P.registryPath(dir), JSON.stringify([{ slug: 'work', name: 'Work', color: 'red' }]));
  const reg = P.readRegistry(dir);
  assert.strictEqual(reg.length, 2);
  assert.strictEqual(reg[1].slug, 'work');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeRegistry: round-trips cleanly and normalises on write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icinny-reg-'));
  const written = P.writeRegistry(dir, [
    { slug: 'work', name: '  Work ', color: 'chartreuse', openAtLaunch: 'yes' },
  ]);
  // color coerced to blue, openAtLaunch coerced to false, default prepended
  assert.strictEqual(written[0].slug, 'default');
  assert.strictEqual(written[1].color, 'blue');
  assert.strictEqual(written[1].openAtLaunch, false);
  assert.strictEqual(written[1].name, 'Work');
  const reread = P.readRegistry(dir);
  assert.deepStrictEqual(reread, written);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('userDataDir: default profile WITH legacy folder → legacy', () => {
  const got = P.userDataDir({
    slug: 'default',
    appData: '/AppData',
    defaultUserData: '/AppData/iCinny',
    legacyExists: true,
  });
  assert.strictEqual(got, path.join('/AppData', 'Cinny'));
});

test('userDataDir: default profile WITHOUT legacy folder → default userData', () => {
  const got = P.userDataDir({
    slug: 'default',
    appData: '/AppData',
    defaultUserData: '/AppData/iCinny',
    legacyExists: false,
  });
  assert.strictEqual(got, '/AppData/iCinny');
});

test('userDataDir: empty/undefined slug behaves like default', () => {
  for (const slug of ['', undefined, null]) {
    const got = P.userDataDir({ slug, appData: '/AppData', defaultUserData: '/D', legacyExists: false });
    assert.strictEqual(got, '/D');
  }
});

test('userDataDir: named profile → iCinny Profiles/<slug>', () => {
  const got = P.userDataDir({
    slug: 'work',
    appData: '/AppData',
    defaultUserData: '/AppData/iCinny',
    legacyExists: true, // irrelevant for named
  });
  assert.strictEqual(got, path.join('/AppData', 'iCinny Profiles', 'work'));
});

test('parseProfileArg: reads --profile=, sanitises, falls back to default', () => {
  assert.strictEqual(P.parseProfileArg(['--profile=work']), 'work');
  assert.strictEqual(P.parseProfileArg(['--profile=Work Account']), 'work-account');
  assert.strictEqual(P.parseProfileArg(['x', '--profile=red', 'y']), 'red');
  assert.strictEqual(P.parseProfileArg(['--profile=']), 'default');
  assert.strictEqual(P.parseProfileArg(['--profile=default']), 'default');
  assert.strictEqual(P.parseProfileArg([]), 'default');
  assert.strictEqual(P.parseProfileArg(['--other=1']), 'default');
});

test('findProfile: finds by slug, defaults when absent', () => {
  const reg = P.normalizeRegistry([{ slug: 'work', name: 'Work', color: 'red' }]);
  assert.strictEqual(P.findProfile(reg, 'work').name, 'Work');
  assert.strictEqual(P.findProfile(reg, 'default').slug, 'default');
  assert.strictEqual(P.findProfile(reg, 'missing'), null);
  assert.strictEqual(P.findProfile(reg).slug, 'default'); // no slug → default
});
