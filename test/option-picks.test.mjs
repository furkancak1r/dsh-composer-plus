// Runs the real client.js Option picks core (phase 3 of the agentbox ideas plan). parseOptions: an answer offers choices
// only when it ends with a numbered list of 1–9 items, numbered from 1, right under an "Options"-like heading or bold
// line in one of the languages; "(recommended)" marks one item; every other shape gives nothing. chatOffer: the list of
// the newest turn that a rollback did not withdraw (both marker kinds), not while it runs or when it was stopped.
// createOptionPicks: one pick per chat at a time from every entry point, the same answer never twice, a failed send
// leaves the buttons on, a newer turn opens them again.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__op = { parseOptions, chatOffer, createOptionPicks };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const { parseOptions, chatOffer, createOptionPicks } = globalThis.__op;
const labels = (text) => parseOptions(text).map((o) => o.label);

// --- parseOptions: the shapes that count ---
const basic = 'I fixed the login.\n\n## Options\n\n1. Merge it\n2. Add a test first (recommended)\n3. Leave it\n';
assert.deepEqual(parseOptions(basic), [
  { n: 1, label: 'Merge it', text: 'Merge it', recommended: false },
  { n: 2, label: 'Add a test first', text: 'Add a test first', recommended: true },
  { n: 3, label: 'Leave it', text: 'Leave it', recommended: false },
], 'a heading, a numbered list, the recommended mark removed');
assert.deepEqual(labels('Done.\n\n**Options:**\n1) Ship\n2) Wait'), ['Ship', 'Wait'], 'a bold line with a colon, `1)` items');
assert.deepEqual(labels('Done.\n__Next steps__\n1. Ship'), ['Ship'], 'one item is a list; __bold__');
assert.deepEqual(labels('#### options :\n1. a\n2. b'), ['a', 'b'], 'any case; #### with a spaced colon');
assert.deepEqual(labels('### Choices ###\n1. a'), ['a'], 'closing #s of a heading');
assert.deepEqual(labels('Done.\r\n\r\n## Options\r\n1. Ship\r\n2. Wait\r\n'), ['Ship', 'Wait'], 'CRLF');
assert.deepEqual(labels('## Options\n\n1. Ship\n\n2. Wait\n\n\n'), ['Ship', 'Wait'], 'blank lines between and after the items');
// Languages: headings and recommended marks, accents and case do not matter.
assert.deepEqual(parseOptions('Bitti.\n\n## Seçenekler\n1. Birleştir (önerilen)\n2. Bekle').map((o) => [o.label, o.recommended]), [['Birleştir', true], ['Bekle', false]], 'Turkish');
assert.deepEqual(parseOptions('完成。\n\n**选项：**\n1. 合并（推荐）\n2. 等待').map((o) => [o.label, o.recommended]), [['合并', true], ['等待', false]], 'Chinese: full-width colon and parentheses');
assert.deepEqual(parseOptions('## SECENEKLER\n1. a (ONERILEN)').map((o) => o.recommended), [true], 'without Turkish letters, in capitals');
assert.deepEqual(parseOptions('## Opciones\n1. Fusionar (Recomendada)\n2. Esperar').map((o) => o.recommended), [true, false], 'Spanish');
assert.deepEqual(parseOptions('## Варианты\n1. Слить (рекомендуется)').map((o) => o.recommended), [true], 'Russian');
assert.deepEqual(parseOptions('## Options\n1. Ship **(Recommended)**').map((o) => [o.label, o.recommended]), [['Ship', true]], 'a bold mark');
assert.deepEqual(parseOptions('## Options\n1. Ship (fast)\n2. Wait (recommended) for CI').map((o) => [o.label, o.recommended]),
  [['Ship (fast)', false], ['Wait for CI', true]], 'other parentheses stay; a mark in the middle goes');
