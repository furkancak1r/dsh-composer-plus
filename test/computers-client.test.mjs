// Remote computers, the client half (real client.js, a fake Host, a fake DOM and a fake desktop bridge): the feature is
// off by default and adds nothing then; switched on, the picker sits in dsh's sidebar brand row (right of the brand, above
// New session), never in the chat header; a picked computer fills this window (a desktop webview with its own lease, or
// an iframe on dsh web) and never opens a browser window; this Mac's page stays and a hidden computer keeps its page. One
// switch at a time from every entry point (the menu, the other Mac's page). The add dialog asks for a name that This Mac
// and the other computers do not have. The other Mac's page (`via`) shows the same picker from its relay. Switched off,
// every view, lease, host, timer and the event loop go.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// ---- A small fake DOM: enough for the brand row host and the views. ----
class El {
  constructor(tag, attrs = {}) { this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.style = {}; this.listeners = {}; this.focused = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; }
  addEventListener(n, f) { (this.listeners[n] ??= []).push(f); } fire(n, e = {}) { for (const f of this.listeners[n] ?? []) f(e); }
  appendChild(c) { c.remove(); c.parentElement = this; this.children.push(c); return c; }
  after(c) { c.remove(); const p = this.parentElement; c.parentElement = p; p.children.splice(p.children.indexOf(this) + 1, 0, c); }
  remove() { const p = this.parentElement; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  get previousElementSibling() { const p = this.parentElement; return p ? p.children[p.children.indexOf(this) - 1] ?? null : null; }
  get isConnected() { let e = this; while (e.parentElement) e = e.parentElement; return e === body; }
  focus() { this.focused++; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  matches(sel) {
    const m = /^\[([\w-]+)(\*=")?([^"\]]*)"?\]$/.exec(sel); if (!m) return false;
    return m[2] ? String(this.attrs[m[1]] ?? '').includes(m[3]) : m[1] in this.attrs;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) { const scope = sel.startsWith(':scope > '); const s = scope ? sel.slice(9) : sel; return (scope ? this.children : this.all()).filter((e) => e.matches(s)); }
}
const body = new El('body');
let observerFns = [];
globalThis.MutationObserver = class { constructor(f) { this.f = f; } observe() { observerFns.push(this.f); } disconnect() { observerFns = observerFns.filter((f) => f !== this.f); } };
globalThis.document = { body, visibilityState: 'visible', createElement: (t) => new El(t), querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s), addEventListener() {}, removeEventListener() {} };
// dsh's sidebar: the brand row with the brand and the toggle (desktop has the toggle in a strip above it).
const row = body.appendChild(new El('div', { class: 'hHd-Xa_logoRow', 'data-window-drag': '' }));
const brand = row.appendChild(new El('span', { class: 'hHd-Xa_brand hHd-Xa_wide' }));
const toggle = row.appendChild(new El('button', { class: 'hHd-Xa_iconButton hHd-Xa_toggle' }));

// ---- Fake timers (the hello wait). ----
let timers = new Map(); let timerId = 0;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, ms) => { if (ms >= 1000) { const id = ++timerId; timers.set(id, f); return id; } return realSetTimeout(f, ms); };
const realClearTimeout = globalThis.clearTimeout;
globalThis.clearTimeout = (id) => { if (timers.has(id)) timers.delete(id); else realClearTimeout(id); };
const runTimers = () => { const all = [...timers.values()]; timers = new Map(); for (const f of all) f(); };

