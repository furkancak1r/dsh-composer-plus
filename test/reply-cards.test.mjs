// Damon reply cards (assistantReplyCards; Furkan, 2026-11-25): each reply of the Damon chat shows as a card in the style
// of the Kararlar cards, the chat is hidden behind them (Sohbeti göster / Sohbeti gizle, kept in this browser), the
// message box stays.
// - replyCardsOf: one card per settled reply that dsh shows (a step with text and no tool call, or its turn's closing
//   answer) and per failed turn; not a reply that is only [quiet], not a quiet turn, not a withdrawn reply (rule 9: Turn
//   rollback's and dsh-rewind-plugin's spans) and not a fork's inherited one (rule 10).
// - replyParts: the bold first line is the title, "Senden:" the action line, `onay` blocks the approval sentences, the
//   option list at the end the option buttons, [!DETAILS] stays closed.
// - Read marks: at the first view every older reply is read; a click or a button marks a card read (each part of a split
//   reply on its own); the newest unread card is first; junk in storage reads as empty; another window's marks are merged.
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
eval(src.replace(ANCHOR, `globalThis.__rc = { replyImageUrl, pathImagesOf, mdLabelsOf, failureTextOf, replyCardsOf, replyParts, readReplyMarks, markReplies, replyUnread, replyOrder, createReplyRead, replySig, chatStateKey, ReplyCard, ReplyFeed, replySections, sideReadId, replyPage, REPLY_PAGE, REPLY_READ_KEY, REPLY_SHOWN_KEY, REPLY_CSS, REPLY_MAX };\n    ${ANCHOR}`));
const h = (t, p, ...c) => ({ t, p: p ?? {}, c });
// A small hook runtime (by call order) for ReplyFeed: state, refs and effects with deps (run after each draw).
let hooks = []; let hi = 0; let pending = [];
const changed = (a, b) => a === undefined || b === undefined || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
const React = { createElement: h, Fragment: 'F', useState: (v) => { const i = hi++; if (!(i in hooks)) hooks[i] = typeof v === 'function' ? v() : v; return [hooks[i], (x) => { hooks[i] = typeof x === 'function' ? x(hooks[i]) : x; }]; },
  useRef: (v) => { const i = hi++; return hooks[i] ??= { current: v }; }, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f,
  useLayoutEffect: (f, deps) => { const i = hi++; const old = hooks[i]; if (old === undefined || changed(old.deps, deps)) pending.push(() => { old?.off?.(); hooks[i] = { deps, off: f() }; }); } };
React.useEffect = React.useLayoutEffect;
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host, key) => ({ portal: el, host, key }) } : {}));
const { replyImageUrl, pathImagesOf, mdLabelsOf, failureTextOf, replyCardsOf, replyParts, readReplyMarks, markReplies, replyUnread, replyOrder, createReplyRead, replySig, chatStateKey, ReplyCard, ReplyFeed, replySections, sideReadId, replyPage, REPLY_PAGE, REPLY_READ_KEY, REPLY_SHOWN_KEY, REPLY_CSS, REPLY_MAX } = globalThis.__rc;
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
  // Review 5: a Senden line with an image (it stays in the body, review 4) still asks you: a card next to a tool call.
  const askImg = chatOf([step(1, 0, 10, [txt('Senden: şu ekrana bak ![Ekran](</a/b.png>)'), tool]), step(1, 1, 12, [txt('Bitti.')]), tail(1, 12)]);
  assert.deepEqual(replyCardsOf(askImg).map((c) => c.seq), [10, 12], 'a Senden line with an image next to a tool call is a card');
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
  const c = (seq) => ({ seq, id: seq }); const cs = (...seqs) => seqs.map(c);
  const m = { floor: 10, read: [] };
  assert.equal(replyUnread(m, c(10)), false); assert.equal(replyUnread(m, c(12)), true); assert.equal(replyUnread(undefined, c(12)), false, 'before the first view: no card is new');
  assert.deepEqual(markReplies(m, [14], cs(12, 14, 16)), { floor: 10, read: [14] }, 'a card in the middle');
  assert.deepEqual(markReplies({ floor: 10, read: [14] }, [12], cs(12, 14, 16)), { floor: 14, read: [] }, 'the floor moves over the cards read in a row');
  const order = replyOrder(cs(8, 12, 14, 16), { floor: 10, read: [14] });
  assert.deepEqual(order.map((x) => x.seq), [16, 12, 14, 8], 'unread first (newest first), then the read ones');
  const store = createReplyRead(); let calls = 0; store.subscribe(() => { calls += 1; });
  store.start('s', 30); assert.deepEqual(store.of('s'), { floor: 30, read: [] }, 'the first view: every older reply is read');
  store.start('s', 99); assert.equal(store.of('s').floor, 30, 'only once');
  store.mark('s', [40], cs(40, 50)); assert.deepEqual(store.of('s'), { floor: 40, read: [] });
  store.mark('s', [40], cs(40, 50)); assert.equal(calls, 2, 'no write without a change');
  // Another window read 50 meanwhile: a write merges it.
  const other = JSON.parse(mem.get(REPLY_READ_KEY)); other.s = { floor: 50, read: [] }; mem.set(REPLY_READ_KEY, JSON.stringify(other));
  store.mark('s', [60], cs(40, 50, 60, 70)); assert.deepEqual(JSON.parse(mem.get(REPLY_READ_KEY)).s, { floor: 50, read: [60] }, 'merged with the other window');
  store.all('s', 70); assert.deepEqual(store.of('s'), { floor: 70, read: [] }, 'Tümünü okundu say');
  const blocked = globalThis.localStorage.setItem; globalThis.localStorage.setItem = () => { throw Error('quota'); };
  store.mark('t', [1], cs(1)); store.start('u', 5); globalThis.localStorage.setItem = blocked; // no throw
  assert.equal(store.of('u').floor, 5, 'storage blocked: this page only');
  // dsh's turn-tail node is the newest node at its turn's end seq + 0.1 (review 1): the floor is a whole seq, so a new
  // reply stays New after a reload (a fraction was dropped at the next load and made every card read).
  const chat = chatOf([step(1, 0, 42, [txt('Eski yanıt.')]), tail(1, 42)]); [...chat.nodes.values()][1].anchorSeq = 43.1;
  store.start('f', Number(chatStateKey(chat).split(':')[1])); assert.deepEqual(store.of('f'), { floor: 43, read: [] }, 'a whole floor');
  const reloaded = createReplyRead(); assert.equal(replyUnread(reloaded.of('f'), c(50)), true, 'a newer reply is still New after a reload');
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
  const draw = (props) => ReplyCard({ card, sessionId: 's', unread: true, newest: true, offerNow, choiceNow, picks, t, lang: 'tr', onRead: (seq) => reads.push(seq), ...props });
  let tr = draw();
  assert.equal(tr.t, 'article'); assert.equal(tr.p['data-unread'], ''); assert.equal(tr.p['data-newest'], ''); assert.equal(tr.p.tabIndex, 0, 'a card takes the focus');
  assert.equal(text(find(tr, (n) => n.p.className === 'cp-rc-new')[0]), 'replies.new', 'the New label');
  assert.equal(text(find(tr, (n) => n.t === 'h3')[0]), 'Hazır.', 'the title');
  const ok = find(tr, (n) => n.t === 'button' && n.p['data-composer-plus-approve'] === 'reply');
  assert.equal(ok.length, 1, 'Onayla on the card that holds the block'); assert.equal(text(ok[0]), 'approve.button');
  ok[0].p.onClick(); assert.deepEqual(picked, [['s', 42, 1]], 'the same send path as the panel (picks.pick)'); assert.deepEqual(reads, [42], 'a button marks it read');
  const opts = find(tr, (n) => n.t === 'button' && n.p.className === 'cp-rc-opt');
  assert.deepEqual(opts.map((b) => b.p['data-option']), ['1', '2'], 'the option buttons'); assert.equal(opts[0].p['data-recommended'], '', 'the recommended one');
  opts[1].p.onClick(); assert.deepEqual(picked.at(-1), ['s', 42, 2], 'an option goes through picks.pick');
  const self = { contains: (n) => n === 'in-card' };
  globalThis.getSelection = () => ({ isCollapsed: false, anchorNode: 'in-card' });
  const before = reads.length; tr.p.onClick({ currentTarget: self }); assert.equal(reads.length, before, 'a drag that selected text of the card does not read it');
  globalThis.getSelection = () => ({ isCollapsed: false, anchorNode: 'elsewhere' });
  tr.p.onClick({ currentTarget: self }); assert.deepEqual(reads.at(-1), 42, 'a selection outside the card: the click reads it');
  reads.pop(); globalThis.getSelection = () => ({ isCollapsed: true, anchorNode: 'in-card' });
  tr.p.onClick({ currentTarget: self }); assert.deepEqual(reads.at(-1), 42, 'a click on the card marks it read'); delete globalThis.getSelection;
  const n = reads.length; tr.p.onKeyDown({ key: 'Enter', target: 'self', currentTarget: 'self' }); assert.equal(reads.length, n + 1, 'Enter on the card too');
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

