// Profile model for iCinny.
//
// iCinny can run several independent copies side by side, one per Matrix
// account/server, told apart by Dock icon colour. A "profile" is just a userData
// directory plus a little metadata (name + colour + open-at-launch).
//
// This module is pure Node (no electron require) so it can be unit-tested with
// `node --test`. main.js passes in the paths it gets from electron's `app`.
//
//   - The DEFAULT profile (slug === DEFAULT_SLUG) keeps using today's data folder
//     EXACTLY as before: the legacy "<appData>/Cinny" dir if it exists, else the
//     normal default userData dir. Its login must never move.
//   - A NAMED profile <slug> uses "<appData>/iCinny Profiles/<slug>/".
//   - The registry lives at "<appData>/iCinny Profiles/profiles.json" and is an
//     array of { slug, name, color, openAtLaunch }. It is validated on every read
//     and a corrupt/garbage file silently falls back to defaults — iCinny must
//     never fail to start because of it.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SLUG = 'default';
const DEFAULT_NAME = 'iCinny';
const DEFAULT_COLOR = 'blue';
const PROFILES_DIRNAME = 'iCinny Profiles';
const REGISTRY_FILENAME = 'profiles.json';
const LEGACY_DIRNAME = 'Cinny';

// Supported Dock-icon colours. "blue" is today's unchanged icon.
const COLORS = ['blue', 'red', 'green', 'purple', 'orange', 'graphite'];

// ---- slug ----------------------------------------------------------------

// Turn arbitrary user text into a safe slug: lowercase, a-z 0-9 and single
// hyphens only, no leading/trailing/doubled hyphens, bounded length. Returns ''
// when nothing usable remains (caller decides what to do with an empty slug).
function sanitizeSlug(input) {
  return String(input == null ? '' : input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining diacritical marks (é → e, not e-)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alnum → single hyphen
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, ''); // slice may have left a trailing hyphen
}

// A slug is valid iff sanitising it leaves it unchanged and non-empty, and it is
// not the reserved default slug (named profiles only).
function isValidSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) return false;
  if (slug === DEFAULT_SLUG) return false;
  return sanitizeSlug(slug) === slug;
}

