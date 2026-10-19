// Feature ideas, client half: the swipe decision, the deck (suggest, skip, build, undo, a failed start keeps the card), the
// rendered page (empty state, stack, buttons, keys) and the feature switch (it registers the tab and removes it again).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
// Other features run their effects too when the plugin applies (notifications listen on the window).
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
// The helpers are module-private: run the module source with a hook that hands them out.
eval(src.replace('function IdeasTitle({ t })', 'globalThis.__ideas = { swipeDecision, ideaDeck, suggestIdeas, decideIdea, undoIdea, IdeasTab, IdeaCard };\n    function IdeasTitle({ t })'));
let state = [], si = 0; const effects = [];
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
  useState: (v) => { const i = si++; if (!(i in state)) state[i] = typeof v === 'function' ? v() : v; return [state[i], (x) => { state[i] = typeof x === 'function' ? x(state[i]) : x; }]; },
  useRef: (v) => ({ current: v }), useEffect: (f) => { effects.push(f); } };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
const { swipeDecision, ideaDeck, suggestIdeas, decideIdea, undoIdea, IdeasTab } = globalThis.__ideas;

// Swipe decision: 30 % of the width (at least 40 px), or a fast flick in the same direction.
assert.equal(swipeDecision(0, 300), null); assert.equal(swipeDecision(89, 300), null); assert.equal(swipeDecision(90, 300), 'right'); assert.equal(swipeDecision(-90, 300), 'left');
assert.equal(swipeDecision(39, 100), null, 'a narrow card still needs 40 px'); assert.equal(swipeDecision(40, 100), 'right');
assert.equal(swipeDecision(30, 300, 1.2), 'right', 'a fast flick decides early'); assert.equal(swipeDecision(-30, 300, -1.2), 'left');
assert.equal(swipeDecision(30, 300, -1.2), null, 'a flick back cancels'); assert.equal(swipeDecision(10, 300, 3), null, 'a tap is not a swipe');

