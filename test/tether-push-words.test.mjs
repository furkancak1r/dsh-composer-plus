// Tether's push words (Host half): Turn finished carries the agent's last reply of the turn, and every push names the
// chat's project. The gateway puts them under this Mac's name (test/tether-gateway.test.mjs, "push: ...").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lastReply, mobileGateway, projectOf, quietNewsTurn, ROLLBACK_SOURCE, REWIND_SOURCE } from '../index.js';

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

// An Assistant news turn with nothing to say gives no Turn finished push; your turns and news with a text reply do. The
// turns have the shape of a real assistant log (2026-11-15): dsh logs the news note and its time context after turn/start.
const prompt = (seq, kind) => ({ seq, type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text: 'note' }] } });
const answer = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'End the turn.' }, ...(text === undefined ? [] : [{ type: 'text', text }])] } } });
const turnOf = (seq, kind, text) => [{ seq, type: 'turn/start' }, { seq: seq + 1, type: 'agent/inbox/spliced' }, { seq: seq + 2, type: 'step/start' },
  prompt(seq + 3, kind), prompt(seq + 4, 'time-context'), answer(seq + 5, text), { seq: seq + 6, type: 'step/end' }, { seq: seq + 7, type: 'turn/end' }];
const pushed = (events) => !quietNewsTurn(events, lastReply(events)); // the Host's check (index.js, agent/status)
const NEWS = 'composer-plus-assistant-news';
assert.equal(pushed(turnOf(1, NEWS)), false, 'news turn, empty reply: no push');
assert.equal(pushed([...turnOf(1, NEWS, ''), tool(9)]), false, 'news turn, only an empty text and a tool call: no push');
assert.equal(pushed(turnOf(1, NEWS, '[quiet]')), false, 'news turn, [quiet]: no push');
assert.equal(pushed(turnOf(1, NEWS, '  [QUIET]\n')), false, 'news turn, [quiet] in other case and spaces: no push');
assert.equal(pushed(turnOf(1, NEWS, 'The deploy of recipe-box failed.')), true, 'news turn, real text: push');
assert.equal(pushed(turnOf(1, NEWS, '[quiet]\nThe audit found 2 issues.')), true, 'news turn, [quiet] and more text: push');
assert.equal(pushed([...turnOf(1, NEWS, '[quiet]'), ...turnOf(9, 'user')]), true, 'your turn after a news turn, empty reply: push');
assert.equal(pushed(turnOf(1, 'schedule', '[quiet]')), true, 'a scheduled turn is not a news turn: push');
// The Host gives the green dot first and pushes only when the turn is not a quiet news turn.
const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
assert.match(host, /changeUnread\(\[agent\.id\], \[\]\);[\s\S]{0,600}quiet = quietNewsTurn\(events, reply\);[\s\S]{0,100}if \(!quiet\) mobile\?\.push\('Turn finished', reply, agent\.id\);/, 'the dot stays, only the push is skipped');
console.log('tether push words: last reply of the turn (withdrawn replies left out), project name, chat id to the gateway, no push for a quiet news turn');
