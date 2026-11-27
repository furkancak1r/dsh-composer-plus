// Assistant messages only, subagent rows (client.js AssistantChatView): in the assistant chat, the rows that relay a
// subagent (dsh's "Task message received" for its send_message and "Subtask status updated" for its finished notice, drawn
// as a turn trigger or a context row) are hidden, so only the assistant's own summary shows. The rows are found by the
// source of dsh's chat nodes (uiConversation's chat target) and hidden by their data-chat-node-key, only inside the
// assistant chat. Your messages, the replies, other triggers (an automation) and other context rows stay. Other chats and
// Assistant off: nothing is hidden and no chat is read.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

// Mini DOM: the open assistant chat column, as dsh draws it (only the selectors that the component reads).
const column = { querySelector: () => null, querySelectorAll: () => [] };
let open = 's-assistant'; // the chat whose column is drawn
globalThis.document = { body: {}, createElement: () => ({ setAttribute() {}, style: {}, remove() {} }),
  querySelector: (s) => (s === `[data-conversation-session=${JSON.stringify(open)}] [data-chat-flow]` ? column : null), querySelectorAll: () => [] };
// The shared body watcher: `drawn()` stands in for dsh drawing another chat column.
const watchers = new Set();
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() { watchers.add(this); } disconnect() { watchers.delete(this); } };
const drawn = () => { for (const w of [...watchers]) w.fn([{ target: {} }]); };

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(src.replace('    function AssistantPage({', '    globalThis.__rows = { AssistantChatView };\n    function AssistantPage({'));
// Fake React with hook state per component; effects run when their dependencies change.
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = { current: v }; return s[i]; },
  useSyncExternalStore: (_s, get) => get(),
  useEffect: (f, deps) => { cur.effects.push([f, deps]); }, useLayoutEffect: (f, deps) => { cur.effects.push([f, deps]); } };
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ t: 'Portal', host, c: [el] }) } : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Button: 'Button' } : {}));
const { AssistantChatView } = globalThis.__rows;
const mount = (props) => {
  const inst = { state: [], deps: [], cleanups: [] };
  const render = () => {
    for (let round = 0; round < 4; round++) {
      cur = inst; inst.si = 0; inst.effects = [];
      var out = AssistantChatView(props());
      let ran = false;
      inst.effects.forEach(([f, deps], i) => {
        if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return;
        inst.cleanups[i]?.(); inst.cleanups[i] = f(); inst.deps[i] = deps; ran = true;
      });
      if (!ran) break;
    }
    return out;
  };
  return { render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};

// dsh's chat target of each chat: a store of its chat nodes (dsh 0.2.0-0.2.2 shape: key, kind, data.source).
const node = (key, kind, source) => [key, { key, kind, data: source === undefined ? {} : { source } }];
const stores = new Map(); const reads = [];
const storeOf = (nodes) => { const s = { nodes: new Map(nodes), listeners: new Set() };
  return { s, getSnapshot: () => ({ nodes: s.nodes }), subscribe: (fn) => { s.listeners.add(fn); return () => s.listeners.delete(fn); },
    add(n) { s.nodes = new Map([...s.nodes, n]); for (const fn of s.listeners) fn(); } }; };
stores.set('s-assistant', storeOf([
  node('4:user1', 'user', { kind: 'user', rpcId: 'r1' }),
  node('4:ctx-relay', 'context', { kind: 'agent-message', form: 'relay', senderSessionId: 'c1' }), // mid-turn send_message
  node('4:step1', 'assistant-step'),
  node('4:trig-done', 'turn-trigger', { kind: 'subagent-settled', form: 'notice', senderSessionId: 'c1' }), // finished notice wakes the chat
  node('4:trig-msg', 'turn-trigger', { kind: 'agent-message', form: 'relay', senderSessionId: 'c2' }), // send_message wakes the chat
  node('4:step2', 'assistant-step'),
  node('4:trig-sched', 'turn-trigger', { kind: 'schedule' }), // an automation: stays
  node('4:ctx-time', 'context', { kind: 'time-context', form: 'snapshot' }), // dsh's own context row: stays
  node('4:user-like', 'user', { kind: 'subagent-settled' }), // only trigger and context rows count
]));
stores.set('s-web', storeOf([node('4:web-trig', 'turn-trigger', { kind: 'subagent-settled', form: 'notice' })]));
const chatOf = (id) => { reads.push(id); return stores.get(id); };

let id = 's-assistant';
const status = { subscribe: () => () => {}, getSnapshot: () => id };
const view = mount(() => ({ status, chatOf, t: (k) => k }));
let out = view.render();
const css = () => (out === null ? '' : out.c[0].c.join(''));
const rule = (key, chat = 's-assistant') => `[data-conversation-session="${chat}"] [data-chat-node-key=${JSON.stringify(key)}]`;
for (const key of ['4:trig-done', '4:trig-msg', '4:ctx-relay']) assert.ok(css().includes(rule(key)), `subagent row ${key} hidden`);
for (const key of ['4:user1', '4:step1', '4:step2', '4:trig-sched', '4:ctx-time', '4:user-like']) assert.ok(!css().includes(JSON.stringify(key)), `${key} stays`);
for (const [, list] of css().matchAll(/([^{}]+)\{[^}]*\}/g)) for (const r of list.trim().split(',\n')) assert.match(r, /^\[data-conversation-session="s-assistant"\] /, 'every rule is inside the assistant chat');
// The subagent rows keep a box of height 0 (dsh's turn navigator jumps to the first row of a turn): not display: none.
const quietBlock = css().split('}').find((b) => b.includes('data-chat-node-key')) ?? '';
assert.match(quietBlock, /height: 0 !important; .*visibility: hidden !important;/, 'a 0-height, invisible box');
assert.doesNotMatch(quietBlock, /display: none/, 'not display: none');
assert.match(css(), /\[data-chat-flow-kind="tool-call"\]/, 'the process rows stay hidden as before');
assert.deepEqual(reads, ['s-assistant'], 'only the assistant chat is read');

