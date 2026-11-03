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
import { BOARD_PATH, BOARD_CHATS_PATH, BOARD_PROGRESS_PATH, BOARD_PROGRESS, BOARD_PROGRESS_SYSTEM, BOARD_LIMITS, BOARD_TAG_SYSTEM, ROLLBACK_SOURCE, REWIND_SOURCE, boardTags, boardChatsStore, boardPromptOf, boardProgressOf, installBoard } from '../index.js';

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

  // Progress of a running chat, from its own log: the open turn, the todo list, the newest tool call and the agent's line.
  const ev = (seq, type, data, extra = {}) => ({ seq, type, data, ...extra });
  const callEv = (seq, id, name, args) => ev(seq, 'tool/call', { callId: id, name, arguments: JSON.stringify(args) });
  const resultEv = (seq, id) => ev(seq, 'tool/result', { message: { source: { callId: id }, content: [{ type: 'text', text: 'ok' }] } });
  const said = (seq, text) => ev(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } });
  const todos = (seq, list) => ev(seq, 'todo/write', { todos: list });
  const log = [
    ev(0, 'turn/start', {}, { time: 1000 }), said(1, 'Old reply'), callEv(2, 'c0', 'read', { file_path: '/old.js' }), resultEv(3, 'c0'), ev(4, 'turn/end', {}),
    ev(5, 'turn/start', {}, { time: 5000 }), msg(6, 'Add tests'),
    todos(7, [{ content: 'Read the code', status: 'completed' }, { content: 'Write the tests', status: 'in_progress' }, { content: 'Run them', status: 'pending' }]),
    callEv(8, 'c1', 'todo_write', {}), resultEv(9, 'c1'),
    said(10, 'I read the code.\n\nNow I write the tests.'),
    callEv(11, 'c2', 'bash', { command: 'npm test -- --watch=false\nexit', description: 'Run the unit tests' }),
  ];
  assert.deepEqual(boardProgressOf(log), { since: 5000, todos: { done: 1, total: 3, current: 'Write the tests' }, tool: { name: 'bash', detail: 'Run the unit tests', running: true }, said: 'Now I write the tests.' },
    'the open turn: its start, the todo list, the running step (not todo_write), the agent\'s last line');
  assert.equal(boardProgressOf([...log, resultEv(12, 'c2')]).tool.running, false, 'a step with its result is done');
  assert.equal(boardProgressOf([...log, resultEv(12, 'other')]).tool.running, true, 'the result of another call does not end it');
  assert.deepEqual(boardProgressOf(log.slice(0, 10)), { since: 5000, todos: { done: 1, total: 3, current: 'Write the tests' } }, 'a new turn: no step and no line of the last turn; todo_write is not a step');
  assert.deepEqual(boardProgressOf([...log.slice(0, 5)]).tool, { name: 'read', detail: '/old.js', running: false }, 'one turn only');
  assert.deepEqual(boardProgressOf([ev(0, 'turn/start', {}, { time: 1 }), callEv(1, 'x', 'grep', { pattern: 'TODO' })]).tool, { name: 'grep', detail: 'TODO', running: true }, 'a pattern as the detail');
  assert.equal(boardProgressOf(log.slice(0, 5), 5).tool, undefined, 'a fork: the parent\'s events do not count');
  assert.deepEqual(boardProgressOf(log, 5).todos.current, 'Write the tests');
  for (const kind of [ROLLBACK_SOURCE, REWIND_SOURCE]) {
    const back = [...log, ev(12, 'user/message', { source: { kind } }, { sourceEventSeqs: [11] }), callEv(13, 'c3', 'edit', { file_path: '/a.js' })];
    assert.deepEqual(boardProgressOf(back).tool, { name: 'edit', detail: '/a.js', running: true }, `a step that ${kind} withdrew does not show`);
    assert.equal(boardProgressOf([...log, ev(12, 'user/message', { source: { kind } }, { sourceEventSeqs: [7] })]).todos, undefined, `nor a todo list that ${kind} withdrew`);
  }
  assert.equal(boardProgressOf([callEv(0, 'b', 'bash', { command: 'x'.repeat(500) })]).tool.detail.length, BOARD_PROGRESS.detail + 1, 'a long detail is cut');
  assert.deepEqual(boardProgressOf([]), {});

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
  // Progress on hover: fast by default (the log only, no model call); AI summary as a setting.
  const P = BOARD_PROGRESS_PATH;
  assert.deepEqual((await call(P)).body, { mode: 'fast' }, 'fast (no AI) by default');
  chat('run', [...log]);
  const before = llmCalls.length;
  r = await call(P, undefined, '?sessionId=run');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { mode: 'fast', ...boardProgressOf(log) });
  assert.equal(llmCalls.length, before, 'fast: no model call');
  assert.equal((await call(P, undefined, '?sessionId=nope')).status, 404, 'a chat that dsh does not have open');
  for (const bad of [{ mode: 'slow' }, { mode: 'ai', x: 1 }, { on: true }, []]) assert.equal((await call(P, bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await call(P, { mode: 'ai' })).body, { mode: 'ai' });
  assert.equal((await stat(join(dir, 'board-progress.json'))).mode & 0o777, 0o600, 'owner-only setting');
  selection = { provider: 'demo', model: 'chat-model' };
  answer = '  Writing the tests\n(step 2 of 3).  ';
  r = await call(P, undefined, '?sessionId=run');
  assert.equal(r.body.pending, true, 'AI: the summary call runs in the background');
  await waitFor(() => llmCalls.length > before); await pause(10);
  const sum = llmCalls.at(-1);
  assert.equal(sum.opts.system, BOARD_PROGRESS_SYSTEM); assert.deepEqual(sum.route, { provider: 'demo', model: 'chat-model' }, 'the chat\'s own model');
  assert.match(sum.opts.messages[0].content[0].text, /Tool call bash/, 'the chat\'s newest part goes to the model');
  assert.equal(sum.controls.reasoningEffort, 'low');
  r = await call(P, undefined, '?sessionId=run');
  assert.equal(r.body.summary, 'Writing the tests (step 2 of 3).', 'one line'); assert.equal(r.body.pending, undefined);
  assert.equal(r.body.tool.name, 'bash', 'the fast part is there too');
  const calls = llmCalls.length;
  await call(P, undefined, '?sessionId=run');
  assert.equal(llmCalls.length, calls, 'the chat did not move on: no new call');
  chats.get('run').events.push(resultEv(12, 'c2'));
  await call(P, undefined, '?sessionId=run'); await pause(10);
  assert.equal(llmCalls.length, calls, `it moved on, but less than ${BOARD_PROGRESS.gapMs / 1000} s after the last call: no new call`);
  assert.equal((await call(P, undefined, '?sessionId=run')).body.summary, 'Writing the tests (step 2 of 3).', 'the last summary stays');
  // Later (the gap passed, shown with a shifted clock): no new call while the chat did not move on; a new step starts one.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60000;
    await call(P, undefined, '?sessionId=run');
    await waitFor(() => llmCalls.length > calls); await pause(10);
    assert.equal(llmCalls.length, calls + 1, 'the gap passed and the chat moved on (the result came): one new call');
    await call(P, undefined, '?sessionId=run'); await pause(10);
    const settled = llmCalls.length;
    assert.equal(settled, calls + 1, 'the same step: no second call');
    Date.now = () => realNow() + 120000;
    await call(P, undefined, '?sessionId=run'); await pause(10);
    assert.equal(llmCalls.length, settled, 'the gap passed but nothing changed: no new call');
    // One call per chat at a time: while one runs, a newer step and the gap do not start a second one.
    let release; gate = new Promise((res) => { release = res; });
    chats.get('run').events.push(said(13, 'Tests pass.'));
    await call(P, undefined, '?sessionId=run');
    await waitFor(() => llmCalls.length > settled);
    chats.get('run').events.push(said(14, 'Done.'));
    Date.now = () => realNow() + 180000;
    await call(P, undefined, '?sessionId=run'); await pause(10);
    assert.equal(llmCalls.length, settled + 1, 'one summary call at a time per chat');
    release(); gate = undefined; await pause(10);
  } finally { Date.now = realNow; }
  assert.deepEqual((await call(P, { mode: 'fast' })).body, { mode: 'fast' });
  assert.equal((await call(P, undefined, '?sessionId=run')).body.summary, undefined, 'fast: no summary');
  assert.deepEqual((await call(BOARD_PATH, { on: false })).body, { on: false });
  assert.equal((await call(BOARD_CHATS_PATH)).status, 409);
  assert.equal((await call(BOARD_CHATS_PATH, { sessionId: 'n1' })).status, 409);
  assert.equal((await call(BOARD_PROGRESS_PATH, undefined, '?sessionId=run')).status, 409, 'off: no progress');
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
  const atUnload = llmCalls.length;
  await waitFor(() => llmCalls.length > atUnload);
  effects.forEach((f) => f?.());
  open(); await pause(20);
  assert.ok(llmCalls.at(-1).signal.aborted, 'unload stops the tag call');
  assert.deepEqual(board.store.list().n5.tags, [], 'no tags after unload');
  // A second Host start reads the saved record and the switch.
  const again = installBoard({ ...ctx, connection: { fetch: { register: () => {} } } }, home);
  await again.ready; await again.store.ready;
  assert.deepEqual(again.store.list().n1.tags, ['chess', 'game']);
  assert.equal(again.isOn(), true);
  console.log('task board: host ok');
} finally { await rm(root, { recursive: true, force: true }); }
