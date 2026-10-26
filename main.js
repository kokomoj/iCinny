// Cinny in an Electron (Chromium) shell.
// Serves the bundled Cinny web build from a privileged custom scheme (cinny://app)
// so it gets a secure context + a working service worker (Cinny's SW injects the
// access token into authenticated media requests; without it images/files break).
//
// Profiles: ONE process, one Dock icon, a window per profile (like Chrome
// windows). The DEFAULT profile uses session.defaultSession (today's userData,
// so its login is untouched); every NAMED profile uses its own persisted
// session partition so its storage is isolated. The coloured header bar and the
// notification tag — applied per window — are how profiles are told apart.
const { app, BrowserWindow, protocol, net, shell, session, Menu, dialog, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
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

// --- userData (default profile) --------------------------------------------
// There is only one process. userData is the DEFAULT profile's store: the
// legacy "<appData>/Cinny" folder if it exists (so the existing login survives
// the iCinny rename), else electron's normal default dir. Named profiles live
// in their own session partitions inside this same userData, isolated by
// Chromium — no per-profile userData override.
const APP_DATA = app.getPath('appData');
const DEFAULT_USER_DATA = app.getPath('userData'); // electron's default before override
const LEGACY_DIR = path.join(APP_DATA, P.LEGACY_DIRNAME);
app.setPath('userData', P.userDataDir({
  slug: P.DEFAULT_SLUG,
  appData: APP_DATA,
  defaultUserData: DEFAULT_USER_DATA,
  legacyExists: fs.existsSync(LEGACY_DIR),
}));
const BASE_USER_DATA = app.getPath('userData');

function readRegistry() {
  return P.readRegistry(APP_DATA);
}
// The profile object for a slug (safe on a corrupt/missing registry).
function profileFor(slug) {
  return P.findProfile(readRegistry(), slug) || P.defaultProfile();
}
function isDefaultSlug(slug) {
  return !slug || slug === P.DEFAULT_SLUG;
}
// Display name for a profile. Default: its registry name if set, else "iCinny".
function profileName(slug) {
  const p = profileFor(slug);
  if (p && p.name) return p.name;
  return isDefaultSlug(slug) ? APP_NAME : slug;
}
// Is there more than one profile (default + at least one named)? Governs
// whether the window title and notifications get a profile tag.
function multiProfile() {
  try {
    return readRegistry().some((p) => p.slug !== P.DEFAULT_SLUG);
  } catch {
    return false;
  }
}
// Window base title: a lone default profile → "iCinny"; otherwise
// "iCinny — <Name>".
function windowBaseTitle(slug) {
  if (isDefaultSlug(slug) && !multiProfile()) return APP_NAME;
  return `${APP_NAME} — ${profileName(slug)}`;
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

// One single-instance lock for the whole app (all profiles share the process).
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

// --- Per-session setup -----------------------------------------------------
// Everything that used to live on the default session is installed on EVERY
// profile session here, so named profiles behave identically to the default
// one (protocol, permissions, downloads).
const configuredSessions = new WeakSet();
function setupSession(ses) {
  if (!ses || configuredSessions.has(ses)) return;
  configuredSessions.add(ses);

  // cinny://app → the bundled web build (SPA fallback to index.html).
  ses.protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    const file = resolveFile(url.pathname) || path.join(WEB_ROOT, 'index.html');
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    if (file.endsWith('.js') || file.endsWith('.mjs')) headers.set('Content-Type', 'text/javascript');
    if (file.endsWith('.json')) headers.set('Content-Type', 'application/json');
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    if (path.basename(file) === 'sw.js') headers.set('Service-Worker-Allowed', '/');
    return new Response(res.body, { status: res.status, headers });
  });

  // Only our own origin may use notifications/media/clipboard/fullscreen.
  const allowed = new Set(['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith(ORIGIN) && allowed.has(permission));
  });

  // Real "Save As" for downloads (the thing broken in Cinny Desktop). Target
  // the window that initiated the download when we can find it.
  ses.on('will-download', (_event, item, webContents) => {
    const owner = BrowserWindow.fromWebContents(webContents) || frontWindow();
    const target = dialog.showSaveDialogSync(owner || undefined, {
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
    });
    if (target) item.setSavePath(target);
    else item.cancel();
  });
}

