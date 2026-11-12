// Assistant as a bot (Host half) with a fake dsh:
// - assistant-status gives the assistant chat id (null while Assistant is off) and never makes a chat.
// - Assistant always free (on by default, an explicit off stays off): the assistant chat itself may call only short tools;
//   any other call is denied with a reason that says to use a background subagent. Its subagents and other chats are not
//   touched; a denial stays a denial; without a subagent tool in its newest request the rule does nothing (active: false).
//   dsh 0.2.0's subagent must run in the background. The prompt section goes only to the assistant chat while on.
// - Assistant news from chats (off by default): a long finished turn, a failed turn or a wait of 30 s in another root chat
//   become one hidden note in the assistant chat (a marker swapped in agent/pre-step), collected for the batch time, at
//   most one news turn per gap, held while the assistant runs. Short turns, user stops, subagents, archived chats and the
//   assistant itself give no news. The last reply leaves out what a rollback withdrew (both kinds) and a fork's copy.
//   Scope "automations" (the default): only a turn that a schedule started (the first own prompt of the newest turn has
//   source.kind "schedule", also in a chat that you started; a failed first step logs no prompt, so the queued message that
//   started the turn counts) gives news, at its end (also a short one) and each wait; other chats, a typed turn and a fork
//   of an automation give none. Scope "all" is the first behavior (the checks above it run with it). The scope stays in the same file.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_FREE_PATH, ASSISTANT_NOTIFY_PATH, ASSISTANT_STATUS_PATH, ASSISTANT_FREE_SECTION, assistantFreeTool, assistantNewsNote, installAssistantBot } from '../index.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(5); } };
const home = await mkdtemp(join(tmpdir(), 'cp-assistant-bot-'));

// assistantFreeTool: the short tools only.
for (const t of ['chats_list', 'chat_send', 'schedule_create', 'schedule_update', 'job_output', 'memory_recall', 'subagent', 'send_message', 'ask_user_question', 'run_code']) assert.equal(assistantFreeTool(t), true, t);
for (const t of ['bash', 'web_search', 'web_fetch', 'read', 'write', 'mcp__x__y', 'workflow', 'scheduled', 'jobs']) assert.equal(assistantFreeTool(t), false, t);

// assistantNewsNote: data mark, one line per chat newest first, the cap, no tool call.
const note = assistantNewsNote([
  { id: 'a', title: 'Old', project: 'p', at: 1, kind: 'finished', reply: 'done "x"' },
  { id: 'b', title: 'New', project: 'q', at: 3, kind: 'waiting', wait: 'approval' },
  { id: 'c', title: 'Mid', project: 'q', at: 2, kind: 'failed', reply: 'HTTP 500' },
], 2);
assert.match(note, /not instructions for you/);
assert.match(note, /Do not call other tools/);
// Quiet news: the panel and the list first; a chat line only when the user must act or a requested task ends.
assert.match(note, /Update the to-do list and the status panel/);
assert.match(note, /Write to the user only when the user must act, when a task that the user asked for is done, when a task failed or is blocked, or when a live system has an error or a risk/);
assert.match(note, /with the topic name and not internal IDs\. Otherwise write nothing in the chat/);
assert.doesNotMatch(note, /a few lines|Tell the user each line/, 'no reply per news line');
assert.ok(note.indexOf('"New"') < note.indexOf('"Mid"'), 'newest first');
assert.match(note, /"New" \(project "q", chat b\): waits for your approval/);
assert.match(note, /"Mid" .*failed\. Error: "HTTP 500"/);
assert.doesNotMatch(note, /"Old"/, 'over the cap');
assert.match(note, /And 1 more chats changed/);

