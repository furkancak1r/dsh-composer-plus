// Feature ideas, client half: the swipe decision, the deck (suggest, skip, build, undo, a failed start keeps the card), the
// rendered page (empty state, stack, buttons, keys) and the feature switch (it registers the tab and removes it again).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
// Other features run their effects too when the plugin applies (notifications listen on the window).
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
// The helpers are module-private: run the module source with a hook that hands them out.
eval(src.replace('function IdeasTitle({ t })', 'globalThis.__ideas = { laterChecklist, FOCUS_PRESETS, swipeDecision, ideaDeck, suggestIdeas, decideIdea, undoIdea, IdeasTab, IdeaCard, loadLater, laterIdea, startLater, startAllLater, removeLater, issueLater, loadHistory, forgetHistory };\n    function IdeasTitle({ t })'));
let state = [], si = 0; const effects = [];
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
  useState: (v) => { const i = si++; if (!(i in state)) state[i] = typeof v === 'function' ? v() : v; return [state[i], (x) => { state[i] = typeof x === 'function' ? x(state[i]) : x; }]; },
  useRef: (v) => ({ current: v }), useEffect: (f) => { effects.push(f); } };
const clipboard = []; let clipboardOk = true;
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', writeClipboard: async (text) => { clipboard.push(text); return clipboardOk; } } : {}));
const { laterChecklist, FOCUS_PRESETS, swipeDecision, ideaDeck, suggestIdeas, decideIdea, undoIdea, IdeasTab, loadLater, laterIdea, startLater, startAllLater, removeLater, issueLater, loadHistory, forgetHistory } = globalThis.__ideas;

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
// The UI language goes with the request, so the cards come in that language.
reply = () => ({ status: 200, body: { ideas: [] } }); await suggestIdeas(ideaDeck('chat-lang'), 'chat-lang', 'tr');
assert.deepEqual(calls.at(-1), ['/api/composer-plus.ideas', { sessionId: 'chat-lang', locale: 'tr' }]);
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
const render = (sessionId) => { si = 0; return IdeasTab({ sessionId, t, openSession: (id) => opened.push(id), uiLocale: () => 'ja' }); };
state = []; let page = render('chat-9');
assert.equal(page.p['data-composer-plus-ideas'], ''); assert.ok(text(page).includes('ideas.emptyTitle'));
const suggestButton = find(page, (n) => n.t === 'button' && text(n) === 'ideas.suggest'); assert.ok(suggestButton, 'empty state offers Suggest features');
reply = () => ({ status: 502, body: { error: 'x' } }); await suggestButton.p.onClick();
assert.deepEqual(calls.at(-1)[1], { sessionId: 'chat-9', locale: 'ja' }, 'the button sends the UI language at the click');
assert.ok(!find(page, (n) => n.p?.['data-composer-plus-idea']), 'no card yet');
state = []; page = render('chat-1');
const cards = find(page, (n) => n.p?.className === 'cpi-stack').c; assert.equal(cards.length, 3, 'top card plus two behind'); assert.equal(cards.at(-1).p.top, true, 'the top card renders last (on top)');
assert.equal(cards.at(-1).p.card.id, 'i1');
assert.ok(text(page).includes('ideas.left:4')); assert.ok(find(page, (n) => n.t === 'button' && n.p['aria-label'] === 'ideas.build'));
// Keys: ← skips, Z undoes; typing in a field is ignored.
const key = (k, target = { closest: () => null }, extra = {}) => { let prevented = 0; page.p.onKeyDown({ key: k, target, preventDefault: () => prevented++, ...extra }); return prevented; };
const flown = () => new Promise((r) => setTimeout(r, 250));
const dragDx = () => state[1].dx; // IdeasTab state: [version, drag]
assert.equal(key('ArrowLeft'), 1); assert.ok(dragDx() < 0, '← first flies the card off to the left');
assert.equal(deck.cards.length, 4, 'the card stays until it has flown'); await flown();
assert.deepEqual(deck.cards.map((c) => c.id), ['i2', 'i10', 'i11']); assert.equal(dragDx(), 0, 'the next card starts in the middle');
assert.equal(key('z'), 1); assert.deepEqual(deck.cards.map((c) => c.id), ['i1', 'i2', 'i10', 'i11']);
assert.equal(key('ArrowLeft', { closest: () => ({}) }), 0, 'keys inside a text field are left alone'); assert.equal(deck.cards.length, 4);
// ✕ and ✓ fly the card off to their side too; a second click during the flight does nothing.
const round = (side) => find(page, (n) => n.t === 'button' && n.p['data-side'] === side);
round('left').p.onClick(); assert.ok(dragDx() < 0, '✕ flies the card off to the left'); round('left').p.onClick(); await flown();
assert.deepEqual(deck.cards.map((c) => c.id), ['i2', 'i10', 'i11'], 'one card per flight'); undoIdea(deck);
reply = (body) => (body.idea ? { status: 200, body: { sessionId: 'new-2' } } : { status: 500, body: {} });
round('right').p.onClick(); assert.ok(dragDx() > 0, '✓ flies the card off to the right'); await flown(); await flown();
assert.equal(opened.at(-1), 'new-2'); assert.deepEqual(deck.cards.map((c) => c.id), ['i2', 'i10', 'i11']); assert.equal(deck.accepted[0].sessionId, 'new-2');
// Started list opens its chat.
state = []; page = render('chat-1'); find(page, (n) => n.t === 'button' && text(n) === '✓ Idea 0').p.onClick(); assert.equal(opened.at(-1), 'new-1');
// Build now: ▶ (between ↓ and ✓) and ↑ fly the card up, then the Host starts a chat without a plan (`plan: false`).
{
  const buildNow = round('up'); assert.equal(buildNow.p['aria-label'], 'ideas.buildNow'); assert.equal(text(buildNow), '▶');
  const sides = find(page, (n) => n.p?.className === 'cpi-actions').c.map((b) => b.p['data-side']); assert.deepEqual(sides, ['left', 'later', 'up', 'right'], '✕ ↓ ▶ ✓');
  reply = (body) => (body.idea ? { status: 200, body: { sessionId: 'now-1', plan: false } } : { status: 500, body: {} });
  const top = deck.cards[0];
  buildNow.p.onClick(); assert.ok(state[1].dy < 0 && state[1].dx === 0 && state[1].fade, '▶ first flies the card up');
  assert.equal(deck.cards[0], top, 'the card stays until it has flown'); await flown(); await flown();
  assert.deepEqual(calls.at(-1), ['/api/composer-plus.ideas', { sessionId: 'chat-1', idea: { title: top.title, summary: top.summary, why: top.why }, plan: false }]);
  assert.equal(opened.at(-1), 'now-1'); assert.equal(deck.accepted[0].now, true); assert.equal(state[1].dy, 0, 'the next card starts in the middle');
  state = []; page = render('chat-1'); assert.ok(find(page, (n) => n.t === 'button' && text(n) === `▶ ${top.title}`), 'Started marks a Build now chat with ▶');
  reply = (body) => (body.idea ? { status: 200, body: { sessionId: 'now-2', plan: false } } : { status: 500, body: {} });
  const next = deck.cards[0]; assert.equal(key('ArrowUp'), 1); assert.ok(state[1].dy < 0, '↑ flies the card up too'); await flown(); await flown();
  assert.equal(calls.at(-1)[1].plan, false); assert.equal(calls.at(-1)[1].idea.title, next.title); assert.equal(opened.at(-1), 'now-2');
  assert.equal(key('ArrowUp', { closest: () => ({}) }), 0, '↑ inside a text field is left alone');
  // A held key decides one card only (its repeats would start one chat per Host answer); Shift+↑ is not Build now.
  const sentBefore = calls.length;
  for (const extra of [{ repeat: true }, { shiftKey: true }]) {
    assert.equal(key('ArrowUp', undefined, extra), 0, JSON.stringify(extra)); assert.equal(key('ArrowRight', undefined, extra), 0); assert.equal(key('ArrowDown', undefined, extra), 0);
  }
  await flown(); assert.equal(calls.length, sentBefore, 'no request from a repeat or Shift'); assert.equal(state[1].dy, 0, 'and no flight');
  // An older Host half ignores `plan: false` and plans: Started then shows ✓, not ▶.
  deck.cards = [...deck.cards, ...ideas(4, 30)]; // the steps below take cards off the top
  reply = (body) => (body.idea ? { status: 200, body: { sessionId: 'old-host', plan: true } } : { status: 500, body: {} });
  await decideIdea(deck, 'chat-1', 'up'); assert.equal(deck.accepted[0].sessionId, 'old-host'); assert.equal(deck.accepted[0].now, false, 'a planned chat is not marked ▶');
  // A failed Build now keeps the card on top; no Build now while a chat starts (▶ disabled, ↑ and the call do nothing).
  reply = () => ({ status: 409, body: { error: 'this chat has no project folder' } }); const kept = deck.cards[0];
  await decideIdea(deck, 'chat-1', 'up'); assert.equal(deck.cards[0], kept); assert.equal(deck.error, 'this chat has no project folder');
  const realFetch = globalThis.fetch; let go; const gate = new Promise((r) => { go = r; }); let starts = 0;
  globalThis.fetch = async (url, init) => { starts++; await gate; return realFetch(url, init); };
  reply = (body) => (body.idea ? { status: 200, body: { sessionId: 'now-3', plan: false } } : { status: 500, body: {} });
  const first = decideIdea(deck, 'chat-1', 'right');
  state = []; page = render('chat-1'); assert.equal(round('up').p.disabled, true, '▶ is disabled while a chat starts');
  assert.equal(key('ArrowUp'), 1); await flown(); await decideIdea(deck, 'chat-1', 'up');
  assert.equal(starts, 1, 'no Build now while a chat starts'); go(); await first; globalThis.fetch = realFetch;
}

