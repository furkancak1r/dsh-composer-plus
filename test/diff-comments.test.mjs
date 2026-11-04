// Diff notes (client): the real client.js with fake React and fake dsh services.
// - numberedRows: old/new line numbers from the hunk headers (`+` and context step the new side, `-` and context the old
//   side; `\ No newline` steps none); noteRange: the new side when a row is on it, else the old side; at most NOTE_LINES
//   lines (then …); a hunk header alone gives nothing.
// - notesText: `path:12-14` (one number for one line, "(removed)" for old lines), a diff block (a longer fence when a line
//   has ```), the note.
// - createDiffNotes: per chat in localStorage, empty notes refused, at most NOTES_MAX, a change reads the newest saved
//   tray first (another window's note is kept), remove, clear only the given ids.
// - NotedDiff: + on each line (not on @@), a click opens the field, Shift+click on a row of the same hunk makes a range
//   (another hunk starts again), Enter saves, Esc and Cancel close, IME is ignored, saved notes show under their last row.
// - NotesBar: hidden without notes; Send puts exactly the notes of the click at the caret (an empty line before them
//   after text) through insertText and removes only those; a refused insert keeps them and shows the notice.
// - ChangesTab gives notes only while the switch is on; the feature through plugin.apply.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const winListeners = new Map();
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, innerWidth: 1280 };
globalThis.addEventListener = (type, fn) => { if (!winListeners.has(type)) winListeners.set(type, new Set()); winListeners.get(type).add(fn); };
globalThis.removeEventListener = (type, fn) => { winListeners.get(type)?.delete(fn); };
globalThis.document = { body: {}, addEventListener() {}, removeEventListener() {}, querySelector: () => null, visibilityState: 'visible' };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__n = { numberedRows, noteRange, notesText, createDiffNotes, NotedDiff, NotesBar, ChangesTab, NOTES_KEY, NOTES_MAX, NOTE_LINES };\n    ${ANCHOR}`));
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; if (!(i in cur.refs)) cur.refs[i] = { current: v }; return cur.refs[i]; },
  useMemo: (f) => f(), useCallback: (f) => f,
  useSyncExternalStore: (sub, get) => get(),
  useEffect: () => {} };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el) => el } : { Button: 'Button' }));
const { numberedRows, noteRange, notesText, createDiffNotes, NotedDiff, NotesBar, ChangesTab, NOTES_KEY, NOTES_MAX, NOTE_LINES } = globalThis.__n;

// --- numberedRows / noteRange ---
const rows = ['@@ -10,4 +10,5 @@ function cart()', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;', ' return a;', '\\ No newline at end of file', '@@ -40,2 +41,1 @@', '-old one', '-old two', ' kept'];
const nr = numberedRows(rows);
assert.deepEqual(nr.map((r) => [r.old, r.new]), [[undefined, undefined], [10, 10], [11, undefined], [undefined, 11], [undefined, 12], [12, 13], [undefined, undefined], [undefined, undefined], [40, undefined], [41, undefined], [42, 41]]);
assert.equal(nr[0].hunk, true); assert.equal(nr[7].hunk, true);
assert.deepEqual(noteRange(nr, 3, 4), { side: 'new', start: 11, end: 12, lines: ['+const b = 3;', '+const c = 4;'] });
assert.deepEqual(noteRange(nr, 4, 2), { side: 'new', start: 11, end: 12, lines: ['-const b = 2;', '+const b = 3;', '+const c = 4;'] }, 'reverse order; the removed line stays in the block');
assert.deepEqual(noteRange(nr, 8, 9), { side: 'old', start: 40, end: 41, lines: ['-old one', '-old two'] }, 'removed lines only: old side');
assert.deepEqual(noteRange(nr, 1, 1), { side: 'new', start: 10, end: 10, lines: [' const a = 1;'] });
assert.equal(noteRange(nr, 0, 0), undefined, 'a hunk header alone');
const many = numberedRows(['@@ -1,0 +1,60 @@', ...Array.from({ length: 60 }, (_, i) => `+l${i}`)]);
const big = noteRange(many, 1, 60);
assert.equal(big.lines.length, NOTE_LINES + 1); assert.equal(big.lines.at(-1), '…'); assert.equal(big.end, 60);
assert.equal(noteRange(many, 1, NOTE_LINES).lines.length, NOTE_LINES, 'NOTE_LINES itself is not cut');

// --- notesText ---
assert.equal(notesText([{ path: 'src/cart.js', side: 'new', start: 11, end: 12, lines: ['+a', '+b'], note: ' Use a constant. ' }, { path: 'x.md', side: 'old', start: 40, end: 40, lines: ['-```js'], note: 'Why?' }]),
  '`src/cart.js:11-12`\n```diff\n+a\n+b\n```\nUse a constant.\n\n`x.md:40 (removed)`\n````diff\n-```js\n````\nWhy?');

