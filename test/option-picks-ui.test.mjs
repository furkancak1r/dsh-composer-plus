// Runs the real client.js Option picks UI (phase 4 of the agentbox ideas plan).
// - OptionPicks (dsh's turn-tail slot): buttons only under the answer that the chat offers now, while the chat is idle and
//   the composer is empty, after the Host answered for this state of the chat (withdrawn answers, a fork's offset); a
//   click sends `Option N: <item>` once; a failed send shows the reason and keeps the buttons; a picked answer hides them.
// - Next message prediction: no guess (and no model call) while the chat offers options.
// - Question card keys 1–9: dsh's own option button, not in a text field, not with a modifier, not during IME
//   composition, not with a dialog open, not for an option that is not there, not in the first 800 ms of a question.
// - The feature through plugin.apply: on by default; the slot and the key listener; switched off, both go.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__op = { chatOffer, OptionPicks, NextPrediction, createOptionPicks, createRollbackCheck, createOptionsGate, installOptionKeys, chatStateKey };\n    ${ANCHOR}`));

// Fake React: per-component hook state; an effect runs again when its dependencies change; a store hook reads now.
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; return cur.refs[i] ??= { current: v }; },
  useSyncExternalStore: (sub, get) => get(),
  useLayoutEffect: () => {},
  useEffect: (f, deps) => {
    const i = cur.ei++; const old = cur.deps[i];
    if (old !== undefined && deps !== undefined && deps.length === old.length && deps.every((d, k) => Object.is(d, old[k]))) return;
    cur.cleanups[i]?.(); cur.deps[i] = deps ?? []; cur.cleanups[i] = f();
  } };
const mount = (C, props) => {
  const inst = { state: [], refs: [], cleanups: [], deps: [] };
  const render = (more = {}) => { Object.assign(props, more); cur = inst; inst.si = 0; inst.ri = 0; inst.ei = 0; return C(props); };
  return { render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) } : {}));
const { chatOffer, OptionPicks, NextPrediction, createOptionPicks, createRollbackCheck, createOptionsGate, installOptionKeys, chatStateKey } = globalThis.__op;
const flush = () => new Promise((r) => setTimeout(r, 0));
const t = (k, p) => (p === undefined ? k : `${k}:${JSON.stringify(p)}`);
const texts = (node) => (Array.isArray(node) ? node.flatMap(texts) : node === null || node === undefined || node === false ? [] : typeof node !== 'object' ? [String(node)] : (node.c ?? []).flatMap(texts));
const buttonsOf = (view) => (view === null ? [] : view.c.flat().filter((c) => c?.t === 'button'));

