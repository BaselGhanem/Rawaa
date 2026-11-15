'use strict';

const api = window.rawaa;
const $ = id => document.getElementById(id);
const kinds = { app: 'تطبيق او اختصار', file: 'ملف', folder: 'مجلد', url: 'رابط', bundle: 'زر تشغيل مجموعة' };
const kindIcons = { app: 'app-window', file: 'file', folder: 'folder', url: 'link', bundle: 'rocket-launch' };
const iconOptions = ['app-window', 'file', 'folder', 'link', 'rocket-launch', 'chart-bar', 'table', 'game-controller', 'globe', 'book-open', 'briefcase', 'graduation-cap', 'star', 'image', 'music-note', 'envelope', 'code', 'video-camera'];
const isPalette = new URLSearchParams(location.search).get(`view`) === `palette`;
document.body.classList.toggle(`palette`, isPalette);
const displayId = new URLSearchParams(location.search).get('display');
const uid = () => crypto.randomUUID();
const selectSpace = () => state.spaces.filter(space => space.id === state.active)[0];
const visibleItems = () => state.items.filter(item => item.shared || item.space === state.active);
let state;
let displays;
let compact;
let paletteIndex = 0;

let dragged;
let trayMotion;
let edgeMotion;
let edgeTimer;
let edgeMode = `pin`;

async function setEdgeMode(mode) {
  if (isPalette || mode === edgeMode) return;
  clearTimeout(edgeTimer);
  edgeMotion?.cancel();
  edgeMode = mode;
  const shell = $(`shell`);
  const handle = $(`edge-handle`);
  const control = $(`tray-minimize`);
  const left = config().side === `left`;
  const top = config().side === `top`;
  control.replaceChildren(icon(mode === `preview` ? `push-pin` : `minus`));
  control.title = mode === `preview` ? `تثبيت فوق النوافذ` : `طي الشريط للحافة`;
  control.setAttribute(`aria-label`, control.title);
  const folded = mode === `fold`;
  handle.hidden = !folded;
  handle.setAttribute(`aria-expanded`, String(!folded));
  shell.classList.remove(`edge-folded`);
  shell.classList.toggle(`edge-preview`, mode === `preview`);
  const tip = $(`tip`);
  tip.hidden = true;
  const updateWindow = api.edgePanel(mode);
  if (matchMedia(`(prefers-reduced-motion: reduce)`).matches || mode === `pin`) {
    shell.classList.toggle(`edge-folded`, folded);
    if (mode === `pin`) animate(control, [
      { scale: .84, rotate: `-12deg` }, { scale: 1.12, rotate: `5deg`, offset: .55 }, { scale: 1, rotate: `0deg` }
    ]);
  } else {
    const full = { opacity: 1, translate: `0`, scale: 1, clipPath: `inset(0 round 30px)` };
    const tucked = {
      opacity: 0,
      translate: top ? `0 -24px` : `${left ? -30 : 30}px`,
      scale: .94,
      clipPath: top ? `inset(0 45% 90% round 20px)` : left ? `inset(35% 95% 35% 0 round 20px)` : `inset(35% 0 35% 95% round 20px)`
    };
    const motion = shell.animate(folded ? [full, tucked] : [tucked, full], {
      duration: folded ? 235 : 310, easing: `cubic-bezier(.22,.8,.2,1)`, fill: `forwards`
    });
    edgeMotion = motion;
    motion.finished.then(() => {
      shell.classList.toggle(`edge-folded`, folded);
      motion.cancel();
      reportGeometry();
    }).catch(() => {});
  }
  try { await updateWindow; } catch (error) { errorMessage(error); }
  reportGeometry();
}
let toastTimeout;
let updateStatus;
let version;
let ignoreSettings = false;
const nativeIcons = new Map();

