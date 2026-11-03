// Task board (Host half): the board's chats. New task opens dsh's own new chat; the client sends `{sessionId}` and the
// chat goes on the record (board-chats.json: merged, owner-only, the newest 2,000, a broken file kept aside). Its first
// message of its own (the user's, after a fork's inherited events, not one that a rollback withdrew) becomes the card's
// prompt, once, also when it came before the POST; one call to the chat's own model (its selection; dsh's default without
// one) writes the tags, cleaned, and a bad answer adds none. The switch: off → 409; the old board.json is never read.
// Unload stops a tag call.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_PATH, BOARD_CHATS_PATH, BOARD_LIMITS, BOARD_TAG_SYSTEM, ROLLBACK_SOURCE, REWIND_SOURCE, boardTags, boardChatsStore, boardPromptOf, installBoard } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-board-'));
const pause = (ms = 0) => new Promise((r) => setTimeout(r, ms));
try {
  // Tags from a model answer.
  assert.deepEqual(boardTags('["Frontend", "bug", "frontend", "a very long tag that is far too long"]'), ['frontend', 'bug']);
  assert.deepEqual(boardTags('<think>hmm ["x"]</think>Tags: ["ui","chess","game","extra"]'), ['ui', 'chess', 'game'], 'reasoning left out, at most 3');
  assert.deepEqual(boardTags('backend, api'), [], 'not a JSON array');
  assert.deepEqual(boardTags('["#api", " Two  words "]'), ['api', 'two words']);
  assert.deepEqual(boardTags('[1, null, {"a":1}]'), [], 'not strings');
  assert.deepEqual(boardTags('["a"'), [], 'a cut answer');
  assert.deepEqual(boardTags(''), []);
  assert.match(BOARD_TAG_SYSTEM, /JSON array/);

  // The first message of a chat's own: the user's text, after a fork's inherited events, not a withdrawn one.
  const msg = (seq, text, kind = 'user', extra = {}) => ({ seq, type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] }, ...extra });
  assert.equal(boardPromptOf([msg(0, 'parent ask'), { seq: 1, type: 'turn/start' }, msg(2, '  Make a chess game  ')], 2), 'Make a chess game', 'a fork: from inheritedEventCount on');
  assert.equal(boardPromptOf([msg(0, 'goal round', 'goal'), msg(1, 'Mine')]), 'Mine', 'only the user\'s own message');
  assert.equal(boardPromptOf([{ seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', data: 'x' }] } }, msg(1, 'Text')]), 'Text', 'a message without text is skipped');
  for (const kind of [ROLLBACK_SOURCE, REWIND_SOURCE]) {
    assert.equal(boardPromptOf([msg(0, 'Withdrawn'), { seq: 1, type: 'user/message', data: { source: { kind } }, sourceEventSeqs: [0] }, msg(2, 'Kept')]), 'Kept', `a message that ${kind} withdrew`);
  }
  assert.equal(boardPromptOf([msg(0, 'x'.repeat(BOARD_LIMITS.prompt + 5))]).length, BOARD_LIMITS.prompt);
  assert.equal(boardPromptOf([]), undefined); assert.equal(boardPromptOf([msg(0, '   ')]), undefined);

  // The record: merged, owner-only, newest kept, broken file kept aside.
  const file = join(root, 'a', 'board-chats.json');
  const store = boardChatsStore(file);
  await store.ready;
  const rev0 = store.rev();
  await Promise.all([store.change((c) => { c.s1 = { prompt: 'one', tags: [], at: 1 }; }), store.change((c) => { c.s2 = { prompt: 'two', tags: [], at: 2 }; })]);
  assert.deepEqual(Object.keys(store.list()).sort(), ['s1', 's2'], 'two changes at the same time: both stay');
  assert.ok(store.rev() > rev0);
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'owner-only file');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8')).chats).sort(), ['s1', 's2']);
  await assert.rejects(store.change((c) => { c.s3 = { prompt: 'x', tags: [], at: 3 }; throw new Error('later step fails'); }));
  assert.equal(store.list().s3, undefined, 'a failed change changes nothing');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).chats.s3, undefined, 'and writes nothing');
  const big = boardChatsStore(join(root, 'big', 'board-chats.json'));
  await big.change((c) => { for (let i = 0; i < BOARD_LIMITS.chats + 5; i++) c[`x${i}`] = { prompt: 'p', tags: [], at: i }; });
  assert.equal(Object.keys(big.list()).length, BOARD_LIMITS.chats, 'at most 2,000');
  assert.equal(big.list().x0, undefined, 'the oldest go'); assert.ok(big.list()[`x${BOARD_LIMITS.chats + 4}`]);
  await mkdir(join(root, 'broken'));
  await writeFile(join(root, 'broken', 'board-chats.json'), '{not json');
  const broken = boardChatsStore(join(root, 'broken', 'board-chats.json'));
  await broken.ready;
  assert.deepEqual(broken.list(), {});
  assert.ok((await readdir(join(root, 'broken'))).some((n) => n.startsWith('board-chats.json.broken-')), 'kept aside');
  await writeFile(join(root, 'broken', 'board-chats.json'), JSON.stringify({ chats: { good: { prompt: 'p', tags: ['ok', 7], at: 5 }, bad: { prompt: 3 }, __proto__: { prompt: 'x', at: 1 } } }));
  const mixed = boardChatsStore(join(root, 'broken', 'board-chats.json'));
  await mixed.ready;
  assert.deepEqual(mixed.list(), { good: { prompt: 'p', tags: ['ok'], at: 5 } }, 'malformed entries left out');

  // installBoard: the switch, the routes, the tags from the chat's model, off, unload.
  const home = join(root, 'home');
  const dir = join(home, 'storages', 'dsh-composer-plus');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'board.json'), '{"tasks":[{"id":1}]}');
  const routes = new Map(); const effects = []; const warnings = [];
  const llmCalls = [];
  let answer = '["chess", "Game"]';
  let gate; let ignoreAbort = false;
  const llm = {
    prepareCall: async (route, signal, controls) => {
      const c = controls({}, { reasoning: { efforts: [{ id: 'low' }] }, defaultMaxTokens: 100 });
      llmCalls.push({ route, controls: c, signal });
      return { config: {}, async *stream(opts) {
        llmCalls.at(-1).opts = opts;
        if (gate) await gate;
        // A provider can still answer after the abort: the Host must not write then.
        if (opts.signal.aborted && !ignoreAbort) { yield { type: 'finish', reason: { kind: 'aborted' } }; return; }
        yield { type: 'text-delta', text: answer }; yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
    listProviders: () => [{ id: 'demo' }], listModels: async () => [{ id: 'fallback' }],
  };
  let selection = { provider: 'demo', model: 'chat-model' };
  // Fake dsh chats: their events (snapshotEvents), fork offset and the session/event handler of the Host.
  const chats = new Map(); let onEvent;
  const chat = (id, events = [], inherited = 0) => { const session = { id, inheritedEventCount: inherited, snapshotEvents: () => chats.get(id).events }; chats.set(id, { events, session, agent: { id, session } }); return session; };
  const ctx = {
    on: (name, fn) => { if (name === 'session/event') onEvent = fn; }, effect: (f) => { effects.push(f()); },
    logger: { warn: (m) => warnings.push(m) },
    get: (name) => (name === 'llm' ? llm : name === 'agents' ? { get: (id) => chats.get(id)?.agent } : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'demo', model: 'fallback' }) } : undefined),
    connection: { fetch: { register: (x) => routes.set(x.path, x) } },
    sessionController: { resolveAgent: async (id) => (chats.has(id) ? { agent: chats.get(id).agent } : { error: 'not-found' }),
      agents: { selectionFor: () => (selection === undefined ? undefined : { current: selection }) } },
  };
  const board = installBoard(ctx, home);
  await board.ready;
  const call = async (path, body, query = '') => {
    const res = await routes.get(path).fetch(new Request(`http://h${path}${query}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  const send = (id, event) => { chats.get(id).events.push(event); onEvent(chats.get(id).session, event); };
  const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await pause(5); };
  assert.deepEqual((await call(BOARD_PATH)).body, { on: true }, 'on by default');
  for (const bad of [{ on: 'yes' }, { on: true, backlog: true }, { backlog: true }, []]) assert.equal((await call(BOARD_PATH, bad)).status, 400, JSON.stringify(bad));
  let r = await call(BOARD_CHATS_PATH);
  assert.equal(r.status, 200); assert.deepEqual(r.body.chats, {});
  assert.deepEqual((await call(BOARD_CHATS_PATH, undefined, `?rev=${r.body.rev}`)).body, { rev: r.body.rev, same: true });
  // New task: dsh's new chat goes on the record with no prompt; its first message names it and the model writes its tags.
  chat('n1');
  r = await call(BOARD_CHATS_PATH, { sessionId: 'n1' });
  assert.equal(r.status, 200); assert.equal(r.body.sessionId, 'n1');
  assert.deepEqual({ ...board.store.list().n1, at: 0 }, { prompt: '', tags: [], at: 0 }, 'on the board, before its first message');
  assert.equal(llmCalls.length, 0, 'no model call before a message');
  send('n1', msg(0, 'html css js ile satranç oyunu yap'));
  await waitFor(() => (board.store.list().n1?.tags ?? []).length > 0);
  assert.equal(board.store.list().n1.prompt, 'html css js ile satranç oyunu yap', 'the first message is the prompt');
  assert.deepEqual(board.store.list().n1.tags, ['chess', 'game'], 'the tags came from the model');
  assert.deepEqual(llmCalls[0].route, { provider: 'demo', model: 'chat-model' }, 'the chat\'s own model');
  assert.equal(llmCalls[0].controls.maxTokens, 100, 'never above the model default'); assert.equal(llmCalls[0].controls.reasoningEffort, 'low');
  assert.equal(llmCalls[0].opts.system, BOARD_TAG_SYSTEM);
  assert.equal(llmCalls[0].opts.messages[0].content[0].text, 'html css js ile satranç oyunu yap', 'only the prompt goes to the model');
  // Once: a second message, or the same chat posted again, changes nothing and calls no model.
  send('n1', msg(1, 'and add tests'));
  assert.equal((await call(BOARD_CHATS_PATH, { sessionId: 'n1' })).status, 200);
  await pause(20);
  assert.equal(board.store.list().n1.prompt, 'html css js ile satranç oyunu yap'); assert.equal(llmCalls.length, 1, 'one tag call per chat');
  // A chat that the board did not open: its messages are not recorded.
  chat('other'); send('other', msg(0, 'not a board task')); await pause(10);
  assert.equal(board.store.list().other, undefined);
  // A fast first message (before the POST, a fork's inherited events first): read from the chat's log.
  chat('n2', [msg(0, 'parent text'), msg(1, 'Fix the login bug')], 1);
  selection = undefined; answer = 'I cannot help';
  r = await call(BOARD_CHATS_PATH, { sessionId: 'n2' });
  await waitFor(() => llmCalls.length >= 2); await pause(10);
  assert.equal(board.store.list().n2.prompt, 'Fix the login bug', 'the first message of its own, read from the log');
  assert.deepEqual(llmCalls[1].route, { provider: 'demo', model: 'fallback' }, 'dsh\'s default without a selection');
  assert.deepEqual(board.store.list().n2.tags, [], 'no tags from a bad answer');
  // The route and the event at the same time (both pass the first look at the record): one write, one model call.
  chat('n3'); await call(BOARD_CHATS_PATH, { sessionId: 'n3' });
  await Promise.all([board.name('n3', chats.get('n3').agent, 'First'), board.name('n3', chats.get('n3').agent, 'Second')]);
  await waitFor(() => llmCalls.length >= 3); await pause(20);
  assert.equal(board.store.list().n3.prompt, 'First', 'the first one wins');
  assert.equal(llmCalls.length, 3, 'one tag call for a chat named twice at the same time');
  for (const bad of [{ project: 'w1', prompt: 'x' }, { sessionId: 3 }, { sessionId: '' }, { sessionId: 'n1', prompt: 'x' }, { sessionId: '__proto__' }, []]) assert.equal((await call(BOARD_CHATS_PATH, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(BOARD_CHATS_PATH, { sessionId: 'nope' })).status, 404, 'not a dsh chat');
  // Off: 409 for the chat route, and a message records nothing; the switch is saved; the old board.json is untouched.
  assert.deepEqual((await call(BOARD_PATH, { on: false })).body, { on: false });
  assert.equal((await call(BOARD_CHATS_PATH)).status, 409);
  assert.equal((await call(BOARD_CHATS_PATH, { sessionId: 'n1' })).status, 409);
  assert.equal(JSON.parse(await readFile(join(dir, 'board-switch.json'), 'utf8')).on, false);
  assert.equal(await readFile(join(dir, 'board.json'), 'utf8'), '{"tasks":[{"id":1}]}', 'the old board file stays as it is');
  await call(BOARD_PATH, { on: true });
  chat('n4'); await call(BOARD_CHATS_PATH, { sessionId: 'n4' });
  await call(BOARD_PATH, { on: false }); send('n4', msg(0, 'while off')); await pause(10);
  assert.equal(board.store.list().n4.prompt, '', 'off: a message is not recorded');
  await call(BOARD_PATH, { on: true });
  // Unload during a tag call: the call stops and writes nothing.
  selection = { provider: 'demo', model: 'chat-model' }; answer = '["late"]'; ignoreAbort = true;
  let open; gate = new Promise((res) => { open = res; });
  chat('n5'); await call(BOARD_CHATS_PATH, { sessionId: 'n5' }); send('n5', msg(0, 'third'));
  await waitFor(() => llmCalls.length >= 4);
  effects.forEach((f) => f?.());
  open(); await pause(20);
  assert.ok(llmCalls[3].signal.aborted, 'unload stops the tag call');
  assert.deepEqual(board.store.list().n5.tags, [], 'no tags after unload');
  // A second Host start reads the saved record and the switch.
  const again = installBoard({ ...ctx, connection: { fetch: { register: () => {} } } }, home);
  await again.ready; await again.store.ready;
  assert.deepEqual(again.store.list().n1.tags, ['chess', 'game']);
  assert.equal(again.isOn(), true);
  console.log('task board: host ok');
} finally { await rm(root, { recursive: true, force: true }); }
