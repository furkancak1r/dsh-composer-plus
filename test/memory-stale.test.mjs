// Find stale memory notes. Host: `staleCandidates` finds the paths (code spans with "/" or an extension), npm scripts and
// branch names that a note names; `staleNotes` checks them against the project: a path by realpath and lstat (no file is
// read), scripts from package.json (read through head(): only a regular file inside the folder, O_NOFOLLOW | O_NONBLOCK),
// branches from one `git for-each-ref` (no path goes to git). A package.json that is a symlink out of the folder is not read
// (scripts are not checked), a FIFO named package.json does not block (the test ends); a path below a symlinked folder that
// points inside is there; a path below a dangling symlink is missing, and that one path does not fail the other notes; a
// path that leaves the folder is not reported. The route answers for one project memory (its own folder), read-only, 409
// while the switch is off. Client (real client.js, fake React): selecting a project checks it; a stale note shows a warning
// and the dialog a summary; switching the feature off removes them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, MEMORY_STALE_PATH, installMemory, staleCandidates, staleNotes, parseMemory } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memory-stale-'));
try {
  // Candidates.
  assert.deepEqual(staleCandidates('Run `npm run e2e` and npm test; the cart is in `src/cart.ts`, docs in `docs/`'), { paths: ['src/cart.ts', 'docs'], scripts: ['e2e', 'test'], branches: [] });
  assert.deepEqual(staleCandidates('Releases go through the `release/2026` branch; `main` branch is protected').branches, ['release/2026', 'main']);
  assert.deepEqual(staleCandidates('Yayınlar `yayin` dalından çıkar').branches, ['yayin']);
  for (const none of ['See `https://example.com/a.b`', 'Version `1.2.3`', 'Hosts in `/etc/hosts`', 'Up: `../x.ts`', 'Glob `src/*.ts`', '`npm install` first', 'Plain text with no code']) {
    const c = staleCandidates(none);
    assert.deepEqual([...c.paths, ...c.scripts, ...c.branches], [], none);
  }

  // A project with a git repository (the test's own git, if present).
  const web = join(root, 'acme-web');
  await mkdir(join(web, 'src'), { recursive: true }); await mkdir(join(web, 'lib', 'real'), { recursive: true });
  await writeFile(join(web, 'src', 'cart.ts'), 'x'); await writeFile(join(web, 'lib', 'real', 'util.ts'), 'x');
  await writeFile(join(web, 'package.json'), JSON.stringify({ name: 'acme-web', scripts: { test: 'node --test', build: 'vite build' } }));
  await symlink('real', join(web, 'lib', 'linked')); // a symlinked folder inside the project
  await symlink(join(root, 'nowhere'), join(web, 'gone')); // a dangling symlinked folder
  await writeFile(join(root, 'outside.ts'), 'x'); await symlink(join(root, 'outside.ts'), join(web, 'escape.ts')); // a symlink that leaves the folder
  let git = true;
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', web]);
    execFileSync('git', ['-C', web, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    execFileSync('git', ['-C', web, 'branch', 'release/2026']);
  } catch { git = false; }
  const files = [parseMemory([
    '# Memory', '',
    '- The cart is in `src/cart.ts`',
    '- The old checkout was in `src/checkout.ts`',
    '- Helpers live in `lib/linked/util.ts`',
    '- Generated code is in `gone/api.ts`',
    '- Escapes: `escape.ts`',
    '- Run `npm run build`, not `npm run deploy`',
    '- Releases go through the `release/2026` branch',
    '- Hotfixes use the `hotfix/old` branch',
    '- The user likes short answers',
  ].join('\n'))];
  const r = await staleNotes(files, web, {});
  const byText = Object.fromEntries(r.notes.map((n) => [n.text, n.missing.map((m) => `${m.kind}:${m.name}`)]));
  assert.deepEqual(byText, {
    'The old checkout was in `src/checkout.ts`': ['path:src/checkout.ts'],
    'Generated code is in `gone/api.ts`': ['path:gone/api.ts'],
    'Run `npm run build`, not `npm run deploy`': ['script:deploy'],
  }, 'a symlinked folder inside is there; a dangling one is missing; one odd path does not fail the others; a path out of the folder is not reported');
  assert.equal(r.npm, true); assert.equal(r.git, false, 'no subprocess: branches are not checked');
  // Branches through the Host route with dsh's subprocess shape (runGit): the route test below covers it.

  // package.json as a symlink out of the folder: not read, so scripts are not checked.
  const linked = join(root, 'acme-linked'); await mkdir(linked);
  await writeFile(join(root, 'outside.json'), JSON.stringify({ scripts: { deploy: 'x' } }));
  await symlink(join(root, 'outside.json'), join(linked, 'package.json'));
  const l = await staleNotes([parseMemory('# Memory\n\n- Run `npm run deploy`\n')], linked, {});
  assert.equal(l.npm, false, 'a package.json outside the folder is not read'); assert.deepEqual(l.notes, []);
  // A FIFO named package.json: not opened, the check ends at once (a red test ends: a writer opens it after 3 s).
  if (process.platform !== 'win32') {
    const fifoDir = join(root, 'acme-fifo'); await mkdir(fifoDir);
    const fifo = join(fifoDir, 'package.json'); execFileSync('mkfifo', [fifo]);
    const timer = setTimeout(() => { execFileSync('sh', ['-c', `echo '{}' > "${fifo}"`]); }, 3000);
    const t0 = Date.now();
    const f = await staleNotes([parseMemory('# Memory\n\n- Run `npm run deploy`\n')], fifoDir, {});
    clearTimeout(timer);
    assert.ok(Date.now() - t0 < 1000, 'a FIFO does not block'); assert.equal(f.npm, false);
  }
  await assert.rejects(staleNotes(files, join(root, 'no-such-folder'), {}), (e) => e.status === 404);

  // The route (with dsh's subprocess shape for git: argv only, never a shell).
  const routes = new Map();
  const { spawn } = await import('node:child_process');
  const dshSubprocess = {
    resolveExecutable: async () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
    spawn({ argv, cwd, env }) {
      const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
      return { done: new Promise((res) => child.on('close', (code) => res({ exitCode: code, signal: null }))),
        collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err }) } } };
    },
  };
  const ctx = {
    on: () => {}, effect: () => {}, logger: { warn: () => {} }, get: () => undefined, subprocess: dshSubprocess,
    connection: { fetch: { register: (rt) => routes.set(rt.path, rt) } },
    sessionQuery: { observeSession: async () => ({ events: [], header: {} }) },
    inject: () => ({ dispose: () => {} }),
  };
  const mem = installMemory(ctx, join(root, 'home'));
  await mem.ready;
  const call = async (q) => { const res = await routes.get(MEMORY_STALE_PATH).fetch(new Request(`http://h${MEMORY_STALE_PATH}${q}`)); return { status: res.status, body: await res.json() }; };
  assert.equal((await call('?project=x')).status, 409, 'off');
  await routes.get(MEMORY_PATH).fetch(new Request(`http://h${MEMORY_PATH}`, { method: 'POST', body: JSON.stringify({ on: true }) }));
  const s = mem.store.project(web);
  for (const line of files[0].entries) await mem.store.add({ scope: s, text: line.text, actor: 'agent' });
  for (const q of ['', '?project=../x', `?project=${'f'.repeat(32)}`]) assert.equal((await call(q)).status, 404, q);
  const answer = await call(`?project=${s.id}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const got = Object.fromEntries(answer.body.notes.map((n) => [n.text, n.missing.map((m) => `${m.kind}:${m.name}`)]));
  assert.deepEqual(got['The old checkout was in `src/checkout.ts`'], ['path:src/checkout.ts']);
  // A memory whose folder now points elsewhere (a symlink to another folder): another project, 404.
  const moved = join(root, 'acme-moved'); await mkdir(moved);
  const ms = mem.store.project(moved); await mem.store.add({ scope: ms, text: 'Uses `src/a.ts`', actor: 'agent' });
  await rm(moved, { recursive: true }); await symlink(web, moved);
  const mv = await call(`?project=${ms.id}`);
  assert.equal(mv.status, 404); assert.match(mv.body.error, /moved or is gone/);
  if (git) {
    assert.equal(answer.body.git, true);
    assert.deepEqual(got['Hotfixes use the `hotfix/old` branch'], ['branch:hotfix/old'], 'a branch that is gone');
    assert.equal(got['Releases go through the `release/2026` branch'], undefined, 'a branch that is there');
  }

  // Client (real client.js, fake React).
  {
    const memStore = new Map();
    globalThis.localStorage = { getItem: (k) => (memStore.has(k) ? memStore.get(k) : null), setItem: (k, v) => memStore.set(k, String(v)) };
    const id = 'a'.repeat(32);
    const view = { projects: [{ id, name: 'acme-web', path: '/p/acme-web', count: 2, files: [{ topic: null, entries: [{ text: 'The old checkout was in `src/checkout.ts`' }, { text: 'The user likes short answers' }] }] }], global: { count: 0, files: [] } };
    const gets = [];
    globalThis.fetch = async (url) => {
      if (url === '/api/composer-plus.memory') return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-history')) return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-stale')) { gets.push(url); return new Response(JSON.stringify({ project: id, notes: [{ topic: null, text: 'The old checkout was in `src/checkout.ts`', missing: [{ kind: 'path', name: 'src/checkout.ts' }] }], checked: 1, git: true, npm: true }), { status: 200 }); }
      if (url === '/api/composer-plus.memory-edit') return new Response(JSON.stringify({ ...view, busy: null }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
    eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
    let cur;
    const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }),
      useState: (v) => { const i = cur.si++; const st = cur.state; if (!(i in st)) st[i] = v; return [st[i], (x) => { st[i] = typeof x === 'function' ? x(st[i]) : x; }]; },
      useRef: (v) => ({ current: v }),
      // Effects with deps run when the deps change (enough for this check).
      useEffect: (f, deps) => { const i = cur.ei++; const old = cur.deps[i]; if (deps === undefined || old === undefined || deps.some((d, k) => d !== old[k])) { cur.deps[i] = deps ?? []; if (deps !== undefined && deps.length > 0) f(); } },
      useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
    const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', Modal: 'Modal' } : {}));
    const live = new Map(); let next = 0;
    plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
      slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
    await new Promise((res) => setTimeout(res, 20));
    const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
    const section = opts.inject();
    const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
    const all = (node, out = []) => { if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of node.c ?? []) all(c, out); return out; };
    const text = (node) => (typeof node === 'string' ? node : node === null || typeof node !== 'object' ? '' : (node.c ?? []).map(text).join(''));
    const find = (tree, attr) => all(tree).find((n) => n.p?.[attr] !== undefined);
    const settingsInst = { state: [], deps: [] };
    const rows = () => { cur = settingsInst; settingsInst.si = 0; settingsInst.ei = 0; return Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, memoryEditor: section.memoryEditor, memoryHistorySwitch: section.memoryHistorySwitch, t }).c; };
    await section.memory.refresh();
    const row = rows().find((r) => r?.p?.key === 'memoryStale');
    assert.ok(row, 'its own Settings row'); assert.equal(row.c[2].p.checked, true, 'on by default'); assert.equal(row.c[0].p.id, 'memoryStale');
    const editorOf = () => rows().find((r) => r?.p?.key === 'projectMemory').c[1].c.find((c) => c?.t?.name === 'MemoryEditor');
    const inst = { state: [], deps: [] };
    const render = () => { cur = inst; inst.si = 0; inst.ei = 0; const e = editorOf(); return e.t(e.p); };
    render(); // closed: no check
    assert.equal(gets.length, 0, 'the dialog is closed: no check');
    section.memoryEditor.open(); await new Promise((res) => setTimeout(res, 10));
    render();
    assert.equal(gets.length, 0, 'All notes: no check');
    all(render()).find((n) => n.p?.['data-composer-plus-memory-project'] === id).p.onClick();
    render(); await new Promise((res) => setTimeout(res, 10));
    assert.equal(gets.length, 1, 'a project: one check'); assert.match(gets[0], new RegExp(`project=${id}`));
    let tree = render();
    assert.equal(gets.length, 1, 'the same notes: no new check');
    const marks = all(tree).filter((n) => n.p?.['data-composer-plus-memory-stale'] !== undefined);
    assert.equal(marks.length, 1, 'one stale note'); assert.match(text(marks[0]), /memoryStale\.path.*src\/checkout\.ts/);
    assert.match(text(find(tree, 'data-composer-plus-memory-stale-summary')), /memoryStale\.summary.*"count":1/);
    // Off: the warnings go.
    section.setFeature('memoryStale', false);
    tree = render();
    assert.equal(all(tree).filter((n) => n.p?.['data-composer-plus-memory-stale'] !== undefined).length, 0, 'off: no warnings');
    assert.equal(section.memoryEditor.getSnapshot().stale, null);
  }
  console.log('memory stale checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
