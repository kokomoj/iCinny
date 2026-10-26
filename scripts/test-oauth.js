// Unit tests for the main-process OAuth module (oauth.js).
//
// A local mock OAuth authorization server + Matrix homeserver run on 127.0.0.1
// ephemeral ports. No real network, no Electron. The loopback callback is driven
// by fetching the ephemeral callback URL directly (simulating the system browser
// returning to the app). Run: node --test scripts/test-oauth.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const o = require('../oauth.js');

// ---------------------------------------------------------------------------
// A mock server that answers auth_metadata, registration, token, revocation,
// authorize (by immediately redirecting to the loopback callback with a code),
// and whoami. Configurable to simulate the quirks each test needs.
// ---------------------------------------------------------------------------
function b64urlSha256(s) {
  return crypto
    .createHash('sha256')
    .update(s)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeMockServer(opts = {}) {
  const state = {
    metadataOnV1: opts.metadataOnV1 !== false, // default: v1 responds
    registrations: 0,
    issuedClientIds: [],
    lastAuthorize: null,
    lastTokenRequest: null,
    tokenRequests: [],
    revocations: [],
    scopesSupported: opts.scopesSupported || null,
    currentRefreshToken: 'refresh-1',
    accessCounter: 0,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);
    const base = `http://127.0.0.1:${server.address().port}`;
    // Advertised endpoints are https (oauth.js refuses anything else); the
    // tests' fetch wrapper routes https://local.test to this http mock.
    const pub = 'https://local.test';
    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () =>
      new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => resolve(b));
      });

    const metadata = () => {
      const m = {
        issuer: `${pub}/`,
        authorization_endpoint: `${pub}/authorize`,
        token_endpoint: `${pub}/token`,
        registration_endpoint: `${pub}/register`,
        revocation_endpoint: `${pub}/revoke`,
        account_management_uri: `${pub}/account`,
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      };
      if (state.scopesSupported) m.scopes_supported = state.scopesSupported;
      return m;
    };

    // --- discovery ---
    if (url.pathname === '/_matrix/client/v1/auth_metadata') {
      if (!state.metadataOnV1) return sendJson(404, { errcode: 'M_UNRECOGNIZED' });
      return sendJson(200, metadata());
    }
    if (url.pathname === '/_matrix/client/unstable/org.matrix.msc2965/auth_metadata') {
      return sendJson(200, metadata());
    }

    // --- registration ---
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody());
      state.registrations += 1;
      state.lastRegistration = body;
      const clientId = `client-${state.registrations}`;
      state.issuedClientIds.push(clientId);
      return sendJson(201, { client_id: clientId, ...body });
    }

    // --- authorize: redirect straight back to the loopback callback ---
    if (url.pathname === '/authorize') {
      state.lastAuthorize = Object.fromEntries(url.searchParams.entries());
      const redirectUri = url.searchParams.get('redirect_uri');
      const st = url.searchParams.get('state');
      const code = 'auth-code-xyz';
      state.lastCode = code;
      // store PKCE challenge to verify at token time
      state.lastChallenge = url.searchParams.get('code_challenge');
      const loc = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(st)}`;
      res.writeHead(302, { Location: loc });
      return res.end();
    }

    // --- token ---
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody());
      const grant = body.get('grant_type');
      state.tokenRequests.push(Object.fromEntries(body.entries()));
      state.lastTokenRequest = Object.fromEntries(body.entries());
      if (grant === 'authorization_code') {
        // verify PKCE
        const verifier = body.get('code_verifier');
        if (!verifier || b64urlSha256(verifier) !== state.lastChallenge) {
          return sendJson(400, { error: 'invalid_grant', detail: 'pkce mismatch' });
        }
        state.accessCounter += 1;
        return sendJson(200, {
          access_token: `access-${state.accessCounter}`,
          refresh_token: state.currentRefreshToken,
          token_type: 'Bearer',
          expires_in: 300,
        });
      }
      if (grant === 'refresh_token') {
        const got = body.get('refresh_token');
        if (got !== state.currentRefreshToken) {
          return sendJson(400, { error: 'invalid_grant' });
        }
        // rotate
        state.currentRefreshToken = `${got}-rotated`;
        state.accessCounter += 1;
        return sendJson(200, {
          access_token: `access-${state.accessCounter}`,
          refresh_token: state.currentRefreshToken,
          token_type: 'Bearer',
          expires_in: 300,
        });
      }
      return sendJson(400, { error: 'unsupported_grant_type' });
    }

    // --- revocation ---
    if (url.pathname === '/revoke' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody());
      state.revocations.push(Object.fromEntries(body.entries()));
      return sendJson(200, {});
    }

    // --- whoami ---
    if (url.pathname === '/_matrix/client/v3/account/whoami') {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return sendJson(401, { errcode: 'M_MISSING_TOKEN' });
      return sendJson(200, { user_id: '@someone:example', device_id: 'DEVFROMSERVER' });
    }

    return sendJson(404, { errcode: 'M_NOT_FOUND' });
  });

  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icinny-oauth-'));
}

// A createOAuthFlow whose openExternal simulates the system browser: it fetches
// the authorization URL (which 302-redirects to the loopback), then fetches the
// loopback callback so the loopback server resolves with the code.
function browserOpenExternal() {
  return async (authUrl) => {
    // Follow the 302 from /authorize to the loopback callback and hit it.
    const res = await fetch(authUrl, { redirect: 'manual' });
    const loc = res.headers.get('location');
    assert.ok(loc && loc.startsWith('http://127.0.0.1:'), 'authorize should redirect to loopback');
    // Fire the callback (don't await the body race; the loopback resolves on request).
    fetch(loc).catch(() => {});
  };
}

function flowFor(port, dir, overrides = {}) {
  const safeStub = {
    isEncryptionAvailable: () => false, // RAW1 path in tests
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  };
  const tokens = o.tokenStore({ userDataDir: dir, safeStorage: safeStub });
  const clients = o.clientIdStore({ userDataDir: dir });
  const flow = o.createOAuthFlow({
    fetchFn: (...a) => fetch(...a),
    tokens,
    clients,
    openExternal: overrides.openExternal || browserOpenExternal(),
    onStatus: overrides.onStatus || (() => {}),
    timeoutMs: overrides.timeoutMs || 5000,
  });
  return { flow, tokens, clients };
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------
test('generatePkce: S256 challenge is sha256(verifier) base64url', () => {
  const p = o.generatePkce();
  assert.strictEqual(p.method, 'S256');
  assert.ok(p.verifier.length >= 43);
  assert.strictEqual(b64urlSha256(p.verifier), p.challenge);
});

test('randomDeviceId: uppercase letters, reasonably long', () => {
  const d = o.randomDeviceId();
  assert.match(d, /^[A-Z]{10}$/);
  assert.notStrictEqual(d, o.randomDeviceId());
});

test('assertHttpsUrl: rejects http, accepts https, caps length', () => {
  assert.strictEqual(o.assertHttpsUrl('https://hs.example/'), 'https://hs.example');
  assert.throws(() => o.assertHttpsUrl('http://hs.example'), /https/);
  assert.throws(() => o.assertHttpsUrl('not a url'), /invalid url/);
  assert.throws(() => o.assertHttpsUrl(`https://a/${'x'.repeat(3000)}`), /invalid url/);
});

