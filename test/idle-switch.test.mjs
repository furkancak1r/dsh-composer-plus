// Runs the real client.js "Open waiting chat when idle" with a fake clock, window, document and dsh services: a chat that
// waits for you (question, approval, plan review) opens after 30 s without activity, the longest-waiting one first, once
// per request; typing, a pointer, a menu, text in the field, a waiting chat on screen and a subagent request block it;
// switching the feature off removes its listeners and its timer.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
let now = 1_000_000; Date.now = () => now;
let timers = []; let timerId = 0;
globalThis.setTimeout = (f, ms) => { const t = { id: ++timerId, f, at: now + ms }; timers.push(t); return t.id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
/** Moves the clock and runs every timer that is due, in order. */
const advance = (ms) => {
  const end = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (due === undefined) break;
    timers = timers.filter((t) => t !== due); now = Math.max(now, due.at); due.f();
  }
  now = end;
};
const listeners = new Map();
let mod; globalThis.window = {
  __ModuleLoader__: { load: (m) => { mod = m; } },
  addEventListener: (type, f, o) => { assert.equal(o?.capture, true); listeners.set(type, f); },
  removeEventListener: (type, f, o) => { assert.equal(o?.capture, true); if (listeners.get(type) === f) listeners.delete(type); },
  getSelection: () => ({ isCollapsed: !selected }),
};
let selected = false; let menu = null; let active = null;
globalThis.document = { get activeElement() { return active; }, querySelector: (q) => { assert.match(q, /role="menu"/); return menu; } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const plugin = mod.factory((n) => (n === 'react' ? { createElement: () => ({}) } : {}));

let snap = new Map(); const statusLs = new Set(); const listLs = new Set();
const status = { getSnapshot: () => snap, subscribe: (l) => { statusLs.add(l); return () => statusLs.delete(l); } };
let byId = {};
const list = { getSnapshot: () => ({ byId }), subscribe: (l) => { listLs.add(l); return () => listLs.delete(l); } };
const pub = (m) => { snap = m; for (const l of [...statusLs]) l(); };
const rows = (open = '') => { byId = Object.fromEntries(['a', 'b', 'c', 'sub'].map((id) => [id, { id, origin: id === 'sub' ? 'subagent' : undefined, retainedBy: { mainView: id === open ? 1 : 0 } }])); for (const l of [...listLs]) l(); };
const opened = [];
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
const fibers = []; let setFeature;
plugin.apply({
  slots: { inject: (n, f) => f(), register: (o) => { if (o.id === 'composer-plus') setFeature = o.inject().setFeature; return () => {}; } },
  configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k }, effect: (f) => f(),
  inject: (deps, setup) => {
    const offs = []; const fiber = { dispose: () => { for (const off of offs.splice(0)) off?.(); } };
    if (deps.join() === 'uiWorkspace,uiSession,sessions') { fibers.push(fiber); setup({ uiSession: { sessionStatus: status }, sessions: { list }, uiWorkspace: { openSession: (id) => opened.push(id) }, effect: (f) => offs.push(f()) }); }
    return fiber;
  },
});
assert.equal(fibers.length, 1, 'on by default');
const ask = (kind) => ({ kind, key: `${kind}:${Math.random()}`, answerable: true });
const st = (pendingInteraction) => ({ running: false, pendingInteraction, completionUnread: false });
rows('c');

// A question in a background chat opens it after 30 s without activity.
const q = ask('question');
pub(new Map([['a', st(q)], ['c', st()]]));
advance(29_000); assert.deepEqual(opened, [], 'not before 30 s');
advance(1_000); assert.deepEqual(opened, ['a'], 'opens after 30 s idle');
rows('a'); advance(120_000); assert.deepEqual(opened, ['a'], 'on screen: it does not open again');

// Activity restarts the wait: a key, a pointer move, the wheel.
rows('c'); opened.length = 0; listeners.get('keydown')();
pub(new Map([['b', st(ask('approval'))]]));
for (const type of ['keydown', 'pointermove', 'wheel']) { advance(20_000); listeners.get(type)(); }
advance(29_000); assert.deepEqual(opened, [], 'each event restarts the 30 s');
advance(1_000); assert.deepEqual(opened, ['b']);

