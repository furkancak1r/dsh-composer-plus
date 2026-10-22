// Next message prediction (client half), real client.js with fake React and a mini DOM: after a finished turn the empty
// composer asks the Host once per turn and shows the text where dsh's placeholder is; Tab puts it in the composer, Esc
// hides it, typing hides it, a new turn hides it; nothing shows for a running, stopped, blank or subagent chat. Settings:
// the switch is a Host switch (on by default) and the Model menu lists dsh's catalog with "dsh default" first.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const fetches = [];
let reply = async () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => { fetches.push({ url, init }); const r = await reply(url, init); return { ok: r.status < 400, status: r.status, json: async () => r.body }; };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

// Mini DOM for the composer seat.
class El {
  constructor(attrs = {}, children = []) { this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.style = {}; this.className = attrs.class ?? ''; this.listeners = new Map(); for (const c of children) this.append(c); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(c) { c.parentElement = this; this.children.push(c); }
  after(c) { const s = this.parentElement.children; s.splice(s.indexOf(this) + 1, 0, c); c.parentElement = this.parentElement; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; }
  has(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return m !== null && m[1] in this.attrs; }
  closest(sel) { for (let e = this; e !== null; e = e.parentElement) if (e.has(sel)) return e; return null; }
  querySelector(sel) { for (const c of this.children) { if (c.has(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
  addEventListener(type, fn, capture) { assert.equal(type, 'keydown'); assert.equal(capture, true, 'before the editor'); this.listeners.set(fn, fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }
}
globalThis.Element = El;
globalThis.document = { createElement: () => new El() };
const placeholder = new El({ 'data-composer-placeholder': '', class: 'uV2eYG_placeholder' });
const input = new El({ 'data-composer-input': '' });
const anchorHost = new El();
const seat = new El({ 'data-composer-seat': '' }, [input, placeholder, anchorHost]);
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
    // the anchor span: React would attach it inside the seat
    if (inst.refs[0] !== undefined && inst.refs[0].current === null) inst.refs[0].current = anchorHost; // anchorRef: the first ref
    inst.effects.forEach(([f, deps], i) => {
      if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return;
      inst.cleanups[i]?.(); inst.cleanups[i] = f(); inst.deps[i] = deps;
    });
  };
  const settle = async () => { for (let i = 0; i < 6; i++) { render(); await new Promise((r) => setTimeout(r, 0)); } render(); return out; };
  return { settle, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu', Switch: 'Switch', Input: 'Input', IconChevronDownOutlineRegular: 'Chevron' } : {}));
const regs = [];
const binding = { eventSource: 'events-of-s1' };
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  sessions: { binding: () => binding }, slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
const entry = regs.find(([o]) => o.id === 'next-prediction');
assert.ok(entry, 'on by default: the composer entry is installed before the Host answers');
const toggles = regs.find(([o]) => o.id === 'composer-plus')[0].inject();
// The Host says off (the user's switch): the entry goes; on again: it comes back.
const count = () => regs.filter(([o]) => o.id === 'next-prediction').length;
reply = async (url, init) => ({ status: 200, body: { on: JSON.parse(init.body).on } });
await toggles.setFeature('nextPrediction', false); await new Promise((r) => setTimeout(r, 0));
assert.equal(toggles.prediction.getSnapshot().on, false);
await toggles.setFeature('nextPrediction', true); await new Promise((r) => setTimeout(r, 0));
assert.equal(toggles.prediction.getSnapshot().on, true); assert.equal(count(), 2, 'reinstalled after off → on');
const [opt, Prediction] = entry;
assert.equal(opt.name, 'conversation.input.right'); assert.equal(opt.locale, 'dsh-composer-plus');
const injected = opt.inject('s1');
assert.equal(injected.hooks.turnEnd, 'events-of-s1');

// The chat: events window, session and input state.
const ev = (seq, type, kind) => ({ event: { seq, type, data: kind === undefined ? {} : { reason: { kind } } } });
let entries = [ev(1, 'turn/start'), ev(9, 'turn/end', 'completed')];
let session = { blank: false, running: false, subagent: null, removed: false };
let inputState = { phase: 'plain', draft: '', attachmentIds: [] };
const drafts = [];
const props = () => ({ ...injected, t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
  useTurnEnd: (f) => f({ entries }), useSession: (f) => f(session), useInput: (f) => f(inputState),
  inputActions: { setDraft: (text) => { drafts.push(text); inputState = { ...inputState, draft: text }; } } });
const asks = () => fetches.filter((f) => f.url === '/api/composer-plus.predict' && JSON.parse(f.init?.body ?? '{}').sessionId !== undefined);
reply = async (url, init) => { const b = JSON.parse(init.body); return { status: 200, body: { text: 'Now run the tests.', afterSeq: b.afterSeq } }; };
const view = mount(Prediction, props);
let out = await view.settle();
assert.equal(asks().length, 1, 'one ask after the finished turn');
assert.deepEqual(JSON.parse(asks()[0].init.body), { sessionId: 's1', afterSeq: 9 });
const box = seat.children.find((c) => c.getAttribute('data-composer-plus-prediction') !== null);
assert.ok(box, 'the text goes next to dsh\'s placeholder'); assert.equal(box.className, 'uV2eYG_placeholder', 'same look as the placeholder');
assert.equal(placeholder.style.visibility, 'hidden', 'dsh\'s placeholder hides meanwhile');
const shown = out.c[1]; assert.equal(shown.host, box); assert.match(shown.portal.c[0].c[0], /\[data-composer-composing\] ~ \[data-composer-plus-prediction\] \{ visibility: hidden; \}/, 'hidden while an IME composes'); assert.equal(shown.portal.c[1].c[0], 'Now run the tests.'); assert.equal(shown.portal.c[2].c[0], 'prediction.accept');
assert.equal(out.c[2].p.role, 'status', 'screen readers hear it');

// Tab accepts: the composer gets the text, dsh does not move the focus.
let e = press('Tab');
assert.equal(e.prevented, 1); assert.equal(e.stopped, 1); assert.deepEqual(drafts, ['Now run the tests.']);
out = await view.settle();
assert.equal(out.c?.[1], undefined, 'hidden once the composer has text'); assert.equal(placeholder.style.visibility, '', 'placeholder back');
assert.equal(seat.children.some((c) => c.getAttribute('data-composer-plus-prediction') !== null), false);
assert.equal(asks().length, 1, 'no new ask for the same turn');
// The user clears the composer: the same guess shows again (no new call).
inputState = { ...inputState, draft: '' }; out = await view.settle();
assert.equal(out.c[1].portal.c[1].c[0], 'Now run the tests.'); assert.equal(asks().length, 1);
let askedBase;
// The answer arrives while the chat shows as running for a moment: it is kept and shows once the chat is idle again.
{
  let late; reply = async (url, init) => new Promise((resolve) => { late = () => resolve({ status: 200, body: { text: 'Late guess', afterSeq: JSON.parse(init.body).afterSeq } }); });
  const keep = [entries, session];
  entries = [...entries, ev(30, 'turn/start'), ev(31, 'turn/end', 'completed')];
  await view.settle();
  session = { ...session, running: true }; await view.settle();
  late(); await new Promise((r) => setTimeout(r, 0));
  session = { ...session, running: false }; out = await view.settle();
  assert.equal(out.c[1].portal.c[1].c[0], 'Late guess', 'a late answer for the current turn still shows');
  [entries, session] = keep; // back to the first turn for the checks below: the Host keeps its answer, so asking again is cheap
  reply = async (url, init) => { const b = JSON.parse(init.body); return { status: 200, body: { text: 'Now run the tests.', afterSeq: b.afterSeq } }; };
  out = await view.settle(); askedBase = asks().length;
}
// The chat shows as running for a moment (no new turn): the same guess comes back without a second model call.
session = { ...session, running: true }; await view.settle(); session = { ...session, running: false }; out = await view.settle();
assert.equal(out.c[1].portal.c[1].c[0], 'Now run the tests.'); assert.equal(asks().length, askedBase, 'one ask per finished turn');
// Esc hides it for this turn.
e = press('Escape'); assert.equal(e.prevented, 1); out = await view.settle();
assert.equal(out.c?.[1], undefined, 'Esc hides it');
// Keys that are not for it: Shift+Tab (plan toggle), an open / menu, IME.
inputState = { ...inputState }; entries = [...entries, ev(10, 'turn/start'), ev(12, 'turn/end', 'completed')];
reply = async (url, init) => ({ status: 200, body: { text: 'Second guess', afterSeq: JSON.parse(init.body).afterSeq } });
out = await view.settle();
assert.equal(asks().length, askedBase + 1, 'a new finished turn asks again'); assert.equal(out.c[1].portal.c[1].c[0], 'Second guess', 'Esc was only for the old turn');
assert.equal(press('Tab', { shiftKey: true }).prevented, 0, 'Shift+Tab stays with the plan toggle');
assert.equal(press('Tab', { isComposing: true }).prevented, 0, 'IME');
const menu = new El({ 'data-trigger-menu': '' }); seat.append(menu);
assert.equal(press('Tab').prevented, 0, 'an open / or @ menu keeps Tab'); menu.remove();
assert.equal(press('Tab', { target: new El() }).prevented, 0, 'only in the composer');
// Typing hides it; a running turn hides it; a stopped turn shows nothing.
inputState = { ...inputState, draft: 'x' }; out = await view.settle(); assert.equal(out.c?.[1], undefined);
inputState = { ...inputState, draft: '' }; session = { ...session, running: true }; out = await view.settle(); assert.equal(out.c?.[1], undefined, 'running');
session = { ...session, running: false }; entries = [...entries, ev(13, 'turn/start'), ev(15, 'turn/end', 'interrupted')];
out = await view.settle(); assert.equal(out.c?.[1], undefined, 'stopped turn: Continue shows instead'); assert.equal(asks().length, askedBase + 1, 'no ask');
// A stale answer (Host says another turn) is dropped.
entries = [...entries, ev(16, 'turn/start'), ev(18, 'turn/end', 'completed')];
reply = async () => ({ status: 200, body: { text: 'old', afterSeq: 12 } });
out = await view.settle(); assert.equal(out.c?.[1], undefined, 'stale answer'); assert.equal(asks().length, askedBase + 2);
// Host refuses (off on another browser, 409): nothing shows.
entries = [...entries, ev(19, 'turn/start'), ev(21, 'turn/end', 'completed')];
reply = async () => ({ status: 409, body: { error: 'next message prediction is off' } });
out = await view.settle(); assert.equal(out.c?.[1], undefined);
// Subagent and blank chats never ask.
session = { ...session, subagent: { address: {} } }; entries = [...entries, ev(22, 'turn/start'), ev(24, 'turn/end', 'completed')];
const n = asks().length; await view.settle(); assert.equal(asks().length, n, 'subagent view');
view.unmount();
assert.equal(seat.listeners.size, 0, 'key listener removed');

// Settings: the row has the Host switch status and the Model menu from dsh's catalog.
const catalog = { default: { provider: 'demo', model: 'demo' }, groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'demo', name: 'Demo model' }] }, { id: 'fast', name: 'Fast', models: [{ id: 'mini', name: 'Mini' }] }] };
let saved = {};
reply = async (url, init) => {
  if (url === '/api/composer-plus.predict?catalog=1') return { status: 200, body: { on: true, ...saved, catalog } };
  if (url === '/api/composer-plus.complete?catalog=1') return { status: 200, body: { on: false, catalog, ...(saved.model ? { fallback: saved.model } : {}) } };
  const b = JSON.parse(init.body);
  if (b.model === null) { saved = {}; return { status: 200, body: { on: true } }; }
  if (b.model.model === 'gone') return { status: 409, body: { error: 'dsh does not list this model' } };
  saved = { model: b.model }; return { status: 200, body: { on: true, model: b.model } };
};
const store = toggles.predictionModel;
await store.load();
assert.deepEqual(store.getSnapshot(), { model: undefined, catalog });
// Render the model row through FeatureSettings: it sits under the nextPrediction switch.
const settingsEntry = regs.find(([o]) => o.id === 'composer-plus');
const Settings = settingsEntry[1];
const tree = (() => { cur = { state: [], refs: [], effects: [], si: 0, ri: 0 }; return Settings({ ...toggles, useComposerPlusToggles: (f) => f({ nextPrediction: true }), t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k) }); })();
const row = tree.c.slice(5).find((r) => r.p.key === 'nextPrediction');
assert.ok(row, 'Settings row'); assert.equal(row.c[2].p.checked, true);
const modelRow = row.c[1].c.find((c) => c?.t?.name === 'PredictionModel');
assert.ok(modelRow, 'Model menu under the switch');
cur = { state: [], refs: [], effects: [], si: 0, ri: 0 };
let m = modelRow.t(modelRow.p);
const menuEl = m.c[1];
assert.equal(menuEl.t, 'Menu');
assert.deepEqual(menuEl.p.items.map((i) => i.label ?? i.text), ['prediction.modelDefaultNamed:{"model":"Demo model"}', 'Demo', 'Demo model', 'Fast', 'Mini'], 'dsh default first, then dsh\'s providers and models');
assert.equal(menuEl.p.selectedId, '::dsh-default', 'default selected');
await menuEl.p.onSelect(JSON.stringify(['fast', 'mini']));
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(store.getSnapshot().model, { provider: 'fast', model: 'mini' });
assert.deepEqual(JSON.parse(fetches.findLast((f) => f.init?.body !== undefined).init.body), { model: { provider: 'fast', model: 'mini' } });
assert.equal(fetches.at(-1).url, '/api/composer-plus.complete?catalog=1', 'then the completion menu reloads (it names the prediction\'s model)');
cur = { state: [], refs: [], effects: [], si: 0, ri: 0 }; m = modelRow.t(modelRow.p);
assert.equal(m.c[1].p.selectedId, JSON.stringify(['fast', 'mini']));
// A refused change keeps the saved choice and says why.
await store.setModel({ provider: 'fast', model: 'gone' });
assert.deepEqual(store.getSnapshot().model, { provider: 'fast', model: 'mini' }); assert.equal(store.getSnapshot().error, 'dsh does not list this model');
// Back to dsh default.
cur = { state: [], refs: [], effects: [], si: 0, ri: 0 }; m = modelRow.t(modelRow.p);
await m.c[1].p.onSelect('::dsh-default'); await new Promise((r) => setTimeout(r, 0));
assert.equal(store.getSnapshot().model, undefined); assert.deepEqual(JSON.parse(fetches.findLast((f) => f.init?.body !== undefined).init.body), { model: null });
// One change at a time: a second choice while the first is saving is ignored.
let finish; reply = async () => new Promise((resolve) => { finish = () => resolve({ status: 200, body: { on: true, model: { provider: 'demo', model: 'demo' } } }); });
const p1 = store.setModel({ provider: 'demo', model: 'demo' });
const before = fetches.length; await store.setModel({ provider: 'fast', model: 'mini' });
assert.equal(fetches.length, before, 'second change ignored while busy');
// A load that answers meanwhile does not overwrite the choice.
finish(); await p1;
assert.deepEqual(store.getSnapshot().model, { provider: 'demo', model: 'demo' });
console.log('predict client checks passed');
