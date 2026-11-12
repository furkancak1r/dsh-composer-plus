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
console.log('assistant subagent rows: ok');