test('registrationBody: native app, loopback redirect, auth method none', () => {
  const b = o.registrationBody('http://127.0.0.1/callback');
  assert.strictEqual(b.application_type, 'native');
  assert.strictEqual(b.client_name, 'iCinny');
  assert.strictEqual(b.client_uri, 'https://github.com/kokomoj/iCinny');
  assert.deepStrictEqual(b.redirect_uris, ['http://127.0.0.1/callback']);
  assert.deepStrictEqual(b.grant_types, ['authorization_code', 'refresh_token']);
  assert.strictEqual(b.token_endpoint_auth_method, 'none');
  assert.deepStrictEqual(b.response_types, ['code']);
});

test('chooseScope: unstable by default, stable when advertised', () => {
  const unstable = o.chooseScope({}, 'DEV1');
  assert.ok(unstable.includes('org.matrix.msc2967.client:api:*'));
  assert.ok(unstable.includes('org.matrix.msc2967.client:device:DEV1'));
  assert.ok(unstable.startsWith('openid '));

  const stable = o.chooseScope(
    { scopes_supported: [o.SCOPE_API_STABLE, 'urn:matrix:client:device:*'] },
    'DEV2'
  );
  assert.ok(stable.includes('urn:matrix:client:api:*'));
  assert.ok(stable.includes('urn:matrix:client:device:DEV2'));
  assert.ok(!stable.includes('msc2967'));
});

