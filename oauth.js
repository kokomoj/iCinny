// OAuth 2.0 / "next-gen auth" (MSC3861 / Matrix Authentication Service) sign-in,
// run entirely in the Electron MAIN process.
//
// Some homeservers only offer OAuth sign-in: their GET /_matrix/client/v3/login
// returns 404 M_UNRECOGNIZED and the web client can't log in. Such a server
// instead exposes auth metadata (issuer, authorization/token/registration/
// revocation endpoints, grant types, PKCE methods) and dynamic client
// registration (RFC 7591 / MSC2966).
//
// This module implements the native-app authorization code flow (RFC 8252):
//   - a loopback redirect http://127.0.0.1:<ephemeral>/callback, 127.0.0.1 only,
//     single use, closed after one callback or a 5-minute timeout;
//   - PKCE S256, a random `state` that is checked on return;
//   - the authorization URL is opened in the SYSTEM browser (shell.openExternal);
//   - the refresh token lives ONLY in the main process, encrypted with
//     Electron safeStorage, in the profile's userData folder.
//
// Everything above the Electron IPC boundary is written as pure functions that
// take an injectable fetch (and, for the loopback server, the node http module),
// so the whole flow is unit-testable with no network and no Electron. The only
// Electron-specific code (shell, safeStorage, ipcMain, BrowserWindow) is reached
// lazily inside registerOAuthIpc / the token store, never at require time.
'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Constants / client metadata (all public; nothing identifying)
// ---------------------------------------------------------------------------
const CLIENT_NAME = 'iCinny';
const CLIENT_URI = 'https://github.com/kokomoj/iCinny';
const CALLBACK_PATH = '/callback';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_URL_LEN = 2048;

// Matrix OAuth scopes. Prefer the stable URNs when the server advertises them,
// otherwise fall back to the unstable org.matrix.msc2967 ones.
const SCOPE_API_STABLE = 'urn:matrix:client:api:*';
const SCOPE_DEVICE_STABLE = 'urn:matrix:client:device:';
const SCOPE_API_UNSTABLE = 'urn:matrix:org.matrix.msc2967.client:api:*';
const SCOPE_DEVICE_UNSTABLE = 'urn:matrix:org.matrix.msc2967.client:device:';

// ---------------------------------------------------------------------------
// Small pure utilities
// ---------------------------------------------------------------------------
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// RFC 7636 PKCE (S256). verifier: 43-128 chars of [A-Za-z0-9-._~]; we use 32
// random bytes -> 43 base64url chars.
function generatePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

const randomState = () => b64url(crypto.randomBytes(24));
const randomNonce = () => b64url(crypto.randomBytes(24));

// A fresh Matrix device id for this login (MSC2967 ties the device to the scope).
// Uppercase letters only, matching the usual synapse device-id shape.
function randomDeviceId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// https URL only, with a length cap. Used to validate every untrusted base URL
// coming from the page. Returns a normalized origin+path (trailing slash removed).
function assertHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LEN) {
    throw new Error('invalid url');
  }
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error('invalid url');
  }
  if (u.protocol !== 'https:') throw new Error('only https is allowed');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Discovery: GET /_matrix/client/v1/auth_metadata, then the unstable MSC2965
// endpoint as a fallback. Returns the validated metadata object.
// ---------------------------------------------------------------------------
const AUTH_METADATA_PATHS = [
  '/_matrix/client/v1/auth_metadata',
  '/_matrix/client/unstable/org.matrix.msc2965/auth_metadata',
];

function validateMetadata(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('auth metadata is not an object');
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint'];
  for (const k of required) {
    if (typeof meta[k] !== 'string' || !meta[k]) {
      throw new Error(`auth metadata missing ${k}`);
    }
  }
  // Every endpoint we call or open must be https: the authorization URL is
  // handed to the system browser, so a hostile server must not be able to
  // point it at file:, a custom app scheme, or plain http.
  for (const k of [...required, 'revocation_endpoint', 'account_management_uri']) {
    if (meta[k] == null) continue;
    let u;
    try { u = new URL(meta[k]); } catch { throw new Error(`auth metadata ${k} is not a URL`); }
    if (u.protocol !== 'https:') throw new Error(`auth metadata ${k} must be https`);
  }
  return meta;
}

