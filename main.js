// Cinny in an Electron (Chromium) shell.
// Serves the bundled Cinny web build from a privileged custom scheme (cinny://app)
// so it gets a secure context + a working service worker (Cinny's SW injects the
// access token into authenticated media requests; without it images/files break).
const { app, BrowserWindow, protocol, net, shell, session, Menu, dialog, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const updater = require('./updater');
const P = require('./profiles');
const oauth = require('./oauth');
const profileBar = require('./profile-bar');

const SCHEME = 'cinny';
const HOST = 'app';
const ORIGIN = `${SCHEME}://${HOST}`;
const WEB_ROOT = path.join(__dirname, 'web');
const SELFTEST = process.env.CINNY_SELFTEST === '1';
const APP_NAME = 'iCinny';
const PROFILE_ICON_DIR = path.join(__dirname, 'build', 'profile-icons');

app.setName(APP_NAME);

// --- Profile resolution ----------------------------------------------------
// A profile is picked by the --profile=<slug> launch argument (no flag = the
// default profile, which keeps using today's data folder so the existing login
// is untouched). userData MUST be set BEFORE requestSingleInstanceLock() because
// the single-instance lock is keyed on the userData dir — that is what lets each
// profile be its own single instance and lets different profiles run side by side.
const PROFILE_SLUG = P.parseProfileArg(process.argv);
const IS_DEFAULT = PROFILE_SLUG === P.DEFAULT_SLUG;
const APP_DATA = app.getPath('appData');
const DEFAULT_USER_DATA = app.getPath('userData'); // electron's default before we override
const LEGACY_DIR = path.join(APP_DATA, P.LEGACY_DIRNAME);

app.setPath('userData', P.userDataDir({
  slug: PROFILE_SLUG,
  appData: APP_DATA,
  defaultUserData: DEFAULT_USER_DATA,
  legacyExists: fs.existsSync(LEGACY_DIR),
}));

// Look up this profile's name + colour from the registry (safe on a corrupt file).
function currentProfile() {
  const reg = P.readRegistry(APP_DATA);
  return P.findProfile(reg, PROFILE_SLUG) || P.defaultProfile();
}
let PROFILE = currentProfile();

// The window/About/notification name. Default profile: its registry name if the
// user set one, else "iCinny". Named profile: its name.
function profileName() {
  return PROFILE && PROFILE.name ? PROFILE.name : (IS_DEFAULT ? APP_NAME : PROFILE_SLUG);
}
// Window base title: default → "iCinny"; named → "iCinny — <Name>".
function windowBaseTitle() {
  if (IS_DEFAULT) return APP_NAME;
  return `${APP_NAME} — ${profileName()}`;
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

// Single-instance lock is PER userData dir (set above), so launching the same
// profile twice focuses the existing window while different profiles coexist.
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

// --- Dock icon -------------------------------------------------------------
// Load the PNG for a colour. Returns null if missing (blue falls back to the
// bundle icon, which is already blue — so no setIcon needed for default blue).
function iconForColor(color) {
  const file = path.join(PROFILE_ICON_DIR, `${P.sanitizeColor(color)}.png`);
  try {
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
  } catch {}
  return null;
}

// Apply the profile's colour to the Dock icon. Blue on the default profile is a
// no-op (the bundle icon is already blue). Any other colour, or any named
// profile, gets its coloured icon.
function applyDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const color = (PROFILE && PROFILE.color) || P.DEFAULT_COLOR;
  if (IS_DEFAULT && color === P.DEFAULT_COLOR) return; // bundle icon already blue
  const img = iconForColor(color);
  if (img) app.dock.setIcon(img);
}

// Draw/update the header bar in the profile's colour with its name.
function applyProfileBar() {
  if (!win || win.isDestroyed()) return;
  const color = (PROFILE && PROFILE.color) || P.DEFAULT_COLOR;
  win.webContents.executeJavaScript(profileBar.barScript(color, profileName()), true).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 500,
    title: windowBaseTitle(),
    show: !SELFTEST && process.env.CINNY_UPDATE_TEST !== '1',
    backgroundColor: '#1a1a1a',
    // The native title bar is replaced by a profile-coloured header bar drawn
    // in the page (profile-bar.js); the traffic lights stay, centred in it.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 7 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  // Cinny sets document.title to "Cinny…"; show the app/profile name instead.
  // Default: "<page> (Cinny→iCinny)". Named: prefix with "iCinny — <Name>".
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    const rewritten = String(title || APP_NAME).replace(/Cinny/g, APP_NAME);
    win.setTitle(IS_DEFAULT ? rewritten : `${APP_NAME} — ${profileName()}`);
  });

  // For NAMED profiles, prefix web notification titles with "[<Name>] " so the
  // user can tell which account a notification is from. Done by wrapping
  // window.Notification in the page's main world — contextIsolation + sandbox
  // stay ON (executeJavaScript runs in the page world without a preload bridge).
  if (!IS_DEFAULT) {
    const prefix = `[${profileName()}] `;
    win.webContents.on('dom-ready', () => {
      const js = `(() => {
        if (window.__icinnyNotifyWrapped) return;
        const Native = window.Notification;
        if (!Native) return;
        const PREFIX = ${JSON.stringify(prefix)};
        function Wrapped(title, options) {
          const t = (typeof title === 'string' && title.indexOf(PREFIX) !== 0) ? PREFIX + title : title;
          return new Native(t, options);
        }
        Wrapped.prototype = Native.prototype;
        Object.defineProperty(Wrapped, 'permission', { get() { return Native.permission; } });
        Wrapped.requestPermission = (...a) => Native.requestPermission(...a);
        try { window.Notification = Wrapped; } catch (e) {}
        window.__icinnyNotifyWrapped = true;
      })();`;
      win.webContents.executeJavaScript(js, true).catch(() => {});
    });
  }

  // Profile-coloured header bar (all profiles, so every copy is tinted).
  win.webContents.on('dom-ready', applyProfileBar);

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
  // Each instance has its own process, so each gets its own Dock badge already.
  let last = null;
  ipcMain.on('badge', (_e, { count }) => {
    const text = count > 0 ? (count > 99 ? '99+' : String(count)) : count < 0 ? '•' : '';
    if (text === last) return;
    last = text;
    if (process.platform === 'darwin') app.dock.setBadge(text);
    else app.setBadgeCount(Math.max(count, 0));
  });
}

