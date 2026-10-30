// Protected files (Host half): a tools/pre-execute gate, after the other gates, denies dsh's file tools (read, read_image,
// grep with a file path, write, edit, str_replace_editor) for paths that match the user's patterns. Defaults: .env*, *.pem,
// *.key (read and write). "write only" lets reads through. A symlink to a protected file is protected; a pattern without
// "/" matches the name at any depth; the switch and the list are kept by the Host (owner-only file); bad lists are refused.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProtectedFiles, parsePatterns, protectedBy, protectedHit, protectGlob, PROTECTED_PATH, PROTECT_DEFAULTS } from '../index.js';

// Patterns: name at any depth, folder globs, case, dot files, "write only".
const D = PROTECT_DEFAULTS;
for (const [path, hit] of [['.env', '.env*'], ['.env.production', '.env*'], ['apps/web/.env.local', '.env*'], ['certs/server.pem', '*.pem'], ['.hidden.pem', '*.pem'],
  ['keys/ID.KEY', '*.key'], ['x.env', undefined], ['src/env.ts', undefined], ['README.md', undefined], ['keys.txt', undefined]]) {
  assert.equal(protectedBy(D, path, false)?.pattern, hit, path);
}
const own = [{ pattern: 'published/**', mode: 'write' }, { pattern: 'config/*.yml', mode: 'all' }, { pattern: '**/secrets/?.txt', mode: 'all' }];
assert.equal(protectedBy(own, 'published/a/b.md', false), undefined, 'write only: a read passes');
assert.equal(protectedBy(own, 'published/a/b.md', true)?.pattern, 'published/**');
assert.equal(protectedBy(own, 'config/app.yml', false)?.pattern, 'config/*.yml');
assert.equal(protectedBy(own, 'config/deep/app.yml', false), undefined, '* stops at /');
assert.equal(protectedBy(own, 'a/b/secrets/k.txt', false)?.pattern, '**/secrets/?.txt'); assert.equal(protectedBy(own, 'secrets/k.txt', false)?.pattern, '**/secrets/?.txt');
assert.equal(protectedBy([{ pattern: 'a+b(1).txt', mode: 'all' }], 'a+b(1).txt', false)?.pattern, 'a+b(1).txt', 'regex characters are text');

// parsePatterns: trimmed, de-duplicated; refused when not valid.
assert.deepEqual(parsePatterns([{ pattern: ' .env* ', mode: 'all' }, { pattern: '.env*', mode: 'write' }, { pattern: 'dist/**', mode: 'write' }]), [{ pattern: '.env*', mode: 'all' }, { pattern: 'dist/**', mode: 'write' }]);
assert.deepEqual(parsePatterns([]), []);
// Review finding P3-1: `./.env` is `.env`, a folder (`secrets/`) is everything in it, `\\` is `/`.
assert.deepEqual(parsePatterns([{ pattern: './.env', mode: 'all' }, { pattern: 'secrets/', mode: 'all' }, { pattern: 'a\\b/', mode: 'write' }]),
  [{ pattern: '.env', mode: 'all' }, { pattern: 'secrets/**', mode: 'all' }, { pattern: 'a/b/**', mode: 'write' }]);
assert.equal(protectedBy(parsePatterns([{ pattern: 'secrets/', mode: 'all' }]), 'secrets/db.txt', false)?.pattern, 'secrets/**');
for (const bad of ['/', './', 'C:\\x', 'a\\..\\b']) assert.equal(parsePatterns([{ pattern: bad, mode: 'all' }]), undefined, bad);
// Review finding P2-1: a model-chosen file name never makes the match slow (the gate runs in the Host event loop).
{ const t0 = Date.now(); protectGlob('*a'.repeat(30) + 'c', 'a'.repeat(255)); protectGlob('*'.repeat(200), 'a/'.repeat(120));
  protectedBy([{ pattern: '*a*a*a*a*b', mode: 'all' }], 'a'.repeat(255), false); assert.ok(Date.now() - t0 < 200, `fast: ${Date.now() - t0} ms`); }
assert.equal(protectGlob('**/x', 'x'), true); assert.equal(protectGlob('**/x', 'a/b/x'), true); assert.equal(protectGlob('**/x', 'ax'), false); assert.equal(protectGlob('a/**', 'a/'), true);
for (const bad of [null, 'x', {}, [{ pattern: '' , mode: 'all' }], [{ pattern: '/etc/passwd', mode: 'all' }], [{ pattern: '../x', mode: 'all' }], [{ pattern: 'a/../b', mode: 'all' }],
  [{ pattern: 'a\0', mode: 'all' }], [{ pattern: 'x', mode: 'read' }], [{ pattern: 'x', mode: 'all', extra: 1 }], [{ pattern: 'x'.repeat(201), mode: 'all' }],
  Array.from({ length: 51 }, (_, i) => ({ pattern: `p${i}`, mode: 'all' }))]) assert.equal(parsePatterns(bad), undefined, JSON.stringify(bad)?.slice(0, 60));

