// Tether's Approve button and assistant name, the same as the Mac (CI has no Swift: this checks the shared table and the
// contract in the source; the behavior has XCTests in tether/ios/Tests, testApprovalBlocksMatchTheMac and testApproveClient).
// - test/fixtures/approval-blocks.json is client.js parseApprovals: one table for both apps.
// - Tether's expressions are client.js APPROVAL_CHARS, APPROVAL_HOLD, APPROVAL_DUR, APPROVAL_SCOPE_OFF, APPROVAL_LIVE_WORD,
//   DEPLOY_ASK and DEPLOY_LINE (JS `[^]` written as `[\s\S]`), and approvalMax is APPROVAL_MAX.
// - A tap asks once and sends the exact sentence through the composer's send (session/prompt, your message).
// - The assistant is Damon on the phone too (one name: index.js and client.js ASSISTANT_NAME).
// - The gateway's /me gives the Composer Plus language that the Host knows (`lang`), so the phone's words follow it.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { ASSISTANT_NAME, reportedLanguage, mobileGateway } from '../index.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const src = read('client.js'), core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
eval(src.replace(ANCHOR, `globalThis.__ta = { parseApprovals, APPROVAL_MAX, APPROVAL_CHARS, APPROVAL_HOLD, APPROVAL_DUR, APPROVAL_SCOPE_OFF, APPROVAL_LIVE_WORD, DEPLOY_ASK, DEPLOY_LINE };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const js = globalThis.__ta;

// One table for both apps.
const { cases } = JSON.parse(read('test/fixtures/approval-blocks.json'));
for (const { text, sentences } of cases) assert.deepEqual(js.parseApprovals(text).map((a) => a.message), sentences, `fixture: ${JSON.stringify(text).slice(0, 70)}`);
assert.ok(cases.length >= 100 && cases.some((c) => c.sentences.length === 0) && cases.some((c) => c.sentences.length === 2), 'the table has button, no-button and two-block cases');

// The same expressions and limit in Tether.
const swiftRe = (name) => { const m = core.match(new RegExp(`let ${name} = try! NSRegularExpression\\(pattern: #"(.*)"#\\)`)); assert.ok(m, `Core.swift has ${name}`); return m[1]; };
for (const [name, sw] of [['APPROVAL_CHARS', 'approvalChars'], ['APPROVAL_HOLD', 'approvalHold'], ['APPROVAL_DUR', 'approvalDur'], ['APPROVAL_SCOPE_OFF', 'approvalScopeOff'],
  ['APPROVAL_LIVE_WORD', 'approvalLiveWord'], ['DEPLOY_ASK', 'deployAsk'], ['DEPLOY_LINE', 'deployLine']]) {
  assert.equal(swiftRe(sw), js[name].source.replaceAll('[^]', '[\\s\\S]'), `Tether's ${sw} = client.js ${name}`);
}
assert.ok(core.includes(`let approvalMax = ${js.APPROVAL_MAX}\n`), 'the same length limit');

// The send payload: the exact sentence, as your message (the composer's prompt), behind the option guard; a tap asks first.
const approve = core.slice(core.indexOf('func approve(_ sid: String, _ offer: ApprovalOffer, _ sentence: String)'), core.indexOf('/// The Composer Plus language of the Mac'));
assert.match(approve, /guard current == sid, let now = approvalOffer, now == offer, offer\.sentences\.contains\(sentence\), optionsOpen\(sid, offer\.picks\) else \{ return \}/, 'only a sentence of the chat\'s offer now, once');
assert.match(approve, /try await prompt\(sentence, images: \[\]\)/, 'the exact sentence, nothing added');
assert.match(core.slice(core.indexOf('private func deliver(')), /rpc\("session\/prompt", \["request": \["requestId": rid, "sessionId": sid, "mode": steer \? "steer" : "queue", "content": content\]\]\)/, 'sent as a user prompt');
const buttons = ui.slice(ui.indexOf('struct ApproveButtons: View'), ui.indexOf('struct LineView: View'));
// The look (Furkan, 2026-11-18: "Bu ne kadar çirkin bir onay butonu"): the Mac's outlined card, the sentence as plain gray
// text (not a tinted link inside the button), and its own Onayla button on one line.
assert.match(buttons, /Text\(verbatim: s\.replacingOccurrences[^\n]*\n\s*\.font\(\.subheadline\)\.foregroundStyle\(Color\.secondary\)/, 'the sentence is plain text');
assert.match(buttons, /Text\(verbatim: w\.button\)\.font\(\.subheadline\.weight\(\.semibold\)\)\.lineLimit\(1\)\.fixedSize\(\)/, 'Onayla never wraps');
assert.match(buttons, /\.buttonStyle\(\.borderedProminent\)/);
assert.doesNotMatch(buttons, /\.buttonStyle\(\.bordered\)\.tint/, 'not the old pill with the sentence inside');
assert.match(buttons, /\.strokeBorder\(Color\.accentColor/, 'the Mac\'s accent border');
assert.match(buttons, /\.confirmationDialog\(Text\(verbatim: w\.confirm\)[\s\S]*c\.approve\(a\.sid, o, a\.sentence\)[\s\S]*message: \{ a in Text\(verbatim: a\.sentence\) \}/, 'one confirmation with the full sentence, then the send');
assert.match(ui, /let approval = !\(text\.isEmpty && images\.isEmpty && files\.isEmpty\) \? nil : c\.approvalOffer/, 'only with an empty composer');
assert.match(ui, /if let o = approval, l\.kind == \.assistant, l\.seq == o\.at \{ ApproveButtons\(offer: o\.offer\) \}/, 'under the answer');
// The words: Turkish when the Mac's Composer Plus language is Turkish, else English; the Mac's own words.
const tr = JSON.parse(read('locales/tr.json'))['dsh-composer-plus'];
for (const [key, word] of [['approve.button', 'Onayla'], ['approve.group', 'Bu yanıtın onay cümleleri']]) assert.equal(tr[key], word, `tr ${key}`);
assert.ok(src.includes("'approve.button': 'Approve'") && src.includes("'approve.group': 'Approval sentences of this answer'"), 'the English words of client.js');
// Tether reads them from its one string table (Localizable.xcstrings) in the Mac's language: the same words.
const table = JSON.parse(read('tether/ios/Resources/Localizable.xcstrings')).strings;
const trOf = (key) => table[key]?.localizations?.tr?.stringUnit?.value;
assert.ok(core.includes('ApproveWords(button: String(localized: "Approve", bundle: b), group: String(localized: "Approval sentences of this answer", bundle: b)'), 'Tether reads the words from the table');
assert.equal(trOf('Approve'), 'Onayla'); assert.equal(trOf('Approval sentences of this answer'), 'Bu yanıtın onay cümleleri');

// Damon: one name for the Mac and the phone; no "Assistant" label left in the phone's UI.
assert.equal(ASSISTANT_NAME, 'Damon'); assert.ok(src.includes("const ASSISTANT_NAME = 'Damon';"));
assert.ok(core.includes(`let assistantName = "${ASSISTANT_NAME}"\n`), 'Tether names the assistant as the Host does');
assert.doesNotMatch(ui, /Label\("Assistant"|navigationTitle\("Assistant"\)|Text\("Assistant"\)|"Opening the assistant…"/, 'no "Assistant" label in Tether');

// Assistant callouts: the same markers and labels (English and Turkish) as the Mac.
const kinds = JSON.parse(src.match(/const CALLOUT_KINDS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
assert.deepEqual(JSON.parse(core.match(/let calloutKinds = (\[[^\]]*\])/)[1]), kinds, 'the same markers');
for (const kind of kinds) {
  const en = src.match(new RegExp(`'callouts\\.${kind}': '([^']*)'`))[1];
  assert.ok(core.includes(`return String(localized: "${en}", bundle: b)`), `Tether reads the ${kind} label (${en}) from the table`);
  assert.equal(trOf(en), tr[`callouts.${kind}`], `label of ${kind}: ${tr[`callouts.${kind}`]} / ${en}`);
}

// The Host gives the gateway the reported UI language; /me carries it (bounded locale id only).
const home = mkdtempSync(join(tmpdir(), 'cp-tether-lang-'));
try {
  assert.equal(reportedLanguage(home), undefined, 'nothing reported yet');
  mkdirSync(join(home, 'storages', 'dsh-composer-plus'), { recursive: true });
  writeFileSync(join(home, 'storages', 'dsh-composer-plus', 'turkish-skill.json'), JSON.stringify({ on: true, lang: 'tr' }));
  assert.equal(reportedLanguage(home), 'tr');
  writeFileSync(join(home, 'storages', 'dsh-composer-plus', 'memory-language.json'), JSON.stringify({ lang: 'en-US' }));
  assert.equal(reportedLanguage(home), 'en-US', 'Project memory\'s report first');
  writeFileSync(join(home, 'storages', 'dsh-composer-plus', 'memory-language.json'), JSON.stringify({ lang: 'x; rm' }));
  assert.equal(reportedLanguage(home), 'tr', 'a bad value is skipped');
} finally { rmSync(home, { recursive: true, force: true }); }
let made; const m = mobileGateway({ dir: '/x', upstreamUrl: () => '', lang: () => 'tr', make: (o) => (made = o, { listenAdmin: async () => 1, start: async () => {}, close: async () => {}, state: () => ({ running: true }) }) });
await m.start(); assert.equal(made.lang(), 'tr', 'the gateway gets the language'); await m.close();
console.log(`tether approve: ${cases.length} shared cases, the same rule and words as the Mac, exact sentence sent as your message, Damon`);
