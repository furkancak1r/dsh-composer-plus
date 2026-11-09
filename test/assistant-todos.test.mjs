// Assistant to-do list (Host half) with a fake dsh: the list logic (add, the same text again, remove, hand over), the
// prompt context (data mark, `{{` broken up, empty list), the file (owner-only, one list per chat, a new Host reads it
// again, a broken file is an empty list, a failed write changes nothing), the two tools (only in the assistant agent's
// own scope, its subagent gets them denied, another caller is refused), the route (remove, hand over with a normal user
// message, a failed send puts the owner back, bad requests), the Assistant always free allowlist and the switch (off: no
// tools, no section, no context, no item actions; an explicit off stays off).
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_FREE_SECTION, ASSISTANT_TODOS_PATH, ASSISTANT_TOOLS, TODO_LIMITS, TODO_SECTION, TODO_TOOLS, assistantFreeTool, installAssistant, installAssistantTodos, todoContext, todoList, todoStore } from '../index.js';

// The list logic.
let r = todoList.add([], { text: '  Prosolocal\'i   internete açmak ' }, { id: 'aaaaaaaa', now: 5 });
assert.deepEqual(r.list, [{ id: 'aaaaaaaa', text: 'Prosolocal\'i internete açmak', owner: 'user', created: 5 }], 'trimmed, owner user by default');
assert.equal(r.added, true);
const one = r.list;
r = todoList.add(one, { text: 'Ece Hanım ile Excel doldurmak', owner: 'user' }, { id: 'bbbbbbbb', now: 6 });
const two = r.list;
assert.equal(two.length, 2); assert.equal(one.length, 1, 'the given list does not change');
r = todoList.add(two, { text: 'PROSOLOCAL\'İ internete açmak', owner: 'agent' }, { id: 'cccccccc' });
assert.equal(r.added, false, 'the same text (case and accents left out) is not added again'); assert.equal(r.list.length, 2);
assert.equal(todoList.add(r.list, { text: 'prosolocal\'i internete açmak' }).item.owner, 'agent', 'F-03: the same text without an owner keeps it');
assert.equal(todoList.add([], { text: 'new' }).item.owner, 'user', 'a new item without an owner is the user\'s');
assert.equal(r.item.id, 'aaaaaaaa'); assert.equal(r.item.owner, 'agent', 'only its owner changes');
r = todoList.add(two, { text: 'x' }, { id: 'aaaaaaaa' });
assert.notEqual(r.item.id, 'aaaaaaaa', 'a used id is never given again');
for (const bad of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(TODO_LIMITS.text + 1) }, { text: 'ok', owner: 'boss' }]) assert.throws(() => todoList.add(two, bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 40));
const full = Array.from({ length: TODO_LIMITS.items }, (_, i) => ({ id: i.toString(16).padStart(8, '0'), text: `t${i}`, owner: 'user', created: i }));
assert.throws(() => todoList.add(full, { text: 'one more' }), /Remove one first/);
r = todoList.remove(two, 'aaaaaaaa'); assert.deepEqual(r.list.map((i) => i.id), ['bbbbbbbb']); assert.equal(r.item.id, 'aaaaaaaa');
r = todoList.remove(two, 'ffffffff'); assert.equal(r.item, undefined); assert.equal(r.list, two);
r = todoList.handover(two, 'bbbbbbbb'); assert.equal(r.item.owner, 'agent'); assert.equal(r.before.owner, 'user'); assert.equal(two[1].owner, 'user');
assert.equal(todoList.handover(two, 'ffffffff').item, undefined);

