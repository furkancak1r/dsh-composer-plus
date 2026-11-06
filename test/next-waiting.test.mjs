// Runs the real client.js Next waiting chat. Part 1, `waitingOrder`: the order of the chats that wait for you, which Open
// waiting chat when idle also uses. Orange (a request that you can answer) before green (`completionUnread`), the one
// that waits longest first in each group, a tie in dsh's order; subagent rows, unknown chats and requests with
// `answerable: false` do not count; one entry per chat (orange wins); `onScreen` when a waiting chat is in the main view;
// `waits` keeps the first time each wait was seen and forgets the ones that ended.
// Part 2, the feature: the live list without the chat on screen, the dsh shortcut (Cmd+Shift+E, blocked with a reason
// when no chat waits, without a key when dsh refuses the default), the sidebar header button (hidden at 0, a dot in the
// color of the next chat, first in dsh's header actions) and the switch, which removes all of it.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__nw = { waitingOrder, watchNextWaiting, registerNextWaitingKey, NextWaitingButton };\n    ${ANCHOR}`));

// Mini DOM: tag names, [a], [a="v"], [a*="v"] and ':scope > A > B' (the selectors the button uses).
const matcher = (compound) => {
  const tag = /^[a-z]+/.exec(compound)?.[0];
  const attrs = [...compound.matchAll(/\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]/g)].map(([, name, op, value]) => ({ name, op, value }));
  return (e) => (tag === undefined || e.tagName === tag.toUpperCase()) && attrs.every(({ name, op, value }) => {
    const v = e.getAttribute(name);
    return v !== null && (op === undefined || (op === '=' ? v === value : op === '^=' ? v.startsWith(value) : v.includes(value)));
  });
};
const descendants = (e) => e.children.flatMap((c) => [c, ...descendants(c)]);
class El {
  constructor(tag, attrs = {}, children = []) { this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null; for (const c of children) this.append(c); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(c) { c.remove(); c.parentElement = this; this.children.push(c); }
  prepend(c) { c.remove(); c.parentElement = this; this.children.unshift(c); }
  remove() { if (this.parentElement !== null) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; }
  get firstElementChild() { return this.children[0] ?? null; }
  querySelectorAll(sel) {
    if (!sel.startsWith(':scope > ')) return descendants(this).filter(matcher(sel));
    let level = [this];
    for (const part of sel.slice(':scope > '.length).split(' > ')) { const m = matcher(part); level = level.flatMap((e) => e.children.filter(m)); }
    return level;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
const body = new El('body');
globalThis.document = { body, createElement: (tag) => new El(tag), querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s) };
let observers = 0;
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() { observers += 1; scanDom = this.fn; } disconnect() { observers -= 1; } };
let scanDom = () => {};

// Fake React with per-component hook state; effects run once (the button's only effect has no dependencies).
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = v; return [s[i], (x) => { s[i] = x; }]; },
  useRef: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = { current: v }; return s[i]; },
  useEffect: (f) => { const i = cur.ei++; if (!(i in cur.cleanups)) cur.cleanups[i] = f(); } };
const mount = (C, props) => {
  const inst = { state: [], cleanups: [] };
  const render = () => { cur = inst; inst.si = 0; inst.ei = 0; return C(props); };
  return { render, settle: () => { render(); return render(); }, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Tooltip: 'Tooltip' } : {}));
const { waitingOrder, watchNextWaiting, registerNextWaitingKey, NextWaitingButton } = globalThis.__nw;

const ask = (kind, key, extra = {}) => ({ kind, key, answerable: true, ...extra });
const st = (pendingInteraction, completionUnread = false) => ({ running: false, pendingInteraction, completionUnread });
const row = (id, o = {}) => [id, { id, retainedBy: { mainView: 0 }, ...o }];
const ids = (r) => r.order.map((w) => w.sessionId);

