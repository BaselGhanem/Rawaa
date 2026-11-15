const { randomUUID } = require('node:crypto');

const defaults = () => ({
  version: 1,
  active: 'home',
  spaces: [{ id: 'home', name: 'مساحتي' }],
  groups: [],
  items: [],
  displays: {},
  prefs: {
    displayName: 'رواء',
    theme: 'classic', searchView: 'sidebar', searchAlwaysOnTop: false,
    width: 330, iconSize: 20, gap: 5, opacity: 38, blur: true, tint: 'warm',
    icons: 'line', compactLabels: false, hour12: false, weekStart: 6,
    toggleKey: 'CommandOrControl+Alt+Space', searchKey: 'CommandOrControl+Alt+K',
    foldOnOutsideClick: true,
    hideFullscreen: true
  }
});

const string = (value, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';
const number = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
const list = value => Array.isArray(value) ? value.slice(0, 1500).filter(entry => entry && typeof entry === 'object') : [];
const id = value => /^[\w-]{1,80}$/.test(string(value, 80)) ? value : randomUUID();

function normalize(input) {
  if (input?.version !== 1 || !Array.isArray(input.spaces) || !Array.isArray(input.items)) {
    throw new Error('ملف الاعدادات غير صالح');
  }
  const state = defaults();
  const p = input.prefs || {};
  state.prefs = {
    ...state.prefs,
    displayName: string(typeof p.displayName === 'string' ? p.displayName.trim() : '', 40).trim() || state.prefs.displayName,
    searchView: p.searchView === 'palette' ? 'palette' : 'sidebar',
    searchAlwaysOnTop: p.searchAlwaysOnTop === true,
    theme: p.theme === 'pebbly' ? 'pebbly' : 'classic',
    width: number(p.width, 275, 460, 330),
    iconSize: number(p.iconSize, 16, 30, 20),
    gap: number(p.gap, 0, 13, 5),
    opacity: number(p.opacity, 15, 90, 38),
    blur: p.blur !== false,
    tint: p.tint === 'teal' ? 'teal' : 'warm',
    icons: p.icons === 'native' ? 'native' : 'line',
    compactLabels: p.compactLabels === true,
    hour12: p.hour12 === true,
    weekStart: p.weekStart === 0 ? 0 : 6,
    toggleKey: string(p.toggleKey, 80) || state.prefs.toggleKey,
    searchKey: string(p.searchKey, 80) || state.prefs.searchKey,
    foldOnOutsideClick: p.foldOnOutsideClick !== false,
    hideFullscreen: p.hideFullscreen !== false
  };
  const unique = entries => [...new Map(entries.map(entry => [entry.id, entry])).values()];
  state.spaces = unique(list(input.spaces).map(value => ({ id: id(value.id), name: string(value.name, 70).trim() })).filter(value => value.name));
  if (!state.spaces.length) state.spaces = defaults().spaces;
  const space = value => state.spaces.some(entry => entry.id === value) ? value : state.spaces[0].id;
  state.active = space(input.active);
  state.groups = unique(list(input.groups).map(value => ({
    id: id(value.id), name: string(value.name, 70).trim(), space: space(value.space), collapsed: value.collapsed === true
  })).filter(value => value.name));
  state.items = unique(list(input.items).map(value => {
    const owner = space(value.space);
    return {
      id: id(value.id), name: string(value.name, 100).trim(),
      kind: ['app', 'file', 'folder', 'url', 'bundle'].includes(value.kind) ? value.kind : 'file',
      target: string(value.target), icon: string(value.icon, 80),
      space: owner, group: state.groups.some(group => group.id === value.group && group.space === owner) ? value.group : '',
      shared: value.shared === true, pinned: value.pinned === true,
      children: [...new Set(listIds(value.children))],
      layout: list(value.layout).map(position => ({
        item: string(position.item, 80), display: string(position.display, 30),
        x: number(position.x, 0, 10000, 0), y: number(position.y, 0, 10000, 0),
        width: number(position.width, 200, 10000, 900), height: number(position.height, 150, 10000, 650)
      }))
    };
  }).filter(value => value.name && (value.kind === 'bundle' || value.target)));
  const itemsById = new Map(state.items.map(item => [item.id, item]));
  for (const item of state.items) {
    item.children = item.children.filter(child => child !== item.id && itemsById.has(child) && itemsById.get(child).kind !== 'bundle');
    item.layout = item.layout.filter(position => item.children.includes(position.item));
  }
  for (const [key, value] of Object.entries(input.displays || {}).slice(0, 30)) {
    if (!/^-?\d+$/.test(key) || !value) continue;
    state.displays[key] = {
      mode: ['fixed', 'edge', 'off'].includes(value.mode) ? value.mode : 'fixed',
      side: ['left', 'top'].includes(value.side) ? value.side : 'right',
      compact: value.compact === true
    };
  }
  return state;
}

function listIds(values) {
  return Array.isArray(values) ? values.slice(0, 150).filter(value => typeof value === 'string') : [];
}

module.exports = { defaults, normalize };