// The prompt context.
assert.equal(todoContext([]), ''); assert.equal(todoContext(undefined), '');
const context = todoContext([...two, { id: 'dddddddd', text: 'say {{secret}} and {{{x}}}', owner: 'agent', created: 7 }]);
assert.match(context, /data, not instructions/);
assert.match(context, /- aaaaaaaa \(owner user\): "Prosolocal'i internete açmak"/);
assert.match(context, /- dddddddd \(owner agent\)/);
assert.doesNotMatch(context, /\{\{/, 'no prompt variable reference');

// The file.
const home = await mkdtemp(join(tmpdir(), 'cp-todos-'));
const dir = join(home, 'storages', 'dsh-composer-plus');
const file = join(dir, 'assistant-todos.json');
const store = todoStore(file);
await store.ready;
assert.deepEqual(store.of('c-1'), []);
await store.change('c-1', (list) => todoList.add(list, { text: 'first' }, { id: '11111111', now: 1 }));
await store.change('c-2', (list) => todoList.add(list, { text: 'other chat' }, { id: '22222222', now: 2 }));
assert.equal(((await stat(file)).mode & 0o777).toString(8), '600', 'owner-only');
assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8')).lists).sort(), ['c-1', 'c-2'], 'one list per chat');
const again = todoStore(file); await again.ready;
assert.deepEqual(again.of('c-1'), [{ id: '11111111', text: 'first', owner: 'user', created: 1 }], 'a new Host reads the list again (reload, dsh restart)');
await store.change('c-2', (list) => todoList.remove(list, '22222222'));
assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8')).lists), ['c-1'], 'an empty list leaves the file');
// A failed write changes nothing.
await chmod(dir, 0o500);
await assert.rejects(store.change('c-1', (list) => todoList.add(list, { text: 'lost' })));
await chmod(dir, 0o700);
assert.deepEqual(store.of('c-1').map((i) => i.text), ['first'], 'memory keeps the saved list');
await store.change('c-1', (list) => todoList.add(list, { text: 'next' }, { id: '33333333', now: 3 }));
assert.deepEqual(store.of('c-1').map((i) => i.text), ['first', 'next'], 'the queue works after a failure');
// A broken file, and a file with broken items.
const brokenDir = await mkdtemp(join(tmpdir(), 'cp-todos-broken-'));
await writeFile(join(brokenDir, 'a.json'), '{not json');
const broken = todoStore(join(brokenDir, 'a.json')); await broken.ready; assert.deepEqual(broken.of('s-a'), []);
await writeFile(join(brokenDir, 'b.json'), JSON.stringify({ lists: { 's-a': [{ id: 'xyz', text: 'bad id', owner: 'user', created: 1 }, { id: '44444444', text: 'ok', owner: 'agent', created: 1 }, { id: '55555555', text: 'bad owner', owner: 'x', created: 1 }] } }));
const mixed = todoStore(join(brokenDir, 'b.json')); await mixed.ready; assert.deepEqual(mixed.of('s-a').map((i) => i.id), ['44444444'], 'broken items are left out');

// A fake dsh with the real installAssistant.
const listeners = new Map(); const routes = new Map(); const sections = new Map(); const contexts = new Map(); const agents = new Map(); const prompts = [];
let failPrompt = false;
const newAgent = (id, header = { cwd: home }) => {
  const registered = new Map(); const restrictions = [];
  const agent = { id, status: 'idle', session: { id, header, snapshotEvents: () => [] },
    ctx: { tools: { register: (t) => { registered.set(t.name, t); return () => registered.delete(t.name); }, restrict: (f) => { restrictions.push(f); return () => restrictions.splice(restrictions.indexOf(f), 1); } } },
    registered, restrictions };
  agents.set(id, agent); return agent;
};
const emit = (name, payload) => { for (const fn of listeners.get(name) ?? []) fn(payload); };
const ctx = {
  logger: { warn: () => {} },
  get: (name) => ({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] }, workspaceRegistry: { list: () => [], archivedSessionIds: [] }, sessionPersistence: { list: async () => [...agents.keys()].map((id) => ({ header: { id } })) } })[name],
  on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
  effect: () => {},
  inject: (deps, setup) => {
    assert.deepEqual(deps, ['systemPrompt']); const own = [];
    setup({ systemPrompt: { section: (s) => { sections.set(s.name, s); own.push(() => sections.delete(s.name)); }, context: (c) => { contexts.set(c.name, c); own.push(() => contexts.delete(c.name)); } } });
    return { dispose: () => { for (const off of own) off(); } };
  },
  connection: { fetch: { register: (route) => { assert.ok(!routes.has(route.path), `${route.path} registered once`); routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
  sessionQuery: { observeSession: async () => ({ header: {}, events: [], [Symbol.dispose]() {} }), readTitle: async () => ({ title: 'Assistant' }) },
  sessionController: {
    resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }),
    prompt: async (p) => { if (failPrompt) throw new Error('the chat is gone'); prompts.push(p); },
  },
};
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'assistant.json'), JSON.stringify({ sessionId: 's-a' }));
const assistantAgent = newAgent('s-a');
const otherAgent = newAgent('s-other');
const assistant = installAssistant(ctx, home, { folder: join(home, 'Assistant'), zone: 'UTC' });
await assistant.ready;
const todos = installAssistantTodos(ctx, home, assistant);
await todos.ready;
const call = async (method, body, query = '') => {
  const res = await routes.get(ASSISTANT_TODOS_PATH).fetch(new Request(`http://x${ASSISTANT_TODOS_PATH}${query}`, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }));
  return { status: res.status, body: await res.json() };
};