// ---- Fake Host ----
const ID = 'f'.repeat(64); const ID2 = 'e'.repeat(64);
const studio = { id: ID, name: 'Studio', mac: 'Studio Mac', label: 'Studio', host: '100.90.0.7', port: 19392, state: 'ok', duplicate: false };
let view = { on: false, self: { name: 'Office Mac' }, computers: [], adding: null, accept: { on: false, running: false, code: null, pending: [], devices: [], last: null }, via: false, available: true };
const posts = []; let gate = null; let refuse = null; let switchOn = false; let opens = 0;
let events = []; let eventSeq = 0; let eventWait = null;
const pushEvent = (e) => { events.push({ seq: ++eventSeq, ...e }); eventWait?.resolve(); };
let opener = { status: 404 };
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('/__composer-plus/')) {
    posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return opener.status === 200 ? Response.json(String(url).endsWith('opener') ? opener.body : { ok: true }) : new Response('{}', { status: opener.status });
  }
  if (String(url) !== '/api/composer-plus.computers') return new Response('{}', { status: 404 });
  if (init?.method !== 'POST') return Response.json({ ...view, on: switchOn });
  const body = JSON.parse(init.body);
  if (body.action === 'events') {
    if (body.after === undefined) return Response.json({ seq: eventSeq, events: [] });
    for (;;) {
      const newer = events.filter((e) => e.seq > body.after);
      if (newer.length > 0) return Response.json({ seq: eventSeq, events: newer });
      eventWait = deferred();
      await Promise.race([eventWait.promise, new Promise((_, bad) => init.signal?.addEventListener('abort', () => bad(new Error('aborted'))))]);
    }
  }
  posts.push(body);
  if (gate) await gate.promise;
  if (refuse) { const r = refuse; refuse = null; return Response.json({ error: r }, { status: 409 }); }
  if (Object.hasOwn(body, 'on')) { switchOn = body.on; return Response.json({ ...view, on: switchOn }); }
  if (body.action === 'add') { view = { ...view, computers: [{ ...studio, name: body.name, label: body.name }] }; return Response.json({ ...view, on: switchOn, added: ID }); }
  if (body.action === 'open') { opens++; return Response.json({ url: `http://127.0.0.1:5555/?cp-ticket=t${opens}` }); }
  return Response.json({ ...view, on: switchOn });
};
// ---- The desktop bridge of dsh (`dshDesktop.browser`). ----
const leases = []; const released = [];
globalThis.dshDesktop = { browser: {
  acquire: async (key) => { const lease = `L${leases.length + 1}`; leases.push({ key, lease }); return { lease, partition: `p-${key}` }; },
  release: async (lease) => { released.push(lease); },
  onOpenRequested: () => () => {},
} };
const windows = []; globalThis.open = (u) => { windows.push(u); return null; };

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
// React with state and layout effects (for the host of the picker).
let hookState = []; let hi = 0; let layouts = [];
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
  useState: (v) => { const i = hi++; if (!(i in hookState)) hookState[i] = typeof v === 'function' ? v() : v; return [hookState[i], (x) => { hookState[i] = typeof x === 'function' ? x(hookState[i]) : x; }]; },
  useRef: (v) => ({ current: v }), useEffect: () => {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: (f) => { layouts.push(f); } };
const primitives = { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Modal: 'Modal', Button: 'Button', IconChevronDownOutlineRegular: 'Chevron', StateDot: 'StateDot' };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) } : n === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : {}));
const live = new Map(); let next = 0;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: (ns) => (k) => k, resolveText: (x) => x },
  inject: () => ({ dispose() {} }),
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
const overlay = (id) => [...live.values()].find(([o]) => o.name === 'shell.overlay' && o.id === id);
const settings = [...live.values()].find(([o]) => o.id === 'composer-plus')[0].inject();
const t = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k);
await tick();

// Off by default: no picker, no views, no dialog, nothing in the chat header.
assert.equal(overlay('computer-picker'), undefined, 'off by default: no picker');
assert.equal(overlay('add-computer-dialog'), undefined, 'off by default: no dialog');
// Also when the Host gives no switch (an older Host half answers 404): the feature stays off.
{
  let m2; const w = globalThis.window; globalThis.window = { __ModuleLoader__: { load: (m) => { m2 = m; } }, addEventListener() {}, removeEventListener() {} };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8')); globalThis.window = w;
  const f = globalThis.fetch; globalThis.fetch = async () => new Response('{}', { status: 404 });
  const p2 = m2.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : {}));
  const live2 = []; p2.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k, resolveText: (x) => x }, inject: () => ({ dispose() {} }),
    slots: { inject: (n, fn) => fn(), register: (o) => { live2.push(o); return () => {}; } } });
  await tick(); globalThis.fetch = f;
  assert.equal(live2.some((o) => o.id === 'computer-picker'), false, 'no Host switch: still off');
}

// Switch on (the Host switch): the picker and the dialog come; the chat header gets nothing.
await settings.setFeature('remoteComputers', true);
await tick();
assert.deepEqual(posts.at(-1), { on: true });
const pickerEntry = overlay('computer-picker');
assert.ok(pickerEntry && overlay('add-computer-dialog'));
assert.equal(overlay('computer-views-bar'), undefined, 'no banner over the other Mac');
assert.equal([...live.values()].some(([o]) => o.name === 'conversation.header.leading'), false, 'not in the chat header any more');
const { computers, views, opener: openerStore } = pickerEntry[0].inject();
assert.equal(computers, settings.computers, 'one store for the picker and Settings');

