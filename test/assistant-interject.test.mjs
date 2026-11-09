// Assistant interjection (part of Assistant always free), with a small model of dsh's agent loop (dsh-agent-loop: send,
// wakeDriver, kick, turn; 0.2.0-rc.2 to 0.2.2-rc.1):
// 1. A message that you type while the assistant's turn runs goes into that turn at its next step (no second turn, nothing
//    cancelled); your message comes before the notices of the same step. Other chats and the switch off keep dsh's queue.
//    A message that comes while the turn ends (after dsh's last inbox check) still runs; after your Stop it waits, as in dsh.
// 2. dsh's "finished" notice of a subagent that sent its result first (dsh 0.2.2 marks it) starts no turn and adds no step:
//    it goes to the model with the next turn. Other notices, other chats and the switch off: dsh's behavior.
// 3. A message typed while a question card of the assistant is open answers the card (custom text) and closes it; the
//    message stays in the turn. Approval cards, other chats and the switch off: the card stays open.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ASSISTANT_FREE_PATH, installAssistantBot } from '../index.js';

const pause = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(2); } };
const home = await mkdtemp(join(tmpdir(), 'cp-assistant-interject-'));

// A fake dsh: events, waterfalls (prepend = outermost) and routes.
const listeners = new Map(); const routes = new Map();
const on = (name, fn, opts) => { const list = listeners.get(name) ?? []; (opts === true || opts?.prepend) ? list.unshift(fn) : list.push(fn); listeners.set(name, list); return () => list.splice(list.indexOf(fn), 1); };
const emit = (name, ...args) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); };
const waterfall = (name, payload, inner) => { const fns = [...(listeners.get(name) ?? [])]; const run = (i) => (i < fns.length ? fns[i](payload, () => run(i + 1)) : inner()); return run(0); };

/** dsh's agent loop rules that matter here: followup → next-turn, steer → next-step, both wake an idle agent; a turn claims
 * all next-step input plus the queue head, continues while next-step has input, and a new turn starts only when the inbox
 * still has input at its end. `beforeIdle` runs where dsh's driver is past its last inbox check but not idle yet. */
class Agent {
  constructor(id) {
    this.id = id; this.lists = { 'next-turn': [], 'next-step': [] }; this.phase = { kind: 'idle' }; this.turns = 0; this.requests = []; this.gates = [];
    this.session = { id, header: {}, inheritedEventCount: 0, snapshotEvents: () => [] };
    const lists = this.lists;
    this.inbox = {
      get nextTurn() { return lists['next-turn']; }, get nextStep() { return lists['next-step']; },
      prepend: (target, m) => { lists[target].unshift(m); },
      remove: (id) => { for (const l of Object.values(lists)) { const i = l.findIndex((m) => m.id === id); if (i >= 0) { l.splice(i, 1); return true; } } return false; },
    };
  }
  get status() { return this.phase.kind === 'running' ? 'running' : 'idle'; }
  setPhase(p) { const before = this.status; this.phase = p; if (this.status !== before) emit('agent/status', { agent: this, status: this.status }); }
  send(m, target, wakeup) {
    const afterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.aborted;
    this.lists[afterAbort ? 'next-turn' : target].push(m);
    if (wakeup) this.wake(afterAbort);
  }
  followup(m) { this.send(m, 'next-turn', true); }
  steer(m) { this.send(m, 'next-step', true); }
  inject(m) { this.send(m, 'next-step', false); }
  cancel() { if (this.phase.kind !== 'idle') { this.phase.aborted = true; this.gates.shift()?.('aborted'); } }
  wake(afterAbort = false) {
    if (this.phase.kind !== 'idle') { if (afterAbort) this.phase.wakeRequested = true; return; }
    this.setPhase({ kind: 'running', aborted: false, wakeRequested: false });
    this.driver = this.kick();
  }
  async kick() {
    try { while (await this.turn()) { this.phase.aborted = false; this.phase.wakeRequested = false; } } finally {
      const { wakeRequested } = this.phase;
      this.beforeIdle?.(); this.beforeIdle = undefined;
      this.setPhase({ kind: 'idle' });
      if (wakeRequested && this.lists['next-turn'].length + this.lists['next-step'].length > 0) this.wake();
    }
  }
  async turn() {
    const turn = ++this.turns; emit('session/event', this.session, { type: 'turn/start', data: { turn } });
    let target = 'next-turn'; let step = 0; let end = null;
    for (;;) {
      const claimed = this.lists['next-step'].splice(0);
      if (target === 'next-turn') claimed.push(...this.lists['next-turn'].splice(0, 1));
      const decision = await waterfall('agent/pre-step', { agent: this, messages: claimed, turn, step: step + 1 }, async () => ({ kind: 'enter', messages: claimed }));
      if (step === 0 && decision.messages.length === 0) { end = 'completed'; break; }
      step += 1; this.requests.push({ turn, step, messages: decision.messages });
      const reply = await new Promise((resolve) => this.gates.push(resolve)); // the model (and its tool calls) of this step
      if (this.phase.aborted || reply === 'aborted') { end = 'aborted'; break; }
      end = reply === 'done' ? 'completed' : null;
      if (end && this.lists['next-step'].length === 0) break;
      target = 'next-step';
    }
    emit('session/event', this.session, { type: 'turn/end', data: { turn, reason: { kind: end } } });
    if (end === 'aborted') return false;
    return this.lists['next-turn'].length + this.lists['next-step'].length > 0;
  }
  /** Let the open model step answer: 'done' (a reply) or 'tool' (a tool call: the turn goes on). */
  async answer(reply) { await until(() => this.gates.length > 0, `${this.id}: a step waits`); this.gates.shift()(reply); await pause(); }
}

