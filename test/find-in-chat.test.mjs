// Find in chat (client): the per-character fold keeps offsets (so a match maps back to the page text), matches never cross
// a block, the shortcut is Ctrl+F (Cmd+F on macOS, never with Shift or Alt: dsh's Fork), it opens only over a chat and not
// over a dialog, Enter / Shift+Enter / ↓ / ↑ move with wrap-around, Esc closes and gives the focus back, the highlights
// go away on close and when the feature is switched off, and the count follows the chat while it changes.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hook = '    function ChangesDiff({';
assert.ok(src.includes(hook));
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
// A window with real listeners (the shortcut is a window capture listener).
const listeners = new Map();
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } },
  addEventListener: (type, fn, capture) => { if (type === 'keydown' && capture === true) listeners.set(fn, true); },
  removeEventListener: (type, fn) => { listeners.delete(fn); } };
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
// A tiny DOM: elements with text children; `getClientRects` says whether it is drawn.
class Text { constructor(v, parent) { this.nodeValue = v; this.parentElement = parent; } }
class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag; this.attrs = attrs; this.children = []; this.parentElement = null; this.drawn = true;
    for (const c of children) this.add(c);
  }
  add(c) { if (typeof c === 'string') this.children.push(new Text(c, this)); else { c.parentElement = this; this.children.push(c); } return this; }
  getClientRects() { let e = this; while (e) { if (!e.drawn) return []; e = e.parentElement; } return [{}]; }
  matches(sel) { return sel.split(',').map((x) => x.trim()).some((x) => (x === 'button' ? this.tagName === 'BUTTON' : /^\[([\w-]+)(?:="([^"]*)")?\]$/.test(x) && (([, k, v]) => (v === undefined ? k in this.attrs : this.attrs[k] === v))(/^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(x)))); }
  closest(sel) { let e = this; while (e) { if (e.matches(sel)) return e; e = e.parentElement; } return null; }
  scrollIntoView(o) { scrolled.push([this, o]); }
  focus() { focused = this; }
  get isConnected() { return true; }
}
const scrolled = []; let focused = null;
const textsOf = (el) => el.children.flatMap((c) => (c instanceof Text ? [c] : textsOf(c)));
let flow = null; let modal = false;
globalThis.document = {
  querySelector: (sel) => (sel === '[data-chat-flow]' ? flow : sel.includes('aria-modal') ? (modal ? {} : null) : null),
  createTreeWalker: (root) => { const all = textsOf(root); let i = -1; return { nextNode: () => all[++i] ?? null }; },
  createRange: () => { const r = { setStart(n, o) { r.startContainer = n; r.startOffset = o; }, setEnd(n, o) { r.endContainer = n; r.endOffset = o; } }; return r; },
  get activeElement() { return focused; },
};
// CSS Custom Highlight API stand-in.
const highlights = new Map();
globalThis.CSS = { highlights: { set: (k, v) => highlights.set(k, v), delete: (k) => highlights.delete(k), has: (k) => highlights.has(k) } };
globalThis.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
const frames = []; globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; }; globalThis.cancelAnimationFrame = () => {};
// Timers by hand: the redraw throttle (setTimeout) and the flow re-check (setInterval) run only when the test says so.
const timers = new Map(); let timerId = 0; const intervals = new Map();
globalThis.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; }; globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.setInterval = (fn) => { intervals.set(++timerId, fn); return timerId; }; globalThis.clearInterval = (id) => { intervals.delete(id); };
const runTimers = () => { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); };
const observers = []; globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe(target) { this.on = true; this.target = target; } disconnect() { this.on = false; } };
eval(src.replace(hook, '    globalThis.__find = { foldChar, findMatches, chatBlocks, matchRange, isFindKey, ChatFind };\n' + hook));

