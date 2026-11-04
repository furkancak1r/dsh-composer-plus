// Export memory to AGENTS.md. Host: the section (MEMORY.md notes, then a `###` part per topic; no global notes, sources or
// dates) goes between the markers, or at the end of the file; broken markers are refused. A preview writes nothing; Apply
// writes once, only while AGENTS.md and the notes are as they were (else 409). The folder comes from the memory's own
// project.json, and its real path must still give the memory's id. AGENTS.md is read and written only as a regular file
// inside the folder: a symlink out of the folder or a dangling one is refused, a symlink inside is followed, a FIFO is
// refused at once (the test ends), the folder may be a symlinked path (/var → /private/var on macOS). When the last change
// (the rename) fails, AGENTS.md stays as it was and no temp file stays. One memory action at a time (409 busy).
// Client (real client.js, fake React): Export shows the diff, Write runs once; a second action while it runs does nothing;
// switching the feature off drops the preview and the button.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, rename, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, MEMORY_EDIT_PATH, MEMORY_EXPORT_PATH, MEMORY_EXPORT_BEGIN, MEMORY_EXPORT_END, installMemory, exportSection, withExportSection, parseMemory } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memory-export-')); // a symlinked path on macOS
try {
  // Pure parts.
  {
    const files = [parseMemory('# Memory\n\n- Run tests with `npm test` [source: session-1 #3; added: 2026-11-01]\n\n## Index\n- [[deploy]]\n'), { ...parseMemory('# deploy\n\n- Tag first [added: 2026-11-02]\n'), topic: 'deploy' }];
    const section = exportSection(files);
    assert.equal(section, `${MEMORY_EXPORT_BEGIN}\n## Project memory (Composer Plus)\n\n- Run tests with \`npm test\`\n\n### deploy\n\n- Tag first\n${MEMORY_EXPORT_END}`);
    assert.equal(withExportSection(null, 'S'), 'S\n', 'a new file');
    assert.equal(withExportSection('# Rules\n\n- one\n\n\n', 'S'), '# Rules\n\n- one\n\nS\n', 'added at the end');
    assert.equal(withExportSection(`# Rules\n${MEMORY_EXPORT_BEGIN}\nold\n${MEMORY_EXPORT_END}\ntail\n`, 'S'), '# Rules\nS\ntail\n', 'replaced in place');
    for (const broken of [`${MEMORY_EXPORT_BEGIN}\n`, `${MEMORY_EXPORT_END}\n${MEMORY_EXPORT_BEGIN}\n`, `${MEMORY_EXPORT_BEGIN}${MEMORY_EXPORT_BEGIN}${MEMORY_EXPORT_END}`]) {
      assert.throws(() => withExportSection(broken, 'S'), /markers .* are broken/);
    }
  }

  const routes = new Map();
  const ctx = {
    on: () => {}, effect: () => {}, logger: { warn: () => {} },
    get: () => undefined,
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionQuery: { observeSession: async () => ({ events: [], header: {} }) },
    inject: () => ({ dispose: () => {} }),
  };
  const home = join(root, 'home');
  const mem = installMemory(ctx, home);
  await mem.ready;
  const call = async (path, body) => {
    const r = await routes.get(path).fetch(new Request(`http://h${path}`, body === undefined ? undefined : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call(MEMORY_EXPORT_PATH, { preview: { project: 'a'.repeat(32) } })).status, 409, 'off: no export');
  await call(MEMORY_PATH, { on: true });
  const { store } = mem;
  const project = async (name) => { const dir = join(root, name); await mkdir(dir, { recursive: true }); const s = store.project(dir); await store.add({ scope: s, text: `The ${name} tests run with npm test`, actor: 'agent' }); return { dir, s }; };
  const { dir: shop, s } = await project('acme-shop');
  await store.add({ scope: s, topic: 'deploy', text: 'Releases need a git tag first', actor: 'agent' });
  await store.add({ scope: store.GLOBAL, text: 'The user writes in Turkish', actor: 'agent' });
  for (const bad of [{}, { preview: {} }, { preview: { project: '../x' } }, { preview: { project: s.id, x: 1 } }, { apply: 5 }, 'nope']) {
    assert.equal((await call(MEMORY_EXPORT_PATH, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(MEMORY_EXPORT_PATH, { preview: { project: 'f'.repeat(32) } })).status, 404);
  // No AGENTS.md: the preview makes it (a diff from nothing); nothing is written yet.
  const p1 = await call(MEMORY_EXPORT_PATH, { preview: { project: s.id } });
  assert.equal(p1.status, 200); assert.equal(p1.body.created, true);
  assert.match(p1.body.patch, /^\+- The acme-shop tests run with npm test$/m); assert.match(p1.body.patch, /^\+### deploy$/m);
  assert.doesNotMatch(p1.body.patch, /Turkish|source|added/, 'no global notes, sources or dates');
  assert.deepEqual((await readdir(shop)).filter((f) => f === 'AGENTS.md'), [], 'a preview writes nothing');
  assert.equal((await call(MEMORY_EXPORT_PATH, { apply: p1.body.id })).status, 200);
  const made = await readFile(join(shop, 'AGENTS.md'), 'utf8');
  assert.ok(made.startsWith(MEMORY_EXPORT_BEGIN));
  assert.equal((await call(MEMORY_EXPORT_PATH, { apply: p1.body.id })).status, 410, 'a preview writes once');
  // The same notes again: no change, no id.
  const same = await call(MEMORY_EXPORT_PATH, { preview: { project: s.id } });
  assert.equal(same.body.id, null); assert.equal(same.body.patch, '');
  // A file with the user's own text: the section is replaced in place, the rest stays.
  await writeFile(join(shop, 'AGENTS.md'), `# Team rules\n\nUse tabs.\n\n${made}\n## Later rules\n\nNo force push.\n`);
  await store.add({ scope: s, text: 'The shop uses Stripe for payments', actor: 'agent' });
  const p2 = await call(MEMORY_EXPORT_PATH, { preview: { project: s.id } });
  assert.match(p2.body.patch, /^\+- The shop uses Stripe for payments$/m);
  assert.doesNotMatch(p2.body.patch, /^[-+].*(Use tabs|No force push)/m, 'the rest of the file does not change');
  // AGENTS.md changed after the preview: 409, nothing written.
  const edited = `${await readFile(join(shop, 'AGENTS.md'), 'utf8')}\nOne more line by hand.\n`;
  await writeFile(join(shop, 'AGENTS.md'), edited);
  const stale = await call(MEMORY_EXPORT_PATH, { apply: p2.body.id });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /changed after the preview/);
  assert.equal(await readFile(join(shop, 'AGENTS.md'), 'utf8'), edited);
  // The notes changed after the preview: 409.
  const p3 = await call(MEMORY_EXPORT_PATH, { preview: { project: s.id } });
  await store.add({ scope: s, text: 'The shop ships on Fridays', actor: 'review' });
  assert.equal((await call(MEMORY_EXPORT_PATH, { apply: p3.body.id })).status, 409);
  assert.equal(await readFile(join(shop, 'AGENTS.md'), 'utf8'), edited);
  const p4 = await call(MEMORY_EXPORT_PATH, { preview: { project: s.id } });
  assert.equal((await call(MEMORY_EXPORT_PATH, { apply: p4.body.id })).status, 200);
  const written = await readFile(join(shop, 'AGENTS.md'), 'utf8');
  assert.match(written, /^# Team rules\n\nUse tabs\./); assert.match(written, /No force push\.\n\nOne more line by hand\.\n$/); assert.match(written, /ships on Fridays/);
  // Broken markers: refused.
  await writeFile(join(shop, 'AGENTS.md'), `${written}\n${MEMORY_EXPORT_END}\n`);
  const broken = await call(MEMORY_EXPORT_PATH, { preview: { project: s.id } });
  assert.equal(broken.status, 409); assert.match(broken.body.error, /markers .* are broken/);
  await writeFile(join(shop, 'AGENTS.md'), written);
  // The last change (the rename) fails: a read-only folder. AGENTS.md as it was, no temp file.
  if (process.getuid?.() !== 0) {
    await store.add({ scope: s, text: 'The shop has a staging site', actor: 'agent' });
    const p5 = await call(MEMORY_EXPORT_PATH, { preview: { project: s.id } });
    await chmod(shop, 0o500);
    let denied;
    try { denied = await call(MEMORY_EXPORT_PATH, { apply: p5.body.id }); } finally { await chmod(shop, 0o700); }
    assert.equal(denied.status, 500); assert.match(denied.body.error, /AGENTS\.md was not changed/);
    assert.equal(await readFile(join(shop, 'AGENTS.md'), 'utf8'), written);
    assert.deepEqual((await readdir(shop)).filter((f) => f.includes('tmp')), []);
  }
  // A symlink to a file outside the folder: refused; the outside file is not read or changed.
  const outside = join(root, 'outside.md'); await writeFile(outside, 'SECRET outside\n');
  const { dir: linked, s: ls } = await project('acme-linked');
  await symlink(outside, join(linked, 'AGENTS.md'));
  const out = await call(MEMORY_EXPORT_PATH, { preview: { project: ls.id } });
  assert.equal(out.status, 409); assert.match(out.body.error, /outside the project folder/); assert.doesNotMatch(JSON.stringify(out.body), /SECRET/);
  assert.equal(await readFile(outside, 'utf8'), 'SECRET outside\n');
  // A symlink inside the folder: its target is written, the link stays.
  const { dir: inside, s: is } = await project('acme-inside');
  await mkdir(join(inside, 'docs')); await writeFile(join(inside, 'docs', 'agents.md'), '# Shared\n'); await symlink('docs/agents.md', join(inside, 'AGENTS.md'));
  const pin = await call(MEMORY_EXPORT_PATH, { preview: { project: is.id } });
  assert.equal((await call(MEMORY_EXPORT_PATH, { apply: pin.body.id })).status, 200);
  assert.match(await readFile(join(inside, 'docs', 'agents.md'), 'utf8'), /^# Shared\n\n<!-- BEGIN COMPOSER PLUS MEMORY/);
  // A dangling symlink: refused, nothing made.
  const { dir: dangling, s: ds } = await project('acme-dangling');
  await symlink(join(root, 'nowhere.md'), join(dangling, 'AGENTS.md'));
  assert.match((await call(MEMORY_EXPORT_PATH, { preview: { project: ds.id } })).body.error, /points nowhere/);
  // A FIFO named AGENTS.md: refused at once (a red test ends: a writer opens it after 3 s).
  if (process.platform !== 'win32') {
    const { dir: fifoDir, s: fs2 } = await project('acme-fifo');
    const fifo = join(fifoDir, 'AGENTS.md'); execFileSync('mkfifo', [fifo]);
    const timer = setTimeout(() => { execFileSync('sh', ['-c', `echo x > "${fifo}"`]); }, 3000);
    const t0 = Date.now();
    const r = await call(MEMORY_EXPORT_PATH, { preview: { project: fs2.id } });
    clearTimeout(timer);
    assert.equal(r.status, 409); assert.match(r.body.error, /not a regular file/); assert.ok(Date.now() - t0 < 1000, 'a FIFO does not block');
  }
  // A folder that moved (its path now holds another folder): refused.
  const { dir: moved, s: ms } = await project('acme-moved');
  await rename(moved, `${moved}-old`); await mkdir(moved);
  assert.equal(await realpath(moved) !== undefined, true);
  // Same real path → same id: still this project. A folder replaced by a symlink to another place is another project.
  await rm(moved, { recursive: true }); await symlink(join(root, 'acme-shop'), moved);
  const mv = await call(MEMORY_EXPORT_PATH, { preview: { project: ms.id } });
  assert.equal(mv.status, 404); assert.match(mv.body.error, /moved or is gone/);
  // One memory action at a time: an export while a preview of Open memory runs → 409 busy.
  let release; const hold = new Promise((r) => { release = r; });
  const slow = { prepareCall: async (route) => ({ config: route, async *stream() { await hold; yield { type: 'text-delta', text: '{"changes":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  ctx.get = (n) => (n === 'llm' ? slow : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'demo', model: 'm' }) } : undefined);
  const running = call(MEMORY_EDIT_PATH, { preview: { project: s.id, text: 'x' } });
  await new Promise((r) => setTimeout(r, 20));
  const busy = await call(MEMORY_EXPORT_PATH, { preview: { project: s.id } });
  assert.equal(busy.status, 409); assert.equal(busy.body.busy, 'preview');
  release(); await running;

  // Client (real client.js, fake React).
  {
    const memStore = new Map();
    globalThis.localStorage = { getItem: (k) => (memStore.has(k) ? memStore.get(k) : null), setItem: (k, v) => memStore.set(k, String(v)) };
    const id = 'a'.repeat(32);
    const view = { projects: [{ id, name: 'acme-shop', path: '/p/acme-shop', count: 1, files: [{ topic: null, entries: [{ text: 'The user uses pnpm' }] }] }], global: { count: 0, files: [] } };
    const posts = []; let gate; let applyError;
    globalThis.fetch = async (url, init) => {
      if (url === '/api/composer-plus.memory') return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-history')) return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url === '/api/composer-plus.memory-export') {
        const body = JSON.parse(init.body); posts.push(body);
        if (gate) await gate;
        if (body.preview) return new Response(JSON.stringify({ id: 'e1', file: 'AGENTS.md', created: false, patch: '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,2 @@\n # Rules\n+- The user uses pnpm\n', truncated: false }), { status: 200 });
        if (applyError) return new Response(JSON.stringify({ error: applyError.text }), { status: applyError.status });
        return new Response(JSON.stringify({ written: 'AGENTS.md' }), { status: 200 });
      }
      if (url === '/api/composer-plus.memory-edit') {
        if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ...view, id: null, changes: [] }), { status: 200 }); }
        return new Response(JSON.stringify({ ...view, busy: null }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
    eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
    let cur;
    const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }),
      useState: (v) => { const i = cur.si++; const st = cur.state; if (!(i in st)) st[i] = v; return [st[i], (x) => { st[i] = typeof x === 'function' ? x(st[i]) : x; }]; },
      useRef: (v) => ({ current: v }), useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
    const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', Modal: 'Modal' } : {}));
    const live = new Map(); let next = 0;
    plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
      slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
    await new Promise((r) => setTimeout(r, 20));
    const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
    const section = opts.inject();
    const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
    const drawn = (node) => (typeof node?.t === 'function' && ['MemoryHistory', 'MemoryDiff'].includes(node.t.name) ? node.t(node.p) : node);
    const all = (node, out = []) => { node = drawn(node); if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of node.c ?? []) all(c, out); return out; };
    const text = (node) => { node = drawn(node); return typeof node === 'string' ? node : node === null || typeof node !== 'object' ? '' : (node.c ?? []).map(text).join(''); };
    const find = (tree, attr) => all(tree).find((n) => n.p?.[attr] !== undefined);
    const settingsInst = { state: [] };
    const rows = () => { cur = settingsInst; settingsInst.si = 0; return Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, memoryEditor: section.memoryEditor, memoryHistorySwitch: section.memoryHistorySwitch, t }).c; };
    await section.memory.refresh();
    const row = rows().find((r) => r?.p?.key === 'memoryExport');
    assert.ok(row, 'its own Settings row'); assert.equal(row.c[2].p.checked, true, 'on by default'); assert.equal(row.c[0].p.id, 'memoryExport');
    const editorOf = () => rows().find((r) => r?.p?.key === 'projectMemory').c[1].c.find((c) => c?.t?.name === 'MemoryEditor');
    const inst = { state: [] };
    const render = () => { cur = inst; inst.si = 0; const e = editorOf(); return e.t(e.p); };
    section.memoryEditor.open(); await new Promise((r) => setTimeout(r, 10));
    let tree = render();
    assert.equal(find(tree, 'data-composer-plus-memory-export'), undefined, 'All notes: no export');
    all(tree).find((n) => n.p?.['data-composer-plus-memory-project'] === id).p.onClick();
    tree = render();
    find(tree, 'data-composer-plus-memory-export').p.onClick(); await new Promise((r) => setTimeout(r, 10));
    tree = render();
    assert.match(text(find(tree, 'data-composer-plus-memory-export-preview')), /\+- The user uses pnpm/);
    // Write once; a second Write, a Preview, a History and an Export while it runs do nothing.
    let releaseGate; gate = new Promise((r) => { releaseGate = r; });
    const writing = find(tree, 'data-composer-plus-memory-export-apply').p.onClick();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(find(render(), 'data-composer-plus-memory-export-apply').p.disabled, true);
    assert.equal(await section.memoryEditor.exportApply(), false);
    assert.equal(await section.memoryEditor.exportPreview(id), false);
    assert.equal(await section.memoryEditor.preview(id, 'x'), false);
    assert.equal(await section.memoryEditor.openHistory(id), false);
    section.memoryEditor.exportDiscard();
    assert.notEqual(section.memoryEditor.getSnapshot().exported, null, 'the preview stays while it writes');
    releaseGate(); gate = undefined; await writing;
    assert.deepEqual(posts.map((b) => Object.keys(b)[0]), ['preview', 'apply'], 'one preview, one write');
    assert.match(text(render()), /memoryExport\.done/);
    // A refused write (409): the reason stays, the preview goes.
    await section.memoryEditor.exportPreview(id);
    applyError = { status: 409, text: 'AGENTS.md changed after the preview; preview again' };
    assert.equal(await section.memoryEditor.exportApply(), false);
    assert.equal(section.memoryEditor.getSnapshot().exported, null); assert.match(section.memoryEditor.getSnapshot().error, /changed after the preview/);
    applyError = undefined;
    // Off: the preview and the button go.
    await section.memoryEditor.exportPreview(id);
    section.setFeature('memoryExport', false);
    assert.equal(section.memoryEditor.getSnapshot().exported, null, 'off: the preview goes');
    assert.equal(find(render(), 'data-composer-plus-memory-export'), undefined, 'off: no button');
  }
  console.log('memory export checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
