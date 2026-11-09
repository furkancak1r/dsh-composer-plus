// Tether's green dots and dsh's own stay the same, both ways, while Mobile connect is on. The real client.js reports each
// chat that dsh shows as read in this window to the Host (POST /api/composer-plus.unread), gives the Host dsh's dots that
// it does not have (`add`), and clears dsh's dot of a chat that a phone read (the Host's list lost it). Off: nothing.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
let mobileOn = false, hostUnread = [], failPost = false, duringGet;
const posts = [], gets = [];
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async (url, init) => {
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
  if (url === '/api/composer-plus.mobile') { if (init?.method === 'POST') mobileOn = JSON.parse(init.body).on; return json({ on: mobileOn, available: true, running: mobileOn }); }
  if (url === '/api/composer-plus.unread') {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body); posts.push(body);
      if (failPost) throw new TypeError('network');
      hostUnread = [...hostUnread.filter((id) => !(body.sessionIds ?? []).includes(id)), ...(body.add ?? []).filter((id) => !hostUnread.includes(id))];
    } else { gets.push(1); const hook = duringGet; duringGet = undefined; hook?.(); }
    return json({ on: mobileOn, unread: mobileOn ? hostUnread : [] });
  }
  return json({}, 404);
};
// The watcher's 3 s check runs only when this test calls it.
const intervals = new Map(); let nextTimer = 1;
globalThis.setInterval = (f) => { const id = nextTimer++; intervals.set(id, f); return id; };
globalThis.clearInterval = (id) => { intervals.delete(id); };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { hasFocus: () => true };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: () => ({}), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: () => ({}) } : {}));

// Fake dsh UiSession: `completionUnread` (dsh's dots) and `running`, published as Session status like dsh does.
const running = new Map(); const dots = new Set();
let snap = new Map(); const statusListeners = new Set();
const status = { getSnapshot: () => snap, subscribe: (l) => { statusListeners.add(l); return () => statusListeners.delete(l); } };
let listSnap = { phase: 'pending', byId: {} }; const listListeners = new Set();
// As dsh's UiSession.publishStatus: every listed chat, every running state and every dot.
const publishStatus = () => {
  snap = new Map([...new Set([...Object.keys(listSnap.byId), ...running.keys(), ...dots])].map((id) => [id, { running: running.get(id), pendingInteraction: undefined, completionUnread: dots.has(id) }]));
  for (const l of [...statusListeners]) l();
};
const uiSession = { sessionStatus: status, completionUnread: dots, publishStatus };
const list = { getSnapshot: () => listSnap, subscribe: (l) => { listListeners.add(l); return () => listListeners.delete(l); } };
// dsh's UiSession listens to the list before any plugin, so the status is new when the watcher hears of the list.
const setList = (v) => { listSnap = v; publishStatus(); for (const l of [...listListeners]) l(); };
const watcherChecks = () => [...intervals.values()];
const check = async () => { for (const f of watcherChecks()) f(); await settle(); };

const fibers = []; let settings;
const ctx = { effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => { const off = f(); return () => off?.(); }, register: (o) => { if (o.id === 'composer-plus') settings = o; return () => {}; } },
  inject: (deps, setup) => {
    const offs = [];
    const fiber = { deps, offs, dispose: () => { for (const off of offs.splice(0)) off?.(); fibers.splice(fibers.indexOf(fiber), 1); } };
    if (deps.includes('uiSession') && deps.includes('sessions') && deps.length === 2) { fibers.push(fiber); setup({ uiSession, sessions: { list }, effect: (f) => offs.push(f()) }); }
    return fiber;
  } };
plugin.apply(ctx);
await settle();
const watching = () => fibers.filter((f) => f.deps.length === 2).length;
const intervalsOff = intervals.size;
assert.equal(watching(), 0, 'Mobile connect off: no read watcher');
dots.add('a'); publishStatus(); dots.delete('a'); publishStatus();
assert.deepEqual(posts, [], 'off: nothing goes to the Host');

// Switch Mobile connect on in Settings: the watcher starts with one 3 s check.
await settings.inject().setFeature('mobileConnect', true);
await settle();
assert.equal(watching(), 1, 'on: one read watcher');
assert.equal(intervals.size, intervalsOff + 1, 'on: one 3 s check');
assert.equal(gets.length, 0, 'the list is not ready yet: no check');