// Derive a slug from a display name, guaranteeing it does not collide with an
// existing slug (array of taken slugs) nor the reserved default slug.
function slugFromName(name, taken = []) {
  let base = sanitizeSlug(name);
  if (!base || base === DEFAULT_SLUG) base = 'profile';
  const used = new Set([DEFAULT_SLUG, ...taken]);
  if (!used.has(base)) return base;
  for (let i = 2; i < 10000; i++) {
    const cand = `${base}-${i}`.slice(0, 48).replace(/-+$/g, '');
    if (!used.has(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

// ---- field sanitising ----------------------------------------------------

function sanitizeColor(color) {
  return COLORS.includes(color) ? color : DEFAULT_COLOR;
}

function sanitizeName(name, fallback) {
  const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || fallback;
}

// Coerce one registry entry into a well-formed profile object, or null if it is
// unusable. `isDefault` relaxes the slug rule for the default entry.
function coerceEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const isDefault = raw.slug === DEFAULT_SLUG;
  if (!isDefault && !isValidSlug(raw.slug)) return null;
  return {
    slug: isDefault ? DEFAULT_SLUG : raw.slug,
    name: sanitizeName(raw.name, isDefault ? DEFAULT_NAME : raw.slug),
    color: sanitizeColor(raw.color),
    openAtLaunch: raw.openAtLaunch === true,
  };
}

function defaultProfile() {
  return { slug: DEFAULT_SLUG, name: DEFAULT_NAME, color: DEFAULT_COLOR, openAtLaunch: false };
}

// Normalise a parsed array into a clean registry: exactly one default entry
// (first), de-duplicated named entries, all fields sanitised. Never throws.
function normalizeRegistry(parsed) {
  const out = [];
  const seen = new Set();
  let def = null;
  if (Array.isArray(parsed)) {
    for (const raw of parsed) {
      const e = coerceEntry(raw);
      if (!e) continue;
      if (e.slug === DEFAULT_SLUG) {
        if (!def) def = e; // keep the first default entry only
        continue;
      }
      if (seen.has(e.slug)) continue;
      seen.add(e.slug);
      out.push(e);
    }
  }
  return [def || defaultProfile(), ...out];
}

// ---- paths ---------------------------------------------------------------

function profilesDir(appData) {
  return path.join(appData, PROFILES_DIRNAME);
}

function registryPath(appData) {
  return path.join(profilesDir(appData), REGISTRY_FILENAME);
}

// The userData directory for a given profile.
//   default: legacy "<appData>/Cinny" if it exists, else `defaultUserData`
//            (what electron would have used — app.getPath('userData')).
//   named:   "<appData>/iCinny Profiles/<slug>/"
// `legacyExists` is injected so this stays pure/testable.
function userDataDir({ slug, appData, defaultUserData, legacyExists }) {
  if (!slug || slug === DEFAULT_SLUG) {
    const legacy = path.join(appData, LEGACY_DIRNAME);
    return legacyExists ? legacy : defaultUserData;
  }
  return path.join(profilesDir(appData), slug);
}

// ---- registry IO (fs) ----------------------------------------------------

// Read + validate the registry. ANY problem (missing file, bad JSON, wrong
// shape) returns a one-element default registry — iCinny never crashes on it.
function readRegistry(appData) {
  try {
    const txt = fs.readFileSync(registryPath(appData), 'utf8');
    return normalizeRegistry(JSON.parse(txt));
  } catch {
    return [defaultProfile()];
  }
}

// Write the registry atomically (temp file + rename) after normalising it.
function writeRegistry(appData, registry) {
  const dir = profilesDir(appData);
  fs.mkdirSync(dir, { recursive: true });
  const clean = normalizeRegistry(registry);
  const file = registryPath(appData);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return clean;
}

function findProfile(registry, slug) {
  const want = slug || DEFAULT_SLUG;
  return registry.find((p) => p.slug === want) || null;
}

// Parse --profile=<slug> out of an argv array. Returns a sanitised slug, or
// DEFAULT_SLUG when the flag is absent/empty/invalid.
// (Retained for compatibility; the one-app model no longer launches by --profile.)
function parseProfileArg(argv) {
  for (const a of argv || []) {
    const m = /^--profile=(.*)$/.exec(String(a));
    if (m) {
      const slug = sanitizeSlug(m[1]);
      return isValidSlug(slug) ? slug : DEFAULT_SLUG;
    }
  }
  return DEFAULT_SLUG;
}

// ---- one-app model: sessions + open-window persistence -------------------

// The Electron session partition for a profile. The default profile uses the
// default session (null → session.defaultSession in main.js); every named
// profile gets its own persisted partition so its web storage (localStorage,
// IndexedDB, cookies, service worker) is isolated.
function partitionFor(slug) {
  if (!slug || slug === DEFAULT_SLUG) return null;
  return `persist:profile-${slug}`;
}

// Where the "which profile windows were open at quit" list lives, so a restart
// (e.g. after an update swap) can reopen the same windows.
function openSlugsPath(appData) {
  return path.join(profilesDir(appData), 'open-windows.json');
}

// Coerce an arbitrary slug list into clean, de-duplicated, order-preserving
// slugs. 'default' is allowed; named slugs must be valid; everything else drops.
function sanitizeSlugList(list) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(list)) {
    for (const raw of list) {
      const slug = raw === DEFAULT_SLUG ? DEFAULT_SLUG : (isValidSlug(raw) ? raw : null);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

// Read the open-window slug list. ANY problem returns [] — never throws.
function readOpenSlugs(appData) {
  try {
    const txt = fs.readFileSync(openSlugsPath(appData), 'utf8');
    return sanitizeSlugList(JSON.parse(txt));
  } catch {
    return [];
  }
}

// Write the open-window slug list atomically, after sanitising. Returns the
// cleaned list. Best-effort: swallows fs errors (it must never block quit).
function writeOpenSlugs(appData, slugs) {
  const clean = sanitizeSlugList(slugs);
  try {
    const dir = profilesDir(appData);
    fs.mkdirSync(dir, { recursive: true });
    const file = openSlugsPath(appData);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(clean) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort; ignore */
  }
  return clean;
}

module.exports = {
  DEFAULT_SLUG,
  DEFAULT_NAME,
  DEFAULT_COLOR,
  PROFILES_DIRNAME,
  REGISTRY_FILENAME,
  LEGACY_DIRNAME,
  COLORS,
  sanitizeSlug,
  isValidSlug,
  slugFromName,
  sanitizeColor,
  sanitizeName,
  coerceEntry,
  defaultProfile,
  normalizeRegistry,
  profilesDir,
  registryPath,
  userDataDir,
  readRegistry,
  writeRegistry,
  findProfile,
  parseProfileArg,
  partitionFor,
  openSlugsPath,
  readOpenSlugs,
  writeOpenSlugs,
};