// --- OptionPicks: which answer shows the buttons ---
const tail = (turn, seq, text, status = 'settled') => ({ kind: 'turn-tail', anchorSeq: seq, data: { turn, seq: seq + 1, closing: { status, turn, blocks: [{ kind: 'text', text }], finalNode: { seq } } } });
const chat = (...nodes) => ({ nodes: new Map(nodes.map((n, i) => [`k${i}`, n])) });
const OPTS = 'Done.\n\n## Options\n1. Merge it\n2. Add a test first (recommended)\n   with a fixture';
let session = { blank: false, running: false, subagent: null, removed: false };
let input = { phase: 'plain', draft: '', attachmentIds: [] };
let view = chat(tail(1, 10, 'Hi.'), tail(2, 20, OPTS));
let rbState = { spans: [], withdrawn: [], rewind: false, busy: false, error: null, redo: null, inherited: 0 };
const rbListeners = new Set();
const rollback = { of: () => rbState, subscribe: (fn) => { rbListeners.add(fn); return () => rbListeners.delete(fn); } };
let loads = 0; let hostAnswers = true;
const check = createRollbackCheck(async () => { loads += 1; return hostAnswers; });
const sent = []; let gate; let failNext = false;
const picks = createOptionPicks(async (id, text) => { sent.push([id, text]); if (gate) await gate; if (failNext) { failNext = false; throw new Error('conversation.send failed: busy'); } });
const gate2 = createOptionsGate(picks, rollback); gate2.setOn(true);
const offers = () => gate2.offers('A', view);
const hooks = { useSession: (sel) => sel(session), useInput: (sel) => sel(input), useChat: (sel) => sel(view) };
// dsh gives `turn` as its turn object; the cell uses only `seq`.
const cell = (turn, seq) => mount(OptionPicks, { sessionId: 'A', turn: { turn, status: 'closed' }, seq, ...hooks, picks, check, rollback, t });
const newest = cell(2, 20); const older = cell(1, 10);
assert.equal(newest.render(), null, 'nothing before the Host answered');
await flush(); assert.equal(loads, 1, 'one ask for this state of the chat');
let out = newest.render();
assert.equal(out.p.role, 'group'); assert.equal(out.p['aria-label'], 'optionPicks.group'); assert.equal(out.p['data-composer-plus-option-picks'], '20');
let buttons = buttonsOf(out);
assert.deepEqual(buttons.map((b) => texts(b).join(' ')), ['1. Merge it', '2. Add a test first optionPicks.recommended'], 'one button per option; the recommended one is marked');
assert.equal(buttons[1].p['data-recommended'], ''); assert.equal(buttons[0].p['data-recommended'], undefined);
assert.equal(buttons[1].p.title, 'Add a test first\nwith a fixture', 'the whole item in the tooltip');
assert.ok(offers(), 'the chat offers options: prediction steps back');
assert.equal(older.render(), null, 'an older answer shows nothing');
await flush(); assert.equal(loads, 1, 'every answer of the chat shares the ask');
// While the composer has text: hidden, but prediction still steps back (the options are still offered).
input = { ...input, draft: 'hm' }; assert.equal(newest.render(), null, 'a draft hides the buttons'); assert.ok(offers(), 'still offered while you type: no guess either');
input = { ...input, draft: '' };
input = { ...input, attachmentIds: ['img'] }; assert.equal(newest.render(), null, 'an attachment hides them'); input = { ...input, attachmentIds: [] };
// While the chat runs: hidden, and no ask.
session = { ...session, running: true }; assert.equal(newest.render(), null, 'not while the chat runs');
session = { ...session, running: false };
for (const other of [{ subagent: { id: 'p' } }, { removed: true }, { blank: true }]) {
  session = { ...session, ...other }; assert.equal(newest.render(), null, `not in ${JSON.stringify(other)}`); session = { blank: false, running: false, subagent: null, removed: false };
}
assert.ok(buttonsOf(newest.render()).length === 2, 'back when idle again');
// A click sends once; a second click during the send sends nothing more; the buttons are off meanwhile.
let release; gate = new Promise((r) => { release = r; });
buttons = buttonsOf(newest.render()); buttons[1].p.onClick(); buttons[0].p.onClick();
out = newest.render(); assert.ok(buttonsOf(out).every((b) => b.p.disabled === true), 'off while the pick is sent');
assert.deepEqual(sent, [['A', 'Option 2: Add a test first\nwith a fixture']], 'one message: the whole item');
release(); await flush(); gate = undefined;
assert.equal(newest.render(), null, 'a picked answer shows no buttons'); assert.equal(offers(), false, 'picked: prediction may guess again');
// A new answer with options: the chat changed, so the Host is asked again before the buttons show.
view = chat(tail(1, 10, 'Hi.'), tail(2, 20, OPTS), { kind: 'user', anchorSeq: 22, data: { seq: 22 } }, tail(3, 30, '## Options\n1. Ship\n2. Wait'));
const third = cell(3, 30);
assert.equal(third.render(), null, 'a new state of the chat: wait for the Host'); await flush(); assert.equal(loads, 2);
out = third.render(); assert.deepEqual(buttonsOf(out).map((b) => texts(b).join(' ')), ['1. Ship', '2. Wait']);
// A failed send shows dsh's reason and keeps the buttons on.
failNext = true; buttonsOf(third.render())[0].p.onClick(); await flush();
out = third.render(); assert.equal(buttonsOf(out).length, 2, 'the buttons stay after a failed send');
assert.equal(out.c.at(-1).p.role, 'alert'); assert.equal(texts(out.c.at(-1)).join(''), 'optionPicks.failed:{"error":"conversation.send failed: busy"}');
// Rule 9: Turn rollback withdrew the newest answer (marker at 32): the answer before it offers again once the Host told so.
view = chat(...view.nodes.values(), { kind: 'user', anchorSeq: 32, data: { seq: 32 } });
rbState = { ...rbState, withdrawn: [[22, 32]] };
assert.equal(third.render(), null, 'a new state: wait');
await flush(); assert.equal(third.render(), null, 'the withdrawn answer shows nothing');
assert.deepEqual(buttonsOf(newest.render()).map((b) => texts(b)[1]), ['Merge it', 'Add a test first'], 'the rollback also withdrew the pick (seq 22): turn 2 offers again');
// Rule 10: a fork whose own events start after the answer shows nothing.
const forkView = chat(tail(1, 10, OPTS));
const forkCell = mount(OptionPicks, { sessionId: 'F', turn: 1, seq: 10, ...hooks, useChat: (sel) => sel(forkView), picks, check, rollback: { of: () => ({ ...rbState, withdrawn: [], inherited: 13 }), subscribe: rollback.subscribe }, t });
forkCell.render(); await flush(); assert.equal(forkCell.render(), null, 'a fork: the parent\'s answer offers nothing');
// No Host answer (an older Host, an error): no buttons.
hostAnswers = false;
const quiet = mount(OptionPicks, { sessionId: 'Q', turn: 1, seq: 10, ...hooks, useChat: (sel) => sel(chat(tail(1, 10, OPTS))), picks, check, rollback, t });
quiet.render(); await flush(); assert.equal(quiet.render(), null, 'no Host answer: no buttons');
hostAnswers = true;
newest.unmount(); older.unmount(); third.unmount(); forkCell.unmount(); quiet.unmount();
// The gate: off with the switch; a pick changes its version (prediction reads the chat again).
{ const g = createOptionsGate(picks, rollback); const c1 = chat(tail(1, 10, OPTS)); let n = 0; g.subscribe(() => n++);
  assert.equal(g.offers('G', c1), false, 'switched off: no gate'); g.setOn(true); assert.equal(g.offers('G', c1), true); assert.equal(n, 1);
  const v = g.version(); assert.equal(await picks.pick('G', chatOffer(c1, [], 0), 1), true);
  assert.ok(g.version() > v, 'a pick changes the version'); assert.equal(g.offers('G', c1), false, 'picked: no gate');
  assert.equal(g.offers('H', chat(tail(1, 10, 'No list.'))), false, 'no list: no gate');
  g.setOn(false); assert.equal(g.offers('H', chat(tail(2, 20, OPTS))), false, 'off again'); }