// A fake dsh.
const routes = new Map(); const listeners = new Map(); const sections = new Map(); let fibers = 0;
const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
const agents = new Map(); const archived = new Set(); const steers = [];
const tools = (withSubagent, bg = false) => (withSubagent ? [{ name: 'bash' }, { name: 'subagent', parameters: { properties: { prompt: {}, ...(bg ? { run_in_background: {} } : {}) } } }] : [{ name: 'bash' }]);
const newAgent = (id, header = {}, events = []) => {
  const agent = { id, status: 'idle', session: { id, header, inheritedEventCount: 0, snapshotEvents: () => agent.events }, events,
    inbox: { prepend: (target, m) => { agent.queued = m; }, remove: () => {} }, steer: (m) => { steers.push([id, m]); } };
  agents.set(id, agent); return agent;
};
const assistantAgent = newAgent('s-assistant', { cwd: '/home/demo/Assistant' }, [{ type: 'request/header', data: { header: { tools: tools(true) } } }]);
// Its subagent and another chat also have the subagent tool: only the assistant chat itself is limited.
const sub = newAgent('s-assistant-sub', { origin: 'subagent', parentSession: 's-assistant', delegationDepth: 1 }, [{ type: 'request/header', data: { header: { tools: tools(true) } } }]);
const web = newAgent('s-web', { cwd: '/demo/acme-web' }, [{ type: 'request/header', data: { header: { tools: tools(true) } } }]);
let assistantOn = true;
const assistant = { ready: Promise.resolve(), isOn: () => assistantOn, id: () => 's-assistant', isAssistant: (a) => assistantOn && a?.id === 's-assistant' };
let clock = 1_000_000;
const ctx = {
  logger: { warn: () => {} },
  get: (name) => ({ agents: { get: (id) => agents.get(id) }, workspaceRegistry: { get archivedSessionIds() { return [...archived]; }, list: () => [{ title: 'acme-web', path: '/demo/acme-web', sessionIds: ['s-web'] }] } })[name],
  on,
  effect: () => {},
  inject: (deps, setup) => { fibers += 1; const mine = []; setup({ systemPrompt: { section: (s) => { sections.set(s.name, s); mine.push(s.name); } } }); return { dispose: () => { fibers -= 1; for (const n of mine) sections.delete(n); } }; },
  connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  sessionQuery: { readTitle: async (id) => ({ title: { 's-web': 'Login page', 's-cli': 'Weather' }[id] }) },
  sessionController: { resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }) },
};
const timing = { turn: 60000, wait: 40, batch: 30, gap: 120000, max: 10, reply: 300 };
const bot = installAssistantBot(ctx, home, assistant, { timing, now: () => clock });
await bot.ready;
const call = async (path, method = 'GET', body) => {
  const res = await routes.get(path).fetch(new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { status: res.status, body: await res.json() };
};

// assistant-status: the id while on, null while off; never makes a chat.
assert.deepEqual((await call(ASSISTANT_STATUS_PATH)).body, { sessionId: 's-assistant' });
assistantOn = false; assert.deepEqual((await call(ASSISTANT_STATUS_PATH)).body, { sessionId: null }); assistantOn = true;

// Assistant always free: on by default; the section only in the assistant chat.
assert.deepEqual((await call(ASSISTANT_FREE_PATH)).body, { on: true, active: true });
const free = sections.get('composer-plus:assistant-free');
assert.equal(free.text({ agent: assistantAgent }), ASSISTANT_FREE_SECTION);
assert.equal(free.text({ agent: web }), ''); assert.equal(free.text({ agent: sub }), '');
const pre = (name, agent, decision = { kind: 'allow' }, args = '{}') => listeners.get('tools/pre-execute')[0]({ name, agent, arguments: args }, async () => decision);
let d = await pre('bash', assistantAgent);
assert.equal(d.kind, 'deny'); assert.match(d.reason, /Assistant always free.*subagent tool in the background/);
assert.equal((await pre('web_fetch', assistantAgent)).kind, 'deny');
assert.equal((await pre('mcp__ddg__search', assistantAgent)).kind, 'deny');
for (const t of ['chats_list', 'schedule_create', 'memory_remember', 'subagent', 'job_output']) assert.equal((await pre(t, assistantAgent)).kind, 'allow', `${t} allowed`);
assert.equal((await pre('chat_send', assistantAgent, { kind: 'ask', reason: 'card' })).kind, 'ask', 'the approval card stays');
assert.equal((await pre('bash', assistantAgent, { kind: 'deny', reason: 'blocked' })).reason, 'blocked', 'a denial stays as it is');
assert.equal((await pre('bash', sub)).kind, 'allow', 'its subagent works');
assert.equal((await pre('bash', web)).kind, 'allow', 'other chats work');
// dsh 0.2.0: subagent waits unless run_in_background is true.
assistantAgent.events.push({ type: 'request/header', data: { header: { tools: tools(true, true) } } });
assert.equal((await pre('subagent', assistantAgent, { kind: 'allow' }, { prompt: 'x' })).kind, 'deny', 'a waiting subagent is refused');
assert.equal((await pre('subagent', assistantAgent, { kind: 'allow' }, { prompt: 'x', run_in_background: true })).kind, 'allow');
// No subagent tool: the rule does nothing and the route says it is not active.
assistantAgent.events.push({ type: 'request/header', data: { header: { tools: tools(false) } } });
assert.equal((await pre('bash', assistantAgent)).kind, 'allow', 'no subagent tool: no rule');
assert.deepEqual((await call(ASSISTANT_FREE_PATH)).body, { on: true, active: false });
assert.equal(free.text({ agent: assistantAgent }), '', 'no section without the subagent tool');
assistantAgent.events.push({ type: 'request/header', data: { header: { tools: tools(true) } } });
// Off: no rule, no section; an explicit off stays off after a restart; a broken file reads as on.
assert.equal((await call(ASSISTANT_FREE_PATH, 'POST', { on: 'no' })).status, 400);
assert.deepEqual((await call(ASSISTANT_FREE_PATH, 'POST', { on: false })).body, { on: false, active: false });
assert.equal((await pre('bash', assistantAgent)).kind, 'allow'); assert.equal(sections.has('composer-plus:assistant-free'), false); assert.equal(fibers, 1, 'only the fiber of Assistant callouts stays'); assert.ok(sections.has('composer-plus:assistant-callouts'));
const restart = async (text) => {
  await mkdir(join(home, 'storages/dsh-composer-plus'), { recursive: true });
  if (text !== undefined) await writeFile(join(home, 'storages/dsh-composer-plus/assistant-free.json'), text);
  const r = new Map(); const b = installAssistantBot({ ...ctx, on: () => {}, connection: { fetch: { register: (route) => { r.set(route.path, route); } } } }, home, assistant, { timing });
  await b.ready; return b.free();
};
assert.equal(await restart(), false, 'an explicit off stays off');
assert.equal(await restart('{broken'), true, 'a broken file: on');
assert.deepEqual((await call(ASSISTANT_FREE_PATH, 'POST', { on: true })).body, { on: true, active: true });
assert.equal((await pre('bash', assistantAgent)).kind, 'deny');

// Assistant news: off by default, only automations by default.
assert.deepEqual((await call(ASSISTANT_NOTIFY_PATH)).body, { on: false, scope: 'automations' });
for (const bad of [{ scope: 'some' }, { scope: 'all', on: true }, { on: 1 }]) assert.equal((await call(ASSISTANT_NOTIFY_PATH, 'POST', bad)).status, 400, JSON.stringify(bad));
// The checks below use the first behavior (every chat).
assert.deepEqual((await call(ASSISTANT_NOTIFY_PATH, 'POST', { scope: 'all' })).body, { on: false, scope: 'all' });
const turn = (session, kind, ms, extra = {}) => {
  emit('session/event', session.session, { type: 'turn/start', time: clock });
  clock += ms;
  emit('session/event', session.session, { type: 'turn/end', time: clock, data: { reason: { kind, ...extra } } });
};
turn(web, 'completed', 90000);
await pause(80);
assert.equal(bot.pending().length, 0, 'nothing while off');
assert.deepEqual((await call(ASSISTANT_NOTIFY_PATH, 'POST', { on: true })).body, { on: true, scope: 'all' });

// A long turn: one note after the batch time; the reply leaves out a withdrawn one and a fork's copy.
const um = (seq, text, kind = 'user', extra = {}) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } }, ...extra });
const am = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
web.events = [{ seq: 0, type: 'turn/start' }, um(1, 'go'), am(2, 'The login page is ready.'), am(3, 'secret withdrawn reply'), um(4, 'marker', 'dsh-rewind', { sourceEventSeqs: [3] })];
turn(web, 'completed', 90000);
await pause(10);
assert.equal(steers.length, 0, 'waits for the batch');
await until(() => steers.length === 1, 'one wake'); assert.equal(steers[0][0], 's-assistant');
assert.equal(steers[0][1].source.kind, 'composer-plus-assistant-news'); assert.deepEqual(steers[0][1].content, [], 'an empty marker');
assert.equal(assistantAgent.queued.source.kind, 'composer-plus-assistant-news', 'a second marker at the queue head');
// The pre-step swaps the markers for one note (no chat bubble: the note has its own source).
const user = { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } };
const step = await listeners.get('agent/pre-step')[0]({ agent: assistantAgent }, async () => ({ kind: 'enter', messages: [assistantAgent.queued, steers[0][1], user] }));
assert.equal(step.messages.length, 2, 'two markers → one note');
assert.equal(step.messages[0].source.kind, 'composer-plus-assistant-news');
const text = step.messages[0].content[0].text;
assert.match(text, /"Login page" \(project "acme-web", chat s-web\): finished\. Last reply: "The login page is ready\."/);
assert.doesNotMatch(text, /secret withdrawn/, 'a withdrawn reply is left out');
assert.equal(step.messages[1], user, 'the user\'s own message stays');
assert.deepEqual((await listeners.get('agent/pre-step')[0]({ agent: web }, async () => ({ kind: 'enter', messages: [user] }))).messages, [user], 'other steps unchanged');

