// Continue in a new chat (Host half). `POST {sessionId}`: one call to the chat's own model writes a handoff note from the
// chat's own events (a fork's copied events and steps withdrawn by Turn rollback or dsh-rewind left out; /compact kept).
// `POST {sessionId, note, start: true}`: a new chat in the same project (its sidebar group) gets the note and a link to the
// old chat as its first message; a failed send archives the new chat (all or none). One action per chat at a time.
import assert from 'node:assert/strict';
import { installHandoff, handoffInput, handoffMessage, sessionLink, HANDOFF_PATH, HANDOFF_NOTE_MAX } from '../index.js';

let seq = 0;
const ev = (type, data, extra = {}) => ({ seq: ++seq, time: seq, type, data, ...extra });
const user = (text, kind = 'user') => ev('user/message', { source: { kind }, content: [{ type: 'text', text }] });
const reply = (text) => ev('assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden thoughts' }, { type: 'text', text }] } });
const call = (name, args) => ev('tool/call', { callId: `c${seq + 1}`, name, arguments: JSON.stringify(args) });
const marker = (kind, from, to) => ev('user/message', { source: { kind }, content: [{ type: 'text', text: '(empty message)' }] }, { sourceEventSeqs: [from, to] });

// The input: own events, both withdraw kinds out, /compact kept, a fork's copy out.
const parent = [user('PARENT ASK'), reply('PARENT REPLY')];
const own = [user('Add a logout button'), reply('Added src/logout.ts.'), call('bash', { command: 'npm test' }),
  user('WITHDRAWN ONE'), reply('WITHDRAWN REPLY')];
own.push(marker('composer-plus-rollback', own[3].seq, own[4].seq));
own.push(user('REWOUND')); own.push(marker('dsh-rewind', own.at(-1).seq, own.at(-1).seq));
own.push(ev('user/message', { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }] }, { sourceEventSeqs: [own[0].seq, own[1].seq] }));
const events = [...parent, ...own];
const input = handoffInput(events, parent.length);
assert.match(input, /User: Add a logout button\n\nAgent: Added src\/logout\.ts\.\n\nTool call bash: \{"command":"npm test"\}/);
for (const gone of ['PARENT', 'WITHDRAWN', 'REWOUND', 'hidden thoughts']) assert.ok(!input.includes(gone), `no ${gone}`);
assert.equal(sessionLink('s1'), 'dsh-session:InMxIg', 'dsh\'s link form (base64url of the JSON id)');
assert.equal(handoffMessage('  Task\n- x  \n', 'dsh-session:InMxIg'), 'Task\n- x\n\nContinue this work. The earlier chat, for reference only: dsh-session:InMxIg');

// The route, with fake dsh services.
const routes = new Map();
const asked = [];
let answer = '<think>x</think>## Task\n- Add a logout button\n## Next action\n- Write a test';
let gate = () => Promise.resolve();
const llm = {
  prepareCall: async (route, signal, configure) => ({
    config: { ...route, ...configure({}, { reasoning: { efforts: [{ id: 'low' }] }, defaultMaxTokens: 64000 }) },
    async *stream(request) { asked.push(request); await gate(request.signal); if (request.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; } yield { type: 'text-delta', text: answer }; yield { type: 'finish', reason: { kind: 'stop' } }; },
  }),
  listProviders: () => [{ id: 'chat', name: 'Chat' }], listModels: async () => [{ provider: 'chat', id: 'big', name: 'Big' }],
};
let origin = 'user';
let observed = { header: { cwd: '/work/acme' }, inheritedEventCount: parent.length, events: [ev('request/header', { header: { config: { provider: 'chat', model: 'big' } } }), ...events] };
observed.inheritedEventCount = parent.length + 1;
const created = []; const prompts = []; const archived = [];
let promptFails = false;
const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'chat', model: 'big' }) },
  workspaceRegistry: { list: () => [{ id: 'w1', sessionIds: ['s1'] }], archiveSession: async (id, o) => { archived.push([id, o]); } } };