// Deck against a fake Host.
const calls = []; let reply = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); calls.push([url, body]); const r = reply(body); return { ok: r.status < 400, status: r.status, json: async () => r.body }; };
const ideas = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `i${from + i}`, title: `Idea ${from + i}`, summary: `Does ${from + i}.`, why: 'Faster.', effort: 'small' }));
const deck = ideaDeck('chat-1'); let changes = 0; deck.listeners.add(() => changes++);
assert.equal(ideaDeck('chat-1'), deck, 'one deck per chat'); assert.notEqual(ideaDeck('chat-2'), deck);
reply = () => ({ status: 200, body: { ideas: ideas(3), model: 'm' } });
const pending = suggestIdeas(deck, 'chat-1'); assert.equal(deck.status, 'loading'); await suggestIdeas(deck, 'chat-1'); await pending;
assert.equal(calls.length, 1, 'a second click while loading does nothing'); assert.deepEqual(calls[0], ['/api/composer-plus.ideas', { sessionId: 'chat-1' }]);
assert.equal(deck.status, 'ready'); assert.deepEqual(deck.cards.map((c) => c.id), ['i0', 'i1', 'i2']); assert.ok(changes >= 2, 'listeners hear each change');
// Skip, undo.
await decideIdea(deck, 'chat-1', 'left'); assert.deepEqual(deck.cards.map((c) => c.id), ['i1', 'i2']); assert.deepEqual(deck.history.map((c) => c.id), ['i0']);
undoIdea(deck); assert.deepEqual(deck.cards.map((c) => c.id), ['i0', 'i1', 'i2']); assert.equal(deck.history.length, 0); undoIdea(deck); assert.equal(deck.cards.length, 3, 'nothing to undo');
// Build: the Host starts a chat; the card moves to the started list and the new chat opens.
const opened = []; reply = (body) => (body.idea ? { status: 200, body: { sessionId: 'new-1', plan: true } } : { status: 500, body: {} });
await decideIdea(deck, 'chat-1', 'right', (id) => opened.push(id));
assert.deepEqual(calls.at(-1), ['/api/composer-plus.ideas', { sessionId: 'chat-1', idea: { title: 'Idea 0', summary: 'Does 0.', why: 'Faster.' } }]);
assert.deepEqual(opened, ['new-1']); assert.deepEqual(deck.cards.map((c) => c.id), ['i1', 'i2']); assert.equal(deck.accepted[0].sessionId, 'new-1'); assert.equal(deck.status, 'ready');
// A failed start keeps the card on top and shows the reason; a missing route asks for a restart.
reply = () => ({ status: 409, body: { error: 'this chat has no project folder' } });
await decideIdea(deck, 'chat-1', 'right', (id) => opened.push(id));
assert.deepEqual(deck.cards.map((c) => c.id), ['i1', 'i2']); assert.equal(deck.error, 'this chat has no project folder'); assert.equal(opened.length, 1);
reply = () => ({ status: 404, body: {} }); await suggestIdeas(deck, 'chat-1'); assert.equal(deck.error, 'restart'); assert.equal(deck.cards.length, 2, 'cards stay');
// More ideas add to the stack; an empty deck that fails goes back to idle.
reply = () => ({ status: 200, body: { ideas: ideas(2, 10) } }); await suggestIdeas(deck, 'chat-1');
assert.deepEqual(deck.cards.map((c) => c.id), ['i1', 'i2', 'i10', 'i11']); assert.equal(deck.error, undefined);
const empty = ideaDeck('chat-3'); reply = () => ({ status: 502, body: { error: 'rate limited' } }); await suggestIdeas(empty, 'chat-3');
assert.equal(empty.status, 'idle'); assert.equal(empty.error, 'rate limited');
// One network action per deck: no swipe while ideas load, no load while a chat starts, Undo history survives a load.
{
  const realFetch = globalThis.fetch; const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
  let loads = 0, starts = 0, loadGate, startGate;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.idea) { starts++; await startGate?.p; return { ok: true, status: 200, json: async () => ({ sessionId: `n-${starts}` }) }; }
    loads++; await loadGate?.p; return { ok: true, status: 200, json: async () => ({ ideas: ideas(2, 100 + 10 * loads) }) };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const a = ideaDeck('race-a'); await suggestIdeas(a, 'race-a'); await decideIdea(a, 'race-a', 'left');
  loadGate = gate(); const more = suggestIdeas(a, 'race-a'); await tick();
  await decideIdea(a, 'race-a', 'right'); assert.equal(starts, 0, 'no start while ideas load');
  loadGate.go(); await more; loadGate = undefined;
  assert.equal(a.history.length, 1, 'More ideas keeps the Undo history'); assert.equal(a.status, 'ready');
  startGate = gate(); const s1 = decideIdea(a, 'race-a', 'right'); await tick();
  const s2 = decideIdea(a, 'race-a', 'right'); await suggestIdeas(a, 'race-a');
  assert.equal(starts, 1, 'one start at a time'); assert.equal(loads, 2, 'no load while a chat starts'); assert.equal(a.status, 'starting');
  startGate.go(); await Promise.all([s1, s2]);
  assert.equal(a.status, 'ready'); assert.equal(a.accepted.length, 1);
  globalThis.fetch = realFetch;
}

