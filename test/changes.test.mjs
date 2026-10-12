// Runs the real index.js git logic against a temporary repository through a child_process-backed subprocess shim.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changes, fileDiff, parseNumstat, grantsStore, apply, CHANGES_PATH, DIFF_PATH, GRANTS_PATH } from '../index.js';

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
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const root = mkdtempSync(join(tmpdir(), 'cp-changes-'));
try {
  const remote = join(root, 'remote.git'); const repo = join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, repo);
  // Empty repository (no HEAD): uncommitted view lists the untracked file instead of failing.
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  let s = await changes(subprocess, repo, 'uncommitted');
  assert.equal(s.repo, true); assert.deepEqual(s.files.map((f) => [f.path, !!f.untracked]), [['a.txt', true]]);
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', '-u', 'origin', 'main');
  // Committed on the branch, staged, unstaged and untracked changes are told apart.
  writeFileSync(join(repo, 'b.txt'), 'b\n'); git(repo, 'add', 'b.txt'); git(repo, 'commit', '-q', '-m', 'b');
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n'); git(repo, 'add', 'a.txt');
  writeFileSync(join(repo, 'b.txt'), 'b\nmore\n');
  mkdirSync(join(repo, 'dir')); writeFileSync(join(repo, 'dir', 'new file.txt'), 'x\n');
  s = await changes(subprocess, repo, 'staged');
  assert.deepEqual(s.files.map((f) => [f.path, f.added, f.deleted]), [['a.txt', 2, 1]]);
  assert.equal(s.branch, 'main'); assert.equal(s.upstream, 'origin/main');
  s = await changes(subprocess, repo, 'unstaged');
  assert.deepEqual(s.files.map((f) => f.path), ['b.txt', 'dir/new file.txt']);
  s = await changes(subprocess, repo, 'uncommitted');
  assert.deepEqual(s.files.map((f) => f.path), ['a.txt', 'b.txt', 'dir/new file.txt']); assert.equal(s.total, 3);
  s = await changes(subprocess, repo, 'branch');
  assert.deepEqual(s.files.map((f) => f.path), ['a.txt', 'b.txt', 'dir/new file.txt'], 'branch = upstream merge-base vs work tree');
  // Diffs: tracked, untracked; a path git did not list is refused.
  let d = await fileDiff(subprocess, repo, 'staged', 'a.txt');
  assert.match(d.patch, /^-two$/m); assert.match(d.patch, /^\+TWO$/m);
  d = await fileDiff(subprocess, repo, 'uncommitted', 'dir/new file.txt');
  assert.match(d.patch, /^\+x$/m);
  assert.equal(await fileDiff(subprocess, repo, 'staged', 'b.txt'), undefined, 'not in this view');
  assert.equal(await fileDiff(subprocess, repo, 'uncommitted', '../../etc/passwd'), undefined, 'arbitrary paths are refused');
  // No upstream / not a repository.
  git(repo, 'checkout', '-q', '-b', 'local-only');
  s = await changes(subprocess, repo, 'branch'); assert.equal(s.noUpstream, true);
  const plain = join(root, 'plain'); mkdirSync(plain);
  assert.deepEqual(await changes(subprocess, plain, 'uncommitted'), { repo: false });
  // Renames in numstat -z.
  assert.deepEqual(parseNumstat('1\t2\tx\0' + '0\t0\t\0old\0new\0' + '-\t-\tbin\0'), [
    { path: 'x', added: 1, deleted: 2, binary: false }, { path: 'new', from: 'old', added: 0, deleted: 0, binary: false }, { path: 'bin', added: 0, deleted: 0, binary: true }]);

  // Grants persist, merge, and revoke per session.
  const file = join(root, 'g', 'grants.json'); const g = grantsStore(file);
  await Promise.all([g.grant('s1', 'tool_a'), g.grant('s1', 'tool_b'), g.grant('s2', 'tool_a'), g.grant('s1', 'tool_a')]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { s1: ['tool_a', 'tool_b'], s2: ['tool_a'] });
  await g.revoke('s1'); assert.deepEqual(await grantsStore(file).read(), { s2: ['tool_a'] });

  // Routes: only the session's own cwd is used; bad input is rejected.
  const routes = new Map();
  process.env.DSH_HOME = join(root, 'home');
  apply({ connection: { fetch: { register: (r) => routes.set(r.path, r) } }, subprocess,
    sessionQuery: { observeSession: async (id) => ({ header: { cwd: id === 'S' ? repo : undefined }, events: id === 'S' ? [{ type: 'workspace/changes', seq: 7, data: { turn: 2 } }, { type: 'turn/end', seq: 9, data: {} }] : [], [Symbol.dispose]() {} }) } });
  const call = async (path, query, init) => routes.get(path).fetch(new Request(`http://h${path}?${query}`, init));
  let r = await call(CHANGES_PATH, 'sessionId=S&mode=uncommitted'); assert.equal(r.status, 200); { const v = await r.json(); assert.equal(v.total, 3); assert.deepEqual(v.lastTurn, { seq: 7, turn: 2 }); }
  r = await call(CHANGES_PATH, 'sessionId=S&mode=evil'); assert.equal(r.status, 400);
  r = await call(CHANGES_PATH, 'sessionId=X'); assert.deepEqual(await r.json(), { repo: false });
  r = await call(DIFF_PATH, 'sessionId=S&mode=uncommitted&path=a.txt'); assert.match((await r.json()).patch, /TWO/);
  r = await call(DIFF_PATH, 'sessionId=S&mode=uncommitted&path=nope'); assert.equal(r.status, 404);
  r = await call(GRANTS_PATH, '', { method: 'POST', body: JSON.stringify({ action: 'grant', sessionId: 'S', tool: 't' }) }); assert.deepEqual(await r.json(), { S: ['t'] });
  r = await call(GRANTS_PATH, '', { method: 'POST', body: '{"action":"nuke"}' }); assert.equal(r.status, 400);
  r = await call(GRANTS_PATH, '', { method: 'GET' }); assert.deepEqual(await r.json(), { S: ['t'] });
  console.log('changes + grants host checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