// Within the gap: a new event waits; it goes when the gap ends (here: the clock moves).
const cli = newAgent('s-cli', { cwd: '/demo/weather-cli' });
turn(cli, 'error', 1000, { error: { message: 'HTTP 500' } });
await until(() => bot.pending()[0]?.kind === 'failed', 'the failed turn is news');
await pause(80);
assert.equal(steers.length, 1, 'held by the gap');
clock += 120000; await bot.flush();
assert.equal(steers.length, 2, 'after the gap');

// No news: a short turn, a stop by the user, a subagent, an archived chat, the assistant itself.
clock += 200000;
turn(web, 'completed', 5000);
turn(web, 'aborted', 90000, { reason: { kind: 'user' } });
turn(sub, 'completed', 90000);
turn(assistantAgent, 'completed', 90000);
archived.add('s-cli'); turn(cli, 'error', 1000, { error: { message: 'x' } }); archived.delete('s-cli');
await pause(80);
assert.equal(bot.pending().length, 0, 'none of these is news'); assert.equal(steers.length, 2);

// A wait of 30 s (here 40 ms): news; a wait answered before that: none.
// The assistant runs: the news waits until it is idle, then goes after the batch time.
assistantAgent.status = 'running';
web.events = [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'approval/asked', data: { id: 'x' } }];
emit('session/event', web.session, { type: 'turn/start', time: clock });
emit('session/event', web.session, { type: 'approval/asked', data: { id: 'x' } });
await until(() => bot.pending()[0]?.kind === 'waiting', 'a long wait is news');
await pause(80);
assert.equal(steers.length, 2, 'held while the assistant runs');
assistantAgent.status = 'idle'; emit('agent/status', { agent: assistantAgent, status: 'idle' });
await until(() => steers.length === 3, 'after the assistant is idle');
assert.match(assistantNewsNote(bot.pending()), /Assistant news/);
clock += 200000;
web.events.push({ seq: 2, type: 'approval/decided', data: { id: 'x' } });
emit('session/event', web.session, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q' } });
web.events.push({ seq: 3, type: 'tool/call', data: { name: 'ask_user_question', callId: 'q' } }, { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'q' } } } });
await pause(60);
assert.equal(bot.pending().length, 0, 'an answered wait is no news');

