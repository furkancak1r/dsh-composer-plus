// Assistant: the reply to a chat_send message comes back to the assistant (Host half, fake dsh, Assistant news off):
// - chat_send keeps the chat as a task with the request ids of its messages (`rpc`) before the message goes. dsh's
//   sessionController.prompt logs the message with source {kind: 'user', rpcId: requestId}.
// - A turn end without such a message (the turn that ran when the message was queued) is no task news and keeps the task;
//   with Assistant news on it is news as for any chat (an automation).
// - Two messages before the first reply: each turn gives its own note. A branch chat whose own turn still runs gives its
//   note, and the message's turn one more.
// - The turn of that message gives one task note with its last reply (no 60 s rule), and the task goes.
// - A wait in that turn is news as for chat_new. A turn whose first step failed logs no prompt: the queued message that
//   dsh took to start it counts. dsh's quit in that turn keeps the task, and the continued turn gives the note.
// - A failed send drops the task that it added, and keeps an older task of the chat (a chat_new branch chat) as it was.
// - A message to a chat whose question card waits answers the card (custom text), closes it and joins the same turn
//   (steer); an approval card and the Assistant switched off keep the card as it was.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_NOTIFY_PATH, ASSISTANT_PATH, ASSISTANT_SWITCH_PATH, installAssistant, installAssistantBot } from '../index.js';

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

  // The chat runs a long turn: the message goes to that turn at its next step (dsh's steer), not to the queue behind it
  // (2026-11-14: a correction waited 63 minutes in the queue of a running chat, and the result said "Sent").
  // The task is kept before the message goes.
  web.status = 'running';
  push(web, start, said('build the login page'), reply('Working on it.'));
  const out = await send('s-web', 'Onay: devam et');
  const rpc = prompts.at(-1).requestId;
  assert.equal(prompts.at(-1).mode, 'steer', 'a running chat: steer');
  assert.deepEqual(kept?.rpc, [rpc], 'the task is kept with this request id before the message goes');
  assert.deepEqual(assistant.tasks.get('s-web'), { title: 'Login page', project: 'acme-web', rpc: [rpc], at: assistant.tasks.get('s-web')?.at }, 'chat_send keeps a task');
  assert.match(out, /^Sent to "Login page" \(s-web\)\. The chat runs: the message went into its running turn, and the chat reads it at its next step\. You get a note/, 'the result says where the message went');
  // dsh logs the steered message in the running turn (its next step). That turn ends (8 s): one note with its last
  // reply; the task goes.
  push(web, { type: 'step/start' }, said('Onay: devam et', rpc), reply('Bu onay yeterli değil: SAP\'de alan açılmalı.'));
  clock += 8000; ended(web);
  await until(() => steers.length === 1, 'the note');
  assert.equal(steers[0][0], me.id);
  assert.match(await noteOf(0), /"Login page" \(project "acme-web", chat s-web, your delegated task\): finished\. Last reply: "Bu onay yeterli değil: SAP'de alan açılmalı\."/);
  assert.equal(assistant.tasks.has('s-web'), false, 'the task goes');
  await pause(60); assert.equal(steers.length, 1, 'one note');

  // An idle chat: the message goes to the queue (it starts a turn); a wait in the message's turn is news (after the gap), then its end.
  web.status = 'idle';
  const idleOut = await send('s-web', 'Raporu gönder');
  const rpc2 = prompts.at(-1).requestId;
  assert.equal(prompts.at(-1).mode, 'queue', 'an idle chat: queue');
  assert.match(idleOut, /^Sent to "Login page" \(s-web\)\. The chat was idle: the message went into its queue and starts a turn \(messages queued before it run first\)\. You get a note/);
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
  assert.deepEqual(assistant.tasks.get('s-branch'), { title: 'Alt bilgi ekle', project: 'acme-web', branch: 'feat/alt-bilgi', rpc: ['*', prompts.at(-1).requestId], at: assistant.tasks.get('s-branch')?.at },
    'it waits for its own turn end and for the message');
  const branchRpc = prompts.at(-1).requestId;
  // The branch chat's own turn ends first: its note comes, and the task waits for the message's turn.
  const branch = agents.get('s-branch');
  push(branch, start, said('Alt bilgi ekle'), reply('Alt bilgi eklendi.'));
  ended(branch);
  await until(() => steers.length === 6, 'the branch chat\'s own note');
  assert.match(await noteOf(5), /chat s-branch, your delegated task on branch "feat\/alt-bilgi"\): finished\. Last reply: "Alt bilgi eklendi\."/);
  assert.deepEqual(assistant.tasks.get('s-branch')?.rpc, [branchRpc], 'the message still waits');
  push(branch, stop, start, said('Footer rengini değiştir', branchRpc), reply('Renk değişti.'));
  ended(branch);
  await until(() => steers.length === 7, 'the note of the message');
  assert.match(await noteOf(6), /chat s-branch, your delegated task on branch "feat\/alt-bilgi"\): finished\. Last reply: "Renk değişti\."/);
  assert.equal(assistant.tasks.has('s-branch'), false);

  // Two queued messages before the first reply (an idle chat; and a third that fails): each message's turn gives its own note.
  await send('s-web', 'Birinci'); const first = prompts.at(-1).requestId;
  await send('s-web', 'İkinci'); const second = prompts.at(-1).requestId;
  promptFails = true; await assert.rejects(send('s-web', 'Üçüncü'), /queue is full/); promptFails = false;
  assert.deepEqual(assistant.tasks.get('s-web')?.rpc, [first, second], 'a failed send takes out only its own id');
  push(web, stop, start, said('Birinci', first), reply('Birinci bitti.'));
  ended(web);
  await until(() => steers.length === 8, 'the first note');
  assert.match(await noteOf(7), /chat s-web, your delegated task\): finished\. Last reply: "Birinci bitti\."/);
  assert.deepEqual(assistant.tasks.get('s-web')?.rpc, [second]);
  push(web, stop, start, said('İkinci', second), reply('İkinci bitti.'));
  ended(web);
  await until(() => steers.length === 9, 'the second note');
  assert.match(await noteOf(8), /chat s-web, your delegated task\): finished\. Last reply: "İkinci bitti\."/);
  assert.equal(assistant.tasks.has('s-web'), false);
  await pause(60); assert.equal(steers.length, 9, 'one note each');

  // Assistant news on: an automation turn that runs before the message is still news; the message's turn gives the task note.
  const switched = await routes.get(ASSISTANT_NOTIFY_PATH).fetch(new Request(`http://x${ASSISTANT_NOTIFY_PATH}`, { method: 'POST', body: JSON.stringify({ on: true }) }));
  assert.equal((await switched.json()).on, true);
  await send('s-web', 'Sonra şunu yap'); const later = prompts.at(-1).requestId;
  push(web, stop, start, said('Gece raporu', undefined, 'schedule'), reply('Gece raporu hazır.'));
  ended(web);
  await until(() => bot.pending()[0]?.automation === true, 'the automation is news');
  clock += timing.gap; await bot.flush();
  await until(() => steers.length === 10, 'the automation note');
  assert.match(await noteOf(9), /chat s-web, an automation\): finished\. Last reply: "Gece raporu hazır\."/);
  assert.deepEqual(assistant.tasks.get('s-web')?.rpc, [later], 'the task still waits for its message');
  push(web, stop, start, said('Sonra şunu yap', later), reply('Yapıldı.'));
  ended(web);
  await until(() => steers.length === 11, 'the task note');
  assert.match(await noteOf(10), /chat s-web, your delegated task\): finished\. Last reply: "Yapıldı\."/);

  // A question card waits in the chat (dsh's ask_user_question without intent; 2026-11-13: five chats waited 55 minutes
  // with the answers in their queue): the message answers the card (each question gets the text), the card closes on every
  // screen (its request signal aborts) and the message goes into the same turn (steer), whose end gives the note.
  // dsh's card answerer (api-remotes, the innermost listener here) settles only when a screen answers or the signal aborts.
  const shown = [];
  const ask = (agent, questions) => {
    const request = { agent, questions, signal: new AbortController().signal }; const given = request.signal;
    const fns = listeners.get('user-questions/request') ?? [];
    const run = (i) => (i < fns.length ? fns[i](request, () => run(i + 1)) : new Promise((resolve, reject) => {
      shown.push({ request, resolve }); request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    }));
    return { request, given, answer: run(0) };
  };
  const within = (promise) => Promise.race([promise, pause(300).then(() => 'still open')]);
  const questions = [{ id: 'field', question: 'Which field?', options: [{ label: 'MinLevel (Recommended)' }] }, { id: 'scope', question: 'Which warehouses?' }];
  push(web, stop, start, said('Depo stok paneli'), { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q1' } });
  const card = ask(web, questions);
  await until(() => shown.length === 1, 'the card shows');
  const answer = '1. MinLevel 2. Tümü';
  // The approval card says that the message answers a waiting question (the user approves that decision too).
  const gate = listeners.get('tools/pre-execute')[0];
  const reason = async (chat) => (await gate({ name: 'chat_send', agent: me, arguments: { chat_id: chat, text: answer } }, async () => ({ kind: 'allow' }))).reason;
  assert.match(await reason('s-web'), /: "1\. MinLevel 2\. Tümü" It answers the question card that waits there\.$/);
  assert.match(await reason(' s-web '), /It answers the question card/, 'the chat id as chat_send reads it (trimmed)');
  assert.doesNotMatch(await reason('s-branch'), /question card/, 'no card in that chat');
  const sent = await send('s-web', answer);
  const cardRpc = prompts.at(-1).requestId;
  assert.deepEqual(await within(card.answer), { answers: [{ id: 'field', selected: [], custom: answer }, { id: 'scope', selected: [], custom: answer }] }, 'the message answers the card');
  assert.equal(shown[0].request.signal.aborted, true, 'the card closes on every screen');
  assert.equal(prompts.at(-1).mode, 'steer', 'the message goes into the same turn at its next step');
  assert.match(sent, /answered the question card/);
  push(web, said(answer, cardRpc), reply('Devam ediyorum.'));
  ended(web);
  await until(() => steers.length === 12, 'the note of that turn');
  assert.match(await noteOf(11), /chat s-web, your delegated task\): finished\. Last reply: "Devam ediyorum\."/);
  // An approval card (intent) stays for the user, and the message waits in the queue as before.
  const approval = ask(web, [{ ...questions[0], intent: { kind: 'approval', approve: 'MinLevel (Recommended)', reject: 'No' }, detail: 'x' }]);
  await until(() => shown.length === 2, 'the approval card');
  await send('s-web', 'Evet');
  assert.equal(await within(approval.answer), 'still open'); assert.equal(approval.request.signal, approval.given, 'the approval card is not touched');
  assert.equal(prompts.at(-1).mode, 'queue');
  shown[1].resolve({ answers: [] }); await approval.answer;
  // That queued message's turn ends: its note.
  push(web, stop, start, said('Evet', prompts.at(-1).requestId), reply('Tamam.'));
  ended(web);
  await until(() => steers.length === 13, 'the note of the queued message');
  // A steer that came after the running turn's last inbox check: the turn ends without it (no note, the task stays), and
  // the idle chat is woken for it once (a Continue marker at the queue head and one as a steer). The turn that the wake
  // starts logs the message: its end gives the note.
  web.inbox.nextStep = []; web.queued = undefined;
  web.status = 'running'; push(web, stop, start, said('Uzun iş'));
  await send('s-web', 'Acil: dur, bu değişiklik reddedildi.'); const late = prompts.at(-1).requestId;
  assert.equal(prompts.at(-1).mode, 'steer');
  web.inbox.nextStep = [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Acil: dur, bu değişiklik reddedildi.' }], source: { kind: 'user', rpcId: late } }];
  web.status = 'idle'; push(web, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); ended(web);
  await until(() => steers.length === 14, 'the wake');
  assert.deepEqual([steers[13][0], steers[13][1].source.kind, web.queued?.source?.kind], ['s-web', 'composer-plus-assistant-interject', 'composer-plus-assistant-interject'], 'one wake of the chat');
  assert.equal(assistant.tasks.get('s-web')?.rpc?.[0], late, 'no note yet: the task waits for the message');
  push(web, start, said('Acil: dur, bu değişiklik reddedildi.', late), reply('Durdum.'));
  ended(web);
  await until(() => steers.length === 15, 'the note of the late steer');
  assert.match(await noteOf(14), /chat s-web, your delegated task\): finished\. Last reply: "Durdum\."/);
  // After a Stop or an error, a late steer waits for the chat's next turn (no wake, as a queued message in dsh).
  web.status = 'running'; push(web, stop, start); await send('s-web', 'Bir şey daha'); web.queued = undefined;
  web.inbox.nextStep = [{ id: randomUUID(), role: 'user', content: [], source: { kind: 'user', rpcId: prompts.at(-1).requestId } }];
  web.status = 'idle'; push(web, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }); ended(web, { kind: 'aborted', reason: { kind: 'user' } });
  await pause(60); assert.equal(steers.length, 15, 'no wake after a stop'); assert.equal(web.queued, undefined);
  // Assistant off: the cards of the chats are not touched.
  const off = await routes.get(ASSISTANT_SWITCH_PATH).fetch(new Request(`http://x${ASSISTANT_SWITCH_PATH}`, { method: 'POST', body: JSON.stringify({ on: false }) }));
  assert.equal((await off.json()).on, false);
  const offCard = ask(web, questions);
  await until(() => shown.length === 3, 'the card while off');
  assert.equal(offCard.request.signal, offCard.given, 'switch off: the card is not touched');
  shown[2].resolve({ answers: [] }); await offCard.answer;
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log('assistant-send-result: ok');
