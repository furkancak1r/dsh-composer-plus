// Changes → a file's menu → "Chats that changed this file" (Host half): the chats of the same repository whose write/edit
// tools changed the file, one row per request, newest first. A chat in another repository, a failed call, a fork's
// inherited events (rule 10) and other files never count; a request that Turn rollback or dsh-rewind-plugin withdrew
// shows no text (rule 9), /compact does not hide one; a chat folder opened through a symlink still counts. The route checks
// its input and reads only logs (the file itself can be a FIFO: nothing opens it).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, fileChats, writeCalls, writeSummaries, FILE_CHATS_PATH, FILE_CHATS_SCAN } from '../index.js';

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

/** One chat log: `ask(text, time)` adds a human message; `write(path, time)` a write call and its result. */
function chat() {
  const events = []; let seq = 0; let n = 0;
  const api = {
    events,
    ask(text, time) { events.push({ seq: ++seq, time, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }); return seq; },
    write(file, time, { tool = 'write', error = false } = {}) {
      const callId = `c${++n}`;
      const args = tool === 'str_replace_editor' ? { command: 'str_replace', path: file } : { file_path: file };
      events.push({ seq: ++seq, time, type: 'tool/call', data: { callId, name: tool, arguments: args } });
      events.push({ seq: ++seq, time, type: 'tool/result', data: { message: { source: { kind: 'tool', callId }, ...(error ? { isError: true } : {}) } } });
      return api;
    },
    withdraw(kind, from) { const marker = ++seq; events.push({ seq: marker, time: 0, type: 'user/message', data: { content: [{ type: 'text', text: '(empty message)' }], source: { kind } }, sourceEventSeqs: [from, marker - 1] }); },
    title(text) { events.push({ seq: ++seq, time: 0, type: 'session/title', data: { title: text } }); },
  };
  return api;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-file-chats-')));
try {
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', repo); writeFileSync(join(repo, 'src', 'app.js'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
  const other = join(root, 'other'); mkdirSync(other); git(root, 'init', '-q', '-b', 'main', other);
  symlinkSync(repo, join(root, 'repo-link'));

  // writeCalls: the request of each call, failed and unanswered calls out, a fork's inherited part skipped.
  const w = chat(); const q1 = w.ask('first', 1); w.write('src/app.js', 2).write('src/app.js', 3, { error: true }); const q2 = w.ask('second', 4); w.write(join(repo, 'b.js'), 5, { tool: 'str_replace_editor' });
  assert.deepEqual(writeCalls(w.events, repo).map((c) => [c.file, c.request]), [[join(repo, 'src/app.js'), q1], [join(repo, 'b.js'), q2]]);
  assert.deepEqual(writeCalls(w.events, repo, 4).map((c) => c.file), [join(repo, 'b.js')], 'events before `from` are a fork\'s parent\'s');

  // The chats of the repository.
  const chats = new Map();
  const add = (id, cwd, log, extra = {}) => { chats.set(id, { header: { id, cwd, createdAt: chats.size }, log, ...extra }); };
  const a = chat(); a.title('Fix the header'); const aq = a.ask('Fix the header\ncolor please', 100); a.write('src/app.js', 110).write('src/app.js', 120); a.ask('now the footer', 200); a.write('src/footer.js', 210);
  add('chat-a', repo, a);
  const b = chat(); const bq = b.ask('Rename the app', 300); b.write(join(repo, 'src/app.js'), 310); add('chat-b', join(repo, 'src'), b); // a subfolder chat, absolute path
  const c = chat(); c.ask('other repo', 400); c.write(join(other, 'src/app.js'), 410); add('chat-c', other, c);
  const d = chat(); const dq = d.ask('Withdrawn try', 500); d.write('src/app.js', 510); d.withdraw('composer-plus-rollback', dq); add('chat-d', repo, d);
  const e = chat(); const eq = e.ask('Rewound try', 600); e.write('src/app.js', 610); e.withdraw('dsh-rewind', eq); add('chat-e', repo, e);
  const f = chat(); const fq = f.ask('Before compact', 700); f.write('src/app.js', 710); f.withdraw('compact-checkpoint', fq); add('chat-f', repo, f);
  // A fork of chat-a: the first 3 events are chat-a's; its own write comes later.
  const g = chat(); g.events.push(...a.events.slice(0, 5)); const gq = g.ask('fork work', 800); g.write('src/app.js', 810); add('chat-g', repo, g, { inherited: 5 });
  g.events.forEach((ev, i) => { ev.seq = i + 1; });
  const link = chat(); const lq = link.ask('through the link', 900); link.write('src/app.js', 910); add('chat-link', join(root, 'repo-link'), link);
  const broken = chat(); add('chat-broken', repo, broken, { fail: true });
  const sessionQuery = {
    listSessions: async () => [...chats.values()].map((x) => ({ header: x.header })).reverse(),
    observeSession: async (id) => {
      const x = chats.get(id); if (x.fail) throw new Error('log unreadable');
      return { header: x.header, events: x.log.events, ...(x.inherited ? { inheritedEventCount: x.inherited } : {}), [Symbol.dispose]() {} };
    },
  };

  let r = await fileChats({ sessionQuery, subprocess }, repo, 'src/app.js');
  assert.equal(r.repo, true);
  assert.deepEqual(r.chats.map((x) => [x.sessionId, x.seq]), [['chat-link', lq], ['chat-g', 6], ['chat-f', fq], ['chat-e', eq], ['chat-d', dq], ['chat-b', bq], ['chat-a', aq]],
    'newest change first; other repos and other files out; a symlinked chat folder counts');
  const row = (id) => r.chats.find((x) => x.sessionId === id);
  assert.equal(row('chat-a').count, 2, 'two writes in one request are one row'); assert.equal(row('chat-a').time, 120);
  assert.equal(row('chat-a').request, 'Fix the header color please', 'the request on one line'); assert.equal(row('chat-a').title, 'Fix the header');
  assert.equal(row('chat-g').request, 'fork work', 'a fork lists only its own request');
  assert.equal(r.chats.filter((x) => x.sessionId === 'chat-g').length, 1, 'the fork does not repeat its parent\'s change');
  for (const id of ['chat-d', 'chat-e']) { assert.equal(row(id).withdrawn, true, `${id}: withdrawn`); assert.equal(row(id).request, undefined, `${id}: no withdrawn text`); }
  assert.equal(row('chat-f').request, 'Before compact', '/compact does not withdraw'); assert.equal(row('chat-f').withdrawn, undefined);
  assert.equal(r.unreadable, 1, 'an unreadable log is counted, not fatal'); assert.equal(r.partial, undefined);
  r = await fileChats({ sessionQuery, subprocess }, repo, 'src/footer.js'); assert.deepEqual(r.chats.map((x) => x.sessionId), ['chat-a']);
  r = await fileChats({ sessionQuery, subprocess }, join(root, 'repo-link'), 'src/app.js'); assert.equal(r.chats.length, 7, 'the same answer from the symlinked folder');
  assert.deepEqual(await fileChats({ sessionQuery, subprocess }, root, 'x'), { repo: false });
  // The summary cache: an unchanged log (same stamp) is not read again; a changed one is; a chat without a stamp always is.
  {
    let reads = 0;
    const counted = { ...sessionQuery, observeSession: async (id, o) => { reads += 1; return sessionQuery.observeSession(id, o); } };
    const stamps = new Map([['chat-a', 's1'], ['chat-b', 's1']]);
    const deps = { sessionQuery: counted, subprocess, summaries: writeSummaries(), stampOf: async (h) => stamps.get(h.id) };
    const first = await fileChats(deps, repo, 'src/app.js'); const n1 = reads;
    const again = await fileChats(deps, repo, 'src/app.js'); const n2 = reads - n1;
    assert.deepEqual(again.chats, first.chats, 'the cached answer is the same');
    assert.equal(n2, n1 - 2, 'two stamped chats are not read again; the others are');
    stamps.set('chat-a', 's2'); await fileChats(deps, repo, 'src/app.js');
    assert.equal(reads - n1 - n2, n1 - 1, 'a changed stamp reads that chat again');
    const other = await fileChats(deps, repo, 'src/footer.js');
    assert.deepEqual(other.chats.map((x) => x.sessionId), ['chat-a'], 'one summary serves every path');
    // A live chat is never served from the cache (its newest events are in dsh's memory, not yet in the log file).
    const liveQuery = { ...counted, listSessions: async () => (await counted.listSessions()).map((r) => (r.header.id === 'chat-b' ? { ...r, live: true } : r)) };
    const liveDeps = { ...deps, sessionQuery: liveQuery };
    await fileChats(liveDeps, repo, 'src/app.js'); const before = reads;
    await fileChats(liveDeps, repo, 'src/app.js');
    assert.equal(reads - before, n1 - 1, 'only chat-a (stamped, not live) comes from the cache');
  }
  // More chats than the scan limit: only the newest are read, and the answer says so.
  const many = { listSessions: async () => Array.from({ length: FILE_CHATS_SCAN + 2 }, (_, i) => ({ header: { id: `m${i}`, cwd: repo } })), observeSession: async (id) => ({ header: { cwd: repo }, events: id === 'm0' ? a.events : [], [Symbol.dispose]() {} }) };
  r = await fileChats({ sessionQuery: many, subprocess }, repo, 'src/app.js'); assert.equal(r.partial, true); assert.equal(r.chats[0].sessionId, 'm0');

  // The route: the chat's own folder decides the repository; the path is checked and never opened.
  const routes = new Map();
  const ctx = { on() {}, effect() {}, get: () => undefined, connection: { fetch: { register: (x) => routes.set(x.path, x) } }, sessionController: {}, subprocess,
    sessionQuery: { ...sessionQuery, observeSession: (id, o) => sessionQuery.observeSession(id === 'route' ? 'chat-a' : id, o) } };
  const saved = process.env.DSH_HOME; process.env.DSH_HOME = join(root, 'home');
  try { apply(ctx); } finally { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved; }
  const route = routes.get(FILE_CHATS_PATH); assert.deepEqual(route.methods, ['GET']);
  const get = async (q) => { const res = await route.fetch(new Request(`http://h${FILE_CHATS_PATH}?${new URLSearchParams(q)}`)); return { status: res.status, body: await res.json() }; };
  for (const bad of [{}, { sessionId: 'route' }, { path: 'a' }, { sessionId: 'route', path: '/etc/passwd' }, { sessionId: 'route', path: '../x' }, { sessionId: 'route', path: 'a//b' },
    { sessionId: 'route', path: 'a/./b' }, { sessionId: 'route', path: 'a\0b' }, { sessionId: 'route', path: 'x'.repeat(4097) }]) assert.equal((await get(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  execFileSync('mkfifo', [join(repo, 'pipe')]);
  let res = await get({ sessionId: 'route', path: 'pipe' }); assert.equal(res.status, 200); assert.deepEqual(res.body.chats, [], 'a FIFO path is only compared, never opened');
  res = await get({ sessionId: 'route', path: 'src/app.js' }); assert.equal(res.status, 200); assert.equal(res.body.chats.length, 7);
  console.log('file chats checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