// One card per topic (Furkan, 2026-11-26: "birbirinden bağımsız konuları ayrı kartlar olarak göster"): a `---` line splits a
// reply; not inside a code block or an `onay` block; a reply without one is one card (test/fixtures/reply-sections.json is
// also Tether's table).
{
  for (const c of JSON.parse(read('test/fixtures/reply-sections.json')).cases) assert.deepEqual(replySections(c.text), c.parts, `sections: ${c.name}`);
  const two = "**Kur kolonu aynı.** Dosyalar hazır.\n\nSenden: 4 raporu güncelle.\n\n---\n\n**Yerel model kapalı kaldı.** Şu an açık.\n\n```onay\nOnaylıyorum (canlı değil): test yeniden başlasın.\n---\n```\n\n**Seçenekler:**\n1. Hemen\n2. Yarın";
  const cards = replyCardsOf(chatOf([step(1, 0, 10, [txt('Tek konu.')]), tail(1, 10), step(2, 0, 20, [txt(two)]), tail(2, 20)]));
  assert.deepEqual(cards.map((c) => [c.key, c.seq, c.last]), [['10:0', 10, true], ['20:0', 20, false], ['20:1', 20, true]], 'two topics: two cards of one reply, in order');
  assert.deepEqual(cards.slice(1).map((c) => [replyParts(c.text).title, replyParts(c.text).forYou]), [['Kur kolonu aynı.', '4 raporu güncelle.'], ['Yerel model kapalı kaldı.', '']], 'each card has its own title and Senden line');
  assert.equal(cards[1].time, cards[2].time, 'the same time');
  assert.deepEqual(replyParts(cards[2].text).approvals, ['Onaylıyorum (canlı değil): test yeniden başlasın.\n---'], 'the onay block stays whole in its part');
  // The option buttons only on the last part; the Approve button on the part that holds the block.
  const t = (k) => k; const picks = { pick: () => Promise.resolve(true) };
  const choiceNow = { offer: { seq: 20, latest: 2, options: [{ n: 1, label: 'Hemen', text: 'Hemen', recommended: false }, { n: 2, label: 'Yarın', text: 'Yarın', recommended: false }] }, state: { busy: false, error: null }, empty: true };
  const sentence = 'Onaylıyorum (canlı değil): test yeniden başlasın.\n---';
  const offerNow = { offer: { seq: 20, latest: 2, options: [{ n: 1, text: sentence, label: sentence, message: sentence, from: 20 }] }, state: { busy: false, error: null }, empty: true };
  const btns = (card) => find(ReplyCard({ card, sessionId: 's', offerNow, choiceNow, picks, t, lang: 'tr' }), (n) => n.t === 'button').map((b) => b.p.className + (b.p['data-composer-plus-approve'] ?? ''));
  assert.deepEqual(btns(cards[1]), [], 'the first topic: no buttons');
  assert.deepEqual(btns(cards[2]), ['cp-rc-btnreply', 'cp-rc-opt', 'cp-rc-opt'], 'the last topic: Onayla and the options');
  const failed = { ...offerNow, state: { busy: false, error: 'boom' } };
  const alerts = (card) => find(ReplyCard({ card, sessionId: 's', offerNow: failed, picks, t, lang: 'tr' }), (n) => n.p?.role === 'alert').length;
  assert.deepEqual([alerts(cards[1]), alerts(cards[2])], [0, 1], 'a failed send: the error only on the part with the button (review 4)');
  const one = replyCardsOf(chatOf([step(1, 0, 30, [txt('**Tek.** Metin.\n\n```\n---\n```')]), tail(1, 30)]));
  assert.deepEqual(one.map((c) => c.key), ['30:0'], '--- in a code block: one card');
  // One read mark per topic (Furkan, 2026-11-26: "ayrı konuları ayrı yazsan da hepsine tek okundu geliyor ama farklı
  // okundular gelmesi lazım"): each part of a split reply has its own read id; a reply without `---` keeps its seq, so the
  // marks saved before stay valid.
  assert.deepEqual(cards.map((c) => c.id), [10, '20:0', '20:1'], 'read ids: the seq for one topic, "seq:i" for each part');
  assert.deepEqual(one.map((c) => c.id), [30], 'a `---` in a code block: still the seq');
  const reads = []; const card1 = ReplyCard({ card: cards[1], sessionId: 's', t, lang: 'tr', picks, onRead: (id) => reads.push(id) });
  card1.p.onClick({ currentTarget: { contains: () => false } }); card1.p.onKeyDown({ key: 'Enter', target: 1, currentTarget: 1 });
  assert.deepEqual(reads, ['20:0', '20:0'], 'a click and Enter read the part, not the reply');
  const mk = { floor: 5, read: [] };
  const first = markReplies(mk, ['20:0'], cards);
  assert.deepEqual(first, { floor: 5, read: ['20:0'] }, 'reply 10 is unread: the floor stays');
  assert.deepEqual(cards.map((c) => replyUnread(first, c)), [true, false, true], 'only the read part: the other part stays New');
  assert.deepEqual(markReplies(first, [10], cards), { floor: 10, read: ['20:0'] }, 'the floor stops before a reply with an unread part');
  assert.deepEqual(markReplies({ floor: 10, read: ['20:0'] }, ['20:1'], cards), { floor: 20, read: [] }, 'all parts read: the floor moves over the reply and drops its ids');
  assert.deepEqual(cards.map((c) => replyUnread({ floor: 5, read: [20] }, c)), [true, false, false], 'an older whole-reply mark (its seq) reads every part');
  assert.deepEqual(markReplies({ floor: 10, read: [] }, [20], cards).floor, 20, 'a whole-reply mark moves the floor too');
  assert.deepEqual(replyOrder(cards, { floor: 5, read: ['20:1'] }).map((c) => c.key), ['20:0', '10:0', '20:1'], 'the canvas: the unread part first');
  // The canvas side panel reads only the card that it opens (review 2).
  assert.deepEqual(['reply|20:1', 'reply|10:0', 'reply|99:0', 'senden|20:1', undefined, null].map((k) => sideReadId(cards, k)), ['20:1', 10, undefined, undefined, undefined, undefined], 'the side panel: the read id of the opened card only');
  assert.match(src, /const onSelCard = \(key\) => \{ setSel\(key\); const id = sideReadId\(replies, key\); if \(id !== undefined\) replyCards\.read\(\[id\]\); \};/, 'the canvas uses it');
  // Saved and read again (a reload): the part mark stays; junk ids are dropped.
  mem.set(REPLY_READ_KEY, JSON.stringify({ s: { floor: 10, read: ['20:0', '20:x', 'x:1', ':1', '20:0:1', 12, '12'] } }));
  assert.deepEqual(readReplyMarks().s.read, ['20:0', 12], 'only seqs and "seq:i" ids');
  mem.delete(REPLY_READ_KEY);
  const ps = createReplyRead(); ps.start('p', 5);
  ps.mark('p', ['20:0'], cards); ps.mark('p', [10], cards);
  assert.deepEqual(JSON.parse(mem.get(REPLY_READ_KEY)).p, { floor: 10, read: ['20:0'] }, 'saved: the floor before the split reply, its read part');
  const back = createReplyRead().of('p');
  assert.deepEqual(cards.map((c) => replyUnread(back, c)), [false, false, true], 'after a reload: only the other part is New');
  // Another window read the other part: the write merges the part ids.
  const win = JSON.parse(mem.get(REPLY_READ_KEY)); win.p.read.push('30:0'); mem.set(REPLY_READ_KEY, JSON.stringify(win));
  ps.mark('p', ['20:1'], cards); assert.deepEqual(JSON.parse(mem.get(REPLY_READ_KEY)).p, { floor: 20, read: ['30:0'] }, 'merged with the other window, sorted by seq');
  mem.delete(REPLY_READ_KEY);
  // The prompt asks for it.
  assert.match(read('index.js'), /- One reply card holds one topic: the reply cards show each part of a reply between lines of only \\`---\\` as its own card\. When a reply must also report an independent topic, put a line \\`---\\` before it and start that part with its own bold line[^\n]*Do not add a side topic that needs nothing from the user\./, 'the reply-form rule in the assistant prompt');
}

