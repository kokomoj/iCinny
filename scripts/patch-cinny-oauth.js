// Build-time patch to Cinny's web source: sign in to OAuth-only (MAS /
// "next-gen auth") homeservers.
//
// Upstream Cinny only knows password/SSO/token login. A homeserver that only
// offers OAuth returns 404 M_UNRECOGNIZED from GET /_matrix/client/v3/login, so
// AuthFlowsLoader throws and the login page shows "Failed to get authentication
// flow information." These edits:
//   1. Make AuthFlowsLoader, when login flows are unavailable, probe the auth
//      metadata endpoint (v1 then the unstable MSC2965 one). If metadata is
//      found it succeeds with an `oauthMetadata` marker instead of erroring.
//   2. Add a "Continue with <server host>" button to the login page when
//      oauthMetadata is present. The button calls the shell's main-process OAuth
//      flow (window.cinnyShell.oauth.*), stores the returned session like a
//      normal login, and reloads. The password form still renders when password
//      flows also exist.
//   3. Mark OAuth sessions (cinny_oauth=1) and wire createClient() for token
//      refresh: an OAuth session gets a refreshToken marker + a
//      tokenRefreshFunction that calls the shell, updates cinny_access_token in
//      localStorage, and re-pushes the session to the service worker so media
//      downloads keep working. Password sessions are untouched.
//   4. On startup, if the stored OAuth token is expired, refresh before the
//      client starts.
//   5. Sign out: for OAuth sessions, revoke + clear the main-process token
//      before Cinny's normal logout.
//
// Each edit is anchored; if an anchor moves upstream the patch WARNs and skips
// EVERY edit (so a partial, inconsistent patch is never written) and the build
// still produces a working password-login app.
const fs = require('fs');
const path = require('path');

const cinnyDir = process.argv[2] || path.join(__dirname, '..', '..', 'cinny-web');
const MARK = '/* cinny-electron:oauth */';

const f = (rel) => path.join(cinnyDir, rel);

// ---------------------------------------------------------------------------
// Each edit targets one file. find must be present exactly once.
// ---------------------------------------------------------------------------
const edits = [
  // --- 1. AuthFlows type: add the optional oauthMetadata marker --------------
  {
    file: 'src/app/hooks/useAuthFlows.ts',
    name: 'AuthFlows type: oauthMetadata field',
    find: `export type AuthFlows = {
  loginFlows: ILoginFlowsResponse;
  registerFlows: RegisterFlowsResponse;
};`,
    replace: `export type OAuthMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint?: string;
  account_management_uri?: string;
};
export type AuthFlows = {
  loginFlows: ILoginFlowsResponse;
  registerFlows: RegisterFlowsResponse;
  oauthMetadata?: OAuthMetadata;
};`,
  },

  // --- 2. AuthFlowsLoader: probe auth metadata when login flows fail ---------
  {
    file: 'src/app/components/AuthFlowsLoader.tsx',
    name: 'AuthFlowsLoader: oauth metadata fallback',
    find: `      if (!loginFlows) {
        throw new Error('Missing auth flow!');
      }
      if ('errcode' in loginFlows) {
        throw new Error('Failed to load auth flow!');
      }

      const authFlows: AuthFlows = {
        loginFlows,
        registerFlows,
      };

      return authFlows;`,
    replace: `      ${MARK}
      // OAuth-only homeservers (MAS / next-gen auth) return 404 M_UNRECOGNIZED
      // from the login-flows endpoint. Before failing, look for OAuth auth
      // metadata; if present, this client can still sign in via the shell's
      // native OAuth flow.
      const oauthCapable = typeof (window as any).cinnyShell?.oauth?.start === 'function';
      if ((!loginFlows || 'errcode' in loginFlows) && oauthCapable) {
        const metaPaths = [
          '/_matrix/client/v1/auth_metadata',
          '/_matrix/client/unstable/org.matrix.msc2965/auth_metadata',
        ];
        for (const mp of metaPaths) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const r = await fetch(\`\${baseUrl.replace(/\\/+$/, '')}\${mp}\`, {
              headers: { Accept: 'application/json' },
            });
            if (!r.ok) continue;
            // eslint-disable-next-line no-await-in-loop
            const meta = await r.json();
            if (meta && meta.issuer && meta.authorization_endpoint && meta.token_endpoint) {
              return {
                loginFlows: { flows: [] } as any,
                registerFlows,
                oauthMetadata: meta,
                oauthBaseUrl: baseUrl,
              } as AuthFlows;
            }
          } catch {
            /* try the next path */
          }
        }
      }

      if (!loginFlows) {
        throw new Error('Missing auth flow!');
      }
      if ('errcode' in loginFlows) {
        throw new Error('Failed to load auth flow!');
      }

      const authFlows: AuthFlows = {
        loginFlows,
        registerFlows,
      };

      return authFlows;`,
  },

  // --- 3. Login page: the "Continue with <host>" button ---------------------
  {
    file: 'src/app/pages/auth/login/Login.tsx',
    name: 'Login: import OAuthLogin',
    find: `import { useClientConfig } from '../../../hooks/useClientConfig';`,
    replace: `import { useClientConfig } from '../../../hooks/useClientConfig';
import { OAuthLogin } from './OAuthLogin';
${MARK}`,
  },
  {
    file: 'src/app/pages/auth/login/Login.tsx',
    name: 'Login: render OAuth button',
    find: `  const parsedFlows = useParsedLoginFlows(loginFlows.flows);

  return (
    <Box direction="Column" gap="500">
      <Text size="H2" priority="400">
        Login
      </Text>`,
    replace: `  const parsedFlows = useParsedLoginFlows(loginFlows.flows);
  // oauthMetadata sits on the AuthFlows object (next to loginFlows), not inside it.
  const authFlowsExtra = useAuthFlows() as any;
  const oauthMetadata = authFlowsExtra.oauthMetadata;

  return (
    <Box direction="Column" gap="500">
      <Text size="H2" priority="400">
        Login
      </Text>
      {oauthMetadata && (
        <>
          <OAuthLogin server={server} baseUrl={authFlowsExtra.oauthBaseUrl} />
          {parsedFlows.password && <OrDivider />}
        </>
      )}`,
  },
  {
    file: 'src/app/pages/auth/login/Login.tsx',
    name: 'Login: no "not supported" error when OAuth sign-in is offered',
    find: `      {!parsedFlows.password && !parsedFlows.sso && (`,
    replace: `      {!parsedFlows.password && !parsedFlows.sso && !oauthMetadata && (`,
  },
];

