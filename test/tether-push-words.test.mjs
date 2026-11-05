// Tether's push words (Host half): Turn finished carries the agent's last reply of the turn, and every push names the
// chat's project. The gateway puts them under this Mac's name (test/tether-gateway.test.mjs, "push: ...").
import assert from 'node:assert/strict';
import { lastReply, mobileGateway, projectOf, ROLLBACK_SOURCE, REWIND_SOURCE } from '../index.js';

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
console.log('tether push words: last reply of the turn (withdrawn replies left out), project name, chat id to the gateway');
