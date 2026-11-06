// Quote from file preview (client): the real client.js with fake React, a fake DOM selection and fake dsh services.
// - filePathOf: dsh's `dsh-resource://file/session/<id>/<path>` (only this chat) and `…/absolute/<path>` addresses, encoded
//   segments, a bad encoding, another scheme.
// - relativePath: inside the chat's folder → relative (with `/` and `\`), a sibling folder with the same prefix and a path
//   outside stay absolute, `./` goes.
// - previewText: `path:from-to` + a code block (one line: `path:N`), a start at a line end and a triple-click end are not one
//   more line, backticks in the text (a longer fence) and in the path (a longer code span), at most QUOTE_MAX characters
//   (the reference keeps the whole range), Markdown and PDF as `> ` lines (with `#page=N` / `#page=N-M`), blank → '',
//   the empty lines around it as Quote in reply.
// - previewTarget: only a selection inside one text, code, Markdown or PDF body of one preview of this chat's right sidebar
//   (not the header, another viewer, two previews, another chat, a full-screen panel, a blank selection).
// - previewSpan: the start line from the page's first line and the line breaks before the range; code from line 1; PDF pages.
// - The feature through plugin.apply: on by default, its own `conversation.input.right` row (QuoteReply with the preview's
//   pick, text and mark) that uses the chat's folder; switched off, the row goes and Quote in reply stays.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
const listeners = { doc: new Map(), win: new Map() };
const on = (m) => (type, fn) => { if (!m.has(type)) m.set(type, new Set()); m.get(type).add(fn); };
const off = (m) => (type, fn) => { m.get(type)?.delete(fn); };
let selection = null;
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, innerWidth: 1280,
  getSelection: () => (selection === null ? null : { ...selection, removeAllRanges: () => { selection = null; } }),
  addEventListener: on(listeners.win), removeEventListener: off(listeners.win) };
