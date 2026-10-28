// Default workspace (client half): the wrapper on dsh's `uiWorkspace.startSession` (a call without a workspace opens the
// Host's target; a project's "+" passes through; the newest click wins; a failure leaves dsh's choice; switch-off gives
// the method back, also under another plugin's wrapper; the Cordis proxy resolves to the raw object) and the Settings
// store and picker (one choice at a time, a refused choice keeps the saved one).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { documentElement: { lang: 'en' }, addEventListener() {}, removeEventListener() {} };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__dw = { installDefaultStart, createDefaultWorkspace, DefaultWorkspacePicker };\n    ${ANCHOR}`));
// Hooks are plain values here; `opened` is the picker menu's one state.
let opened = false;
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), useState: () => [opened, (x) => { opened = x; }], useEffect() {}, useSyncExternalStore: (s, g) => g() };
mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu' } : {}));
const tick = () => new Promise((r) => setTimeout(r, 0));
const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
const warn = console.warn; const warnings = []; console.warn = (...a) => { warnings.push(a); };

// A UiWorkspaceService-like object: `startSession` on the prototype, like dsh's class.
class Ui { constructor() { this.calls = []; } startSession(workspaceId, options) { this.calls.push([this, workspaceId, options]); } }
const workspaces = (ids) => {
  const created = [];
  return { created, list: { getSnapshot: () => ({ items: ids.map((workspaceId) => ({ workspaceId })) }) },
    create: async (input) => { created.push(input); return { workspaceId: `resolved:${input.path}` }; } };
};
const { installDefaultStart } = globalThis.__dw;

// A call without a workspace opens the Host's target; `this` and the options stay; a "+" call passes at once.
{
  const ui = new Ui(); let asks = 0;
  const off = installDefaultStart(ui, workspaces(['casual']), async () => { asks += 1; return { workspaceId: 'casual', path: '/p/casual' }; });
  assert.ok(Object.hasOwn(ui, 'startSession'), 'the wrapper sits on the object');
  ui.startSession(undefined, { clearPreviousDraft: false });
  assert.equal(ui.calls.length, 0, 'waits for the Host');
  await tick(); await tick();
  assert.deepEqual(ui.calls.map(([self, id, o]) => [self === ui, id, o]), [[true, 'casual', { clearPreviousDraft: false }]]);
  ui.startSession('acme');
  assert.deepEqual(ui.calls.at(-1).slice(1), ['acme', undefined], 'a project\'s "+" opens its project at once');
  assert.equal(asks, 1, 'no Host call for "+"');
  off();
  assert.equal(Object.hasOwn(ui, 'startSession'), false, 'switch-off gives the prototype method back');
  ui.startSession(); assert.deepEqual(ui.calls.at(-1).slice(1), [undefined, undefined]);
}
// A project that the Host just made and that dsh's list does not have yet: added by its path first.
{
  const ui = new Ui(); const ws = workspaces(['acme']);
  installDefaultStart(ui, ws, async () => ({ workspaceId: 'w9', path: '/d/deepseek-harness/default-workspace' }));
  ui.startSession(); await tick(); await tick(); await tick();
  assert.deepEqual(ws.created, [{ path: '/d/deepseek-harness/default-workspace' }]);
  assert.equal(ui.calls[0][1], 'resolved:/d/deepseek-harness/default-workspace');
}
// The newest click wins: an older answer that comes later opens nothing.
{
  const ui = new Ui(); const answers = [gate(), gate()]; let n = 0;
  installDefaultStart(ui, workspaces(['a', 'b']), () => answers[n++].p);
  ui.startSession(); ui.startSession();
  answers[1].go({ workspaceId: 'b' }); await tick(); await tick();
  answers[0].go({ workspaceId: 'a' }); await tick(); await tick();
  assert.deepEqual(ui.calls.map(([, id]) => id), ['b']);
}
// A project's "+" while a global click waits for the Host: the "+" wins, the late answer opens nothing.
{
  const ui = new Ui(); const g = gate();
  installDefaultStart(ui, workspaces(['casual']), () => g.p);
  ui.startSession(); ui.startSession('acme');
  g.go({ workspaceId: 'casual' }); await tick(); await tick();
  assert.deepEqual(ui.calls.map(([, id]) => id), ['acme']);
}
// A failure (switch off, Host down, older Host, bad answer) leaves dsh's own choice.
for (const target of [async () => { throw new Error('off'); }, async () => { throw new Error('restart'); }, async () => ({}), async () => null]) {
  const ui = new Ui(); warnings.length = 0;
  installDefaultStart(ui, workspaces([]), target);
  ui.startSession(undefined, { agentPreset: 'cordis' }); await tick(); await tick();
  assert.deepEqual(ui.calls.map(([, id, o]) => [id, o]), [[undefined, { agentPreset: 'cordis' }]]);
}
assert.equal(warnings.length, 1, 'a bad answer is logged; "off" and an older Host ("restart") are not');
// Switched off while the Host answers: dsh picks.
{
  const ui = new Ui(); const g = gate();
  const off = installDefaultStart(ui, workspaces(['a']), () => g.p);
  ui.startSession(); off(); g.go({ workspaceId: 'a' }); await tick(); await tick();
  assert.deepEqual(ui.calls.map(([, id]) => id), [undefined]);
}
// Another plugin wraps it after us: switch-off keeps its wrapper, and ours passes each call through.
{
  const ui = new Ui(); let asks = 0;
  const off = installDefaultStart(ui, workspaces(['a']), async () => { asks += 1; return { workspaceId: 'a' }; });
  const ours = ui.startSession;
  const theirs = function (...a) { return ours.apply(this, a); };
  ui.startSession = theirs;
  off();
  assert.equal(ui.startSession, theirs);
  ui.startSession(); await tick();
  assert.deepEqual([asks, ui.calls.map(([, id]) => id)], [0, [undefined]]);
}
// The Cordis proxy (what `ctx.inject` gives): the wrapper goes on the raw object, which the ⌘N shortcut calls.
{
  const raw = new Ui();
  const proxy = new Proxy(raw, { get: (t, p) => (p === Symbol.for('cordis.original') ? t : Reflect.get(t, p)), set: () => { throw new Error('a write through the proxy'); } });
  const off = installDefaultStart(proxy, workspaces(['a']), async () => ({ workspaceId: 'a' }));
  assert.ok(Object.hasOwn(raw, 'startSession'));
  raw.startSession(); await tick(); await tick();
  assert.deepEqual(raw.calls.map(([, id]) => id), ['a']);
  off(); assert.equal(Object.hasOwn(raw, 'startSession'), false);
}
// No method (another dsh): nothing changes.
{ const plain = {}; installDefaultStart(plain, workspaces([]), async () => ({}))(); assert.deepEqual(Object.keys(plain), []); }

