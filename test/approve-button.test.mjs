// Approve button: the real client.js parser and buttons, and the Host's prompt rule and switch.
// - parseApprovals: only closed, top-level ```onay blocks; the exact sentence; nothing for anything unsure.
// - A live or public target (production, a deploy, a release, npm publish, a public PR) gets its button too (owner, 2026-11-11).
// - ApproveButtons (dsh's turn-tail slot): only under the newest answer, while the chat is idle and the composer is empty;
//   one click sends the exact sentence once (a second click sends nothing, the button is off); a failed send shows the
//   reason and keeps the button; a sent answer shows none; never for a user message.
// - The Assistant chat (owner, 2026-11-11: "onay butonu çıkmıyor kod bloğu çıkıyor"): the answer that asks for the approval
//   is in the middle of its turn when a subagent's result or Assistant news continues the turn; its sentence still gets
//   the button under the turn's end. An answer of an earlier turn gets it too when only Assistant news or a subagent's
//   result came after it. An answer that you already answered (your message after it) or a withdrawn one gets none.
// - The feature through plugin.apply: on by default; switched off, its slot goes.
// - Host: the prompt section with the `onay` rule, on by default; the switch route removes and adds it.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { APPROVE_PATH, APPROVE_SECTION, installApproveButton } from '../index.js';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__ap = { parseApprovals, parseOptions, ApproveButtons, OptionPicks, createOptionPicks, createRollbackCheck, chatOffer, APPROVAL_MAX };\n    ${ANCHOR}`));
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; return cur.refs[i] ??= { current: v }; },
  useSyncExternalStore: (sub, get) => get(), useLayoutEffect: () => {},
  useEffect: (f, deps) => {
    const i = cur.ei++; const old = cur.deps[i];
    if (old !== undefined && deps !== undefined && deps.length === old.length && deps.every((d, k) => Object.is(d, old[k]))) return;
    cur.cleanups[i]?.(); cur.deps[i] = deps ?? []; cur.cleanups[i] = f();
  } };
const mount = (C, props) => {
  const inst = { state: [], refs: [], cleanups: [], deps: [] };
  return { render: () => { cur = inst; inst.si = 0; inst.ri = 0; inst.ei = 0; return C(props); }, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) } : {}));
const { parseApprovals, parseOptions, ApproveButtons, OptionPicks, createOptionPicks, createRollbackCheck, chatOffer, APPROVAL_MAX } = globalThis.__ap;

// --- parseApprovals ---
const sentences = (text) => parseApprovals(text).map((a) => a.message);
const block = (body, info = 'onay') => `Ready.\n\n\`\`\`${info}\n${body}\n\`\`\`\n`;
const PUSH = "Onaylıyorum: feature/x dalını origin'e push et.";
assert.deepEqual(parseApprovals(block(PUSH)), [{ n: 1, label: PUSH, text: PUSH, message: PUSH }], 'one block: the exact sentence');
assert.deepEqual(sentences(block(PUSH, 'ONAY ')), [PUSH], 'the info string: case and spaces do not matter');
assert.deepEqual(sentences(`~~~onay\n${PUSH}\n~~~`), [PUSH], 'a tilde fence');
assert.deepEqual(sentences(`\`\`\`\`onay\n${PUSH}\n\`\`\`\`\``), [PUSH], 'a longer closing fence');
assert.deepEqual(sentences(`\`\`\`onay\r\n  ${PUSH}  \r\n\r\n\`\`\``), [PUSH], 'CRLF; spaces and blank lines around the sentence go');
assert.deepEqual(sentences(`${block('Onaylıyorum: testleri çalıştır.')}\nAnd:\n${block('Onaylıyorum: feature/y dalını sil.')}`),
  ['Onaylıyorum: testleri çalıştır.', 'Onaylıyorum: feature/y dalını sil.'], 'two blocks: two buttons, in order');