async function discoverAuthMetadata(baseUrl, fetchFn) {
  const root = trimSlash(assertHttpsUrl(baseUrl));
  let lastErr;
  for (const p of AUTH_METADATA_PATHS) {
    try {
      const res = await fetchFn(root + p, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        lastErr = new Error(`auth_metadata ${p} -> HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      return validateMetadata(json);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no auth metadata endpoint responded');
}

// Pick the scope string. Honor scopes_supported when present: use the stable
// device/api URNs if advertised, else the unstable ones.
function chooseScope(meta, deviceId) {
  const supported = Array.isArray(meta.scopes_supported) ? meta.scopes_supported : [];
  const stable =
    supported.includes(SCOPE_API_STABLE) || supported.includes(`${SCOPE_DEVICE_STABLE}*`);
  const api = stable ? SCOPE_API_STABLE : SCOPE_API_UNSTABLE;
  const devicePrefix = stable ? SCOPE_DEVICE_STABLE : SCOPE_DEVICE_UNSTABLE;
  return `openid ${api} ${devicePrefix}${deviceId}`;
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591 / MSC2966). application_type native.
// The loopback redirect is registered WITHOUT the ephemeral port, per RFC 8252
// section 7.3 and MAS practice (the server allows any port on a registered
// 127.0.0.1 redirect). Returns { clientId }.
// ---------------------------------------------------------------------------
function registrationBody(redirectUri) {
  return {
    application_type: 'native',
    client_name: CLIENT_NAME,
    client_uri: CLIENT_URI,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

async function registerClient(meta, redirectUri, fetchFn) {
  const res = await fetchFn(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(registrationBody(redirectUri)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`client registration failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json || typeof json.client_id !== 'string' || !json.client_id) {
    throw new Error('client registration returned no client_id');
  }
  return { clientId: json.client_id };
}

// The loopback redirect URI registered with the server (no port).
const REGISTERED_REDIRECT = 'http://127.0.0.1/callback';

// ---------------------------------------------------------------------------
// Authorization URL (RFC 6749 + PKCE). redirectUri here DOES carry the live
// ephemeral port (the actual place the browser is sent back to).
// ---------------------------------------------------------------------------
function buildAuthorizationUrl({ meta, clientId, redirectUri, scope, state, pkce, nonce }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', pkce.challenge);
  u.searchParams.set('code_challenge_method', pkce.method);
  if (nonce) u.searchParams.set('nonce', nonce);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint: authorization_code exchange and refresh_token grant.
// token_endpoint_auth_method is "none", so client_id travels in the body and no
// secret is sent.
// ---------------------------------------------------------------------------
async function postToken(meta, params, fetchFn) {
  const res = await fetchFn(meta.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`token endpoint HTTP ${res.status} ${json.error || ''}`.trim());
  }
  if (typeof json.access_token !== 'string' || !json.access_token) {
    throw new Error('token endpoint returned no access_token');
  }
  return json;
}

function exchangeCode({ meta, clientId, code, redirectUri, verifier }, fetchFn) {
  return postToken(
    meta,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    },
    fetchFn
  );
}

function refreshTokens({ meta, clientId, refreshToken, scope }, fetchFn) {
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  };
  if (scope) params.scope = scope;
  return postToken(meta, params, fetchFn);
}

// Token revocation (RFC 7009). Best-effort: a non-2xx is not fatal to logout.
async function revokeToken({ meta, clientId, token, tokenTypeHint }, fetchFn) {
  if (!meta.revocation_endpoint) return false;
  try {
    const params = { token, client_id: clientId };
    if (tokenTypeHint) params.token_type_hint = tokenTypeHint;
    const res = await fetchFn(meta.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// whoami -> the Matrix user id for the freshly minted access token.
// ---------------------------------------------------------------------------
async function whoami(baseUrl, accessToken, fetchFn) {
  const root = trimSlash(baseUrl);
  const res = await fetchFn(`${root}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`whoami HTTP ${res.status}`);
  const json = await res.json();
  if (!json || typeof json.user_id !== 'string') throw new Error('whoami returned no user_id');
  return {
    userId: json.user_id,
    deviceId: typeof json.device_id === 'string' ? json.device_id : undefined,
  };
}

// ---------------------------------------------------------------------------
// Loopback callback server (RFC 8252). Binds 127.0.0.1 on an ephemeral port,
// accepts exactly one GET /callback, resolves with its query, then closes.
// Auto-closes after timeoutMs or when cancel() is called.
//
// httpMod is injectable for tests. Returns { listen, waitForCode, cancel }.
// ---------------------------------------------------------------------------
function startLoopbackServer({ timeoutMs = CALLBACK_TIMEOUT_MS, httpMod = http } = {}) {
  let resolveFn;
  let rejectFn;
  let settled = false;
  let timer = null;

  const done = (fn, arg) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    try {
      server.close();
    } catch {
      /* ignore */
    }
    if (fn) fn(arg);
  };

  const server = httpMod.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end('not found');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    // Small self-closing page so the browser tab shows something friendly.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><meta charset="utf-8"><title>iCinny</title>' +
        '<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:3rem;background:#1a1a1a;color:#eee">' +
        '<h2>You can return to iCinny now.</h2><p>This window can be closed.</p>' +
        '<script>setTimeout(function(){window.close()},800)</script></body>'
    );
    if (error) {
      done(rejectFn, new Error(`authorization error: ${error}`));
      return;
    }
    done(resolveFn, { code, state });
  });

  const waitForCode = () =>
    new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
      timer = setTimeout(() => done(rejectFn, new Error('timeout')), timeoutMs);
    });

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      // 127.0.0.1 ONLY -- never 0.0.0.0.
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({ port, redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}` });
      });
    });

  const cancel = () => done(rejectFn, new Error('cancelled'));

  return { listen, waitForCode, cancel };
}