const typed = (text) => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: randomUUID() } });
const notice = (child, text) => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: `Background subagent ${child} ${text}` }], source: { kind: 'subagent-settled', form: 'notice', senderSessionId: child } });
const texts = (messages) => messages.map((m) => m.content.map((b) => b.text).join(''));
const idle = (agent) => until(() => agent.status === 'idle' && agent.gates.length === 0, `${agent.id} idle`);

const agents = new Map();
const add = (agent) => { agents.set(agent.id, agent); emit('agent/created', { agent }); return agent; };
const assistant = { ready: Promise.resolve(), isOn: () => true, id: () => 's-assistant', isAssistant: (a) => a?.id === 's-assistant' };
const ctx = {
  logger: { warn: () => {} }, on, effect: () => {},
  get: (name) => ({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] } })[name],
  connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  sessionController: { resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }) },
};
const bot = installAssistantBot(ctx, home, assistant);
await bot.ready;
const setFree = async (on) => { const res = await routes.get(ASSISTANT_FREE_PATH).fetch(new Request(`http://x${ASSISTANT_FREE_PATH}`, { method: 'POST', body: JSON.stringify({ on }) })); assert.equal(res.status, 200); };
assert.equal(bot.free(), true, 'Assistant always free is on by default');

const a = add(new Agent('s-assistant'));
const other = add(new Agent('s-web'));

// 1a. A message typed while the assistant's turn runs goes into the same turn at its next step.
a.followup(typed('find flights'));
await until(() => a.gates.length === 1, 'first step');
a.followup(typed('also hotels'));
assert.deepEqual(a.inbox.nextTurn, [], 'not in the queue');
assert.deepEqual(texts(a.inbox.nextStep), ['also hotels'], 'waits for the next step');
await a.answer('done'); // the model replied while the message waited: the turn takes one more step
await a.answer('done');
await idle(a);
assert.equal(a.turns, 1, 'one turn');
assert.deepEqual(a.requests.map((r) => [r.turn, r.step, texts(r.messages)]), [[1, 1, ['find flights']], [1, 2, ['also hotels']]]);

// 1b. Your message comes before the notices of the same step; a tool call that runs is not cancelled.
a.requests = [];
a.followup(typed('start research'));
await until(() => a.gates.length === 1, 'step');
a.steer(notice('s-child', 'failed before it finished.')); // dsh steers a notice into a running parent
a.followup(typed('make it short'));
await a.answer('tool');
await a.answer('done');
await idle(a);
assert.deepEqual(a.requests.map((r) => texts(r.messages)), [['start research'], ['make it short', 'Background subagent s-child failed before it finished.']]);

// 1c. Another chat keeps dsh's queue: the message waits for the turn's end and starts its own turn.
other.followup(typed('one'));
await until(() => other.gates.length === 1, 'other step');
other.followup(typed('two'));
assert.deepEqual(texts(other.inbox.nextTurn), ['two']);
await other.answer('done');
await other.answer('done');
await idle(other);
assert.deepEqual(other.requests.map((r) => [r.turn, texts(r.messages)]), [[1, ['one']], [2, ['two']]]);

