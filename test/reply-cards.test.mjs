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
eval(src.replace(ANCHOR, `globalThis.__rc = { failureTextOf, replyCardsOf, replyParts, readReplyMarks, markReplies, replyUnread, replyOrder, createReplyRead, replySig, chatStateKey, ReplyCard, ReplyFeed, replyPage, REPLY_PAGE, REPLY_MAX, REPLY_READ_KEY, REPLY_SHOWN_KEY };\n    ${ANCHOR}`));
const h = (t, p, ...c) => ({ t, p: p ?? {}, c });
// A small hook runtime (by call order) for ReplyFeed: state, refs and effects with deps (run after each draw).
let hooks = []; let hi = 0; let pending = [];
const changed = (a, b) => a === undefined || b === undefined || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
const React = { createElement: h, Fragment: 'F', useState: (v) => { const i = hi++; if (!(i in hooks)) hooks[i] = typeof v === 'function' ? v() : v; return [hooks[i], (x) => { hooks[i] = typeof x === 'function' ? x(hooks[i]) : x; }]; },
  useRef: (v) => { const i = hi++; return hooks[i] ??= { current: v }; }, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f,
  useLayoutEffect: (f, deps) => { const i = hi++; const old = hooks[i]; if (old === undefined || changed(old.deps, deps)) pending.push(() => { old?.off?.(); hooks[i] = { deps, off: f() }; }); } };
