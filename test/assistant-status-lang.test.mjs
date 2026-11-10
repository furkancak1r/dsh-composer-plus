// Assistant status panel in the UI language: the subagents write their result in English (the text that the assistant
// and its subagents exchange is not changed), and the panel shows each task's result line in the UI language.
// - GET ?sessionId=…&lang=tr answers at once: the new lines go to one model call (dsh's default model, no tools) in the
//   background, the answer has no English line for them and `translating: true`; the next read has the translation.
//   The same lines are not sent again (cache by text, also while the call runs); a new line makes one call for it only.
// - lang=en (or no lang): no call, the lines stay.
// - A failed call: the lines are left out (no English line), and the same lines are not sent again.
// - A delegated chat's line (`chat`: project · branch) is not translated.
// - The client sends dsh's UI language with each read of the panel.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_TODOS_PATH, installAssistant, installAssistantTodos, parseStatusLines } from '../index.js';

const NOW = Date.now();
const ev = (seq, type, data, time = NOW - 1000) => ({ seq, type, data, time });
const reply = (seq, text) => ev(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } });
const done = (text) => [ev(0, 'turn/start', {}), reply(1, text), ev(2, 'turn/end', { reason: { kind: 'completed' } })];
const logs = { 'c-1': done('All tests pass.'), 'c-2': done('Found 3 options.') };
const cat = (seq, childId, label) => ev(seq, 'subagent/catalog', { version: 0, childId, childCreatedAt: NOW - 60000 + seq, mode: 'one-shot', label });

// A fake model: it answers a JSON array (each line with "TR:" before it), or fails when `fail` is set.
const calls = []; let fail = false; let hold = false; let release = () => {};
const llm = {
  async prepareCall(route, signal, controls) {
    controls({}, {});
    return { config: {}, async *stream(req) {
      const lines = JSON.parse(req.messages[0].content[0].text);
      calls.push({ route, system: req.system, lines });
      if (hold) { hold = false; await new Promise((r) => { release = r; }); }
      if (fail) { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 500' } } }; return; }
      yield { type: 'text-delta', text: JSON.stringify(lines.map((l) => `TR: ${l}`)) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  },
};

const root = await mkdtemp(join(tmpdir(), 'cp-status-lang-'));
try {
  const home = join(root, 'home'); const dir = join(home, 'storages', 'dsh-composer-plus');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'assistant.json'), JSON.stringify({ sessionId: 's-a' }));
  const agents = new Map(); const routes = new Map();
  const newAgent = (id, header, log = []) => { const a = { id, status: 'idle', session: { id, header, inheritedEventCount: 0, snapshotEvents: () => log }, ctx: { tools: { register: () => () => {}, restrict: () => () => {} } } }; agents.set(id, a); return a; };
  const events = [cat(1, 'c-1', 'Run the tests'), cat(2, 'c-2', 'Find flights')];
  newAgent('s-a', { cwd: home }, events);
  const ctx = {
    logger: { warn: () => {} },
    get: (name) => ({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] }, workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      llm, agentDefaultModel: { currentSelection: () => ({ provider: 'demo', model: 'demo-model' }) } })[name],
    on: () => {}, effect: () => {},
    inject: (deps, setup) => { setup({ systemPrompt: { section: () => {}, context: () => {} } }); return { dispose: () => {} }; },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    sessionQuery: { observeSession: async (id) => ({ header: {}, events: logs[id] ?? [], inheritedEventCount: 0, [Symbol.dispose]() {} }) },
    sessionController: { list: async () => ({ items: [] }), resolveAgent: async (id) => ({ agent: agents.get(id) }), prompt: async () => {} },
  };
  const assistant = installAssistant(ctx, home, { folder: join(home, 'Assistant'), zone: 'UTC' }); await assistant.ready;
  await assistant.tasks.add('s-deleg', { title: 'Fix the login form', project: 'acme-web', branch: 'assistant/fix-login' });
  newAgent('s-deleg', { cwd: '/demo/acme-web' }, [ev(0, 'turn/start', {})]).status = 'running';
  const todos = installAssistantTodos(ctx, home, assistant); await todos.ready;
  const read = async (query) => (await routes.get(ASSISTANT_TODOS_PATH).fetch(new Request(`http://x${ASSISTANT_TODOS_PATH}${query}`))).json();
  const get = async (query) => (await read(query)).tasks;
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const result = (tasks, id) => tasks.find((t) => t.id === id)?.result;

  // English UI (and no lang): no call, the lines stay.
  let tasks = await get('?sessionId=s-a');
  assert.equal(result(tasks, 'c-1'), 'All tests pass.'); assert.equal(calls.length, 0, 'no lang: no call');
  tasks = await get('?sessionId=s-a&lang=en-US');
  assert.equal(result(tasks, 'c-2'), 'Found 3 options.'); assert.equal(calls.length, 0, 'English: no call');

  // Turkish UI: the first read answers at once, with no English line and `translating`; a second read while the call
  // runs makes no second call; after the call, the lines are Turkish.
  hold = true;
  let first = await read('?sessionId=s-a&lang=tr');
  assert.equal(first.translating, true, 'the panel reads again soon');
  assert.equal(result(first.tasks, 'c-1'), undefined, 'no English line while it translates');
  assert.equal(result(first.tasks, 's-deleg'), 'acme-web · assistant/fix-login', 'a delegated chat line stays');
  await read('?sessionId=s-a&lang=tr');
  release(); await settle();
  first = await read('?sessionId=s-a&lang=tr'); tasks = first.tasks;
  assert.equal(first.translating, undefined, 'done: no more reads for it');
  assert.equal(result(tasks, 'c-1'), 'TR: All tests pass.', 'the result line in the UI language');
  assert.equal(result(tasks, 'c-2'), 'TR: Found 3 options.');
  assert.equal(result(tasks, 's-deleg'), 'acme-web · assistant/fix-login', 'a delegated chat line stays');
  assert.equal(tasks.find((t) => t.id === 'c-1').title, 'Run the tests', 'the title stays (the parent writes it in the user\'s language)');
  assert.equal(calls.length, 1, 'one call for all new lines');
  assert.deepEqual(calls[0].route, { provider: 'demo', model: 'demo-model' });
  assert.match(calls[0].system, /into Turkish/);
  assert.deepEqual(calls[0].lines.sort(), ['All tests pass.', 'Found 3 options.']);
  assert.equal(logs['c-1'][1].data.message.content[0].text, 'All tests pass.', 'the subagent\'s own text is not changed');

  // The same lines again (the panel reads every few seconds): no new call.
  await get('?sessionId=s-a&lang=tr'); await get('?sessionId=s-a&lang=tr');
  assert.equal(calls.length, 1, 'cached by text: no repeated call');

  // A new task: one call for only its line.
  logs['c-3'] = done('Deploy is ready.'); events.push(cat(3, 'c-3', 'Deploy'));
  await get('?sessionId=s-a&lang=tr'); await settle(); tasks = await get('?sessionId=s-a&lang=tr');
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].lines, ['Deploy is ready.'], 'only the new line');
  assert.equal(result(tasks, 'c-3'), 'TR: Deploy is ready.');

  // Another language: its own call.
  await get('?sessionId=s-a&lang=de'); await settle();
  assert.equal(calls.length, 3); assert.match(calls[2].system, /into German/);

  // A failed call: the new line is left out (no English line), and it is not sent again.
  fail = true; logs['c-4'] = done('Build failed at step 2.'); events.push(cat(4, 'c-4', 'Build'));
  await get('?sessionId=s-a&lang=tr'); await settle(); tasks = await get('?sessionId=s-a&lang=tr');
  assert.equal(calls.length, 4);
  assert.equal(result(tasks, 'c-4'), undefined, 'not translated: no English line');
  assert.equal(result(tasks, 'c-1'), 'TR: All tests pass.', 'the cached lines still show');
  await get('?sessionId=s-a&lang=tr');
  assert.equal(calls.length, 4, 'a failed line is not sent again');

  // A bad lang value: no call, the lines stay.
  fail = false; tasks = await get(`?sessionId=s-a&lang=${encodeURIComponent('tr; drop')}`);
  assert.equal(calls.length, 4); assert.equal(result(tasks, 'c-1'), 'All tests pass.');
} finally { await rm(root, { recursive: true, force: true }); }

