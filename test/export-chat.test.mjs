// Export chat as Markdown: the Host transcript (only the user's own messages and the reply text; rollback-hidden messages,
// reasoning, tool calls and hidden context left out; the size cap), the read-only route, and the client half (closed code
// fences, the Markdown, the file name, one export at a time, copy and save inside the click, the menu item and the switch).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { apply, EXPORT_PATH, EXPORT_MAX, chatTranscript } from '../index.js';

// 1. Host transcript.
const user = (seq, content, source = { kind: 'user' }) => ({ seq, type: 'user/message', data: { role: 'user', content, ...(source === null ? {} : { source }) } });
const reply = (seq, content) => ({ seq, type: 'assistant/message', data: { message: { role: 'assistant', content } } });
const text = (t) => ({ type: 'text', text: t });
const code = 'Here:\n\n```js\nconst a = 1;\n```\n';
const events = [
  { seq: 1, type: 'session' },
  user(2, [text('<system-reminder>rules</system-reminder>')], { kind: 'agent-instructions' }),
  user(3, [text('Fix the '), text('login bug'), { type: 'image', attachmentId: 'x' }]),
  reply(4, [{ type: 'reasoning', text: 'secret thinking' }, { type: 'tool-call', name: 'bash', arguments: '{}' }]),
  { seq: 5, type: 'tool/result', data: { message: { content: [text('tool output')] } } },
  reply(6, [text('Step one done.')]),
  reply(7, [text(code)]),
  user(8, [text('time context')], { kind: 'time-context' }),
  user(9, [text('An old client message')], null),
  reply(10, [text('   ')]),
  user(11, [text('Withdrawn question')]),
  reply(12, [text('Withdrawn answer')]),
  { seq: 13, type: 'user/message', data: { content: [text('marker')], source: { kind: 'composer-plus-rollback' } }, sourceEventSeqs: [11, 12] },
  user(14, [text('Thanks')]),
];
const out = chatTranscript(events);
assert.equal(out.truncated, false);
assert.deepEqual(out.messages, [
  { role: 'user', text: 'Fix the login bug\n[image]' },
  { role: 'assistant', text: `Step one done.\n\n${code.trim()}` },
  { role: 'user', text: 'An old client message' },
  { role: 'user', text: 'Thanks' },
], 'own messages and reply text only; replies of one turn join; reasoning, tools, context and rolled-back messages are out');
assert.ok(!JSON.stringify(out).includes('secret thinking') && !JSON.stringify(out).includes('tool output') && !JSON.stringify(out).includes('Withdrawn'));
// The cap: an export stops before the message that passes it.
const big = chatTranscript([user(1, [text('a'.repeat(60))]), reply(2, [text('b'.repeat(60))]), user(3, [text('c')])], 100);
assert.deepEqual(big, { messages: [{ role: 'user', text: 'a'.repeat(60) }], truncated: true });
assert.equal(EXPORT_MAX, 4 * 1024 * 1024);
assert.deepEqual(chatTranscript([]), { messages: [], truncated: false });
// dsh-rewind-plugin owns rollback when it is installed: its marker withdraws messages too. dsh's /compact marker hides
// old messages from the model only: they stay in the export.
const rewound = chatTranscript([user(1, [text('Keep this')]), reply(2, [text('Kept answer')]), user(3, [text('Rewound question')]), reply(4, [text('Rewound answer')]),
  { seq: 5, type: 'user/message', data: { content: [text('(empty message)')], source: { kind: 'dsh-rewind' } }, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] },
  { seq: 6, type: 'user/message', data: { content: [text('summary')], source: { kind: 'compact-checkpoint', compactionId: 'c1' } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] },
  user(7, [text('After')])]);
assert.deepEqual(rewound.messages.map((m) => m.text), ['Keep this', 'Kept answer', 'After'], 'a dsh-rewind span is out; a /compact span stays');

