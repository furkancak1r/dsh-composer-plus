// Goal check (client half), real client.js with fake React: on by default (a dock entry right under dsh's goal bar); the
// row shows only for a top-level chat with an unfinished goal; it reads the chat's check on open and after a turn edge;
// it shows the test that will run (own or found), the last result and the budget; Edit → Save sends the chat's command and
// limits, an invalid limit is refused in the browser; Run now and Clear; one action per chat at a time from every entry
// point (button, Enter); an older load never replaces a newer answer; an error shows. Settings: a Host switch and a Model
// menu on the goal-check route; switching the feature off removes the dock entry and stops the store.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ROUTE = '/api/composer-plus.goal-check';
const fetches = [];
let reply = async () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  fetches.push({ url, init });
  const r = await reply(url, init);
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; return cur.refs[i] ??= { current: v }; },
  useEffect: (f, deps) => { cur.effects.push([f, deps]); }, useLayoutEffect: (f, deps) => { cur.effects.push([f, deps]); },
  useSyncExternalStore: (sub, get) => get() };
const mount = (C, props) => {
  const inst = { state: [], refs: [], deps: [], cleanups: [] };
  let out;
  const render = () => {
    cur = inst; inst.si = 0; inst.ri = 0; inst.effects = [];
    out = C(props());
    inst.effects.forEach(([f, deps], i) => {
      if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return;
      inst.cleanups[i]?.(); inst.cleanups[i] = f(); inst.deps[i] = deps;
    });
  };
  const settle = async () => { for (let i = 0; i < 4; i++) { render(); await new Promise((r) => setTimeout(r, 0)); } render(); return out; };
  return { settle, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu', Switch: 'Switch', Input: 'Input', Tooltip: 'Tooltip' } : {}));
const regs = [];
const unregistered = [];
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k, getSnapshot: () => ({ active: 'en' }) },
  sessions: { binding: () => ({ eventSource: 'events' }), scope: () => undefined },
  slots: { inject: (n, f) => f(), register: (o, C) => { const r = [o, C]; regs.push(r); return () => { unregistered.push(o.id); }; } } });
const entry = regs.find(([o]) => o.id === 'goal-check');
assert.ok(entry, 'on by default: the dock entry is installed');
const [opt, GoalCheck] = entry;
assert.equal(opt.name, 'conversation.input.dock'); assert.equal(opt.order, 11, 'right under the goal bar'); assert.equal(opt.locale, 'dsh-composer-plus');
const injected = opt.inject('s1');
assert.equal(injected.hooks.turnEnd, 'events', 'the turn-end hook of the chat'); assert.equal(injected.locale, 'en');

// Find helpers on the fake tree.
const all = (node, out = []) => { if (node === null || typeof node !== 'object') return out; out.push(node); for (const c of node.c ?? []) all(c, out); return out; };
const text = (node) => (typeof node === 'string' || typeof node === 'number' ? String(node) : node === null || typeof node !== 'object' ? '' : (node.c ?? []).map(text).join(''));
const button = (out, label) => all(out).find((n) => n.t === 'button' && text(n) === label);
const inputs = (out) => all(out).filter((n) => n.t === 'input');

const goalActive = { goal: { id: 'goal-1', revision: 1, phase: 'active', objective: 'Ship it' } };
let projection = goalActive;
let session = { subagent: null, removed: false };
let turnSeq = 10;
let chat = 's1';
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
const props = () => ({ ...opt.inject(chat), sessionId: chat, t, useSession: (f) => f(session), useProjection: (key) => (key === 'goal' ? projection : undefined),
  useTurnEnd: (f) => f({ entries: [{ event: { seq: turnSeq } }] }) });
const view = (over = {}) => ({ on: true, check: null, detected: 'npm test', last: null, running: false, goal: { id: 'goal-1', phase: 'active', elapsedMs: 600000, tokens: 1234 }, ...over });
let current = view();
reply = async (url, init) => {
  if (init === undefined) return { status: 200, body: current };
  const body = JSON.parse(init.body);
  if (body.check !== undefined) current = view({ check: body.check });
  if (body.run === true) current = view({ check: current.check, last: { ok: false, stage: 'test', code: 1, at: Date.now(), command: 'npm test', tail: 'not ok' } });
  return { status: 200, body: current };
};
const loads = () => fetches.filter((f) => f.url === `${ROUTE}?sessionId=s1`).length;
const posts = () => fetches.filter((f) => f.url === ROUTE && f.init?.method === 'POST').map((f) => JSON.parse(f.init.body));

