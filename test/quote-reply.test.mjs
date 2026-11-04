// Quote in reply (client): the real client.js with fake React, a fake DOM selection and fake dsh services.
// - quoteText: `> ` lines (an empty line as `>`); an empty line before and after it, as the text around the caret needs;
//   at the end of the draft one more line break (the real dsh drops one when you type there); CRLF and NBSP; at most QUOTE_MAX characters (cut with …, by code point); blank → ''.
// - quoteTarget: only a selection whose two ends are in one answer node of this chat's body counts (not another answer,
//   another chat, a user message, a tool row, a collapsed or blank selection).
// - QuoteReply: the button shows for such a selection (fixed, in document.body), a click inserts the quote at the caret
//   through dsh's insertText with the captured span (one undo step), clears the selection, focuses the composer; a refused
//   insert shows the notice and keeps the button; the listeners go with the row.
// - The feature through plugin.apply: on by default, `conversation.input.right` slot; switched off, the slot goes.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
const listeners = { doc: new Map(), win: new Map() };
const on = (m) => (type, fn) => { if (!m.has(type)) m.set(type, new Set()); m.get(type).add(fn); };
const off = (m) => (type, fn) => { m.get(type)?.delete(fn); };
let selection = null; let removed = 0;
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, innerWidth: 1280,
  getSelection: () => (selection === null ? null : { ...selection, removeAllRanges: () => { removed += 1; selection = null; } }),
  addEventListener: on(listeners.win), removeEventListener: off(listeners.win) };
