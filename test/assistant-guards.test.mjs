// Assistant reply guards (Host half, error review of 2026-11-24) with a fake dsh. Each guard gives the assistant chat a
// hidden note in a later step (the Approve button's note path), never another chat.
// 1. A self-quote ("Önceki yanıtımda "…" yazdım") that no earlier answer of the chat has: a note at the next step that
//    carries a message, once. A real quote (markdown, case and spaces left out), a short quote and a quote without the
//    words give none; a withdrawn earlier answer does not count, and a withdrawn quote gets no note (both rollback kinds).
// 2. An Auto review denial of a call of this turn: a note in the next step (that step runs anyway after a tool call),
//    once per denial. No denial, a Composer Plus refusal, a denial of an earlier turn or another chat: none.
// 4. A to-do "Onay: …" of owner user in a turn whose answers since the user's newest message have no `onay` block: a
//    note at the next step that carries a message, once. An answer with a block, an item of owner agent, another mark
//    or a refused call: none.
// Each item prints its own line, so a red run shows which item fails.
import assert from 'node:assert/strict';
import './temp-home.mjs';
import * as host from '../index.js';

const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push([name, 'ok']); } catch (error) { checks.push([name, `FAIL: ${String(error?.message ?? error).split('\n')[0]}`]); }
};

const listeners = new Map();
const ctx = { on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }, effect: () => {}, logger: { warn: () => {} } };
const logs = new Map();
const sessionOf = (id) => ({ id, header: {}, inheritedEventCount: 0, snapshotEvents: () => logs.get(id) ?? [] });
const assistant = { ready: Promise.resolve(), isOn: () => true, id: () => 'damon', isAssistant: (agent) => agent?.id === 'damon' };
const installed = typeof host.installAssistantGuards === 'function';
if (installed) host.installAssistantGuards(ctx, assistant);
let seq = 0;
const push = (id, type, data, extra = {}) => {
  const e = { seq: seq++, type, data, ...extra };
  if (!logs.has(id)) logs.set(id, []);
  logs.get(id).push(e); // dsh adds the event to the log before it calls the observers
  for (const fn of listeners.get('session/event') ?? []) fn(sessionOf(id), e);
  return e;
};
const say = (id, text, ...blocks) => push(id, 'assistant/message', { message: { content: [{ type: 'text', text }, ...blocks] } });
const typed = (id, text) => push(id, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `r${seq}` } });
const result = (callId, text, isError = false) => ({ message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, isError, content: [{ type: 'text', text }] } });
const typedMsg = { id: 'u', role: 'user', content: [{ type: 'text', text: 'devam' }], source: { kind: 'user', rpcId: 'r' } };
const step = async (id, messages = [typedMsg]) => {
  assert.ok(installed, 'index.js exports installAssistantGuards');
  return listeners.get('agent/pre-step')[0]({ agent: { id, session: sessionOf(id) }, messages }, async () => ({ kind: 'enter', messages }));
};
const notesOf = (d) => d.messages.filter((m) => m?.source?.kind === 'composer-plus-assistant-guard').map((m) => m.content[0].text);

