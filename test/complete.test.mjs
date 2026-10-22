// Complete while typing (Host half): off by default (no settings file, a broken file); the switch is saved; the model is
// its own choice, else the one chosen for the next message prediction, else dsh's default; the model sees the chat's own text and the typed
// text only; the answer is the words after the typed text; a newer request for the same chat stops the older call.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, COMPLETE_PATH, PREDICT_PATH, cleanCompletion, completeContext } from '../index.js';

// Pure parts.
assert.equal(cleanCompletion('Run the ', 'tests again.'), 'tests again.');
assert.equal(cleanCompletion('Run the ', '  tests'), 'tests', 'after a space: no second space');
assert.equal(cleanCompletion('Run the te', 'sts again'), 'sts again', 'ends the typed word');
assert.equal(cleanCompletion('Run the tests', ' and fix the failures.'), ' and fix the failures.', 'a new word keeps its space');
assert.equal(cleanCompletion('Run the', 'Run the tests now.'), ' tests now.', 'a repeated message keeps only the new part');
assert.equal(cleanCompletion('Add ', '"a logout button."\nExplanation: x'), 'a logout button.', 'quotes and other lines go');
assert.equal(cleanCompletion('Bunu dsh', "'yi yeniden başlatmadan yap"), "'yi yeniden başlatmadan yap", 'a Turkish suffix apostrophe stays');
assert.equal(cleanCompletion('Add ', 'Completion: tests'), 'tests');
assert.equal(cleanCompletion('Add ', '<think>hmm</think>   '), '');
assert.equal(cleanCompletion('Add ', 'word '.repeat(60)).length <= 150, true);
assert.ok(!cleanCompletion('Add ', 'word '.repeat(60)).endsWith(' '), 'cut at a word end');
const user = (seq, text, kind = 'user') => ({ seq, type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } });
const agent = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'secret thoughts' }, { type: 'text', text }] } } });
const tool = (seq) => ({ seq, type: 'tool/call', data: { name: 'bash', arguments: { command: 'rm -rf secret' } } });
const chat = [user(1, 'Add a login page'), user(2, '<runtime context>', 'runtime-context'), tool(3), agent(4, 'Done: the login page is in src/login.tsx.')];
assert.equal(completeContext(chat), 'User: Add a login page\n\nAgent: Done: the login page is in src/login.tsx.');
assert.equal(completeContext([]), '', 'a new chat');
assert.ok(completeContext([user(1, 'x'.repeat(5000)), agent(2, 'newest')]).endsWith('Agent: newest'));
assert.ok(completeContext([user(1, 'x'.repeat(5000)), agent(2, 'newest')]).length <= 3001);

