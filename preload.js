// Minimal bridge. Cinny is a pure web app; the shell features it talks to are the
// Dock badge and (for OAuth-only homeservers) the main-process OAuth flow.
// contextIsolation + sandbox stay on and nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');

let gotCount = false;

// Listeners the page registers for OAuth progress ("Finish signing in in your
// browser…"). Kept in the preload so the page gets a plain callback, not an
// ipcRenderer handle.
const oauthStatusListeners = new Set();
ipcRenderer.on('oauth:status', (_e, status) => {
  oauthStatusListeners.forEach((fn) => {
    try {
      fn(status);
    } catch {
      /* ignore listener errors */
    }
  });
});

contextBridge.exposeInMainWorld('cinnyShell', {
  setBadge(count, highlight) {
    gotCount = true;
    ipcRenderer.send('badge', { count: Number(count) || 0, highlight: !!highlight });
  },

  // OAuth sign-in for OAuth-only (MAS) homeservers. Each call returns the
  // main-process result object { ok, result?/error? }. The access token comes
  // back to the page (to be stored like a normal login); the refresh token
  // never leaves the main process.
  oauth: {
    // Begin sign-in for an https homeserver base URL. Resolves when the browser
    // round-trip completes (or rejects via { ok:false }).
    start(baseUrl) {
      return ipcRenderer.invoke('oauth:start', String(baseUrl || ''));
    },
    // Abort an in-flight start() (the Cancel button).
    cancel() {
      return ipcRenderer.invoke('oauth:cancel');
    },
    // Refresh the access token using the stored refresh token.
    refresh() {
      return ipcRenderer.invoke('oauth:refresh');
    },
    // Revoke + clear the stored OAuth session (sign out). accessToken optional.
    logout(accessToken) {
      return ipcRenderer.invoke('oauth:logout', accessToken ? String(accessToken) : undefined);
    },
    // Stored-session info: account_management_uri, userId, expiry (for the OIDC
    // dashboard link and startup refresh).
    info() {
      return ipcRenderer.invoke('oauth:info');
    },
    // Subscribe to progress phases. Returns an unsubscribe function.
    onStatus(fn) {
      if (typeof fn !== 'function') return () => {};
      oauthStatusListeners.add(fn);
      return () => oauthStatusListeners.delete(fn);
    },
  },
});

// Fallback for when the build-time count patch is missing: Cinny swaps the favicon to
// cinny-unread / cinny-highlight. Watch it and show a dot.
window.addEventListener('DOMContentLoaded', () => {
  const fav = document.getElementById('favicon');
  if (!fav) return;
  const report = () => {
    if (gotCount) return;
    const href = fav.getAttribute('href') || '';
    const unread = /unread|highlight/i.test(href);
    ipcRenderer.send('badge', { count: unread ? -1 : 0, highlight: /highlight/i.test(href) });
  };
  new MutationObserver(report).observe(fav, { attributes: true, attributeFilter: ['href'] });
  report();
});