// The chat state key: a new node or a newer seq changes it; the same snapshot gives the same key.
{ const c1 = chat(tail(1, 10, 'a')); assert.equal(chatStateKey(c1), '1:10'); assert.equal(chatStateKey(chat(tail(1, 10, 'a'), { kind: 'user', anchorSeq: 12 })), '2:12');
  assert.equal(chatStateKey(undefined), null); }

// --- Next message prediction steps back while options show ---
{
  const asked = []; let pchat = chat(tail(1, 40, OPTS));
  const pg = createOptionsGate(picks, rollback); pg.setOn(true);
  const props = { sessionId: 'P', useSession: (sel) => sel(session), useInput: (sel) => sel(input), useChat: (sel) => sel(pchat),
    useTurnEnd: (sel) => sel({ entries: [{ event: { type: 'turn/end', seq: 41, data: { reason: { kind: 'completed' } } } }] }),
    inputActions: { setDraft() {} }, predict: async (afterSeq) => { asked.push(afterSeq); return 'next please'; }, optionsGate: pg, t };
  const p = mount(NextPrediction, props); p.render(); await flush(); p.render();
  assert.deepEqual(asked, [], 'no model call while the chat offers options (no wait for the Host)');
  pchat = chat(tail(1, 40, 'No options.')); p.render(); await flush();
  assert.deepEqual(asked, [41], 'no options: the guess is asked');
  pchat = chat(tail(1, 40, OPTS)); pg.setOn(false);
  const off = mount(NextPrediction, { ...props, sessionId: 'P2' }); off.render(); await flush();
  assert.deepEqual(asked, [41, 41], 'Option picks switched off: prediction works as before');
  const old = mount(NextPrediction, { ...props, sessionId: 'P3', optionsGate: undefined, useChat: undefined }); old.render(); await flush();
  assert.deepEqual(asked, [41, 41, 41], 'without the gate (older wiring), prediction works as before');
}

