// Quote in reply (client): the real client.js with fake React, a fake DOM selection and fake dsh services.
// - quoteText: `> ` lines (an empty line as `>`); an empty line before and after it, as the text around the caret needs;
//   at the end of the draft one more line break (the real dsh drops one when you type there); CRLF and NBSP; at most QUOTE_MAX characters (cut with …, by code point); blank → ''.
// - quoteTarget: only a selection whose two ends are in one message node of this chat's body counts: an answer (dsh 0.2.0,
//   0.2.1) or dsh's own quote source (0.2.2+: your message too); not two messages, another chat, a tool row, a collapsed
//   or blank selection.
// - QuoteReply with `menu` (Quote in reply): no floating button. A right-click on the selected text opens dsh's Menu at
//   the pointer with Copy and Quote (in this order, from the language packs), also at once where a drag ended (past the
//   last selected letter: its text position is in the selection); a link, a part with its own menu, a click
//   beside the selected text (also in the same message) or no selection keeps the browser's menu. Quote inserts at the caret (dsh's insertQuote
//   when it has one, else `> ` lines through insertText with the captured span), clears the selection, focuses the
//   composer; a refused insert shows the notice. Copy selects the text again and runs the copy command.
// - The labels in 13 languages: tr Kopyala / Alıntıla, en Copy / Quote, zh 复制 / 引用, the others not empty.
// - The feature through plugin.apply: on by default, `conversation.input.right` slot and the empty entry over dsh's
//   "Quote text" button; switched off, both go.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
const listeners = { doc: new Map(), win: new Map() };
const on = (m) => (type, fn) => { if (!m.has(type)) m.set(type, new Set()); m.get(type).add(fn); };
const off = (m) => (type, fn) => { m.get(type)?.delete(fn); };
let selection = null; let removed = 0; const added = [];
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, innerWidth: 1280,
  getSelection: () => (selection === null ? null : { ...selection, removeAllRanges: () => { removed += 1; selection = null; }, addRange: (r) => { added.push(r); } }),
  addEventListener: on(listeners.win), removeEventListener: off(listeners.win) };
