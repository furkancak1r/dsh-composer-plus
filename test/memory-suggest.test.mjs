// Suggest memory notes from a chat. Host: POST {sessionId} makes one call to the chat's own model (the newest request
// header's route), with no tools, the saved notes and the chat's own numbered lines: a fork's copy of its parent is left out
// (it starts at inheritedEventCount), messages withdrawn by composer-plus-rollback and dsh-rewind are left out, and lines
// before a /compact marker stay. The answer is cleaned (a secret, a repeat, a saved note, a bad topic: left out) and each
// suggestion keeps the seq of its chat line. Nothing is saved until {accept: {id, index}}: then the note is saved with
// `[source: <chat id> #<seq>]` and the journal actor `suggest`, once. One call per chat at a time (409); not in a subagent
// chat or a chat with the memory off; one memory action at a time for accept (409 busy). Client (real client.js, fake React):
// the model is called only by the button; one ask or accept at a time from every entry point; Reject changes nothing on the
// Host; switching the feature off closes the dialog and removes the button.
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, MEMORY_CHAT_PATH, MEMORY_EDIT_PATH, MEMORY_SUGGEST_PATH, MEMORY_SUGGEST_SYSTEM, installMemory, parseMemorySuggest, ROLLBACK_SOURCE, REWIND_SOURCE } from '../index.js';
// The main memory file of a memory folder: `<name> memory.md` (MEMORY.md before 2026-11-12, still read).
const mainOf = (dir) => join(dir, (() => { try { return readdirSync(dir).find((f) => / memory\.md$/.test(f)); } catch { return undefined; } })() ?? 'MEMORY.md');