// Button label vs. sent text: Markdown marks leave the label; the later lines of an item go into the message.
const long = parseOptions('## Options\n1. **Refactor** the `auth` module, see [notes](https://x.test/n)\n   It touches 4 files.\n   - keeps the API\n2. Stop');
assert.equal(long[0].label, 'Refactor the auth module, see notes', 'no ** ` or link target in the button');
assert.equal(long[0].text, '**Refactor** the `auth` module, see [notes](https://x.test/n)\nIt touches 4 files.\n- keeps the API', 'the whole item, indent removed');
assert.equal(long[1].text, 'Stop');
const big = parseOptions(`## Options\n1. ${'x'.repeat(300)}`)[0];
assert.equal(big.label.length, 200); assert.ok(big.label.endsWith('…')); assert.equal(big.text.length, 300, 'the message keeps the whole item');
assert.equal(labels(`## Options\n${Array.from({ length: 9 }, (_, i) => `${i + 1}. o${i + 1}`).join('\n')}`).length, 9, '9 items');
assert.deepEqual(labels('Here is the code:\n```js\nconst a = 1;\n```\n\n## Options\n1. Keep\n2. Drop'), ['Keep', 'Drop'], 'a closed code block before the heading');
assert.deepEqual(labels('## Options\n1. Run it:\n   ```sh\n   npm test\n   ```\n2. Skip'), ['Run it:', 'Skip'], 'an indented code block inside an item');
assert.equal(parseOptions('## Options\n1. Run it:\n   ```sh\n   npm test\n   ```\n2. Skip')[0].text, 'Run it:\n```sh\nnpm test\n```');
assert.equal(parseOptions('## Options\n1. a\n\n   more\n2. b')[0].text, 'a\n\nmore', 'a blank line inside an item stays');
assert.deepEqual(parseOptions('## Options\n1. a\n   2. sub\n2. b').map((o) => [o.label, o.text]), [['a', 'a\n2. sub'], ['b', 'b']], 'an indented number is part of the item');

// --- parseOptions: the shapes that do not count ---
for (const [text, why] of [
  ['', 'empty'], [undefined, 'no text'], [42, 'not text'],
  ['Done. Everything works.', 'no list'],
  ['1. Ship\n2. Wait', 'a list without a heading'],
  ['## Options\n1. Ship\n2. Wait\n\nTell me which one.', 'text after the list'],
  ['## Options\n1. Ship\n\n## Notes\nnothing', 'the list is not the last block'],
  ['## Summary\n1. Fixed A\n2. Fixed B', 'another heading'],
  ['## My options today\n1. a', 'a heading that only contains the word'],
  ['Options\n1. a', 'a plain line is not a heading'],
  ['##### Options\n1. a', 'a level-5 heading'],
  ['**Options** below\n1. a', 'a bold word in a sentence'],
  ['## Options\nPick one:\n1. a', 'text between the heading and the list'],
  ['## Options\n   indented note\n1. a', 'an indented line between the heading and the list'],
  ['## Options\n2. a\n3. b', 'numbers not from 1'],
  ['## Options\n1. a\n3. b', 'a gap'],
  ['## Options\n1. a\n1. b', 'a repeated number'],
  ['## Options\n1. a\n2) b', 'mixed delimiters'],
  [`## Options\n${Array.from({ length: 10 }, (_, i) => `${i + 1}. o`).join('\n')}`, '10 items'],
  ['## Options\n- a\n- b', 'a bullet list'],
  ['## Options\n1.\n2. b', 'an empty item'],
  ['## Options\n1. (recommended)', 'an item that is only the mark'],
  ['```md\n## Options\n1. a\n2. b', 'inside an open code block'],
  ['```\nx\n```\n```md\n## Options\n1. a', 'inside a second, open code block'],
  ['## Options\n1.Ship', 'no space after the number'],
  ['## Options\n 1. a', 'an indented list is part of something else'],
]) assert.deepEqual(parseOptions(text), [], why);

// --- A CANLI DEPLOY line in any item: no options, the user types the answer (owner, 2026-11-12: the Auto review deploy
// gate counts a pick as typed). The same list without the line keeps its options. ---
{ const live = '## Options\n1. Deploy now\n   CANLI DEPLOY PROMES 22e33b30 ŞİMDİ\n2. Wait';
  assert.deepEqual(parseOptions(live), [], 'the line on its own line of an item');
  assert.deepEqual(parseOptions(live.replace('CANLI DEPLOY', 'canlı deploy')), [], 'lower case and Turkish ı');
  assert.deepEqual(parseOptions(live.replace('CANLI DEPLOY', 'CANLİ DEPLOY')), [], 'Turkish İ');
  assert.deepEqual(parseOptions('## Options\n1. CANLI DEPLOY PROSO 3f2a9c1 SAAT 21:10\n2. Wait').map((o) => o.label), [], 'the line as the label');
  assert.deepEqual(parseOptions(live.replace('   CANLI DEPLOY PROMES 22e33b30 ŞİMDİ\n', '')).map((o) => o.label), ['Deploy now', 'Wait'], 'without the line: options'); }

