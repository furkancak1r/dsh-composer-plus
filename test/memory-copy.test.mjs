// Copy memory to another project. Host: GET lists dsh's projects (workspaceRegistry) A–Z with their memory's note count;
// POST copies the picked notes into the target project's memory, all or none (one batch): a note the target already has is
// skipped, topic and source go with each note, the journal actor is `copy`. When the last note does not fit (a full
// MEMORY.md), nothing is copied and the answer gives the reason. The target is a dsh project id (never a path); the same
// project, an unknown project, a note that is gone and a bad body are refused. One memory action at a time (409 busy).
// Client (real client.js, fake React): Copy to project shows checkboxes and the projects; the search filters them (case and
// accents ignored) and Enter picks the first match; one copy at a time from every entry point; switching off drops it.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, MEMORY_EDIT_PATH, MEMORY_COPY_PATH, installMemory } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memory-copy-'));
try {
  const web = join(root, 'acme-web'); const api = join(root, 'acme-api'); const blog = join(root, 'Ácme-blog');
  for (const d of [web, api, blog]) await mkdir(d);
  const workspaces = [{ id: 'w-web', path: web, title: 'acme-web' }, { id: 'w-api', path: api, title: 'acme-api' }, { id: 'w-blog', path: blog, title: 'Ácme-blog' }];
  const routes = new Map();
  const ctx = {
    on: () => {}, effect: () => {}, logger: { warn: () => {} },
    get: (name) => (name === 'workspaceRegistry' ? { list: () => workspaces } : undefined),
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
  assert.equal((await call(MEMORY_COPY_PATH)).status, 409, 'off: no copy');
  await call(MEMORY_PATH, { on: true });
  const { store } = mem;
  const w = store.project(web); const a = store.project(api);
  await store.add({ scope: w, text: 'Run the tests with npm test', meta: { source: 'session-abc #4' }, actor: 'agent' });
  await store.add({ scope: w, text: 'Use tabs in TypeScript files', actor: 'agent' });
  await store.add({ scope: w, topic: 'deploy', text: 'Releases need a git tag first', actor: 'agent' });
  await store.add({ scope: a, text: 'Use tabs in TypeScript files', actor: 'agent' });
  const listed = (await call(MEMORY_COPY_PATH)).body.projects;
  assert.deepEqual(listed.map((p) => [p.title, p.count]), [['acme-api', 1], ['Ácme-blog', 0], ['acme-web', 3]], 'dsh\'s projects A–Z (accents ignored) with counts');
  assert.equal(listed[2].memory, w.id);
  for (const bad of [{}, { copy: { from: w.id, notes: [], to: 'w-api' } }, { copy: { from: w.id, notes: [{ text: 'x', path: '/etc' }], to: 'w-api' } }, { copy: { from: w.id, notes: [{ text: 'x' }] } },
    { copy: { from: w.id, notes: Array.from({ length: 101 }, (_, i) => ({ text: `n${i}` })), to: 'w-api' } }, 'nope']) {
    assert.equal((await call(MEMORY_COPY_PATH, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await call(MEMORY_COPY_PATH, { copy: { from: w.id, notes: [{ text: 'Use tabs in TypeScript files' }], to: 'w-gone' } })).status, 404, 'an unknown project');
  assert.equal((await call(MEMORY_COPY_PATH, { copy: { from: w.id, notes: [{ text: 'Use tabs in TypeScript files' }], to: 'w-web' } })).status, 409, 'the same project');
  assert.equal((await call(MEMORY_COPY_PATH, { copy: { from: 'f'.repeat(32), notes: [{ text: 'x' }], to: 'w-api' } })).status, 404);
  const gone = await call(MEMORY_COPY_PATH, { copy: { from: w.id, notes: [{ text: 'A note that is not there' }], to: 'w-api' } });
  assert.equal(gone.status, 409); assert.match(gone.body.error, /not in this memory any more/);
  // Copy: topic and source go along, a note the target has is skipped, the journal says copy.
  const before = await readFile(join(a.dir, 'MEMORY.md'), 'utf8');
  const ok = await call(MEMORY_COPY_PATH, { copy: { from: w.id, notes: [{ text: 'Run the tests with npm test' }, { text: 'Use tabs in TypeScript files', topic: null }, { text: 'Releases need a git tag first', topic: 'deploy' }], to: 'w-api' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.copied, 2); assert.equal(ok.body.skipped, 1);
  const main = await readFile(join(a.dir, 'MEMORY.md'), 'utf8');
  assert.match(main, /Run the tests with npm test \[source: session-abc #4; added: /); assert.match(main, /\[\[deploy\]\]/);
  assert.match(await readFile(join(a.dir, 'deploy.md'), 'utf8'), /Releases need a git tag first/);
  assert.notEqual(main, before);
  assert.match(await readFile(join(w.dir, 'MEMORY.md'), 'utf8'), /npm test/, 'the notes stay in the first memory');
  const journal = (await readFile(join(home, 'storages', 'dsh-composer-plus', 'memory', 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(journal.slice(-2).map((r) => r.actor), ['copy', 'copy']);
  // A new project (no memory yet) gets its project.json.
  assert.equal((await call(MEMORY_COPY_PATH, { copy: { from: 'global', notes: [], to: 'w-blog' } })).status, 400);
  await store.add({ scope: store.GLOBAL, text: 'The user writes in Turkish', actor: 'agent' });
  assert.equal((await call(MEMORY_COPY_PATH, { copy: { from: 'global', notes: [{ text: 'The user writes in Turkish' }], to: 'w-blog' } })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(store.project(blog).dir, 'project.json'), 'utf8')), { path: store.project(blog).path });
  // All or none: the target's MEMORY.md is full, so the last note does not fit: nothing is copied, files and journal as they were.
  for (let i = 0; ; i++) { try { await store.add({ scope: a, text: `Api fact ${i} ${'x'.repeat(200)}`, actor: 'agent' }); } catch { break; } }
  await store.add({ scope: w, topic: 'style', text: 'Prefer small functions', actor: 'agent' });
  await store.add({ scope: w, text: `A long web note ${'y'.repeat(250)}`, actor: 'agent' });
  const files = async () => Promise.all([join(a.dir, 'MEMORY.md'), join(a.dir, 'style.md'), join(home, 'storages', 'dsh-composer-plus', 'memory', 'journal.jsonl')].map((f) => readFile(f, 'utf8').catch(() => null)));
  const was = await files();
  const full = await call(MEMORY_COPY_PATH, { copy: { from: w.id, notes: [{ text: 'Prefer small functions', topic: 'style' }, { text: `A long web note ${'y'.repeat(250)}` }], to: 'w-api' } });
  assert.equal(full.status, 409); assert.match(full.body.error, /^Nothing was copied: "A long web note .*would have \d+ of its 4000/);
  assert.deepEqual(await files(), was, 'the last note failed: no topic file, no change, no journal row');
  // One memory action at a time.
  let release; const hold = new Promise((r) => { release = r; });
  const slow = { prepareCall: async (route) => ({ config: route, async *stream() { await hold; yield { type: 'text-delta', text: '{"changes":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  const realGet = ctx.get;
  ctx.get = (n) => (n === 'llm' ? slow : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'demo', model: 'm' }) } : realGet(n));
  const running = call(MEMORY_EDIT_PATH, { preview: { project: w.id, text: 'x' } });
  await new Promise((r) => setTimeout(r, 20));
  const busy = await call(MEMORY_COPY_PATH, { copy: { from: w.id, notes: [{ text: 'Prefer small functions', topic: 'style' }], to: 'w-blog' } });
  assert.equal(busy.status, 409); assert.equal(busy.body.busy, 'preview');
  release(); await running; ctx.get = realGet;

  // Client (real client.js, fake React).
  {
    const memStore = new Map();
    globalThis.localStorage = { getItem: (k) => (memStore.has(k) ? memStore.get(k) : null), setItem: (k, v) => memStore.set(k, String(v)) };
    const id = 'a'.repeat(32);
    const view = { projects: [{ id, name: 'acme-web', path: '/p/acme-web', count: 2, files: [{ topic: null, entries: [{ text: 'Run the tests with npm test' }] }, { topic: 'deploy', entries: [{ text: 'Tag first' }] }] }], global: { count: 0, files: [] } };
    const posts = []; let gate; let copyError;
    globalThis.fetch = async (url, init) => {
      if (url === '/api/composer-plus.memory') return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-history')) return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url === '/api/composer-plus.memory-copy') {
        if (init?.method !== 'POST') return new Response(JSON.stringify({ projects: [{ workspaceId: 'w-api', title: 'acme-api', path: '/p/acme-api', memory: 'b'.repeat(32), count: 1 }, { workspaceId: 'w-web', title: 'acme-web', path: '/p/acme-web', memory: id, count: 2 }, { workspaceId: 'w-blog', title: 'Ácme-blog', path: '/p/blog', memory: 'c'.repeat(32), count: 0 }] }), { status: 200 });
        const body = JSON.parse(init.body); posts.push(body);
        if (gate) await gate;
        if (copyError) return new Response(JSON.stringify({ error: copyError.text }), { status: copyError.status });
        return new Response(JSON.stringify({ ...view, copied: 2, skipped: 0 }), { status: 200 });
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
    // MemoryCopy has its own state (the search): it keeps it between renders here.
    const copyInst = { state: [] };
    const drawn = (node) => {
      if (typeof node?.t !== 'function') return node;
      if (node.t.name === 'MemoryCopy') { const outer = cur; cur = copyInst; copyInst.si = 0; try { return node.t(node.p); } finally { cur = outer; } }
      return ['MemoryHistory', 'MemoryDiff'].includes(node.t.name) ? node.t(node.p) : node;
    };
    const all = (node, out = []) => { node = drawn(node); if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of node.c ?? []) all(c, out); return out; };
    const text = (node) => { node = drawn(node); return typeof node === 'string' ? node : node === null || typeof node !== 'object' ? '' : (node.c ?? []).map(text).join(''); };
    const find = (tree, attr) => all(tree).find((n) => n.p?.[attr] !== undefined);
    const settingsInst = { state: [] };
    const rows = () => { cur = settingsInst; settingsInst.si = 0; return Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, memoryEditor: section.memoryEditor, memoryHistorySwitch: section.memoryHistorySwitch, t }).c; };
    await section.memory.refresh();
    const row = rows().find((r) => r?.p?.key === 'memoryCopy');
    assert.ok(row, 'its own Settings row'); assert.equal(row.c[2].p.checked, true, 'on by default'); assert.equal(row.c[0].p.id, 'memoryCopy');
    const editorOf = () => rows().find((r) => r?.p?.key === 'projectMemory').c[1].c.find((c) => c?.t?.name === 'MemoryEditor');
    const inst = { state: [] };
    const render = () => { cur = inst; inst.si = 0; const e = editorOf(); return e.t(e.p); };
    section.memoryEditor.open(); await new Promise((r) => setTimeout(r, 10));
    let tree = render();
    all(tree).find((n) => n.p?.['data-composer-plus-memory-project'] === id).p.onClick();
    tree = render();
    find(tree, 'data-composer-plus-memory-copy').p.onClick(); await new Promise((r) => setTimeout(r, 10));
    tree = render();
    const boxes = all(tree).filter((n) => n.p?.['data-composer-plus-memory-pick'] !== undefined);
    assert.equal(boxes.length, 2, 'a checkbox per note');
    const targets = () => all(render()).filter((n) => n.p?.['data-composer-plus-memory-copy-to'] !== undefined);
    assert.deepEqual(targets().map((n) => n.p['data-composer-plus-memory-copy-to']), ['w-api', 'w-blog'], 'every project but this one');
    assert.equal(targets()[0].p.disabled, true, 'nothing picked: no copy');
    boxes[0].p.onChange(); boxes[1].p.onChange();
    assert.equal(section.memoryEditor.getSnapshot().copy.picked.length, 2);
    // The search ignores case and accents; Enter picks the first match.
    find(render(), 'data-composer-plus-memory-copy-search').p.onChange({ target: { value: 'acme-b' } });
    assert.deepEqual(targets().map((n) => n.p['data-composer-plus-memory-copy-to']), ['w-blog'], 'Ácme-blog matches acme-b');
    let releaseGate; gate = new Promise((r) => { releaseGate = r; });
    find(render(), 'data-composer-plus-memory-copy-search').p.onKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: {} });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(section.memoryEditor.busy(), true);
    // A second copy, a click on a target, a pick, Preview and History while it runs do nothing.
    assert.equal(await section.memoryEditor.copyTo('w-api'), false);
    targets()[0]?.p.onClick();
    section.memoryEditor.pickNote('x\u0000y'); section.memoryEditor.cancelCopy();
    assert.equal(await section.memoryEditor.preview(id, 'x'), false); assert.equal(await section.memoryEditor.openHistory(id), false);
    assert.equal(section.memoryEditor.getSnapshot().copy.picked.length, 2, 'the picks stay while it runs');
    releaseGate(); gate = undefined; await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.filter((b) => b.copy).length, 1, 'one copy'); assert.equal(posts.filter((b) => b.preview).length, 0);
    assert.deepEqual(posts[0], { copy: { from: id, notes: [{ topic: null, text: 'Run the tests with npm test' }, { topic: 'deploy', text: 'Tag first' }], to: 'w-blog' } });
    assert.match(text(render()), /memoryCopy\.done/); assert.match(text(render()), /Ácme-blog/);
    assert.equal(section.memoryEditor.getSnapshot().copy, null, 'the copy panel closes');
    // A refused copy: the reason shows, the picks stay for another try.
    section.memoryEditor.startCopy(id); await new Promise((r) => setTimeout(r, 10));
    section.memoryEditor.pickNote('\u0000Run the tests with npm test');
    copyError = { status: 409, text: 'Nothing was copied: "x": MEMORY.md of the project memory would have 4100 of its 4000 characters.' };
    assert.equal(await section.memoryEditor.copyTo('w-api'), false);
    assert.match(section.memoryEditor.getSnapshot().error, /^Nothing was copied/);
    assert.equal(section.memoryEditor.getSnapshot().copy.picked.length, 1);
    copyError = undefined;
    // Off: the panel and the button go.
    section.setFeature('memoryCopy', false);
    assert.equal(section.memoryEditor.getSnapshot().copy, null, 'off: the panel closes');
    assert.equal(find(render(), 'data-composer-plus-memory-copy'), undefined, 'off: no button');
  }
  console.log('memory copy checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