// The answer parser: an array of the same length, with a <think> part and text around it; anything else is no answer.
assert.deepEqual(parseStatusLines('<think>x</think>Here: ["a","b"]', 2), ['a', 'b']);
assert.equal(parseStatusLines('["a"]', 2), undefined, 'wrong count');
assert.equal(parseStatusLines('["a",""]', 2), undefined, 'an empty line');
assert.equal(parseStatusLines('no json', 1), undefined);

// The client sends dsh's UI language with each read.
{
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return Response.json({ on: true, items: [], tasks: [], projects: [] }); };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  const live = [];
  const plugin = mod.factory((n) => (n === 'react' ? { createElement: (t, p, ...c) => ({ t, p, c }) } : {}));
  plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k, getSnapshot: () => ({ active: 'tr' }) },
    slots: { inject: (n, f) => f(), register: (o) => { live.push(o); return () => {}; } } });
  const overlay = live.find((o) => o.name === 'shell.overlay' && o.id === 'assistant-status');
  await overlay.inject().store.load('s-a');
  assert.ok(urls.some((u) => u.startsWith('/api/composer-plus.assistant-todos?sessionId=s-a&lang=tr')), `the read sends the UI language (${urls.join(' ')})`);
  // `translating: true`: the store reads again soon (STATUS_DELAY_MS), once.
  const timers = []; const realSet = globalThis.setTimeout; globalThis.setTimeout = (f, ms) => { timers.push(ms); return 1; };
  globalThis.fetch = async (url) => { urls.push(String(url)); return Response.json({ on: true, items: [], tasks: [], projects: [], translating: true }); };
  await overlay.inject().store.load('s-a');
  globalThis.setTimeout = realSet;
  assert.equal(timers.length, 1, 'one read scheduled while the Host translates');
}
console.log('assistant status language checks passed');