// The range that previewSpan builds from the block's start to the range's start: its text is what the test gives.
let before = '';
globalThis.document = { body: { id: 'body' }, addEventListener: on(listeners.doc), removeEventListener: off(listeners.doc), querySelector: () => null,
  createRange: () => ({ setStart() {}, setEnd() {}, toString: () => before }) };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__p = { filePathOf, relativePath, previewText, previewTarget, previewSpan, previewFormat, QuoteReply, QUOTE_MAX };\n    ${ANCHOR}`));
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
const { filePathOf, relativePath, previewText, previewTarget, previewSpan, previewFormat, QuoteReply, QUOTE_MAX } = globalThis.__p;

// --- filePathOf ---
assert.equal(filePathOf('dsh-resource://file/session/S/src/login.js', 'S'), 'src/login.js', 'a session path is relative');
assert.equal(filePathOf('dsh-resource://file/session/S/docs/my%20notes.md?x=1#y', 'S'), 'docs/my notes.md', 'decoded; query and fragment go');
assert.equal(filePathOf('dsh-resource://file/session/T/src/login.js', 'S'), null, 'another chat');
assert.equal(filePathOf('dsh-resource://file/absolute/tmp/x.txt', 'S'), '/tmp/x.txt', 'absolute');
assert.equal(filePathOf('dsh-resource://file/absolute/C%3A/work/x.txt', 'S'), 'C:/work/x.txt', 'a Windows drive');
assert.equal(filePathOf('dsh-resource://file/session/S/%E0%A4', 'S'), null, 'a bad encoding');
assert.equal(filePathOf('https://example.com/a', 'S'), null); assert.equal(filePathOf(null, 'S'), null);

// --- relativePath ---
assert.equal(relativePath('/w/acme/src/a.js', '/w/acme'), 'src/a.js');
assert.equal(relativePath('/w/acme/src/a.js', '/w/acme/'), 'src/a.js', 'a trailing / on the folder');
assert.equal(relativePath('/w/acme-web/a.js', '/w/acme'), '/w/acme-web/a.js', 'a sibling folder with the same prefix');
assert.equal(relativePath('/tmp/a.js', '/w/acme'), '/tmp/a.js', 'outside the folder');
assert.equal(relativePath('C:\\w\\acme\\a.js', 'C:\\w\\acme'), 'a.js', 'Windows');
assert.equal(relativePath('./src/a.js', '/w/acme'), 'src/a.js'); assert.equal(relativePath('src/a.js', undefined), 'src/a.js');
assert.equal(relativePath('/w/acme/a.js', undefined), '/w/acme/a.js', 'no folder: as dsh shows it');

// --- previewText ---
const code = { kind: 'code', path: 'src/login.js' };
assert.equal(previewText({ ...code, line: 2 }, '  if (!user) throw Error("no user");\n  return token(user);'),
  '`src/login.js:2-3`\n```\n  if (!user) throw Error("no user");\n  return token(user);\n```\n\n\n', 'two lines at the end of the draft');
assert.equal(previewText({ ...code, line: 2 }, 'second line\n', 'My note', 'z'), '\n\n`src/login.js:2`\n```\nsecond line\n```\n\n', 'a triple-click end is not one more line; after text');
assert.equal(previewText({ ...code, line: 1 }, '\nsecond line'), '`src/login.js:2`\n```\nsecond line\n```\n\n\n', 'a start at the end of line 1 is line 2');
assert.equal(previewText({ ...code, line: 4 }, 'a ``` b'), '`src/login.js:4`\n````\na ``` b\n````\n\n\n', 'a longer fence than the text has');
assert.equal(previewText({ kind: 'text', path: 'a`b.txt', line: 1 }, 'x'), '``a`b.txt:1``\n```\nx\n```\n\n\n', 'a backtick in the path');
assert.equal(previewText({ ...code }, 'x'), '`src/login.js`\n```\nx\n```\n\n\n', 'no line number: the path only');
assert.equal(previewText({ ...code, line: 3 }, ' \n\n'), '', 'blank');
const many = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
const long = previewText({ ...code, line: 10 }, many);
assert.ok(long.startsWith('`src/login.js:10-3009`\n```\n'), 'the reference keeps the whole range');
assert.equal([...long.slice(long.indexOf('```\n') + 4, long.lastIndexOf('\n```'))].length, QUOTE_MAX, 'the lines are cut to QUOTE_MAX'); assert.ok(long.includes('…\n```'));
assert.equal(previewText({ kind: 'markdown', path: 'docs/guide.md' }, 'Run npm test first.\n\none', 'a\n\n', 'b'), '`docs/guide.md`\n> Run npm test first.\n>\n> one\n\n', 'Markdown: > lines');
assert.equal(previewText({ kind: 'pdf', path: 'docs/spec.pdf', pages: [3, 3] }, 'Hello PDF line'), '`docs/spec.pdf#page=3`\n> Hello PDF line\n\n\n');
assert.equal(previewText({ kind: 'pdf', path: 'docs/spec.pdf', pages: [3, 4] }, 'a\u00a0b'), '`docs/spec.pdf#page=3-4`\n> a b\n\n\n', 'two pages, NBSP');
assert.equal(previewText({ kind: 'pdf', path: 'docs/spec.pdf' }, '  '), '', 'blank PDF');