// No goal, a completed goal, a subagent: nothing.
projection = null; let v = mount(GoalCheck, props); assert.equal(await v.settle(), null, 'no goal: no row'); assert.equal(loads(), 0);
projection = { goal: { ...goalActive.goal, phase: 'complete' } }; assert.equal(await v.settle(), null, 'a completed goal: no row');
projection = goalActive; session = { subagent: { parent: 'p' }, removed: false }; assert.equal(await v.settle(), null, 'a subagent chat: no row');
session = { subagent: null, removed: false };
// A goal: the row loads the chat's check and shows the found test and no result yet.
let out = await v.settle();
assert.equal(out.p['data-composer-plus-goal-check'], ''); assert.equal(out.p.role, 'group'); assert.equal(loads(), 1, 'one read on open');
assert.ok(text(out).includes('goalCheck.testDetected:{"command":"npm test"}'));
assert.equal(button(out, 'goalCheck.clear'), undefined, 'no own check: nothing to clear');
// A paused or blocked goal still shows (its check settings stay editable).
projection = { goal: { ...goalActive.goal, phase: 'blocked' } }; out = await v.settle(); assert.ok(out !== null); projection = goalActive; out = await v.settle();
// A turn edge reads again (only the turn edge changes here).
{ const before = loads(); turnSeq = 11; out = await v.settle(); assert.equal(loads(), before + 1, 'read again after a turn edge'); }

// Edit → invalid limit → refused in the browser; then Save sends the command and limits.
button(out, 'goalCheck.edit').p.onClick(); out = await v.settle();
let [cmd, minutes, tokens] = inputs(out);
assert.equal(cmd.p.placeholder, 'goalCheck.commandHint:{"command":"npm test"}');
cmd.p.onChange({ target: { value: ' npm run test:unit ' } }); minutes.p.onChange({ target: { value: '0' } }); out = await v.settle();
button(out, 'goalCheck.save').p.onClick(); out = await v.settle();
assert.equal(posts().length, 0, 'an invalid limit is not sent'); assert.ok(all(out).some((n) => n.p.role === 'alert' && text(n) === 'goalCheck.invalid'));
[cmd, minutes, tokens] = inputs(out);
minutes.p.onChange({ target: { value: '30' } }); tokens.p.onChange({ target: { value: '500000' } }); out = await v.settle();
// Enter twice while the save runs: one POST (the guard is in the store, not only in the button).
let release;
const slow = new Promise((r) => { release = r; });
const fast = reply;
reply = async (url, init) => { if (init !== undefined) await slow; return fast(url, init); };
const key = (k) => ({ key: k, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });
[cmd] = inputs(out); cmd.p.onKeyDown(key('Enter')); out = await v.settle();
[cmd] = inputs(out); assert.equal(cmd.p.disabled, true, 'fields are disabled while it saves');
cmd.p.onKeyDown(key('Enter')); button(out, 'goalCheck.run').p.onClick();
assert.equal(posts().length, 1, 'one action at a time from Enter, the button and Run now');
// A load that started before the save ended answers the old view later: it does not overwrite the save's answer.
let releaseLoad;
const oldView = current;
reply = async (url, init) => { if (init !== undefined) { await slow; return fast(url, init); } await new Promise((r) => { releaseLoad = r; }); return { status: 200, body: oldView }; };
const loading = injected.checks.load('s1');
await new Promise((r) => setTimeout(r, 0));
release(); for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
releaseLoad(); await loading; out = await v.settle(); reply = fast;
assert.deepEqual(posts()[0], { sessionId: 's1', check: { command: 'npm run test:unit', minutes: 30, tokens: 500000 } });
assert.equal(inputs(out).length, 0, 'the form closes after a save');
assert.ok(text(out).includes('goalCheck.test:{"command":"npm run test:unit"}'), 'the own command');
assert.ok(text(out).includes(`goalCheck.budget:${JSON.stringify({ used: 'goalCheck.budgetMinutes:{"used":10,"limit":30} · goalCheck.budgetTokens:{"used":"1,234","limit":"500,000"}' })}`), 'the budget: minutes and tokens');
// Esc closes the form without a request; an IME Enter does nothing.
button(out, 'goalCheck.edit').p.onClick(); out = await v.settle();
[cmd] = inputs(out); cmd.p.onKeyDown({ ...key('Enter'), nativeEvent: { isComposing: true } }); assert.equal(posts().length, 1, 'IME Enter: no save');
cmd.p.onKeyDown(key('Escape')); out = await v.settle(); assert.equal(inputs(out).length, 0); assert.equal(posts().length, 1);