function el(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function icon(name) {
  const item = el('i', `ph ph-${name}`);
  item.setAttribute('aria-hidden', 'true');
  return item;
}

function button(label, handler, css = 'secondary', glyph) {
  const item = el('button', css);
  item.type = 'button';
  if (glyph) item.append(icon(glyph));
  if (label) item.append(el('span', '', label));
  item.addEventListener('click', handler);
  return item;
}

function row(label, glyph, handler) {
  const item = button(label, handler, 'row', glyph);
  item.dataset.tip = label;
  item.setAttribute('aria-label', label);
  return item;
}

function choice(options, value) {
  const input = el('select');
  for (const [key, label] of options) {
    const option = el('option', '', label);
    option.value = key;
    input.append(option);
  }
  input.value = value;
  return input;
}

function input(type, value, attributes = {}) {
  const node = el('input');
  node.type = type;
  node.value = value ?? '';
  for (const [key, data] of Object.entries(attributes)) node[key] = data;
  return node;
}

function field(label, node) {
  const field = el('label', 'field');
  field.append(el('span', '', label), node);
  return field;
}

function checkbox(label, checked) {
  const item = input('checkbox', '', { checked });
  const labelNode = el('label', 'check');
  labelNode.append(item, el('span', '', label));
  return { item, label: labelNode };
}

function formActions(save, extras = []) {
  const actions = el('div', 'actions');
  const submit = el('button', 'primary', save);
  submit.type = 'submit';
  actions.append(submit, ...extras);
  return actions;
}

function toast(message, undo) {
  if (!message) return;
  const node = $('toast');
  clearTimeout(toastTimeout);
  node.replaceChildren(document.createTextNode(message));
  if (undo) node.append(button(`تراجع`, () => {
    node.hidden = true;
    reportGeometry();
    undo();
  }, `plain`));
  node.classList.toggle(`undo-toast`, Boolean(undo));
  node.hidden = false;
  reportGeometry();
  toastTimeout = setTimeout(() => { node.hidden = true; reportGeometry(); }, undo ? 6500 : 3500);
}

function errorMessage(error) {
  toast((error?.message || 'تعذر تنفيذ الاجراء').replace(/^Error invoking remote method '[^']+': Error: /, ''));
}

async function change(mutate) {
  try {
    const next = structuredClone(state);
    mutate(next);
    const result = await api.save(next);
    state = result.state;
    if (result.warning) toast(result.warning);
    draw();
    return true;
  } catch (error) {
    errorMessage(error);
    return false;
  }
}

function config() {
  const display = displays.find(entry => entry.id === displayId) || displays[0];
  return state.displays[display.id] || display.config;
}

function styles() {
  const { prefs } = state;
  const root = document.documentElement.style;
  root.setProperty('--width', `${prefs.width}px`);
  root.setProperty('--alpha', `${prefs.opacity / 100}`);
  root.setProperty('--icon', `${prefs.iconSize}px`);
  root.setProperty('--gap', `${prefs.gap}px`);
  document.body.classList.toggle('compact', compact);
  document.body.classList.toggle('pebbly', prefs.theme === 'pebbly');
  document.body.classList.toggle('dock-top', !isPalette && config().side === 'top');
  document.body.classList.toggle('left', config().side === 'left');
  document.body.classList.toggle('teal', prefs.tint === 'teal');
  document.body.classList.toggle('no-blur', !prefs.blur);
  document.body.classList.toggle('compact-labels', prefs.compactLabels);
  const fold = $('fold');
  const towardRight = compact === (config().side === 'left');
  fold.replaceChildren(icon(towardRight ? 'caret-right' : 'caret-left'));
  fold.setAttribute('aria-label', compact ? 'توسيع الشريط' : 'تصغير الشريط');
  fold.title = fold.getAttribute('aria-label');
  requestAnimationFrame(reportGeometry);
}

function draw() {
  styles();
  $('current-space').textContent = selectSpace().name;
  drawEntries();
  clock();
}

function nativeIcon(item, node) {
  if ((!isPalette && state.prefs.icons !== 'native' && item.kind !== 'app') || item.icon || !['app', 'file', 'folder'].includes(item.kind)) return;
  const key = `${item.id}|${item.target}`;
  if (!nativeIcons.has(key)) {
    if (nativeIcons.size > 250) nativeIcons.clear();
    nativeIcons.set(key, api.icon(item.id).catch(() => ''));
  }
  const pending = nativeIcons.get(key);
  pending.then(source => {
    if (!source && nativeIcons.get(key) === pending) nativeIcons.delete(key);
    if (!source || !node.isConnected) return;
    const image = el('img', 'app-icon');
    image.src = source;
    image.alt = '';
    node.firstElementChild.replaceWith(image);
  });
}

async function run(item, node) {
  if (node?.classList.contains('launching')) return;
  node?.classList.add('launching');
  const started = performance.now();
  try {
    const result = await api.launch(item.id);
    if (result) toast(result);
    else if (isPalette && !state.prefs.searchAlwaysOnTop) await api.hide();
  }
  catch (error) { errorMessage(error); }
  finally { setTimeout(() => node?.classList.remove('launching'), Math.max(0, 420 - (performance.now() - started))); }
}

function makeItem(item) {
  const node = row(item.name, iconOptions.includes(item.icon) ? item.icon : kindIcons[item.kind], () => run(item, node));
  node.classList.add('shortcut-row');
  node.dataset.shortcutId = item.id;
  nativeIcon(item, node);
  node.draggable = true;
  node.addEventListener('dragstart', event => {
    dragged = item.id;
    event.dataTransfer.setData('text/plain', item.id);
    event.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => {
    dragged = null;
    document.querySelectorAll(`.target`).forEach(target => target.classList.remove(`target`));
  });
  node.addEventListener('contextmenu', event => { event.preventDefault(); itemMenu(item); });
  node.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      itemMenu(item);
    }
  });
  if (item.pinned || item.children.length) node.append(icon(item.pinned ? 'push-pin' : 'dots-three'));
  if (node.lastElementChild.tagName === 'I' && node.children.length > 2) node.lastElementChild.classList.add('tail');
  dropTarget(node, item.group, item.id);
  return node;
}

function dropTarget(node, group, before) {
  node.addEventListener('dragover', event => {
    if (!dragged || dragged === before) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    node.classList.add('target');
  });
  node.addEventListener('dragleave', event => {
    if (!node.contains(event.relatedTarget)) node.classList.remove('target');
  });
  node.addEventListener('drop', async event => {
    if (!dragged || dragged === before) return;
    event.preventDefault();
    event.stopPropagation();
    node.classList.remove('target');
    const moving = dragged;
    dragged = null;
    const originalIndex = state.items.findIndex(item => item.id === moving);
    if (originalIndex < 0) return;
    const original = state.items[originalIndex];
    const previous = state.items[originalIndex - 1]?.id;
    const following = state.items[originalIndex + 1]?.id;
    const saved = await change(next => {
      const index = next.items.findIndex(item => item.id === moving);
      if (index < 0) return;
      const [item] = next.items.splice(index, 1);
      const anchor = next.items.find(entry => entry.id === before);
      item.group = group;
      item.space = anchor?.space || next.active;
      if (anchor) item.pinned = anchor.pinned;
      const destination = next.items.findIndex(entry => entry.id === before);
      next.items.splice(destination < 0 ? next.items.length : destination, 0, item);
    });
    if (saved) {
      const moved = document.querySelector(`[data-shortcut-id="${CSS.escape(moving)}"]`);
      if (moved) animate(moved, [{ opacity: .55, translate: `0 -6px` }, { opacity: 1, translate: `0 0` }]);
      toast(`تم ترتيب الاختصار`, () => change(next => {
        const index = next.items.findIndex(item => item.id === moving);
        if (index < 0) return;
        const [item] = next.items.splice(index, 1);
        Object.assign(item, { group: original.group, space: original.space, pinned: original.pinned });
        const after = next.items.findIndex(item => item.id === following);
        const before = next.items.findIndex(item => item.id === previous);
        next.items.splice(after >= 0 ? after : before >= 0 ? before + 1 : originalIndex, 0, item);
      }));
    }
  });
}