// 1d. Switched off: dsh's queue in the assistant chat too.
await setFree(false);
a.requests = []; a.turns = 0;
a.followup(typed('one'));
await until(() => a.gates.length === 1, 'step');
a.followup(typed('two'));
assert.deepEqual(texts(a.inbox.nextTurn), ['two'], 'queued while off');
await a.answer('done'); await a.answer('done'); await idle(a);
assert.equal(a.turns, 2);
await setFree(true);

// 1e. Race: the message comes after dsh's last inbox check, while the turn ends. It still runs, in one new turn, and the
//     wake markers never reach the model.
a.requests = []; a.turns = 0;
a.followup(typed('first'));
await until(() => a.gates.length === 1, 'step');
a.beforeIdle = () => a.followup(typed('late'));
await a.answer('done');
await until(() => a.turns === 2 && a.gates.length === 1, 'the late message gets a turn');
await a.answer('done');
await idle(a);
assert.deepEqual(a.requests.map((r) => [r.turn, texts(r.messages)]), [[1, ['first']], [2, ['late']]]);
assert.deepEqual([...a.inbox.nextTurn, ...a.inbox.nextStep], [], 'nothing waits');

// 1f. Stop: a message that waited for the next step stays (it is not lost) and no turn starts by itself; your next message
//     runs it.
a.requests = []; a.turns = 0;
a.followup(typed('long job'));
await until(() => a.gates.length === 1, 'step');
a.followup(typed('wait, one more thing'));
a.cancel();
await idle(a); await pause(5);
assert.equal(a.turns, 1, 'no turn after Stop');
assert.deepEqual(texts(a.inbox.nextStep), ['wait, one more thing'], 'kept');
a.followup(typed('go on'));
await until(() => a.gates.length === 1, 'next turn');
await a.answer('done'); await idle(a);
assert.deepEqual(a.requests.map((r) => texts(r.messages)), [['long job'], ['wait, one more thing', 'go on']]);

// 2. A subagent that sent you its result with send_message and then finished: dsh's "finished" notice starts no turn.
const SENT = 'It sent you a message just before finishing, so its closing message is omitted.';
const finished = (child, sent) => ({ id: randomUUID(), role: 'user', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: child },
  content: [{ type: 'text', text: `Background subagent ${child} finished and will do no further work unless you send it more.` }, { type: 'text', text: sent ? SENT : 'Its closing message:' }, ...(sent ? [] : [{ type: 'text', text: 'Rome: 3 flights.' }])] });
const relay = (child, text) => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: `Agent ${child} sent a message: ` }, { type: 'text', text }], source: { kind: 'agent-message', form: 'relay', senderSessionId: child } });
a.requests = []; a.turns = 0;
// 2a. Idle: the message starts one turn; the notice that follows (dsh: followup, the parent is idle) starts none and goes
//     to the model with your next message, after it.
a.steer(relay('s-c1', 'Rome: 3 flights.'));
await until(() => a.gates.length === 1, 'the message turn');
await a.answer('done'); await idle(a);
a.followup(finished('s-c1', true));
await pause(5);
assert.equal(a.turns, 1, 'no turn for the notice');
assert.equal(a.inbox.nextStep.length, 1, 'kept as context');
a.followup(typed('thanks, book the first'));
await until(() => a.gates.length === 1, 'your turn'); await a.answer('done'); await idle(a);
assert.deepEqual(a.requests.map((r) => [r.turn, texts(r.messages).map((t) => t.slice(0, 30))]), [[1, ['Agent s-c1 sent a message: Rom']], [2, ['thanks, book the first', 'Background subagent s-c1 finis']]]);
// 2b. Running: the notice (dsh: steer) adds no step to the turn; it waits and goes in, without a turn, when the turn ends.
a.requests = []; a.turns = 0;
a.followup(typed('plan a trip'));
await until(() => a.gates.length === 1, 'step');
a.steer(finished('s-c2', true));
await a.answer('done'); await idle(a); await pause(5);
assert.equal(a.requests.length, 1, 'no extra step');
assert.equal(a.turns, 1, 'no extra turn');
assert.deepEqual(texts(a.inbox.nextStep).map((t) => t.slice(0, 30)), ['Background subagent s-c2 finis'], 'held, then kept as context');
a.followup(typed('ok'));
await until(() => a.gates.length === 1, 'turn'); await a.answer('done'); await idle(a);
assert.deepEqual(a.inbox.nextStep, []);
// 2c. A subagent that finished without a message, or failed: dsh's notice starts a turn as before.
a.requests = []; a.turns = 0;
a.followup(finished('s-c3', false));
await until(() => a.gates.length === 1, 'the notice turn'); await a.answer('done'); await idle(a);
a.followup({ ...finished('s-c4', true), content: [{ type: 'text', text: 'Background subagent s-c4 failed before it finished.' }, { type: 'text', text: SENT }] });
await until(() => a.gates.length === 1, 'the failure turn'); await a.answer('done'); await idle(a);
assert.equal(a.turns, 2);
// A notice that carries a structured result keeps dsh's turn: a held notice lives in memory only, so it must carry no data.
a.turns = 0;
a.followup({ ...finished('s-c7', true), content: [...finished('s-c7', true).content, { type: 'text', text: 'Structured result: {"price":120}' }] });
await until(() => a.gates.length === 1, 'the structured notice turn'); await a.answer('done'); await idle(a);
assert.equal(a.turns, 1);
// 2d. Another chat and the switch off: dsh's notice as before.
other.requests = []; other.turns = 0;
other.followup(finished('s-c5', true));
await until(() => other.gates.length === 1, 'other notice turn'); await other.answer('done'); await idle(other);
assert.equal(other.turns, 1);
await setFree(false);
a.turns = 0;
a.followup(finished('s-c6', true));
await until(() => a.gates.length === 1, 'notice turn while off'); await a.answer('done'); await idle(a);
assert.equal(a.turns, 1);
await setFree(true);