// A subagent finishes later: its new trigger is hidden as soon as dsh has its node; another new row stays.
const a = stores.get('s-assistant');
a.add(node('4:trig-late', 'turn-trigger', { kind: 'subagent-settled', form: 'notice', senderSessionId: 'c3' }));
a.add(node('4:step3', 'assistant-step'));
out = view.render();
assert.ok(css().includes(rule('4:trig-late')), 'a new subagent trigger is hidden');
assert.ok(!css().includes('"4:step3"'), 'the new reply stays');
assert.equal(a.s.listeners.size, 1, 'one subscription to the chat');

// Another chat id (the assistant chat was made again, s-web is not the assistant chat any more): the new chat's rows are
// read and the old rules go; the old chat's subscription ends.
open = 's-web'; id = 's-web'; drawn(); out = view.render();
assert.equal(a.s.listeners.size, 0, 'the old chat is not watched');
assert.ok(css().includes(rule('4:web-trig', 's-web')) && !css().includes('s-assistant'), 'rules follow the assistant chat id');

// Assistant off (no id): no rule, no read. A chat that is not the assistant chat never gets a rule.
const before = reads.length; id = null; out = view.render();
assert.equal(css(), '', 'Assistant off: nothing is hidden');
assert.equal(stores.get('s-web').s.listeners.size, 0, 'and no chat is watched');
assert.equal(reads.length, before, 'no chat is read');

// The assistant chat is not drawn (another chat is open): its nodes are not read.
id = 's-assistant'; open = 's-other'; drawn(); out = view.render();
assert.equal(a.s.listeners.size, 0, 'no column: no subscription');
assert.ok(!css().includes('data-chat-node-key'), 'no node rule without the column');

// dsh without the chat target (older or changed dsh): chatOf throws or gives nothing; the view still works.
open = 's-assistant';
const failing = mount(() => ({ status, chatOf: () => { throw new Error('uiConversation.binding: inactive session'); }, t: (k) => k }));
out = failing.render(); assert.ok(!css().includes('data-chat-node-key') && css().includes('tool-call'), 'no chat target: the old rules only');
failing.unmount();