await check('item 1: a self-quote that is not in the chat log', async () => {
  assert.equal(typeof host.selfQuotes, 'function', 'index.js exports selfQuotes');
  assert.deepEqual(host.selfQuotes(`Önceki yanıtımda "Savaş Bey'e gidecek mail hâlâ panoda olmalı." yazdım ve bu yanlıştı.`), ["Savaş Bey'e gidecek mail hâlâ panoda olmalı."]);
  assert.deepEqual(host.selfQuotes(`Önceki mesajımdaki 'büyük olasılıkla hata çıkar' cümlesini geri alıyorum.`), ['büyük olasılıkla hata çıkar']);
  assert.deepEqual(host.selfQuotes(`Önceki yanıtımda "**Senden:** 12:00'den sonra DSH'yi yeniden başlat." yazmıştım.`), ["**Senden:** 12:00'den sonra DSH'yi yeniden başlat."]);
  assert.deepEqual(host.selfQuotes('Az önce “DSH’yi bu akşam yeniden başlat” dedim, bu doğru değildi.'), ['DSH’yi bu akşam yeniden başlat'], 'curly quotes, an apostrophe inside');
  assert.deepEqual(host.selfQuotes('Daha önce "sunucu bu gece kapanır" demiştim, yanlıştı.'), ['sunucu bu gece kapanır'], 'daha önce');
  assert.deepEqual(host.selfQuotes('Önceki mesajımda ‘canlı kopya güncel’ demiştim.'), ['canlı kopya güncel']);
  assert.deepEqual(host.selfQuotes('Önceki yanıtımda "tamam" yazdım.'), [], 'a quote of fewer than 12 characters');
  assert.deepEqual(host.selfQuotes(`Mailin konusu "Savaş Bey'e gidecek mail hâlâ panoda" olsun.`), [], 'a quote without the words');
  // Review 1 (P2): "yazdım", "dedim" … without a self-reference in the same sentence is not a self-quote.
  for (const text of ['Hafızaya "Ayşe mail imzasını istemiyor" yazdım.', 'Alt ajana "testleri çalıştır ve raporla" dedim.', 'Mailin konusuna "Promes test sonuçları" yazdım.',
    "Taslaktaki 'Saygılarımla, Ayşe Yılmaz' cümlesini düzeltiyorum", 'Dal sohbetine "testleri çalıştır ve push et" dedim.',
    'Önceki yanıtımda bir hata vardı. Alt ajana "testleri çalıştır ve raporla" dedim.',
    // Review 2 (P3): a self-reference with an addressee between it and the quote.
    'Az önce alt ajana "testleri çalıştır ve raporla" dedim.', 'Daha önce hafızaya "Ayşe mail imzasını istemiyor" yazdım.',
    'Az önce dal sohbetine "testleri çalıştır ve push et" dedim.', 'Önceki mesajımda alt ajana "testleri çalıştır ve raporla" dedim.',
  ]) assert.deepEqual(host.selfQuotes(text), [], `not a self-quote: ${text}`);
  // Review 2: "şunu yazdım:" between the reference and the quote, and "yanıtımdaki".
  assert.deepEqual(host.selfQuotes('Önceki yanıtımda şunu yazdım: "yarın sabah sunucu kapanır"'), ['yarın sabah sunucu kapanır'], 'şunu yazdım:');
  assert.deepEqual(host.selfQuotes('Az önce şöyle dedim: "rapor bu akşam hazır olur"'), ['rapor bu akşam hazır olur'], 'az önce şöyle dedim:');
  assert.deepEqual(host.selfQuotes(`Önceki yanıtımdaki 'büyük olasılıkla hata çıkar' cümlesini geri alıyorum.`), ['büyük olasılıkla hata çıkar'], 'yanıtımdaki');
  // Review 1 (P4): a fenced code block is not the answer's own words.
  assert.deepEqual(host.selfQuotes('Örnek:\n```text\nÖnceki yanıtımda "bu bir kod örneğidir" yazdım.\n```\nBitti.'), [], 'inside a fenced code block');
  assert.deepEqual(host.selfQuotes('~~~\nÖnceki yanıtımda "bu da bir kod örneği" yazdım.\n~~~~\nÖnceki yanıtımda "bu cümle kodun dışında" yazdım.'), ['bu cümle kodun dışında'], 'only the text outside the fence');
  // Review 1 (P4): worst-case texts stay fast.
  for (const s of ["'a ".repeat(20000), '‘a’b '.repeat(20000), 'önceki yanıtımda '.repeat(5000), '"aaaaaaaaaaaaaa" dedim '.repeat(4000)]) {
    const started = performance.now(); host.selfQuotes(s);
    assert.ok(performance.now() - started < 1000, `selfQuotes stays fast (${s.slice(0, 12)}…)`);
  }
  // 2026-11-24 11:12, the correct case: the earlier answer has the sentence.
  typed('damon', 'DSH ne zaman?');
  say('damon', "**Tamam.** Saat 12'den sonra uygun.\n\n**Senden:** 12:00'den sonra DSH'yi yeniden başlat.");
  typed('damon', 'emin misin?');
  say('damon', `Önceki yanıtımda "**Senden:** 12:00'den sonra DSH'yi yeniden başlat." yazmıştım. Bu hâlâ geçerli.`);
  assert.deepEqual(notesOf(await step('damon')), [], 'the quote is in an earlier answer: no note');
  // 2026-11-24 10:35: no earlier answer has the sentence.
  say('damon', `Önceki yanıtımda "Savaş Bey'e gidecek mail hâlâ panoda olmalı." yazdım ve bu yanlıştı.`);
  assert.deepEqual(notesOf(await step('damon', [])), [], 'a step without a message: the note waits');
  const [note, more] = notesOf(await step('damon'));
  assert.equal(more, undefined, 'one note');
  assert.match(note, /"Savaş Bey'e gidecek mail hâlâ panoda olmalı\."/);
  assert.match(note, /the quoted text is not in an earlier answer of this chat/);
  assert.match(note, /Write one short line to the user that withdraws this correction\. Never quote a sentence that the log does not have\./);
  assert.deepEqual(notesOf(await step('damon')), [], 'once');
  // Review 1 (P3): the line that withdraws the correction quotes the wrong sentence again: no second note.
  say('damon', `Önceki mesajımda "Savaş Bey'e gidecek mail hâlâ panoda olmalı." yazdığımı söyledim, bu kayıtta yok; düzeltmeyi geri alıyorum.`);
  assert.deepEqual(notesOf(await step('damon')), [], 'a quote that already got a note: no second note');
  // 2026-11-23 16:44.
  say('damon', `Önceki mesajımdaki 'büyük olasılıkla hata çıkar' cümlesini geri alıyorum.`);
  assert.equal(notesOf(await step('damon')).length, 1, '2026-11-23: a note');
  // Review 2 (P3): "yanıtımdaki" and "şunu yazdım:" give a note when the log does not have the quote.
  say('damon', `Önceki yanıtımdaki 'sunucu yarın öğlen kapanacak' cümlesini geri alıyorum.`);
  assert.equal(notesOf(await step('damon')).length, 1, 'yanıtımdaki: a note');
  say('damon', 'Önceki yanıtımda şunu yazdım: "yedek dosyası masaüstünde duruyor"');
  assert.equal(notesOf(await step('damon')).length, 1, 'şunu yazdım: a note');
  say('damon', 'Az önce alt ajana "testleri çalıştır ve raporla" dedim.');
  assert.deepEqual(notesOf(await step('damon')), [], 'a message to another agent: no note');
  // Review 1 (P3): typographic apostrophes and the end mark of a sentence do not matter.
  say('damon', "**Senden:** DSH'yi yeniden başlat");
  say('damon', 'Önceki yanıtımda "Senden: DSH\'yi yeniden başlat." yazmıştım, bu hâlâ geçerli.');
  assert.deepEqual(notesOf(await step('damon')), [], 'an end mark that the earlier answer does not have: no note');
  say('damon', 'Tamam: DSH’yi bu akşam yeniden başlat');
  say('damon', 'Önceki yanıtımda "DSH\'yi bu akşam yeniden başlat" yazmıştım.');
  assert.deepEqual(notesOf(await step('damon')), [], '’ and \' are the same: no note');
  for (const kind of ['composer-plus-rollback', 'dsh-rewind']) {
    // A withdrawn earlier answer is not in the log.
    const old = say('damon', `Sunucu bu gece yeniden başlayacak (${kind}).`);
    push('damon', 'user/message', { content: [], source: { kind } }, { sourceEventSeqs: [old.seq] });
    say('damon', `Önceki yanıtımda "Sunucu bu gece yeniden başlayacak (${kind})." yazdım, yanlıştı.`);
    assert.equal(notesOf(await step('damon')).length, 1, `${kind}: a withdrawn answer does not count`);
    // A withdrawn quote gets no note, and the same quote later gets one.
    const bad = say('damon', `Önceki yanıtımda "Bu cümle hiç yazılmadı (${kind})." yazdım.`);
    push('damon', 'user/message', { content: [], source: { kind } }, { sourceEventSeqs: [bad.seq] });
    assert.deepEqual(notesOf(await step('damon')), [], `${kind}: a withdrawn quote gets no note`);
    say('damon', `Önceki yanıtımda "Bu cümle hiç yazılmadı (${kind})." yazdım.`);
    assert.equal(notesOf(await step('damon')).length, 1, `${kind}: the same quote after the rollback gets a note`);
  }
  // Review 1 (P4): a long log stays fast (each earlier answer is folded only while a quote is not found).
  for (let i = 0; i < 2000; i++) say('damon', `Rapor ${i}: ${'iş bitti, testler geçti. '.repeat(40)}`);
  { const started = performance.now(); say('damon', 'Önceki yanıtımda "bu cümle hiçbir yanıtta yok" yazdım.');
    assert.ok(performance.now() - started < 1000, 'a long log stays fast');
    assert.equal(notesOf(await step('damon')).length, 1, 'a long log: the note'); }
  say('s-web', `Önceki yanıtımda "Savaş Bey'e gidecek mail hâlâ panoda olmalı." yazdım.`);
  assert.deepEqual(notesOf(await step('s-web')), [], 'another chat: no note');
});

