// Project memory → Open memory. Host: the route lists every saved note by project (and the global memory); a preview asks
// dsh's default model (not the chat's) and writes nothing; Apply writes only the previewed changes, only while the notes are
// as they were (a review in between → 409), with the journal actor "editor"; a secret, a note that does not exist and a
// project that is not in scope are left out; one preview or apply at a time (409) for every browser and phone; the route
// answers 409 while the switch is off. Client (real client.js, fake React): the Settings row shows "Open memory" only while
// the feature is on; the dialog groups by project; a second preview or apply while one runs does nothing, from the button
// and from ⌘/Ctrl+Enter; switching the feature off closes the dialog and its style goes with it.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, MEMORY_EDIT_PATH, MEMORY_EDIT_SYSTEM, installMemory, memoryStore, memoryView, memoryEditScopes, memoryEditRequest, planMemoryEdit, parseMemoryEdit } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memory-edit-'));
try {
  const shop = join(root, 'acme-shop'); const blog = join(root, 'acme-blog');
  await mkdir(shop); await mkdir(blog);

  // Pure parts: view, scopes, request, plan.
  {
    const store = memoryStore(join(root, 'pure'), { today: () => '2026-10-30' });
    const s = store.project(shop); const b = store.project(blog);
    await store.add({ scope: s, text: 'The user deploys with make release', actor: 'agent' });
    await store.add({ scope: s, topic: 'api', text: 'The API runs on port 8080', actor: 'agent' });
    await store.add({ scope: b, text: 'The blog uses Hugo', actor: 'agent' });
    await store.add({ scope: store.GLOBAL, text: 'The user writes in Turkish', actor: 'agent' });
    const view = memoryView(store);
    assert.deepEqual(view.projects.map((p) => [p.name, p.count]), [['acme-blog', 1], ['acme-shop', 2]], 'projects A–Z with counts');
    assert.deepEqual(view.projects[1].files.map((f) => f.topic), [null, 'api']);
    assert.equal(view.projects[1].files[0].entries[0].added, '2026-10-30');
    assert.equal(view.global.count, 1);
    assert.equal(memoryEditScopes(store, 'f'.repeat(32)), undefined, 'an unknown project');
    assert.equal(memoryEditScopes(store, '../x'), undefined);
    const one = memoryEditScopes(store, s.id);
    const req = memoryEditRequest(store, one, 'remove the deploy note');
    assert.match(req.text, /\[1\] \(project\) The user deploys/); assert.match(req.text, /\(global\) The user writes in Turkish/);
    assert.match(req.text, /\(project · api\) The API runs/, 'topics come after MEMORY.md');
    assert.doesNotMatch(req.text, /Hugo/, 'another project is not sent');
    const all = memoryEditScopes(store, 'all');
    const reqAll = memoryEditRequest(store, all, 'x');
    assert.match(reqAll.text, /P1 = acme-(shop|blog)/); assert.match(reqAll.text, /Hugo/);
    const answer = parseMemoryEdit('```json\n{"changes":[{"op":"remove","entry":1},{"op":"edit","entry":2,"text":"The user writes in English"},{"op":"remove","entry":1},{"op":"remove","entry":99},{"op":"add","text":"password is hunter2"},{"op":"add","text":"Deploys need a tag","topic":"Deploy Notes"},{"op":"edit","entry":3,"text":"The API runs on port 8080"}],"note":"Done"}\n```');
    assert.equal(answer.note, 'Done');
    const plan = planMemoryEdit(answer, req, one);
    assert.deepEqual(plan.changes.map((c) => [c.op, c.scope === 'global' ? 'global' : c.scope === s.id ? 'shop' : c.scope, c.topic ?? null]),
      [['remove', 'shop', null], ['edit', 'global', null], ['add', 'shop', 'deploy-notes']]);
    assert.equal(plan.skipped, 4, 'a repeat, a missing note, a secret and an edit to the same text are left out');
    // The all mode: an add needs a project tag or global.
    const tagged = planMemoryEdit({ changes: [{ op: 'add', text: 'Uses Node 22' }, { op: 'add', text: 'Uses Node 22', project: [...reqAll.tags.values()][0] }] }, reqAll, all);
    assert.equal(tagged.changes.length, 1); assert.equal(tagged.skipped, 1);
    for (const bad of ['no json', '{"changes":[{"op":"edit","text":"x"}]}', '{"note":"x"}']) assert.equal(parseMemoryEdit(bad), undefined, bad);
  }

  // The route.
  const routes = new Map();
  const calls = [];
  let answer = '{"changes":[],"note":""}';
  let hold; // a promise that a model call waits for
  const llm = { prepareCall: async (route, signal, configure) => ({ config: { ...route, ...configure({}, { defaultMaxTokens: 32000 }) },
    async *stream(req) { calls.push(req); if (hold) await hold; yield { type: 'text-delta', text: typeof answer === 'function' ? answer(req.messages[0].content[0].text) : answer }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  const ctx = {
    on: () => {}, effect: () => {}, logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'demo', model: 'default-model' }) } : undefined),
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
  assert.equal((await call(MEMORY_EDIT_PATH)).status, 409, 'off: no editor');
  await call(MEMORY_PATH, { on: true });
  const { store } = mem;
  const s = store.project(shop);
  await store.add({ scope: s, text: 'The user deploys with make release', actor: 'agent' });
  await store.add({ scope: s, text: 'The user uses yarn', actor: 'agent' });
  await store.add({ scope: store.GLOBAL, text: 'The user writes in Turkish', actor: 'agent' });
  const listed = (await call(MEMORY_EDIT_PATH)).body;
  assert.deepEqual(listed.projects.map((p) => [p.id, p.path, p.count]), [[s.id, s.path, 2]]); assert.equal(listed.busy, null);
  for (const bad of [{}, { preview: { project: s.id } }, { preview: { project: s.id, text: '' } }, { preview: { project: s.id, text: 'x'.repeat(2001) } },
    { preview: { project: '../etc', text: 'x' } }, { preview: { project: s.id, text: 'x', extra: 1 } }, { apply: 5 }, { apply: 'a', x: 1 }, 'not json']) {
    assert.equal((await call(MEMORY_EDIT_PATH, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(MEMORY_EDIT_PATH, { preview: { project: 'a'.repeat(32), text: 'x' } })).status, 404, 'a project without memory');

  // Preview: dsh's default model, no tools, nothing written.
  const before = await readFile(join(s.dir, 'MEMORY.md'), 'utf8');
  answer = '{"changes":[{"op":"remove","entry":2},{"op":"add","text":"The user uses pnpm"},{"op":"add","text":"the key is sk-abcdefghijklmnopqrstu"}],"note":"Yarn becomes pnpm."}';
  const p1 = await call(MEMORY_EDIT_PATH, { preview: { project: s.id, text: 'I switched from yarn to pnpm' } });
  assert.equal(p1.status, 200);
  assert.equal(calls.at(-1).model, 'default-model', 'dsh\'s default model'); assert.equal(calls.at(-1).system, MEMORY_EDIT_SYSTEM);
  assert.equal(calls.at(-1).tools, undefined, 'no tools'); assert.ok(calls.at(-1).maxTokens <= 16000);
  assert.match(calls.at(-1).messages[0].content[0].text, /I switched from yarn to pnpm/);
  assert.deepEqual(p1.body.changes.map((c) => [c.op, c.before ?? c.text]), [['remove', 'The user uses yarn'], ['add', 'The user uses pnpm']]);
  assert.equal(p1.body.skipped, 1, 'the secret is left out'); assert.equal(p1.body.note, 'Yarn becomes pnpm.');
  assert.equal(await readFile(join(s.dir, 'MEMORY.md'), 'utf8'), before, 'a preview writes nothing');

  // A review writes between the preview and Apply: Apply refuses (409) and writes nothing.
  await store.add({ scope: s, text: 'The user likes short answers', actor: 'review' });
  const changed = await readFile(join(s.dir, 'MEMORY.md'), 'utf8');
  const stale = await call(MEMORY_EDIT_PATH, { apply: p1.body.id });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /changed after this preview/);
  assert.equal(await readFile(join(s.dir, 'MEMORY.md'), 'utf8'), changed);

  // Preview again and apply.
  answer = '{"changes":[{"op":"remove","entry":2},{"op":"add","text":"The user uses pnpm"}],"note":"ok"}';
  const p2 = await call(MEMORY_EDIT_PATH, { preview: { project: s.id, text: 'I switched from yarn to pnpm' } });
  const applied = await call(MEMORY_EDIT_PATH, { apply: p2.body.id });
  assert.equal(applied.status, 200); assert.equal(applied.body.applied, 2); assert.equal('failed' in applied.body, false, 'all or none: no list of failed changes');
  const after = await readFile(join(s.dir, 'MEMORY.md'), 'utf8');
  assert.match(after, /uses pnpm \[source: editor; added: /); assert.doesNotMatch(after, /yarn/); assert.match(after, /make release/); assert.match(after, /short answers/);
  const journal = (await readFile(join(home, 'storages', 'dsh-composer-plus', 'memory', 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(journal.slice(-2).map((r) => [r.op, r.actor]), [['remove', 'editor'], ['add', 'editor']]);
  assert.equal((await call(MEMORY_EDIT_PATH, { apply: p2.body.id })).status, 410, 'a preview applies once');
  assert.equal(applied.body.projects[0].count, 3, 'the answer has the new list');

  // No change: no id, nothing to apply.
  answer = '{"changes":[],"note":"No note is about Docker."}';
  const none = await call(MEMORY_EDIT_PATH, { preview: { project: 'global', text: 'remove the docker note' } });
  assert.equal(none.body.id, null); assert.deepEqual(none.body.changes, []); assert.equal(none.body.note, 'No note is about Docker.');
  answer = 'not json';
  assert.equal((await call(MEMORY_EDIT_PATH, { preview: { project: null, text: 'x' } })).status, 502, 'a bad answer');

  // One at a time: a second preview or an apply while one runs → 409 busy; GET shows it.
  answer = '{"changes":[{"op":"add","text":"The user tests with vitest"}]}';
  let release; hold = new Promise((r) => { release = r; });
  const running = call(MEMORY_EDIT_PATH, { preview: { project: s.id, text: 'add vitest' } });
  await new Promise((r) => setTimeout(r, 20));
  const second = await call(MEMORY_EDIT_PATH, { preview: { project: s.id, text: 'add jest' } });
  assert.equal(second.status, 409); assert.equal(second.body.busy, 'preview');
  assert.equal((await call(MEMORY_EDIT_PATH, { apply: 'x' })).status, 409);
  assert.equal((await call(MEMORY_EDIT_PATH)).body.busy, 'preview');
  release(); hold = undefined;
  assert.equal((await running).status, 200);
  assert.equal((await call(MEMORY_EDIT_PATH)).body.busy, null);

  // All or none (AGENTS.md rule 11): when the last change fails, nothing is saved. The removed topic note and its link come
  // back, the new topic goes, the edit is undone, the journal gets no row, and the answer gives the reason.
  const b = store.project(blog);
  await store.add({ scope: b, text: 'The blog uses Hugo', actor: 'agent' });
  await store.add({ scope: b, topic: 'api', text: 'The API runs on port 8080', actor: 'agent' });
  const journalPath = join(home, 'storages', 'dsh-composer-plus', 'memory', 'journal.jsonl');
  const files = async () => Promise.all([join(b.dir, 'MEMORY.md'), join(b.dir, 'api.md'), join(b.dir, 'deploy.md'), join(store.GLOBAL.dir, 'MEMORY.md'), journalPath]
    .map((path) => readFile(path, 'utf8').catch(() => null)));
  const num = (req, note) => Number(new RegExp(`\\[(\\d+)\\] \\([^)]*\\) ${note}`).exec(req)[1]);
  answer = (req) => JSON.stringify({ changes: [
    { op: 'remove', entry: num(req, 'The API runs') }, { op: 'edit', entry: num(req, 'The blog uses Hugo'), text: 'The blog uses Hugo 0.140' },
    { op: 'add', text: 'Deploys need a tag', topic: 'deploy' }, { op: 'add', text: 'The blog deploys with git push on the main branch', global: true }] });
  const move = await call(MEMORY_EDIT_PATH, { preview: { project: b.id, text: 'move the deploy rule to global' } });
  assert.deepEqual(move.body.changes.map((c) => c.op), ['remove', 'edit', 'add', 'add']);
  const was = await files();
  if (process.getuid?.() !== 0) { // root can write a read-only folder
    // A write error (the global folder is read-only): 500, every file as it was; the same preview applies after.
    await chmod(store.GLOBAL.dir, 0o500);
    let denied;
    try { denied = await call(MEMORY_EDIT_PATH, { apply: move.body.id }); } finally { await chmod(store.GLOBAL.dir, 0o700); }
    assert.equal(denied.status, 500);
    assert.match(denied.body.error, /^Nothing was saved: add "The blog deploys with git push on the main branch" in global: .*EACCES/);
    assert.deepEqual(await files(), was, 'a write error: every file as it was, no journal row');
  }
  // The global MEMORY.md is full: the global add (the last change) is refused, so nothing is saved (409).
  for (const size of [200, 20]) for (let i = 0; ; i++) { try { await store.add({ scope: store.GLOBAL, text: `Global fact ${size} ${i} ${'x'.repeat(size)}`, actor: 'agent' }); } catch { break; } }
  const full = await files();
  const move2 = await call(MEMORY_EDIT_PATH, { preview: { project: b.id, text: 'move the deploy rule to global' } });
  const refusedApply = await call(MEMORY_EDIT_PATH, { apply: move2.body.id });
  assert.equal(refusedApply.status, 409);
  assert.match(refusedApply.body.error, /^Nothing was saved: add "The blog deploys with git push on the main branch" in global: MEMORY\.md of the global memory would have \d+ of its 4000 characters/);
  assert.deepEqual(await files(), full, 'the limit: every file as it was, no journal row');
  assert.equal(full[0], was[0]); assert.equal(full[1], was[1]); assert.equal(full[2], null, 'no new topic file');
  // The count: a note that is already saved changes nothing, so it is not counted.
  answer = '{"changes":[{"op":"add","text":"The blog uses Hugo"},{"op":"add","text":"The blog has a dark theme"}]}';
  const again = await call(MEMORY_EDIT_PATH, { apply: (await call(MEMORY_EDIT_PATH, { preview: { project: b.id, text: 'the blog has a dark theme' } })).body.id });
  assert.equal(again.status, 200); assert.equal(again.body.applied, 1, 'only the changes that changed a note');
  // Off again: the editor answers 409.
  await call(MEMORY_PATH, { on: false });
  assert.equal((await call(MEMORY_EDIT_PATH)).status, 409);

  // Client (real client.js, fake React).
  {
    const memStore = new Map();
    globalThis.localStorage = { getItem: (k) => (memStore.has(k) ? memStore.get(k) : null), setItem: (k, v) => memStore.set(k, String(v)) };
    const view = { projects: [{ id: 'a'.repeat(32), name: 'acme-shop', path: '/p/acme-shop', count: 2, files: [{ topic: null, entries: [{ text: 'The user uses yarn', added: '2026-10-30' }, { text: 'Deploy with make release' }] }] }],
      global: { count: 1, files: [{ topic: null, entries: [{ text: 'The user writes in Turkish' }] }] } };
    let hostOn = true; const posts = []; let gate; let applyError;
    globalThis.fetch = async (url, init) => {
      if (url === '/api/composer-plus.memory') return new Response(JSON.stringify({ on: hostOn }), { status: 200 });
      if (url !== '/api/composer-plus.memory-edit') return new Response('{}', { status: 404 });
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body); posts.push(body);
        if (gate) await gate;
        if (body.preview) return new Response(JSON.stringify({ ...view, id: 'p1', changes: [{ op: 'remove', scope: 'a'.repeat(32), name: 'acme-shop', before: 'The user uses yarn' }, { op: 'add', scope: 'a'.repeat(32), name: 'acme-shop', text: 'The user uses pnpm' }], note: 'Yarn becomes pnpm.', skipped: 0, hidden: 0 }), { status: 200 });
        if (applyError) return new Response(JSON.stringify({ error: applyError.text }), { status: applyError.status });
        return new Response(JSON.stringify({ ...view, applied: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ...view, busy: null }), { status: 200 });
    };
    let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
    eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
    let cur;
    const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }),
      useState: (v) => { const i = cur.si++; const st = cur.state; if (!(i in st)) st[i] = v; return [st[i], (x) => { st[i] = typeof x === 'function' ? x(st[i]) : x; }]; },
      useRef: (v) => ({ current: v }), useEffect: (f) => { cur.effects.push(f); }, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
    const Modal = 'Modal';
    const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', Modal } : {}));
    const live = new Map(); let next = 0;
    plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
      slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
    await new Promise((r) => setTimeout(r, 20));
    const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
    const section = opts.inject();
    const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
    const all = (node, out = []) => { if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of node.c ?? []) all(c, out); return out; };
    const text = (node) => (typeof node === 'string' ? node : node === null || typeof node !== 'object' ? '' : (node.c ?? []).map(text).join(''));
    const find = (tree, attr) => all(tree).find((n) => n.p?.[attr] !== undefined);
    const settingsInst = { state: [], effects: [] };
    const row = () => { cur = settingsInst; settingsInst.si = 0; settingsInst.effects = []; return settingsRow(); };
    const settingsRow = () => Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, memoryEditor: section.memoryEditor, t })
      .c.find((r) => r?.p?.key === 'projectMemory');
    const editorOf = () => row().c[1].c.find((c) => c?.t?.name === 'MemoryEditor');
    await section.memory.refresh();
    assert.ok(editorOf(), 'on: the row has the editor');
    const inst = { state: [], effects: [] };
    const render = () => { cur = inst; inst.si = 0; inst.effects = []; const e = editorOf(); return e.t(e.p); };
    let tree = render();
    assert.equal(tree.p['data-composer-plus-memory-open'], '', 'closed: only the button');
    section.memoryEditor.open();
    await new Promise((r) => setTimeout(r, 10));
    tree = render();
    const modal = tree.c.find((c) => c?.t === Modal);
    assert.ok(modal, 'the dialog'); assert.equal(modal.p.headless, true);
    assert.ok(all(modal).some((n) => n.t === 'style'), 'its style is inside the dialog');
    const nav = all(modal).filter((n) => n.p?.['data-composer-plus-memory-project'] !== undefined).map((n) => n.p['data-composer-plus-memory-project']);
    assert.deepEqual(nav, ['all', 'global', 'a'.repeat(32)], 'All, Global, then the projects');
    const groups = all(modal).filter((n) => n.p?.['data-composer-plus-memory-group'] !== undefined);
    assert.deepEqual(groups.map((g) => g.p['data-composer-plus-memory-group']), ['a'.repeat(32), 'global'], 'grouped by project');
    assert.match(text(groups[0]), /The user uses yarn.*2026-10-30/);
    // Select the project, then filter.
    find(modal, 'data-composer-plus-memory-project') && all(modal).find((n) => n.p?.['data-composer-plus-memory-project'] === 'a'.repeat(32)).p.onClick();
    tree = render();
    assert.deepEqual(all(tree).filter((n) => n.p?.['data-composer-plus-memory-group'] !== undefined).map((g) => g.p['data-composer-plus-memory-group']), ['a'.repeat(32)]);
    // Type and preview with ⌘+Enter; a second ask (button, key) while it runs sends nothing.
    find(tree, 'data-composer-plus-memory-ask').p.onChange({ target: { value: 'I use pnpm now' } });
    tree = render();
    let releaseGate; gate = new Promise((r) => { releaseGate = r; });
    const key = (k) => ({ key: 'Enter', metaKey: k === 'meta', ctrlKey: k === 'ctrl', preventDefault() {} });
    find(tree, 'data-composer-plus-memory-ask').p.onKeyDown(key('meta'));
    await new Promise((r) => setTimeout(r, 5));
    tree = render();
    assert.equal(section.memoryEditor.busy(), true);
    assert.equal(find(tree, 'data-composer-plus-memory-preview-button').p.disabled, true, 'the button is off while it runs');
    find(tree, 'data-composer-plus-memory-ask').p.onKeyDown(key('ctrl'));
    find(tree, 'data-composer-plus-memory-preview-button').p.onClick();
    assert.equal(await section.memoryEditor.preview(null, 'again'), false, 'the store refuses a second preview');
    assert.equal(await section.memoryEditor.apply(), false, 'and an apply');
    assert.equal(posts.length, 1, 'one request');
    assert.deepEqual(posts[0], { preview: { project: 'a'.repeat(32), text: 'I use pnpm now' } });
    releaseGate(); gate = undefined;
    await new Promise((r) => setTimeout(r, 10));
    tree = render();
    const changes = all(tree).filter((n) => n.p?.['data-composer-plus-memory-change'] !== undefined).map((n) => n.p['data-composer-plus-memory-change']);
    assert.deepEqual(changes, ['remove', 'add'], 'the preview list');
    assert.match(text(find(tree, 'data-composer-plus-memory-preview')), /Yarn becomes pnpm/);
    // Apply: one at a time too.
    gate = new Promise((r) => { releaseGate = r; });
    const applying = find(tree, 'data-composer-plus-memory-apply').p.onClick();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await section.memoryEditor.apply(), false); assert.equal(await section.memoryEditor.preview('global', 'x'), false);
    find(render(), 'data-composer-plus-memory-ask').p.onKeyDown(key('meta'));
    releaseGate(); gate = undefined; await applying;
    assert.deepEqual(posts.map((p) => Object.keys(p)[0]), ['preview', 'apply'], 'one apply, no extra preview');
    assert.deepEqual(posts[1], { apply: 'p1' });
    tree = render();
    assert.equal(find(tree, 'data-composer-plus-memory-preview'), undefined, 'the preview is gone after Apply');
    assert.match(text(tree), /memoryEditor\.applied/);
    // A refused Apply: the reason stays on screen after the list is read again (409 also drops the preview); a 500 keeps
    // the preview, so the user can apply it again.
    await section.memoryEditor.preview('a'.repeat(32), 'I use pnpm now');
    applyError = { status: 500, text: 'Nothing was saved: add "x" in acme-shop: EACCES' };
    assert.equal(await section.memoryEditor.apply(), false);
    assert.equal(section.memoryEditor.getSnapshot().preview?.id, 'p1', 'a 500 keeps the preview');
    applyError = { status: 409, text: 'Nothing was saved: add "x" in global: MEMORY.md of the global memory would have 4053 of its 4000 characters.' };
    assert.equal(await section.memoryEditor.apply(), false);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(section.memoryEditor.getSnapshot().preview, null, 'a 409 drops the preview');
    assert.match(section.memoryEditor.getSnapshot().error ?? '', /^Nothing was saved/, 'the reason stays after the list is read again');
    assert.match(text(render()), /memoryEditor\.failed/);
    applyError = undefined;
    // Switching the feature off closes the dialog (and its style) and removes the button.
    hostOn = false;
    await section.setFeature('projectMemory', false);
    assert.equal(section.memoryEditor.getSnapshot().open, false, 'off: the dialog closes');
    assert.equal(editorOf(), undefined, 'off: no button');
  }
  console.log('memory editor checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
