// Damon reply cards (assistantReplyCards; Furkan, 2026-11-25): each reply of the Damon chat shows as a card in the style
// of the Kararlar cards, the chat is hidden behind them (Sohbeti göster / Sohbeti gizle, kept in this browser), the
// message box stays.
// - replyCardsOf: one card per settled reply that dsh shows (a step with text and no tool call, or its turn's closing
//   answer) and per failed turn; not a reply that is only [quiet], not a quiet turn, not a withdrawn reply (rule 9: Turn
//   rollback's and dsh-rewind-plugin's spans) and not a fork's inherited one (rule 10).
// - replyParts: the bold first line is the title, "Senden:" the action line, `onay` blocks the approval sentences, the
//   option list at the end the option buttons, [!DETAILS] stays closed.
// - Read marks: at the first view every older reply is read; a click or a button marks a card read; the newest unread
//   card is first; junk in storage reads as empty; another window's marks are merged.
// - ReplyCard: Onayla only on the card that holds the chat's newest approval offer, option buttons only on the card of
//   the choice offer, both through Option picks' store (one send per chat); an older card shows them as text.
// - The feature: its own switch (dock seat + overlay entry, removed when off), the chat toggle in the status panel.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { body: { tag: 'body' }, querySelector: () => null, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
const ANCHOR = '/** Feature switches, in Settings order.';
const src = read('client.js');
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__rc = { replyCardsOf, replyParts, readReplyMarks, markReplies, replyUnread, replyOrder, createReplyRead, ReplyCard, REPLY_READ_KEY, REPLY_SHOWN_KEY };\n    ${ANCHOR}`));
const h = (t, p, ...c) => ({ t, p: p ?? {}, c });
const React = { createElement: h, Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }), useEffect() {}, useLayoutEffect() {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f };
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host, key) => ({ portal: el, host, key }) } : {}));
const { replyCardsOf, replyParts, readReplyMarks, markReplies, replyUnread, replyOrder, createReplyRead, ReplyCard, REPLY_READ_KEY, REPLY_SHOWN_KEY } = globalThis.__rc;
const find = (n, pred) => { if (n === null || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap((c) => find(c, pred)); return [...(pred(n) ? [n] : []), ...(n.c ?? []).flat(Infinity).flatMap((c) => find(c, pred))]; };
const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : n?.c ? text(n.c) : '');

// dsh's chat nodes (dsh-client-ui-chat 0.2.2: assistant-step { status, turn, step, blocks, finalNode: { seq, time } },
// turn-tail { turn, closing }, turn-error { seq, turn, time, message, code }).
const step = (turn, stepN, seq, blocks, status = 'settled') => ({ key: `s${seq}`, kind: 'assistant-step', data: { status, turn, step: stepN, blocks, time: seq * 1000, ...(status === 'running' ? {} : { finalNode: { seq, time: seq * 1000 } }) } });
const tail = (turn, closingSeq) => ({ key: `t${turn}`, kind: 'turn-tail', data: { turn, seq: closingSeq + 1, closing: { finalNode: { seq: closingSeq } } } });
const txt = (s) => ({ kind: 'text', text: s }); const tool = { kind: 'tool-call', callId: 'c', name: 'bash', argsRaw: '{}' };
const chatOf = (nodes) => ({ nodes: new Map(nodes.map((n) => [n.key, n])) });
{
  const chat = chatOf([
    step(1, 0, 10, [txt('Bakıyorum.'), tool]), // a step with a tool call that is not the closing answer: dsh folds it
    step(1, 1, 12, [txt('**Rapor hazır.** Ayrıntılar aşağıda.')]), tail(1, 12),
    step(2, 0, 20, [txt('[quiet]')]), tail(2, 20), // only [quiet]
    step(3, 0, 30, [txt(' [Quiet] ')]), step(3, 1, 31, [txt('[quiet]'), tool]), tail(3, 31), // a quiet turn
    step(4, 0, 40, [txt('Ara yanıt.')]), step(4, 1, 41, [tool]), step(4, 2, 42, [txt('Son yanıt.'), tool]), tail(4, 42), // a reply mid-turn, and a closing answer with a tool call
    step(5, 0, 50, [txt('Yazıyor…')], 'running'), // still streaming
    { key: 'e6', kind: 'turn-error', data: { seq: 60, time: 60000, turn: 6, step: 0, message: 'Provider rejected the request (HTTP 400)', code: 'X' } },
    step(7, 0, 70, [{ kind: 'reasoning', text: 'düşünce' }, txt('   ')]), tail(7, 70), // no text
  ]);
  const cards = replyCardsOf(chat);
  assert.deepEqual(cards.map((c) => [c.kind, c.seq]), [['reply', 12], ['reply', 40], ['reply', 42], ['error', 60]], 'the replies that dsh shows and the failed turn');
  assert.equal(cards[0].text, '**Rapor hazır.** Ayrıntılar aşağıda.'); assert.equal(cards[3].message, 'Provider rejected the request (HTTP 400)');
  assert.equal(replyCardsOf(chat), cards, 'one parse per snapshot');
  // Rule 9: a reply inside a withdrawn span (Turn rollback or dsh-rewind-plugin: both come in `withdrawn`) is left out.
  assert.deepEqual(replyCardsOf(chat, [[38, 45]]).map((c) => c.seq), [12, 60], 'a rollback withdrew turn 4');
  assert.deepEqual(replyCardsOf(chat, [[60, 61]]).map((c) => c.seq), [12, 40, 42], 'a withdrawn failed turn');
  // Rule 10: a fork's inherited events (below `inherited`) are the parent's.
  assert.deepEqual(replyCardsOf(chat, [], 41).map((c) => c.seq), [42, 60], 'a fork shows only its own replies');
  assert.deepEqual(replyCardsOf({ nodes: new Map() }), [], 'an empty chat'); assert.deepEqual(replyCardsOf(undefined), [], 'no chat');
}

// replyParts.
{
  const labels = { problem: 'Sorun', details: 'Ayrıntılar' };
  const p = replyParts([
    '**Deploy paketi hazır.** Testler geçti.',
    '',
    'Senden: test sunucusunda Gerekli Tarih alanını aç.',
    '',
    '> [!PROBLEM]',
    '> Gece denetimi bir kez zaman aşımına uğradı.',
    '',
    '> [!DETAILS] Test çıktısı',
    '> 412 test geçti.',
    '',
    '```onay',
    "Onaylıyorum (canlı değil): deploy paketi test dalı main'e alınsın.",
    '```',
    '',
    '**Seçenekler:**',
    '1. Hemen al (Önerilen)',
    '2. Yarın al',
  ].join('\n'), labels);
  assert.equal(p.title, 'Deploy paketi hazır.', 'the bold first line is the title');
  assert.equal(p.forYou, 'test sunucusunda Gerekli Tarih alanını aç.', 'the Senden line');
  assert.deepEqual(p.approvals, ["Onaylıyorum (canlı değil): deploy paketi test dalı main'e alınsın."], 'the onay block');
  assert.deepEqual(p.options.map((o) => [o.n, o.label, o.recommended]), [[1, 'Hemen al', true], [2, 'Yarın al', false]], 'the option list');
  assert.deepEqual(p.details, [{ summary: 'Test çıktısı', body: '412 test geçti.' }], '[!DETAILS] stays closed');
  assert.match(p.body, /^Testler geçti\./, 'the rest of the first line starts the body');
  assert.match(p.body, /> \*\*Sorun\*\*\n> Gece denetimi/, 'another callout keeps its label');
  for (const gone of ['```onay', 'Seçenekler', 'Hemen al', 'Senden:', '[!DETAILS]', '412 test']) assert.ok(!p.body.includes(gone), `not in the body: ${gone}`);
  assert.equal(replyParts('# Durum\nHer şey yolunda.').title, 'Durum', 'a heading is the title');
  assert.deepEqual([replyParts('Bitti. Rapor gönderildi.').title, replyParts('Bitti. Rapor gönderildi.').body], ['Bitti.', 'Rapor gönderildi.'], 'else the first sentence');
  assert.equal(replyParts('**For you:** open the port.').forYou, 'open the port.', 'the English mark, in bold');
  assert.equal(replyParts('```\nSenden: kod\n```').forYou, '', 'not inside a code block');
  assert.deepEqual(replyParts('Metin\n```onay\nAçık blok').approvals, [], 'an unclosed block is no approval');
  assert.match(replyParts('Metin\n```onay\nAçık blok').body, /Açık blok/, 'it stays text');
  assert.equal(replyParts('a'.repeat(300)).title.length, 160, 'a long line is cut');
}