// --- Windows (one per profile) ---------------------------------------------
const windows = new Map(); // slug -> BrowserWindow
const wcToSlug = new Map(); // webContents.id -> slug

function slugForWebContents(wc) {
  return wc ? (wcToSlug.get(wc.id) || null) : null;
}
// The profile window currently focused, or any open one as a fallback.
function frontWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && wcToSlug.has(focused.webContents.id)) return focused;
  for (const w of windows.values()) if (w && !w.isDestroyed()) return w;
  return null;
}

// Coloured dot per profile colour, used in notification titles.
const COLOR_DOT = { blue: '🔵', red: '🔴', green: '🟢', purple: '🟣', orange: '🟠', graphite: '⚫' };

// The profile's coloured iCinny PNG as a 128px data URL, for the notification
// picture. Returns null if the icon is missing (notifications then show no
// custom picture). build/profile-icons/*.png is kept for exactly this.
function iconDataUrl(color) {
  const file = path.join(PROFILE_ICON_DIR, `${P.sanitizeColor(color)}.png`);
  try {
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img.resize({ width: 128, height: 128 }).toDataURL();
    }
  } catch {}
  return null;
}

// --- Per-window header bar + notification tag ------------------------------
function applyProfileBar(win, slug) {
  if (!win || win.isDestroyed()) return;
  const color = (profileFor(slug) || {}).color || P.DEFAULT_COLOR;
  win.webContents.executeJavaScript(profileBar.barScript(color, profileName(slug)), true).catch(() => {});
}

// Tag notifications (coloured dot + name prefix, coloured icon) once there is
// more than one profile; a lone default profile keeps plain notifications.
function notificationTag(slug) {
  if (isDefaultSlug(slug) && !multiProfile()) return null;
  const color = (profileFor(slug) || {}).color || P.DEFAULT_COLOR;
  return {
    prefix: `${COLOR_DOT[color] || COLOR_DOT.blue} ${profileName(slug)} · `,
    icon: iconDataUrl(color),
  };
}

function applyNotificationTag(win, slug) {
  if (!win || win.isDestroyed()) return;
  const tag = notificationTag(slug);
  const js = `(() => {
    window.__icinnyNotifyTag = ${JSON.stringify(tag)};
    if (window.__icinnyNotifyWrapped) return;
    const Native = window.Notification;
    if (!Native) return;
    function Wrapped(title, options) {
      const tag = window.__icinnyNotifyTag;
      if (!tag) return new Native(title, options);
      const t = typeof title === 'string' && title.indexOf(tag.prefix) !== 0 ? tag.prefix + title : title;
      const o = Object.assign({}, options || {});
      if (tag.icon) o.icon = tag.icon;
      return new Native(t, o);
    }
    Wrapped.prototype = Native.prototype;
    Object.defineProperty(Wrapped, 'permission', { get() { return Native.permission; } });
    Wrapped.requestPermission = (...a) => Native.requestPermission(...a);
    try { window.Notification = Wrapped; } catch (e) {}
    window.__icinnyNotifyWrapped = true;
  })();`;
  win.webContents.executeJavaScript(js, true).catch(() => {});
}

