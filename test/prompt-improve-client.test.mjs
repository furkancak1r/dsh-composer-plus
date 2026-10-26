// Improve prompt (client half), real client.js with fake React and a mini DOM: on by default (a composer entry in the tool
// row); disabled for an empty, too long, slash-command or chip draft; a click sends the draft and replaces it through dsh's
// insertText with a span over the whole draft (one undo step); dsh refusing the edit (the draft changed) keeps the text
// and says so; the button then undoes; a second click or Esc cancels; one ask at a time; a failure keeps the text.
// Settings: a Model menu on the improve route; switching the feature off removes the composer entry.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const fetches = [];
let reply = async () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  fetches.push({ url, init });
  const r = await reply(url, init);
  if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

class El {
  constructor(attrs = {}, children = []) { this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.listeners = new Map(); for (const c of children) this.append(c); }
  append(c) { c.parentElement = this; this.children.push(c); }
  has(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return m !== null && m[1] in this.attrs; }
  closest(sel) { for (let e = this; e !== null; e = e.parentElement) if (e.has(sel)) return e; return null; }
  querySelector(sel) { for (const c of this.children) { if (c.has(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
  addEventListener(type, fn, capture) { assert.equal(type, 'keydown'); assert.equal(capture, true, 'before the editor'); this.listeners.set(fn, fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }
}
globalThis.Element = El;
const input = new El({ 'data-composer-input': '' });
const anchorHost = new El();
const seat = new El({ 'data-composer-seat': '' }, [input, anchorHost]);
const press = (key, o = {}) => { const e = { key, target: input, prevented: 0, stopped: 0, ...o, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } }; for (const fn of [...seat.listeners.values()]) fn(e); return e; };

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
    if (inst.refs[1] !== undefined && inst.refs[1].current === null) inst.refs[1].current = anchorHost; // anchorRef: the second ref
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
const notices = [];
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  sessions: { binding: () => ({}), scope: () => ({ get: () => ({ input: { for: () => ({ notify: (level, text) => notices.push([level, text]) }) } }) }) },
  slots: { inject: (n, f) => f(), register: (o, C) => { const r = [o, C]; regs.push(r); return () => { unregistered.push(o.id); }; } } });
const entry = regs.find(([o]) => o.id === 'prompt-improve');
assert.ok(entry, 'on by default: the composer entry is installed');
const [opt, Improve] = entry;
assert.equal(opt.name, 'conversation.input.right'); assert.equal(opt.locale, 'dsh-composer-plus');
const injected = opt.inject('s1');

let session = { subagent: null, removed: false };
let inputState = { phase: 'plain', draft: '', draftRev: 1, attachmentIds: [], occurrences: [] };
const edits = [];
let accept = true;
const inputActions = {
  captureInsertion: () => ({ start: 3, end: 3, draftRev: inputState.draftRev }),
  insertText: (text, span) => {
    edits.push({ text, span });
    if (!accept || span.draftRev !== inputState.draftRev) return false;
    inputState = { ...inputState, draft: text, draftRev: inputState.draftRev + 1 };
    return true;
  },
};
const props = () => ({ ...injected, sessionId: 's1', t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k), useSession: (f) => f(session), useInput: (f) => f(inputState), inputActions });
const asks = () => fetches.filter((f) => f.url === '/api/composer-plus.improve' && f.init?.method === 'POST' && JSON.parse(f.init.body).sessionId !== undefined);
const buttonOf = (out) => { const tip = out.c.find((c) => c?.t === 'Tooltip'); return tip?.c[0]; };
const view = mount(Improve, props);

// Disabled states (the tooltip says why); nothing is asked.
let out = await view.settle();
let button = buttonOf(out);
assert.ok(button, 'a button in the tool row'); assert.equal(button.p.disabled, true, 'empty draft');
assert.equal(out.c.find((c) => c?.t === 'Tooltip').p.label, 'improve.label: improve.empty');
for (const [state, why] of [[{ draft: '/plan add tests' , phase: 'claimed' }, 'improve.unsupported'], [{ draft: 'see @file', occurrences: [{ offset: 4 }] }, 'improve.unsupported'], [{ draft: 'x'.repeat(8001) }, 'improve.tooLong']]) {
  inputState = { ...inputState, phase: 'plain', occurrences: [], ...state };
  out = await view.settle(); button = buttonOf(out);
  assert.equal(button.p.disabled, true, why); assert.match(out.c.find((c) => c?.t === 'Tooltip').p.label, new RegExp(why));
  button.p.onClick(); await view.settle();
}
assert.equal(asks().length, 0, 'a disabled button asks nothing');

// A click: the whole draft goes to the Host; the answer replaces it through insertText with a whole-draft span.
inputState = { ...inputState, phase: 'plain', occurrences: [], draft: 'login hatasını düzelt', attachmentIds: ['img1'] };
let release;
reply = async (url, init) => { const b = JSON.parse(init.body); await new Promise((r) => { release = r; }); return { status: 200, body: { text: b.text, improved: 'Fix the login error in `src/auth/login.ts`.\n1. Run `npm test`.', model: 'big' } }; };
out = await view.settle(); button = buttonOf(out);
assert.equal(button.p.disabled, false, 'an image does not block it');
const down = { prevented: 0, preventDefault() { this.prevented++; } }; button.p.onMouseDown(down); assert.equal(down.prevented, 1, 'the composer keeps its focus');
button.p.onClick();
out = await view.settle(); button = buttonOf(out);
assert.equal(asks().length, 1); assert.deepEqual(JSON.parse(asks()[0].init.body), { sessionId: 's1', text: 'login hatasını düzelt' });
assert.equal(button.p['aria-busy'], true); assert.equal(button.p.disabled, false, 'a running ask can be cancelled');
assert.equal(button.p['aria-label'], 'improve.cancel', 'its name says that it cancels'); assert.equal(out.c.at(-1).c[0], 'improve.working', 'the status line says that it works');
assert.equal(out.c.find((c) => c?.t === 'Tooltip').p.label, 'improve.cancel');
button.p.onClick !== undefined && assert.equal(asks().length, 1);
release(); out = await view.settle(); button = buttonOf(out);
assert.equal(edits.length, 1); assert.deepEqual(edits[0].span, { start: 0, end: 'login hatasını düzelt'.length, draftRev: 1 }, 'a span over the whole draft, at the click\'s revision');
assert.equal(inputState.draft, 'Fix the login error in `src/auth/login.ts`.\n1. Run `npm test`.');
assert.equal(button.p['aria-label'], 'improve.undo', 'the button now undoes');
assert.equal(out.c.at(-1).c[0], 'improve.done', 'screen readers hear it');
// Undo puts the user's text back (one more insertText over the whole improved text).
button.p.onClick(); out = await view.settle(); button = buttonOf(out);
assert.equal(inputState.draft, 'login hatasını düzelt'); assert.equal(edits.at(-1).span.start, 0); assert.equal(edits.at(-1).span.end, 'Fix the login error in `src/auth/login.ts`.\n1. Run `npm test`.'.length);
assert.equal(button.p['aria-label'], 'improve.label', 'back to the wand');

// The draft changes while it runs: dsh refuses the edit, the text stays, a notice says so.
reply = async (url, init) => { const b = JSON.parse(init.body); await new Promise((r) => { release = r; }); return { status: 200, body: { text: b.text, improved: 'Better prompt', model: 'big' } }; };
buttonOf(await view.settle()).p.onClick(); await view.settle();
inputState = { ...inputState, draft: 'login hatasını düzelt ve test ekle', draftRev: inputState.draftRev + 1 };
release(); out = await view.settle();
assert.equal(inputState.draft, 'login hatasını düzelt ve test ekle', 'new typing is never overwritten');
assert.deepEqual(notices.at(-1), ['info', 'improve.changed']);
assert.equal(buttonOf(out).p['aria-label'], 'improve.label', 'no undo for a refused edit');

// One ask at a time: a second click cancels the running one (no second request, the answer is dropped).
let signal;
reply = async (url, init) => { signal = init.signal; await new Promise((r) => { release = r; }); return { status: 200, body: { text: JSON.parse(init.body).text, improved: 'late', model: 'big' } }; };
const n = asks().length; const e0 = edits.length;
buttonOf(await view.settle()).p.onClick(); await view.settle();
buttonOf(await view.settle()).p.onClick(); await view.settle();
assert.equal(asks().length, n + 1, 'the second click sends nothing'); assert.equal(signal.aborted, true, 'it aborts the ask');
release(); out = await view.settle();
assert.equal(edits.length, e0, 'a cancelled answer is dropped'); assert.equal(buttonOf(out).p['aria-busy'], false);
// Esc in the composer cancels too, before dsh's keys; Esc while idle is dsh's.
assert.equal(press('Escape').prevented, 0, 'idle: Esc stays with dsh');
buttonOf(await view.settle()).p.onClick(); await view.settle();
const esc = press('Escape'); assert.equal(esc.prevented, 1); assert.equal(esc.stopped, 1); assert.equal(signal.aborted, true);
release(); out = await view.settle(); assert.equal(edits.length, e0);
assert.equal(seat.listeners.size, 0, 'the Esc listener goes when it ends');

// Failures keep the text and say why; an unchanged answer says that the prompt is already clear.
reply = async () => ({ status: 502, body: { error: 'rate limited' } });
buttonOf(await view.settle()).p.onClick(); await view.settle();
assert.deepEqual(notices.at(-1), ['error', 'improve.failed:{"error":"rate limited"}']); assert.equal(edits.length, e0);
reply = async (url, init) => ({ status: 200, body: { text: JSON.parse(init.body).text, improved: JSON.parse(init.body).text } });
buttonOf(await view.settle()).p.onClick(); await view.settle();
assert.deepEqual(notices.at(-1), ['info', 'improve.same']); assert.equal(edits.length, e0);
// A stale answer (another text) is not used.
reply = async () => ({ status: 200, body: { text: 'other', improved: 'nope' } });
buttonOf(await view.settle()).p.onClick(); await view.settle(); assert.equal(edits.length, e0);
// A subagent chat: no button.
session = { subagent: { address: {} }, removed: false };
out = await view.settle(); assert.equal(buttonOf(out), undefined, 'no button in a subagent view');
session = { subagent: null, removed: false };
view.unmount();

// Settings: its own Model menu on the improve route ("Same as the chat's model" first); switching it off removes the entry.
const settings = regs.find(([o]) => o.id === 'composer-plus')[0].inject();
const Settings = regs.find(([o]) => o.id === 'composer-plus')[1];
cur = { state: [], refs: [], effects: [], si: 0, ri: 0 };
const tree = Settings({ ...settings, useComposerPlusToggles: (f) => f({}), t: (k) => k });
const row = tree.c.slice(5).find((r) => r.p.key === 'promptImprove');
assert.ok(row, 'Settings row'); assert.equal(row.c[2].p.checked, true, 'on by default'); assert.equal(row.c[0].p.id, 'promptImprove', 'its own screenshot');
const modelRow = row.c[1].c.find((c) => c?.t?.name === 'PredictionModel');
assert.ok(modelRow, 'a Model menu'); assert.equal(modelRow.p.store, settings.improveModel); assert.equal(modelRow.p.improve, true);
{
  const sent = []; const catalog = { default: { provider: 'demo', model: 'demo' }, groups: [{ id: 'fast', name: 'Fast', models: [{ id: 'nano', name: 'Nano' }] }] };
  reply = async (url, init) => { sent.push([url, init?.body === undefined ? undefined : JSON.parse(init.body)]); return init?.body === undefined ? { status: 200, body: { catalog } } : { status: 200, body: JSON.parse(init.body).model ? { model: JSON.parse(init.body).model } : {} }; };
  const store = settings.improveModel; await store.load();
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.improve?catalog=1', undefined]);
  cur = { state: [], refs: [], effects: [], si: 0, ri: 0 };
  const menu = modelRow.t({ store, t: (k, p) => (p ? `${k}(${Object.values(p).join(',')})` : k), improve: true }).c[1];
  assert.equal(menu.p.items[0].label, 'improve.modelChat'); assert.equal(menu.p.anchor.p['aria-label'], 'feature.promptImprove: prediction.model');
  await menu.p.onSelect(JSON.stringify(['fast', 'nano'])); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.improve', { model: { provider: 'fast', model: 'nano' } }]);
}
cur = { state: [], refs: [], effects: [], si: 0, ri: 0 };
const offRow = Settings({ ...settings, useComposerPlusToggles: (f) => f({ promptImprove: false }), t: (k) => k }).c.slice(5).find((r) => r.p.key === 'promptImprove');
assert.equal(offRow.c[2].p.checked, false); assert.ok(!offRow.c[1].c.some((c) => c?.t?.name === 'PredictionModel'), 'no Model menu while off');
settings.setFeature('promptImprove', false);
assert.ok(unregistered.includes('prompt-improve'), 'switched off: the composer entry is removed');
const before = regs.length; settings.setFeature('promptImprove', true);
assert.ok(regs.slice(before).some(([o]) => o.id === 'prompt-improve'), 'switched on again: installed again');
console.log('prompt improve client checks passed');
