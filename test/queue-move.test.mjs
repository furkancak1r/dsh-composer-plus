// Queue drag-and-drop, Host half: `/api/composer-plus.queue-move` moves one queued message (with its images) in dsh's own
// inbox with one splice, after it checks that the queue is still what the user saw. Only your own messages move.
import assert from 'node:assert/strict';
import { apply, QUEUE_MOVE_PATH } from '../index.js';

const routes = new Map();
const msg = (id, kind = 'user', content = [{ type: 'text', text: id }]) => ({ id, source: { kind, rpcId: 'r-' + id }, content });
let queue = [], splices = [], subagent;
const inbox = {
  get nextTurn() { return queue; },
  splice(target, start, count, inserted) { splices.push({ target, start, count, ids: inserted.map((m) => m.id) }); return queue.splice(start, count, ...inserted); },
};
let resolve = async () => ({ agent: { inbox, session: { header: subagent ? { origin: 'subagent', delegationDepth: 1 } : {} } } });
apply({
  on() {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  sessionController: { resolveAgent: (id) => resolve(id) }, sessionQuery: {}, subprocess: {},
  sessionProjections: { snapshot: () => ({ values: { subagent: subagent } }) },
});
const post = async (body) => {
  const r = await routes.get(QUEUE_MOVE_PATH).fetch(new Request('http://h' + QUEUE_MOVE_PATH, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: r.status, json: await r.json() };
};
const ids = () => queue.map((m) => m.id);

// Up and down, with an image row in the range; one splice each, ids kept.
queue = [msg('a'), msg('b', 'user', [{ type: 'image', attachment: { attachmentId: 'x' } }, { type: 'text', text: 'B' }]), msg('c'), msg('d')];
let r = await post({ sessionId: 's', itemId: 'c', to: 0, before: ['a', 'b', 'c', 'd'] });
assert.equal(r.status, 200); assert.deepEqual(r.json, { moved: true, order: ['c', 'a', 'b', 'd'] });
assert.deepEqual(splices, [{ target: 'next-turn', start: 0, count: 3, ids: ['c', 'a', 'b'] }], 'one splice over the moved range');
assert.equal(queue[2].content[0].type, 'image', 'the image stays with its message');
splices = [];
r = await post({ sessionId: 's', itemId: 'c', to: 3, before: ['c', 'a', 'b', 'd'] });
assert.deepEqual(r.json.order, ['a', 'b', 'd', 'c']);
assert.deepEqual((await post({ sessionId: 's', itemId: 'a', to: 0, before: ids() })).json, { moved: false });

// The user saw only a part of the queue (dsh hides rows already echoed in the chat): `to` counts in that part.
queue = [msg('e'), msg('a'), msg('b'), msg('c')];
r = await post({ sessionId: 's', itemId: 'c', to: 0, before: ['a', 'b', 'c'] });
assert.deepEqual(r.json.order, ['e', 'c', 'a', 'b']);

// The queue changed since the user saw it (the first message started to send): nothing moves.
queue = [msg('b'), msg('c')]; splices = [];
r = await post({ sessionId: 's', itemId: 'c', to: 0, before: ['a', 'b', 'c'] });
assert.equal(r.status, 409); assert.match(r.json.error, /queue changed/); assert.deepEqual(splices, []);
r = await post({ sessionId: 's', itemId: 'c', to: 0, before: ['c', 'b'] });
assert.equal(r.status, 409, 'another order');

// Only your own messages move: a goal round or a question reply in the range stays.
queue = [msg('a'), msg('g', 'goal'), msg('b')];
r = await post({ sessionId: 's', itemId: 'b', to: 0, before: ['a', 'g', 'b'] });
assert.equal(r.status, 409); assert.deepEqual(ids(), ['a', 'g', 'b']);

// Bad input, an unknown chat, a one-shot subagent chat.
for (const b of ['x', {}, { sessionId: 's', itemId: 'a', to: -1, before: ['a'] }, { sessionId: 's', itemId: 'a', to: 0, before: 'a' }, { sessionId: 's', itemId: 'a', to: 1.5, before: ['a'] }]) {
  assert.equal((await post(b)).status, 400, JSON.stringify(b));
}
queue = [msg('a'), msg('b')];
assert.equal((await post({ sessionId: 's', itemId: 'b', to: 2, before: ['a', 'b'] })).status, 409, 'to past the end');
subagent = { mode: 'one-shot' };
assert.equal((await post({ sessionId: 's', itemId: 'b', to: 0, before: ['a', 'b'] })).status, 409);
subagent = { mode: 'continuable' };
assert.equal((await post({ sessionId: 's', itemId: 'b', to: 0, before: ['a', 'b'] })).status, 200, 'a continuable subagent chat can move');
subagent = undefined;
resolve = async () => ({ error: { code: 'session/not-found' } });
assert.equal((await post({ sessionId: 'x', itemId: 'a', to: 0, before: ['a'] })).status, 409);

// One move per chat at a time.
let release; resolve = () => new Promise((r2) => { release = () => r2({ agent: { inbox, session: { header: {} } } }); });
queue = [msg('a'), msg('b')];
const first = post({ sessionId: 's', itemId: 'b', to: 0, before: ['a', 'b'] });
await new Promise((r2) => setTimeout(r2, 5));
assert.equal((await post({ sessionId: 's', itemId: 'a', to: 1, before: ['a', 'b'] })).status, 409, 'a second move waits for the first');
release(); assert.equal((await first).status, 200);
console.log('queue-move checks passed');