// --- OAuth (next-gen auth / MAS) --------------------------------------------
// Register the main-process OAuth handlers. The only accepted IPC sender is the
// main app window's webContents (checked inside the module). The refresh token
// is stored encrypted in this profile's userData (already per-profile, set
// before the single-instance lock). Every profile process runs this with its
// own userData, so each account keeps its own refresh token.
function setupOAuth() {
  oauth.registerOAuthIpc({
    getMainWindow: () => win,
    userDataDir: app.getPath('userData'),
  });
}

// --- Launch / focus another profile ---------------------------------------
// Launch a profile as a separate running copy using `open -n -a <this .app>`.
// Uses the running bundle path and passes args as an array (no shell), so a
// profile slug can never be interpreted as a shell token.
function appBundlePath() {
  // .../iCinny.app/Contents/MacOS/iCinny → .../iCinny.app
  const p = path.resolve(path.dirname(process.execPath), '..', '..');
  return p.endsWith('.app') ? p : null;
}

function launchProfile(slug) {
  if (slug === PROFILE_SLUG) {
    // Same profile → focus our own window (the lock makes a second launch a no-op).
    if (win) { win.show(); win.focus(); }
    return;
  }
  const bundle = appBundlePath();
  if (!bundle) {
    // Not packaged (dev run): can't re-open the bundle; inform.
    dialog.showMessageBox({ type: 'info', message: 'Switching profiles needs the installed app.', detail: 'Run the packaged iCinny.app to open other profiles.' });
    return;
  }
  const args = ['-n', '-a', bundle, '--args'];
  if (slug !== P.DEFAULT_SLUG) args.push(`--profile=${slug}`);
  try {
    const child = spawn('/usr/bin/open', args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    dialog.showMessageBox({ type: 'warning', message: 'Could not open that profile', detail: String(e && e.message || e) });
  }
}

// --- Auto-open profiles ----------------------------------------------------
// When the DEFAULT profile starts, launch every profile marked openAtLaunch
// that is not already running. Named profiles never auto-open others.
function autoOpenProfiles() {
  if (!IS_DEFAULT) return;
  const bundle = appBundlePath();
  if (!bundle) return; // dev run
  const reg = P.readRegistry(APP_DATA);
  for (const p of reg) {
    if (p.slug === P.DEFAULT_SLUG) continue;
    if (!p.openAtLaunch) continue;
    launchProfile(p.slug);
  }
}

// --- Profile editor window (New / Edit) ------------------------------------
let editorWin = null;
function openProfileEditor(mode, slug) {
  if (editorWin && !editorWin.isDestroyed()) { editorWin.focus(); return; }
  editorWin = new BrowserWindow({
    width: 420,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: win || undefined,
    modal: !!win,
    title: mode === 'new' ? 'New Profile' : 'Edit Profile',
    backgroundColor: '#1f1f22',
    webPreferences: {
      preload: path.join(__dirname, 'profile-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  editorWin.setMenuBarVisibility(false);
  editorWin.loadFile(path.join(__dirname, 'ui', 'profile-editor.html'));
  editorWin.on('closed', () => { editorWin = null; });

  // Hand the editor its initial data once it's ready.
  editorWin.webContents.on('did-finish-load', () => {
    const existing = mode === 'edit' ? PROFILE : null;
    editorWin.webContents.send('editor:init', {
      mode,
      colors: P.COLORS,
      slug: slug || '',
      name: existing ? existing.name : '',
      color: existing ? existing.color : P.DEFAULT_COLOR,
      openAtLaunch: existing ? !!existing.openAtLaunch : false,
      isDefault: mode === 'edit' ? IS_DEFAULT : false,
    });
  });
}

// IPC from the editor window (validated here; the editor has no privileges).
function setupProfileIpc() {
  ipcMain.handle('profile:save', (_e, payload) => {
    // Only the profile editor window may change profiles.
    if (!editorWin || editorWin.isDestroyed() || _e.sender !== editorWin.webContents) return { ok: false, error: 'Not allowed.' };
    const data = payload && typeof payload === 'object' ? payload : {};
    const name = P.sanitizeName(data.name, '');
    const color = P.sanitizeColor(data.color);
    const openAtLaunch = data.openAtLaunch === true;
    const reg = P.readRegistry(APP_DATA);

    if (data.mode === 'edit') {
      // Edit the CURRENT profile (named or default).
      const idx = reg.findIndex((p) => p.slug === PROFILE_SLUG);
      const entry = {
        slug: PROFILE_SLUG,
        name: name || (IS_DEFAULT ? P.DEFAULT_NAME : PROFILE_SLUG),
        color,
        openAtLaunch: IS_DEFAULT ? false : openAtLaunch,
      };
      if (idx >= 0) reg[idx] = entry; else reg.push(entry);
      P.writeRegistry(APP_DATA, reg);
      PROFILE = entry;
      // Apply live: dock icon + window title.
      applyDockIcon();
      applyProfileBar();
      if (win) win.setTitle(windowBaseTitle());
      app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: `${updater.BUILD.version} (build ${updater.BUILD.build})`,
        credits: aboutCredits(),
      });
      rebuildMenu();
      return { ok: true };
    }

    // New named profile.
    if (!name) return { ok: false, error: 'Please enter a name.' };
    const taken = reg.filter((p) => p.slug !== P.DEFAULT_SLUG).map((p) => p.slug);
    const slug = P.slugFromName(name, taken);
    reg.push({ slug, name, color, openAtLaunch });
    P.writeRegistry(APP_DATA, reg);
    rebuildMenu();
    launchProfile(slug);
    return { ok: true, slug };
  });

  ipcMain.on('profile:close', (e) => {
    if (!editorWin || e.sender !== editorWin.webContents) return;
    if (editorWin && !editorWin.isDestroyed()) editorWin.close();
  });
}

// --- Delete profile --------------------------------------------------------
function deleteProfileFlow(slug) {
  const reg = P.readRegistry(APP_DATA);
  const p = P.findProfile(reg, slug);
  if (!p || slug === P.DEFAULT_SLUG) return;

  // Refuse while that profile is running (its single-instance lock dir is busy).
  if (isProfileRunning(slug)) {
    dialog.showMessageBox(win || undefined, {
      type: 'info',
      message: `“${p.name}” is still open.`,
      detail: 'Quit that profile’s window first, then delete it.',
    });
    return;
  }

  const choice = dialog.showMessageBoxSync(win || undefined, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete the profile “${p.name}”?`,
    detail: `This removes its data on this Mac and signs that account out here. You can add the account again later. This can’t be undone.`,
  });
  if (choice !== 0) return;

  // Remove the data folder, then the registry entry.
  const dir = P.userDataDir({ slug, appData: APP_DATA, defaultUserData: DEFAULT_USER_DATA, legacyExists: false });
  try {
    if (dir && dir.startsWith(P.profilesDir(APP_DATA) + path.sep)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    dialog.showMessageBox(win || undefined, { type: 'warning', message: 'Could not fully remove the data folder', detail: String(e && e.message || e) });
  }
  const next = reg.filter((x) => x.slug !== slug);
  P.writeRegistry(APP_DATA, next);
  rebuildMenu();
}

// Is a profile currently running? Check its single-instance lock dir / userData.
// A running Electron app holds the SingletonLock symlink in its userData dir.
function isProfileRunning(slug) {
  if (slug === PROFILE_SLUG) return true; // us
  const dir = P.userDataDir({ slug, appData: APP_DATA, defaultUserData: DEFAULT_USER_DATA, legacyExists: slug === P.DEFAULT_SLUG && fs.existsSync(LEGACY_DIR) });
  try {
    return fs.existsSync(path.join(dir, 'SingletonLock'));
  } catch {
    return false;
  }
}

// --- Menu ------------------------------------------------------------------
function aboutCredits() {
  const who = IS_DEFAULT && profileName() === APP_NAME ? '' : `Profile: ${profileName()}\n`;
  return `${who}iCinny: the Cinny web client (cinny.in) in an Electron shell`;
}

function profilesMenu() {
  const reg = P.readRegistry(APP_DATA);
  const items = [];
  for (const p of reg) {
    const label = p.slug === P.DEFAULT_SLUG ? (p.name || APP_NAME) : p.name;
    items.push({
      label,
      type: 'checkbox',
      checked: p.slug === PROFILE_SLUG,
      click: () => launchProfile(p.slug),
    });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'New Profile…', click: () => openProfileEditor('new') });
  items.push({ label: 'Edit This Profile…', click: () => openProfileEditor('edit', PROFILE_SLUG) });

  // Delete submenu — named profiles only.
  const deletable = reg.filter((p) => p.slug !== P.DEFAULT_SLUG);
  if (deletable.length) {
    items.push({
      label: 'Delete Profile',
      submenu: deletable.map((p) => ({ label: `${p.name}…`, click: () => deleteProfileFlow(p.slug) })),
    });
  }
  return { label: 'Profiles', submenu: items };
}

function updatesMenuItem() {
  if (IS_DEFAULT) {
    return { label: 'Check for Updates…', click: () => updater.check({ manual: true }) };
  }
  // Named profiles don't run the updater. Explain in plain language.
  return {
    label: 'Check for Updates…',
    click: () => dialog.showMessageBox(win || undefined, {
      type: 'info',
      message: 'Updates are handled by your main iCinny.',
      detail: 'Open the main iCinny window and choose “Check for Updates…” there. All profiles update together.',
    }),
  };
}

function buildMenuTemplate() {
  return [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        updatesMenuItem(),
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
    profilesMenu(),
    { role: 'windowMenu' },
  ];
}

function rebuildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function setupMenu() {
  rebuildMenu();
}

async function selfTest() {
  // Headless check: app loads, secure context, SW registers & controls the page.
  const out = { profile: PROFILE_SLUG };
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
  setupProfileIpc();
  setupOAuth();
  setupMenu();
  applyDockIcon();
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: `${updater.BUILD.version} (build ${updater.BUILD.build})`,
    credits: aboutCredits(),
  });
  createWindow();
  if (SELFTEST) {
    selfTest();
  } else {
    // Only the DEFAULT profile runs the updater and auto-opens other profiles.
    if (IS_DEFAULT) {
      updater.start(() => win, { appData: APP_DATA });
      autoOpenProfiles();
    } else {
      // Named profile: watch for a quit-request from the default instance
      // (used during an update swap) and quit when asked.
      updater.watchQuitRequest(APP_DATA, () => { app.isQuitting = true; app.quit(); });
    }
  }
});

app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});
app.on('activate', () => {
  if (win) win.show(); else createWindow();
});
app.on('before-quit', () => {
  app.isQuitting = true;
  if (IS_DEFAULT) updater.installOnQuit({ appData: APP_DATA });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