function drawEntries() {
  const entries = $('entries');
  const scroll = entries.scrollTop;
  const list = $('entry-list');
  list.replaceChildren();
  const q = $('search').value.trim().toLocaleLowerCase();
  const items = visibleItems();
  if (isPalette) {
    const matches = items.filter(item => `${item.name} ${item.target}`.toLocaleLowerCase().includes(q));
    matches.sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(q)) - Number(!b.name.toLocaleLowerCase().startsWith(q)) ||
      Number(b.pinned) - Number(a.pinned));
    list.append(...matches.map(makeItem));
    if (!matches.length) list.append(el(`p`, `empty`, q ? `ما في نتائج` : `ضيف اختصار حتى تفتحه من البحث`));
    selectPaletteResult(paletteIndex);
    return;
  }
  if (q) {
    const matches = items.filter(item => `${item.name} ${item.target}`.toLocaleLowerCase().includes(q));
    list.append(...matches.map(makeItem));
    if (!matches.length) list.append(el('p', 'empty', 'ما في نتائج'));
    entries.scrollTop = scroll;
    return;
  }
  const section = (name, contents, group) => {
    const heading = el('div', 'section', name);
    dropTarget(heading, group);
    list.append(heading, ...contents.map(makeItem));
  };
  const groups = state.groups.filter(group => group.space === state.active);
  const pinned = items.filter(item => item.pinned);
  const ordinary = items.filter(item => !item.pinned && (!item.group || !groups.some(group => group.id === item.group)));
  if (pinned.length) section('المثبتة', pinned, '');
  section('الاختصارات', ordinary, '');
  if (!items.length && !groups.length) list.append(el('p', 'empty', 'اسحب تطبيق او ملف او مجلد الى الشريط، او اضغط اضافة عنصر'));
  if (groups.length) list.append(el('div', 'section', 'المجموعات'));
  for (const group of groups) {
    const header = row(group.name, 'stack', () => change(next => {
      const target = next.groups.find(entry => entry.id === group.id);
      target.collapsed = !target.collapsed;
    }));
    header.setAttribute('aria-expanded', String(!group.collapsed));
    const caret = icon(group.collapsed ? 'caret-left' : 'caret-down');
    caret.classList.add('tail');
    header.append(caret);
    header.addEventListener('contextmenu', event => { event.preventDefault(); editGroup(group); });
    dropTarget(header, group.id);
    list.append(header);
    if (!group.collapsed) {
      const children = el('div', 'group-items');
      children.append(...items.filter(item => item.group === group.id && !item.pinned).map(makeItem));
      list.append(children);
    }
  }
  entries.scrollTop = scroll;
}

function selectPaletteResult(index) {
  const results = [...$(`entry-list`).querySelectorAll(`.shortcut-row`)];
  paletteIndex = Math.max(0, Math.min(index, results.length - 1));
  results.forEach((node, i) => {
    node.classList.toggle(`selected`, i === paletteIndex);
    if (i === paletteIndex) node.setAttribute(`aria-current`, `true`);
    else node.removeAttribute(`aria-current`);
  });
  results[paletteIndex]?.scrollIntoView({ block: `nearest` });
}

function closeSheet() {
  const sheet = $('sheet');
  sheet.hidden = true;
  $('shell').classList.remove('sheet-open');
}

function showSheet(title, content) {
  if (!$(`clock-calendar`).hidden) toggleCalendar(false);
  if (compact) { compact = false; styles(); }
  $('tip').hidden = true;
  const sheet = $('sheet');
  const header = el('div', 'sheet-head');
  const close = button('', closeSheet, 'plain', 'x');
  close.setAttribute('aria-label', 'اغلاق');
  header.append(el('strong', '', title), close);
  const body = el('div', 'sheet-content');
  body.append(content);
  sheet.classList.remove('settings-sheet');
  sheet.replaceChildren(header, body);
  sheet.hidden = false;
  $('shell').classList.add('sheet-open');
  animate(sheet, [{ opacity: .35, transform: 'translateY(9px) scale(.98)' }, { opacity: 1, transform: 'none' }]);
  sheet.querySelector('input:not([type=checkbox]),select')?.focus({ preventScroll: true });
}

function setCompact(value) {
  if (!$(`clock-calendar`).hidden) toggleCalendar(false);
  compact = value;
  closeSheet();
  $('search').value = '';
  draw();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    animate($('fold'), [{ rotate: '-18deg' }, { rotate: '8deg', offset: .7 }, { rotate: '0deg' }]);
  }
  change(next => { next.displays[displayId] = { ...config(), compact }; });
}

function searchFocus() {
  if (compact) { compact = false; styles(); }
  closeSheet();
  $(`search`).focus();
  if (isPalette) {
    $(`search`).select();
    animate($(`shell`), [{ opacity: .35 }, { opacity: 1 }]);
  }
}

function itemMenu(item) {
  const content = el('div');
  content.append(button('تعديل العنصر', () => editor(item), 'row', 'pencil-simple'));
  for (const id of item.children) {
    const child = state.items.find(entry => entry.id === id);
    if (child && item.kind !== 'bundle') content.append(row(child.name, kindIcons[child.kind], () => run(child)));
  }
  content.append(button('فتح', () => { closeSheet(); run(item); }, 'row', 'arrow-square-out'));
  showSheet(item.name, content);
}

function confirmRemoval(name, onRemove) {
  const box = el('div');
  box.append(el('p', '', `حذف «${name}» من رواء؟`), button('حذف', async () => {
    if (await change(onRemove)) closeSheet();
  }, 'danger'), button('الغاء', closeSheet));
  showSheet('تاكيد الحذف', box);
}

