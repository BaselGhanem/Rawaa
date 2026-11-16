const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, dialog, globalShortcut, nativeImage, Notification, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { defaults, normalize } = require('./store.cjs');

const exec = promisify(execFile);
const windows = new Map();
const imageCache = new Map();
const packagedIconPaths = new Map();
const windowsOS = process.platform === 'win32';
const nativeScript = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'windows.ps1');
const ps = windowsOS ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
const args = (action, extra = []) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeScript, '-Action', action, ...extra];
const native = (action, extra) => exec(ps, args(action, extra), { windowsHide: true, timeout: 12000 });
let state = defaults();
let tray;
let trayOnly = false;
let dockDrag;
let dockPreview;
let trayTransition;
let palette;
let settingsEntry;
let settingsPreview;

function launcherEntries() {
  return [...windows.values(), ...[palette, settingsEntry].filter(Boolean)];
}
let monitor;
let interval;
let foreground;
let modalDialogs = 0;
let shelfDragging = false;
let quitting = false;
let updateStatus = '';
let updatesReady = false;
let updateInfo;
let checkingUpdate;
let updatePromptOpen = false;
let updateNotification;
let notifiedVersion;
let saveQueue = Promise.resolve();
const shelf = new Map();

function shelfItems() {
  return [...shelf.values()].map(({ id, name }) => ({ id, name }));
}

function broadcastShelf() {
  const items = shelfItems();
  for (const { win } of launcherEntries()) {
    if (!win.isDestroyed()) win.webContents.send('shelf-changed', items);
  }
  return items;
}

async function addShelfFiles(paths) {
  const candidates = Array.isArray(paths) ? paths.slice(0, 50) : [];
  const files = await Promise.all(candidates.map(async value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
    const target = path.normalize(value);
    const info = await fsp.stat(target).catch(() => null);
    return info?.isFile() ? target : null;
  }));
  const known = new Set([...shelf.values()].map(item => windowsOS ? item.target.toLowerCase() : item.target));
  let accepted = 0;
  for (const target of files) {
    if (!target) continue;
    const key = windowsOS ? target.toLowerCase() : target;
    if (known.has(key)) continue;
    if (shelf.size >= 50) break;
    const id = randomUUID();
    shelf.set(id, { id, target, name: path.basename(target) });
    known.add(key);
    accepted++;
  }
  return { items: broadcastShelf(), accepted };
}

function configPath() {
  return path.join(app.getPath('userData'), 'rawaa.json');
}

async function readConfiguration(file) {
  if ((await fsp.stat(file)).size > 8 * 1024 * 1024) throw new Error('ملف الاعدادات كبير جدا');
  return normalize(JSON.parse(await fsp.readFile(file, 'utf8')));
}

function saveConfiguration(next) {
  const pending = saveQueue.catch(() => {}).then(async () => {
    const file = configPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + '.tmp', JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(file + '.tmp', file);
    const keysChanged = next.prefs.toggleKey !== state.prefs.toggleKey || next.prefs.searchKey !== state.prefs.searchKey;
    const nameChanged = next.prefs.displayName !== state.prefs.displayName;
    state = next;
    syncWindows();
    if (settingsPreview) previewSettings(null);
    if (nameChanged) {
      for (const { win, isSettings } of launcherEntries()) if (!isSettings) win.setTitle(state.prefs.displayName);
      refreshTrayTitle();
    }
    if (keysChanged) registerKeys();
    for (const { win } of launcherEntries()) if (!win.isDestroyed()) win.webContents.send('state', state);
    return state;
  });
  saveQueue = pending;
  return pending;
}

function displayConfig(display) {
  return state.displays[display.id] || {
    side: 'right', mode: display.id === screen.getPrimaryDisplay().id ? 'fixed' : 'off', compact: false
  };
}

function boundsFor(display, settings, prefs = state.prefs) {
  const area = display.workArea;
  if (settings.side === 'top') {
    const width = Math.min(area.width, 880);
    return { x: area.x + Math.round((area.width - width) / 2), y: area.y, width, height: Math.min(area.height, 560) };
  }
  const width = Math.min(area.width, prefs.width + 110);
  const height = Math.max(180, Math.min(760, area.height - 30));
  return {
    x: settings.side === 'left' ? area.x : area.x + area.width - width,
    y: area.y + Math.round((area.height - height) / 2), width, height
  };
}

function paletteBounds(display) {
  const area = display.workArea;
  const width = Math.min(680, area.width);
  const height = Math.min(560, area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2), width, height
  };
}