// The chat list gets ready. The Host has seen/dot/busy/unknown; dsh shows a dot on "dot" and on "local" (a dot from
// before Mobile connect was on, which the Host does not have), "busy" runs and "seen" is idle without a dot.
hostUnread = ['seen', 'dot', 'busy', 'unknown'];
running.set('seen', false); running.set('busy', true); dots.add('dot'); dots.add('local'); running.set('kid', false); publishStatus();
setList({ phase: 'ready', byId: { seen: {}, dot: {}, busy: {}, local: {}, kid: { origin: 'subagent' } } });
await settle();
assert.equal(gets.length, 1, 'the Host list is read once the chat list is ready');
assert.deepEqual(posts, [{ add: ['local'] }], 'first check: dsh\'s dot that the Host does not have goes to it; nothing is read yet');
setList({ ...listSnap });
await settle();
assert.equal(gets.length, 1, 'a list change after the first check does not check again');
// Next check: "seen" is still on the Host and still without a dot in dsh, so it is read; the rest stays.
posts.length = 0;
await check();
assert.deepEqual(posts, [{ sessionIds: ['seen'] }], 'idle without a dot in two checks: read');
assert.deepEqual(hostUnread.sort(), ['busy', 'dot', 'local', 'unknown']);

// THE BUG (2026-11-09): Tether showed 8 unread chats, dsh showed 0. A chat read on the phone must lose dsh's dot too, and
// a chat read in dsh must leave the Host's list (and so the phone's count).
posts.length = 0;
hostUnread = hostUnread.filter((id) => id !== 'dot'); // the phone opened "dot"
await check();
assert.equal(dots.has('dot'), false, 'read on the phone: dsh\'s dot goes too');
assert.equal(dots.has('local'), true, 'the other dot stays');
// dsh's own read echo is harmless: the Host already took it off.
assert.ok(posts.every((p) => p.add === undefined), 'nothing is added');

// The dot goes away in dsh (the chat was opened here): read at once.
posts.length = 0;
dots.delete('local'); publishStatus();
assert.deepEqual(posts, [{ sessionIds: ['local'] }]);
// A chat that finishes while it is open: no dot from dsh, so read.
running.set('busy', false); publishStatus();
assert.deepEqual(posts.at(-1), { sessionIds: ['busy'] });
// A chat that finishes in the background: dsh gives it a dot, so it is not read.
posts.length = 0;
running.set('seen', true); publishStatus(); running.set('seen', false); dots.add('seen'); publishStatus();
assert.deepEqual(posts, [], 'a background finish keeps its dot');

// The Host adds a finished turn before dsh's status reaches this window. A phone that reads it before the next check
// (a tap on the Turn finished push) still clears dsh's dot: the Host never had it at a check, but lost it.
hostUnread = ['seen'];
await check();
assert.equal(dots.has('seen'), true, 'on the Host and in dsh: it stays');
posts.length = 0;
hostUnread.push('quick'); running.set('quick', false); dots.add('quick'); setList({ phase: 'ready', byId: { ...listSnap.byId, quick: {} } });
hostUnread = hostUnread.filter((id) => id !== 'quick'); // read on the phone at once
await check();
assert.equal(dots.has('quick'), false, 'read on the phone before the next check: dsh\'s dot goes');
assert.ok(posts.every((p) => p.add === undefined), 'it is not given back to the Host');

// A status change while the check waits for the Host: the check does nothing (a dot that came meanwhile must stay).
hostUnread = []; // a phone reads "seen", and a turn ends in dsh while the next check waits
duringGet = () => { hostUnread.push('other'); running.set('other', false); dots.add('other'); setList({ phase: 'ready', byId: { ...listSnap.byId, other: {} } }); };
await check();
assert.equal(dots.has('seen'), true, 'a check that saw a status change is dropped');
assert.equal(dots.has('other'), true);
await check();
assert.equal(dots.has('seen'), false, 'the next check clears it');
assert.equal(dots.has('other'), true, 'the new turn keeps its dot');

// Mobile connect was off for a time (no list kept): the next check gives dsh's dots to the Host again; a failed `add`
// is sent again at the next check.
mobileOn = false; await check(); mobileOn = true; hostUnread = [];
failPost = true; posts.length = 0;
await check();
assert.deepEqual(posts, [{ add: ['other'] }], 'dsh\'s dot goes to the Host, but the POST fails');
assert.equal(dots.has('other'), true, 'a failed add clears nothing');
failPost = false;
await check();
assert.deepEqual(hostUnread, ['other'], 'sent again: the Host has it');
assert.equal(dots.has('other'), true);

// A read that did not reach the Host is sent again at the next check.
hostUnread.push('gone');
running.set('gone', false); setList({ phase: 'ready', byId: { ...listSnap.byId, gone: {} } });
await check();
failPost = true; posts.length = 0;
await check();
assert.deepEqual(posts.at(-1), { sessionIds: ['gone'] }, 'read, but the POST fails');
failPost = false;
await check();
assert.deepEqual(hostUnread, ['other'], 'sent again: the Host has it');

// Switching Mobile connect off removes the watcher, its listeners and its check.
const before = statusListeners.size;
await settings.inject().setFeature('mobileConnect', false);
await settle();
assert.equal(watching(), 0, 'off: the watcher is gone');
assert.equal(statusListeners.size, before - 1, 'its status listener goes');
assert.equal(listListeners.size, 0, 'its list listener goes');
assert.equal(intervals.size, intervalsOff, 'its 3 s check stops');
console.log('unread-client: dsh and Tether dots stay the same both ways ok');
