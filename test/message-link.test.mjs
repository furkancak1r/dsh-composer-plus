// Copy message link (client half): the real client.js link format (dsh's own session reference reads the part before `#`,
// checked with dsh's decoder when a dsh install is found), the strict parser, the user-text rule that finds a link in a
// message (bare or as a `@[label](link)` mention, before dsh's own session rule), and the opener: it opens the chat,
// loads older history until the message is there, scrolls the nearest visible row at or before the seq to the middle,
// lets it blink 2 s, says so when the message is gone, and runs one jump at a time.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hook = '    /** Turn rollback (client half).';
assert.ok(src.includes(hook));
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(src.replace(hook, '    globalThis.__ml = { messageLink, parseMessageLink, messageLinkRule, jumpToMessage, MessageLinkChip, MESSAGE_LINK_RULE_ID };\n' + hook));
mod.factory((n) => (n === 'react' ? { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }) } : {}));
const { messageLink, parseMessageLink, messageLinkRule, jumpToMessage, MessageLinkChip, MESSAGE_LINK_RULE_ID } = globalThis.__ml;

// 1. Format: dsh-session:<base64url(JSON id)>#<seq>; round trip; dsh's own decoder reads the part before '#'.
const ids = ['session-fd7c92c7-787f-40dc-b837-95b53cc19c98', 'ğüş "q" ✓', 'a'];
const candidates = [`${homedir()}/Documents/testdeepseekharness/work/dsh-0.2.1-rc.2/node_modules/@deepseek-ai/dsh-session-reference/lib/index.js`,
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-reference/lib/index.js'];
const refPath = candidates.find(existsSync);
const dsh = refPath === undefined ? null : await import(refPath);
for (const id of ids) {
  const link = messageLink(id, 42);
  assert.match(link, /^dsh-session:[A-Za-z0-9_-]+#42$/);
  assert.deepEqual(parseMessageLink(link), { sessionId: id, seq: 42 });
  if (dsh) {
    assert.equal(link.split('#')[0], dsh.encodeSessionReferenceUri(id));
    const parsed = dsh.parseSessionReferenceText(`see ${link} now`);
    assert.deepEqual(parsed.references.map((r) => r.sessionId), [id], 'dsh still attaches the chat as context');
  }
}
// The parser refuses anything else: no seq, a sign, a fraction, a non-canonical payload, a non-string id, junk.
const good = messageLink('abc', 7);
for (const bad of [good.split('#')[0], `${good.split('#')[0]}#-1`, `${good.split('#')[0]}#1.5`, `${good.split('#')[0]}#`, `${good}x`,
  `dsh-session:${Buffer.from('42').toString('base64url')}#1`, `dsh-session:${Buffer.from('"abc"').toString('base64')}=#1`, 'dsh-session:!!#1', `x${good}`, '']) {
  assert.equal(parseMessageLink(bad), undefined, `refuses ${bad}`);
}

// 2. The user-text rule: before dsh's session rule (order 10); a bare link and a mention; a plain session link is left to dsh.
assert.equal(messageLinkRule.id, MESSAGE_LINK_RULE_ID); assert.ok(messageLinkRule.order < 10);
const text = `See ${good} and @[Old chat](${messageLink('x', 3)}) but not ${good.split('#')[0]} here.`;
const m1 = messageLinkRule.match(text, 0);
assert.deepEqual([m1.start, text.slice(m1.start, m1.end), m1.data], [4, good, { sessionId: 'abc', seq: 7, label: null }]);
const m2 = messageLinkRule.match(text, m1.end);
assert.equal(text.slice(m2.start, m2.end), `@[Old chat](${messageLink('x', 3)})`); assert.deepEqual(m2.data, { sessionId: 'x', seq: 3, label: 'Old chat' });
assert.equal(messageLinkRule.match(text, m2.end), undefined, 'a session link without #seq is dsh\'s own');
assert.equal(messageLinkRule.match('no links', 0), undefined);
assert.equal(messageLinkRule.match(`@[x](dsh-session:!!#1) ${good}`, 0).start, 23, 'a broken mention is skipped, the next link matches');
// After sending, dsh stores the link as `@<chat id>#<seq>` (its session reference took the `dsh-session:` part).
{
  const sent = 'look at @session-5e87ba98-b640-4cc7-b8a7-877edc05c3aa#5 please';
  const m = messageLinkRule.match(sent, 0);
  assert.deepEqual([sent.slice(m.start, m.end), m.data], ['@session-5e87ba98-b640-4cc7-b8a7-877edc05c3aa#5', { sessionId: 'session-5e87ba98-b640-4cc7-b8a7-877edc05c3aa', seq: 5, label: null }]);
  assert.equal(messageLinkRule.match('mail me @someone#5 or @session-x#5x', 0), undefined, 'only a chat id with a whole seq');
  // Mixed order: a bare link after many mentions, and a mention after a broken bare link.
  const mixed = `${'@a '.repeat(50)}${good}`;
  assert.equal(messageLinkRule.match(mixed, 0).start, 150);
  const after = `dsh-session:!!#1 @session-x#2`;
  assert.deepEqual(messageLinkRule.match(after, 0).data, { sessionId: 'session-x', seq: 2, label: null });
  // A long message with many `@` and no link: each search goes forward only (it was a new scan per `@`).
  // 1 MB of `@`: about 10 ms with the forward search, about 7 s with a new scan per `@` (measured, Apple M-series).
  const many = '@'.repeat(1000000);
  const started = performance.now(); assert.equal(messageLinkRule.match(many, 0), undefined);
  assert.ok(performance.now() - started < 1000, 'a linear scan');
}
// The chip opens the link; a double-click (text selection) does not.
const opened = [];
const chip = MessageLinkChip({ node: { data: { sessionId: 'abc', seq: 7, label: null } }, raw: good, open: (l) => opened.push(l), t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k) });
assert.equal(chip.t, 'button'); assert.deepEqual(chip.c, ['messageLink.chip:{"seq":"7"}']);
chip.p.onClick({ detail: 1, stopPropagation() {} }); chip.p.onClick({ detail: 2, stopPropagation() {} });
assert.deepEqual(opened, [{ sessionId: 'abc', seq: 7 }]);

// 3. The opener, on a fake chat view: rows with node keys; the chat snapshot maps keys to nodes (seq / anchorSeq).
const makeRow = (key) => {
  const attrs = new Map();
  return { dataset: { chatAnchorKey: key }, offsetParent: {}, getClientRects: () => [1], scrolled: 0,
    scrollIntoView() { this.scrolled += 1; }, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k) };
};
let rows = []; let nodes = new Map();
const doc = { querySelectorAll: (sel) => (sel === '[data-chat-anchor-key]' ? rows : rows.filter((r) => r.hasAttribute('data-composer-plus-jump'))) };
const setChat = (list) => { rows = list.map(([key]) => makeRow(key)); nodes = new Map(list.map(([key, node]) => [key, node])); };
const queue = []; const wait = (fn) => { queue.push(fn); return queue.length; };
const drain = async (max = 100) => { for (let i = 0; i < max && queue.length > 0; i++) { queue.shift()(); await new Promise((r) => setTimeout(r, 0)); } };
const calls = { open: [], load: [], notify: [] };
const env = { doc, wait, openSession: (id) => calls.open.push(id), chatOf: () => (rows.length === 0 ? undefined : { nodes }),
  loadThrough: (id, seq) => { calls.load.push([id, seq]); setChat(older); }, notify: (k) => calls.notify.push(k) };