// --- Question card keys ---
class El {
  constructor(tag, attrs = {}, children = []) { this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.clicks = 0; this.disabled = false; for (const c of children) this.append(c); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  append(c) { c.parentElement = this; this.children.push(c); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; }
  contains(e) { for (let x = e; x; x = x.parentElement) if (x === this) return true; return false; }
  closest(sel) { for (let x = this; x; x = x.parentElement) if (sel.split(', ').some((s) => matches(x, s))) return x; return null; }
  click() { this.clicks += 1; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((e) => sel.split(', ').some((s) => matches(e, s))); }
}
const matches = (e, s) => {
  if (s === '[data-question-key] > section') return e.tagName === 'SECTION' && e.parentElement?.getAttribute('data-question-key') !== null && e.parentElement !== null;
  if (s === '[role="radio"]' || s === '[role="checkbox"]') return e.getAttribute('role') === s.slice(7, -2);
  if (s === 'input' || s === 'textarea' || s === 'select') return e.tagName === s.toUpperCase();
  if (s === '[contenteditable]:not([contenteditable="false"])') return e.getAttribute('contenteditable') !== null && e.getAttribute('contenteditable') !== 'false';
  if (s === '[aria-modal="true"]') return e.getAttribute('aria-modal') === 'true';
  if (s === 'dialog[open]') return e.tagName === 'DIALOG' && e.getAttribute('open') !== null;
  if (s === '[role="menu"]') return e.getAttribute('role') === 'menu';
  return false;
};
const body = new El('body');
const winListeners = new Map();
const doc = { body, activeElement: body, defaultView: { addEventListener: (t, f, c) => { assert.equal(c, true, 'capture'); winListeners.set(t, f); }, removeEventListener: (t) => winListeners.delete(t) },
  querySelectorAll: (s) => body.querySelectorAll(s), querySelector: (s) => body.querySelectorAll(s)[0] ?? null };
let observing = 0; let onMutation = () => {};
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; } observe(target, opts) { assert.equal(target, globalThis.document?.body ?? body, 'the page body'); assert.ok(opts.subtree); observing += 1; onMutation = this.fn; } disconnect() { observing -= 1; } };
let clock = 1000;
const card = (key, q, roles) => { const opts = roles.map((role) => new El('button', { role })); const field = new El('textarea'); const section = new El('section', { 'aria-labelledby': `question-${key}-${q}` }, [new El('div', {}, [...opts, field])]); return { frame: new El('div', { 'data-question-key': key }, [section]), opts, field, section }; };
const off = installOptionKeys(doc, () => clock);
assert.equal(observing, 1); assert.ok(winListeners.has('keydown'));
const press = (key, more = {}) => { let prevented = false; let stopped = false; winListeners.get('keydown')({ key, target: doc.activeElement, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, defaultPrevented: false, ...more, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } }); return { prevented, stopped }; };
press('1'); // no card: nothing, no error
let q = card('req-1', 0, ['radio', 'radio', 'radio']); body.append(q.frame); onMutation();
clock += 500; assert.deepEqual(press('1'), { prevented: false, stopped: false }, 'the first 800 ms: nothing'); assert.equal(q.opts[0].clicks, 0);
clock += 400; let r = press('2'); assert.equal(q.opts[1].clicks, 1, 'key 2 clicks option 2'); assert.deepEqual(r, { prevented: true, stopped: true });
press('9'); assert.ok(q.opts.every((o, i) => o.clicks === (i === 1 ? 1 : 0)), 'no option 9: nothing');
press('0'); press('a'); press('Enter'); assert.equal(q.opts[0].clicks, 0, 'only 1–9');
for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'repeat']) press('1', { [mod]: true });
press('1', { keyCode: 229 }); press('1', { defaultPrevented: true });
assert.equal(q.opts[0].clicks, 0, 'a modifier, a held key, IME composition or a handled key: nothing');
doc.activeElement = q.field; press('1', { target: q.field }); assert.equal(q.opts[0].clicks, 0, 'typing in the answer field: nothing');
const composer = new El('div', { contenteditable: 'true' }); body.append(composer); doc.activeElement = composer; press('1', { target: composer });
assert.equal(q.opts[0].clicks, 0, 'typing in dsh\'s composer: nothing'); composer.remove(); doc.activeElement = body;
const dialog = new El('div', { 'aria-modal': 'true' }); body.append(dialog); press('1'); assert.equal(q.opts[0].clicks, 0, 'a dialog is open: nothing'); dialog.remove();
q.opts[0].disabled = true; press('1'); assert.equal(q.opts[0].clicks, 0, 'a locked option (dsh sends the answer): nothing'); q.opts[0].disabled = false;
// The next question of the same card (dsh moves on after a pick): a new 800 ms guard.
q.section.attrs['aria-labelledby'] = 'question-req-1-1'; onMutation();
press('1'); assert.equal(q.opts[0].clicks, 0, 'the next question: the guard starts again');
clock += 900; press('1'); assert.equal(q.opts[0].clicks, 1);
// Checkboxes (multiSelect) count too.
q.frame.remove(); onMutation();
const multi = card('req-2', 0, ['checkbox', 'checkbox']); body.append(multi.frame); onMutation(); clock += 900;
press('2'); assert.equal(multi.opts[1].clicks, 1, 'a checkbox option');
// Two cards on screen (two chats side by side): only the one with the focus; none without the focus.
const second = card('req-3', 0, ['radio', 'radio']); body.append(second.frame); onMutation(); clock += 900;
press('1'); assert.equal(multi.opts[0].clicks + second.opts[0].clicks, 0, 'two cards, no focus in one: nothing');
doc.activeElement = second.opts[1]; press('1', { target: second.opts[1] }); assert.equal(second.opts[0].clicks, 1, 'the card with the focus');
doc.activeElement = body;
off(); assert.equal(observing, 0, 'off: no observer'); assert.equal(winListeners.size, 0, 'off: no key listener');
assert.equal(installOptionKeys(undefined), undefined, 'no page: nothing');

