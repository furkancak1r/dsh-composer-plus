// Advisor model (client half), real client.js with fake React: off by default (no slot until the Host says on); on: the chat
// header's per-chat button and the advisor tool's row. Settings: the Host switch, the Model menu (no dsh default: "No
// model") and the advisor menus, which read the chosen model only from the model store (rule 7: the two stores never write
// the same field; a model change refreshes the switch store only while it saves nothing). The Advice row parses the tool
// result's first line; an error result shows "No advice".
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ROUTE = '/api/composer-plus.advisor';
const fetches = [];
let host = { on: false, maxUses: 3, maxTokens: 16000, subagents: false };
let hold; let holdModel; let holdOn; let failNext;
globalThis.fetch = async (url, init) => {
  fetches.push({ url, init });
  if (!String(url).startsWith(ROUTE)) return { ok: true, status: 200, json: async () => ({ on: false }) };
  if (init?.method === 'POST') { const body = JSON.parse(init.body); if (failNext) { failNext = false; return { ok: false, status: 500, json: async () => ({ error: 'disk full' }) }; } if (holdOn && 'on' in body) await holdOn; if (hold && 'maxUses' in body) await hold; if (holdModel && 'model' in body) await holdModel; host = { ...host, ...body }; if (host.model === null) delete host.model; } // the Host drops a removed model
  const body = String(url).includes('efforts=1') ? { efforts: host.model?.model === 'opus' ? [{ id: 'high', name: 'High' }] : [] } : String(url).includes('sessionId=') ? { on: host.on, ready: host.on && host.model !== undefined, off: false }
    : String(url).includes('catalog=1') ? { ...host, catalog: { groups: [{ id: 'strong', name: 'Strong', models: [{ id: 'opus', name: 'Opus' }] }] } } : host;
  return { ok: true, status: 200, json: async () => body };
};
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; return cur.refs[i] ??= { current: v }; }, useEffect: (f, deps) => { cur.effects.push([f, deps]); }, useLayoutEffect: () => {}, useSyncExternalStore: (sub, get) => get() };
const render = (C, props, inst = { state: [], deps: [] }) => { cur = inst; inst.si = 0; inst.ri = 0; inst.refs ??= []; inst.effects = []; const out = C(props); inst.effects.forEach(([f, deps], i) => { if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return; f(); inst.deps[i] = deps; }); return out; };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu', Switch: 'Switch', MarkdownText: 'MarkdownText' } : {}));
const regs = []; const gone = [];
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k, getSnapshot: () => ({ active: 'en' }) },
  sessions: { binding: () => ({}), scope: () => undefined, list: { getSnapshot: () => ({ byId: {} }) } },
  slots: { inject: (n, f) => f(), register: (o, C) => { const r = [o, C]; regs.push(r); return () => { gone.push(o.id); }; } } });