// --- A fake DOM: previews in right sidebar panels ---
const node = (attrs, parent = null) => {
  const n = { nodeType: 1, attrs, parentElement: parent, getAttribute: (k) => attrs[k] ?? null };
  n.closest = (sel) => { for (let x = n; x !== null; x = x.parentElement) if (matches(x, sel)) return x; return null; };
  n.querySelector = (sel) => (sel === '[data-textpreview-path]' ? n.pathEl ?? null : null);
  return n;
};
const has = (x, k, v) => (v === undefined ? x.attrs[k] !== undefined : x.attrs[k] === v);
const matches = (x, sel) => {
  if (sel === '[data-textpreview-state="text"][data-document-preview]') return has(x, 'data-textpreview-state', 'text') && has(x, 'data-document-preview');
  if (sel === '[data-sidebar-right-session]') return has(x, 'data-sidebar-right-session');
  if (sel === '[data-sidebar-right-panel="fullscreen"]') return has(x, 'data-sidebar-right-panel', 'fullscreen');
  if (sel === '[data-textpreview-page]') return has(x, 'data-textpreview-page');
  if (sel === '[data-code-preview] pre') return x.attrs.tag === 'pre' && x.parentElement !== null && has(x.parentElement, 'data-code-preview');
  if (sel === '[data-document-markdown]') return has(x, 'data-document-markdown');
  if (sel === '[data-pdf-page]') return has(x, 'data-pdf-page');
  return false;
};
const text = (parent) => ({ nodeType: 3, parentElement: parent });
const NS = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview';
const panel = (sessionId, mode = 'push') => node({ 'data-sidebar-right-session': sessionId, 'data-sidebar-right-panel': mode });
const preview = (parent, kind, url) => node({ 'data-textpreview-state': 'text', 'data-document-preview': `${NS}/${kind}`, 'data-textpreview-url': url }, parent);
const S = panel('S');
const txt = preview(S, 'text', 'dsh-resource://file/session/S/notes.txt'); const page1 = node({ 'data-textpreview-page': '1' }, txt); const page2 = node({ 'data-textpreview-page': '101' }, txt);
const header = node({}, txt);
const js = preview(S, 'code', 'dsh-resource://file/session/S/src/login.js'); const pre = node({ tag: 'pre' }, node({ 'data-code-preview': true }, js));
const md = preview(S, 'markdown', 'dsh-resource://file/session/S/docs/guide.md'); const mdBody = node({ 'data-document-markdown': true }, md);
const pdf = preview(S, 'pdf', 'dsh-resource://file/absolute/w/acme/docs/spec.pdf'); const pdf3 = node({ 'data-pdf-page': '3' }, pdf); const pdf4 = node({ 'data-pdf-page': '4' }, pdf);
const xls = preview(S, 'excel', 'dsh-resource://file/session/S/a.xlsx'); const xlsCell = node({}, xls);
const other = preview(panel('T'), 'text', 'dsh-resource://file/absolute/w/acme/notes.txt'); const otherPage = node({ 'data-textpreview-page': '1' }, other);
const txt2 = preview(S, 'text', 'dsh-resource://file/session/S/todo.txt'); const txt2Page = node({ 'data-textpreview-page': '1' }, txt2);
const full = preview(panel('S', 'fullscreen'), 'text', 'dsh-resource://file/session/S/notes.txt'); const fullPage = node({ 'data-textpreview-page': '1' }, full);
const noUrl = preview(S, 'code', undefined); noUrl.pathEl = { getAttribute: () => '/w/acme/x.js' }; const noUrlPre = node({ tag: 'pre' }, node({ 'data-code-preview': true }, noUrl));
const sel = (a, f, str = 'second line', more = {}) => ({ rangeCount: 1, isCollapsed: false, anchorNode: a, focusNode: f, toString: () => str,
  getRangeAt: () => ({ startContainer: a, startOffset: 0, endContainer: f, getBoundingClientRect: () => ({ right: 900, top: 200 }), cloneRange() { return this; } }), ...more });

// --- previewTarget ---
assert.deepEqual(previewTarget(sel(text(page1), text(page1)), 'S'), { kind: 'text', path: 'notes.txt' }, 'a text file of this chat');
assert.deepEqual(previewTarget(sel(text(page1), text(page2)), 'S'), { kind: 'text', path: 'notes.txt' }, 'over two pages of one preview');
assert.deepEqual(previewTarget(sel(text(pre), pre), 'S'), { kind: 'code', path: 'src/login.js' }, 'code');
assert.deepEqual(previewTarget(sel(text(mdBody), text(mdBody)), 'S'), { kind: 'markdown', path: 'docs/guide.md' }, 'Markdown');
assert.deepEqual(previewTarget(sel(text(pdf3), text(pdf4)), 'S'), { kind: 'pdf', path: '/w/acme/docs/spec.pdf' }, 'PDF, absolute address');
assert.deepEqual(previewTarget(sel(text(noUrlPre), text(noUrlPre)), 'S'), { kind: 'code', path: '/w/acme/x.js' }, 'no address: the path label');
assert.equal(previewTarget(sel(text(header), text(page1)), 'S'), null, 'from the header');
assert.equal(previewTarget(sel(text(page1), text(pre)), 'S'), null, 'two previews');
assert.equal(previewTarget(sel(text(page1), text(txt2Page)), 'S'), null, 'two text previews');
assert.equal(previewTarget(sel(text(xlsCell), text(xlsCell)), 'S'), null, 'another viewer');
assert.equal(previewTarget(sel(text(otherPage), text(otherPage)), 'S'), null, 'another chat');
assert.equal(previewTarget(sel(text(fullPage), text(fullPage)), 'S'), null, 'a full-screen panel covers the composer');
assert.equal(previewTarget(sel(text(page1), text(page1), ' \n'), 'S'), null, 'blank');
assert.equal(previewTarget(sel(text(page1), text(page1), 'x', { isCollapsed: true }), 'S'), null, 'collapsed');
assert.equal(previewTarget(null, 'S'), null);