// --- Part 1: waitingOrder ---
// Acceptance case 1 of the plan: A (question, t0), B (approval, t1 > t0), C (green, t2), D (green, t1). Order A, B, D, C.
const waits = new Map();
const byId = Object.fromEntries([row('A'), row('B'), row('C'), row('D'), row('open', { retainedBy: { mainView: 1 } })]);
waitingOrder(new Map([['A', st(ask('question', 'qa'))]]), byId, waits, 100);
waitingOrder(new Map([['A', st(ask('question', 'qa'))], ['B', st(ask('approval', 'qb'))], ['D', st(undefined, true)]]), byId, waits, 200);
let r = waitingOrder(new Map([['C', st(undefined, true)], ['D', st(undefined, true)], ['B', st(ask('approval', 'qb'))], ['A', st(ask('question', 'qa'))]]), byId, waits, 300);
assert.deepEqual(ids(r), ['A', 'B', 'D', 'C'], 'orange before green, the longest-waiting first in each group');
assert.deepEqual(r.order.map((w) => w.done), [false, false, true, true]);
assert.equal(r.onScreen, false);
assert.deepEqual(r.order.map((w) => w.since), [100, 200, 200, 300], 'each wait keeps the time it was first seen');

// An older green chat still comes after a newer orange one.
r = waitingOrder(new Map([['D', st(undefined, true)], ['E', st(ask('plan-review', 'pe'))]]), { ...byId, ...Object.fromEntries([row('E')]) }, waits, 400);
assert.deepEqual(ids(r), ['E', 'D'], 'an orange chat that started waiting later still comes first');

// A tie keeps dsh's order (the order of the status snapshot).
const tie = new Map();
r = waitingOrder(new Map([['B', st(ask('question', 't1'))], ['A', st(ask('question', 't2'))]]), byId, tie, 50);
assert.deepEqual(ids(r), ['B', 'A'], 'same time: dsh\'s order');

// Left out: a subagent row, a chat that is not in the list, a request that cannot be answered here, a chat without a dot.
const out = new Map();
r = waitingOrder(new Map([
  ['sub', st(ask('question', 's1'))], ['ghost', st(ask('question', 'g1'))], ['A', st(ask('approval', 'a1', { answerable: false }))],
  ['B', st(undefined, false)], ['C', st(ask('question', 'c1'))],
]), { ...byId, ...Object.fromEntries([row('sub', { origin: 'subagent' })]) }, out, 10);
assert.deepEqual(ids(r), ['C'], 'only chats with a dot that you can act on');
assert.deepEqual([...out.keys()], ['c1'], 'nothing is remembered for the chats that are left out');

// One entry per chat: a request wins over the green dot of the same chat.
r = waitingOrder(new Map([['A', st(ask('question', 'both'), true)]]), byId, new Map(), 10);
assert.equal(r.order.length, 1); assert.equal(r.order[0].done, false, 'orange wins over green in one chat');

// A waiting chat in the main view sets onScreen; it stays in the order (the caller decides to skip it).
r = waitingOrder(new Map([['open', st(ask('question', 'o1'))], ['A', st(undefined, true)]]), byId, new Map(), 10);
assert.equal(r.onScreen, true); assert.deepEqual(ids(r), ['open', 'A']);
r = waitingOrder(new Map([['open', st()], ['A', st(undefined, true)]]), byId, new Map(), 10);
assert.equal(r.onScreen, false, 'a chat on screen that does not wait is not onScreen');

// A wait that ended is forgotten; the same chat waiting again (a new request key) starts a new wait.
const again = new Map();
waitingOrder(new Map([['A', st(ask('question', 'k1'))], ['B', st(ask('question', 'k2'))]]), byId, again, 1);
waitingOrder(new Map([['B', st(ask('question', 'k2'))]]), byId, again, 2);
assert.deepEqual([...again.keys()], ['k2'], 'an answered request is forgotten');
r = waitingOrder(new Map([['A', st(ask('question', 'k3'))], ['B', st(ask('question', 'k2'))]]), byId, again, 3);
assert.deepEqual(ids(r), ['B', 'A'], 'a new request of A starts after B\'s older wait');
// A green chat that was opened and finishes again later keeps one key per chat: `done:<id>` starts again after it ended.
waitingOrder(new Map([['C', st(undefined, true)]]), byId, again, 4);
waitingOrder(new Map(), byId, again, 5);
r = waitingOrder(new Map([['C', st(undefined, true)]]), byId, again, 6);
assert.equal(r.order[0].since, 6, 'a green dot that came back is a new wait');