// The assistant chat is drawn again: its rows are read again. Unmount: the subscription ends.
open = 's-assistant'; drawn(); out = view.render();
assert.ok(css().includes(rule('4:trig-late')), 'drawn again: hidden again'); assert.equal(a.s.listeners.size, 1);
view.unmount(); assert.equal(a.s.listeners.size, 0, 'unmount stops the subscription');

// Folded answers (the real case: a user asks, the reply comes, then a subagent's message arrives mid-turn and wakes a next
// step whose reply ends the turn). dsh folds every reply but the turn's last into the turn's process, whose control this
// view hides: the first reply must be shown again. A next turn that a hidden agent message starts keeps its own reply.
const blocks = (...kinds) => kinds.map((k) => (k === 'tool' ? { kind: 'tool-call', callId: 'c', name: 'chat_read' } : k === 'think' ? { kind: 'reasoning', text: 'hm' } : k === 'blank' ? { kind: 'text', text: '  ' } : { kind: 'text', text: k }));
const step = (key, turn, n, ...kinds) => [key, { key, kind: 'assistant-step', data: { turn, step: n, blocks: blocks(...kinds) } }];
stores.set('s-answers', storeOf([
  node('9:user', 'user', { kind: 'user' }),
  step('9:1', 9, 1, 'think', 'tool'), // tool step: stays hidden as process
  step('9:2', 9, 2, 'think', 'Promes is fine.'), // the first answer: folded by dsh
  node('9:relay', 'context', { kind: 'agent-message', form: 'relay' }), // the subagent's message mid-turn: hidden
  step('9:3', 9, 3, 'Let me check.', 'tool'), // a progress note with a tool call: stays hidden
  step('9:4', 9, 4, 'think', 'blank'), // reasoning only: no answer
  step('9:5', 9, 5, 'GIB has no code.'), // the turn's last reply: dsh shows it
  node('10:trig', 'turn-trigger', { kind: 'agent-message', form: 'relay' }), // a hidden agent message starts the next turn
  step('10:1', 10, 1, 'Second result.'),
]));
open = 's-answers'; id = 's-answers';
const answersView = mount(() => ({ status, chatOf, t: (k) => k }));
out = answersView.render();
const shown = (key) => `[data-conversation-session="s-answers"] [data-chat-node-key=${JSON.stringify(key)}]:not([data-chat-group-part="reasoning"])`;
const answerBlock = css().split('}').find((b) => b.includes('content-visibility')) ?? '';
assert.ok(answerBlock.includes(shown('9:2')), 'the folded first answer is shown again');
for (const key of ['9:1', '9:3', '9:4', '9:5', '10:1']) assert.ok(!answerBlock.includes(JSON.stringify(key)), `${key} gets no answer rule`);
assert.match(answerBlock, /content-visibility: visible !important; height: auto !important; opacity: 1 !important;/, 'beats dsh\'s hidden="until-found" and its fade');
for (const key of ['9:relay', '10:trig']) assert.ok(css().includes(`${rule(key, 's-answers')} `) || css().includes(`${rule(key, 's-answers')},`), `${key} stays hidden`);
// The turn goes on: a next step comes, so the old last reply is now folded too and shown again.
stores.get('s-answers').add(step('10:2', 10, 2, 'Third result.'));
out = answersView.render();
assert.ok(css().includes(shown('10:1')), 'a reply that is no longer the turn\'s last is shown again');
// Assistant off: no rule.
id = null; out = answersView.render(); assert.equal(css(), '', 'off: nothing');
answersView.unmount();

// An ended turn: its steps get dsh's finalNode, and its turn tail names the last step with text as `closing`.
const ended = (turn, ...steps) => {
  const done = steps.map(([key, n], i) => [key, { ...n, data: { ...n.data, finalNode: { seq: turn * 100 + i } } }]);
  const closing = done.filter(([, n]) => n.data.blocks.some((b) => b.kind === 'text' && b.text.trim() !== '')).at(-1)?.[1].data.finalNode;
  return [...done, [`${turn}:tail`, { key: `${turn}:tail`, kind: 'turn-tail', data: { turn, closing: closing === undefined ? null : { finalNode: closing } } }]];
};
// dsh's tool-call node of a call that Auto review denied: the result as `root`, the turn in its location.
const denied = (turn) => [`${turn}:deny`, { key: `${turn}:deny`, kind: 'tool-call', location: { kind: 'step', turn: { turn } },
  data: { root: { kind: 'tool-result', content: [{ type: 'text', text: 'Error: Auto review denied this tool call and it did not run.' }], isError: true } } }];
