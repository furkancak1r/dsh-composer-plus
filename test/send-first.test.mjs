// Send after Stop goes first (Host half). Scenario of the owner's report: five messages wait in the queue, Stop, a sixth is
// sent at once. dsh puts the sixth at the END of the queue and its turn takes the queue HEAD, so an older message runs.
// With the feature, the sixth runs alone in the next turn and the five keep their order after it. Real index.js apply()
// wiring; the fake inbox and agent copy dsh-agent-loop (`send`, `claim`, splice events in order, the same in dsh 0.2.0-rc.2
// to 0.2.2-alpha.2).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, SEND_FIRST_PATH, QUEUE_MOVE_PATH } from '../index.js';

const home = mkdtempSync(join(tmpdir(), 'cp-send-first-'));
process.env.DSH_HOME = home;
process.env.DSH_MOBILE_IFACE = 'cp-test-none';
const listeners = new Map();
const routes = new Map();
const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
const warnings = [];

/** One chat as dsh-agent-loop keeps it: `send` splices at the end, emits `session/event` then `agent/inbox/inserted`
 * (both synchronous), then opens the turn if idle; `claim` takes the queue head. */
function makeAgent({ origin } = {}) {
  const session = { id: 's1', header: origin === undefined ? {} : { origin, delegationDepth: 1 } };
  const state = { 'next-turn': [], 'next-step': [] };
  const agent = { id: 's1', session, phase: { kind: 'idle' }, turns: [], splices: [] };
  Object.defineProperty(agent, 'status', { get: () => (agent.phase.kind === 'idle' ? 'idle' : 'running') });
  const mutate = (target, start, count, inserted, discard) => {
    const list = state[target];
    const at = start === Infinity ? list.length : Math.min(start, list.length);
    const n = Math.min(count, list.length - at);
    if (n === 0 && inserted.length === 0) return [];
    const next = list.toSpliced(at, n, ...inserted);
    const ids = new Set();
    for (const m of [...next, ...state[target === 'next-turn' ? 'next-step' : 'next-turn']]) {
      if (ids.has(m.id)) throw new Error(`message "${m.id}" is already pending`);
      ids.add(m.id);
    }
    const removed = list.slice(at, at + n);
    state[target] = next;
    const data = { target, start: at, ...(n === 0 ? {} : { removedCount: n }), inserted, ...(discard && n > 0 ? { outcome: 'canceled' } : {}) };
    agent.splices.push(data);
    emit('session/event', session, { type: 'agent/inbox/spliced', data });
    for (const message of inserted) emit('agent/inbox/inserted', { agent, message });
    return removed;
  };
  agent.inbox = {
    get nextTurn() { return state['next-turn']; },
    get nextStep() { return state['next-step']; },
    splice: (target, start, count, inserted) => mutate(target, start, count, inserted, true),
    claim: () => mutate('next-turn', 0, 1, [], false),
  };
  agent.followup = (message) => {
    const afterAbort = agent.phase.kind !== 'idle' && agent.phase.abort.signal.aborted;
    agent.inbox.splice('next-turn', Infinity, 0, [message]);
    if (agent.phase.kind === 'idle') agent.turns.push(agent.inbox.claim().map((m) => m.id)); // the turn takes the head
    else if (afterAbort) agent.phase.wake = true;
  };
  /** The stopped turn ends: a latched wake opens the next turn (dsh's `kick` → `wakeDriver`). */
  agent.endTurn = () => { const wake = agent.phase.wake; agent.phase = { kind: 'idle' }; if (wake) agent.turns.push(agent.inbox.claim().map((m) => m.id)); };
  /** A turn ends normally: dsh opens the next one while the queue has messages. */
  agent.next = () => { if (state['next-turn'].length > 0) agent.turns.push(agent.inbox.claim().map((m) => m.id)); };
  return agent;
}
let agent = makeAgent();
apply({
  on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
  connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  sessionController: { resolveAgent: async () => ({ agent }) }, sessionQuery: {}, subprocess: {},
  sessionProjections: { snapshot: () => ({ values: {} }) },
  logger: { warn: (text) => warnings.push(text) },
});
const call = async (path, body) => {
  const r = await routes.get(path).fetch(new Request(`http://h${path}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }));
  return { status: r.status, json: await r.json() };
};
const msg = (id, kind = 'user', content = [{ type: 'text', text: id }]) => ({ id, role: 'user', content, source: { kind, rpcId: `r-${id}` } });
const ids = () => agent.inbox.nextTurn.map((m) => m.id);
const QUEUED = ['q1', 'q2', 'q3', 'q4', 'q5'];
/** A turn runs; five messages queue behind it; Stop (the queue stays). */
const stopWithQueue = (aborting) => {
  agent = makeAgent(agent.session.header.origin === undefined ? {} : { origin: agent.session.header.origin });
  agent.phase = { kind: 'running', abort: new AbortController() };
  for (const id of QUEUED) agent.followup(msg(id));
  assert.deepEqual(ids(), QUEUED, 'a running turn: messages queue in order');
  agent.phase.abort.abort({ kind: 'user' }); // dsh's Stop: cancel({kind:'user'}, {keepInbox: true})
  if (!aborting) agent.endTurn();
};

// The switch: on by default.
assert.deepEqual((await call(SEND_FIRST_PATH)).json, { on: true });

// 1. The owner's scenario, after the stopped turn ended: the sixth runs alone at once, the five keep their order.
stopWithQueue(false);
agent.followup(msg('six', 'user', [{ type: 'image', attachment: { attachmentId: 'x' } }, { type: 'text', text: 'six' }]));
assert.deepEqual(agent.turns, [['six']], 'the next turn takes only the sixth message');
assert.deepEqual(ids(), QUEUED, 'the five wait in their order');
for (let i = 0; i < QUEUED.length; i++) agent.next();
assert.deepEqual(agent.turns, [['six'], ['q1'], ['q2'], ['q3'], ['q4'], ['q5']], 'then one queued message per turn, in order');
assert.ok(!agent.splices.some((s) => s.removedCount !== undefined && s.inserted.some((m) => m.id === 'six')), 'the sixth is never removed (dsh would show its send as failed)');
assert.ok(agent.splices.flatMap((s) => s.inserted).some((m) => m.id === 'q1' && m.content[0].text === 'q1'), 'queued messages keep their id and content');

// 2. Sent right after Stop, while the stopped turn still ends: the same order.
stopWithQueue(true);
agent.followup(msg('six'));
assert.deepEqual(ids(), ['six', ...QUEUED], 'the sixth is at the head while the stopped turn ends');
agent.endTurn();
assert.deepEqual(agent.turns, [['six']]);
assert.deepEqual(ids(), QUEUED);

// 3. While a turn runs (not stopped), a new message joins the end of the queue as before.
agent = makeAgent();
agent.phase = { kind: 'running', abort: new AbortController() };
for (const id of [...QUEUED, 'six']) agent.followup(msg(id));
assert.deepEqual(ids(), [...QUEUED, 'six'], 'a running turn keeps the normal queue');

// 4. Only past your own messages: a goal round or a question reply in the queue keeps dsh's order.
for (const kind of ['goal', 'user-question-reply']) {
  stopWithQueue(false);
  agent.inbox.splice('next-turn', 2, 0, [msg('other', kind)]);
  agent.turns.length = 0;
  agent.followup(msg('six'));
  assert.deepEqual(agent.turns, [['q1']], `${kind}: dsh's own order`);
}
// A message that is not yours does not move to the head.
stopWithQueue(false);
agent.followup(msg('round', 'goal'));
assert.deepEqual(agent.turns, [['q1']], 'a goal round is not moved');

// 5. Not a queue edit, a queue move or a single message.
stopWithQueue(false);
const q3 = agent.inbox.nextTurn[2];
agent.inbox.splice('next-turn', 2, 1, [{ ...q3, content: [{ type: 'text', text: 'edited' }] }]); // dsh's queue `edit`
assert.deepEqual(ids(), QUEUED, 'an edit keeps its place');
assert.equal(agent.inbox.nextTurn[2].content[0].text, 'edited');
agent = makeAgent();
agent.followup(msg('alone'));
assert.deepEqual(agent.turns, [['alone']], 'an empty queue: dsh as before');

// 6. A subagent chat keeps dsh's order.
agent = makeAgent({ origin: 'subagent' });
stopWithQueue(false);
agent.followup(msg('six'));
assert.deepEqual(agent.turns, [['q1']], 'subagent chat: not moved');
agent = makeAgent();

// 7. The queue move route after a send-first move: the drag that saw the old order gets 409, nothing moves.
stopWithQueue(true);
const seen = ids();
agent.followup(msg('six'));
let r = await call(QUEUE_MOVE_PATH, { sessionId: 's1', itemId: 'q5', to: 0, before: seen });
assert.equal(r.status, 200, 'the rows the user saw are still in the same order (the sixth is not among them)');
assert.deepEqual(ids(), ['six', 'q5', 'q1', 'q2', 'q3', 'q4'], 'the drag moves inside the five; the sixth stays first');

// 8. A failed second step puts every queued message back.
stopWithQueue(false);
const realSplice = agent.inbox.splice;
let n = 0;
agent.inbox.splice = (...args) => { n += 1; if (n === 3) throw new Error('disk full'); return realSplice(...args); };
agent.followup(msg('six'));
assert.deepEqual([...agent.turns.flat(), ...ids()].sort(), ['q1', 'q2', 'q3', 'q4', 'q5', 'six'].sort(), 'no message is lost');
assert.match(warnings.at(-1), /send first: disk full/);

// 9. Switch off: dsh's own order (the bug), saved for the next start; back on.
r = await call(SEND_FIRST_PATH, { on: false });
assert.deepEqual(r.json, { on: false });
assert.deepEqual(JSON.parse(readFileSync(join(home, 'storages', 'dsh-composer-plus', 'send-first.json'), 'utf8')), { on: false });
stopWithQueue(false);
agent.followup(msg('six'));
assert.deepEqual(agent.turns, [['q1']], 'off: the turn takes the queue head');
assert.deepEqual(ids(), ['q2', 'q3', 'q4', 'q5', 'six'], 'off: the sixth waits at the end');
assert.deepEqual((await call(SEND_FIRST_PATH, { on: true })).json, { on: true });
for (const bad of [{}, { on: 'yes' }]) assert.equal((await call(SEND_FIRST_PATH, bad)).status, 400);
assert.equal((await routes.get(SEND_FIRST_PATH).fetch(new Request(`http://h${SEND_FIRST_PATH}`, { method: 'POST', body: '{' }))).status, 400);

rmSync(home, { recursive: true, force: true });
console.log('send-first checks passed');
