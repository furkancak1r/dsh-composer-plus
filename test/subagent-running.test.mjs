// Runs the real client.js apply() with fake slots: "Running subagents in the chat header" shadows dsh's subagent counter
// (dsh-client-ui-subagent, entry `subagent-catalog` in `conversation.session.header.actions`) with the same id at a
// lower priority, and draws dsh's own component. The header text becomes the running count (0 too): every total text
// that dsh's component asks for becomes "N subagents running". The open list gets the total as its first line, and the
// line goes when the list closes. Switched off, the entry goes (dsh's counter renders again). The layout is checked in a
// real dsh by test/browser-subagent-running.mjs.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

// A tiny hook runtime: one component render with state, refs, memo and layout effects that run after the render.
let state = [], refs = [], effects = [], cleanups = [], si = 0, ri = 0;
const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F',
  useState: (v) => { const i = si++; if (!(i in state)) state[i] = typeof v === 'function' ? v() : v; return [state[i], (x) => { state[i] = typeof x === 'function' ? x(state[i]) : x; }]; },
  useRef: (v) => { const i = ri++; return refs[i] ??= { current: v }; },
  useMemo: (f) => f(), useCallback: (f) => f, useEffect: () => {}, useSyncExternalStore: (s, g) => g(),
  useLayoutEffect: (f) => { effects.push(f); } };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el) => el } : {}));

// dsh's own entry, already registered by dsh-client-ui-subagent.
const shippedComponent = (props) => ({ shipped: true, text: props.t('count.total.other', { count: 37 }), aria: props.t('count.running.other', { count: 3 }), tree: props.t('tree.aria'), props });
// dsh 0.2.2-rc.2: its inject also gives `hooks` (the renderer makes `use<Name>` hooks) and its entry declares `children`.
let footer = false; const footerListeners = new Set();
const footerAvailable = { getSnapshot: () => footer, subscribe: (fn) => { footerListeners.add(fn); return () => footerListeners.delete(fn); } };
const CHILDREN = { 'conversation.session.header.actions.subagent.footer': { kind: 'list', scope: 'session' } };
const shipped = { component: shippedComponent, options: { id: 'subagent-catalog', order: 10 }, children: CHILDREN, inject: () => ({ openChild: 'dsh-open-child', hooks: { footerAvailable } }) };
const registered = [];
// dsh 0.2.2-rc.2's Agent Team board: an entry of the child slot, with its own locale namespace.
const FOOTER = 'conversation.session.header.actions.subagent.footer';
const TeamBoard = (p) => ({ board: true, sessionId: p.sessionId, title: p.t('tasks') });
const boards = [{ component: TeamBoard, options: { id: 'agent-team' }, locale: 'agent-team' }];
const slots = {
  inject: (n, f) => f(),
  register: (o, Comp) => { const entry = { options: o, component: Comp, children: o.children }; registered.push(entry); return () => registered.splice(registered.indexOf(entry), 1); },
  entries: (key) => (key === 'conversation.session.header.actions' ? [shipped, ...registered.filter((e) => e.options.name === key).map((e) => ({ component: e.component, options: { id: e.options.id, priority: e.options.priority } }))] : []),
  entriesOfSlot: (key) => (key === FOOTER ? boards : []),
};
const effectsOff = []; let settings;
const dict = { 'count.running.one': '{count} subagent running', 'count.running.other': '{count} subagents running', 'tree.aria': 'Subagent sessions', 'subagentCount.total': 'Subagents in total: {count}' };
const fill = (k, p) => (dict[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => String(p?.[n]));
const teamDict = { tasks: 'Shared tasks' };
plugin.apply({ effect: (f) => { effectsOff.push(f()); }, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: (ns) => (ns === 'agent-team' ? (k) => teamDict[k] ?? k : fill) },
  slots: { ...slots, register: (o, Comp) => { if (o.id === 'composer-plus') settings = o; return slots.register(o, Comp); } } });
const mine = () => registered.filter((e) => e.options.name === 'conversation.session.header.actions' && e.options.id === 'subagent-catalog');