assert.deepEqual(parseApprovals(`${block('A b c.')}${block('D e f.')}`).map((a) => a.n), [1, 2]);
assert.deepEqual(sentences('Satır 1\nsatır 2'), [], 'no block: nothing');
for (const [text, why] of [
  [block(PUSH, ''), 'a block without an info string'],
  [block(PUSH, 'text'), 'another info string'],
  [block(PUSH, 'onay2'), 'a longer info string'],
  [block(PUSH, 'onay x'), 'an info string with more words'],
  [`\`\`\`onay\n${PUSH}\n`, 'an unclosed block'],
  [`\`\`\`onay\n${PUSH}\n~~~\n`, 'closed with the other fence character'],
  [`\`\`\`\`onay\n${PUSH}\n\`\`\`\n`, 'closed with a shorter fence'],
  [`\`\`\`onay\n${PUSH}\n\`\`\` x\n`, 'a closing line with text is no close'],
  [block('   '), 'an empty block'],
  [`1. Step\n   \`\`\`onay\n   ${PUSH}\n   \`\`\``, 'an indented block (in a list)'],
  [`\`\`\`md\n\`\`\`onay\n${PUSH}\n\`\`\`\n\`\`\``, 'a block inside another fence: the inner line is code'],
  [block('a'.repeat(501)), 'longer than 500 characters'],
  [block(`Onaylıyorum: feature/x\u202E dalını sil.`), 'a bidi control character'],
  [block(`Onaylıyorum: feature/x\u200B dalını sil.`), 'a zero-width space'],
  [block('Onaylıyorum: feature/x dalını push et.\u0007'), 'a control character'],
  [block('Onaylıyorum: feature/x dalını push et\u0301.'), 'a combining mark (it could stack over a letter)'],
  [block('Onaylıyorum: рrod dalını push et.'), 'a Cyrillic look-alike letter (р)'],
  [block('Onaylıyorum: dεploy et.'), 'a Greek look-alike letter (ε)'],
  [block('Onaylıyorum: 2٫19 sunucusuna kopyala.'), 'a separator that is not ASCII (Arabic decimal mark)'],
  [block('Onaylıyorum: 2·19 sunucusuna kopyala.'), 'a middle dot between digits'],
  [block('Onaylıyorum: ２.19 sunucusuna kopyala.'.replace('２', '٢')), 'a digit that is not 0–9'],
  [block('Onaylıyorum: dosyayı sil.\uE000'), 'a private-use character'],
  [block('Onaylıyorum: dalı sil ß.'), 'a letter outside the English and Turkish alphabets'],
  [block('Approve: run ᴅᴇᴘʟᴏʏ now.'), 'small capital letters'],
  [block('Approve: switch to pʀoduction.'), 'a small capital letter in a word'],
  [block('Approve: ｄｅｐｌｏｙ now.'), 'full-width letters'],
]) assert.deepEqual(sentences(text), [], `no button: ${why}`);
assert.deepEqual(sentences(block('a'.repeat(500))), ['a'.repeat(500)], '500 characters is the limit');
{ const long = `Onaylıyorum: ${'x '.repeat(240)}sil.`; assert.equal(long.length, 497);
  assert.equal(parseApprovals(block(long))[0].label, long, 'a long sentence: the button shows all of it, never cut (the user approves only what they read)'); }
assert.equal(parseApprovals(block('Onaylıyorum:\n  iki   satır.'))[0].label, 'Onaylıyorum: iki satır.', 'the label: white space as one space');
assert.deepEqual(sentences(block('Onaylıyorum:\nçok satırlı onay.')), ['Onaylıyorum:\nçok satırlı onay.'], 'a sentence over two lines is sent as it is');
assert.deepEqual(sentences(`\`\`\`js\nx()\n\`\`\`\n${block(PUSH)}`), [PUSH], 'a code block before it is skipped');
assert.deepEqual(parseOptions(block(PUSH)), [], 'an approval block is no option list');