React.useEffect = React.useLayoutEffect;
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host, key) => ({ portal: el, host, key }) } : {}));
const { failureTextOf, replyCardsOf, replyParts, readReplyMarks, markReplies, replyUnread, replyOrder, createReplyRead, replySig, chatStateKey, ReplyCard, ReplyFeed, replyPage, REPLY_PAGE, REPLY_MAX, REPLY_READ_KEY, REPLY_SHOWN_KEY } = globalThis.__rc;
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
  // Review 2: text that asks you for something next to a tool call (not the closing answer) is a card: dsh 0.2.2 shows it
  // in the chat (foldedReplies: all), and the chat is hidden. A plain "looking" line next to a tool call is not.
  const ask = chatOf([
    step(1, 0, 10, [txt('Bakıyorum.'), tool]),
    step(1, 1, 11, [txt("Dal hazır.\n\n```onay\nOnaylıyorum (canlı değil): dal main'e alınsın.\n```"), tool]),
    step(1, 2, 12, [txt('**Seçenekler:**\n1. Hemen\n2. Yarın'), tool]),
    step(1, 3, 13, [txt('Senden: portu aç.'), tool]),
    step(1, 4, 14, [txt('Bitti.')]), tail(1, 14),
  ]);
  assert.deepEqual(replyCardsOf(ask).map((c) => c.seq), [11, 12, 13, 14], 'an approval, options or a Senden line next to a tool call is a card');
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
  // A reply that starts with a list: no title from a list line, the list stays whole (review 6).
  assert.deepEqual([replyParts('1. Testleri çalıştır.\n2. Dalı birleştir.').title, replyParts('1. Testleri çalıştır.\n2. Dalı birleştir.').body], ['', '1. Testleri çalıştır.\n2. Dalı birleştir.'], 'a numbered list');
  assert.deepEqual([replyParts('- Testler geçti.\n- Derleme yeşil.').title, replyParts('- Testler geçti.\n- Derleme yeşil.').body], ['', '- Testler geçti.\n- Derleme yeşil.'], 'a bullet list');
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
  // dsh's turn-tail node is the newest node at its turn's end seq + 0.1 (review 1): the floor is a whole seq, so a new
  // reply stays New after a reload (a fraction was dropped at the next load and made every card read).
  const chat = chatOf([step(1, 0, 42, [txt('Eski yanıt.')]), tail(1, 42)]); [...chat.nodes.values()][1].anchorSeq = 43.1;
  store.start('f', Number(chatStateKey(chat).split(':')[1])); assert.deepEqual(store.of('f'), { floor: 43, read: [] }, 'a whole floor');
  const reloaded = createReplyRead(); assert.equal(replyUnread(reloaded.of('f'), 50), true, 'a newer reply is still New after a reload');
  store.all('f', 60.1); assert.equal(createReplyRead().of('f').floor, 60, 'Tümünü okundu say: a whole floor too');
  // A streamed chunk is no new state for the cards (no draw at each frame); a settled step is.
  const live = (text, status) => chatOf([step(1, 0, 42, [txt(text)], status)]);
  assert.equal(replySig(live('Yazı', 'running')), replySig(live('Yazıyor, uzun', 'running')), 'a chunk: the same state');
  assert.notEqual(replySig(live('Yazı', 'running')), replySig(live('Yazı', 'settled')), 'it settles: a new state');
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
  // Review 8: a known failure code shows dsh's own text in the UI language (its `chat` dictionary), as dsh's chat does;
  // the node's English message or bare code only when this dsh has no text for it.
  const failure = (code) => ({ INTERRUPTED: 'DSH süreci bu tur bitmeden kapandı.' })[code] ?? '';
  const errBody = (c) => text(find(ReplyCard({ card: { kind: 'error', seq: 61, time: 61000, ...c }, sessionId: 's', t, lang: 'tr', picks, failure }), (n) => n.p?.className === 'cp-rc-body')[0]);
  assert.equal(errBody({ code: 'INTERRUPTED', message: 'The DSH process exited before this turn finished.' }), 'DSH süreci bu tur bitmeden kapandı.', 'a known code: dsh\'s text');
  assert.equal(errBody({ code: 'QUOTA', message: '' }), 'QUOTA', 'no text in this dsh: the code');
  assert.equal(errBody({ code: 'X', message: 'HTTP 400' }), 'HTTP 400', 'an unknown code: the message');
  const known = replyCardsOf(chatOf([{ key: 'e', kind: 'turn-error', data: { seq: 5, time: 5000, turn: 1, message: '', code: 'QUOTA' } }]));
  assert.deepEqual([known[0].message, known[0].code], ['', 'QUOTA'], 'the card keeps the code');
  // The real lookup: dsh's `chat` dictionary through bind; a key that comes back (no text in this dsh, as INTERRUPTED on
  // 0.2.0) is no text; an unknown or inherited name is not looked up; a throwing bind is no text.
  const dict = { 'message.failure.interrupted': 'DSH süreci kapandı.' }; const asked = [];
  const locale = { bind: (ns) => (key) => { asked.push(`${ns}/${key}`); return dict[key] ?? key; } };
  assert.equal(failureTextOf(locale, 'INTERRUPTED'), 'DSH süreci kapandı.', 'dsh\'s text'); assert.deepEqual(asked, ['chat/message.failure.interrupted'], 'in the chat namespace');
  assert.equal(failureTextOf(locale, 'ACCOUNT_QUOTA'), '', 'the key came back: no text');
  for (const code of ['X', 'constructor', 'toString', undefined]) assert.equal(failureTextOf(locale, code), '', `not looked up: ${code}`);
  assert.equal(asked.length, 2, 'only the known codes are looked up');
  assert.equal(failureTextOf({ bind: () => { throw Error('boom'); } }, 'AUTH'), '', 'a throwing bind'); assert.equal(failureTextOf(undefined, 'AUTH'), '', 'no locale');
  assert.equal(ReplyCard({ card, sessionId: 's', t, lang: 'tr', picks, focusable: false }).p.tabIndex, undefined, 'on the canvas its frame takes the focus');
}