// The host: its own row right after the brand row (above New session), so two names fit; the brand row keeps only dsh's
// brand and toggle. Not a drag area. The rail (no brand) has none.
const mount = () => { hi = 0; layouts = []; const out = pickerEntry[1]({ ...pickerEntry[0].inject(), t }); const fx = layouts.map((f) => f()); hi = 0; layouts = []; return { out: pickerEntry[1]({ ...pickerEntry[0].inject(), t }), cleanup: () => fx.forEach((f) => f?.()) }; };
const afterRow = (r) => body.children[body.children.indexOf(r) + 1];
let { out, cleanup } = mount();
const host = afterRow(row);
assert.equal(host.hasAttribute('data-composer-plus-computer-host'), true, 'the host follows the brand row');
assert.deepEqual(row.children, [brand, toggle], 'nothing of ours in the brand row');
assert.match(host.style.cssText, /-webkit-app-region:no-drag/); assert.equal(host.hasAttribute('data-window-drag-recall'), true);
assert.equal(out.host, host, 'the picker is portaled into the host');
// dsh draws a new brand row: the observer moves the host after it, and keeps one host.
const row2 = new El('div', { class: 'hHd-Xa_logoRow' }); row2.appendChild(brand); row.remove(); body.appendChild(row2);
observerFns.forEach((f) => f());
assert.equal(afterRow(row2)?.hasAttribute('data-composer-plus-computer-host'), true, 'after the new row');
assert.equal(body.querySelectorAll('[data-composer-plus-computer-host]').length, 1);
// The rail: no brand → no host.
brand.remove(); observerFns.forEach((f) => f());
assert.equal(body.querySelectorAll('[data-composer-plus-computer-host]').length, 0, 'no picker in the rail');
row2.remove(); body.children.unshift(row); row.parentElement = body; row.children.unshift(brand); brand.parentElement = row; observerFns.forEach((f) => f());
assert.equal(afterRow(row).hasAttribute('data-composer-plus-computer-host'), true);
cleanup();
assert.equal(body.querySelectorAll('[data-composer-plus-computer-host]').length, 0, 'unmount removes the host');
assert.equal(observerFns.length, 0, 'and the observer');

// The picker: This Mac, the computers, Add a computer…; the button is no drag area.
// The portal holds <ComputerPicker>; call its component.
const renderPicker = () => { const { out: o } = mount(); const el = o?.portal; return el === undefined ? null : el.t(el.p); };
await computers.refresh();
let tree = renderPicker(); let menu = tree.c[0];
assert.equal(menu.t, 'Menu');
assert.deepEqual(menu.p.items.map((i) => i.id), ['self', 'sep', 'add'], 'no computers yet');
assert.equal(menu.p.anchor.p.style.WebkitAppRegion, 'no-drag');
assert.equal(menu.p.items[0].label, 'computers.thisMac:{"name":"Office Mac"}');

// Add: a name is needed; This Mac's name (any case) and another computer's name are refused before anything is sent.
const addComputer = settings.addComputer;
const link = 'dsh-computer://pair?v=1&host=100.90.0.7&port=19392&fp=' + 'f'.repeat(64) + '&code=c&mac=Office%20Mac';
addComputer.open(); addComputer.setLink(`  ${link}  `);
assert.equal(addComputer.getSnapshot().name, 'Office Mac', 'the name follows the link until the user types one');
let before = posts.length;
await addComputer.submit(computers);
assert.equal(posts.length, before, 'This Mac has that name: nothing is sent');
{ const d = overlay('add-computer-dialog'); const el = d[1]({ ...d[0].inject(), t });
  const s = JSON.stringify(el); assert.ok(s.includes('computers.error.name-taken'), 'the dialog says why'); assert.ok(s.includes('"disabled":true'), 'Connect is off'); }
addComputer.setName('  '); await addComputer.submit(computers); assert.equal(posts.length, before, 'an empty name: nothing is sent');
addComputer.setName('Studio'); addComputer.setLink(link);
assert.equal(addComputer.getSnapshot().name, 'Studio', 'a typed name stays when the link changes');
gate = deferred();
const first = addComputer.submit(computers);
await tick();
assert.equal(addComputer.getSnapshot().waiting, true);
{ const d = overlay('add-computer-dialog'); const el = d[1]({ ...d[0].inject(), t });
  assert.ok(JSON.stringify(el).includes('computers.waiting:{\\"name\\":\\"Studio\\"}'), 'the waiting text has the name'); }
before = posts.length;
await addComputer.submit(computers); await computers.add('again', 'X');
assert.equal(posts.length, before, 'one pairing at a time from the dialog and the store');
assert.deepEqual(posts.at(-1), { action: 'add', link, name: 'Studio' }, 'link and name are trimmed');
gate.resolve(); gate = null; await first;
assert.equal(addComputer.getSnapshot().open, false, 'the dialog closes after Approve');
assert.equal(JSON.stringify(computers.getSnapshot()).includes('token'), false);
// A second computer may not take "studio".
addComputer.open(); addComputer.setLink(link.replace('Office%20Mac', 'Other')); addComputer.setName('STUDIO ');
before = posts.length; await addComputer.submit(computers); assert.equal(posts.length, before, 'another computer has that name');
// The Host's refusal (a race) shows too.
addComputer.setName('Garage'); refuse = 'name-taken'; await addComputer.submit(computers);
assert.equal(addComputer.getSnapshot().error, 'name-taken');
addComputer.close(computers);

