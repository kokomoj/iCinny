// Cinny in an Electron (Chromium) shell.
// Serves the bundled Cinny web build from a privileged custom scheme (cinny://app)
// so it gets a secure context + a working service worker (Cinny's SW injects the
// access token into authenticated media requests; without it images/files break).
const { app, BrowserWindow, protocol, net, shell, session, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const updater = require('./updater');

const SCHEME = 'cinny';
const HOST = 'app';
const ORIGIN = `${SCHEME}://${HOST}`;
const WEB_ROOT = path.join(__dirname, 'web');
const SELFTEST = process.env.CINNY_SELFTEST === '1';
const APP_NAME = 'iCinny';

// The app was renamed Cinny → iCinny. If a profile from the old name exists
// (~/Library/Application Support/Cinny), keep using it so logins and keys carry over.
app.setName(APP_NAME);
{
  const legacy = path.join(app.getPath('appData'), 'Cinny');
  if (fs.existsSync(legacy)) app.setPath('userData', legacy);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      allowServiceWorkers: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

// Keep the sync loop alive while the window is hidden/backgrounded — the
// desktop-app disconnects we are escaping were background throttling.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
}

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const candidate = path.normalize(path.join(WEB_ROOT, clean));
  if (!candidate.startsWith(WEB_ROOT + path.sep)) return null; // path traversal guard (no sibling-prefix escape)
  try {
    if (clean && fs.statSync(candidate).isFile()) return candidate;
  } catch {}
  return null;
}

function registerAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    // SPA fallback: unknown routes → index.html (Cinny uses browser routing)
    const file = resolveFile(url.pathname) || path.join(WEB_ROOT, 'index.html');
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    if (file.endsWith('.js') || file.endsWith('.mjs')) headers.set('Content-Type', 'text/javascript');
    if (file.endsWith('.json')) headers.set('Content-Type', 'application/json');
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    if (path.basename(file) === 'sw.js') headers.set('Service-Worker-Allowed', '/');
    return new Response(res.body, { status: res.status, headers });
  });
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 500,
    title: APP_NAME,
    show: !SELFTEST && process.env.CINNY_UPDATE_TEST !== '1',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  // Cinny sets document.title to "Cinny…"; show the app's own name instead.
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    win.setTitle(String(title || APP_NAME).replace(/Cinny/g, APP_NAME));
  });

  // External links → default browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) return { action: 'allow' };
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault();
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(`${ORIGIN}/`);

  // macOS: closing the window hides it (keeps syncing + notifications), like Element.
  win.on('close', (e) => {
    if (process.platform === 'darwin' && !app.isQuitting && !SELFTEST) {
      e.preventDefault();
      win.hide();
    }
  });
}

function setupDownloads() {
  // The thing that is broken in Cinny Desktop: real "Save As" for downloads.
  session.defaultSession.on('will-download', (_event, item) => {
    const target = dialog.showSaveDialogSync(win, {
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
    });
    if (target) item.setSavePath(target);
    else item.cancel();
  });
}

function setupPermissions() {
  const allowed = new Set(['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith(ORIGIN) && allowed.has(permission));
  });
}

function setupBadge() {
  // count > 0 → number; -1 → dot (favicon fallback); 0 → clear.
  let last = null;
  ipcMain.on('badge', (_e, { count }) => {
    const text = count > 0 ? (count > 99 ? '99+' : String(count)) : count < 0 ? '•' : '';
    if (text === last) return;
    last = text;
    if (process.platform === 'darwin') app.dock.setBadge(text);
    else app.setBadgeCount(Math.max(count, 0));
  });
}

function setupMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => updater.check({ manual: true }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function selfTest() {
  // Headless check: app loads, secure context, SW registers & controls the page.
  const out = {};
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await new Promise((r) => setTimeout(r, 4000));
    const js = `(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await navigator.serviceWorker.ready;
      await new Promise(r => setTimeout(r, 1500));
      return {
        href: location.href,
        title: document.title,
        secure: window.isSecureContext,
        subtle: !!(crypto && crypto.subtle),
        swRegistered: !!reg,
        swScope: reg && reg.scope,
        swControlling: !!navigator.serviceWorker.controller,
        hasRoot: !!document.getElementById('root') && document.getElementById('root').children.length > 0,
        indexedDB: !!window.indexedDB,
        badgeBridge: typeof (window.cinnyShell && window.cinnyShell.setBadge) === 'function',
        ua: navigator.userAgent
      };
    })()`;
    Object.assign(out, await win.webContents.executeJavaScript(js, true));
    // If SW didn't claim on first load, a reload is normal — check again.
    if (!out.swControlling) {
      win.webContents.reload();
      await new Promise((r) => win.webContents.once('did-finish-load', r));
      await new Promise((r) => setTimeout(r, 2500));
      out.swControllingAfterReload = await win.webContents.executeJavaScript('!!navigator.serviceWorker.controller', true);
    }
    // Cross-origin reachability of the homeserver from the app origin (CORS path Cinny uses).
    out.homeserver = await win.webContents.executeJavaScript(
      `fetch('https://matrix-client.matrix.org/_matrix/client/versions').then(r => r.status).catch(e => 'ERR ' + e.message)`, true);
    out.config = await win.webContents.executeJavaScript(
      `fetch('/config.json').then(r => r.json()).then(c => ({homeserverList: c.homeserverList, defaultHomeserver: c.defaultHomeserver})).catch(e => 'ERR ' + e.message)`, true);
  } catch (e) {
    out.error = String(e && e.stack || e);
  }
  console.log('SELFTEST_RESULT ' + JSON.stringify(out));
  app.exit(0);
}

app.whenReady().then(() => {
  registerAppProtocol();
  setupPermissions();
  setupDownloads();
  setupBadge();
  setupMenu();
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: `${updater.BUILD.version} (build ${updater.BUILD.build})`,
    credits: 'iCinny: the Cinny web client (cinny.in) in an Electron shell',
  });
  createWindow();
  if (SELFTEST) selfTest();
  else updater.start(() => win);
});

app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});
app.on('activate', () => {
  if (win) win.show(); else createWindow();
});
app.on('before-quit', () => {
  app.isQuitting = true;
  updater.installOnQuit();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