function makeWindow(display, settings, isPalette = false) {
  const win = new BrowserWindow({
    ...(isPalette ? paletteBounds(display) : boundsFor(display, settings)), show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: !isPalette || state.prefs.searchAlwaysOnTop, title: state.prefs.displayName,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  const entry = { win, isPalette, ready: false, revealed: false, manual: false, fullscreen: false };
  if (isPalette) palette = entry;
  else windows.set(display.id, entry);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (!windowsOS && !isPalette) win.on('blur', () => requestAutoFold(entry));
  win.on('page-title-updated', event => event.preventDefault());
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => {
    entry.ready = true;
    if (isPalette) revealPalette(entry);
    else {
      tick();
      if (entry.dockLanding && (!windowsOS || entry.shape)) {
        entry.dockLanding = false;
        win.webContents.send('dock-landed');
      }
    }
  });
  win.on('closed', () => {
    if (dockDrag?.entry === entry) finishDockDrag(false);
    if (palette === entry) palette = undefined;
    if (windows.get(display.id) === entry) windows.delete(display.id);
  });
  entry.displayId = display.id;
  win.loadFile(path.join(__dirname, 'index.html'), { query: { display: String(display.id), view: isPalette ? 'palette' : 'sidebar' } });
  return entry;
}

function previewSettings(draft) {
  settingsPreview = draft;
  for (const display of screen.getAllDisplays()) {
    const entry = windows.get(display.id);
    if (!entry) continue;
    const current = displayConfig(display);
    const appearance = draft?.displays[display.id] || current;
    const bounds = boundsFor(display, appearance, draft?.prefs);
    const currentBounds = entry.win.getBounds();
    if (Object.keys(bounds).some(key => bounds[key] !== currentBounds[key])) entry.win.setBounds(bounds);
    if (settingsEntry?.displayId === display.id && appearance.side !== settingsEntry.side) {
      settingsEntry.side = appearance.side;
      settingsEntry.win.setBounds(settingsBounds(display, appearance, draft?.prefs || state.prefs));
    }
    entry.win.webContents.send('settings-preview', draft ? { prefs: draft.prefs, display: appearance } : null);
  }
}

function settingsBounds(display, dock, prefs) {
  const area = display.workArea;
  const width = Math.min(484, area.width);
  const height = Math.min(650, area.height);
  const x = dock.side === 'left' ? Math.min(area.x + prefs.width + 65, area.x + area.width - width)
    : Math.max(area.x, area.x + area.width - width - (dock.side === 'right' ? prefs.width + 65 : 0));
  const y = dock.side === 'top' ? Math.min(area.y + 96, area.y + area.height - height)
    : area.y + Math.round((area.height - height) / 2);
  return { x, y, width, height };
}

function openSettings(source) {
  if (settingsEntry) { settingsEntry.win.show(); return; }
  const display = screen.getDisplayMatching(source.win.getBounds());
  const win = new BrowserWindow({
    ...settingsBounds(display, displayConfig(display), state.prefs),
    show: false, frame: false, backgroundColor: '#1b2328',
    title: 'الاعدادات', autoHideMenuBar: true, alwaysOnTop: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  settingsEntry = { win, isSettings: true, source, displayId: display.id, side: displayConfig(display).side };
  for (const entry of windows.values()) entry.win.webContents.send('settings-visibility', true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('page-title-updated', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    settingsEntry = undefined;
    for (const entry of windows.values()) entry.win.webContents.send('settings-visibility', false);
    if (settingsPreview) previewSettings(null);
    if (source.edgeMode === 'preview' && !source.win.isDestroyed()) source.win.webContents.send('edge-autofold');
  });
  win.loadFile(path.join(__dirname, 'index.html'), { query: { display: String(display.id), view: 'settings' } });
}

function revealPalette(entry) {
  if (!entry.manual || !entry.ready || (windowsOS && !entry.shape)) return;
  entry.win.show();
  entry.win.focus();
  entry.win.webContents.send('search-focus');
}

function showPalette(display) {
  const entry = palette || makeWindow(display, null, true);
  entry.win.setBounds(paletteBounds(display));
  entry.manual = true;
  revealPalette(entry);
}

function syncWindows() {
  if (palette) {
    palette.win.setAlwaysOnTop(state.prefs.searchAlwaysOnTop);
    if (state.prefs.searchView !== 'palette') hideLauncher(palette);
    else if (palette.win.isVisible()) palette.win.setBounds(paletteBounds(screen.getDisplayMatching(palette.win.getBounds())));
  }
  const displays = screen.getAllDisplays();
  for (const [id, entry] of windows) {
    if (!displays.some(display => display.id === id && displayConfig(display).mode !== 'off')) entry.win.destroy();
  }
  if (displays.every(display => displayConfig(display).mode === 'off')) {
    const primary = screen.getPrimaryDisplay();
    state = { ...state, displays: { ...state.displays, [primary.id]: { side: 'right', mode: 'fixed', compact: false } } };
  }
  for (const display of displays) {
    const settings = displayConfig(display);
    if (settings.mode === 'off') continue;
    let entry = windows.get(display.id);
    if (!entry) { makeWindow(display, settings); continue; }
    const bounds = boundsFor(display, settings);
    const current = entry.win.getBounds();
    if (Object.keys(bounds).some(key => bounds[key] !== current[key])) entry.win.setBounds(bounds);
  }
  tick();
}

function covers(rect, area) {
  return rect && rect[0] <= area.x + 2 && rect[1] <= area.y + 2 &&
    rect[2] >= area.x + area.width - 2 && rect[3] >= area.y + area.height - 2;
}

function dockTarget() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.bounds;
  const distances = [
    ['top', Math.abs(cursor.y - area.y) / area.height],
    ['left', Math.abs(cursor.x - area.x) / area.width],
    ['right', Math.abs(area.x + area.width - 1 - cursor.x) / area.width]
  ];
  distances.sort((a, b) => a[1] - b[1]);
  const side = distances[0][1] < .17 ? distances[0][0] : dockDrag.settings.side;
  return { display, side };
}

function updateDockPreview() {
  const { display, side } = dockTarget();
  const signature = `${display.id}:${side}`;
  if (dockDrag.preview === signature) return;
  dockDrag.preview = signature;
  const bounds = boundsFor(display, { side });
  const horizontal = side === 'top';
  const width = horizontal ? Math.max(1, bounds.width - 32) : Math.max(1, bounds.width - 73);
  const height = horizontal ? 64 : Math.min(490, bounds.height);
  const x = bounds.x + (horizontal ? 16 : side === 'left' ? 37 : bounds.width - width - 37);
  const y = bounds.y + (horizontal ? 16 : Math.round((bounds.height - height) / 2));
  if (!dockPreview) {
    dockPreview = new BrowserWindow({
      x, y, width, height, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true }
    });
    dockPreview.setIgnoreMouseEvents(true);
    const preview = dockPreview;
    preview.once('ready-to-show', () => {
      if (preview === dockPreview && dockDrag) preview.showInactive();
    });
    preview.loadURL('data:text/html,' + encodeURIComponent(
      '<body style="margin:0"><div style="box-sizing:border-box;height:100vh;border:2px solid #71ded0;border-radius:25px;background:#09999949"></div></body>'
    )).catch(() => {});
  } else {
    dockPreview.setBounds({ x, y, width, height });
    if (!dockPreview.webContents.isLoading()) dockPreview.showInactive();
  }
}

async function finishDockDrag(commit) {
  if (!dockDrag) return;
  const { entry, settings } = dockDrag;
  const target = commit ? dockTarget() : null;
  dockDrag = undefined;
  dockPreview?.hide();
  if (!target) return;
  const { display, side } = target;
  if (display.id === entry.displayId && side === settings.side) return;
  const next = structuredClone(state);
  if (display.id !== entry.displayId) next.displays[entry.displayId] = { ...settings, mode: 'off' };
  next.displays[display.id] = { ...settings, side, mode: 'fixed' };
  await saveConfiguration(next);
  const destination = windows.get(display.id);
  if (destination) {
    destination.manual = true;
    destination.suppressed = false;
    destination.edgePanel = false;
    destination.edgeMode = 'normal';
    destination.pinned = false;
    destination.win.setSkipTaskbar(false);
    if (destination.ready && (!windowsOS || destination.shape)) destination.win.webContents.send('dock-landed');
    else destination.dockLanding = true;
    tick();
  }
}

function tick() {
  if (quitting || trayOnly) return;
  if (dockDrag) { updateDockPreview(); return; }
  const cursor = screen.getCursorScreenPoint();
  for (const display of screen.getAllDisplays()) {
    const entry = windows.get(display.id);
    if (!entry?.ready || (windowsOS && !entry.shape)) continue;
    const settings = displayConfig(display);
    const bounds = entry.win.getBounds();
    const area = display.bounds;
    const edge = settings.side === 'left' ? area.x : area.x + area.width - 1;
    const nearEdge = settings.side === 'top'
      ? Math.abs(cursor.y - display.workArea.y) <= 8 && cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width
      : Math.abs(cursor.x - edge) <= 8 && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    const inWindow = cursor.x >= bounds.x - 13 && cursor.x <= bounds.x + bounds.width + 13 &&
      cursor.y >= bounds.y - 3 && cursor.y <= bounds.y + bounds.height + 3;
    if (nearEdge) entry.revealed = true;
    if (!inWindow && !entry.win.isFocused()) entry.revealed = false;
    const physical = windowsOS ? screen.dipToScreenRect(entry.win, display.bounds) : display.bounds;
    const fullscreen = state.prefs.hideFullscreen && covers(foreground, physical);
    if (fullscreen && !entry.fullscreen && !entry.pinned) entry.overrideFullscreen = false;
    entry.fullscreen = fullscreen;
    if (settingsEntry?.source === entry && entry.edgeMode !== 'fold') {
      if (!entry.win.isVisible()) entry.win.showInactive();
      continue;
    }
    if (entry.edgePanel) {
      if (fullscreen && !entry.overrideFullscreen) entry.win.hide();
      else if (!entry.win.isVisible()) entry.win.showInactive();
      continue;
    }
    const show = (!fullscreen || entry.overrideFullscreen) && (entry.manual || (!entry.suppressed && (settings.mode === 'fixed' || entry.revealed)));
    if (show && !entry.win.isVisible()) entry.win.showInactive();
    if (!show && entry.win.isVisible()) entry.win.hide();
    if (nearEdge && !entry.wasNear && settings.mode === 'edge') entry.suppressed = false;
    entry.wasNear = nearEdge;
  }
}

function showLauncher(search = false, restoreEdge = false) {
  const restoring = trayOnly;
  clearTimeout(trayTransition);
  if (restoring) {
    trayOnly = false;
    for (const entry of windows.values()) entry.suppressed = false;
    tick();
  }
  const preferred = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (search && state.prefs.searchView === 'palette') {
    if (restoring) windows.forEach(entry => sendTrayMotion(entry, false));
    return showPalette(preferred);
  }
  const entry = windows.get(preferred.id) || [...windows.values()][0];
  if (!entry) return;
  if (entry.edgePanel) {
    entry.overrideFullscreen = true;
    entry.win.show();
    entry.win.webContents.send('edge-open', restoreEdge ? 'pin' : 'preview');
    if (search) entry.win.webContents.send('search-focus');
    return;
  }
  if (!restoring && !search && entry.win.isVisible() && entry.win.isFocused()) {
    hideLauncher(entry);
    return;
  }
  entry.manual = true;
  entry.suppressed = false;
  entry.overrideFullscreen = true;
  entry.win.show();
  entry.win.focus();
  if (restoring) windows.forEach(candidate => sendTrayMotion(candidate, false));
  if (search) entry.win.webContents.send('search-focus');
}

function sendTrayMotion(entry, closing) {
  const trayBounds = tray?.getBounds();
  const bounds = entry.win.getBounds();
  const x = trayBounds?.width ? trayBounds.x + trayBounds.width / 2 - bounds.x : bounds.width / 2;
  const y = trayBounds?.height ? trayBounds.y + trayBounds.height / 2 - bounds.y : bounds.height;
  entry.win.webContents.send('tray-motion', { x, y, closing });
}

function minimizeToTray(entry) {
  if (trayOnly) return;
  trayOnly = true;
  for (const candidate of launcherEntries()) {
    if (candidate !== entry && !candidate.isSettings) hideLauncher(candidate);
  }
  if (!entry?.win.isVisible()) return;
  sendTrayMotion(entry, true);
  trayTransition = setTimeout(() => {
    if (trayOnly && !entry.win.isDestroyed()) hideLauncher(entry);
  }, 245);
}

function hideLauncher(entry) {
  entry.manual = false;
  entry.revealed = false;
  entry.suppressed = true;
  entry.win.hide();
}

function registerKeys() {
  globalShortcut.unregisterAll();
  const register = (key, action) => {
    try { return globalShortcut.register(key, action); } catch { return false; }
  };
  const toggle = register(state.prefs.toggleKey, () => showLauncher());
  const search = register(state.prefs.searchKey, () => showLauncher(true));
  return toggle && search;
}

function requestAutoFold(entry) {
  if (entry.pinned || settingsEntry || !state.prefs.foldOnOutsideClick || modalDialogs || shelfDragging || dockDrag || entry.isPalette || entry.edgeMode === 'fold' ||
      !entry.win.isVisible()) return;
  entry.win.webContents.send('edge-autofold');
}

function handleOutsideClick(point) {
  if (launcherEntries().some(entry => {
    if (!entry.win.isVisible()) return false;
    const bounds = entry.win.getBounds();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    return entry.hitRegions?.some(rect => x >= rect.x && x < rect.x + rect.width &&
      y >= rect.y && y < rect.y + rect.height);
  })) return;
  windows.forEach(requestAutoFold);
}

async function whileModal(action) {
  modalDialogs++;
  try { return await action(); }
  finally { modalDialogs--; }
}

function startMonitor() {
  if (!windowsOS || quitting) return;
  monitor = spawn(ps, args('monitor'), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = require('node:readline').createInterface({ input: monitor.stdout });
  lines.on('line', line => {
    const click = /^click (-?\d+) (-?\d+)$/.exec(line);
    if (click) {
      handleOutsideClick(screen.screenToDipPoint({ x: Number(click[1]), y: Number(click[2]) }));
    } else {
      foreground = /^-?\d+( -?\d+){3}$/.test(line) ? line.split(' ').map(Number) : null;
    }
  });
  monitor.on('error', () => { foreground = null; });
  monitor.once('close', () => {
    foreground = null;
    if (!quitting) setTimeout(startMonitor, 5000).unref();
  });
}

function displaysInfo() {
  const enabled = screen.getAllDisplays();
  return enabled.map((display, index) => ({
    id: String(display.id), name: display.id === screen.getPrimaryDisplay().id ? 'الشاشة الرئيسية' : `الشاشة ${index + 1}`,
    primary: display.id === screen.getPrimaryDisplay().id, config: displayConfig(display)
  }));
}

async function describe(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null;
  try {
    const stats = await fsp.stat(target);
    const extension = path.extname(target).toLowerCase();
    return {
      target, name: stats.isDirectory() ? path.basename(target) || target : path.basename(target, extension),
      kind: stats.isDirectory() ? 'folder' : ['.exe', '.lnk', '.com'].includes(extension) ? 'app' : 'file'
    };
  } catch { return null; }
}

async function executable(item) {
  const extension = path.extname(item.target).toLowerCase();
  if (extension === '.exe') return path.win32.normalize(item.target);
  if (extension === '.lnk') {
    const { stdout } = await native('resolve', ['-Target', item.target]);
    const resolved = stdout.trim();
    if (path.extname(resolved).toLowerCase() === '.exe') return path.win32.normalize(resolved);
  }
  return '';
}

async function openItem(item, layout) {
  if (item.kind === 'url') {
    const url = new URL(item.target);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('الروابط المدعومة تبدأ بـ HTTPS او HTTP');
    await shell.openExternal(url.href);
    return '';
  }
  const packaged = windowsOS && item.kind === 'app' && /^appx:[a-z0-9._-]+![a-z0-9._-]+$/i.test(item.target);
  if (!packaged && !path.isAbsolute(item.target)) throw new Error('اختر مسارا كاملا للعنصر');
  if (!packaged) await fsp.access(item.target).catch(() => { throw new Error(`تعذر الوصول الى ${item.name}`); });
  const target = packaged ? item.target : windowsOS && item.kind === 'app' ? await executable(item).catch(() => '') : '';
  let running = false;
  if (target) {
    try {
      await native('activate', ['-Target', target]);
      running = true;
    } catch (error) {
      if (error.code === 3) running = true;
    }
  }
  if (!running && packaged) {
    const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    // Explorer can return exit code 1 after handing the launch to the shell.
    await exec(explorer, [`shell:AppsFolder\\${item.target.slice(5)}`], { windowsHide: true, timeout: 10000 })
      .catch(error => { if (error.code !== 1) throw error; });
  } else if (!running) {
    const error = await shell.openPath(item.target);
    if (error) throw new Error(error);
  }
  if (!layout) return '';
  if (!target) return `تعذر ترتيب نافذة ${item.name}`;
  const display = screen.getAllDisplays().find(value => String(value.id) === layout.display) || screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(area.width, layout.width);
  const height = Math.min(area.height, layout.height);
  const dip = {
    x: area.x + Math.min(layout.x, area.width - width), y: area.y + Math.min(layout.y, area.height - height), width, height
  };
  const reference = windows.get(display.id)?.win;
  const position = screen.dipToScreenRect(reference || null, dip);
  try {
    await native('place', ['-Target', target, '-X', String(position.x), '-Y', String(position.y), '-Width', String(position.width), '-Height', String(position.height)]);
    return '';
  } catch { return `تعذر ترتيب نافذة ${item.name}`; }
}

function status(message) {
  updateStatus = message;
  for (const { win } of launcherEntries()) win.webContents.send('update-status', message);
}

function checkUpdates() {
  if (!checkingUpdate) {
    checkingUpdate = autoUpdater.checkForUpdates().finally(() => { checkingUpdate = undefined; });
  }
  return checkingUpdate;
}

async function offerUpdate(entry) {
  if (updatePromptOpen) return '';
  updatePromptOpen = true;
  try {
    if (!updatesReady && !updateInfo) await checkUpdates();
    if (!updateInfo) return updateStatus;
    const ready = updatesReady;
    const options = {
      type: 'info',
      title: 'تحديث رواء',
      message: ready ? 'التحديث جاهز للتثبيت' : `تحديث رواء ${updateInfo.version} متاح`,
      detail: ready ? 'رح يتم اغلاق رواء وفتحه بعد التثبيت مع الاحتفاظ باعداداتك' : 'بتقدر تنزل التحديث هلا وتثبت من داخل رواء',
      buttons: [ready ? 'تثبيت واعادة التشغيل' : 'تنزيل التحديث', 'لاحقا'],
      defaultId: 0, cancelId: 1
    };
    const { response } = await whileModal(() => entry?.win.isVisible()
      ? dialog.showMessageBox(entry.win, options)
      : dialog.showMessageBox(options));
    if (response !== 0) return '';
    if (!ready) {
      status('جاري تنزيل التحديث');
      await autoUpdater.downloadUpdate();
    }
    await saveQueue.catch(() => {});
    autoUpdater.quitAndInstall(true, true);
    return 'جاري تثبيت التحديث';
  } catch (error) {
    console.error('Rawaa updater:', error.message);
    return updateStatus;
  } finally {
    updatePromptOpen = false;
  }
}

function refreshTrayTitle() {
  const name = state.prefs.displayName;
  tray?.setToolTip(updateInfo ? `${name} | تحديث ${updateInfo.version} متاح` : name);
}

function openUpdatePrompt() {
  const entries = launcherEntries();
  return offerUpdate(entries.find(entry => entry.win.isFocused()) || entries.find(entry => entry.win.isVisible()));
}

function broadcastUpdateAvailability() {
  for (const { win } of launcherEntries()) {
    if (!win.isDestroyed()) win.webContents.send('update-version', updateInfo?.version || '');
  }
}

function setupUpdates() {
  if (!windowsOS || !app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => status('جاري البحث عن تحديث'));
  autoUpdater.on('update-available', info => {
    updateInfo = info;
    status(`تحديث رواء ${info.version} متاح`);
    refreshTrayTitle();
    broadcastUpdateAvailability();
    if (updatePromptOpen || notifiedVersion === info.version) return;
    notifiedVersion = info.version;
    const details = { title: `${state.prefs.displayName} • تحديث ${info.version}`, body: 'اضغط لفتح خيارات التحديث' };
    const fallback = () => tray?.displayBalloon({ title: details.title, content: details.body });
    if (!Notification.isSupported()) {
      fallback();
      return;
    }
    updateNotification = new Notification(details);
    updateNotification.on('click', openUpdatePrompt);
    updateNotification.once('failed', error => {
      console.error('Rawaa update notification:', error);
      fallback();
    });
    updateNotification.show();
  });
  autoUpdater.on('update-not-available', () => {
    updateInfo = undefined;
    refreshTrayTitle();
    broadcastUpdateAvailability();
    status(`رواء على اخر اصدار • ${app.getVersion()}`);
  });
  autoUpdater.on('download-progress', progress => status(`جاري تنزيل التحديث ${Math.floor(progress.percent)}٪`));
  autoUpdater.on('update-downloaded', () => { updatesReady = true; status('التحديث جاهز للتثبيت'); });
  autoUpdater.on('error', error => {
    console.error('Rawaa updater:', error.message);
    status(error.statusCode === 404 ? 'بيانات التحديث غير متاحة حاليا' : 'تعذر اكمال التحديث، جرب مرة ثانية');
  });
  const check = () => {
    if (!quitting && !updatePromptOpen && !updatesReady) checkUpdates().catch(() => {});
  };
  check();
  setInterval(check, 60_000).unref();
  powerMonitor.on('resume', check);
}

function transparentIcon(image) {
  if (!image || image.isEmpty()) return '';
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  if (pixels.length !== width * height * 4) return '';
  let left = width, right = -1, top = height, bottom = -1;
  let transparent = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha < 255) transparent = true;
      if (alpha <= 8) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (!transparent || right < left) return '';
  return image.crop({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 }).toDataURL();
}

async function readFileIcon(target) {
  const resolved = windowsOS && path.extname(target).toLowerCase() === '.lnk'
    ? await executable({ target }).catch(() => '')
    : '';
  for (const source of new Set([resolved, target])) {
    if (!source) continue;
    for (const size of ['large', 'normal']) {
      const image = await app.getFileIcon(source, { size }).catch(() => null);
      const icon = transparentIcon(image);
      if (icon) return icon;
    }
  }
  return '';
}

async function fileIcon(target) {
  if (!path.isAbsolute(target)) return '';
  if (!imageCache.has(target)) {
    if (imageCache.size >= 250) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(target, readFileIcon(target));
  }
  const pending = imageCache.get(target);
  const icon = await pending.catch(() => '');
  if (!icon && imageCache.get(target) === pending) imageCache.delete(target);
  return icon;
}

async function itemIcon(item) {
  const target = item.target;
  const name = item.name.trim();
  const calculator = /^appx:Microsoft\.WindowsCalculator_|(?:^|[\\/])(?:calc|calculatorapp)\.exe$/i.test(target)
    || /^(calculator|الحاسبة)$/i.test(name);
  if (calculator) return transparentIcon(nativeImage.createFromPath(path.join(__dirname, 'calculator-icon.png')));
  if (/^close[ _-]?pilot$/i.test(name) || /(?:^|[\\/])close[ _-]?pilot\.exe$/i.test(target)) {
    return transparentIcon(nativeImage.createFromPath(path.join(__dirname, 'closepilot-icon.png')));
  }
  const excel = /(?:^|[\\/])excel\.exe$/i.test(target) || /^(?:microsoft )?excel(?: \d{4})?$/i.test(name);
  if (excel) return transparentIcon(nativeImage.createFromPath(path.join(__dirname, 'excel-icon.png')));
  return fileIcon(packagedIconPaths.get(target) || target);
}

function registerHandlers() {
  const senderEntry = event => launcherEntries().find(candidate => candidate.win.webContents === event.sender);
  const handle = (channel, fn) => ipcMain.handle(channel, (event, value) => {
    const entry = senderEntry(event);
    if (!entry || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid sender');
    return fn(entry, value);
  });
  handle('load', () => ({ state, displays: displaysInfo(), version: app.getVersion(), updateStatus, updateVersion: updateInfo?.version || '', shelf: shelfItems() }));
  handle('shelf-add', (_entry, paths) => addShelfFiles(paths));
  handle('shelf-remove', (_entry, id) => {
    shelf.delete(id);
    return broadcastShelf();
  });
  handle('shelf-open', async (_entry, id) => {
    const item = shelf.get(id);
    if (!item) return;
    const error = await shell.openPath(item.target);
    if (error) throw new Error(`تعذر فتح ${item.name}`);
  });
  const dragIcon = nativeImage.createFromPath(path.join(__dirname, 'rawaa.png')).resize({ width: 32, height: 32 });
  ipcMain.on('shelf-drag', (event, id) => {
    const entry = senderEntry(event);
    if (!entry || event.senderFrame !== event.sender.mainFrame) return;
    const item = shelf.get(id);
    if (!item) return;
    try {
      if (!fs.statSync(item.target).isFile()) throw new Error('File unavailable');
      shelfDragging = true;
      event.sender.startDrag({ file: item.target, icon: dragIcon });
    } catch {
      event.sender.send('shelf-error', `تعذر سحب ${item.name} من مكانه الاصلي`);
    } finally {
      shelfDragging = false;
    }
  });
  handle('save', async (_entry, value) => {
    const next = normalize(value);
    if (!screen.getAllDisplays().some(display => (next.displays[display.id]?.mode || (display.id === screen.getPrimaryDisplay().id ? 'fixed' : 'off')) !== 'off')) {
      throw new Error('اختر شاشة واحدة على الاقل');
    }
    const changed = next.prefs.toggleKey !== state.prefs.toggleKey || next.prefs.searchKey !== state.prefs.searchKey;
    const saved = await saveConfiguration(next);
    const activeKeys = ['toggleKey', 'searchKey'].every(key => {
      try { return globalShortcut.isRegistered(saved.prefs[key]); } catch { return false; }
    });
    return { state: saved, warning: changed && !activeKeys ? 'تعذر تسجيل واحد من اختصارات الكيبورد' : '' };
  });
  handle('open-settings', entry => { if (!entry.isSettings) openSettings(entry); });
  handle('close-settings', entry => { if (entry.isSettings) entry.win.close(); });
  handle('settings-preview', (entry, value) => {
    if (entry.isSettings) previewSettings(normalize(value));
  });
  handle('geometry', (entry, value) => {
    if (entry.isSettings || !windowsOS || !Array.isArray(value) || value.length > 5 || !value.length) return;
    const valid = rect => rect && ['x', 'y', 'width', 'height', 'radius'].every(key =>
      Number.isInteger(rect[key]) && rect[key] >= 0 && rect[key] <= 2000
    ) && rect.width > 0 && rect.height > 0;
    if (!value.every(valid)) return;
    const signature = JSON.stringify(value);
    if (entry.shape === signature) return;
    const regions = value.flatMap(({ x, y, width, height, radius: requestedRadius }) => {
      const radius = Math.min(requestedRadius, Math.floor(width / 2), Math.floor(height / 2));
      const parts = [];
      for (let row = 0; row < radius; row++) {
        const pad = Math.floor(radius - Math.sqrt(radius ** 2 - (radius - row - .5) ** 2));
        parts.push({ x: x + pad, y: y + row, width: width - 2 * pad, height: 1 });
        parts.push({ x: x + pad, y: y + height - row - 1, width: width - 2 * pad, height: 1 });
      }
      if (height > 2 * radius) parts.push({ x, y: y + radius, width, height: height - 2 * radius });
      return parts;
    });
    const firstShape = !entry.shape;
    entry.win.setShape(regions);
    entry.hitRegions = regions;
    entry.shape = signature;
    if (firstShape && entry.isPalette) revealPalette(entry);
    else if (firstShape) {
      tick();
      if (entry.dockLanding) {
        entry.dockLanding = false;
        entry.win.webContents.send('dock-landed');
      }
    }
  });
  handle('show-search', () => showLauncher(true));
  handle('dock-drag', (entry, action) => {
    if (entry.isPalette) return;
    if (action === 'start' && !dockDrag) {
      const display = screen.getAllDisplays().find(candidate => candidate.id === entry.displayId);
      if (!display) return;
      dockDrag = { entry, settings: displayConfig(display) };
      updateDockPreview();
    } else if (dockDrag?.entry === entry && (action === 'drop' || action === 'cancel')) {
      return finishDockDrag(action === 'drop');
    }
  });
  handle('edge-panel', (entry, mode) => {
    if (entry.isPalette || !['fold', 'preview', 'pin', 'normal'].includes(mode)) return;
    if (mode === 'preview' && !entry.edgePanel) return;
    entry.edgePanel = mode === 'fold' || mode === 'preview';
    entry.edgeMode = mode;
    entry.pinned = mode === 'pin';
    entry.manual = mode === 'pin' || mode === 'normal';
    entry.suppressed = false;
    entry.win.setSkipTaskbar(mode === 'fold');
    entry.win.setAlwaysOnTop(true);
    if (mode === 'pin') entry.overrideFullscreen = true;
  });
  handle('minimize-to-tray', entry => minimizeToTray(entry));
  handle('hide', entry => hideLauncher(entry));
  handle('choose', async (entry, kind) => {
    const result = await whileModal(() => dialog.showOpenDialog(entry.win, { properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'] }));
    return (await Promise.all(result.filePaths.map(describe))).filter(Boolean);
  });
  handle('paths', async (_entry, paths) => (await Promise.all((Array.isArray(paths) ? paths.slice(0, 100) : []).map(describe))).filter(Boolean));
  handle('open-apps', async () => {
    if (!windowsOS) return [];
    const { stdout } = await native('list', ['-OwnerPid', String(process.pid)]);
    const entries = stdout.trim() ? JSON.parse(stdout) : [];
    for (const entry of entries) {
      if (entry.target.startsWith('appx:') && entry.iconPath && !/ApplicationFrameHost\.exe$/i.test(entry.iconPath)) {
        if (packagedIconPaths.size >= 250) packagedIconPaths.delete(packagedIconPaths.keys().next().value);
        packagedIconPaths.set(entry.target, entry.iconPath);
      }
    }
    return Promise.all(entries.map(async entry => ({
      kind: 'app', name: entry.name, target: entry.target, image: await itemIcon(entry)
    })));
  });
  handle('icon', (_entry, id) => {
    const item = state.items.find(value => value.id === id);
    return item && ['app', 'file', 'folder'].includes(item.kind) ? itemIcon(item) : '';
  });
  handle('launch', async (_entry, id) => {
    const item = state.items.find(value => value.id === id);
    if (!item) throw new Error('العنصر غير موجود');
    if (item.kind !== 'bundle') return openItem(item);
    const entries = item.children.map(child => state.items.find(value => value.id === child)).filter(Boolean);
    const results = await Promise.allSettled(entries.map(child => openItem(child, item.layout.find(position => position.item === child.id))));
    return results.map(result => result.status === 'fulfilled' ? result.value : result.reason.message).filter(Boolean).join('، ');
  });
  handle('backup', async (entry, action) => {
    if (action === 'export') {
      const result = await whileModal(() => dialog.showSaveDialog(entry.win, { defaultPath: 'Rawaa-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] }));
      if (!result.canceled) await fsp.writeFile(result.filePath, JSON.stringify(state, null, 2), 'utf8');
      return !result.canceled;
    }
    if (action !== 'import') return false;
    const result = await whileModal(() => dialog.showOpenDialog(entry.win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }));
    if (result.canceled) return false;
    const next = await readConfiguration(result.filePaths[0]);
    const displays = screen.getAllDisplays();
    if (displays.every(display => (next.displays[display.id]?.mode || (display.id === screen.getPrimaryDisplay().id ? 'fixed' : 'off')) === 'off')) {
      next.displays[screen.getPrimaryDisplay().id] = { mode: 'fixed', side: 'right', compact: false };
    }
    const confirmation = await whileModal(() => dialog.showMessageBox(entry.win, {
      type: 'question', message: 'استبدال اعدادات رواء الحالية؟',
      detail: 'رح يتم تحميل المساحات والاختصارات من الملف المختار', buttons: ['استيراد', 'الغاء'], defaultId: 1, cancelId: 1
    }));
    if (confirmation.response !== 0) return false;
    await saveConfiguration(next);
    return true;
  });
  handle('updates', entry => windowsOS && app.isPackaged
    ? offerUpdate(entry)
    : 'التحديث متاح من نسخة ويندوز المثبتة');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showLauncher());
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(interval);
    monitor?.kill();
    globalShortcut.unregisterAll();
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.baselghanem.rawaa');
    try { state = await readConfiguration(configPath()); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        await fsp.copyFile(configPath(), configPath() + '.invalid').catch(() => {});
      }
    }
    const logo = nativeImage.createFromPath(path.join(__dirname, 'rawaa.png'));
    tray = new Tray(logo.resize({ width: 24, height: 24 }));
    refreshTrayTitle();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'توسيع رواء', click: () => showLauncher(false, true) },
      { label: 'بحث سريع', click: () => showLauncher(true) },
      { label: 'تحديثات رواء', click: async () => {
        if (!windowsOS || !app.isPackaged) return;
        const message = await openUpdatePrompt();
        if (message && !updateInfo) await whileModal(() => dialog.showMessageBox({ title: 'تحديثات رواء', message }));
      } },
      { label: 'تصغير بجانب الساعة', click: () => minimizeToTray(launcherEntries().find(entry => !entry.isSettings && entry.win.isFocused())) },
      { type: 'separator' },
      { label: 'اخفاء كلي (خروج)', click: () => app.quit() }
    ]));
    tray.on('balloon-click', openUpdatePrompt);
    tray.on('click', () => { if (trayOnly) showLauncher(); });
    registerHandlers();
    registerKeys();
    syncWindows();
    screen.on('display-added', syncWindows);
    screen.on('display-removed', syncWindows);
    screen.on('display-metrics-changed', syncWindows);
    interval = setInterval(tick, 100);
    startMonitor();
    setupUpdates();
  }).catch(error => {
    dialog.showErrorBox('Rawaa', error.message);
    app.quit();
  });
}