// Run now: the result shows.
button(out, 'goalCheck.run').p.onClick(); out = await v.settle();
assert.deepEqual(posts().at(-1), { sessionId: 's1', run: true });
assert.ok(all(out).some((n) => n.p.className === 'cp-gc-bad' && text(n).startsWith('✗ goalCheck.failedTest:{"code":1')), 'the failed test shows');
assert.ok(!text(out).includes('goalCheck.verified'), 'no table: no tally');
// The verifier's evidence table: "1 of 3 verified", each part with its evidence and fix in the tooltips.
{
  const items = [{ item: 'Logout button', verdict: 'verified', evidence: 'Header.tsx', fix: '' }, { item: 'Tests', verdict: 'unresolved', evidence: 'no test', fix: 'add one' }, { item: 'README', verdict: 'incorrect', evidence: '', fix: '' }];
  const saved = current;
  current = view({ check: current.check, last: { ok: false, stage: 'verifier', at: Date.now(), reason: 'Half done', missing: ['Tests: add one', 'README'], items } });
  turnSeq += 1; out = await v.settle();
  const tally = all(out).find((n) => text(n) === 'goalCheck.verified:{"count":1,"total":3}');
  assert.ok(tally, 'N of M verified'); assert.equal(tally.p.title, '✓ Logout button — Header.tsx\n? Tests — no test → add one\n✗ README');
  const bad = all(out).find((n) => n.p.className === 'cp-gc-bad');
  assert.equal(bad.p.title, 'Half done\n✓ Logout button — Header.tsx\n? Tests — no test → add one\n✗ README', 'the result tooltip has the table');
  // Review finding F-02 (2026-10-30): 20 rows shown of a 25-part table count as 24 of 25 (the Host's counts).
  const shown = [{ item: 'p24', verdict: 'incorrect', evidence: '', fix: '' }, ...Array.from({ length: 19 }, (_, i) => ({ item: `p${i}`, verdict: 'verified', evidence: '', fix: '' }))];
  current = view({ check: current.check, last: { ok: false, stage: 'verifier', at: Date.now(), reason: 'One open', missing: ['p24'], items: shown, verified: 24, total: 25 } });
  turnSeq += 1; out = await v.settle();
  assert.ok(all(out).some((n) => text(n) === 'goalCheck.verified:{"count":24,"total":25}'), 'the whole table counts');
  current = saved; turnSeq += 1; out = await v.settle();
}
// Clear removes the own check.
button(out, 'goalCheck.clear').p.onClick(); out = await v.settle();
assert.deepEqual(posts().at(-1), { sessionId: 's1', check: null });
// A Host error shows and frees the guard.
reply = async (url, init) => (init === undefined ? { status: 200, body: current } : { status: 409, body: { error: 'session unavailable' } });
button(out, 'goalCheck.run').p.onClick(); out = await v.settle();
assert.ok(all(out).some((n) => n.p.role === 'alert' && text(n) === 'goalCheck.failed:{"error":"session unavailable"}'));
reply = fast; button(out, 'goalCheck.run').p.onClick(); out = await v.settle();
assert.equal(posts().at(-1).run, true, 'the guard is free after an error');
// Another chat has its own entry.
chat = 's2'; out = await v.settle(); assert.ok(fetches.some((f) => f.url === `${ROUTE}?sessionId=s2`)); chat = 's1';
v.unmount();

// Settings: a Host switch row and a Model menu on the goal-check route.
const settings = regs.find(([o]) => o.id === 'composer-plus');
const sprops = settings[0].inject();
assert.ok(sprops.goalSwitch !== undefined && sprops.goalModel !== undefined);
sprops.setFeature('goalCheck', false);
assert.deepEqual(fetches.at(-1).init && JSON.parse(fetches.at(-1).init.body), { on: false }, 'the Host keeps the switch');
assert.equal(fetches.at(-1).url, ROUTE);
const tree = settings[1]({ ...sprops, useComposerPlusToggles: (f) => f({}), t: (k) => k });
const row = tree.c.slice(5).find((r) => r.p.key === 'goalCheck');
assert.ok(row, 'a Settings row');
assert.ok(row.c[1].c.some((c) => c?.t?.name === 'PredictionModel' && c.p.goal === true), 'a Model menu');
assert.ok(row.c[1].c.some((c) => c?.t?.name === 'MobileStatus' && c.p.prefix === 'goalCheck.switch'), 'the switch status');
// Switching the feature off removes the dock entry (the Host answers the switch's new state).
const off = regs.length;
reply = async () => ({ status: 200, body: { on: false } });
sprops.setFeature('goalCheck', false); await new Promise((r) => setTimeout(r, 0));
assert.ok(unregistered.includes('goal-check'), 'switching off removes the dock entry');
// The store: stop() drops later answers, also the answer of a load that was running.
const store = injected.checks;
{ let done; reply = async () => { await new Promise((r) => { done = r; }); return { status: 200, body: view() }; };
  const late = store.load('s9'); await new Promise((r) => setTimeout(r, 0)); store.stop(); done(); await late;
  assert.deepEqual(store.of('s9'), {}, 'a stopped store keeps nothing'); }
assert.equal(regs.length, off);
console.log('goal check client checks passed');
