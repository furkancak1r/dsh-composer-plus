// Branches in the workspace tree (Host half), with real git in temporary repositories and fake dsh services:
// - sync: each linked worktree in <root>/.worktrees with a branch becomes a project (title = branch); a worktree folder
//   that is deleted (or a branch project whose folder is gone) is removed; a project that is not a main working tree, a
//   detached worktree, a worktree outside .worktrees and a project below a symlinked or dangling folder change nothing.
// - branchToWorktree: the main folder goes back to its branch and the new branch gets its worktree; uncommitted changes,
//   another branch and a taken folder refuse with nothing written.
// - the hooks: a branch made and checked out by a chat's tool call moves the chat (a dsh-fork-like copy in the new
//   project, archived old chat, hidden note, carried steering); not clean = no move; switch off = nothing; route.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANCH_TREE_PATH, branchToWorktree, copyChatTo, installBranchTree, repoOf, syncBranchTree } from '../index.js';

const subprocess = {
  resolveExecutable: async () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
  spawn({ argv, cwd, env }) {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => {});
    return { done: new Promise((resolve) => { child.on('close', (code) => resolve({ exitCode: code, signal: null })); child.on('error', () => resolve({ exitCode: 1, signal: null })); }),
      collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err }) } } };
  },
};
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const repo = (path) => { mkdirSync(path, { recursive: true }); git(path, 'init', '-q', '-b', 'main'); writeFileSync(join(path, 'a.txt'), 'a\n'); git(path, 'add', '-A'); git(path, 'commit', '-qm', 'init'); return path; };
const branchOf = (cwd) => git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

