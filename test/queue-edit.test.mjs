// Edit queued message in place, with images and files.
// Host half (real index.js): `/api/composer-plus.queue-edit` gives one of your own queued messages new content with the
// same id (`inbox.replace`), so its place stays. Kept attachments are the message's own blocks; a new image goes through
// dsh's own admission; a new file is a receipt uploaded for this chat. A changed or sent message, a foreign message, an
// attachment that is not in the message and bad input change nothing.
// Client half (real client.js QueueEdit with a fake DOM): a double-click or the plugin's Edit button opens the editor in
// the row; Save sends the edited content (kept attachments by id, new ones as dsh serialized them, the text in its own
// place); the chat's queue lock stops a drag or a grip move while the editor is open or saves, and a second editor.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, QUEUE_EDIT_PATH, QUEUE_MOVE_PATH, seenOf } from '../index.js';

// ---------- Host half ----------
const routes = new Map();
const img = (id) => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', width: 1, height: 1, bytes: 9 } });
const file = (id, name) => ({ type: 'file', attachment: { attachmentId: id, name, bytes: 3 } });
const text = (t) => ({ type: 'text', text: t });
const msg = (id, content, kind = 'user') => Object.freeze({ id, role: 'user', source: { kind, rpcId: 'r-' + id }, content });
let queue = [], replaced = [], subagent, modalities = ['text', 'image'], admitGate = null, bound = [], committed = 0, disposed = 0;
const inbox = {
  get nextTurn() { return queue; },
  splice() { throw Error('no splice for an edit'); },
  replace(id, next) {
    const i = queue.findIndex((m) => m.id === id);
    if (i === -1) return false;
    assert.ok(Object.isFrozen(next) && Object.isFrozen(next.content), 'the new message is frozen like dsh\'s');
    replaced.push(next); queue = queue.toSpliced(i, 1, next); return true;
  },
};
const agent = { inbox, session: { header: {} } };
const services = {
  attachments: {
    async admitPromptContent(parts) {
      if (admitGate) await admitGate;
      for (const p of parts) if (p.mediaType === 'image/bmp') throw Object.assign(Error('Image type image/bmp is not accepted by this deployment.'), { attachmentError: true });
      return parts.map((p, i) => ({ type: 'image', attachment: { attachmentId: 'sha256:new' + i, mediaType: p.mediaType, width: 2, height: 2, bytes: 4 } }));
    },
    isAttachmentError: (e) => e?.attachmentError === true,
  },
  fileUploads: {
    resolve: (a, receipt) => (a === agent && receipt.startsWith('ok-') ? { attachmentId: 'sha256:' + receipt, name: receipt + '.txt', bytes: 5 } : undefined),
    bindPrompt(a, receipts, rpcId) { bound.push({ receipts, rpcId }); return { commit() { committed += 1; }, [Symbol.dispose]() { disposed += 1; } }; },
  },
  llm: { resolveModelInfo: async () => ({ inputModalities: modalities }) },
};
apply({
  on() {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  get: (name) => services[name],
  sessionController: { resolveAgent: async () => ({ agent }), agents: { selectionFor: () => ({ current: { provider: 'demo', model: 'demo' } }) } },
  sessionQuery: {}, subprocess: {},
  sessionProjections: { snapshot: () => ({ values: { subagent } }) },
});
const post = async (path, body) => {
  const r = await routes.get(path).fetch(new Request('http://h' + path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: r.status, json: await r.json() };
};
const edit = (body) => post(QUEUE_EDIT_PATH, { sessionId: 's', itemId: 'b', ...body });

// 1. Text only: the image and the file stay, the text changes, the id and the place stay.
queue = [msg('a', [text('first')]), msg('b', [img('i1'), file('f1', 'spec.txt'), text('fix the logo')]), msg('c', [text('third')])];
let r = await edit({ seen: seenOf(queue[1].content), content: [{ type: 'image', attachmentId: 'i1' }, { type: 'file', attachmentId: 'f1' }, text('fix the logo, please')] });
assert.deepEqual(r, { status: 200, json: { edited: true } });
assert.deepEqual(queue.map((m) => m.id), ['a', 'b', 'c'], 'the order stays');
assert.deepEqual(queue[1].content, [img('i1'), file('f1', 'spec.txt'), text('fix the logo, please')], 'the attachments are the message\'s own blocks, unchanged');
assert.deepEqual(queue[1].source, { kind: 'user', rpcId: 'r-b' }, 'the source stays');
// 2. Remove the image, keep the file; a new image and a new file come in the editor's order.
r = await edit({ content: [{ type: 'file', attachmentId: 'f1' }, { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'dot.png' }, { type: 'file', receiptId: 'ok-r1' }, text('new text')] });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.deepEqual(queue[1].content, [file('f1', 'spec.txt'), { type: 'image', attachment: { attachmentId: 'sha256:new0', mediaType: 'image/png', width: 2, height: 2, bytes: 4 } },
  { type: 'file', attachment: { attachmentId: 'sha256:ok-r1', name: 'ok-r1.txt', bytes: 5 } }, text('new text')]);
assert.deepEqual(bound, [{ receipts: ['ok-r1'], rpcId: 'r-b' }], 'the new file\'s receipt goes with the message (dsh retires it when the message leaves)');
assert.equal(committed, 1); assert.equal(disposed, 1);
// 3. Everything removed but the text; text before the attachments; a message of attachments only.
r = await edit({ content: [text('just text')] }); assert.equal(r.status, 200); assert.deepEqual(queue[1].content, [text('just text')]);
queue[1] = msg('b', [text('look:'), img('i2'), img('i3')]);
r = await edit({ content: [text('look here:'), { type: 'image', attachmentId: 'i3' }] }); assert.equal(r.status, 200); assert.deepEqual(queue[1].content, [text('look here:'), img('i3')]);
r = await edit({ content: [{ type: 'image', attachmentId: 'i3' }] }); assert.equal(r.status, 200); assert.deepEqual(queue[1].content, [img('i3')], 'no text: attachments only');
// The same attachment twice: each keep takes one block; a third keep is refused.
queue[1] = msg('b', [img('i4'), img('i4'), text('x')]);
assert.equal((await edit({ content: [{ type: 'image', attachmentId: 'i4' }, { type: 'image', attachmentId: 'i4' }, text('y')] })).status, 200);
replaced = [];
assert.equal((await edit({ content: [{ type: 'image', attachmentId: 'i4' }, { type: 'image', attachmentId: 'i4' }, { type: 'image', attachmentId: 'i4' }] })).status, 409);
// 4. Refusals change nothing.
const before = () => JSON.stringify(queue);
queue = [msg('a', [text('first')]), msg('b', [img('i1'), text('B')]), msg('g', [text('G')], 'goal')];
let snap = before();
assert.equal((await edit({ content: [{ type: 'image', attachmentId: 'other' }, text('B')] })).status, 409, 'an attachment that is not in the message');
assert.equal((await edit({ content: [{ type: 'file', attachmentId: 'i1' }, text('B')] })).status, 409, 'the type must match');
assert.equal((await edit({ content: [{ type: 'file', receiptId: 'gone' }, text('B')] })).status, 409, 'a receipt that this chat does not have');
assert.equal((await edit({ seen: [['text', 'old']], content: [text('B2')] })).status, 409, 'the message changed since the user saw it');
assert.equal((await post(QUEUE_EDIT_PATH, { sessionId: 's', itemId: 'g', content: [text('G2')] })).status, 409, 'a goal round is not yours');
assert.equal((await post(QUEUE_EDIT_PATH, { sessionId: 's', itemId: 'zz', content: [text('x')] })).status, 409, 'not in the queue (started to send)');
modalities = ['text'];
r = await edit({ content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, text('B')] });
assert.equal(r.status, 400); assert.match(r.json.error, /does not support image input/); modalities = ['text', 'image'];
r = await edit({ content: [{ type: 'image', mediaType: 'image/bmp', data: 'AAAA' }, text('B')] });
assert.equal(r.status, 400); assert.match(r.json.error, /not accepted/, 'dsh\'s attachment error text');
services.attachments.imageLimits = { maxImagesPerMessage: 1 };
r = await edit({ content: [{ type: 'image', attachmentId: 'i1' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }, text('B')] });
assert.equal(r.status, 400); assert.match(r.json.error, /at most 1 images/, 'the kept images count toward dsh\'s per-message limit');
delete services.attachments.imageLimits;
assert.equal(before(), snap, 'nothing changed');
assert.deepEqual(replaced, []);
for (const b of ['x', {}, { sessionId: 's', itemId: 'b', content: [] }, { sessionId: 's', itemId: 'b', content: [text('   ')] },
  { sessionId: 's', itemId: 'b', content: [{ type: 'image', attachmentId: 'i1', data: 'x' }] }, { sessionId: 's', itemId: 'b', content: [{ type: 'video', attachmentId: 'v' }] },
  { sessionId: 's', itemId: 'b', content: [{ type: 'text', text: 1 }] }, { sessionId: 's', itemId: 'b', content: 'hi' }]) {
  assert.equal((await post(QUEUE_EDIT_PATH, b)).status, 400, JSON.stringify(b));
}
subagent = { mode: 'one-shot' }; agent.session.header = { origin: 'subagent', delegationDepth: 1 };
assert.equal((await edit({ content: [text('x')] })).status, 409, 'a one-shot subagent chat cannot change its queue');
subagent = undefined; agent.session.header = {};
// 5. The message changed while dsh admitted the new image: nothing is written.
{
  let open; admitGate = new Promise((resolve) => { open = resolve; });
  const pending = edit({ content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, text('B')] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // One queue change per chat on the Host: a move (or a second edit) meanwhile is refused.
  assert.equal((await post(QUEUE_MOVE_PATH, { sessionId: 's', itemId: 'b', to: 0, before: ['a', 'b', 'g'] })).status, 409, 'a move waits for the edit');
  assert.equal((await edit({ content: [text('other')] })).status, 409, 'a second edit waits');
  queue = queue.map((m) => (m.id === 'b' ? msg('b', [img('i1'), text('changed elsewhere')]) : m));
  open(); admitGate = null;
  r = await pending;
  assert.equal(r.status, 409); assert.deepEqual(queue[1].content, [img('i1'), text('changed elsewhere')]);
  assert.equal((await edit({ content: [{ type: 'image', attachmentId: 'i1' }, text('now')] })).status, 200, 'the lock is free again');
}

// ---------- Client half ----------
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hook = '    function QueueEdit({';
assert.ok(src.includes(hook));
let mod, cleared = 0;
globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, getSelection: () => ({ removeAllRanges() { cleared += 1; } }) };
globalThis.Element = class Element {};
// A tiny DOM: elements with a tag, attributes, children and a parent; the few selectors used.
class El extends Element {
  constructor(tag, attrs = {}, children = []) {
    super(); this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parent = null; this.disabled = attrs.disabled === true; this.className = attrs.class ?? ''; this.style = {}; this.isConnected = true;
    for (const c of children) { c.parent = this; this.children.push(c); }
  }
  get tagName() { return this.tag.toUpperCase(); }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get firstChild() { return this.children[0] ?? null; }
  get parentElement() { return this.parent; }
  get previousElementSibling() { const s = this.parent?.children; const i = s ? s.indexOf(this) : -1; return i > 0 ? s[i - 1] : null; }
  hasAttribute(k) { return k in this.attrs; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  insertBefore(n, ref) { n.parent = this; this.children.splice(this.children.indexOf(ref), 0, n); }
  appendChild(n) { n.parent = this; this.children.push(n); return n; }
  cloneNode() { const c = new El(this.tag, this.attrs); c.getBoundingClientRect = this.getBoundingClientRect; return c; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  matches(sel) {
    return sel.split(',').map((x) => x.trim()).some((one) => {
      if (one === '[data-queue-dock] li') return this.tag === 'li' && this.ancestors().some((a) => a.hasAttribute('data-queue-dock'));
      if (one === 'li:not([data-submission-echo])') return this.tag === 'li' && !this.hasAttribute('data-submission-echo');
      const attr = one.match(/^\[([\w-]+)\]$/); if (attr) return this.hasAttribute(attr[1]);
      if (one === '[contenteditable="true"]') return this.attrs.contenteditable === 'true';
      return one === this.tag;
    });
  }
  ancestors() { const out = []; for (let p = this.parent; p; p = p.parent) out.push(p); return out; }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
globalThis.document = { createElement: (tag) => new El(tag) };
globalThis.MutationObserver = class { constructor(f) { this.f = f; } observe() {} disconnect() {} };
const listeners = new Map();
const button = (label, opts = {}) => new El('button', { 'aria-label': label, class: 'dshAction', ...(opts.disabled ? { disabled: true } : {}) });
const rowEl = (preview) => new El('li', {}, [new El('span', { class: 'preview' }, [new El('span', { class: 'word', text: preview })]),
  new El('div', { class: 'actions' }, [button('Edit queued message', { disabled: preview.includes('image') }), button('Remove'), button('Steer')])]);
const lis = [rowEl('first'), rowEl('with image'), rowEl('third')];
const ul = new El('ul', {}, lis);
const dock = new El('div', { 'data-queue-dock': '' }, [ul]);
const anchor = new El('span');
const seat = new El('div', { 'data-composer-seat': '' }, [dock, anchor]);
seat.addEventListener = (type, fn) => { listeners.set(type, fn); };
seat.removeEventListener = (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); };
eval(src);
// Fake React: state by hook order, effects collected and run by hand, portals recorded.
let state = [], si = 0, layout = [], effects = [], refs = [], ri = 0;
const React = {
  createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
  useState: (v) => { const i = si++; if (!(i in state)) state[i] = typeof v === 'function' ? v() : v; return [state[i], (x) => { state[i] = typeof x === 'function' ? x(state[i]) : x; }]; },
  useRef: (v) => { const i = ri++; if (!(i in refs)) refs[i] = { current: i === 0 ? anchor : v }; return refs[i]; },
  useMemo: (f) => f(), useSyncExternalStore: (_, get) => get(),
  useLayoutEffect: (f) => layout.push(f), useEffect: (f) => effects.push(f),
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (e, host, key) => ({ portal: e, host, key }) } : {}));
const regs = [];
plugin.apply({ sessions: { scope: () => undefined }, slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
const QueueEdit = regs.find(([o]) => o.id === 'queue-edit')[1];
const QueueReorder = regs.find(([o]) => o.id === 'queue-reorder')[1];
const rows = [
  { id: 'r1', source: { kind: 'user', rpcId: 'p1' }, content: [text('first')] },
  { id: 'r2', source: { kind: 'user', rpcId: 'p2' }, content: [img('i1'), file('f1', 'spec.txt'), text('with image')] },
  { id: 'r3', source: { kind: 'user', rpcId: 'p3' }, content: [text('third')] },
];
let sent = [], answer = () => true, notes = [], released = [], serialized = [];
const uploads = { snap: {}, subs: new Set(), getSnapshot() { return this.snap; }, subscribe(f) { this.subs.add(f); return () => this.subs.delete(f); } };
const conversation = {
  fileUploads: uploads,
  createDrafts: (sid, files) => files.map((f, i) => (f.type.startsWith('image/') ? { kind: 'image', id: 'd-img' + i, previewUrl: 'blob:' + f.name, file: f } : { kind: 'file', id: 'd-file' + i, file: f })),
  releaseDraftAttachment: (id) => released.push(id),
  serializeDraftAttachments: async (ids) => { serialized.push(ids); return { attachments: ids.map((id) => (id.startsWith('d-img') ? { type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'new.png' } : { type: 'file', receiptId: 'rcpt-' + id })) }; },
};
let updates = [];
const props = () => ({ useSession: (f) => f({ pendingSubmissions: [], subagent: null }), useProjection: () => ({ 'next-turn': rows }), t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
  notify: (l, m) => notes.push(m), loadImage: async () => 'blob:stored', conversation, sessionId: 's1', updateQueue: async (id, a) => { updates.push([id, a]); },
  editQueued: async (b) => { sent.push(b); return answer(b); } });
const render = () => { si = 0; ri = 0; layout = []; effects = []; return QueueEdit(props()); };
const flat = (node) => (node === null || typeof node !== 'object' ? [] : [node, ...(node.portal ? flat(node.portal) : []), ...(node.c ?? []).flatMap(flat)]);
const find = (tree, pred) => flat(tree).find(pred);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

render(); const offLayout = layout[0](); let out = render(); effects.forEach((f) => f());
// The plugin's Edit button replaces dsh's (dsh's stays in the row, hidden) on every row, also the image row.
for (const li of lis) {
  const actions = li.children.at(-1);
  assert.ok(actions.children[0].hasAttribute('data-composer-plus-queue-edit-button'), 'a host before dsh\'s Edit');
  assert.ok(actions.children[1].hasAttribute('data-composer-plus-native-edit'), 'dsh\'s Edit is hidden');
}
const editButtons = () => flat(out).filter((n) => n.t === 'button' && n.p['aria-label'] === 'queue.edit');
assert.equal(editButtons().length, 3); assert.equal(editButtons()[1].p.disabled, false, 'the image row can be edited');
assert.equal(editButtons()[1].p.className, 'dshAction', 'dsh\'s own look');
// 1. A double-click on the image row opens the editor there: text without markers, both attachments as chips.
const dbl = (target, extra = {}) => { let prevented = false; listeners.get('dblclick')({ target, button: 0, preventDefault: () => { prevented = true; }, ...extra }); return prevented; };
assert.equal(dbl(lis[1].children[0].children[0]), true); assert.equal(cleared, 1);
out = render(); layout.slice(1).forEach((f) => f()); out = render();
const editorHost = lis[1].children.find((c) => c.hasAttribute('data-composer-plus-queue-editor'));
assert.ok(editorHost, 'the editor is in the row'); assert.ok(lis[1].hasAttribute('data-composer-plus-queue-editing'), 'the rest of the row hides');
const area = () => find(out, (n) => n.t === 'textarea');
assert.equal(area().p.value, 'with image');
const chips = () => flat(out).filter((n) => n.p?.className === 'cp-qe-chip');
assert.deepEqual(chips().map((c) => c.p.title), ['queue.editImage', 'spec.txt']);
assert.ok(editButtons().every((b) => b.p.disabled), 'no second editor while one is open');
// 2. While the editor is open, the queue cannot move: QueueReorder (same module, so the same chat lock) gets its grips
// off, and its grip pointer and grip key do nothing even when they are called; a second double-click opens nothing.
let moves = [];
const reorderProps = { useSession: (f) => f({ pendingSubmissions: [], subagent: null }), useProjection: () => ({ 'next-turn': rows }), updateQueue: async () => {}, notify: () => {}, t: (k) => k, sessionId: 's1', moveQueued: async (b) => { moves.push(b); return true; } };
const seatR = { querySelector: () => ({ querySelectorAll: () => lis }), querySelectorAll: () => [] };
let rs = [], rsi = 0, rl = [];
// QueueReorder gets its own hook state: swap the fake hooks for one call.
const reorder = () => {
  const keep = [React.useState, React.useLayoutEffect, React.useRef];
  React.useState = (v) => { const i = rsi++; if (!(i in rs)) rs[i] = v; return [rs[i], (x) => { rs[i] = typeof x === 'function' ? x(rs[i]) : x; }]; };
  React.useLayoutEffect = (f) => rl.push(f); React.useRef = () => ({ current: { closest: () => seatR } });
  rsi = 0; rl = [];
  try { return QueueReorder(reorderProps); } finally { [React.useState, React.useLayoutEffect, React.useRef] = keep; }
};
globalThis.window.addEventListener = () => {}; globalThis.window.removeEventListener = () => {};
document.head = new El('head'); document.body = new El('body');
for (const li of lis) li.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, width: 10, height: 10 });
reorder(); rl[0](); let grips = reorder();
const gripOf = (i) => flat(grips).filter((n) => n.t === 'button' && n.p['aria-label'] === 'queue.grip')[i];
assert.equal(gripOf(0).p.disabled, true, 'the grip is off while a message is open for editing'); assert.equal(gripOf(0).p.title, 'queue.editing');
gripOf(2).p.onPointerDown({ button: 0, clientY: 5, preventDefault() {} });
assert.equal(document.body.children.length, 0, 'no drag starts: no lifted card');
gripOf(2).p.onKeyDown({ key: 'ArrowUp', preventDefault() {} }); await tick();
assert.deepEqual(moves, [], 'no key move while the editor is open');
assert.equal(dbl(lis[0].children[0].children[0]), false, 'no second editor by a double-click');
// 3. Remove the image, add a new image and a new file, change the text: Save sends the edited content.
find(out, (n) => n.t === 'button' && n.p['aria-label'] === 'queue.editRemoveAttachment:{"name":"queue.editImage"}').p.onClick(); out = render();
assert.deepEqual(chips().map((c) => c.p.title), ['spec.txt']);
find(out, (n) => n.t === 'input' && n.p.type === 'file').p.onChange({ currentTarget: { files: [{ name: 'new.png', type: 'image/png' }, { name: 'notes.md', type: 'text/markdown' }], value: 'x' } });
out = render();
assert.deepEqual(chips().map((c) => c.p.title), ['spec.txt', 'new.png', 'notes.md']);
const saveBtn = () => find(out, (n) => n.t === 'button' && n.p['aria-label'] === 'queue.editSave');
assert.equal(saveBtn().p.disabled, true, 'Save waits for the file upload');
area().p.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {}, nativeEvent: {} }); await tick();
assert.deepEqual(sent, [], 'Enter does not save before the upload is ready');
uploads.snap = { 'd-file1': { status: 'ready', receiptId: 'rcpt-d-file1' } }; out = render();
assert.equal(saveBtn().p.disabled, false);
area().p.onChange({ currentTarget: { value: 'with a new image' } }); out = render();
let gate; answer = () => new Promise((resolve) => { gate = resolve; });
area().p.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {}, nativeEvent: {} });
area().p.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {}, nativeEvent: {} }); // a second Enter while it saves
await tick(); await tick();
assert.equal(sent.length, 1, 'one save at a time');
assert.deepEqual(sent[0], { sessionId: 's1', itemId: 'r2', seen: [['image', 'i1'], ['file', 'f1'], ['text', 'with image']],
  content: [{ type: 'file', attachmentId: 'f1' }, { type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'new.png' }, { type: 'file', receiptId: 'rcpt-d-file1' }, { type: 'text', text: 'with a new image' }] },
  'kept file by id, new image as bytes, new file by receipt, the text after the attachments as before');
