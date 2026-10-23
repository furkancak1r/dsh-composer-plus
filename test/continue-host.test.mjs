import assert from 'node:assert/strict';
import { apply, CONTINUE_PATH } from '../index.js';
const routes = new Map(), hooks = new Map(), agents = new Map();
let released = 0;
const stopped = (id, reason = 'aborted') => {
  const agent = { status: 'idle', events: [{ type: 'turn/end', seq: 8, data: { reason: { kind: reason } } }], sent: [],
    steer(message) { this.sent.push(message); this.status = 'running'; this.events.push({ type: 'turn/start', seq: 9 }); },
  };
  agents.set(id, agent); return agent;
};
apply({
  on: (name, fn) => hooks.set(name, fn),
  connection: { fetch: { register: r => routes.set(r.path, r) } },
  sessionController: { resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: {} } },
  sessionQuery: { observeSession: async id => ({ events: agents.get(id).events, [Symbol.dispose]() { released++; } }) },
});
const route = routes.get(CONTINUE_PATH);
assert.deepEqual(route.methods, ['POST']);
const call = (body, signal) => route.fetch(new Request(`http://localhost${CONTINUE_PATH}`, {
  method: 'POST', body: JSON.stringify(body), signal,
}));
for (const body of [null, {}, { sessionId: '', afterSeq: 8 }, { sessionId: 'a', afterSeq: -1 }, { sessionId: 'a', afterSeq: '8' }]) {
  assert.equal((await call(body)).status, 400);
}
assert.equal((await route.fetch(new Request(`http://localhost${CONTINUE_PATH}`, { method: 'POST', body: '{' }))).status, 400);
assert.equal((await call({ sessionId: 'missing', afterSeq: 8 })).status, 409);
let a = stopped('a');
assert.equal((await call({ sessionId: 'a', afterSeq: 7 })).status, 409, 'stale request');
const pair = await Promise.all([call({ sessionId: 'a', afterSeq: 8 }), call({ sessionId: 'a', afterSeq: 8 })]);
assert.deepEqual(pair.map(r => r.status).sort(), [200, 409]);
assert.equal(a.sent.length, 1); assert.deepEqual(a.sent[0].content, []);
const marker = a.sent[0];
const other = { id: 'actual-user', role: 'user', content: [{ type: 'text', text: 'keep this' }], source: { kind: 'user' } };
const gate = hooks.get('agent/pre-step');
assert.equal(hooks.has('agent/request'), false, 'no request-time mutation');
const decision = await gate({ agent: a }, async () => ({ kind: 'enter', messages: [other, marker], startsRequestSeries: true }));
assert.equal(decision.messages.length, 2);
assert.equal(decision.messages[0], other, 'other messages are kept as-is');
assert.equal(decision.startsRequestSeries, true);
const resume = decision.messages[1];
assert.notEqual(resume.id, marker.id, 'fresh id: the inbox-claimed marker id never reaches Chat as a bubble');
assert.equal(resume.role, 'user');
assert.notEqual(resume.source.kind, 'user', 'context source, not a human message');
assert.match(resume.content[0].text, /Continue the task/);
assert.ok(Object.isFrozen(resume), 'frozen like dsh messages');
const empty = await gate({ agent: a }, async () => ({ kind: 'enter', messages: [marker] }));
assert.equal(empty.messages.length, 1, 'a lone wake still sends one non-empty message, so the model is not asked to continue from an assistant turn');
assert.ok(empty.messages[0].content[0].text.length > 0);
const plain = { kind: 'enter', messages: [other] };
assert.equal(await gate({ agent: a }, async () => plain), plain, 'unrelated steps are untouched');
const denied = { kind: 'reject' };
assert.equal(await gate({ agent: a }, async () => denied), denied, 'downstream rejection is preserved');
await assert.rejects(gate({ agent: a }, async () => { throw new Error('policy failed'); }), /policy failed/);
a.status = 'idle'; a.events.push({ type: 'turn/end', seq: 10, data: { reason: { kind: 'completed' } } });
assert.equal((await call({ sessionId: 'a', afterSeq: 8 })).status, 409, 'replayed request after completion');
assert.equal((await call({ sessionId: 'a', afterSeq: 10 })).status, 409, 'completed turn');
for (const reason of ['error', 'max-tokens']) {
  const b = stopped('b', reason); assert.equal((await call({ sessionId: 'b', afterSeq: 8 })).status, 200);
  assert.equal(b.sent.length, 1); assert.equal(a.sent.length, 1, 'another chat is untouched');
}
a = stopped('a'); a.events = [{ type: 'turn/start', seq: 8 }];
assert.equal((await call({ sessionId: 'a', afterSeq: 8 })).status, 200, 'interrupted open turn');
a = stopped('a'); a.events = [];
assert.equal((await call({ sessionId: 'a', afterSeq: 8 })).status, 409, 'blank chat');
a = stopped('a');
assert.equal((await call({ sessionId: 'a', afterSeq: 8 }, AbortSignal.abort())).status, 500);
assert.equal(a.sent.length, 0, 'aborted request cannot start a turn');

// Issue #3: messages queued before Stop wait. dsh starts a turn by claiming every next-step message and the queue head at
// once (inbox.claim), so a plain steer marker took the user's queued message into the continued task.
const queued = (id, texts) => {
  const agent = stopped(id);
  const user = texts.map((text, i) => ({ id: `${id}-q${i}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }));
  agent.inbox = {
    nextTurn: [...user], nextStep: [],
    prepend(target, message) { assert.equal(target, 'next-turn'); this.nextTurn.unshift(message); },
    remove(messageId) { const i = this.nextTurn.findIndex((m) => m.id === messageId); if (i >= 0) this.nextTurn.splice(i, 1); return i >= 0; },
  };
  // dsh: a steer to an idle agent opens the turn and claims at once: all next-step messages, then one queued message.
  agent.steer = function steer(message) {
    this.sent.push(message); this.status = 'running'; this.events.push({ type: 'turn/start', seq: 9 });
    this.claimed = [message, ...this.inbox.nextTurn.splice(0, 1)];
  };
  return { agent, user };
};
let q = queued('q', ['next task', 'later task']);
assert.equal((await call({ sessionId: 'q', afterSeq: 8 })).status, 200);
assert.deepEqual(q.agent.inbox.nextTurn, q.user, 'the queued messages stay in the queue, in order');
assert.ok(q.agent.claimed.every((m) => m.source.kind === 'composer-plus-continue'), 'the continued step claims only Continue markers');
const once = await gate({ agent: q.agent }, async () => ({ kind: 'enter', messages: q.agent.claimed }));
assert.equal(once.messages.length, 1, 'two markers still give the model one continue note');
assert.match(once.messages[0].content[0].text, /Continue the task/);
const mixed = await gate({ agent: q.agent }, async () => ({ kind: 'enter', messages: [other, marker, marker] }));
assert.deepEqual(mixed.messages.map((m) => m.id === other.id || /Continue the task/.test(m.content[0].text)), [true, true]);
q = queued('q', ['next task']);
q.agent.steer = () => { throw new Error('agent busy'); };
assert.equal((await call({ sessionId: 'q', afterSeq: 8 })).status, 500);
assert.deepEqual(q.agent.inbox.nextTurn, q.user, 'a failed continue leaves no marker in the queue');
assert.ok(released > 0, 'observations are disposed');
console.log('message-free continue host checks passed');