// --- createDiffNotes ---
mem.clear();
const store = createDiffNotes();
assert.deepEqual(store.of('S'), []);
assert.equal(store.add('S', { path: 'a', side: 'new', start: 1, end: 1, lines: ['+x'], note: '   ' }), false, 'an empty note');
assert.equal(store.add('S', { path: 'a', side: 'new', start: 1, end: 1, lines: ['+x'], note: ' first ' }), true);
assert.equal(store.of('S')[0].note, 'first'); assert.ok(store.of('S')[0].id);
assert.equal(JSON.parse(mem.get(NOTES_KEY)).S.length, 1, 'saved in localStorage');
// Another window added a note meanwhile: the next change keeps it.
const saved = JSON.parse(mem.get(NOTES_KEY)); saved.S.push({ id: 'other', path: 'b', side: 'new', start: 2, end: 2, lines: [], note: 'from the other window' }); mem.set(NOTES_KEY, JSON.stringify(saved));
store.add('S', { path: 'c', side: 'new', start: 3, end: 3, lines: [], note: 'third' });
assert.deepEqual(store.of('S').map((n) => n.note), ['first', 'from the other window', 'third']);
assert.deepEqual(store.of('T'), [], 'per chat');
store.remove('S', 'other'); assert.equal(store.of('S').length, 2);
const keep = store.of('S')[1].id; store.clear('S', [store.of('S')[0].id]); assert.deepEqual(store.of('S').map((n) => n.id), [keep], 'clear only the given ids');
store.clear('S'); assert.deepEqual(store.of('S'), []); assert.equal(JSON.parse(mem.get(NOTES_KEY)).S, undefined, 'an empty tray is not kept');
for (let i = 0; i < NOTES_MAX; i++) store.add('S', { path: 'a', side: 'new', start: i, end: i, lines: [], note: `n${i}` });
assert.equal(store.add('S', { path: 'a', side: 'new', start: 0, end: 0, lines: [], note: 'one more' }), false, 'full');
assert.equal(store.add('S', { path: 'a', side: 'new', start: 0, end: 0, lines: [], note: 'x'.repeat(5000) }), false);
store.clear('S');
store.add('S', { path: 'a', side: 'new', start: 0, end: 0, lines: [], note: 'y'.repeat(5000) });
assert.equal(store.of('S')[0].note.length, 2000, 'cut to NOTE_MAX'); store.clear('S');
mem.set(NOTES_KEY, 'not json'); assert.deepEqual(createDiffNotes().of('S'), [], 'broken storage: empty');
mem.clear();