// Pick Studio: a desktop webview with its own lease fills the window; no browser window; this Mac's page stays.
// dsh's macOS desktop app marks only its own page (`data-platform`, its preload); the webview gets the mark below.
globalThis.document.documentElement = { dataset: { platform: 'darwin' } };
tree = renderPicker(); menu = tree.c[0];
assert.deepEqual(menu.p.items.map((i) => i.id), ['self', ID, 'sep', 'add']);
await menu.p.onSelect(ID); await tick();
assert.deepEqual(windows, [], 'never a browser window');
assert.deepEqual(leases, [{ key: `composer-plus-computer:${ID}`, lease: 'L1' }]);
const root = body.querySelector('[data-composer-plus-computer-views]');
assert.ok(root, 'the views root'); assert.equal(root.style.visibility, 'visible');
const wv = root.querySelector(`[data-composer-plus-computer-view]`);
assert.equal(wv.tag, 'webview'); assert.equal(wv.getAttribute('partition'), `p-composer-plus-computer:${ID}`); assert.equal(wv.getAttribute('src'), 'about:blank#L1');
assert.equal(wv.hasAttribute('allowpopups'), true, 'a link of the page that opens a window goes to the system browser');
assert.equal(root.querySelector('[data-window-drag]') !== null, true, 'a drag strip over the page');
// The relay's "does not answer" page gets dsh's UI language with the open (the texts of the locale pack).
assert.deepEqual(posts.find((p) => p.action === 'open').texts, { unreachable: 'computers.relay.unreachable', unreachableHint: 'computers.relay.unreachableHint', retry: 'computers.relay.retry' });
// While the page loads, a spinner with "Connecting to Studio…" fills the window (no empty page); it goes when the
// document is ready, and comes again when a new document starts (Try again on the relay's page).
const loadingOverlay = overlay('computer-loading');
const spinnerOf = () => { const [o, C] = loadingOverlay; const el = C({ ...o.inject(), t }); return el === null ? null : el.portal; };
{ assert.equal(views.getSnapshot().loading, true, 'the page loads');
  const s = spinnerOf(); assert.ok(s, 'the spinner shows');
  assert.equal(s.p.role, 'status'); assert.equal(s.c[1].c[0], 'computers.connecting:{"name":"Studio"}');
  assert.deepEqual(s.c[0].p, { state: 'ongoing', size: 28 }, 'dsh\'s own spinner');
  const cover = root.querySelector('[data-composer-plus-computer-cover]'); assert.ok(cover, 'its host in the root');
  assert.match(cover.style.cssText, /pointer-events:none/, 'the picker float and the window drag stay usable'); }
