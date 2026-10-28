// Turn rollback, Host half: the git snapshot store on a temporary repository (the user's .git stays byte for byte the same),
// the restore (only regular files inside the chat folder; a symlink to an outside file and a FIFO are skipped, never
// followed or opened), the marker plan, and the route (switch, preview, stop + marker + composer text, one rollback at a time).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, ROLLBACK_PATH, ROLLBACK_SOURCE, REWIND_SOURCE, SNAPSHOT_MAX, rollbackMarker, rollbackPlan, rollbackSpans, redoTarget, snapshotStore, writeBack } from '../index.js';

const subprocess = {
  resolveExecutable: async () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
  // Like dsh's own provider: an aborted signal (the time-out) ends the child.
  spawn({ argv, cwd, env, stdio, signal }) {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    if (stdio?.stdin?.data !== undefined) child.stdin.end(stdio.stdin.data); else child.stdin.end();
    return {
      done: new Promise((resolve) => child.on('close', (code) => resolve({ exitCode: code, signal: null }))),
      collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err }) } },
    };
  },
};
// The test's own `git commit` starts `git maintenance run --auto --detach`, and that can leave .git/objects/maintenance.lock
// after `before` was taken (CI run 39903429035). Switch it off: the fingerprint then sees only what the snapshot store writes.
const git = (cwd, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
/** A fingerprint of every file under .git: path, size, mode and content hash. */
const fingerprint = (dir) => {
  const lines = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { const s = lstatSync(p); lines.push(`${p} ${s.size} ${s.mode} ${createHash('sha1').update(readFileSync(p)).digest('hex')}`); } } };
  walk(dir); return lines.sort().join('\n');
};
const root = mkdtempSync(join(tmpdir(), 'cp-rollback-'));
try {
  // 1. The marker plan: everything on the surface from the message on; dsh's own checks need every shadowed node.
  {
    const plan = rollbackPlan([3, 8, 9, 15, 23, 24], 15);
    assert.deepEqual(plan.shadowed, [15, 23, 24]);
    assert.deepEqual(plan.options, { surfaceOp: { op: 'replace', startSeq: 15, endSeq: 24 }, sourceEventSeqs: [15, 23, 24] });
    assert.throws(() => rollbackPlan([3, 8], 15), (e) => e.status === 409, 'a message that compaction took away cannot be rolled back');
    const marker = rollbackMarker();
    assert.equal(marker.role, 'user'); assert.equal(marker.source.kind, ROLLBACK_SOURCE); assert.ok(Object.isFrozen(marker));
    assert.deepEqual(rollbackSpans([{ seq: 30, type: 'user/message', data: { source: { kind: ROLLBACK_SOURCE } }, sourceEventSeqs: [15, 23, 24] },
      { seq: 31, type: 'user/message', data: { source: { kind: 'user' } } }]), [[15, 30]]);
    // The ↶ view and the route show only our own markers (dsh-rewind-plugin hides its own); the export asks for both kinds.
    const rewind = { seq: 40, type: 'user/message', data: { source: { kind: REWIND_SOURCE } }, sourceEventSeqs: [35, 36] };
    assert.equal(REWIND_SOURCE, 'dsh-rewind');
    assert.deepEqual(rollbackSpans([rewind]), [], 'by default only Composer Plus markers');
    assert.deepEqual(rollbackSpans([rewind], [ROLLBACK_SOURCE, REWIND_SOURCE]), [[35, 40]]);
    assert.deepEqual(rollbackSpans([{ ...rewind, sourceEventSeqs: [] }], [REWIND_SOURCE]), [], 'a marker without sources hides nothing');
  }

  // 2. Snapshots on a real repository: the work tree as it is (untracked files too, .gitignore respected), byte for byte
  // (a CRLF file under "* text eol=lf" stays CRLF), and the user's .git never changes.
  const repo = join(root, 'repo');
  mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitattributes'), '* text eol=lf\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repo, 'crlf.txt'), 'one\r\ntwo\r\n');
  writeFileSync(join(repo, 'keep.txt'), 'keep\n');
  mkdirSync(join(repo, 'app')); writeFileSync(join(repo, 'app', 'main.js'), 'console.log(1);\n');
  writeFileSync(join(repo, 'app', 'run.sh'), '#!/bin/sh\necho run\n'); chmodSync(join(repo, 'app', 'run.sh'), 0o755);
  git(repo, '-c', 'core.safecrlf=false', 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'app', 'notes.md'), 'untracked\n');
  mkdirSync(join(repo, 'node_modules')); writeFileSync(join(repo, 'node_modules', 'x.js'), 'ignored\n');
  writeFileSync(join(repo, 'crlf.txt'), 'one\r\nTWO\r\n'); // a change the user made before the chat
  const before = fingerprint(join(repo, '.git'));
  const dir = join(root, 'home', 'cache', 'composer-plus', 'rollback');
  const store = snapshotStore({ subprocess, dir });
  const chat = 'session-1';
  const cwd = join(repo, 'app'); // the chat works in a subfolder of the repository
  const tree = await store.snapshot(chat, cwd, 10);
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.equal(fingerprint(join(repo, '.git')), before, 'the snapshot writes nothing into the user\'s .git');
  assert.equal(statSync(dir).mode & 0o077, 0, 'the store folder is owner-only');
  // The model's turn: an edit, a bash-style change, a new file, a deleted file, an outside-the-chat-folder change.
  writeFileSync(join(cwd, 'main.js'), 'console.log(2);\n');
  writeFileSync(join(cwd, 'run.sh'), '#!/bin/sh\necho changed by bash\n');
  writeFileSync(join(cwd, 'new.js'), 'new\n');
  rmSync(join(cwd, 'notes.md'));
  writeFileSync(join(repo, 'keep.txt'), 'changed outside the chat folder\n');
  mkdirSync(join(cwd, 'gen')); writeFileSync(join(cwd, 'gen', 'out.txt'), 'generated\n');
  const preview = await store.preview(chat, cwd, 10);
  assert.deepEqual(preview.files.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'gen/out.txt', action: 'delete' }, { path: 'main.js', action: 'restore' }, { path: 'new.js', action: 'delete' },
    { path: 'notes.md', action: 'create' }, { path: 'run.sh', action: 'restore' },
  ], 'only files in the chat folder; bash changes count too');
  assert.equal(fingerprint(join(repo, '.git')), before, 'a preview writes nothing into the user\'s .git');
  assert.deepEqual(await store.preview(chat, cwd, 99), { git: true, snapshot: false }, 'no snapshot for that message');
  const done = await store.restore(chat, cwd, 10);
  assert.deepEqual(done.skipped, []);
  assert.deepEqual(done.restored.sort(), ['main.js', 'notes.md', 'run.sh']);
  assert.deepEqual(done.deleted.sort(), ['gen/out.txt', 'new.js']);
  assert.equal(readFileSync(join(cwd, 'main.js'), 'utf8'), 'console.log(1);\n');
  assert.equal(readFileSync(join(cwd, 'run.sh'), 'utf8'), '#!/bin/sh\necho run\n');
  assert.equal(statSync(join(cwd, 'run.sh')).mode & 0o111, 0o111, 'the executable bit comes back');
  assert.equal(readFileSync(join(cwd, 'notes.md'), 'utf8'), 'untracked\n', 'an untracked file comes back');
  assert.throws(() => statSync(join(cwd, 'new.js')), 'a file made after the message goes away');
  assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'changed outside the chat folder\n', 'outside the chat folder: unchanged');
  assert.equal(readFileSync(join(repo, 'crlf.txt'), 'utf8'), 'one\r\nTWO\r\n', 'the user\'s own change stays');
  assert.equal(readFileSync(join(repo, 'node_modules', 'x.js'), 'utf8'), 'ignored\n', 'ignored files are not touched');
  assert.equal(fingerprint(join(repo, '.git')), before, 'a restore writes nothing into the user\'s .git');
  // The only change git may make is a newer time stamp on reused object files (README says so); index, HEAD, refs and config keep theirs too.
  {
    const times = (names) => names.map((n) => `${n} ${statSync(join(repo, '.git', n)).mtimeMs}`).join('\n');
    const meta = ['index', 'HEAD', 'config', 'refs/heads/main'];
    const t1 = times(meta);
    await store.snapshot(chat, cwd, 11); await store.preview(chat, cwd, 11);
    assert.equal(times(meta), t1, 'index, HEAD, config and the branch ref keep their time stamps');
  }
  // Byte for byte: a CRLF file in the chat folder comes back with CRLF.
  {
    const crlfCwd = repo;
    await store.snapshot('session-crlf', crlfCwd, 1);
    writeFileSync(join(repo, 'crlf.txt'), 'changed\n');
    const r = await store.restore('session-crlf', crlfCwd, 1);
    assert.ok(r.restored.includes('crlf.txt'));
    assert.equal(readFileSync(join(repo, 'crlf.txt'), 'utf8'), 'one\r\nTWO\r\n', 'CRLF stays CRLF');
    writeFileSync(join(repo, 'keep.txt'), 'keep\n');
  }
  // Only the newest SNAPSHOT_MAX snapshots stay.
  {
    for (let seq = 100; seq < 100 + SNAPSHOT_MAX + 2; seq++) await store.snapshot('session-many', cwd, seq);
    assert.deepEqual(await store.preview('session-many', cwd, 100), { git: true, snapshot: false }, 'the oldest snapshot was dropped');
    assert.equal((await store.preview('session-many', cwd, 100 + SNAPSHOT_MAX + 1)).snapshot, true);
  }

  // 3. Rule 6: a symlink to a file outside the folder and a FIFO are skipped; the outside file is unchanged and nothing hangs.
  {
    const outside = join(root, 'outside.txt'); writeFileSync(outside, 'secret\n');
    await store.snapshot(chat, cwd, 20);
    rmSync(join(cwd, 'main.js')); symlinkSync(outside, join(cwd, 'main.js'));
    execFileSync('mkfifo', [join(cwd, 'run.sh.fifo')]);
    rmSync(join(cwd, 'run.sh')); execFileSync('mkfifo', [join(cwd, 'run.sh')]);
    let opened = false; // a red test (a FIFO opened for reading or writing) must end instead of hanging
    const unblock = setTimeout(() => { opened = true; try { closeSync(openSync(join(cwd, 'run.sh'), constants.O_RDWR | constants.O_NONBLOCK)); } catch { /* gone */ } }, 3000);
    const r = await store.restore(chat, cwd, 20);
    clearTimeout(unblock);
    assert.equal(opened, false, 'restore did not wait on the FIFO');
    // git cannot index a FIFO and keeps its last entry, so the FIFO is not in the list at all; either way it is not opened.
    assert.deepEqual(r.skipped.map((s) => [s.path, s.reason]), [['main.js', 'symlink']]);
    assert.equal(readFileSync(outside, 'utf8'), 'secret\n', 'the file behind the symlink is unchanged');
    assert.ok(lstatSync(join(cwd, 'main.js')).isSymbolicLink(), 'the symlink itself stays');
    assert.ok(lstatSync(join(cwd, 'run.sh')).isFIFO() && lstatSync(join(cwd, 'run.sh.fifo')).isFIFO(), 'the FIFOs stay as they are');
    rmSync(join(cwd, 'main.js')); rmSync(join(cwd, 'run.sh')); rmSync(join(cwd, 'run.sh.fifo'));
  }
  // writeBack with a FIFO as the target (restore and delete): skipped without opening it.
  {
    const project = join(root, 'fifo-project'); mkdirSync(project);
    execFileSync('mkfifo', [join(project, 'pipe')]); execFileSync('mkfifo', [join(project, 'gone')]);
    const src = join(root, 'fifo-src.txt'); writeFileSync(src, 'bytes\n');
    let opened = false;
    const unblock = setTimeout(() => { opened = true; for (const n of ['pipe', 'gone']) try { closeSync(openSync(join(project, n), constants.O_RDWR | constants.O_NONBLOCK)); } catch { /* gone */ } }, 3000);
    const r = await writeBack(project, [{ path: 'pipe', action: 'restore' }, { path: 'gone', action: 'delete' }], () => ({ source: src, mode: '100644' }));
    clearTimeout(unblock);
    assert.equal(opened, false, 'writeBack did not wait on a FIFO');
    assert.deepEqual(r.skipped.map((s) => [s.path, s.reason]), [['pipe', 'not a regular file'], ['gone', 'not a regular file']]);
    assert.ok(lstatSync(join(project, 'pipe')).isFIFO() && lstatSync(join(project, 'gone')).isFIFO());
  }
  // writeBack directly: a folder symlinked outside, and a ".." path, are refused.
  {
    const project = join(root, 'project'); mkdirSync(project);
    const away = join(root, 'away'); mkdirSync(away);
    symlinkSync(away, join(project, 'linked'));
    const src = join(root, 'src.txt'); writeFileSync(src, 'bytes\n');
    const r = await writeBack(project, [{ path: 'linked/x.txt', action: 'create' }, { path: '../x.txt', action: 'create' }, { path: 'ok/y.txt', action: 'create' }, { path: 'linked/z.txt', action: 'delete' }],
      () => ({ source: src, mode: '100644' }));
    assert.deepEqual(r.skipped.map((s) => [s.path, s.reason]), [['linked/x.txt', 'outside the project folder'], ['../x.txt', 'unsafe path'], ['linked/z.txt', 'outside the project folder']]);
    assert.deepEqual(r.restored, ['ok/y.txt']);
    assert.deepEqual(readdirSync(away), [], 'nothing written through the folder symlink');
  }
  // Review finding 1: a file that was ignored at the snapshot is never deleted, even when the turn changes the ignore rules.
  {
    const r2 = join(root, 'ignore-repo'); mkdirSync(r2); git(r2, 'init', '-q', '-b', 'main');
    writeFileSync(join(r2, '.gitignore'), '.env\nnode_modules/\n'); writeFileSync(join(r2, '.env'), 'SECRET=1\n');
    mkdirSync(join(r2, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(r2, 'node_modules', 'pkg', 'index.js'), 'x\n');
    writeFileSync(join(r2, 'a.js'), 'a\n'); git(r2, 'add', '-A'); git(r2, 'commit', '-q', '-m', 'init');
    await store.snapshot('session-ignore', r2, 1);
    rmSync(join(r2, '.gitignore')); // the turn removes the ignore rules
    writeFileSync(join(r2, 'made.js'), 'made by the turn\n');
    const p2 = await store.preview('session-ignore', r2, 1);
    assert.deepEqual(p2.files.map((f) => [f.path, f.action]).sort(), [['.gitignore', 'create'], ['made.js', 'delete']], 'ignored files are not delete candidates');
    const r = await store.restore('session-ignore', r2, 1);
    assert.equal(readFileSync(join(r2, '.env'), 'utf8'), 'SECRET=1\n', '.env stays');
    assert.ok(statSync(join(r2, 'node_modules', 'pkg', 'index.js')).isFile(), 'node_modules stays');
    assert.deepEqual(r.deleted, ['made.js']);
  }
  // Review findings 2 + 3: a FIFO as .git/info/exclude, or a FIFO named .gitignore in the tree, never stops the chat.
  {
    const r3 = join(root, 'fifo-repo'); mkdirSync(r3); git(r3, 'init', '-q', '-b', 'main');
    writeFileSync(join(r3, 'a.js'), 'a\n'); git(r3, 'add', '-A'); git(r3, 'commit', '-q', '-m', 'init');
    rmSync(join(r3, '.git', 'info', 'exclude'), { force: true }); execFileSync('mkfifo', [join(r3, '.git', 'info', 'exclude')]);
    const fast = snapshotStore({ subprocess, dir: join(root, 'fast-store'), timeoutMs: 1500 });
    const unblock = [];
    const timer = setTimeout(() => { for (const f of unblock) try { closeSync(openSync(f, constants.O_RDWR | constants.O_NONBLOCK)); } catch { /* gone */ } }, 8000);
    unblock.push(join(r3, '.git', 'info', 'exclude'));
    const started = Date.now();
    assert.match(await fast.snapshot('session-fifo', r3, 1), /^[0-9a-f]{40}$/, 'a FIFO as info/exclude is read as empty');
    assert.ok(Date.now() - started < 4000, 'the exclude FIFO did not block');
    mkdirSync(join(r3, 'sub')); execFileSync('mkfifo', [join(r3, 'sub', '.gitignore')]); unblock.push(join(r3, 'sub', '.gitignore'));
    const t0 = Date.now();
    await fast.snapshot('session-fifo', r3, 2).catch(() => {}); // git waits on the FIFO until the time-out
    assert.ok(Date.now() - t0 < 5000, 'a FIFO .gitignore ends at the snapshot time-out');
    clearTimeout(timer);
    rmSync(join(r3, 'sub'), { recursive: true });
  }
  // Review finding 4: only the chat's folder goes into the snapshot, not the whole repository.
  {
    const r4 = join(root, 'home-repo'); mkdirSync(join(r4, 'Downloads'), { recursive: true }); mkdirSync(join(r4, 'Projects', 'x'), { recursive: true });
    git(r4, 'init', '-q', '-b', 'main'); writeFileSync(join(r4, 'Downloads', 'big.bin'), 'not for the store\n'); writeFileSync(join(r4, 'Projects', 'x', 'm.js'), 'm\n');
    const tree = await store.snapshot('session-home', join(r4, 'Projects', 'x'), 1);
    const listed = execFileSync('git', ['--git-dir', join(dir, 'session-home.git'), 'ls-tree', '-r', '--name-only', tree], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim().split('\n');
    assert.deepEqual(listed, ['Projects/x/m.js'], 'files outside the chat folder are not copied');
  }
  // Review finding 5: after the repository loses an object that the store index names, the next snapshot still works.
  {
    const r5 = join(root, 'gc-repo'); mkdirSync(r5); git(r5, 'init', '-q', '-b', 'main');
    writeFileSync(join(r5, 'a.js'), 'version one\n'); git(r5, 'add', '-A'); git(r5, 'commit', '-q', '-m', 'one');
    await store.snapshot('session-gc', r5, 1);
    // The repository forgets the blob (as gc does after a rebase); the file itself is unchanged on disk.
    const blob = git(r5, 'rev-parse', 'HEAD:a.js').trim();
    git(r5, 'update-ref', '-d', 'refs/heads/main'); git(r5, 'reflog', 'expire', '--expire=now', '--all'); git(r5, 'gc', '-q', '--prune=now');
    rmSync(join(r5, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
    assert.match(await store.snapshot('session-gc', r5, 2), /^[0-9a-f]{40}$/, 'the store index is made again');
  }
  // Outside a repository: no snapshot, and the preview says so.
  {
    const plain = join(root, 'plain'); mkdirSync(plain);
    assert.equal(await store.snapshot('session-plain', plain, 1), undefined);
    assert.deepEqual(await store.preview('session-plain', plain, 1), { git: false });
  }

  // Review finding 6: every git step runs before `beforeWrite` (the marker); a git failure never calls it.
  {
    const broken = join(root, 'broken-repo'); mkdirSync(broken); git(broken, 'init', '-q', '-b', 'main'); writeFileSync(join(broken, 'a.js'), 'a\n');
    await store.snapshot('session-broken', broken, 1);
    writeFileSync(join(broken, 'a.js'), 'changed\n');
    // git fails in the restore step: this subprocess refuses `read-tree`, as a git error or a time-out would.
    const refusing = { ...subprocess, spawn: (spec) => (spec.argv.includes('read-tree') ? { done: Promise.resolve({ exitCode: 128 }), collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: 'fatal: test' }) } } } : subprocess.spawn(spec)) };
    const failingStore = snapshotStore({ subprocess: refusing, dir });
    let called = false;
    await assert.rejects(failingStore.restore('session-broken', broken, 1, undefined, () => { called = true; }), /read-tree/);
    assert.equal(called, false, 'no marker when git fails');
    assert.equal(readFileSync(join(broken, 'a.js'), 'utf8'), 'changed\n', 'no file written');
    let calledOk = false;
    const r = await store.restore('session-broken', broken, 1, undefined, () => { calledOk = true; });
    assert.ok(calledOk && r.restored.includes('a.js'), 'with git working, the marker comes, then the files');
    // The Redo record fails after the marker (here: `update-ref refs/r/…`): the messages are withdrawn, so the files must
    // still come back; only the warning is logged and Redo then has no files to offer.
    writeFileSync(join(broken, 'a.js'), 'changed again\n');
    const logged = [];
    const noRecord = { ...subprocess, spawn: (spec) => (spec.argv.some((a) => a.startsWith('refs/r/')) ? { done: Promise.resolve({ exitCode: 128 }), collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: 'fatal: lock' }) } } } : subprocess.spawn(spec)) };
    const r2 = await snapshotStore({ subprocess: noRecord, dir, log: (t) => logged.push(t) }).restore('session-broken', broken, 1, undefined, () => 7);
    assert.ok(r2.restored.includes('a.js'), 'files written although the redo record failed');
    assert.equal(readFileSync(join(broken, 'a.js'), 'utf8'), 'a\n');
    assert.match(logged.join('\n'), /redo record not saved/);
    assert.deepEqual(await store.redoPreview('session-broken', broken, 7), { files: false }, 'no record: Redo offers the chat only');
  }
  // Many files: the paths go to `git ls-tree` in parts (here two), and the Redo record and preview still have each file.
  {
    const many = join(root, 'many-repo'); mkdirSync(many); git(many, 'init', '-q', '-b', 'main');
    const names = Array.from({ length: 600 }, (_, i) => `${String(i).padStart(4, '0')}-${'x'.repeat(120)}.txt`);
    for (const n of names) writeFileSync(join(many, n), 'old\n');
    await store.snapshot('session-many-files', many, 1);
    for (const n of names) writeFileSync(join(many, n), 'new\n');
    assert.equal((await store.restore('session-many-files', many, 1, undefined, () => 9)).restored.length, 600);
    assert.equal((await store.redoPreview('session-many-files', many, 9)).files.length, 600, 'each file in the redo preview');
  }

  // 4. The route: switch (on by default, 0600 file), GET spans, preview, rollback (stop, steering dropped, marker,
  // composer text), one rollback at a time, refusals.
  {
    const home = join(root, 'route-home'); process.env.DSH_HOME = home;
    const routes = new Map(); const listeners = new Map();
    const events = [
      { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } },
      { seq: 8, type: 'assistant/message', data: {} },
      { seq: 9, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second ' }, { type: 'image' }, { type: 'text', text: 'part' }] } },
      { seq: 12, type: 'assistant/message', data: {} },
    ];
    const appended = []; const removed = []; const cancelled = [];
    let status = 'running'; let idle; const idleWait = new Promise((r) => { idle = r; });
    const session = {
      id: 'chat-a', header: { id: 'chat-a', cwd: repo },
      surface: { get nodes() { return [3, 8, 9, 12]; } },
      snapshotEvents: () => [...events, ...appended],
      append: (type, data, options) => { const e = { seq: 20 + appended.length, type, data, ...options }; appended.push(e); return e; },
    };
    const agent = {
      session, get status() { return status; },
      cancel: (cause, options) => { cancelled.push([cause, options]); setTimeout(() => { status = 'idle'; idle(); }, 30); },
      whenIdle: () => idleWait,
      inbox: { nextStep: [{ id: 'm1' }], remove: (id) => removed.push(id) },
    };
    let commands = {};
    const forks = []; let forkFails = false;
    apply({
      // Like Cordis, every listener of an event runs (other features listen to session/event too).
      on: (name, fn) => { const prev = listeners.get(name); listeners.set(name, prev === undefined ? fn : (...a) => { const r = prev(...a); fn(...a); return r; }); }, sessionQuery: {}, subprocess,
      sessionController: { resolveAgent: async (id) => (id === 'chat-a' ? { agent } : { error: 'missing' }),
        fork: async (request) => { if (forkFails) throw new Error('fork failed'); forks.push(request); return { sessionId: `fork-${forks.length}` }; } },
      connection: { fetch: { register: (r) => routes.set(r.path, r) } },
      get: (name) => (name === 'commands' ? commands : name === 'agents' ? { get: () => agent } : undefined),
    });
    const call = async (body, method = 'POST') => {
      const url = method === 'GET' ? `http://h${ROLLBACK_PATH}?${new URLSearchParams(body)}` : `http://h${ROLLBACK_PATH}`;
      const response = await routes.get(ROLLBACK_PATH).fetch(new Request(url, method === 'GET' ? {} : { method, body: typeof body === 'string' ? body : JSON.stringify(body) }));
      return { status: response.status, json: await response.json() };
    };
    assert.deepEqual((await call({}, 'GET')).json, { on: true }, 'on by default');
    assert.deepEqual((await call({ sessionId: 'chat-a' }, 'GET')).json, { on: true, rewind: false, spans: [], redo: null });
    assert.equal((await call('{bad')).status, 400);
    assert.equal((await call({ sessionId: 'chat-a', seq: 8 })).status, 400, 'only a message of the user');
    assert.equal((await call({ sessionId: 'missing', seq: 9 })).status, 409);
    // A user message event takes a snapshot; a tool waits for it.
    listeners.get('session/event')(session, events[2]);
    let toolRan = false;
    await listeners.get('tools/pre-execute')({ agent }, async () => { toolRan = true; });
    assert.ok(toolRan);
    assert.equal((await call({ sessionId: 'chat-a', seq: 9, preview: true })).json.git, true);
    writeFileSync(join(repo, 'keep.txt'), 'turn edit\n');
    const first = call({ sessionId: 'chat-a', seq: 9, files: true });
    const second = await call({ sessionId: 'chat-a', seq: 9 });
    assert.equal(second.status, 409, 'one rollback of a chat at a time');
    const res = await first;
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(cancelled, [[{ kind: 'user' }, { keepInbox: true }]], 'the running turn stops first');
    assert.deepEqual(removed, ['m1'], 'unread steering goes with the turn');
    assert.equal(appended.length, 1);
    assert.deepEqual(appended[0].surfaceOp, { op: 'replace', startSeq: 9, endSeq: 12 });
    assert.deepEqual(appended[0].sourceEventSeqs, [9, 12]);
    assert.equal(appended[0].data.source.kind, ROLLBACK_SOURCE);
    assert.equal(res.json.text, 'second part', 'the message text for the composer');
    assert.deepEqual(res.json.span, [9, 20]);
    assert.ok(res.json.files.restored.includes('keep.txt'));
    assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'keep\n');
    assert.deepEqual((await call({ sessionId: 'chat-a' }, 'GET')).json.spans, [[9, 20]]);
    // Redo: offered for the newest rollback while its marker is the chat's last user message.
    {
      assert.equal((await call({ sessionId: 'chat-a' }, 'GET')).json.redo, 20);
      // Meanwhile the user edits keep.txt by hand: the redo preview marks it as changed.
      writeFileSync(join(repo, 'keep.txt'), 'hand edit\n');
      let r = await call({ sessionId: 'chat-a', redo: 20, preview: true });
      assert.deepEqual(r.json, { files: [{ path: 'keep.txt', action: 'restore', changed: true }] });
      assert.equal((await call({ sessionId: 'chat-a', redo: 19, preview: true })).status, 409, 'only the newest rollback');
      assert.equal((await call({ sessionId: 'chat-a', redo: '20' })).status, 409);
      // A busy chat: refused (its work would mix with the files).
      status = 'running'; assert.equal((await call({ sessionId: 'chat-a', redo: 20, files: true })).status, 409); status = 'idle';
      // A failing fork writes no file and keeps the offer.
      forkFails = true;
      r = await call({ sessionId: 'chat-a', redo: 20, files: true, overwrite: true });
      assert.equal(r.status, 500); assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'hand edit\n', 'no file before the fork worked');
      assert.equal((await call({ sessionId: 'chat-a' }, 'GET')).json.redo, 20);
      forkFails = false;
      // Without overwrite: the changed file stays and is listed; the new chat starts from just before the marker.
      r = await call({ sessionId: 'chat-a', redo: 20, files: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(forks, [{ sessionId: 'chat-a', atSeq: 19 }]);
      assert.equal(r.json.sessionId, 'fork-1'); assert.deepEqual(r.json.files.changed, ['keep.txt']); assert.deepEqual(r.json.files.restored, []);
      assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'hand edit\n', 'a file changed since the rollback is kept');
      // Once only (saved owner-only): the offer is gone, a second redo is refused.
      assert.equal((await call({ sessionId: 'chat-a' }, 'GET')).json.redo, null);
      assert.equal((await call({ sessionId: 'chat-a', redo: 20 })).status, 409);
      assert.equal(statSync(join(home, 'storages', 'dsh-composer-plus', 'redone.json')).mode & 0o777, 0o600);
    }
    // A second rollback of the same turn, then redo with overwrite: the turn's file comes back over a hand edit.
    {
      writeFileSync(join(repo, 'keep.txt'), 'turn edit again\n');
      status = 'idle';
      events.push({ seq: 13, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'third' }] } });
      listeners.get('session/event')(session, events.at(-1)); await listeners.get('tools/pre-execute')({ agent }, async () => {});
      writeFileSync(join(repo, 'keep.txt'), 'third turn\n');
      const surf = Object.getOwnPropertyDescriptor(session.surface, 'nodes');
      Object.defineProperty(session.surface, 'nodes', { get: () => [3, 8, 13], configurable: true });
      let r = await call({ sessionId: 'chat-a', seq: 13, files: true });
      assert.equal(r.status, 200, JSON.stringify(r.json)); const marker = r.json.markerSeq;
      assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'turn edit again\n');
      writeFileSync(join(repo, 'keep.txt'), 'hand edit 2\n');
      // redone.json cannot be saved (read-only folder): the new chat exists, so the redo still answers it, and a second
      // click in this run is refused (no second new chat).
      const saved = join(home, 'storages', 'dsh-composer-plus'); chmodSync(saved, 0o500);
      try {
        r = await call({ sessionId: 'chat-a', redo: marker, files: true, overwrite: true });
        assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.sessionId, `fork-${forks.length}`);
        assert.equal((await call({ sessionId: 'chat-a', redo: marker })).status, 409, 'no second new chat');
        assert.equal(forks.length, 2);
      } finally { chmodSync(saved, 0o700); }
      assert.deepEqual(r.json.files.restored, ['keep.txt']); assert.deepEqual(r.json.files.changed, []);
      assert.equal(readFileSync(join(repo, 'keep.txt'), 'utf8'), 'third turn\n', 'overwrite puts the turn\'s file back');
      Object.defineProperty(session.surface, 'nodes', surf);
      // A later message of the user ends the offer.
      appended.push({ seq: 99, type: 'user/message', data: { source: { kind: 'user' } } });
      assert.equal((await call({ sessionId: 'chat-a' }, 'GET')).json.redo, null);
    }
    assert.equal(redoTarget([{ seq: 5, type: 'user/message', data: { source: { kind: ROLLBACK_SOURCE } }, sourceEventSeqs: [2] }]), 5);
    assert.equal(redoTarget([{ seq: 5, type: 'user/message', data: { source: { kind: REWIND_SOURCE } }, sourceEventSeqs: [2] }]), undefined, 'not dsh-rewind\'s');
    assert.equal(redoTarget([{ seq: 5, type: 'user/message', data: { source: { kind: ROLLBACK_SOURCE } }, sourceEventSeqs: [2] }, { seq: 6, type: 'user/message', data: { source: { kind: 'runtime-context' } } }]), undefined, 'a later message ends it');
    // Switch off: saved owner-only, rollbacks refused, no more snapshots.
    assert.deepEqual((await call({ on: false })).json, { on: false });
    assert.equal(statSync(join(home, 'storages', 'dsh-composer-plus', 'rollback.json')).mode & 0o777, 0o600);
    assert.equal((await call({ sessionId: 'chat-a', seq: 3 })).status, 409);
    await call({ on: true });
    // dsh-rewind-plugin loaded: it owns rollback; the route says so and no snapshot is taken.
    commands = { find: (a, name) => (name === 'rewind-plugin' ? {} : undefined) };
    assert.equal((await call({ sessionId: 'chat-a' }, 'GET')).json.rewind, true);
  }
  console.log('turn-rollback: ok');
} finally { rmSync(root, { recursive: true, force: true }); }