// Load earlier (Furkan, 2026-11-26: "hepsi birden gözükmesin öncekini yükle"): the feed draws one page of REPLY_PAGE
// replies first (and every unread card); each click adds one page; the order, the read marks and the New marks stay; a new
// reply shows at once; the first card on screen keeps its place; the label is dsh's own.
{
  assert.equal(REPLY_PAGE, 8, 'the same 8 as the first view of the assistant chat'); assert.equal(REPLY_MAX, 40);
  // replyPage: before a click the newest 8 replies by seq (the parts of one reply stay together), in the given order;
  // after a click every reply from the floor up (`next`: the floor after one more click).
  const list = Array.from({ length: 20 }, (_, i) => ({ seq: 200 - i * 10 })); list.splice(1, 0, { seq: 190, part: 2 }); // 20 replies, one in 2 parts
  let p = replyPage(list);
  assert.deepEqual(p.shown.map((c) => c.seq), [200, 190, 190, 180, 170, 160, 150, 140, 130], 'the first 8 replies, both parts of one');
  assert.deepEqual([p.older, p.next, p.held, p.more], [true, 50, false, 0], 'the next floor: 8 older replies');
  p = replyPage(list, p.next); assert.equal(p.shown.length, 17); assert.equal(p.next, 10, 'the last page has 4 replies');
  p = replyPage(list, p.next); assert.deepEqual([p.shown.length, p.older], [21, false], 'all shown: no button');
  assert.deepEqual([replyPage([]).shown, replyPage([]).older, replyPage([]).next], [[], false, null], 'no reply');
  assert.deepEqual(replyPage(list.slice(0, 5)).shown.length, 5, 'less than a page: all, no button'); assert.equal(replyPage(list.slice(0, 5)).older, false);
  // A new reply after a click: it shows, no loaded card hides.
  assert.equal(replyPage([{ seq: 210 }, ...list], 50).shown.length, 18, 'a new reply comes, the loaded ones stay');
  // A rollback took the newest replies after a click: still at least one page.
  assert.deepEqual(replyPage(list.filter((c) => c.seq <= 100), 90).shown.map((c) => c.seq), [100, 90, 80, 70, 60, 50, 40, 30], 'withdrawn after a click: the newest page');
  // By time, in the given order: an old read card at the top of the order waits for its page.
  const mixed = [{ seq: 5 }, { seq: 6 }, ...Array.from({ length: 9 }, (_, i) => ({ seq: 100 - i }))];
  assert.deepEqual(replyPage(mixed).shown.map((c) => c.seq), [100, 99, 98, 97, 96, 95, 94, 93], 'the newest 8 replies, in the given order');
  assert.deepEqual(replyPage(mixed, replyPage(mixed).next).shown.map((c) => c.seq), mixed.map((c) => c.seq), 'page 2: all, in the given order');
  // An old unread card never waits behind the button: the cut goes down to it (held: the feed keeps that floor).
  p = replyPage(mixed, null, (c) => c.seq === 6);
  assert.deepEqual([p.shown.map((c) => c.seq), p.cut, p.held, p.older], [[6, 100, 99, 98, 97, 96, 95, 94, 93, 92], 6, true, true], 'down to the old unread card');
  // The 40 cap by seq, in either order (newest first, or newest at the bottom); the rest is only in the chat.
  const many = Array.from({ length: 45 }, (_, i) => ({ seq: 1000 - i }));
  for (const order of [many, [...many].reverse()]) {
    let q = replyPage(order); for (let n = 0; q.older && n < 10; n++) q = replyPage(order, q.next);
    assert.deepEqual([q.shown.length, Math.min(...q.shown.map((c) => c.seq)), q.older, q.more], [40, 961, false, 5], 'the newest 40 replies, then the note');
  }
  assert.equal(replyPage(many, null, (c) => c.seq === 955).shown.length, 8, 'an unread card past the 40 cap is only in the chat');

  // ReplyFeed with 20 replies (seq 10…200); the first view read up to 150, and 170 was read with a click.
  const nodes = []; for (let n = 1; n <= 20; n++) nodes.push(step(n, 0, n * 10, [txt(`**Yanıt ${n}.** Gövde.`)]), tail(n, n * 10));
  const chat = chatOf(nodes); let snap = chat; const subs = new Set();
  const source = { getSnapshot: () => snap, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
  const store = createReplyRead(); store.start('feed', 150); store.mark('feed', [170], [160, 170, 180, 190, 200]);
  const replies = { chatOf: () => source, rollback: { subscribe: () => () => {}, of: () => ({ withdrawn: [], inherited: 0 }) }, check: { ask() {}, subscribe: () => () => {}, ready: () => true }, read: store };
  const scroll = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, bottom: 600 }), querySelector: () => null };
  const host = { querySelector: (q) => (q === '[data-conversation-scroll]' ? scroll : null), getBoundingClientRect: () => ({ left: 0, top: 0 }), setAttribute() {}, removeAttribute() {} };
  const flag = (v) => ({ subscribe: () => () => {}, getSnapshot: () => v, set() {} });
  const props = { sessionId: 'feed', host, replies, shown: flag(false), statusSeats: { subscribe: () => () => {}, getSnapshot: () => new Map() }, offers: { subscribe: () => () => {}, of: () => undefined, choiceOf: () => undefined }, picks: {}, locale: () => 'tr', t: (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`) };
  hooks = []; pending = [];
  const render = () => { for (let n = 0; n < 6; n++) { hi = 0; const out = ReplyFeed(props); const run = pending; pending = []; for (const f of run) f(); if (run.length === 0) return out; } throw Error('no stable draw'); };
  const cardsOf = (out) => find(out, (n) => n.t === ReplyCard).map((n) => ({ seq: n.p.card.seq, unread: n.p.unread, first: n.p.first }));
  const olderOf = (out) => find(out, (n) => n.t === 'button' && n.p['data-reply-older'] !== undefined)[0];
  let out = render();
  // Unread first (200, 190, 180, 160), then the read ones, newest first: only the first 8 show.
  assert.deepEqual(cardsOf(out).map((c) => c.seq), [200, 190, 180, 160, 170, 150, 140, 130], 'one page: the first 8 cards of the order');
  assert.deepEqual(cardsOf(out).filter((c) => c.unread).map((c) => c.seq), [200, 190, 180, 160], 'the New marks');
  assert.equal(cardsOf(out)[0].first, true, 'the newest unread card is first');
  assert.equal(text(find(out, (n) => n.p?.['data-reply-unread'] !== undefined)[0]), 'replies.unread:{"count":4}', 'the unread count');
  let older = olderOf(out); assert.equal(text(older), 'replies.loadEarlier', 'no dsh text: our copy'); assert.equal(older.p['data-reply-older'], '8');
  // The button is at the older end: after the last card.
  const inner = find(out, (n) => n.p?.className === 'cp-rf-in')[0].c.flat(Infinity).filter((c) => c !== null);
  assert.equal(inner.findIndex((c) => c.p?.className === 'cp-rf-older'), inner.length - 1, 'below the cards, at the older end');
  // The click keeps the first card on screen at its place (a fake feed: the card moves 200 px down as cards come above).
  const section = find(out, (n) => n.t === 'section')[0]; let cardTop = 100; const focused = [];
  const fakeCard = (seq) => ({ isConnected: true, dataset: { reply: String(seq) }, getBoundingClientRect: () => ({ top: cardTop, bottom: cardTop + 50 }), focus: () => focused.push(seq) });
  const feedEl = { scrollTop: 40, getBoundingClientRect: () => ({ top: 0 }), querySelector: () => null, querySelectorAll: () => [fakeCard(200), fakeCard(120), fakeCard(40)] };
  section.p.ref.current = feedEl;
  const before = cardsOf(out);
  older.p.onClick({ currentTarget: older }); cardTop = 300; out = render();
  assert.equal(feedEl.scrollTop, 240, 'the first card on screen keeps its place');
  assert.deepEqual(cardsOf(out).slice(0, 8), before, 'the first page stays as it was (order, read and New marks)');
  assert.deepEqual(cardsOf(out).map((c) => c.seq).slice(8), [120, 110, 100, 90, 80, 70, 60, 50], 'the next 8');
  older = olderOf(out); assert.equal(older.p['data-reply-older'], '16');
  // The last click with the keyboard: the button goes, the focus goes to the first card that the click added.
  globalThis.document.activeElement = older; older.p.onClick({ currentTarget: older }); out = render(); delete globalThis.document.activeElement;
  assert.deepEqual(focused, [40], 'the focus on the first card that the last click added (below seq 50)'); section.p.ref.current = null;
  assert.equal(cardsOf(out).length, 20); assert.equal(olderOf(out), undefined, 'all shown: no button');
  assert.equal(find(out, (n) => n.p?.className === 'cp-rf-note').length, 0, 'no note under 40 replies');
  // Read marks still work on a card of a later page; a new reply shows at once.
  find(out, (n) => n.t === ReplyCard && n.p.card.seq === 160)[0].p.onRead(160); out = render();
  assert.equal(cardsOf(out).find((c) => c.seq === 160).unread, false, 'a click reads a card');
  snap = chatOf([...nodes, step(21, 0, 210, [txt('**Yeni yanıt.**')]), tail(21, 210)]); for (const fn of subs) fn(); out = render();
  assert.deepEqual(cardsOf(out)[0], { seq: 210, unread: true, first: true }, 'a new reply shows at once, New, on top');
  // The cards of a new chat column start with one page again (a new ReplyFeed).
  hooks = []; out = render(); assert.equal(cardsOf(out).length, 8, 'a new feed: one page');
  // An old unread card shows on the first page (no New card behind the button), and stays after it is read.
  snap = chat; store.all('old', 20); store.mark('old', nodes.filter((n) => n.kind === 'assistant-step' && n.data.finalNode.seq > 30).map((n) => n.data.finalNode.seq), nodes.filter((n) => n.kind === 'assistant-step').map((n) => n.data.finalNode.seq));
  props.sessionId = 'old'; hooks = []; out = render();
  assert.deepEqual(cardsOf(out).map((c) => c.seq), [30, 200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 100, 90, 80, 70, 60, 50, 40], 'the old unread card and every card above it');
  find(out, (n) => n.t === ReplyCard && n.p.card.seq === 30)[0].p.onRead(30); out = render();
  assert.deepEqual([cardsOf(out).length, cardsOf(out).at(-1)], [18, { seq: 30, unread: false, first: false }], 'read, it stays');
  assert.equal(olderOf(out).p['data-reply-older'], '18', 'Load earlier for the 2 older ones');
  // dsh's own label (its chat.loadOlder now, e.g. dsh 0.2.2's German "Früher laden"), else our copy.
  props.loadOlder = () => 'Früher laden'; out = render(); assert.equal(text(olderOf(out)), 'Früher laden', "dsh's own label");
  props.sessionId = 'feed'; delete props.loadOlder;
}

// The texts: replies.loadEarlier is our language packs' copy of dsh's chat.loadOlder (the label when dsh has no text).
for (const f of ['de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'tr', 'vi']) {
  const pack = JSON.parse(read(`locales/${f}.json`));
  assert.equal(pack['dsh-composer-plus']['replies.loadEarlier'], pack.chat['chat.loadOlder'], `${f}: the copy`);
}
assert.match(src, /'replies\.loadEarlier': 'Load earlier',/, 'en'); assert.match(src, /'replies\.loadEarlier': '加载更早',/, 'zh');
assert.match(src, /loadOlder: \(\) => chatTextOf\(ctx\.locale, 'chat\.loadOlder'\)/, "the feed asks dsh's chat dictionary");

// The feature: its switch, Settings screenshot, category, chat toggle key.
assert.match(src, /const FEATURES = \[[^\]]*'assistantReplyCards'/, 'its own switch'); assert.match(src, /const SHOT_OF = \{[^}]*assistantReplyCards: 'assistantReplyCards'/, 'its screenshot');
assert.match(src, /assistant: \[[^\]]*'assistantReplyCards'\]/, 'in the Assistant category'); assert.ok(!/const OFF_BY_DEFAULT = \[[^\]]*'assistantReplyCards'/.test(src), 'on by default');
assert.equal(REPLY_SHOWN_KEY, 'dsh-composer-plus.assistant-chat-shown');
console.log('reply-cards: ok');