const root = await mkdtemp(join(tmpdir(), 'cp-protected-'));
try {
  const project = join(root, 'acme');
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, '.env'), 'TOKEN=x'); await writeFile(join(project, 'src', 'app.ts'), 'x');
  await symlink(join(project, '.env'), join(project, 'src', 'settings.txt')); // a harmless name for a secret
  await writeFile(join(root, 'outside.pem'), 'x'); await symlink(join(root, 'outside.pem'), join(project, 'cert.txt'));
  // protectedHit: tool arguments, relative and absolute paths, a symlink by its target, a path outside by its name.
  assert.deepEqual(await protectedHit(D, 'read', { file_path: '.env' }, project), { path: '.env', pattern: '.env*' });
  assert.deepEqual(await protectedHit(D, 'read', { file_path: join(project, '.env') }, project), { path: join(project, '.env'), pattern: '.env*' });
  assert.deepEqual(await protectedHit(D, 'read', { file_path: 'src/settings.txt' }, project), { path: 'src/settings.txt', pattern: '.env*' }, 'a symlink to .env');
  assert.deepEqual(await protectedHit(D, 'read', { file_path: 'cert.txt' }, project), { path: 'cert.txt', pattern: '*.pem' }, 'a symlink out of the folder: by the target name');
  assert.deepEqual(await protectedHit(D, 'read', { file_path: join(root, 'outside.pem') }, project), { path: join(root, 'outside.pem'), pattern: '*.pem' });
  assert.deepEqual(await protectedHit(D, 'write', { file_path: 'new.key', content: 'x' }, project), { path: 'new.key', pattern: '*.key' }, 'a new file');
  assert.deepEqual(await protectedHit(D, 'grep', { pattern: 'TOKEN', path: '.env' }, project), { path: '.env', pattern: '.env*' });
  assert.deepEqual(await protectedHit(D, 'str_replace_editor', { command: 'view', path: join(project, '.env') }, project), { path: join(project, '.env'), pattern: '.env*' });
  assert.equal(await protectedHit(D, 'grep', { pattern: 'TOKEN' }, project), undefined, 'a folder search is not covered (README limit)');
  assert.equal(await protectedHit(D, 'glob', { pattern: '.env*' }, project), undefined, 'glob lists names only');
  assert.equal(await protectedHit(D, 'bash', { command: 'cat .env' }, project), undefined, 'bash is not covered (README limit)');
  assert.equal(await protectedHit(D, 'read', { file_path: 'src/app.ts' }, project), undefined);
  assert.equal(await protectedHit(D, 'read', { file_path: '.env' }, 'relative'), undefined, 'no absolute folder: nothing to resolve');
  const writeOnly = [{ pattern: 'src/**', mode: 'write' }];
  assert.equal(await protectedHit(writeOnly, 'read', { file_path: 'src/app.ts' }, project), undefined);
  assert.equal(await protectedHit(writeOnly, 'str_replace_editor', { command: 'view', path: join(project, 'src/app.ts') }, project), undefined, 'view reads');
  assert.ok(await protectedHit(writeOnly, 'edit', { file_path: 'src/app.ts' }, project));
  assert.ok(await protectedHit(writeOnly, 'str_replace_editor', { command: 'str_replace', path: join(project, 'src/app.ts') }, project));
  // Review finding F-01 (2026-10-30): the path that dsh's file tools use (the realpath of <cwd>/<path> with `..` after a
  // link, and for a new file the nearest existing folder), not only the path as text.
  {
    await mkdir(join(project, 'published'), { recursive: true }); await mkdir(join(project, 'config', 'deep'), { recursive: true });
    await writeFile(join(project, 'published', 'old.md'), 'x'); await writeFile(join(project, 'config', 'app.yml'), 'SECRET');
    await symlink(join(project, 'published'), join(project, 'alias'));
    await symlink(join(project, 'config', 'deep'), join(project, 'src', 'link'));
    await symlink(join(project, 'missing'), join(project, 'ghost'));
    await symlink(project, join(root, 'acme-link'));
    const folders = [{ pattern: 'published/**', mode: 'write' }, { pattern: 'config/*.yml', mode: 'all' }, ...D];
    const hit = async (name, path, cwd = project) => (await protectedHit(folders, name, { [name === 'grep' ? 'path' : 'file_path']: path, content: 'x' }, cwd))?.pattern;
    assert.equal(await hit('write', 'alias/new.md'), 'published/**', 'a new file below a symlinked folder');
    assert.equal(await hit('write', 'alias/a/b/new.md'), 'published/**', 'new folders below a symlinked folder');
    assert.equal(await hit('write', 'src/link/../new.yml'), 'config/*.yml', '.. after a symlinked folder: a new file');
    assert.equal(await hit('read', 'src/link/../app.yml'), 'config/*.yml', '.. after a symlinked folder: an existing file');
    assert.equal(await hit('grep', 'src/link/../app.yml'), 'config/*.yml', 'grep too');
    assert.equal(await hit('write', join(await realpath(project), 'published', 'new.md'), join(root, 'acme-link')), 'published/**', 'the real path while the chat folder is a symlinked path');
    // Unchanged answers.
    assert.equal(await hit('write', 'published/new.md'), 'published/**');
    assert.equal(await hit('read', 'published/old.md'), undefined, 'write only: a read passes');
    assert.equal(await hit('write', 'src/new.md'), undefined);
    assert.equal(await hit('write', 'ghost/x.md'), undefined, 'below a dangling link (dsh cannot write there)');
    assert.equal(await hit('read', 'src/link/../../.env'), '.env*');
  }

  // The gate and the route, with fake dsh services.
  const home = join(root, 'home');
  const file = join(home, 'storages/dsh-composer-plus/protected-files.json');
  const listeners = []; const routes = new Map();
  let folder = project;
  installProtectedFiles({
    on: (name, fn) => listeners.push([name, fn]), get: (name) => (name === 'workingDirectory' ? { get: () => folder } : undefined),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  }, home, file);
  const gate = listeners.find(([n]) => n === 'tools/pre-execute')[1];
  const run = (name, args, downstream = { kind: 'allow' }) => gate({ name, arguments: JSON.stringify(args), agent: { session: { header: { cwd: '/elsewhere' } } } }, async () => downstream);
  let d = await run('read', { file_path: '.env' });
  assert.equal(d.kind, 'deny'); assert.match(d.reason, /^Protected file: \.env matches "\.env\*"/); assert.match(d.reason, /ask the user/);
  assert.deepEqual(await run('read', { file_path: 'src/app.ts' }), { kind: 'allow' });
  assert.deepEqual(await run('bash', { command: 'cat .env' }), { kind: 'allow' });
  assert.deepEqual(await run('read', { file_path: '.env' }, { kind: 'deny', reason: 'approval' }), { kind: 'deny', reason: 'approval' }, 'another gate decides first');
  // Review finding P3-2: a call that would ask the user is refused too (no approval card for a protected file).
  assert.equal((await run('write', { file_path: '.env' }, { kind: 'ask' })).kind, 'deny');
  assert.deepEqual(await run('write', { file_path: 'src/app.ts' }, { kind: 'ask' }), { kind: 'ask' }, 'another file still asks');
  assert.deepEqual(await run('read', { file_path: '.env' }, { kind: 'cancel' }), { kind: 'cancel' });
  folder = undefined; // no working-directory service answer: the session's own folder
  assert.deepEqual(await gate({ name: 'read', arguments: { file_path: '.env' }, agent: { session: { header: { cwd: project } } } }, async () => ({ kind: 'allow' })).then((x) => x.kind), 'deny', 'object arguments and the header folder');
  folder = project;

  const call = async (method, body) => {
    const r = await routes.get(PROTECTED_PATH).fetch(new Request(`http://h${PROTECTED_PATH}`, method === 'GET' ? {} : { method, body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, data: await r.json() };
  };
  let r = await call('GET');
  assert.deepEqual(r.data, { on: true, patterns: D.map((p) => ({ ...p })), defaults: D.map((p) => ({ ...p })) }, 'on with the defaults');
  for (const body of ['nope', 'null', '[]', {}, { on: 'yes' }, { patterns: 'x' }, { patterns: [{ pattern: '/abs', mode: 'all' }] }, { on: true, patterns: [] }]) assert.equal((await call('POST', body)).status, 400, JSON.stringify(body));
  r = await call('POST', { patterns: [{ pattern: 'published/**', mode: 'write' }] });
  assert.deepEqual(r.data.patterns, [{ pattern: 'published/**', mode: 'write' }]);
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'owner-only');
  assert.deepEqual(await run('read', { file_path: '.env' }), { kind: 'allow' }, 'the new list applies at once');
  assert.equal((await run('write', { file_path: 'published/post.md', content: 'x' })).kind, 'deny');
  assert.equal((await run('write', { file_path: 'alias/post.md', content: 'x' })).kind, 'deny', 'F-01: through a symlinked folder');
  r = await call('POST', { patterns: [] }); assert.deepEqual(r.data.patterns, []);
  assert.deepEqual(await run('write', { file_path: 'published/post.md' }), { kind: 'allow' }, 'an empty list protects nothing');
  await call('POST', { patterns: D });
  r = await call('POST', { on: false }); assert.equal(r.data.on, false);
  assert.deepEqual(await run('read', { file_path: '.env' }), { kind: 'allow' }, 'switched off');
  await call('POST', { on: true });
  assert.equal((await run('read', { file_path: '.env' })).kind, 'deny', 'switched on again');
  // A broken file reads as on with the defaults.
  await writeFile(file, '{"on": true, "patterns": [{"pattern": "/abs", "mode": "all"}]}');
  const again = new Map();
  installProtectedFiles({ on() {}, get() {}, connection: { fetch: { register: (x) => again.set(x.path, x) } } }, home, file);
  assert.deepEqual((await (await again.get(PROTECTED_PATH).fetch(new Request(`http://h${PROTECTED_PATH}`))).json()).patterns, D.map((p) => ({ ...p })));
} finally { await rm(root, { recursive: true, force: true }); }
console.log('protected files checks passed');