// ---------------------------------------------------------------------------
// Encrypted token store (main process only). Keeps the refresh token and the
// context needed to refresh/revoke it (issuer, client_id, token/revocation
// endpoints, scope) encrypted with Electron safeStorage in the profile's
// userData. safeStorage is injectable so tests can use a plain-text stub.
// ---------------------------------------------------------------------------
function tokenStore({ userDataDir, safeStorage }) {
  const file = path.join(userDataDir, 'oauth-session.bin');

  const encrypt = (obj) => {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      return Buffer.concat([Buffer.from('ENC1'), safeStorage.encryptString(json.toString('utf8'))]);
    }
    // Fallback (e.g. safeStorage unavailable): store plainly, clearly marked.
    return Buffer.concat([Buffer.from('RAW1'), json]);
  };

  const decrypt = (buf) => {
    const tag = buf.slice(0, 4).toString();
    const rest = buf.slice(4);
    if (tag === 'ENC1') return JSON.parse(safeStorage.decryptString(rest));
    if (tag === 'RAW1') return JSON.parse(rest.toString('utf8'));
    throw new Error('unknown token store format');
  };

  return {
    file,
    save(session) {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, encrypt(session), { mode: 0o600 });
    },
    load() {
      try {
        return decrypt(fs.readFileSync(file));
      } catch {
        return null;
      }
    },
    clear() {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// client_id cache, keyed by issuer, in the profile userData (a plain JSON file --
// client ids are not secret). One file per profile folder already.
function clientIdStore({ userDataDir }) {
  const file = path.join(userDataDir, 'oauth-clients.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      return {};
    }
  };
  return {
    file,
    get(issuer) {
      const v = read()[issuer];
      return typeof v === 'string' ? v : undefined;
    },
    set(issuer, clientId) {
      const all = read();
      all[issuer] = clientId;
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
  };
}

// ---------------------------------------------------------------------------
// The orchestrated flow, independent of Electron. deps injects fetch, the http
// module, the two stores, openExternal, and onStatus (progress callback).
// Returns { start, cancel, refresh, logout }.
// ---------------------------------------------------------------------------
function createOAuthFlow(deps) {
  const {
    fetchFn,
    httpMod = http,
    tokens, // tokenStore instance
    clients, // clientIdStore instance
    openExternal, // (url) => void|Promise
    onStatus = () => {}, // (stateObj) => void
    timeoutMs = CALLBACK_TIMEOUT_MS,
  } = deps;

  let pendingServer = null; // the loopback server of an in-flight start()

  async function start(rawBaseUrl) {
    const baseUrl = assertHttpsUrl(rawBaseUrl); // https-only, length-capped
    onStatus({ phase: 'discovering' });
    const meta = await discoverAuthMetadata(baseUrl, fetchFn);

    // Register (or reuse cached client_id for this issuer).
    let clientId = clients.get(meta.issuer);
    if (!clientId) {
      onStatus({ phase: 'registering' });
      ({ clientId } = await registerClient(meta, REGISTERED_REDIRECT, fetchFn));
      clients.set(meta.issuer, clientId);
    }

    const deviceId = randomDeviceId();
    const scope = chooseScope(meta, deviceId);
    const pkce = generatePkce();
    const state = randomState();
    const nonce = randomNonce();

    const srv = startLoopbackServer({ timeoutMs, httpMod });
    pendingServer = srv;
    const { redirectUri } = await srv.listen();

    const authUrl = buildAuthorizationUrl({
      meta,
      clientId,
      redirectUri,
      scope,
      state,
      pkce,
      nonce,
    });

    onStatus({ phase: 'awaiting-browser' });
    await openExternal(authUrl);

    let cb;
    try {
      cb = await srv.waitForCode();
    } finally {
      pendingServer = null;
    }
    if (!cb.code) throw new Error('no authorization code returned');
    if (cb.state !== state) throw new Error('state mismatch'); // CSRF guard

    onStatus({ phase: 'exchanging' });
    const tok = await exchangeCode(
      { meta, clientId, code: cb.code, redirectUri, verifier: pkce.verifier },
      fetchFn
    );

    const who = await whoami(baseUrl, tok.access_token, fetchFn);

    const session = {
      baseUrl,
      issuer: meta.issuer,
      clientId,
      tokenEndpoint: meta.token_endpoint,
      revocationEndpoint: meta.revocation_endpoint || null,
      accountManagementUri: meta.account_management_uri || null,
      scope,
      deviceId: who.deviceId || deviceId,
      userId: who.userId,
      refreshToken: tok.refresh_token || null,
      // persisted for startup-expiry checks; not sensitive
      expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    };
    tokens.save(session);

    onStatus({ phase: 'done' });
    // The access token is handed to the page but NOT persisted here (the page
    // stores it in localStorage like a normal login). The refresh token stays
    // in the main process only.
    return {
      baseUrl,
      accessToken: tok.access_token,
      userId: session.userId,
      deviceId: session.deviceId,
      expiresInMs: tok.expires_in ? tok.expires_in * 1000 : undefined,
    };
  }

  function cancel() {
    if (pendingServer) {
      pendingServer.cancel();
      pendingServer = null;
      return true;
    }
    return false;
  }

  // Refresh using the stored refresh token. Rotates it if the server returns a
  // new one. Returns { accessToken, expiresInMs } for the page; the refresh
  // token itself never leaves the main process.
  // Single-flight: the server rotates refresh tokens and may revoke the whole
  // session if an old one is used twice, so concurrent callers (startup check,
  // SDK on a 401, a retry) share one in-flight request.
  let refreshing = null;
  function refresh() {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function doRefresh() {
    const session = tokens.load();
    if (!session || !session.refreshToken) throw new Error('no oauth session');
    const meta = {
      token_endpoint: session.tokenEndpoint,
      revocation_endpoint: session.revocationEndpoint,
    };
    const tok = await refreshTokens(
      { meta, clientId: session.clientId, refreshToken: session.refreshToken, scope: undefined },
      fetchFn
    );
    const updated = {
      ...session,
      refreshToken: tok.refresh_token || session.refreshToken, // rotation
      expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
    };
    tokens.save(updated);
    return {
      accessToken: tok.access_token,
      expiresInMs: tok.expires_in ? tok.expires_in * 1000 : undefined,
    };
  }

  // Revoke refresh + access tokens at the server, then wipe the stored session.
  async function logout(accessToken) {
    const session = tokens.load();
    if (session) {
      const meta = {
        token_endpoint: session.tokenEndpoint,
        revocation_endpoint: session.revocationEndpoint,
      };
      if (session.refreshToken) {
        await revokeToken(
          {
            meta,
            clientId: session.clientId,
            token: session.refreshToken,
            tokenTypeHint: 'refresh_token',
          },
          fetchFn
        );
      }
      if (accessToken) {
        await revokeToken(
          { meta, clientId: session.clientId, token: accessToken, tokenTypeHint: 'access_token' },
          fetchFn
        );
      }
    }
    tokens.clear();
    return true;
  }

  return { start, cancel, refresh, logout };
}

// ---------------------------------------------------------------------------
// Per-profile OAuth storage directory.
//   default profile → the base userData dir (legacy location, unchanged)
//   named profile   → <userData>/oauth/<slug>/
// Pure (no electron) so it is unit-testable.
// ---------------------------------------------------------------------------
function oauthDirFor(slug, baseUserDataDir) {
  if (!slug || slug === 'default') return baseUserDataDir;
  return path.join(baseUserDataDir, 'oauth', slug);
}

// ---------------------------------------------------------------------------
// Electron wiring. Lazily requires electron so this file is require-able (and
// unit-testable) in a plain node:test process.
//
// getProfileWindows() -> an iterable (Map or array) of the app's profile
//   BrowserWindows; a sender is accepted iff it is one of their webContents.
// slugForSender(webContents) -> the profile slug that owns a webContents, or
//   null if it is not one of ours.
// baseUserDataDir -> the app's base userData folder (default profile's store;
//   named profiles nest under <base>/oauth/<slug>/).
//
// One OAuth flow (loopback server, PKCE verifier, pending promise, token &
// client stores) is created lazily PER PROFILE and cached, so two profiles
// signing in at once never share state.
// ---------------------------------------------------------------------------
function registerOAuthIpc({ getProfileWindows, slugForSender, baseUserDataDir }) {
  // eslint-disable-next-line global-require
  const { ipcMain, shell, safeStorage, app } = require('electron');
  const base = baseUserDataDir || (app && app.getPath('userData'));

  // slug -> flow. Each profile gets its own stores + single-flight flow.
  const flows = new Map();

  function flowForSlug(slug) {
    let entry = flows.get(slug);
    if (entry) return entry;
    const dir = oauthDirFor(slug, base);
    const tokens = tokenStore({ userDataDir: dir, safeStorage });
    const clients = clientIdStore({ userDataDir: dir });
    const sendStatus = (status) => {
      const win = windowForSlug(slug);
      if (win && !win.isDestroyed()) win.webContents.send('oauth:status', status);
    };
    const flow = createOAuthFlow({
      fetchFn: (...a) => fetch(...a), // Node/Electron global fetch
      tokens,
      clients,
      openExternal: (url) => shell.openExternal(url),
      onStatus: sendStatus,
    });
    entry = { flow, tokens, clients };
    flows.set(slug, entry);
    return entry;
  }

  // Iterate the app's profile windows (Map values or array).
  function profileWindows() {
    const w = getProfileWindows ? getProfileWindows() : [];
    if (!w) return [];
    if (typeof w.values === 'function' && !Array.isArray(w)) return Array.from(w.values());
    return Array.from(w);
  }

  function windowForSlug(slug) {
    for (const win of profileWindows()) {
      if (win && !win.isDestroyed() && slugForSender && slugForSender(win.webContents) === slug) return win;
    }
    return null;
  }

  // Resolve the sender to one of our profile windows; returns its slug or null.
  const senderSlug = (e) => {
    for (const win of profileWindows()) {
      if (win && !win.isDestroyed() && e.sender === win.webContents) {
        return slugForSender ? slugForSender(win.webContents) : null;
      }
    }
    return null;
  };

  ipcMain.handle('oauth:start', async (e, baseUrl) => {
    const slug = senderSlug(e);
    if (slug === null) return { ok: false, error: 'not allowed' };
    if (typeof baseUrl !== 'string' || baseUrl.length > MAX_URL_LEN) {
      return { ok: false, error: 'invalid server' };
    }
    try {
      const result = await flowForSlug(slug).flow.start(baseUrl);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('oauth:cancel', (e) => {
    const slug = senderSlug(e);
    if (slug === null) return { ok: false, error: 'not allowed' };
    return { ok: true, cancelled: flowForSlug(slug).flow.cancel() };
  });

  ipcMain.handle('oauth:refresh', async (e) => {
    const slug = senderSlug(e);
    if (slug === null) return { ok: false, error: 'not allowed' };
    try {
      const result = await flowForSlug(slug).flow.refresh();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('oauth:logout', async (e, accessToken) => {
    const slug = senderSlug(e);
    if (slug === null) return { ok: false, error: 'not allowed' };
    const at = typeof accessToken === 'string' ? accessToken : undefined;
    try {
      await flowForSlug(slug).flow.logout(at);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // Expose the stored account-management URI (for the OIDC dashboard link) and
  // whether a stored token looks expired (for the startup refresh).
  ipcMain.handle('oauth:info', (e) => {
    const slug = senderSlug(e);
    if (slug === null) return { ok: false, error: 'not allowed' };
    const s = flowForSlug(slug).tokens.load();
    if (!s) return { ok: true, result: null };
    return {
      ok: true,
      result: {
        accountManagementUri: s.accountManagementUri || null,
        userId: s.userId,
        expiresAt: s.expiresAt || null,
        expired: typeof s.expiresAt === 'number' ? Date.now() >= s.expiresAt : false,
      },
    };
  });

  // Let the app drop a profile's OAuth state when the profile is deleted.
  return {
    clearProfile(slug) {
      const entry = flows.get(slug);
      if (entry) {
        try { entry.tokens.clear(); } catch { /* ignore */ }
        flows.delete(slug);
      }
    },
  };
}

module.exports = {
  // pure helpers (unit-tested directly)
  generatePkce,
  randomState,
  randomDeviceId,
  assertHttpsUrl,
  discoverAuthMetadata,
  validateMetadata,
  chooseScope,
  registrationBody,
  registerClient,
  buildAuthorizationUrl,
  exchangeCode,
  refreshTokens,
  revokeToken,
  whoami,
  startLoopbackServer,
  tokenStore,
  clientIdStore,
  createOAuthFlow,
  // per-profile storage
  oauthDirFor,
  // electron wiring
  registerOAuthIpc,
  // constants (handy in tests)
  CLIENT_NAME,
  CLIENT_URI,
  REGISTERED_REDIRECT,
  AUTH_METADATA_PATHS,
  SCOPE_API_STABLE,
  SCOPE_API_UNSTABLE,
};
