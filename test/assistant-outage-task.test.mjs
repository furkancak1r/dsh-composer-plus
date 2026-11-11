// Assistant: a delegated task whose turn fails in an AIProxy outage (Host half, fake dsh, Assistant news off):
// - Resume after an AIProxy outage on: the 499 request_cancelled turn end keeps the task and gives no note; the turn that
//   the outage feature continues gives one task note with its last reply.
// - Switched off: nothing continues the chat, so the same turn end gives the "failed" note and drops the task.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_PATH, OUTAGE_NOTES, OUTAGE_PATH, installAssistant, installAssistantBot, installOutageResume } from '../index.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(5); } };
const C499 = 'aiproxy API error (499): {"code":"request_cancelled","message":"İstek iptal edildi."}';
const home = await mkdtemp(join(tmpdir(), 'cp-assistant-outage-'));
try {
  const folder = join(home, 'Assistant');
  const workspaces = [{ id: 'w-web', title: 'acme-web', path: '/demo/acme-web', sessionIds: ['s-task'] }];
  const agents = new Map(); const listeners = new Map(); const routes = new Map(); const steers = [];
  let created = 0;
  const newAgent = (id, header = { cwd: '/demo/acme-web' }) => {
    const registered = new Map();
    const agent = { id, status: 'idle', events: [], session: { id, header, inheritedEventCount: 0, snapshotEvents: () => agent.events },
      ctx: { tools: { register: (t) => { registered.set(t.name, t); return () => registered.delete(t.name); }, restrict: () => () => {} } },
      inbox: { prepend: (target, m) => { agent.queued = m; }, remove: () => {} }, steer: (m) => { steers.push([id, m]); }, registered };
    agents.set(id, agent);
    return agent;
  };
  const task = newAgent('s-task');
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
  const ctx = {
    logger: { warn: () => {} },
    get: (name) => ({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
      workspaceRegistry: { list: () => workspaces, archivedSessionIds: [],
        create: async (path, title) => { let w = workspaces.find((x) => x.path === path); if (!w) { w = { id: `w-${workspaces.length}`, title, path, sessionIds: [] }; workspaces.push(w); } return w; } },
      permissionPresets: { names: [], set: () => {} } })[name],
    on,
    effect: () => {},
    inject: (deps, setup) => { setup({ systemPrompt: { section: () => {} } }); return { dispose: () => {} }; },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return async () => routes.delete(route.path); } } },
    sessionQuery: {
      observeSession: async (id) => { if (!agents.has(id)) throw new Error('unknown session'); return { header: agents.get(id).session.header, events: agents.get(id).events, inheritedEventCount: 0, [Symbol.dispose]() {} }; },
      readTitle: async (id) => ({ title: { 's-task': 'Release PR' }[id] }),
    },
    sessionController: {
      list: async () => ({ items: [] }),
      resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found', message: 'not found' } }),
      create: async ({ workspaceId }) => { created += 1; const id = `s-assistant-${created}`; newAgent(id, { cwd: folder }); workspaces.find((w) => w.id === workspaceId).sessionIds.push(id); return { sessionId: id }; },
      rename: async () => {},
      prompt: async () => {},
    },
  };
  // As in apply(): the outage feature first, its handle goes to the bot. No real health check (the chat has no AIProxy
  // request header, so the outage watch does not start: this test continues the chat itself).
  const outage = installOutageResume(ctx, home, { health: async () => true });
  await outage.ready;
  assert.equal(outage.isOn(), true, 'Resume after an AIProxy outage is on by default');
  const assistant = installAssistant(ctx, home, { folder, zone: 'UTC' });
  await assistant.ready;
  const me = agents.get((await (await routes.get(ASSISTANT_PATH).fetch(new Request(`http://x${ASSISTANT_PATH}`))).json()).sessionId);
  const timing = { turn: 60000, wait: 40, batch: 20, gap: 120000, max: 10, reply: 300, taskReply: 2000 };
  const preStep = listeners.get('agent/pre-step').length; // the bot's news hook comes after the outage feature's hook
  const bot = installAssistantBot(ctx, home, assistant, { timing, outage });
  await bot.ready;
  assert.equal(bot.notify(), false, 'Assistant news is off');
  const push = (agent, ...events) => { for (const e of events) agent.events.push({ seq: agent.events.length, ...e }); };
  const said = (text, rpcId) => ({ type: 'user/message', data: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', ...(rpcId === undefined ? {} : { rpcId }) } } });
  const reply = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
  const start = { type: 'turn/start' }; const stop = { type: 'turn/end' };
  const ended = (agent, reason = { kind: 'completed' }) => emit('session/event', agent.session, { type: 'turn/end', data: { reason } });
  const noteOf = async (i) => (await listeners.get('agent/pre-step')[preStep]({ agent: me }, async () => ({ kind: 'enter', messages: [me.queued, steers[i][1]] }))).messages[0].content[0].text;

  // (a) Outage feature on: the 499 turn end keeps the task and gives no note.
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, start, said('Open the release PR'), reply('Half way.'));
  ended(task, { kind: 'error', error: { message: C499, code: 'PI_AI_ERROR' } });
  await pause(60);
  assert.equal(assistant.tasks.has('s-task'), true, 'the outage keeps the task');
  assert.equal(steers.length, 0, 'no "failed" note'); assert.deepEqual(bot.pending(), []);
  // The outage feature continues the chat (its message through dsh's prompt); that turn gives the one task note.
  push(task, stop, start, said(OUTAGE_NOTES.en, randomUUID()), reply('PR ready'));
  ended(task);
  await until(() => steers.length === 1, 'the note of the continued turn');
  assert.equal(steers[0][0], me.id);
  assert.match(await noteOf(0), /"Release PR" \(project "acme-web", chat s-task, your delegated task\): finished\. Last reply: "PR ready"/);
  assert.equal(assistant.tasks.has('s-task'), false, 'the task goes');
  await pause(60); assert.equal(steers.length, 1, 'exactly one note');

  // (b) Outage feature off: nothing continues the chat, so the 499 turn end is the task's result (today's behavior).
  const switched = await routes.get(OUTAGE_PATH).fetch(new Request(`http://x${OUTAGE_PATH}`, { method: 'POST', body: JSON.stringify({ on: false }) }));
  assert.deepEqual(await switched.json(), { on: false });
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, stop, start, said('Open the release PR again'), reply('Half way.'));
  ended(task, { kind: 'error', error: { message: C499, code: 'PI_AI_ERROR' } });
  await until(() => steers.length === 2, 'the failure note');
  assert.match(await noteOf(1), /"Release PR" \(project "acme-web", chat s-task, your delegated task\): failed\. Error: "aiproxy API error \(499\)/);
  assert.equal(assistant.tasks.has('s-task'), false, 'the task goes');
  await pause(60); assert.equal(steers.length, 2, 'one note');
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log('assistant-outage-task: ok');