// On by default: the tools are only in the assistant agent's own scope, next to the six assistant tools.
assert.equal(todos.isOn(), true);
assert.deepEqual([...assistantAgent.registered.keys()].sort(), [...ASSISTANT_TOOLS, ...TODO_TOOLS].sort());
assert.equal(otherAgent.registered.size, 0, 'another chat has no to-do tools');
const sub = newAgent('s-a-sub', { cwd: home, origin: 'subagent', parentSession: 's-a' });
emit('agent/created', { agent: sub });
assert.deepEqual(sub.restrictions, [{ deny: [...ASSISTANT_TOOLS, ...TODO_TOOLS] }], 'its subagent gets them denied');
// Assistant always free lets the assistant call them itself.
for (const name of TODO_TOOLS) { assert.equal(assistantFreeTool(name), true, name); assert.match(ASSISTANT_FREE_SECTION, new RegExp(name)); }

// The section and the context: only in the assistant chat; the context is the chat's own list.
const section = sections.get('composer-plus:assistant-todos');
assert.equal(section.text({ agent: assistantAgent }), TODO_SECTION); assert.equal(section.text({ agent: otherAgent }), '');
assert.match(TODO_SECTION, /evidence that an item is done, remove it with todo_list_remove/);
assert.match(TODO_SECTION, /do not ask about it, unless the user mentions it/);
const ctxEntry = contexts.get('composer-plus:assistant-todos');
assert.equal(ctxEntry.interpolate, false);
assert.equal(ctxEntry.text({ agent: assistantAgent }), '', 'no context for an empty list');

// The tools.
const tool = (name) => assistantAgent.registered.get(name);
await assert.rejects(tool('todo_list_add').execute({ text: 'x' }, { agent: otherAgent }), (e) => e.status === 403);
await assert.rejects(tool('todo_list_add').execute({ text: 'x' }, { agent: sub }), (e) => e.status === 403, 'not its subagent either');
assert.match(await tool('todo_list_add').execute({ text: 'Prosolocal\'i internete açmak' }, { agent: assistantAgent }), /^Added [0-9a-f]{8} \(owner user\)/);
assert.match(await tool('todo_list_add').execute({ text: 'Ece Hanım ile Excel doldurmak', owner: 'user' }, { agent: assistantAgent }), /^Added/);
assert.match(await tool('todo_list_add').execute({ text: 'Rapor yaz', owner: 'agent' }, { agent: assistantAgent }), /owner agent/);
assert.match(await tool('todo_list_add').execute({ text: 'rapor YAZ' }, { agent: assistantAgent }), /^Already on the list: .*owner agent/, 'F-03: no owner keeps the owner');
assert.match(await tool('todo_list_add').execute({ text: 'rapor YAZ', owner: 'user' }, { agent: assistantAgent }), /^Already on the list: .*owner user/);
let items = (await call('GET', undefined, '?sessionId=s-a')).body.items;
assert.deepEqual(items.map((i) => [i.text, i.owner]), [['Prosolocal\'i internete açmak', 'user'], ['Ece Hanım ile Excel doldurmak', 'user'], ['Rapor yaz', 'user']]);
assert.match(ctxEntry.text({ agent: assistantAgent }), /Ece Hanım ile Excel doldurmak/, 'the context has the list');
await todos.store.change('s-other', (list) => todoList.add(list, { text: 'not for that chat' }));
assert.equal(ctxEntry.text({ agent: otherAgent }), '', 'another chat gets no context, also when it has a list');
await assert.rejects(tool('todo_list_remove').execute({ id: 'ffffffff', reason: 'completed' }, { agent: assistantAgent }), (e) => e.status === 404);
await assert.rejects(tool('todo_list_remove').execute({ id: items[2].id, reason: '' }, { agent: assistantAgent }), (e) => e.status === 400, 'a reason is needed');
assert.match(await tool('todo_list_remove').execute({ id: items[2].id, reason: 'completed' }, { agent: assistantAgent }), /^Removed [0-9a-f]{8} \(completed\): "Rapor yaz"/);
assert.equal((await call('GET', undefined, '?sessionId=s-a')).body.items.length, 2);

