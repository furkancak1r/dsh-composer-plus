// Branches in the workspace tree (client half): `watchBranchTree` asks the Host for a sync on window focus (at most every
// 5 s), opens the copy of the open chat when the Host says that it moved, ignores other archived chats, and removes its
// listeners when the feature goes off. The feature is off by default and its switch lives in the Host.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const listeners = new Map();
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } },
  addEventListener: (n, fn) => { listeners.set(n, fn); }, removeEventListener: (n, fn) => { if (listeners.get(n) === fn) listeners.delete(n); } };
let selected; // the sidebar row with aria-selected="true"
globalThis.document = { documentElement: { lang: 'en' }, addEventListener() {}, removeEventListener() {},
  querySelector: (sel) => (sel.includes('aria-selected') && selected !== undefined ? { getAttribute: () => `session:${selected}` } : null) };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__bt = { watchBranchTree, BRANCH_TREE_ROUTE, get FEATURES() { return FEATURES; }, get OFF_BY_DEFAULT() { return OFF_BY_DEFAULT; }, get SHOT_OF() { return SHOT_OF; } };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const { watchBranchTree, BRANCH_TREE_ROUTE, FEATURES, OFF_BY_DEFAULT, SHOT_OF } = globalThis.__bt;
const tick = () => new Promise((r) => setTimeout(r, 0));

assert.ok(FEATURES.includes('branchTree') && OFF_BY_DEFAULT.includes('branchTree'), 'its own switch, off by default');
assert.equal(SHOT_OF.branchTree, 'branchTree');

const sent = [];
let answer = {};
globalThis.fetch = async (url, init) => { sent.push([url, init?.method ?? 'GET', init?.body]); return { ok: true, status: 200, json: async () => answer }; };
let snapshot = { archivedSessionIds: ['old'] }; const subs = new Set();
const workspaces = { list: { getSnapshot: () => snapshot, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } } };
const opened = [];
const ui = { openSession: (id) => opened.push(id) };
const realNow = Date.now; let now = 100000; Date.now = () => now;
const off = watchBranchTree(ui, workspaces);

// Focus: one sync, then nothing for 5 s.
listeners.get('focus')(); listeners.get('focus')();
assert.deepEqual(sent, [[BRANCH_TREE_ROUTE, 'POST', '{"sync":true}']], 'one sync per focus burst');
now += 5001; listeners.get('focus')(); assert.equal(sent.length, 2, 'again after 5 s');
sent.length = 0;

// Another chat is archived while chat-1 is open: no question.
selected = 'chat-1';
snapshot = { archivedSessionIds: ['old', 'chat-9'] }; for (const fn of subs) fn(); await tick();
assert.equal(sent.length, 0, 'an archived chat that is not open asks nothing');
// The open chat is archived and the Host says that it moved: the copy opens.
answer = { on: true, moved: 'chat-1-copy' };
snapshot = { archivedSessionIds: ['old', 'chat-9', 'chat-1'] }; for (const fn of subs) fn(); await tick(); await tick();
assert.deepEqual(sent, [[`${BRANCH_TREE_ROUTE}?moved=chat-1`, 'GET', undefined]]);
assert.deepEqual(opened, ['chat-1-copy'], 'the copy opens');
// An archive that did not move (Host has no copy): nothing opens.
sent.length = 0; answer = { on: true }; selected = 'chat-2';
snapshot = { archivedSessionIds: ['old', 'chat-9', 'chat-1', 'chat-2'] }; for (const fn of subs) fn(); await tick(); await tick();
assert.equal(sent.length, 1); assert.deepEqual(opened, ['chat-1-copy'], 'a plain archive opens nothing');

// Off: listeners and the store subscription go.
off();
assert.equal(listeners.has('focus'), false, 'focus listener removed');
assert.equal(subs.size, 0, 'store subscription removed');
Date.now = realNow;
console.log('branch tree client checks passed');
