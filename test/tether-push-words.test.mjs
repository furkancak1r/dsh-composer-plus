// Tether's push words (Host half): Turn finished carries the agent's last reply of the turn, and every push names the
// chat's project. The gateway puts them under this Mac's name (test/tether-gateway.test.mjs, "push: ...").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { damonAbout, lastReply, mobileGateway, projectOf, pushWords, quietTurn, ROLLBACK_SOURCE, REWIND_SOURCE } from '../index.js';

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
const pushed = (events) => pushWords(events) !== undefined; // the Host's check for a chat that is not the assistant (index.js, agent/status)
assert.equal(pushed([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]), !quietTurn([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }], ''), 'pushWords keeps quietTurn');
const NEWS = 'composer-plus-assistant-news';
for (const kind of [NEWS, 'user', 'schedule']) {
  assert.equal(pushed(turnOf(1, kind)), false, `${kind}: empty reply: no push`);
  assert.equal(pushed([...turnOf(1, kind, ''), tool(9)]), false, `${kind}: only an empty text and a tool call: no push`);
  assert.equal(pushed(turnOf(1, kind, '[quiet]')), false, `${kind}: [quiet]: no push`);
  assert.equal(pushed(turnOf(1, kind, '  [QUIET]\n')), false, `${kind}: [quiet] in other case and spaces: no push`);
  assert.equal(pushed(turnOf(1, kind, 'The deploy of recipe-box failed.')), true, `${kind}: real text: push`);
  assert.equal(pushed(turnOf(1, kind, '[quiet]\nThe audit found 2 issues.')), true, `${kind}: [quiet] and more text: push`);
  assert.equal(pushed(turnOf(1, kind, 'Audit: [quiet]')), true, `${kind}: [quiet] inside a sentence: push`);
  for (const end of ['max-tokens', 'aborted', 'interrupted']) {
    assert.equal(pushed(turnOf(1, kind, undefined, end)), true, `${kind}: ${end}, empty reply: push`);
    assert.equal(pushed(turnOf(1, kind, '[quiet]', end)), true, `${kind}: ${end}, [quiet]: push`);
  }
  // A failed turn: dsh relays its error (agent/error → api-session/error) and the gateway pushes DSH error, so no second
  // Turn finished push for the same failure (2026-11-24).
  assert.equal(pushed(turnOf(1, kind, undefined, 'error')), false, `${kind}: error: DSH error only`);
  assert.equal(pushed(turnOf(1, kind, 'Half a reply.', 'error')), false, `${kind}: error with text: DSH error only`);
}
assert.equal(pushed(turnOf(1, 'user', '[quiet]').slice(0, -1)), true, 'no turn/end yet: push');
assert.equal(pushed([...turnOf(1, 'user', 'Fixed the login.'), ...turnOf(9, NEWS, '[quiet]')]), false, 'only the newest turn counts: quiet');
assert.equal(pushed([...turnOf(1, NEWS, '[quiet]'), ...turnOf(9, 'user', 'Fixed the login.')]), true, 'only the newest turn counts: push');
assert.equal(pushed([...turnOf(1, NEWS, '[quiet]'), ...turnOf(9, 'user', '[quiet]', 'max-tokens')]), true, 'only the newest turn end counts');
// The assistant chat's run (`from`: where it started): a run whose every text is [quiet] gives no push; a run that is news
// pushes its newest real text, also when its last reply is [quiet] (a real reply, then a queued [quiet] news turn).
const run = [...turnOf(1, 'user', 'Fixed the login.'), ...turnOf(9, NEWS, '[quiet]')];
assert.equal(pushWords(run, 0), 'Fixed the login.', 'the assistant run with a real reply pushes it');
assert.equal(pushWords(run, 8), undefined, 'a quiet run of the assistant: no push');
assert.equal(pushWords([...turnOf(1, NEWS, '[quiet]', 'error')], 0), undefined, 'a failed turn: DSH error only, never the words [quiet]');
assert.equal(pushWords([...turnOf(1, NEWS, '[quiet]', 'aborted')], 0), '', 'a stopped turn pushes, never with the words [quiet]');
assert.equal(pushWords(turnOf(1, NEWS, 'Deploy failed.'), 0), 'Deploy failed.');

// Damon's [quiet] turn never pushes, not even its first part (2026-11-24, Furkan: "bazı [quiet] bildirimleri de ilk kısım
// geliyor"). The three forms: only [quiet], a turn that starts with [quiet], a turn that ends with [quiet].
const steps = (seq, kind, texts, end = 'completed') => [{ seq, type: 'turn/start' }, prompt(seq + 1, kind),
  ...texts.map((t, i) => ({ seq: seq + 2 + i, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: t }, { type: 'toolCall', id: `t${i}`, name: 'chats_list' }] } } })),
  { seq: seq + 2 + texts.length, type: 'turn/end', data: { reason: { kind: end } } }];