// --- One table for both apps: Tether's Swift parseOptions reads the same cases (tether/ios/Tests). ---
const shared = JSON.parse(readFileSync(new URL('./fixtures/option-lists.json', import.meta.url), 'utf8')).cases;
for (const { text, options } of shared) assert.deepEqual(parseOptions(text), options, `fixture: ${JSON.stringify(text).slice(0, 60)}`);
assert.ok(shared.length >= 40 && shared.some((x) => x.options.length === 0) && shared.some((x) => x.options.some((o) => o.recommended)), 'the fixture has match, no-match and recommended cases');
// Tether keeps the same heading and "recommended" words.
{ const swift = readFileSync(new URL('../tether/ios/Sources/Core.swift', import.meta.url), 'utf8');
  const words = (name, from) => JSON.parse(`[${from.match(new RegExp(`${name} = \\[([^\\]]*)\\]`))[1].replace(/'/g, '"')}]`);
  for (const [js, sw] of [['OPTION_HEADINGS', 'optionHeadings'], ['OPTION_RECOMMENDED', 'optionRecommended']]) assert.deepEqual(words(sw, swift), words(js, src), `Tether's ${sw} = client.js ${js}`); }

// --- chatOffer: the newest answer that is still in the chat ---
const tail = (turn, seq, text, status = 'settled') => ({ kind: 'turn-tail', anchorSeq: seq, data: { turn, seq: seq + 1, closing: text === null ? null
  : { status, turn, blocks: [{ kind: 'reasoning', text: '## Options\n1. secret' }, ...(Array.isArray(text) ? text : [text]).map((t) => ({ kind: 'text', text: t }))], finalNode: { seq } } } });
const chat = (...nodes) => ({ nodes: new Map(nodes.map((n, i) => [`k${i}`, n])) });
const opts = '## Options\n1. Merge\n2. Wait';
assert.deepEqual(chatOffer(chat(tail(1, 10, 'Hi.'), { kind: 'user', data: { seq: 12 } }, tail(2, 20, `Done.\n\n${opts}`)), []),
  { seq: 20, turn: 2, latest: 2, options: parseOptions(opts) }, 'the newest turn; reasoning is left out');
assert.equal(chatOffer(chat(tail(1, 10, opts), tail(2, 20, 'No options now.')), []), undefined, 'an older list does not come back');
assert.deepEqual(chatOffer(chat(tail(1, 10, ['Done.\n\n## Opt', 'ions\n1. Merge\n2. Wait'])), [])?.options.map((o) => o.label), ['Merge', 'Wait'],
  'text blocks joined as dsh joins them (no separator)');
assert.equal(chatOffer(chat(tail(1, 10, opts, 'running')), []), undefined, 'not while the answer streams');
assert.equal(chatOffer(chat(tail(1, 10, opts, 'interrupted')), []), undefined, 'not a stopped answer');
assert.equal(chatOffer(chat(tail(1, 10, null)), []), undefined, 'a turn without an answer');
assert.equal(chatOffer(chat(tail(1, 10, opts), tail(2, 20, null)), []), undefined, 'a newer turn without an answer hides the older list');
assert.equal(chatOffer(undefined, []), undefined, 'no chat view yet');
assert.equal(chatOffer(chat(), []), undefined, 'an empty chat');
// Rule 9: a withdrawn turn does not count, with either marker kind; the newest turn still in the chat does.
const withdrawn = chat(tail(1, 10, opts), tail(2, 20, '## Options\n1. Revert'));
assert.deepEqual(chatOffer(withdrawn, [[15, 25]])?.options.map((o) => o.label), ['Merge', 'Wait'], 'Turn rollback span: the turn before it offers again');
assert.deepEqual(chatOffer(withdrawn, [[15, 25]])?.latest, 2, 'latest still counts the withdrawn turn');
assert.equal(chatOffer(withdrawn, [[5, 25]]), undefined, 'both turns withdrawn');
assert.equal(chatOffer(chat(tail(1, 10, opts)), [[10, 12]]), undefined, 'a span that starts at the answer');
// Rule 10: a fork's inherited answer (seq before its inherited event count) is the parent's: no buttons until the fork's
// own first answer.
const fork = chat(tail(1, 10, opts));
assert.equal(chatOffer(fork, [], 13), undefined, 'the parent\'s answer in a fork');
assert.deepEqual(chatOffer(fork, [], 10)?.seq, 10, 'an answer at the cut is the fork\'s own');
assert.deepEqual(chatOffer(fork, [])?.seq, 10, 'no fork: from 0');
assert.deepEqual(chatOffer(chat(tail(1, 10, opts), tail(2, 20, opts)), [], 13)?.seq, 20, 'the fork\'s own answer offers');
assert.equal(chatOffer(chat(tail(1, 10, opts), tail(2, 20, opts)), [[15, 25]], 13), undefined, 'its own answer withdrawn: the inherited one still offers nothing');