// A reply that is only `[quiet]` (any case, spaces): the assistant's "nothing to say" for routine news. Its row is hidden
// like a subagent row (also when it is not the turn's last reply, and also when the step has a tool call); a reply that
// says more stays.
stores.set('s-quiet', storeOf([
  node('11:trig', 'turn-trigger', { kind: 'composer-plus-assistant-news' }),
  ...ended(11,
    step('11:1', 11, 1, 'think', ' [QUIET]\n'), // quiet, not the turn's last: hidden, not shown again as an answer
    step('11:2', 11, 2, '[quiet]')), // the turn's last reply: hidden
  ...ended(12,
    step('12:1', 12, 1, '[quiet]\nThe audit found 2 issues.'), // says more: stays
    step('12:2', 12, 2, 'Audit: [quiet]')), // stays
  // a real answer, then a quiet last step: the answer shows, the quiet step goes
  ...ended(13, step('13:1', 13, 1, 'Real answer.'), step('13:2', 13, 2, '[quiet]')),
  ...ended(14, step('14:1', 14, 1, '[quiet]'), step('14:2', 14, 2, 'think', 'tool')), // dsh's tail names the last step with text: quiet
  ['15:x', { key: '15:x', kind: 'assistant-step' }], // a node without data: no rule, no error
  // A [quiet] text sent with a tool call: dsh's default (foldedReplies: all) shows it, so it goes too (the Host's
  // quietRun counts it the same way); the turn's later real reply stays.
  ...ended(16, step('16:1', 16, 1, '[quiet]', 'tool'), step('16:2', 16, 2, 'Found 2 issues.')),
  // 2026-11-27: a text with a tool call in an ended turn whose closing answer is [quiet] (dsh's turn tail names it) and that
  // has a call that Auto review denied (dsh's tool-call node, its result as `root`) is for you: it shows. A [quiet] text
  // with a tool call in such a turn stays hidden, and so does a looking line in a hushed turn without a denial (review 3).
  ...ended(17, step('17:1', 17, 1, 'Auto review denied bash.', 'tool'), step('17:2', 17, 2, '\n[quiet] ')), denied(17),
  ...ended(18, step('18:1', 18, 1, '[quiet]', 'tool'), step('18:2', 18, 2, '[quiet]')), denied(18),
  ...ended(20, step('20:1', 20, 1, 'Gave it to a subagent.', 'tool'), step('20:2', 20, 2, '[quiet]')),
  // A running turn (no tail yet) whose newest text is [quiet]: its real answer can still come, so its looking line stays hidden.
  step('19:1', 19, 1, 'Checking.', 'tool'), step('19:2', 19, 2, '[quiet]', 'tool'),
]));
open = 's-quiet'; id = 's-quiet';
const quietView = mount(() => ({ status, chatOf, t: (k) => k }));
out = quietView.render();
const quietRule = (key) => rule(key, 's-quiet');
for (const key of ['11:1', '11:2', '16:1']) assert.ok(css().includes(`${quietRule(key)},`) || css().includes(`${quietRule(key)} {`), `[quiet] reply ${key} hidden`);
for (const key of ['12:1', '12:2', '16:2']) assert.ok(!css().includes(`${quietRule(key)},`) && !css().includes(`${quietRule(key)} {`), `${key} is not hidden as quiet`);
assert.ok(!css().includes(`${quietRule('11:1')}:not(`), 'a quiet reply is not shown again as a folded answer');
assert.ok(css().includes(`${quietRule('13:1')}:not(`), 'the real answer before a quiet last step shows');
assert.ok(css().includes(`${quietRule('17:1')}:not(`), 'a text with a tool call before a quiet closing answer shows');
assert.ok(!css().includes(`${quietRule('18:1')}:not(`), 'a [quiet] text with a tool call in a hushed turn is not shown again');
assert.ok(!css().includes(`${quietRule('20:1')}:not(`), 'a looking line in a hushed turn without a denial stays hidden');
assert.ok(!css().includes(`${quietRule('19:1')}:not(`), 'a running turn: its looking line stays hidden until the turn ends');
assert.ok(css().includes(`${quietRule('13:2')},`) || css().includes(`${quietRule('13:2')} {`), 'the quiet last step is hidden');
// The tail of a turn that ends quiet: only its Copy/time row goes (the tail keeps the Approve and option buttons).
const tails = css().split('}').find((b) => b.includes('data-turn-tail')) ?? '';
for (const turn of ['11', '13', '14']) assert.ok(tails.includes(`[data-conversation-session="s-quiet"] [data-turn-tail="${turn}"] > [data-clock]`), `turn ${turn}: its Copy/time row goes`);
assert.ok(!css().includes('"15'), 'a node without data gets no rule');
for (const turn of ['12', '16']) assert.ok(!tails.includes(`"${turn}"`), `turn ${turn} ends with a reply that says more: it keeps its row`);
assert.ok(!tails.includes('"19"'), 'a running turn (no tail yet) gets no tail rule');
assert.match(tails, /display: none !important;/);
quietView.unmount();