// Rendered page.
const t = (k, p) => (p ? `${k}:${Object.values(p).join(',')}` : k);
const find = (node, pred) => { if (node === null || typeof node !== 'object') return undefined; if (pred(node)) return node; for (const c of node.c ?? []) { const hit = Array.isArray(c) ? c.map((x) => find(x, pred)).find(Boolean) : find(c, pred); if (hit) return hit; } return undefined; };
const text = (node) => (node === null || node === undefined ? '' : typeof node === 'string' ? node : (node.c ?? []).map(text).join(''));
const render = (sessionId) => { si = 0; return IdeasTab({ sessionId, t, openSession: (id) => opened.push(id) }); };
state = []; let page = render('chat-9');
assert.equal(page.p['data-composer-plus-ideas'], ''); assert.ok(text(page).includes('ideas.emptyTitle'));
assert.ok(find(page, (n) => n.t === 'button' && text(n) === 'ideas.suggest'), 'empty state offers Suggest features');
assert.ok(!find(page, (n) => n.p?.['data-composer-plus-idea']), 'no card yet');
state = []; page = render('chat-1');
const cards = find(page, (n) => n.p?.className === 'cpi-stack').c; assert.equal(cards.length, 3, 'top card plus two behind'); assert.equal(cards.at(-1).p.top, true, 'the top card renders last (on top)');
assert.equal(cards.at(-1).p.card.id, 'i1');
assert.ok(text(page).includes('ideas.left:4')); assert.ok(find(page, (n) => n.t === 'button' && n.p['aria-label'] === 'ideas.build'));
// Keys: ← skips, Z undoes; typing in a field is ignored.
const key = (k, target = { closest: () => null }) => { let prevented = 0; page.p.onKeyDown({ key: k, target, preventDefault: () => prevented++ }); return prevented; };
assert.equal(key('ArrowLeft'), 1); assert.deepEqual(deck.cards.map((c) => c.id), ['i2', 'i10', 'i11']);
assert.equal(key('z'), 1); assert.deepEqual(deck.cards.map((c) => c.id), ['i1', 'i2', 'i10', 'i11']);
assert.equal(key('ArrowLeft', { closest: () => ({}) }), 0, 'keys inside a text field are left alone'); assert.equal(deck.cards.length, 4);
// Started list opens its chat.
state = []; page = render('chat-1'); find(page, (n) => n.t === 'button' && text(n) === '✓ Idea 0').p.onClick(); assert.equal(opened.at(-1), 'new-1');

// Feature switch: on by default, it registers the Ideas tab and its slots; switching it off removes them all.
const live = new Map(); let next = 0; const tabs = new Set();
const slots = { inject: (name, f) => { const off = f(); return () => off(); }, register: (o) => { const k = `${o.name}#${o.id ?? o.key}#${next++}`; live.set(k, o); return () => live.delete(k); } };
const ctx = { slots, configForms: { get: () => ({}) }, effect: () => {}, locale: { register: () => () => {}, bind: () => (k) => k },
  inject: (deps, setup) => { const disposers = []; setup({ effect: (f) => { const off = f(); if (typeof off === 'function') disposers.push(off); }, uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
    sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } }, uiWorkspace: { openSession: (id) => opened.push(`ws:${id}`) }, workspaces: { list: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    sidebarRight: {}, sidebarRightTabs: { register: (tab) => { tabs.add(tab.id); return () => tabs.delete(tab.id); } } }); return { dispose: () => disposers.forEach((f) => f()) }; } };
plugin.apply(ctx);
const ideaSlots = () => [...live.values()].filter((o) => o.key === 'dsh-composer-plus/ideas').map((o) => o.name).sort();
assert.ok(tabs.has('dsh-composer-plus/ideas')); assert.deepEqual(ideaSlots(), ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
const body = [...live.values()].find((o) => o.key === 'dsh-composer-plus/ideas' && o.name === 'sidebar.right.pane.tab');
body.inject().openSession('s-7'); assert.equal(opened.at(-1), 'ws:s-7', 'opening a started chat goes through dsh navigation');
const settings = [...live.values()].find((o) => o.id === 'composer-plus');
settings.inject().setFeature('featureIdeas', false);
assert.ok(!tabs.has('dsh-composer-plus/ideas'), 'switching off removes the tab type'); assert.deepEqual(ideaSlots(), [], 'and both slots');
assert.ok(tabs.has('dsh-composer-plus/changes'), 'other features stay');
settings.inject().setFeature('featureIdeas', true); assert.ok(tabs.has('dsh-composer-plus/ideas'), 'switching on again reinstalls');
console.log('feature-ideas client checks passed');