const installed = {
  get: (name) => services[name],
  connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  sessionQuery: { observeSession: async () => ({ ...observed, header: { ...observed.header, origin }, [Symbol.dispose]() {} }) },
  sessionController: {
    create: async (o) => { created.push(o); return { sessionId: `new${created.length}` }; },
    resolveAgent: async (id) => ({ agent: { id } }),
    prompt: async (p) => { if (promptFails) throw new Error('queue refused'); prompts.push(p); },
  },
};
installHandoff(installed, '/tmp/unused-home');
const post = async (body) => {
  const r = await routes.get(HANDOFF_PATH).fetch(new Request(`http://h${HANDOFF_PATH}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: r.status, data: await r.json() };
};
for (const body of ['nope', 'null', '[]', {}, { sessionId: '' }, { sessionId: 's1', start: true }, { sessionId: 's1', note: 'x' }, { sessionId: 's1', note: '  ', start: true },
  { sessionId: 's1', note: 'x'.repeat(HANDOFF_NOTE_MAX + 1), start: true }, { sessionId: 's1', note: 'x', start: 'yes' }, { sessionId: 's1', extra: 1 }]) {
  assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 60));
}
assert.equal(asked.length + created.length, 0, 'nothing done for a bad request');

// The note: the chat's model, lowest effort, the own events only; nothing is created.
let r = await post({ sessionId: 's1' });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.deepEqual(r.data, { note: '## Task\n- Add a logout button\n## Next action\n- Write a test', model: 'big' });
assert.equal(asked[0].model, 'big'); assert.equal(asked[0].reasoningEffort, 'low');
assert.match(asked[0].system, /Task, Outputs, Completed, Decisions, Open issues, Next action/); assert.match(asked[0].system, /Never invent/);
const sent = asked[0].messages[0].content[0].text;
assert.ok(sent.includes('Add a logout button') && !sent.includes('PARENT') && !sent.includes('WITHDRAWN'), 'own, not withdrawn');
assert.equal(created.length, 0, 'a note creates no chat');

// Review finding P2-3: a newer note stops the older call (a closed dialog never locks the chat); a start waits while a
// note runs and runs to its end; another chat is not blocked.
let release;
gate = (signal) => new Promise((res) => { release = res; signal?.addEventListener?.('abort', res); });
const slow = post({ sessionId: 's1' });
await new Promise((res) => setTimeout(res, 10));
const older = asked.at(-1);
assert.equal((await post({ sessionId: 's1', note: 'x', start: true })).status, 409, 'no start while a note is written');
gate = () => Promise.resolve();
assert.equal((await post({ sessionId: 's2' })).status, 200, 'another chat');
assert.equal(older.signal.aborted, false, 'another chat does not stop it');
r = await post({ sessionId: 's1' });
assert.equal(r.status, 200, 'a newer note runs at once'); assert.equal(older.signal.aborted, true, 'and stops the older call');
assert.deepEqual(await slow, { status: 409, data: { error: 'a newer handoff note replaced this one' } });
{ // A page that leaves stops its own call; the chat is free again.
  gate = (signal) => new Promise((res) => signal?.addEventListener?.('abort', res));
  const page = new AbortController();
  const left = routes.get(HANDOFF_PATH).fetch(new Request('http://h', { method: 'POST', body: JSON.stringify({ sessionId: 's1' }), signal: page.signal })).catch(() => 'gone');
  await new Promise((res) => setTimeout(res, 10)); page.abort(); await left;
  gate = () => Promise.resolve();
  assert.equal((await post({ sessionId: 's1' })).status, 200, 'free after the page left');
}
// A start blocks a second start and a note of the same chat while it runs.
{ let go; const prompt = installed.sessionController.prompt;
  installed.sessionController.prompt = async (p) => { await new Promise((res) => { go = res; }); return prompt(p); };
  const first = post({ sessionId: 's1', note: 'n', start: true });
  await new Promise((res) => setTimeout(res, 10));
  assert.equal((await post({ sessionId: 's1', note: 'n', start: true })).status, 409);
  assert.equal((await post({ sessionId: 's1' })).status, 409, 'no note while the new chat starts');
  go(); assert.equal((await first).status, 200);
  installed.sessionController.prompt = prompt; created.length = 0; prompts.length = 0; }

// Start: a new chat in the same sidebar group with the edited note and the link; the old chat stays.
r = await post({ sessionId: 's1', note: '  My edited note  ', start: true });
assert.deepEqual(r, { status: 200, data: { sessionId: `new${created.length}` } });
assert.deepEqual(created.at(-1), { workspaceId: 'w1' });
assert.equal(prompts.at(-1).sessionId, 'new1'); assert.equal(prompts.at(-1).mode, 'queue');
assert.equal(prompts.at(-1).content[0].text, 'My edited note\n\nContinue this work. The earlier chat, for reference only: dsh-session:InMxIg');
assert.equal(archived.length, 0);
// A chat outside a sidebar group: its folder.
r = await post({ sessionId: 's9', note: 'n', start: true }); assert.deepEqual(created.at(-1), { cwd: '/work/acme' });
// All or none: a failed send archives the new chat and says so.
promptFails = true;
r = await post({ sessionId: 's1', note: 'n', start: true });
assert.equal(r.status, 502); assert.match(r.data.error, /queue refused; the new chat was archived/);
assert.deepEqual(archived.at(-1), [`new${created.length}`, { stopActivity: true }]);
promptFails = false;

// Refusals: a subagent chat, a chat with no own messages (only a fork's copy), no model, a cut-off answer, a model error.
origin = 'subagent'; assert.equal((await post({ sessionId: 's1' })).status, 409); origin = 'user';
{ const saved = observed; observed = { ...saved, inheritedEventCount: saved.events.length };
  r = await post({ sessionId: 's1' }); assert.equal(r.status, 409); assert.match(r.data.error, /no messages of its own/); observed = saved; }
answer = '<think>only</think>'; r = await post({ sessionId: 's1' }); assert.equal(r.status, 502); answer = 'ok';
{ const prepare = llm.prepareCall;
  llm.prepareCall = async () => ({ config: {}, async *stream() { yield { type: 'text-delta', text: '## Task\n- half' }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; } });
  r = await post({ sessionId: 's1' }); assert.equal(r.status, 502); assert.match(r.data.error, /token limit/);
  llm.prepareCall = async () => ({ config: {}, async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }; } });
  r = await post({ sessionId: 's1' }); assert.equal(r.status, 502); assert.equal(r.data.error, 'rate limited');
  llm.prepareCall = prepare; }
answer = 'x'.repeat(20000); r = await post({ sessionId: 's1' }); assert.equal(r.data.note.length, HANDOFF_NOTE_MAX, 'a long note is cut');
services.llm = undefined; assert.equal((await post({ sessionId: 's1' })).status, 409);
console.log('handoff checks passed');