// No waits and no list: an empty order, no error.
r = waitingOrder(new Map(), {}, new Map(), 1);
assert.deepEqual(r, { order: [], onScreen: false });

// --- Part 2: the feature ---
let now = 1000; Date.now = () => now;
let snap = new Map(); const statusLs = new Set(); const listLs = new Set();
const status = { getSnapshot: () => snap, subscribe: (l) => { statusLs.add(l); return () => statusLs.delete(l); } };
let rowsById = {};
const list = { getSnapshot: () => ({ byId: rowsById }), subscribe: (l) => { listLs.add(l); return () => listLs.delete(l); } };
const pub = (m) => { now += 10; snap = m; for (const l of [...statusLs]) l(); };
const rows = (open = '') => { rowsById = Object.fromEntries(['a', 'b', 'c', 'sub'].map((id) => [id, { id, origin: id === 'sub' ? 'subagent' : undefined, retainedBy: { mainView: id === open ? 1 : 0 } }])); for (const l of [...listLs]) l(); };
rows('c');

// The live list: next first, the chat on screen left out, one snapshot object until the list changes.
const live = watchNextWaiting(status, list);
const seen = []; const offSeen = live.subscribe(() => seen.push(live.getSnapshot()));
assert.deepEqual(live.getSnapshot(), [], 'no chat waits');
pub(new Map([['a', st(undefined, true)]]));
pub(new Map([['a', st(undefined, true)], ['b', st(ask('question', 'qb'))], ['c', st(ask('approval', 'qc'))]]));
assert.deepEqual(live.getSnapshot(), [{ sessionId: 'b', done: false }, { sessionId: 'a', done: true }], 'orange first; the chat on screen (c) is left out');
const before = live.getSnapshot(); const count = seen.length;
pub(new Map([['a', st(undefined, true)], ['b', st(ask('question', 'qb'))], ['c', st(ask('approval', 'qc'))]]));
assert.equal(live.getSnapshot(), before, 'same list: same object'); assert.equal(seen.length, count, 'same list: no update');
rows('b'); assert.deepEqual(live.getSnapshot().map((w) => w.sessionId), ['c', 'a'], 'you open b: c (orange) is next, then a (green)');
pub(new Map([['a', st(undefined, true)], ['b', st(ask('question', 'qb'))], ['c', st(ask('approval', 'qc'))], ['sub', st(ask('question', 'qs'))]]));
assert.deepEqual(live.getSnapshot().map((w) => w.sessionId), ['c', 'a'], 'a subagent request does not count');
offSeen(); live.dispose(); assert.equal(statusLs.size + listLs.size, 0, 'dispose ends both subscriptions');

// The shortcut: dsh's command shape, blocked with a reason at 0, run opens the next chat; dsh refusing the default.
const t = (k, p) => (p === undefined ? k : `${k}:${JSON.stringify(p)}`);
const registered = [];
const fakeShortcuts = (refuse = () => false) => ({ register: (command) => {
  if (refuse(command)) throw new Error(`Conflicting shortcut defaults: ${command.id}`);
  registered.push(command); return () => { registered.splice(registered.indexOf(command), 1); };
} });
let waitingCount = 0; const opens = [];
let off = registerNextWaitingKey(fakeShortcuts(), t, () => waitingCount, () => opens.push('next'));
assert.equal(registered.length, 1); const command = registered[0];
assert.equal(command.id, 'composerPlus.nextWaiting'); assert.match(command.id, /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/u, 'dsh\'s command id pattern');
assert.equal(command.label(), 'nextWaiting.command');
assert.deepEqual(command.regions, ['page', 'editable'], 'works while the composer has the focus'); assert.deepEqual(command.modals, []);
assert.deepEqual(Object.keys(command.defaults).sort(), ['desktop:linux', 'desktop:macos', 'desktop:windows', 'web:macos', 'web:windows'], 'no web Linux default, as in dsh');
for (const binding of Object.values(command.defaults)) assert.deepEqual(binding, { code: 'KeyE', modifiers: ['primary', 'shift'] }, 'Cmd+Shift+E / Ctrl+Shift+E');
assert.deepEqual(command.resolve({}), { status: 'blocked', reason: 'nextWaiting.none' }, 'no chat waits: blocked, with the reason');
waitingCount = 2; const handled = command.resolve({}); assert.equal(handled.status, 'handled'); handled.run();
assert.deepEqual(opens, ['next']);
off(); assert.equal(registered.length, 0, 'the disposer removes the command');
const warns = []; const warn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
off = registerNextWaitingKey(fakeShortcuts((c) => Object.keys(c.defaults).length > 0), t, () => 0, () => {});
assert.equal(registered.length, 1); assert.deepEqual(registered[0].defaults, {}, 'a taken default: the command still comes, without a key'); off();
off = registerNextWaitingKey(fakeShortcuts(() => true), t, () => 0, () => {});
assert.equal(registered.length, 0, 'a second copy (same id): no command'); off();
console.warn = warn; assert.equal(warns.length, 3, 'each refusal is logged');