function editor(existing, initialGroup = '', initialKind = 'app') {
  const current = existing || { id: uid(), name: '', kind: initialKind, target: '', icon: '', space: state.active, group: initialGroup, children: [], layout: [] };
  const form = el('form');
  const name = input('text', current.name, { required: true, maxLength: 100 });
  const kind = choice(Object.entries(kinds), current.kind);
  const target = input('text', current.target, { maxLength: 4000, dir: 'ltr' });
  const space = choice(state.spaces.map(value => [value.id, value.name]), current.space);
  const group = choice([], current.group);
  const glyph = choice([['', 'تلقائية'], ...iconOptions.map(value => [value, value])], current.icon);
  const pin = checkbox('تثبيت بالاعلى', current.pinned);
  const share = checkbox('اظهار في كل المساحات', current.shared);
  const targetArea = el('div', 'field');
  const children = el('fieldset');
  const pick = button('اختيار من الجهاز', async () => {
    try {
      const entries = await api.choose(kind.value);
      const [first, ...rest] = entries;
      if (!first) return;
      target.value = first.target;
      if (!name.value) name.value = first.name;
      kind.value = first.kind;
      refreshKind();
      if (rest.length) await addPaths(rest);
    } catch (error) { errorMessage(error); }
  });
  targetArea.append(field('المسار او الرابط', target), pick);
  function refreshGroups(value = group.value) {
    const options = [['', 'بدون مجموعة'], ...state.groups.filter(entry => entry.space === space.value).map(entry => [entry.id, entry.name])];
    group.replaceChildren(...choice(options, value).children);
    group.value = options.some(([key]) => key === value) ? value : '';
  }
  const childControls = state.items.filter(item => item.id !== current.id && item.kind !== 'bundle').map(item => {
    const toggle = checkbox(item.name, current.children.includes(item.id));
    const old = current.layout.find(value => value.item === item.id);
    const display = choice([['', 'بدون ترتيب نافذة'], ...displays.map(value => [value.id, value.name])], old?.display || '');
    const x = input('number', old?.x ?? 0, { min: 0, max: 10000 });
    const y = input('number', old?.y ?? 0, { min: 0, max: 10000 });
    const width = input('number', old?.width ?? 900, { min: 200, max: 10000 });
    const height = input('number', old?.height ?? 650, { min: 150, max: 10000 });
    const layout = el('div', 'position');
    layout.append(field('من اليسار', x), field('من الاعلى', y), field('العرض', width), field('الارتفاع', height));
    const options = el('div', 'field');
    options.append(field('الشاشة', display), layout);
    const wrapper = el('div', 'field');
    wrapper.append(toggle.label, options);
    const update = () => {
      options.hidden = kind.value !== 'bundle' || item.kind !== 'app' || !toggle.item.checked;
      layout.hidden = !display.value;
      for (const control of [x, y, width, height]) control.disabled = options.hidden || layout.hidden;
    };
    toggle.item.addEventListener('change', update);
    display.addEventListener('change', update);
    return { id: item.id, toggle: toggle.item, display, x, y, width, height, wrapper, update };
  });
  const legend = el('legend');
  children.append(legend, ...childControls.map(value => value.wrapper));
  if (!childControls.length) children.append(el('small', '', 'اضف اختصارات للشريط اولا'));
  function refreshKind() {
    targetArea.hidden = kind.value === 'bundle';
    target.required = kind.value !== 'bundle';
    target.type = kind.value === 'url' ? 'url' : 'text';
    pick.hidden = kind.value === 'url';
    legend.textContent = kind.value === 'bundle' ? 'العناصر اللي بتفتح مع الزر' : 'اختصارات تظهر بالكبسة اليمين';
    for (const child of childControls) child.update();
  }
  kind.addEventListener('change', refreshKind);
  space.addEventListener('change', () => refreshGroups());
  refreshGroups(current.group);
  refreshKind();
  const extras = existing ? [button('حذف', () => confirmRemoval(existing.name, next => {
    next.items = next.items.filter(item => item.id !== existing.id);
  }), 'danger')] : [];
  form.append(field('الاسم', name), field('النوع', kind), targetArea, field('المساحة', space), field('المجموعة', group),
    field('الايقونة', glyph), pin.label, share.label, children, formActions('حفظ', extras));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const children = childControls.filter(value => value.toggle.checked);
    if (!name.value.trim()) { toast('اكتب اسم للعنصر'); return; }
    if (kind.value === 'bundle' && !children.length) { toast('اختر عنصر واحد على الاقل'); return; }
    if (kind.value === 'url' && !/^https?:\/\//i.test(target.value.trim())) { toast('الرابط لازم يبدأ بـ HTTPS او HTTP'); return; }
    const item = {
      id: current.id, name: name.value.trim(), kind: kind.value, target: target.value.trim(), icon: glyph.value,
      space: space.value, group: group.value, shared: share.item.checked, pinned: pin.item.checked,
      children: children.map(value => value.id),
      layout: children.filter(value => !value.width.disabled).map(value => ({
        item: value.id, display: value.display.value,
        x: value.x.valueAsNumber, y: value.y.valueAsNumber, width: value.width.valueAsNumber, height: value.height.valueAsNumber
      }))
    };
    if (await change(next => {
      const index = next.items.findIndex(value => value.id === item.id);
      if (index < 0) next.items.push(item);
      else next.items[index] = item;
    })) closeSheet();
  });
  showSheet(existing ? 'تعديل العنصر' : 'اضافة عنصر', form);
}

async function addPaths(paths) {
  if (!paths.length) return;
  if (await change(next => {
    for (const entry of paths) next.items.push({ ...entry, id: uid(), space: next.active });
  })) toast(`تمت اضافة ${paths.length}`);
}

async function addMenu() {
  const box = el('div', 'add-panel');
  const search = input('search', '', { placeholder: 'ابحث عن تطبيق مفتوح' });
  search.className = 'app-search';
  search.setAttribute('aria-label', 'ابحث عن تطبيق مفتوح');
  const listing = el('div', 'app-list');
  listing.setAttribute('aria-live', 'polite');
  const actions = el('div', 'add-actions');
  actions.append(
    row('ملف او رابط او تطبيق اخر', 'file-plus', () => editor()),
    row('مجلد من الجهاز', 'folder', async () => {
      try { await addPaths(await api.choose('folder')); closeSheet(); }
      catch (error) { errorMessage(error); }
    }),
    row('مجموعة جديدة', 'stack', () => editGroup()),
    row('زر يفتح عدة عناصر', 'rocket-launch', () => editor(null, '', 'bundle'))
  );
  const refresh = button('تحديث القائمة', loadApps, 'secondary', 'arrows-clockwise');
  box.append(el('div', 'section', 'التطبيقات المفتوحة'), search, refresh, listing, actions);
  showSheet('اضافة اختصار', box);
  let apps = [];
  function render() {
    const q = search.value.trim().toLocaleLowerCase();
    const matches = apps.filter(app => app.name.toLocaleLowerCase().includes(q));
    listing.replaceChildren();
    if (!matches.length) listing.append(el('p', 'empty', q ? 'ما في تطبيق مطابق' : 'ما في تطبيقات مفتوحة متاحة للاضافة'));
    for (const app of matches) {
      const exists = () => visibleItems().some(item => item.kind === 'app' && item.target.toLowerCase() === app.target.toLowerCase());
      const line = row(app.name, 'app-window', async () => {
        if (exists() || line.disabled) return;
        line.disabled = true;
        const saved = await change(next => {
          const { name, kind, target } = app;
          next.items.push({ id: uid(), name, kind, target, space: next.active });
        });
        if (saved) {
          render();
          const added = [...listing.children].find(node => node.dataset.target === app.target);
          if (added) animate(added, [{ opacity: .55, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }]);
          toast('تمت اضافة التطبيق');
        }
        else line.disabled = false;
      });
      line.classList.add('app-option');
      line.dataset.target = app.target;
      const alreadyAdded = exists();
      line.disabled = alreadyAdded;
      const indicator = icon(alreadyAdded ? 'check' : 'plus');
      indicator.classList.add('tail');
      line.append(indicator);
      if (app.image) {
        const image = el('img', 'app-icon');
        image.src = app.image;
        image.alt = '';
        line.firstElementChild.replaceWith(image);
      }
      listing.append(line);
    }
  }
  async function loadApps() {
    refresh.disabled = true;
    search.disabled = true;
    listing.replaceChildren(el(`p`, `empty loading-apps`, `جاري قراءة التطبيقات المفتوحة`));
    try {
      apps = await api.openApps();
      render();
      search.disabled = false;
    } catch {
      listing.replaceChildren(el(`p`, `empty`, `تعذر قراءة التطبيقات المفتوحة`));
    } finally {
      refresh.disabled = false;
    }
  }
  search.addEventListener(`input`, render);
  await loadApps();
}

