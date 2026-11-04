// Memory version history. Host: a copy before each save (the tool, the review, Open memory's Apply, a restore), the newest
// MEMORY_HISTORY_KEEP of each memory; the route lists the versions, shows a version's diff, and restores it all or none, only
// while the memory is as it was at the diff (else 409). A restore keeps the memory before it as a new version. When the last
// file of a restore cannot be written, every file stays as it was and the journal gets no row. Its own Host switch (on by
// default): off keeps no copy and refuses a restore. One memory action at a time (409 busy). Client (real client.js, fake
// React): History opens the versions of the selected memory, a version shows its diff, Restore runs once; a second action
// (Restore, Preview, Apply, History) while one runs does nothing; switching the feature off closes the panel.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, MEMORY_EDIT_PATH, MEMORY_HISTORY_PATH, installMemory, memoryHistory, memoryStore } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memory-history-'));
try {
  const shop = join(root, 'acme-shop'); await mkdir(shop);

  // The history alone: keep, list, prune.
  {
    let clock = 1_700_000_000_000;
    const h = memoryHistory(join(root, 'pure'), { keepCount: 3, now: () => clock++ });
    const store = memoryStore(join(root, 'pure'), { beforeSave: (save) => h.keep(save) });
    const s = store.project(shop);
    for (let i = 0; i < 6; i++) await store.add({ scope: s, text: `Fact ${i}`, actor: i % 2 ? 'review' : 'agent' });
    const list = h.list(s);
    assert.equal(list.length, 3, 'the newest 3 stay');
    assert.deepEqual(list.map((v) => v.notes), [5, 4, 3], 'newest first; each keeps the notes before its save');
    assert.equal(list[0].actor, 'review');
    assert.equal(h.read(s, '../../x'), undefined, 'no path in an id');
    assert.equal(h.read(s, '1700000000000-zzzzzzzz'), undefined);
  }

  // The route.
  const routes = new Map();
  let answer = '{"changes":[]}';
  const llm = { prepareCall: async (route, signal, configure) => ({ config: { ...route, ...configure({}, {}) }, async *stream() { yield { type: 'text-delta', text: answer }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  const ctx = {
    on: () => {}, effect: () => {}, logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'demo', model: 'm' }) } : undefined),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionQuery: { observeSession: async () => ({ events: [], header: {} }) },
    inject: () => ({ dispose: () => {} }),
  };
  const home = join(root, 'home');
  const mem = installMemory(ctx, home);
  await mem.ready; await mem.historyReady;
  const call = async (path, body, query = '') => {
    const r = await routes.get(path).fetch(new Request(`http://h${path}${query}`, body === undefined ? undefined : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  assert.deepEqual((await call(MEMORY_HISTORY_PATH)).body, { on: true }, 'on by default');
  await call(MEMORY_PATH, { on: true });
  const { store } = mem;
  const s = store.project(shop);
  await store.add({ scope: s, text: 'The user uses yarn', actor: 'agent' });
  await store.add({ scope: s, text: 'The user deploys with make release', actor: 'agent' });
  await store.add({ scope: s, topic: 'api', text: 'The API runs on port 8080', actor: 'agent' });
  // Apply of Open memory keeps a copy too.
  answer = '{"changes":[{"op":"remove","entry":1},{"op":"add","text":"The user uses pnpm"}]}';
  const p = await call(MEMORY_EDIT_PATH, { preview: { project: s.id, text: 'yarn → pnpm' } });
  assert.equal((await call(MEMORY_EDIT_PATH, { apply: p.body.id })).status, 200);
  const listed = await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.versions.map((v) => v.actor), ['editor', 'agent', 'agent'], 'one version per save, newest first');
  for (const q of ['?scope=../x', `?scope=${'f'.repeat(32)}`]) assert.equal((await call(MEMORY_HISTORY_PATH, undefined, q)).status, 404, q);
  assert.equal((await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}&id=1-x`)).status, 404);
  // The diff of the version before the Apply: yarn comes back, pnpm goes.
  const before = listed.body.versions[0];
  const diff = await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}&id=${before.id}`);
  assert.match(diff.body.patch, /^\+- The user uses yarn/m); assert.match(diff.body.patch, /^-- The user uses pnpm/m);
  assert.equal(typeof diff.body.version, 'string');
  // The version two saves back has no api.md: a restore removes it.
  const older = listed.body.versions[2];
  const diffOld = await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}&id=${older.id}`);
  assert.match(diffOld.body.patch, /--- a\/api\.md/);
  for (const bad of [{ restore: { scope: s.id, id: before.id } }, { restore: { scope: s.id, id: '../x', version: 'v' } }, { restore: {}, x: 1 }, 'nope']) {
    assert.equal((await call(MEMORY_HISTORY_PATH, bad)).status, 400, JSON.stringify(bad));
  }
  // A change in between: 409, nothing written.
  await store.add({ scope: s, text: 'The user likes short answers', actor: 'review' });
  const mainNow = await readFile(join(s.dir, 'MEMORY.md'), 'utf8');
  const stale = await call(MEMORY_HISTORY_PATH, { restore: { scope: s.id, id: older.id, version: diffOld.body.version } });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /changed after you opened/);
  assert.equal(await readFile(join(s.dir, 'MEMORY.md'), 'utf8'), mainNow);
  // The last file of a restore cannot be written (a read-only memory folder): every file as it was, no journal row.
  const journalPath = join(home, 'storages', 'dsh-composer-plus', 'memory', 'journal.jsonl');
  const files = async () => Promise.all([join(s.dir, 'MEMORY.md'), join(s.dir, 'api.md'), journalPath].map((f) => readFile(f, 'utf8').catch(() => null)));
  const fresh = await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}&id=${older.id}`);
  if (process.getuid?.() !== 0) {
    const was = await files();
    const count = (await readdir(join(home, 'storages', 'dsh-composer-plus', 'memory', 'history', s.id))).length;
    await chmod(s.dir, 0o500);
    let denied;
    try { denied = await call(MEMORY_HISTORY_PATH, { restore: { scope: s.id, id: older.id, version: fresh.body.version } }); } finally { await chmod(s.dir, 0o700); }
    assert.equal(denied.status, 500); assert.match(denied.body.error, /EACCES|EPERM/);
    assert.deepEqual(await files(), was, 'every file as it was, no journal row');
    assert.equal((await readdir(join(home, 'storages', 'dsh-composer-plus', 'memory', 'history', s.id))).length, count, 'the copy of the failed restore is gone');
  }
  // Restore: the files of that version (api.md goes); the memory before it is a new version; the journal says restore.
  const restored = await call(MEMORY_HISTORY_PATH, { restore: { scope: s.id, id: older.id, version: fresh.body.version } });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(await readFile(join(s.dir, 'api.md'), 'utf8').catch(() => null), null, 'a topic that the version did not have goes');
  assert.match(await readFile(join(s.dir, 'MEMORY.md'), 'utf8'), /uses yarn/);
  assert.equal(restored.body.versions[0].actor, 'restore', 'the memory before the restore is kept');
  assert.equal(JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n').at(-1)).op, 'restore');
  // Undo the restore with the version it kept.
  const undo = await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}&id=${restored.body.versions[0].id}`);
  assert.equal((await call(MEMORY_HISTORY_PATH, { restore: { scope: s.id, id: restored.body.versions[0].id, version: undo.body.version } })).status, 200);
  assert.match(await readFile(join(s.dir, 'MEMORY.md'), 'utf8'), /short answers/, 'the restore was undone');
  assert.match(await readFile(join(s.dir, 'api.md'), 'utf8'), /8080/);
  // One action at a time: a restore while a preview runs → 409 busy.
  let release; const hold = new Promise((r) => { release = r; });
  const slow = { prepareCall: async (route) => ({ config: route, async *stream() { await hold; yield { type: 'text-delta', text: '{"changes":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  const realGet = ctx.get; ctx.get = (n) => (n === 'llm' ? slow : realGet(n));
  const running = call(MEMORY_EDIT_PATH, { preview: { project: s.id, text: 'x' } });
  await new Promise((r) => setTimeout(r, 20));
  const v = await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}&id=${older.id}`);
  const busy = await call(MEMORY_HISTORY_PATH, { restore: { scope: s.id, id: older.id, version: v.body.version } });
  assert.equal(busy.status, 409); assert.equal(busy.body.busy, 'preview');
  release(); await running; ctx.get = realGet;
  // The switch: off keeps no copy and refuses a restore; the phone's gateway never sends it (a switch body).
  assert.deepEqual((await call(MEMORY_HISTORY_PATH, { on: false })).body, { on: false });
  assert.deepEqual(JSON.parse(await readFile(join(home, 'storages', 'dsh-composer-plus', 'memory-history.json'), 'utf8')), { on: false });
  const n = (await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}`)).body.versions.length;
  await store.add({ scope: s, text: 'Saved while history is off', actor: 'agent' });
  assert.equal((await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}`)).body.versions.length, n, 'off: no copy');
  assert.equal((await call(MEMORY_HISTORY_PATH, { restore: { scope: s.id, id: older.id, version: 'x' } })).status, 409);
  await call(MEMORY_HISTORY_PATH, { on: true });
  // Project memory off: the list and a restore answer 409; the switch still answers.
  await call(MEMORY_PATH, { on: false });
  assert.equal((await call(MEMORY_HISTORY_PATH, undefined, `?scope=${s.id}`)).status, 409);
  assert.deepEqual((await call(MEMORY_HISTORY_PATH)).body, { on: true });

  // Client (real client.js, fake React).
  {
    const memStore = new Map();
    globalThis.localStorage = { getItem: (k) => (memStore.has(k) ? memStore.get(k) : null), setItem: (k, v) => memStore.set(k, String(v)) };
    const id = 'a'.repeat(32);
    const view = { projects: [{ id, name: 'acme-shop', path: '/p/acme-shop', count: 1, files: [{ topic: null, entries: [{ text: 'The user uses pnpm' }] }] }], global: { count: 0, files: [] } };
    let historyOn = true; const posts = []; let gate; let restoreError;
    globalThis.fetch = async (url, init) => {
      if (url === '/api/composer-plus.memory') return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-history')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body); posts.push(body);
          if (body.on !== undefined) { historyOn = body.on; return new Response(JSON.stringify({ on: historyOn }), { status: 200 }); }
          if (gate) await gate;
          if (restoreError) return new Response(JSON.stringify({ error: restoreError.text }), { status: restoreError.status });
          return new Response(JSON.stringify({ ...view, restored: 'v1', versions: [{ id: 'v0', time: 3, actor: 'restore', notes: 1 }] }), { status: 200 });
        }
        const q = new URL(url, 'http://h').searchParams;
        if (!q.has('scope')) return new Response(JSON.stringify({ on: historyOn }), { status: 200 });
        if (!q.has('id')) return new Response(JSON.stringify({ on: true, versions: [{ id: 'v1', time: 1_700_000_000_000, actor: 'editor', notes: 2 }] }), { status: 200 });
        return new Response(JSON.stringify({ id: 'v1', time: 1_700_000_000_000, actor: 'editor', version: 'ver1', patch: '--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1,1 +1,1 @@\n-- The user uses pnpm\n+- The user uses yarn\n', truncated: false }), { status: 200 });
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
    // MemoryHistory and MemoryDiff use no hooks: the walk draws them in place.
    const drawn = (node) => (typeof node?.t === 'function' && ['MemoryHistory', 'MemoryDiff'].includes(node.t.name) ? node.t(node.p) : node);
    const all = (node, out = []) => { node = drawn(node); if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of node.c ?? []) all(c, out); return out; };
    const text = (node) => { node = drawn(node); return typeof node === 'string' ? node : node === null || typeof node !== 'object' ? '' : (node.c ?? []).map(text).join(''); };
    const find = (tree, attr) => all(tree).find((n) => n.p?.[attr] !== undefined);
    const settingsInst = { state: [] };
    const rows = () => { cur = settingsInst; settingsInst.si = 0; return Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, memoryEditor: section.memoryEditor, memoryHistorySwitch: section.memoryHistorySwitch, t }).c; };
    await section.memory.refresh(); await section.memoryHistorySwitch.refresh();
    const historyRow = rows().find((r) => r?.p?.key === 'memoryHistory');
    assert.ok(historyRow, 'its own Settings row'); assert.equal(historyRow.c[2].p.checked, true, 'on by default');
    assert.equal(historyRow.c[0].p.id, 'memoryHistory', 'its screenshot');
    const editorOf = () => rows().find((r) => r?.p?.key === 'projectMemory').c[1].c.find((c) => c?.t?.name === 'MemoryEditor');
    const inst = { state: [] };
    const render = () => { cur = inst; inst.si = 0; const e = editorOf(); return e.t(e.p); };
    section.memoryEditor.open(); await new Promise((r) => setTimeout(r, 10));
    let tree = render();
    assert.equal(find(tree, 'data-composer-plus-memory-history-open'), undefined, 'All notes: no History (one memory at a time)');
    all(tree).find((n) => n.p?.['data-composer-plus-memory-project'] === id).p.onClick();
    tree = render();
    find(tree, 'data-composer-plus-memory-history-open').p.onClick();
    await new Promise((r) => setTimeout(r, 10));
    tree = render();
    const versions = all(tree).filter((n) => n.p?.['data-composer-plus-memory-version'] !== undefined);
    assert.equal(versions.length, 1); assert.match(text(versions[0]), /memoryHistory\.actor\.editor/);
    versions[0].p.onClick(); await new Promise((r) => setTimeout(r, 10));
    tree = render();
    assert.match(text(find(tree, 'data-composer-plus-memory-diff')), /-- The user uses pnpm/);
    // Restore once; a second Restore, a Preview, an Apply and History while it runs do nothing.
    let releaseGate; gate = new Promise((r) => { releaseGate = r; });
    const restoring = find(tree, 'data-composer-plus-memory-restore').p.onClick();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(section.memoryEditor.busy(), true);
    assert.equal(find(render(), 'data-composer-plus-memory-restore').p.disabled, true, 'the button is off while it runs');
    assert.equal(await section.memoryEditor.restore(), false);
    assert.equal(await section.memoryEditor.preview(id, 'x'), false);
    assert.equal(await section.memoryEditor.openHistory('global'), false);
    assert.equal(await section.memoryEditor.openVersion('v1'), false);
    section.memoryEditor.closeHistory();
    assert.notEqual(section.memoryEditor.getSnapshot().history, null, 'the panel stays while the restore runs');
    releaseGate(); gate = undefined; await restoring;
    assert.deepEqual(posts.filter((b) => b.restore).length, 1, 'one restore'); assert.equal(posts.filter((b) => b.preview).length, 0);
    assert.deepEqual(posts.find((b) => b.restore), { restore: { scope: id, id: 'v1', version: 'ver1' } });
    assert.match(text(render()), /memoryHistory\.restored/);
    // A refused restore (409): the reason stays, the version closes.
    versions[0].p.onClick(); await new Promise((r) => setTimeout(r, 10));
    restoreError = { status: 409, text: 'the memory changed after you opened this version; open it again' };
    assert.equal(await section.memoryEditor.restore(), false);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(section.memoryEditor.getSnapshot().history.open, null);
    assert.match(section.memoryEditor.getSnapshot().error, /changed after you opened/);
    restoreError = undefined;
    // Off (a Host switch): the panel closes and the button goes.
    await section.setFeature('memoryHistory', false);
    assert.deepEqual(posts.at(-1), { on: false }, 'the switch goes to the Host');
    assert.equal(section.memoryEditor.getSnapshot().history, null, 'off: the panel closes');
    assert.equal(find(render(), 'data-composer-plus-memory-history-open'), undefined, 'off: no History button');
  }
  console.log('memory history checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
