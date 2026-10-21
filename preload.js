// Minimal bridge. Cinny is a pure web app; the only shell feature it talks to is the
// Dock badge. contextIsolation + sandbox stay on and nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');

let gotCount = false;

contextBridge.exposeInMainWorld('cinnyShell', {
  setBadge(count, highlight) {
    gotCount = true;
    ipcRenderer.send('badge', { count: Number(count) || 0, highlight: !!highlight });
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
