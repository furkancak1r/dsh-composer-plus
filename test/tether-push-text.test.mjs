// Tether's notification text (2026-11-24, Furkan: "kalın yazma görünmüyor ** ** olarak geliyor"): the gateway's push and
// Tether's own alert show plain text, the first line that says something, without Markdown. One table:
// test/fixtures/push-text.json (the iOS PushTextTests read it too). The gateway's Turkish titles are Tether's own words.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { pushText, PUSH_LINE, PUSH_WORDS } from '../tether/gateway/server.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const table = JSON.parse(read('test/fixtures/push-text.json'));
assert.ok(table.cases.length >= 20);
for (const { text, push } of table.cases) assert.equal(pushText(text, table.approval), push, JSON.stringify(text));
// The approval word comes from the caller (the Mac's language); the default is the English one.
const onay = '```onay\nOnaylıyorum: acme-web main\'e alınsın, canlı değil.\n```';
assert.equal(pushText(onay), 'Approval waits');
assert.equal(pushText(onay, PUSH_WORDS.tr['Approval waits']), 'Onay bekliyor');
assert.equal(pushText(undefined), '');
assert.equal(pushText('```onay\nOnaylıyorum: x\n'), 'Approval waits', 'an open onay block');
// A long line cannot keep the Host busy (review 2026-11-24: 100,000 `[` took 3.5 s): each line is cut first.
for (const long of ['['.repeat(100000), '!['.repeat(50000), '<a '.repeat(40000), `a ${'**x'.repeat(40000)}`]) {
  const t = performance.now(); const s = pushText(long);
  assert.ok(performance.now() - t < 200, `${long.slice(0, 3)}…: ${Math.round(performance.now() - t)} ms`);
  assert.ok([...s].length <= PUSH_LINE);
}
assert.equal([...pushText('界'.repeat(5000))].length, PUSH_LINE, 'cut by code point');

// The gateway's Turkish words are Tether's own (Localizable.xcstrings), so a push and a local alert say the same.
const strings = JSON.parse(read('tether/ios/Resources/Localizable.xcstrings')).strings;
const tr = (key) => strings[key]?.localizations?.tr?.stringUnit?.value;
const en = (key) => strings[key]?.localizations?.en?.stringUnit?.value ?? key;
for (const [key, word] of Object.entries(PUSH_WORDS.tr)) {
  const k = key === 'Approval waits' ? 'cards.onay' : key;
  assert.equal(en(k), key, `${k} is "${key}" in English`);
  assert.equal(tr(k), word, `${key} = Tether's "${tr(k)}"`);
}
console.log('tether push text: plain first line, no Markdown, onay block = the approval word, Turkish titles = Tether\'s words');
