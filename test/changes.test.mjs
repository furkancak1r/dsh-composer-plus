// Runs the real index.js git logic against a temporary repository through a child_process-backed subprocess shim.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changes, fileDiff, parseNumstat, parseRefs, branchList, branchCommits, isBranchRef, runGit, grantsStore, apply, CHANGES_PATH, DIFF_PATH, GRAPH_PATH, GRANTS_PATH } from '../index.js';

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
  { const g = await branchList(subprocess, repo); assert.equal(g.repo, true); assert.deepEqual(g.branches, [], 'no commits: no branches, not an error'); assert.equal(g.head, undefined); }
  assert.equal(await branchCommits(subprocess, repo, 'HEAD'), undefined, 'no commits: no HEAD to read');
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
  // Branch tree, in its own clone: init (pushed) → b → main work → Merge side (+ side work) → rename b, a tag.
  const tree = join(root, 'tree'); git(root, 'clone', '-q', remote, tree);
  const sha = (ref) => git(tree, 'rev-parse', ref).trim();
  writeFileSync(join(tree, 'b.txt'), 'b\n'); git(tree, 'add', 'b.txt'); git(tree, 'commit', '-q', '-m', 'b');
  git(tree, 'checkout', '-q', '-b', 'side'); writeFileSync(join(tree, 's.txt'), 's1\ns2\n'); git(tree, 'add', 's.txt'); git(tree, 'commit', '-q', '-m', 'side work');
  git(tree, 'checkout', '-q', 'main'); writeFileSync(join(tree, 'b.txt'), 'b\nmain\n'); git(tree, 'commit', '-q', '-am', 'main work');
  git(tree, 'merge', '-q', '--no-ff', 'side', '-m', 'Merge side'); git(tree, 'tag', 'v1');
  git(tree, 'mv', 'b.txt', 'c.txt'); git(tree, 'commit', '-q', '-m', 'rename b');
  writeFileSync(join(tree, 'loose.txt'), 'x\n'); git(tree, 'stash', '-q', '-u'); // a stash is not a branch: not in the tree
  writeFileSync(join(tree, 'loose.txt'), 'x\n');
  // The branch list: the current branch first, then the other local branches, then remote ones; origin/HEAD and the stash
  // are left out. Each has its last commit.
  let bl = await branchList(subprocess, tree);
  assert.deepEqual(bl.branches.map((b) => [b.name, b.kind, b.ref, !!b.current]), [['main', 'local', 'refs/heads/main', true], ['side', 'local', 'refs/heads/side', false], ['origin/main', 'remote', 'refs/remotes/origin/main', false]]);
  assert.deepEqual(bl.branches.map((b) => [b.sha, b.subject]), [[sha('main'), 'rename b'], [sha('side'), 'side work'], [sha('origin/main'), 'init']]);
  assert.equal(bl.branches[0].author, 't'); assert.ok(bl.branches[0].time > 1e9);
  assert.equal(bl.head, sha('HEAD')); assert.equal(bl.branch, 'main'); assert.equal(bl.upstream, 'origin/main'); assert.equal(bl.more, false);
  assert.equal('commits' in bl, false, 'the list has no commits');
  bl = await branchList(subprocess, tree, undefined, 2); assert.equal(bl.branches.length, 2); assert.equal(bl.more, true, 'the list is cut');
  // One branch: its first-parent line, newest first (a merge stands for what it brought in), with its tags.
  let gr = await branchCommits(subprocess, tree, 'refs/heads/main');
  assert.deepEqual(gr.commits.map((c) => c.subject), ['rename b', 'Merge side', 'main work', 'b', 'init'], 'the side commit is not on main\'s line');
  assert.equal(gr.ref, 'refs/heads/main'); assert.equal(gr.head, sha('HEAD')); assert.equal(gr.more, false);
  assert.deepEqual(gr.commits[0].refs, [{ name: 'main', kind: 'local', current: true }]);
  assert.deepEqual(gr.commits[1].refs, [{ name: 'v1', kind: 'tag' }]);
  assert.deepEqual(gr.commits[4].refs, [{ name: 'origin/main', kind: 'remote' }], 'remote branch; origin/HEAD is left out');
  assert.equal(gr.commits[4].author, 't'); assert.ok(gr.commits[4].time > 1e9);
  gr = await branchCommits(subprocess, tree, 'refs/heads/side');
  assert.deepEqual(gr.commits.map((c) => c.subject), ['side work', 'b', 'init']);
  gr = await branchCommits(subprocess, tree, 'refs/remotes/origin/main'); assert.deepEqual(gr.commits.map((c) => c.subject), ['init']);
  gr = await branchCommits(subprocess, tree, 'refs/heads/main', undefined, 2); assert.equal(gr.commits.length, 2); assert.equal(gr.more, true, 'older commits are cut');
  assert.equal(await branchCommits(subprocess, tree, 'refs/heads/gone'), undefined, 'a deleted branch');
  // Only a full branch name or HEAD reaches git: never an option, a revision expression or a tag.
  for (const bad of ['main', '--output=/tmp/x', 'refs/heads/main~1', 'refs/tags/v1', 'refs/heads/', 'HEAD~1', `refs/heads/a\0b`, '']) {
    assert.equal(isBranchRef(bad), bad === 'refs/heads/main~1', `isBranchRef ${JSON.stringify(bad)}`);
    if (bad === 'refs/heads/main~1') assert.equal(await branchCommits(subprocess, tree, bad), undefined, 'a revision expression is no ref');
    else await assert.rejects(branchCommits(subprocess, tree, bad), /not a branch/);
  }
  // Commit mode: one commit's files against its first parent (root, merge, rename); untracked files never show.
  s = await changes(subprocess, tree, 'commit', undefined, sha('HEAD~4'));
  assert.deepEqual(s.files.map((f) => [f.path, f.added, f.deleted]), [['a.txt', 2, 0]], 'root commit: its files'); assert.equal(s.commit, sha('HEAD~4'));
  s = await changes(subprocess, tree, 'commit', undefined, sha('HEAD~1'));
  assert.deepEqual(s.files.map((f) => [f.path, f.added]), [['s.txt', 2]], 'merge: what the side branch brought in');
  s = await changes(subprocess, tree, 'commit', undefined, sha('HEAD'));
  assert.deepEqual(s.files.map((f) => [f.from, f.path]), [['b.txt', 'c.txt']]);
  d = await fileDiff(subprocess, tree, 'commit', 'c.txt', undefined, sha('HEAD')); assert.match(d.patch, /^rename from b\.txt$/m);
  d = await fileDiff(subprocess, tree, 'commit', 's.txt', undefined, sha('side')); assert.match(d.patch, /^\+s2$/m);
  assert.equal(await fileDiff(subprocess, tree, 'commit', 'loose.txt', undefined, sha('HEAD')), undefined, 'untracked is not part of a commit');
  await assert.rejects(changes(subprocess, tree, 'commit', undefined, '--output=/tmp/x'), /full commit id/, 'never an option');
  await assert.rejects(changes(subprocess, tree, 'commit', undefined, 'f'.repeat(40)), /git diff failed/, 'unknown commit');
  await assert.rejects(changes(subprocess, tree, 'commit', undefined, sha('HEAD:c.txt')), /expected commit type/, 'a blob id never prints its content');
  // A \x1f in a subject stays in the subject; cut-off output drops its broken last record.
  writeFileSync(join(tree, 'sep.txt'), 'x\n'); git(tree, 'add', 'sep.txt'); git(tree, 'commit', '-q', '-m', 'odd\x1fsubject');
  gr = await branchCommits(subprocess, tree, 'HEAD');
  assert.equal((await branchList(subprocess, tree)).branches[0].subject, 'odd\x1fsubject', 'the list keeps it too');
  assert.equal(gr.commits[0].subject, 'odd\x1fsubject'); assert.ok(gr.commits[0].time > 1e9); assert.deepEqual(gr.commits[0].refs, [{ name: 'main', kind: 'local', current: true }]);
  {
    const full = await runGit(subprocess, tree, ['log', '--first-parent', '-z', '--format=%H%x1f%ct%x1f%an%x1f%D%x1f%s', 'main']);
    const cut = { ...subprocess, spawn: (spec) => {
      const h = subprocess.spawn(spec);
      if (!spec.argv.includes('log')) return h;
      return { done: h.done, collected: { stdout: { readFrom: () => ({ text: full.stdout.slice(0, full.stdout.indexOf('\0') + 1 + 41 + 20), lossy: true }) }, stderr: h.collected.stderr } };
    } };
    gr = await branchCommits(cut, tree, 'refs/heads/main');
    assert.equal(gr.commits.length, 1, 'only the whole record'); assert.equal(gr.more, true);
  }
  git(tree, 'reset', '-q', '--hard', 'HEAD~1');
  // %D parsing: detached HEAD, current branch, tags, remotes; <remote>/HEAD and other refs are dropped.
  assert.deepEqual(parseRefs('HEAD, refs/remotes/origin/main'), [{ name: 'HEAD', kind: 'head' }, { name: 'origin/main', kind: 'remote' }]);
  assert.deepEqual(parseRefs('HEAD -> refs/heads/feat/x, tag: refs/tags/v2, refs/remotes/up/HEAD, refs/stash, refs/remotes/up/feat/x'),
    [{ name: 'feat/x', kind: 'local', current: true }, { name: 'v2', kind: 'tag' }, { name: 'up/feat/x', kind: 'remote' }]);
  assert.deepEqual(parseRefs(''), []);
  // Detached HEAD on an older commit: HEAD leads the list (it is where the work tree is), every branch stays.
  git(tree, 'checkout', '-q', '--detach', 'HEAD~2');
  bl = await branchList(subprocess, tree);
  assert.deepEqual(bl.branches.map((b) => [b.name, b.kind, !!b.current]), [['HEAD', 'head', true], ['main', 'local', false], ['side', 'local', false], ['origin/main', 'remote', false]]);
  assert.deepEqual([bl.branches[0].ref, bl.branches[0].sha, bl.branches[0].subject, bl.branches[0].author], ['HEAD', sha('HEAD'), 'main work', 't']);
  gr = await branchCommits(subprocess, tree, 'HEAD'); assert.deepEqual(gr.commits.map((c) => c.subject), ['main work', 'b', 'init']);
  assert.deepEqual(gr.commits[0].refs, [{ name: 'HEAD', kind: 'head' }]);
  git(tree, 'checkout', '-q', 'main');
  // No upstream / not a repository.
  git(repo, 'checkout', '-q', '-b', 'local-only');
  s = await changes(subprocess, repo, 'branch'); assert.equal(s.noUpstream, true);
  const plain = join(root, 'plain'); mkdirSync(plain);
  assert.deepEqual(await changes(subprocess, plain, 'uncommitted'), { repo: false });
  assert.deepEqual(await branchList(subprocess, plain), { repo: false });
  assert.deepEqual(await branchCommits(subprocess, plain, 'HEAD'), { repo: false });
  // Hide whitespace (`-w`): a file whose lines differ only in indentation or CRLF leaves the list and its diff; a real
  // change stays. In commit mode too.
  {
    const wsRepo = join(root, 'ws'); mkdirSync(wsRepo); git(wsRepo, 'init', '-q', '-b', 'main');
    writeFileSync(join(wsRepo, 'indent.js'), 'if (a) {\nb();\n}\n'); writeFileSync(join(wsRepo, 'real.js'), 'x\ny\n');
    git(wsRepo, 'add', '.'); git(wsRepo, 'commit', '-q', '-m', 'init');
    writeFileSync(join(wsRepo, 'indent.js'), 'if (a) {\r\n    b();\r\n}\r\n'); writeFileSync(join(wsRepo, 'real.js'), 'x\nY\n');
    let w = await changes(subprocess, wsRepo, 'uncommitted');
    assert.deepEqual(w.files.map((f) => f.path), ['indent.js', 'real.js'], 'without -w both show');
    w = await changes(subprocess, wsRepo, 'uncommitted', undefined, undefined, { ws: true });
    assert.deepEqual(w.files.map((f) => f.path), ['real.js'], 'with -w the indentation/CRLF-only file is gone');
    assert.equal(await fileDiff(subprocess, wsRepo, 'uncommitted', 'indent.js', undefined, undefined, { ws: true }), undefined, 'not listed, so no diff');
    writeFileSync(join(wsRepo, 'real.js'), 'x\n  Y\n');
    const d2 = await fileDiff(subprocess, wsRepo, 'uncommitted', 'real.js', undefined, undefined, { ws: true });
    assert.match(d2.patch, /^\+ {2}Y$/m); assert.match(d2.patch, /^-y$/m);
    git(wsRepo, 'commit', '-q', '-am', 'mixed');
    const head = git(wsRepo, 'rev-parse', 'HEAD').trim();
    w = await changes(subprocess, wsRepo, 'commit', undefined, head, { ws: true });
    assert.deepEqual(w.files.map((f) => f.path), ['real.js'], 'commit mode honors -w');
    w = await changes(subprocess, wsRepo, 'commit', undefined, head);
    assert.deepEqual(w.files.map((f) => f.path), ['indent.js', 'real.js']);
    // `paths` limits the list (chat mode passes the chat's own files); an empty list is an empty view.
    writeFileSync(join(wsRepo, 'real.js'), 'z\n'); writeFileSync(join(wsRepo, 'other.js'), 'o\n');
    w = await changes(subprocess, wsRepo, 'uncommitted', undefined, undefined, { paths: [':(literal)other.js'] });
    assert.deepEqual(w.files.map((f) => [f.path, !!f.untracked]), [['other.js', true]]);
    w = await changes(subprocess, wsRepo, 'uncommitted', undefined, undefined, { paths: [] });
    assert.deepEqual([w.repo, w.total], [true, 0]);
  }
  // Renames in numstat -z.
  assert.deepEqual(parseNumstat('1\t2\tx\0' + '0\t0\t\0old\0new\0' + '-\t-\tbin\0'), [
    { path: 'x', added: 1, deleted: 2, binary: false }, { path: 'new', from: 'old', added: 0, deleted: 0, binary: false }, { path: 'bin', added: 0, deleted: 0, binary: true }]);

  // Grants persist, merge, and revoke per session (time limits: test/grant-ttl.test.mjs).
  const file = join(root, 'g', 'chat-grants.json'); const g = grantsStore(file);
  await Promise.all([g.grant('s1', 'tool_a'), g.grant('s1', 'tool_b'), g.grant('s2', 'tool_a'), g.grant('s1', 'tool_a')]);
  assert.deepEqual(g.names(await g.read()), { s1: ['tool_a', 'tool_b'], s2: ['tool_a'] });
  await g.revoke('s1'); const g2 = grantsStore(file); assert.deepEqual(g2.names(await g2.read()), { s2: ['tool_a'] });

  // Routes: only the session's own cwd is used; bad input is rejected.
  const routes = new Map();
  process.env.DSH_HOME = join(root, 'home');
  apply({on:()=>{},connection: { fetch: { register: (r) => routes.set(r.path, r) } }, subprocess,
    sessionQuery: { observeSession: async (id) => ({ header: { cwd: id === 'S' ? repo : id === 'T' ? tree : undefined }, events: id === 'S' ? [{ type: 'workspace/changes', seq: 7, data: { turn: 2 } }, { type: 'turn/end', seq: 9, data: {} }] : [], [Symbol.dispose]() {} }) } });
  const call = async (path, query, init) => routes.get(path).fetch(new Request(`http://h${path}?${query}`, init));
  let r = await call(CHANGES_PATH, 'sessionId=S&mode=uncommitted'); assert.equal(r.status, 200); { const v = await r.json(); assert.equal(v.total, 3); assert.deepEqual(v.lastTurn, { seq: 7, turn: 2 }); }
  r = await call(CHANGES_PATH, 'sessionId=S&mode=evil'); assert.equal(r.status, 400);
  r = await call(CHANGES_PATH, 'sessionId=X'); assert.deepEqual(await r.json(), { repo: false });
  r = await call(DIFF_PATH, 'sessionId=S&mode=uncommitted&path=a.txt'); assert.match((await r.json()).patch, /TWO/);
  r = await call(DIFF_PATH, 'sessionId=S&mode=uncommitted&path=nope'); assert.equal(r.status, 404);
  r = await call(GRAPH_PATH, 'sessionId=S'); assert.equal(r.status, 200);
  { const v = await r.json(); assert.deepEqual(v.branches.map((b) => b.name), ['local-only', 'main', 'origin/main']); assert.equal(v.branch, 'local-only'); assert.deepEqual(v.lastTurn, { seq: 7, turn: 2 }); }
  r = await call(GRAPH_PATH, 'sessionId=S&ref=refs%2Fheads%2Flocal-only'); assert.equal(r.status, 200);
  { const v = await r.json(); assert.deepEqual(v.commits.map((c) => c.subject), ['b', 'init']); assert.equal(v.ref, 'refs/heads/local-only'); assert.deepEqual(v.lastTurn, { seq: 7, turn: 2 }); }
  r = await call(GRAPH_PATH, 'sessionId=T&ref=HEAD'); assert.equal((await r.json()).commits.length, 5);
  r = await call(GRAPH_PATH, 'sessionId=T&ref=refs%2Fheads%2Fnope'); assert.equal(r.status, 404, 'a branch that is gone');
  for (const bad of ['main', '--output%3D%2Ftmp%2Fx', 'refs%2Ftags%2Fv1', '']) { r = await call(GRAPH_PATH, `sessionId=T&ref=${bad}`); assert.equal(r.status, 400, `ref "${bad}"`); }
  r = await call(GRAPH_PATH, 'sessionId=X'); assert.deepEqual(await r.json(), { repo: false });
  r = await call(GRAPH_PATH, 'sessionId=X&ref=HEAD'); assert.deepEqual(await r.json(), { repo: false });
  r = await call(GRAPH_PATH, ''); assert.equal(r.status, 400);
  const tip = sha('HEAD');
  r = await call(CHANGES_PATH, `sessionId=T&mode=commit&commit=${tip}`); assert.deepEqual((await r.json()).files.map((f) => f.path), ['c.txt']);
  r = await call(DIFF_PATH, `sessionId=T&mode=commit&commit=${tip}&path=c.txt`); assert.match((await r.json()).patch, /rename to c\.txt/);
  for (const bad of ['', '&commit=HEAD', '&commit=--output%3D%2Ftmp%2Fx', `&commit=${tip.toUpperCase()}`, `&commit=${tip.slice(1)}`]) {
    r = await call(CHANGES_PATH, `sessionId=T&mode=commit${bad}`); assert.equal(r.status, 400, `commit mode refuses "${bad}"`);
  }
  r = await call(CHANGES_PATH, `sessionId=T&mode=staged&commit=${tip}`); assert.equal(r.status, 400, 'a commit only goes with commit mode');
  r = await call(CHANGES_PATH, 'sessionId=S&mode=uncommitted&ws=1'); assert.equal(r.status, 200, 'ws=1 hides whitespace');
  for (const bad of ['ws=2', 'ws=', 'ws=true']) { r = await call(CHANGES_PATH, `sessionId=S&mode=uncommitted&${bad}`); assert.equal(r.status, 400, `refuses ${bad}`); }
  r = await call(DIFF_PATH, 'sessionId=S&mode=uncommitted&path=a.txt&ws=1'); assert.match((await r.json()).patch, /TWO/);
  r = await call(CHANGES_PATH, `sessionId=T&mode=commit&commit=${'f'.repeat(40)}`); assert.equal(r.status, 500, 'unknown commit');
  r = await call(GRANTS_PATH, '', { method: 'POST', body: JSON.stringify({ action: 'grant', sessionId: 'S', tool: 't' }) }); assert.deepEqual(await r.json(), { S: ['t'] });
  r = await call(GRANTS_PATH, '', { method: 'POST', body: '{"action":"nuke"}' }); assert.equal(r.status, 400);
  r = await call(GRANTS_PATH, '', { method: 'GET' }); assert.deepEqual(await r.json(), { S: ['t'] });
  console.log('changes + grants host checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
