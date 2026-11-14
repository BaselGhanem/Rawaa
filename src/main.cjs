const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, dialog, globalShortcut, nativeImage, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { defaults, normalize } = require('./store.cjs');

const exec = promisify(execFile);
const windows = new Map();
const imageCache = new Map();
const windowsOS = process.platform === 'win32';
const nativeScript = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'windows.ps1');
const ps = windowsOS ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
const args = (action, extra = []) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeScript, '-Action', action, ...extra];
const native = (action, extra) => exec(ps, args(action, extra), { windowsHide: true, timeout: 12000 });
let state = defaults();
let tray;
let monitor;
let interval;
let foreground;
let quitting = false;
let updateStatus = '';
let updatesReady = false;
let updateInfo;
let checkingUpdate;
let updatePromptOpen = false;
let updateNotification;
let notifiedVersion;
let saveQueue = Promise.resolve();

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
    state = next;
    syncWindows();
    if (keysChanged) registerKeys();
    for (const { win } of windows.values()) if (!win.isDestroyed()) win.webContents.send('state', state);
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

function boundsFor(display, settings) {
  const area = display.workArea;
  const width = Math.min(area.width, state.prefs.width + 110);
  const height = Math.max(180, Math.min(760, area.height - 30));
  return {
    x: settings.side === 'left' ? area.x + 12 : area.x + area.width - width - 12,
    y: area.y + Math.round((area.height - height) / 2), width, height
  };
}