// ---------------------------------------------------------------------------
// A whole new source file Cinny doesn't have: the OAuth login button + waiting
// UI with a Cancel escape hatch, wired to window.cinnyShell.oauth.
// ---------------------------------------------------------------------------
const NEW_FILES = [
  {
    file: 'src/app/pages/auth/login/OAuthLogin.tsx',
    contents: `${MARK}
import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, Overlay, OverlayBackdrop, OverlayCenter, Spinner, Text, color } from 'folds';
import { setFallbackSession } from '../../../state/sessions';
import { useNavigate } from 'react-router-dom';
import { getHomePath } from '../../pathUtils';

// Sign in to an OAuth-only (MAS / next-gen auth) homeserver via the shell's
// main-process OAuth flow. The access token comes back to the page and is stored
// like a normal login; the refresh token stays in the main process.
type OAuthLoginProps = { server: string; baseUrl?: string };
export function OAuthLogin({ server, baseUrl: discoveredBaseUrl }: OAuthLoginProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const shell = (window as any).cinnyShell?.oauth;
    if (!shell?.onStatus) return undefined;
    const off = shell.onStatus(() => {});
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  const handleStart = useCallback(async () => {
    const shell = (window as any).cinnyShell?.oauth;
    if (!shell?.start) {
      setError('Sign-in is not available in this build.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      // The homeserver base URL is discovered from .well-known already; pass the
      // server the user chose. The main process re-discovers + validates it.
      const baseUrl = discoveredBaseUrl || \`https://\${server}\`;
      const res = await shell.start(baseUrl);
      if (!res || !res.ok) {
        setBusy(false);
        setError(res?.error ? \`Could not sign in: \${res.error}\` : 'Could not sign in.');
        return;
      }
      const s = res.result;
      // Mark this as an OAuth session so the client wires token refresh for it.
      localStorage.setItem('cinny_oauth', '1');
      setFallbackSession(s.accessToken, s.deviceId, s.userId, s.baseUrl);
      // Same hand-off as Cinny's password login (useLoginComplete).
      navigate(getHomePath(), { replace: true });
    } catch (e: any) {
      setBusy(false);
      setError(e?.message ? \`Could not sign in: \${e.message}\` : 'Could not sign in.');
    }
  }, [server, discoveredBaseUrl, navigate]);

  const handleCancel = useCallback(async () => {
    const shell = (window as any).cinnyShell?.oauth;
    try {
      await shell?.cancel?.();
    } catch {
      /* ignore */
    }
    setBusy(false);
  }, []);

  return (
    <Box direction="Column" gap="300">
      <Button variant="Primary" size="500" onClick={handleStart} disabled={busy}>
        <Text as="span" size="B500">
          {\`Continue with \${server}\`}
        </Text>
      </Button>
      {error && (
        <Text size="T300" style={{ color: color.Critical.Main }}>
          {error}
        </Text>
      )}
      <Overlay open={busy} backdrop={<OverlayBackdrop />}>
        <OverlayCenter>
          <Box
            direction="Column"
            gap="400"
            alignItems="Center"
            style={{
              padding: '1.5rem 2rem',
              backgroundColor: color.Surface.Container,
              color: color.Surface.OnContainer,
              borderRadius: '1rem',
              boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
              maxWidth: '22rem',
            }}
          >
            <Spinner variant="Secondary" size="600" />
            <Text align="Center">Finish signing in in your browser…</Text>
            <Button variant="Secondary" fill="Soft" size="400" onClick={handleCancel}>
              <Text as="span" size="B400">
                Cancel
              </Text>
            </Button>
          </Box>
        </OverlayCenter>
      </Overlay>
    </Box>
  );
}
`,
  },
];