// Saved for later: ↓ flies the card down, then the Host keeps it in the project's list; "Later (N)" opens the list, where
// Plan starts a plan-mode chat and Remove drops the idea.
{
  const realFetch = globalThis.fetch; const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
  const sent = []; let laterReply = () => ({ status: 200, body: {} }); let getGate, postGate;
  globalThis.fetch = async (url, init) => {
    const body = init === undefined ? undefined : JSON.parse(init.body); sent.push([url, body]);
    await (body === undefined ? getGate : postGate)?.p;
    const r = laterReply(body); return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  const saved = (title) => ({ id: `s-${title}`, title, summary: `${title} summary.`, at: 1 });
  const L = ideaDeck('later-a'); L.cards = ideas(3, 200); L.status = 'ready';
  laterReply = () => ({ status: 200, body: { ideas: [saved('Old')] } }); await loadLater(L, 'later-a');
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.later?sessionId=later-a', undefined], 'the list is read for this chat');
  assert.deepEqual(L.later.map((i) => i.title), ['Old']);
  // Save: the card leaves at once; the other deck actions wait; the Host's list replaces ours.
  laterReply = (body) => ({ status: 200, body: { ideas: [saved(body.add.title), saved('Old')] } });
  postGate = gate(); const save = laterIdea(L, 'later-a'); assert.equal(L.status, 'saving'); assert.deepEqual(L.cards.map((c) => c.id), ['i201', 'i202']);
  const before = sent.length;
  await suggestIdeas(L, 'later-a'); await decideIdea(L, 'later-a', 'right'); await laterIdea(L, 'later-a'); await removeLater(L, 'later-a', 's-Old'); await startLater(L, 'later-a', saved('Old'));
  await decideIdea(L, 'later-a', 'up'); await startLater(L, 'later-a', saved('Old'), undefined, true); await startAllLater(L, 'later-a');
  assert.equal(sent.length, before, 'no load, start, Build now, Plan all, second save or list change while a save runs');
  postGate.go(); await save; postGate = undefined;
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.later', { sessionId: 'later-a', add: { title: 'Idea 200', summary: 'Does 200.', why: 'Faster.', effort: 'small' } }]);
  assert.deepEqual(L.later.map((i) => i.title), ['Idea 200', 'Old']); assert.equal(L.status, 'ready'); assert.equal(L.error, undefined);
  // A failed save puts the card back on top and shows why; an older Host half asks for a restart.
  laterReply = () => ({ status: 500, body: { error: 'disk full' } }); await laterIdea(L, 'later-a');
  assert.deepEqual(L.cards.map((c) => c.id), ['i201', 'i202'], 'a failed save keeps the card'); assert.equal(L.error, 'disk full'); assert.equal(L.later.length, 2);
  laterReply = () => ({ status: 404, body: {} }); await laterIdea(L, 'later-a'); assert.equal(L.error, 'restart'); assert.equal(L.cards.length, 2);
  // No save while ideas load.
  { let go; const loading = new Promise((r) => { go = r; }); const realReply = laterReply; laterReply = () => ({ status: 200, body: { ideas: [] } });
    const prev = globalThis.fetch; globalThis.fetch = async (url, init) => { if (url === '/api/composer-plus.ideas') { await loading; return { ok: true, status: 200, json: async () => ({ ideas: [] }) }; } return prev(url, init); };
    const more = suggestIdeas(L, 'later-a'); const n = sent.length; await laterIdea(L, 'later-a'); assert.equal(sent.length, n, 'no save while ideas load');
    go(); await more; globalThis.fetch = prev; laterReply = realReply; }
  // A read that overlaps a change never replaces the newer list.
  getGate = gate();
  laterReply = (body) => (body === undefined ? { status: 200, body: { ideas: [saved('Stale')] } } : { status: 200, body: { ideas: [saved('Fresh')] } });
  const read = loadLater(L, 'later-a'); await new Promise((r) => setTimeout(r, 0));
  await laterIdea(L, 'later-a'); getGate.go(); await read; getGate = undefined;
  assert.deepEqual(L.later.map((i) => i.title), ['Fresh'], 'a stale read is ignored');
  L.later = [saved('Pantry'), saved('Timer')]; L.cards = ideas(2, 201); L.error = undefined;

  // Rendered: "Later (2)" in the head opens the list; ↓ and ArrowDown fly the top card down before it is saved.
  const at = (n) => (p) => find(p, n);
  const go = (sessionId) => { si = 0; return IdeasTab({ sessionId, t, openSession: (id) => opened.push(id), uiLocale: () => 'en' }); };
  state = []; let view = go('later-a');
  const laterButton = at((n) => n.t === 'button' && n.p['data-composer-plus-ideas-later'] === '');
  assert.equal(text(laterButton(view)), 'ideas.laterOpen:2');
  assert.ok(find(view, (n) => n.t === 'button' && n.p['data-side'] === 'later' && n.p['aria-label'] === 'ideas.later'), 'a ↓ button between ✕ and ✓');
  laterReply = (body) => ({ status: 200, body: { ideas: [saved(body.add.title), ...L.later] } });
  const press = (k) => { let prevented = 0; view.p.onKeyDown({ key: k, target: { closest: () => null }, preventDefault: () => prevented++ }); return prevented; };
  assert.equal(press('ArrowDown'), 1); assert.ok(state[1].dy > 0 && state[1].dx === 0 && state[1].fade, '↓ first flies the card down');
  assert.equal(L.cards.length, 2, 'the card stays until it has flown'); await new Promise((r) => setTimeout(r, 250));
  assert.equal(sent.at(-1)[1].add.title, 'Idea 201'); assert.deepEqual(L.cards.map((c) => c.id), ['i202']); assert.equal(state[1].dy, 0);
  state = []; view = go('later-a'); find(view, (n) => n.t === 'button' && n.p['data-side'] === 'later').p.onClick(); await new Promise((r) => setTimeout(r, 250));
  assert.equal(sent.at(-1)[1].add.title, 'Idea 202', 'the ↓ button saves too'); assert.equal(L.cards.length, 0);
  state = []; view = go('later-a'); assert.equal(text(laterButton(view)), 'ideas.laterOpen:4');
  laterButton(view).p.onClick(); view = go('later-a');
  const items = () => { const list = find(view, (n) => n.p?.role === 'list'); return list ? list.c.filter((c) => c?.p?.role === 'listitem') : []; };
  assert.deepEqual(items().map((i) => i.p['data-composer-plus-later']), ['s-Idea 202', 's-Idea 201', 's-Pantry', 's-Timer'], 'the list shows the saved ideas');
  assert.equal(press('ArrowDown'), 0, 'card keys do nothing in the list');
  const button = (item, label) => find(item, (n) => n.t === 'button' && text(n) === label);
  // Plan: the Host starts the chat; the idea leaves the list, joins Started, and the chat opens.
  laterReply = () => ({ status: 200, body: { sessionId: 'new-L', plan: true, ideas: L.later.filter((i) => i.id !== 's-Pantry') } });
  await button(items()[2], 'ideas.plan').p.onClick();
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.later', { sessionId: 'later-a', start: 's-Pantry' }]);
  assert.equal(opened.at(-1), 'new-L'); assert.equal(L.accepted[0].title, 'Pantry'); assert.equal(L.accepted[0].sessionId, 'new-L'); assert.equal(L.later.length, 3);
  // Build now on a saved idea: the same start with `plan: false`; Started marks it with ▶.
  const keep = L.later;
  laterReply = () => ({ status: 200, body: { sessionId: 'now-L', plan: false, ideas: L.later.filter((i) => i.id !== 's-Idea 201') } });
  view = go('later-a'); const nowItem = items().find((i) => i.p['data-composer-plus-later'] === 's-Idea 201');
  assert.equal(button(nowItem, 'ideas.buildNow').p.disabled, false);
  const pressed = button(nowItem, 'ideas.buildNow').p.onClick(); view = go('later-a');
  assert.equal(button(items().find((i) => i.p['data-composer-plus-later'] === 's-Idea 201'), 'ideas.buildNow').p.disabled, true, 'Build now in the list is disabled while it starts');
  await pressed;
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.later', { sessionId: 'later-a', start: 's-Idea 201', plan: false }]);
  assert.equal(opened.at(-1), 'now-L'); assert.equal(L.accepted[0].now, true); assert.equal(L.later.length, 2);
  L.later = keep; // the checks below start from the 3 ideas
  // Plan all: the head button (2 or more ideas) sends the ids shown, then the chat opens; disabled while it starts.
  view = go('later-a'); const planAll = () => find(view, (n) => n.t === 'button' && n.p['data-composer-plus-ideas-plan-all'] === '');
  assert.equal(text(planAll()), 'ideas.planAll:3'); assert.equal(planAll().p.disabled, false);
  laterReply = () => ({ status: 200, body: { sessionId: 'all-L', plan: true, ideas: [] } });
  const all = planAll().p.onClick(); view = go('later-a'); assert.equal(planAll().p.disabled, true, 'Plan all is disabled while it starts');
  await all;
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.later', { sessionId: 'later-a', startAll: keep.map((i) => i.id) }]);
  assert.equal(opened.at(-1), 'all-L'); assert.equal(L.accepted[0].title, keep.map((i) => i.title).join(' + ')); assert.equal(L.accepted[0].now, undefined);
  L.later = [keep[0]]; view = go('later-a'); assert.equal(planAll(), undefined, 'no Plan all for one idea');
  const n1 = sent.length; await startAllLater(L, 'later-a'); assert.equal(sent.length, n1, 'and no request');
  L.later = keep;
  // A failed start shows why and reads the list again (another window can have changed it).
  laterReply = (body) => (body === undefined ? { status: 200, body: { ideas: L.later.filter((i) => i.id !== 's-Timer') } } : { status: 409, body: { error: 'this idea is no longer in the list' } });
  view = go('later-a'); await button(items()[2], 'ideas.plan').p.onClick(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(L.error, 'this idea is no longer in the list'); assert.equal(sent.at(-1)[1], undefined, 'then the list is read again'); assert.equal(L.later.length, 2);
  // Open GitHub issue: the Host answers the list with the link; the button turns into "Issue #N" (an https link only).
  {
    const issueOf = (item) => find(item, (n) => n.t === 'button' && n.p['data-composer-plus-ideas-issue'] !== undefined);
    const linkOf = (item) => find(item, (n) => n.t === 'a' && n.p['data-composer-plus-ideas-issue-link'] !== undefined);
    view = go('later-a'); const first = items()[0]; const id = first.p['data-composer-plus-later'];
    assert.equal(text(issueOf(first)), 'ideas.issue'); assert.equal(linkOf(first), undefined);
    postGate = gate();
    laterReply = (body) => ({ status: 200, body: { issue: { url: 'https://github.com/acme/web/issues/9', number: 9 }, ideas: L.later.map((i) => (i.id === body.issue ? { ...i, issue: { url: 'https://github.com/acme/web/issues/9', number: 9 } } : i)) } });
    const opening = issueOf(first).p.onClick(); view = go('later-a');
    assert.equal(L.status, 'issuing'); assert.equal(issueOf(items()[1]).p.disabled, true, 'other issue buttons wait');
    assert.ok(find(view, (n) => text(n) === 'ideas.issuing'), 'a note says that the issue is being opened');
    const n = sent.length; await issueLater(L, 'later-a', id); await startLater(L, 'later-a', L.later[1]); await removeLater(L, 'later-a', id);
    assert.equal(sent.length, n, 'no second issue, start or change while an issue opens');
    postGate.go(); await opening; postGate = undefined;
    assert.deepEqual(sent.at(-1), ['/api/composer-plus.later', { sessionId: 'later-a', issue: id }]);
    view = go('later-a'); const link = linkOf(items()[0]);
    assert.equal(link.p.href, 'https://github.com/acme/web/issues/9'); assert.equal(link.p.target, '_blank'); assert.equal(link.p.rel, 'noopener noreferrer');
    assert.equal(text(link), 'ideas.issueLink:9'); assert.equal(issueOf(items()[0]), undefined, 'no second issue button');
    // A link that is not an https issue URL is never drawn as a link.
    const keepList = L.later; L.later = [{ ...keepList[0], issue: { url: 'javascript:alert(1)', number: 9 } }, ...keepList.slice(1)]; view = go('later-a');
    assert.equal(linkOf(items()[0]), undefined); assert.ok(issueOf(items()[0]), 'a bad link shows the button again');
    L.later = keepList;
    // gh refuses: the reason shows, and the list is read again (the issue may exist after a time-out).
    laterReply = (body) => (body === undefined ? { status: 200, body: { ideas: L.later } } : { status: 409, body: { error: 'gh could not open the issue: gh auth login' } });
    view = go('later-a'); await issueOf(items()[1]).p.onClick(); await new Promise((r) => setTimeout(r, 0));
    assert.equal(L.error, 'gh could not open the issue: gh auth login'); assert.equal(sent.at(-1)[1], undefined, 'then the list is read again');
    assert.equal(L.status, 'ready'); L.error = undefined;
    L.later = L.later.map((i) => ({ ...i, issue: undefined }));
  }
  // Remove: the Host's shorter list; an empty list goes back to the cards.
  laterReply = (body) => ({ status: 200, body: { ideas: L.later.filter((i) => i.id !== body.remove) } });
  view = go('later-a'); await button(items()[0], 'ideas.remove').p.onClick(); assert.deepEqual(sent.at(-1)[1], { sessionId: 'later-a', remove: 's-Idea 202' });
  view = go('later-a'); await button(items()[0], 'ideas.remove').p.onClick(); assert.deepEqual(L.later, []);
  view = go('later-a'); assert.equal(state[2], 'cards', 'an empty list goes back to the cards'); assert.equal(items().length, 0);
  assert.ok(!laterButton(view), 'no Later button without saved ideas');
  // History: the head button opens the project's earlier ideas (read from the Host); Forget and Forget all ask the Host.
  laterReply = (body) => (body === undefined ? { status: 200, body: { ideas: [{ ...saved('Old idea'), started: true }, saved('Skipped one')] } } : { status: 200, body: { ideas: body.clear ? [] : [saved('Skipped one')] } });
  state = []; view = go('later-a');
  const historyButton = () => find(view, (n) => n.t === 'button' && n.p['data-composer-plus-ideas-history'] === '');
  assert.equal(text(historyButton()), 'ideas.history');
  await historyButton().p.onClick(); await new Promise((r) => setTimeout(r, 0)); view = go('later-a');
  assert.equal(state[2], 'history'); assert.deepEqual(sent.at(-1), ['/api/composer-plus.idea-history?sessionId=later-a', undefined]);
  const pastItems = () => { const list = find(view, (n) => n.p?.role === 'list'); return list ? list.c.filter((c) => c?.p?.role === 'listitem') : []; };
  assert.deepEqual(pastItems().map((i) => i.p['data-composer-plus-past']), ['s-Old idea', 's-Skipped one']);
  assert.ok(find(pastItems()[0], (n) => text(n) === 'ideas.historyStarted') && find(pastItems()[1], (n) => text(n) === 'ideas.historySuggested'), 'started and suggested are marked');
  // An idea that is also in the Later list stays avoided: no Forget there, a note instead.
  const keepLater = L.later; L.later = [saved('Skipped one')]; view = go('later-a');
  assert.ok(find(pastItems()[1], (n) => text(n) === 'ideas.historySaved') && !find(pastItems()[1], (n) => text(n) === 'ideas.historyForget'));
  L.later = keepLater; view = go('later-a');
  assert.equal(press('ArrowRight'), 0, 'card keys do nothing in the history');
  await find(pastItems()[0], (n) => n.t === 'button' && text(n) === 'ideas.historyForget').p.onClick();
  assert.deepEqual(sent.at(-1), ['/api/composer-plus.idea-history', { sessionId: 'later-a', remove: 's-Old idea' }]); view = go('later-a');
  assert.deepEqual(pastItems().map((i) => i.p['data-composer-plus-past']), ['s-Skipped one']);
  // One change at a time: no Forget while another history change runs.
  postGate = gate(); const forgetting = forgetHistory(L, 'later-a', { clear: true }); const n2 = sent.length;
  await forgetHistory(L, 'later-a', { remove: 's-Skipped one' }); await loadHistory(L, 'later-a'); assert.equal(sent.length, n2, 'no second history request while one runs');
  postGate.go(); await forgetting; postGate = undefined; view = go('later-a'); assert.deepEqual(L.past, []);
  assert.ok(find(view, (n) => text(n) === 'ideas.historyEmpty'), 'an empty history says so');
  // A failed read shows only the error, no "saving" note.
  L.past = undefined; laterReply = () => ({ status: 500, body: { error: 'disk full' } }); await loadHistory(L, 'later-a'); view = go('later-a');
  assert.equal(L.error, 'disk full'); assert.ok(!find(view, (n) => text(n) === 'ideas.saving'), 'no saving note after a failed read');
  find(view, (n) => n.t === 'button' && n.p['data-composer-plus-ideas-back'] === '').p.onClick(); view = go('later-a'); assert.equal(state[2], 'cards');
  globalThis.fetch = realFetch;
}

// Focus topic: the field and the chips fill `deck.focus`; a focus goes with Suggest only when it has text.
{
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ideas: ideas(1, 300) }) }; };
  const F = ideaDeck('focus-a'); assert.equal(F.focus, '', 'no focus at first');
  await suggestIdeas(F, 'focus-a', 'en'); assert.deepEqual(sent.at(-1), { sessionId: 'focus-a', locale: 'en' }, 'an empty focus sends the same request as before');
  F.cards = []; F.focus = '   '; await suggestIdeas(F, 'focus-a'); assert.deepEqual(sent.at(-1), { sessionId: 'focus-a' }, 'only spaces count as empty');
  F.cards = []; F.focus = '  speed of search '; await suggestIdeas(F, 'focus-a', 'tr'); assert.deepEqual(sent.at(-1), { sessionId: 'focus-a', locale: 'tr', focus: 'speed of search' });
  // Rendered: an empty deck shows the field, Suggest and six chips; the cards view shows them above the stack.
  F.focus = ''; F.cards = []; F.status = 'idle';
  const go = () => { si = 0; return IdeasTab({ sessionId: 'focus-a', t, openSession: () => {}, uiLocale: () => 'ko' }); };
  let page = go();
  const box = () => find(page, (n) => n.p?.['data-composer-plus-ideas-focus'] === '');
  const input = () => find(box(), (n) => n.t === 'input'); const chip = (id) => find(box(), (n) => n.p?.['data-composer-plus-ideas-focus-preset'] === id);
  assert.ok(box(), 'the empty page has the focus box'); assert.equal(input().p['aria-label'], 'ideas.focus'); assert.equal(input().p.maxLength, 80);
  assert.ok(find(box(), (n) => n.t === 'button' && text(n) === 'ideas.suggest'), 'Suggest sits next to the field');
  assert.deepEqual(FOCUS_PRESETS, ['performance', 'accessibility', 'tests', 'security', 'usability', 'docs']);
  const chips = find(box(), (n) => n.p?.role === 'group'); assert.equal(chips.p['aria-label'], 'ideas.focusPresets');
  assert.deepEqual(chips.c.map((c) => text(c)), FOCUS_PRESETS.map((id) => `ideas.focus.${id}`), 'six fixed chips, in the UI language');
  assert.ok(chips.c.every((c) => c.p['aria-pressed'] === false), 'none pressed');
  // A chip fills the field with its label; the same chip again empties it; typing replaces it.
  chip('tests').p.onClick(); assert.equal(F.focus, 'ideas.focus.tests'); page = go(); assert.equal(chip('tests').p['aria-pressed'], true); assert.equal(input().p.value, 'ideas.focus.tests');
  chip('security').p.onClick(); assert.equal(F.focus, 'ideas.focus.security', 'another chip replaces it'); page = go(); assert.equal(chip('tests').p['aria-pressed'], false);
  chip('security').p.onClick(); assert.equal(F.focus, '', 'a second click empties it');
  input().p.onChange({ target: { value: 'offline mode' } }); assert.equal(F.focus, 'offline mode'); page = go();
  assert.ok(chips.c.length === 6 && find(box(), (n) => n.p?.role === 'group').c.every((c) => c.p['aria-pressed'] === false), 'free text presses no chip');
  // Enter suggests once with the focus and the UI language; not while an IME composes, not on a repeat, not while busy.
  const enter = (extra = {}) => { let prevented = 0; input().p.onKeyDown({ key: 'Enter', preventDefault: () => prevented++, ...extra }); return prevented; };
  const n0 = sent.length; assert.equal(enter({ isComposing: true }), 0); assert.equal(enter({ keyCode: 229 }), 0); assert.equal(enter({ repeat: true }), 0); assert.equal(sent.length, n0);
  assert.equal(enter(), 1); await new Promise((r) => setTimeout(r, 0)); assert.deepEqual(sent.at(-1), { sessionId: 'focus-a', locale: 'ko', focus: 'offline mode' });
  let go2; globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); await new Promise((r) => { go2 = r; }); return { ok: true, status: 200, json: async () => ({ ideas: ideas(1, 310) }) }; };
  const loading = suggestIdeas(F, 'focus-a'); const n1 = sent.length; enter(); chip('docs'); assert.equal(sent.length, n1, 'no second request while ideas load'); go2(); await loading;
  // The cards view: the box sits above the stack and holds More ideas; arrow keys in the field never fly a card.
  page = go(); const stack = page.c.indexOf(page.c.find((c) => c?.t === 'F'));
  const frag = page.c.find((c) => c?.t === 'F'); assert.equal(frag.c[0].p['data-composer-plus-ideas-focus'], '', 'the focus box comes before the stack'); void stack;
  assert.ok(find(frag.c[0], (n) => n.t === 'button' && text(n) === 'ideas.more'), 'More ideas sits next to the field');
  assert.ok(!find(page.c.find((c) => c?.p?.className === 'cpi-head'), (n) => n.t === 'button' && text(n) === 'ideas.more'), 'and no longer in the head');
  const before = F.cards.length; let prevented = 0; page.p.onKeyDown({ key: 'ArrowLeft', target: { closest: (sel) => (sel.includes('input') ? {} : null) }, preventDefault: () => prevented++ });
  await new Promise((r) => setTimeout(r, 250)); assert.equal(prevented, 0); assert.equal(F.cards.length, before, 'arrow keys in the focus field leave the cards alone');
  globalThis.fetch = realFetch;
}