// The chat's feed (Furkan, 2026-11-26: "yeni gelen kart en altta gözüksün"): time order, the oldest on top, the newest
// at the bottom; the newest REPLY_MAX cards; the shadow on the newest unread card. The canvas island keeps replyOrder.
{
  const t = (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`);
  const store = (v) => ({ subscribe: () => () => {}, getSnapshot: () => v });
  const many = Array.from({ length: REPLY_MAX + 3 }, (_, i) => step(i + 1, 0, (i + 1) * 10, [txt(`Yanıt ${i + 1}.`)]));
  const chat = chatOf(many);
  const replies = { chatOf: () => ({ subscribe: () => () => {}, getSnapshot: () => chat }), rollback: { subscribe: () => () => {}, of: () => undefined },
    check: { ask() {}, subscribe: () => () => {}, ready: () => true }, read: { subscribe: () => () => {}, of: () => ({ floor: 395, read: [410, 430] }), start() {}, mark() {}, all() {} } };
  const host = { querySelector: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, bottom: 600 }), setAttribute() {}, removeAttribute() {} };
  // useReplyCards' chat and ready, then the feed's box and its Load earlier floor (the order of the hook calls): floor 0
  // is the feed after every Load earlier click (test the first page in the Load earlier block below).
  hooks = []; hi = 0;
  const states = [chat, true, { left: 0, top: 0, width: 800, height: 500 }, 0];
  const React0 = React.useState; React.useState = (v) => [states.length > 0 ? states.shift() : typeof v === 'function' ? v() : v, () => {}];
  const tree = ReplyFeed({ sessionId: 's', host, replies, shown: store(false), statusSeats: { subscribe: () => () => {}, getSnapshot: () => new Map() }, offers: { subscribe: () => () => {}, of: () => undefined, choiceOf: () => undefined }, picks: {}, locale: () => 'tr', t });
  React.useState = React0;
  const arts = find(tree, (n) => n.t === ReplyCard);
  const seqs = arts.map((n) => n.p.card.seq);
  assert.deepEqual(seqs, many.slice(-REPLY_MAX).map((n) => n.data.finalNode.seq), 'the newest REPLY_MAX cards, oldest on top, newest at the bottom');
  assert.deepEqual(arts.filter((n) => n.p.newest).map((n) => n.p.card.seq), [420], 'the shadow on the newest unread card');
  assert.deepEqual(arts.filter((n) => n.p.unread).map((n) => n.p.card.seq), [400, 420], 'unread marks stay');
  // A split reply at the limit shows whole: the limit counts replies (seqs), not cards.
  {
    const split = chatOf([...many.slice(-REPLY_MAX), step(99, 0, 990, [txt('Bir.\n---\nİki.')])]);
    hooks = []; hi = 0; const st = [split, true, { left: 0, top: 0, width: 800, height: 500 }, 0]; const R0 = React.useState;
    React.useState = (v) => [st.length > 0 ? st.shift() : typeof v === 'function' ? v() : v, () => {}];
    const r2 = { ...replies, chatOf: () => ({ subscribe: () => () => {}, getSnapshot: () => split }) };
    const t2 = ReplyFeed({ sessionId: 's', host, replies: r2, shown: store(false), statusSeats: { subscribe: () => () => {}, getSnapshot: () => new Map() }, offers: { subscribe: () => () => {}, of: () => undefined, choiceOf: () => undefined }, picks: {}, locale: () => 'tr', t });
    React.useState = R0;
    const a2 = find(t2, (n) => n.t === ReplyCard).map((n) => n.p.card.key);
    assert.equal(a2.length, REPLY_MAX + 1, 'the newest 40 replies with both parts of the split one'); assert.deepEqual(a2.slice(-2), ['990:0', '990:1']);
    assert.equal(text(find(t2, (n) => n.p?.className === 'cp-rf-note')[0]), `replies.more:${JSON.stringify({ count: 1 })}`, 'the hidden replies (41 replies, the newest 40 show)');
    assert.equal(find(t2, (n) => n.p?.['data-reply-unread'] !== undefined)[0].p['data-reply-unread'], String(find(t2, (n) => n.t === ReplyCard && n.p.unread).length), 'the unread count: the shown cards');
  }
  const note = find(tree, (n) => n.p?.className === 'cp-rf-note');
  assert.equal(text(note[0]), `replies.more:${JSON.stringify({ count: 3 })}`, 'the note of the older replies is above the cards');
  const inner = find(tree, (n) => n.p?.className === 'cp-rf-in')[0];
  assert.ok(inner.c.flat(Infinity).indexOf(note[0]) < inner.c.flat(Infinity).indexOf(arts[0]), 'the note comes first');
  // A structure check only (the mock React runs no effects); test/browser-reply-order.mjs measures the scroll.
  assert.match(src, /follow\.current = true; f\.scrollTop = f\.scrollHeight; \}, \[box === null, newestKey\]\)/, 'structure: the scroll effect runs when the feed opens and when a new card comes');
  hooks = []; hi = 0; pending = []; // the mock runs no effects
}

// The pointer (Furkan, 2026-11-26): text in a card has the text cursor and can be selected; only controls have the hand.
{
  assert.match(REPLY_CSS, /\.cp-rc\{[^}]*cursor:default\}/, 'the card frame: the arrow');
  assert.doesNotMatch(REPLY_CSS.replace(/\.cp-cv-isl \.cp-rc\{cursor:pointer\}/, ''), /\.cp-rc\{[^}]*cursor:pointer/, 'no hand on the whole card (only on a canvas island, where a click opens it)');
  assert.match(REPLY_CSS, /:is\(\[data-composer-plus-reply-feed\],\.cp-cv-side\) \.cp-rc\{-webkit-user-select:text;user-select:text\}/, 'text can be selected in the feed and the side panel');
  assert.match(REPLY_CSS, /:is\(\[data-composer-plus-reply-feed\],\.cp-cv-side\) \.cp-rc :is\(h3,\.cp-rc-top,\.cp-rc-for,\.cp-rc-body,\.cp-rc-ok>p,ol\.cp-rc-opts,\.cp-rc-details>div\)\{cursor:text\}/, 'the text cursor over text');
  assert.match(REPLY_CSS, /\.cp-rc :is\(button,a\[href\],summary\)\{cursor:pointer\}/, 'the hand over buttons, links and the summary');
}

// The chat toggle in the status panel header (Furkan, 2026-11-26: "sohbeti göster butonunu da simgeye dönüştür"): an icon
// button of the header row (cp-td-btn), named by aria-label and title in the UI language, the same click.
{
  const at = src.indexOf('const chatLabel = '); const code = src.slice(at, src.indexOf('\n', src.indexOf('lineIcon(', at)));
  assert.match(code, /className: 'cp-td-btn'/, 'the class of the header icons'); assert.match(code, /'aria-label': chatLabel, title: chatLabel/, 'named for hover and screen readers');
  assert.match(code, /const chatLabel = t\(chatIsShown \? 'replies\.hideChat' : 'replies\.showChat'\)/, 'the language pack label');
  assert.match(code, /onClick: \(\) => chatShown\.set\(!chatIsShown\)/, 'the same click'); assert.match(code, /lineIcon\(/, 'a line icon (no text)');
  const row = src.slice(src.indexOf("React.createElement('div', { className: 'cp-st-top' },"), src.indexOf('spokenSpan),', src.indexOf("React.createElement('div', { className: 'cp-st-top' },")));
  assert.ok(row.indexOf('chatToggle,') > row.indexOf('data-composer-plus-canvas-open') && row.indexOf('chatToggle,') < row.indexOf('data-place-button'), 'in the icon row, between the canvas and the place icons');
}

// One title rule for the Mac and Tether (test/fixtures/reply-titles.json; Tether: testReplyTitleMatchesTheMac).
{
  const { cases } = JSON.parse(read('test/fixtures/reply-titles.json'));
  for (const c of cases) { const p = replyParts(c.text); assert.deepEqual([p.title, p.forYou], [c.title, c.forYou], c.name); }
  const core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
  assert.match(core, /func replyHead\(_ text: String\) -> ReplyHead/, 'the Swift port');
  assert.match(ui, /if damon, l\.kind == \.assistant \{\s*let parts = replySections\(l\.text\)/, 'Tether: the Damon chat draws one card per topic of a reply');
  assert.match(ui, /\} else if damon, l\.kind == \.error \{ replyCard \{/, 'Tether: a failed turn is a card');
  assert.match(core, /func replySections\(_ text: String\) -> \[String\]/, 'Tether: the split port (testReplySectionsMatchTheMac)');
  assert.match(ui, /if last, l\.kind == \.assistant, let o = c\.optionOffer/, 'Tether: the options under the last topic');
  assert.match(ui, /if card \{ cardHead\(title: head\.title, forYou: head\.forYou\) \}/, 'Tether: the card shows the title and the For you line');
  assert.match(ui, /Text\(verbatim: title\)[^\n]*\.textSelection\(\.enabled\)/, 'Tether: the title can be selected');
  assert.match(ui, /private var shown: String \{ line\.kind == \.assistant \? part \?\? line\.text : line\.text \}/, 'Tether: a long press on a topic card uses its topic (review 7)');
  for (const use of ['string = [shown, line.output]', 'ShareLink(item: shown)', 'onQuote(shown)', 'SelectableText(text: shown)']) assert.ok(ui.includes(use), `Tether menu: ${use}`);
}

// Load earlier (Furkan, 2026-11-26: "hepsi birden gözükmesin öncekini yükle"): the feed draws one page of REPLY_PAGE
// replies first (and every unread card); each click adds one older page above them; the time order (the newest at the
// bottom), the read marks and the New marks stay; a new reply shows at once; the first card on screen keeps its place;
// the label is dsh's own.
{
  assert.equal(REPLY_PAGE, 8, 'the same 8 as the first view of the assistant chat'); assert.equal(REPLY_MAX, 40);
  // replyPage, in the feed's time order (the oldest first): before a click the newest 8 replies by seq (the parts of one
  // reply stay together), in the given order; after a click every reply from the floor up (`next`: the floor after one
  // more click).
  const list = Array.from({ length: 20 }, (_, i) => ({ seq: 10 + i * 10 })); list.splice(19, 0, { seq: 190, part: 2 }); // 20 replies, one in 2 parts
  let p = replyPage(list);
  assert.deepEqual(p.shown.map((c) => c.seq), [130, 140, 150, 160, 170, 180, 190, 190, 200], 'the newest 8 replies, both parts of one, oldest first');
  assert.deepEqual([p.older, p.next, p.held, p.more], [true, 50, false, 0], 'the next floor: 8 older replies');
  p = replyPage(list, p.next); assert.equal(p.shown.length, 17); assert.equal(p.next, 10, 'the last page has 4 replies');
  assert.deepEqual(p.shown.slice(-9), replyPage(list).shown, 'the first page stays at the bottom');
  p = replyPage(list, p.next); assert.deepEqual([p.shown.length, p.older], [21, false], 'all shown: no button');
  assert.deepEqual([replyPage([]).shown, replyPage([]).older, replyPage([]).next], [[], false, null], 'no reply');
  assert.deepEqual(replyPage(list.slice(0, 5)).shown.length, 5, 'less than a page: all, no button'); assert.equal(replyPage(list.slice(0, 5)).older, false);
  // A new reply after a click: it shows, no loaded card hides.
  assert.equal(replyPage([...list, { seq: 210 }], 50).shown.length, 18, 'a new reply comes, the loaded ones stay');
  // A rollback took the newest replies after a click: still at least one page.
  assert.deepEqual(replyPage(list.filter((c) => c.seq <= 100), 90).shown.map((c) => c.seq), [30, 40, 50, 60, 70, 80, 90, 100], 'withdrawn after a click: the newest page');
  // By time, not by place: an old read card waits for its page.
  const mixed = [{ seq: 5 }, { seq: 6 }, ...Array.from({ length: 9 }, (_, i) => ({ seq: 92 + i }))];
  assert.deepEqual(replyPage(mixed).shown.map((c) => c.seq), [93, 94, 95, 96, 97, 98, 99, 100], 'the newest 8 replies, in the given order');
  assert.deepEqual(replyPage(mixed, replyPage(mixed).next).shown.map((c) => c.seq), mixed.map((c) => c.seq), 'page 2: all, in the given order');
  // An old unread card never waits behind the button: the cut goes down to it (held: the feed keeps that floor).
  p = replyPage(mixed, null, (c) => c.seq === 6);
  assert.deepEqual([p.shown.map((c) => c.seq), p.cut, p.held, p.older], [[6, 92, 93, 94, 95, 96, 97, 98, 99, 100], 6, true, true], 'down to the old unread card');
  // The 40 cap by seq, in either order (newest at the bottom, or newest first); the rest is only in the chat.
  const many = Array.from({ length: 45 }, (_, i) => ({ seq: 956 + i }));
  for (const order of [many, [...many].reverse()]) {
    let q = replyPage(order); for (let n = 0; q.older && n < 10; n++) q = replyPage(order, q.next);
    assert.deepEqual([q.shown.length, Math.min(...q.shown.map((c) => c.seq)), q.older, q.more], [40, 961, false, 5], 'the newest 40 replies, then the note');
  }
  p = replyPage(many, null, (c) => c.seq === 958);
  assert.deepEqual([p.shown.length, p.held], [8, false], 'an unread card past the 40 cap is only in the chat: it does not open the 40');

  // ReplyFeed with 20 replies (seq 10…200); the first view read up to 150, and 170 was read with a click.
  const nodes = []; for (let n = 1; n <= 20; n++) nodes.push(step(n, 0, n * 10, [txt(`**Yanıt ${n}.** Gövde.`)]), tail(n, n * 10));
  const chat = chatOf(nodes); let snap = chat; const subs = new Set();
  const source = { getSnapshot: () => snap, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
  const store = createReplyRead(); store.start('feed', 150); store.mark('feed', [170], [160, 170, 180, 190, 200].map((seq) => ({ seq, id: seq })));
  const replies = { chatOf: () => source, rollback: { subscribe: () => () => {}, of: () => ({ withdrawn: [], inherited: 0 }) }, check: { ask() {}, subscribe: () => () => {}, ready: () => true }, read: store };
  const scroll = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, bottom: 600 }), querySelector: () => null };
  const host = { querySelector: (q) => (q === '[data-conversation-scroll]' ? scroll : null), getBoundingClientRect: () => ({ left: 0, top: 0 }), setAttribute() {}, removeAttribute() {} };
  const flag = (v) => ({ subscribe: () => () => {}, getSnapshot: () => v, set() {} });
  const props = { sessionId: 'feed', host, replies, shown: flag(false), statusSeats: { subscribe: () => () => {}, getSnapshot: () => new Map() }, offers: { subscribe: () => () => {}, of: () => undefined, choiceOf: () => undefined }, picks: {}, locale: () => 'tr', t: (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`) };
  hooks = []; pending = [];
  const render = () => { for (let n = 0; n < 6; n++) { hi = 0; const out = ReplyFeed(props); const run = pending; pending = []; for (const f of run) f(); if (run.length === 0) return out; } throw Error('no stable draw'); };
  const cardsOf = (out) => find(out, (n) => n.t === ReplyCard).map((n) => ({ seq: n.p.card.seq, unread: n.p.unread, newest: n.p.newest }));
  const olderOf = (out) => find(out, (n) => n.t === 'button' && n.p['data-reply-older'] !== undefined)[0];
  let out = render();
  // Time order (the oldest on top, the newest at the bottom): only the newest 8 replies show.
  assert.deepEqual(cardsOf(out).map((c) => c.seq), [130, 140, 150, 160, 170, 180, 190, 200], 'one page: the newest 8 cards, in time order');
  assert.deepEqual(cardsOf(out).filter((c) => c.unread).map((c) => c.seq), [160, 180, 190, 200], 'the New marks');
  assert.deepEqual(cardsOf(out).filter((c) => c.newest).map((c) => c.seq), [200], 'the shadow on the newest unread card (at the bottom)');
  assert.equal(text(find(out, (n) => n.p?.['data-reply-unread'] !== undefined)[0]), 'replies.unread:{"count":4}', 'the unread count');
  let older = olderOf(out); assert.equal(text(older), 'replies.loadEarlier', 'no dsh text: our copy'); assert.equal(older.p['data-reply-older'], '8');
  // The button is at the older end: under the header, above the cards.
  const inner = find(out, (n) => n.p?.className === 'cp-rf-in')[0].c.flat(Infinity).filter((c) => c !== null);
  assert.deepEqual([inner.findIndex((c) => c.p?.className === 'cp-rf-older'), inner.findIndex((c) => c.t === ReplyCard)], [1, 2], 'above the cards, at the older end');
  // The click keeps the first card on screen at its place (a fake feed: the card moves 200 px down as cards come above).
  const section = find(out, (n) => n.t === 'section')[0]; let cardTop = 100; const focused = []; const shownBy = []; let buttonLeft = true;
  const fakeCard = (seq) => ({ isConnected: true, dataset: { reply: String(seq) }, getBoundingClientRect: () => ({ top: cardTop, bottom: cardTop + 50 }), focus: () => focused.push(seq), scrollIntoView: (o) => shownBy.push([seq, o?.block]) });
  const feedEl = { scrollTop: 40, getBoundingClientRect: () => ({ top: 0 }), querySelector: (q) => (q === '[data-reply-older]' && buttonLeft ? {} : null), querySelectorAll: () => [fakeCard(10), fakeCard(20), fakeCard(40), fakeCard(120), fakeCard(200)] };
  section.p.ref.current = feedEl;
  const before = cardsOf(out);
  // A keyboard click (Enter or Space: event detail 0) while the button stays: the focus stays on the button.
  older.p.onClick({ currentTarget: older, detail: 0 }); cardTop = 300; out = render();
  assert.deepEqual([focused, shownBy], [[], []], 'the button stays: no focus move');
  assert.equal(feedEl.scrollTop, 240, 'the first card on screen keeps its place');
  assert.deepEqual(cardsOf(out).slice(-8), before, 'the first page stays as it was, at the bottom (order, read and New marks)');
  assert.deepEqual(cardsOf(out).map((c) => c.seq).slice(0, 8), [50, 60, 70, 80, 90, 100, 110, 120], 'the next 8, above them');
  older = olderOf(out); assert.equal(older.p['data-reply-older'], '16');
  // The last click with the keyboard: the button goes, the focus goes to the newest card that the click added (just above
  // the cards that showed, below seq 50), and that card comes into view with the smallest move.
  buttonLeft = false; older.p.onClick({ currentTarget: older, detail: 0 }); out = render();
  assert.deepEqual([focused, shownBy], [[40], [[40, 'nearest']]], 'the focus on the newest added card, in view'); section.p.ref.current = null;
  assert.equal(cardsOf(out).length, 20); assert.equal(olderOf(out), undefined, 'all shown: no button');
  assert.equal(find(out, (n) => n.p?.className === 'cp-rf-note').length, 0, 'no note under 40 replies');
  // Read marks still work on a card of a later page; a new reply shows at once.
  find(out, (n) => n.t === ReplyCard && n.p.card.seq === 160)[0].p.onRead(160); out = render();
  assert.equal(cardsOf(out).find((c) => c.seq === 160).unread, false, 'a click reads a card');
  snap = chatOf([...nodes, step(21, 0, 210, [txt('**Yeni yanıt.**')]), tail(21, 210)]); for (const fn of subs) fn(); out = render();
  assert.deepEqual([cardsOf(out).length, cardsOf(out).at(-1)], [21, { seq: 210, unread: true, newest: true }], 'a new reply shows at once, New, at the bottom; the loaded cards stay');
  // The cards of a new chat column start with one page again (a new ReplyFeed).
  hooks = []; out = render(); assert.equal(cardsOf(out).length, 8, 'a new feed: one page');
  // An old unread card shows on the first page (no New card behind the button), and stays after it is read.
  snap = chat; const all = nodes.filter((n) => n.kind === 'assistant-step').map((n) => ({ seq: n.data.finalNode.seq, id: n.data.finalNode.seq }));
  store.all('old', 20); store.mark('old', all.filter((c) => c.seq > 30).map((c) => c.id), all);
  props.sessionId = 'old'; hooks = []; out = render();
  assert.deepEqual(cardsOf(out).map((c) => c.seq), [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200], 'the old unread card and every card after it');
  find(out, (n) => n.t === ReplyCard && n.p.card.seq === 30)[0].p.onRead(30); out = render();
  assert.deepEqual([cardsOf(out).length, cardsOf(out)[0]], [18, { seq: 30, unread: false, newest: false }], 'read, it stays');
  assert.equal(olderOf(out).p['data-reply-older'], '18', 'Load earlier for the 2 older ones');
  // dsh's own label (its chat.loadOlder now, e.g. dsh 0.2.2's German "Früher laden"), else our copy.
  props.loadOlder = () => 'Früher laden'; out = render(); assert.equal(text(olderOf(out)), 'Früher laden', "dsh's own label");
  // The last click with the mouse (event detail 1; Chromium also focuses a clicked button): no focus move, no scroll.
  find(out, (n) => n.t === 'section')[0].p.ref.current = feedEl; olderOf(out).p.onClick({ currentTarget: olderOf(out), detail: 1 }); out = render();
  assert.deepEqual([cardsOf(out).length, olderOf(out), focused, shownBy], [20, undefined, [40], [[40, 'nearest']]], 'a mouse click: all shown, the focus stays');
  props.sessionId = 'feed'; delete props.loadOlder;
  // The click stops the follow to the bottom, so the cards that come above do not move the feed (a structure check: the
  // mock runs no ResizeObserver; test/browser-reply-pages.mjs measures it).
  assert.match(src, /follow\.current = false; \/\/ the cards that come above must not move the feed to its bottom\n\s*setFloor\(page\.next\);/, 'structure: Load earlier stops the follow');
}