assert.equal(mine().length, 1, 'on by default: one entry');
const entry = mine()[0];
assert.equal(entry.options.priority, -1, 'a lower priority than dsh (0): the slot cell renders it instead of dsh\'s entry');
assert.equal(entry.options.order, 10, 'same place as dsh\'s counter');
assert.equal(entry.options.locale, 'subagent', 'dsh\'s own subagent texts');
assert.equal(entry.options.children, undefined, 'no second declaration of dsh\'s child slot (dsh throws "already declared")');

// A fake page: dsh's button (aria-expanded) inside the entry's root, and dsh's portal menu under <body>.
let expanded = 'false';
// `popup`: dsh's button kind ("tree" before 0.2.2-rc.2, "dialog" in 0.2.2-rc.2).
let popup = 'tree';
const root = { querySelector: (sel) => (sel.split(', ').includes(`[aria-haspopup="${popup}"][aria-expanded="true"]`) && expanded === 'true' ? {} : null) };
const body = [];
const node = (tag) => ({ tag, style: {}, attrs: new Map(), children: [], setAttribute(k, v) { this.attrs.set(k, v); }, remove() { for (const box of [menu, body2]) { const i = box.children.indexOf(this); if (i >= 0) box.children.splice(i, 1); } } });
const tree = { getAttribute: (k) => ({ role: 'tree', 'aria-label': 'Subagent sessions' })[k] };
const menu = { hasAttribute: () => false, firstElementChild: tree, children: [tree], prepend(n) { this.children.unshift(n); } };
const projects = { getAttribute: (k) => ({ role: 'tree', 'aria-label': 'Projects' })[k] };
const other = { hasAttribute: () => false, firstElementChild: projects, children: [projects], prepend() { throw Error('another tree must not get the line'); } };
// dsh 0.2.2-rc.2: `body > [role=dialog][data-subagent-panel] > div > [role=tree]`, the line goes into that div.
const body2 = { children: [tree], prepend(n) { this.children.unshift(n); } };
const backdrop = { children: [], prepend() { throw Error('not into the backdrop'); } };
const dialog = { hasAttribute: (k) => k === 'data-subagent-panel', firstElementChild: backdrop, children: [backdrop, body2], prepend() { throw Error('the line goes into the panel body'); } };
globalThis.document = { createElement: node, body: { get children() { return body; } } };
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };

