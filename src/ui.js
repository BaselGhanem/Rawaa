'use strict';

const api = window.rawaa;
const $ = id => document.getElementById(id);
const kinds = { app: 'تطبيق او اختصار', file: 'ملف', folder: 'مجلد', url: 'رابط', bundle: 'زر تشغيل مجموعة' };
const kindIcons = { app: 'app-window', file: 'file', folder: 'folder', url: 'link', bundle: 'rocket-launch' };
const iconOptions = ['app-window', 'file', 'folder', 'link', 'rocket-launch', 'chart-bar', 'table', 'game-controller', 'globe', 'book-open', 'briefcase', 'graduation-cap', 'star', 'image', 'music-note', 'envelope', 'code', 'video-camera'];
const displayId = new URLSearchParams(location.search).get('display');
const uid = () => crypto.randomUUID();
const selectSpace = () => state.spaces.filter(space => space.id === state.active)[0];
const visibleItems = () => state.items.filter(item => item.shared || item.space === state.active);
let state;
let displays;
let compact;

let dragged;
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

function toast(message) {
  if (!message) return;
  const node = $('toast');
  clearTimeout(toastTimeout);
  node.textContent = message;
  node.hidden = false;
  reportGeometry();
  toastTimeout = setTimeout(() => { node.hidden = true; reportGeometry(); }, 3500);
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
  if ((state.prefs.icons !== 'native' && item.kind !== 'app') || item.icon || !['app', 'file', 'folder'].includes(item.kind)) return;
  const key = `${item.id}|${item.target}`;
  if (!nativeIcons.has(key)) {
    if (nativeIcons.size > 250) nativeIcons.clear();
    nativeIcons.set(key, api.icon(item.id).catch(() => ''));
  }
  nativeIcons.get(key).then(source => {
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
  try { toast(await api.launch(item.id)); }
  catch (error) { errorMessage(error); }
  finally { setTimeout(() => node?.classList.remove('launching'), Math.max(0, 420 - (performance.now() - started))); }
}

function makeItem(item) {
  const node = row(item.name, iconOptions.includes(item.icon) ? item.icon : kindIcons[item.kind], () => run(item, node));
  node.classList.add('shortcut-row');
  nativeIcon(item, node);
  node.draggable = true;
  node.addEventListener('dragstart', event => {
    dragged = item.id;
    event.dataTransfer.setData('text/plain', item.id);
    event.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => { dragged = null; });
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
  node.addEventListener('dragleave', () => node.classList.remove('target'));
  node.addEventListener('drop', event => {
    if (!dragged || dragged === before) return;
    event.preventDefault();
    event.stopPropagation();
    node.classList.remove('target');
    const moving = dragged;
    dragged = null;
    change(next => {
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
  });
}

function drawEntries() {
  const entries = $('entries');
  const scroll = entries.scrollTop;
  const list = $('entry-list');
  list.replaceChildren();
  const q = $('search').value.trim().toLocaleLowerCase();
  const items = visibleItems();
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

function closeSheet() {
  const sheet = $('sheet');
  sheet.hidden = true;
  $('shell').classList.remove('sheet-open');
}

function showSheet(title, content) {
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
  compact = value;
  closeSheet();
  $('search').value = '';
  draw();
  if (state.prefs.theme === 'pebbly') {
    animate($('fold'), [{ rotate: '-18deg' }, { rotate: '8deg', offset: .7 }, { rotate: '0deg' }]);
  }
  change(next => { next.displays[displayId] = { ...config(), compact }; });
}

function searchFocus() {
  if (compact) { compact = false; styles(); }
  closeSheet();
  $('search').focus();
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
  box.append(el('div', 'section', 'التطبيقات المفتوحة'), search, listing, actions);
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
        if (saved) { render(); toast('تمت اضافة التطبيق'); }
        else line.disabled = false;
      });
      line.classList.add('app-option');
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
  listing.append(el('p', 'empty loading-apps', 'جاري قراءة التطبيقات المفتوحة'));
  search.disabled = true;
  try {
    apps = await api.openApps();
    search.disabled = false;
    search.addEventListener('input', render);
    render();
  } catch {
    listing.replaceChildren(el('p', 'empty', 'تعذر قراءة التطبيقات المفتوحة'), button('اعادة المحاولة', addMenu));
  }
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
  for (const [key, label] of [['blur', 'كثافة الزجاج الافتراضية'], ['compactLabels', 'اظهار عناوين الاقسام بالمصغر'], ['hideFullscreen', 'اخفاء وقت ملء الشاشة'], ['hour12', 'الساعة بنظام 12 ساعة']]) {
    const control = checkbox(label, state.prefs[key]);
    controls[key] = control.item;
    const section = key === 'hour12' ? sections.controls : key === 'hideFullscreen' ? sections.display : sections.look;
    section.append(control.label);
  }
  const monitorControls = displays.map(display => {
    const settings = state.displays[display.id] || display.config;
    const block = el('fieldset');
    const mode = choice([['fixed', 'ثابت'], ['edge', 'يظهر عند الحافة'], ['off', 'مخفي']], settings.mode);
    const side = choice([['right', 'يمين'], ['left', 'يسار']], settings.side);
    const compactMode = checkbox('الوضع المصغر', settings.compact);
    block.append(el('legend', '', display.name), field('الظهور', mode), field('جهة الشريط', side), compactMode.label);
    sections.display.append(block);
    return { id: display.id, mode, side, compact: compactMode.item };
  });
  const actions = ['export', 'import'].map((action, index) => button(index ? 'استيراد الاعدادات' : 'تصدير الاعدادات', async () => {
    try {
      if (await api.backup(action)) {
        if (action === 'import') { compact = config().compact; draw(); closeSheet(); }
        toast(index ? 'تم الاستيراد' : 'تم التصدير');
      }
    } catch (error) { errorMessage(error); }
  }));
  actions.push(button('التحديثات', async () => {
    try { toast(await api.updates()); } catch (error) { errorMessage(error); }
  }), button('اخفاء الشريط', () => { closeSheet(); api.hide(); }));
  const updateLine = el('small', '', updateStatus || `Rawaa ${version}`);
  updateLine.id = 'update-status';
  updateLine.setAttribute('role', 'status');
  const systemActions = el('div', 'actions');
  systemActions.append(...actions.slice(2), ...actions.slice(0, 2));
  sections.system.append(el('strong', '', `رواء ${version}`), updateLine, systemActions);
  form.append(formActions('حفظ الاعدادات'));
  form.addEventListener('submit', async event => {
    event.preventDefault();
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
    if (success) { compact = config().compact; draw(); closeSheet(); }
  });
  showSheet('الاعدادات', form);
  $('sheet').classList.add('settings-sheet');
}

function clock() {
  const now = new Date();
  const time = new Intl.DateTimeFormat('ar-JO', { hour: '2-digit', minute: '2-digit', hour12: state.prefs.hour12 }).format(now);
  $('time').textContent = time;
  $('date-label').textContent = new Intl.DateTimeFormat('ar-JO', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  $('date').dataset.tip = `${time} · التقويم`;
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
  showSheet('التقويم', content);
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
  const boxes = ['shell', 'fold', 'tip', 'toast'].filter(id => !$(id).hidden && getComputedStyle($(id)).visibility !== 'hidden').map(id => {
    const { left, top, right, bottom } = $(id).getBoundingClientRect();
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(top));
    return { x, y, width: Math.min(innerWidth, Math.ceil(right)) - x, height: Math.min(innerHeight, Math.ceil(bottom)) - y };
  });
  api.geometry(boxes).catch(() => {});
}

function wire() {
  const shell = $('shell');
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
  $('shell').addEventListener('transitionend', reportGeometry);
  $('fold').addEventListener('click', () => setCompact(!compact));
  $('spaces').addEventListener('click', spaces);
  $('space-name').addEventListener('click', spaces);
  $('date').addEventListener('click', () => calendar());
  $('add').addEventListener('click', addMenu);
  $('settings').addEventListener('click', settings);
  $('search-icon').addEventListener('click', searchFocus);
  $('search').addEventListener('input', drawEntries);
  $('search').addEventListener('keydown', event => {
    if (event.key === 'Enter') $('entries').querySelector('button')?.click();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!$('sheet').hidden) closeSheet();
    else if ($('search').value) { $('search').value = ''; drawEntries(); }
    else api.hide();
  });
  document.addEventListener('pointerover', event => {
    const anchor = event.target.closest('[data-tip]');
    if (!compact || !anchor || anchor.contains(event.relatedTarget)) return;
    const tip = $('tip');
    const rect = anchor.getBoundingClientRect();
    tip.textContent = anchor.dataset.tip;
    tip.hidden = false;

    const available = config().side === 'left' ? innerWidth - rect.right : rect.left;
    tip.style.maxWidth = `${Math.min(150, available - 10)}px`;
    tip.style.left = `${config().side === 'left' ? rect.right + 10 : rect.left - tip.offsetWidth - 10}px`;
    tip.style.top = `${rect.top + (rect.height - tip.offsetHeight) / 2}px`;
    reportGeometry();
    animate(tip, [{ opacity: 0 }, { opacity: 1 }]);
  });
  document.addEventListener('pointerout', event => {
    const anchor = event.target.closest('[data-tip]');
    if (anchor && !anchor.contains(event.relatedTarget)) {
      $('tip').hidden = true;
      reportGeometry();
    }
  });
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
  compact = config().compact;
  wire();
  draw();
  setInterval(clock, 1000);
  api.on('state', next => {
    const before = config().compact;
    state = next;
    if (!ignoreSettings && before !== config().compact) compact = config().compact;
    draw();
  });
  api.on('search-focus', searchFocus);
  api.on('update-status', message => {
    updateStatus = message;
    if ($('update-status')) $('update-status').textContent = message;
    if (message === 'التحديث جاهز للتثبيت') toast(message);
  });
}).catch(errorMessage);