// --- previewSpan ---
before = 'first\nsecond\n';
assert.deepEqual(previewSpan('text', { startContainer: text(page1), startOffset: 0 }), { line: 3 }, 'two line breaks before it: line 3');
before = 'x\n'; assert.deepEqual(previewSpan('text', { startContainer: text(page2), startOffset: 0 }), { line: 102 }, 'the page starts at line 101');
before = ''; assert.deepEqual(previewSpan('code', { startContainer: text(pre), startOffset: 0 }), { line: 1 }, 'code starts at line 1');
assert.deepEqual(previewSpan('pdf', { startContainer: text(pdf3), endContainer: text(pdf4) }), { pages: [3, 4] });
assert.deepEqual(previewSpan('markdown', { startContainer: text(mdBody) }), {}, 'Markdown: no line');

// --- previewFormat (the row's text) ---
before = 'one\n';
assert.equal(previewFormat({ text: 'two\nthree', target: { kind: 'code', path: '/w/acme/src/login.js' }, range: { startContainer: text(pre), startOffset: 0 } }, '', '', '/w/acme'),
  '`src/login.js:2-3`\n```\ntwo\nthree\n```\n\n\n', 'relative to the folder, the line from the range');

// --- The row: QuoteReply with the preview's pick, text and mark ---
const mount = (C, props) => {
  const inst = { state: [], refs: [], cbs: [], cleanups: [], deps: [] };
  const render = (more = {}) => { Object.assign(props, more); cur = inst; inst.si = 0; inst.ri = 0; inst.ci = 0; inst.ei = 0; return C(props); };
  return { render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const fire = (m, type) => { for (const fn of [...(m.get(type) ?? [])]) fn({}); };
const regs = new Set();
const ctx = {
  effect: (f) => { f(); }, locale: { register: () => () => {}, bind: () => (k) => k }, inject: () => ({ dispose() {} }), configForms: { get: () => ({}) },
  sessions: { scope: () => ({ get: () => ({ input: { for: () => ({ focus() {}, notify() {} }) } }) }), sessionOf: () => undefined, list: { getSnapshot: () => ({ byId: { S: { cwd: '/w/acme' } } }) } },
  slots: { inject: (name, f) => f(), register: (o, C) => { const r = [o, C]; regs.add(r); return () => { regs.delete(r); }; } },
  get: () => undefined,
};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ on: true }) });
const row = (id) => [...regs].find(([o]) => o.id === id);
plugin.apply(ctx);
assert.ok(row('preview-quote'), 'on by default'); assert.equal(row('preview-quote')[0].name, 'conversation.input.right'); assert.equal(row('preview-quote')[1], QuoteReply);
assert.ok(row('quote-reply'), 'Quote in reply has its own row');
{
  const injected = row('preview-quote')[0].inject('S');
  assert.equal(injected.pick, previewTarget); assert.equal(injected.mark, 'data-composer-plus-preview-quote'); assert.equal(injected.title, 'previewQuote.title');
  const inserts = []; const span = { start: 0, end: 0, draftRev: 1 };
  const inputActions = { captureInsertion: () => span, insertText: (text, s) => { inserts.push([text, s]); return true; } };
  const v = mount(QuoteReply, { ...injected, useInput: (f) => f({ draft: '' }), inputActions, focusComposer: () => {}, t: (k) => k });
  assert.equal(v.render(), null, 'no selection: nothing');
  // A selection in Quote in reply's place (an answer) shows no preview button.
  selection = sel(text(node({})), text(node({}))); fire(listeners.doc, 'selectionchange'); assert.equal(v.render(), null, 'not in a preview');
  before = 'first line\n';
  selection = sel(text(page1), text(page1), 'second line\nthird line'); fire(listeners.doc, 'selectionchange');
  const out = v.render();
  assert.equal(out.portal.p['data-composer-plus-preview-quote'], ''); assert.equal(out.portal.p['data-composer-plus-quote'], undefined, 'its own mark');
  assert.equal(out.portal.p.title, 'previewQuote.title'); assert.equal(out.portal.c.at(-1), 'quote.button');
  out.portal.p.onClick();
  assert.deepEqual(inserts, [['`notes.txt:2-3`\n```\nsecond line\nthird line\n```\n\n\n', span]], 'path, lines and a code block at the caret');
  assert.equal(v.render(), null, 'the button goes');
  v.unmount();
}
// Switched off: the row goes, Quote in reply stays.
const toggles = JSON.parse(mem.get('dsh-composer-plus.features') ?? '{}');
mem.set('dsh-composer-plus.features', JSON.stringify({ ...toggles, previewQuote: false }));
regs.clear(); plugin.apply(ctx);
assert.equal(row('preview-quote'), undefined, 'off: no row'); assert.ok(row('quote-reply'), 'Quote in reply stays');
console.log('preview-quote: ok');