// Create (or focus) a profile's window in THIS process.
function openProfileWindow(slug) {
  const existing = windows.get(slug);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }

  const partition = P.partitionFor(slug);
  const ses = partition ? session.fromPartition(partition) : session.defaultSession;
  setupSession(ses);

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 500,
    title: windowBaseTitle(slug),
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
      session: ses,
    },
  });

  windows.set(slug, win);
  wcToSlug.set(win.webContents.id, slug);

  // Cinny sets document.title to "Cinny…"; show the app/profile name instead.
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    if (isDefaultSlug(slug) && !multiProfile()) {
      win.setTitle(String(title || APP_NAME).replace(/Cinny/g, APP_NAME));
    } else {
      win.setTitle(`${APP_NAME} — ${profileName(slug)}`);
    }
  });

  // Per-window notification tag + header bar; re-applied on each load.
  win.webContents.on('dom-ready', () => applyNotificationTag(win, slug));
  win.webContents.on('dom-ready', () => applyProfileBar(win, slug));

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

  // Closing a profile window closes just that window (no app-wide hide): the
  // process stays alive for the other profiles. The badge drops this window's
  // contribution.
  // Capture the id now: after 'closed' the window and its webContents are
  // destroyed and reading win.webContents throws.
  const wcId = win.webContents.id;
  win.on('closed', () => {
    badgeCounts.delete(wcId);
    refreshBadge();
    wcToSlug.delete(wcId);
    if (windows.get(slug) === win) windows.delete(slug);
  });

  return win;
}

// --- Dock badge (sum across windows) ---------------------------------------
const badgeCounts = new Map(); // webContents.id -> count (>0 number, -1 dot, 0 none)
let lastBadge = null;

function refreshBadge() {
  let total = 0;
  let anyDot = false;
  for (const c of badgeCounts.values()) {
    if (c > 0) total += c;
    else if (c < 0) anyDot = true;
  }
  const text = total > 0 ? (total > 99 ? '99+' : String(total)) : anyDot ? '•' : '';
  if (text === lastBadge) return;
  lastBadge = text;
  if (process.platform === 'darwin') {
    if (app.dock) app.dock.setBadge(text);
  } else {
    app.setBadgeCount(total > 0 ? total : 0);
  }
}

function setupBadge() {
  ipcMain.on('badge', (e, { count }) => {
    if (!wcToSlug.has(e.sender.id)) return; // only our profile windows
    badgeCounts.set(e.sender.id, Number(count) || 0);
    refreshBadge();
  });
}

// --- OAuth (next-gen auth / MAS) -------------------------------------------
// One flow + token store per profile (inside oauth.js), resolved from the
// sender window. Named profiles store under <userData>/oauth/<slug>/; the
// default profile keeps the legacy location.
let oauthCtl = null;
function setupOAuth() {
  oauthCtl = oauth.registerOAuthIpc({
    getProfileWindows: () => windows,
    slugForSender: slugForWebContents,
    baseUserDataDir: BASE_USER_DATA,
  });
}