const tick = () => new Promise((r) => setTimeout(r, 0));
await tick();
assert.ok(!regs.some(([o]) => o.id === 'advisor-chat'), 'off by default: no header button');
const settings = regs.find(([o]) => o.id === 'composer-plus');
const sp = settings[0].inject();
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
// Switch on through the Host: the header button and the tool row come.
await sp.setFeature('advisor', true); await tick();
assert.deepEqual(JSON.parse(fetches.filter((f) => f.url === ROUTE && f.init?.method === 'POST').at(-1).init.body), { on: true }, 'the Host keeps the switch');
const header = regs.find(([o]) => o.id === 'advisor-chat'); const row = regs.find(([o]) => o.key === 'advisor');
assert.ok(header && row, 'on: the header button and the Advice row');
assert.equal(header[0].name, 'conversation.session.header.utilities'); assert.equal(row[0].name, 'tool.call.toolview');
const hp = header[0].inject();
assert.equal(hp.prefix, 'advisor.chat'); assert.equal(hp.attr, 'data-composer-plus-advisor-chat');
// The header button shows only while the tool is offered (on and a model chosen).
// Children and a Menu's anchor button.
const all = (node, out = []) => { if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of [...(node.c ?? []), node.p?.anchor]) all(c, out); return out; };
const btn = (out) => all(out).find((n) => n.t === 'button');
const hInst = { state: [], deps: [] };
render(header[1], { ...hp, sessionId: 's1', t }, hInst); await tick();
assert.equal(btn(render(header[1], { ...hp, sessionId: 's1', t }, hInst)), undefined, 'no model: no header button');
// Settings row: switch status, Model menu (advisor flag), the advisor menus.
const tree = settings[1]({ ...sp, useComposerPlusToggles: (f) => f({ advisor: true }), t: (k) => k });
const srow = tree.c.slice(5).find((r) => r.p.key === 'advisor');
assert.ok(srow.c[1].c.some((c) => c?.t?.name === 'PredictionModel' && c.p.advisor === true), 'the Model menu');
const settingsEl = srow.c[1].c.find((c) => c?.t?.name === 'AdvisorSettings');
assert.ok(settingsEl && settingsEl.p.models === sp.advisorModel, 'the advisor menus read the model store');
// Rule 7: a model change does not overwrite a running save of the switch store.
await sp.advisorModel.load(); await sp.advisorSwitch.refresh();
let release; hold = new Promise((r) => { release = r; });
const sInst = { state: [], deps: [] };
render(settingsEl.t, { ...settingsEl.p, t }, sInst);
const saving = sp.advisorSwitch.post({ maxUses: 5 }, { maxUses: 5, busy: true });
await sp.advisorModel.setModel({ provider: 'strong', model: 'opus' }).catch(() => {});
render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick();
assert.equal(sp.advisorSwitch.getSnapshot().busy, true, 'the save still shows as busy after a model change');
release(); hold = undefined; await saving;
assert.equal(sp.advisorSwitch.getSnapshot().maxUses, 5, 'the saved value stays');
const effortMenu = (out) => all(out).find((n) => n.p?.['data-composer-plus-advisor'] === 'effort');
render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick(); await tick();
assert.ok(effortMenu(render(settingsEl.t, { ...settingsEl.p, t }, sInst)), 'the chosen model lists efforts: a Reasoning menu');
// While a model saves, the menus wait (disabled, a save does nothing) and nothing is read; after it, the efforts of the
// new model are read from the Host (which has the new model then).
{
  let go; holdModel = new Promise((r) => { go = r; });
  const posts = () => fetches.filter((f) => f.url === ROUTE && f.init?.method === 'POST').length;
  const effortReads = () => fetches.filter((f) => String(f.url).includes('efforts=1')).length;
  const p0 = posts();
  const changing = sp.advisorModel.setModel(null);
  const e0 = effortReads();
  let out = render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick();
  const buttons = all(out).filter((n) => n.t === 'button' && n.p['data-composer-plus-advisor'] !== undefined);
  assert.ok(buttons.length >= 3 && buttons.every((n) => n.p.disabled === true), 'the menus are disabled while the model saves');
  const uses = all(out).find((n) => n.t === 'Menu' && n.p.anchor?.p?.['data-composer-plus-advisor'] === 'uses');
  uses.p.onSelect('10'); await tick();
  assert.equal(posts(), p0 + 1, 'a menu save waits for the model save: only the model POST');
  assert.equal(effortReads(), e0, 'no efforts read while the model saves');
  const reads = () => fetches.filter((f) => f.url === ROUTE && f.init === undefined).length;
  const r0 = reads();
  go(); holdModel = undefined; await changing;
  render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick(); await tick();
  assert.ok(reads() > r0, 'the settings are read again after the save (the Host dropped the effort)');
  assert.equal(effortReads(), e0, 'no model: no efforts to read');
  // Choose the model again: its efforts are read after its save, from the Host that has it.
  holdModel = new Promise((r) => { go = r; });
  const again = sp.advisorModel.setModel({ provider: 'strong', model: 'opus' });
  render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick();
  assert.equal(effortReads(), e0, 'not while it saves');
  go(); holdModel = undefined; await again;
  render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick(); await tick();
  assert.equal(effortReads(), e0 + 1, 'once after the save');
  assert.ok(effortMenu(render(settingsEl.t, { ...settingsEl.p, t }, sInst)), 'the new model\'s efforts');
  await sp.advisorModel.setModel(null);
  render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick(); await tick();
  out = render(settingsEl.t, { ...settingsEl.p, t }, sInst);
  assert.equal(effortMenu(out), undefined, 'no model now: no Reasoning menu (the Host answered for the new state)');
}
// A menu save reads nothing again (the Reasoning menu stays, no extra GET), and a refused save keeps its reason.
{
  const gets = () => fetches.filter((f) => String(f.url).startsWith(ROUTE) && f.init === undefined).length;
  await sp.advisorModel.setModel({ provider: 'strong', model: 'opus' });
  for (let i = 0; i < 3; i++) { render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick(); }
  const g0 = gets();
  let go; hold = new Promise((r) => { go = r; });
  const saving = sp.advisorSwitch.post({ maxUses: 10 }, { maxUses: 10, busy: true });
  render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick();
  assert.ok(effortMenu(render(settingsEl.t, { ...settingsEl.p, t }, sInst)), 'the Reasoning menu stays while a menu saves');
  go(); hold = undefined; await saving;
  for (let i = 0; i < 3; i++) { render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick(); }
  assert.equal(gets(), g0, 'a menu save reads nothing again');
  failNext = true;
  await sp.advisorSwitch.post({ maxUses: 20 }, { maxUses: 20, busy: true });
  for (let i = 0; i < 3; i++) { render(settingsEl.t, { ...settingsEl.p, t }, sInst); await tick(); }
  assert.equal(sp.advisorSwitch.getSnapshot().error, 'disk full', 'the reason of a refused save stays');
  assert.equal(sp.advisorSwitch.getSnapshot().maxUses, 10, 'and the saved value');
}
// Switching it on in Settings: the advisor menus that appear wait for the switch save; the Host's answer wins (rule 7).
{
  host.on = false; await sp.advisorSwitch.refresh();
  let go; holdOn = new Promise((r) => { go = r; });
  const turning = sp.setFeature('advisor', true);
  const inst = { state: [], deps: [] };
  render(settingsEl.t, { ...settingsEl.p, t }, inst); await tick();
  render(settingsEl.t, { ...settingsEl.p, t }, inst); await tick();
  go(); holdOn = undefined; await turning;
  for (let i = 0; i < 3; i++) { render(settingsEl.t, { ...settingsEl.p, t }, inst); await tick(); }
  assert.equal(sp.advisorSwitch.getSnapshot().on, true, 'the switch stays on (a read during the save does not win)');
}
// The Settings switch waits for a running save too: no {on} POST while a menu save runs.
{
  const onPosts = () => fetches.filter((f) => f.url === ROUTE && f.init?.method === 'POST' && 'on' in JSON.parse(f.init.body)).length;
  let go; hold = new Promise((r) => { go = r; });
  const saving = sp.advisorSwitch.post({ maxUses: 5 }, { maxUses: 5, busy: true });
  const n = onPosts();
  await sp.setFeature('advisor', false);
  assert.equal(onPosts(), n, 'no switch POST while a save runs');
  go(); hold = undefined; await saving;
  assert.equal(sp.advisorSwitch.getSnapshot().maxUses, 5, 'the menu save keeps its answer');
}
// A refused switch-off keeps its reason, also when the advisor menus mount again (a new Settings instance).
{
  failNext = true;
  await sp.setFeature('advisor', false);
  assert.equal(sp.advisorSwitch.getSnapshot().on, true); assert.equal(sp.advisorSwitch.getSnapshot().error, 'disk full');
  const inst = { state: [], deps: [] };
  for (let i = 0; i < 3; i++) { render(settingsEl.t, { ...settingsEl.p, t }, inst); await tick(); }
  assert.equal(sp.advisorSwitch.getSnapshot().error, 'disk full', 'the reason stays after the menus mount again');
}
// The Advice row: running, done (parsed first line), error.
const R = row[1];
assert.match(JSON.stringify(R({ phase: 'start', t })), /advisor.card.running/);
const done = R({ phase: 'result', block: { isError: false, content: [{ type: 'text', text: 'Advice from opus (1200 input tokens, 30 output tokens; use 1 of 3 in this chat):\n\nUse a cache.' }] }, t });
assert.match(JSON.stringify(done), /advisor.card.meta:\{\\"model\\":\\"opus\\",\\"input\\":\\"1,200\\",\\"output\\":\\"30\\",\\"use\\":\\"1\\",\\"max\\":\\"3\\"\}/);
assert.ok(all(done).some((n) => n.t === 'MarkdownText' && n.p.text === 'Use a cache.'), 'the advice as Markdown, without the first line');
const failed = R({ phase: 'result', block: { isError: true, content: [{ type: 'text', text: 'Error: The advisor limit of this chat is reached (3 uses).' }] }, t });
assert.match(JSON.stringify(failed), /advisor.card.failed/); assert.match(JSON.stringify(failed), /limit of this chat is reached/);
// Off again: the header button and the row go.
host.on = false; await sp.setFeature('advisor', false); await tick();
assert.ok(gone.includes('advisor-chat'), 'off removes the header button');
console.log('advisor client checks passed');