function editGroup(existing) {
  const form = el('form');
  const name = input('text', existing?.name, { required: true, maxLength: 70 });
  const extras = existing ? [
    button('اضافة عنصر للمجموعة', () => editor(null, existing.id)),
    button('حذف المجموعة', () => confirmRemoval(existing.name, next => {
      next.groups = next.groups.filter(group => group.id !== existing.id);
    }), 'danger')
  ] : [];
  form.append(field('اسم المجموعة', name), formActions('حفظ', extras));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!name.value.trim()) return;
    if (await change(next => {
      if (existing) next.groups.find(group => group.id === existing.id).name = name.value.trim();
      else next.groups.push({ id: uid(), name: name.value.trim(), space: next.active, collapsed: false });
    })) closeSheet();
  });
  showSheet(existing ? 'تعديل المجموعة' : 'مجموعة جديدة', form);
}

function spaces() {
  const box = el('div');
  for (const space of state.spaces) {
    const line = row(space.name, space.id === state.active ? 'check-circle' : 'squares-four', async () => {
      if (await change(next => { next.active = space.id; })) closeSheet();
    });
    line.addEventListener('contextmenu', event => { event.preventDefault(); editSpace(space); });
    box.append(line);
  }
  box.append(row('مساحة جديدة', 'plus-circle', () => editSpace()), row('تعديل المساحة الحالية', 'pencil-simple', () => editSpace(selectSpace())));
  showSheet('مساحات العمل', box);
}

function editSpace(existing) {
  const form = el('form');
  const name = input('text', existing?.name, { required: true, maxLength: 70 });
  const extras = existing && state.spaces.length > 1 ? [button('حذف المساحة', () => confirmRemoval(existing.name, next => {
    next.spaces = next.spaces.filter(space => space.id !== existing.id);
    const fallback = next.spaces[0].id;
    if (next.active === existing.id) next.active = fallback;
    for (const entry of [...next.items, ...next.groups]) if (entry.space === existing.id) entry.space = fallback;
  }), 'danger')] : [];
  form.append(field('اسم المساحة', name), formActions('حفظ', extras));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!name.value.trim()) return;
    if (await change(next => {
      if (existing) next.spaces.find(space => space.id === existing.id).name = name.value.trim();
      else {
        next.active = uid();
        next.spaces.push({ id: next.active, name: name.value.trim() });
      }
    })) closeSheet();
  });
  showSheet(existing ? 'تعديل المساحة' : 'مساحة جديدة', form);
}