// --- createOptionPicks: the guard (rule 7) ---
const sent = []; let gate; let failNext = false;
const picks = createOptionPicks(async (sessionId, text) => {
  sent.push([sessionId, text]);
  if (gate !== undefined) await gate;
  if (failNext) { failNext = false; throw new Error('conversation.send failed: busy'); }
});
const events = []; const off = picks.subscribe(() => events.push(picks.of('A')));
const offer = chatOffer(chat(tail(1, 10, '## Options\n1. Merge it\n2. Add a test first\n   with a fixture')), []);
assert.equal(picks.open('A', offer), true, 'a new offer is open');
assert.equal(picks.of('A'), picks.of('A'), 'one state object until it changes');
let release; gate = new Promise((r) => { release = r; });
const first = picks.pick('A', offer, 2);
assert.equal(picks.of('A').busy, true); assert.equal(picks.open('A', offer), false, 'closed while the pick is sent');
assert.equal(await picks.pick('A', offer, 1), false, 'a second click or key during the send sends nothing');
assert.equal(await picks.pick('A', { ...offer, seq: 99, latest: 5 }, 1), false, 'not even another answer of the same chat');
assert.deepEqual(sent, [['A', 'Option 2: Add a test first\nwith a fixture']], 'one message: the whole item');
release(); assert.equal(await first, true); gate = undefined;
assert.deepEqual(picks.of('A'), { busy: false, picked: { seq: 10, latest: 1 }, error: null });
assert.equal(picks.open('A', offer), false, 'a picked answer stays off');
assert.equal(await picks.pick('A', offer, 1), false, 'and cannot be picked again'); assert.equal(sent.length, 1);
// Another chat is independent.
assert.equal(picks.open('B', offer), true); assert.equal(await picks.pick('B', offer, 1), true); assert.deepEqual(sent.at(-1), ['B', 'Option 1: Merge it']);
// A newer turn opens the buttons again: a new answer, or the same answer again after the pick was rolled back.
const next = chatOffer(chat(tail(1, 10, opts), tail(2, 20, opts)), []);
assert.equal(picks.open('A', next), true, 'the next answer offers again');
const back = chatOffer(chat(tail(1, 10, opts), tail(2, 20, opts)), [[15, 25]]);
assert.deepEqual([back.seq, back.latest], [10, 2]); assert.equal(picks.open('A', back), true, 'after a rollback of the pick, the old answer offers again');
// A failed send leaves the buttons on and shows why; then a pick works.
failNext = true;
assert.equal(await picks.pick('A', next, 1), false);
assert.deepEqual(picks.of('A'), { busy: false, picked: { seq: 10, latest: 1 }, error: 'conversation.send failed: busy' });
assert.equal(picks.open('A', next), true, 'a failed send does not close the offer');
assert.equal(await picks.pick('A', next, 2), true); assert.equal(picks.of('A').error, null, 'the next pick clears the error');
// Bad input: an option that is not there, no offer.
assert.equal(await picks.pick('C', offer, 7), false, 'no option 7'); assert.equal(await picks.pick('C', undefined, 1), false, 'no offer');
assert.equal(picks.open('C', undefined), false);
off(); const count = events.length; await picks.pick('D', offer, 1); assert.equal(events.length, count, 'unsubscribed');
assert.ok(events.every((s) => Object.isFrozen(s)), 'each published state is frozen');
console.log('option-picks checks passed');
