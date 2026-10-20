// Turn rollback and Delete chat, client half: the two stores (one action per chat at a time in every entry point, errors
// kept, a missing route asks for a restart), the hidden-span check, the menu item (none for a subagent chat) and the
// feature switches (Turn rollback is a Host switch; each one adds its slots and removes them all again).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
eval(src.replace('const ROLLBACK_ROUTE = ', 'globalThis.__rb = () => ({ createRollback, createDeleteChat, inSpans, DeleteChatItem });\n    const ROLLBACK_ROUTE = '));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect() {}, useSyncExternalStore: (s, g) => g() };
const posted = [];
let answer = () => ({ status: 200, body: { on: true } });
globalThis.fetch = async (url, init) => { const body = init?.body === undefined ? undefined : JSON.parse(init.body); posted.push([url, body]); const r = answer(url, body); return { ok: r.status < 400, status: r.status, json: async () => r.body }; };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', MenuItemButton: 'MenuItemButton', Modal: 'Modal', Button: 'Button' } : {}));
const { createRollback, createDeleteChat, inSpans, DeleteChatItem } = globalThis.__rb();
const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });

// 1. Hidden spans: [first withdrawn seq, marker seq], inclusive.
assert.equal(inSpans([[9, 20]], 9), true); assert.equal(inSpans([[9, 20]], 20), true); assert.equal(inSpans([[9, 20]], 8), false);
assert.equal(inSpans([[9, 20]], 23.9), false); assert.equal(inSpans([[9, 20], [22, 30]], 23.9), true, 'turn chrome has fractional anchors');
assert.equal(inSpans([[9, 20]], undefined), false);

// 2. Rollback store: one rollback per chat at a time; the span is kept for hiding; a failure keeps the reason.
{
  const calls = []; let g = gate();
  const store = createRollback(async (init, query) => { calls.push([init?.body === undefined ? undefined : JSON.parse(init.body), query]); await g.p; return reply(200, { span: [9, 20], text: 'second', markerSeq: 20 }); });
  let changes = 0; store.subscribe(() => changes++);
  const first = store.run('chat-a', 9, true);
  assert.equal(store.of('chat-a').busy, true);
  // A refused call answers at once; without the guard it would wait on the gate (the race makes that a failure, not a hang).
  assert.equal(await Promise.race([store.run('chat-a', 3, false), new Promise((r) => setTimeout(() => r('waited'), 200))]), undefined, 'a second rollback of the same chat is refused while one runs');
  const other = store.run('chat-b', 4, false); // another chat may roll back at the same time
  assert.equal(store.of('chat-b').busy, true);
  g.go();
  const done = await first; await other;
  assert.deepEqual(done, { span: [9, 20], text: 'second', markerSeq: 20 });
  assert.deepEqual(calls.map((c) => c[0]), [{ sessionId: 'chat-a', seq: 9, files: true }, { sessionId: 'chat-b', seq: 4, files: false }]);
  assert.deepEqual(store.of('chat-a'), { spans: [[9, 20]], rewind: false, busy: false, error: null });
  assert.ok(changes >= 3);
  g = gate(); g.go();
  const failing = createRollback(async () => reply(409, { error: 'the running turn did not stop' }));
  assert.equal(await failing.run('chat-a', 9, false), undefined);
  assert.equal(failing.of('chat-a').error, 'the running turn did not stop'); assert.equal(failing.of('chat-a').busy, false);
  const old = createRollback(async () => reply(404, {}));
  await old.run('chat-a', 9, false);
  assert.match(old.of('chat-a').error, /restart dsh/, 'an old Host without the route asks for a restart');
  // load: spans from the log (after a reload) and whether dsh-rewind-plugin owns rollback.
  const loaded = createRollback(async (init, query) => { assert.equal(query, '?sessionId=chat%2Fx'); return reply(200, { on: true, rewind: true, spans: [[3, 7]] }); });
  await loaded.load('chat/x');
  assert.deepEqual(loaded.of('chat/x').spans, [[3, 7]]); assert.equal(loaded.of('chat/x').rewind, true);
  const preview = createRollback(async (init) => reply(200, { git: true, snapshot: true, files: [{ path: 'a.js', action: 'restore' }], echo: JSON.parse(init.body) }));
  assert.deepEqual((await preview.preview('chat-a', 9)).echo, { sessionId: 'chat-a', seq: 9, preview: true });
}