// --- Live or public targets: the button shows too (owner, 2026-11-11: "onay mesajlarını bana sorarken her zaman onay butonu çıkmasını sağla") ---
const LIVE = [
  'Onaylıyorum: 2.19 sunucusuna Z aktarımı yap.', 'Onaylıyorum: Z-share klasörüne kopyala.', 'Onaylıyorum: Z: sürücüsüne yaz.',
  'Onaylıyorum: dosyaları paylaşıma kopyala.', 'Onaylıyorum: canlı sunucuyu yeniden başlat.', 'Onaylıyorum: CANLI ortama al.',
  'Approve: restart the live server.', 'Onaylıyorum: production ayarını değiştir.', 'Onaylıyorum: prod ortamına geç.',
  'Onaylıyorum: üretim veritabanına bağlan.', 'Onaylıyorum: 192.168.2.19 üzerinde servisi durdur.', 'Onaylıyorum: 2,19 sunucusunu güncelle.',
  'Onaylıyorum: ssh promes-219 ile betiği çalıştır.', 'Onaylıyorum: promes 219 sunucusunu yeniden başlat.', 'Onaylıyorum: port 5100 servisini durdur.',
  'Onaylıyorum: :5100 portunu aç.', 'Onaylıyorum: live database kaydını sil.', 'Onaylıyorum: canlı DB tablosunu güncelle.',
  'Onaylıyorum: inkool_live tablosunu oku.', 'Onaylıyorum: PRS veritabanına yaz.', 'Onaylıyorum: npm publish çalıştır.',
  'Onaylıyorum: GitHub release v1.26.0 oluştur.', 'Onaylıyorum: release notlarını yayımla.', 'Onaylıyorum: yeni sürümü yayınla.',
  'Onaylıyorum: sürüm 1.26.0 etiketini at.', 'Onaylıyorum: ssh proso-deploy deploy abc çalıştır.', 'Onaylıyorum: deploy et.',
  'Onaylıyorum: Proso sunucusuna dağıt.', 'Onaylıyorum: bu sayfayı herkese açık yap.', 'Onaylıyorum: repoyu public yap.',
  'Onaylıyorum: dosyayı paylaş.', 'Onaylıyorum: DEPLOY et.', 'Onaylıyorum: deploy’u başlat.', 'Onaylıyorum: Ürün kodunu ürün ortamına al: prodüksiyon.',
  'Onaylıyorum: herkese\naçık yap.', 'Onaylıyorum: feature/x için public PR aç.',
  'Approve: deploy demo-app to production.', 'Onaylıyorum: canlı veritabanında (inkool_live) UPDATE çalıştır.',
];
for (const s of LIVE) assert.deepEqual(sentences(block(s)), [s], `a live or public target shows the button: ${s}`);
const SAFE = [
  PUSH, 'Onaylıyorum: feature/onay-dugmesi dalını main ile birleştir.', 'Onaylıyorum: test veritabanında (inkool) sorguyu çalıştır.',
  'Onaylıyorum: npm test çalıştır.', 'Onaylıyorum: .worktrees/feature-x klasörünü sil.', 'Onaylıyorum: test/fixtures dosyasını güncelle.',
  'Approve: run the headless browser test on port 3198.', 'Onaylıyorum: fix/asistan-acilis-hizi dalını origin\'e push et.',
  'Onaylıyorum: ~/Documents/testdeepseekharness/dsh-composer-history kopyasını güncelle.', 'Onaylıyorum: 12 dosyayı biçimlendir.',
];
SAFE.push('Onaylıyorum: “feature/x” dalını sil – sonra main → origin’e push et…', 'Onaylıyorum: ÇĞİÖŞÜ çğıöşü dalını sil.', 'Onaylıyorum: sil ve yeniden oluştur.',
  'Approve: delete the files in test/fixtures and run the 12 tests.', 'Onaylıyorum: feature/login-fix-1 dalını sil.');
{ const nfd = 'Onaylıyorum: üç şube dalını sil.'.normalize('NFD'); assert.notEqual(nfd, nfd.normalize('NFC'));
  assert.deepEqual(sentences(block(nfd)), [nfd], 'decomposed Turkish letters: checked as NFC, sent as written'); }
for (const s of SAFE) assert.deepEqual(sentences(block(s)), [s], `test or branch work shows the button: ${s}`);