// The button: dsh's sidebar is root > [sectionHeader > headerActions > [view options, add], listArea].
const viewOptions = new El('button', { 'aria-label': 'View options' }); const add = new El('button', { 'aria-label': 'Add workspace' });
const actions = new El('div', { class: 'x_headerActions' }, [new El('span', { class: 'm_root' }, [viewOptions]), add]);
body.append(new El('div', { class: 'x_root' }, [new El('div', { class: 'x_sectionHeader' }, [new El('span', { class: 'x_sectionLabel' }), actions]), new El('div', { class: 'x_listArea' })]));
let list2 = [];
const clicks = [];
const nb = mount(NextWaitingButton, { t, useNextWaiting: (select) => select(list2), open: () => clicks.push('open') });
let view = nb.settle();
const css = view.c[0].c[0];
assert.ok(css.includes('[data-composer-plus-next-waiting] { display: contents; }'), 'an empty host takes no room');
assert.ok(css.includes(':has(> [data-composer-plus-next-waiting] > button)'), 'the header cap grows only while the button shows');
assert.ok(css.includes('[class*="_rail"] > [class*="_sectionHeader"] [data-composer-plus-next-waiting] { display: none; }'), 'not in the narrow sidebar');
const host = actions.children[0];
assert.equal(host.getAttribute('data-composer-plus-next-waiting'), '', 'first in the header actions');
assert.equal(actions.children[1].children[0], viewOptions, 'dsh buttons keep their order'); assert.equal(actions.children[2], add);
assert.equal(view.c[1], null, 'no chat waits: no button');
list2 = [{ sessionId: 'b', done: false }, { sessionId: 'a', done: true }];
view = nb.render();
assert.equal(view.c[1].host, host);
const trigger = view.c[1].portal; assert.equal(trigger.t, 'Tooltip'); assert.equal(trigger.p.label, 'nextWaiting.button:{"count":"2"}');
const button = trigger.c[0]; assert.equal(button.t, 'button'); assert.equal(button.p.type, 'button'); assert.equal(button.p['aria-label'], 'nextWaiting.button:{"count":"2"}');
assert.equal(button.c[1], '2', 'the number of waiting chats');
assert.match(button.c[0].p.style.background, /state-warn-primary/, 'orange dot: the next chat asks you something'); assert.equal(button.c[0].p['aria-hidden'], true);
button.p.onClick({ detail: 1 }); assert.deepEqual(clicks, ['open']);
list2 = [{ sessionId: 'a', done: true }];
view = nb.render(); assert.match(view.c[1].portal.c[0].c[0].p.style.background, /state-success-primary/, 'green dot: the next chat finished a turn');
// Collapse all projects puts its host first later: this one moves first again; one host only.
const collapse = new El('span', { 'data-composer-plus-collapse-projects': '' }); actions.prepend(collapse);
scanDom(); nb.render();
assert.equal(actions.children[0], host, 'first again'); assert.equal(actions.children[1], collapse);
assert.equal(document.querySelectorAll('[data-composer-plus-next-waiting]').length, 1, 'one host only');
nb.unmount(); assert.equal(observers, 0, 'unmount stops watching');
assert.equal(document.querySelector('[data-composer-plus-next-waiting]'), null, 'unmount removes the button host');
// No dsh sidebar (for example a narrow window during start): no host, no error.
body.children.length = 0;
const lone = mount(NextWaitingButton, { t, useNextWaiting: (select) => select(list2), open: () => {} });
assert.equal(lone.settle().c[1], null, 'no header: no button'); lone.unmount();