await check('item 2: an Auto review denial, then a reply of only [quiet]', async () => {
  push('damon', 'turn/start', { turn: 9 });
  push('damon', 'user/message', { content: [{ type: 'text', text: 'news' }], source: { kind: 'composer-plus-assistant-news' } });
  say('damon', '', { type: 'tool-call', id: 'c1', name: 'send_message' });
  push('damon', 'tool/call', { name: 'send_message', callId: 'c1', arguments: '{"agent":"model-speed","message":"Switch back."}' });
  push('damon', 'tool/result', result('c1', 'Error: Auto review denied this tool call and it did not run. The user was not asked.\nReviewer reason: The message tells the agent to switch the local model server back to its original config, restart it, and try more speed-up paths, and it says not to ask for the stop approval that was denied earlier.', true));
  const [note, more] = notesOf(await step('damon', []));
  assert.equal(more, undefined, 'one note');
  assert.match(note, /Auto review denied a call of this turn \(send_message\)\. Write one short line for the user with the denied action and the reason that the result or this note gives \(do not guess a reason\), in the turn's last reply \(not next to a tool call\)\. Do not reply only \[quiet\]\./);
  assert.ok(!note.includes('Reviewer reason:'), 'the reason is in the result text: the note does not repeat it');
  assert.deepEqual(notesOf(await step('damon', [])), [], 'each denial gets the note once');
  push('damon', 'tool/call', { name: 'chats_list', callId: 'c2', arguments: '{}' });
  push('damon', 'tool/result', result('c2', '{"chats":[]}'));
  assert.deepEqual(notesOf(await step('damon', [])), [], 'no denial: no note');
  push('damon', 'tool/call', { name: 'chat_send', callId: 'c3', arguments: '{}' });
  push('damon', 'tool/result', result('c3', 'Error: Composer Plus → Assistant: the quoted approval "x" is not in a message that the user typed in this chat in the last 12 hours.', true));
  assert.deepEqual(notesOf(await step('damon', [])), [], 'a Composer Plus refusal: no note');
  push('damon', 'tool/call', { name: 'bash', callId: 'c4', arguments: '{}' });
  push('damon', 'tool/result', result('c4', 'Error: Auto review denied this tool call and it did not run.', true));
  assert.match(notesOf(await step('damon', []))[0] ?? '', /\(bash\)/, 'a second denial: its own note');
  // dsh's own Auto review text (dsh-experimental-auto-review denied(), review 4): a note too.
  push('damon', 'tool/call', { name: 'chat_send', callId: 'c6', arguments: '{}' });
  push('damon', 'tool/result', result('c6', 'Error: Auto review rejected tool "chat_send"; its body was not executed', true));
  assert.match(notesOf(await step('damon', []))[0] ?? '', /\(chat_send\)/, "dsh's own denial text: a note");
  // Review 5: dsh's own denial gives the model only that fixed text; the reviewer's reason is in the event's
  // data.error.reason (dsh-tools `error: result.error.info`), and the note carries it.
  push('damon', 'tool/call', { name: 'bash', callId: 'c7', arguments: '{}' });
  push('damon', 'tool/result', { ...result('c7', 'Error: Auto review rejected tool "bash"; its body was not executed', true), error: { name: 'AutoReviewDenied', code: 'AUTO_REVIEW_DENIED', reason: 'It writes to the live server.' } });
  assert.match(notesOf(await step('damon', []))[0] ?? '', /\(bash\)\. Reviewer reason: "It writes to the live server\."\. Write one short line/, "dsh's own denial: the note has the reviewer's reason");
  push('damon', 'turn/end', { reason: { kind: 'completed' } });
  push('damon', 'turn/start', { turn: 10 });
  push('damon', 'tool/call', { name: 'bash', callId: 'c5', arguments: '{}' });
  push('damon', 'tool/result', result('c5', 'Error: Auto review denied this tool call and it did not run.', true));
  push('damon', 'turn/end', { reason: { kind: 'completed' } });
  push('damon', 'turn/start', { turn: 11 });
  assert.deepEqual(notesOf(await step('damon')), [], 'a denial of an earlier turn: no note');
  push('s-web', 'turn/start', { turn: 1 });
  push('s-web', 'tool/call', { name: 'bash', callId: 'w1', arguments: '{}' });
  push('s-web', 'tool/result', result('w1', 'Error: Auto review denied this tool call and it did not run.', true));
  assert.deepEqual(notesOf(await step('s-web', [])), [], 'another chat: no note');
});

await check('item 4: an approval to-do for the user without an onay block', async () => {
  const turn = (args, reply, error = false) => {
    push('damon', 'turn/start', {});
    typed('damon', 'Tether kartını kaldır');
    const callId = `t${seq}`;
    push('damon', 'tool/call', { name: 'todo_list_add', callId, arguments: JSON.stringify(args) });
    push('damon', 'tool/result', result(callId, error ? 'Error: text is 1 to 500 characters.' : `Added 1a2b3c4d (owner ${args.owner ?? 'user'}): ${JSON.stringify(args.text)}`, error));
    say('damon', reply);
    push('damon', 'turn/end', { reason: { kind: 'completed' } });
  };
  // 2026-11-24 13:51.
  turn({ text: "Onay: Tether kart kaldırma düzeltmesi main'e", owner: 'user' }, '**Tether kart düzeltmesi hazır.** Main onayını review bitince isteyeceğim.\n\nSenden bir şey gerekmiyor.');
  assert.deepEqual(notesOf(await step('damon', [])), [], 'a step without a message: the note waits');
  const [note, more] = notesOf(await step('damon'));
  assert.equal(more, undefined, 'one note');
  assert.match(note, /you added an approval item for the user \("Onay: Tether kart kaldırma düzeltmesi main'e"\) without an `onay` block\. Write the `onay` block now, or remove the item with todo_list_remove\./);
  assert.deepEqual(notesOf(await step('damon')), [], 'once');
  turn({ text: 'Onay:   Tether imzası  yenilensin' }, 'Tamam.');
  assert.equal(notesOf(await step('damon')).length, 1, 'a new item without an owner is the user\'s');
  turn({ text: "Onay: Tether kart kaldırma düzeltmesi main'e", owner: 'user' }, "**Onay gerekiyor.**\n\n```onay\nOnaylıyorum: Tether kart kaldırma düzeltmesi main'e alınsın (canlı değil).\n```");
  assert.deepEqual(notesOf(await step('damon')), [], 'an answer with an onay block: no note');
  turn({ text: 'Onay: Tether imzası kontrol edilecek', owner: 'agent' }, 'Tamam.');
  assert.deepEqual(notesOf(await step('damon')), [], 'an item of owner agent: no note');
  turn({ text: 'Senden: DSH yeniden başlat', owner: 'user' }, 'Tamam.');
  assert.deepEqual(notesOf(await step('damon')), [], 'another mark: no note');
  turn({ text: 'Onay: x', owner: 'user' }, 'Tamam.', true);
  assert.deepEqual(notesOf(await step('damon')), [], 'a refused call added nothing: no note');
  // Review 2 (P3): the block of the turn before does not count. Turn 1 (typed) has a block for A; turn 2 (news) adds
  // B and has no block.
  push('damon', 'turn/start', {});
  typed('damon', 'A için onay iste');
  say('damon', "**Onay gerekiyor.**\n\n```onay\nOnaylıyorum: A dalı main'e alınsın (canlı değil).\n```");
  push('damon', 'turn/end', { reason: { kind: 'completed' } });
  push('damon', 'turn/start', {});
  push('damon', 'user/message', { content: [{ type: 'text', text: 'news' }], source: { kind: 'composer-plus-assistant-news' } });
  push('damon', 'tool/call', { name: 'todo_list_add', callId: 'nb1', arguments: JSON.stringify({ text: 'Onay: B canlıya deploy', owner: 'user' }) });
  push('damon', 'tool/result', result('nb1', 'Added 5e6f7a8b (owner user): "Onay: B canlıya deploy"'));
  say('damon', '[quiet]');
  push('damon', 'turn/end', { reason: { kind: 'completed' } });
  assert.match(notesOf(await step('damon'))[0] ?? '', /"Onay: B canlıya deploy"/, 'a news turn without a block: a note');
});

for (const [name, state] of checks) console.log(`${name}: ${state}`);
assert.ok(checks.every(([, state]) => state === 'ok'), 'every item passes');
console.log('assistant-guards checks passed');