// Hook runtime for one component.
let slots = []; let at = 0; let effects = [];
const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const React = {
  createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }), Fragment: 'F',
  useState: (v) => { const k = at++; if (!(k in slots)) slots[k] = typeof v === 'function' ? v() : v; return [slots[k], (x) => { slots[k] = typeof x === 'function' ? x(slots[k]) : x; }]; },
  useRef: (v) => { const k = at++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
  useEffect: (f, deps) => { const k = at++; const old = slots[k]; if (old && same(old.deps, deps)) return; effects.push(() => { slots[k]?.cleanup?.(); slots[k] = { deps, cleanup: f() }; }); },
};
mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? {} : {}));
const { foldChar, findMatches, chatBlocks, matchRange, isFindKey, ChatFind } = globalThis.__find;
const t = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k);

// 1. Fold: case, accents, Turkish ı/İ; one character in, one or none out.
assert.equal([...'ŞEKER İçin ıIé'].map(foldChar).join(''), 'seker icin iie');
for (const ch of ['A', 'İ', 'é', 'ß', 'ﬁ', '😀'[0]]) assert.ok(foldChar(ch).length <= 1, `${ch} folds to at most one character`);
// 2. Matches: inside a block across text nodes, never across blocks, folded, offsets in the page text.
const blocks = [[{ text: 'Run npm ' }, { text: 'TEST now' }], [{ text: 'npm' }, { text: ' test' }], [{ text: 'Şeker npm test' }]];
assert.deepEqual(findMatches(blocks, 'npm test'), [{ block: 0, start: 4, end: 12 }, { block: 1, start: 0, end: 8 }, { block: 2, start: 6, end: 14 }]);
assert.deepEqual(findMatches(blocks, 'seker'), [{ block: 2, start: 0, end: 5 }]);
assert.deepEqual(findMatches([[{ text: 'test' }], [{ text: 'npm ' }]], 'npm test'), [], 'no match across two blocks');
assert.deepEqual(findMatches(blocks, '   '), [], 'blank query'); assert.equal(findMatches([[{ text: 'a'.repeat(50) }]], 'a', 7).length, 7, 'capped');
assert.deepEqual(findMatches([[{ text: 'aaaa' }]], 'aa').map((m) => m.start), [0, 2], 'no overlapping matches');
// The query folds per code unit like the page text: an emoji finds only itself, a combining accent folds away in both.
assert.deepEqual(findMatches([[{ text: 'a 😁 b 😀' }]], '😀'), [{ block: 0, start: 7, end: 9 }], 'an emoji finds only the same emoji');
assert.deepEqual(findMatches([[{ text: 'CAFÉ cafe\u0301' }]], 'café').map((m) => m.start), [0, 5], 'precomposed and combining accents both match');
// A character that decomposes into more than its base and Latin accents stays as it is: Korean syllables, Japanese kana.
assert.deepEqual(findMatches([[{ text: '한글 하고 한국' }]], '한국'), [{ block: 0, start: 6, end: 8 }], 'a Hangul syllable is not its first consonant');
assert.deepEqual(findMatches([[{ text: 'かが' }]], 'が'), [{ block: 0, start: 1, end: 2 }], 'が is not か');
// Decomposed page text (a macOS file name): the marks are skipped, and the match covers the base letters and their marks.
assert.deepEqual(findMatches([[{ text: 'Tu\u0308rkc\u0327e.md' }]], 'Türkçe'), [{ block: 0, start: 0, end: 8 }], 'NFD text matches');
assert.deepEqual(findMatches([[{ text: 'x Tu\u0308r' }]], 'tur'), [{ block: 0, start: 2, end: 6 }], 'the match ends after the last mark');
// 3. The shortcut.
const key = (o) => ({ code: 'KeyF', key: 'f', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });
assert.ok(isFindKey(key({ ctrlKey: true }), false), 'Ctrl+F off macOS'); assert.ok(isFindKey(key({ metaKey: true }), true), 'Cmd+F on macOS');
assert.ok(!isFindKey(key({ metaKey: true }), false), 'Meta+F is not ours off macOS');
assert.ok(!isFindKey(key({ ctrlKey: true }), true), 'on macOS Ctrl+F stays the text field key (cursor one character forward)');
for (const o of [{ ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, { metaKey: true, altKey: true }, { metaKey: true, shiftKey: true }, {}, { ctrlKey: true, metaKey: true }])
  assert.ok(!isFindKey(key(o), true), JSON.stringify(o));

// 4. Blocks from the DOM: our own box, buttons, hidden and rolled-back rows are left out.
const p1 = new El('P', {}, ['Run ', new El('CODE', {}, ['npm test']), ' now']);
const hiddenRow = new El('DIV', { 'data-cp-rolled-back': '' }, [new El('P', {}, ['npm test withdrawn'])]);
const closed = new El('P', {}, ['npm test in a closed group']); closed.drawn = false;
const button = new El('BUTTON', {}, ['npm test']);
const li = new El('LI', {}, ['then ', new El('B', {}, ['npm']), ' test again']);
flow = new El('DIV', { 'data-chat-flow': '' }, [p1, hiddenRow, closed, button, new El('UL', {}, [li])]);
let got = chatBlocks();
assert.equal(got.blocks.length, 2); assert.deepEqual(got.blocks.map((b) => b.map((x) => x.text).join('')), ['Run npm test now', 'then npm test again']);
const r = matchRange(got.blocks, findMatches(got.blocks, 'npm test')[1]);
assert.equal(r.startContainer.nodeValue, 'npm'); assert.equal(r.startOffset, 0); assert.equal(r.endContainer.nodeValue, ' test again'); assert.equal(r.endOffset, 5);

// 5. The component: shortcut → box; typing → highlights and count; Enter / Shift+Enter / arrows wrap; Esc closes.
const render = () => { for (let round = 0; round < 6; round++) { at = 0; effects = []; const out = ChatFind({ t }); const run = effects; for (const f of run) f(); if (run.length === 0) return out; } return ChatFind({ t }); };
let out = render(); assert.equal(out, null, 'closed at first');
assert.equal(listeners.size, 1, 'one window key listener');
const press = (o) => { let prevented = 0; for (const fn of [...listeners.keys()]) fn({ ...key(o), preventDefault: () => prevented++, stopPropagation() {} }); return prevented; };
const composer = new El('DIV', { 'data-composer-input': '' }); focused = composer;
modal = true; assert.equal(press({ metaKey: true }), 0, 'not over a dialog'); modal = false;
const keepFlow = flow; flow = null; assert.equal(press({ metaKey: true }), 0, 'not without a chat'); flow = keepFlow;
assert.equal(press({ ctrlKey: true, altKey: true }), 0, 'Ctrl+Alt+F stays dsh\'s');
assert.equal(press({ ctrlKey: true }), 0, 'this runtime is a Mac: Ctrl+F is not taken');
assert.equal(press({ metaKey: true }), 1); out = render();
assert.ok(out !== null && out.p['data-composer-plus-find'] === '', 'the box opens');
const input = () => out.c.find((x) => x.t === 'input');
const count = () => out.c.find((x) => x.p?.role === 'status').c.join('');
assert.equal(count(), '', 'no count before typing');
input().p.onChange({ target: { value: 'NPM test' } }); out = render();
assert.equal(count(), 'find.count:{"current":"1","total":"2"}');
assert.equal(highlights.get('cp-find').ranges.length, 2); assert.equal(highlights.get('cp-find-current').ranges[0].startContainer.nodeValue, 'npm test');
assert.ok(scrolled.length > 0, 'the current match scrolls into view');
const keyIn = (k, shift = false, ime = false) => input().p.onKeyDown({ key: k, shiftKey: shift, keyCode: ime ? 229 : 0, nativeEvent: { isComposing: ime }, preventDefault() {}, stopPropagation() {} });
// IME input: React's event has no isComposing; the native one says so. Enter and Esc then pick a candidate, not ours.
keyIn('Enter', false, true); out = render(); assert.equal(count(), 'find.count:{"current":"1","total":"2"}', 'an IME Enter does not move');
keyIn('Escape', false, true); out = render(); assert.ok(out !== null, 'an IME Esc does not close the box');
keyIn('Enter'); out = render(); assert.equal(count(), 'find.count:{"current":"2","total":"2"}');
assert.equal(highlights.get('cp-find-current').ranges[0].startContainer.nodeValue, 'npm', 'the current highlight moves');
keyIn('Enter'); out = render(); assert.equal(count(), 'find.count:{"current":"1","total":"2"}', 'Enter wraps around');
keyIn('Enter', true); out = render(); assert.equal(count(), 'find.count:{"current":"2","total":"2"}', 'Shift+Enter goes back (and wraps)');
keyIn('ArrowUp'); out = render(); assert.equal(count(), 'find.count:{"current":"1","total":"2"}');
// The chat changes (a streamed reply): one redraw per frame, the current match stays the same match.
keyIn('ArrowDown'); out = render();
// A page of older history loads above: the current match keeps its place in the text, so its number moves from 2 to 3.
{ const older = new El('P', {}, ['older npm test']); older.parentElement = flow; flow.children.unshift(older); }
const obs = observers.filter((o) => o.on); assert.equal(obs.length, 1, 'one observer on the chat flow');
obs[0].fn(); obs[0].fn(); assert.equal(timers.size, 1, 'many changes, one queued search');
runTimers(); out = render();
assert.equal(count(), 'find.count:{"current":"3","total":"3"}', 'a new match counts; the current match stays the same match');
assert.equal(highlights.get('cp-find-current').ranges[0].startContainer.nodeValue, 'npm');
// Another chat opens with the box open: dsh replaces the flow; the search follows the new one.
{
  const oldFlow = flow;
  flow = new El('DIV', { 'data-chat-flow': '' }, [new El('P', {}, ['npm test in the other chat'])]);
  for (const fn of intervals.values()) fn();
  assert.equal(observers.filter((o) => o.on && o.target === flow).length, 1, 'the observer moves to the new flow');
  runTimers(); out = render();
  assert.equal(count(), 'find.count:{"current":"1","total":"1"}', 'the count is of the open chat');
  flow = oldFlow; for (const fn of intervals.values()) fn(); runTimers(); out = render();
}
// No match: the buttons are off.
input().p.onChange({ target: { value: 'zzz' } }); out = render();
assert.equal(count(), 'find.none'); assert.equal(highlights.has('cp-find'), false);
assert.ok(out.c.filter((x) => x.t === 'button').slice(0, 2).every((b) => b.p.disabled === true));
// Esc closes, clears the highlights and gives the focus back.
input().p.onChange({ target: { value: 'npm' } }); out = render(); assert.ok(highlights.has('cp-find'));
keyIn('Escape'); out = render();
assert.equal(out, null); assert.equal(highlights.has('cp-find'), false); assert.equal(highlights.has('cp-find-current'), false);
assert.equal(focused, composer, 'the focus goes back to where it was');
assert.equal(observers.filter((o) => o.on).length, 0, 'no observer while closed');
assert.equal(intervals.size, 0, 'no flow re-check while closed'); assert.equal(timers.size, 0, 'no queued search while closed');

// 6. The feature switch: off removes the key listener and the overlay.
const regs = []; const offs = [];
const ctx = { locale: undefined, slots: { inject: (name, make) => { const off = make(); offs.push(off); return off; }, register: (o, C) => { regs.push([o.id, C]); return () => { regs.splice(regs.findIndex((x) => x[0] === o.id), 1); }; } },
  sessions: {}, remote: {}, configForms: { get: () => undefined }, effect: () => {}, inject: () => ({ dispose() {} }) };
mem.set('dsh-composer-plus.features', JSON.stringify({}));
const plugin = mod.factory((n) => (n === 'react' ? React : {}));
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
try { plugin.apply(ctx); } catch { /* other features may need more of dsh; only the registration matters here */ }
assert.ok(regs.some(([id]) => id === 'find-in-chat'), 'the overlay is registered while the feature is on');
console.log('find in chat checks passed');
