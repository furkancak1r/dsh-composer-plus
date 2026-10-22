// Next message prediction (Host half): the switch and the model choice are saved; the model must be one that dsh lists
// now; GET ?catalog=1 returns dsh's own model list and default; a prediction uses the chosen model (else dsh's default),
// reads only the user's own messages and the agent's replies, runs only right after a finished turn, one call per chat,
// and returns one clean line. On by default (no settings file); a saved `on: false` stops every model call.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, PREDICT_PATH, predictTranscript, cleanPrediction, finishedTurn } from '../index.js';

// Pure parts.
const user = (seq, text, kind = 'user') => ({ seq, type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } });
const agent = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'secret thoughts' }, { type: 'text', text }] } } });
const start = (seq) => ({ seq, type: 'turn/start', data: {} });
const end = (seq, kind = 'completed') => ({ seq, type: 'turn/end', data: { reason: { kind } } });
const tool = (seq) => ({ seq, type: 'tool/call', data: { name: 'bash', arguments: { command: 'rm -rf secret' } } });
const chat = [start(1), user(2, 'Add a login page'), user(3, '<runtime context>', 'runtime-context'), tool(4), agent(5, 'Done: the login page is in src/login.tsx.'), end(6)];
assert.equal(finishedTurn(chat), 6);
assert.equal(finishedTurn([...chat, start(7)]), undefined, 'a new turn runs');
assert.equal(finishedTurn([start(1), end(2, 'interrupted')]), undefined, 'a stopped turn: Continue is the next step, not a guess');
const transcript = predictTranscript(chat);
assert.equal(transcript, 'User: Add a login page\n\nAgent: Done: the login page is in src/login.tsx.');
assert.ok(!transcript.includes('runtime') && !transcript.includes('rm -rf') && !transcript.includes('secret thoughts'), 'no hidden context, tools or reasoning');
assert.equal(predictTranscript([user(1, 'hi')]), undefined, 'no reply yet: nothing to predict');
const long = predictTranscript([user(1, 'old '.repeat(3000)), agent(2, 'x'.repeat(5000)), user(3, 'newer'), agent(4, 'newest reply')]);
assert.ok(long.length <= 6000 + 40 && long.endsWith('Agent: newest reply') && long.includes('User: newer'), 'the newest messages stay, the oldest go');
assert.equal(cleanPrediction('"Run the tests now."\nExtra line'), 'Run the tests now.');
assert.equal(cleanPrediction('User: add a logout button'), 'add a logout button');
assert.equal(cleanPrediction('<think>hmm</think>\n  Ship it  '), 'Ship it');
assert.equal(cleanPrediction('   '), '');
assert.equal(cleanPrediction('a'.repeat(400)).length, 300);