function makeWindow(display, settings) {
  const win = new BrowserWindow({
    ...boundsFor(display, settings), show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, title: 'رواء',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  const entry = { win, ready: false, revealed: false, manual: false, fullscreen: false };
  windows.set(display.id, entry);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => { entry.ready = true; tick(); });
  win.on('closed', () => { if (windows.get(display.id) === entry) windows.delete(display.id); });
  win.loadFile(path.join(__dirname, 'index.html'), { query: { display: String(display.id) } });
}

function syncWindows() {
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

function tick() {
  if (quitting) return;
  const cursor = screen.getCursorScreenPoint();
  for (const display of screen.getAllDisplays()) {
    const entry = windows.get(display.id);
    if (!entry?.ready || (windowsOS && !entry.shape)) continue;
    const settings = displayConfig(display);
    const bounds = entry.win.getBounds();
    const area = display.bounds;
    const edge = settings.side === 'left' ? area.x : area.x + area.width - 1;
    const nearEdge = Math.abs(cursor.x - edge) <= 8 && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    const inWindow = cursor.x >= bounds.x - 13 && cursor.x <= bounds.x + bounds.width + 13 &&
      cursor.y >= bounds.y - 3 && cursor.y <= bounds.y + bounds.height + 3;
    if (nearEdge) entry.revealed = true;
    if (!inWindow && !entry.win.isFocused()) entry.revealed = false;
    const physical = windowsOS ? screen.dipToScreenRect(entry.win, display.bounds) : display.bounds;
    const fullscreen = state.prefs.hideFullscreen && covers(foreground, physical);
    if (fullscreen && !entry.fullscreen) entry.overrideFullscreen = false;
    entry.fullscreen = fullscreen;
    const show = (!fullscreen || entry.overrideFullscreen) && (entry.manual || (!entry.suppressed && (settings.mode === 'fixed' || entry.revealed)));
    if (show && !entry.win.isVisible()) entry.win.showInactive();
    if (!show && entry.win.isVisible()) entry.win.hide();
    if (nearEdge && !entry.wasNear && settings.mode === 'edge') entry.suppressed = false;
    entry.wasNear = nearEdge;
  }
}

function showLauncher(search = false) {
  const preferred = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const entry = windows.get(preferred.id) || [...windows.values()][0];
  if (!entry) return;
  if (!search && entry.win.isVisible() && entry.win.isFocused()) {
    hideLauncher(entry);
    return;
  }
  entry.manual = true;
  entry.suppressed = false;
  entry.overrideFullscreen = true;
  entry.win.show();
  entry.win.focus();
  if (search) entry.win.webContents.send('search-focus');
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

function startMonitor() {
  if (!windowsOS || quitting) return;
  monitor = spawn(ps, args('monitor'), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = require('node:readline').createInterface({ input: monitor.stdout });
  lines.on('line', line => { foreground = /^-?\d+( -?\d+){3}$/.test(line) ? line.split(' ').map(Number) : null; });
  monitor.on('error', () => { foreground = null; });
  monitor.once('close', () => {
    foreground = null;
    if (!quitting) setTimeout(startMonitor, 5000).unref();
  });
}

function displaysInfo() {
  const enabled = screen.getAllDisplays();
  return enabled.map((display, index) => ({
    id: String(display.id), name: display.label || `شاشة ${index + 1}`,
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
  if (!path.isAbsolute(item.target)) throw new Error('اختر مسارا كاملا للعنصر');
  await fsp.access(item.target).catch(() => { throw new Error(`تعذر الوصول الى ${item.name}`); });
  const target = windowsOS && item.kind === 'app' ? await executable(item).catch(() => '') : '';
  let running = false;
  if (target) {
    try {
      await native('activate', ['-Target', target]);
      running = true;
    } catch (error) {
      if (error.code === 3) running = true;
    }
  }
  if (!running) {
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
  for (const { win } of windows.values()) win.webContents.send('update-status', message);
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
    const { response } = entry?.win.isVisible()
      ? await dialog.showMessageBox(entry.win, options)
      : await dialog.showMessageBox(options);
    if (response !== 0) return '';
    if (!ready) {
      status('جاري تنزيل التحديث');
      await autoUpdater.downloadUpdate();
    }
    autoUpdater.quitAndInstall(false, true);
    return 'جاري تثبيت التحديث';
  } catch (error) {
    console.error('Rawaa updater:', error.message);
    return updateStatus;
  } finally {
    updatePromptOpen = false;
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
    if (updatePromptOpen || notifiedVersion === info.version || !Notification.isSupported()) return;
    notifiedVersion = info.version;
    updateNotification = new Notification({ title: `رواء • تحديث ${info.version}`, body: 'اضغط لتنزيل التحديث وتثبيته من داخل رواء' });
    updateNotification.on('click', () => offerUpdate([...windows.values()].find(entry => entry.win.isVisible())));
    updateNotification.show();
  });
  autoUpdater.on('update-not-available', () => {
    updateInfo = undefined;
    status(`رواء على اخر اصدار • ${app.getVersion()}`);
  });
  autoUpdater.on('download-progress', progress => status(`جاري تنزيل التحديث ${Math.floor(progress.percent)}٪`));
  autoUpdater.on('update-downloaded', () => { updatesReady = true; status('التحديث جاهز للتثبيت'); });
  autoUpdater.on('error', error => {
    console.error('Rawaa updater:', error.message);
    status(error.statusCode === 404 ? 'بيانات التحديث غير متاحة حاليا' : 'تعذر اكمال التحديث، جرب مرة ثانية');
  });
  const check = () => { if (!updatePromptOpen && !updatesReady) checkUpdates().catch(() => {}); };
  setTimeout(check, 3000).unref();
  setInterval(check, 4 * 60 * 60 * 1000).unref();
}

async function fileIcon(target) {
  if (!path.isAbsolute(target)) return '';
  if (!imageCache.has(target)) {
    if (imageCache.size > 250) imageCache.clear();
    const image = await app.getFileIcon(target, { size: 'normal' }).catch(() => null);
    if (image) imageCache.set(target, image.toDataURL());
  }
  return imageCache.get(target) || '';
}

function registerHandlers() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, value) => {
    const entry = [...windows.values()].find(candidate => candidate.win.webContents === event.sender);
    if (!entry || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid sender');
    return fn(entry, value);
  });
  handle('load', () => ({ state, displays: displaysInfo(), version: app.getVersion(), updateStatus }));
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
  handle('geometry', (entry, value) => {
    if (!windowsOS || !Array.isArray(value) || value.length > 4 || !value.length) return;
    const valid = rect => rect && ['x', 'y', 'width', 'height'].every(key =>
      Number.isInteger(rect[key]) && rect[key] >= 0 && rect[key] <= 2000
    ) && rect.width > 0 && rect.height > 0;
    if (!value.every(valid)) return;
    const signature = JSON.stringify(value);
    if (entry.shape === signature) return;
    const radii = [39, 14, 11, 11];
    const regions = value.flatMap(({ x, y, width, height }, index) => {
      const radius = Math.min(radii[index], Math.floor(width / 2), Math.floor(height / 2));
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
    entry.shape = signature;
    if (firstShape) tick();
  });
  handle('hide', entry => hideLauncher(entry));
  handle('choose', async (entry, kind) => {
    const result = await dialog.showOpenDialog(entry.win, { properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'] });
    return (await Promise.all(result.filePaths.map(describe))).filter(Boolean);
  });
  handle('paths', async (_entry, paths) => (await Promise.all((Array.isArray(paths) ? paths.slice(0, 100) : []).map(describe))).filter(Boolean));
  handle('open-apps', async () => {
    if (!windowsOS) return [];
    const { stdout } = await native('list', ['-OwnerPid', String(process.pid)]);
    const entries = stdout.trim() ? JSON.parse(stdout) : [];
    return Promise.all(entries.map(async entry => ({
      kind: 'app', name: entry.name, target: entry.target, image: await fileIcon(entry.target)
    })));
  });
  handle('icon', (_entry, id) => {
    const item = state.items.find(value => value.id === id);
    return item && ['app', 'file', 'folder'].includes(item.kind) ? fileIcon(item.target) : '';
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
      const result = await dialog.showSaveDialog(entry.win, { defaultPath: 'Rawaa-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!result.canceled) await fsp.writeFile(result.filePath, JSON.stringify(state, null, 2), 'utf8');
      return !result.canceled;
    }
    if (action !== 'import') return false;
    const result = await dialog.showOpenDialog(entry.win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled) return false;
    const next = await readConfiguration(result.filePaths[0]);
    const displays = screen.getAllDisplays();
    if (displays.every(display => (next.displays[display.id]?.mode || (display.id === screen.getPrimaryDisplay().id ? 'fixed' : 'off')) === 'off')) {
      next.displays[screen.getPrimaryDisplay().id] = { mode: 'fixed', side: 'right', compact: false };
    }
    const confirmation = await dialog.showMessageBox(entry.win, {
      type: 'question', message: 'استبدال اعدادات رواء الحالية؟',
      detail: 'رح يتم تحميل المساحات والاختصارات من الملف المختار', buttons: ['استيراد', 'الغاء'], defaultId: 1, cancelId: 1
    });
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
    tray.setToolTip('رواء | Rawaa');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'اظهار رواء', click: () => showLauncher() },
      { label: 'بحث سريع', click: () => showLauncher(true) },
      { label: 'اخفاء الشريط', click: () => windows.forEach(hideLauncher) },
      { type: 'separator' },
      { label: 'خروج', click: () => app.quit() }
    ]));
    tray.on('double-click', () => showLauncher());
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