// 2. Route: GET only, the chat's own log, the project folder name, the observation always closed.
{
  const routes = new Map(); const disposed = [];
  const observeSession = async (id, opts) => {
    assert.equal(opts.projectionMode, 'none');
    if (id === 'gone') throw Object.assign(new Error('session not found'), { status: 404 });
    return { header: { cwd: '/home/demo/recipe-box/' }, events, [Symbol.dispose]: () => disposed.push(id) };
  };
  process.env.DSH_HOME = '/nonexistent-dsh-home-for-tests';
  apply({ on() {}, effect() {}, get: () => undefined, connection: { fetch: { register: (r) => routes.set(r.path, r) } }, sessionController: {}, sessionQuery: { observeSession }, subprocess: undefined });
  const route = routes.get(EXPORT_PATH); assert.equal(EXPORT_PATH, '/api/composer-plus.export'); assert.deepEqual(route.methods, ['GET']);
  const get = async (q) => { const r = await route.fetch(new Request(`http://h${EXPORT_PATH}${q}`)); return { status: r.status, body: await r.json() }; };
  for (const q of ['', '?sessionId=', `?sessionId=${'x'.repeat(600)}`]) assert.equal((await get(q)).status, 400, q);
  const ok = await get('?sessionId=chat-1');
  assert.equal(ok.status, 200); assert.equal(ok.body.project, 'recipe-box'); assert.equal(ok.body.messages.length, 4); assert.equal(ok.body.truncated, false);
  assert.deepEqual(disposed, ['chat-1'], 'the observation is closed');
  const gone = await get('?sessionId=gone'); assert.equal(gone.status, 404); assert.match(gone.body.error, /not found/);
}

// 3. Client half.
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
const clicks = [];
globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {},
  createElement: (tag) => { const el = { tag, click() { clicks.push({ href: el.href, download: el.download }); } }; return el; } };
const blobs = new Map(); let nextUrl = 0; const revoked = [];
globalThis.URL.createObjectURL = (blob) => { const url = `blob:test/${nextUrl++}`; blobs.set(url, blob); return url; };
globalThis.URL.revokeObjectURL = (url) => { revoked.push(url); };
eval(src.replace('const EXPORT_ROUTE = ', 'globalThis.__ex = () => ({ closeFences, chatMarkdown, mdFileName, createExportChat, ExportChatItem, ExportChatDialog });\n    const EXPORT_ROUTE = '));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect() {}, useSyncExternalStore: (s, g) => g() };
const clipboard = []; let clipboardOk = true;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ on: false }) });
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives'
  ? { Switch: 'Switch', Input: 'Input', MenuItemButton: 'MenuItemButton', Modal: 'Modal', Button: 'Button', writeClipboard: async (t) => { clipboard.push(t); return clipboardOk; } } : {}));
const { closeFences, chatMarkdown, mdFileName, createExportChat, ExportChatItem, ExportChatDialog } = globalThis.__ex();

// Fences: a closed block stays; an open one is closed with the same character and length; ``` with a backtick in its info
// string is not a fence (CommonMark); a longer fence needs a closer at least as long.
assert.equal(closeFences(code), code);
assert.equal(closeFences('```js\nopen'), '```js\nopen\n```');
assert.equal(closeFences('~~~~\na\n~~~'), '~~~~\na\n~~~\n~~~~', 'a shorter closer does not close');
assert.equal(closeFences('````md\n```js\ninner\n```\n````'), '````md\n```js\ninner\n```\n````', 'a nested shorter fence is content');
assert.equal(closeFences('``` a`b\ntext'), '``` a`b\ntext', 'not a fence');
assert.equal(closeFences('```\na\n``` x'), '```\na\n``` x\n```', 'a closer has no info string');
assert.equal(closeFences('plain text'), 'plain text');
assert.equal(closeFences('```js\r\nx\r\n```\r\n'), '```js\r\nx\r\n```\r\n', 'CRLF lines: a closed block stays');
assert.equal(closeFences('```js\r\nx'), '```js\r\nx\n```', 'CRLF lines: an open block is closed');

// Markdown: title, project and date, a section per message, the text as it is.
const t = (k, p) => (p ? `${k}(${Object.values(p).join(',')})` : k);
const md = chatMarkdown({ project: 'recipe-box', messages: [{ role: 'user', text: 'Fix it' }, { role: 'assistant', text: '```sh\nnpm test' }], truncated: false },
  { title: '  Login\nbug ', t, now: new Date(2026, 9, 2) });
assert.equal(md, '# Login bug\n\nexportChat.project(recipe-box) · exportChat.exported(2026-10-02)\n\n## exportChat.user\n\nFix it\n\n## exportChat.assistant\n\n```sh\nnpm test\n```\n');
assert.ok(chatMarkdown({ project: '', messages: [], truncated: true }, { title: '', t, now: new Date(2026, 0, 1) }).startsWith('# Chat\n\nexportChat.exported(2026-01-01)\n\n> exportChat.truncated'));