// --- ApproveButtons in dsh's turn-tail slot ---
const flush = () => new Promise((r) => setTimeout(r, 0));
const t = (k, p) => (p === undefined ? k : `${k}:${JSON.stringify(p)}`);
const texts = (node) => (Array.isArray(node) ? node.flatMap(texts) : node === null || node === undefined || node === false ? [] : typeof node !== 'object' ? [String(node)] : (node.c ?? []).flatMap(texts));
const buttonsOf = (view) => (view === null ? [] : view.c.flat().filter((c) => c?.t === 'button'));
const tail = (turn, seq, text, status = 'settled') => ({ kind: 'turn-tail', anchorSeq: seq, data: { turn, seq: seq + 1, closing: { status, turn, blocks: [{ kind: 'text', text }], finalNode: { seq } } } });
const user = (seq, text) => ({ kind: 'user', anchorSeq: seq, data: { seq, text } });
const chat = (...nodes) => ({ nodes: new Map(nodes.map((n, i) => [`k${i}`, n])) });
let session = { blank: false, running: false, subagent: null, removed: false };
let input = { phase: 'plain', draft: '', attachmentIds: [] };
const OLD = block('Onaylıyorum: feature/eski dalını sil.');
const NEW = `Done.\n\n${block(PUSH)}`;
let view = chat(tail(1, 10, OLD), user(15, block('Onaylıyorum: kullanıcı mesajı.')), tail(2, 20, NEW));
const rbState = { spans: [], withdrawn: [], rewind: false, busy: false, error: null, redo: null, inherited: 0 };
const rollback = { of: () => rbState, subscribe: () => () => {} };
const check = createRollbackCheck(async () => true);
const sent = []; let gate; let failNext = false;
const picks = createOptionPicks(async (id, text) => { sent.push([id, text]); if (gate) await gate; if (failNext) { failNext = false; throw new Error('conversation.send failed: busy'); } });
const hooks = { useSession: (sel) => sel(session), useInput: (sel) => sel(input), useChat: (sel) => sel(view) };
const cell = (seq, C = ApproveButtons) => mount(C, { sessionId: 'A', turn: {}, seq, ...hooks, picks, check, rollback, t });
const newest = cell(20); const older = cell(10);
assert.equal(newest.render(), null, 'nothing before the Host answered (withdrawn answers)');
await flush();
let out = newest.render();
assert.equal(out.p.role, 'group'); assert.equal(out.p['aria-label'], 'approve.group'); assert.equal(out.p['data-composer-plus-approve'], '20');
let buttons = buttonsOf(out);
assert.equal(buttons.length, 1); assert.deepEqual(texts(buttons[0]), ['approve.button', PUSH], 'the button: "Approve" and the sentence that it sends');
assert.equal(buttons[0].p.title, PUSH); assert.equal(buttons[0].p.type, 'button');
assert.equal(older.render(), null, 'an older answer shows no button');
assert.equal(cell(15).render(), null, 'a user message shows no button');
assert.equal(cell(20, OptionPicks).render(), null, 'an approval block gives no option buttons');
// Composer text, a running chat: hidden.
input = { ...input, draft: 'hm' }; assert.equal(newest.render(), null, 'a draft hides the button'); input = { ...input, draft: '' };
session = { ...session, running: true }; assert.equal(newest.render(), null, 'not while the chat runs'); session = { ...session, running: false };
// One click sends the exact sentence once; a second click sends nothing; the button is off meanwhile.
let release; gate = new Promise((r) => { release = r; });
buttons = buttonsOf(newest.render()); buttons[0].p.onClick(); buttons[0].p.onClick();
assert.ok(buttonsOf(newest.render()).every((b) => b.p.disabled === true), 'off while the sentence is sent');
assert.deepEqual(sent, [['A', PUSH]], 'one message: the exact sentence');
release(); await flush(); gate = undefined;
assert.equal(newest.render(), null, 'a sent answer shows no button');
assert.equal(await picks.pick('A', chatOffer(view, [], 0, parseApprovals), 1), false, 'a direct second send of the same answer: refused');
assert.equal(sent.length, 1, 'still one message');
// A new answer with a new block: the button comes back for it; a failed send shows the reason and keeps the button.
view = chat(...view.nodes.values(), user(22, PUSH), tail(3, 30, block('Onaylıyorum: feature/z dalını sil.')));
const third = cell(30); third.render(); await flush();
failNext = true; buttonsOf(third.render())[0].p.onClick(); await flush();
out = third.render(); assert.equal(buttonsOf(out).length, 1, 'the button stays after a failed send');
assert.equal(out.c.at(-1).p.role, 'alert'); assert.equal(texts(out.c.at(-1)).join(''), 'approve.failed:{"error":"conversation.send failed: busy"}');
buttonsOf(third.render())[0].p.onClick(); await flush();
assert.deepEqual(sent.at(-1), ['A', 'Onaylıyorum: feature/z dalını sil.'], 'the retry sends');
// A live sentence in the newest answer: its button shows too, and a click sends it.
const PUBLISH = 'Onaylıyorum: npm publish çalıştır.';
view = chat(...view.nodes.values(), user(32, 'x'), tail(4, 40, block(PUBLISH)));
const live = cell(40); live.render(); await flush();
buttons = buttonsOf(live.render()); assert.equal(buttons.length, 1, 'a live sentence: one button');
assert.deepEqual(texts(buttons[0]), ['approve.button', PUBLISH]);
buttons[0].p.onClick(); await flush(); assert.deepEqual(sent.at(-1), ['A', PUBLISH], 'a click sends the live sentence');
newest.unmount(); older.unmount(); third.unmount(); live.unmount();

