// Fixed assistant name: always Damon. Host half: the switch route gives `{on}` and refuses `{name}`; the instructions say
// "Your name is Damon." with no saved name and with an old assistant-name.json (that file stays as it was). Retitle: the
// ~/Assistant project and the assistant chat become Damon while their title is "Assistant", the old localized row label
// or an old saved name or title; a title that the user chose stays; a second run changes nothing. Client half: the
// sidebar row shows Damon in every UI language, and Settings has no name field.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_NAME, ASSISTANT_OLD_TITLES, ASSISTANT_PATH, ASSISTANT_SWITCH_PATH, installAssistant } from '../index.js';

const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
assert.equal(ASSISTANT_NAME, 'Damon');

// The old default row labels: the `assistant.title` of each UI language before the fixed name.
assert.deepEqual(ASSISTANT_OLD_TITLES, ['Assistant', '助理', 'Asistan', 'Asistente', 'Assistente', 'Assistent', 'Ассистент', 'アシスタント', '어시스턴트', 'Asisten', 'Trợ lý', 'असिस्टेंट']);

// Host half with a small fake dsh: one saved assistant chat, so its agent gets the section.
const home = await mkdtemp(join(tmpdir(), 'cp-assistant-name-'));
const dir = join(home, 'storages/dsh-composer-plus');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'assistant.json'), JSON.stringify({ sessionId: 's-a' }));
const boot = async () => {
  const routes = new Map(); const sections = new Map();
  const ctx = {
    logger: { warn: () => {} }, get: () => undefined, on: () => {}, effect: () => {},
    inject: (_deps, setup) => { setup({ systemPrompt: { section: (s) => sections.set(s.name, s) } }); return { dispose: () => sections.clear() }; },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  const host = installAssistant(ctx, home, { folder: join(home, 'Assistant'), zone: 'UTC' });
  await host.ready;
  const call = async (method = 'GET', body) => {
    const res = await routes.get(ASSISTANT_SWITCH_PATH).fetch(new Request(`http://x${ASSISTANT_SWITCH_PATH}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: res.status, body: await res.json() };
  };
  const text = () => sections.get('composer-plus:assistant').text({ agent: { id: 's-a', session: { header: {} } } });
  return { call, text };
};
const damon = /You are the user's personal assistant in this chat\. Your name is Damon\. The user gives you small tasks\./;
// No saved name: Damon.
let h = await boot();
assert.deepEqual((await h.call()).body, { on: true }, 'no name in the answer');
assert.match(h.text(), damon, 'no saved name: Damon');
// The name cannot change: POST {name} is refused, and the instructions stay.
for (const body of [{ name: 'Max' }, { name: '' }, { name: 'Max', on: true }]) assert.equal((await h.call('POST', body)).status, 400, `refused: ${JSON.stringify(body)}`);
assert.match(h.text(), damon);
// An old saved name (and a broken file) has no effect, and the file stays as it was.
const file = join(dir, 'assistant-name.json');
const old = JSON.stringify({ name: 'Max', title: 'Max' });
await writeFile(file, old);
h = await boot();
assert.match(h.text(), damon, 'an old saved name: Damon'); assert.doesNotMatch(h.text(), /Max/);
assert.equal((await h.call('POST', { on: false })).status, 200); assert.equal((await h.call('POST', { on: true })).status, 200);
assert.equal(await readFile(file, 'utf8'), old, 'the old file is not changed or removed');
await writeFile(file, '{broken');
h = await boot();
assert.match(h.text(), damon, 'a broken file: Damon');
await rm(home, { recursive: true, force: true });

// Retitle: the ~/Assistant project (dsh's own setTitle; the folder keeps its name) and the assistant chat
// (sessionController.rename) become Damon after dsh's start, when the switch goes on and when the first open adds the
// project. Only an old default title changes.
{
  const home2 = await mkdtemp(join(tmpdir(), 'cp-assistant-title-'));
  const dir2 = join(home2, 'storages/dsh-composer-plus'); await mkdir(dir2, { recursive: true });
  const folder = join(home2, 'Assistant'); await mkdir(folder);
  const real = await realpath(folder); // dsh keeps the real path (/var → /private/var on macOS)
  const project = (path, title) => ({ id: `w-${title}`, path, title, sessionIds: [], sets: 0, async setTitle(next) { this.title = next; this.sets += 1; } });
  const chat = { title: undefined, renames: 0 };
  const start = async (list, { saved } = {}) => {
    if (saved !== undefined) await writeFile(join(dir2, 'assistant-name.json'), JSON.stringify(saved));
    const routes = new Map(); const warnings = []; let onReady;
    const registry = { list: () => list, archivedSessionIds: [],
      create: async (path, title) => { const at = await realpath(path); let w = list.find((x) => x.path === at); if (!w) list.push(w = project(at, title)); return w; } };
    const services = { workspaceRegistry: registry, appReady: { onReady: (f) => { onReady = f; return () => {}; } } };
    const ctx = { logger: { warn: (t) => warnings.push(t) }, get: (n) => services[n], on: () => {}, effect: (f) => { f(); },
      inject: () => ({ dispose: () => {} }),
      sessionQuery: { readTitle: async () => (chat.title === undefined ? undefined : { title: chat.title }) },
      sessionController: { create: async () => ({ sessionId: 's-new' }), resolveAgent: async () => ({ error: { code: 'x' } }),
        rename: async ({ title }) => { chat.title = title; chat.renames += 1; } },
      connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } } };
    const host = installAssistant(ctx, home2, { folder, zone: 'UTC' });
    await host.ready;
    const call = async (path, method = 'GET', body) => {
      const res = await routes.get(path).fetch(new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: res.status, body: await res.json() };
    };
    return { call, warnings, ready: async () => { onReady(); await tick(); } };
  };
  // Each old default title becomes Damon after dsh's start (not before dsh is ready); other projects stay.
  await writeFile(join(dir2, 'assistant.json'), JSON.stringify({ sessionId: 's-a' }));
  const other = project('/demo/acme-web', 'acme-web');
  for (const title of ASSISTANT_OLD_TITLES) {
    const mine = project(real, title); chat.title = title;
    const s = await start([other, mine]);
    await tick(); assert.equal(mine.title, title, 'not before dsh is ready');
    await s.ready(); assert.equal(mine.title, 'Damon', `project "${title}" → Damon`); assert.equal(chat.title, 'Damon', `chat "${title}" → Damon`);
    assert.equal(other.title, 'acme-web', 'other projects stay');
  }
  // An old saved name or title becomes Damon too; a second run (a restart, the switch) changes nothing.
  let mine = project(real, 'Max'); chat.title = 'Max';
  let s = await start([other, mine], { saved: { name: 'Max' } }); await s.ready();
  assert.equal(mine.title, 'Damon', 'an old saved name → Damon'); assert.equal(chat.title, 'Damon');
  mine = project(real, 'Rex'); chat.title = 'Assistant';
  s = await start([other, mine], { saved: { name: 'Max', title: 'Rex' } }); await s.ready();
  assert.equal(mine.title, 'Damon', 'the last title that an older version set → Damon');
  const sets = mine.sets; const renames = chat.renames;
  s = await start([other, mine]); await s.ready();
  await s.call(ASSISTANT_SWITCH_PATH, 'POST', { on: false }); await s.call(ASSISTANT_SWITCH_PATH, 'POST', { on: true });
  assert.equal(mine.sets, sets, 'idempotent: no second setTitle'); assert.equal(chat.renames, renames, 'idempotent: no second rename');
  // A title that the user chose in dsh stays (project and chat).
  mine.title = 'My helper'; chat.title = 'Daily';
  s = await start([other, mine]); await s.ready();
  assert.equal(mine.title, 'My helper', 'the user title stays'); assert.equal(chat.title, 'Daily', 'the user chat title stays');
  // Another project named Damon: the project keeps its title, one warning; the chat still becomes Damon.
  mine.title = 'Assistant'; chat.title = 'Assistant'; other.title = 'Damon';
  s = await start([other, mine]); await s.ready();
  assert.equal(mine.title, 'Assistant', 'no second project named Damon'); assert.equal(chat.title, 'Damon');
  assert.ok(s.warnings.some((w) => /another project is named "Damon"/.test(w)), 'the reason is logged');
  other.title = 'acme-web';
  // Switched off: no change at start; on again: Damon.
  await s.call(ASSISTANT_SWITCH_PATH, 'POST', { on: false });
  s = await start([other, mine]); await s.ready(); assert.equal(mine.title, 'Assistant', 'off: no change at start');
  await s.call(ASSISTANT_SWITCH_PATH, 'POST', { on: true }); assert.equal(mine.title, 'Damon', 'on again: Damon');
  // The first open adds the project as "Assistant" and gives it the name before the chat starts; the chat is Damon.
  await rm(join(dir2, 'assistant.json'), { force: true });
  const list = []; chat.title = undefined;
  s = await start(list);
  await s.ready(); assert.equal(list.length, 0, 'no project before the first open');
  assert.equal((await s.call(ASSISTANT_PATH)).body.sessionId, 's-new');
  assert.equal(list.length, 1); assert.equal(list[0].path, real); assert.equal(list[0].title, 'Damon', 'the new project is Damon');
  assert.equal(chat.title, 'Damon', 'the new chat is Damon');
  // No folder (removed): nothing changes, no warning.
  await rm(folder, { recursive: true });
  s = await start([project('/gone/Assistant', 'Assistant')]);
  await s.ready(); assert.deepEqual(s.warnings, [], 'a missing folder is not an error');
  await rm(home2, { recursive: true, force: true });
}

// Client half: the real client.js with fake dsh slots and a fake Host (an older Host still sends a saved name).
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
globalThis.fetch = async (url) => {
  if (String(url) === '/api/composer-plus.assistant-switch') return Response.json({ on: true, name: 'Max' });
  if (String(url) === '/api/composer-plus.assistant-status') return Response.json({ sessionId: null });
  return new Response('{}', { status: 404 });
};
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: () => {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {} };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
const live = new Map(); let next = 0; let settings;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: () => undefined, locale: { register: () => () => {}, bind: () => (k) => `tr:${k}`, resolveText: (x) => x },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); if (o.name === 'settings.section') settings = o; return () => live.delete(key); } } });
const rows = () => [...live.values()].filter(([o]) => o.name === 'sidebar.panellist' && o.id === 'composer-plus-assistant').map(([o]) => o);
await tick();
assert.equal(rows().length, 1); assert.equal(rows()[0].label(), 'Damon', 'the row is Damon in any UI language, also with an old saved name');
// Settings: the Assistant row has its switch and status, and no name field (no text input).
const section = settings.inject(); const Settings = [...live.values()].find(([o]) => o.id === 'composer-plus')[1];
const assistantRow = Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, assistantSwitch: section.assistantSwitch, t: (k) => k })
  .c.slice(5).find((r) => r.p.key === 'assistant');
assert.ok(assistantRow, 'the Assistant row is in Settings');
const all = []; const walk = (n) => { if (n === null || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(walk); return; } all.push(n);
  if (typeof n.t === 'function' && n.t.name !== '' && !/^[a-z]/.test(n.t.name)) { try { walk(n.t(n.p)); } catch { /* a component that needs more props */ } } (n.c ?? []).forEach(walk); };
walk(assistantRow);
assert.ok(all.length > 3, 'the row was walked');
assert.equal(all.some((n) => n.t === 'input' || n.p?.['data-composer-plus-assistant-name'] !== undefined || n.t?.name === 'AssistantName'), false, 'no name field in Settings');
assert.equal(readFileSync(new URL('../client.js', import.meta.url), 'utf8').includes('assistantName.label'), false, 'no name label in any language');
console.log('assistant name: ok');