// Settings store: one choice at a time; a refused choice keeps the saved one and shows the reason.
{
  const { createDefaultWorkspace } = globalThis.__dw;
  const sent = []; let reply;
  globalThis.fetch = async (url, init) => { sent.push([url, init?.body]); const r = await reply(init); return { status: r.status, ok: r.status < 400, json: async () => r.body }; };
  const store = createDefaultWorkspace();
  reply = () => ({ status: 200, body: { on: true, available: true, general: { path: '/g' } } });
  await store.refresh();
  const slow = gate(); reply = () => slow.p;
  const first = store.choose('casual');
  assert.equal(store.getSnapshot().busy, true);
  await store.choose('acme');
  assert.deepEqual(sent.slice(1).map(([, b]) => b), ['{"workspaceId":"casual"}'], 'a click while one saves is ignored');
  slow.go({ status: 200, body: { on: true, workspaceId: 'casual', available: true } }); await first;
  assert.deepEqual([store.getSnapshot().workspaceId, store.getSnapshot().busy], ['casual', undefined]);
  reply = () => ({ status: 409, body: { error: 'this project is not in dsh' } });
  await store.choose('gone');
  assert.deepEqual([store.getSnapshot().workspaceId, store.getSnapshot().error], ['casual', 'this project is not in dsh'], 'the saved choice stays');
  reply = () => ({ status: 200, body: { on: false, workspaceId: 'casual', available: true } });
  await store.setOn(false);
  assert.equal(sent.at(-1)[1], '{"on":false}');
}
// Settings picker: the general folder first, then dsh's projects A–Z without the general folder's own row.
{
  const { DefaultWorkspacePicker } = globalThis.__dw;
  let state = { on: true, available: true, workspaceId: 'c', general: { workspaceId: 'g', path: '/d/deepseek-harness/default-workspace' } };
  const store = { subscribe: () => () => {}, getSnapshot: () => state, refresh() {}, chosen: [], choose(id) { this.chosen.push(id); } };
  const items = [{ workspaceId: 'z', title: 'zeta', path: '/p/zeta' }, { workspaceId: 'g', title: 'default-workspace', path: '/d/deepseek-harness/default-workspace' },
    { workspaceId: 'c', title: 'casual', path: '/p/casual' }, { workspaceId: 'a', title: 'Acme', path: '/p/acme' }];
  const render = () => DefaultWorkspacePicker({ store, useWorkspaces: (f) => f({ items }), t: (k) => k });
  let tree = render();
  const menu = tree.c[1];
  assert.equal(menu.t, 'Menu');
  assert.deepEqual(menu.p.items.map((i) => i.label ?? i.type), ['defaultWorkspace.general', 'separator', 'Acme', 'casual', 'zeta']);
  assert.equal(menu.p.selectedId, 'c');
  assert.equal(menu.p.anchor.p.title, '/p/casual');
  menu.p.onSelect('::general'); menu.p.onSelect('c'); menu.p.onSelect('z');
  assert.deepEqual(store.chosen, [null, 'z'], 'the same row sends nothing');
  state = { ...state, gone: true };
  tree = render();
  assert.equal(tree.c[1].p.selectedId, '::general');
  assert.equal(tree.c[2].c[0], 'defaultWorkspace.gone');
  state = { ...state, busy: true }; assert.equal(render().c[1].p.anchor.p.disabled, true);
  document.documentElement.lang = 'not a language!'; state = { on: true, available: true, general: { workspaceId: 'g', path: '/g' } };
  assert.deepEqual(render().c[1].p.items.map((i) => i.label ?? i.type).slice(2), ['Acme', 'casual', 'zeta'], 'a bad page language still sorts');
  document.documentElement.lang = 'en';
  state = { available: false }; assert.equal(render(), null, 'no registry in this dsh: no picker');
}
console.warn = warn;
console.log('default workspace client checks passed');
