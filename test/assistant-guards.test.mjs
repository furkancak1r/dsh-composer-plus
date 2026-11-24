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
  assert.deepEqual(host.selfQuotes('“DSH’yi bu akşam yeniden başlat” dedim, bu doğru değildi.'), ['DSH’yi bu akşam yeniden başlat'], 'curly quotes, an apostrophe inside');
  assert.deepEqual(host.selfQuotes('Önceki mesajımda ‘canlı kopya güncel’ demiştim.'), ['canlı kopya güncel']);
  assert.deepEqual(host.selfQuotes('Önceki yanıtımda "tamam" yazdım.'), [], 'a quote of fewer than 12 characters');
  assert.deepEqual(host.selfQuotes(`Mailin konusu "Savaş Bey'e gidecek mail hâlâ panoda" olsun.`), [], 'a quote without the words');
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
  // 2026-11-23 16:44.
  say('damon', `Önceki mesajımdaki 'büyük olasılıkla hata çıkar' cümlesini geri alıyorum.`);
  assert.equal(notesOf(await step('damon')).length, 1, '2026-11-23: a note');
  for (const kind of ['composer-plus-rollback', 'dsh-rewind']) {
    // A withdrawn earlier answer is not in the log.
    const old = say('damon', 'Sunucu bu gece yeniden başlayacak.');
    push('damon', 'user/message', { content: [], source: { kind } }, { sourceEventSeqs: [old.seq] });
    say('damon', 'Önceki yanıtımda "Sunucu bu gece yeniden başlayacak." yazdım, yanlıştı.');
    assert.equal(notesOf(await step('damon')).length, 1, `${kind}: a withdrawn answer does not count`);
    // A withdrawn quote gets no note.
    const bad = say('damon', 'Önceki yanıtımda "Bu cümle hiç yazılmadı, uydurma." yazdım.');
    push('damon', 'user/message', { content: [], source: { kind } }, { sourceEventSeqs: [bad.seq] });
    assert.deepEqual(notesOf(await step('damon')), [], `${kind}: a withdrawn quote gets no note`);
  }
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
  assert.match(note, /Auto review denied a call of this turn \(send_message\)\. Write one short line for the user with the denied action and the reason\. Do not reply only \[quiet\]\./);
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
});

for (const [name, state] of checks) console.log(`${name}: ${state}`);
assert.ok(checks.every(([, state]) => state === 'ok'), 'every item passes');
console.log('assistant-guards checks passed');