globalThis.document = { body: { id: 'body' }, addEventListener: on(listeners.doc), removeEventListener: off(listeners.doc), querySelector: () => null };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__q = { quoteText, quoteTarget, QuoteReply, QUOTE_MAX, QUOTE_ANSWER };\n    ${ANCHOR}`));
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; if (!(i in cur.refs)) cur.refs[i] = { current: v }; return cur.refs[i]; },
  useCallback: (f) => { const i = cur.ci++; if (!(i in cur.cbs)) cur.cbs[i] = f; return cur.cbs[i]; },
  useSyncExternalStore: (sub, get) => get(),
  useEffect: (f, deps) => {
    const i = cur.ei++; const old = cur.deps[i];
    if (old !== undefined && deps !== undefined && deps.length === old.length && deps.every((d, k) => Object.is(d, old[k]))) return;
    cur.cleanups[i]?.(); cur.deps[i] = deps ?? []; cur.cleanups[i] = f();
  } };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) } : { Button: 'Button' }));
const { quoteText, quoteTarget, QuoteReply, QUOTE_MAX, QUOTE_ANSWER } = globalThis.__q;

// --- quoteText ---
assert.equal(quoteText('Use pnpm.'), '> Use pnpm.\n\n\n', 'at the end of the draft: three line breaks');
assert.equal(quoteText('  a\r\n\r\nb\u00a0c  ', '', 'z'), '> a\n>\n> b c\n\n', 'CRLF, an empty line, NBSP, trim');
assert.equal(quoteText('x', 'My note', 'z'), '\n\n> x\n\n', 'after text on the same line: an empty line first');
assert.equal(quoteText('x', 'My note\n', 'z'), '\n> x\n\n', 'after a line break: one more');
assert.equal(quoteText('x', 'My note\n\n', 'z'), '> x\n\n', 'after an empty line: nothing first');
assert.equal(quoteText('   \n '), '', 'blank: nothing');
const long = quoteText('😀'.repeat(QUOTE_MAX + 5));
assert.equal([...long.slice(2, -3)].length, QUOTE_MAX, 'cut to QUOTE_MAX code points'); assert.ok(long.endsWith('…\n\n\n'));
assert.equal(quoteText('x', 'a', '\nb'), '\n\n> x\n', 'before a line break: one more');
assert.equal(quoteText('x', 'a', '\n\nb'), '\n\n> x', 'before an empty line: nothing more');
assert.equal(quoteText('a'.repeat(QUOTE_MAX), '', 'z'), `> ${'a'.repeat(QUOTE_MAX)}\n\n`, 'QUOTE_MAX itself is not cut');

// --- A fake DOM: answers in chat bodies ---
const node = (attrs, parent = null) => {
  const n = { nodeType: 1, attrs, parentElement: parent, getAttribute: (k) => attrs[k] ?? null };
  n.closest = (sel) => { for (let x = n; x !== null; x = x.parentElement) if (matches(x, sel)) return x; return null; };
  return n;
};
const matches = (x, sel) => (sel === QUOTE_ANSWER ? x.attrs.answer === true : sel === '[data-conversation-session]' ? x.attrs['data-conversation-session'] !== undefined : false);
const text = (parent) => ({ nodeType: 3, parentElement: parent });
const body = node({ 'data-conversation-session': 'S' });
const answer1 = node({ answer: true }, node({}, body));
const answer2 = node({ answer: true }, node({}, body));
const user = node({}, body);
const other = node({ answer: true }, node({ 'data-conversation-session': 'T' }));
const sel = (a, f, str = 'Use pnpm.', more = {}) => ({ rangeCount: 1, isCollapsed: false, anchorNode: a, focusNode: f, toString: () => str,
  getRangeAt: () => ({ getBoundingClientRect: () => ({ right: 600, top: 300 }) }), ...more });

// --- quoteTarget ---
assert.equal(quoteTarget(sel(text(answer1), text(answer1)), 'S'), answer1, 'one answer of this chat');
assert.equal(quoteTarget(sel(answer1, text(answer1)), 'S'), answer1, 'an element end counts too');
assert.equal(quoteTarget(sel(text(answer1), text(answer2)), 'S'), null, 'two answers');
assert.equal(quoteTarget(sel(text(user), text(user)), 'S'), null, 'a user message (or a tool row)');
assert.equal(quoteTarget(sel(text(answer1), text(user)), 'S'), null, 'from an answer into a user message');
assert.equal(quoteTarget(sel(text(other), text(other)), 'S'), null, 'another chat');
assert.equal(quoteTarget(sel(text(answer1), text(answer1), '  \n'), 'S'), null, 'blank');
assert.equal(quoteTarget(sel(text(answer1), text(answer1), 'x', { isCollapsed: true }), 'S'), null, 'collapsed');
assert.equal(quoteTarget(sel(text(answer1), text(answer1), 'x', { rangeCount: 0 }), 'S'), null, 'no range');
assert.equal(quoteTarget(null, 'S'), null);

// --- QuoteReply ---
const mount = (C, props) => {
  const inst = { state: [], refs: [], cbs: [], cleanups: [], deps: [] };
  const render = (more = {}) => { Object.assign(props, more); cur = inst; inst.si = 0; inst.ri = 0; inst.ci = 0; inst.ei = 0; return C(props); };
  return { render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const fire = (m, type) => { for (const fn of [...(m.get(type) ?? [])]) fn({}); };
const t = (k) => k;
{
  let draft = 'First line'; let span = { start: 10, end: 10, draftRev: 3 }; const inserts = []; let accept = true; const notes = []; let focused = 0;
  const inputActions = { captureInsertion: () => span, insertText: (text, s) => { inserts.push([text, s]); return accept; } };
  const props = { sessionId: 'S', useInput: (f) => f({ draft }), inputActions, focusComposer: () => { focused += 1; }, notify: (level, text) => notes.push([level, text]), t };
  const v = mount(QuoteReply, props);
  assert.equal(v.render(), null, 'no selection: nothing');
  assert.equal(listeners.doc.get('selectionchange').size, 1); assert.equal(listeners.win.get('scroll').size, 1);
  // A selection in an answer of this chat: the button.
  selection = sel(text(answer1), text(answer1), 'Use pnpm, not npm.');
  fire(listeners.doc, 'selectionchange');
  let out = v.render();
  assert.equal(out.host, document.body); assert.equal(out.portal.t, 'button');
  assert.equal(out.portal.p['data-composer-plus-quote'], ''); assert.equal(out.portal.p.style.position, 'fixed');
  assert.equal(out.portal.c.at(-1), 'quote.button'); assert.equal(out.portal.p.title, 'quote.title');
  let prevented = 0; out.portal.p.onMouseDown({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, 'mousedown keeps the selection');
  // A click: the quote at the caret, after the text before it.
  out.portal.p.onClick();
  assert.deepEqual(inserts, [['\n\n> Use pnpm, not npm.\n\n\n', { start: 10, end: 10, draftRev: 3 }]], 'insertText with the captured span');
  assert.equal(removed, 1, 'the selection goes'); assert.equal(focused, 1, 'the composer gets the focus');
  assert.equal(v.render(), null, 'the button goes');
  // The caret in the middle of the draft: only the text before it counts.
  draft = 'Before\nafter'; span = { start: 7, end: 7, draftRev: 4 };
  selection = sel(text(answer2), text(answer2), 'Part'); fire(listeners.doc, 'selectionchange'); v.render().portal.p.onClick();
  assert.equal(inserts.at(-1)[0], '\n> Part\n\n', 'the text after the caret counts too');
  // A refused insert (the draft changed, or dsh locks the composer): the notice; the button stays.
  accept = false;
  selection = sel(text(answer1), text(answer1), 'Again'); fire(listeners.doc, 'selectionchange'); v.render().portal.p.onClick();
  assert.deepEqual(notes, [['info', 'quote.changed']]); assert.ok(v.render(), 'the button stays for a retry');
  assert.equal(focused, 2, 'no focus move after a refused insert');
  // A selection that does not count, and a scroll that moves it out: the button goes.
  selection = sel(text(user), text(user), 'mine'); fire(listeners.doc, 'selectionchange');
  assert.equal(v.render(), null, 'a user message: no button');
  selection = sel(text(answer1), text(answer1), 'x'); fire(listeners.doc, 'selectionchange'); assert.ok(v.render());
  selection = null; fire(listeners.win, 'scroll'); assert.equal(v.render(), null, 'a scroll reads the selection again');
  // Another chat's row does not show a button for this chat's selection.
  const vT = mount(QuoteReply, { ...props, sessionId: 'T' }); vT.render();
  selection = sel(text(answer1), text(answer1), 'x'); fire(listeners.doc, 'selectionchange');
  assert.equal(vT.render(), null, 'another chat'); assert.ok(v.render(), 'this chat');
  vT.unmount();
  // No dsh input face: no button.
  assert.equal(mount(QuoteReply, { ...props, inputActions: undefined }).render(), null);
  v.unmount();
  assert.equal(listeners.doc.get('selectionchange').size, 1, 'one listener left (the no-input row)');
}

// --- The feature through plugin.apply ---
{
  const regs = new Set();
  const ctx = {
    effect: (f) => { f(); }, locale: { register: () => () => {}, bind: () => (k) => k }, inject: () => ({ dispose() {} }), configForms: { get: () => ({}) },
    sessions: { scope: () => ({ get: () => ({ input: { for: () => ({ focus() {}, notify() {} }) } }) }), sessionOf: () => undefined, list: { getSnapshot: () => ({ byId: {} }) } },
    slots: { inject: (name, f) => f(), register: (o, C) => { const r = [o, C]; regs.add(r); return () => { regs.delete(r); }; } },
    get: () => undefined,
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ on: true }) });
  const row = () => [...regs].find(([o]) => o.id === 'quote-reply');
  plugin.apply(ctx);
  assert.ok(row(), 'on by default'); assert.equal(row()[0].name, 'conversation.input.right'); assert.equal(row()[1], QuoteReply);
  const injected = row()[0].inject('S');
  assert.equal(injected.sessionId, 'S'); assert.equal(typeof injected.focusComposer, 'function'); injected.focusComposer(); injected.notify('info', 'x');
  const toggles = JSON.parse(mem.get('dsh-composer-plus.features') ?? '{}');
  mem.set('dsh-composer-plus.features', JSON.stringify({ ...toggles, quoteReply: false }));
  regs.clear(); plugin.apply(ctx);
  assert.equal(row(), undefined, 'off: no slot');
}
console.log('quote-reply: ok');