async function settings() {
  try { displays = (await api.load()).displays; } catch (error) { errorMessage(error); }
  const form = el('form');
  form.className = 'settings-form';
  const controls = {};
  const navigation = el('nav', 'settings-nav');
  navigation.setAttribute('aria-label', 'اقسام الاعدادات');
  const sections = {};
  const tabs = {};
  function selectSection(key) {
    for (const [id, panel] of Object.entries(sections)) {
      panel.hidden = id !== key;
      tabs[id].setAttribute('aria-pressed', String(id === key));
    }
    form.closest('.sheet-content')?.scrollTo?.({ top: 0 });
  }
  for (const [key, title, glyph] of [
    ['look', 'المظهر', 'paint-brush'],
    ['display', 'الشاشات', 'monitor'],
    ['controls', 'التحكم', 'keyboard'],
    ['system', 'النظام', 'gear']
  ]) {
    sections[key] = el('section', 'settings-card');
    sections[key].dataset.section = key;
    tabs[key] = button(title, () => selectSection(key), 'settings-tab', glyph);
    navigation.append(tabs[key]);
  }
  form.append(navigation, ...Object.values(sections));
  selectSection('look');
  form.addEventListener('invalid', event => {
    const key = event.target.closest('[data-section]')?.dataset.section;
    if (key) selectSection(key);
  }, true);
  const fields = [
    [`searchView`, `واجهة البحث`, choice([['sidebar', 'داخل الشريط'], ['palette', 'لوحة في وسط الشاشة']], state.prefs.searchView)],
    ['theme', 'الثيم', choice([['classic', 'رواء الكلاسيكي'], ['pebbly', 'مستوحى من Pebbly']], state.prefs.theme)],
    ['width', 'عرض الشريط', input('range', state.prefs.width, { min: 275, max: 460 })],
    ['iconSize', 'حجم الايقونات', input('range', state.prefs.iconSize, { min: 16, max: 30 })],
    ['gap', 'المسافة بين العناصر', input('range', state.prefs.gap, { min: 0, max: 13 })],
    ['opacity', 'كثافة لون الزجاج', input('range', state.prefs.opacity, { min: 15, max: 90 })],
    ['tint', 'لون الزجاج', choice([['warm', 'دافئ'], ['teal', 'تيل']], state.prefs.tint)],
    ['icons', 'نمط الايقونات', choice([['line', 'خطية'], ['native', 'ايقونات الملفات والتطبيقات']], state.prefs.icons)],
    ['weekStart', 'بداية الاسبوع', choice([[6, 'السبت'], [0, 'الاحد']], String(state.prefs.weekStart))],
    ['toggleKey', 'اختصار اظهار الشريط', input('text', state.prefs.toggleKey, { dir: 'ltr', required: true })],
    ['searchKey', 'اختصار البحث', input('text', state.prefs.searchKey, { dir: 'ltr', required: true })]
  ];
  for (const [key, label, node] of fields) {
    controls[key] = node;
    const section = ['weekStart', 'toggleKey', 'searchKey'].includes(key) ? sections.controls : sections.look;
    const wrapper = field(label, node);
    if (node.type === 'range') {
      const value = el('output', 'setting-value');
      const refresh = () => { value.textContent = key === 'opacity' ? `${node.value}٪` : `${node.value} px`; };
      node.addEventListener('input', refresh);
      refresh();
      wrapper.firstChild.append(value);
    }
    section.append(wrapper);
  }
  for (const [key, label] of [['searchAlwaysOnTop', 'لوحة البحث فوق النوافذ دائما'], ['blur', 'كثافة الزجاج الافتراضية'], ['compactLabels', 'اظهار عناوين الاقسام بالمصغر'], ['hideFullscreen', 'اخفاء وقت ملء الشاشة'], ['hour12', 'الساعة بنظام 12 ساعة']]) {
    const control = checkbox(label, state.prefs[key]);
    controls[key] = control.item;
    const section = key === 'hour12' ? sections.controls : key === 'hideFullscreen' ? sections.display : sections.look;
    section.append(control.label);
  }
  const monitorControls = displays.map(display => {
    const settings = state.displays[display.id] || display.config;
    const block = el('fieldset');
    const mode = choice([['fixed', 'ثابت'], ['edge', 'يظهر عند الحافة'], ['off', 'مخفي']], settings.mode);
    const side = choice([['right', 'يمين'], ['left', 'يسار'], ['top', 'اعلى الشاشة']], settings.side);
    const compactMode = checkbox('الوضع المصغر', settings.compact);
    block.append(el('legend', '', display.name), field('الظهور', mode), field('جهة الشريط', side), compactMode.label);
    sections.display.append(block);
    return { id: display.id, mode, side, compact: compactMode.item };
  });
  const actions = ['export', 'import'].map((action, index) => button(index ? 'استيراد الاعدادات' : 'تصدير الاعدادات', async () => {
    try {
      if (await api.backup(action)) {
        if (action === 'import') { compact = !isPalette && config().compact; draw(); closeSheet(); }
        toast(index ? 'تم الاستيراد' : 'تم التصدير');
      }
    } catch (error) { errorMessage(error); }
  }));
  actions.push(button('التحديثات', async () => {
    try { toast(await api.updates()); } catch (error) { errorMessage(error); }
  }), button(isPalette ? 'اخفاء لوحة البحث' : 'اخفاء الشريط', () => { closeSheet(); if (isPalette) api.hide(); else setEdgeMode(`fold`); }));
  const updateLine = el('small', '', updateStatus || `Rawaa ${version}`);
  updateLine.id = 'update-status';
  updateLine.setAttribute('role', 'status');
  const systemActions = el('div', 'actions');
  systemActions.append(...actions.slice(2), ...actions.slice(0, 2));
  sections.system.append(el('strong', '', `رواء ${version}`), updateLine, systemActions);
  form.append(formActions('حفظ الاعدادات'));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const showPalette = state.prefs.searchView !== `palette` && controls.searchView.value === `palette`;
    ignoreSettings = true;
    const success = await change(next => {
      for (const [key, node] of Object.entries(controls)) {
        if (node.type === 'checkbox') next.prefs[key] = node.checked;
        else if (node.type === 'range' || key === 'weekStart') next.prefs[key] = Number(node.value);
        else next.prefs[key] = node.value.trim();
      }
      for (const display of monitorControls) {
        next.displays[display.id] = { mode: display.mode.value, side: display.side.value, compact: display.compact.checked };
      }
    });
    ignoreSettings = false;
    if (success) {
      compact = !isPalette && config().compact;
      draw();
      closeSheet();
      if (showPalette) api.showSearch().catch(errorMessage);
    }
  });
  showSheet('الاعدادات', form);
  $('sheet').classList.add('settings-sheet');
}

function clock() {
  const now = new Date();
  const time = new Intl.DateTimeFormat('ar-JO', { hour: '2-digit', minute: '2-digit', hour12: state.prefs.hour12 }).format(now);
  const parts = new Intl.DateTimeFormat(`ar-JO-u-nu-latn`, {
    hour: `2-digit`, minute: `2-digit`, ...(state.prefs.hour12 ? { hour12: true } : { hourCycle: `h23` })
  }).formatToParts(now);
  const reading = parts.filter(part => [`hour`, `minute`].includes(part.type)).map(part => part.value).join(`:`);
  $(`time`).textContent = reading;
  $(`clock-period`).textContent = parts.find(part => part.type === `dayPeriod`)?.value || ``;
  $(`clock-period`).hidden = !state.prefs.hour12;
  $(`date`).setAttribute(`aria-label`, `${time}، فتح التقويم`);
  $('date-label').textContent = new Intl.DateTimeFormat('ar-JO', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  $('date').dataset.tip = `${time} · التقويم`;
}

function toggleCalendar(open = $(`clock-calendar`).hidden) {
  const panel = $(`clock-calendar`);
  const trigger = $(`date`);
  if (open) {
    $(`shell`).classList.add(`calendar-open`);
    calendar();
    panel.hidden = false;
    animate(panel, [
      { opacity: 0, transform: `translateY(9px) scale(.94)` },
      { opacity: 1, transform: `none` }
    ]);
  } else {
    panel.hidden = true;
    $(`shell`).classList.remove(`calendar-open`);
  }
  trigger.setAttribute(`aria-expanded`, String(open));
  if (open && compact) {
    compact = false;
    styles();
    panel.dataset.restoreCompact = `true`;
  } else if (!open && panel.dataset.restoreCompact) {
    delete panel.dataset.restoreCompact;
    compact = config().compact;
    styles();
  }
}

function calendar(month = new Date()) {
  const year = month.getFullYear();
  const index = month.getMonth();
  const content = el('div');
  const header = el('div', 'calendar-head');
  const prev = button('', () => calendar(new Date(year, index - 1, 1)), 'plain', 'caret-right');
  const next = button('', () => calendar(new Date(year, index + 1, 1)), 'plain', 'caret-left');
  prev.setAttribute('aria-label', 'الشهر السابق');
  next.setAttribute('aria-label', 'الشهر التالي');
  header.append(prev, el('strong', '', new Intl.DateTimeFormat('ar-JO', { month: 'long', year: 'numeric' }).format(month)), next);
  const days = el('div', 'days');
  const start = state.prefs.weekStart;
  const labels = ['احد', 'اثن', 'ثلا', 'ارب', 'خمي', 'جمع', 'سبت'];
  for (let offset = 0; offset < 7; offset++) days.append(el('span', 'weekday', labels[(start + offset) % 7]));
  const offset = (new Date(year, index, 1).getDay() - start + 7) % 7;
  for (let i = 0; i < offset; i++) days.append(el('span'));
  const today = new Date();
  const end = new Date(year, index + 1, 0).getDate();
  const format = new Intl.NumberFormat('ar-JO');
  for (let day = 1; day <= end; day++) {
    const isToday = today.getDate() === day && today.getMonth() === index && today.getFullYear() === year;
    const cell = el('span', isToday ? 'today' : '', format.format(day));
    if (isToday) cell.setAttribute('aria-current', 'date');
    days.append(cell);
  }
  content.append(header, days, button('اليوم', () => calendar(), 'secondary'));
  $(`clock-calendar`).replaceChildren(content);
}

function animate(node, frames) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (state.prefs.theme === 'pebbly' && node.id === 'sheet') {
    node.animate([
      { opacity: .15, clipPath: 'inset(4% 25% 84% round 28px)' },
      { opacity: 1, clipPath: 'inset(0 0 0 round 24px)' }
    ], { duration: 330, easing: 'cubic-bezier(.18,.9,.28,1)' });
    return;
  }
  node.animate(frames, { duration: 210, easing: 'cubic-bezier(.2,.75,.2,1)' });
}

