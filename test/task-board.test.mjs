// Task board (Host half): the board file, its order rules (bottom on create and status change, a drop between two cards,
// renumber when the gap is too small), the "changed meanwhile" check of an edit, the agent tools (project from the chat's
// folder, Branch per chat folders count as their repository, next task skips human tasks, list hides done and human), the
// prompt section (only for a project with open tasks, then it stays), the switch (off: no tools, no section, the data
// route answers 409), Backlog (off only when empty), a broken file (kept aside, the board starts empty), export.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_PATH, BOARD_TASKS_PATH, BOARD_SECTION, BOARD_DONE_SHOWN, boardStore, boardOps, boardView, boardProjectOf, boardSlug, boardTags, boardKey, boardExport, boardSearch, boardProjects, installBoard } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-board-'));
try {
  // Pure rules.
  assert.deepEqual(boardTags(' Bug, UI,bug ,, needs  review'), ['bug', 'ui', 'needs review']);
  assert.deepEqual(boardTags(''), []);
  assert.throws(() => boardTags(Array.from({ length: 21 }, (_, i) => `t${i}`).join(',')), /at most 20 tags/);
  assert.equal(boardSlug('Acme Shop!', new Set()), 'acme-shop');
  assert.equal(boardSlug('acme-shop', new Set(['acme-shop', 'acme-shop-2'])), 'acme-shop-3');
  assert.equal(boardSlug('Şeker', new Set()), 'seker');
  assert.equal(boardSlug('日本', new Set()), 'project');
  const paths = ['/w/acme', '/w/acme/web', '/w/blog'];
  assert.equal(boardProjectOf('/w/acme/src', paths), '/w/acme');
  assert.equal(boardProjectOf('/w/acme/web/x', paths), '/w/acme/web', 'the nearest project');
  assert.equal(boardProjectOf('/w/acme/.worktrees/feat-login', paths), '/w/acme', 'a Branch per chat folder is its repository');
  assert.equal(boardProjectOf('/w/acme-two', paths), '/w/acme-two', 'a name prefix is not a parent folder');
  assert.equal(boardProjectOf('/w/solo/.worktrees/feat-x/src', paths), '/w/solo', 'a Branch per chat folder of a repository that is not a dsh project');
  assert.equal(boardProjectOf('/w/blog/', paths), '/w/blog');

  // Order and edits on a store.
  const file = join(root, 'board.json');
  let clock = Date.parse('2026-11-02T10:00:00Z');
  const store = boardStore(file, { now: () => new Date(clock += 60000) });
  await store.ready;
  const reg = [{ path: '/w/acme', title: '' }, { path: '/w/blog', title: 'Blog' }, { path: '/w/acme/.worktrees/feat-x', title: 'feat-x' }];
  const make = (title, extra = {}) => store.change((d, now) => boardOps.create(d, now, { path: '/w/acme', title, ...extra }, reg));
  const a = await make('  Fix   the login  '); const b = await make('Cache images'); const c = await make('Remove v1');
  const t = (id) => store.peek().tasks.find((x) => x.id === id);
  assert.equal(t(a).title, 'Fix the login', 'one line');
  assert.deepEqual([a, b, c].map((id) => t(id).position), [1, 2, 3], 'new tasks go to the bottom');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tasks.length, 3, 'saved');
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'owner-only file');
  const view = () => boardView(store.peek(), reg, { project: '/w/acme' });
  const order = (status) => view().tasks.filter((x) => x.status === status).map((x) => x.id);
  await store.change((d, now) => boardOps.move(d, now, c, 'todo', a));
  assert.deepEqual(order('todo'), [c, a, b], 'drop before the first card: the top');
  await store.change((d, now) => boardOps.move(d, now, c, 'todo', b));
  assert.deepEqual(order('todo'), [a, c, b], 'drop between two cards');
  await store.change((d, now) => boardOps.move(d, now, a, 'doing'));
  assert.deepEqual(order('doing'), [a]); assert.equal(t(a).updated !== t(a).created, true, 'a move to another column is a change');
  // A tiny gap renumbers the column.
  await store.change((d) => { d.tasks.find((x) => x.id === c).position = 1; d.tasks.find((x) => x.id === b).position = 1 + Number.EPSILON; }); // no float between them
  const d1 = await make('Drop me');
  await store.change((d, now) => boardOps.move(d, now, d1, 'todo', b));
  assert.deepEqual(order('todo'), [c, d1, b], 'renumbered, then between');
  assert.ok(t(c).position < t(d1).position && t(d1).position < t(b).position);
  // Status change from the editor: to the bottom of the new column.
  await store.change((d, now) => boardOps.update(d, now, c, { status: 'doing' }));
  assert.deepEqual(order('doing'), [a, c]);
  await assert.rejects(store.change((d, now) => boardOps.update(d, now, c, { status: 'backlog' })), /unknown status "backlog"/, 'backlog is off');
  await assert.rejects(store.change((d, now) => boardOps.update(d, now, c, { title: '   ' })), /needs a title/);
  // "Changed meanwhile": the editor's start value no longer matches → nothing changes.
  await store.change((d, now) => boardOps.update(d, now, b, { description: 'Agent text' }));
  await assert.rejects(store.change((d, now) => boardOps.update(d, now, b, { description: 'My text' }, { description: '' })), (e) => e.status === 409);
  assert.equal(t(b).description, 'Agent text', 'not overwritten');
  await store.change((d, now) => boardOps.update(d, now, b, { tags: 'Perf, perf' }, { description: 'Agent text' }));
  assert.deepEqual(t(b).tags, ['perf']);
  const before = JSON.stringify(store.peek());
  await assert.rejects(store.change((d, now) => { boardOps.update(d, now, b, { title: 'X' }); throw new Error('later step fails'); }));
  assert.equal(JSON.stringify(store.peek()), before, 'a failed change changes nothing (all or none)');
  assert.equal(JSON.stringify(JSON.parse(await readFile(file, 'utf8'))), before, 'and writes nothing');
  // Comments.
  await store.change((d, now) => boardOps.comment(d, now, b, { body: ' Looks good ', by: 'user' }));
  await assert.rejects(store.change((d, now) => boardOps.comment(d, now, b, { body: '  ', by: 'user' })), /needs text/);
  assert.equal(t(b).comments[0].body, 'Looks good');
  await store.change((d) => boardOps.uncomment(d, b, t(b).comments[0].id));
  assert.equal(t(b).comments.length, 0);
  // Next task: the top todo that is not human.
  await store.change((d, now) => boardOps.update(d, now, d1, { human: true }));
  const n = await store.change((d, now) => boardOps.next(d, now, '/w/acme'));
  assert.equal(n, b, 'the human task on top is skipped'); assert.equal(t(b).status, 'doing'); assert.deepEqual(order('doing'), [a, c, b]);
  assert.equal(await store.change((d, now) => boardOps.next(d, now, '/w/acme')), undefined, 'only a human task is left');

  // Keys, projects, view, search, export.
  const projects = boardProjects(store.peek(), reg);
  assert.deepEqual(projects.map((p) => [p.name, p.slug, p.open]), [['acme', 'acme', 4], ['Blog', 'blog', 0]], 'dsh projects A–Z; no Branch per chat folder');
  const slugs = new Map(projects.map((p) => [p.path, p.slug]));
  assert.equal(boardKey(`acme#${b}`, store.peek(), slugs), b);
  assert.equal(boardKey(`#${b}`, store.peek(), slugs), b);
  assert.equal(boardKey(b, store.peek(), slugs), b);
  assert.throws(() => boardKey(`blog#${b}`, store.peek(), slugs), /no task/);
  assert.throws(() => boardKey('api#999', store.peek(), slugs), /no task #999/);
  assert.throws(() => boardKey('drop table', store.peek(), slugs), /not a task/);
  assert.deepEqual(boardSearch(store.peek(), reg, 'cache perf').map((x) => x.id), [b], 'every word, tags too');
  assert.deepEqual(boardSearch(store.peek(), reg, `acme#${a}`).map((x) => x.id), [a], 'the key');
  const md = boardExport(store.peek(), reg, '/w/acme', 'markdown', '2026-11-02T12:00:00.000Z');
  assert.match(md, /^# Task board\n\nExported 2026-11-02 12:00 UTC\.\n\n## acme `acme`\n\n4 open of 4 task\(s\)\./);
  assert.match(md, /### doing\n\n#### acme#1 Fix the login/);
  const js = JSON.parse(boardExport(store.peek(), reg, 'all', 'json'));
  assert.equal(js.projects.length, 1, 'all: only projects with tasks'); assert.equal(js.projects[0].tasks.length, 4);

  // Done: the newest 50 in a view, the rest with done=all.
  const many = boardStore(join(root, 'many.json'));
  await many.ready;
  await many.change((d, now) => { for (let i = 0; i < BOARD_DONE_SHOWN + 5; i++) { const id = boardOps.create(d, now, { path: '/w/blog', title: `Old ${i}`, status: 'done' }, reg); void id; } });
  const v = boardView(many.peek(), reg, { project: '/w/blog' });
  assert.equal(v.hiddenDone, 5); assert.equal(v.tasks.length, BOARD_DONE_SHOWN); assert.equal(v.tasks[0].title, 'Old 5', 'the newest stay');
  assert.equal(boardView(many.peek(), reg, { project: '/w/blog', done: true }).tasks.length, BOARD_DONE_SHOWN + 5);

  // A broken file is kept aside and the board starts empty; nothing overwrites it.
  const broken = join(root, 'broken', 'board.json');
  await mkdir(join(root, 'broken'));
  await writeFile(broken, '{"tasks": [', { mode: 0o600 });
  const fresh = boardStore(broken);
  await fresh.ready;
  assert.equal(fresh.peek().tasks.length, 0);
  assert.ok((await readdir(join(root, 'broken'))).some((f) => f.startsWith('board.json.broken-')), 'the broken file is kept');
  // A file with one bad task keeps the good ones.
  const mixed = join(root, 'mixed.json');
  await writeFile(mixed, JSON.stringify({ projects: [{ path: '/w/acme', slug: 'acme' }], tasks: [
    { id: 4, path: '/w/acme', title: 'Good', status: 'todo', position: 1, created: '2026-11-01T00:00:00Z', updated: '2026-11-01T00:00:00Z', comments: [] },
    { id: 5, path: '/w/elsewhere', title: 'No project', status: 'todo', position: 2, created: '2026-11-01T00:00:00Z', updated: '2026-11-01T00:00:00Z' },
    { id: 6, path: '/w/acme', title: 'Bad status', status: 'later', position: 3, created: '2026-11-01T00:00:00Z', updated: '2026-11-01T00:00:00Z' }] }));
  const m = boardStore(mixed); await m.ready;
  assert.deepEqual(m.peek().tasks.map((x) => x.id), [4]); assert.equal(m.peek().next, 5, 'ids never repeat');
  // A big board inside the limits (260 tasks × 500 comments) loads: it is not taken for a broken file.
  const big = join(root, 'big', 'board.json');
  await mkdir(join(root, 'big'));
  let cid = 0; const at = '2026-11-01T00:00:00.000Z';
  await writeFile(big, JSON.stringify({ projects: [{ path: '/w/acme', slug: 'acme' }], tasks: Array.from({ length: 260 }, (_, i) => ({ id: i + 1, path: '/w/acme', title: `T${i}`, status: 'done', position: i + 1, created: at, updated: at,
    comments: Array.from({ length: 500 }, () => ({ id: ++cid, by: 'agent', body: 'ok', at })) })) }));
  const bigStore = boardStore(big); await bigStore.ready;
  assert.equal(bigStore.peek().tasks.length, 260, 'a big board loads');
  assert.equal(bigStore.peek().nextComment, cid + 1); assert.equal(bigStore.peek().next, 261);
  assert.deepEqual(await readdir(join(root, 'big')), ['board.json'], 'nothing kept aside');

  // installBoard: switch, routes, tools and section.
  const home = join(root, 'home');
  const routes = new Map(); const effects = [];
  const registered = { tools: new Map(), sections: new Map() };
  let disposed = 0;
  const workspaces = [{ path: join(root, 'acme'), title: 'acme' }, { path: join(root, 'blog'), title: 'blog' }];
  for (const w of workspaces) await mkdir(w.path);
  const header = { [`s-acme`]: { cwd: join(root, 'acme', 'src') }, [`s-blog`]: { cwd: join(root, 'blog') } };
  const ctx = {
    on() {}, effect: (f) => { effects.push(f()); },
    get: (name) => (name === 'workspaceRegistry' ? { list: () => workspaces } : undefined),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionQuery: { observeSession: async (id) => ({ header: header[id], events: [] }) },
    inject: (deps, setup) => {
      assert.deepEqual(deps, ['tools', 'systemPrompt']);
      const offs = [];
      setup({ tools: { register: (x) => { registered.tools.set(x.name, x); offs.push(() => registered.tools.delete(x.name)); } },
        systemPrompt: { section: (s) => { registered.sections.set(s.name, s); offs.push(() => registered.sections.delete(s.name)); } } });
      return { dispose: () => { disposed++; offs.forEach((f) => f()); } };
    },
  };
  const board = installBoard(ctx, home);
  await board.ready;
  const call = async (path, body, query = '') => {
    const r = await routes.get(path).fetch(new Request(`http://h${path}${query}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  assert.deepEqual((await call(BOARD_PATH)).body, { on: true, backlog: false }, 'on by default');
  assert.equal(registered.tools.size, 8);
  const agent = (id) => ({ id, session: { header: header[id] } });
  const tool = (name, args, id = 's-acme') => registered.tools.get(name).execute(args, { agent: agent(id) });
  const section = (id) => registered.sections.get('composer-plus:board').text({ agent: agent(id) });
  assert.equal(section('s-acme'), '', 'no open task: no section');
  assert.equal(await tool('board_list_tasks', {}), 'No tasks in acme.');
  assert.equal(await tool('board_create_task', { title: 'Add login', tags: 'auth' }), 'Created acme#1 in todo: Add login', 'the chat folder below the project');
  assert.equal(await tool('board_create_task', { title: 'Write post', project: 'blog' }), 'Created blog#2 in todo: Write post');
  assert.equal(await tool('board_create_task', { title: 'Call the bank', human: true }), 'Created acme#3 in todo: Call the bank');
  assert.equal(section('s-acme'), BOARD_SECTION, 'open tasks: the section');
  assert.match(await tool('board_list_projects', {}), /^acme: 2 open of 2 <- this chat\nblog: 1 open of 1$/);
  assert.equal(await tool('board_list_tasks', {}), 'acme#1 [todo] Add login {auth}\n(1 human task not shown: for the user, not for agents)');
  assert.match(await tool('board_next_task', {}), /^Moved to doing:\nacme#1 Add login \{auth\}\nstatus: doing, created/);
  assert.equal(await tool('board_next_task', {}), 'Nothing in todo for acme.', 'the human task stays');
  assert.equal(await tool('board_add_comment', { id: 'acme#1', body: 'Done in src/login.js; tests pass.' }), 'Comment added to acme#1.');
  assert.equal(board.store.peek().tasks[0].comments[0].sessionId, 's-acme', 'the comment links its chat');
  assert.equal(await tool('board_update_task', { id: '#1', status: 'review' }), 'Updated acme#1, doing -> review: Add login');
  assert.match(await tool('board_get_task', { id: 1 }), /status: review[\s\S]*Comments \(1\):\n- agent, /);
  await assert.rejects(tool('board_update_task', { id: 'blog#1', status: 'done' }), /no task blog#1/);
  await assert.rejects(tool('board_create_task', { title: 'x', project: 'nope' }), /no project "nope"; projects: acme, blog/);
  assert.equal(await tool('board_list_tasks', { status: 'done' }), 'No tasks in acme.');
  assert.equal(await tool('board_delete_task', { id: 'blog#2' }), 'Deleted blog#2: Write post');
  // A chat that once got the section keeps it (the same prompt prefix), also when its project has no open task.
  await tool('board_update_task', { id: 'acme#1', status: 'done' }); await tool('board_update_task', { id: 'acme#3', status: 'done' });
  assert.equal(section('s-acme'), BOARD_SECTION, 'kept for this chat');
  assert.equal(section('s-blog'), '', 'another chat without open tasks gets none');

  // The data route: views, rev, task, search, the browser's changes, export.
  const acme = join(root, 'acme');
  let r = await call(BOARD_TASKS_PATH, undefined, `?project=${encodeURIComponent(acme)}`);
  assert.equal(r.status, 200); assert.deepEqual(r.body.statuses, ['todo', 'doing', 'review', 'done']); assert.equal(r.body.tasks.length, 2);
  assert.deepEqual((await call(BOARD_TASKS_PATH, undefined, `?project=${encodeURIComponent(acme)}&rev=${r.body.rev}`)).body, { rev: r.body.rev, same: true }, 'nothing new');
  assert.equal((await call(BOARD_TASKS_PATH, undefined, '?sessionId=s-acme')).body.project, acme, 'a chat: its project');
  assert.equal((await call(BOARD_TASKS_PATH, undefined, '?project=/etc')).status, 404, 'only a board project');
  r = await call(BOARD_TASKS_PATH, { op: 'create', project: acme, title: 'From the board', description: 'Body' });
  assert.equal(r.status, 200); assert.equal(r.body.task.key, 'acme#4'); assert.equal(r.body.task.status, 'todo');
  assert.equal((await call(BOARD_TASKS_PATH, { op: 'create', project: '/etc', title: 'x' })).status, 400, 'a path that is not a project');
  assert.equal((await call(BOARD_TASKS_PATH, { op: 'update', id: 4, description: 'Mine', was: { description: 'Not the start' } })).status, 409, 'changed meanwhile');
  assert.equal((await call(BOARD_TASKS_PATH, { op: 'update', id: 4, description: 'Mine', was: { description: 'Body' } })).body.task.description, 'Mine');
  assert.equal((await call(BOARD_TASKS_PATH, { op: 'move', id: 4, status: 'review' })).body.task.status, 'review');
  assert.equal((await call(BOARD_TASKS_PATH, { op: 'comment', id: 4, body: 'Hi' })).body.task.comments[0].by, 'user');
  assert.equal((await call(BOARD_TASKS_PATH, undefined, '?task=4')).body.task.comments.length, 1);
  assert.deepEqual((await call(BOARD_TASKS_PATH, undefined, '?q=board')).body.results.map((x) => x.id), [4]);
  const exp = await call(BOARD_TASKS_PATH, undefined, `?project=${encodeURIComponent(acme)}&export=markdown`);
  assert.equal(exp.body.name, 'task-board-acme.md'); assert.match(exp.body.text, /#### acme#4 From the board/);
  assert.equal((await call(BOARD_TASKS_PATH, { op: 'delete', id: 4 })).body.deleted, 4);
  assert.equal((await call(BOARD_TASKS_PATH, undefined, '?task=4')).status, 404);
  for (const bad of [{ op: 'nuke' }, { op: 'move', id: 1 }, { op: 'update', id: 1, was: { human: 'x' } }, { op: 'comment', id: 1 }, [], { op: 'update', id: -1 }]) assert.equal((await call(BOARD_TASKS_PATH, bad)).status, 400, JSON.stringify(bad));

  // Backlog: on, a task in it, off refused, empty → off.
  assert.equal((await call(BOARD_PATH, { backlog: true })).body.backlog, true);
  await tool('board_create_task', { title: 'Idea', status: 'backlog' });
  r = await call(BOARD_PATH, { backlog: false });
  assert.equal(r.status, 409); assert.match(r.body.error, /move the 1 task out of Backlog first/);
  await tool('board_update_task', { id: 'acme#5', status: 'todo' });
  assert.equal((await call(BOARD_PATH, { backlog: false })).body.backlog, false);
  assert.equal((await call(BOARD_PATH, { on: 'yes' })).status, 400); assert.equal((await call(BOARD_PATH, { on: true, backlog: true })).status, 400);

  // Off: no tools, no section, 409; data kept; on again.
  assert.deepEqual((await call(BOARD_PATH, { on: false })).body, { on: false, backlog: false });
  assert.equal(registered.tools.size, 0); assert.equal(registered.sections.size, 0); assert.ok(disposed >= 1);
  assert.equal((await call(BOARD_TASKS_PATH, undefined, '?project=all')).status, 409);
  assert.equal(JSON.parse(await readFile(join(home, 'storages', 'dsh-composer-plus', 'board-switch.json'), 'utf8')).on, false);
  await call(BOARD_PATH, { on: true });
  assert.equal(registered.tools.size, 8, 'on again');
  assert.equal(board.store.peek().tasks.length, 3, 'the data stayed');
  effects.forEach((f) => f?.()); assert.equal(registered.tools.size, 0, 'unload removes the tools');
  // A second Host start reads the saved board and the switch.
  const routes2 = new Map();
  const again = installBoard({ ...ctx, connection: { fetch: { register: (x) => routes2.set(x.path, x) } } }, home);
  await again.ready; await again.store.ready;
  assert.equal(again.store.peek().tasks.length, 3); assert.equal(again.store.peek().next, 6);
  console.log('task board: host ok');
} finally { await rm(root, { recursive: true, force: true }); }
