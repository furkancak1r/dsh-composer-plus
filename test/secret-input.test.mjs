// Secret input (Host half): the tool `request_secret` waits for the user's answer and returns only a file path; the value
// is in an owner-only file (folder 0700, file 0600) and never in the tool result; later tool results of the same chat get
// `[secret]` in place of the value (other chats keep theirs); the agent's file tools cannot open the secrets folder (the
// real path, rule 12: a symlink to the folder, `..` after a symlinked folder, the real path of a symlinked chat folder);
// one answer per request; a wrong chat or request is 404; files go at the turn end and at start (a FIFO with a value's
// name does not block); the switch is on by default and off removes the tool and the listener and ends waiting asks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRETS_PATH, SECRET_ANSWER_PATH, SECRET_MAX, SECRET_TOOL, installSecrets, maskSecrets, parseSecretAsk } from '../index.js';

// parseSecretAsk
assert.deepEqual(parseSecretAsk({ label: ' GitHub token ', purpose: ' push the tag ' }), { label: 'GitHub token', purpose: 'push the tag' });
assert.deepEqual(parseSecretAsk({ label: 'x' }), { label: 'x', purpose: '' });
for (const bad of [{}, { label: '' }, { label: 'a\nb' }, { label: 'x'.repeat(81) }, { label: 'x', purpose: 'y'.repeat(301) }, { label: 'x', purpose: 'a\0' }]) assert.ok(parseSecretAsk(bad).error, JSON.stringify(bad));

// maskSecrets: exact text in text blocks, longest first; other blocks unchanged; undefined when nothing changed.
assert.deepEqual(maskSecrets([{ type: 'text', text: 'token=abc123 and abc123' }, { type: 'image', data: 'abc123' }], ['abc123']), [{ type: 'text', text: 'token=[secret] and [secret]' }, { type: 'image', data: 'abc123' }]);
assert.deepEqual(maskSecrets([{ type: 'text', text: 'x-abcdef-y' }], ['abc', 'abcdef']), [{ type: 'text', text: 'x-[secret]-y' }], 'longest first');
assert.equal(maskSecrets([{ type: 'text', text: 'nothing' }], ['abc']), undefined);
assert.equal(maskSecrets([{ type: 'text', text: 'abc' }], []), undefined);