// Read marks.
{
  assert.deepEqual(readReplyMarks(), {}, 'nothing saved');
  for (const junk of ['{', '[]', '42', '{"s":{"floor":"1"}}', '{"s":null}']) { mem.set(REPLY_READ_KEY, junk); assert.deepEqual(readReplyMarks(), {}, `junk: ${junk}`); }
  mem.set(REPLY_READ_KEY, '{"s":{"floor":5,"read":[7,"x",9]}}'); assert.deepEqual(readReplyMarks(), { s: { floor: 5, read: [7, 9] } }, 'only numbers');
  mem.delete(REPLY_READ_KEY);
  const m = { floor: 10, read: [] };
  assert.equal(replyUnread(m, 10), false); assert.equal(replyUnread(m, 12), true); assert.equal(replyUnread(undefined, 12), false, 'before the first view: no card is new');
  assert.deepEqual(markReplies(m, [14], [12, 14, 16]), { floor: 10, read: [14] }, 'a card in the middle');
  assert.deepEqual(markReplies({ floor: 10, read: [14] }, [12], [12, 14, 16]), { floor: 14, read: [] }, 'the floor moves over the cards read in a row');
  const order = replyOrder([{ seq: 8 }, { seq: 12 }, { seq: 14 }, { seq: 16 }], { floor: 10, read: [14] });
  assert.deepEqual(order.map((c) => c.seq), [16, 12, 14, 8], 'unread first (newest first), then the read ones');
  const store = createReplyRead(); let calls = 0; store.subscribe(() => { calls += 1; });
  store.start('s', 30); assert.deepEqual(store.of('s'), { floor: 30, read: [] }, 'the first view: every older reply is read');
  store.start('s', 99); assert.equal(store.of('s').floor, 30, 'only once');
  store.mark('s', [40], [40, 50]); assert.deepEqual(store.of('s'), { floor: 40, read: [] });
  store.mark('s', [40], [40, 50]); assert.equal(calls, 2, 'no write without a change');
  // Another window read 50 meanwhile: a write merges it.
  const other = JSON.parse(mem.get(REPLY_READ_KEY)); other.s = { floor: 50, read: [] }; mem.set(REPLY_READ_KEY, JSON.stringify(other));
  store.mark('s', [60], [40, 50, 60, 70]); assert.deepEqual(JSON.parse(mem.get(REPLY_READ_KEY)).s, { floor: 50, read: [60] }, 'merged with the other window');
  store.all('s', 70); assert.deepEqual(store.of('s'), { floor: 70, read: [] }, 'Tümünü okundu say');
  const blocked = globalThis.localStorage.setItem; globalThis.localStorage.setItem = () => { throw Error('quota'); };
  store.mark('t', [1], [1]); store.start('u', 5); globalThis.localStorage.setItem = blocked; // no throw
  assert.equal(store.of('u').floor, 5, 'storage blocked: this page only');
}