// A fork: only the chat's own events (its parent's reply is not this chat's reply).
clock += 200000;
web.session.inheritedEventCount = 2;
web.events = [{ seq: 0, type: 'turn/start' }, am(1, 'parent reply'), um(2, 'own message')];
turn(web, 'completed', 90000);
await until(() => bot.pending()[0]?.kind === 'finished', 'the fork turn is news');
assert.equal(bot.pending()[0].reply, '', 'no inherited reply');
web.session.inheritedEventCount = 0;

// Off: the queue is dropped, no more wakes.
turn(web, 'completed', 90000);
assert.deepEqual((await call(ASSISTANT_NOTIFY_PATH, 'POST', { on: false })).body, { on: false, scope: 'all' });
await pause(80);
assert.equal(bot.pending().length, 0); assert.equal(steers.length, 3);
// Assistant off: no news either.
await call(ASSISTANT_NOTIFY_PATH, 'POST', { on: true }); assistantOn = false;
turn(web, 'completed', 90000); await pause(80);
assert.equal(steers.length, 3, 'no news while Assistant is off');

// Scope "automations": a chat that a schedule started reports each turn end like a subagent; other chats stay quiet.
assistantOn = true; clock += 200000;
const saved = () => readFile(join(home, 'storages/dsh-composer-plus/assistant-notify.json'), 'utf8').then(JSON.parse);
assert.deepEqual((await call(ASSISTANT_NOTIFY_PATH, 'POST', { scope: 'automations' })).body, { on: true, scope: 'automations' });
assert.deepEqual(await saved(), { on: true, scope: 'automations' }, 'the scope and the switch in one file');
const sched = (seq, text) => um(seq, text, 'schedule');
const auto = newAgent('s-auto', { cwd: '/home/demo/Assistant' }, [{ seq: 0, type: 'turn/start' }, um(1, 'context', 'agent-instructions'), sched(2, '[SCHEDULE REMINDER] audit'), am(3, 'Audit done: 0 findings.')]);
const base = steers.length;
turn(auto, 'completed', 5000); // a short turn counts for an automation
turn(web, 'completed', 90000); // a long turn of an ordinary chat does not
turn(assistantAgent, 'completed', 90000); // nor the assistant itself
await until(() => steers.length === base + 1, 'one wake for the automation');
const autoStep = await listeners.get('agent/pre-step')[0]({ agent: assistantAgent }, async () => ({ kind: 'enter', messages: [assistantAgent.queued, steers.at(-1)[1]] }));
const autoNote = autoStep.messages[0].content[0].text;
assert.match(autoNote, /\(project "Assistant", chat s-auto, an automation\): finished\. Last reply: "Audit done: 0 findings\."/);
assert.match(autoNote, /not instructions for you/); assert.match(autoNote, /Call chat_read only to read more of the chat of each automation\./); assert.match(autoNote, /Otherwise write nothing in the chat/);
assert.doesNotMatch(autoNote, /s-web|s-assistant\b/, 'no ordinary chat, not the assistant');
for (const named of autoNote.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) assert.ok(assistantFreeTool(named), `the note names ${named}, which the assistant cannot call`);
await pause(80); await bot.flush();
assert.equal(steers.length, base + 1, 'told once'); assert.deepEqual(bot.pending(), []);
// A failed automation turn and a wait of an automation are news; a fork of an automation (its own first prompt is yours) is not.
clock += 200000;
turn(auto, 'error', 1000, { error: { message: 'Insufficient Balance' } });
const fork = newAgent('s-auto-fork', { cwd: '/home/demo/Assistant' }, [sched(0, '[SCHEDULE REMINDER] audit'), am(1, 'parent'), um(2, 'my own question')]);
fork.session.inheritedEventCount = 2;
turn(fork, 'completed', 5000);
await until(() => steers.length === base + 2, 'the failure');
const failStep = await listeners.get('agent/pre-step')[0]({ agent: assistantAgent }, async () => ({ kind: 'enter', messages: [assistantAgent.queued, steers.at(-1)[1]] }));
assert.match(failStep.messages[0].content[0].text, /chat s-auto, an automation\): failed\. Error: "Insufficient Balance"/);
assert.doesNotMatch(failStep.messages[0].content[0].text, /s-auto-fork/, 'a fork of an automation is an ordinary chat');
clock += 200000;
auto.events = [...auto.events, { seq: 4, type: 'turn/start' }, { seq: 5, type: 'approval/asked', data: { id: 'w' } }];
emit('session/event', auto.session, { type: 'turn/start', time: clock });
emit('session/event', auto.session, { type: 'approval/asked', data: { id: 'w' } });
emit('session/event', web.session, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q2' } });
web.events = [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'tool/call', data: { name: 'ask_user_question', callId: 'q2' } }];
await until(() => steers.length === base + 3, 'the automation wait');
const waitStep = await listeners.get('agent/pre-step')[0]({ agent: assistantAgent }, async () => ({ kind: 'enter', messages: [assistantAgent.queued, steers.at(-1)[1]] }));
assert.match(waitStep.messages[0].content[0].text, /chat s-auto, an automation\): waits for your approval/);
assert.doesNotMatch(waitStep.messages[0].content[0].text, /s-web/, 'the wait of an ordinary chat is no news');
// Off: an automation gives no news either.
clock += 200000;
await call(ASSISTANT_NOTIFY_PATH, 'POST', { on: false });
assert.deepEqual(await saved(), { on: false, scope: 'automations' }, 'the switch keeps the scope');
turn(auto, 'completed', 5000); await pause(80);
assert.equal(steers.length, base + 3, 'switched off: no news'); assert.deepEqual(bot.pending(), []);
// A schedule that delivers into a chat that you started by typing: that turn is an automation (its end and its wait);
// a turn that you type there later is not.
await call(ASSISTANT_NOTIFY_PATH, 'POST', { on: true }); clock += 200000;
const typed = newAgent('s-typed', { cwd: '/home/demo/Assistant' }, [{ seq: 0, type: 'turn/start' }, um(1, 'set up audit'), am(2, 'Done.'), { seq: 3, type: 'turn/end' }, { seq: 4, type: 'turn/start' }, sched(5, '[SCHEDULE REMINDER] audit'), am(6, 'Audit: 2 findings.')]);
const before = steers.length;
turn(typed, 'completed', 5000);
await until(() => steers.length === before + 1, 'one wake for the scheduled turn of a typed chat');
const typedStep = await listeners.get('agent/pre-step')[0]({ agent: assistantAgent }, async () => ({ kind: 'enter', messages: [assistantAgent.queued, steers.at(-1)[1]] }));
assert.match(typedStep.messages[0].content[0].text, /\(project "Assistant", chat s-typed, an automation\): finished\. Last reply: "Audit: 2 findings\."/);
clock += 200000;
typed.events.push({ seq: 7, type: 'turn/end' }, { seq: 8, type: 'turn/start' }, sched(9, '[SCHEDULE REMINDER] audit'), { seq: 10, type: 'approval/asked', data: { id: 't' } });
emit('session/event', typed.session, { type: 'turn/start', time: clock });
emit('session/event', typed.session, { type: 'approval/asked', data: { id: 't' } });
await until(() => steers.length === before + 2, 'the wait of a scheduled turn');
const typedWait = await listeners.get('agent/pre-step')[0]({ agent: assistantAgent }, async () => ({ kind: 'enter', messages: [assistantAgent.queued, steers.at(-1)[1]] }));
assert.match(typedWait.messages[0].content[0].text, /chat s-typed, an automation\): waits for your approval/);
clock += 200000;
typed.events.push({ seq: 11, type: 'approval/decided', data: { id: 't' } }, { seq: 12, type: 'turn/end' }, { seq: 13, type: 'turn/start' }, um(14, 'thanks'), am(15, 'You are welcome.'));
turn(typed, 'completed', 5000);
await pause(80); await bot.flush();
assert.equal(steers.length, before + 2, 'a turn that you typed in that chat is no news'); assert.deepEqual(bot.pending(), []);
// A turn whose first step fails (an unknown model, a rate limit) logs no prompt: dsh only took it out of the queue. A
// scheduled delivery that fails so after a typed turn is an automation's failure; a typed prompt that fails so after a
// scheduled turn is not.
const queued = (seq, kind, id) => ({ seq, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id, role: 'user', content: [], source: { kind } }] } });
const taken = (seq) => ({ seq, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } });
const failedStart = (seq, kind, id) => [{ seq, type: 'turn/end' }, queued(seq + 1, kind, id), { seq: seq + 2, type: 'turn/start' }, taken(seq + 3), { seq: seq + 4, type: 'step/start' }, { seq: seq + 5, type: 'step/end' }];
clock += 200000;
typed.events.push(...failedStart(16, 'schedule', 'q1'));
turn(typed, 'error', 1000, { error: { message: 'no configured model' } });
await until(() => steers.length === before + 3, 'the failed first step of a scheduled turn');
const typedFail = await listeners.get('agent/pre-step')[0]({ agent: assistantAgent }, async () => ({ kind: 'enter', messages: [assistantAgent.queued, steers.at(-1)[1]] }));
assert.match(typedFail.messages[0].content[0].text, /chat s-typed, an automation\): failed\. Error: "no configured model"/);
clock += 200000;
typed.events.push({ seq: 22, type: 'turn/end' }, { seq: 23, type: 'turn/start' }, sched(24, '[SCHEDULE REMINDER] audit'), am(25, 'Audit: 0 findings.'), ...failedStart(26, 'user', 'q2'));
turn(typed, 'error', 1000, { error: { message: 'rate limit' } });
await pause(80); await bot.flush();
assert.equal(steers.length, before + 3, 'a typed prompt whose first step failed is no automation'); assert.deepEqual(bot.pending(), []);
// The saved file at the next start: no scope (an older copy's file) reads as automations; "all" stays.
const startWith = async (text) => {
  await writeFile(join(home, 'storages/dsh-composer-plus/assistant-notify.json'), text);
  const r = new Map(); const b = installAssistantBot({ ...ctx, on: () => {}, connection: { fetch: { register: (route) => { r.set(route.path, route); } } } }, home, assistant, { timing });
  await b.ready; return (await r.get(ASSISTANT_NOTIFY_PATH).fetch(new Request('http://x'))).json();
};
assert.deepEqual(await startWith('{"on":true}'), { on: true, scope: 'automations' });
assert.deepEqual(await startWith('{"on":true,"scope":"all"}'), { on: true, scope: 'all' });
assert.deepEqual(await startWith('{broken'), { on: false, scope: 'automations' });

await rm(home, { recursive: true, force: true });
console.log('assistant-bot: ok');