// --- The feature through plugin.apply ---
{
  const slots = new Map(); let setFeature;
  plugin.apply({
    slots: { inject: (n, f) => f(), register: (o, C) => { if (o.id === 'composer-plus') setFeature = o.inject().setFeature; const key = Symbol(o.id); slots.set(key, [o, C]); return () => slots.delete(key); } },
    configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k }, effect: (f) => f(),
  });
  // The real page: installOptionKeys reads globalThis.document.
  const slot = () => [...slots.values()].find(([o]) => o.id === 'option-picks');
  const found = slot(); assert.ok(found, 'on by default: the turn-tail slot');
  assert.equal(found[0].name, 'conversation.chat.turnTail'); assert.equal(found[0].locale, 'dsh-composer-plus'); assert.equal(found[1], OptionPicks);
  const face = found[0].inject('A'); assert.equal(typeof face.picks.pick, 'function'); assert.equal(typeof face.check.ask, 'function'); assert.equal(typeof face.rollback.load, 'function');
  assert.equal(face.hooks, undefined, 'the chat, session and input hooks come from dsh\'s session scope');
  const prediction = [...slots.values()].find(([o]) => o.id === 'next-prediction');
  const gate = prediction[0].inject('A').optionsGate; assert.equal(typeof gate.offers, 'function', 'prediction reads the options gate');
  assert.equal(gate.offers('Z', chat(tail(1, 10, OPTS))), true, 'on: the gate is open');
  setFeature('optionPicks', false); assert.equal(slot(), undefined, 'off: no slot'); assert.equal(gate.offers('Z', chat(tail(1, 10, OPTS))), false, 'off: prediction is not held back');
  assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { optionPicks: false }, 'the choice is kept');
  setFeature('optionPicks', true); assert.ok(slot(), 'on again');
}
// With a page: the key listener comes with the switch and goes with it.
{
  const page = new El('body'); const listeners = new Map();
  globalThis.document = { body: page, defaultView: { addEventListener: (t, f) => listeners.set(t, f), removeEventListener: (t) => listeners.delete(t) }, querySelectorAll: () => [], querySelector: () => null };
  mem.clear(); let setFeature;
  plugin.apply({ slots: { inject: (n, f) => f(), register: (o) => { if (o.id === 'composer-plus') setFeature = o.inject().setFeature; return () => {}; } },
    configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k }, effect: (f) => f() });
  assert.ok(listeners.has('keydown'), 'on: the question card keys listen'); assert.equal(observing, 1);
  setFeature('optionPicks', false); assert.equal(listeners.has('keydown'), false, 'off: no key listener'); assert.equal(observing, 0, 'off: no observer');
  delete globalThis.document;
}
console.log('option-picks-ui checks passed');
