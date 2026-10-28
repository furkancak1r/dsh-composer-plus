// Branch badge (Host half + client): at each turn start and end of a top-level chat the Host reads the git branch of the
// chat's folder and keeps it (owner-only file, newest BRANCHES_MAX); a detached HEAD shows its short id, a folder that is
// not a repository has no entry, a subagent chat is skipped, edges during a read read again once; the switch (on by
// default) stops it and the route answers nothing then. The client badge shows the branch on each chat row and removes
// its hosts when it unmounts.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBranches, branchOf, BRANCHES_PATH, BRANCHES_MAX } from '../index.js';

let spawned = 0;
const subprocess = {
  resolveExecutable: async () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
  spawn({ argv, cwd, env, stdio, signal }) {
    spawned += 1;
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    if (stdio?.stdin?.data !== undefined) child.stdin.end(stdio.stdin.data); else child.stdin.end();
    return { done: new Promise((resolve) => child.on('close', (code) => resolve({ exitCode: code, signal: null }))),
      collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err }) } } };
  },
};
const git = (cwd, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-branch-')));
try {
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'sub'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', repo);
  const plain = join(root, 'plain'); mkdirSync(plain);
  // branchOf: a new repository (no commit) still has its branch name; a commit, a new branch, a detached HEAD, no repo.
  assert.equal(await branchOf(subprocess, repo), 'main', 'before the first commit');
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'one');
  git(repo, 'switch', '-qc', 'feature/x');
  assert.equal(await branchOf(subprocess, join(repo, 'sub')), 'feature/x', 'a subfolder');
  const head = git(repo, 'rev-parse', '--short', 'HEAD').trim();
  git(repo, 'switch', '-q', '--detach');
  assert.equal(await branchOf(subprocess, repo), `(${head})`, 'a detached HEAD');
  git(repo, 'switch', '-q', 'feature/x');
  assert.equal(await branchOf(subprocess, plain), undefined, 'not a repository');

  // installBranches with a fake ctx: turn edges record the branch; the route reads it; the switch stops it.
  const home = join(root, 'home');
  const handlers = []; const routes = new Map();
  const ctx = { subprocess, on: (name, fn) => { if (name === 'session/event') handlers.push(fn); }, connection: { fetch: { register: (r) => routes.set(r.path, r) } } };
  const branches = installBranches(ctx, home);
  const route = routes.get(BRANCHES_PATH); assert.deepEqual(route.methods, ['GET', 'POST']);
  const get = async () => (await route.fetch(new Request(`http://h${BRANCHES_PATH}`))).json();
  const post = async (body) => { const r = await route.fetch(new Request(`http://h${BRANCHES_PATH}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  const session = (id, cwd, header = {}) => ({ id, header: { cwd, ...header } });
  const emit = (s, type) => { for (const fn of handlers) fn(s, { type, seq: 1 }); };
  assert.deepEqual(await get(), { on: true, branches: {} }, 'on by default, nothing yet');
  emit(session('chat-a', repo), 'turn/start');
  emit(session('chat-b', join(repo, 'sub')), 'turn/end');
  emit(session('chat-p', plain), 'turn/end');
  emit(session('chat-sub', repo, { origin: 'subagent' }), 'turn/end');
  emit(session('chat-a', repo), 'user/message'); // not a turn edge
  await branches.settled();
  assert.deepEqual(await get(), { on: true, branches: { 'chat-a': 'feature/x', 'chat-b': 'feature/x' } }, 'turn edges of top-level chats in a repository');
  const file = join(home, 'storages', 'dsh-composer-plus', 'session-branches.json');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'owner-only file');
  // The branch changes; the next turn edge records it. Several edges during one read make one more read, not many.
  git(repo, 'switch', '-q', 'main');
  spawned = 0;
  for (let i = 0; i < 5; i++) emit(session('chat-a', repo), i % 2 ? 'turn/end' : 'turn/start');
  await branches.settled();
  assert.equal((await get()).branches['chat-a'], 'main');
  assert.ok(spawned <= 2, `edges during a read are merged (${spawned} git runs)`);
  // The folder stops being a repository: the entry goes.
  rmSync(join(repo, '.git'), { recursive: true, force: true });
  emit(session('chat-b', join(repo, 'sub')), 'turn/end'); await branches.settled();
  assert.equal((await get()).branches['chat-b'], undefined, 'no repository, no badge');
  // The switch: bad bodies, off (no reads, no answer), on again.
  for (const bad of ['{', {}, { on: 'no' }]) assert.equal((await post(bad)).status, 400);
  assert.deepEqual((await post({ on: false })).body, { on: false, branches: {} });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'storages', 'dsh-composer-plus', 'branches.json'), 'utf8')), { on: false });
  spawned = 0; emit(session('chat-c', plain), 'turn/start'); await branches.settled(); assert.equal(spawned, 0, 'off: no git runs');
  assert.deepEqual((await post({ on: true })).body.on, true);
  assert.equal((await get()).branches['chat-a'], 'main', 'kept while off');
  // A restart keeps the switch; a broken file reads as no branches.
  const routes2 = new Map(); installBranches({ ...ctx, connection: { fetch: { register: (r) => routes2.set(r.path, r) } } }, home);
  assert.equal((await (await routes2.get(BRANCHES_PATH).fetch(new Request(`http://h${BRANCHES_PATH}`))).json()).on, true);
  writeFileSync(file, '{broken'); assert.deepEqual(await get(), { on: true, branches: {} });
  assert.ok(BRANCHES_MAX >= 1000);
  // The client: newest read wins, an off Host gives no badges; the pill goes into each chat row that has a branch.
  {
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
    const hook = '    function ProjectStatusMarkers({';
    let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
    const portals = [];
    // A tiny sidebar: two session rows and one project row; rows hold the hosts that useRowHosts adds.
    const mkRow = (key) => { const row = { key, children: [], getAttribute: () => key, insertBefore: (h) => { row.children.push(h); h.parent = row; }, querySelector: () => row.children.find((h) => h.attrs?.[0] !== undefined) ?? null }; return row; };
    const rows = [mkRow('session:s1'), mkRow('session:s2'), mkRow('workspace:w1')];
    globalThis.document = {
      querySelectorAll: (sel) => { if (sel.startsWith('[data-row-key^="session:"]')) return rows.filter((r) => r.key.startsWith('session:')); if (sel.startsWith('[data-composer-plus-branch-badge]')) return rows.flatMap((r) => r.children); return []; },
      createElement: () => ({ attrs: [], style: {}, setAttribute(k) { this.attrs.push(k); }, remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }, get isConnected() { return this.parent.children.includes(this); } }),
      body: {},
    };
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
    let slots = []; let at = 0; let effects = [];
    const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
      useState: (v) => { const k = at++; if (!(k in slots)) slots[k] = typeof v === 'function' ? v() : v; return [slots[k], (x) => { slots[k] = typeof x === 'function' ? x(slots[k]) : x; }]; },
      useRef: (v) => { const k = at++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
      useEffect: (f) => { at++; effects.push(f); }, useLayoutEffect: (f) => { at++; effects.push(f); },
      useSyncExternalStore: (sub, get) => get() };
    eval(src.replace(hook, '    globalThis.__br = { createBranches, SessionBranchBadges };\n' + hook));
    mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host, key) => { portals.push({ el, host, key }); return { portal: key }; } } : {}));
    const { createBranches, SessionBranchBadges } = globalThis.__br;
    // Newest read wins.
    let answers = [];
    const store = createBranches(() => new Promise((resolve) => answers.push(resolve)));
    const ok = (body) => ({ ok: true, json: async () => body });
    const older = store.load(); const newer = store.load();
    answers[1](ok({ on: true, branches: { s1: 'main' } })); await newer;
    answers[0](ok({ on: true, branches: { s1: 'stale' } })); await older;
    assert.deepEqual(store.getSnapshot(), { s1: 'main' }, 'an older read never replaces a newer list');
    answers = []; const off = store.load(); answers[0](ok({ on: false, branches: { s1: 'x' } })); await off;
    assert.deepEqual(store.getSnapshot(), {}, 'switched off on the Host: no badges');
    answers = []; const again = store.load(); answers[0](ok({ on: true, branches: { s1: 'feature/x', s2: '(abc1234)' } })); await again;
    // The component (only when react-dom's createPortal exists in this test runtime).
    {
      slots = []; at = 0; effects = []; portals.length = 0;
      SessionBranchBadges({ branches: store, useSessionStatus: () => new Map(), t: (k, v) => `${k}:${v.branch}` });
      const cleanups = effects.map((f) => f()); slots.forEach(() => {});
      at = 0; effects = []; portals.length = 0;
      SessionBranchBadges({ branches: store, useSessionStatus: () => new Map(), t: (k, v) => `${k}:${v.branch}` });
      assert.deepEqual(portals.map((x) => [x.key, x.el.c[0], x.el.p.title]), [['s1', 'feature/x', 'branch.badge:feature/x'], ['s2', '(abc1234)', 'branch.badge:(abc1234)']], 'one pill per chat row with a branch');
      assert.equal(rows[2].children.length, 0, 'no host on project rows');
      for (const c of cleanups) if (typeof c === 'function') c();
      assert.equal(rows[0].children.length + rows[1].children.length, 0, 'unmount removes the hosts');
    }
  }
  console.log('session branch checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
