// Changes → This chat (Host half): the files that dsh's file tools wrote in one chat (from its log) and their total diff
// against the chat's oldest Turn rollback snapshot. Two chats in one repository each see only their own files; work that
// was committed meanwhile still shows; without a snapshot the view is against HEAD; `-w` and the route checks.
// A symlinked folder and a FIFO never fail the view, never escape the folder and never block. The user's .git and the
// rollback store stay the same.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, chatWrites, chatChanges, snapshotStore, CHANGES_PATH, DIFF_PATH } from '../index.js';

const subprocess = {
  resolveExecutable: async () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
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
const git = (cwd, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const fingerprint = (dir) => {
  const lines = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else lines.push(`${p} ${createHash('sha1').update(readFileSync(p)).digest('hex')}`); } };
  walk(dir); return lines.sort().join('\n');
};
/** A chat log: one `tool/call` + `tool/result` per write; `error` marks a failed call. */
let seq = 0;
const write = (name, args, { error = false, raw = false } = {}) => {
  const callId = `c${++seq}`;
  return [{ seq: seq * 2, type: 'tool/call', data: { callId, name, arguments: raw ? JSON.stringify(args) : args } },
    { seq: seq * 2 + 1, type: 'tool/result', data: { message: { source: { kind: 'tool', callId }, ...(error ? { isError: true } : {}) } } }];
};

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-chat-changes-')));
try {
  // 1. chatWrites: write/edit/str_replace_editor, string or object arguments, relative paths from the chat folder at that
  // time, failed calls and `view` left out, repeats once, newest last.
  {
    const cwd = '/p/app';
    const events = [
      ...write('write', { file_path: '/p/app/a.js' }),
      ...write('edit', { file_path: 'lib/b.js' }, { raw: true }),
      ...write('str_replace_editor', { command: 'view', path: '/p/app/c.js' }),
      ...write('str_replace_editor', { command: 'str_replace', path: '/p/app/d.js' }),
      ...write('write', { file_path: '/p/app/e.js' }, { error: true }),
      ...write('bash', { command: 'echo > /p/app/f.js' }),
      { seq: 99, type: 'working-directory/change', data: { cwd: '/p/app/sub' } },
      ...write('write', { file_path: 'g.js' }),
      ...write('write', { file_path: '/p/app/a.js' }),
      ...write('write', { file_path: '' }),
      { seq: 200, type: 'tool/call', data: { callId: 'open', name: 'write', arguments: { file_path: '/p/app/h.js' } } }, // no result yet
    ];
    assert.deepEqual(chatWrites(events, cwd), ['/p/app/lib/b.js', '/p/app/d.js', '/p/app/sub/g.js', '/p/app/a.js']);
    assert.deepEqual(chatWrites([], cwd), []);
  }

  // 2. A repository with two chats; the rollback store took one snapshot per chat before its first message.
  const repo = join(root, 'repo'); mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'shared.js'), 'one\n'); writeFileSync(join(repo, 'a.js'), 'if (x) {\ny();\n}\n'); writeFileSync(join(repo, 'b.js'), 'b\n');
  mkdirSync(join(repo, 'src')); writeFileSync(join(repo, 'src', 'deep.js'), 'deep\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  symlinkSync(outside, join(repo, 'link'));
  writeFileSync(join(repo, '.gitignore'), 'link\n');
  const before = fingerprint(join(repo, '.git'));
  const dir = join(root, 'store');
  const store = snapshotStore({ subprocess, dir });
  await store.snapshot('A', repo, 1);
  await store.snapshot('B', repo, 1);
  const storeBefore = fingerprint(dir);
  // Chat A: changes a.js (only indentation and line endings) and shared.js, creates new.js, deletes b.js; chat B: src/deep.js.
  writeFileSync(join(repo, 'a.js'), 'if (x) {\r\n    y();\r\n}\r\n');
  writeFileSync(join(repo, 'shared.js'), 'one\ntwo\n');
  writeFileSync(join(repo, 'new.js'), 'n\n');
  rmSync(join(repo, 'b.js'));
  writeFileSync(join(repo, 'src', 'deep.js'), 'deep\ndeeper\n');
  // A file nobody's tool wrote (a user edit) is never in a chat's view.
  writeFileSync(join(repo, 'by-hand.js'), 'hand\n');
  const pathsA = ['a.js', 'shared.js', 'new.js', 'b.js'].map((p) => join(repo, p)).concat([join(root, 'elsewhere.txt'), join(repo, 'link', 'secret.txt')]);
  const pathsB = [join(repo, 'src', 'deep.js')];
  let v = await chatChanges(subprocess, store, 'A', repo, pathsA);
  assert.equal(v.base, 'snapshot'); assert.equal(v.mode, 'chat'); assert.equal(v.since, 1);
  // The oldest kept snapshot is from a later message than the chat's first (older ones pruned): the view says so.
  assert.equal((await chatChanges(subprocess, store, 'A', repo, pathsA, undefined, { first: 1 })).base, 'snapshot');
  assert.equal((await chatChanges(subprocess, store, 'A', repo, pathsA, undefined, { first: 0 })).base, 'partial');
  assert.deepEqual(v.files.map((f) => [f.path, f.added, f.deleted]), [['a.js', 3, 3], ['b.js', 0, 1], ['new.js', 1, 0], ['shared.js', 1, 0]]);
  assert.equal(v.outside, 1, 'a path outside the repository is only counted');
  assert.equal(v.skipped, 1, 'a path below a symlinked folder is skipped, never followed');
  assert.deepEqual([v.total, v.added, v.deleted], [4, 5, 4]);
  v = await chatChanges(subprocess, store, 'B', repo, pathsB);
  assert.deepEqual(v.files.map((f) => f.path), ['src/deep.js'], 'chat B sees only its own file');
  // Hide whitespace: a.js leaves the list.
  v = await chatChanges(subprocess, store, 'A', repo, pathsA, undefined, { ws: true });
  assert.deepEqual(v.files.map((f) => f.path), ['b.js', 'new.js', 'shared.js']);
  // One file's diff, only for a listed file.
  let d = await chatChanges(subprocess, store, 'A', repo, pathsA, undefined, { file: 'shared.js' });
  assert.match(d.patch, /^\+two$/m);
  assert.equal(await chatChanges(subprocess, store, 'A', repo, pathsA, undefined, { file: 'by-hand.js' }), undefined, 'not this chat\'s file');
  assert.equal(await chatChanges(subprocess, store, 'A', repo, pathsA, undefined, { file: 'a.js', ws: true }), undefined, 'hidden by -w');
  // Committed meanwhile: still the chat's work (against the snapshot, not HEAD).
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'chat work');
  v = await chatChanges(subprocess, store, 'A', repo, pathsA);
  assert.deepEqual(v.files.map((f) => f.path), ['a.js', 'b.js', 'new.js', 'shared.js'], 'a commit does not hide the chat\'s work');
  // A FIFO with a written path's name: skipped without blocking (a red test would hang: the timer opens it for writing).
  rmSync(join(repo, 'new.js')); execFileSync('mkfifo', [join(repo, 'new.js')]);
  const unblock = setTimeout(() => { try { writeFileSync(join(repo, 'new.js'), 'x'); } catch { /* gone */ } }, 5000);
  v = await chatChanges(subprocess, store, 'A', repo, pathsA);
  clearTimeout(unblock);
  assert.ok(lstatSync(join(repo, 'new.js')).isFIFO(), 'the FIFO was not opened or replaced');
  assert.equal(v.skipped, 2, 'the FIFO is skipped');
  rmSync(join(repo, 'new.js'));
  // No snapshot for this chat: against HEAD (uncommitted), with a note in `base`.
  writeFileSync(join(repo, 'shared.js'), 'one\ntwo\nthree\n');
  v = await chatChanges(subprocess, store, 'C', repo, [join(repo, 'shared.js'), join(repo, 'by-hand.js'), join(root, 'x')]);
  assert.equal(v.base, 'head'); assert.equal(v.outside, 1);
  // by-hand.js went into the test's commit, so against HEAD only shared.js changed.
  assert.deepEqual(v.files.map((f) => f.path), ['shared.js'], 'the chat\'s changed paths, against HEAD');
  d = await chatChanges(subprocess, store, 'C', repo, [join(repo, 'shared.js')], undefined, { file: 'shared.js' });
  assert.match(d.patch, /^\+three$/m);
  v = await chatChanges(subprocess, store, 'C', repo, []);
  assert.deepEqual([v.base, v.total], ['head', 0], 'a chat that wrote nothing has an empty view');
  // Subfolder chat: paths from the chat's folder; a file outside it (in the same repository) is only counted.
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'more');
  const sub = join(repo, 'src');
  await store.snapshot('S', sub, 1);
  writeFileSync(join(sub, 'deep.js'), 'changed\n'); writeFileSync(join(repo, 'shared.js'), 'top\n');
  v = await chatChanges(subprocess, store, 'S', sub, [join(sub, 'deep.js'), join(repo, 'shared.js')]);
  assert.deepEqual(v.files.map((f) => f.path), ['deep.js'], 'paths from the chat folder'); assert.equal(v.outside, 1);
  d = await chatChanges(subprocess, store, 'S', sub, [join(sub, 'deep.js')], undefined, { file: 'deep.js' });
  assert.match(d.patch, /^\+changed$/m);
  // A chat folder opened through a symlink (as macOS /tmp): dsh keeps that path, git answers the real one. The chat's
  // files still show, with a snapshot and against HEAD.
  {
    const linked = join(root, 'linked-repo'); symlinkSync(repo, linked);
    await store.snapshot('L', linked, 1);
    writeFileSync(join(repo, 'shared.js'), 'through the link\n');
    v = await chatChanges(subprocess, store, 'L', linked, [join(linked, 'shared.js')]);
    assert.deepEqual([v.base, v.files.map((f) => f.path), v.outside], ['snapshot', ['shared.js'], 0], 'a symlinked chat folder');
    v = await chatChanges(subprocess, store, 'LH', linked, [join(linked, 'shared.js')]);
    assert.deepEqual([v.base, v.files.map((f) => f.path), v.outside], ['head', ['shared.js'], 0], 'a symlinked chat folder, against HEAD');
    writeFileSync(join(repo, 'shared.js'), 'top\n');
  }
  // Review F-01 (2026-10-27): a written path below a symlinked folder that points inside the repository (`alias -> src`)
  // or nowhere (`ghost -> missing`): git refuses each one "beyond a symbolic link", so they are skipped and the rest of the
  // view still answers. A path in a folder that was deleted (`gone/x.js`) is a delete, not a skip.
  {
    const inner = join(root, 'inner'); mkdirSync(join(inner, 'src'), { recursive: true }); mkdirSync(join(inner, 'gone'));
    git(inner, 'init', '-q', '-b', 'main');
    writeFileSync(join(inner, 'shared.js'), 'one\n'); writeFileSync(join(inner, 'src', 'deep.js'), 'deep\n'); writeFileSync(join(inner, 'gone', 'x.js'), 'x\n');
    symlinkSync('src', join(inner, 'alias')); symlinkSync('missing', join(inner, 'ghost'));
    git(inner, 'add', '-A'); git(inner, 'commit', '-q', '-m', 'init');
    await store.snapshot('I', inner, 1);
    writeFileSync(join(inner, 'shared.js'), 'one\ntwo\n'); writeFileSync(join(inner, 'alias', 'deep.js'), 'deep\nvia alias\n');
    rmSync(join(inner, 'gone'), { recursive: true });
    const pathsI = ['shared.js', 'gone/x.js', 'alias/deep.js', 'ghost/new.js'].map((p) => join(inner, ...p.split('/')));
    v = await chatChanges(subprocess, store, 'I', inner, pathsI);
    assert.deepEqual(v.files.map((f) => [f.path, f.added, f.deleted]), [['gone/x.js', 0, 1], ['shared.js', 1, 0]], 'the other files still show');
    assert.equal(v.skipped, 2, 'alias/deep.js and ghost/new.js are skipped');
    d = await chatChanges(subprocess, store, 'I', inner, pathsI, undefined, { file: 'shared.js' });
    assert.match(d.patch, /^\+two$/m, 'a listed file\'s diff still works');
    assert.equal(await chatChanges(subprocess, store, 'I', inner, pathsI, undefined, { file: 'alias/deep.js' }), undefined, 'a skipped path has no diff');
  }
  // Not a repository.
  const plain = join(root, 'plain'); mkdirSync(plain);
  assert.deepEqual(await chatChanges(subprocess, store, 'A', plain, [join(plain, 'x')]), { repo: false });
  // Read-only: the user's .git (beyond the test's own commits) and the existing store refs never change through a view.
  const storeAfter = fingerprint(dir);
  for (const line of storeBefore.split('\n')) assert.ok(storeAfter.includes(line.split(' ')[0]), `store file kept: ${line.split(' ')[0]}`);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith('view-')).length, 0, 'temp view folders are removed');
  assert.notEqual(before, fingerprint(join(repo, '.git')), 'sanity: the test itself committed');

  // 3. Routes: `mode=chat` reads the chat's own log and folder; `ws=1`; a path from the browser is never a file to read.
  const routes = new Map();
  process.env.DSH_HOME = join(root, 'home');
  const log = { R: [...write('write', { file_path: join(repo, 'shared.js') })] };
  const inherited = {};
  apply({ on: () => {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } }, subprocess,
    sessionQuery: { observeSession: async (id) => ({ header: { cwd: log[id] === undefined ? undefined : repo }, events: log[id] ?? [], inheritedEventCount: inherited[id] ?? 0, [Symbol.dispose]() {} }) } });
  const call = async (path, query) => routes.get(path).fetch(new Request(`http://h${path}?${query}`));
  let r = await call(CHANGES_PATH, 'sessionId=R&mode=chat'); assert.equal(r.status, 200);
  { const body = await r.json(); assert.equal(body.base, 'head'); assert.deepEqual(body.files.map((f) => f.path), ['shared.js']); }
  r = await call(CHANGES_PATH, 'sessionId=R&mode=chat&ws=1'); assert.equal(r.status, 200);
  r = await call(DIFF_PATH, 'sessionId=R&mode=chat&path=shared.js'); assert.match((await r.json()).patch, /^\+top$/m);
  r = await call(DIFF_PATH, 'sessionId=R&mode=chat&path=by-hand.js'); assert.equal(r.status, 404, 'not a file of this chat');
  r = await call(CHANGES_PATH, 'sessionId=X&mode=chat'); assert.deepEqual(await r.json(), { repo: false });
  r = await call(CHANGES_PATH, `sessionId=R&mode=chat&commit=${'a'.repeat(40)}`); assert.equal(r.status, 400);
  // Review F-02 (2026-10-27): a fork (dsh's Branch, Redo) starts with its parent's events (seq = index, as in dsh;
  // `inheritedEventCount` of them). Its first message is its own (seq 12), so a snapshot there is "before its first
  // message": `snapshot`, not `partial`. A chat of its own whose oldest kept snapshot is after its first message: `partial`.
  {
    const chatLog = (firstOwn) => {
      const events = Array.from({ length: 12 }, (_, seq) => ({ seq, type: seq === 1 ? 'user/message' : 'turn/start', data: { source: { kind: 'user' } } }));
      if (firstOwn) events[11] = { seq: 11, type: 'session/end-seed', data: { inherited: true } };
      events.push({ seq: 12, type: 'user/message', data: { source: { kind: 'user' } } },
        { seq: 13, type: 'tool/call', data: { callId: 'w', name: 'write', arguments: { file_path: join(repo, 'shared.js') } } },
        { seq: 14, type: 'tool/result', data: { message: { source: { callId: 'w' } } } });
      return events;
    };
    log.F = chatLog(true); inherited.F = 12;
    log.P = chatLog(false);
    const routeStore = snapshotStore({ subprocess, dir: join(process.env.DSH_HOME, 'cache', 'composer-plus', 'rollback') });
    await routeStore.snapshot('F', repo, 12); await routeStore.snapshot('P', repo, 12);
    writeFileSync(join(repo, 'shared.js'), 'fork turn\n');
    let body = await (await call(CHANGES_PATH, 'sessionId=F&mode=chat')).json();
    assert.deepEqual([body.base, body.since, body.files.map((f) => f.path)], ['snapshot', 12, ['shared.js']], 'a fork: its own first message');
    body = await (await call(CHANGES_PATH, 'sessionId=P&mode=chat')).json();
    assert.deepEqual([body.base, body.since], ['partial', 12], 'not a fork: an older first message stays partial');
  }
  console.log('chat changes checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