assert.deepEqual(serialized, [['d-img0', 'd-file1']]);
out = render(); reorder(); grips = reorder();
assert.equal(gripOf(0).p.disabled, true, 'still locked while it saves');
assert.equal(find(out, (n) => n.t === 'button' && n.p['aria-label'] === 'queue.editCancel').p.disabled, true, 'no cancel while it saves');
gate(true); await tick(); await tick();
out = render(); layout.slice(1).forEach((f) => f()); out = render();
assert.equal(find(out, (n) => n.t === 'textarea'), undefined, 'the editor closed');
assert.deepEqual(released.sort(), ['d-file1', 'd-img0'], 'the drafts are freed');
assert.ok(!lis[1].hasAttribute('data-composer-plus-queue-editing') && !lis[1].children.some((c) => c.hasAttribute('data-composer-plus-queue-editor')), 'the row is back');
reorder(); grips = reorder(); assert.equal(gripOf(0).p.disabled, false, 'the grips work again');
// 4. A refused save keeps the editor and the changes; Esc cancels and frees the new drafts.
sent = []; released = []; answer = () => { throw Error('the queue changed'); };
editButtons()[0].p.onClick(); out = render(); layout.slice(1).forEach((f) => f()); out = render();
area().p.onChange({ currentTarget: { value: 'first!' } }); out = render();
await saveBtn().p.onClick(); await tick(); await tick(); out = render();
assert.equal(notes.at(-1), 'queue.editFailed:{"error":"the queue changed"}'); assert.equal(area().p.value, 'first!', 'the text stays for another try');
assert.deepEqual(sent[0].content, [{ type: 'text', text: 'first!' }]);
find(out, (n) => n.t === 'input' && n.p.type === 'file').p.onChange({ currentTarget: { files: [{ name: 'a.png', type: 'image/png' }], value: 'x' } }); out = render();
area().p.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {}, nativeEvent: {} }); out = render();
assert.equal(find(out, (n) => n.t === 'textarea'), undefined, 'Esc closes'); assert.deepEqual(released, ['d-img0'], 'the new image draft is freed');
// 5. An older Host (404): a text-only result uses dsh's own queue edit; with attachments a notice asks for a restart.
answer = () => false; sent = []; updates = [];
editButtons()[2].p.onClick(); out = render(); area().p.onChange({ currentTarget: { value: 'third, fixed' } }); out = render();
await saveBtn().p.onClick(); await tick(); await tick();
assert.deepEqual(updates, [['r3', { kind: 'edit', content: [{ type: 'text', text: 'third, fixed' }] }]]);
out = render(); editButtons()[1].p.onClick(); out = render(); area().p.onChange({ currentTarget: { value: 'x' } }); out = render();
await saveBtn().p.onClick(); await tick(); await tick();
assert.equal(updates.length, 1, 'no text-only edit for a message with attachments'); assert.equal(notes.at(-1), 'queue.editFailed:{"error":"queue.editRestart"}');
area().p.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {}, nativeEvent: {} }); out = render();
// 6. The message starts to send while the editor is open: the editor closes and nothing is sent.
editButtons()[0].p.onClick(); out = render(); sent = [];
rows.shift(); out = render(); effects.forEach((f) => f()); out = render();
assert.equal(find(out, (n) => n.t === 'textarea'), undefined); assert.equal(notes.at(-1), 'queue.editGone'); assert.deepEqual(sent, []);
// 7. Switching the feature off removes the hosts, the editor, dsh's hidden mark and the listener.
offLayout();
assert.equal(listeners.has('dblclick'), false);
assert.ok(lis.every((li) => !li.all().some((e) => e.hasAttribute('data-composer-plus-queue-edit-button') || e.hasAttribute('data-composer-plus-native-edit') || e.hasAttribute('data-composer-plus-queue-editor'))), 'nothing of the plugin stays in dsh\'s rows');
assert.match(src, /'queueReorder', 'queueEdit', 'copyDeeplink'/, 'the feature has its own switch');
console.log('queue edit checks passed');