// File name: no path or reserved characters, no leading dot, 80 characters at most.
assert.equal(mdFileName('Login bug'), 'Login bug.md');
assert.equal(mdFileName('../../etc/passwd'), 'etc-passwd.md');
assert.equal(mdFileName('a:b*c?"d<e>f|g\\h\u0007'), 'a-b-c-d-e-f-g-h.md');
assert.equal(mdFileName('   '), 'chat.md'); assert.equal(mdFileName(undefined), 'chat.md'); assert.equal(mdFileName('...'), 'chat.md');
assert.equal(mdFileName('x'.repeat(200)), `${'x'.repeat(80)}.md`);
assert.equal(mdFileName(`${'x'.repeat(79)}😀tail`), `${'x'.repeat(79)}😀.md`, 'the cut never splits a character');
assert.equal(mdFileName(`${'x'.repeat(78)}. more`), `${'x'.repeat(78)}.md`, 'no dot or space left at the cut');

// Store: one open chat; a later open makes an older answer count for nothing; errors and an old Host half are shown.
const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
{
  const gates = {}; const asked = [];
  const store = createExportChat(async (id) => { asked.push(id); gates[id] = gate(); await gates[id].p; return answer(200, { project: id, messages: [{ role: 'user', text: id }], truncated: false }); });
  const a = store.open('chat-a', 'A'); assert.equal(store.getSnapshot().status, 'loading');
  const b = store.open('chat-b', 'B'); gates['chat-b'].go(); await b; gates['chat-a'].go(); await a;
  assert.deepEqual(asked, ['chat-a', 'chat-b']); assert.equal(store.getSnapshot().request.sessionId, 'chat-b');
  assert.equal(store.getSnapshot().data.project, 'chat-b', 'the late answer of the older chat is dropped');
  assert.ok(store.markdown(t).includes('\n\nchat-b\n'));
  store.close(); assert.equal(store.getSnapshot().request, null); assert.equal(store.markdown(t), undefined);
  const late = store.open('chat-c', 'C'); store.close(); gates['chat-c'].go(); await late; assert.equal(store.getSnapshot().request, null, 'an answer after Close does not open it again');
  const failing = createExportChat(async () => answer(500, { error: 'disk' })); await failing.open('x', 'X');
  assert.equal(failing.getSnapshot().status, 'error'); assert.equal(failing.getSnapshot().error, 'disk');
  const old = createExportChat(async () => answer(404, {})); await old.open('x', 'X'); assert.match(old.getSnapshot().error, /restart dsh/);
}

// Dialog: Copy and Save only when ready; Copy writes the Markdown in the click; Save downloads `<title>.md` and closes.
{
  const store = createExportChat(async () => answer(200, { project: 'recipe-box', messages: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: code }], truncated: true }));
  assert.equal(ExportChatDialog({ exportChat: store, t }), null, 'nothing while closed');
  const pending = store.open('chat-1', 'Login: bug');
  let dialog = ExportChatDialog({ exportChat: store, t });
  const buttons = (d) => d.p.footer.c; const copyButton = (d) => buttons(d).find((b) => b.p['data-composer-plus-export-copy'] === '');
  const saveButton = (d) => buttons(d).find((b) => b.p['data-composer-plus-export-save'] === '');
  assert.equal(dialog.t, 'Modal'); assert.equal(dialog.p.title, 'exportChat.title'); assert.equal(dialog.p.description, 'Login: bug');
  assert.equal(copyButton(dialog).p.disabled, true); assert.equal(saveButton(dialog).p.disabled, true, 'disabled while loading');
  assert.equal(dialog.c[0].c[0], 'exportChat.loading');
  await pending; dialog = ExportChatDialog({ exportChat: store, t });
  assert.equal(copyButton(dialog).p.disabled, false);
  assert.equal(dialog.c[0].c[0], 'exportChat.summary(2) exportChat.truncated', 'the count and the truncation note');
  copyButton(dialog).p.onClick(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(clipboard.length, 1); assert.ok(clipboard[0].startsWith('# Login: bug\n\nexportChat.project(recipe-box)'));
  assert.ok(clipboard[0].includes('```js\nconst a = 1;\n```'), 'the code block is kept'); assert.ok(clipboard[0].endsWith('> exportChat.truncated\n'));
  dialog = ExportChatDialog({ exportChat: store, t }); assert.ok(dialog.c[0].c[0].endsWith(' · exportChat.copied'));
  clipboardOk = false; copyButton(dialog).p.onClick(); await new Promise((r) => setTimeout(r, 0));
  dialog = ExportChatDialog({ exportChat: store, t }); assert.ok(dialog.c[0].c[0].endsWith(' · exportChat.copyFailed')); clipboardOk = true;
  saveButton(dialog).p.onClick();
  assert.equal(clicks.length, 1); assert.equal(clicks[0].download, 'Login- bug.md');
  const blob = blobs.get(clicks[0].href); assert.equal(blob.type, 'text/markdown;charset=utf-8'); assert.equal(await blob.text(), clipboard[0], 'the file holds the same Markdown');
  assert.equal(store.getSnapshot().request, null, 'Save closes the dialog');
  // The error state shows the reason and keeps Copy and Save off.
  // A copy that ends after the dialog closed and another chat opened leaves no note in the new one.
  {
    const two = createExportChat(async (id) => answer(200, { project: id, messages: [{ role: 'user', text: id }], truncated: false }));
    await two.open('a', 'A'); let slow; clipboardOk = new Promise((r) => { slow = r; });
    const d = ExportChatDialog({ exportChat: two, t }); copyButton(d).p.onClick();
    two.close(); await two.open('b', 'B'); slow(true); await new Promise((r) => setTimeout(r, 0));
    assert.equal(two.getSnapshot().note, null, 'a late copy result does not show in the next export'); clipboardOk = true;
  }
  const failing = createExportChat(async () => answer(500, { error: 'disk' })); await failing.open('x', 'X');
  dialog = ExportChatDialog({ exportChat: failing, t });
  assert.equal(copyButton(dialog).p.disabled, true); assert.equal(dialog.c[1].p.role, 'alert'); assert.equal(dialog.c[1].c[0], 'exportChat.failed(disk)');
}