// The feature through plugin.apply: on by default; the button slot, the shortcut and the subscriptions; switched off,
// all of them go; without dsh's shortcuts service the button still comes.
const boot = (withShortcuts) => {
  const slots = new Map(); let setFeature; const fibers = [];
  const shortcutsService = fakeShortcuts();
  plugin.apply({
    slots: { inject: (n, f) => f(), register: (o, C) => { if (o.id === 'composer-plus') setFeature = o.inject().setFeature; const key = Symbol(o.id); slots.set(key, [o, C]); return () => slots.delete(key); } },
    configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k }, effect: (f) => f(),
    inject: (deps, setup) => {
      const offs = []; const fiber = { deps: deps.join(), dispose: () => { for (const o of offs.splice(0).reverse()) o?.(); fibers.splice(fibers.indexOf(fiber), 1); } };
      const services = { uiSession: { sessionStatus: status }, sessions: { list }, uiWorkspace: { openSession: (id) => opened.push(id) }, shortcuts: shortcutsService };
      // Only this feature's scopes: the other features have their own tests.
      if (deps.join() === 'uiSession,sessions,uiWorkspace' || (withShortcuts && deps.join() === 'shortcuts')) {
        fibers.push(fiber); setup({ ...Object.fromEntries(deps.map((d) => [d, services[d]])), effect: (f) => offs.push(f()) });
      }
      return fiber;
    },
  });
  const slot = () => [...slots.values()].find(([o]) => o.id === 'next-waiting');
  return { slot, setFeature, fibers };
};
const opened = [];
rows('c'); snap = new Map(); registered.length = 0;
let app = boot(true);
const found = app.slot(); assert.ok(found, 'on by default: the button slot');
assert.equal(found[0].name, 'shell.overlay'); assert.equal(found[0].locale, 'dsh-composer-plus'); assert.equal(found[1], NextWaitingButton);
assert.deepEqual(registered.map((c) => c.id), ['composerPlus.nextWaiting'], 'and the shortcut');
assert.equal(found[0].hooks, undefined, 'dsh reads slot hooks from inject(), not from the options');
const store = found[0].inject().hooks.nextWaiting;
pub(new Map([['a', st(undefined, true)], ['b', st(ask('question', 'qb2'))]]));
assert.deepEqual(store.getSnapshot().map((w) => w.sessionId), ['b', 'a'], 'the slot hook is the live list');
const cmd = registered[0];
cmd.resolve({}).run(); assert.deepEqual(opened, ['b'], 'the key opens the next chat');
found[0].inject().open(); assert.deepEqual(opened, ['b', 'b'], 'the button opens the same one');
pub(new Map()); assert.deepEqual(cmd.resolve({}), { status: 'blocked', reason: 'nextWaiting.none' }, 'nothing waits: the key is blocked');
found[0].inject().open(); assert.deepEqual(opened, ['b', 'b'], 'nothing waits: a stale click does nothing');
app.setFeature('nextWaiting', false);
assert.equal(app.slot(), undefined, 'off: no button slot'); assert.equal(registered.length, 0, 'off: no shortcut');
assert.equal(statusLs.size + listLs.size, 0, 'off: no subscriptions'); assert.equal(app.fibers.length, 0, 'off: its scopes are gone');
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { nextWaiting: false }, 'the choice is kept');
app.setFeature('nextWaiting', true); assert.ok(app.slot() && registered.length === 1, 'on again: both come back');
app.setFeature('nextWaiting', false); app.setFeature('nextWaiting', true); assert.equal(registered.length, 1, 'off and on: one command, not two');
// dsh without the shortcuts service: the button works, no error.
registered.length = 0; mem.clear();
app = boot(false);
assert.ok(app.slot(), 'no shortcuts service: the button slot still comes'); assert.equal(registered.length, 0);
pub(new Map([['a', st(ask('approval', 'qa3'))]])); opened.length = 0; app.slot()[0].inject().open(); assert.deepEqual(opened, ['a']);
console.log('next-waiting checks passed');