// The loaded window starts at seq 40; the message 12 is older: the opener loads through 12, then lands on it.
const older = [['u1', { kind: 'user', anchorSeq: 5, data: { seq: 5 } }], ['a1', { kind: 'assistant-step', anchorSeq: 9 }], ['u2', { kind: 'user', anchorSeq: 12, data: { seq: 12 } }],
  ['t2', { kind: 'turn-tail', anchorSeq: 20 }], ['u3', { kind: 'user', anchorSeq: 40, data: { seq: 40 } }]];
setChat(older.slice(4));
jumpToMessage({ sessionId: 'chat-a', seq: 12 }, env);
await drain();
assert.deepEqual(calls.open, ['chat-a']); assert.deepEqual(calls.load, [['chat-a', 12]], 'older history is loaded once');
const u2 = rows.find((r) => r.dataset.chatAnchorKey === 'u2');
assert.equal(u2.scrolled, 1); assert.equal(u2.hasAttribute('data-composer-plus-jump'), true, 'the message blinks');
// A seq inside a hidden group (a tool call at 15): the nearest visible row before it.
rows.find((r) => r.dataset.chatAnchorKey === 't2').offsetParent = null; rows.find((r) => r.dataset.chatAnchorKey === 't2').getClientRects = () => [];
jumpToMessage({ sessionId: 'chat-a', seq: 15 }, env); await drain();
assert.equal(u2.scrolled, 2, 'the nearest visible row at or before the seq');
assert.equal(rows.filter((r) => r.hasAttribute('data-composer-plus-jump')).length, 1, 'a new jump stops the old blink');
// A chat that never shows (not found, archived): a notice, no endless retry.
rows = []; calls.notify.length = 0;
jumpToMessage({ sessionId: 'gone', seq: 3 }, env); await drain(200);
assert.deepEqual(calls.notify, ['messageLink.notFound']);
// openSession throws (no workspace service): a notice at once.
jumpToMessage({ sessionId: 'x', seq: 1 }, { ...env, openSession: () => { throw new Error('no'); } });
assert.equal(calls.notify.length, 2);
// One jump at a time: a second jump stops the first (it never scrolls later).
setChat(older); queue.length = 0;
const r5 = rows.find((r) => r.dataset.chatAnchorKey === 'u1');
const stop = jumpToMessage({ sessionId: 'chat-a', seq: 5 }, { ...env, chatOf: () => undefined });
jumpToMessage({ sessionId: 'chat-a', seq: 40 }, env); await drain();
assert.equal(r5.scrolled, 0, 'the first jump was stopped'); assert.equal(typeof stop, 'function');

// 4. The feature: its own switch and screenshot; a header-slot component; the chip only where dsh has user-text rules.
assert.match(src, /'copyDeeplink', 'copyMessageLink',/);
assert.match(src, /const userText = scope.uiConversation\?\.userText;\n\s+if \(userText\?\.register === undefined\) return;/);
console.log('message link checks passed' + (dsh ? ' (verified with dsh decoder)' : ''));