// --- Profile editor window (New / Edit) ------------------------------------
let editorWin = null;
function openProfileEditor(mode, slug) {
  if (editorWin && !editorWin.isDestroyed()) { editorWin.focus(); return; }
  const parent = frontWindow();
  editorWin = new BrowserWindow({
    width: 420,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: parent || undefined,
    modal: !!parent,
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

  editorWin.editTargetSlug = mode === 'edit' ? (slug || P.DEFAULT_SLUG) : null;

  editorWin.webContents.on('did-finish-load', () => {
    const target = editorWin.editTargetSlug;
    const existing = mode === 'edit' ? profileFor(target) : null;
    editorWin.webContents.send('editor:init', {
      mode,
      colors: P.COLORS,
      slug: target || '',
      name: existing ? existing.name : '',
      color: existing ? existing.color : P.DEFAULT_COLOR,
      openAtLaunch: existing ? !!existing.openAtLaunch : false,
      isDefault: mode === 'edit' ? isDefaultSlug(target) : false,
    });
  });
}

// IPC from the editor window (validated here; the editor has no privileges).
function setupProfileIpc() {
  ipcMain.handle('profile:save', (_e, payload) => {
    if (!editorWin || editorWin.isDestroyed() || _e.sender !== editorWin.webContents) {
      return { ok: false, error: 'Not allowed.' };
    }
    const data = payload && typeof payload === 'object' ? payload : {};
    const name = P.sanitizeName(data.name, '');
    const color = P.sanitizeColor(data.color);
    const openAtLaunch = data.openAtLaunch === true;
    const reg = readRegistry();

    if (data.mode === 'edit') {
      const target = editorWin.editTargetSlug || P.DEFAULT_SLUG;
      const def = isDefaultSlug(target);
      const idx = reg.findIndex((p) => p.slug === target);
      const entry = {
        slug: target,
        name: name || (def ? P.DEFAULT_NAME : target),
        color,
        openAtLaunch: def ? false : openAtLaunch,
      };
      if (idx >= 0) reg[idx] = entry; else reg.push(entry);
      P.writeRegistry(APP_DATA, reg);
      // Apply live to that profile's window (if open).
      const win = windows.get(target);
      if (win && !win.isDestroyed()) {
        applyProfileBar(win, target);
        applyNotificationTag(win, target);
        win.setTitle(windowBaseTitle(target));
      }
      rebuildMenu();
      updateAboutPanel();
      return { ok: true };
    }

    // New named profile.
    if (!name) return { ok: false, error: 'Please enter a name.' };
    const taken = reg.filter((p) => p.slug !== P.DEFAULT_SLUG).map((p) => p.slug);
    const slug = P.slugFromName(name, taken);
    reg.push({ slug, name, color, openAtLaunch });
    P.writeRegistry(APP_DATA, reg);
    rebuildMenu();
    // Once a second profile exists, the default window's title/notifications
    // gain their tag — refresh the default window if it is open.
    const defWin = windows.get(P.DEFAULT_SLUG);
    if (defWin && !defWin.isDestroyed()) {
      defWin.setTitle(windowBaseTitle(P.DEFAULT_SLUG));
      applyNotificationTag(defWin, P.DEFAULT_SLUG);
    }
    openProfileWindow(slug);
    return { ok: true, slug };
  });

  ipcMain.on('profile:close', (e) => {
    if (!editorWin || e.sender !== editorWin.webContents) return;
    if (editorWin && !editorWin.isDestroyed()) editorWin.close();
  });
}

// --- Delete profile --------------------------------------------------------
function deleteProfileFlow(slug) {
  const reg = readRegistry();
  const p = P.findProfile(reg, slug);
  if (!p || slug === P.DEFAULT_SLUG) return;

  const choice = dialog.showMessageBoxSync(frontWindow() || undefined, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete the profile “${p.name}”?`,
    detail: `This removes its data on this Mac and signs that account out here. You can add the account again later. This can’t be undone.`,
  });
  if (choice !== 0) return;

  // Close its window.
  const win = windows.get(slug);
  if (win && !win.isDestroyed()) win.close();
  windows.delete(slug);

  // Clear its partition storage, then its on-disk oauth dir.
  const partition = P.partitionFor(slug);
  const finish = () => {
    // Remove the profile's oauth dir and drop its in-memory OAuth flow.
    try {
      const dir = oauth.oauthDirFor(slug, BASE_USER_DATA);
      if (dir && dir !== BASE_USER_DATA && dir.startsWith(path.join(BASE_USER_DATA, 'oauth') + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
    if (oauthCtl && oauthCtl.clearProfile) oauthCtl.clearProfile(slug);
    const next = reg.filter((x) => x.slug !== slug);
    P.writeRegistry(APP_DATA, next);
    rebuildMenu();
  };
  if (partition) {
    const ses = session.fromPartition(partition);
    Promise.resolve(ses.clearStorageData()).catch(() => {}).then(finish);
  } else {
    finish();
  }
}

// --- Menu ------------------------------------------------------------------
function aboutCredits() {
  return 'iCinny: the Cinny web client (cinny.in) in an Electron shell';
}
function updateAboutPanel() {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: `${updater.BUILD.version} (build ${updater.BUILD.build})`,
    credits: aboutCredits(),
  });
}

function profilesMenu() {
  const reg = readRegistry();
  const items = [];
  for (const p of reg) {
    const label = p.slug === P.DEFAULT_SLUG ? (p.name || APP_NAME) : p.name;
    const isOpen = windows.has(p.slug) && !windows.get(p.slug).isDestroyed();
    items.push({
      label,
      type: 'checkbox',
      checked: isOpen,
      click: () => openProfileWindow(p.slug),
    });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'New Profile…', click: () => openProfileEditor('new') });
  items.push({
    label: 'Edit This Profile…',
    click: () => {
      const w = frontWindow();
      const slug = w ? slugForWebContents(w.webContents) : P.DEFAULT_SLUG;
      openProfileEditor('edit', slug || P.DEFAULT_SLUG);
    },
  });

  const deletable = reg.filter((p) => p.slug !== P.DEFAULT_SLUG);
  if (deletable.length) {
    items.push({
      label: 'Delete Profile',
      submenu: deletable.map((p) => ({ label: `${p.name}…`, click: () => deleteProfileFlow(p.slug) })),
    });
  }
  return { label: 'Profiles', submenu: items };
}

function buildMenuTemplate() {
  return [
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
    profilesMenu(),
    // The standard Window menu lists every open window by title ("iCinny —
    // <Name>") and gives Cmd+` to cycle them.
    { role: 'windowMenu' },
  ];
}

function rebuildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

// --- Which profile windows to open on launch -------------------------------
// Open the default profile, every profile marked openAtLaunch, AND (for an
// update relaunch) whatever windows were open when we quit — the union, so a
// relaunch restores the previous windows in addition to the open-automatically
// ones. The persisted list is cleared implicitly: it is overwritten on the
// next quit with whatever is actually open then.
function slugsToOpenAtLaunch() {
  const reg = readRegistry();
  const valid = new Set(reg.map((p) => p.slug));
  const persisted = P.readOpenSlugs(APP_DATA).filter((s) => valid.has(s));
  const autoOpen = reg.filter((p) => p.slug !== P.DEFAULT_SLUG && p.openAtLaunch).map((p) => p.slug);
  // Union, default first, de-duplicated, order stable.
  const set = new Set([P.DEFAULT_SLUG, ...persisted, ...autoOpen]);
  return Array.from(set);
}

// Persist the set of currently-open profile windows (for an update relaunch).
function persistOpenWindows() {
  const open = [];
  for (const [slug, w] of windows.entries()) if (w && !w.isDestroyed()) open.push(slug);
  P.writeOpenSlugs(APP_DATA, open);
}

async function selfTest() {
  // Headless check: app loads, secure context, SW registers & controls the page.
  const win = windows.get(P.DEFAULT_SLUG);
  const out = { profile: P.DEFAULT_SLUG };
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
    if (!out.swControlling) {
      win.webContents.reload();
      await new Promise((r) => win.webContents.once('did-finish-load', r));
      await new Promise((r) => setTimeout(r, 2500));
      out.swControllingAfterReload = await win.webContents.executeJavaScript('!!navigator.serviceWorker.controller', true);
    }
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
  // Configure the default session before the first window loads.
  setupSession(session.defaultSession);
  setupBadge();
  setupProfileIpc();
  setupOAuth();
  rebuildMenu();
  updateAboutPanel();

  if (SELFTEST) {
    openProfileWindow(P.DEFAULT_SLUG);
    selfTest();
    return;
  }

  for (const slug of slugsToOpenAtLaunch()) openProfileWindow(slug);
  // Single updater for the one process.
  updater.start(() => frontWindow(), { appData: APP_DATA });
});

app.on('second-instance', () => {
  const w = frontWindow();
  if (w) { w.show(); w.focus(); }
});

app.on('activate', () => {
  const w = frontWindow();
  if (w) { w.show(); w.focus(); }
  else openProfileWindow(P.DEFAULT_SLUG);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  // Remember which profile windows were open so an update relaunch restores them.
  persistOpenWindows();
  updater.installOnQuit({ appData: APP_DATA });
});

app.on('window-all-closed', () => {
  // macOS convention: the app stays alive in the Dock when all windows close;
  // clicking the Dock icon (activate) reopens the default profile window.
  // Other platforms quit.
  if (process.platform !== 'darwin') app.quit();
});