// The Host's news note (dsh 0.2.2 draws it as a context row, by its location's turn) goes with its turn's quiet reply; the
// note of a news turn with a real reply, and another context row of the quiet turn, stay.
const at = (turn) => ({ kind: 'step', turn: { turn } });
const news = (key, turn, kind = 'context') => [key, { key, kind, location: at(turn), data: { source: { kind: 'composer-plus-assistant-news', form: 'snapshot' } } }];
stores.set('s-news', storeOf([
  news('20:note', 20), step('20:1', 20, 1, 'think', '[quiet]'), // a quiet news turn: note and reply go
  ['20:time', { key: '20:time', kind: 'context', location: at(20), data: { source: { kind: 'time-context' } } }], // dsh's own row: stays
  news('21:note', 21), step('21:1', 21, 1, 'The deploy failed.'), // a news turn with a real reply: the note stays
  news('22:trig', 22, 'turn-trigger'), step('22:1', 22, 1, '[QUIET]'), // a note drawn as a trigger row: goes too
  news('23:note', 23), step('23:1', 23, 1, 'Started the audit.'), step('23:2', 23, 2, '[quiet]'), // a real reply, then [quiet]: the note stays
  news('24:note', 24), step('24:1', 24, 1, 'think', 'tool'), step('24:2', 24, 2, '[quiet]'), // a tool call without text: the note goes
  // A text sent with a tool call (dsh's default foldedReplies: all shows it): news, as the Host's quietRun says
  // (test/quiet-replies.test.mjs has the same shape). The note stays.
  news('25:note', 25), step('25:1', 25, 1, 'Checking.', 'tool'), step('25:2', 25, 2, '[quiet]'),
  // A [quiet] text sent with a tool call, then [quiet]: every text is quiet, so the note goes (quietRun says quiet too).
  news('26:note', 26), step('26:1', 26, 1, '[quiet]', 'tool'), step('26:2', 26, 2, '[quiet]'),
]));
open = 's-news'; id = 's-news';
const newsView = mount(() => ({ status, chatOf, t: (k) => k }));
out = newsView.render();
const newsRule = (key) => rule(key, 's-news');
for (const key of ['20:note', '22:trig', '20:1', '22:1', '23:2', '24:note', '25:2', '26:note', '26:1', '26:2']) assert.ok(css().includes(`${newsRule(key)},`) || css().includes(`${newsRule(key)} {`), `${key} goes with the quiet turn`);
for (const key of ['21:note', '21:1', '20:time', '23:note', '23:1', '25:note']) assert.ok(!css().includes(`${newsRule(key)},`) && !css().includes(`${newsRule(key)} {`), `${key} stays`);
newsView.unmount();
console.log('assistant subagent rows: ok');