const flush = () => new Promise((r) => setTimeout(r, 10));
const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-secrets-')));
try {
  const home = join(root, 'home');
  const dir = join(home, 'storages', 'dsh-composer-plus');
  const folder = join(dir, 'secrets');
  // A leftover file and a FIFO with a value's name from an earlier run: the start sweep removes both without blocking.
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'a'.repeat(32)), 'old value');
  execFileSync('mkfifo', [join(folder, 'b'.repeat(32))]);
  await writeFile(join(folder, 'not-ours.txt'), 'kept');

  const routes = new Map(); const live = { tools: new Map(), on: new Map() }; const hooks = new Map(); const effects = [];
  let disposed = 0;
  const chats = { S: join(root, 'project'), T: join(root, 'other') };
  await mkdir(chats.S, { recursive: true }); await mkdir(chats.T, { recursive: true });
  const ctx = {
    effect: (fn) => effects.push(fn()),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    on: (name, fn) => { hooks.set(name, fn); },
    get: (name) => (name === 'workingDirectory' ? { get: (session) => chats[session.id] } : undefined),
    inject: (deps, setup) => {
      assert.deepEqual(deps, ['tools']);
      const offs = [];
      setup({ tools: { register: (t) => { live.tools.set(t.name, t); offs.push(() => live.tools.delete(t.name)); } },
        on: (name, fn) => { live.on.set(name, fn); offs.push(() => live.on.delete(name)); } });
      return { dispose: () => { disposed++; offs.forEach((f) => f()); } };
    },
  };
  const host = installSecrets(ctx, home);
  await host.ready;
  assert.deepEqual((await readdir(folder)).sort(), ['not-ours.txt'], 'start sweep: our leftovers go (also a FIFO), another name stays');
  const req = async (path, body, query = '') => { const r = await routes.get(path).fetch(new Request(`http://h${path}${query}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  assert.deepEqual((await req(SECRETS_PATH)).body, { on: true }, 'on by default');
  assert.ok(live.tools.has(SECRET_TOOL) && live.on.has('tools/post-execute'));
  const tool = live.tools.get(SECRET_TOOL);
  assert.match(tool.description, /never see the value/);
  assert.ok(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length < 1400, 'small schema');

  // The tool waits; GET lists the open ask (no value); a second ask of the same chat is an error.
  const abort = new AbortController();
  const agent = (id) => ({ id, session: { id } });
  const running = tool.execute({ label: 'Deploy token', purpose: 'deploy to staging' }, { agent: agent('S'), callId: 'call_1', signal: abort.signal });
  await flush();
  const open = (await req(SECRET_ANSWER_PATH, undefined, '?sessionId=S')).body;
  assert.equal(open.asks.length, 1);
  assert.deepEqual({ ...open.asks[0], askId: 'x' }, { askId: 'x', callId: 'call_1', label: 'Deploy token', purpose: 'deploy to staging' });
  assert.deepEqual((await req(SECRET_ANSWER_PATH, undefined, '?sessionId=T')).body.asks, [], 'another chat sees nothing');
  await assert.rejects(tool.execute({ label: 'Second' }, { agent: agent('S'), callId: 'call_2', signal: new AbortController().signal }), /one secret request at a time/);
  await assert.rejects(tool.execute({ label: '' }, { agent: agent('S'), signal: new AbortController().signal }), /label/);
  const askId = open.asks[0].askId;
  // Bad answers: 400; wrong chat: 404.
  for (const bad of [{ sessionId: 'S', askId }, { sessionId: 'S', askId, value: '' }, { sessionId: 'S', askId, value: 'x'.repeat(SECRET_MAX + 1) }, { sessionId: 'S', askId, value: 'a\0b' }, { sessionId: 'S', askId, value: 'v', extra: 1 }, { sessionId: 'S', askId, decline: false }]) {
    assert.equal((await req(SECRET_ANSWER_PATH, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await req(SECRET_ANSWER_PATH, { sessionId: 'T', askId, value: 'v' })).status, 404, 'another chat cannot answer');
  assert.equal((await req(SECRET_ANSWER_PATH, { sessionId: 'S', askId: 'nope', value: 'v' })).status, 404);
  // Save: the tool returns the path, not the value; a second answer finds no request.
  const SECRET = 'ghp_Sup3rS3cretValue-42';
  const [first, second] = await Promise.all([req(SECRET_ANSWER_PATH, { sessionId: 'S', askId, value: SECRET }), req(SECRET_ANSWER_PATH, { sessionId: 'S', askId, value: 'other' })]);
  assert.deepEqual([first.status, second.status].sort(), [200, 404], 'one answer per request');
  const out = await running;
  assert.ok(!out.includes(SECRET), 'the tool result never has the value');
  const path = out.match(/ to (\/\S+) \(owner-only\)/)[1];
  assert.equal(await readFile(path, 'utf8'), SECRET);
  assert.equal((await stat(path)).mode & 0o777, 0o600, 'file 0600');
  assert.equal((await stat(folder)).mode & 0o777, 0o700, 'folder 0700');
  assert.ok((await lstat(folder)).isDirectory());

  // post-execute: a later result of the same chat gets [secret]; another chat's result stays; a `value` decision stays.
  const post = live.on.get('tools/post-execute');
  const r1 = await post({ agent: agent('S'), name: 'bash' }, { content: [{ type: 'text', text: `token is ${SECRET}\n` }] }, async () => ({ kind: 'accept' }));
  assert.deepEqual(r1.content, [{ type: 'text', text: 'token is [secret]\n' }]);
  const r2 = await post({ agent: agent('S'), name: 'bash' }, {}, async () => ({ kind: 'accept', content: [{ type: 'text', text: SECRET }] }));
  assert.deepEqual(r2.content, [{ type: 'text', text: '[secret]' }], 'a content that a later listener gave is masked too');
  const r3 = await post({ agent: agent('T'), name: 'bash' }, { content: [{ type: 'text', text: SECRET }] }, async () => ({ kind: 'accept' }));
  assert.equal(r3.content, undefined, 'another chat: unchanged');
  const block = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] };
  assert.equal(await post({ agent: agent('S'), name: 'bash' }, { content: [] }, async () => block), block);

  // The gate: the agent's file tools cannot open the secrets folder, by any path to it.
  const pre = hooks.get('tools/pre-execute');
  const allow = async () => ({ kind: 'allow' });
  const gate = (name, args, id = 'S') => pre({ name, arguments: args, agent: agent(id) }, allow);
  assert.equal((await gate('read', { file_path: path })).kind, 'deny', 'absolute path');
  assert.equal((await gate('grep', { path: folder })).kind, 'deny', 'the folder');
  assert.equal((await gate('write', { file_path: join(folder, 'new') })).kind, 'deny', 'a new file');
  assert.equal((await gate('str_replace_editor', { command: 'view', path })).kind, 'deny');
  await symlink(folder, join(chats.S, 'vault'));
  assert.equal((await gate('read', { file_path: `vault/${path.split('/').at(-1)}` })).kind, 'deny', 'a symlink to the folder');
  await mkdir(join(dir, 'deep'), { recursive: true });
  await symlink(join(dir, 'deep'), join(chats.S, 'link'));
  assert.equal((await gate('read', { file_path: `link/../secrets/${path.split('/').at(-1)}` })).kind, 'deny', '.. after a symlinked folder');
  assert.equal((await gate('read', { file_path: 'README.md' })).kind, 'allow', 'other files are not touched');
  assert.equal((await gate('bash', { command: `cat ${path}` })).kind, 'allow', 'shell is not a file tool (the docs say so)');
  const denied = { kind: 'deny', reason: 'x' };
  assert.equal(await pre({ name: 'read', arguments: { file_path: path }, agent: agent('S') }, async () => denied), denied, 'an earlier deny stays');

  // The turn end of chat T keeps S's file; S's turn end removes it and the values.
  hooks.get('agent/status')({ agent: { id: 'T' }, status: 'idle' });
  await flush(); assert.equal(await readFile(path, 'utf8'), SECRET);
  hooks.get('agent/status')({ agent: { id: 'S' }, status: 'running' });
  await flush(); assert.equal(await readFile(path, 'utf8'), SECRET, 'still running');
  hooks.get('agent/status')({ agent: { id: 'S' }, status: 'idle' });
  await flush();
  await assert.rejects(readFile(path), /ENOENT/, 'deleted at the turn end');
  const after = await post({ agent: agent('S'), name: 'bash' }, { content: [{ type: 'text', text: SECRET }] }, async () => ({ kind: 'accept' }));
  assert.equal(after.content, undefined, 'values are forgotten with the files');

  // Decline and stop.
  const d = tool.execute({ label: 'Password' }, { agent: agent('S'), callId: 'c3', signal: new AbortController().signal });
  await flush();
  const dId = (await req(SECRET_ANSWER_PATH, undefined, '?sessionId=S')).body.asks[0].askId;
  assert.deepEqual((await req(SECRET_ANSWER_PATH, { sessionId: 'S', askId: dId, decline: true })).body, { declined: true });
  assert.match(await d, /did not give this secret/);
  const stop = new AbortController();
  const s = tool.execute({ label: 'Password' }, { agent: agent('S'), callId: 'c4', signal: stop.signal });
  await flush(); stop.abort();
  assert.match(await s, /stopped before the user answered/);
  assert.deepEqual((await req(SECRET_ANSWER_PATH, undefined, '?sessionId=S')).body.asks, []);

  // Off: the tool and the listener go; a waiting ask ends as declined. On again: both come back.
  const w = tool.execute({ label: 'Password' }, { agent: agent('S'), callId: 'c5', signal: new AbortController().signal });
  await flush();
  for (const bad of [{ on: 'yes' }, { on: true, x: 1 }, {}]) assert.equal((await req(SECRETS_PATH, bad)).status, 400);
  assert.deepEqual((await req(SECRETS_PATH, { on: false })).body, { on: false });
  assert.match(await w, /did not give this secret/);
  assert.equal(live.tools.size + live.on.size, 0, 'off: nothing registered'); assert.ok(disposed >= 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')), { on: false });
  await req(SECRETS_PATH, { on: true });
  assert.ok(live.tools.has(SECRET_TOOL));

  // A folder that is a symlink (someone swapped it in) is refused: no value goes through the link.
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(root, 'elsewhere'));
  await symlink(join(root, 'elsewhere'), folder);
  const x = tool.execute({ label: 'Password' }, { agent: agent('S'), callId: 'c6', signal: new AbortController().signal });
  await flush();
  const xId = (await req(SECRET_ANSWER_PATH, undefined, '?sessionId=S')).body.asks[0].askId;
  const refused = await req(SECRET_ANSWER_PATH, { sessionId: 'S', askId: xId, value: 'v' });
  assert.equal(refused.status, 500);
  assert.deepEqual(await readdir(join(root, 'elsewhere')), [], 'nothing written through the link');
  assert.equal((await req(SECRET_ANSWER_PATH, undefined, '?sessionId=S')).body.asks.length, 1, 'the ask stays open after a failed save');
  await req(SECRET_ANSWER_PATH, { sessionId: 'S', askId: xId, decline: true }); await x;

  // Unload: the fiber goes.
  const before = disposed; effects.forEach((f) => typeof f === 'function' && f()); assert.ok(disposed > before, 'unload disposes');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('secret input checks passed');