// Images in a card (Furkan, 2026-11-26: "kartlara görüntüler gelmiyor düzelt"): dsh's Markdown asks `pathImages` for a
// local destination; the card answers dsh's own file route (api/file?path=), as dsh's chat view does, for an image file only.
{
  const base = 'http://127.0.0.1:52053/';
  const abs = '/Users/demo/Damon/Belgeler/Composer Plus/guncellemeler/ilk görünüm 3.png'; // spaces, written in angle brackets
  const url = new URL(replyImageUrl(abs, '/Users/demo/Assistant', base));
  assert.deepEqual([url.origin + url.pathname, url.searchParams.get('path'), [...url.searchParams.keys()]], ['http://127.0.0.1:52053/api/file', abs, ['path']], 'an absolute path with spaces: dsh\'s file route');
  assert.equal(new URL(replyImageUrl('/a/b%20c.png?x=1#y', undefined, base)).searchParams.get('path'), '/a/b c.png', 'decoded once, without ?query and #fragment (as dsh)');
  assert.equal(new URL(replyImageUrl('resim/a.png', '/Users/demo/Assistant/', base)).searchParams.get('path'), '/Users/demo/Assistant/resim/a.png', 'a relative path: in the chat\'s folder');
  assert.equal(new URL(replyImageUrl('./b.JPG', 'C:\\work\\damon', base)).searchParams.get('path'), 'C:\\work\\damon\\b.JPG', 'a Windows folder keeps its separator');
  assert.equal(replyImageUrl('/a/b.webp', '/x', 'dsh-app://app/'), 'dsh-app://app/api/file?path=%2Fa%2Fb.webp', 'the Desktop app\'s base');
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) assert.ok(replyImageUrl(`/a/b.${ext}`, '/x', base), `.${ext} is an image`);
  for (const [value, cwd, why] of [['/a/rapor.pdf', '/x', 'a .pdf'], ['/Users/demo/.ssh/id_rsa', '/x', 'a key file'], ['/a/notes.md', '/x', 'a .md'], ['/a/x.svg', '/x', 'an .svg'],
    ['resim/a.png', undefined, 'a relative path without a folder'], ['//server/share/a.png', '/x', 'a // network path'], ['/a/b\nc.png', '/x', 'a control character'], ['/a/%E0%A4.png', '/x', 'a broken escape']]) {
    assert.equal(replyImageUrl(value, cwd, base), undefined, `no image: ${why}`);
  }
  assert.equal(replyImageUrl('/a/b.png', '/x', 'file:///index.html'), undefined, 'no file route on another base');
  // The card gives dsh's MarkdownText the resolver of its chat's folder (one object per folder: MarkdownText memoizes by it).
  const own = pathImagesOf('/Users/demo/Assistant');
  assert.equal(own, pathImagesOf('/Users/demo/Assistant'), 'the same object at the next draw');
  globalThis.document.baseURI = base;
  assert.equal(new URL(own.resolve(abs)).searchParams.get('path'), abs, 'the resolver reads the page\'s base');
  assert.equal(new URL(own.resolve('resim/a.png')).searchParams.get('path'), '/Users/demo/Assistant/resim/a.png', 'and the chat\'s folder');
  assert.equal(own.resolve('/a/rapor.pdf'), undefined, 'a .pdf stays its alt text');
  delete globalThis.document.baseURI;
  assert.match(src, /React\.createElement\(primitives\.MarkdownText, \{ text, pathImages: pathImagesOf\(cwd\), labels: mdLabelsOf\(t\) \}\)/, 'structure: the card passes the resolver and the stable labels to dsh\'s Markdown');
  assert.equal(replyParts(`**Resim.** Bak:\n\n![İlk görünüm](<${abs}>)`).body, `Bak:\n\n![İlk görünüm](<${abs}>)`, 'the image line stays in the card body');
  // Review 1: a reply (or a topic) that starts with an image keeps the image; it is no title ("!İlk görünüm" before).
  // Review 2: also an image after text on the first line (a sentence, a heading, a plain line).
  // Review 3: alt text with ". ", "! " or "? " (the first sentence ends inside the image).
  for (const first of [`![İlk görünüm](<${abs}>)`, `![İlk görünüm](<${abs}>) Sonra metin.`, `Ekran görüntüsü: ![a](</a/b.png>)`, `# Durum ![x](</a/b.png>)`, `Görünüm ![x](</a/b.png>) hazır.`,
    '![Adım 1. Giriş ekranı](</a/b.png>)', '![Dikkat! Hata](</a/b.png>)', 'Bak: ![Neden? Bu](</a/b.png>)']) {
    const p = replyParts(`${first}\n\nMetin burada.`);
    assert.deepEqual([p.title, p.body], ['', `${first}\n\nMetin burada.`], `an image in the first line: no title, the image in the body (${first})`);
  }
  const boldFirst = replyParts('**Başlık** ![x](</a/b.png>)\n\nMetin.');
  assert.deepEqual([boldFirst.title, boldFirst.body], ['Başlık', '![x](</a/b.png>)\n\nMetin.'], 'a bold title keeps its title; the image goes to the body');
  // Review 4: an image on the "Senden:" line or in a [!DETAILS] summary is not lost in plain text.
  const youImg = replyParts('**Başlık**\n\nSenden: şu ekrana bak ![Ekran](</a/b.png>)\n\nMetin.');
  assert.deepEqual([youImg.forYou, youImg.body], ['', 'Senden: şu ekrana bak ![Ekran](</a/b.png>)\n\nMetin.'], 'a Senden line with an image stays in the body');
  assert.equal(replyParts('**Başlık**\n\nSenden: rapora bak.').forYou, 'rapora bak.', 'a Senden line without an image is still the action line');
  const boldYou = replyParts('**Senden:** şu ekrana bak ![x](</a/b.png>)\n\nMetin.');
  assert.deepEqual([boldYou.title, boldYou.forYou, boldYou.asks, boldYou.body], ['', '', true, '**Senden:** şu ekrana bak ![x](</a/b.png>)\n\nMetin.'], 'a bold Senden line with an image is no title (review 5)');
  assert.deepEqual(replyParts('**Başlık**\n\n> [!DETAILS] ![x](</a/b.png>)\n> gövde').details, [{ summary: '', body: '![x](</a/b.png>)\n\ngövde' }], 'an image in a DETAILS summary goes to its text');
  const l1 = mdLabelsOf((k) => `tr:${k}`); const l2 = mdLabelsOf((k) => `de:${k}`);
  assert.ok(l1 !== l2 && l2.code.copyLabel === 'de:board.copy' && l2.footnotes === 'de:board.footnotes', 'a new language: a new labels object with its texts');
  assert.equal(mdLabelsOf((k) => k), mdLabelsOf((k) => k), 'one labels object per language (MarkdownText memoizes by it)');
  assert.equal(replyImageUrl('/a/b.png', '/x', undefined), undefined, 'no base: no image, no throw (review 1)');
  for (const re of [/ReplyCard, \{ key: card\.key, card, sessionId, cwd,/, /ReplyCard, \{ card: rc, sessionId, cwd,/]) assert.match(src, re, 'structure: the feed and the canvas give the card the chat folder');
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
