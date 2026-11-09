// Assistant messages only, view cap (client.js AssistantChatView): the assistant chat shows only its newest
// ASSISTANT_TURNS turns of the rows that dsh drew. The older rows (found by dsh's `data-chat-turn`, inside dsh's
// `conversation.chat.flow` slot wrapper, as dsh's own chat view finds them) get `display: none`; a button above the rows
// shows them all; dsh's "Load earlier" is hidden while the cap holds. Other chats and a short assistant chat do not change.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

// Mini DOM: elements with attributes, children, prepend/before/remove and the selectors the component uses.
class El {
  constructor(attrs = {}, children = []) { this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.style = {}; for (const c of children) this.append(c); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(c) { c.parentElement = this; this.children.push(c); }
  prepend(c) { c.parentElement = this; this.children.unshift(c); }
  before(c) { const s = this.parentElement.children; s.splice(s.indexOf(this), 0, c); c.parentElement = this.parentElement; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; }
  get all() { return this.children.flatMap((c) => [c, ...c.all]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    if (sel === ':scope > [data-slot="conversation.chat.flow"]') return this.children.filter((c) => c.attrs['data-slot'] === 'conversation.chat.flow');
    if (sel === ':scope > [data-chat-turn]') return this.children.filter((c) => 'data-chat-turn' in c.attrs);
    const m = sel.match(/^\[data-conversation-session="([^"]+)"\] \[data-chat-flow\]$/);
    if (m) { const conv = this.all.find((e) => e.attrs['data-conversation-session'] === m[1]); return conv ? conv.all.filter((e) => 'data-chat-flow' in e.attrs) : []; }
    throw new Error(`selector not in the mini DOM: ${sel}`);
  }
}
const body = new El();
globalThis.document = { body, createElement: () => new El(), querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s) };
let watcher = null;
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() { watcher = this; } disconnect() { watcher = null; } };

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(src.replace('    function AssistantPage({', '    globalThis.__cap = { AssistantChatView, ASSISTANT_TURNS };\n    function AssistantPage({'));
// Fake React with hook state per component; effects run when their dependencies change.
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = { current: v }; return s[i]; },
  useSyncExternalStore: (_s, get) => get(),
  useEffect: (f, deps) => { cur.effects.push([f, deps]); }, useLayoutEffect: (f, deps) => { cur.effects.push([f, deps]); } };
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ t: 'Portal', host, c: [el] }) } : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Button: 'Button' } : {}));
const { AssistantChatView, ASSISTANT_TURNS } = globalThis.__cap;
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

// A long assistant chat: 12 turns drawn (each turn: a user row, a step group, a reply), dsh's "Load earlier" above.
const rowsOf = (turns) => turns.flatMap((n) => [new El({ 'data-chat-turn': String(n), 'data-chat-flow-kind': 'user' }), new El({ 'data-chat-turn': String(n), 'data-chat-group-key': `g${n}` }), new El({ 'data-chat-turn': String(n), 'data-chat-flow-kind': 'turn-tail' })]);
const slot = new El({ 'data-slot': 'conversation.chat.flow' }, rowsOf([29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]));
const older = new El({ class: 'tnXGgG_older' });
const flow = new El({ 'data-chat-flow': '' }, [older, slot]);
body.append(new El({ 'data-conversation-session': 's-assistant' }, [flow]));
let id = 's-assistant';
const status = { subscribe: () => () => {}, getSnapshot: () => id };
const t = (k, v) => `${k}:${v?.count ?? ''}`;
const view = mount(() => ({ status, t }));
let out = view.render();
const css = () => out.c[0].c.join('');
const button = () => out.c[1];
assert.equal(ASSISTANT_TURNS, 8);
// The oldest 4 turns (29-32) are hidden, in the slot wrapper and directly in the column; the newest 8 stay.
for (const n of [29, 30, 31, 32]) assert.ok(css().includes(`[data-conversation-session="s-assistant"] [data-chat-flow] > [data-slot="conversation.chat.flow"] > [data-chat-turn="${n}"]`), `turn ${n} hidden`);
for (const n of [33, 40]) assert.ok(!css().includes(`[data-chat-turn="${n}"]`), `turn ${n} shown`);
assert.match(css(), /\[data-chat-flow\] > \[class\*="_older"\] \{ display: none !important; \}/, 'dsh\'s Load earlier waits behind the cap');
assert.match(css(), /\[data-chat-flow-kind="tool-call"\]/, 'the process rows stay hidden as before');
// The button: above the rows (right before dsh's slot wrapper), labeled with the hidden turn count.
const seat = flow.children[flow.children.indexOf(slot) - 1];
assert.equal(seat.getAttribute('data-composer-plus-assistant-earlier'), '', 'a seat right before the rows');
assert.equal(button().host, seat); assert.equal(button().c[0].c[0], 'assistantChatView.earlier:4');
// A new turn comes (the shared body watcher sees the new row): still the newest 8.
slot.append(...rowsOf([41])); watcher.fn([{ target: body }]); out = view.render();
assert.ok(css().includes('[data-chat-turn="33"]') && !css().includes('[data-chat-turn="34"]'), 'the cap moves with a new turn');
// Show earlier: every drawn row shows, the seat goes, dsh's Load earlier is back.
button().c[0].p.onClick(); out = view.render();
assert.ok(!css().includes('data-chat-turn'), 'every turn shows'); assert.ok(!css().includes('_older'), 'Load earlier is back');
assert.equal(out.c[1], null, 'no button'); assert.ok(!flow.children.includes(seat), 'the seat goes');
// Another chat id (the assistant chat was made again): the cap holds again for it.
const flow2 = new El({ 'data-chat-flow': '' }, [new El({ 'data-slot': 'conversation.chat.flow' }, rowsOf([1, 2, 3, 4, 5, 6, 7, 8, 9]))]);
body.append(new El({ 'data-conversation-session': 's-assistant-2' }, [flow2])); id = 's-assistant-2'; out = view.render();
assert.ok(css().includes('[data-conversation-session="s-assistant-2"] [data-chat-flow] > [data-slot="conversation.chat.flow"] > [data-chat-turn="1"]'), 'a new chat: capped');
// A short chat (8 turns or fewer): no cap, no button.
id = 's-short';
body.append(new El({ 'data-conversation-session': 's-short' }, [new El({ 'data-chat-flow': '' }, [new El({ 'data-slot': 'conversation.chat.flow' }, rowsOf([1, 2, 3]))])]));
out = view.render();
assert.ok(!css().includes('data-chat-turn'), 'short chat: nothing hidden'); assert.equal(out.c[1], null);
// Unmount: the watcher stops.
view.unmount(); assert.equal(watcher, null, 'unmount stops watching');
console.log('assistant-cap: ok');