const root = await mkdtemp(join(tmpdir(), 'cp-memory-suggest-'));
try {
  // Pure part: the answer is cleaned.
  {
    const lines = [{ who: 'user', text: 'a', seq: 10, n: 1 }, { who: 'agent', text: 'b', seq: 11, n: 2 }, { who: 'user', text: 'c', seq: 12, n: 3 }];
    const r = parseMemorySuggest('```json\n{"suggestions":[{"text":"Deploys need a tag","why":"L1","line":1},{"text":"deploys need a TAG","line":3},{"text":"the token is ghp_abcdefghijklmnopqrstuvwxyz12"},{"text":"Already saved"},{"text":"x","topic":"../bad"},{"text":"Uses pnpm","line":99,"global":true,"topic":"Tools"}]}\n```',
      { lines, saved: new Set(['already saved']) });
    assert.deepEqual(r.suggestions, [{ text: 'Deploys need a tag', why: 'L1', seq: 10 }, { text: 'Uses pnpm', why: '', global: true, topic: 'tools', seq: 12 }]);
    assert.equal(r.skipped, 4, 'a repeat, a secret, a saved note and a bad topic');
    for (const bad of ['no json', '{"x":1}']) assert.equal(parseMemorySuggest(bad, { lines, saved: new Set() }), undefined);
  }

  const project = join(root, 'acme-web'); await mkdir(project);
  let seq = 0;
  const ev = (type, data, extra = {}) => ({ seq: seq++, type, data, ...extra });
  const user = (text, kind = 'user') => ev('user/message', { source: { kind }, content: [{ type: 'text', text }] });
  const reply = (text) => ev('assistant/message', { message: { content: [{ type: 'text', text }] } });
  const marker = (kind, hides) => ev('user/message', { source: { kind }, content: [{ type: 'text', text: '(empty message)' }] }, { sourceEventSeqs: hides });
  // A fork: the parent's copy, then its own lines; one rolled back, one rewound, one before a /compact marker.
  const parent = [ev('request/header', { header: { config: { provider: 'demo', model: 'chat-model' } } }), user('PARENT says use yarn'), reply('ok')];
  const keep = user('We release only from the main branch, after a git tag');
  const own = [keep, reply('Understood'), user('WITHDRAWN use docker'), reply('x'), marker(ROLLBACK_SOURCE, [5, 6]), user('REWOUND use podman'), marker(REWIND_SOURCE, [8]),
    user('COMPACTED but kept: tests run with vitest'), marker('compact-checkpoint', [10]), user('hidden context', 'goal'), reply('Done')];
  const sessions = { 'session-fork': { events: [...parent, ...own], header: { cwd: project }, inheritedEventCount: parent.length },
    'session-sub': { events: [user('x')], header: { cwd: project, origin: 'subagent', parentSession: 'session-fork' } },
    'session-empty': { events: [reply('only the agent')], header: { cwd: project } } };
  const calls = []; let answer = ''; let hold;
  const llm = { prepareCall: async (route, signal, configure) => ({ config: { ...route, ...configure({}, { defaultMaxTokens: 32000 }) },
    async *stream(req) { calls.push(req); if (hold) await hold; yield { type: 'text-delta', text: typeof answer === 'function' ? answer(req.messages[0].content[0].text) : answer }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  const routes = new Map();
  const ctx = {
    on: () => {}, effect: () => {}, logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'demo', model: 'default-model' }) }
      : name === 'agents' ? { get: (id) => (sessions[id] ? { id, session: { header: sessions[id].header } } : undefined) }
        : name === 'llmModelCatalog' ? undefined : undefined),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionQuery: { observeSession: async (id) => { if (!sessions[id]) throw new Error('unknown session'); return { ...sessions[id] }; } },
    inject: () => ({ dispose: () => {} }),
  };
  const home = join(root, 'home');
  const mem = installMemory(ctx, home);
  await mem.ready;
  const call = async (path, body) => { const r = await routes.get(path).fetch(new Request(`http://h${path}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  assert.equal((await call(MEMORY_SUGGEST_PATH, { sessionId: 'session-fork' })).status, 409, 'off: no suggestions');
  await call(MEMORY_PATH, { on: true });
  const scope = mem.store.project(project);
  await mem.store.add({ scope, text: 'The user wants short answers', actor: 'agent' });
  for (const bad of [{}, { sessionId: '' }, { sessionId: 'a', x: 1 }, { accept: { id: 'x' } }, { accept: { id: 'x', index: -1 } }]) assert.equal((await call(MEMORY_SUGGEST_PATH, bad)).status, 400, JSON.stringify(bad));
  // The ask: the chat's own lines, the right model, no tools.
  answer = (req) => JSON.stringify({ suggestions: [
    { text: 'Releases go only from the main branch, after a git tag', why: 'The user said so.', line: Number(/\[L(\d+)\] User: We release only/.exec(req)[1]) },
    { text: 'The user wants short answers', line: 1 },
    { text: 'Tests run with vitest', line: Number(/\[L(\d+)\] User: COMPACTED/.exec(req)[1]), topic: 'testing' }] });
  const asked = await call(MEMORY_SUGGEST_PATH, { sessionId: 'session-fork' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const sent = calls.at(-1).messages[0].content[0].text;
  assert.equal(calls.at(-1).system, MEMORY_SUGGEST_SYSTEM); assert.equal(calls.at(-1).tools, undefined, 'no tools');
  assert.equal(calls.at(-1).model, 'chat-model', 'the chat\'s own model');
  assert.doesNotMatch(sent, /PARENT says/, 'a fork reads only its own lines'); assert.doesNotMatch(sent, /WITHDRAWN|REWOUND/, 'withdrawn by rollback and rewind');
  assert.match(sent, /COMPACTED but kept/, '/compact keeps its lines'); assert.doesNotMatch(sent, /hidden context/);
  assert.match(sent, /\(project\) The user wants short answers/, 'the saved notes go along');
  assert.deepEqual(asked.body.suggestions.map((x) => [x.text, x.seq, x.topic ?? null]), [['Releases go only from the main branch, after a git tag', keep.seq, null], ['Tests run with vitest', own[7].seq, 'testing']]);
  assert.equal(asked.body.skipped, 1, 'a saved note is left out');
  assert.equal((await readFile(mainOf(scope.dir), 'utf8')).includes('main branch'), false, 'nothing is saved before Accept');
  // Accept: saved with its source, once; journal actor suggest.
  const ok = await call(MEMORY_SUGGEST_PATH, { accept: { id: asked.body.id, index: 0 } });
  assert.equal(ok.status, 200); assert.equal(ok.body.saved, true);
  assert.match(await readFile(mainOf(scope.dir), 'utf8'), new RegExp(`main branch, after a git tag \\[source: session-fork #${keep.seq}; added: `));
  assert.equal((await call(MEMORY_SUGGEST_PATH, { accept: { id: asked.body.id, index: 0 } })).status, 409, 'once');
  assert.equal((await call(MEMORY_SUGGEST_PATH, { accept: { id: asked.body.id, index: 7 } })).status, 410);
  assert.equal((await call(MEMORY_SUGGEST_PATH, { accept: { id: 'gone', index: 0 } })).status, 410);
  await call(MEMORY_SUGGEST_PATH, { accept: { id: asked.body.id, index: 1 } });
  assert.match(await readFile(join(scope.dir, 'testing.md'), 'utf8'), /Tests run with vitest \[source: session-fork #\d+;/);
  const journal = (await readFile(join(home, 'storages', 'dsh-composer-plus', 'memory', 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(journal.slice(-2).map((r) => r.actor), ['suggest', 'suggest']);
  // Refused: a subagent chat, a chat with no message of its own, an unknown chat, a chat with the memory off.
  assert.match((await call(MEMORY_SUGGEST_PATH, { sessionId: 'session-sub' })).body.error, /switched off|subagent/);
  assert.equal((await call(MEMORY_SUGGEST_PATH, { sessionId: 'session-empty' })).status, 409);
  assert.equal((await call(MEMORY_SUGGEST_PATH, { sessionId: 'session-none' })).status, 404);
  await call(MEMORY_CHAT_PATH, { sessionId: 'session-fork', off: true });
  const n = calls.length;
  assert.equal((await call(MEMORY_SUGGEST_PATH, { sessionId: 'session-fork' })).status, 409, 'memory off for this chat');
  assert.equal(calls.length, n, 'no model call');
  await call(MEMORY_CHAT_PATH, { sessionId: 'session-fork', off: false });
  // One call per chat at a time; an accept while another memory action runs → 409 busy.
  answer = '{"suggestions":[{"text":"Use the staging box first","line":1}]}';
  let release; hold = new Promise((r) => { release = r; });
  const running = call(MEMORY_SUGGEST_PATH, { sessionId: 'session-fork' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await call(MEMORY_SUGGEST_PATH, { sessionId: 'session-fork' })).status, 409, 'one call per chat');
  const editing = call(MEMORY_EDIT_PATH, { preview: { project: scope.id, text: 'x' } });
  await new Promise((r) => setTimeout(r, 20));
  release(); hold = undefined;
  const second = (await running).body; await editing;
  hold = new Promise((r) => { release = r; });
  const editing2 = call(MEMORY_EDIT_PATH, { preview: { project: scope.id, text: 'y' } });
  await new Promise((r) => setTimeout(r, 20));
  const busy = await call(MEMORY_SUGGEST_PATH, { accept: { id: second.id, index: 0 } });
  assert.equal(busy.status, 409); assert.equal(busy.body.busy, 'preview');
  release(); hold = undefined; await editing2;
  assert.equal((await call(MEMORY_SUGGEST_PATH, { accept: { id: second.id, index: 0 } })).status, 200, 'after the other action ends');

  // Client (real client.js, fake React).
  {
    const memStore = new Map();
    globalThis.localStorage = { getItem: (k) => (memStore.has(k) ? memStore.get(k) : null), setItem: (k, v) => memStore.set(k, String(v)) };
    const posts = []; let gate; let acceptError;
    globalThis.fetch = async (url, init) => {
      if (url === '/api/composer-plus.memory') return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-chat')) return new Response(JSON.stringify({ on: true, memory: true, sessionId: 'session-x', off: false }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-history')) return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url === '/api/composer-plus.memory-suggest') {
        const body = JSON.parse(init.body); posts.push(body);
        if (gate) await gate;
        if (body.sessionId) return new Response(JSON.stringify({ id: 's1', suggestions: [{ text: 'Releases need a tag', why: 'L1', seq: 3 }, { text: 'Use pnpm', why: '', seq: 5 }], skipped: 0 }), { status: 200 });
        if (acceptError) return new Response(JSON.stringify({ error: acceptError }), { status: 409 });
        return new Response(JSON.stringify({ saved: true, index: body.accept.index }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
    eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
    let cur;
    const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }),
      useState: (v) => { const i = cur.si++; const st = cur.state; if (!(i in st)) st[i] = v; return [st[i], (x) => { st[i] = typeof x === 'function' ? x(st[i]) : x; }]; },
      useRef: (v) => ({ current: v }), useEffect: (f) => { f(); }, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
    const Button = 'Button'; const Modal = 'Modal';
    const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', Modal, Button } : {}));
    const live = new Map(); let next = 0;
    plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-x': { displayTitle: 'Release notes' }, 'session-sub': { origin: 'subagent' } } }) } },
      slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
    await new Promise((r) => setTimeout(r, 20));
    const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
    const section = opts.inject();
    const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
    const all = (node, out = []) => { if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of node.c ?? []) all(c, out); return out; };
    const text = (node) => (typeof node === 'string' ? node : node === null || typeof node !== 'object' ? '' : (node.c ?? []).map(text).join(''));
    const find = (tree, attr, v) => all(tree).find((n) => n.p?.[attr] !== undefined && (v === undefined || n.p[attr] === v));
    const settingsInst = { state: [] };
    const rows = () => { cur = settingsInst; settingsInst.si = 0; return Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, t }).c; };
    const row = rows().find((r) => r?.p?.key === 'memorySuggest');
    assert.ok(row, 'its own Settings row'); assert.equal(row.c[2].p.checked, true, 'on by default'); assert.equal(row.c[0].p.id, 'memorySuggest');
    const slotOf = (id) => [...live.values()].find(([o]) => o.id === id);
    const [bOpts, Btn] = slotOf('memory-suggest'); const [dOpts, Dialog] = slotOf('memory-suggest-dialog');
    assert.equal(bOpts.name, 'conversation.session.header.utilities'); assert.equal(dOpts.name, 'shell.overlay');
    const drawButton = (id) => { cur = { state: [], si: 0 }; return Btn({ sessionId: id, ...bOpts.inject(id), t }); };
    const drawDialog = () => { cur = { state: [], si: 0 }; return Dialog({ ...dOpts.inject(), t }); };
    drawButton('session-x'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 0, 'no model call before a click');
    assert.equal(drawDialog(), null, 'no dialog before a click');
    drawButton('session-sub'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(drawButton('session-sub'), null, 'not in a subagent chat (the Host answers for it as for its root)');
    // Ask once; a second click while it runs does nothing.
    let release2; gate = new Promise((r) => { release2 = r; });
    find(drawButton('session-x'), 'data-composer-plus-memory-suggest').p.onClick();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(find(drawButton('session-x'), 'data-composer-plus-memory-suggest').p.disabled, true);
    find(drawButton('session-x'), 'data-composer-plus-memory-suggest').p.onClick();
    assert.match(text(drawDialog()), /memorySuggest\.thinking/);
    release2(); gate = undefined; await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(posts, [{ sessionId: 'session-x' }], 'one call, with this chat only');
    let dialog = drawDialog();
    assert.match(dialog.p.description, /Release notes/, 'the chat\'s title'); assert.equal(all(dialog).filter((n) => n.p?.['data-composer-plus-memory-suggestion'] === 'new').length, 2);
    // Accept the first; while it saves, a second Accept, a Reject and a new ask do nothing.
    gate = new Promise((r) => { release2 = r; });
    find(dialog, 'data-composer-plus-memory-suggestion-accept', '0').p.onClick();
    await new Promise((r) => setTimeout(r, 5));
    dialog = drawDialog();
    assert.equal(find(dialog, 'data-composer-plus-memory-suggestion-accept', '1').p.disabled, true);
    find(dialog, 'data-composer-plus-memory-suggestion-reject', '1').p.onClick();
    find(drawButton('session-x'), 'data-composer-plus-memory-suggest').p.onClick();
    // The store itself refuses a second accept (a key or a second window would call it directly).
    assert.equal(await Promise.race([dOpts.inject().suggest.accept(1), new Promise((r) => setTimeout(() => r('waits'), 30))]), false, 'a second accept while one runs');
    release2(); gate = undefined; await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(posts.map((p) => Object.keys(p)[0]), ['sessionId', 'accept'], 'one accept, no second ask');
    dialog = drawDialog();
    assert.deepEqual(all(dialog).filter((n) => n.p?.['data-composer-plus-memory-suggestion'] !== undefined).map((n) => n.p['data-composer-plus-memory-suggestion']), ['saved', 'new'], 'the reject during the save did nothing');
    // Reject: only on this screen.
    find(dialog, 'data-composer-plus-memory-suggestion-reject', '1').p.onClick();
    assert.equal(posts.length, 2, 'a reject sends nothing');
    assert.deepEqual(all(drawDialog()).filter((n) => n.p?.['data-composer-plus-memory-suggestion'] !== undefined).map((n) => n.p['data-composer-plus-memory-suggestion']), ['saved', 'rejected']);
    // A refused accept keeps the suggestion and shows the reason.
    find(drawButton('session-x'), 'data-composer-plus-memory-suggest').p.onClick(); await new Promise((r) => setTimeout(r, 10));
    acceptError = 'the memory is being changed; wait for it to end';
    await find(drawDialog(), 'data-composer-plus-memory-suggestion-accept', '0').p.onClick();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(text(drawDialog()), /memoryEditor\.failed/);
    assert.equal(find(drawDialog(), 'data-composer-plus-memory-suggestion-accept', '0').p.disabled, false, 'it can be accepted again');
    acceptError = undefined;
    // Off: the dialog closes and the slots go.
    const store = dOpts.inject().suggest;
    assert.notEqual(store.getSnapshot().request, null, 'the dialog is open');
    section.setFeature('memorySuggest', false);
    assert.equal(slotOf('memory-suggest'), undefined); assert.equal(slotOf('memory-suggest-dialog'), undefined);
    assert.equal(store.getSnapshot().request, null, 'off: the dialog closes (it does not come back with the switch)');
  }
  console.log('memory suggest checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