// Text in the focused field, a text selection or an open menu at the moment of the switch: wait again.
rows('c'); opened.length = 0; listeners.get('keydown')();
active = { isContentEditable: true, textContent: 'half a sentence' };
pub(new Map([['b', st(ask('plan-review'))]]));
advance(60_000); assert.deepEqual(opened, [], 'a draft in the field blocks it');
active = { isContentEditable: true, textContent: '  ' }; selected = true;
advance(30_000); assert.deepEqual(opened, [], 'a text selection blocks it');
selected = false; menu = {};
advance(30_000); assert.deepEqual(opened, [], 'an open menu blocks it');
menu = null; active = null;
advance(30_000); assert.deepEqual(opened, ['b'], 'then it opens');

// Several waiting chats: the one that waits longest opens first, the next one after its own 30 s idle.
rows('c'); opened.length = 0; listeners.get('keydown')();
const qa = ask('question'); const qb = ask('approval');
pub(new Map([['b', st(qb)]])); advance(5_000);
pub(new Map([['a', st(qa)], ['b', st(qb)]]));
advance(25_000); assert.deepEqual(opened, ['b'], 'longest-waiting first');
rows('b'); advance(120_000); assert.deepEqual(opened, ['b'], 'the opened chat stays while it waits');
listeners.get('pointerdown')(); pub(new Map([['a', st(qa)]])); rows('b');
advance(29_000); assert.deepEqual(opened, ['b']);
advance(1_000); assert.deepEqual(opened, ['b', 'a'], 'you answer it: the next one after another 30 s');

// A waiting chat on screen: nothing moves, also when another chat waits. Leaving it is a click, not a status change:
// the wait starts again, and the chat that still waits longest opens.
opened.length = 0; const qc = ask('question'); const qd = ask('question');
rows('a'); pub(new Map([['a', st(qc)]])); advance(1_000); pub(new Map([['a', st(qc)], ['b', st(qd)]]));
advance(120_000); assert.deepEqual(opened, [], 'never away from a waiting chat on screen');
listeners.get('pointerdown')(); rows('c');
advance(29_000); assert.deepEqual(opened, []);
advance(1_000); assert.deepEqual(opened, ['a'], 'after you leave it unanswered, it opens again (it waits longest)');
rows('a'); advance(120_000); assert.deepEqual(opened, ['a'], 'then it stays: the other one does not replace it');
// You answer it (clicks): the other one opens after the next 30 s idle.
listeners.get('pointerdown')(); pub(new Map([['b', st(qd)]]));
advance(29_000); assert.deepEqual(opened, ['a']);
advance(1_000); assert.deepEqual(opened, ['a', 'b'], 'answered: the next one after 30 s idle');

// Answered within the grace period, not answerable, or asked by a subagent: nothing opens.
pub(new Map()); opened.length = 0; rows('c');
advance(60_000);
pub(new Map([['a', st(ask('approval'))]])); pub(new Map()); advance(60_000);
pub(new Map([['a', st({ ...ask('approval'), answerable: false })]])); advance(60_000);
pub(new Map([['sub', st(ask('question'))]])); advance(60_000);
assert.deepEqual(opened, [], 'auto-answered, settled and subagent requests stay quiet');

// A request that waited through a long idle time still respects the grace period.
pub(new Map([['b', st(ask('question'))]])); advance(1_000); assert.deepEqual(opened, []);
advance(500); assert.deepEqual(opened, ['b'], 'after the 1.5 s grace when you were idle already');

// Switched off: listeners, subscriptions and the timer go; switched on again: they come back.
pub(new Map([['a', st(ask('question'))]])); assert.ok(timers.length > 0 && listeners.size > 0);
setFeature('idleSwitch', false);
assert.equal(listeners.size, 0, 'no window listeners'); assert.equal(statusLs.size + listLs.size, 0, 'no subscriptions'); assert.equal(timers.length, 0, 'no timer');
opened.length = 0; advance(120_000); assert.deepEqual(opened, [], 'off: nothing opens');
setFeature('idleSwitch', true); assert.ok(listeners.size > 0 && statusLs.size === 1);
advance(30_000); assert.deepEqual(opened, ['a'], 'back on');
console.log('idle-switch checks passed');
