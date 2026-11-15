// Approve button: an unchanged `onay` block is not written again (2026-11-15: the Assistant chat had 51 turns, 38 of them
// only answered automation news, and each reply repeated the same 473-character block with "G3-G5", a code the user did
// not know; these turns used about 16 M of the day's 24 M tokens).
// - The prompt rule: a reply without a block keeps the button; no new block for news, a reminder or an agent result
//   when the pending approvals did not change; the sentence names subjects, not internal codes. The old rule for a user
//   message stays.
// - The Assistant news note: do not write an unchanged block again, its button stays until the user's next message.
// - The client (real client.js chatOffer): a newer turn without a text answer (tools only, dsh's closing is null) keeps
//   the button of the older block, under that turn's end; not after your message, a rollback of the block or in a fork's
//   inherited part. Option buttons do not change.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { APPROVE_SECTION, assistantNewsNote } from '../index.js';

// 1. The prompt rule and the news note.
assert.match(APPROVE_SECTION, /A reply without an `onay` block keeps the button of the newest block until the user's next message\./);
// Review 1: no wording that asks for the block in every reply.
assert.match(APPROVE_SECTION, /When several approvals are pending, put them in one sentence in one block \(only the newest block gets a button\)\./);
assert.doesNotMatch(APPROVE_SECTION, /in your newest reply/, 'no "block in your newest reply" (the model read it as "in every reply")');
assert.match(APPROVE_SECTION, /When the pending approvals did not change, do not write the block again in a reply to news, a scheduled reminder or an agent result: write a new block only when the list of pending approvals changes or after a user message\./);
assert.match(APPROVE_SECTION, /After a user message, when an approval is still pending, include it again in the next `onay` block, together with any new approval\./, 'the rule after a user message stays');
assert.match(APPROVE_SECTION, /Name each item by its subject in the user's words, never by an internal code such as a review item name \(G3, H1\) or a session id\./);
for (const kind of [{ task: true }, { automation: true }, {}]) {
  const note = assistantNewsNote([{ id: 's-1', title: 'Nightly audit', project: 'demo-app', at: 1, kind: 'finished', reply: 'No finding.', ...kind }]);
  assert.match(note, /Do not write an unchanged `onay` block again: its button stays until the user's next message\./, `the news note: ${JSON.stringify(kind)}`);
}

// 2. The client: the real chatOffer of client.js.
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__on = { chatOffer, parseApprovals, parseOptions };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const { chatOffer, parseApprovals, parseOptions } = globalThis.__on;

const S = 'Onaylıyorum: demo-app için feature/login dalını main ile birleştir.';
const ASK = `The login fix is ready.\n\n\`\`\`onay\n${S}\n\`\`\`\n`;
const user = (seq) => ({ kind: 'user', anchorSeq: seq, data: { seq } });
const news = (seq) => ({ kind: 'context', anchorSeq: seq, data: { kind: 'context', seq, source: { kind: 'composer-plus-assistant-news', form: 'snapshot' } } });
const step = (turn, seq, text) => ({ kind: 'assistant-step', anchorSeq: seq, data: { status: 'settled', turn, step: 1, blocks: [{ kind: 'text', text }], finalNode: { seq } } });
const tail = (turn, seq, text) => ({ kind: 'turn-tail', anchorSeq: seq, data: { turn, seq: seq + 1, closing: { status: 'settled', turn, blocks: [{ kind: 'text', text }], finalNode: { seq } } } });
// A turn that ended with tool calls only (todo_list_add): dsh's tail has no closing answer; its slot gets the turn end's seq.
const toolsOnly = (turn, seq) => ({ kind: 'turn-tail', anchorSeq: seq, data: { turn, seq, closing: null } });
const chat = (...nodes) => ({ nodes: new Map(nodes.map((n, i) => [`k${i}`, n])) });
const sentences = (offer) => offer?.options.map((o) => o.message);

const base = [user(10), step(1, 20, ASK), tail(1, 20, ASK)];
const quiet = chat(...base, news(30), toolsOnly(2, 40));
const offer = chatOffer(quiet, [], 0, parseApprovals);
assert.deepEqual(sentences(offer), [S], 'a news turn with tools only keeps the button');
assert.equal(offer.seq, 40, 'under the newest turn\'s end (the seq that dsh gives its slot)');
assert.equal(offer.options[0].from, 20, 'the block stays in its own answer');
assert.deepEqual(sentences(chatOffer(chat(...base, news(30), toolsOnly(2, 40), news(50), toolsOnly(3, 60)), [], 0, parseApprovals)), [S], 'also after two such turns');
// The same exclusions as for a newer answer with text.
assert.equal(chatOffer(chat(...base, user(30), toolsOnly(2, 40)), [], 0, parseApprovals), undefined, 'your message after the block: none');
assert.deepEqual(sentences(chatOffer(chat(...base, user(30), toolsOnly(2, 40)), [[30, 35]], 0, parseApprovals)), [S], 'your message withdrawn (rollback): the button comes back');
assert.equal(chatOffer(quiet, [[15, 25]], 0, parseApprovals), undefined, 'the block withdrawn (rollback): none');
assert.equal(chatOffer(quiet, [], 25, parseApprovals), undefined, 'a fork\'s inherited block: none');
assert.equal(chatOffer(quiet, [], 45, parseApprovals), undefined, 'a fork\'s inherited turn: none');
assert.equal(chatOffer(chat(user(10), toolsOnly(1, 40)), [], 0, parseApprovals), undefined, 'no block: none');
assert.equal(chatOffer(chat(...base, news(30), step(2, 35, 'Done.'), tail(2, 35, 'Done.'), toolsOnly(3, 40)), [], 0, parseApprovals)?.seq, 40, 'a text answer without a block between: kept too');
// The newest turn is withdrawn: the turn before it decides, as before.
assert.equal(chatOffer(quiet, [[38, 45]], 0, parseApprovals)?.seq, 20, 'the tools-only turn withdrawn: the button under the older turn');
// Option buttons do not change: a newer turn without an answer hides an older list.
const opts = '## Options\n1. Merge\n2. Wait';
assert.equal(chatOffer(chat(user(10), step(1, 20, opts), tail(1, 20, opts), toolsOnly(2, 40)), [], 0, parseOptions), undefined, 'Option buttons: still hidden');
console.log('onay-no-repeat: ok');
