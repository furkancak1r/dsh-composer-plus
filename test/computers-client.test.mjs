// Remote computers, the client half (real client.js, a fake Host and fake dsh services): the feature is off by default
// and adds nothing then; switched on, the picker sits in `conversation.header.leading` and the add dialog in
// `shell.overlay`; switched off, both go. The store runs one action of a kind at a time (from the menu, Settings and the
// Enter key), keeps the newest Host view, and never shows a token. A page that another Mac opened (`via`) has no picker.
// A computer opens in the chat's Browser tab, else in a window that opens at the click.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// ---- Fake Host ----
let view = { on: false, self: { name: 'Office Mac' }, computers: [], adding: null, accept: { on: false, running: false, code: null, pending: [], devices: [], last: null }, via: false, available: true };
const posts = []; let gate = null; let refuse = null; let switchOn = false;
globalThis.fetch = async (url, init) => {
  if (String(url) !== '/api/composer-plus.computers') return new Response('{}', { status: 404 });
  if (init?.method !== 'POST') return Response.json({ ...view, on: switchOn });
  const body = JSON.parse(init.body); posts.push(body);
  if (gate) await gate.promise;
  if (refuse) { const r = refuse; refuse = null; return Response.json({ error: r }, { status: 409 }); }
  if (Object.hasOwn(body, 'on')) { switchOn = body.on; return Response.json({ ...view, on: switchOn }); }
  if (body.action === 'add') { view = { ...view, computers: [{ id: 'f'.repeat(64), name: 'Studio Mac', mac: 'Studio Mac', label: null, host: '100.90.0.7', port: 19392, state: 'ok' }] }; return Response.json({ ...view, on: switchOn, added: 'f'.repeat(64) }); }
  if (body.action === 'open') return Response.json({ url: 'http://127.0.0.1:5555/?cp-ticket=abc' });
  if (body.action === 'cancel-add') return Response.json({ ...view, on: switchOn });
  return Response.json({ ...view, on: switchOn });
};

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: () => {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {} };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Modal: 'Modal', Button: 'Button' } : {}));
const live = new Map(); let next = 0;
// dsh's right sidebar: openTab records the tab; the Browser kind is registered.
const opened = []; let expanded = true; let toggled = 0; let hasBrowserKind = true;
const sidebarRight = { openTab: (kind, o) => opened.push([kind, o]), isExpanded: () => expanded, toggleExpanded: () => { toggled++; expanded = !expanded; } };
const sidebarRightTabs = { get: (kind) => (kind === 'browser' && hasBrowserKind ? { kind } : undefined), register: () => () => {} };
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: (ns) => (k) => k, resolveText: (x) => x },
  // Only the right sidebar's services are here: the other features' scopes never start.
  inject: (deps, setup) => { if (!deps.every((d) => d === 'sidebarRight' || d === 'sidebarRightTabs')) return { dispose() {} }; const fx = []; setup({ sidebarRight, sidebarRightTabs, effect: (f) => fx.push(f()) }); return { dispose: () => fx.forEach((f) => f?.()) }; },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
const slot = (name) => [...live.values()].find(([o]) => o.name === name && (name !== 'shell.overlay' || o.id === 'add-computer-dialog'));
const settingsEntry = [...live.values()].find(([o]) => o.id === 'composer-plus');
const settings = settingsEntry[0].inject();
await tick();

// Off by default: no picker, no dialog.
assert.equal(slot('conversation.header.leading'), undefined, 'off by default: no picker');
assert.equal(slot('shell.overlay'), undefined, 'off by default: no dialog');
// Also when the Host gives no switch (an older Host half answers 404): the feature stays off.
{
  let m2; const w = globalThis.window; globalThis.window = { __ModuleLoader__: { load: (m) => { m2 = m; } }, addEventListener() {}, removeEventListener() {} };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8')); globalThis.window = w;
  const f = globalThis.fetch; globalThis.fetch = async () => new Response('{}', { status: 404 });
  const p2 = m2.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Modal: 'Modal', Button: 'Button' } : {}));
  const live2 = []; p2.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k, resolveText: (x) => x }, inject: () => ({ dispose() {} }),
    slots: { inject: (n, fn) => fn(), register: (o) => { live2.push(o); return () => {}; } } });
  await tick(); globalThis.fetch = f;
  assert.equal(live2.some((o) => o.name === 'conversation.header.leading'), false, 'no Host switch: still off');
}