// ---------------------------------------------------------------------------
// 4 + 5. createClient token refresh, startup refresh, OAuth-aware logout, all in
// initMatrix.ts.
// ---------------------------------------------------------------------------
edits.push(
  {
    file: 'src/client/initMatrix.ts',
    name: 'initMatrix: imports for oauth refresh',
    find: `import { createClient, MatrixClient, IndexedDBStore, IndexedDBCryptoStore } from 'matrix-js-sdk';

import { cryptoCallbacks } from './secretStorageKeys';
import { clearNavToActivePathStore } from '../app/state/navToActivePath';
import { pushSessionToSW } from '../sw-session';`,
    replace: `import { createClient, MatrixClient, IndexedDBStore, IndexedDBCryptoStore } from 'matrix-js-sdk';

import { cryptoCallbacks } from './secretStorageKeys';
import { clearNavToActivePathStore } from '../app/state/navToActivePath';
import { pushSessionToSW } from '../sw-session';
${MARK}
// OAuth (next-gen auth / MAS) sessions keep their refresh token in the Electron
// main process. The access token expires in minutes, so the client refreshes it
// through the shell. Password sessions have no cinny_oauth flag and are untouched.
const isOAuthSession = (): boolean => localStorage.getItem('cinny_oauth') === '1';
const shellOAuth = (): any => (window as any).cinnyShell?.oauth;

// Ask the main process to refresh; update localStorage + the service worker so
// media downloads keep working with the new token.
const refreshViaShell = async (
  baseUrl: string
): Promise<{ accessToken: string; refreshToken: string; expiry?: Date }> => {
  const res = await shellOAuth()?.refresh();
  if (!res || !res.ok || !res.result?.accessToken) {
    throw new Error(res?.error || 'token refresh failed');
  }
  const accessToken = res.result.accessToken as string;
  localStorage.setItem('cinny_access_token', accessToken);
  pushSessionToSW(baseUrl, accessToken);
  const expiry =
    typeof res.result.expiresInMs === 'number'
      ? new Date(Date.now() + res.result.expiresInMs)
      : undefined;
  // The SDK stores whatever refreshToken we return and refuses to refresh again
  // (logging the user out) if it's empty. The real token stays in the main
  // process, so hand back the same non-empty marker every time.
  return { accessToken, refreshToken: 'shell', expiry };
};

// Refresh on startup if the stored OAuth token is already expired, so the client
// starts with a live token.
export const refreshOAuthOnStartupIfExpired = async (session: {
  baseUrl: string;
  accessToken: string;
}): Promise<string> => {
  if (!isOAuthSession() || !shellOAuth()?.info) return session.accessToken;
  try {
    const info = await shellOAuth().info();
    if (info?.ok && info.result?.expired) {
      const { accessToken } = await refreshViaShell(session.baseUrl);
      return accessToken;
    }
  } catch {
    /* fall through with the existing token */
  }
  return session.accessToken;
};`,
  },
  {
    file: 'src/client/initMatrix.ts',
    name: 'initMatrix: createClient refresh wiring',
    find: `  const mx = createClient({
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    store: indexedDBStore,
    cryptoStore: legacyCryptoStore,
    deviceId: session.deviceId,
    timelineSupport: true,
    cryptoCallbacks: cryptoCallbacks as any,
    verificationMethods: ['m.sas.v1'],
  });`,
    replace: `  ${MARK}
  const oauth = isOAuthSession();
  const accessToken = oauth
    ? await refreshOAuthOnStartupIfExpired(session)
    : session.accessToken;

  const mx = createClient({
    baseUrl: session.baseUrl,
    accessToken,
    userId: session.userId,
    store: indexedDBStore,
    cryptoStore: legacyCryptoStore,
    deviceId: session.deviceId,
    timelineSupport: true,
    cryptoCallbacks: cryptoCallbacks as any,
    verificationMethods: ['m.sas.v1'],
    // For OAuth sessions, enable the SDK's refresh path. The real refresh token
    // lives in the main process, so we pass a non-empty marker here and do the
    // actual refresh through the shell.
    ...(oauth
      ? {
          refreshToken: 'shell',
          tokenRefreshFunction: async () => refreshViaShell(session.baseUrl),
        }
      : {}),
  });`,
  },
  {
    file: 'src/client/initMatrix.ts',
    name: 'initMatrix: oauth-aware logout',
    find: `export const logoutClient = async (mx: MatrixClient) => {
  pushSessionToSW();
  mx.stopClient();
  try {
    await mx.logout();
  } catch {
    // ignore if failed to logout
  }
  await mx.clearStores();
  window.localStorage.clear();
  window.location.reload();
};`,
    replace: `export const logoutClient = async (mx: MatrixClient) => {
  ${MARK}
  // For OAuth sessions, revoke + clear the main-process token first.
  if (isOAuthSession() && shellOAuth()?.logout) {
    try {
      await shellOAuth().logout(localStorage.getItem('cinny_access_token') || undefined);
    } catch {
      /* ignore revoke failure; still clear local session below */
    }
  }
  pushSessionToSW();
  mx.stopClient();
  try {
    await mx.logout();
  } catch {
    // ignore if failed to logout
  }
  await mx.clearStores();
  window.localStorage.clear();
  window.location.reload();
};`,
  }
);