globalThis.document = { body: { id: 'body' }, addEventListener: on(listeners.doc), removeEventListener: off(listeners.doc), querySelector: () => null };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__q = { quoteText, quoteTarget, QuoteReply, QUOTE_MAX, QUOTE_SOURCE, QUOTE_SKIP, quoteSelectionText, primitives };\n    ${ANCHOR}`));
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
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) } : { Button: 'Button', Menu: 'Menu' }));
const { quoteText, quoteTarget, QuoteReply, QUOTE_MAX, QUOTE_SOURCE, QUOTE_SKIP, quoteSelectionText, primitives } = globalThis.__q;

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

// --- quoteSelectionText: dsh's left-out parts are hidden while the browser reads the text, then put back exactly ---
{
  const attr = (style) => { const a = { style }; return { getAttribute: () => a.style, setAttribute: (_k, v) => { a.style = v; }, removeAttribute: () => { a.style = null; }, get value() { return a.style; } }; };
  const label = attr(null); const math = attr('color: red');
  let skipSel; const target = { querySelectorAll: (q) => { skipSel = q; return [label, math]; } };
  const read = { toString: () => [label, math].map((e) => (/display:none!important$/.test(e.value ?? '') ? 'hidden' : 'shown')).join(' ') };
  assert.equal(quoteSelectionText(read, target), 'hidden hidden', 'both parts are hidden while the text is read');
  assert.equal(skipSel, QUOTE_SKIP);
  assert.equal(label.value, null, 'no style attribute before: none after'); assert.equal(math.value, 'color: red', 'its own style back');
  for (const part of ['[data-text-interaction-exclude]', '.katex-mathml', '[hidden]', '.sr-only', ':not(code) > button']) assert.ok(QUOTE_SKIP.includes(part), part);
  const boom = { toString: () => { throw Error('x'); } };
  assert.throws(() => quoteSelectionText(boom, target)); assert.equal(label.value, null, 'put back after a failure too');
}

// --- A fake DOM: messages in chat bodies ---
const node = (attrs, parent = null) => {
  const n = { nodeType: 1, attrs, parentElement: parent, getAttribute: (k) => attrs[k] ?? null };
  n.closest = (sel) => { for (let x = n; x !== null; x = x.parentElement) if (matches(x, sel)) return x; return null; };
  n.contains = (o) => { for (let x = o; x != null; x = x.parentElement) if (x === n) return true; return false; };
  return n;
};
// An answer (`answer`: the answer node of dsh 0.2.0/0.2.1) or dsh 0.2.2's quote source (`source`: your message too).
const matches = (x, sel) => (sel === QUOTE_SOURCE ? x.attrs.answer === true || x.attrs.source === true : sel === '[data-conversation-session]' ? x.attrs['data-conversation-session'] !== undefined : false);
const text = (parent) => ({ nodeType: 3, parentElement: parent });
const body = node({ 'data-conversation-session': 'S' });
const answer1 = node({ answer: true }, node({}, body));
const answer2 = node({ answer: true }, node({}, body));
const user = node({ source: true }, body);
const tool = node({}, body);
const other = node({ answer: true }, node({ 'data-conversation-session': 'T' }));
const sel = (a, f, str = 'Use pnpm.', more = {}) => ({ rangeCount: 1, isCollapsed: false, anchorNode: a, focusNode: f, toString: () => str,
  // The selected text has two line boxes: 400..640 × 210..230 and 380..520 × 230..250.
  getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 500, right: 600, top: 300, bottom: 320 }), getClientRects: () => [{ left: 400, right: 640, top: 210, bottom: 230 }, { left: 380, right: 520, top: 230, bottom: 250 }],
    isPointInRange: (node) => node === 'in', cloneRange() { return this; } }), ...more });

// --- quoteTarget ---
assert.equal(quoteTarget(sel(text(answer1), text(answer1)), 'S'), answer1, 'one answer of this chat');
assert.equal(quoteTarget(sel(answer1, text(answer1)), 'S'), answer1, 'an element end counts too');
assert.equal(quoteTarget(sel(text(answer1), text(answer2)), 'S'), null, 'two answers');
assert.equal(quoteTarget(sel(text(user), text(user)), 'S'), user, 'your message (dsh 0.2.2+ quote source)');
assert.equal(quoteTarget(sel(text(tool), text(tool)), 'S'), null, 'a tool row');
assert.equal(quoteTarget(sel(text(answer1), text(user)), 'S'), null, 'from an answer into a user message');
assert.equal(quoteTarget(sel(text(other), text(other)), 'S'), null, 'another chat');
assert.equal(quoteTarget(sel(text(answer1), text(answer1), '  \n'), 'S'), null, 'blank');
assert.equal(quoteTarget(sel(text(answer1), text(answer1), 'x', { isCollapsed: true }), 'S'), null, 'collapsed');
assert.equal(quoteTarget(sel(text(answer1), text(answer1), 'x', { rangeCount: 0 }), 'S'), null, 'no range');
assert.equal(quoteTarget(null, 'S'), null);

// --- QuoteReply (Quote in reply: the right-click menu) ---
const mount = (C, props) => {
  const inst = { state: [], refs: [], cbs: [], cleanups: [], deps: [] };
  const render = (more = {}) => { Object.assign(props, more); cur = inst; inst.si = 0; inst.ri = 0; inst.ci = 0; inst.ei = 0; return C(props); };
  return { render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const fire = (m, type, e = {}) => { for (const fn of [...(m.get(type) ?? [])]) fn(e); };
const t = (k) => k;
/** A right-click on `on` (a node; `closest` for the link rule) at x, y; returns whether the menu took it. */
const rightClick = (on, x = 410, y = 220, more = {}) => { let prevented = false; fire(listeners.doc, 'contextmenu', { target: on, clientX: x, clientY: y, preventDefault: () => { prevented = true; }, ...more }); return prevented; };
{
  let draft = 'First line'; const span = { start: 10, end: 10, draftRev: 3 }; const inserts = []; let accept = true; const notes = []; let focused = 0;
  const inputActions = { captureInsertion: () => span, insertText: (text, s) => { inserts.push([text, s]); return accept; } };
  const props = { sessionId: 'S', menu: true, useInput: (f) => f({ draft }), inputActions, focusComposer: () => { focused += 1; }, notify: (level, text) => notes.push([level, text]), t };
  // The Menu is portaled under <body> (dsh 0.2.2-rc.2 places it at anchorPoint with position: fixed).
  const m = mount(QuoteReply, props);
  const v = { render: (more) => { const r = m.render(more); assert.equal(r?.host, document.body, 'the menu is under <body>');
    assert.equal(r.portal.p.style.position, 'fixed', 'in a fixed box: out of the page flow'); return r.portal.c[0]; }, unmount: m.unmount };
  let out = v.render();
  assert.equal(out.t, 'Menu', "dsh's Menu"); assert.equal(out.p.open, false, 'closed until a right-click'); assert.equal(out.p.anchorPoint, undefined);
  assert.equal(listeners.doc.get('selectionchange')?.size ?? 0, 0, 'no floating button: no selectionchange listener');
  assert.equal(listeners.doc.get('contextmenu').size, 1);
  // The labels: Copy next to Quote, from the language pack (t gives the key here; the packs give the words, below).
  assert.deepEqual(out.p.items.map((i) => [i.id, i.label]), [['copy', 'computers.edit.copy'], ['quote', 'quote.button']]);
  // The selection rule: a right-click on the selected text of one message of this chat opens the menu at the pointer.
  selection = sel(text(answer1), text(answer1), 'Use pnpm, not npm.');
  assert.equal(rightClick(answer1), true, 'a selection in an answer: our menu, not the browser menu');
  out = v.render(); assert.equal(out.p.open, true); assert.deepEqual(out.p.getAnchorRect(), { left: 410, right: 410, top: 220, bottom: 220 });
  assert.deepEqual(out.p.anchorPoint, { x: 410, y: 220 }, 'dsh 0.2.2-rc.2 and later: the pointer as anchorPoint (its Menu has no getAnchorRect)');
  // Quote: the quote at the caret through insertText (older dsh: no insertQuote), the selection goes, the composer gets the focus.
  out.p.onSelect('quote');
  assert.deepEqual(inserts, [['\n\n> Use pnpm, not npm.\n\n\n', span]]);
  assert.equal(removed, 1); assert.equal(focused, 1); assert.equal(v.render().p.open, false, 'the menu closes');
  // A refused insert: the notice.
  accept = false; selection = sel(text(answer1), text(answer1), 'Again'); rightClick(answer1); v.render().p.onSelect('quote');
  assert.deepEqual(notes, [['info', 'quote.changed']]); assert.equal(focused, 1, 'no focus move after a refused insert');
  accept = true;
  // dsh 0.2.2 and later: dsh's own quote (insertQuote), the text trimmed and cut to QUOTE_MAX.
  const quotes = []; inputActions.insertQuote = (q) => { quotes.push(q); return true; };
  selection = sel(text(user), text(user), '  my words \n'); assert.equal(rightClick(user), true, 'your own message (data-text-interaction-source) counts');
  v.render().p.onSelect('quote'); assert.deepEqual(quotes, ['my words']); assert.equal(inserts.length, 2, 'no > text (the refused one above is the second)');
  selection = sel(text(answer1), text(answer1), 'a'.repeat(QUOTE_MAX + 9)); rightClick(answer1); v.render().p.onSelect('quote');
  assert.equal([...quotes.at(-1)].length, QUOTE_MAX); assert.ok(quotes.at(-1).endsWith('…'));
  delete inputActions.insertQuote;
  // Copy: the same text again selected, the browser's copy command; no copy command → dsh's writeClipboard with the text.
  const commands = []; let copyWorks = true; document.execCommand = (c) => { commands.push(c); return copyWorks; };
  const clip = []; primitives.writeClipboard = (x) => { clip.push(x); };
  selection = sel(text(answer1), text(answer1), 'Copy me'); rightClick(answer1);
  v.render().p.onSelect('copy');
  assert.deepEqual(commands, ['copy']); assert.deepEqual(added.length, 1, 'the range again selected before copy'); assert.deepEqual(clip, []);
  assert.equal(v.render().p.open, false); assert.equal(inserts.length, 2, 'Copy quotes nothing');
  copyWorks = false; selection = sel(text(answer1), text(answer1), 'Copy me'); rightClick(answer1); v.render().p.onSelect('copy');
  assert.deepEqual(clip, ['Copy me'], 'writeClipboard when the copy command fails');
  // The browser menu stays: no selection, a selection elsewhere, a click outside the selected message, a link, a part
  // that drew its own menu, another chat, a selection over two messages.
  selection = null; assert.equal(rightClick(answer1), false, 'no selection');
  // Only a left-out part selected (a code block's language label): nothing to quote, the browser's menu.
  { const label = { getAttribute: () => null, setAttribute: (_k, v) => { label.hidden = v.includes('display:none'); }, removeAttribute: () => { label.hidden = false; }, hidden: false };
    answer1.querySelectorAll = () => [label];
    selection = sel(text(answer1), text(answer1), 'js', { toString: () => (label.hidden ? '' : 'js') });
    assert.equal(rightClick(answer1), false, 'only the code label: no menu of ours'); assert.equal(label.hidden, false, 'the label shows again');
    delete answer1.querySelectorAll; }
  selection = sel(text(answer1), text(answer1), 'x'); assert.equal(rightClick(answer2), false, 'a click outside the selected message');
  assert.equal(rightClick(answer1, 700, 220), false, 'a click in the same message, beside the selected text');
  assert.equal(rightClick(answer1, 450, 245), true, 'a click on the second line of the selected text'); v.render().p.onClose();
  // A fast right-click where a drag ended: past the last selected letter, outside its boxes (also below the message). Its
  // text position is in the selection, so the browser keeps the selection and shows its own Copy: our menu shows instead.
  document.caretPositionFromPoint = (x) => ({ offsetNode: x === 660 ? 'in' : 'out', offset: 0 });
  assert.equal(rightClick(answer1, 660, 220), true, 'where a drag ended, past the last selected letter'); v.render().p.onClose();
  assert.equal(rightClick(body, 660, 262), true, 'where a drag ended, below the message'); v.render().p.onClose();
  assert.equal(rightClick(answer1, 700, 220), false, 'beside the selected text, its text position outside the selection');
  document.caretPositionFromPoint = () => ({ offsetNode: 'in', offset: 0 });
  assert.equal(rightClick(body, 0, 0), false, 'the menu key outside the selected message: the browser menu, as before');
  // A text field's caret offset is not a child index: isPointInRange throws (IndexSizeError). The browser menu stays.
  const range = selection.getRangeAt(0);
  selection = sel(text(answer1), text(answer1), 'x', { getRangeAt: () => ({ ...range, isPointInRange: () => { throw Error('IndexSizeError'); } }) });
  assert.equal(rightClick(body, 660, 262), false, 'isPointInRange throws: no menu of ours, no error');
  delete document.caretPositionFromPoint;
  assert.equal(rightClick({ ...answer1, closest: (s) => (s === 'a[href], button' ? {} : null) }), false, 'a link or a button');
  assert.equal(rightClick(answer1, 1, 1, { defaultPrevented: true }), false, 'a part with its own menu');
  selection = sel(text(answer1), text(answer2), 'x'); assert.equal(rightClick(answer1), false, 'two messages');
  selection = sel(text(other), text(other), 'x'); assert.equal(rightClick(other), false, 'another chat');
  selection = sel(text(tool), text(tool), 'x'); assert.equal(rightClick(tool), false, 'a tool row');
  assert.equal(v.render().p.open, false);
  // The menu key (no pointer): the menu at the start of the selection.
  selection = sel(text(answer1), text(answer1), 'x'); rightClick(answer1, 0, 0);
  assert.deepEqual(v.render().p.getAnchorRect(), { left: 500, right: 500, top: 320, bottom: 320 });
  assert.deepEqual(v.render().p.anchorPoint, { x: 500, y: 320 });
  v.render().p.onClose(); assert.equal(v.render().p.open, false, 'Esc or a click outside closes it');
  // No dsh input face or no dsh Menu: nothing, the browser menu stays.
  assert.equal(mount(QuoteReply, { ...props, inputActions: undefined }).render(), null);
  v.unmount();
  assert.equal(listeners.doc.get('contextmenu').size, 1, 'the listener goes with the row (one left: the no-input row)');
}
// The labels in each language: Copy and Quote from the same packs as the rest of the app (13 languages).
{
  const want = { tr: ['Kopyala', 'Alıntıla'], en: ['Copy', 'Quote'], zh: ['复制', '引用'] };
  for (const id of ['de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'tr', 'vi']) {
    const pack = JSON.parse(readFileSync(new URL(`../locales/${id}.json`, import.meta.url), 'utf8'))['dsh-composer-plus'];
    for (const key of ['computers.edit.copy', 'quote.button']) assert.ok(typeof pack[key] === 'string' && pack[key].trim() !== '', `${id}: ${key}`);
    if (want[id]) assert.deepEqual([pack['computers.edit.copy'], pack['quote.button']], want[id]);
  }
  for (const [lang, words] of [['en', want.en], ['zh', want.zh]]) {
    const dict = new Function(`return ${src.match(new RegExp(`\\n          ${lang}: (\\{[\\s\\S]*?\\n          \\})`))[1]}`)();
    assert.deepEqual([dict['computers.edit.copy'], dict['quote.button']], words, lang);
  }
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
  // dsh's floating "Quote text" button (dsh 0.2.2+: key `quote` of conversation.chat.text-interaction) is shadowed by nothing.
  const hide = () => [...regs].find(([o]) => o.name === 'conversation.chat.text-interaction');
  plugin.apply(ctx);
  assert.ok(row(), 'on by default'); assert.equal(row()[0].name, 'conversation.input.right'); assert.equal(row()[1], QuoteReply);
  const injected = row()[0].inject('S');
  assert.equal(injected.sessionId, 'S'); assert.equal(injected.menu, true); assert.equal(typeof injected.focusComposer, 'function'); injected.focusComposer(); injected.notify('info', 'x');
  assert.deepEqual(hide()?.[0], { name: 'conversation.chat.text-interaction', key: 'quote', priority: -1 }, "dsh's button: the same key, a lower priority");
  assert.equal(hide()[1](), null, 'it draws nothing');
  const toggles = JSON.parse(mem.get('dsh-composer-plus.features') ?? '{}');
  mem.set('dsh-composer-plus.features', JSON.stringify({ ...toggles, quoteReply: false }));
  regs.clear(); plugin.apply(ctx);
  assert.equal(row(), undefined, 'off: no slot'); assert.equal(hide(), undefined, "off: dsh's own button shows again");
}
console.log('quote-reply: ok');
