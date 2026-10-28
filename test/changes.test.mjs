// Runs the real index.js git logic against a temporary repository through a child_process-backed subprocess shim.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changes, fileDiff, parseNumstat, parseRefs, branchList, branchCommits, branchMap, branchMapOf, isBranchRef, runGit, grantsStore, apply, MAP_BRANCHES, CHANGES_PATH, DIFF_PATH, GRAPH_PATH, GRANTS_PATH } from '../index.js';

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
  // The branch map (as the owner's sketch): feature/login → develop (merged), feature/report from develop (waiting),
  // hotfix/payment → main (merged), develop → main (merged); origin/main has a local main, so it is not shown; a
  // remote-only branch is.
  {
    const map = join(root, 'map'); mkdirSync(map); let n = 0;
    const mg = (...a) => execFileSync('git', a, { cwd: map, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_AUTHOR_DATE: `2026-10-${10 + n} 10:00:00`, GIT_COMMITTER_DATE: `2026-10-${10 + n} 10:00:00` } });
    const c = (file, msg) => { writeFileSync(join(map, file), msg + '\n'); mg('add', file); mg('commit', '-qm', msg); n++; };
    mg('init', '-q', '-b', 'main'); c('README.md', 'init');
    mg('checkout', '-qb', 'develop'); c('dev.txt', 'develop work');
    mg('checkout', '-qb', 'feature/login'); c('login.ts', 'login');
    mg('checkout', '-q', 'develop'); mg('merge', '-q', '--no-ff', 'feature/login', '-m', 'Merge login'); n++;
    mg('checkout', '-qb', 'feature/report'); c('report.ts', 'report');
    mg('checkout', '-q', 'main'); mg('checkout', '-qb', 'hotfix/payment'); c('pay.ts', 'pay');
    mg('checkout', '-q', 'main'); mg('merge', '-q', '--no-ff', 'hotfix/payment', '-m', 'Merge hotfix'); n++;
    mg('merge', '-q', '--no-ff', 'develop', '-m', 'Merge develop'); n++;
    mg('checkout', '-qb', 'ff-done'); c('ff.txt', 'ff'); mg('checkout', '-q', 'main'); mg('merge', '-q', '--ff-only', 'ff-done'); // no merge commit
    mg('branch', 'fresh'); // a new branch at main's tip; main moves past it below, so it counts as a fast-forward merge
    c('after.txt', 'after'); mg('branch', 'fresh-now'); // main moved past ff-done; fresh-now is at main's tip again
    mg('update-ref', 'refs/remotes/origin/main', 'main'); mg('update-ref', 'refs/remotes/origin/spike', 'feature/report~1');
    mg('checkout', '-q', 'feature/report');
    const m = await branchMapOf(subprocess, map);
    const of = (name) => m.branches.find((b) => b.name === name);
    assert.equal(m.main, 'refs/heads/main', 'main: main (origin has no HEAD)'); assert.equal(m.partial, false); assert.equal(m.more, false);
    assert.equal(of('origin/main'), undefined, 'a remote branch with a local one is not shown'); assert.ok(of('origin/spike'), 'a remote-only branch is');
    assert.deepEqual([of('main').state, of('main').level, of('main').reached], ['main', 0, true]);
    const merged = (name) => { const b = of(name); return [b.state, b.target, b.reached, b.merge === undefined ? undefined : mg('log', '-1', '--format=%s', b.merge).trim(), b.level]; };
    assert.deepEqual(merged('develop'), ['merged', 'refs/heads/main', true, 'Merge develop', 1]);
    assert.deepEqual(merged('hotfix/payment'), ['merged', 'refs/heads/main', true, 'Merge hotfix', 1]);
    assert.deepEqual(merged('fresh'), ['merged', 'refs/heads/main', true, undefined, 1], 'main moved past it: a fast-forward, as git sees it');
    assert.deepEqual(merged('feature/login'), ['merged', 'refs/heads/develop', true, 'Merge login', 2], 'login: develop merged it first');
    assert.deepEqual(merged('feature/report'), ['waiting', 'refs/heads/develop', false, undefined, 2], 'report started from develop');
    assert.equal(of('feature/report').current, true);
    assert.deepEqual(merged('ff-done'), ['merged', 'refs/heads/main', true, undefined, 1], 'a fast-forward: on main, no merge commit');
    assert.deepEqual(merged('fresh-now'), ['waiting', 'refs/heads/main', true, undefined, 1], 'same commit as main: waiting');
    assert.deepEqual(merged('origin/spike'), ['merged', 'refs/heads/main', true, 'Merge develop', 1], 'at develop\'s tip: report only started there, main merged it');
    assert.equal(m.branches[0].name, 'feature/report', 'the list order (the current branch first) is kept');
    // Pending: the files that report brings into develop, from their merge base; a diff of one; a gone branch.
    const pending = { ref: 'refs/heads/feature/report', target: 'refs/heads/develop' };
    let p = await changes(subprocess, map, 'pending', undefined, undefined, { pending });
    assert.deepEqual([p.mode, p.files.map((x) => [x.path, x.added]), p.total], ['pending', [['report.ts', 1]], 1]);
    writeFileSync(join(map, 'loose.txt'), 'x\n'); // untracked files are not part of a branch
    p = await changes(subprocess, map, 'pending', undefined, undefined, { pending }); assert.deepEqual(p.files.map((x) => x.path), ['report.ts']);
    assert.match((await fileDiff(subprocess, map, 'pending', 'report.ts', undefined, undefined, { pending })).patch, /^\+report$/m);
    assert.equal(await fileDiff(subprocess, map, 'pending', 'pay.ts', undefined, undefined, { pending }), undefined, 'only the listed files');
    assert.equal((await changes(subprocess, map, 'pending', undefined, undefined, { pending: { ...pending, ref: 'refs/heads/gone' } })).gone, true);
    assert.equal((await changes(subprocess, map, 'pending', undefined, undefined, { pending: { ref: 'refs/heads/develop', target: 'refs/heads/main' } })).total, 0, 'merged: nothing to bring');
    for (const bad of [{ ref: 'refs/heads/feature/report~1', target: 'refs/heads/develop' }, { ref: '--output=/tmp/x', target: 'refs/heads/develop' }, { ref: 'refs/heads/develop' }]) {
      if (isBranchRef(bad.ref) && isBranchRef(bad.target)) assert.equal((await changes(subprocess, map, 'pending', undefined, undefined, { pending: bad })).gone, true, 'a revision expression is no ref');
      else await assert.rejects(changes(subprocess, map, 'pending', undefined, undefined, { pending: bad }), /two branches/);
    }
    // A file named HEAD in the project does not break the map (git gets `--` after the revisions).
    writeFileSync(join(map, 'HEAD'), 'x\n'); mg('add', 'HEAD'); mg('commit', '-qm', 'a file named HEAD'); n++;
    assert.equal((await branchMapOf(subprocess, map)).main, 'refs/heads/main', 'a file named HEAD');
    // A default branch of origin wins; then master; then the open branch.
    mg('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/spike');
    assert.equal((await branchMapOf(subprocess, map)).main, 'refs/remotes/origin/spike', "origin's default branch");
    mg('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    // More shapes, each in a new repository: siblings from an unmoved develop, a target that moved on, an octopus merge,
    // a criss-cross merge, a detached HEAD.
    const shape = async (build) => {
      const dir = mkdtempSync(join(root, 'shape-')); let k = 0;
      const sg = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
        GIT_AUTHOR_DATE: `2026-10-${10 + k} 10:00:00`, GIT_COMMITTER_DATE: `2026-10-${10 + k} 10:00:00` } });
      const sc = (file, msg) => { writeFileSync(join(dir, file), msg + '\n'); sg('add', file); sg('commit', '-qm', msg); k++; };
      sg('init', '-q', '-b', 'main'); sc('a.txt', 'init');
      build(sg, sc, () => k++);
      const v = await branchMapOf(subprocess, dir);
      return Object.fromEntries(v.branches.map((b) => [b.name, [b.state, (b.target ?? '').replace(/^refs\/heads\//, ''), !!b.merge, b.level]]));
    };
    let got = await shape((sg, sc) => { sg('checkout', '-qb', 'develop'); sc('d.txt', 'd1');
      sg('checkout', '-qb', 'feature/a'); sc('fa.txt', 'a1'); sc('fa.txt', 'a2'); sg('checkout', '-q', 'develop'); sg('checkout', '-qb', 'feature/b'); sc('fb.txt', 'b1'); sg('checkout', '-q', 'main'); });
    assert.deepEqual([got['feature/a'], got['feature/b']], [['waiting', 'develop', false, 2], ['waiting', 'develop', false, 2]], 'siblings point to develop, not to each other');
    got = await shape((sg, sc, tick) => { sg('checkout', '-qb', 'develop'); sc('d.txt', 'd1'); sg('checkout', '-qb', 'feature/a'); sc('fa.txt', 'a1');
      sg('checkout', '-q', 'develop'); sg('merge', '-q', '--no-ff', 'feature/a', '-m', 'M'); tick(); sg('checkout', '-qb', 'feature/b'); sc('fb.txt', 'b1');
      sg('checkout', '-q', 'develop'); sc('d.txt', 'd2'); sg('checkout', '-q', 'main'); });
    assert.deepEqual(got['feature/a'], ['merged', 'develop', true, 2], 'develop merged it, although feature/b started from that merge');
    assert.deepEqual([got.develop, got['feature/b']], [['waiting', 'main', false, 1], ['waiting', 'develop', false, 2]], 'develop took a branch: it never starts from feature/b');
    got = await shape((sg, sc, tick) => { sg('checkout', '-qb', 'x'); sc('x.txt', 'x'); sg('checkout', '-q', 'main'); sg('checkout', '-qb', 'y'); sc('y.txt', 'y');
      sg('checkout', '-q', 'main'); sg('merge', '-q', '--no-ff', 'x', 'y', '-m', 'octopus'); tick(); });
    assert.deepEqual([got.x, got.y], [['merged', 'main', true, 1], ['merged', 'main', true, 1]], 'an octopus merge takes both');
    got = await shape((sg, sc, tick) => { sg('checkout', '-qb', 'b'); sc('b.txt', 'b1'); sg('checkout', '-q', 'main'); sc('m.txt', 'm1');
      sg('merge', '-q', '--no-ff', 'b', '-m', 'main takes b'); tick(); sg('checkout', '-q', 'b'); sg('merge', '-q', '--no-ff', 'main~1', '-m', 'b takes main'); tick(); sc('b2.txt', 'b2'); sg('checkout', '-q', 'main'); });
    assert.deepEqual(got.b, ['waiting', 'main', false, 1], 'criss-cross: b has new work, no cycle');
    got = await shape((sg, sc) => { sc('b.txt', 'two'); sg('checkout', '-q', '--detach', 'HEAD~1'); });
    assert.deepEqual(got.HEAD, ['merged', 'main', false, 1], 'a detached HEAD behind main');
    // Pure rules: a cut list keeps the main branch; a tip older than the commits read waits, with no arrow; no cycles.
    const ids = (k) => k.toString(16).padStart(40, '0');
    const recs = [{ sha: ids(3), parents: [ids(1)] }, { sha: ids(2), parents: [ids(1)] }, { sha: ids(1), parents: [] }];
    const list = Array.from({ length: MAP_BRANCHES + 5 }, (_, k) => ({ ref: `refs/heads/b${k}`, name: `b${k}`, kind: 'local', sha: ids(2), time: 0, author: '', subject: '' }));
    list.push({ ref: 'refs/heads/main', name: 'main', kind: 'local', sha: ids(3), time: 0, author: '', subject: '' }, { ref: 'refs/heads/old', name: 'old', kind: 'local', sha: ids(9), time: 0, author: '', subject: '' });
    const cut = branchMap(list, recs, 'refs/heads/main');
    assert.equal(cut.branches.length, MAP_BRANCHES); assert.equal(cut.more, true); assert.equal(cut.branches.at(-1).ref, 'refs/heads/main', 'main stays');
    assert.ok(cut.branches.slice(0, -1).every((b) => b.state === 'waiting' && b.target === 'refs/heads/main' && b.level === 1), 'same tip: no branch took another');
    // A merge whose first parent is older than the commits read: the line ends there, the merge is still a merge.
    const edge = branchMap([{ ref: 'refs/heads/main', name: 'main', kind: 'local', sha: ids(5) }, { ref: 'refs/heads/f', name: 'f', kind: 'local', sha: ids(4) }],
      [{ sha: ids(5), parents: [ids(99), ids(4)] }, { sha: ids(4), parents: [ids(98)] }], 'refs/heads/main', true).branches[1];
    assert.deepEqual([edge.state, edge.target, edge.merge], ['merged', 'refs/heads/main', ids(5)]);
    const old = branchMap(list.slice(-2), recs, 'refs/heads/main', true).branches.find((b) => b.name === 'old');
    assert.deepEqual([old.state, old.target, old.reached, old.level], ['waiting', undefined, false, 1]);
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
  { const v = await r.json(); assert.deepEqual(v.branches.map((b) => [b.name, b.state]), [['local-only', 'waiting'], ['main', 'main']], 'the map; origin/main has a local main');
    assert.equal(v.main, 'refs/heads/main'); assert.equal(v.branch, 'local-only'); assert.deepEqual(v.lastTurn, { seq: 7, turn: 2 }); }
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
  // Pending: two branch refs, nothing else; a gone branch is 404.
  r = await call(CHANGES_PATH, 'sessionId=S&mode=pending&ref=refs%2Fheads%2Fmain&target=refs%2Fremotes%2Forigin%2Fmain'); assert.equal(r.status, 200);
  { const v = await r.json(); assert.equal(v.mode, 'pending'); assert.deepEqual(v.files.map((x) => x.path), ['b.txt']); assert.deepEqual(v.lastTurn, { seq: 7, turn: 2 }); }
  r = await call(DIFF_PATH, 'sessionId=S&mode=pending&ref=refs%2Fheads%2Fmain&target=refs%2Fremotes%2Forigin%2Fmain&path=b.txt'); assert.match((await r.json()).patch, /^\+b$/m);
  r = await call(CHANGES_PATH, 'sessionId=S&mode=pending&ref=refs%2Fheads%2Fgone&target=refs%2Fheads%2Fmain'); assert.equal(r.status, 404, 'a gone branch');
  for (const bad of ['', '&ref=refs%2Fheads%2Fmain', '&ref=main&target=refs%2Fheads%2Fmain', '&ref=--output%3Dx&target=refs%2Fheads%2Fmain', `&ref=refs%2Fheads%2Fmain&target=refs%2Fheads%2Fmain&commit=${tip}`]) {
    r = await call(CHANGES_PATH, `sessionId=S&mode=pending${bad}`); assert.equal(r.status, 400, `pending refuses "${bad}"`);
  }
  r = await call(CHANGES_PATH, 'sessionId=S&mode=uncommitted&ref=refs%2Fheads%2Fmain'); assert.equal(r.status, 400, 'a ref only goes with pending mode');
  r = await call(CHANGES_PATH, 'sessionId=S&mode=uncommitted&ws=1'); assert.equal(r.status, 200, 'ws=1 hides whitespace');
  for (const bad of ['ws=2', 'ws=', 'ws=true']) { r = await call(CHANGES_PATH, `sessionId=S&mode=uncommitted&${bad}`); assert.equal(r.status, 400, `refuses ${bad}`); }
  r = await call(DIFF_PATH, 'sessionId=S&mode=uncommitted&path=a.txt&ws=1'); assert.match((await r.json()).patch, /TWO/);
  r = await call(CHANGES_PATH, `sessionId=T&mode=commit&commit=${'f'.repeat(40)}`); assert.equal(r.status, 500, 'unknown commit');
  r = await call(GRANTS_PATH, '', { method: 'POST', body: JSON.stringify({ action: 'grant', sessionId: 'S', tool: 't' }) }); assert.deepEqual(await r.json(), { S: ['t'] });
  r = await call(GRANTS_PATH, '', { method: 'POST', body: '{"action":"nuke"}' }); assert.equal(r.status, 400);
  r = await call(GRANTS_PATH, '', { method: 'GET' }); assert.deepEqual(await r.json(), { S: ['t'] });
  console.log('changes + grants host checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
