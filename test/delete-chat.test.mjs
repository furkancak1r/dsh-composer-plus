// Delete chat, Host half: archive with dsh's own stop first, then move the chat's log folder (and its subagents' folders)
// to a trash. Refusals keep every file: a subagent chat, a chat that does not stop, a chat that another dsh holds.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, DELETE_CHAT_PATH, moveToTrash } from '../index.js';

const root = mkdtempSync(join(tmpdir(), 'cp-delete-chat-'));
try {
  // 1. moveToTrash outside macOS: `<home>/trash/<project folder>/<chat folder>-<time>`, owner-only.
  {
    const home = join(root, 'home1');
    const folder = join(home, 'sessions', '--proj--', 'session-a'); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'session.v4.jsonl'), '{}\n');
    const r = await moveToTrash([folder, join(home, 'sessions', '--proj--', 'missing')], { home, platform: 'linux' });
    assert.equal(r.to, 'folder'); assert.equal(r.moved.length, 1);
    assert.ok(!existsSync(folder), 'the folder moved');
    assert.ok(existsSync(join(r.moved[0], 'session.v4.jsonl')), 'the log is in the trash folder');
    assert.match(r.moved[0], /trash\/--proj--\/session-a-\d+$/);
    assert.equal(statSync(join(home, 'trash')).mode & 0o077, 0, 'owner-only trash folder');
    assert.deepEqual(await moveToTrash([folder], { home, platform: 'linux' }), { to: 'none', moved: [] });
  }
  // macOS: /usr/bin/trash gets every folder in one call; a failing trash falls back to the folder.
  {
    const home = join(root, 'home2');
    const folder = join(home, 'sessions', '--proj--', 'session-b'); mkdirSync(folder, { recursive: true });
    const calls = [];
    const fakeTrash = (exitCode) => ({ spawn: ({ argv }) => { calls.push(argv); return { done: Promise.resolve({ exitCode }) }; } });
    const hasTrash = existsSync('/usr/bin/trash');
    const r = await moveToTrash([folder], { home, platform: 'darwin', subprocess: fakeTrash(1) });
    if (hasTrash) assert.deepEqual(calls, [['/usr/bin/trash', folder]]);
    assert.equal(r.to, 'folder', 'a failed Trash move falls back to the folder');
    mkdirSync(folder, { recursive: true });
    const ok = await moveToTrash([folder], { home, platform: 'darwin', subprocess: fakeTrash(0) });
    assert.equal(ok.to, hasTrash ? 'trash' : 'folder');
  }

  // 2. The route on fake dsh services.
  const setup = ({ agentStatus, ownedElsewhere = false, subStatus } = {}) => {
    const home = join(root, `route-${Math.random().toString(16).slice(2)}`); process.env.DSH_HOME = home;
    const sessions = join(home, 'sessions', '--proj--');
    const headers = [
      { id: 'chat-a', cwd: '/proj' }, { id: 'sub-1', cwd: '/proj', origin: 'subagent', parentSession: 'chat-a', delegationDepth: 1 },
      { id: 'sub-2', cwd: '/proj', origin: 'subagent', parentSession: 'sub-1', delegationDepth: 2 }, { id: 'chat-b', cwd: '/proj' },
    ];
    for (const h of headers) { mkdirSync(join(sessions, h.id), { recursive: true }); writeFileSync(join(sessions, h.id, 'session.v4.jsonl'), '{}\n'); }
    const log = [];
    const agent = agentStatus === undefined ? undefined : { status: agentStatus, whenIdle: () => (agentStatus === 'stuck' ? new Promise(() => {}) : Promise.resolve()) };
    const subAgent = subStatus === undefined ? undefined : { status: subStatus, whenIdle: () => (subStatus === 'stuck' ? new Promise(() => {}) : Promise.resolve()) };
    const routes = new Map();
    const services = {
      workspaceRegistry: { archiveSession: async (id, options) => { log.push(['archive', id, options]); } },
      sessionPersistence: {
        list: async () => headers.map((header) => ({ header })),
        locate: (h) => ({ kind: 'jsonl', path: join(sessions, h.id, 'session.v4.jsonl') }),
        open: async (id, access) => {
          log.push(['open', id, access]);
          if (ownedElsewhere === true || ownedElsewhere === id) throw Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' });
          return { close: async () => { log.push(['close', id]); } };
        },
      },
      agents: { get: (id) => (id === 'chat-a' ? agent : id === 'sub-1' ? subAgent : undefined) },
      sessions: { get: (id) => ((id === 'chat-a' && agent !== undefined) || (id === 'sub-1' && subAgent !== undefined) ? { id } : undefined), flush: async (s) => { log.push(['flush', s.id]); } },
    };
    apply({ on() {}, sessionQuery: {}, sessionController: {}, subprocess: undefined, connection: { fetch: { register: (r) => routes.set(r.path, r) } }, get: (n) => services[n] });
    // Each chat has a rollback store; Delete removes the stores of the whole family.
    for (const h of headers) mkdirSync(join(home, 'cache', 'composer-plus', 'rollback', `${h.id}.git`), { recursive: true });
    const call = async (body) => {
      const response = await routes.get(DELETE_CHAT_PATH).fetch(new Request(`http://h${DELETE_CHAT_PATH}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
      return { status: response.status, json: await response.json() };
    };
    return { home, sessions, log, call };
  };
  // Not open in this dsh: archive (with stop), hold the write lock while the folders move, close it.
  {
    const t = setup();
    const r = await t.call({ sessionId: 'chat-a' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.chats, 3, 'the chat and its two subagent chats');
    assert.deepEqual(t.log, [['archive', 'chat-a', { stopActivity: true }], ['open', 'chat-a', 'write'], ['open', 'sub-1', 'write'], ['open', 'sub-2', 'write'],
      ['close', 'chat-a'], ['close', 'sub-1'], ['close', 'sub-2']], 'every log of the family is locked while it moves');
    assert.deepEqual(readdirSync(t.sessions), ['chat-b'], 'only the other chat stays');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(readdirSync(join(t.home, 'cache', 'composer-plus', 'rollback')).filter((n) => n.endsWith('.git')), ['chat-b.git'], 'the family\'s rollback stores are gone');
  }
  // Open and idle here: archive, flush, move; no lock (this dsh owns it).
  {
    const t = setup({ agentStatus: 'idle' });
    assert.equal((await t.call({ sessionId: 'chat-a' })).status, 200);
    assert.deepEqual(t.log, [['archive', 'chat-a', { stopActivity: true }], ['flush', 'chat-a'], ['open', 'sub-1', 'write'], ['open', 'sub-2', 'write'], ['close', 'sub-1'], ['close', 'sub-2']]);
  }
  // Refusals keep every file.
  {
    const t = setup();
    assert.equal((await t.call('{bad')).status, 400);
    assert.equal((await t.call({ sessionId: 'nope' })).status, 404);
    const sub = await t.call({ sessionId: 'sub-1' });
    assert.equal(sub.status, 409); assert.match(sub.json.error, /parent/);
    assert.deepEqual(t.log, [], 'nothing archived for a refused request');
    assert.equal(readdirSync(t.sessions).length, 4);
  }
  {
    const t = setup({ ownedElsewhere: true });
    const r = await t.call({ sessionId: 'chat-a' });
    assert.equal(r.status, 409); assert.match(r.json.error, /another dsh/);
    assert.equal(readdirSync(t.sessions).length, 4, 'a chat that another dsh holds stays (archived)');
  }
  {
    const t = setup({ agentStatus: 'stuck' });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 10), ...a); // the 15 s stop wait, shortened
    try {
      const r = await t.call({ sessionId: 'chat-a' });
      assert.equal(r.status, 409); assert.match(r.json.error, /did not stop/);
    } finally { globalThis.setTimeout = realSetTimeout; }
    assert.equal(readdirSync(t.sessions).length, 4);
  }
  // A subagent log that another dsh holds, or a live subagent that does not stop: nothing moves.
  {
    const t = setup({ ownedElsewhere: 'sub-2' });
    const r = await t.call({ sessionId: 'chat-a' });
    assert.equal(r.status, 409); assert.match(r.json.error, /another dsh/);
    assert.equal(readdirSync(t.sessions).length, 4, 'a locked subagent log keeps the whole family in place');
    assert.ok(t.log.filter((e) => e[0] === 'close').length === 2, 'the locks taken so far are released');
  }
  {
    const t = setup({ subStatus: 'stuck' });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 10), ...a);
    try { assert.equal((await t.call({ sessionId: 'chat-a' })).status, 409); } finally { globalThis.setTimeout = realSetTimeout; }
    assert.equal(readdirSync(t.sessions).length, 4, 'a live subagent that does not stop keeps the family in place');
  }
  {
    const t = setup({ subStatus: 'idle' });
    assert.equal((await t.call({ sessionId: 'chat-a' })).status, 200);
    assert.ok(t.log.some((e) => e[0] === 'flush' && e[1] === 'sub-1'), 'a live subagent is flushed before it moves');
  }
  // Two clicks: the second request is refused while the first runs.
  {
    const t = setup();
    const [a, b] = await Promise.all([t.call({ sessionId: 'chat-a' }), t.call({ sessionId: 'chat-a' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  }
  console.log('delete-chat: ok');
} finally { rmSync(root, { recursive: true, force: true }); }