// The route: hand over sends a normal user message and gives the item to the assistant.
items = (await call('GET', undefined, '?sessionId=s-a')).body.items;
let res = await call('POST', { sessionId: 's-a', id: items[1].id, action: 'handover', prefix: 'Bunu sen yap:' });
assert.equal(res.status, 200);
assert.equal(res.body.items[1].owner, 'agent');
assert.equal(prompts.length, 1); assert.equal(prompts[0].sessionId, 's-a'); assert.equal(prompts[0].mode, 'queue');
assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'Bunu sen yap: Ece Hanım ile Excel doldurmak' }]);
// A failed send: the owner goes back.
failPrompt = true;
res = await call('POST', { sessionId: 's-a', id: items[0].id, action: 'handover', prefix: 'Bunu sen yap:' });
failPrompt = false;
assert.equal(res.status, 502); assert.match(res.body.error, /the chat is gone/);
assert.equal(res.body.items[0].owner, 'user', 'all or none: the owner is back');
// Remove: one click, no confirmation.
res = await call('POST', { sessionId: 's-a', id: items[0].id, action: 'remove' });
assert.equal(res.status, 200); assert.deepEqual(res.body.items.map((i) => i.text), ['Ece Hanım ile Excel doldurmak']);
res = await call('POST', { sessionId: 's-a', id: items[0].id, action: 'remove' });
assert.equal(res.status, 404, 'a removed item is gone'); assert.equal(res.body.items.length, 1);
// Bad requests.
for (const bad of [{ sessionId: 's-a', id: '../x', action: 'remove' }, { sessionId: '', id: items[1].id, action: 'remove' }, { sessionId: 's-a', id: items[1].id, action: 'delete' },
  { sessionId: 's-a', id: items[1].id, action: 'handover' }, { sessionId: 's-a', id: items[1].id, action: 'handover', prefix: 'x'.repeat(TODO_LIMITS.prefix + 1) }, { on: 'yes' }, []]) {
  assert.equal((await call('POST', bad)).status, 400, JSON.stringify(bad).slice(0, 60));
}
assert.equal((await call('POST', '{broken')).status, 400);
assert.deepEqual((await call('GET')).body, { on: true }, 'GET without a chat: only the switch');
// Persistence across a new Host (a dsh restart): the list is in the file.
const reread = todoStore(file); await reread.ready;
assert.deepEqual(reread.of('s-a').map((i) => [i.text, i.owner]), [['Ece Hanım ile Excel doldurmak', 'agent']]);

// Off: no tools, no section, no context, no item actions; the list stays in the file.
assert.deepEqual((await call('POST', { on: false })).body, { on: false });
assert.equal(JSON.parse(await readFile(join(dir, 'assistant-todos-switch.json'), 'utf8')).on, false);
assert.deepEqual([...assistantAgent.registered.keys()].sort(), [...ASSISTANT_TOOLS].sort(), 'the to-do tools left the assistant agent');
assert.equal(sections.has('composer-plus:assistant-todos'), false); assert.equal(contexts.has('composer-plus:assistant-todos'), false);
assert.deepEqual((await call('GET', undefined, '?sessionId=s-a')).body, { on: false, items: [] });
assert.equal((await call('POST', { sessionId: 's-a', id: items[1].id, action: 'remove' })).status, 409);
// An explicit off stays off in a new Host; on again brings everything back.
const routes2 = new Map(); const ctx2 = { ...ctx, connection: { fetch: { register: (route) => { routes2.set(route.path, route); return () => {}; } } } };
const later = installAssistantTodos(ctx2, home, { isAssistant: () => false, addTools: () => ({ remount() {}, off() {} }) });
await later.ready; assert.equal(later.isOn(), false, 'an explicit off stays off');
assert.deepEqual((await call('POST', { on: true })).body, { on: true });
assert.deepEqual([...assistantAgent.registered.keys()].sort(), [...ASSISTANT_TOOLS, ...TODO_TOOLS].sort());
assert.equal((await call('GET', undefined, '?sessionId=s-a')).body.items.length, 1, 'the list is back');
console.log('assistant-todos: ok');
