// Complete while typing (client half), real client.js with fake React and a mini DOM: off by default (no composer entry
// until the Host says on); while you type with the caret at the end it asks once after a pause and shows the rest through
// dsh's composer hint; typing along the guess uses it with no new ask; Tab adds it, Esc hides it; a slash command, a chip,
// a caret in the middle, a short draft, an open / or @ menu, a subagent chat and a stale answer get nothing. Settings:
// a Host switch row with the same Model menu as Next message prediction.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
const docListeners = new Map();
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const fetches = [];
let reply = async () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => { fetches.push({ url, init }); const r = await reply(url, init); return { ok: r.status < 400, status: r.status, json: async () => r.body }; };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

// Mini DOM: the composer seat with the input; the caret is at the end unless `caretEnd` is false.
class El {
  constructor(attrs = {}, children = []) { this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.listeners = new Map(); const props = new Map(); this.style = { setProperty: (k, v) => props.set(k, v), getPropertyValue: (k) => props.get(k) ?? '', removeProperty: (k) => { props.delete(k); }, props }; for (const c of children) this.append(c); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  append(c) { c.parentElement = this; this.children.push(c); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; }
  has(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return m !== null && m[1] in this.attrs; }
  closest(sel) { for (let e = this; e !== null; e = e.parentElement) if (e.has(sel)) return e; return null; }
  querySelector(sel) { for (const c of this.children) { if (c.has(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
  contains(node) { for (let e = node; e; e = e.parentElement) if (e === this) return true; return false; }
  addEventListener(type, fn, capture) { assert.equal(type, 'keydown'); assert.equal(capture, true, 'before the editor'); this.listeners.set(fn, fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }
}
globalThis.Element = El;
const input = new El({ 'data-composer-input': '' });
const textNode = new El(); input.append(textNode);
const anchorHost = new El();
const seat = new El({ 'data-composer-seat': '' }, [input, anchorHost]);
let caretEnd = true;
window.getSelection = () => ({ rangeCount: 1, isCollapsed: true, focusNode: textNode, focusOffset: 0 });
globalThis.document = {
  createElement: () => new El(),
  createRange: () => ({ selectNodeContents() {}, setStart() {}, toString: () => (caretEnd ? '' : 'more text') }),
  addEventListener: (type, fn) => { docListeners.set(fn, type); }, removeEventListener: (type, fn) => { docListeners.delete(fn); },
};
const hint = () => input.style.getPropertyValue('--dsh-composer-hint');
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
    if (inst.refs[0] !== undefined && inst.refs[0].current === null) inst.refs[0].current = anchorHost; // anchorRef: the first ref
    inst.effects.forEach(([f, deps], i) => {
      if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return;
      inst.cleanups[i]?.(); inst.cleanups[i] = f(); inst.deps[i] = deps;
    });
  };
  const settle = async (ms = 0) => { for (let i = 0; i < 4; i++) { render(); await new Promise((r) => setTimeout(r, 0)); } if (ms) { await new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 4; i++) { render(); await new Promise((r) => setTimeout(r, 0)); } } render(); return out; };
  return { settle, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu', Switch: 'Switch', Input: 'Input' } : {}));
const regs = [];
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  sessions: { binding: () => ({}) }, slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
const count = () => regs.filter(([o]) => o.id === 'typing-completion').length;
assert.equal(count(), 0, 'off by default: no composer entry');
const settings = regs.find(([o]) => o.id === 'composer-plus')[0].inject();
reply = async (url, init) => ({ status: 200, body: { on: JSON.parse(init.body).on } });
await settings.setFeature('typingCompletion', true); await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(JSON.parse(fetches.at(-1).init.body), { on: true }, 'the Host keeps the switch');
assert.equal(fetches.at(-1).url, '/api/composer-plus.complete');
assert.equal(count(), 1, 'switched on: the composer entry is installed');
const [opt, Completion] = regs.find(([o]) => o.id === 'typing-completion');
assert.equal(opt.name, 'conversation.input.right'); assert.equal(opt.locale, 'dsh-composer-plus');
const injected = opt.inject('s1');

let session = { subagent: null, removed: false };
let inputState = { phase: 'plain', draft: '', attachmentIds: [], occurrences: [] };
const drafts = [];
const props = () => ({ ...injected, t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
  useSession: (f) => f(session), useInput: (f) => f(inputState),
  inputActions: { setDraft: (text) => { drafts.push(text); inputState = { ...inputState, draft: text }; } } });
const asks = () => fetches.filter((f) => f.url === '/api/composer-plus.complete' && JSON.parse(f.init?.body ?? '{}').sessionId !== undefined);
reply = async (url, init) => { const b = JSON.parse(init.body); return { status: 200, body: { text: b.text, completion: ' tests and fix the failures.', model: 'nano' } }; };
const view = mount(Completion, props);
let out = await view.settle();
assert.equal(docListeners.size, 1, 'follows the caret');
// Too short: nothing.
inputState = { ...inputState, draft: 'Ru' }; out = await view.settle(400);
assert.equal(asks().length, 0, 'fewer than 3 characters: no ask');
// Typing: one ask after the pause, not one per keystroke.
inputState = { ...inputState, draft: 'Run' }; await view.settle();
inputState = { ...inputState, draft: 'Run the' }; out = await view.settle(400);
assert.equal(asks().length, 1, 'one ask after the pause');
assert.deepEqual(JSON.parse(asks()[0].init.body), { sessionId: 's1', text: 'Run the' });
assert.ok(asks()[0].init.signal instanceof AbortSignal, 'a newer keystroke can abort it');
assert.equal(hint(), JSON.stringify(' tests and fix the failures.'), 'the rest shows after the caret (dsh\'s hint)');
assert.match(out.c[1].c[0], /completion\.announce/, 'screen readers hear it');
// Typing along the guess: the rest gets shorter, no new ask.
inputState = { ...inputState, draft: 'Run the te' }; out = await view.settle(400);
assert.equal(hint(), JSON.stringify('sts and fix the failures.')); assert.equal(asks().length, 1, 'no new ask along the guess');
// Tab adds it; the added text gets no new ask.
let e = press('Tab');
assert.equal(e.prevented, 1); assert.equal(e.stopped, 1); assert.deepEqual(drafts, ['Run the tests and fix the failures.']);
out = await view.settle(400);
assert.equal(hint(), '', 'gone after Tab'); assert.equal(asks().length, 1, 'no ask for the accepted text');
// Typing on asks again; Esc hides that guess.
inputState = { ...inputState, draft: 'Run the tests and fix the failures. Then' }; out = await view.settle(400);
assert.equal(asks().length, 2); assert.ok(hint() !== '');
e = press('Escape'); assert.equal(e.prevented, 1); out = await view.settle(400);
assert.equal(hint(), '', 'Esc hides it'); assert.equal(asks().length, 2, 'no ask for the closed text');
// A key that is not for it: Shift+Tab (plan toggle), IME, an open / or @ menu, another element.
inputState = { ...inputState, draft: 'Fix the bug' }; out = await view.settle(400);
assert.ok(hint() !== '');
assert.equal(press('Tab', { shiftKey: true }).prevented, 0, 'Shift+Tab stays with the plan toggle');
assert.equal(press('Tab', { isComposing: true }).prevented, 0, 'IME');
const menu = new El({ 'data-trigger-menu': '' }); seat.append(menu);
assert.equal(press('Tab').prevented, 0, 'an open / or @ menu keeps Tab'); menu.remove();
assert.equal(press('Tab', { target: new El() }).prevented, 0, 'only in the composer');
// A stale answer (the Host completed other text) is dropped.
reply = async () => ({ status: 200, body: { text: 'something else', completion: ' nope' } });
inputState = { ...inputState, draft: 'Write a test' }; out = await view.settle(400);
assert.equal(hint(), '', 'stale answer'); 
// The Host refuses (off on another browser, 409): nothing.
reply = async () => ({ status: 409, body: { error: 'complete while typing is off' } });
inputState = { ...inputState, draft: 'Write a test for' }; out = await view.settle(400); assert.equal(hint(), '');
reply = async (url, init) => { const b = JSON.parse(init.body); return { status: 200, body: { text: b.text, completion: ' it.' } }; };
// Not for: a slash command, a chip, a command claim, the caret in the middle, a subagent chat.
let n = asks().length;
inputState = { ...inputState, draft: '/plan add a' }; await view.settle(400);
inputState = { ...inputState, draft: 'Look at @file', occurrences: [{ occurrenceId: 1 }] }; await view.settle(400);
inputState = { ...inputState, draft: '/goal finish', occurrences: [], phase: 'claimed' }; await view.settle(400);
inputState = { ...inputState, phase: 'plain' };
assert.equal(asks().length, n, 'slash command, chip and claim: no ask');
caretEnd = false; for (const fn of docListeners.keys()) fn();
inputState = { ...inputState, draft: 'Change the middle' }; await view.settle(400);
assert.equal(asks().length, n, 'caret not at the end: no ask');
caretEnd = true; for (const fn of docListeners.keys()) fn();
session = { ...session, subagent: { address: {} } }; inputState = { ...inputState, draft: 'Subagent text' }; await view.settle(400);
assert.equal(asks().length, n, 'subagent chat: no ask');
session = { ...session, subagent: null };
// A fast typist: the older ask is aborted when the draft changes before its answer.
let late; reply = async (url, init) => new Promise((resolve) => { late = () => resolve({ status: 200, body: { text: JSON.parse(init.body).text, completion: ' late' } }); });
inputState = { ...inputState, draft: 'Deploy the' }; await view.settle(400);
const first = asks().at(-1);
inputState = { ...inputState, draft: 'Deploy the app' }; await view.settle();
assert.equal(first.init.signal.aborted, true, 'the older ask is aborted');
late(); out = await view.settle();
assert.equal(hint(), '', 'its answer does not show');
// Our hint stays ours: cleanup does not remove a hint that dsh set meanwhile.
reply = async (url, init) => { const b = JSON.parse(init.body); return { status: 200, body: { text: b.text, completion: ' now' } }; };
inputState = { ...inputState, draft: 'Deploy the app' }; await view.settle(400);
assert.equal(hint(), JSON.stringify(' now'));
input.style.setProperty('--dsh-composer-hint', '"<task>"');
inputState = { ...inputState, draft: 'x' }; await view.settle();
assert.equal(hint(), '"<task>"', 'dsh\'s own hint is left alone');
input.style.removeProperty('--dsh-composer-hint');
view.unmount();
assert.equal(seat.listeners.size, 0, 'key listener removed'); assert.equal(docListeners.size, 0, 'caret listener removed');
// Switched off: the entry goes.
reply = async (url, init) => ({ status: 200, body: { on: JSON.parse(init.body).on } });
await settings.setFeature('typingCompletion', false); await new Promise((r) => setTimeout(r, 0));
assert.equal(settings.completion.getSnapshot().on, false);

// Settings row: the Host switch status and its own Model menu (the completion route; its first entry follows the prediction).
const Settings = regs.find(([o]) => o.id === 'composer-plus')[1];
cur = { state: [], refs: [], effects: [], si: 0, ri: 0 };
const tree = Settings({ ...settings, useComposerPlusToggles: (f) => f({ typingCompletion: false }), t: (k) => k });
const row = tree.c.slice(5).find((r) => r.p.key === 'typingCompletion');
assert.ok(row, 'Settings row'); assert.equal(row.c[2].p.checked, false, 'off by default');
assert.equal(row.c[0].p.id, 'typingCompletion', 'its own screenshot');
assert.ok(row.c[1].c.some((c) => c?.t?.name === 'MobileStatus' && c.p.prefix === 'completion'), 'Host switch status');
const modelRow = row.c[1].c.find((c) => c?.t?.name === 'PredictionModel');
assert.ok(modelRow, 'a Model menu'); assert.notEqual(modelRow.p.store, settings.predictionModel, 'its own model store, not the prediction\'s');
assert.equal(modelRow.p.store, settings.completionModel); assert.equal(modelRow.p.followPrediction, true);
// The store reads and writes the completion route; its first entry names the prediction's model.
{
  const sent = []; const catalog = { default: { provider: 'demo', model: 'demo' }, groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'demo', name: 'Demo model' }] }, { id: 'fast', name: 'Fast', models: [{ id: 'nano', name: 'Nano' }, { id: 'mini', name: 'Mini' }] }] };
  reply = async (url, init) => { sent.push([url, init?.body === undefined ? undefined : JSON.parse(init.body)]);
    return init?.body === undefined ? { status: 200, body: { on: true, catalog, fallback: { provider: 'fast', model: 'nano' } } } : { status: 200, body: { on: true, ...(JSON.parse(init.body).model ? { model: JSON.parse(init.body).model } : {}) } }; };
  const store = settings.completionModel; await store.load();
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.complete?catalog=1', undefined], 'it reads the completion route');
  cur = { state: [], refs: [], effects: [], si: 0, ri: 0 };
  const menu = modelRow.t({ store, t: (k, p) => (p ? `${k}(${Object.values(p).join(',')})` : k), followPrediction: true }).c[1];
  assert.equal(menu.p.items[0].label, 'completion.modelSameNamed(Nano)', 'the first entry names the prediction\'s model');
  assert.equal(menu.p.selectedId, '::dsh-default', 'nothing saved: the first entry is selected');
  await menu.p.onSelect(JSON.stringify(['fast', 'mini'])); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.complete', { model: { provider: 'fast', model: 'mini' } }], 'a choice goes to the completion route');
  assert.deepEqual(store.getSnapshot().model, { provider: 'fast', model: 'mini' }); assert.equal(settings.predictionModel.getSnapshot().model, undefined, 'the prediction\'s choice does not move');
  cur = { state: [], refs: [], effects: [], si: 0, ri: 0 };
  const again = modelRow.t({ store, t: (k, p) => (p ? `${k}(${Object.values(p).join(',')})` : k), followPrediction: true }).c[1];
  await again.p.onSelect('::dsh-default'); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.complete', { model: null }], 'the first entry sends null');
  // A new prediction model reloads the completion menu, so its first entry names the new model.
  await new Promise((r) => setTimeout(r, 0)); const before = sent.length;
  reply = async (url, init) => { sent.push([url, init?.body === undefined ? undefined : JSON.parse(init.body)]); return { status: 200, body: { on: true, model: { provider: 'fast', model: 'nano' } } }; };
  await settings.predictionModel.setModel({ provider: 'fast', model: 'nano' }); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent.slice(before).map(([u]) => u), ['/api/composer-plus.predict', '/api/composer-plus.complete?catalog=1'], 'the prediction is saved, then the completion menu reloads');
  assert.equal(menu.p.anchor.p['aria-label'], 'feature.typingCompletion: prediction.model', 'its own accessible name');
}
console.log('complete client checks passed');