// 3. Delete store: the dialog opens per chat; confirm runs once (button, Enter, double click); close is blocked meanwhile.
{
  const calls = []; let g = gate();
  const store = createDeleteChat(async (body) => { calls.push(body); await g.p; return reply(200, { deleted: true }); });
  assert.equal(await store.confirm(), false, 'nothing to confirm before the dialog opens');
  store.ask('chat-a', 'Weekend menu');
  assert.deepEqual(store.getSnapshot().request, { sessionId: 'chat-a', title: 'Weekend menu' });
  const first = store.confirm();
  assert.equal(await store.confirm(), false, 'a second confirm while one runs does nothing');
  store.close(); store.ask('chat-b', 'Other');
  assert.equal(store.getSnapshot().request.sessionId, 'chat-a', 'the dialog stays on its chat while the delete runs');
  g.go(); assert.equal(await first, true);
  assert.deepEqual(calls, [{ sessionId: 'chat-a' }]);
  assert.deepEqual(store.getSnapshot(), { request: null, busy: false, error: null });
  const failing = createDeleteChat(async () => reply(409, { error: 'another dsh has this chat open; it stays archived' }));
  failing.ask('chat-a', 'x'); assert.equal(await failing.confirm(), false);
  assert.equal(failing.getSnapshot().error, 'another dsh has this chat open; it stays archived');
  assert.equal(failing.getSnapshot().request.sessionId, 'chat-a', 'the dialog stays open with the reason');
  failing.close(); assert.equal(failing.getSnapshot().request, null);
  const old = createDeleteChat(async () => reply(404, {}));
  old.ask('chat-a', 'x'); await old.confirm(); assert.match(old.getSnapshot().error, /restart dsh/);
}

// 4. Menu item: none for a subagent chat; the row opens the dialog and closes the menu.
{
  const asked = []; const menu = [];
  const deleteChat = { ask: (id, title) => asked.push([id, title]) };
  const props = { sessionId: 'chat-a', useMenuOpenState: () => [true, (v) => menu.push(v)], deleteChat, titleOf: () => 'Weekend menu', t: (k) => k };
  assert.equal(DeleteChatItem({ ...props, isSubagent: () => true }), null);
  const item = DeleteChatItem({ ...props, isSubagent: () => false });
  assert.equal(item.t, 'MenuItemButton');
  item.p.onSelect();
  assert.deepEqual(menu, [false]); assert.deepEqual(asked, [['chat-a', 'Weekend menu']]);
}

// 5. Feature switches: both on by default; Turn rollback moves its Host switch; each switch adds and removes its slots.
{
  let next = 0; const live = new Map();
  const slots = { inject: (name, f) => { const off = f(); return () => off(); }, register: (o) => { const k = `${o.name}#${o.id ?? o.key}#${next++}`; live.set(k, o); return () => live.delete(k); } };
  const ctx = { slots, configForms: { get: () => ({}) }, effect: () => {}, locale: { register: () => () => {}, bind: () => (k) => k, getLocale: () => ({ active: 'en', locales: [] }) },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } }, get: () => undefined, inject: () => ({ dispose() {} }) };
  answer = (url, body) => (url.startsWith('/api/composer-plus.rollback') ? { status: 200, body: { on: body?.on ?? true } } : { status: 200, body: { on: false } });
  plugin.apply(ctx);
  await new Promise((r) => setTimeout(r, 0));
  const ids = () => [...live.values()].map((o) => o.id);
  assert.ok(ids().includes('turn-rollback'), 'Turn rollback is on by default');
  assert.ok(ids().includes('delete-chat') && ids().includes('delete-chat-dialog'), 'Delete chat is on by default');
  const settings = [...live.values()].find((o) => o.id === 'composer-plus');
  posted.length = 0;
  await settings.inject().setFeature('turnRollback', false);
  assert.deepEqual(posted, [['/api/composer-plus.rollback', { on: false }]], 'the Host keeps the Turn rollback switch');
  assert.ok(!ids().includes('turn-rollback'), 'switched off: the header slot goes away');
  settings.inject().setFeature('deleteChat', false);
  assert.ok(!ids().includes('delete-chat') && !ids().includes('delete-chat-dialog'), 'switched off: the menu item and the dialog go away');
  await settings.inject().setFeature('turnRollback', true); settings.inject().setFeature('deleteChat', true);
  assert.ok(ids().includes('turn-rollback') && ids().includes('delete-chat'), 'switching on again reinstalls');
  const menuItem = [...live.values()].find((o) => o.id === 'delete-chat');
  assert.equal(menuItem.order, 410, 'right after dsh\'s own Archive (400)');
}
console.log('turn-rollback client checks passed');