// ReplyCard: buttons only on the card of the offer, through picks.pick.
{
  const t = (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`);
  const sentence = "Onaylıyorum (canlı değil): deploy paketi test dalı main'e alınsın.";
  const textOfReply = `**Hazır.**\n\n\`\`\`onay\n${sentence}\n\`\`\`\n\n**Seçenekler:**\n1. Hemen al (Önerilen)\n2. Yarın al`;
  const card = { kind: 'reply', seq: 42, turn: 4, time: Date.now(), text: textOfReply };
  const offerNow = { offer: { seq: 42, latest: 4, options: [{ n: 1, text: sentence, label: sentence, message: sentence, from: 42 }] }, state: { busy: false, error: null }, empty: true };
  const choiceNow = { offer: { seq: 42, latest: 4, options: [{ n: 1, label: 'Hemen al', text: 'Hemen al', recommended: true }, { n: 2, label: 'Yarın al', text: 'Yarın al', recommended: false }] }, state: { busy: false, error: null }, empty: true };
  const picked = []; const picks = { pick: (id, o, n) => { picked.push([id, o.seq, n]); return Promise.resolve(true); } };
  const reads = [];
  const draw = (props) => ReplyCard({ card, sessionId: 's', unread: true, first: true, offerNow, choiceNow, picks, t, lang: 'tr', onRead: (seq) => reads.push(seq), ...props });
  let tr = draw();
  assert.equal(tr.t, 'article'); assert.equal(tr.p['data-unread'], ''); assert.equal(tr.p['data-first'], ''); assert.equal(tr.p.tabIndex, 0, 'a card takes the focus');
  assert.equal(text(find(tr, (n) => n.p.className === 'cp-rc-new')[0]), 'replies.new', 'the New label');
  assert.equal(text(find(tr, (n) => n.t === 'h3')[0]), 'Hazır.', 'the title');
  const ok = find(tr, (n) => n.t === 'button' && n.p['data-composer-plus-approve'] === 'reply');
  assert.equal(ok.length, 1, 'Onayla on the card that holds the block'); assert.equal(text(ok[0]), 'approve.button');
  ok[0].p.onClick(); assert.deepEqual(picked, [['s', 42, 1]], 'the same send path as the panel (picks.pick)'); assert.deepEqual(reads, [42], 'a button marks it read');
  const opts = find(tr, (n) => n.t === 'button' && n.p.className === 'cp-rc-opt');
  assert.deepEqual(opts.map((b) => b.p['data-option']), ['1', '2'], 'the option buttons'); assert.equal(opts[0].p['data-recommended'], '', 'the recommended one');
  opts[1].p.onClick(); assert.deepEqual(picked.at(-1), ['s', 42, 2], 'an option goes through picks.pick');
  tr.p.onClick(); assert.deepEqual(reads.at(-1), 42, 'a click on the card marks it read');
  tr.p.onKeyDown({ key: 'Enter', target: 'self', currentTarget: 'self' }); assert.equal(reads.length, 4, 'Enter on the card too');
  // An older card (another seq), a draft in the composer, a busy send: no buttons, the sentences and options as text.
  for (const props of [{ card: { ...card, seq: 30 } }, { offerNow: { ...offerNow, empty: false }, choiceNow: { ...choiceNow, empty: false } }]) {
    tr = draw(props);
    assert.equal(find(tr, (n) => n.t === 'button').length, 0, 'no buttons');
    assert.ok(text(tr).includes(sentence) && text(tr).includes('1. Hemen al'), 'the sentence and the options as text');
  }
  tr = draw({ offerNow: { ...offerNow, state: { busy: true, error: null } } });
  assert.equal(find(tr, (n) => n.p['data-composer-plus-approve'] === 'reply')[0].p.disabled, true, 'busy: Onayla is off');
  tr = draw({ offerNow: { ...offerNow, state: { busy: false, error: 'boom' } } });
  assert.equal(text(find(tr, (n) => n.p.role === 'alert')[0]), 'approve.failed:{"error":"boom"}', 'a failed send says why');
  tr = ReplyCard({ card: { kind: 'error', seq: 60, time: 60000, message: 'HTTP 400' }, sessionId: 's', t, lang: 'tr', picks });
  assert.equal(tr.p['data-kind'], 'error'); assert.equal(text(find(tr, (n) => n.t === 'h3')[0]), 'replies.failed', 'a failed turn');
  assert.equal(ReplyCard({ card, sessionId: 's', t, lang: 'tr', picks, focusable: false }).p.tabIndex, undefined, 'on the canvas its frame takes the focus');
}

// The feature: its switch, Settings screenshot, category, chat toggle key.
assert.match(src, /const FEATURES = \[[^\]]*'assistantReplyCards'/, 'its own switch'); assert.match(src, /const SHOT_OF = \{[^}]*assistantReplyCards: 'assistantReplyCards'/, 'its screenshot');
assert.match(src, /assistant: \[[^\]]*'assistantReplyCards'\]/, 'in the Assistant category'); assert.ok(!/const OFF_BY_DEFAULT = \[[^\]]*'assistantReplyCards'/.test(src), 'on by default');
assert.equal(REPLY_SHOWN_KEY, 'dsh-composer-plus.assistant-chat-shown');
console.log('reply-cards: ok');
