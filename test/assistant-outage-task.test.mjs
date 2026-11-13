// Assistant: a delegated task whose turn fails in an AIProxy outage (Host half, fake dsh, fake AIProxy health, Assistant
// news off):
// - Resume after an AIProxy outage on, a chat on AIProxy: the 499 request_cancelled turn end keeps the task and gives no
//   note; the turn that the outage feature continues gives one task note with its last reply.
// - The outage feature does not continue the chat (a 499 while AIProxy stays up): the "failed" note comes then, once.
// - A "Connection error." of another provider (the outage feature does not take it): the "failed" note at once.
// - chat_send: a message that waits in the queue across the outage stays the task's.
// - A 429 upstream_rejected (the provider refused the request): the task is kept, the try after the wait gives one task
//   note; at the hourly limit the "failed" note comes once.
// - Switched off: nothing continues the chat, so the same turn end gives the "failed" note and drops the task.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_PATH, OUTAGE, OUTAGE_NOTES, OUTAGE_PATH, installAssistant, installAssistantBot, installOutageResume } from '../index.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(5); } };
const C499 = 'aiproxy API error (499): {"code":"request_cancelled","message":"İstek iptal edildi."}';
const home = await mkdtemp(join(tmpdir(), 'cp-assistant-outage-'));
try {
  const folder = join(home, 'Assistant');
  const workspaces = [{ id: 'w-web', title: 'acme-web', path: '/demo/acme-web', sessionIds: ['s-task'] }];
  const agents = new Map(); const listeners = new Map(); const routes = new Map(); const steers = []; const prompts = [];
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
      prompt: async (req) => { prompts.push(req); },
    },
  };
  // As in apply(): the outage feature first, its handle goes to the bot. A fake AIProxy health and short times.
  let healthy = true;
  // `sleep` keeps the process alive (the default timer is unref'd).
  const outage = installOutageResume(ctx, home, { health: async () => healthy, sleep: pause, timing: { ...OUTAGE, window: 300, poll: 5, settle: 30, giveUp: 5000, retry: 40 } });
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
  const asked = (provider = 'aiproxy') => ({ type: 'request/header', data: { header: { config: { provider, model: 'm' } } } });
  const start = { type: 'turn/start' };
  const ended = (agent, reason = { kind: 'completed' }) => { push(agent, { type: 'turn/end', data: { reason } }); emit('session/event', agent.session, agent.events.at(-1)); };
  const failed = { kind: 'error', error: { message: C499, code: 'PI_AI_ERROR' } };
  const noteOf = async (i) => (await listeners.get('agent/pre-step')[preStep]({ agent: me }, async () => ({ kind: 'enter', messages: [me.queued, steers[i][1]] }))).messages[0].content[0].text;
  const settled = () => outage.watch.settled();

  // (a) An outage (AIProxy down, then back): the 499 turn end keeps the task and gives no note.
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, start, said('Open the release PR'), asked(), reply('Half way.'));
  healthy = false;
  ended(task, failed);
  await pause(60);
  assert.equal(assistant.tasks.has('s-task'), true, 'the outage keeps the task');
  assert.equal(steers.length, 0, 'no "failed" note'); assert.deepEqual(bot.pending(), []);
  healthy = true;
  await settled();
  assert.deepEqual(prompts.map((p) => [p.sessionId, p.content[0].text]), [['s-task', OUTAGE_NOTES.en]], 'the outage feature continues the chat');
  // The continued turn (its message through dsh's prompt) gives the one task note.
  push(task, start, said(OUTAGE_NOTES.en, prompts[0].requestId), asked(), reply('PR ready'));
  ended(task);
  await until(() => steers.length === 1, 'the note of the continued turn');
  assert.equal(steers[0][0], me.id);
  assert.match(await noteOf(0), /"Release PR" \(project "acme-web", chat s-task, your delegated task\): finished\. Last reply: "PR ready"/);
  assert.equal(assistant.tasks.has('s-task'), false, 'the task goes');
  await pause(60); assert.equal(steers.length, 1, 'exactly one note');

  // (b) A 499 while AIProxy stays up (a cancel, no outage): nothing continues the chat, so the "failed" note comes when the
  // outage feature lets the chat go.
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, start, said('Open the release PR again'), asked(), reply('Half way.'));
  ended(task, failed);
  await pause(20);
  assert.equal(steers.length, 1, 'no note while the outage feature waits');
  await settled();
  await until(() => steers.length === 2, 'the failure note after the outage feature let the chat go');
  assert.equal(prompts.length, 1, 'nothing continued');
  assert.match(await noteOf(1), /"Release PR" \(project "acme-web", chat s-task, your delegated task\): failed\. Error: "aiproxy API error \(499\)/);
  assert.equal(assistant.tasks.has('s-task'), false, 'the task goes');
  await pause(60); assert.equal(steers.length, 2, 'one note');

  // (b2) The same cancel, but you continue the chat before the outage feature lets it go: no "failed" note, the turn
  // that you started gives the task note.
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, start, said('Open the release PR again'), asked(), reply('Half way.'));
  ended(task, failed);
  push(task, start, said('continue'), asked());
  await settled(); await pause(60);
  assert.equal(steers.length, 2, 'no note while your turn runs');
  assert.equal(assistant.tasks.has('s-task'), true, 'the task stays for your turn');
  push(task, reply('PR ready now'));
  ended(task);
  await until(() => steers.length === 3, 'the note of your turn');
  assert.match(await noteOf(2), /finished\. Last reply: "PR ready now"/);

  // (c) "Connection error." of a chat on another provider: the outage feature does not take it, the note comes at once.
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, start, said('Try once more'), asked('local'), reply('Half way.'));
  ended(task, { kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } });
  await until(() => steers.length === 4, 'the failure note of another provider');
  assert.match(await noteOf(3), /failed\. Error: "Connection error\."/);
  assert.equal(assistant.tasks.has('s-task'), false, 'the task goes');

  // (d) chat_send with two messages: the first one's turn fails in an outage, the second waits in the queue. The outage
  // cannot continue the chat (the queued message runs first): that turn is the task's, and its note is the one note.
  const r1 = randomUUID(); const r2 = randomUUID();
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web', rpc: [r1, r2] });
  push(task, start, said('First', r1), asked(), reply('Half way.'));
  healthy = false;
  ended(task, failed);
  await pause(20);
  assert.deepEqual(assistant.tasks.get('s-task').rpc, ['*', r2], 'the queued message stays the task\'s');
  push(task, start, said('Second', r2), asked(), reply('Both done'));
  ended(task);
  await until(() => steers.length === 5, 'the note of the queued message');
  assert.match(await noteOf(4), /finished\. Last reply: "Both done"/);
  assert.equal(assistant.tasks.has('s-task'), false, 'the task goes');
  healthy = true;
  await settled();
  assert.equal(prompts.length, 1, 'the chat moved on: the outage feature sends nothing');
  await pause(60); assert.equal(steers.length, 5, 'no second note when the outage feature lets the chat go');

  // (f) The provider refused the task's turn (AIProxy's 429 upstream_rejected): the task is kept with no note at once, and
  // the turn that the try continues gives the one task note. The next refusal in the same hour reaches the hourly limit
  // (the outage in (a) and this try): the "failed" note comes once.
  const refused = { kind: 'error', error: { message: 'aiproxy API error (429): {"code":"upstream_rejected","message":"Sağlayıcı isteği reddetti (HTTP 429)."}', code: 'RATE_LIMIT' } };
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, start, said('Open the release PR once more'), asked(), reply('Half way.'));
  ended(task, refused);
  await pause(10);
  assert.equal(assistant.tasks.has('s-task'), true, 'the refusal keeps the task'); assert.equal(steers.length, 5, 'no note at once');
  await settled();
  assert.deepEqual(prompts.slice(1).map((p) => p.sessionId), ['s-task'], 'one try after the wait');
  push(task, start, said(OUTAGE_NOTES.en, prompts[1].requestId), asked(), reply('PR ready after the limit'));
  ended(task);
  await until(() => steers.length === 6, 'the note of the continued turn');
  assert.match(await noteOf(5), /finished\. Last reply: "PR ready after the limit"/);
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, start, said('And the tag'), asked(), reply('Half way.'));
  ended(task, refused);
  await settled();
  await until(() => steers.length === 7, 'the failure note at the hourly limit');
  assert.equal(prompts.length, 2, 'the limit: no third message');
  assert.match(await noteOf(6), /failed\. Error: "aiproxy API error \(429\)/);
  assert.equal(assistant.tasks.has('s-task'), false, 'the task goes');
  await pause(60); assert.equal(steers.length, 7, 'one note');

  // (e) Outage feature off: nothing continues the chat, so the 499 turn end is the task's result (the behavior before).
  const switched = await routes.get(OUTAGE_PATH).fetch(new Request(`http://x${OUTAGE_PATH}`, { method: 'POST', body: JSON.stringify({ on: false }) }));
  assert.deepEqual(await switched.json(), { on: false });
  await assistant.tasks.add('s-task', { title: 'Open the release PR', project: 'acme-web' });
  push(task, start, said('Open the release PR again'), asked(), reply('Half way.'));
  ended(task, failed);
  await until(() => steers.length === 8, 'the failure note');
  assert.match(await noteOf(7), /"Release PR" \(project "acme-web", chat s-task, your delegated task\): failed\. Error: "aiproxy API error \(499\)/);
  assert.equal(assistant.tasks.has('s-task'), false, 'the task goes');
  await pause(60); assert.equal(steers.length, 8, 'one note');
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log('assistant-outage-task: ok');
