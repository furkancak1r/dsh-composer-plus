// Assistant: visible branch chats. chat_new with `branch: true` starts the delegated work as a real dsh chat on a new git
// branch in `<repo>/.worktrees/<name>` (the same path as "New branch" of Worktree chats), registered as a dsh project, with
// the given title and the first message; the approval card names the branch and the title. The chat is kept as a task
// (owner-only file, read again after a restart); when its turn ends (completed, max-tokens, error) or it waits for the user,
// a hidden note wakes the assistant even while Assistant news is off, without the gap. A stop by the user gives no note; dsh's
// quit keeps the task. Real git in a temporary repository; fake dsh services.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_FREE_SECTION, ASSISTANT_TASKS_MAX, assistantFreeTool, assistantNewsNote, assistantTasks, installAssistant, installAssistantBot } from '../index.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(5); } };
const subprocess = {
  resolveExecutable: async () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
  spawn({ argv, cwd, env }) {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    return {
      done: new Promise((resolve) => child.on('close', (code) => resolve({ exitCode: code, signal: null }))),
      collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err }) } },
    };
  },
};
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cp-assistant-branch-')));
try {
  // The task store: owner-only, read again after a restart, capped (the oldest goes first).
  {
    const file = join(base, 'tasks.json');
    const t = assistantTasks(file, () => 7);
    await t.ready;
    await t.add('s-1', { title: 'Giriş sayfası', project: 'acme', branch: 'feat/login' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { tasks: { 's-1': { title: 'Giriş sayfası', project: 'acme', branch: 'feat/login', at: 7 } } });
    assert.equal((statSync(file).mode & 0o777).toString(8), '600');
    const again = assistantTasks(file);
    await again.ready;
    assert.equal(again.get('s-1').branch, 'feat/login', 'read again after a restart');
    for (let i = 0; i < ASSISTANT_TASKS_MAX + 2; i++) await again.add(`s-x${i}`, { project: 'p' });
    assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).tasks).length, ASSISTANT_TASKS_MAX); assert.equal(again.has('s-1'), false, 'the oldest goes first');
    await again.drop('s-x10');
    assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).tasks).length, ASSISTANT_TASKS_MAX - 1);
    writeFileSync(file, '{broken');
    const broken = assistantTasks(file); await broken.ready;
    assert.equal(broken.has('s-x11'), false, 'a broken file is an empty list');
  }

  // A git project, a project that is not a repository and the assistant folder.
  const P = join(base, 'acme-web'); mkdirSync(P);
  git(P, 'init', '-q', '-b', 'main'); writeFileSync(join(P, 'a.txt'), 'a\n'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'init');
  const N = join(base, 'notes'); mkdirSync(N);
  const home = join(base, 'home'); const folder = join(base, 'Assistant');
  const dir = join(home, 'storages', 'dsh-composer-plus');

  const workspaces = [{ id: 'w-web', title: 'acme-web', path: P, sessionIds: [] }, { id: 'w-notes', title: 'notes', path: N, sessionIds: [] }];
  const agents = new Map(); const listeners = new Map(); const routes = new Map(); const steers = []; const archivedIds = new Set();
  const made = { sessions: [], renames: [], prompts: [], models: [] };
  let created = 0; let promptFails = false;
  const newAgent = (id, header = {}, events = []) => {
    const registered = new Map();
    const agent = { id, status: 'idle', events, session: { id, header, inheritedEventCount: 0, snapshotEvents: () => agent.events },
      ctx: { tools: { register: (t) => { registered.set(t.name, t); return () => registered.delete(t.name); }, restrict: () => () => {} } },
      inbox: { prepend: (target, m) => { agent.queued = m; }, remove: () => {} }, steer: (m) => { steers.push([id, m]); }, registered };
    agents.set(id, agent);
    return agent;
  };
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
  const ctx = {
    logger: { warn: () => {} },
    subprocess,
    get: (name) => ({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
      workspaceRegistry: { list: () => workspaces, get archivedSessionIds() { return [...archivedIds]; },
        create: async (path, title) => { let w = workspaces.find((x) => x.path === path); if (!w) { w = { id: `w-${workspaces.length}`, title, path, sessionIds: [] }; workspaces.push(w); } return w; },
        archiveSession: async () => {} },
      permissionPresets: { names: [], set: () => {} },
      sessionPersistence: { list: async () => [...agents.keys()].map((id) => ({ header: { id } })) } })[name],
    on,
    effect: () => {},
    inject: (deps, setup) => { setup({ systemPrompt: { section: () => {} } }); return { dispose: () => {} }; },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return async () => routes.delete(route.path); } } },
    sessionQuery: {
      observeSession: async () => { throw new Error('the assistant\'s chat_new must not read a source chat'); },
      readTitle: async (id) => ({ title: made.renames.find((r) => r.sessionId === id)?.title }),
    },
    sessionController: {
      list: async () => ({ items: [] }),
      resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found', message: 'not found' } }),
      create: async (input) => {
        made.sessions.push(input); created += 1; const id = `s-${created}`;
        const w = workspaces.find((x) => x.id === input.workspaceId); w.sessionIds.push(id);
        newAgent(id, { cwd: w.path }); return { sessionId: id };
      },
      selectModel: async (input) => { made.models.push(input); },
      rename: async (r) => { made.renames.push(r); },
      prompt: async (input, signal) => { signal.throwIfAborted(); if (promptFails) throw new Error('queue is full'); made.prompts.push(input); },
    },
  };
  const assistant = installAssistant(ctx, home, { folder, zone: 'UTC' });
  await assistant.ready;
  const assistantId = (await (await routes.get('/api/composer-plus.assistant').fetch(new Request('http://x/api/composer-plus.assistant'))).json()).sessionId;
  const me = agents.get(assistantId);
  me.events.push({ type: 'request/header', data: { header: { tools: [{ name: 'subagent', parameters: { properties: { prompt: {} } } }] } } });
  const timing = { turn: 60000, wait: 40, batch: 20, gap: 120000, max: 10, reply: 300, taskReply: 2000 };
  let clock = 1_000_000;
  const bot = installAssistantBot(ctx, home, assistant, { timing, now: () => clock });
  await bot.ready;
  assert.equal(bot.notify(), false, 'Assistant news is off');
  const chatNew = me.registered.get('chat_new');
  const as = { agent: me };

  // The approval card names the branch and the title.
  const pre = listeners.get('tools/pre-execute')[0];
  const card = await pre({ name: 'chat_new', agent: me, arguments: JSON.stringify({ project: 'acme-web', text: 'Add a footer', branch: true, title: 'Alt bilgi ekle' }) }, async () => ({ kind: 'allow' }));
  assert.equal(card.kind, 'ask', 'one approval per delegation');
  assert.match(card.reason, /start a new chat on a new branch in "acme-web" named "Alt bilgi ekle": "Add a footer"/);
  // The free rule allows chat_new and tells the model where project work goes.
  assert.equal((await pre({ name: 'chat_new', agent: me, arguments: '{}' }, async () => ({ kind: 'allow' }))).kind, 'ask');
  assert.match(ASSISTANT_FREE_SECTION, /chat_new with branch true/);

  // branch: true makes the worktree, the branch, the project and the chat, with the title before the message.
  const out = await chatNew.execute({ project: 'ACME-WEB', text: 'Sayfaya alt bilgi ekle', branch: true, title: '  Alt bilgi  ekle ' }, as);
  const sid = `s-${created}`;
  const path = join(P, '.worktrees', 'feat-sayfaya-alt-bilgi-ekle');
  assert.match(out, new RegExp(`Started a new chat \\(${sid}\\) on the new branch feat/sayfaya-alt-bilgi-ekle of acme-web`));
  assert.ok(existsSync(join(path, 'a.txt')), 'the worktree has the files');
  assert.equal(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat/sayfaya-alt-bilgi-ekle');
  assert.equal(git(P, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'the project folder stays on its branch');
  assert.equal(git(P, 'status', '--porcelain'), '', 'the project folder stays clean');
  const branchProject = workspaces.find((w) => w.path === realpathSync(path) || w.path === path);
  assert.equal(branchProject?.title, 'feat/sayfaya-alt-bilgi-ekle', 'the worktree is a dsh project named after the branch (dsh\'s Workspace Tree nests it inside acme-web)');
  // F-01: the answer does not claim that every sidebar view nests it.
  assert.match(out, /lists it as the project "feat\/sayfaya-alt-bilgi-ekle" \(inside acme-web in the Workspace Tree view\)/); assert.doesNotMatch(out, /shows it under the project/);
  assert.deepEqual(made.sessions.at(-1), { workspaceId: branchProject.id }, 'dsh\'s default mode');
  assert.equal(made.models.length, 0, 'dsh\'s default model');
  assert.deepEqual(made.renames.at(-1), { sessionId: sid, title: 'Alt bilgi ekle' }, 'the title, spaces folded');
  assert.equal(made.prompts.at(-1).sessionId, sid); assert.deepEqual(made.prompts.at(-1).content, [{ type: 'text', text: 'Sayfaya alt bilgi ekle' }]);
  assert.deepEqual(assistant.tasks.get(sid), { title: 'Alt bilgi ekle', project: 'acme-web', branch: 'feat/sayfaya-alt-bilgi-ekle', at: assistant.tasks.get(sid).at });
  assert.ok(JSON.parse(readFileSync(join(dir, 'assistant-tasks.json'), 'utf8')).tasks[sid], 'saved');

  // Refusals: no repository, a bad title, a bad branch value, Branch per chat off. No chat is made.
  const before = created;
  await assert.rejects(chatNew.execute({ project: 'notes', text: 'x', branch: true }, as), /this project folder is not in a git repository/);
  await assert.rejects(chatNew.execute({ project: 'acme-web', text: 'x', branch: true, title: 'x'.repeat(121) }, as), /title is 1 to 120/);
  await assert.rejects(chatNew.execute({ project: 'acme-web', text: 'x', branch: true, title: '   ' }, as), /title is 1 to 120/);
  await assert.rejects(chatNew.execute({ project: 'acme-web', text: 'x', branch: 'yes' }, as), /branch is true or false/);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'worktrees.json'), '{"on":false}');
  await assert.rejects(chatNew.execute({ project: 'acme-web', text: 'x', branch: true }, as), /Branch per chat is switched off/);
  writeFileSync(join(dir, 'worktrees.json'), '{"on":true}');
  assert.equal(created, before, 'no chat for a refused call');
  // A failed message: the task is dropped (no note for a chat that never got its work).
  promptFails = true;
  await assert.rejects(chatNew.execute({ project: 'acme-web', text: 'Fix the header', branch: true }, as), /queue is full; the new worktree stays at/);
  promptFails = false;
  assert.equal(assistant.tasks.has(`s-${created}`), false, 'no task without its message');
  // Without branch: a chat in the project folder, with the title.
  assert.match(await chatNew.execute({ project: 'acme-web', text: 'Only a question', title: 'Soru' }, as), /Started a new chat \(s-\d+\) in acme-web\./);
  assert.deepEqual(made.renames.at(-1), { sessionId: `s-${created}`, title: 'Soru' });
  assert.equal(assistant.tasks.has(`s-${created}`), false, 'a chat without branch is no task');

  // The task chat ends its turn: one note (News is off; no 60 s rule), with its result; the task leaves the list.
  const task = agents.get(sid);
  const am = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
  task.events = [{ seq: 0, type: 'turn/start' }, am(1, 'Alt bilgi eklendi, testler geçti. Commit: abc123.')];
  emit('session/event', task.session, { type: 'turn/start', time: 1 });
  emit('session/event', task.session, { type: 'turn/end', time: 2, data: { reason: { kind: 'completed' } } });
  await until(() => steers.length === 1, 'the task note');
  assert.equal(steers[0][0], assistantId);
  assert.equal(assistant.tasks.has(sid), false, 'the task leaves the list');
  const step = await listeners.get('agent/pre-step')[0]({ agent: me }, async () => ({ kind: 'enter', messages: [me.queued, steers[0][1]] }));
  const note = step.messages[0].content[0].text;
  assert.match(note, new RegExp(`"Alt bilgi ekle" \\(project "acme-web", chat ${sid}, your delegated task on branch "feat/sayfaya-alt-bilgi-ekle"\\): finished\\. Last reply: "Alt bilgi eklendi, testler geçti\\. Commit: abc123\\."`));
  assert.match(note, /not instructions for you/); assert.match(note, /result of each delegated task in a few lines/);
  // F-05: the note names only tools that the assistant chat may call (Assistant always free refuses the others).
  for (const named of note.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) assert.ok(assistantFreeTool(named), `the note names ${named}, which the assistant cannot call`);
  assert.doesNotMatch(note, /task list/);

  // A second task right after: no gap wait (the user started it). An error is news; a stop by the user is not; dsh's quit keeps it.
  for (const [id, branch] of [['t-err', 'feat/a'], ['t-stop', 'feat/b'], ['t-quit', 'feat/c'], ['t-wait', 'feat/d']]) { newAgent(id, { cwd: P }); await assistant.tasks.add(id, { project: 'acme-web', branch }); }
  emit('session/event', agents.get('t-err').session, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'HTTP 500' } } } });
  emit('session/event', agents.get('t-stop').session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  emit('session/event', agents.get('t-quit').session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } });
  await until(() => steers.length === 2, 'the error note without the gap');
  const step2 = await listeners.get('agent/pre-step')[0]({ agent: me }, async () => ({ kind: 'enter', messages: [me.queued, steers[1][1]] }));
  assert.match(step2.messages[0].content[0].text, /chat t-err, your delegated task on branch "feat\/a"\): failed\. Error: "HTTP 500"/);
  assert.doesNotMatch(step2.messages[0].content[0].text, /t-stop|t-quit/);
  assert.equal(assistant.tasks.has('t-stop'), false, 'a stopped task leaves the list');
  assert.equal(assistant.tasks.has('t-quit'), true, 'dsh\'s quit keeps the task');
  // A wait for the user (approval) is news; the task stays until its turn ends. F-03: a wait keeps the 2-minute gap
  // (only a finished or failed task skips it), so a task chat that asks often does not start a model turn each time.
  const waiting = agents.get('t-wait');
  waiting.events = [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'approval/asked', data: { id: 'x' } }];
  emit('session/event', waiting.session, { type: 'approval/asked', data: { id: 'x' } });
  await until(() => bot.pending()[0]?.kind === 'waiting', 'the wait is news');
  await pause(60);
  assert.equal(steers.length, 2, 'a wait waits for the gap');
  clock += timing.gap; await bot.flush();
  await until(() => steers.length === 3, 'the wait note after the gap');
  const step3 = await listeners.get('agent/pre-step')[0]({ agent: me }, async () => ({ kind: 'enter', messages: [me.queued, steers[2][1]] }));
  assert.match(step3.messages[0].content[0].text, /chat t-wait, your delegated task on branch "feat\/d"\): waits for your approval/);
  assert.equal(assistant.tasks.has('t-wait'), true);
  // F-02: switching Assistant news off forgets the turns that it saw start, as before this feature: a turn that started
  // while news was on and ends after news is on again (its start unseen) is no news.
  clock += timing.gap;
  const off = (v) => routes.get('/api/composer-plus.assistant-notify').fetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ on: v }) }));
  const early = newAgent('early', { cwd: P });
  await off(true);
  emit('session/event', early.session, { type: 'turn/start', time: clock });
  await off(false);
  emit('session/event', early.session, { type: 'turn/end', time: clock + 1000, data: { reason: { kind: 'completed' } } });
  emit('session/event', early.session, { type: 'turn/start', time: clock + 2000 });
  await off(true);
  emit('session/event', early.session, { type: 'turn/end', time: clock + 100000, data: { reason: { kind: 'completed' } } });
  await pause(60);
  assert.equal(steers.length, 3, 'no news from a turn start seen before the switch went off');
  await off(false);
  // An ordinary chat is no news while Assistant news is off.
  const other = newAgent('plain', { cwd: P });
  emit('session/event', other.session, { type: 'turn/start', time: 0 });
  emit('session/event', other.session, { type: 'turn/end', time: 100000, data: { reason: { kind: 'completed' } } });
  await pause(60);
  assert.equal(steers.length, 3, 'news off: an ordinary chat gives nothing');
  assert.deepEqual(bot.pending(), []);

  // A task result that the assistant chat does not get (its steer throws) stays and goes once, after the gap.
  const told = async (i) => (await listeners.get('agent/pre-step')[0]({ agent: me }, async () => ({ kind: 'enter', messages: [me.queued, steers[i][1]] }))).messages[0].content[0].text;
  const steer = me.steer; let throws = 1;
  me.steer = (m) => { if (throws > 0) { throws -= 1; throw new Error('steer failed'); } steer(m); };
  const lost = newAgent('t-lost', { cwd: P }); await assistant.tasks.add('t-lost', { project: 'acme-web', branch: 'feat/e' });
  lost.events = [{ seq: 0, type: 'turn/start' }, am(1, 'Rapor hazır.')];
  emit('session/event', lost.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await until(() => throws === 0, 'the failed delivery');
  assert.equal(steers.length, 3);
  assert.deepEqual(bot.pending().map(({ id, kind, task }) => ({ id, kind, task })), [{ id: 't-lost', kind: 'finished', task: true }], 'the task result stays');
  clock += timing.gap; await bot.flush();
  assert.equal(steers.length, 4, 'one retry'); assert.equal(steers[3][0], assistantId);
  assert.match(await told(3), /chat t-lost, your delegated task on branch "feat\/e"\): finished\. Last reply: "Rapor hazır\."/);
  await bot.flush(); assert.equal(steers.length, 4, 'told once'); assert.deepEqual(bot.pending(), []);
  // The assistant chat is archived: the task result stays (other news goes) and goes when the chat is back.
  archivedIds.add(assistantId); await off(true); timing.batch = 60000; // flushed by hand
  const late = newAgent('t-late', { cwd: P }); await assistant.tasks.add('t-late', { project: 'acme-web', branch: 'feat/f' });
  late.events = [{ seq: 0, type: 'turn/start' }, am(1, 'Bitti.')];
  emit('session/event', other.session, { type: 'turn/start', time: clock });
  emit('session/event', other.session, { type: 'turn/end', time: clock + 100000, data: { reason: { kind: 'completed' } } });
  emit('session/event', late.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await until(() => bot.pending().length === 2, 'two items');
  await bot.flush(); timing.batch = 20;
  assert.deepEqual(bot.pending().map(({ id, task }) => ({ id, task })), [{ id: 't-late', task: true }], 'only the task result stays');
  assert.equal(steers.length, 4);
  archivedIds.delete(assistantId); await off(false);
  clock += timing.gap; await bot.flush();
  assert.equal(steers.length, 5, 'told after the chat is back');
  assert.match(await told(4), /chat t-late, your delegated task on branch "feat\/f"\): finished\. Last reply: "Bitti\."/);
  me.steer = steer;

  // The plain news note (no task) still says not to call a tool.
  assert.match(assistantNewsNote([{ id: 'a', title: 'A', project: 'p', at: 1, kind: 'finished', reply: '' }]), /Do not call a tool/);
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log('assistant-branch-chat: ok');