// Copy as checklist: the Later view copies the list as a Markdown checklist, without a network call.
{
  assert.equal(laterChecklist([{ title: 'Dark mode', summary: 'A dark theme.' }, { title: 'Export', summary: 'Save as CSV.', why: 'x' }]), '- [ ] Dark mode — A dark theme.\n- [ ] Export — Save as CSV.\n');
  const C = ideaDeck('copy-a'); C.later = [{ id: 'a', title: 'Pantry', summary: 'Track food.', why: 'Less waste.' }, { id: 'b', title: 'Timer', summary: 'Cook steps.' }];
  const realFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ ideas: C.later }) }; };
  const go = () => { si = 0; return IdeasTab({ sessionId: 'copy-a', t, openSession: () => {}, uiLocale: () => 'en' }); };
  state = []; let page = go(); find(page, (n) => n.p?.['data-composer-plus-ideas-later'] === '').p.onClick(); page = go();
  const button = () => find(page, (n) => n.t === 'button' && n.p['data-composer-plus-ideas-copy-later'] === '');
  assert.equal(text(button()), 'ideas.copyLater'); assert.equal(button().p.title, 'ideas.copyLaterHint'); assert.equal(button().p.disabled, undefined, 'read-only: never disabled');
  assert.ok(!find(page, (n) => n.p?.['data-composer-plus-ideas-focus'] === ''), 'no focus box in the Later list');
  const callsBefore = calls; const n = clipboard.length;
  await button().p.onClick(); page = go();
  assert.deepEqual(clipboard.slice(n), ['- [ ] Pantry — Track food.\n- [ ] Timer — Cook steps.\n'], 'the list, in its order, title and summary');
  assert.equal(calls, callsBefore, 'no network call'); assert.equal(text(button()), 'ideas.copied');
  await new Promise((r) => setTimeout(r, 2100)); page = go(); assert.equal(text(button()), 'ideas.copyLater', 'the label comes back after 2 s');
  clipboardOk = false; await button().p.onClick(); page = go(); assert.equal(text(button()), 'ideas.copyFailed', 'a refused copy says so'); clipboardOk = true;
  C.status = 'starting'; page = go(); assert.equal(button().p.disabled, undefined, 'it stays on while another action runs'); C.status = 'idle';
  globalThis.fetch = realFetch;
}