// Switch on (the Host switch); the picker and the dialog come.
await settings.setFeature('remoteComputers', true);
await tick();
assert.deepEqual(posts.at(-1), { on: true });
const picker = slot('conversation.header.leading');
assert.ok(picker, 'the picker is in the chat header');
assert.ok(slot('shell.overlay'), 'the add dialog is in the overlay');
const { computers } = picker[0].inject();
assert.equal(computers, settings.computers, 'one store for the picker and Settings');
// The slot component returns <ComputerPicker sessionId={open chat}>; render that element.
const render = () => { const el = picker[1]({ ...picker[0].inject(), t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k) }); return el.t(el.p); };

// The picker renders This Mac, the computers and Add a computer…
await computers.refresh();
let tree = render();
let menu = tree.c[0];
assert.equal(menu.t, 'Menu');
assert.deepEqual(menu.p.items.map((i) => i.id), ['self', 'sep', 'add'], 'no computers yet');
assert.equal(menu.p.items[1].type, 'separator');
assert.match(menu.p.anchor.p['aria-label'], /computers\.picker/);
assert.equal(menu.p.anchor.p.style.WebkitAppRegion, 'no-drag', 'the button is not a window drag area');
assert.equal(tree.p.style.WebkitAppRegion, 'no-drag', 'nor its error text (the header is a drag area on macOS)');
// Off by default also for a browser that saved nothing: the Host switch is the only state.
assert.equal(mem.get('dsh-composer-plus.features'), undefined);

// Add: one at a time (a second Connect, or Enter while it waits, sends nothing); no token in the store.
const addComputer = settings.addComputer;
addComputer.open(); addComputer.setLink('  dsh-computer://pair?v=1&host=100.90.0.7&port=19392&fp=' + 'f'.repeat(64) + '&code=c  ');
gate = deferred();
const first = addComputer.submit(computers);
await tick();
assert.equal(addComputer.getSnapshot().waiting, true);
// The waiting text names the other Mac from the link (here its address: this link has no `mac`).
{ const dialog = slot('shell.overlay'); const el = dialog[1]({ ...dialog[0].inject(), t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k) });
  assert.ok(JSON.stringify(el).includes('computers.waiting:{\\"name\\":\\"100.90.0.7\\"}'), 'the waiting text has the name'); }
const before = posts.length;
// Enter again in the dialog: the dialog itself refuses (its own state stays "waiting", the store is not asked).
const addCalls = []; const realAdd = computers.add; computers.add = (l) => { addCalls.push(l); return realAdd(l); };
await addComputer.submit(computers);
computers.add = realAdd;
assert.equal(addCalls.length, 0, 'the dialog does not send a second pairing');
await computers.add('again');
assert.equal(posts.length, before, 'one pairing at a time from the dialog and the store');
assert.equal(posts.at(-1).link, 'dsh-computer://pair?v=1&host=100.90.0.7&port=19392&fp=' + 'f'.repeat(64) + '&code=c', 'the link is trimmed');
gate.resolve(); gate = null;
await first;
assert.equal(addComputer.getSnapshot().open, false, 'the dialog closes after Approve');
assert.equal(computers.getSnapshot().computers.length, 1);
assert.equal(JSON.stringify(computers.getSnapshot()).includes('token'), false);
assert.equal(computers.getSnapshot().added, undefined, 'only the view is kept');

// A refused link keeps the dialog open with the reason; Cancel while it waits asks the Host to stop.
addComputer.open(); addComputer.setLink('x'); refuse = 'bad-link';
await addComputer.submit(computers);
assert.equal(addComputer.getSnapshot().error, 'bad-link'); assert.equal(addComputer.getSnapshot().open, true);
// The add waits at the Host (held); Cancel goes past the hold, then the add answers 'cancelled'.
const held = deferred(); addComputer.setLink('y');
const realFetchAdd = globalThis.fetch;
globalThis.fetch = async (url, init) => { const b = init?.body ? JSON.parse(init.body) : {}; if (b.action === 'add') { posts.push(b); await held.promise; return Response.json({ error: 'cancelled' }, { status: 409 }); } return realFetchAdd(url, init); };
const waiting = addComputer.submit(computers); await tick();
addComputer.close(computers); await tick();
assert.deepEqual(posts.at(-1), { action: 'cancel-add' });
held.resolve(); await waiting;
globalThis.fetch = realFetchAdd;
assert.equal(addComputer.getSnapshot().error, undefined, 'a cancel is no error');
assert.equal(addComputer.getSnapshot().open, false);