// A fake dsh workspace registry: create is idempotent per real path, delete keeps nothing else.
const fakeRegistry = (paths = []) => {
  let n = 0; const items = new Map(); const archived = [];
  const reg = {
    items, archived,
    list: () => [...items.values()],
    get: (id) => items.get(id),
    create: async (path, title) => {
      const real = realpathSync(path);
      for (const w of items.values()) if (w.path === real) return w;
      const w = { id: `ws-${++n}`, path: real, title, attached: [], attachSession: async (id) => { w.attached.push(id); } };
      items.set(w.id, w); return w;
    },
    delete: async (id) => items.delete(id),
    archiveSession: async (id, options) => { archived.push({ id, options }); },
  };
  for (const p of paths) reg.create(p);
  return reg;
};
const titles = (reg) => Object.fromEntries(reg.list().map((w) => [w.path, w.title ?? null]));

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cp-branch-tree-')));
try {
  // --- sync ---
  const A = repo(join(base, 'A'));
  git(A, 'worktree', 'add', '-q', join(A, '.worktrees', 'feat-one'), '-b', 'feat/one');
  git(A, 'worktree', 'add', '-q', join(A, '.worktrees', 'feat-two'), '-b', 'feat/two');
  git(A, 'worktree', 'add', '-q', '--detach', join(A, '.worktrees', 'detached'));
  git(A, 'worktree', 'add', '-q', join(base, 'outside-wt'), '-b', 'outside');
  const plain = join(base, 'plain'); mkdirSync(plain);
  const sub = join(A, 'sub'); mkdirSync(sub);
  // A project below a symlinked folder that points inside, and one below a dangling symlink (its folder does not resolve).
  symlinkSync(A, join(base, 'alias')); symlinkSync(join(base, 'nowhere'), join(base, 'ghost'));
  const reg = fakeRegistry([A, plain, sub]);
  await new Promise((r) => setTimeout(r, 10));
  reg.items.set('ws-ghost', { id: 'ws-ghost', path: join(base, 'ghost', 'x'), title: 'ghost' });
  reg.items.set('ws-alias', { id: 'ws-alias', path: join(base, 'alias', 'sub'), title: 'alias sub' });
  let r = await syncBranchTree({ subprocess, registry: reg });
  assert.deepEqual(r.added.sort(), [join(A, '.worktrees', 'feat-one'), join(A, '.worktrees', 'feat-two')], 'branch worktrees in .worktrees are added');
  assert.equal(titles(reg)[join(A, '.worktrees', 'feat-one')], 'feat/one', 'title = branch');
  assert.ok(!(join(A, '.worktrees', 'detached') in titles(reg)), 'a detached worktree is not added');
  assert.ok(!(join(base, 'outside-wt') in titles(reg)), 'a worktree outside .worktrees is not added');
  assert.ok(reg.get('ws-ghost') && reg.get('ws-alias'), 'paths below a dangling or symlinked folder change nothing and fail nothing');
  assert.deepEqual(r.removed, []);
  r = await syncBranchTree({ subprocess, registry: reg });
  assert.deepEqual(r, { added: [], removed: [] }, 'a second sync changes nothing');
  // A deleted worktree folder (git calls it prunable) and a removed worktree both leave the tree.
  rmSync(join(A, '.worktrees', 'feat-one'), { recursive: true, force: true });
  git(A, 'worktree', 'remove', join(A, '.worktrees', 'feat-two'));
  r = await syncBranchTree({ subprocess, registry: reg });
  assert.deepEqual(r.removed.sort(), [join(A, '.worktrees', 'feat-one'), join(A, '.worktrees', 'feat-two')], 'deleted branches leave the tree');
  assert.deepEqual(r.added, []);
  assert.ok(existsSync(join(A, 'a.txt')) && branchOf(A) === 'main', 'the sync writes nothing in the project');
  // A branch project whose main project is not registered: removed when its folder is gone.
  const B = repo(join(base, 'B'));
  git(B, 'worktree', 'add', '-q', join(B, '.worktrees', 'x'), '-b', 'x');
  const reg2 = fakeRegistry([join(B, '.worktrees', 'x')]);
  assert.deepEqual(await syncBranchTree({ subprocess, registry: reg2 }), { added: [], removed: [] }, 'a branch project alone stays while its folder exists');
  rmSync(join(B, '.worktrees', 'x'), { recursive: true, force: true });
  assert.deepEqual((await syncBranchTree({ subprocess, registry: reg2 })).removed, [join(B, '.worktrees', 'x')]);

  // --- branchToWorktree ---
  const C = repo(join(base, 'C'));
  const facts = await repoOf(subprocess, C);
  git(C, 'switch', '-qc', 'feat/login');
  const moved = await branchToWorktree(subprocess, facts, 'main', 'feat/login');
  assert.deepEqual(moved, { path: join(C, '.worktrees', 'feat-login') });
  assert.equal(branchOf(C), 'main', 'the main folder is back on main');
  assert.equal(branchOf(moved.path), 'feat/login', 'the branch has its worktree');
  assert.match(readFileSync(join(C, '.git', 'info', 'exclude'), 'utf8'), /^\.worktrees\/$/m, '.worktrees/ is excluded locally');
  assert.equal(git(C, 'status', '--porcelain'), '');
  // Uncommitted change: refused, nothing changes.
  git(C, 'switch', '-qc', 'feat/dirty'); writeFileSync(join(C, 'new.txt'), 'n');
  await assert.rejects(branchToWorktree(subprocess, facts, 'main', 'feat/dirty'), (e) => e.status === 409 && /uncommitted/.test(e.message));
  assert.equal(branchOf(C), 'feat/dirty', 'not clean: the folder stays on the new branch'); assert.ok(!existsSync(join(C, '.worktrees', 'feat-dirty')));
  rmSync(join(C, 'new.txt'));
  await assert.rejects(branchToWorktree(subprocess, facts, 'main', 'feat/other'), /not on feat\/other/);
  mkdirSync(join(C, '.worktrees', 'feat-dirty'));
  await assert.rejects(branchToWorktree(subprocess, facts, 'main', 'feat/dirty'), /exists/);
  assert.equal(branchOf(C), 'feat/dirty', 'a taken folder: nothing changes');
  rmSync(join(C, '.worktrees', 'feat-dirty'), { recursive: true }); git(C, 'switch', '-q', 'main');

  // --- the hooks ---
  const home = join(base, 'home');
  const D = repo(join(base, 'D'));
  const registry = fakeRegistry([D]);
  const handlers = {}; const routes = new Map(); const effects = [];
  const on = (name, fn) => { (handlers[name] ??= []).push(fn); };
  const emit = (name, ...args) => Promise.all((handlers[name] ?? []).map((fn) => fn(...args)));
  // dsh opens a turn long before the model's first tool call ends: the turn-start read (branch, branches) ends first.
  const turnStart = async (agent) => { await emit('session/event', agent.session, { type: 'turn/start', seq: 0 }); await new Promise((resolve) => setTimeout(resolve, 300)); };
  const chain = async (name, payload, last) => {
    const list = handlers[name] ?? []; const run = (i) => (i < list.length ? list[i](...payload, () => run(i + 1)) : last());
    return run(0);
  };
  const copies = [];
  const fakeAgent = (id, cwd, events = []) => {
    const a = { id, status: 'idle', steered: [], injected: [], cancels: 0,
      session: { id, header: { id, cwd }, snapshotEvents: () => events },
      inbox: { nextTurn: [], clear: () => { a.cleared = true; } },
      inject: (m) => a.injected.push(m), steer: (m) => a.steered.push(m), cancel: () => { a.cancels++; } };
    a.inbox.prepend = (t, m) => a.injected.push({ prepend: t, ...m });
    a.inbox.remove = () => true;
    return a;
  };
  const live = new Map();
  const agents = { create: async (options) => { const a = fakeAgent(options.sessionId, options.meta.cwd, options.seed); copies.push({ options, agent: a }); live.set(a.id, a); return { agent: a, dispose: async () => {} }; } };
  const cds = [];
  const sessionController = {
    agents: { composeAgent: async (preset) => ({ agentPreset: preset ?? 'ptc', setup: () => {} }), presetForSession: () => 'ptc', agentOptions: () => ({ provider: 'demo', model: 'demo' }) },
    resolveAgent: async (id) => (live.has(id) ? { agent: live.get(id) } : { error: new Error('gone') }),
  };
  const services = { workspaceRegistry: registry, agents, workingDirectory: { set: async (agent, cwd) => { cds.push([agent.id, cwd]); } } };
  const ctx = { subprocess, on, sessionController, get: (n) => services[n], effect: (fn) => effects.push(fn()), logger: { warn: () => {} },
    connection: { fetch: { register: (x) => routes.set(x.path, x) } } };
  installBranchTree(ctx, home);
  const route = routes.get(BRANCH_TREE_PATH);
  const call = async (method, body, query = '') => {
    const res = await route.fetch(new Request(`http://h${BRANCH_TREE_PATH}${query}`, method === 'GET' ? {} : { method, body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: res.status, data: await res.json() };
  };
  assert.deepEqual((await call('GET')).data, { on: false }, 'off by default');
  for (const bad of ['{', {}, { on: 'yes' }, { on: true, sync: true }, { sync: 1 }]) assert.equal((await call('POST', bad)).status, 400, JSON.stringify(bad));
  // Off: a chat that makes a branch does not move.
  const chat = fakeAgent('chat-1', D, [{ type: 'turn/start', seq: 0, time: 1 }, { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' } } }]);
  const tool = async (agent) => chain('tools/post-execute', [{ agent }, {}], async () => ({ kind: 'accept' }));
  await turnStart(chat);
  git(D, 'switch', '-qc', 'feat/off'); await tool(chat);
  assert.equal(branchOf(D), 'feat/off', 'off: nothing moves'); git(D, 'switch', '-q', 'main');
  assert.deepEqual((await call('POST', { on: true })).data, { on: true });
  assert.equal(statSync(join(home, 'storages', 'dsh-composer-plus', 'branch-tree.json')).mode & 0o777, 0o600, 'owner-only switch file');
  // A tool call that changes nothing: no move. Then the agent makes and checks out a branch.
  await turnStart(chat);
  assert.deepEqual(await tool(chat), { kind: 'accept' });
  git(D, 'switch', '-qc', 'feat/login-form');
  assert.deepEqual(await tool(chat), { kind: 'accept' }, 'the tool result is not changed');
  assert.equal(branchOf(D), 'main', 'the main folder is back on main');
  assert.equal(branchOf(join(D, '.worktrees', 'feat-login-form')), 'feat/login-form');
  // Further tool calls are denied; the next step stops the turn and keeps the user's steering.
  assert.equal((await chain('tools/pre-execute', [{ agent: chat }], async () => ({ kind: 'allow' }))).kind, 'deny');
  const steering = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'also add a test' }], source: { kind: 'user' } };
  assert.deepEqual(await chain('agent/pre-step', [{ agent: chat, messages: [steering, { id: 'x', source: { kind: 'working-directory' } }] }], async () => ({ kind: 'enter' })), { kind: 'reject' });
  // Idle: the copy opens in the branch's project, the old chat is archived, the copy gets the note and the steering.
  await emit('agent/status', { agent: chat, status: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const wt = realpathSync(join(D, '.worktrees', 'feat-login-form'));
  const project = registry.list().find((w) => w.path === wt);
  assert.equal(project?.title, 'feat/login-form', 'the branch is a project');
  assert.equal(copies.length, 1); const { options, agent: copy } = copies[0];
  assert.equal(options.meta.cwd, join(D, '.worktrees', 'feat-login-form')); assert.equal(options.meta.parentSession, 'chat-1'); assert.equal(options.meta.isSeeded, true);
  assert.equal(options.inheritedEventCount, 2); assert.deepEqual(options.seed.at(-1), { type: 'session/end-seed', seq: 2, time: 1, data: { inherited: true } }, 'dsh\'s own fork cut');
  assert.deepEqual(project.attached, [copy.id], 'the copy is in the branch project');
  assert.deepEqual(cds, [[copy.id, join(D, '.worktrees', 'feat-login-form')]], 'the copy works in the new folder');
  assert.deepEqual(registry.archived, [{ id: 'chat-1', options: { stopActivity: true } }], 'the old chat is archived');
  assert.ok(chat.cleared, 'the old chat\'s queue is cleared (it lives in the copy)');
  assert.match(copy.injected[0].content[0].text, /feat\/login-form.*back on "main"/s, 'the hidden note');
  assert.equal(copy.injected[1], steering, 'the steering goes along');
  assert.equal(copy.steered.length, 1, 'the copy continues');
  assert.deepEqual((await call('GET', undefined, '?moved=chat-1')).data, { on: true, moved: copy.id });
  // Not clean: the chat stays and the folder stays on its new branch.
  const chat2 = fakeAgent('chat-2', D);
  await turnStart(chat2);
  git(D, 'switch', '-qc', 'feat/dirty'); writeFileSync(join(D, 'wip.txt'), 'w');
  await tool(chat2);
  assert.equal(branchOf(D), 'feat/dirty'); assert.equal((await chain('agent/pre-step', [{ agent: chat2, messages: [] }], async () => ({ kind: 'enter' }))).kind, 'enter', 'not clean: no stop');
  rmSync(join(D, 'wip.txt')); git(D, 'switch', '-q', 'main');
  // A subagent and a chat in a subfolder are never watched.
  const subChat = fakeAgent('chat-3', join(D, 'sub')); mkdirSync(join(D, 'sub'));
  await turnStart(subChat);
  git(D, 'switch', '-qc', 'feat/from-sub'); await tool(subChat);
  assert.equal(branchOf(D), 'feat/from-sub', 'a chat in a subfolder does not move the repository'); git(D, 'switch', '-q', 'main');
  // A chat whose folder is a symlink to the main folder moves (git gives the real paths); a chat below a dangling
  // symlink is not watched and fails nothing.
  symlinkSync(D, join(base, 'D-link')); symlinkSync(join(base, 'gone'), join(base, 'D-dangling'));
  const linked = fakeAgent('chat-link', join(base, 'D-link'));
  await turnStart(linked);
  git(D, 'switch', '-qc', 'feat/via-link');
  assert.deepEqual(await tool(linked), { kind: 'accept' });
  assert.equal(branchOf(D), 'main', 'a chat in a symlinked main folder moves');
  assert.equal(branchOf(join(D, '.worktrees', 'feat-via-link')), 'feat/via-link');
  await emit('agent/status', { agent: linked, status: 'idle' }); await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(copies.at(-1).options.meta.cwd, join(D, '.worktrees', 'feat-via-link'), 'the copy gets the real path');
  const dangling = fakeAgent('chat-dangling', join(base, 'D-dangling', 'x'));
  await turnStart(dangling);
  git(D, 'switch', '-qc', 'feat/dangling');
  assert.deepEqual(await tool(dangling), { kind: 'accept' }, 'a dangling folder fails nothing');
  assert.equal(branchOf(D), 'feat/dangling', 'a chat below a dangling symlink is not watched'); git(D, 'switch', '-q', 'main');
  // The sync route: a deleted branch folder leaves the tree.
  rmSync(wt, { recursive: true, force: true });
  const s = await call('POST', { sync: true });
  assert.deepEqual(s.data.removed, [wt]);
  assert.ok(!registry.list().some((w) => w.path === wt));
  for (const off of effects) off?.();
  // copyChatTo refuses on a dsh without the internal pieces.
  await assert.rejects(copyChatTo({ sessionController: {}, agents }, chat, D, project), (e) => e.status === 409);
  console.log('branch tree checks passed');
} finally { rmSync(base, { recursive: true, force: true }); }