// Feature switch: on by default, it registers the Ideas tab and its slots; switching it off removes them all.
const live = new Map(); let next = 0; const tabs = new Set();
const slots = { inject: (name, f) => { const off = f(); return () => off(); }, register: (o) => { const k = `${o.name}#${o.id ?? o.key}#${next++}`; live.set(k, o); return () => live.delete(k); } };
const ctx = { slots, configForms: { get: () => ({}) }, effect: () => {}, locale: { register: () => () => {}, bind: () => (k) => k, getLocale: () => ({ active: 'ko', locales: [] }) },
  inject: (deps, setup) => { const disposers = []; setup({ effect: (f) => { const off = f(); if (typeof off === 'function') disposers.push(off); }, uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
    sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } }, uiWorkspace: { openSession: (id) => opened.push(`ws:${id}`) }, workspaces: { list: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    sidebarRight: {}, sidebarRightTabs: { register: (tab) => { tabs.add(tab.id); return () => tabs.delete(tab.id); } } }); return { dispose: () => disposers.forEach((f) => f()) }; } };
plugin.apply(ctx);
const ideaSlots = () => [...live.values()].filter((o) => o.key === 'dsh-composer-plus/ideas').map((o) => o.name).sort();
assert.ok(tabs.has('dsh-composer-plus/ideas')); assert.deepEqual(ideaSlots(), ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
const body = [...live.values()].find((o) => o.key === 'dsh-composer-plus/ideas' && o.name === 'sidebar.right.pane.tab');
body.inject().openSession('s-7'); assert.equal(opened.at(-1), 'ws:s-7', 'opening a started chat goes through dsh navigation');
assert.equal(body.inject().uiLocale(), 'ko', 'the page reads dsh’s active UI language');
const settings = [...live.values()].find((o) => o.id === 'composer-plus');
settings.inject().setFeature('featureIdeas', false);
assert.ok(!tabs.has('dsh-composer-plus/ideas'), 'switching off removes the tab type'); assert.deepEqual(ideaSlots(), [], 'and both slots');
assert.ok(tabs.has('dsh-composer-plus/changes'), 'other features stay');
settings.inject().setFeature('featureIdeas', true); assert.ok(tabs.has('dsh-composer-plus/ideas'), 'switching on again reinstalls');
console.log('feature-ideas client checks passed');
