// scripts/live-copy-check.mjs: MATCH when the live copy equals one commit of main (live client.js line 12 is ignored),
// MIXED when the files come from different commits, and the live folder is never written. Temporary repo and live folder.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/live-copy-check.mjs', import.meta.url).pathname;
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
  const copyFrom = (rev, file) => writeFileSync(join(live, file), execFileSync('git', ['-C', repo, 'show', `${rev}:${file}`]));
  const copyAll = (rev) => { for (const f of ['client.js', 'index.js', 'backup.mjs']) copyFrom(rev, f); };
  const snapshot = () => readdirSync(live).sort().map((f) => `${f}:${statSync(join(live, f)).mtimeMs}:${readFileSync(join(live, f)).length}`).join('|');

  // 1. Match: the live copy is the whole of one older commit; the newest commit is not it.
  copyAll('HEAD~1');
  let before = snapshot();
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), `MATCH ${short('HEAD~1')} second`);
  assert.equal(snapshot(), before, 'the live folder is not written');

  // 2. Changed line 12: the live copy keeps its own id; it still matches. Another change in client.js does not.
  writeFileSync(join(live, 'client.js'), readFileSync(join(live, 'client.js'), 'utf8').replace("id: 'dsh-composer-plus'", "id: '@local/dsh-composer-history'"));
  r = run();
  assert.equal(r.status, 0, 'line 12 is ignored');
  assert.equal(r.stdout.trim(), `MATCH ${short('HEAD~1')} second`);
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

  // 4. release-notes.json counts only when the live copy has it; then a difference is MIXED.
  copyAll('HEAD');
  writeFileSync(join(live, 'release-notes.json'), '{}');
  r = run();
  assert.equal(r.status, 0, 'main has no release-notes.json: the file is not compared');
  writeFileSync(join(repo, 'release-notes.json'), '{"a":1}\n'); git('add', '.'); git('commit', '-m', 'notes');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^release-notes\.json none$/m);

  // 5. Bad argument: exit 2.
  assert.equal(spawnSync(process.execPath, [script, '--commits', 'x'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--nope', '1'], { encoding: 'utf8' }).status, 2);
  console.log('live-copy-check.test.mjs: ok');
} finally { rmSync(root, { recursive: true, force: true }); }
