// Tether's push words (Host half): Turn finished carries the agent's last reply of the turn, and every push names the
// chat's project. The gateway puts them under this Mac's name (test/tether-gateway.test.mjs, "push: ...").
import assert from 'node:assert/strict';
import { lastReply, mobileGateway, projectOf, quietTurn, ROLLBACK_SOURCE, REWIND_SOURCE } from '../index.js';

const say = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const tool = (seq) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'toolCall', id: 't', name: 'bash' }] } } });
const user = (seq, text) => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });

// The last reply of the last turn: not a tool call, not an older turn's reply.
const turn = [user(1, 'a'), { seq: 2, type: 'turn/start' }, say(3, 'old'), { seq: 4, type: 'turn/end' },
  user(5, 'b'), { seq: 6, type: 'turn/start' }, say(7, 'Looking.'), tool(8), { seq: 9, type: 'tool/result' }, say(10, '  Fixed the login.\nTests pass.  '), tool(11), { seq: 12, type: 'turn/end' }];
assert.equal(lastReply(turn), 'Fixed the login.\nTests pass.');
assert.equal(lastReply([...turn.slice(0, 5), { seq: 6, type: 'turn/start' }, tool(7), { seq: 8, type: 'turn/end' }]), '', 'a turn with no text: no reply, not the old one');
assert.equal(lastReply([]), '');
assert.equal(lastReply([say(1, 'before any turn')]), 'before any turn', 'a log with no turn/start still has its reply');
// A reply that a rollback withdrew does not count (both withdraw markers).
for (const kind of [ROLLBACK_SOURCE, REWIND_SOURCE]) {
  const back = [{ seq: 1, type: 'turn/start' }, say(2, 'kept'), say(3, 'withdrawn'), { seq: 4, type: 'user/message', data: { source: { kind } }, sourceEventSeqs: [3] }];
  assert.equal(lastReply(back), 'kept', kind);
}

// The project: dsh's project title, else the folder name; a branch folder names its repository.
const spaces = [{ id: 'w1', path: '/u/dev/recipe-box', title: 'Recipes' }, { id: 'w2', path: '/u/dev/plain', title: '' }];
assert.equal(projectOf('/u/dev/recipe-box', spaces), 'Recipes');
assert.equal(projectOf('/u/dev/recipe-box/', spaces), 'Recipes', 'a trailing slash');
assert.equal(projectOf('/u/dev/plain', spaces), 'plain', 'no title: the folder name');
assert.equal(projectOf('/u/dev/other', undefined), 'other', 'no registry');
assert.equal(projectOf('/u/dev/recipe-box/.worktrees/feat-login', spaces), 'recipe-box', 'a branch folder: its repository');
assert.equal(projectOf('relative/path', spaces), undefined);
assert.equal(projectOf(undefined, spaces), undefined);
assert.equal(projectOf('/', spaces), undefined, 'the root folder has no name');

// The Host's mobileGateway gives `about` to the gateway and passes the chat id of each push.
const pushes = []; let made;
const m = mobileGateway({ dir: '/x', upstreamUrl: () => '', about: (id) => ({ chat: id }), make: (o) => (made = { o, listenAdmin: async () => 1, start: async () => {}, close: async () => {}, state: () => ({ running: true }), push: (...a) => pushes.push(a) }) });
await m.start();
assert.equal(made.o.about('s1').chat, 's1');
m.push('Turn finished', 'Fixed it.', 's1');
assert.deepEqual(pushes, [['Turn finished', 'Fixed it.', 's1']]);
await m.close();

// A completed turn with nothing to say (its reply is empty or only `[quiet]`) gives no Turn finished push, whatever started
// it; any other reply, and a turn that failed, stopped or hit the token limit, pushes. The turns have the shape of a real
// assistant log (2026-11-15): dsh logs the prompt and its time context after turn/start. An outage note is a `user`
// message with an rpcId (2026-11-17: its `[quiet]` turn pushed).
const prompt = (seq, kind) => ({ seq, type: 'user/message', data: { source: { kind, ...(kind === 'user' ? { rpcId: 'r1' } : {}) }, content: [{ type: 'text', text: 'note' }] } });
const answer = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'End the turn.' }, ...(text === undefined ? [] : [{ type: 'text', text }])] } } });
const turnOf = (seq, kind, text, end = 'completed') => [{ seq, type: 'turn/start' }, { seq: seq + 1, type: 'agent/inbox/spliced' }, { seq: seq + 2, type: 'step/start' },
  prompt(seq + 3, kind), prompt(seq + 4, 'time-context'), answer(seq + 5, text), { seq: seq + 6, type: 'step/end' }, { seq: seq + 7, type: 'turn/end', data: { reason: { kind: end } } }];
const pushed = (events) => !quietTurn(events, lastReply(events)); // the Host's check (index.js, agent/status)
const NEWS = 'composer-plus-assistant-news';
for (const kind of [NEWS, 'user', 'schedule']) {
  assert.equal(pushed(turnOf(1, kind)), false, `${kind}: empty reply: no push`);
  assert.equal(pushed([...turnOf(1, kind, ''), tool(9)]), false, `${kind}: only an empty text and a tool call: no push`);
  assert.equal(pushed(turnOf(1, kind, '[quiet]')), false, `${kind}: [quiet]: no push`);
  assert.equal(pushed(turnOf(1, kind, '  [QUIET]\n')), false, `${kind}: [quiet] in other case and spaces: no push`);
  assert.equal(pushed(turnOf(1, kind, 'The deploy of recipe-box failed.')), true, `${kind}: real text: push`);
  assert.equal(pushed(turnOf(1, kind, '[quiet]\nThe audit found 2 issues.')), true, `${kind}: [quiet] and more text: push`);
  assert.equal(pushed(turnOf(1, kind, 'Audit: [quiet]')), true, `${kind}: [quiet] inside a sentence: push`);
  for (const end of ['error', 'max-tokens', 'aborted', 'interrupted']) {
    assert.equal(pushed(turnOf(1, kind, undefined, end)), true, `${kind}: ${end}, empty reply: push`);
    assert.equal(pushed(turnOf(1, kind, '[quiet]', end)), true, `${kind}: ${end}, [quiet]: push`);
  }
}
assert.equal(pushed(turnOf(1, 'user', '[quiet]').slice(0, -1)), true, 'no turn/end yet: push');
assert.equal(pushed([...turnOf(1, 'user', 'Fixed the login.'), ...turnOf(9, NEWS, '[quiet]')]), false, 'only the newest turn counts: quiet');
assert.equal(pushed([...turnOf(1, NEWS, '[quiet]'), ...turnOf(9, 'user', 'Fixed the login.')]), true, 'only the newest turn counts: push');
assert.equal(pushed([...turnOf(1, NEWS, '[quiet]'), ...turnOf(9, 'user', '[quiet]', 'max-tokens')]), true, 'only the newest turn end counts');
// The Host's push and green dot on a real agent/status edge: test/unread.test.mjs and test/quiet-replies.test.mjs.
console.log('tether push words: last reply of the turn (withdrawn replies left out), project name, chat id to the gateway, no push for an empty or [quiet] reply');
