// Secret input through the real Host (apply), with a chat_send task: request_secret opens no card while a chat's turn
// runs the message that the assistant sent; a later turn of that chat that the user typed opens the card, also when the
// task stayed (its turn ended while Assistant was off). Not covered: a chat_new task waits for any turn, so the next turn
// is refused too, until the bot drops the task at that turn end (ponytail at taskTurn in index.js). A fork (parentSession,
// no origin "subagent", no delegationDepth) opens the card too.
import assert from 'node:assert/strict';
import './temp-home.mjs'; // before index.js: apply() must not get the real DSH_HOME
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, ASSISTANT_SWITCH_PATH, SECRET_ANSWER_PATH, SECRET_TOOL } from '../index.js';

const store = join(process.env.DSH_HOME, 'storages', 'dsh-composer-plus');
mkdirSync(store, { recursive: true });
writeFileSync(join(store, 'assistant.json'), JSON.stringify({ sessionId: 's-damon' }));
const routes = new Map(); const handlers = new Map(); const agents = new Map(); const tools = new Map(); const prompts = []; const disposers = [];
const newAgent = (id, header = { cwd: '/demo/acme-web' }) => {
  const registered = new Map(); const events = [];
  const agent = { id, status: 'idle', events, registered, session: { id, header, inheritedEventCount: 0, snapshotEvents: () => events },
    ctx: { tools: { register: (t) => { registered.set(t.name, t); return () => registered.delete(t.name); }, restrict: () => () => {} } } };
  agents.set(id, agent);
  return agent;
};
const damon = newAgent('s-damon', { cwd: '/demo/Assistant' }); const web = newAgent('s-web'); const fork = newAgent('s-fork', { cwd: '/demo/acme-web', parentSession: 's-web' });
const sub = { tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name); } }, systemPrompt: { section: () => {} }, skills: { registerProvider: () => {} }, on: () => {}, effect: () => {} };
apply({ on: (name, f) => { handlers.set(name, [...(handlers.get(name) ?? []), f]); }, subprocess: {},
  sessionQuery: { observeSession: async (id) => ({ header: agents.get(id).session.header, events: agents.get(id).events, [Symbol.dispose]() {} }) },
  sessionController: { prompt: async (request) => { prompts.push(request); } },
  get: (name) => (name === 'agents' ? { get: (id) => agents.get(id), list: () => [...agents.values()] } : undefined),
  connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  effect: (f) => { disposers.push(f()); },
  inject: (deps, setup) => { if (deps.every((d) => d in sub)) setup(sub); return { dispose() {} }; } });
const route = async (path, body, query = '') => (await routes.get(path).fetch(new Request(`http://h${path}${query}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }))).json();
for (let i = 0; !(damon.registered.has('chat_send') && tools.has(SECRET_TOOL)); i++) { assert.ok(i < 300, 'the assistant tools and request_secret'); await new Promise((r) => setTimeout(r, 10)); }
/** 'card' when the call opens a card (then declined, so nothing waits), else the error text of the refused call. */
const outcome = async (agent, callId) => {
  let refused;
  const waiting = tools.get(SECRET_TOOL).execute({ label: 'Deploy token' }, { agent, callId, signal: new AbortController().signal }).catch((error) => { refused = error.message; });
  for (let i = 0; i < 100 && refused === undefined; i++) {
    const [open] = (await route(SECRET_ANSWER_PATH, undefined, `?sessionId=${agent.id}`)).asks;
    if (open !== undefined) { await route(SECRET_ANSWER_PATH, { sessionId: agent.id, askId: open.askId, decline: true }); await waiting; return 'card'; }
    await new Promise((r) => setTimeout(r, 5));
  }
  return refused;
};
const turn = (agent, rpcId) => agent.events.push({ seq: agent.events.length, type: 'turn/start' },
  { seq: agent.events.length + 1, type: 'user/message', data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user', rpcId } } });

// The assistant sends a task to the idle chat; dsh runs it as a new turn with the request id: no card in that turn.
await damon.registered.get('chat_send').execute({ chat_id: 's-web', text: 'Deploy acme-web to staging.' }, { agent: damon });
turn(web, prompts.at(-1).requestId);
assert.match(await outcome(web, 'c1'), /^request_secret is not available in a chat that Damon started or gave a task to\./, 'the turn of the assistant\'s task');
// The turn ends while Assistant is off, so the task stays; the user's next turn in that chat opens the card.
await route(ASSISTANT_SWITCH_PATH, { on: false });
web.events.push({ seq: web.events.length, type: 'turn/end', data: { reason: { kind: 'completed' } } });
for (const f of handlers.get('session/event') ?? []) f(web.session, web.events.at(-1));
await route(ASSISTANT_SWITCH_PATH, { on: true });
await new Promise((r) => setTimeout(r, 50)); // the task list saves its file after each change
assert.ok(Object.keys(JSON.parse(readFileSync(join(store, 'assistant-tasks.json'), 'utf8')).tasks).includes('s-web'), 'the task stayed');
turn(web, 'typed-1');
assert.equal(await outcome(web, 'c2'), 'card', 'a turn that the user typed opens the card');
// A fork of a chat (dsh's Branch, Redo) is a root chat that the user looks at: the card opens.
turn(fork, 'typed-2');
assert.equal(await outcome(fork, 'c3'), 'card', 'a fork opens the card');
for (const d of disposers) { try { d?.(); } catch { /* unloaded */ } }
console.log('secret input in delegated chats: checks passed');
