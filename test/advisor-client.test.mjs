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
let hold;
globalThis.fetch = async (url, init) => {
  fetches.push({ url, init });
  if (!String(url).startsWith(ROUTE)) return { ok: true, status: 200, json: async () => ({ on: false }) };
  if (init?.method === 'POST') { const body = JSON.parse(init.body); if (hold && 'maxUses' in body) await hold; host = { ...host, ...body }; }
  const body = String(url).includes('efforts=1') ? { efforts: [{ id: 'high', name: 'High' }] } : String(url).includes('sessionId=') ? { on: host.on, ready: host.on && host.model !== undefined, off: false }
    : String(url).includes('catalog=1') ? { ...host, catalog: { groups: [{ id: 'strong', name: 'Strong', models: [{ id: 'opus', name: 'Opus' }] }] } } : host;
  return { ok: true, status: 200, json: async () => body };
};
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => ({ current: v }), useEffect: (f, deps) => { cur.effects.push([f, deps]); }, useLayoutEffect: () => {}, useSyncExternalStore: (sub, get) => get() };
const render = (C, props, inst = { state: [], deps: [] }) => { cur = inst; inst.si = 0; inst.effects = []; const out = C(props); inst.effects.forEach(([f, deps], i) => { if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return; f(); inst.deps[i] = deps; }); return out; };
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