test('buildAuthorizationUrl: carries PKCE, state, redirect_uri, scope', () => {
  const url = o.buildAuthorizationUrl({
    meta: { authorization_endpoint: 'https://op.example/authorize' },
    clientId: 'client-1',
    redirectUri: 'http://127.0.0.1:55555/callback',
    scope: 'openid foo',
    state: 'st-123',
    pkce: { challenge: 'chal', method: 'S256' },
    nonce: 'n-1',
  });
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('client_id'), 'client-1');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:55555/callback');
  assert.strictEqual(u.searchParams.get('code_challenge'), 'chal');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(u.searchParams.get('state'), 'st-123');
});

// ---------------------------------------------------------------------------
// Discovery: v1 then unstable fallback
// ---------------------------------------------------------------------------
test('discovery: uses v1 auth_metadata when present', async () => {
  // discoverAuthMetadata enforces https on the base URL, so route an https-shaped
  // URL to the http mock through the same mask the flow uses.
  const { server } = makeMockServer({ metadataOnV1: true });
  const port = await listen(server);
  try {
    const meta = await o.discoverAuthMetadata('https://local.test', httpsMaskFetch(port));
    assert.ok(meta.token_endpoint.endsWith('/token'));
    assert.ok(meta.issuer);
  } finally {
    await closeServer(server);
  }
});