// Route, with fake dsh services.
const home = await mkdtemp(join(tmpdir(), 'cp-predict-'));
process.env.DSH_HOME = home;
let events = chat;
let origin = 'user';
const calls = [];
let release = () => {};
let gate = Promise.resolve();
const providers = [{ id: 'demo', name: 'Demo' }, { id: 'fast', name: 'Fast provider' }, { id: 'broken', name: 'Broken' }];
const models = { demo: [{ id: 'demo', name: 'Demo model' }], fast: [{ id: 'mini', name: 'Mini' }, { id: 'nano', name: 'Nano' }] };
const llm = {
  listProviders: () => providers,
  listModels: async (id) => { if (id === 'broken') throw new Error('no key'); return (models[id] ?? []).map((m) => ({ provider: id, ...m })); },
  prepareCall: async (route, signal, configure) => {
    const controls = configure({}, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }, defaultMaxTokens: 64000 });
    return {
      config: { ...route, ...controls },
      async *stream(request) {
        calls.push(request);
        await gate;
        yield { type: 'text-delta', text: '"Now add a logout button.' };
        yield { type: 'text-delta', text: '"\nExplanation: ...' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
  },
};
const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'demo', model: 'demo', reasoningEffort: 'high' }) } };
const routes = new Map();
apply({
  on() {}, effect() {}, get: (name) => services[name],
  connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  sessionQuery: { observeSession: async (id) => ({ header: { cwd: '/p', origin }, events, [Symbol.dispose]() {} }) },
  sessionController: {}, subprocess: {},
});
const route = routes.get(PREDICT_PATH);
assert.ok(route, 'route registered'); assert.deepEqual(route.methods, ['GET', 'POST']);
const call = async (method, body, query = '', signal) => {
  const response = await route.fetch(new Request(`http://h${PREDICT_PATH}${query}`, method === 'GET' ? {} : { method, signal, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: response.status, data: await response.json() };
};

let r = await call('GET');
assert.deepEqual(r.data, { on: true }, 'on by default, dsh default model');
r = await call('POST', { on: false });
assert.deepEqual(r.data, { on: false });
r = await call('POST', { sessionId: 's1', afterSeq: 6 });
assert.equal(r.status, 409, 'switched off: no model call'); assert.equal(calls.length, 0);

r = await call('GET', undefined, '?catalog=1');
assert.deepEqual(r.data.catalog, { default: { provider: 'demo', model: 'demo' }, groups: [
  { id: 'demo', name: 'Demo', models: [{ id: 'demo', name: 'Demo model' }] },
  { id: 'fast', name: 'Fast provider', models: [{ id: 'mini', name: 'Mini' }, { id: 'nano', name: 'Nano' }] }] }, 'dsh\'s models and default; a failing provider is left out');
// dsh adds a provider: the next read lists it (no cache).
models.fast.push({ id: 'pico', name: 'Pico' });
r = await call('GET', undefined, '?catalog=1');
assert.deepEqual(r.data.catalog.groups[1].models.map((m) => m.id), ['mini', 'nano', 'pico'], 'live list');

// Bad bodies.
for (const body of ['not json', '[]', 'null', { on: 'yes' }, { model: { provider: 'demo' } }, { on: true, model: null }, { sessionId: 's1' }, { sessionId: 's1', afterSeq: -1 }, { sessionId: 's1', afterSeq: 6, on: true }]) {
  assert.equal((await call('POST', body)).status, 400, JSON.stringify(body));
}
r = await call('POST', { model: { provider: 'fast', model: 'gone' } });
assert.equal(r.status, 409, 'a model that dsh does not list is refused');

r = await call('POST', { on: true });
assert.deepEqual(r.data, { on: true });
assert.deepEqual(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/predict.json'), 'utf8')), { on: true });

// Default model: dsh's default, lowest effort, a small output cap; the model sees the transcript only.
r = await call('POST', { sessionId: 's1', afterSeq: 6 });
assert.equal(r.status, 200);
assert.deepEqual(r.data, { text: 'Now add a logout button.', afterSeq: 6, model: 'demo' });
assert.equal(calls.length, 1);
const [first] = calls;
assert.equal(first.provider, 'demo'); assert.equal(first.model, 'demo'); assert.equal(first.reasoningEffort, 'low'); assert.equal(first.maxTokens, 4000);
assert.match(first.system, /next message that the user will type/);
assert.match(first.messages[0].content[0].text, /User: Add a login page[\s\S]*Agent: Done: the login page/);
assert.ok(!JSON.stringify(first).includes('rm -rf'), 'tool calls never go to the model');

// The same turn again (reopened chat, another tab, the phone): the kept answer, no new model call.
r = await call('POST', { sessionId: 's1', afterSeq: 6 });
assert.equal(r.data.text, 'Now add a logout button.'); assert.equal(calls.length, 1, 'kept answer: no second call');
// A chosen model is used; null goes back to dsh's default.
r = await call('POST', { model: { provider: 'fast', model: 'nano' } });
assert.deepEqual(r.data, { on: true, model: { provider: 'fast', model: 'nano' } });
r = await call('POST', { on: false }); r = await call('POST', { on: true });
assert.deepEqual(r.data, { on: true, model: { provider: 'fast', model: 'nano' } }, 'the switch keeps the model choice');
r = await call('POST', { sessionId: 's1', afterSeq: 6 });
assert.equal(calls.at(-1).provider, 'fast'); assert.equal(calls.at(-1).model, 'nano'); assert.equal(r.data.model, 'nano');
// dsh drops that model (provider removed): the default is used, the choice stays saved.
const nano = models.fast.splice(1, 1);
r = await call('POST', { sessionId: 's1', afterSeq: 6 });
assert.equal(calls.at(-1).model, 'demo', 'unlisted model → dsh default');
models.fast.splice(1, 0, ...nano);
r = await call('POST', { model: null });
assert.deepEqual(r.data, { on: true }, 'back to dsh default');

// Only right after a finished turn of a top-level chat.
assert.equal((await call('POST', { sessionId: 's1', afterSeq: 5 })).status, 409, 'not the newest turn end');
events = [...chat, start(7)];
assert.equal((await call('POST', { sessionId: 's1', afterSeq: 6 })).status, 409, 'a new turn runs');
events = chat; origin = 'subagent';
assert.equal((await call('POST', { sessionId: 's1', afterSeq: 6 })).status, 409, 'subagent chat');
origin = 'user';
events = [start(1), user(2, 'hi'), end(3)];
r = await call('POST', { sessionId: 's1', afterSeq: 3 });
assert.deepEqual(r.data, { text: '', afterSeq: 3 }, 'no reply: no call, empty text');

// One call per chat: the same turn shares the running call; another turn of the same chat waits for it to end.
events = [...chat, start(7), user(8, 'more'), agent(9, 'ok'), end(10)];
const before = calls.length;
gate = new Promise((resolve) => { release = resolve; });
const leaving = new AbortController(); // the first tab closes while the call runs
const a = call('POST', { sessionId: 's1', afterSeq: 10 }, '', leaving.signal);
const b = call('POST', { sessionId: 's1', afterSeq: 10 });
leaving.abort();
await new Promise((resolve) => setTimeout(resolve, 20));
events = [...events, start(11), user(12, 'again'), agent(13, 'ok'), end(14)];
const c = await call('POST', { sessionId: 's1', afterSeq: 14 });
assert.equal(c.status, 409, 'a second turn of the same chat while one call runs');
release();
const [ra, rb] = await Promise.all([a, b]);
assert.equal(rb.data.text, 'Now add a logout button.', 'the second request still gets the shared answer'); assert.deepEqual(ra.data, rb.data);
assert.equal(calls.at(-1).signal.aborted, false, 'the shared call is not tied to the first request');
assert.equal(calls.length, before + 1, 'one model call for both requests');
gate = Promise.resolve();

// Model call failure: the error comes back, nothing is cached.
const prepare = llm.prepareCall;
llm.prepareCall = async () => ({ config: {}, async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }; } });
r = await call('POST', { sessionId: 's1', afterSeq: 14 });
assert.equal(r.status, 502); assert.equal(r.data.error, 'rate limited');
llm.prepareCall = prepare;
// No model at all.
services.agentDefaultModel = undefined;
r = await call('POST', { sessionId: 's1', afterSeq: 14 });
assert.equal(r.status, 409); assert.equal(r.data.error, 'no model is selected');
// A broken settings file reads as off.
await (await import('node:fs/promises')).writeFile(join(home, 'storages/dsh-composer-plus/predict.json'), '{broken');
assert.deepEqual((await call('GET')).data, { on: true }, 'a broken file reads as the default (on)');
await rm(home, { recursive: true, force: true });
console.log('predict checks passed');
