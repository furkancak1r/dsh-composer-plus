// scripts/live-copy-check.mjs: MATCH when the live copy equals one commit of main (live client.js line 12 is the live id),
// MIXED when the files come from different commits, and the live folder is never written. Temporary repo and live folder.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/live-copy-check.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'cp-live-check-'));
try {
  const repo = join(root, 'repo');
  const live = join(root, 'live');
  mkdirSync(repo); mkdirSync(live);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const client = (n) => ['// c', ...Array.from({ length: 10 }, (_, i) => `// line ${i + 2}`), "  id: 'dsh-composer-plus',", `const n = ${n};`, ''].join('\n');
  const commit = (n, subject) => {
    writeFileSync(join(repo, 'client.js'), client(n));
    writeFileSync(join(repo, 'index.js'), `export const n = ${n};\n`);
    writeFileSync(join(repo, 'backup.mjs'), `export const b = ${n};\n`);
    git('add', '.'); git('commit', '-m', subject);
  };
  git('init', '-b', 'main');
  commit(1, 'first'); commit(2, 'second'); commit(3, 'third');
  const short = (rev) => git('rev-parse', '--short', rev);
  const run = (...extra) => spawnSync(process.execPath, [script, '--repo', repo, '--live', live, ...extra], { encoding: 'utf8' });
  const LIVE_ID = "id: '@local/dsh-composer-history'";
  const copyFrom = (rev, file) => {
    const text = execFileSync('git', ['-C', repo, 'show', `${rev}:${file}`]).toString('utf8');
    writeFileSync(join(live, file), file === 'client.js' ? text.replace("id: 'dsh-composer-plus'", LIVE_ID) : text);
  };
  const copyAll = (rev) => { for (const f of ['client.js', 'index.js', 'backup.mjs']) copyFrom(rev, f); };
  const snapshot = () => readdirSync(live).sort().map((f) => `${f}:${statSync(join(live, f)).mtimeMs}:${readFileSync(join(live, f)).length}`).join('|');

  // 1. Match: the live copy is the whole of one older commit; the newest commit is not it.
  copyAll('HEAD~1');
  let before = snapshot();
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), `MATCH ${short('HEAD~1')} second (1 commit behind main)`);
  assert.equal(snapshot(), before, 'the live folder is not written');
  // The script runs through a symlinked path too (no silent exit 0).
  const link = join(root, 'scripts-link');
  symlinkSync(dirname(script), link);
  r = spawnSync(process.execPath, [join(link, 'live-copy-check.mjs'), '--repo', repo, '--live', live], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), `MATCH ${short('HEAD~1')} second (1 commit behind main)`, r.stderr);

  // 2. Line 12 must be the live id: the repo id or another id is not a match. Another change in client.js is not either.
  const liveClient = readFileSync(join(live, 'client.js'), 'utf8');
  for (const id of ["id: 'dsh-composer-plus'", "id: 'WRONG'"]) {
    writeFileSync(join(live, 'client.js'), liveClient.replace(LIVE_ID, id));
    r = run();
    assert.equal(r.status, 1, `line 12 ${id} is MIXED`);
    assert.match(r.stdout, /^client\.js none$/m);
  }
  writeFileSync(join(live, 'client.js'), liveClient);
  assert.equal(run().status, 0);
  writeFileSync(join(live, 'client.js'), readFileSync(join(live, 'client.js'), 'utf8').replace('const n = 2;', 'const n = 22;'));
  r = run();
  assert.equal(r.status, 1, 'a change outside line 12 is MIXED');
  assert.match(r.stdout, /^client\.js none$/m);
  assert.match(r.stdout, new RegExp(`^index\\.js ${short('HEAD~1')} second$`, 'm'));

  // 3. Mixed: client.js from the newest commit, index.js and backup.mjs from the first.
  copyFrom('HEAD', 'client.js'); copyFrom('HEAD~2', 'index.js'); copyFrom('HEAD~2', 'backup.mjs');
  before = snapshot();
  r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.stdout.trim().split('\n'), [`client.js ${short('HEAD')} third`, `index.js ${short('HEAD~2')} first`, `backup.mjs ${short('HEAD~2')} first`, 'MIXED']);
  assert.equal(snapshot(), before, 'the live folder is not written');
  // --commits 1 sees only the newest commit.
  r = run('--commits', '1');
  assert.match(r.stdout, /^index\.js none$/m);

  // 4. release-notes.json counts whenever the live copy has it: main does not have it yet, so MIXED; then a difference is MIXED too.
  copyAll('HEAD');
  writeFileSync(join(live, 'release-notes.json'), '{}');
  r = run();
  assert.equal(r.status, 1, 'the live file exists, main has none');
  assert.match(r.stdout, /^release-notes\.json none$/m);
  writeFileSync(join(repo, 'release-notes.json'), '{}'); git('add', '.'); git('commit', '-m', 'notes0');
  assert.equal(run().status, 0, 'equal release-notes.json: MATCH');
  writeFileSync(join(repo, 'release-notes.json'), '{"a":1}\n'); git('add', '.'); git('commit', '-m', 'notes');
  r = run();
  assert.match(r.stdout, /^MATCH [0-9a-f]+ notes0 \(1 commit behind main\)$/m, 'the older commit with the same release-notes.json is found');
  writeFileSync(join(live, 'release-notes.json'), '{"b":2}');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^release-notes\.json none$/m);
  unlinkSync(join(live, 'release-notes.json'));
  r = run();
  assert.equal(r.status, 0, 'no live release-notes.json: it is not compared');
  assert.match(r.stdout, /^MATCH [0-9a-f]+ notes \(newest main commit\)$/m);

  // 5. A file that the live folder does not have: none (missing).
  unlinkSync(join(live, 'backup.mjs'));
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^backup\.mjs none \(missing in the live folder\)$/m);

  // 6. Bad argument, no live folder or no git repo: exit 2.
  assert.equal(spawnSync(process.execPath, [script, '--commits', 'x'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--nope', '1'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--commits', '0x10'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--live', '--commits', '5'], { encoding: 'utf8' }).status, 2);
  assert.equal(run('--live', join(root, 'nope')).status, 2, 'no live folder');
  r = spawnSync(process.execPath, [script, '--repo', live, '--live', live], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'not a git repo');
  assert.match(r.stderr, /^live-copy-check: [^]*not a git repository/i);
  console.log('live-copy-check.test.mjs: ok');
} finally { rmSync(root, { recursive: true, force: true }); }