test('discovery: falls back to unstable endpoint when v1 is 404', async () => {
  const { server, state } = makeMockServer({ metadataOnV1: false });
  const port = await listen(server);
  try {
    const meta = await o.discoverAuthMetadata('https://local.test', httpsMaskFetch(port));
    assert.ok(meta, 'should have resolved via unstable fallback');
    assert.ok(meta.token_endpoint.endsWith('/token'));
    assert.strictEqual(state.metadataOnV1, false);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Full flow: registration + client_id caching, PKCE, token exchange, whoami.
// We bypass assertHttpsUrl's https requirement by hitting the mock through a
// flow whose fetchFn rewrites https://local -> http://127.0.0.1:port (the flow
// itself still validates that the page passed an https URL).
// ---------------------------------------------------------------------------
function httpsMaskFetch(port) {
  // The page passes an https URL; we transparently route it to the http mock.
  const target = `http://127.0.0.1:${port}`;
  return (input, init) => {
    const s = typeof input === 'string' ? input : input.url;
    const rewritten = s.replace(/^https:\/\/local\.test(\/|$)/, `${target}$1`).replace(
      /^https:\/\/local\.test/,
      target
    );
    return fetch(rewritten, init);
  };
}

function flowWithMask(port, dir, overrides = {}) {
  const safeStub = {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  };
  const tokens = o.tokenStore({ userDataDir: dir, safeStorage: safeStub });
  const clients = o.clientIdStore({ userDataDir: dir });
  const maskFetch = httpsMaskFetch(port);
  const flow = o.createOAuthFlow({
    fetchFn: maskFetch,
    tokens,
    clients,
    openExternal:
      overrides.openExternal ||
      (async (authUrl) => {
        const res = await maskFetch(authUrl, { redirect: 'manual' });
        const loc = res.headers.get('location');
        maskFetch(loc).catch(() => {});
      }),
    onStatus: overrides.onStatus || (() => {}),
    timeoutMs: overrides.timeoutMs || 5000,
  });
  return { flow, tokens, clients, maskFetch };
}

test('start: registers, exchanges code with PKCE, returns session + stores refresh token', async () => {
  const { server, state } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    const { flow, tokens } = flowWithMask(port, dir);
    const result = await flow.start('https://local.test');
    assert.strictEqual(result.userId, '@someone:example');
    assert.strictEqual(result.deviceId, 'DEVFROMSERVER'); // whoami wins
    assert.match(result.accessToken, /^access-/);
    assert.strictEqual(result.expiresInMs, 300000);
    assert.strictEqual(state.registrations, 1);
    // refresh token is stored on disk, NOT returned to the page
    assert.strictEqual('refreshToken' in result, false);
    const stored = tokens.load();
    assert.strictEqual(stored.refreshToken, 'refresh-1');
    assert.strictEqual(stored.accountManagementUri, 'https://local.test/account');
    // token request used the registered client id and a code_verifier
    assert.strictEqual(state.lastTokenRequest.client_id, 'client-1');
    assert.ok(state.lastTokenRequest.code_verifier);
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('client_id is cached per issuer (second start does not re-register)', async () => {
  const { server, state } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    const { flow } = flowWithMask(port, dir);
    await flow.start('https://local.test');
    const { flow: flow2 } = flowWithMask(port, dir); // same userData dir
    await flow2.start('https://local.test');
    assert.strictEqual(state.registrations, 1, 'should reuse cached client_id');
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a non-https homeserver', async () => {
  const dir = tmpDir();
  try {
    const { flow } = flowWithMask(1, dir); // port irrelevant; rejected before any fetch
    await assert.rejects(() => flow.start('http://insecure.example'), /https/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state mismatch is rejected (CSRF guard)', async () => {
  const { server } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    // openExternal that returns the callback with a WRONG state.
    const { flow, maskFetch } = flowWithMask(port, dir, {
      openExternal: async (authUrl) => {
        const res = await maskFetch(authUrl, { redirect: 'manual' });
        const loc = new URL(res.headers.get('location'));
        loc.searchParams.set('state', 'tampered');
        maskFetch(loc.toString()).catch(() => {});
      },
    });
    await assert.rejects(() => flow.start('https://local.test'), /state mismatch/);
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PKCE mismatch at token endpoint surfaces as an error', async () => {
  const { server, state } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    // Corrupt the stored challenge after authorize so the verifier won't match.
    const { flow, maskFetch } = flowWithMask(port, dir, {
      openExternal: async (authUrl) => {
        const res = await maskFetch(authUrl, { redirect: 'manual' });
        state.lastChallenge = 'not-the-real-challenge';
        maskFetch(res.headers.get('location')).catch(() => {});
      },
    });
    await assert.rejects(() => flow.start('https://local.test'), /token endpoint HTTP 400/);
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cancel() aborts an in-flight start and the loopback server closes', async () => {
  const { server } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    // openExternal that does NOT hit the callback, so start() waits; we cancel.
    const { flow } = flowWithMask(port, dir, {
      openExternal: async () => {
        /* user never finishes in the browser */
      },
      timeoutMs: 30000,
    });
    const p = flow.start('https://local.test');
    // give it a moment to reach awaiting-browser
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(flow.cancel(), true);
    await assert.rejects(() => p, /cancelled/);
    // a second cancel is a no-op
    assert.strictEqual(flow.cancel(), false);
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loopback callback times out when the browser never returns', async () => {
  const { server } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    const { flow } = flowWithMask(port, dir, {
      openExternal: async () => {},
      timeoutMs: 300, // fast timeout for the test
    });
    await assert.rejects(() => flow.start('https://local.test'), /timeout/);
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh rotates the refresh token and stores the new one', async () => {
  const { server, state } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    const { flow, tokens } = flowWithMask(port, dir);
    await flow.start('https://local.test');
    assert.strictEqual(tokens.load().refreshToken, 'refresh-1');
    const r = await flow.refresh();
    assert.match(r.accessToken, /^access-/);
    assert.strictEqual(tokens.load().refreshToken, 'refresh-1-rotated');
    // server saw a refresh_token grant
    assert.ok(state.tokenRequests.some((t) => t.grant_type === 'refresh_token'));
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logout revokes refresh + access tokens and clears the store', async () => {
  const { server, state } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    const { flow, tokens } = flowWithMask(port, dir);
    const result = await flow.start('https://local.test');
    await flow.logout(result.accessToken);
    assert.strictEqual(tokens.load(), null, 'session file should be cleared');
    const hints = state.revocations.map((r) => r.token_type_hint);
    assert.ok(hints.includes('refresh_token'));
    assert.ok(hints.includes('access_token'));
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tokenStore round-trips via safeStorage ENC path', () => {
  const dir = tmpDir();
  try {
    const safe = {
      isEncryptionAvailable: () => true,
      // trivial reversible "encryption" for the test
      encryptString: (s) => Buffer.from(`enc:${s}`),
      decryptString: (b) => b.toString().replace(/^enc:/, ''),
    };
    const ts = o.tokenStore({ userDataDir: dir, safeStorage: safe });
    ts.save({ refreshToken: 'secret', userId: '@x:y' });
    // raw bytes on disk must NOT contain the plaintext refresh token
    const raw = fs.readFileSync(ts.file).toString();
    assert.ok(raw.startsWith('ENC1'));
    assert.ok(raw.includes('enc:'));
    const loaded = ts.load();
    assert.strictEqual(loaded.refreshToken, 'secret');
    ts.clear();
    assert.strictEqual(ts.load(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('onStatus reports the expected phases through a full start', async () => {
  const { server } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  const phases = [];
  try {
    const { flow } = flowWithMask(port, dir, { onStatus: (s) => phases.push(s.phase) });
    await flow.start('https://local.test');
    for (const p of ['discovering', 'registering', 'awaiting-browser', 'exchanging', 'done']) {
      assert.ok(phases.includes(p), `missing phase ${p} in ${phases.join(',')}`);
    }
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata endpoints must be https (nothing else is ever opened or called)', () => {
  const ok = {
    issuer: 'https://op.example/',
    authorization_endpoint: 'https://op.example/authorize',
    token_endpoint: 'https://op.example/token',
    registration_endpoint: 'https://op.example/register',
  };
  assert.ok(o.validateMetadata(ok));
  for (const [k, v] of [
    ['authorization_endpoint', 'file:///etc/passwd'],
    ['authorization_endpoint', 'someapp://open'],
    ['token_endpoint', 'http://op.example/token'],
    ['revocation_endpoint', 'javascript:alert(1)'],
    ['account_management_uri', 'http://op.example/account'],
  ]) {
    assert.throws(() => o.validateMetadata({ ...ok, [k]: v }), /https|not a URL/, `${k}=${v}`);
  }
});

test('repeated refreshes keep working (each uses the newly rotated token)', async () => {
  const { server, state } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    const { flow, tokens } = flowWithMask(port, dir);
    await flow.start('https://local.test');
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await flow.refresh();
      assert.match(r.accessToken, /^access-/);
    }
    assert.strictEqual(tokens.load().refreshToken, 'refresh-1' + '-rotated'.repeat(4));
    assert.strictEqual(state.tokenRequests.filter((t) => t.grant_type === 'refresh_token').length, 4);
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent refreshes share one request (an old refresh token is never reused)', async () => {
  const { server, state } = makeMockServer();
  const port = await listen(server);
  const dir = tmpDir();
  try {
    const { flow, tokens } = flowWithMask(port, dir);
    await flow.start('https://local.test');
    const [a, b, c] = await Promise.all([flow.refresh(), flow.refresh(), flow.refresh()]);
    assert.strictEqual(a.accessToken, b.accessToken);
    assert.strictEqual(b.accessToken, c.accessToken);
    const grants = state.tokenRequests.filter((t) => t.grant_type === 'refresh_token');
    assert.strictEqual(grants.length, 1, 'only one refresh request should reach the server');
    assert.strictEqual(tokens.load().refreshToken, 'refresh-1-rotated');
    // and the next one still works
    await flow.refresh();
    assert.strictEqual(tokens.load().refreshToken, 'refresh-1-rotated-rotated');
  } finally {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Per-profile isolation (one-app model: one flow + token store per profile)
// ---------------------------------------------------------------------------

test('oauthDirFor: default profile → base dir; named profile → oauth/<slug>', () => {
  const base = '/UD';
  assert.strictEqual(o.oauthDirFor('default', base), base);
  assert.strictEqual(o.oauthDirFor('', base), base);
  assert.strictEqual(o.oauthDirFor(null, base), base);
  assert.strictEqual(o.oauthDirFor('work', base), path.join(base, 'oauth', 'work'));
  assert.strictEqual(o.oauthDirFor('home', base), path.join(base, 'oauth', 'home'));
});

test('two profiles have separate token stores (no cross-profile leakage)', () => {
  const base = tmpDir();
  const safeStub = {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString(),
  };
  try {
    const dirA = o.oauthDirFor('work', base);
    const dirB = o.oauthDirFor('home', base);
    assert.notStrictEqual(dirA, dirB);
    const tokensA = o.tokenStore({ userDataDir: dirA, safeStorage: safeStub });
    const tokensB = o.tokenStore({ userDataDir: dirB, safeStorage: safeStub });
    tokensA.save({ userId: '@a:x', refreshToken: 'ra', accessToken: 'aa' });
    // B must not see A's session, and vice-versa after B saves its own.
    assert.strictEqual(tokensB.load(), null);
    tokensB.save({ userId: '@b:x', refreshToken: 'rb', accessToken: 'ab' });
    assert.strictEqual(tokensA.load().userId, '@a:x');
    assert.strictEqual(tokensA.load().refreshToken, 'ra');
    assert.strictEqual(tokensB.load().userId, '@b:x');
    assert.strictEqual(tokensB.load().refreshToken, 'rb');
    // The default profile keeps using the base dir (legacy location).
    assert.strictEqual(o.oauthDirFor('default', base), base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