// Open from the picker: in this chat's Browser tab; the label then names the computer.
globalThis.document.querySelector = (sel) => (sel.includes('aria-selected') ? { getAttribute: () => 'session:s1' } : null);
tree = render(); menu = tree.c[0];
assert.deepEqual(menu.p.items.map((i) => i.id), ['self', 'f'.repeat(64), 'sep', 'add']);
await menu.p.onSelect('f'.repeat(64)); await tick();
assert.deepEqual(opened.at(-1), ['browser', { params: { url: 'http://127.0.0.1:5555/?cp-ticket=abc' } }]);
assert.equal(computers.shown('s1'), 'f'.repeat(64));
tree = render();
assert.equal(tree.c[0].p.selectedId, 'f'.repeat(64));
assert.match(tree.c[0].p.anchor.p['aria-label'], /Studio Mac/);
// Collapsed sidebar: the label says This Mac again.
expanded = false; assert.equal(render().c[0].p.selectedId, 'self'); expanded = true;
// This Mac: the sidebar closes and the chat forgets the computer.
await render().c[0].p.onSelect('self');
assert.equal(toggled, 1); assert.equal(computers.shown('s1'), undefined);

// One open at a time: a second pick while the first waits sends nothing.
gate = deferred();
const o1 = render().c[0].p.onSelect('f'.repeat(64)); await tick();
const n = posts.length;
assert.equal(render().c[0].p.items[1].disabled, true, 'computers are off in the menu while one opens');
await computers.open('f'.repeat(64));
assert.equal(posts.length, n);
gate.resolve(); gate = null; await o1;

// No Browser tab kind (or no chat): a window opens at the click, then gets the address.
hasBrowserKind = false;
const windows = []; globalThis.open = (u) => { const w = { u, location: { href: u }, close() { w.closed = true; } }; windows.push(w); return w; };
await render().c[0].p.onSelect('f'.repeat(64)); await tick();
assert.equal(windows[0].u, 'about:blank', 'the window opens before the Host answers');
assert.equal(windows[0].location.href, 'http://127.0.0.1:5555/?cp-ticket=abc');
// A refused open closes that window and shows the reason.
refuse = 'unpaired';
await render().c[0].p.onSelect('f'.repeat(64)); await tick();
assert.equal(windows[1].closed, true);
hasBrowserKind = true;

// A page that another Mac opened: no picker at all.
view = { ...view, via: true };
await computers.refresh();
assert.equal(render(), null, 'no picker inside another computer\'s page');
view = { ...view, via: false };
await computers.refresh();

// Settings: one change of one computer at a time; Approve and Deny one at a time per request.
gate = deferred();
const r1 = computers.rename('f'.repeat(64), 'A'); await tick();
const m = posts.length;
await computers.remove('f'.repeat(64));
assert.equal(posts.length, m, 'remove waits for the rename');
gate.resolve(); gate = null; await r1;
gate = deferred();
const a1 = computers.answer('p1', true); await tick();
const k = posts.length;
await computers.answer('p1', false);
assert.equal(posts.length, k, 'one answer per request');
gate.resolve(); gate = null; await a1;
assert.deepEqual(posts.at(-1), { action: 'approve', id: 'p1' });

// An older GET answer that arrives after a POST does not overwrite the newer view.
const slow = deferred(); const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { if (init?.method !== 'POST') { await slow.promise; return Response.json({ ...view, on: true, computers: [] }); } return realFetch(url, init); };
const oldRead = computers.refresh(); await tick();
await computers.setAccept(true);
const afterPost = computers.getSnapshot().computers.length;
slow.resolve(); await oldRead;
assert.equal(computers.getSnapshot().computers.length, afterPost, 'the older read is dropped');
globalThis.fetch = realFetch;

// Switch off: the picker and the dialog go; the chats forget their computers.
computers.show('s1', 'f'.repeat(64));
await settings.setFeature('remoteComputers', false);
await tick();
assert.equal(slot('conversation.header.leading'), undefined, 'off: no picker');
assert.equal(slot('shell.overlay'), undefined, 'off: no dialog');
assert.equal(computers.shown('s1'), undefined);
console.log('computers client checks passed');