function reportGeometry() {
  const boxes = ['shell', 'tip', 'toast', 'edge-handle'].filter(id => !$(id).hidden && getComputedStyle($(id)).visibility !== 'hidden').map(id => {
    const { left, top, right, bottom } = $(id).getBoundingClientRect();
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(top));
    return { x, y, width: Math.min(innerWidth, Math.ceil(right)) - x, height: Math.min(innerHeight, Math.ceil(bottom)) - y };
  });
  api.geometry(boxes.filter(box => box.width > 0 && box.height > 0)).catch(() => {});
}

function wire() {
  const shell = $('shell');
  const grip = $(`dock-grip`);
  let dockPointer;
  grip.addEventListener(`pointerdown`, event => {
    if (event.button !== 0) return;
    dockPointer = { id: event.pointerId, x: event.screenX, y: event.screenY, started: false };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener(`pointermove`, event => {
    if (!dockPointer || dockPointer.started || dockPointer.id !== event.pointerId) return;
    if (Math.hypot(event.screenX - dockPointer.x, event.screenY - dockPointer.y) < 7) return;
    dockPointer.started = true;
    shell.classList.add(`dock-dragging`);
    api.dockDrag(`start`).catch(errorMessage);
  });
  function endDockDrag(commit) {
    if (!dockPointer) return;
    const { id, started } = dockPointer;
    dockPointer = undefined;
    if (grip.hasPointerCapture(id)) grip.releasePointerCapture(id);
    shell.classList.remove(`dock-dragging`);
    if (started) api.dockDrag(commit ? `drop` : `cancel`).catch(errorMessage);
  }
  grip.addEventListener(`pointerup`, () => endDockDrag(true));
  grip.addEventListener(`lostpointercapture`, () => endDockDrag(false));
  grip.addEventListener(`pointercancel`, () => endDockDrag(false));
  grip.addEventListener(`click`, event => { if (event.detail === 0) settings(); });
  let magnified = [];
  function resetMagnification() {
    for (const row of magnified) row.style.removeProperty('--dock-scale');
    magnified = [];
  }
  shell.addEventListener(`pointerover`, event => {
    if (event.pointerType === `touch` || matchMedia(`(prefers-reduced-motion: reduce)`).matches) return;
    const selector = `.shortcut-row, .app-option`;
    const row = event.target.closest(selector);
    if (row && row.contains(event.relatedTarget)) return;
    resetMagnification();
    if (!row) return;
    const list = row.closest(`.app-list, #entry-list`);
    if (!list) return;
    const rows = [...list.querySelectorAll(selector)];
    const active = rows.indexOf(row);
    magnified = rows.slice(Math.max(0, active - 2), active + 3);
    for (const neighbor of magnified) {
      const distance = Math.min(2, Math.abs(rows.indexOf(neighbor) - active));
      neighbor.style.setProperty(`--dock-scale`, [1.44, 1.20, 1.08][distance]);
    }
  });
  shell.addEventListener(`pointerleave`, resetMagnification);
  shell.addEventListener(`dragstart`, resetMagnification);
  const sizeObserver = new ResizeObserver(() => {
    const height = [...shell.children].filter(node => node.id !== 'sheet').reduce((total, node) => {
      const style = getComputedStyle(node);
      const content = node.id === 'entries' ? $('entry-list') : node;
      return total + content.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    }, 0);
    const style = getComputedStyle(shell);
    const preferred = Math.ceil(height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
    shell.style.setProperty('--content-height', `${preferred}px`);
  });
  for (const node of [shell.querySelector('.brand'), shell.querySelector('.search-wrap'), $('entry-list'), shell.querySelector('.footer')]) {
    sizeObserver.observe(node);
  }
  const observer = new ResizeObserver(reportGeometry);
  observer.observe($('shell'));
  $(`shell`).addEventListener(`transitionend`, reportGeometry);
  window.addEventListener(`resize`, reportGeometry);
  if (isPalette) {
    const exit = button('', () => api.hide(), `palette-close`, `x`);
    exit.title = `اخفاء لوحة البحث`;
    exit.setAttribute(`aria-label`, exit.title);
    const minimize = button('', () => api.minimizeToTray().catch(errorMessage), `palette-close`, `minus`);
    minimize.title = `تصغير بجانب ساعة ويندوز`;
    minimize.setAttribute(`aria-label`, minimize.title);
    $(`search`).after(minimize, exit);
    $(`search`).autofocus = true;
  }
  const handle = $(`edge-handle`);
  handle.addEventListener(`pointerenter`, () => {
    edgeTimer = setTimeout(() => setEdgeMode(`preview`), 110);
  });
  handle.addEventListener(`pointerleave`, () => {
    if (edgeMode === `fold`) clearTimeout(edgeTimer);
  });
  handle.addEventListener(`click`, () => setEdgeMode(`preview`));
  shell.addEventListener(`pointerenter`, () => clearTimeout(edgeTimer));
  shell.addEventListener(`pointerleave`, () => {
    if (edgeMode === `preview` && $(`sheet`).hidden && !dragged && !dockPointer) {
      edgeTimer = setTimeout(() => setEdgeMode(`fold`), 420);
    }
  });
  $(`tray-minimize`).addEventListener(`click`, () => setEdgeMode(edgeMode === `preview` ? `pin` : `fold`));
  $(`fold`).addEventListener('click', () => setCompact(!compact));
  $('spaces').addEventListener('click', spaces);
  $('space-name').addEventListener('click', spaces);
  $(`date`).addEventListener(`click`, () => toggleCalendar());
  $('add').addEventListener('click', addMenu);
  $('settings').addEventListener('click', settings);
  $(`search-icon`).addEventListener(`click`, () => {
    if (!isPalette && state.prefs.searchView === `palette`) api.showSearch().catch(errorMessage);
    else searchFocus();
  });
  $(`search`).addEventListener(`input`, () => {
    paletteIndex = 0;
    drawEntries();
  });
  $('search').addEventListener('keydown', event => {
    if (isPalette && [`ArrowUp`, `ArrowDown`].includes(event.key)) {
      event.preventDefault();
      selectPaletteResult(paletteIndex + (event.key === `ArrowUp` ? -1 : 1));
    }
    if (event.key === `Enter`) {
      event.preventDefault();
      $(`entries`).querySelector(isPalette ? `.shortcut-row.selected` : `button`)?.click();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (dockPointer) { endDockDrag(false); return; }
    if (!$(`clock-calendar`).hidden) toggleCalendar(false);
    else if (!$('sheet').hidden) closeSheet();
    else if (!isPalette && $('search').value) { $('search').value = ''; drawEntries(); }
    else if (edgeMode === `preview`) setEdgeMode(`fold`);
    else if (edgeMode === `pin`) api.hide();
  });
  const tip = $(`tip`);
  let tipTimer;
  let lastTip = -Infinity;
  function dismissTip() {
    clearTimeout(tipTimer);
    if (tip.hidden) return;
    tip.hidden = true;
    lastTip = performance.now();
    reportGeometry();
  }
  function queueTip(anchor) {
    if (!compact || !anchor || dragged) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (!anchor.isConnected || !compact) return;
      const rect = anchor.getBoundingClientRect();
      const left = config().side === `left`;
      const horizontal = config().side === `top`;
      const available = horizontal ? innerWidth - 16 : left ? innerWidth - rect.right : rect.left;
      if (available < 36) return;
      tip.textContent = anchor.dataset.tip;
      tip.hidden = false;
      tip.style.maxWidth = `${Math.min(180, available - 12)}px`;
      tip.style.left = `${horizontal ? Math.max(4, Math.min(innerWidth - tip.offsetWidth - 4, rect.left + (rect.width - tip.offsetWidth) / 2)) : left ? rect.right + 8 : rect.left - tip.offsetWidth - 8}px`;
      tip.style.top = `${Math.max(4, Math.min(innerHeight - tip.offsetHeight - 4, horizontal ? rect.bottom + 8 : rect.top + (rect.height - tip.offsetHeight) / 2))}px`;
      reportGeometry();
      animate(tip, [{ opacity: .2, translate: left ? `-4px 0` : `4px 0` }, { opacity: 1, translate: `0 0` }]);
    }, performance.now() - lastTip < 220 ? 30 : 320);
  }
  shell.addEventListener(`pointerover`, event => {
    const anchor = event.target.closest(`[data-tip]`);
    if (event.pointerType !== `touch` && anchor && !anchor.contains(event.relatedTarget)) queueTip(anchor);
  });
  shell.addEventListener(`pointerout`, event => {
    const anchor = event.target.closest(`[data-tip]`);
    if (anchor && !anchor.contains(event.relatedTarget)) dismissTip();
  });
  shell.addEventListener(`focusin`, event => {
    if (event.target.matches(`:focus-visible`)) queueTip(event.target.closest(`[data-tip]`));
  });
  shell.addEventListener(`focusout`, dismissTip);
  shell.addEventListener(`dragstart`, dismissTip);
  $(`entries`).addEventListener(`scroll`, dismissTip, { passive: true });
  $('shell').addEventListener('dragover', event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
  $('shell').addEventListener('drop', async event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    try { await addPaths(await api.paths([...event.dataTransfer.files].map(file => api.filePath(file)))); }
    catch (error) { errorMessage(error); }
  });
}

api.load().then(data => {
  ({ state, displays, version, updateStatus } = data);
  compact = !isPalette && config().compact;
  wire();
  draw();
  setInterval(clock, 1000);
  api.on('state', next => {
    const before = config().compact;
    state = next;
    if (!isPalette && !ignoreSettings && before !== config().compact) compact = config().compact;
    draw();
  });
  api.on('search-focus', searchFocus);
  api.on(`dock-landed`, () => {
    if (edgeMode !== `pin`) setEdgeMode(`pin`);
    const vertical = config().side === `top`;
    const offset = config().side === `left` ? -22 : 22;
    animate($(`shell`), [
      { opacity: .45, translate: vertical ? `0 -18px` : `${offset}px 0`, scale: .97 },
      { opacity: 1, translate: `0 0`, scale: 1 }
    ]);
  });
  api.on(`edge-open`, () => setEdgeMode(`preview`));
  api.on(`tray-motion`, ({ x, y, closing }) => {
    trayMotion?.cancel();
    if (matchMedia(`(prefers-reduced-motion: reduce)`).matches) return;
    const shell = $(`shell`);
    const rect = shell.getBoundingClientRect();
    const fromX = Math.max(8, Math.min(rect.width - 8, x - rect.left));
    const fromY = Math.max(8, Math.min(rect.height - 8, y - rect.top));
    const expanded = { clipPath: `inset(0 round 28px)`, opacity: 1 };
    const collapsed = {
      clipPath: `inset(${fromY - 8}px ${rect.width - fromX - 8}px ${rect.height - fromY - 8}px ${fromX - 8}px round 9px)`,
      opacity: .15
    };
    trayMotion = shell.animate(closing ? [expanded, collapsed] : [collapsed, expanded],
      { duration: closing ? 225 : 360, easing: `cubic-bezier(.22,.8,.22,1)`, fill: closing ? `forwards` : `none` });
  });
  api.on('update-status', message => {
    updateStatus = message;
    if ($('update-status')) $('update-status').textContent = message;
    if (message === 'التحديث جاهز للتثبيت') toast(message);
  });
}).catch(errorMessage);