// Route, with fake dsh services.
const home = await mkdtemp(join(tmpdir(), 'cp-complete-'));
process.env.DSH_HOME = home;
let events = chat;
let origin = 'user';
const calls = [];
let answer = ' and add tests.';
let gate = () => Promise.resolve();
const providers = [{ id: 'demo', name: 'Demo' }, { id: 'fast', name: 'Fast' }];
const models = { demo: [{ id: 'demo', name: 'Demo model' }], fast: [{ id: 'nano', name: 'Nano' }] };
const llm = {
  listProviders: () => providers,
  listModels: async (id) => (models[id] ?? []).map((m) => ({ provider: id, ...m })),
  prepareCall: async (route, signal, configure) => {
    const controls = configure({}, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }, defaultMaxTokens: 64000 });
    return {
      config: { ...route, ...controls },
      async *stream(request) {
        calls.push(request);
        await gate(request.signal);
        if (request.signal.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
        yield { type: 'text-delta', text: answer };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
  },
};
const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'demo', model: 'demo' }) } };
const routes = new Map();
apply({
  on() {}, effect() {}, get: (name) => services[name],
  connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  sessionQuery: { observeSession: async () => ({ header: { cwd: '/p', origin }, events, [Symbol.dispose]() {} }) },
  sessionController: {}, subprocess: {},
});
const route = routes.get(COMPLETE_PATH);
assert.ok(route, 'route registered'); assert.deepEqual(route.methods, ['GET', 'POST']);
const call = async (path, method, body, signal) => {
  const r = await routes.get(path).fetch(new Request(`http://h${path}`, method === 'GET' ? {} : { method, signal, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: r.status, data: await r.json() };
};
const ask = (body, signal) => call(COMPLETE_PATH, 'POST', body, signal);

// Off by default: no model call.
assert.deepEqual((await call(COMPLETE_PATH, 'GET')).data, { on: false });
let r = await ask({ sessionId: 's1', text: 'Run the' });
assert.equal(r.status, 409); assert.equal(calls.length, 0, 'off: no call');
for (const body of ['nope', '[]', 'null', { on: 'yes' }, { sessionId: 's1' }, { sessionId: 's1', text: '   ' }, { sessionId: 's1', text: 'x'.repeat(4001) }, { sessionId: 's1', text: 'a', on: true }, { text: 'a' }]) {
  assert.equal((await ask(body)).status, 400, JSON.stringify(body));
}
r = await ask({ on: true });
assert.deepEqual(r.data, { on: true });
assert.deepEqual(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/complete.json'), 'utf8')), { on: true });

// dsh's default model, lowest effort, small cap; the model sees the chat text and the typed text, not tools or reasoning.
r = await ask({ sessionId: 's1', text: 'Run the tests' });
assert.equal(r.status, 200);
assert.deepEqual(r.data, { text: 'Run the tests', completion: ' and add tests.', model: 'demo' });
const [first] = calls;
assert.equal(first.provider, 'demo'); assert.equal(first.reasoningEffort, 'low'); assert.equal(first.maxTokens, 2000);
assert.match(first.system, /complete the message that the user is typing/);
assert.match(first.messages[0].content[0].text, /User: Add a login page[\s\S]*Agent: Done[\s\S]*<<<Run the tests>>>/);
assert.ok(!JSON.stringify(first).includes('rm -rf') && !JSON.stringify(first).includes('secret thoughts'), 'no tools or reasoning');
// A new chat has no context: it still completes.
events = [];
r = await ask({ sessionId: 's2', text: 'Write a' });
assert.equal(r.status, 200); assert.match(calls.at(-1).messages[0].content[0].text, /\(none, a new chat\)/);
events = chat;

// The model chosen for the next message prediction is used here too.
assert.equal((await call(PREDICT_PATH, 'POST', { model: { provider: 'fast', model: 'nano' } })).status, 200);
r = await ask({ sessionId: 's1', text: 'Run' });
assert.equal(calls.at(-1).provider, 'fast'); assert.equal(calls.at(-1).model, 'nano'); assert.equal(r.data.model, 'nano');
// dsh drops that model: dsh's default.
const nano = models.fast.splice(0, 1);
r = await ask({ sessionId: 's1', text: 'Run' });
assert.equal(calls.at(-1).model, 'demo');
models.fast.push(...nano);

// Its own model: saved in complete.json beside the switch; the prediction keeps its own; null goes back to the prediction's.
models.fast.push({ id: 'mini', name: 'Mini' });
const settingsFile = join(home, 'storages/dsh-composer-plus/complete.json');
for (const bad of [{ model: 'x' }, { model: { provider: 'fast' } }, { model: { provider: 'fast', model: 'mini' }, on: true }, { model: { provider: 'fast', model: 'mini' }, sessionId: 's1', text: 'a' }]) assert.equal((await ask(bad)).status, 400, JSON.stringify(bad));
assert.equal((await ask({ model: { provider: 'fast', model: 'gone' } })).status, 409, 'only a model that dsh lists');
r = await ask({ model: { provider: 'fast', model: 'mini' } });
assert.equal(r.status, 200); assert.deepEqual(r.data, { on: true, model: { provider: 'fast', model: 'mini' } });
assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { on: true, model: { provider: 'fast', model: 'mini' } }, 'the switch stays on');
r = await ask({ sessionId: 's1', text: 'Run' }); assert.equal(calls.at(-1).model, 'mini', 'its own model is used'); assert.equal(r.data.model, 'mini');
assert.deepEqual((await call(PREDICT_PATH, 'GET')).data.model, { provider: 'fast', model: 'nano' }, 'the prediction keeps its model');
// The settings answer with the catalog names the prediction's model for the "Same as …" entry.
const withCatalog = await (await routes.get(COMPLETE_PATH).fetch(new Request(`http://h${COMPLETE_PATH}?catalog=1`))).json();
assert.deepEqual(withCatalog.model, { provider: 'fast', model: 'mini' }); assert.deepEqual(withCatalog.fallback, { provider: 'fast', model: 'nano' });
assert.ok(withCatalog.catalog.groups.some((g) => g.id === 'fast' && g.models.some((m) => m.id === 'mini')));
// A switch write keeps the model; a model write keeps the switch.
assert.deepEqual((await ask({ on: false })).data, { on: false, model: { provider: 'fast', model: 'mini' } });
assert.deepEqual((await ask({ on: true })).data, { on: true, model: { provider: 'fast', model: 'mini' } });
// dsh drops its own model: the prediction's.
const mini = models.fast.splice(models.fast.findIndex((m) => m.id === 'mini'), 1);
await ask({ sessionId: 's1', text: 'Run' }); assert.equal(calls.at(-1).model, 'nano', 'a model that dsh no longer lists falls back to the prediction\'s');
models.fast.push(...mini);
// null: back to the prediction's model.
assert.deepEqual((await ask({ model: null })).data, { on: true });
await ask({ sessionId: 's1', text: 'Run' }); assert.equal(calls.at(-1).model, 'nano');
// An older file (`{on}` only) still reads.
await writeFile(settingsFile, JSON.stringify({ on: true })); assert.deepEqual((await call(COMPLETE_PATH, 'GET')).data, { on: true });

// A newer request for the same chat stops the older call; another chat is not touched.
let releaseOld;
gate = (signal) => new Promise((resolve) => { releaseOld = resolve; signal.addEventListener('abort', resolve); });
const older = ask({ sessionId: 's1', text: 'Run the t' });
await new Promise((resolve) => setTimeout(resolve, 10));
const oldSignal = calls.at(-1).signal;
gate = () => Promise.resolve();
const newer = await ask({ sessionId: 's1', text: 'Run the te' });
assert.equal(oldSignal.aborted, true, 'the older call was stopped');
assert.equal((await older).status, 409, 'the older request ends without text');
assert.equal(newer.status, 200);
// The browser leaves (request aborted): the call stops.
gate = (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve));
const leaving = new AbortController();
const gone = ask({ sessionId: 's3', text: 'Fix the' }, leaving.signal);
await new Promise((resolve) => setTimeout(resolve, 10));
leaving.abort();
await gone.catch(() => {});
assert.equal(calls.at(-1).signal.aborted, true, 'an aborted request stops its call');
gate = () => Promise.resolve();

// Subagent chat, failure, no model.
origin = 'subagent';
assert.equal((await ask({ sessionId: 's1', text: 'Run' })).status, 409);
origin = 'user';
const prepare = llm.prepareCall;
llm.prepareCall = async () => ({ config: {}, async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }; } });
r = await ask({ sessionId: 's1', text: 'Run' });
assert.equal(r.status, 502); assert.equal(r.data.error, 'rate limited');
llm.prepareCall = prepare;
services.agentDefaultModel = undefined;
assert.equal((await call(PREDICT_PATH, 'POST', { model: null })).status, 200);
r = await ask({ sessionId: 's1', text: 'Run' });
assert.equal(r.status, 409); assert.equal(r.data.error, 'no model is selected');

// Switch off: no call. A broken file reads as off.
assert.deepEqual((await ask({ on: false })).data, { on: false });
const n = calls.length;
assert.equal((await ask({ sessionId: 's1', text: 'Run' })).status, 409); assert.equal(calls.length, n);
await writeFile(join(home, 'storages/dsh-composer-plus/complete.json'), '{broken');
assert.deepEqual((await call(COMPLETE_PATH, 'GET')).data, { on: false }, 'a broken file reads as off');
await rm(home, { recursive: true, force: true });
console.log('complete checks passed');