// 3. An open question card of the assistant: a typed message answers it (custom text for each question) and closes the
//    card through its signal; the message also goes into the turn. dsh's card answerer (api-remotes, the next listener)
//    settles only when a screen answers or the signal aborts.
on('user-questions/request', (request, next) => new Promise((resolve, reject) => {
  shownCards.push({ request, resolve });
  request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
}));
const shownCards = [];
const ask = (agent, questions) => { const signal = new AbortController().signal; return waterfall('user-questions/request', { agent, questions, signal, given: signal }, () => Promise.reject(Error('NO_PROVIDER'))); };
const q = [{ id: 'city', question: 'Which city?', options: [{ label: 'Rome' }] }, { id: 'when', question: 'When?' }];
// 3a. Typed while the card is open.
a.requests = []; a.turns = 0;
a.followup(typed('plan a trip'));
await until(() => a.gates.length === 1, 'step');
const asked = ask(a, q);
await until(() => shownCards.length === 1, 'the card shows');
a.followup(typed('Paris, next week'));
assert.deepEqual(await asked, { answers: [{ id: 'city', selected: [], custom: 'Paris, next week' }, { id: 'when', selected: [], custom: 'Paris, next week' }] });
assert.equal(shownCards[0].request.signal.aborted, true, 'the card closes');
assert.deepEqual(texts(a.inbox.nextStep), ['Paris, next week'], 'the message stays for the turn');
await a.answer('tool'); await a.answer('done'); await idle(a);
assert.equal(a.turns, 1);
// 3b. A card answered on the card itself: a later message is an ordinary interjection.
const asked2 = ask(a, q);
await until(() => shownCards.length === 2, 'card 2');
shownCards[1].resolve({ answers: [{ id: 'city', selected: ['Rome'] }, { id: 'when', selected: [], custom: 'May' }] });
assert.deepEqual((await asked2).answers[0].selected, ['Rome']);
assert.equal(shownCards[1].request.signal.aborted, false);
// 3c. An approval card (intent), another chat's card and the switch off: a message does not answer them.
for (const [agent, questions, off] of [[a, [{ ...q[0], intent: { kind: 'approval', approve: 'Rome', reject: 'No' }, detail: 'x' }]], [other, q], [a, q, true]]) {
  if (off) await setFree(false);
  agent.requests = [];
  agent.followup(typed('go'));
  await until(() => agent.gates.length === 1, 'step');
  const pending = ask(agent, questions); let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  await until(() => shownCards.length > 0 && shownCards.at(-1).request.agent === agent && !shownCards.at(-1).done, 'card');
  const card = shownCards.at(-1); card.done = true;
  agent.followup(typed('my words'));
  await pause(5);
  assert.equal(settled, false, 'the card stays open');
  assert.equal(card.request.signal, card.request.given, 'the card is not touched');
  card.resolve({ answers: [] }); await pending;
  await agent.answer('done'); await agent.answer('done'); // two steps (interjected) or two turns (queued)
  await idle(agent);
  if (off) await setFree(true);
}

await rm(home, { recursive: true, force: true });
console.log('assistant-interject ok');