// --- An approval in the middle of a turn (the Assistant chat: a subagent's result continues the turn) ---
{
  const CAT = 'Onaylıyorum: Composer Plus kategori filtresi önerilen 8 kategoriyle yapılsın, sonraki sürüme girsin.';
  const step = (turn, stepNo, seq, text) => ({ kind: 'assistant-step', anchorSeq: seq, data: { status: 'settled', turn, step: stepNo, blocks: [{ kind: 'text', text }], finalNode: { seq } } });
  const ctx = (seq) => ({ kind: 'turn-trigger', anchorSeq: seq, data: { seq, source: { kind: 'subagent-settled' } } });
  const ASK = `The category filter is ready to plan. It needs your approval:\n\n${block(CAT)}`;
  const mid = chat(user(100, 'kategori filtresi yap'), step(9, 3, 110, ASK), ctx(112), step(9, 4, 115, 'Subagent done: the review passed.'), tail(9, 115, 'Subagent done: the review passed.'));
  const offer = chatOffer(mid, [], 0, parseApprovals);
  assert.deepEqual(offer?.options.map((o) => o.message), [CAT], 'a sentence in an earlier answer of the turn gets the button');
  assert.equal(offer.seq, 115, 'the button sits under the turn\'s end (its closing answer)');
  assert.deepEqual(chatOffer(mid, [], 0, parseOptions), undefined, 'Option buttons still read only the closing answer');
  const answered = chat(user(100, 'x'), step(9, 3, 110, ASK), user(113, CAT), step(9, 4, 115, 'Done.'), tail(9, 115, 'Done.'));
  assert.equal(chatOffer(answered, [], 0, parseApprovals), undefined, 'an answer before your newest message: you answered it');
  const later = chat(user(100, 'x'), step(9, 3, 110, ASK), ctx(112), step(9, 4, 115, 'Done.'), tail(9, 115, 'Done.'), user(116, 'y'), step(10, 1, 120, 'Ok.'), tail(10, 120, 'Ok.'));
  assert.equal(chatOffer(later, [], 0, parseApprovals), undefined, 'a newer turn: the older approval gives none');
  assert.deepEqual(chatOffer(later, [[116, 130]], 0, parseApprovals)?.options.map((o) => o.message), [CAT], 'your later message withdrawn (rollback): the button comes back');
  const twice = chat(user(100, 'x'), step(9, 3, 110, ASK), ctx(112), step(9, 4, 115, `Still waiting:\n\n${block(CAT)}`), tail(9, 115, `Still waiting:\n\n${block(CAT)}`));
  assert.deepEqual(chatOffer(twice, [], 0, parseApprovals)?.options.map((o) => [o.n, o.message]), [[1, CAT]], 'the same sentence twice: one button');
  assert.equal(chatOffer(mid, [[105, 111]], 0, parseApprovals), undefined, 'a withdrawn answer gives none');
  assert.equal(chatOffer(mid, [], 112, parseApprovals), undefined, 'a fork\'s inherited answer gives none');
  // An answer of an earlier turn, then a new turn that a subagent's result or Assistant news started (owner, 2026-11-11:
  // "onay butonu çıkmıyor"): you did not answer it yet, so the button shows under the newest turn's end.
  const older = chat(user(90, 'x'), step(8, 1, 95, ASK), tail(8, 95, ASK), ctx(99), step(9, 1, 115, 'Done.'), tail(9, 115, 'Done.'));
  const olderOffer = chatOffer(older, [], 0, parseApprovals);
  assert.deepEqual(olderOffer?.options.map((o) => o.message), [CAT], 'an answer of an earlier turn, then a subagent turn: the button shows');
  assert.equal(olderOffer.seq, 115, 'under the newest turn\'s end');
  // dsh draws a message whose source is not "user" (Assistant news, a subagent's result) as a context row, not as your message.
  const news = (seq) => ({ kind: 'context', anchorSeq: seq, data: { kind: 'context', seq, source: { kind: 'composer-plus-assistant-news', form: 'snapshot' } } });
  const newsTurn = chat(user(90, 'x'), step(8, 1, 95, ASK), tail(8, 95, ASK), news(99), step(9, 1, 115, 'X finished.'), tail(9, 115, 'X finished.'));
  assert.deepEqual(chatOffer(newsTurn, [], 0, parseApprovals)?.options.map((o) => o.message), [CAT], 'an Assistant news steer between them: the button still shows');
  const humanAfter = chat(user(90, 'x'), step(8, 1, 95, ASK), tail(8, 95, ASK), user(97, 'Bekle.'), step(9, 1, 100, 'Ok.'), tail(9, 100, 'Ok.'),
    news(105), step(10, 1, 115, 'X finished.'), tail(10, 115, 'X finished.'));
  assert.equal(chatOffer(humanAfter, [], 0, parseApprovals), undefined, 'your message after the answer (you answered or skipped it): none');
  assert.equal(chatOffer(older, [], 96, parseApprovals), undefined, 'a fork\'s inherited earlier answer gives none');
  // The rendered button under the turn's end, and a click sends the sentence.
  view = mid; const cellMid = cell(115); cellMid.render(); await flush();
  const midButtons = buttonsOf(cellMid.render());
  assert.equal(midButtons.length, 1, 'one button under the turn end'); assert.deepEqual(texts(midButtons[0]), ['approve.button', CAT]);
  assert.equal(cell(110).render(), null, 'not twice: the earlier answer itself shows none');
  midButtons[0].p.onClick(); await flush(); assert.deepEqual(sent.at(-1), ['A', CAT], 'a click sends the sentence');
  cellMid.unmount();
  // One button at a time (the owner, 2026-11-12: "tek seferde tek onay butonu gösterilsin ve hepsi tek butonda yer alsın"):
  // two answers with blocks after one user message (a subagent's result between them) give only the newest block.
  const X = 'Onaylıyorum: X dalını push et.'; const XY = 'Onaylıyorum: X dalını push et ve Y dalını main ile birleştir.';
  const both = chat(user(100, 'x'), step(9, 1, 105, block(X)), ctx(107), step(9, 2, 110, block(XY)), tail(9, 110, block(XY)));
  assert.deepEqual(chatOffer(both, [], 0, parseApprovals)?.options.map((o) => o.message), [XY], 'two answers with blocks: one button, the newest');
  const quiet = chat(...both.nodes.values(), ctx(112), step(10, 1, 120, 'Subagent done.'), tail(10, 120, 'Subagent done.'));
  const quietOffer = chatOffer(quiet, [], 0, parseApprovals);
  assert.deepEqual(quietOffer?.options.map((o) => o.message), [XY], 'a later answer without a block keeps that button');
  assert.equal(quietOffer.seq, 120, 'under the newest turn\'s end');
  assert.deepEqual(chatOffer(quiet, [[108, 111]], 0, parseApprovals)?.options.map((o) => o.message), [X], 'the newest block withdrawn (rollback): the older block offers again');
  view = quiet; const cellQuiet = cell(120); cellQuiet.render(); await flush();
  assert.deepEqual(buttonsOf(cellQuiet.render()).map((b) => b.p.title), [XY], 'rendered: one button');
  cellQuiet.unmount();
}

