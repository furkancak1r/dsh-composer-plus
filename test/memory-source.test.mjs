// Memory note source link. Host: memory_remember writes `[source: <chat id> #<seq>]` with the chat's newest own user
// message (a fork's copy and withdrawn messages are left out); the review writes the seq of the newest user line it read;
// the memory-edit view gives each note `source: {sessionId, seq?}` (a note of an older version: the chat only; an actor such
// as "editor" or a bad value: none). Client (real client.js, fake React): Source next to a note closes the dialog and
// Settings, then opens the chat at the message (dsh's own message link opener); a note without a source has no link;
// switching the feature off removes the links.
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, MEMORY_EDIT_PATH, installMemory, memoryView, ROLLBACK_SOURCE } from '../index.js';
// The main memory file of a memory folder: `<name> memory.md` (MEMORY.md before 2026-11-12, still read).
const mainOf = (dir) => join(dir, (() => { try { return readdirSync(dir).find((f) => / memory\.md$/.test(f)); } catch { return undefined; } })() ?? 'MEMORY.md');

const root = await mkdtemp(join(tmpdir(), 'cp-memory-source-'));
try {
  const project = join(root, 'acme-web'); await mkdir(project);
  let seq = 0;
  const ev = (type, data, extra = {}) => ({ seq: seq++, time: 1000 + seq, type, data, ...extra });
  const user = (text) => ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const reply = (text) => ev('assistant/message', { message: { content: [{ type: 'text', text }] } });
  // A fork: the parent's copy (2 events), then its own messages; the newest own one is rolled back.
  const parent = [ev('request/header', { header: { config: { provider: 'demo', model: 'm1' } } }), user('parent asks')];
  const own = [user('Remember: we deploy with make release'), reply('ok'), user('withdrawn later'), ev('user/message', { source: { kind: ROLLBACK_SOURCE }, content: [] }, { sourceEventSeqs: [4] })];
  const events = { 'session-fork-1': [...parent, ...own] };
  const routes = new Map(); const registered = new Map();
  const llm = { prepareCall: async (route, signal, configure) => ({ config: { ...route, ...configure({}, {}) }, async *stream() { yield { type: 'text-delta', text: '{"changes":[{"op":"add","text":"The user deploys with make release"}]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  const ctx = {
    on: () => {}, effect: () => {}, logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? llm : undefined),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionQuery: { observeSession: async (id) => { if (!events[id]) throw new Error('unknown session'); return { events: events[id], header: { cwd: project }, inheritedEventCount: parent.length }; } },
    inject: (deps, setup) => { setup({ tools: { register: (t) => registered.set(t.name, t) }, systemPrompt: { section: () => {} } }); return { dispose: () => registered.clear() }; },
  };
  const mem = installMemory(ctx, join(root, 'home'));
  await mem.ready;
  const call = async (path, body) => { const r = await routes.get(path).fetch(new Request(`http://h${path}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  await call(MEMORY_PATH, { on: true });
  const scope = mem.store.project(project);
  // The tool: the newest own user message that was not withdrawn (seq 2), not the parent's (1) or the withdrawn one (4).
  await registered.get('memory_remember').execute({ text: 'The user deploys with make release' }, { agent: { id: 'session-fork-1', session: { header: { cwd: project } } } });
  assert.match(await readFile(mainOf(scope.dir), 'utf8'), /\[source: session-fork-1 #2; added: /);
  // A chat whose log cannot be read: the chat only.
  await registered.get('memory_remember').execute({ text: 'The user writes tests first' }, { agent: { id: 'session-gone', session: { header: { cwd: project } } } });
  assert.match(await readFile(mainOf(scope.dir), 'utf8'), /writes tests first \[source: session-gone; added: /);
  // The review: the seq of the newest user line it read.
  const pnpm = user('I use pnpm');
  events['session-rev-1'] = [...parent, pnpm, reply('noted')];
  ctx.sessionQuery.observeSession = async (id) => ({ events: events[id], header: { cwd: project }, inheritedEventCount: parent.length });
  await mem.store.remove({ scope, match: 'make release', actor: 'agent' });
  await mem.review('session-rev-1');
  assert.match(await readFile(mainOf(scope.dir), 'utf8'), new RegExp(`deploys with make release \\[source: session-rev-1 #${pnpm.seq}; added: `));
  // The view: a source per note; a bad or actor value gives none.
  await writeFile(mainOf(scope.dir), `${await readFile(mainOf(scope.dir), 'utf8')}`.replace('## Index', '- An editor note [source: editor; added: 2026-11-01]\n- A bad one [source: session-x/../y #3]\n\n## Index'));
  const view = (await call(MEMORY_EDIT_PATH)).body.projects[0].files[0].entries;
  const byText = Object.fromEntries(view.map((e) => [e.text, e.source]));
  assert.deepEqual(byText['The user deploys with make release'], { sessionId: 'session-rev-1', seq: pnpm.seq });
  assert.deepEqual(byText['The user writes tests first'], { sessionId: 'session-gone' });
  assert.equal(byText['An editor note'], undefined); assert.equal(byText['A bad one'], undefined);
  assert.deepEqual(memoryView(mem.store).projects[0].files[0].entries.find((e) => e.text.startsWith('The user deploys')).source, { sessionId: 'session-rev-1', seq: pnpm.seq });

  // Client (real client.js, fake React).
  {
    const memStore = new Map();
    globalThis.localStorage = { getItem: (k) => (memStore.has(k) ? memStore.get(k) : null), setItem: (k, v) => memStore.set(k, String(v)) };
    const id = 'a'.repeat(32);
    const data = { projects: [{ id, name: 'acme-web', path: '/p/acme-web', count: 2, files: [{ topic: null, entries: [{ text: 'The user deploys with make release', source: { sessionId: 'session-rev-1', seq: 2 } }, { text: 'A note without a source' }] }] }], global: { count: 0, files: [] } };
    globalThis.fetch = async (url) => {
      if (url === '/api/composer-plus.memory') return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-history')) return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url === '/api/composer-plus.memory-edit') return new Response(JSON.stringify({ ...data, busy: null }), { status: 200 });
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
    const opened = [];
    plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
      get: (name) => (name === 'uiWorkspace' ? { openSession: (sid) => opened.push(sid) } : undefined),
      slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
    await new Promise((r) => setTimeout(r, 20));
    const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
    const section = opts.inject();
    assert.equal(typeof section.openMessage, 'function', 'Settings gets dsh\'s message link opener');
    const t = (k) => k;
    const all = (node, out = []) => { if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of node.c ?? []) all(c, out); return out; };
    let closed = 0;
    const settingsInst = { state: [] };
    const rows = () => { cur = settingsInst; settingsInst.si = 0; return Settings({ close: () => { closed++; }, openMessage: section.openMessage, useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, memoryEditor: section.memoryEditor, memoryHistorySwitch: section.memoryHistorySwitch, t }).c; };
    await section.memory.refresh();
    const row = rows().find((r) => r?.p?.key === 'memorySource');
    assert.ok(row, 'its own Settings row'); assert.equal(row.c[2].p.checked, true, 'on by default'); assert.equal(row.c[0].p.id, 'memorySource');
    const editorOf = () => rows().find((r) => r?.p?.key === 'projectMemory').c[1].c.find((c) => c?.t?.name === 'MemoryEditor');
    const inst = { state: [] };
    const render = () => { cur = inst; inst.si = 0; const e = editorOf(); return e.t(e.p); };
    section.memoryEditor.open(); await new Promise((r) => setTimeout(r, 10));
    const links = all(render()).filter((n) => n.p?.['data-composer-plus-memory-source'] !== undefined);
    assert.equal(links.length, 1, 'only the note with a source has a link');
    assert.equal(links[0].p['data-composer-plus-memory-source'], 'session-rev-1');
    globalThis.document = { querySelectorAll: () => [] };
    links[0].p.onClick();
    assert.equal(section.memoryEditor.getSnapshot().open, false, 'the dialog closes'); assert.equal(closed, 1, 'Settings closes');
    assert.deepEqual(opened, ['session-rev-1'], 'the chat opens (then dsh scrolls to the message)');
    // Off: no links.
    section.memoryEditor.open(); await new Promise((r) => setTimeout(r, 10));
    section.setFeature('memorySource', false);
    assert.equal(all(render()).filter((n) => n.p?.['data-composer-plus-memory-source'] !== undefined).length, 0, 'off: no links');
  }
  console.log('memory source checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
