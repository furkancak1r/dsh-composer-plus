// Tether's green dots follow dsh's own read state: the real client.js reports each chat that dsh shows as read in this
// window to the Host (POST /api/composer-plus.unread) while Mobile connect is on, and nothing while it is off.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let mobileOn = false, hostUnread = [];
const posts = [], gets = [];
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async (url, init) => {
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
  if (url === '/api/composer-plus.mobile') { if (init?.method === 'POST') mobileOn = JSON.parse(init.body).on; return json({ on: mobileOn, available: true, running: mobileOn }); }
  if (url === '/api/composer-plus.unread') {
    if (init?.method === 'POST') { const ids = JSON.parse(init.body).sessionIds; posts.push(ids); hostUnread = hostUnread.filter((id) => !ids.includes(id)); }
    else gets.push(1);
    return json({ unread: hostUnread });
  }
  return json({}, 404);
};
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { hasFocus: () => true };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: () => ({}), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: () => ({}) } : {}));

// Fake dsh sources: Session status (dsh's dots) and the chat list.
let snap = new Map(); const statusListeners = new Set();
const status = { getSnapshot: () => snap, subscribe: (l) => { statusListeners.add(l); return () => statusListeners.delete(l); } };
const pub = (m) => { snap = m; for (const l of [...statusListeners]) l(); };
let listSnap = { phase: 'pending', byId: {} }; const listListeners = new Set();
const list = { getSnapshot: () => listSnap, subscribe: (l) => { listListeners.add(l); return () => listListeners.delete(l); } };
const setList = (v) => { listSnap = v; for (const l of [...listListeners]) l(); };
const st = (o = {}) => ({ running: false, pendingInteraction: undefined, completionUnread: false, ...o });

const fibers = []; let settings;
const ctx = { effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => { const off = f(); return () => off?.(); }, register: (o) => { if (o.id === 'composer-plus') settings = o; return () => {}; } },
  inject: (deps, setup) => {
    const offs = [];
    const fiber = { deps, offs, dispose: () => { for (const off of offs.splice(0)) off?.(); fibers.splice(fibers.indexOf(fiber), 1); } };
    if (deps.includes('uiSession') && deps.includes('sessions') && deps.length === 2) { fibers.push(fiber); setup({ uiSession: { sessionStatus: status }, sessions: { list }, effect: (f) => offs.push(f()) }); }
    return fiber;
  } };
plugin.apply(ctx);
await tick(); await tick();
const watching = () => fibers.filter((f) => f.deps.length === 2).length;
assert.equal(watching(), 0, 'Mobile connect off: no read watcher');
pub(new Map([['a', st({ completionUnread: true })]])); pub(new Map([['a', st()]]));
assert.deepEqual(posts, [], 'off: nothing goes to the Host');

// Switch Mobile connect on in Settings: the watcher starts.
await settings.inject().setFeature('mobileConnect', true);
await tick();
assert.equal(watching(), 1, 'on: one read watcher');
// The list is not ready yet: no sync.
assert.equal(gets.length, 0);
// The chat list gets ready: one GET; a chat the Host keeps but dsh shows without a dot is read; one with a dot stays.
hostUnread = ['seen', 'dot', 'busy', 'unknown'];
pub(new Map([['seen', st()], ['dot', st({ completionUnread: true })], ['busy', st({ running: true })]]));
setList({ phase: 'ready', byId: { seen: {}, dot: {}, busy: {} } });
await tick(); await tick(); await tick();
assert.ok(gets.length >= 1, 'the Host list is read once the chat list is ready');
assert.deepEqual(posts.at(-1), ['seen'], 'only chats that dsh shows as read here');
const getsAfterSync = gets.length;
setList({ phase: 'ready', byId: { seen: {}, dot: {}, busy: {} } });
await tick();
assert.equal(gets.length, getsAfterSync, 'synced once per watcher');
// The dot goes away (the chat was opened here): read.
posts.length = 0;
pub(new Map([['seen', st()], ['dot', st()], ['busy', st({ running: true })]]));
assert.deepEqual(posts, [['dot']]);
// A chat that finishes while it is open: no dot from dsh, so read.
pub(new Map([['seen', st()], ['dot', st()], ['busy', st()]]));
assert.deepEqual(posts.at(-1), ['busy']);
// A chat that finishes in the background: dsh gives it a dot, so it is not read.
posts.length = 0;
pub(new Map([['seen', st({ running: true })], ['dot', st()], ['busy', st()]]));
pub(new Map([['seen', st({ completionUnread: true })], ['dot', st()], ['busy', st()]]));
assert.deepEqual(posts, [], 'a background finish keeps its dot');

// Switching Mobile connect off removes the watcher and its listeners.
const before = statusListeners.size;
await settings.inject().setFeature('mobileConnect', false);
await tick();
assert.equal(watching(), 0, 'off: the watcher is gone');
assert.equal(statusListeners.size, before - 1, 'its status listener goes');
assert.equal(listListeners.size, 0, 'its list listener goes');
console.log('unread-client: desktop reads reach the Host ok');