// The chat: 37 subagents, 3 run now (2 by dsh's status, 1 by its summary only).
const kids = Array.from({ length: 37 }, (_, i) => `k${i}`);
const list = { projectionsBySession: { s1: { values: { subagentCatalog: kids.map((id) => ({ id })) } } }, byId: { k2: { running: true }, k5: { running: false } } };
const statuses = new Map([['k0', { running: true }], ['k1', { running: true }], ['k5', { running: true }], ['k2', { running: false }], ['k9', {}]]);
// k0, k1, k5 run (status); k2's status says no (status wins over summary); k9 has no status running and no summary.
// A state change in a layout effect renders again (as React does), at most 3 passes.
const render = (lst = list, st = statuses) => {
  let out;
  for (let pass = 0; pass < 3; pass++) {
    const before = JSON.stringify(state);
    si = ri = 0; effects = [];
    out = entry.component({ sessionId: 's1', useSessions: (f) => f(lst), useSessionStatus: (f) => f(st), t: fill, ...entry.options.inject() });
    refs[0] ??= { current: null }; refs[0].current = root;
    for (const c of cleanups.splice(0)) c?.();
    for (const f of effects) cleanups.push(f());
    if (JSON.stringify(state) === before) break;
  }
  return out;
};
let out = render();
const drawn = out.c[0];
assert.equal(drawn.t, shippedComponent, 'dsh\'s own component draws the counter');
const shown = shippedComponent(drawn.p);
assert.equal(shown.text, '3 subagents running', 'the header shows the subagents that run now, not the total (37)');
assert.equal(shown.aria, '3 subagents running', 'other texts stay dsh\'s');
assert.equal(drawn.p.openChild, 'dsh-open-child', 'dsh\'s own actions (open a subagent) still reach the component');
assert.equal(drawn.p.hooks, undefined, 'no raw hooks to dsh\'s component');
const footerOut = drawn.p.renderSlot(FOOTER, {});
assert.equal(footerOut.length, 1, 'dsh 0.2.2-rc.2: renderSlot draws the Agent Team board under the list');
assert.equal(footerOut[0].t, TeamBoard);
const board = TeamBoard(footerOut[0].p);
assert.equal(board.sessionId, 's1', 'the board gets the chat');
assert.equal(board.title, 'Shared tasks', 'the board gets its own texts, not the subagent texts');
assert.equal(drawn.p.renderSlot('another.slot', {}), null, 'another slot: nothing');
boards.length = 0; assert.deepEqual(drawn.p.renderSlot(FOOTER, {}), [], 'no board plugin: nothing under the list');
assert.equal(drawn.p.useFooterAvailable((v) => v), false, 'dsh 0.2.2-rc.2: hooks become use<Name> selector hooks');
footer = true; assert.equal(drawn.p.useFooterAvailable((v) => !v), false, 'the hook reads the source and applies the selector');
footer = false;
assert.equal(out.p['data-composer-plus-subagent-running'], 3);
// One running: singular.
let one = render(list, new Map([['k0', { running: true }], ['k2', { running: false }]]));
assert.equal(shippedComponent(one.c[0].p).text, '1 subagent running', 'one form');
// None running: the header says 0 (the counter stays: dsh hides it only when the chat has no subagent).
let none = render(list, new Map([['k2', { running: false }]]));
assert.equal(shippedComponent(none.c[0].p).text, '0 subagents running', 'none running: 0');

// The open list: the total is its first line; the line goes when the list closes.
body.push(other, menu);
out = render();
assert.equal(menu.children.length, 1, 'closed: no line');
expanded = 'true'; out = render();
assert.equal(menu.children.length, 2, 'open: one line');
assert.equal(menu.children[0].textContent, 'Subagents in total: 37', 'the total of all the chat\'s subagents');
assert.ok(menu.children[0].attrs.has('data-composer-plus-subagent-total'));
out = render();
assert.equal(menu.children.length, 2, 'a second render adds no second line');
expanded = 'false'; out = render();
assert.equal(menu.children.length, 1, 'closed again: the line goes');
// dsh 0.2.2-rc.2: its button says aria-haspopup="dialog" and its panel wraps the tree in one more box.
body.splice(0, body.length, other, dialog); popup = 'dialog';
expanded = 'true'; out = render();
assert.equal(body2.children.length, 2, '0.2.2-rc.2: open, one line above the tree');
assert.equal(body2.children[0].textContent, 'Subagents in total: 37');
expanded = 'false'; out = render();
assert.equal(body2.children.length, 1, '0.2.2-rc.2: closed, the line goes');

// Switch off: the entry goes, so dsh's own counter (the total) renders again; on again: back.
const { setFeature } = settings.inject();
setFeature('subagentRunning', false);
assert.equal(mine().length, 0, 'switch off removes the entry');
setFeature('subagentRunning', true);
assert.equal(mine().length, 1, 'switch on adds it back');
for (const f of effectsOff) if (typeof f === 'function') f();
assert.equal(mine().length, 0, 'unloading the plugin removes the entry');

// Without dsh's subagent plugin (no shipped entry) nothing is drawn; without slots.entries the feature adds nothing.
shipped.options.id = 'other';
registered.length = 0;
plugin.apply({ effect() {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => fill }, slots });
assert.equal(render(), null, 'no dsh counter: nothing');
registered.length = 0;
plugin.apply({ effect() {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => fill }, slots: { inject: slots.inject, register: slots.register } });
assert.equal(mine().length, 0, 'no slots.entries: dsh\'s counter stays');
console.log('subagent-running checks passed');
