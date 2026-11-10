// Assistant name (Settings → Composer Plus → Assistant → Assistant name). Host half: the switch route gives `{on, name}`
// ('' by default), POST `{name}` saves one trimmed line of at most 40 characters in assistant-name.json (owner-only) and
// puts "Your name is <name>." into the assistant chat's instructions at once; '' takes it out again; a bad name is
// refused; a restart reads the saved name. Client half: the sidebar row shows the localized "Assistant" while the name
// is empty and the name after a save (the row registers again, so dsh reads its label again), and the Settings field
// sends the trimmed name.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_SWITCH_PATH, installAssistant } from '../index.js';

const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

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
let h = await boot();
assert.deepEqual((await h.call()).body, { on: true, name: '' }, 'no name by default');
assert.match(h.text(), /You are the user's personal assistant in this chat\. The user gives you small tasks\./, 'the default text has no name');
assert.doesNotMatch(h.text(), /Your name is/);
assert.deepEqual((await h.call('POST', { name: '  Damon ' })).body, { on: true, name: 'Damon' }, 'trimmed');
assert.match(h.text(), /You are the user's personal assistant in this chat\. Your name is Damon\. The user gives you small tasks\./, 'the name is in the instructions at once');
const file = join(dir, 'assistant-name.json');
assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { name: 'Damon' });
assert.equal(((await stat(file)).mode & 0o777).toString(8), '600', 'owner-only');
for (const bad of [42, 'x'.repeat(41), 'two\nlines', 'a\u2028b']) assert.equal((await h.call('POST', { name: bad })).status, 400, `refused: ${JSON.stringify(bad)}`);
assert.equal((await h.call('POST', { name: 'Damon', on: true })).status, 400, 'one setting per POST');
assert.equal((await h.call()).body.name, 'Damon', 'a refused name keeps the saved one');
assert.equal((await h.call('POST', { name: '$& $1' })).body.name, '$& $1');
assert.match(h.text(), /Your name is \$& \$1\./, 'a name is not a replacement pattern');
await h.call('POST', { name: 'Damon' });
// A restart reads the saved name; a broken file reads as no name.
h = await boot();
assert.equal((await h.call()).body.name, 'Damon'); assert.match(h.text(), /Your name is Damon\./);
assert.deepEqual((await h.call('POST', { name: '' })).body, { on: true, name: '' }, 'empty: back to the default');
assert.doesNotMatch(h.text(), /Your name is/);
await writeFile(file, '{broken');
h = await boot();
assert.equal((await h.call()).body.name, '');
await rm(home, { recursive: true, force: true });

// Client half: the real client.js with fake dsh slots and a fake Host.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
let name = ''; const posts = [];
globalThis.fetch = async (url, init) => {
  if (String(url) === '/api/composer-plus.assistant-switch') {
    if (init?.method === 'POST') { const body = JSON.parse(init.body); posts.push(body); if ('name' in body) name = body.name; }
    return Response.json({ on: true, name });
  }
  if (String(url) === '/api/composer-plus.assistant-status') return Response.json({ sessionId: null });
  return new Response('{}', { status: 404 });
};
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: () => {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {} };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
const live = new Map(); let next = 0; let settings;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: () => undefined, locale: { register: () => () => {}, bind: () => (k) => (k === 'assistant.title' ? 'Asistan' : k), resolveText: (x) => x },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); if (o.name === 'settings.section') settings = o; return () => live.delete(key); } } });
const rows = () => [...live.values()].filter(([o]) => o.name === 'sidebar.panellist' && o.id === 'composer-plus-assistant').map(([o]) => o);
await tick();
assert.equal(rows().length, 1); assert.equal(rows()[0].label(), 'Asistan', 'empty name: the localized default');
// The Settings field under the Assistant switch: it shows the saved name, and Save (or Enter) sends the trimmed text.
const section = settings.inject(); const Settings = [...live.values()].find(([o]) => o.id === 'composer-plus')[1];
const t = (k) => k;
const assistantRow = () => Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, assistantSwitch: section.assistantSwitch, t })
  .c.slice(5).find((r) => r.p.key === 'assistant');
/** The field as drawn; `draft`: the text that the user typed (the field's own state). */
const fieldOf = (draft) => {
  const f = assistantRow().c[1].c.find((c) => c?.t?.name === 'AssistantName');
  if (!f) return undefined;
  const useState = React.useState; if (draft !== undefined) React.useState = () => [draft, () => {}];
  try { return f.t(f.p); } finally { React.useState = useState; }
};
let field = fieldOf();
assert.ok(field, 'the name field shows under the Assistant switch');
assert.equal(field.c[0].c[0], 'assistantName.label'); assert.equal(field.c[1].p.value, ''); assert.equal(field.c[1].p.placeholder, 'assistant.title', 'the default name as its placeholder');
assert.equal(field.c[2].p.disabled, true, 'Save waits for a change');
field = fieldOf('  Damon ');
assert.equal(field.c[2].p.disabled, false);
field.c[2].p.onClick(); await tick();
assert.deepEqual(posts.at(-1), { name: 'Damon' }, 'the trimmed name goes to the Host');
assert.equal(rows().length, 1, 'one row'); assert.equal(rows()[0].label(), 'Damon', 'the row shows the name');
assert.equal(fieldOf().c[1].p.value, 'Damon');
await section.assistantSwitch.post({ name: '' }, { busy: true }); await tick();
assert.equal(rows().length, 1); assert.equal(rows()[0].label(), 'Asistan', 'empty again: the default');
// An older Host half (no `name` in its answer): no field, the default label.
name = undefined; await section.assistantSwitch.refresh(); await tick();
assert.equal(fieldOf() ?? null, null, 'no field for an older Host'); assert.equal(rows()[0].label(), 'Asistan');
console.log('assistant name: ok');
