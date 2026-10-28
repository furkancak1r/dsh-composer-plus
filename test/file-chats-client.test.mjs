// Changes → a file's "…" menu → "Chats that changed this file" (client half): the menu on each file row (only when the page
// can open a message), the list view with its back button, the request URL, the rows (title, request, rolled back, this
// chat, count), a click that opens the chat at the request, the notes (partial, unreadable, older Host) and that the
// view belongs to its chat (dsh can show another chat in the same tab) and goes away with a mode change.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
const storage = new Map(); globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
const hook = 'const CHANGES_KIND = ';
assert.ok(src.includes(hook));
eval(src.replace(hook, 'globalThis.__fc = () => ({ ChangesTab, FileList, FileMenu, FileChats });\n    ' + hook));
let slots = []; let at = 0; let effects = [];
const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const React = {
  createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }), Fragment: 'F',
  useState: (v) => { const own = slots; const k = at++; if (!(k in own)) own[k] = typeof v === 'function' ? v() : v; return [own[k], (x) => { own[k] = typeof x === 'function' ? x(own[k]) : x; }]; },
  useRef: (v) => { const k = at++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
  useMemo: (f, deps) => { const k = at++; if (slots[k] && same(slots[k].deps, deps)) return slots[k].v; slots[k] = { deps, v: f() }; return slots[k].v; },
  useEffect: (f, deps) => { const k = at++; const old = slots[k]; if (old && same(old.deps, deps)) return; effects.push(() => { slots[k]?.cleanup?.(); slots[k] = { deps, cleanup: f() }; }); },
};
mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu' } : {}));
const { ChangesTab, FileList, FileMenu, FileChats } = globalThis.__fc();
const find = (e, test) => { if (e === null || typeof e !== 'object') return undefined; if (test(e)) return e; for (const x of e.c ?? []) { const f = find(x, test); if (f) return f; } return undefined; };
const findAll = (e, test, acc = []) => { if (e && typeof e === 'object') { if (test(e)) acc.push(e); for (const x of e.c ?? []) findAll(x, test, acc); } return acc; };
const text = (e) => (typeof e === 'string' ? e : e && typeof e === 'object' ? (e.c ?? []).map(text).join('') : '');
const t = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k);
globalThis.setInterval = () => 1; globalThis.clearInterval = () => {};

const UNCOMMITTED = { repo: true, root: '/demo', branch: 'main', mode: 'uncommitted', files: [{ path: 'src/app.js', added: 2, deleted: 1, binary: false }], total: 1, added: 2, deleted: 1 };
let CHATS = { repo: true, path: 'src/app.js', total: 3, chats: [
  { sessionId: 'chat-2', seq: 9, time: 1700000200000, count: 2, title: 'Saved title', request: 'Rename the header' },
  { sessionId: 'chat-1', seq: 4, time: 1700000100000, count: 1, request: 'Fix it' },
  { sessionId: 'chat-3', seq: 7, time: 1700000000000, count: 1, withdrawn: true }] };
let status = 200;
const urls = [];
globalThis.fetch = async (url, init) => {
  urls.push(url);
  if (url.includes('.file-chats')) return { ok: status < 400, status, json: async () => (status === 200 ? structuredClone(CHATS) : status === 404 ? {} : { error: 'boom' }) };
  return { ok: true, status: 200, json: async () => structuredClone(UNCOMMITTED) };
};
const opened = [];
let out;
const props = (sessionId, extra = {}) => ({ sessionId, t, openLastTurn: () => {}, openMessage: (link) => opened.push(link), titleOf: (id) => (id === 'chat-1' ? 'Live title' : undefined), ...extra });
const render = async (sessionId = 'chat-1', extra) => {
  for (let round = 0; round < 5; round++) {
    at = 0; effects = []; out = ChangesTab(props(sessionId, extra));
    const run = effects; for (const f of run) f();
    await new Promise((r) => setTimeout(r, 0));
    if (run.length === 0) break;
  }
};
// A child component with its own hook slots, rendered until its effects settle.
const renderChild = async (el) => {
  const keep = slots; slots = [];
  let view;
  for (let round = 0; round < 5; round++) { at = 0; effects = []; view = el.t(el.p); const run = effects; for (const f of run) f(); await new Promise((r) => setTimeout(r, 0)); if (run.length === 0) break; }
  slots = keep; return view;
};