for (const [texts, why] of [[['[quiet]'], 'only [quiet]'], [['[quiet]\nThe audit found 2 issues.'], 'starts with [quiet]'],
  [['[quiet]', 'Updated the list.'], 'first text [quiet], then text'], [['Checking the chats.', '[quiet]'], 'a progress text, then [quiet]'],
  [['Checking the chats. [quiet]'], 'ends with [quiet]'], [['Checking.', 'Done: nothing new. [QUIET]'], 'last text ends with [QUIET]']]) {
  assert.equal(pushWords(steps(1, NEWS, texts), 0), undefined, `Damon: ${why}: no push`);
}
assert.equal(pushWords(steps(1, 'user', ['Checking.', 'Fixed the login.']), 0), 'Fixed the login.', 'Damon: a real reply pushes its newest text');
// A partial text that a stop cut (dsh logs it with `interrupted: true`) is not a reply.
const cut = { seq: 3, type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: 'Half a sent' }] } } };
assert.equal(pushWords([{ seq: 1, type: 'turn/start' }, prompt(2, NEWS), cut, { seq: 4, type: 'turn/end', data: { reason: { kind: 'aborted' } } }], 0), '', 'Damon: a stopped turn shows no partial text');
assert.equal(pushWords([{ seq: 1, type: 'turn/start' }, prompt(2, NEWS), { ...cut, data: { ...cut.data, message: { content: [{ type: 'text', text: '[quiet]' }] } } }, { seq: 4, type: 'turn/end', data: { reason: { kind: 'aborted' } } }], 0), '', 'Damon: a stopped [quiet] turn pushes no words');
// Hidden turns: empty text, only tool calls.
assert.equal(pushWords(steps(1, NEWS, ['']), 0), undefined, 'Damon: an empty text: no push');
assert.equal(pushWords([{ seq: 1, type: 'turn/start' }, prompt(2, NEWS), tool(3), { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } }], 0), undefined, 'Damon: only tool calls: no push');
// A run of two turns: a real reply, then a queued news turn whose first part is real and whose end is [quiet].
assert.equal(pushWords([...steps(1, 'user', ['Fixed the login.']), ...steps(9, NEWS, ['Checking.', '[quiet]'])], 0), 'Fixed the login.', 'Damon: the quiet second turn does not hide the real reply');
assert.equal(pushWords([...steps(1, NEWS, ['Checking.', '[quiet]']), ...steps(9, NEWS, ['[quiet]'])], 0), undefined, 'Damon: two quiet turns: no push');
// A question that you steered into a running news turn (review 2026-11-24): the [quiet] news part does not hide the answer.
const typed = (seq, text) => ({ seq, type: 'user/message', data: { source: { kind: 'user', rpcId: 'r2' }, content: [{ type: 'text', text }] } });
const steered = [{ seq: 1, type: 'turn/start' }, prompt(2, NEWS), say(3, '[quiet]'), tool(4), typed(5, 'Is the deploy done?'), say(6, 'Yes: acme-web is live.'), { seq: 7, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
assert.equal(pushWords(steered, 0), 'Yes: acme-web is live.', 'Damon: a steered question gets its answer pushed');
assert.equal(pushWords([...steered.slice(0, -1), say(7, '[quiet]'), { seq: 8, type: 'turn/end', data: { reason: { kind: 'completed' } } }], 0), 'Yes: acme-web is live.', 'Damon: a [quiet] after the answer');
assert.equal(pushWords([...steered.slice(0, 5), { seq: 6, type: 'turn/end', data: { reason: { kind: 'aborted' } } }], 0), '', 'Damon: stopped after the steered question: no words of the quiet part');
// A rollback that withdrew the steered question: the answer is withdrawn too, and the quiet part stays quiet.
assert.equal(pushWords([...steered.slice(0, -1), { seq: 7, type: 'user/message', data: { source: { kind: ROLLBACK_SOURCE } }, sourceEventSeqs: [5] }, { seq: 8, type: 'turn/end', data: { reason: { kind: 'completed' } } }], 0), undefined, 'Damon: a withdrawn question');
// Events of a run that has no turn/start (and no text): no push, not an empty one.
assert.equal(pushWords([{ seq: 1, type: 'agent/inbox/spliced' }], 0), undefined, 'Damon: no turn and no text: no push');
assert.equal(pushWords([], 0), undefined, 'Damon: no events: no push');
// Review round 2 (2026-11-24): a subagent's result that dsh steers into a [quiet] news turn is a part of its own.
for (const kind of ['subagent-settled', 'agent-message']) {
  const note = { seq: 5, type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text: 'Subagent finished.' }] } };
  assert.equal(pushWords([...steered.slice(0, 4), note, say(6, '**Deploy bitti:** acme-web canlıda.'), steered.at(-1)], 0), '**Deploy bitti:** acme-web canlıda.', `Damon: a ${kind} result after a [quiet] news part pushes`);
  assert.equal(pushWords([...steered.slice(0, 4), note, say(6, 'Not aldım.'), tool(7), say(8, '[quiet]'), { seq: 9, type: 'turn/end', data: { reason: { kind: 'completed' } } }], 0), undefined, `Damon: a ${kind} part that ends with [quiet]: no push`);
}
// A turn that you opened by typing keeps the strict rule; a later typed message (steered into your own turn) too.
const mine = (texts, more = []) => [{ seq: 1, type: 'turn/start' }, typed(2, 'Teşekkürler'), ...texts.map((t, i) => say(3 + i, t)), ...more, { seq: 30, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
assert.equal(pushWords(mine(['Not aldım.', '[quiet]']), 0), undefined, 'Damon: your turn whose last text is [quiet]: no push');
assert.equal(pushWords(mine(['Done. [quiet]']), 0), undefined, 'Damon: your turn whose last text ends with [quiet]: no push, never the raw mark');
assert.equal(pushWords(mine(['Not aldım.'], [typed(20, 'ok'), say(21, '[quiet]')]), 0), undefined, 'Damon: a message typed into your own turn keeps the strict rule');
// The steered answer: a text that ends with [quiet] is never the words.
assert.equal(pushWords([...steered.slice(0, -2), say(6, 'Yes. [quiet]'), steered.at(-1)], 0), undefined, 'Damon: a steered answer that ends with [quiet]: no push');
// A queued second turn that stops: the first turn's real reply stays the words (not '').
assert.equal(pushWords([...steps(1, 'user', ['Fixed the login.']), ...steps(9, NEWS, ['[quiet]'], 'aborted')], 0), 'Fixed the login.', 'Damon: a stopped quiet turn does not hide the real reply');
assert.equal(pushWords([...steps(1, 'user', ['Fixed the login.']), ...steps(9, NEWS, ['[quiet]'], 'max-tokens')], 0), 'Fixed the login.');
// Notifications only from Damon: the Host tells the gateway whether a push is about Damon's chat (or one of its subagents).
// dsh's session headers: a subagent has `origin: 'subagent'` and `parentSession`; a fork (Branch, Redo) of an older dsh
// has `parentSession` without that origin.
const headers = { d1: {}, sub: { origin: 'subagent', parentSession: 'd1' }, subsub: { origin: 'subagent', parentSession: 'sub' },
  fork: { parentSession: 'd1' }, forkSub: { origin: 'subagent', parentSession: 'fork' }, loop: { origin: 'subagent', parentSession: 'loop' }, w1: {} };
const headerOf = (id) => headers[id];
const damon = (on, id) => ({ isOn: () => on, id: () => id });
assert.deepEqual(damonAbout(damon(true, 'd1'), 'd1', headerOf), { damon: true });
assert.deepEqual(damonAbout(damon(true, 'd1'), 'subsub', headerOf), { damon: true, subagent: true }, 'a subagent of Damon (its error is Damon\'s news)');
assert.deepEqual(damonAbout(damon(true, 'd1'), 'fork', headerOf), { damon: false }, 'a fork of Damon is another chat, as on the phone');
assert.deepEqual(damonAbout(damon(true, 'd1'), 'forkSub', headerOf), { damon: false }, 'a subagent of a fork of Damon');
assert.deepEqual(damonAbout(damon(true, 'd1'), 'loop', headerOf), { damon: false }, 'a parent loop ends');
assert.deepEqual(damonAbout(damon(true, 'd1'), 'gone', headerOf), { damon: false }, 'a chat that is not loaded');
assert.deepEqual(damonAbout(damon(true, 'd1'), 'w1', headerOf), { damon: false }, 'a branch chat');
assert.deepEqual(damonAbout(damon(false, 'd1'), 'w1', headerOf), {}, 'Assistant off: no Damon, every chat pushes');
assert.deepEqual(damonAbout(damon(true, undefined), 'w1', headerOf), {}, 'no Damon chat yet: every chat pushes');
assert.match(readFileSync(new URL('../index.js', import.meta.url), 'utf8'), /const chatAbout = \(sessionId\) => \{\n\s*const session = [^\n]*\n\s*const damon = damonAbout\(assistant, sessionId, \(id\) => serviceOf\('agents'\)\?\.get\?\.\(id\)\?\.session\?\.header\);[\s\S]*?if \(session === undefined\) return damon;[\s\S]*?project: projectOf\(cwd, list\), \.\.\.damon \};/, 'chatAbout gives the gateway the Damon flag');
// The Host's push and green dot on a real agent/status edge: test/unread.test.mjs and test/quiet-replies.test.mjs.
console.log('tether push words: last reply of the turn (withdrawn replies left out), project name, chat id to the gateway, no push for an empty or [quiet] reply');