// --- NotedDiff ---
const mount = (C, props) => {
  const inst = { state: [], refs: [] };
  const render = (more = {}) => { Object.assign(props, more); cur = inst; inst.si = 0; inst.ri = 0; return C(props); };
  return { render };
};
const find = (tree, pred) => { if (tree === null || typeof tree !== 'object') return undefined; if (pred(tree)) return tree; for (const c of tree.c ?? []) { const f = find(c, pred); if (f) return f; } return undefined; };
const all = (tree, pred, out = []) => { if (tree === null || typeof tree !== 'object') return out; if (pred(tree)) out.push(tree); for (const c of tree.c ?? []) all(c, pred, out); return out; };
const t = (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`);
{
  const notes = createDiffNotes();
  const v = mount(NotedDiff, { sessionId: 'S', path: 'src/cart.js', rows, notes, t });
  let out = v.render();
  const adds = all(out, (n) => n.p?.['data-composer-plus-note-add'] !== undefined);
  assert.equal(adds.length, rows.length - 2, 'a + on each row but the two @@ rows');
  const add = (i) => find(v.render(), (n) => n.p?.['data-composer-plus-note-add'] === String(i));
  add(3).p.onClick({ shiftKey: false });
  add(4).p.onClick({ shiftKey: true });
  const form = () => find(v.render(), (n) => n.p?.['data-composer-plus-note-form'] === '');
  assert.ok(form(), 'the field opens');
  assert.equal(all(v.render(), (n) => n.p?.['data-composer-plus-diff-row'] !== undefined && n.p.style.boxShadow !== undefined).length, 2, 'two rows marked');
  // The field sits under the last row of the range.
  const flat = v.render().c.slice(1);
  const at = flat.findIndex((n) => n.p?.['data-composer-plus-note-form'] === '');
  assert.equal(flat[at - 1].p['data-composer-plus-diff-row'], '4');
  const area = () => find(form(), (n) => n.t === 'textarea');
  area().p.onChange({ target: { value: 'Use a constant here.' } });
  let prevented = 0;
  area().p.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault: () => { prevented++; } });
  assert.equal(notes.of('S').length, 0, 'IME Enter does nothing');
  area().p.onKeyDown({ key: 'Enter', shiftKey: true, nativeEvent: {}, preventDefault: () => { prevented++; } });
  assert.equal(notes.of('S').length, 0, 'Shift+Enter is a new line');
  area().p.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: {}, preventDefault: () => { prevented++; } });
  assert.deepEqual(notes.of('S').map(({ id, ...n }) => n), [{ path: 'src/cart.js', side: 'new', start: 11, end: 12, lines: ['+const b = 3;', '+const c = 4;'], note: 'Use a constant here.' }]);
  assert.equal(form(), undefined, 'the field closes');
  // The saved note shows under its last row; ✕ removes it.
  out = v.render();
  const flat2 = out.c.slice(1); const k = flat2.findIndex((n) => n.p?.['data-composer-plus-note'] !== undefined);
  assert.equal(flat2[k - 1].p['data-composer-plus-diff-row'], '4');
  // Shift+click in another hunk starts again; Esc closes; Cancel closes.
  add(3).p.onClick({ shiftKey: false }); add(9).p.onClick({ shiftKey: true });
  assert.equal(all(v.render(), (n) => n.p?.['data-composer-plus-diff-row'] !== undefined && n.p.style.boxShadow !== undefined).length, 1, 'another hunk: a new single row');
  let stopped = 0; area().p.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() {}, stopPropagation: () => { stopped++; } });
  assert.equal(form(), undefined, 'Esc closes'); assert.equal(stopped, 1);
  add(8).p.onClick({ shiftKey: false }); add(9).p.onClick({ shiftKey: true });
  area().p.onChange({ target: { value: 'Why remove these?' } });
  find(form(), (n) => n.p?.['data-composer-plus-note-save'] === '').p.onClick();
  assert.deepEqual(notes.of('S').at(-1).side, 'old'); assert.equal(notes.of('S').at(-1).start, 40);
  const flat3 = v.render().c.slice(1); const k3 = flat3.findIndex((n) => n.p?.['data-composer-plus-note'] === notes.of('S').at(-1).id);
  assert.equal(flat3[k3 - 1].p['data-composer-plus-diff-row'], '9', 'an old-side note shows under its last removed row');
  find(v.render(), (n) => n.p?.['data-composer-plus-note'] === notes.of('S')[0].id).c.at(-1).p.onClick();
  assert.equal(notes.of('S').length, 1, '✕ removes it');
  add(1).p.onClick({ shiftKey: false });
  find(form(), (n) => n.t === 'button' && n.c.includes('notes.cancel')).p.onClick();
  assert.equal(form(), undefined, 'Cancel closes');
  // The picked lines are kept at the click: a reloaded diff with other rows does not move a saved note.
  add(5).p.onClick({ shiftKey: false });
  v.render({ rows: ['@@ -1,1 +1,1 @@', '+other'] });
  area().p.onChange({ target: { value: 'kept place' } });
  find(form(), (n) => n.p?.['data-composer-plus-note-save'] === '').p.onClick();
  assert.deepEqual([notes.of('S').at(-1).start, notes.of('S').at(-1).lines], [13, [' return a;']]);
}

// --- NotesBar ---
{
  mem.clear();
  const notes = createDiffNotes();
  let draft = 'Please fix:'; let span = { start: 11, end: 11, draftRev: 2 }; const inserts = []; let accept = true; const notes2 = [];
  const inputActions = { captureInsertion: () => span, insertText: (text, s) => { inserts.push([text, s]); return accept; } };
  const v = mount(NotesBar, { sessionId: 'S', notes, inputActions, useInput: (f) => f({ draft }), notify: (l, x) => notes2.push([l, x]), t });
  assert.equal(v.render(), null, 'no notes: nothing');
  notes.add('S', { path: 'a.js', side: 'new', start: 3, end: 3, lines: ['+x'], note: 'one' });
  notes.add('T', { path: 'b.js', side: 'new', start: 1, end: 1, lines: ['+y'], note: 'other chat' });
  let out = v.render();
  assert.equal(out.p['data-composer-plus-notes-bar'], '1');
  const send = () => find(v.render(), (n) => n.p?.['data-composer-plus-notes-send'] === '').p.onClick();
  accept = false; send();
  assert.deepEqual(notes2, [['info', 'notes.changed']]); assert.equal(notes.of('S').length, 1, 'a refused insert keeps the notes');
  accept = true; send();
  assert.deepEqual(inserts.at(-1), ['\n\n`a.js:3`\n```diff\n+x\n```\none\n\n', span], 'after the text, with an empty line');
  assert.equal(notes.of('S').length, 0); assert.equal(notes.of('T').length, 1, 'another chat keeps its notes');
  assert.equal(v.render(), null);
  // An empty composer: no empty line first.
  draft = ''; span = { start: 0, end: 0, draftRev: 3 };
  notes.add('S', { path: 'a.js', side: 'new', start: 3, end: 3, lines: ['+x'], note: 'two' });
  send(); assert.ok(inserts.at(-1)[0].startsWith('`a.js:3`'));
  // Clear.
  notes.add('S', { path: 'a.js', side: 'new', start: 3, end: 3, lines: ['+x'], note: 'three' });
  find(v.render(), (n) => n.p?.['data-composer-plus-notes-clear'] === '').p.onClick(); assert.equal(notes.of('S').length, 0);
  // No input face: Send is off.
  notes.add('S', { path: 'a.js', side: 'new', start: 3, end: 3, lines: ['+x'], note: 'four' });
  assert.equal(find(mount(NotesBar, { sessionId: 'S', notes, useInput: (f) => f({ draft }), t }).render(), (n) => n.p?.['data-composer-plus-notes-send'] === '').p.disabled, true);
}

// --- The switch: ChangesTab shows the bar only while diffComments is on; plugin.apply ---
{
  mem.clear();
  globalThis.fetch = () => new Promise(() => {});
  const notes = createDiffNotes();
  notes.add('S', { path: 'a.js', side: 'new', start: 3, end: 3, lines: ['+x'], note: 'one' });
  let on = true;
  const props = { sessionId: 'S', t, openLastTurn() {}, titleOf: () => '', useComposerPlusToggles: (f) => f({ diffComments: on }), diffNotes: notes, inputActions: { captureInsertion: () => ({}), insertText: () => true }, useInput: (f) => f({ draft: '' }), notifyChat() {} };
  const tab = mount(ChangesTab, props);
  const bar = () => find(tab.render(), (n) => n.t === NotesBar);
  assert.ok(bar(), 'on: the tray bar');
  on = false; assert.equal(bar(), undefined, 'off: no bar');
  const regs = new Set();
  const ctx = {
    effect: (f) => { f(); }, locale: { register: () => () => {}, bind: () => (k) => k }, inject: (deps, f) => { if (deps.join() === 'sidebarRight,sidebarRightTabs') f({ effect: (g) => g(), sidebarRightTabs: { register: () => () => {} }, sidebarRight: { openResource() {} } }); return { dispose() {} }; }, configForms: { get: () => ({}) },
    sessions: { scope: () => ({ get: () => ({ input: { for: () => ({ focus() {}, notify() {} }) } }) }), sessionOf: () => undefined, list: { getSnapshot: () => ({ byId: {} }) } },
    slots: { inject: (name, f) => f(), register: (o, C) => { const r = [o, C]; regs.add(r); return () => { regs.delete(r); }; } },
    get: () => undefined,
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ on: true }) });
  plugin.apply(ctx);
  const changes = [...regs].find(([o]) => o.key === 'dsh-composer-plus/changes');
  assert.ok(changes, 'the Changes tab body');
  const injected = changes[0].inject('S');
  assert.equal(typeof injected.diffNotes?.add, 'function'); assert.ok(injected.hooks?.composerPlusToggles); assert.equal(typeof injected.notifyChat, 'function');
  assert.equal(winListeners.get('storage')?.size, 1, 'on by default: one storage listener');
  const toggles = JSON.parse(mem.get('dsh-composer-plus.features') ?? '{}');
  mem.set('dsh-composer-plus.features', JSON.stringify({ ...toggles, diffComments: false }));
  regs.clear(); plugin.apply(ctx);
  assert.equal(winListeners.get('storage')?.size, 1, 'off: no second listener');
}
console.log('diff-comments: ok');
