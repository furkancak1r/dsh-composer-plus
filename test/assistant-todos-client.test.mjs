// Assistant status panel with the to-do list (client half, real client.js with fake dsh slots and a fake fetch).
// - A seat in dsh's input dock (only in the assistant chat) gives the chat body; the panel is a shell.overlay entry
//   (typing in the composer does not draw it again) portaled into that chat body, at the right side of the chat, not in
//   dsh's right sidebar.
// - To-do items have real buttons with an aria-label: Hand over (only for an item of the user) sends the action with the
//   prefix in the UI language; Remove removes at once. Keyboard: aria-disabled (not disabled) while an action runs.
// - The status: the morning summary card (only today's; Hide keeps it hidden; a project name opens its row), the tasks
//   (state, time, result; a click opens the task's chat), the projects (closed rows with one line; a click opens the
//   row, reads its git details once, shows its chats, to-do items, branch and commits), Refresh and the update time.
// - The store: one action per chat at a time, an older read never overwrites a newer answer, a failed action keeps the
//   reason, `schedule` merges a burst of calls into one read.
// - Switched off, the dock and overlay entries go.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
const focused = []; const scrolled = [];
const elements = new Map();
globalThis.document = { visibilityState: 'visible', body: { tag: 'body' }, activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  getElementById: (id) => elements.get(id) ?? { focus: () => focused.push(id), scrollIntoView: () => scrolled.push(id) } };
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const NOW = Date.now();
let switchOn = true;
let items = [{ id: 'aaaaaaaa', text: 'Prosolocal\'i internete açmak', owner: 'user', created: 1 }, { id: 'bbbbbbbb', text: 'Rapor yaz', owner: 'agent', created: 2 }];
let tasks = [{ id: 'c-run', title: 'Research Rome', state: 'running', started: NOW - 125000 }, { id: 'c-done', title: 'Flights', state: 'done', started: NOW - 600000, ended: NOW - 60000, result: 'Flights found: 3 options' }];
let projects = [{ id: 'w-web', title: 'acme-web', count: 2, updated: NOW, chats: [{ id: 's-web', title: 'Login page', updated: NOW - 1000, running: true }] }, { id: 'w-cli', title: 'weather-cli', count: 1, updated: NOW - 5000, chats: [{ id: 's-cli', title: 'Weather', updated: NOW - 5000, running: false }] }];
let summary = { at: NOW, projects: [{ project: 'acme-web', text: 'Login page done.' }, { project: 'other-proj', text: 'Not in the list.' }] };
const posts = []; const gets = []; let gate = null; let failNext = null;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === '/api/composer-plus.assistant-status') return Response.json({ sessionId: 's-assistant' });
  if (u.startsWith('/api/composer-plus.assistant-todos')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body); posts.push(body);
      if ('on' in body) { switchOn = body.on; return Response.json({ on: switchOn }); }
      if (gate) await gate;
      if (failNext) { const error = failNext; failNext = null; return Response.json({ error, on: true, items }, { status: 502 }); }
      if (body.action === 'remove') items = items.filter((i) => i.id !== body.id);
      else items = items.map((i) => (i.id === body.id ? { ...i, owner: 'agent' } : i));
      return Response.json({ on: true, items });
    }
    gets.push(u);
    const q = new URL(u, 'http://x').searchParams;
    if (q.get('project') !== null) return Response.json({ project: q.get('project'), branch: 'feature/x', commits: [{ hash: 'abc1234', at: NOW - 3600000, subject: 'Fix login' }] });
    return Response.json(q.get('sessionId') === null ? { on: switchOn } : { on: switchOn, items: switchOn ? items : [], tasks, projects, summary, at: NOW });
  }
  return new Response('{}', { status: 404 });
};

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
// A small hook runtime per component: state and refs by call order; layout effects run at each render; effects are kept.
const runtime = () => {
  let hooks = []; let hi = 0; let effects = [];
  const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
    useState: (v) => { const i = hi++; if (!(i in hooks)) hooks[i] = typeof v === 'function' ? v() : v; return [hooks[i], (x) => { hooks[i] = typeof x === 'function' ? x(hooks[i]) : x; }]; },
    useRef: (v) => { const i = hi++; return hooks[i] ??= { current: v }; },
    useEffect: (f) => { effects.push(f); }, useLayoutEffect: (f) => { f(); }, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f };
  return { React, reset: () => { hi = 0; effects = []; }, effects: () => effects, clear: () => { hooks = []; } };
};
// The cleanups of the effects that the test ran (the running-task poll is a timer): React runs them on unmount.
const cleanups = [];
const runEffects = (list) => { for (const f of list) { const off = f(); if (typeof off === 'function') cleanups.push(off); } };
const rt = runtime();
const plugin = mod.factory((n) => (n === 'react' ? rt.React : n === 'react-dom' ? { createPortal: (el, host, key) => ({ portal: el, host, key }) }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
const live = new Map(); let next = 0; const opened = [];
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: (n) => (n === 'uiWorkspace' ? { openSession: (id) => opened.push(id) } : undefined),
  locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x, getSnapshot: () => ({ active: 'tr' }) },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
await tick();
const entry = (name, id) => [...live.values()].find(([o]) => o.name === name && o.id === id);
const [seatEntry, Seat] = entry('conversation.input.dock', 'assistant-todos') ?? [];
const [overlayEntry, Panels] = entry('shell.overlay', 'assistant-status') ?? [];
assert.ok(seatEntry && overlayEntry, 'a seat in dsh\'s input dock and the panel in shell.overlay while the feature is on');
const seatProps = seatEntry.inject('s-assistant'); const panelProps = overlayEntry.inject();
assert.equal(seatProps.seats, panelProps.seats, 'one seat store');
const t = (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`);
const attrs = new Map();
const body = { tag: 'chat-body', setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
const mark = { closest: (sel) => (sel === '[data-conversation-content]' ? body : null) };
// The seat: only in the assistant chat it gives the chat body (its ref is its first hook: the test gives it the mark).
rt.reset(); rt.clear();
const seatOut = (sessionId) => { rt.reset(); const out = Seat({ ...seatProps, sessionId, t }); return out; };
{ rt.reset(); const ref = rt.React.useRef(null); ref.current = mark; } // even with a chat body, another chat gives no seat
seatOut('s-other');
assert.equal(seatProps.seats.getSnapshot().size, 0, 'no seat in another chat');
// Give the ref the chat body mark, render again: the seat is set.
rt.clear(); rt.reset();
{ const React = rt.React; const ref = React.useRef(null); ref.current = mark; }
rt.reset(); seatOut('s-assistant');
assert.equal(seatProps.seats.getSnapshot().get('s-assistant'), body, 'the assistant chat gives its chat body');

// The panels: one portal per seat, into the chat body.
const useSessions = (pick) => pick({ byId: { 's-assistant': { running: false } }, projectionsBySession: { 's-assistant': { values: { subagentCatalog: [{ id: 'c-run', mode: 'one-shot' }, { id: 'c-done', mode: 'one-shot' }] } } } });
const statuses = new Map([['s-assistant', { running: false }], ['c-run', { running: true }]]);
const useSessionStatus = (pick) => pick(statuses);
rt.clear();
let renders = 0;
const panel = () => {
  rt.reset();
  const out = Panels({ ...panelProps, useSessions, useSessionStatus, t });
  assert.equal(out.c[0][0].host, body, 'portaled into dsh\'s chat body, not into the right sidebar');
  const inner = out.c[0][0].portal; rt.reset(); renders += 1;
  return inner.t(inner.p);
};
let tree = panel();
runEffects(rt.effects()); await tick();
const find = (n, pred) => { if (n === null || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap((c) => find(c, pred)); const own = pred(n) ? [n] : []; return [...own, ...(n.c ?? []).flat(Infinity).flatMap((c) => find(c, pred)), ...(n.portal ? find(n.portal, pred) : [])]; };
const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join(' ') : n?.portal ? text(n.portal) : n?.c ? text(n.c) : '');
tree = panel();
const root = find(tree, (n) => n.p?.['data-composer-plus-todos'] === '')[0];
assert.ok(root, 'the panel shows'); assert.equal(root.t, 'section');
assert.equal(attrs.get('data-composer-plus-status-seat'), 'open', 'the chat makes room for the open panel');
const style = find(root, (n) => n.t === 'style')[0]; assert.match(style.c[0], /position:absolute;top:12px;right:20px/, 'at the right side of the chat');
assert.doesNotMatch(style.c[0], /:has\(> \[data-composer-plus-todos\]\)/, 'no :has() rule on the chat body');
// Heading: h2 > button[aria-expanded]; no aria-label on a span.
const h2 = find(root, (n) => n.t === 'h2')[0]; assert.equal(find(h2, (n) => n.t === 'button' && n.p['aria-expanded'] === true).length, 1, 'h2 > button[aria-expanded]');
assert.equal(find(root, (n) => n.t === 'span' && n.p['aria-label'] !== undefined).length, 0, 'no aria-label on a span');
assert.match(text(h2), /status\.title/); assert.match(text(h2), /status\.updated/, 'the last update time');
const refresh = find(root, (n) => n.t === 'button' && n.p['aria-label'] === 'status.refresh')[0]; assert.ok(refresh, 'Refresh button with an aria-label');
// Summary card: today's, with a link for a project that is on the list.
const card = find(root, (n) => n.p?.className === 'cp-st-summary')[0]; assert.ok(card, 'the morning summary card');
assert.match(text(card), /Login page done\./); assert.match(text(card), /Not in the list\./);
const link = find(card, (n) => n.t === 'button' && n.p.className === 'cp-st-link'); assert.equal(link.length, 1, 'only a listed project is a link');
// To-do items.
assert.match(text(root), /Prosolocal'i internete açmak/); assert.match(text(root), /Rapor yaz/);
const handover = find(root, (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? ''));
assert.equal(handover.length, 1, 'Hand over only for an item of the user');
// Tasks: state, time, result; a click opens its chat.
const taskRows = find(root, (n) => n.t === 'button' && n.p.className === 'cp-st-row' && n.p['aria-expanded'] === undefined);
assert.equal(taskRows.length, 2); assert.match(text(taskRows[0]), /Research Rome.*status\.task\.running/); assert.match(text(taskRows[1]), /Flights found: 3 options/);
assert.match(text(taskRows[0]), /dk|min/, 'the time it runs');
taskRows[0].p.onClick(); assert.deepEqual(opened, ['c-run'], 'a click opens the task\'s chat');
// Projects: closed rows with one line (the summary's sentence, else the chat count).
let rows = find(root, (n) => n.t === 'button' && n.p.className === 'cp-st-row' && n.p['aria-expanded'] !== undefined);
assert.deepEqual(rows.map((r) => r.p['aria-expanded']), [false, false], 'closed by default');
assert.match(text(rows[0]), /Login page done\./); assert.match(text(rows[1]), /status\.projectChats:\{"count":1\}/);
const nameOf = (b) => text(find(b, (n) => n.p?.className === 'cp-st-name')[0]);
assert.doesNotMatch(nameOf(rows[0]).replace(/\s/g, ''), /[▸▾]/, 'F-10: the arrow is not in the name text');
assert.ok(find(rows[0], (n) => n.p?.['aria-hidden'] === true && /[▸▾]/.test(text(n))).length === 1, 'F-10: the arrow is aria-hidden');
const before = gets.length;
rows[0].p.onClick(); tree = panel();
rows = find(tree, (n) => n.t === 'button' && n.p.className === 'cp-st-row' && n.p['aria-expanded'] !== undefined);
assert.equal(rows[0].p['aria-expanded'], true);
// The detail reads the project's git details once.
const detail = find(tree, (n) => n.t?.name === 'ProjectDetail')[0];
assert.ok(detail, 'the open row shows its detail');
const D = detail.t; let dTree;
const drawDetail = () => { rt.reset(); return D(detail.p); };
dTree = drawDetail(); runEffects(rt.effects()); await tick();
assert.ok(gets.slice(before).some((u) => /project=w-web/.test(u)), 'git details on open');
const once = gets.length; dTree = drawDetail(); runEffects(rt.effects()); await tick();
assert.equal(gets.length, once, 'the git details are read once, not at each draw');
dTree = D(detail.p);
assert.match(text(dTree), /Login page/); assert.match(text(dTree), /status\.branch:\{"branch":"feature\/x"\}/); assert.match(text(dTree), /abc1234/); assert.match(text(dTree), /Fix login/);
find(dTree, (n) => n.t === 'button' && n.p.className === 'cp-st-link')[0].p.onClick(); assert.deepEqual(opened, ['c-run', 's-web'], 'a chat link opens the chat');
// The summary link opens and focuses the project row.
link[0].p.onClick(); await new Promise((r) => setTimeout(r, 5));
assert.deepEqual(focused.at(-1), 'cp-st-s-assistant-w-web'); assert.deepEqual(scrolled.at(-1), 'cp-st-s-assistant-w-web');
// Hide the summary: kept hidden (this browser) until a new one comes.
tree = panel();
find(tree, (n) => n.t === 'button' && n.p['aria-label'] === 'status.hideSummary')[0].p.onClick();
tree = panel(); assert.equal(find(tree, (n) => n.p?.className === 'cp-st-summary').length, 0, 'hidden');
assert.equal(mem.get('dsh-composer-plus.status-summary-hidden'), String(NOW));
// An old summary (yesterday) does not show.
summary = { at: NOW - 86400000 * 2, projects: [{ project: 'acme-web', text: 'Old.' }] }; mem.delete('dsh-composer-plus.status-summary-hidden');
await panelProps.store.load('s-assistant'); rt.clear(); tree = panel(); assert.equal(find(tree, (n) => n.p?.className === 'cp-st-summary').length, 0, 'only today\'s summary');

// Owner groups: the user's items first, then the assistant's, each header with a count; no owner line in a row; a
// header (aria-expanded, aria-controls) folds its group and the folded groups stay folded in this browser.
const todoSection = (tr) => find(tr, (n) => n.t === 'section' && /-todos$/.test(n.p['aria-labelledby'] ?? ''))[0];
const groups = (tr) => find(todoSection(tr), (n) => n.t === 'button' && n.p.className === 'cp-td-group');
const groupLists = (tr) => find(todoSection(tr), (n) => n.t === 'ul');
{
  const saved = items;
  items = [{ id: '11111111', text: 'U1', owner: 'user', created: 1 }, { id: '22222222', text: 'A1', owner: 'agent', created: 2 }, { id: '33333333', text: 'U2', owner: 'user', created: 3 },
    { id: '44444444', text: 'A2', owner: 'agent', created: 4 }, { id: '55555555', text: 'A3', owner: 'agent', created: 5 }];
  await panelProps.store.load('s-assistant');
  let g = groups(panel());
  assert.deepEqual(g.map((b) => [b.p['data-owner'], b.p['aria-expanded']]), [['user', true], ['agent', true]], 'two groups, the user\'s first, both open');
  assert.match(text(g[0]), /todos\.groupUser\s+2$/); assert.match(text(g[1]), /todos\.groupAgent:\{"name":"assistant\.title"\}\s+3$/);
  assert.ok(g.every((b) => find(b, (n) => n.p?.['aria-hidden'] === true && /[▸▾]/.test(text(n))).length === 1), 'the arrow is aria-hidden');
  let lists = groupLists(panel());
  assert.deepEqual(lists.map((l) => find(l, (n) => n.p?.className === 'cp-td-text').map(text)), [['U1', 'U2'], ['A1', 'A2', 'A3']], 'each item in its owner\'s group');
  assert.deepEqual(lists.map((l) => l.p.id), g.map((b) => b.p['aria-controls']), 'each header controls its list');
  assert.doesNotMatch(text(todoSection(panel())), /todos\.owner/, 'no owner line in a row');
  assert.equal(find(lists[1], (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? '')).length, 0, '→ only in the user\'s group');
  assert.equal(find(lists[1], (n) => n.t === 'button' && /todos\.remove:/.test(n.p['aria-label'] ?? '')).length, 3, '× in both groups');
  g[1].p.onClick(); g = groups(panel()); lists = groupLists(panel());
  assert.deepEqual(g.map((b) => b.p['aria-expanded']), [true, false], 'a click folds the group'); assert.deepEqual(lists.map((l) => l.p.hidden), [false, true]);
  assert.equal(mem.get('dsh-composer-plus.status-todo-groups-closed'), 'agent', 'kept in this browser');
  rt.clear(); assert.equal(groups(panel())[1].p['aria-expanded'], false, 'still folded after the panel opens again');
  groups(panel())[1].p.onClick(); assert.equal(groups(panel())[1].p['aria-expanded'], true, 'a second click opens it');
  assert.equal(mem.get('dsh-composer-plus.status-todo-groups-closed'), '');
  items = saved; await panelProps.store.load('s-assistant'); rt.clear(); tree = panel();
}

// Hand over and Remove.
handover.length && find(tree, (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? ''))[0].p.onClick(); await tick();
assert.deepEqual(posts.at(-1), { sessionId: 's-assistant', id: 'aaaaaaaa', action: 'handover', prefix: 'todos.handoverMessage' });
tree = panel(); assert.equal(find(tree, (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? '')).length, 0, 'now the assistant does it');
assert.deepEqual(groups(tree).map((b) => [b.p['data-owner'], text(b).trim().split(/\s+/).at(-1)]), [['agent', '2']], 'the handed-over item moves to the assistant\'s group; the empty group does not show');
find(tree, (n) => n.t === 'button' && /todos\.remove:.*Rapor/.test(n.p['aria-label'] ?? ''))[0].p.onClick(); await tick();
assert.deepEqual(posts.at(-1), { sessionId: 's-assistant', id: 'bbbbbbbb', action: 'remove' });
assert.doesNotMatch(text(panel()), /Rapor yaz/);

// One action per chat at a time; aria-disabled (not disabled) while it runs.
const store = panelProps.store;
let open; gate = new Promise((r) => { open = r; });
const first = store.act('s-assistant', 'aaaaaaaa', 'remove');
assert.equal(await store.act('s-assistant', 'aaaaaaaa', 'remove'), false, 'a second action waits');
tree = panel();
assert.ok(find(tree, (n) => n.t === 'button' && n.p['aria-disabled'] === true).length > 0); assert.equal(find(tree, (n) => n.t === 'button' && n.p.disabled === true).length, 0);
open(); gate = null; assert.equal(await first, true); assert.deepEqual(store.of('s-assistant').items, []);
// A read that started before or during an action does not overwrite its answer.
items = [{ id: 'eeeeeeee', text: 'e', owner: 'user', created: 5 }]; await store.load('s-assistant');
let hold; gate = new Promise((r) => { hold = r; });
const running = store.act('s-assistant', 'eeeeeeee', 'remove');
let late; const realFetch = globalThis.fetch; const snapshot = items;
globalThis.fetch = async (url, init) => { if (init === undefined) { await new Promise((r) => { late = r; }); return Response.json({ on: true, items: snapshot, tasks, projects, at: NOW }); } return realFetch(url, init); };
const during = store.load('s-assistant'); await tick();
globalThis.fetch = realFetch; hold(); gate = null; await running; late(); await during; await tick();
assert.deepEqual(store.of('s-assistant').items, [], 'a read from before the action ended does not bring the item back');
// A failed action keeps the reason.
items = [{ id: 'dddddddd', text: 'x', owner: 'user', created: 4 }]; await store.load('s-assistant');
failNext = 'the chat is gone';
assert.equal(await store.act('s-assistant', 'dddddddd', 'handover', 'Bunu sen yap:'), false);
assert.match(text(find(panel(), (n) => n.p?.role === 'alert')[0]), /todos\.failed:.*the chat is gone/);
// schedule: a burst of calls is one read.
const reads = gets.length;
for (let i = 0; i < 5; i++) store.schedule('s-assistant');
await new Promise((r) => setTimeout(r, 3200)); await tick();
assert.equal(gets.length - reads, 1, 'a burst is merged into one read');
// Refresh reads the status and the git details again.
const r0 = gets.length; tree = panel(); find(tree, (n) => n.t === 'button' && n.p['aria-label'] === 'status.refresh')[0].p.onClick(); await tick();
assert.equal(gets.length - r0, 1); assert.equal(store.detailsOf('s-assistant', 'w-web'), undefined, 'git details are read again on the next open');
assert.match(gets.at(-1), /refresh=1/, 'F-08: Refresh asks the Host to read again');
// Collapse: the chat gives its room back.
tree = panel(); find(tree, (n) => n.t === 'button' && n.p['aria-expanded'] === true && n.p.className === 'cp-td-head')[0].p.onClick();
tree = panel(); assert.equal(attrs.get('data-composer-plus-status-seat'), 'closed'); assert.equal(find(tree, (n) => n.p?.className === 'cp-st-body').length, 0);

// Typing: dsh draws the dock seat again at each key; the seat draws nothing and the panel is not drawn.
const r1 = renders; for (let i = 0; i < 20; i++) seatOut('s-assistant');
assert.equal(renders, r1, 'the panel is not drawn while you type');
assert.equal(seatOut('s-assistant').t, 'span'); assert.equal(seatOut('s-assistant').p.hidden, true);

// Switched off: the seat and the overlay entries go.
const settings = [...live.values()].find(([o]) => o.name === 'settings.section')[0];
await settings.inject().setFeature('assistantTodos', false); await tick();
assert.equal(entry('conversation.input.dock', 'assistant-todos'), undefined); assert.equal(entry('shell.overlay', 'assistant-status'), undefined);
await settings.inject().setFeature('assistantTodos', true); await tick();
assert.ok(entry('shell.overlay', 'assistant-status'), 'on again');
store.stop(); for (const off of cleanups) off();
console.log('assistant-todos-client: ok');
