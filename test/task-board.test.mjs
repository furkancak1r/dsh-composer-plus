// Task board (Host half): the board's chats. A start makes a new chat in the project's dsh workspace (not a Branch per chat
// folder, not an unknown folder) and sends the prompt with its own timeout (a `/command` that dsh knows runs as the
// command); a failed send archives the new chat (all or none). The record (board-chats.json) merges two starts that run at
// the same time, is owner-only, keeps the newest 2,000, and a broken file is kept aside. The tags come from one call to the
// new chat's own model (its selection; dsh's default without one), cleaned, and a bad answer adds none. The switch: off →
// 409; the old board.json is never read or changed. Unload stops a tag call.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_PATH, BOARD_CHATS_PATH, BOARD_LIMITS, BOARD_TAG_SYSTEM, boardTags, boardChatsStore, boardProject, startBoardChat, installBoard } from '../index.js';

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

  // The project of a start: a dsh workspace, never a Branch per chat folder.
  const reg = { list: () => [{ id: 'w1', path: '/w/acme/' }, { id: 'w2', path: '/w/acme/.worktrees/feat-x' }] };
  assert.equal(boardProject(reg, 'w1')?.path, '/w/acme/', 'by its workspace id');
  assert.equal(boardProject(reg, 'w2'), undefined, 'a Branch per chat folder is not a board project');
  assert.equal(boardProject(reg, 'nope'), undefined);
  assert.equal(boardProject(reg, ''), undefined);
  assert.equal(boardProject({ list: () => { throw new Error('not ready'); } }, 'w1'), undefined);

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

  // startBoardChat: the new chat, the prompt with its own timeout, the record; a failure archives the chat.
  const calls = [];
  const fakeController = (failPrompt = false) => ({
    create: async (req) => { calls.push(['create', req]); return { sessionId: `new-${calls.length}` }; },
    resolveAgent: async (id) => ({ agent: { id } }),
    prompt: async (req, signal) => {
      calls.push(['prompt', req.sessionId, req.mode, req.content, signal instanceof AbortSignal]);
      if (failPrompt) throw new Error('admission refused');
    },
  });
  const archived = [];
  const registry = { list: reg.list, archiveSession: async (id, o) => { archived.push([id, o]); } };
  const rec = boardChatsStore(join(root, 'b', 'board-chats.json'));
  let r = await startBoardChat({ sessionController: fakeController(), registry, store: rec }, 'w1', '  html css js ile satranç oyunu yap  ');
  assert.equal(r.sessionId, 'new-1');
  assert.deepEqual(calls[0], ['create', { workspaceId: 'w1' }], 'the project\'s dsh workspace');
  assert.deepEqual(calls[1], ['prompt', 'new-1', 'queue', [{ type: 'text', text: 'html css js ile satranç oyunu yap' }], true], 'queued, with its own signal');
  assert.equal(rec.list()['new-1'].prompt, 'html css js ile satranç oyunu yap');
  // A /command that dsh knows runs as the command; an unknown one goes as text.
  const executed = [];
  const commands = { find: (agent, name) => (name === 'plan' ? {} : undefined), execute: async (agent, text, att, signal) => { executed.push([agent.id, text, signal instanceof AbortSignal]); return { result: { kind: 'success' } }; } };
  calls.length = 0;
  await startBoardChat({ sessionController: fakeController(), commands, registry, store: rec }, 'w1', '/plan add dark mode');
  assert.deepEqual(executed, [['new-1', '/plan add dark mode', true]]);
  assert.equal(calls.filter((c) => c[0] === 'prompt').length, 0, 'not sent twice');
  calls.length = 0;
  await startBoardChat({ sessionController: fakeController(), commands, registry, store: rec }, 'w1', '/nope do it');
  assert.equal(calls.filter((c) => c[0] === 'prompt').length, 1, 'an unknown command is plain text');
  // Refusals before any chat exists.
  calls.length = 0;
  await assert.rejects(startBoardChat({ sessionController: fakeController(), registry, store: rec }, 'w2', 'x'), (e) => e.status === 404);
  await assert.rejects(startBoardChat({ sessionController: fakeController(), registry, store: rec }, 'w1', '   '), (e) => e.status === 400);
  await assert.rejects(startBoardChat({ sessionController: fakeController(), registry, store: rec }, 'w1', 'x'.repeat(BOARD_LIMITS.prompt + 1)), (e) => e.status === 400);
  assert.equal(calls.length, 0, 'no chat for a refused start');
  // A failed send: the new chat is archived, the error says so, nothing is recorded.
  const before = Object.keys(rec.list()).length;
  await assert.rejects(startBoardChat({ sessionController: fakeController(true), registry, store: rec }, 'w1', 'do it'), /admission refused; the new chat was archived/);
  assert.equal(archived.length, 1); assert.deepEqual(archived[0][1], { stopActivity: true });
  assert.equal(Object.keys(rec.list()).length, before, 'not recorded');
  const failedCmd = { find: () => ({}), execute: async () => ({ result: { kind: 'error', text: 'no plan mode' } }) };
  await assert.rejects(startBoardChat({ sessionController: fakeController(), commands: failedCmd, registry, store: rec }, 'w1', '/plan x'), /\/plan failed: no plan mode; the new chat was archived/);

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
  const ctx = {
    on() {}, effect: (f) => { effects.push(f()); },
    logger: { warn: (m) => warnings.push(m) },
    get: (name) => (name === 'workspaceRegistry' ? registry : name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'demo', model: 'fallback' }) } : undefined),
    connection: { fetch: { register: (x) => routes.set(x.path, x) } },
    sessionController: { ...fakeController(), agents: { selectionFor: () => (selection === undefined ? undefined : { current: selection }) } },
  };
  const board = installBoard(ctx, home);
  await board.ready;
  const call = async (path, body, query = '') => {
    const res = await routes.get(path).fetch(new Request(`http://h${path}${query}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual((await call(BOARD_PATH)).body, { on: true }, 'on by default');
  for (const bad of [{ on: 'yes' }, { on: true, backlog: true }, { backlog: true }, []]) assert.equal((await call(BOARD_PATH, bad)).status, 400, JSON.stringify(bad));
  r = await call(BOARD_CHATS_PATH);
  assert.equal(r.status, 200); assert.deepEqual(r.body.chats, {});
  assert.deepEqual((await call(BOARD_CHATS_PATH, undefined, `?rev=${r.body.rev}`)).body, { rev: r.body.rev, same: true });
  r = await call(BOARD_CHATS_PATH, { project: 'w1', prompt: 'html css js ile satranç oyunu yap' });
  assert.equal(r.status, 200);
  const sid = r.body.sessionId;
  for (let i = 0; i < 50 && (board.store.list()[sid]?.tags ?? []).length === 0; i++) await pause(5);
  assert.deepEqual(board.store.list()[sid].tags, ['chess', 'game'], 'the tags came from the model');
  assert.deepEqual(llmCalls[0].route, { provider: 'demo', model: 'chat-model' }, 'the new chat\'s own model');
  assert.equal(llmCalls[0].controls.maxTokens, 100, 'never above the model default'); assert.equal(llmCalls[0].controls.reasoningEffort, 'low');
  assert.equal(llmCalls[0].opts.system, BOARD_TAG_SYSTEM);
  assert.equal(llmCalls[0].opts.messages[0].content[0].text, 'html css js ile satranç oyunu yap', 'only the prompt goes to the model');
  const listed = await call(BOARD_CHATS_PATH);
  assert.deepEqual(listed.body.chats[sid].tags, ['chess', 'game']);
  // No selection: dsh's default model. A bad answer: no tags, the chat stays.
  selection = undefined; answer = 'I cannot help';
  r = await call(BOARD_CHATS_PATH, { project: 'w1', prompt: 'second' });
  for (let i = 0; i < 50 && llmCalls.length < 2; i++) await pause(5);
  await pause(10);
  assert.deepEqual(llmCalls[1].route, { provider: 'demo', model: 'fallback' }, 'dsh\'s default without a selection');
  assert.ok(board.store.list()[r.body.sessionId], 'the chat is on the board');
  assert.deepEqual(board.store.list()[r.body.sessionId].tags, [], 'no tags from a bad answer');
  for (const bad of [{ project: 'w1' }, { prompt: 'x' }, { project: 3, prompt: 'x' }, []]) assert.equal((await call(BOARD_CHATS_PATH, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(BOARD_CHATS_PATH, { project: 'nope', prompt: 'x' })).status, 404, 'not a dsh project');
  // Off: 409 for the chat route; the switch is saved; the old board.json is untouched.
  assert.deepEqual((await call(BOARD_PATH, { on: false })).body, { on: false });
  assert.equal((await call(BOARD_CHATS_PATH)).status, 409);
  assert.equal((await call(BOARD_CHATS_PATH, { project: 'w1', prompt: 'x' })).status, 409);
  assert.equal(JSON.parse(await readFile(join(dir, 'board-switch.json'), 'utf8')).on, false);
  assert.equal(await readFile(join(dir, 'board.json'), 'utf8'), '{"tasks":[{"id":1}]}', 'the old board file stays as it is');
  await call(BOARD_PATH, { on: true });
  // Unload during a tag call: the call stops and writes nothing.
  selection = { provider: 'demo', model: 'chat-model' }; answer = '["late"]'; ignoreAbort = true;
  let open; gate = new Promise((res) => { open = res; });
  r = await call(BOARD_CHATS_PATH, { project: 'w1', prompt: 'third' });
  for (let i = 0; i < 50 && llmCalls.length < 3; i++) await pause(5);
  effects.forEach((f) => f?.());
  open(); await pause(20);
  assert.ok(llmCalls[2].signal.aborted, 'unload stops the tag call');
  assert.deepEqual(board.store.list()[r.body.sessionId].tags, [], 'no tags after unload');
  // A second Host start reads the saved record and the switch.
  const again = installBoard({ ...ctx, connection: { fetch: { register: () => {} } } }, home);
  await again.ready; await again.store.ready;
  assert.deepEqual(again.store.list()[sid].tags, ['chess', 'game']);
  assert.equal(again.isOn(), true);
  console.log('task board: host ok');
} finally { await rm(root, { recursive: true, force: true }); }
