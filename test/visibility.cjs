const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(`${__dirname}/../src/main.cjs`, `utf8`);
function harness() {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const calls = [];
  let visible = false;
  const entry = { ready: true, shape: `old`, suppressed: true, edgePanel: true, win: {
    webContents: { isLoading: () => false, send: (...args) => calls.push(args) },
    isMinimized: () => false, isVisible: () => visible, show: () => { visible = true; }, showInactive: () => { visible = true; },
    hide: () => { visible = false; }, focus() {}, isFocused: () => false,
    setSkipTaskbar: value => calls.push([`taskbar`, value]), setAlwaysOnTop() {}, moveTop() {},
    getBounds: () => ({ x: 1550, y: 100, width: 370, height: 760 }), reload: () => calls.push([`reload`])
  } };
  const context = { windows: new Map([[1, entry]]), trayOnly: true, trayTransition: null, clearTimeout,
    state: { prefs: { hideFullscreen: true, searchView: `sidebar` } }, foreground: [0, 0, 1920, 1080], windowsOS: true,
    screen: { getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      dipToScreenRect: (_win, area) => area, getAllDisplays: () => [display] },
    syncWindows() {}, quitting: false, dockDrag: null, settingsEntry: null, modalDialogs: 0,
    shelfDragging: false, breakWindow: null, displayConfig: () => ({ side: `right`, mode: `fixed` }), Date, Boolean
  };
  vm.createContext(context);
  for (const name of [`covers`, `keepPinnedVisible`, `tick`, `showLauncher`, `restoreEntry`]) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`\nfunction `, start + 1);
    vm.runInContext(source.slice(start, end), context);
  }
  return { context, entry, calls, visible: () => visible };
}
test(`tray restores suppressed folded window and taskbar in fullscreen`, () => {
  const h = harness(); h.context.showLauncher(); h.context.tick();
  assert.equal(h.visible(), true); assert.equal(h.context.trayOnly, false);
  assert.equal(h.entry.suppressed, false); assert.equal(h.entry.edgePanel, false);
  assert.ok(h.calls.some(([name, value]) => name === `taskbar` && value === false));
  assert.ok(h.calls.some(([name]) => name === `restore-launcher`));
});
test(`repeated show is idempotent instead of hiding focused window`, () => {
  const h = harness(); h.entry.win.isFocused = () => true;
  h.context.showLauncher(); h.context.showLauncher(); assert.equal(h.visible(), true);
});
test(`edge recovery remains available over fullscreen`, () => {
  const h = harness(); h.context.trayOnly = false; h.entry.suppressed = false; h.context.tick(); assert.equal(h.visible(), true);
});
test(`loading renderer queues restoration until ready`, () => {
  const h = harness(); h.entry.ready = false; h.context.showLauncher(true);
  assert.equal(h.entry.pendingRestore.search, true);
  h.entry.ready = true; h.context.restoreEntry(h.entry, true);
  assert.equal(h.entry.pendingRestore, null); assert.equal(h.visible(), true);
});
test(`explicit expand pins and preserves fullscreen override`, () => {
  const h = harness(); h.context.showLauncher(false, true); h.context.tick();
  assert.equal(h.entry.pinned, true); assert.equal(h.visible(), true);
});
test(`manual recovery retries renderer after bounded crash loop`, () => {
  const h = harness(); h.entry.recoveryAttempts = 4; h.context.showLauncher();
  assert.ok(h.calls.some(([name]) => name === `reload`));
});

test(`fullscreen policy returns fixed dock after fullscreen ends`, () => {
  const h = harness(); h.context.trayOnly = false; h.entry.edgePanel = false; h.entry.suppressed = false;
  h.context.tick(); assert.equal(h.visible(), false);
  h.context.foreground = null; h.context.tick(); assert.equal(h.visible(), true);
});
test(`settings preview keeps its source visible over fullscreen`, () => {
  const h = harness(); h.context.trayOnly = false; h.entry.edgePanel = false;
  h.context.settingsEntry = { source: h.entry }; h.context.tick(); assert.equal(h.visible(), true);
});
test(`intentional tray hiding is preserved until explicit restore`, () => {
  const h = harness(); h.context.tick(); assert.equal(h.visible(), false);
  h.context.showLauncher(); assert.equal(h.visible(), true);
});
test(`unresponsive renderer can be recovered from tray`, () => {
  const h = harness(); h.entry.unresponsive = true; h.context.showLauncher();
  assert.ok(h.calls.some(([name]) => name === `reload`));
});
test(`renderer restore cancels both invisible animation states`, async () => {
  const ui = fs.readFileSync(`${__dirname}/../src/ui.js`, `utf8`);
  const start = ui.indexOf('  api.on(`restore-launcher`');
  const end = ui.indexOf('  api.on(`edge-open`', start);
  const events = {}; const cancelled = []; let mode;
  const context = { api: { on: (name, callback) => { events[name] = callback; } },
    clearTimeout() {}, edgeTimer: 1, edgeMode: `fold`,
    trayMotion: { cancel: () => cancelled.push(`tray`) }, edgeMotion: { cancel: () => cancelled.push(`edge`) },
    setEdgeMode: async value => { mode = value; }, requestAnimationFrame: callback => callback(), reportGeometry() {}, searchFocus() {} };
  vm.createContext(context); vm.runInContext(ui.slice(start, end), context);
  await events[`restore-launcher`]({ mode: `normal`, search: false });
  assert.deepEqual(cancelled, [`tray`, `edge`]); assert.equal(mode, `normal`);
});