// 1. The file list gets a "…" menu per row only when the page can open a message.
await render();
let list = find(out, (e) => e.t === FileList);
assert.equal(typeof list.p.onFileChats, 'function');
{
  const keep = slots; slots = []; at = 0; const fl = FileList(list.p); slots = keep;
  const menu = find(fl, (e) => e.t === FileMenu); assert.equal(menu.p.path, 'src/app.js');
  slots = []; at = 0; const m = FileMenu(menu.p); slots = keep;
  assert.equal(m.t, 'Menu'); assert.deepEqual(m.p.items, [{ id: 'chats', label: 'changes.fileChats' }]);
  assert.equal(m.p.anchor.p['aria-label'], 'changes.fileMenu:{"file":"src/app.js"}'); assert.equal(m.p.anchor.p['aria-haspopup'], 'menu');
  let stopped = 0; m.p.anchor.p.onClick({ stopPropagation: () => stopped++ }); assert.equal(stopped, 1, 'the menu button does not open the diff');
  m.p.onSelect('chats');
}
await render();
await renderChild(find(out, (e) => e.t === FileChats));
assert.equal(urls.at(-1), '/api/composer-plus.file-chats?sessionId=chat-1&path=src%2Fapp.js');
assert.equal(find(out, (e) => e.t === FileList), undefined, 'the list view replaces the files');
assert.ok(find(out, (e) => e.c?.includes?.('src/app.js')), 'the file path is shown');
{
  const keep = slots; slots = []; at = 0; const fl = FileList({ ...list.p, onFileChats: undefined }); slots = keep;
  assert.equal(find(fl, (e) => e.t === FileMenu), undefined, 'no menu without an opener');
}
await render('chat-1', { openMessage: undefined });
list = find(out, (e) => e.t === FileList);
assert.ok(list === undefined || list.p.onFileChats === undefined);

// 2. The rows: dsh's live title first, the saved title, the request, rolled back, this chat, the count; a click opens it.
await render();
const chatsEl = find(out, (e) => e.t === FileChats);
assert.equal(chatsEl.p.path, 'src/app.js'); assert.equal(chatsEl.p.sessionId, 'chat-1');
let view = await renderChild(chatsEl);
const rows = findAll(view, (e) => e.p?.['data-composer-plus-file-chat'] !== undefined);
assert.deepEqual(rows.map((r) => r.p['data-composer-plus-file-chat']), ['chat-2#9', 'chat-1#4', 'chat-3#7'], 'newest first, as the Host answers');
assert.match(text(rows[0]), /Saved title/); assert.match(text(rows[0]), /Rename the header · ×2/);
assert.match(text(rows[1]), /Live title/); assert.match(text(rows[1]), /changes\.fileChats\.this/, 'the open chat is marked');
assert.match(text(rows[2]), /changes\.fileChats\.withdrawn/); assert.match(text(rows[2]), /chat-3/, 'no title: the id');
rows[0].p.onClick(); assert.deepEqual(opened.at(-1), { sessionId: 'chat-2', seq: 9 }, 'a row opens that chat at the request');
// Notes: partial and unreadable; empty; an older Host half (404) asks for a restart; another error.
CHATS = { repo: true, path: 'src/app.js', total: 0, chats: [], partial: true, unreadable: 2 };
view = await renderChild(chatsEl);
assert.match(text(view), /changes\.fileChats\.partial/); assert.match(text(view), /changes\.fileChats\.unreadable:\{"count":"2"\}/); assert.match(text(view), /changes\.fileChats\.empty/);
status = 404; view = await renderChild(chatsEl); assert.match(text(view), /changes\.fileChats\.restart/);
status = 500; view = await renderChild(chatsEl); assert.match(text(view), /changes\.failed/);
status = 200; CHATS = { repo: false }; view = await renderChild(chatsEl); assert.match(text(view), /changes\.noRepo/);

// 3. The view belongs to its chat: chat 2 in the same tab sees its files; back and a mode change leave the view.
await render('chat-2');
assert.ok(find(out, (e) => e.t === FileList), 'another chat shows its files, not chat 1\'s list');
await render('chat-1');
assert.ok(find(out, (e) => e.t === FileChats), 'chat 1 still has its list');
find(out, (e) => 'data-composer-plus-file-chats-back' in e.p).p.onClick(); await render();
assert.equal(find(out, (e) => e.t === FileChats), undefined); assert.ok(find(out, (e) => e.t === FileList), 'back shows the files again');
// Open it again, then the mode menu leaves it.
{ const keep = slots; slots = []; at = 0; const fl = FileList(find(out, (e) => e.t === FileList).p); slots = []; at = 0; FileMenu(find(fl, (e) => e.t === FileMenu).p).p.onSelect('chats'); slots = keep; }
await render(); assert.ok(find(out, (e) => e.t === FileChats));
find(out, (e) => e.t === 'Menu').p.onSelect('staged'); await render();
assert.equal(find(out, (e) => e.t === FileChats), undefined, 'a mode change leaves the list');
console.log('file chats client checks passed');