// Menu item: closes dsh's menu and opens the dialog with the chat's title.
{
  const menu = []; const opened = [];
  const item = ExportChatItem({ sessionId: 'chat-a', useMenuOpenState: () => [true, (v) => menu.push(v)], exportChat: { open: (...a) => opened.push(a) }, titleOf: () => 'Weekend menu', t });
  assert.equal(item.t, 'MenuItemButton'); assert.equal(item.c[0], 'exportChat.menu');
  item.p.onSelect(); assert.deepEqual(menu, [false]); assert.deepEqual(opened, [['chat-a', 'Weekend menu']]);
  ExportChatItem({ sessionId: 'chat-b', useMenuOpenState: () => [true, () => {}], exportChat: { open: (...a) => opened.push(a) }, titleOf: () => undefined, t }).p.onSelect();
  assert.deepEqual(opened.at(-1), ['chat-b', 'chat-b'], 'an untitled chat uses its id');
}

// Switch: on by default; switching it off removes the menu item and the dialog and closes an open export.
{
  let next = 0; const live = new Map();
  const slots = { inject: (name, f) => { const off = f(); return () => off(); }, register: (o) => { const k = `${o.name}#${o.id ?? o.key}#${next++}`; live.set(k, o); return () => live.delete(k); } };
  const ctx = { slots, configForms: { get: () => ({}) }, effect: () => {}, locale: { register: () => () => {}, bind: () => (k) => k, getLocale: () => ({ active: 'en', locales: [] }) },
    sessions: { list: { getSnapshot: () => ({ byId: { 'chat-a': { displayTitle: 'Weekend menu' } } }) } }, get: () => undefined, inject: () => ({ dispose() {} }) };
  plugin.apply(ctx);
  const ids = () => [...live.values()].map((o) => o.id);
  assert.ok(ids().includes('export-markdown') && ids().includes('export-markdown-dialog'), 'on by default');
  const item = [...live.values()].find((o) => o.id === 'export-markdown');
  assert.equal(item.name, 'sidebar.workspaces.session.menu.item'); assert.equal(item.order, 470, 'after Copy session link (460)');
  const shared = item.inject(); assert.equal(shared.titleOf('chat-a'), 'Weekend menu');
  globalThis.fetch = async () => answer(200, { project: 'p', messages: [], truncated: false });
  await shared.exportChat.open('chat-a', 'Weekend menu'); assert.equal(shared.exportChat.getSnapshot().status, 'ready');
  const settings = [...live.values()].find((o) => o.id === 'composer-plus');
  settings.inject().setFeature('exportMarkdown', false);
  assert.ok(!ids().includes('export-markdown') && !ids().includes('export-markdown-dialog'), 'switched off: the item and the dialog go away');
  assert.equal(shared.exportChat.getSnapshot().request, null, 'and an open export closes');
  settings.inject().setFeature('exportMarkdown', true); assert.ok(ids().includes('export-markdown'), 'switching on again reinstalls');
}
console.log('export-chat checks passed');
