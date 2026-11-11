// Assistant: the reply to a chat_send message comes back to the assistant (Host half, fake dsh, Assistant news off):
// - chat_send keeps the chat as a task with the request id of its message (`rpc`) before the message goes. dsh's
//   sessionController.prompt logs the message with source {kind: 'user', rpcId: requestId}.
// - A turn end without that message (the turn that ran when the message was queued) is no news and keeps the task.
// - The turn of that message gives one task note with its last reply (no 60 s rule), and the task goes.
// - A wait in that turn is news as for chat_new. A turn whose first step failed logs no prompt: the queued message that
//   dsh took to start it counts. dsh's quit in that turn keeps the task, and the continued turn gives the note.
// - A failed send drops the task that it added, and keeps an older task of the chat (a chat_new branch chat) as it was.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_PATH, installAssistant, installAssistantBot } from '../index.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(5); } };
const home = await mkdtemp(join(tmpdir(), 'cp-assistant-send-'));
try {
  const folder = join(home, 'Assistant');
  const workspaces = [{ id: 'w-web', title: 'acme-web', path: '/demo/acme-web', sessionIds: ['s-web', 's-branch'] }];
  const agents = new Map(); const listeners = new Map(); const routes = new Map(); const steers = []; const prompts = [];
  let created = 0; let promptFails = false; let kept;
  const newAgent = (id, header = { cwd: '/demo/acme-web' }) => {
    const registered = new Map();
    const agent = { id, status: 'idle', events: [], session: { id, header, inheritedEventCount: 0, snapshotEvents: () => agent.events },
      ctx: { tools: { register: (t) => { registered.set(t.name, t); return () => registered.delete(t.name); }, restrict: () => () => {} } },
      inbox: { prepend: (target, m) => { agent.queued = m; }, remove: () => {} }, steer: (m) => { steers.push([id, m]); }, registered };
    agents.set(id, agent);
    return agent;
  };
  const web = newAgent('s-web'); newAgent('s-branch');
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
      readTitle: async (id) => ({ title: { 's-web': 'Login page', 's-branch': 'Alt bilgi' }[id] }),
    },
    sessionController: {
      list: async () => ({ items: [] }),
      resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found', message: 'not found' } }),
      create: async ({ workspaceId }) => { created += 1; const id = `s-assistant-${created}`; newAgent(id, { cwd: folder }); workspaces.find((w) => w.id === workspaceId).sessionIds.push(id); return { sessionId: id }; },
      rename: async () => {},
      prompt: async (r, signal) => { signal.throwIfAborted(); kept = assistant.tasks.get(r.sessionId); if (promptFails) throw new Error('queue is full'); prompts.push(r); },
    },
  };
  const assistant = installAssistant(ctx, home, { folder, zone: 'UTC' });
  await assistant.ready;
  const me = agents.get((await (await routes.get(ASSISTANT_PATH).fetch(new Request(`http://x${ASSISTANT_PATH}`))).json()).sessionId);
  const timing = { turn: 60000, wait: 40, batch: 20, gap: 120000, max: 10, reply: 300, taskReply: 2000 };
  let clock = 1_000_000;
  const bot = installAssistantBot(ctx, home, assistant, { timing, now: () => clock });
  await bot.ready;
  assert.equal(bot.notify(), false, 'Assistant news is off');
  const send = (chat, text) => me.registered.get('chat_send').execute({ chat_id: chat, text }, { agent: me });
  const push = (agent, ...events) => { for (const e of events) agent.events.push({ seq: agent.events.length, ...e }); };
  const said = (text, rpcId, kind = 'user') => ({ type: 'user/message', data: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind, ...(rpcId === undefined ? {} : { rpcId }) } } });
  const reply = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
  const start = { type: 'turn/start' }; const stop = { type: 'turn/end' };
  const ended = (agent, reason = { kind: 'completed' }) => emit('session/event', agent.session, { type: 'turn/end', time: clock, data: { reason } });
  const noteOf = async (i) => (await listeners.get('agent/pre-step')[0]({ agent: me }, async () => ({ kind: 'enter', messages: [me.queued, steers[i][1]] }))).messages[0].content[0].text;

  // The chat runs an earlier turn; the message waits in its queue. The task is kept before the message goes.
  web.status = 'running';
  push(web, start, said('build the login page'), reply('Working on it.'));
  const out = await send('s-web', 'Onay: devam et');
  const rpc = prompts.at(-1).requestId;
  assert.equal(kept?.rpc, rpc, 'the task is kept with this request id before the message goes');
  assert.deepEqual(assistant.tasks.get('s-web'), { title: 'Login page', project: 'acme-web', rpc, at: assistant.tasks.get('s-web')?.at }, 'chat_send keeps a task');
  assert.match(out, /^Sent to "Login page" \(s-web\)\. You get a note/);
  // The earlier turn ends (8 s, without the message): no note, the task stays.
  clock += 8000; ended(web);
  await pause(60);
  assert.equal(steers.length, 0, 'no note for the earlier turn'); assert.deepEqual(bot.pending(), []);
  assert.equal(assistant.tasks.has('s-web'), true, 'the task stays');
  // The turn of the message ends (8 s): one note with its last reply; the task goes.
  push(web, stop, start, said('Onay: devam et', rpc), reply('Bu onay yeterli değil: SAP\'de alan açılmalı.'));
  clock += 8000; ended(web);
  await until(() => steers.length === 1, 'the note');
  assert.equal(steers[0][0], me.id);
  assert.match(await noteOf(0), /"Login page" \(project "acme-web", chat s-web, your delegated task\): finished\. Last reply: "Bu onay yeterli değil: SAP'de alan açılmalı\."/);
  assert.equal(assistant.tasks.has('s-web'), false, 'the task goes');
  await pause(60); assert.equal(steers.length, 1, 'one note');

  // An idle chat: a wait in the message's turn is news (after the gap), then its end.
  web.status = 'idle';
  await send('s-web', 'Raporu gönder');
  const rpc2 = prompts.at(-1).requestId;
  push(web, stop, start, said('Raporu gönder', rpc2), { type: 'approval/asked', data: { id: 'a' } });
  emit('session/event', web.session, { type: 'approval/asked', data: { id: 'a' } });
  await until(() => bot.pending()[0]?.kind === 'waiting', 'the wait is news');
  clock += timing.gap; await bot.flush();
  await until(() => steers.length === 2, 'the wait note');
  assert.match(await noteOf(1), /chat s-web, your delegated task\): waits for your approval/);
  assert.equal(assistant.tasks.has('s-web'), true);
  push(web, { type: 'approval/decided', data: { id: 'a' } }, reply('Rapor gönderildi.'));
  ended(web);
  await until(() => steers.length === 3, 'the end note');
  assert.match(await noteOf(2), /chat s-web, your delegated task\): finished\. Last reply: "Rapor gönderildi\."/);

  // dsh's quit in the message's turn keeps the task; the continued turn (no message of its own) gives the note.
  await send('s-web', 'Testleri çalıştır');
  push(web, stop, start, said('Testleri çalıştır', prompts.at(-1).requestId), reply('Half way.'));
  ended(web, { kind: 'aborted', reason: { kind: 'disposed' } });
  await pause(60);
  assert.equal(steers.length, 3); assert.equal(assistant.tasks.has('s-web'), true, 'dsh\'s quit keeps the task');
  assert.equal(assistant.tasks.get('s-web').rpc, undefined, 'its message ran: a later turn continues it');
  push(web, stop, start, said('', undefined, 'composer-plus-continue'), reply('Testler geçti.'));
  ended(web);
  await until(() => steers.length === 4, 'the note after the restart');
  assert.match(await noteOf(3), /chat s-web, your delegated task\): finished\. Last reply: "Testler geçti\."/);

  // A first step that failed logs no prompt: the queued message that dsh took to start the turn counts.
  await send('s-web', 'Tekrar dene');
  const rpc4 = prompts.at(-1).requestId;
  const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Tekrar dene' }], source: { kind: 'user', rpcId: rpc4 } };
  push(web, stop, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } }, start,
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } }, { type: 'step/start' }, { type: 'step/end' });
  ended(web, { kind: 'error', error: { message: 'rate limit' } });
  await until(() => steers.length === 5, 'the failure note');
  assert.match(await noteOf(4), /chat s-web, your delegated task\): failed\. Error: "rate limit"/);
  assert.equal(assistant.tasks.has('s-web'), false);

  // A failed send drops the task that it added.
  promptFails = true;
  await assert.rejects(send('s-web', 'x'), /queue is full/);
  assert.equal(kept?.rpc !== undefined, true, 'it was kept before the message went');
  assert.equal(assistant.tasks.has('s-web'), false, 'no task without its message');
  // An older task (a chat_new branch chat) keeps its fields: a failed send leaves it as it was, a sent one adds only rpc.
  await assistant.tasks.add('s-branch', { title: 'Alt bilgi ekle', project: 'acme-web', branch: 'feat/alt-bilgi' });
  await assert.rejects(send('s-branch', 'x'), /queue is full/);
  promptFails = false;
  assert.deepEqual(assistant.tasks.get('s-branch'), { title: 'Alt bilgi ekle', project: 'acme-web', branch: 'feat/alt-bilgi', at: assistant.tasks.get('s-branch')?.at }, 'the older task stays, without rpc');
  await send('s-branch', 'Footer rengini değiştir');
  assert.deepEqual(assistant.tasks.get('s-branch'), { title: 'Alt bilgi ekle', project: 'acme-web', branch: 'feat/alt-bilgi', rpc: prompts.at(-1).requestId, at: assistant.tasks.get('s-branch')?.at });
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log('assistant-send-result: ok');