// --- The feature through plugin.apply ---
{
  const slots = new Map(); let setFeature;
  plugin.apply({
    slots: { inject: (n, f) => f(), register: (o, C) => { if (o.id === 'composer-plus') setFeature = o.inject().setFeature; const key = Symbol(o.id); slots.set(key, [o, C]); return () => slots.delete(key); } },
    configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k }, effect: (f) => f(),
  });
  const slot = () => [...slots.values()].find(([o]) => o.id === 'approve-button');
  const found = slot(); assert.ok(found, 'on by default: the turn-tail slot');
  assert.equal(found[0].name, 'conversation.chat.turnTail'); assert.equal(found[0].locale, 'dsh-composer-plus'); assert.equal(found[1], ApproveButtons);
  const face = found[0].inject('A'); assert.equal(typeof face.picks.pick, 'function'); assert.equal(typeof face.check.ask, 'function');
  const options = [...slots.values()].find(([o]) => o.id === 'option-picks');
  assert.equal(options[0].inject('A').picks, face.picks, 'one store with Option picks: one send per answer');
  setFeature('approveButton', false); assert.equal(slot(), undefined, 'off: no slot');
  setFeature('approveButton', true); assert.ok(slot(), 'on again');
}

// --- Host: the prompt rule and its switch ---
const root = await mkdtemp(join(tmpdir(), 'cp-approve-'));
try {
  const routes = new Map(); const effects = []; const sections = new Map(); let disposed = 0;
  const ctx = {
    connection: { fetch: { register: (r) => routes.set(r.path, r) } }, effect: (f) => effects.push(f()),
    inject(names, setup) {
      assert.deepEqual(names, ['systemPrompt']);
      const offs = [];
      setup({ systemPrompt: { section: (s) => { sections.set(s.name, s); offs.push(() => sections.delete(s.name)); } } });
      return { dispose: () => { disposed++; offs.forEach((f) => f()); } };
    },
  };
  const home = join(root, 'home');
  const host = installApproveButton(ctx, home); await host.ready;
  const req = async (body) => { const r = await routes.get(APPROVE_PATH).fetch(new Request(`http://h${APPROVE_PATH}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  assert.deepEqual((await req()).body, { on: true }, 'on by default');
  const section = sections.get('composer-plus:approve-button');
  assert.ok(section, 'the prompt section'); assert.equal(section.interpolate, false); assert.equal(section.text(), APPROVE_SECTION);
  assert.match(APPROVE_SECTION, /info string `onay`/); assert.match(APPROVE_SECTION, /```onay\nOnaylıyorum: feature\/x dalını origin'e push et\.\n```/);
  assert.deepEqual(sentences(APPROVE_SECTION), ["Onaylıyorum: feature/x dalını origin'e push et."], 'the example in the rule is a block that the client reads');
  assert.match(APPROVE_SECTION, /Each approval sentence gets the block, also one that names a live or public target/, 'the rule: a block for each approval sentence');
  assert.doesNotMatch(APPROVE_SECTION, /no button|user types it/, 'no exception for live or public targets');
  assert.match(APPROVE_SECTION, /Write at most one `onay` block per answer/);
  // One button at a time (the owner, 2026-11-12: a click removes the other buttons): all pending approvals in one block.
  assert.match(APPROVE_SECTION, /Write at most one `onay` block in the chat at a time\. When several approvals are pending, put all of them in one sentence in one block in your newest reply:/, 'one block for all pending approvals');
  assert.match(APPROVE_SECTION, /only the newest block gets a button\. After a user message, when an approval is still pending, include it again in the next `onay` block, together with any new approval\./, 'a pending approval comes back in the next block');
  assert.match(APPROVE_SECTION, /Write at most one `onay` block per answer/, 'still one block in a reply');
  // The rule's limit is the client's limit (approvable: a longer block gets no button).
  assert.match(APPROVE_SECTION, new RegExp(`Keep the block under ${APPROVAL_MAX} characters: a longer block shows only as code, without the button\\.`), 'the length limit');
  assert.doesNotMatch(APPROVE_SECTION, /Show the `onay` block once|do not repeat the block/, 'no rule that hides a pending approval');
  assert.match(APPROVE_SECTION, /name the targets and the live or not-live scope, without file lines or script names/, 'a short sentence');
  for (const bad of [{ on: 'yes' }, { on: true, x: 1 }, {}, []]) assert.equal((await req(bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await req({ on: false })).body, { on: false });
  assert.equal(sections.size, 0, 'off: no section'); assert.ok(disposed >= 1);
  await Promise.all([req({ on: true }), req({ on: false }), req({ on: true })]);
  assert.deepEqual((await req()).body, { on: true }, 'the newest click wins'); assert.ok(sections.has('composer-plus:approve-button'));
  await req({ on: false });
  const again = installApproveButton({ ...ctx, connection: { fetch: { register: () => {} } } }, home); await again.ready;
  assert.equal(sections.size, 0, 'a saved "off" stays off after a restart');
  await req({ on: true }); const before = disposed; effects.forEach((f) => typeof f === 'function' && f()); assert.ok(disposed > before, 'unload disposes');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('approve-button checks passed');
