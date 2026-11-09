// Assistant interjection (part of Assistant always free), with a small model of dsh's agent loop (dsh-agent-loop: send,
// wakeDriver, kick, turn; 0.2.0-rc.2 to 0.2.2-rc.1):
// 1. A message that you type while the assistant's turn runs goes into that turn at its next step (no second turn, nothing
//    cancelled); your message comes before the notices of the same step. Other chats and the switch off keep dsh's queue.
//    A message that comes while the turn ends (after dsh's last inbox check) still runs; after your Stop it waits, as in dsh.
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

await rm(home, { recursive: true, force: true });
console.log('assistant-interject ok');