// macOS desktop: the other Mac's page fills the whole window (no empty title bar band above it) and draws dsh's own title
// bar row; the drag strip keeps only the traffic-light corner, so it covers no control of that page.
assert.match(wv.style.cssText, /top:0;height:100%/, 'the page starts at the top of the window');
assert.doesNotMatch(wv.style.cssText, /frame-top-clearance/);
assert.match(root.querySelector('[data-window-drag]').style.cssText, /left:0;top:0;width:88px;height:var\(--dsh-frame-top-clearance/);
// The relay URL loads only after the lease is attached (dom-ready), once; each later document gets the platform mark.
const loaded = []; wv.loadURL = async (u) => { loaded.push(u); };
const marks = []; wv.executeJavaScript = async (code) => { marks.push(code); };
wv.fire('dom-ready'); assert.deepEqual(marks, [], 'not in about:blank');
wv.fire('did-stop-loading');
assert.equal(views.getSnapshot().loading, true, 'about:blank is not the page: the spinner stays');
wv.fire('dom-ready');
assert.deepEqual(loaded, ['http://127.0.0.1:5555/?cp-ticket=t1']);
assert.equal(marks.length, 1, 'the page gets the mark once per document');
assert.equal(views.getSnapshot().loading, false, 'the document is ready: the spinner goes');
wv.fire('did-start-navigation', { isMainFrame: true, url: 'http://127.0.0.1:5555/' });
assert.equal(views.getSnapshot().loading, true, 'Try again (a new document): the spinner again');
wv.fire('did-stop-loading'); assert.equal(views.getSnapshot().loading, false, 'a navigation that failed or was cancelled (a download link) ends it');
wv.fire('did-start-navigation', { isMainFrame: true, url: 'http://127.0.0.1:5555/' }); wv.fire('dom-ready');
assert.equal(views.getSnapshot().loading, false); marks.length = 1;
// The mark comes after dsh's page mounted (its brand row), never at start: dsh's shortcuts would ask for a desktop bridge.
{ const page = { el: null }; const docEl = { dataset: {} }; let poll;
  const fakeDoc = { documentElement: docEl, querySelector: (s) => (s === '[class*="_logoRow"]' ? page.el : null) };
  new Function('document', 'setInterval', 'clearInterval', 'Date', marks[0])(fakeDoc, (f) => { poll = f; return 1; }, () => { poll = null; }, Date);
  poll(); assert.equal(docEl.dataset.platform, undefined, 'not before dsh\'s page mounted');
  page.el = {}; poll(); assert.equal(docEl.dataset.platform, 'darwin', 'then marked as dsh\'s macOS window'); assert.equal(poll, null, 'and the poll stops'); }
assert.equal(wv.style.visibility, 'visible'); assert.equal(wv.focused, 1, 'the page gets the focus');
assert.equal(views.getSnapshot().current, ID);
// Studio's page did not say hello yet (it has no picker of its own): this Mac's picker floats over it, in the same place.
// Two places (This Mac and Studio): two parts that name them, Studio (on screen) pressed; no menu, no arrow.
const floating = () => mount().out?.host?.hasAttribute('data-composer-plus-computer-float') === true;
assert.equal(views.getSnapshot().noPicker, true); assert.equal(floating(), true, 'the picker floats over the page');
assert.equal(mount().out.portal.p.floating, true, 'it knows that it floats (no sidebar margins)');
const partsOf = (a) => a.c.map((p) => ({ id: p.p['data-composer-plus-computer-part'], label: p.c[1].c[0], pressed: p.p['aria-pressed'] }));
let btn = renderPicker().c[0].p.anchor;
assert.equal(btn.p.role, 'group', 'two places: two parts'); assert.equal(btn.p['aria-haspopup'], undefined, 'no menu');
assert.equal(btn.p['data-composer-plus-computer-picker'], '');
assert.deepEqual(partsOf(btn), [{ id: 'self', label: 'computers.thisMacShort', pressed: false }, { id: ID, label: 'Studio', pressed: true }], 'This Mac | Studio, Studio on screen');
assert.equal(btn.c[1].p.title, 'computers.picker:{"name":"Studio"}', 'the pressed part names the computer on screen');
assert.equal(btn.c[0].p.title, 'computers.switchTo:{"name":"computers.thisMacShort"}', 'the other part says where its click goes');
btn.c[1].p.onClick(); await tick();
assert.equal(views.getSnapshot().current, ID, 'a click on the part on screen does nothing');
assert.equal(body.querySelector('[data-composer-plus-computer-back]'), null, 'no banner');
// The other Mac's page says hello (it shows the same picker itself): the float goes. A new document must say hello again.
await tick();
wv.fire('did-start-navigation', { isMainFrame: true, url: 'http://127.0.0.1:5555/' });
pushEvent({ hello: true, from: ID }); await tick();
runTimers(); assert.equal(views.getSnapshot().noPicker, false, 'hello came'); assert.equal(floating(), false, 'its own picker shows: none over it');
wv.fire('did-start-navigation', { isMainFrame: true, url: 'http://127.0.0.1:5555/' });
assert.equal(views.getSnapshot().noPicker, true, 'a new document: the picker floats again at once'); assert.equal(floating(), true);
runTimers(); await tick();
assert.equal(views.getSnapshot().noPicker, true, 'no hello in time: it stays');
pushEvent({ hello: true, from: ID }); await tick();
assert.equal(views.getSnapshot().noPicker, false, 'a late hello hides it');

// This Mac, with one click on its part (no menu): the page hides and stays (no reload, lease kept); Studio again shows it.
renderPicker().c[0].p.anchor.c[0].p.onClick(); await tick();
assert.equal(views.getSnapshot().current, 'self', 'the click came back');
assert.equal(renderPicker().c[0].p.open, false, 'no menu opened');
btn = renderPicker().c[0].p.anchor;
// On this Mac with one other computer: the same two parts, This Mac pressed; a right-click opens the whole menu.
assert.deepEqual(partsOf(btn), [{ id: 'self', label: 'computers.thisMacShort', pressed: true }, { id: ID, label: 'Studio', pressed: false }], 'This Mac on screen');
assert.equal(btn.c[1].p.title, 'computers.switchTo:{"name":"Studio"}', 'the title names where the click goes');
assert.equal(root.style.visibility, 'hidden'); assert.equal(wv.style.visibility, 'hidden'); assert.equal(wv.isConnected, true); assert.deepEqual(released, []);
{ let prevented = 0; btn.p.onContextMenu({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, 'no browser menu'); menu = renderPicker().c[0]; assert.equal(menu.p.open, true, 'the right-click opens the menu');
  assert.deepEqual(menu.p.items.map((i) => i.id), ['self', ID, 'sep', 'add'], 'Add a computer… stays one right-click away'); menu.p.onClose(); }
renderPicker().c[0].p.anchor.c[1].p.onClick(); await tick();
assert.equal(views.getSnapshot().current, ID, 'one click: Studio');
assert.equal(renderPicker().c[0].p.open, false, 'no menu opened');
assert.equal(opens, 1, 'no new ticket'); assert.equal(loaded.length, 1, 'no reload'); assert.equal(root.style.visibility, 'visible');

// Right-click in the other Mac's page: dsh's desktop app shows its edit menu only for its own page (its main window's
// `context-menu` handler); the webview's right-click comes as the webview's own `context-menu` event. The page gets the
// same items as dsh's own page, at the pointer, and an item runs the command in the page. The real Electron 44 path is
// checked by hand: test/electron-computer-menu.cjs.
{
  const editEntry = overlay('computer-edit-menu'); assert.ok(editEntry, 'the menu slot is there while the feature is on');
  // dsh's Menu under <body> (dsh 0.2.2-rc.2 places it at anchorPoint with position: fixed).
  const editMenu = () => { const r = editEntry[1]({ ...editEntry[0].inject(), t }); assert.equal(r.host, document.body, 'under <body>'); assert.equal(r.portal.p.style.position, 'fixed', 'in a fixed box'); return r.portal.c[0]; };
  assert.equal(editMenu().p.open, false, 'closed until a right-click');
  // The webview sits under a title bar space: Electron's x/y are in this window already and need no offset.
  wv.getBoundingClientRect = () => ({ left: 100, top: 48 });
  const calls = []; for (const c of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'delete', 'stop']) wv[c] = () => { calls.push(c); };
  const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
  wv.fire('context-menu', { params: { x: 40, y: 30, isEditable: true, selectionText: 'world', editFlags: flags } });
  let m = editMenu();
  assert.equal(m.t, 'Menu'); assert.equal(m.p.open, true, 'a right-click in a text field opens the menu');
  assert.deepEqual(m.p.items.map((i) => (i.type === 'separator' ? '-' : `${i.label}${i.disabled ? ' (off)' : ''}`)),
    ['computers.edit.undo', 'computers.edit.redo (off)', '-', 'computers.edit.cut', 'computers.edit.copy', 'computers.edit.paste', '-', 'computers.edit.selectAll'],
    'the items of dsh\'s own page, in its order, off as the page says');
  // Electron gives the pointer in this window's coordinates already (real Electron 44: test/electron-computer-menu.cjs).
  assert.deepEqual(m.p.getAnchorRect(), { left: 40, right: 40, top: 30, bottom: 30 }, 'at the pointer');
  assert.deepEqual(m.p.anchorPoint, { x: 40, y: 30 }, 'dsh 0.2.2-rc.2: at the pointer (anchorPoint)');
  const focusBefore = wv.focused;
  m.p.onSelect('paste');
  assert.deepEqual(calls, ['paste'], 'Paste runs in the page'); assert.ok(wv.focused > focusBefore, 'the page gets the focus back first');
  assert.equal(editMenu().p.open, false, 'the menu closes');
  // Selected text outside a field: Copy only. Nothing selected, or no field: no menu (as on dsh's own page).
  wv.fire('context-menu', { params: { x: 5, y: 5, isEditable: false, selectionText: 'Studio', editFlags: { canCopy: true } } });
  assert.deepEqual(editMenu().p.items.map((i) => [i.id, i.disabled]), [['copy', false]]);
  editMenu().p.onClose(); assert.equal(editMenu().p.open, false, 'Esc or a click outside closes it');
  // A click in the other Mac's page (the webview gets the focus) closes it; a late focus of the same right-click does not.
  wv.fire('context-menu', { params: { x: 5, y: 5, isEditable: false, selectionText: 'Studio', editFlags: { canCopy: true } } });
  wv.fire('focus'); assert.equal(editMenu().p.open, true, 'the focus of the right-click itself keeps the menu');
  await new Promise((r) => realSetTimeout(r, 350));
  wv.fire('focus'); assert.equal(editMenu().p.open, false, 'a click in the page closes the menu');
  wv.fire('context-menu', { params: { x: 5, y: 5, isEditable: false, selectionText: '', editFlags: { canCopy: false } } });
  assert.equal(editMenu().p.open, false, 'no selection and no field: no menu');
  wv.fire('context-menu', {}); assert.equal(editMenu().p.open, false, 'no params: no menu');
  // No item can run (an empty field, an empty clipboard): no menu, and an open menu closes (it could take no focus).
  wv.fire('context-menu', { params: { x: 1, y: 1, isEditable: true, selectionText: '', editFlags: flags } });
  assert.equal(editMenu().p.open, true);
  wv.fire('context-menu', { params: { x: 2, y: 2, isEditable: true, selectionText: '', editFlags: {} } });
  assert.equal(editMenu().p.open, false, 'every item off: no menu');
  // Only the six commands; the page sends none of its own.
  wv.fire('context-menu', { params: { x: 1, y: 1, isEditable: true, selectionText: '', editFlags: flags } });
  views.edit('stop'); views.edit('delete');
  assert.deepEqual(calls, ['paste'], 'no other webview method runs'); assert.equal(editMenu().p.open, false);
  views.edit('copy'); assert.deepEqual(calls, ['paste'], 'no menu open: nothing runs');
  // A switch closes the menu (the page hides).
  wv.fire('context-menu', { params: { x: 1, y: 1, isEditable: true, selectionText: '', editFlags: flags } });
  await views.select('self'); assert.equal(editMenu().p.open, false, 'This Mac: the menu closes');
  await views.select(ID); assert.equal(views.getSnapshot().current, ID);
}

// The other Mac's page switches the window: only the page on screen may; "add" goes back to This Mac and opens the dialog.
pushEvent({ switch: 'self', from: ID2 }); await tick();
assert.equal(views.getSnapshot().current, ID, 'a page that is not on screen cannot switch');
pushEvent({ switch: 'self', from: ID }); await tick();
assert.equal(views.getSnapshot().current, 'self');
await views.select(ID);
pushEvent({ switch: 'add', from: ID }); await tick();
assert.equal(views.getSnapshot().current, 'self'); assert.equal(addComputer.getSnapshot().open, true, 'the add dialog opens on this Mac');
addComputer.close(computers);

// One switch at a time: a pick and the other Mac's page while a computer opens.
view = { ...view, computers: [...view.computers, { ...studio, id: ID2, name: 'Garage' }] }; await computers.refresh();
gate = deferred();
const o1 = views.select(ID2); await tick();
assert.equal(views.getSnapshot().busy, true);
assert.equal(renderPicker().c[0].p.items.find((i) => i.id === ID).disabled, true, 'computers are off in the menu while one opens');
assert.deepEqual(await views.select(ID), { skipped: true }, 'a second pick waits');
assert.deepEqual(await views.select('self'), { skipped: true });
gate.resolve(); gate = null; await o1; await tick();
assert.equal(views.getSnapshot().current, ID2); assert.equal(leases.length, 2);
assert.equal(wv.style.visibility, 'hidden', 'Studio stays, hidden');
// Away with another computer to pick: the button still says Back to this Mac, and the click opens the menu.
btn = renderPicker().c[0].p.anchor;
assert.equal(btn.c[1].c[0], 'computers.back'); assert.equal(btn.p['aria-haspopup'], 'menu', 'two computers: the menu');
btn.p.onClick(); assert.equal(views.getSnapshot().current, ID2, 'the click did not switch');
menu = renderPicker().c[0]; assert.equal(menu.p.open, true, 'the menu opened'); menu.p.onClose();
// On this Mac with two computers: the click opens the menu (two places to go).
await views.select('self');
btn = renderPicker().c[0].p.anchor; assert.equal(btn.p['aria-haspopup'], 'menu', 'two other computers: the menu');
btn.p.onClick(); assert.equal(views.getSnapshot().current, 'self'); menu = renderPicker().c[0]; assert.equal(menu.p.open, true); menu.p.onClose();
await views.select(ID2);

// A computer that is removed: its page closes, its lease goes back, the window shows This Mac.
view = { ...view, computers: view.computers.filter((c) => c.id !== ID2) }; await computers.refresh();
views.sync();
assert.deepEqual(released, ['L2']); assert.equal(views.getSnapshot().current, 'self');
// A refused open shows the reason under the picker.
view = { ...view, computers: [...view.computers, { ...studio, id: ID2, name: 'Garage' }] }; await computers.refresh();
refuse = 'unpaired'; await views.select(ID2);
assert.equal(views.getSnapshot().error, 'unpaired');
assert.ok(JSON.stringify(renderPicker().c[1]).includes('computers.error.unpaired'));

// dsh web (no desktop bridge): an iframe.
const bridge = globalThis.dshDesktop; globalThis.dshDesktop = undefined;
await views.select(ID2);
const frame = root.children.find((c) => c.tag === 'iframe');
assert.ok(frame, 'an iframe'); assert.match(frame.src, /cp-ticket=/);
assert.match(frame.style.cssText, /top:var\(--dsh-frame-top-clearance/, 'dsh web: under the title bar space, as before');
globalThis.dshDesktop = bridge;
// That Mac removed this one: the page closes and the window shows This Mac with the reason.
view = { ...view, computers: view.computers.map((c) => (c.id === ID2 ? { ...c, state: 'unpaired' } : c)) }; await computers.refresh();
views.sync();
assert.equal(frame.isConnected, false, 'an unpaired computer\'s page closes'); assert.equal(views.getSnapshot().current, 'self');
assert.equal(views.getSnapshot().error, 'unpaired');

// The other Mac's page (`via`): the picker lists this Mac's computers from its relay and asks it to switch.
view = { ...view, via: true }; await computers.refresh();
assert.equal(renderPicker(), null, 'an older relay (404): no picker');
opener = { status: 200, body: { self: { name: 'Office Mac' }, current: ID, computers: [{ id: ID, name: 'Studio', state: 'ok' }, { id: ID2, name: 'Garage', state: 'ok' }] } };
await openerStore.refresh();
menu = renderPicker().c[0];
assert.deepEqual(menu.p.items.map((i) => i.id), ['self', ID, ID2, 'sep', 'add']);
assert.equal(menu.p.selectedId, ID, 'this page is Studio');
before = posts.length;
menu.p.onSelect(ID2); await tick();
assert.deepEqual(posts.at(-1), { url: '/__composer-plus/switch', body: { to: ID2 } });
menu.p.onSelect(ID); await tick();
assert.equal(posts.length, before + 1, 'the page that shows does not switch to itself');
btn = menu.p.anchor; assert.equal(btn.c[1].c[0], 'computers.back', 'the other Mac\'s page says Back to this Mac'); assert.equal(btn.p['aria-haspopup'], 'menu');
// One computer: the click asks this Mac to come back at once.
opener = { status: 200, body: { self: { name: 'Office Mac' }, current: ID, computers: [{ id: ID, name: 'Studio', state: 'ok' }] } };
await openerStore.refresh();
btn = renderPicker().c[0].p.anchor; assert.equal(btn.p['aria-haspopup'], undefined);
assert.deepEqual(partsOf(btn), [{ id: 'self', label: 'computers.thisMacShort', pressed: false }, { id: ID, label: 'Studio', pressed: true }], 'the same two parts on the other Mac\'s page');
before = posts.length; btn.c[1].p.onClick(); await tick();
assert.equal(posts.length, before, 'the page on screen does not switch to itself');
btn.c[0].p.onClick(); await tick();
assert.deepEqual(posts.at(-1), { url: '/__composer-plus/switch', body: { to: 'self' } });
assert.equal(renderPicker().c[0].p.open, false, 'no menu opened');
view = { ...view, via: false }; await computers.refresh();

// The computer slept when its page loaded: the relay showed its own error page in the view and said so (`failed`). The
// next pick drops that page (its lease goes back) and loads a new ticket, so the computer that woke up shows its dsh. A
// page that did not fail stays hidden (above, "no reload"); a hello after the failure (Try again worked) keeps it too.
{
  assert.equal(views.getSnapshot().current, 'self');
  const opensBefore = opens; const relBefore = released.length; const leasesBefore = leases.length;
  pushEvent({ failed: 'unreachable', from: 'c'.repeat(64) }); await tick(); // no such view: nothing to drop
  await views.select(ID); await tick();
  assert.equal(opens, opensBefore, 'a page that did not fail: no new ticket');
  pushEvent({ failed: 'unreachable', from: ID }); await tick();
  assert.equal(views.getSnapshot().current, ID, 'a failed page does not switch the window');
  assert.equal(wv.isConnected, true, 'the failed page stays until the next pick');
  await views.select('self');
  await views.select(ID); await tick();
  assert.equal(opens, opensBefore + 1, 'a new ticket');
  assert.deepEqual(released.slice(relBefore), ['L1'], 'the failed page\'s lease went back');
  assert.equal(wv.isConnected, false, 'the error page is gone');
  assert.equal(leases.length, leasesBefore + 1, 'a new lease');
  const fresh = root.querySelector(`[data-composer-plus-computer-view="${ID}"]`) ?? root.children.find((c) => c.getAttribute('data-composer-plus-computer-view') === ID);
  assert.ok(fresh && fresh !== wv, 'a new view');
  const urls = []; fresh.loadURL = async (u) => { urls.push(u); }; fresh.fire('dom-ready');
  assert.deepEqual(urls, [`http://127.0.0.1:5555/?cp-ticket=t${opens}`], 'it loads the new ticket');
  assert.equal(views.getSnapshot().current, ID); assert.equal(views.getSnapshot().noPicker, true, 'it must say hello again');
  // Try again in the error page worked (a hello after the failure): the page stays at the next pick.
  pushEvent({ failed: 'unreachable', from: ID }); await tick(); pushEvent({ hello: true, from: ID }); await tick();
  await views.select('self'); await views.select(ID); await tick();
  assert.equal(opens, opensBefore + 1, 'a page that said hello after its failure is kept'); assert.equal(fresh.isConnected, true);
  // One switch at a time: while the failed page opens again, a second pick waits and drops nothing more.
  pushEvent({ failed: 'unreachable', from: ID }); await tick();
  await views.select('self');
  const relMid = released.length;
  gate = deferred();
  const reopening = views.select(ID); await tick();
  assert.equal(views.getSnapshot().busy, true);
  assert.deepEqual(await views.select(ID), { skipped: true }, 'a second pick waits');
  gate.resolve(); gate = null; await reopening; await tick();
  assert.equal(opens, opensBefore + 2); assert.equal(released.length, relMid + 1, 'one lease went back, once');
  await views.select('self');
}

// Switch off: every page and lease, the root, the timer and the loop go; nothing in the window.
await views.select(ID);
root.children.find((c) => c.getAttribute('data-composer-plus-computer-view') === ID).fire('did-start-navigation', { isMainFrame: true, url: 'http://127.0.0.1:5555/' });
assert.equal(timers.size, 1, 'a hello wait runs');
// The float goes with the picker (React unmounts the slot).
{ const m = mount(); const f = m.out.host; assert.equal(f.hasAttribute('data-composer-plus-computer-float'), true); assert.equal(f.isConnected, true); m.cleanup(); assert.equal(f.isConnected, false, 'the float is gone'); }
await settings.setFeature('remoteComputers', false);
await tick();
assert.equal(overlay('computer-picker'), undefined); assert.equal(overlay('add-computer-dialog'), undefined); assert.equal(overlay('computer-edit-menu'), undefined, 'the menu slot goes');
assert.equal(body.querySelector('[data-composer-plus-computer-views]'), null, 'the views root is gone');
assert.deepEqual([...new Set(released)].sort(), leases.map((x) => x.lease).sort(), 'every lease went back');
assert.equal(released.length, leases.length, 'each lease went back once');
assert.equal(views.getSnapshot().current, 'self');
assert.equal(timers.size, 0, 'no timer left');
assert.deepEqual(await views.select(ID), { skipped: true }, 'nothing opens while off');
console.log('computers client checks passed');
process.exit(0);
