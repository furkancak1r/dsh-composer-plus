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
const primitives = { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Modal: 'Modal', Button: 'Button' };
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
assert.equal(overlay('computer-views-bar'), undefined);
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

// Switch on (the Host switch): the picker, the views bar and the dialog come; the chat header gets nothing.
await settings.setFeature('remoteComputers', true);
await tick();
assert.deepEqual(posts.at(-1), { on: true });
const pickerEntry = overlay('computer-picker');
assert.ok(pickerEntry && overlay('computer-views-bar') && overlay('add-computer-dialog'));
assert.equal([...live.values()].some(([o]) => o.name === 'conversation.header.leading'), false, 'not in the chat header any more');
const { computers, views, opener: openerStore } = pickerEntry[0].inject();
assert.equal(computers, settings.computers, 'one store for the picker and Settings');

// The host: right after the brand, before the toggle; not a drag area. The rail (no brand) has none.
const mount = () => { hi = 0; layouts = []; const out = pickerEntry[1]({ ...pickerEntry[0].inject(), t }); const fx = layouts.map((f) => f()); hi = 0; layouts = []; return { out: pickerEntry[1]({ ...pickerEntry[0].inject(), t }), cleanup: () => fx.forEach((f) => f?.()) }; };
let { out, cleanup } = mount();
const host = row.children[1];
assert.equal(host.hasAttribute('data-composer-plus-computer-host'), true, 'the host follows the brand');
assert.equal(row.children[2], toggle, 'the toggle stays after it');
assert.match(host.style.cssText, /-webkit-app-region:no-drag/); assert.equal(host.hasAttribute('data-window-drag-recall'), true);
assert.equal(out.host, host, 'the picker is portaled into the host');
// dsh redraws the row (a new brand): the observer moves the host after it, and keeps one host.
const brand2 = new El('span', { class: 'hHd-Xa_brand' }); row.children.unshift(brand2); brand2.parentElement = row; brand.remove();
observerFns.forEach((f) => f());
assert.equal(row.children[1].hasAttribute('data-composer-plus-computer-host'), true);
assert.equal(body.querySelectorAll('[data-composer-plus-computer-host]').length, 1);
// The rail: no brand → no host.
brand2.remove(); observerFns.forEach((f) => f());
assert.equal(body.querySelectorAll('[data-composer-plus-computer-host]').length, 0, 'no picker in the rail');
row.children.unshift(brand); brand.parentElement = row; observerFns.forEach((f) => f());
assert.equal(row.children[1].hasAttribute('data-composer-plus-computer-host'), true);
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
// The relay URL loads only after the lease is attached (dom-ready), once.
const loaded = []; wv.loadURL = async (u) => { loaded.push(u); };
wv.fire('dom-ready'); wv.fire('dom-ready');
assert.deepEqual(loaded, ['http://127.0.0.1:5555/?cp-ticket=t1']);
assert.equal(wv.style.visibility, 'visible'); assert.equal(wv.focused, 1, 'the page gets the focus');
assert.equal(views.getSnapshot().current, ID);
assert.match(renderPicker().c[0].p.anchor.p['aria-label'], /Studio/, 'the picker names it');

// The other Mac's page says hello: no fallback button. A new document in the webview must say hello again.
await tick();
wv.fire('did-start-navigation', { isMainFrame: true, url: 'http://127.0.0.1:5555/' });
pushEvent({ hello: true, from: ID }); await tick();
runTimers(); assert.equal(views.getSnapshot().fallback, false, 'hello came: no button');
wv.fire('did-start-navigation', { isMainFrame: true, url: 'http://127.0.0.1:5555/' });
runTimers(); await tick();
assert.equal(views.getSnapshot().fallback, true, 'no hello in time: the Back button');
{ const bar = overlay('computer-views-bar'); const el = bar[1]({ ...bar[0].inject(), t }); assert.equal(el.host, body); assert.ok(JSON.stringify(el.portal).includes('computers.back')); }
pushEvent({ hello: true, from: ID }); await tick();
assert.equal(views.getSnapshot().fallback, false, 'a late hello hides it');

// This Mac: the page hides and stays (no reload, lease kept); Studio again shows it at once.
await renderPicker().c[0].p.onSelect('self');
assert.equal(root.style.visibility, 'hidden'); assert.equal(wv.style.visibility, 'hidden'); assert.equal(wv.isConnected, true); assert.deepEqual(released, []);
await renderPicker().c[0].p.onSelect(ID);
assert.equal(opens, 1, 'no new ticket'); assert.equal(loaded.length, 1, 'no reload'); assert.equal(root.style.visibility, 'visible');

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

// A computer that is removed: its page closes, its lease goes back, the window shows This Mac.
view = { ...view, computers: view.computers.filter((c) => c.id !== ID2) }; await computers.refresh();
{ const bar = overlay('computer-views-bar'); bar[1]({ ...bar[0].inject(), t }); }
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
view = { ...view, via: false }; await computers.refresh();

// Switch off: every page and lease, the root, the timer and the loop go; nothing in the window.
await views.select(ID);
wv.fire('did-start-navigation', { isMainFrame: true, url: 'http://127.0.0.1:5555/' });
assert.equal(timers.size, 1, 'a hello wait runs');
await settings.setFeature('remoteComputers', false);
await tick();
assert.equal(overlay('computer-picker'), undefined); assert.equal(overlay('computer-views-bar'), undefined); assert.equal(overlay('add-computer-dialog'), undefined);
assert.equal(body.querySelector('[data-composer-plus-computer-views]'), null, 'the views root is gone');
assert.deepEqual(released.sort(), ['L1', 'L2', 'L3'].filter((l) => leases.some((x) => x.lease === l)).sort(), 'every lease went back');
assert.equal(views.getSnapshot().current, 'self');
assert.equal(timers.size, 0, 'no timer left');
assert.deepEqual(await views.select(ID), { skipped: true }, 'nothing opens while off');
console.log('computers client checks passed');
process.exit(0);