// ---------------------------------------------------------------------------
// Apply: verify every anchor first, then write. All-or-nothing.
// ---------------------------------------------------------------------------
function run() {
  // Idempotency: if any target already carries the mark, treat as applied.
  const anyMarked = [...new Set(edits.map((e) => e.file))].some((rel) => {
    try {
      return fs.readFileSync(f(rel), 'utf8').includes(MARK);
    } catch {
      return false;
    }
  });
  if (anyMarked) {
    console.log('oauth patch: already applied');
    return 0;
  }

  // Load each file once, check all anchors.
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) cache.set(rel, fs.readFileSync(f(rel), 'utf8'));
    return cache.get(rel);
  };

  let ok = true;
  for (const e of edits) {
    let src;
    try {
      src = read(e.file);
    } catch (err) {
      console.warn(`oauth patch: cannot read ${e.file} — ${err.message}`);
      ok = false;
      continue;
    }
    const count = src.split(e.find).length - 1;
    if (count !== 1) {
      console.warn(
        `oauth patch: ANCHOR ${count === 0 ? 'NOT FOUND' : 'AMBIGUOUS'} for "${e.name}" in ${e.file}`
      );
      ok = false;
    }
  }

  if (!ok) {
    console.warn('oauth patch: one or more anchors missing — leaving stock login (no OAuth).');
    return 0;
  }

  // Everything matched → apply edits and write new files.
  for (const e of edits) {
    const src = read(e.file);
    cache.set(e.file, src.replace(e.find, e.replace));
  }
  for (const [rel, src] of cache) fs.writeFileSync(f(rel), src);
  for (const nf of NEW_FILES) {
    const p = f(nf.file);
    if (fs.existsSync(p)) {
      console.warn(`oauth patch: ${nf.file} already exists — skipping its creation`);
      continue;
    }
    fs.writeFileSync(p, nf.contents);
  }

  console.log(`oauth patch: applied ${edits.length} edits + ${NEW_FILES.length} new file(s)`);
  return 0;
}

process.exit(run());
