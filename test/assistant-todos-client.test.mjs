// Assistant status panel with the to-do list (client half, real client.js with fake dsh slots and a fake fetch).
// - A seat in dsh's input dock (only in the assistant chat) gives the chat body; the panel is a shell.overlay entry
//   (typing in the composer does not draw it again) portaled into that chat body, at the right side of the chat, not in
//   dsh's right sidebar.
// - To-do items have real buttons with an aria-label: → (only for an item of the user) writes "<Do this for me:> <item>"
//   in the UI language at the end of the composer (a draft that is there stays, the text goes on its own line), focuses
//   the composer and sends nothing (no POST, the owner stays); Remove removes at once. Keyboard: aria-disabled (not
//   disabled) while an action runs.
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
// Refresh's summary request: the Host's open request time (`asked`), a refused request, a read that fails.
let askedAt = null; let askFail = null; let missed = false; let readFail = null; let askGate = null;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === '/api/composer-plus.assistant-status') return Response.json({ sessionId: 's-assistant' });
  if (u.startsWith('/api/composer-plus.assistant-todos')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body); posts.push(body);
      if ('on' in body) { switchOn = body.on; return Response.json({ on: switchOn }); }
      if (body.action === 'summary') {
        if (askGate) await askGate;
        if (askFail) return Response.json({ error: askFail }, { status: 502 });
        askedAt ??= Date.now(); return Response.json({ asked: askedAt });
      }
      if (gate) await gate;
      if (failNext) { const error = failNext; failNext = null; return Response.json({ error, on: true, items }, { status: 502 }); }
      if (body.action === 'remove') items = items.filter((i) => i.id !== body.id);
      else items = items.map((i) => (i.id === body.id ? { ...i, owner: 'agent' } : i));
      return Response.json({ on: true, items });
    }
    gets.push(u);
    const q = new URL(u, 'http://x').searchParams;
    if (q.get('project') !== null) return Response.json({ project: q.get('project'), branch: 'feature/x', commits: [{ hash: 'abc1234', at: NOW - 3600000, subject: 'Fix login' }] });
    if (readFail) return Response.json({ error: readFail }, { status: 500 });
    return Response.json(q.get('sessionId') === null ? { on: switchOn } : { on: switchOn, items: switchOn ? items : [], tasks, projects, summary, at: NOW,
      ...(askedAt === null ? {} : { asked: askedAt, ...(missed ? { missed: true } : {}) }) });
  }
  return new Response('{}', { status: 404 });
};

// The assistant chat's composer (dsh's input shell): insertText at a span of the current revision, as dsh does.
const composer = { draft: '', occurrences: [], rev: 0, inserts: [], focused: 0, submits: 0, refuse: false, stale: false };
const shell = {
  get snapshot() { return { draft: composer.draft, occurrences: composer.occurrences, draftRev: composer.stale ? composer.rev - 1 : composer.rev, phase: 'plain' }; },
  actions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: composer.rev }),
    insertText: (text, span) => {
      composer.inserts.push({ text, span });
      if (composer.refuse || span.draftRev !== composer.rev) return false;
      composer.draft = composer.draft + text; composer.rev += 1; return true;
    },
    submit: () => { composer.submits += 1; },
  },
  get projection() { return composer.detect === undefined ? undefined : { detectText: composer.detect }; },
  focus: () => { composer.focused += 1; },
  notify: (level, text) => notices.push(['s-assistant', level, text]),
};
const notices = [];
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
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, sessions: { scope: (id) => (id === 's-assistant' ? { id } : undefined) },
  get: (n) => (n === 'uiWorkspace' ? { openSession: (id) => opened.push(id) } : n === 'conversation' ? { input: { for: () => shell } } : undefined),
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
// No summary by default: the Host has one (the assistant wrote it without a request), but the panel shows no card and
// no summary line in a project row. Get summary is a text button next to Refresh.
assert.equal(find(root, (n) => n.p?.className === 'cp-st-summary').length, 0, 'no summary card by default');
assert.doesNotMatch(text(root), /Login page done/, 'no summary text anywhere by default');
const summarize = find(root, (n) => n.t === 'button' && n.p.className === 'cp-st-ask')[0];
assert.ok(summarize, 'Get summary button'); assert.match(text(summarize), /status\.summarize/); assert.equal(summarize.p['aria-disabled'], false);
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
assert.match(text(rows[0]), /status\.projectChats:\{"count":2\}/); assert.match(text(rows[1]), /status\.projectChats:\{"count":1\}/);
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
// Get summary: one click asks the assistant (a POST), opens the card with "Preparing the summary…" and the button says it
// too (aria-disabled). The new summary replaces the placeholder; a project name in it opens and focuses the project row.
{
  mem.clear(); summary = { at: NOW - 60000, projects: [{ project: 'acme-web', text: 'Old summary.' }] }; await panelProps.store.load('s-assistant');
  const p0 = posts.length;
  find(panel(), (n) => n.t === 'button' && n.p.className === 'cp-st-ask')[0].p.onClick();
  tree = panel();
  let c = find(tree, (n) => n.p?.className === 'cp-st-summary')[0];
  assert.ok(c, 'the card opens at once'); assert.match(text(c), /status\.summaryWaiting/);
  assert.equal(find(tree, (n) => n.p?.className === 'cp-st-ask')[0].p['aria-disabled'], true);
  assert.match(text(find(tree, (n) => n.p?.className === 'cp-st-ask')[0]), /status\.summaryWaiting/, 'the button says it too');
  await tick();
  assert.deepEqual(posts.slice(p0), [{ sessionId: 's-assistant', action: 'summary' }], 'one summary request');
  assert.equal(panelProps.store.of('s-assistant').ask.state, 'waiting');
  // A second click while it waits does nothing.
  assert.equal(await panelProps.store.askSummary('s-assistant'), false); assert.equal(posts.length - p0, 1, 'one request at a time');
  // The summary that the request asked for (not older than the request) comes: the card shows it with its time.
  const at = new Date(NOW); at.setHours(9, 56, 0, 0);
  summary = { at: Math.max(askedAt, at.getTime()), projects: [{ project: 'acme-web', text: 'Login page done.' }, { project: 'other-proj', text: 'Not in the list.' }] };
  await panelProps.store.load('s-assistant'); askedAt = null; tree = panel(); c = find(tree, (n) => n.p?.className === 'cp-st-summary')[0];
  assert.equal(panelProps.store.of('s-assistant').ask.state, 'done');
  assert.match(text(c), /Login page done\./); assert.match(text(c), /Not in the list\./); assert.doesNotMatch(text(c), /summaryWaiting|Old summary/);
  assert.match(text(find(c, (n) => n.t === 'h3')[0]).trim(), /^status\.summary · \d{2}[.:]\d{2}/, 'a neutral title with the time');
  const link = find(c, (n) => n.t === 'button' && n.p.className === 'cp-st-link'); assert.equal(link.length, 1, 'only a listed project is a link');
  link[0].p.onClick(); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(focused.at(-1), 'cp-st-s-assistant-w-web'); assert.deepEqual(scrolled.at(-1), 'cp-st-s-assistant-w-web');
  // Close: the card goes and stays hidden, also when a new summary comes without a request (a morning automation).
  find(panel(), (n) => n.t === 'button' && n.p['aria-label'] === 'status.hideSummary')[0].p.onClick();
  assert.equal(find(panel(), (n) => n.p?.className === 'cp-st-summary').length, 0, 'closed');
  assert.equal(focused.at(-1), 'cp-td-s-assistant-summarize', 'the focus goes to Get summary');
  summary = { at: NOW + 1, projects: [{ project: 'acme-web', text: 'Unasked summary.' }] }; await panelProps.store.load('s-assistant');
  tree = panel(); assert.equal(find(tree, (n) => n.p?.className === 'cp-st-summary').length, 0, 'an unrequested summary does not open the card');
  assert.doesNotMatch(text(tree), /Unasked summary/);
  // The next click always asks for a fresh summary (the stored one is not shown as new).
  const p1 = posts.length; await panelProps.store.askSummary('s-assistant');
  assert.equal(posts.length - p1, 1, 'a new request'); assert.equal(panelProps.store.of('s-assistant').ask.state, 'waiting', 'waits for a summary not older than the request');
  summary = { at: askedAt, projects: [{ project: 'acme-web', text: 'Fresh.' }] }; await panelProps.store.load('s-assistant'); askedAt = null;
  assert.match(text(find(panel(), (n) => n.p?.className === 'cp-st-summary')[0]), /Fresh\./);
  // A summary from another day does not show (the card says only Summary).
  summary = { at: NOW - 86400000 * 2, projects: [{ project: 'acme-web', text: 'Old.' }] }; await panelProps.store.load('s-assistant');
  assert.doesNotMatch(text(find(panel(), (n) => n.p?.className === 'cp-st-summary')[0]), /Old\./, 'only today\'s summary');
  find(panel(), (n) => n.t === 'button' && n.p['aria-label'] === 'status.hideSummary')[0].p.onClick();
  summary = { at: NOW, projects: [{ project: 'acme-web', text: 'Login page done.' }] }; await panelProps.store.load('s-assistant'); rt.clear();
}
// The morning summary: a summary that the Host marks `show` (written in a scheduled turn, or the answer to Get summary)
// opens the card without a click. After its close button the same summary stays closed (this browser keeps its time);
// the next one opens it again. The answer to a request whose card you closed while it waited does not open it.
{
  const store = panelProps.store; const cardOf = () => find(panel(), (n) => n.p?.className === 'cp-st-summary')[0];
  const close = () => find(panel(), (n) => n.t === 'button' && n.p['aria-label'] === 'status.hideSummary')[0].p.onClick();
  const p0 = posts.length;
  summary = { at: NOW - 3000, show: true, projects: [{ project: 'acme-web', text: 'Morning summary.' }] }; await store.load('s-assistant');
  assert.match(text(cardOf()), /Morning summary\./, 'the morning summary opens the card'); assert.equal(posts.length, p0, 'no request');
  close(); await store.load('s-assistant');
  assert.equal(cardOf(), undefined, 'closed: the same summary does not open it again');
  assert.equal(mem.get('dsh-composer-plus.status-summary-closed'), String(NOW - 3000), 'kept for a reload');
  summary = { at: NOW - 2000, show: true, projects: [{ project: 'acme-web', text: 'Next morning.' }] }; await store.load('s-assistant');
  assert.match(text(cardOf()), /Next morning\./, 'the next morning summary opens it again');
  close();
  await store.askSummary('s-assistant'); close();
  summary = { at: askedAt, show: true, projects: [{ project: 'acme-web', text: 'Answer.' }] }; askedAt = null; await store.load('s-assistant');
  assert.equal(store.of('s-assistant').ask.state, 'done'); assert.equal(cardOf(), undefined, 'closed while it waited: its answer opens nothing');
  // A reload on a later day: yesterday's morning summary opens no (empty) card.
  summary = { at: NOW - 86400000 * 2, show: true, projects: [{ project: 'acme-web', text: 'Two days ago.' }] }; await store.load('s-assistant');
  assert.equal(cardOf(), undefined, 'an older day\'s summary opens nothing');
  summary = { at: NOW, projects: [{ project: 'acme-web', text: 'Login page done.' }] }; await store.load('s-assistant'); rt.clear();
}

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
  assert.match(text(g[0]), /todos\.groupUser\s+2$/); assert.match(text(g[1]), /todos\.groupAgent:\{"name":"Damon"\}\s+3$/, 'the fixed name Damon');
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

// → writes "<Do this for me:> <item>" in the composer and sends nothing: no POST, the owner and the groups stay.
const arrow = () => find(panel(), (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? ''))[0];
const postsBefore = posts.length;
arrow().p.onClick(); await tick();
assert.equal(posts.length, postsBefore, '→ sends nothing to the Host');
assert.equal(composer.draft, 'todos.handoverMessage Prosolocal\'i internete açmak', 'the text is in the empty composer');
assert.deepEqual(composer.inserts.at(-1).span, { start: 0, end: 0, draftRev: 0 }, 'at the end of the draft');
assert.equal(composer.focused, 1, 'the focus goes to the composer (caret after the text)');
assert.equal(composer.submits, 0, 'not sent');
tree = panel(); assert.equal(arrow() !== undefined, true, 'the item stays the user\'s');
assert.deepEqual(groups(tree).map((b) => b.p['data-owner']), ['user', 'agent'], 'no group change');
// A draft that is there stays: the text goes on a new line after it.
composer.draft = 'Ask about the invoice';
arrow().p.onClick();
assert.equal(composer.draft, 'Ask about the invoice\ntodos.handoverMessage Prosolocal\'i internete açmak', 'appended on its own line, the draft kept');
assert.deepEqual(composer.inserts.at(-1).span, { start: 21, end: 21, draftRev: 1 });
// A chip counts as one character in dsh's span: the end is after the chip, not after its text.
composer.draft = 'see src/app.js'; composer.occurrences = [{ offset: 4, length: 10 }];
arrow().p.onClick();
assert.deepEqual(composer.inserts.at(-1).span, { start: 5, end: 5, draftRev: 2 }, 'the end in dsh\'s span offsets');
composer.occurrences = [];
// The shell's detect text is the exact end: dsh 0.2.0 keeps a claimed command as plain text (detect = draft), 0.2.1 as a
// chip (one character); the claim alone does not tell which.
composer.detect = '/goal do it'; composer.draft = '/goal do it';
arrow().p.onClick();
assert.deepEqual(composer.inserts.at(-1).span, { start: 11, end: 11, draftRev: 3 }, 'dsh 0.2.0: a claimed command is text');
composer.detect = '\uFFFC do it'; composer.draft = '/goal do it';
arrow().p.onClick();
assert.deepEqual(composer.inserts.at(-1).span, { start: 7, end: 7, draftRev: 4 }, 'dsh 0.2.1: a command chip is one character');
composer.detect = undefined;
// The composer refuses (it sends now): a notice, nothing else.
composer.refuse = true; composer.draft = ''; arrow().p.onClick(); composer.refuse = false;
assert.equal(composer.draft, ''); assert.deepEqual(notices.at(-1), ['s-assistant', 'info', 'quote.changed'], 'the user sees why');
// The end comes from the published draft: when the editor is a revision ahead of it, dsh refuses the insert (no wrong place).
composer.stale = true; const n0 = notices.length; arrow().p.onClick(); composer.stale = false;
assert.equal(composer.draft, ''); assert.equal(notices.length, n0 + 1, 'an older draft: refused, with the notice');
assert.equal(posts.length, postsBefore, 'still nothing sent');
// Remove.
tree = panel();
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
assert.equal(await store.act('s-assistant', 'dddddddd', 'remove'), false);
assert.match(text(find(panel(), (n) => n.p?.role === 'alert')[0]), /todos\.failed:.*the chat is gone/);
// schedule: a burst of calls is one read.
const reads = gets.length;
for (let i = 0; i < 5; i++) store.schedule('s-assistant');
await new Promise((r) => setTimeout(r, 3200)); await tick();
assert.equal(gets.length - reads, 1, 'a burst is merged into one read');
// Refresh: feedback at once and only the lists (no summary request, no card). Get summary: the summary from the assistant
// (a model turn) with its own wait, time limit, missed turn and errors.
{
  const refreshBtn = () => find(panel(), (n) => n.t === 'button' && n.p['aria-label'] === 'status.refresh')[0];
  const askBtn = () => find(panel(), (n) => n.t === 'button' && n.p.className === 'cp-st-ask')[0];
  const cardOf = (tr) => find(tr, (n) => n.p?.className === 'cp-st-summary')[0];
  const spoken = (tr) => text(find(tr, (n) => n.p?.role === 'status' && n.p['aria-live'] === 'polite')[0]);
  summary = { at: NOW - 60000, projects: [{ project: 'acme-web', text: 'Old summary.' }] }; await store.load('s-assistant');
  tree = panel();
  assert.match(text(find(tree, (n) => n.t === 'h2')[0]), /status\.updated/, 'the list time');
  assert.equal(find(tree, (n) => n.p?.title === 'status.updatedHint').length, 1, 'the list time has the hint');
  const r0 = gets.length; const p0 = posts.length;
  items = [{ id: 'ffffffff', text: 'Fresh item', owner: 'user', created: 9 }];
  const clicked = Date.now();
  refreshBtn().p.onClick();
  // At once (no await): the button turns and is aria-disabled, the header says Refreshing…, the old content is dimmed in
  // place, and the polite status line says it.
  tree = panel();
  assert.ok(Date.now() - clicked < 100, 'the loading state shows within 100 ms');
  const btn = find(tree, (n) => n.t === 'button' && n.p['aria-label'] === 'status.refresh')[0];
  assert.equal(btn.p['aria-disabled'], true); assert.equal(btn.p['data-refreshing'], 'true'); assert.equal(btn.p.disabled, undefined, 'aria-disabled, not disabled: the focus stays');
  assert.match(text(find(tree, (n) => n.t === 'h2')[0]), /status\.refreshing/, 'the header says Refreshing… instead of the time');
  const bodyNode = find(tree, (n) => n.p?.className === 'cp-st-body')[0];
  assert.equal(bodyNode.p['data-refreshing'], 'true'); assert.equal(bodyNode.p['aria-busy'], true);
  assert.match(text(bodyNode), /Prosolocal|status\.tasks/, 'the old content stays (dimmed), so the panel does not jump');
  assert.equal(cardOf(tree), undefined, 'Refresh opens no summary card'); assert.equal(spoken(tree), 'status.refreshing');
  // A second click while it refreshes does nothing (the store refuses it, not only the button).
  assert.equal(await store.refresh('s-assistant'), false, 'one Refresh at a time');
  refreshBtn().p.onClick();
  await tick();
  assert.equal(posts.length, p0, 'Refresh asks for no summary');
  assert.equal(gets.length - r0, 1); assert.match(gets.at(-1), /refresh=1/, 'F-08: Refresh asks the Host to read again');
  assert.equal(store.detailsOf('s-assistant', 'w-web'), undefined, 'git details are read again on the next open');
  assert.deepEqual(store.of('s-assistant').items.map((i) => i.text), ['Fresh item'], 'the lists come at once');
  await new Promise((r) => setTimeout(r, 520)); await tick();
  tree = panel(); assert.equal(store.of('s-assistant').refreshing, false, 'Refreshing… ends after the read (at least 500 ms)');
  assert.equal(find(tree, (n) => n.t === 'button' && n.p['aria-label'] === 'status.refresh')[0].p['aria-disabled'], false);
  assert.match(text(tree), /Fresh item/); assert.equal(cardOf(tree), undefined);
  // Get summary: the card waits with the placeholder; Refresh meanwhile reads only the lists and the wait goes on.
  askBtn().p.onClick(); await tick();
  assert.equal(posts.length - p0, 1, 'one summary request');
  {
    const p2 = posts.length; const g2 = gets.length; const waitingAsk = store.of('s-assistant').ask;
    assert.equal(await store.refresh('s-assistant'), true);
    assert.equal(posts.length, p2, 'Refresh asks for no second summary'); assert.equal(gets.length - g2, 1, 'the lists are read again');
    assert.equal(store.of('s-assistant').ask, waitingAsk, 'the same wait');
  }
  tree = panel(); let c = cardOf(tree);
  assert.match(text(c), /status\.summaryWaiting/); assert.equal(c.p['aria-busy'], true); assert.equal(spoken(tree), 'status.summaryWaiting');
  assert.equal(find(c, (n) => n.p?.className === 'cp-st-old')[0].p['data-old'], 'true', 'the previous summary is dimmed');
  assert.equal(find(c, (n) => n.p?.['aria-label'] === 'status.hideSummary').length, 1, 'the card can be closed while it waits');
  // The new summary comes (a read after status_summary_set): it replaces the placeholder.
  summary = { at: askedAt, projects: [{ project: 'acme-web', text: 'New summary.' }] }; askedAt = null;
  await store.load('s-assistant'); tree = panel(); c = cardOf(tree);
  assert.equal(store.of('s-assistant').ask.state, 'done'); assert.doesNotMatch(text(c), /summaryWaiting|Old summary/); assert.match(text(c), /New summary\./);
  assert.match(text(find(c, (n) => n.t === 'h3')[0]), /^\s*status\.summary · \d/, 'the summary time');
  assert.match(spoken(tree), /^status\.summary · \d/, 'the status line says that the summary is new');
  // The time limit: no new summary in 5 minutes. The previous summary shows again with a short note and Try again.
  {
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms === 5 * 60000 ? 30 : ms, ...rest);
    try { await store.askSummary('s-assistant'); } finally { globalThis.setTimeout = realTimeout; }
    await new Promise((r) => setTimeout(r, 60)); tree = panel(); c = cardOf(tree);
    assert.equal(store.of('s-assistant').ask.state, 'late');
    assert.match(text(c), /status\.summaryLate/); assert.match(text(c), /New summary\./, 'the previous summary again');
    assert.equal(find(c, (n) => n.p?.className === 'cp-st-old')[0].p['data-old'], 'false', 'not dimmed');
    const again = find(c, (n) => n.t === 'button' && n.p['aria-label'] === 'assistant.retry: status.summarize')[0];
    assert.ok(again, 'Try again'); assert.equal(spoken(tree), 'status.summaryLate');
    // A summary that comes late still replaces it.
    summary = { at: askedAt, projects: [{ project: 'acme-web', text: 'Late summary.' }] };
    await store.load('s-assistant'); assert.equal(store.of('s-assistant').ask.state, 'done'); assert.match(text(cardOf(panel())), /Late summary\./);
    askedAt = null;
    // Try again asks again, and the focus goes to Get summary.
    const p1 = posts.length; again.p.onClick(); await tick();
    assert.equal(posts.length - p1, 1); assert.equal(focused.at(-1), 'cp-td-s-assistant-summarize');
  }
  // The turn that got the request ended without a summary (`missed`): the wait ends at once, with the same note.
  missed = true; await store.load('s-assistant'); missed = false;
  assert.equal(store.of('s-assistant').ask.state, 'late', 'a turn without a summary ends the wait'); askedAt = null;
  // The Host forgets the request (its time limit, a dsh restart): a later read without `asked` ends the wait too.
  await store.askSummary('s-assistant'); askedAt = null; await store.load('s-assistant');
  assert.equal(store.of('s-assistant').ask.state, 'late', 'no open request on the Host: late');
  // Errors: a refused summary request and a failed read each say why and offer Try again. No silent failure.
  askFail = 'the assistant chat is not available';
  await store.askSummary('s-assistant'); askFail = null;
  tree = panel(); c = cardOf(tree);
  assert.match(text(c), /status\.summaryFailed:\{"error":"the assistant chat is not available"\}/);
  assert.ok(find(c, (n) => n.t === 'button' && n.p['aria-label'] === 'assistant.retry: status.summarize').length === 1, 'Try again for the summary');
  {
    const running = store.refresh('s-assistant'); tree = panel();
    assert.equal(find(cardOf(tree), (n) => n.p?.['aria-label'] === 'assistant.retry: status.summarize')[0].p['aria-disabled'], false, 'the summary\'s Try again does not wait for Refresh');
    await running;
  }
  readFail = 'disk full';
  await store.refresh('s-assistant'); readFail = null;
  tree = panel();
  const alert = find(tree, (n) => n.p?.role === 'alert')[0];
  assert.match(text(alert), /status\.readFailed:\{"error":"disk full"\}/); assert.equal(store.of('s-assistant').refreshing, false, 'the button works again');
  const retryRead = find(alert, (n) => n.t === 'button' && n.p['aria-label'] === 'assistant.retry: status.refresh')[0];
  assert.ok(retryRead, 'Try again for the read'); retryRead.p.onClick(); await new Promise((r) => setTimeout(r, 520)); await tick();
  assert.equal(find(panel(), (n) => n.p?.role === 'alert').length, 0, 'Try again read the panel again');
  assert.equal(focused.at(-1), 'cp-td-s-assistant-refresh', 'the focus goes to Refresh');
  // A remove while the read error shows: the read error goes at once (no empty "Could not refresh" while it runs).
  {
    readFail = 'disk full'; await store.load('s-assistant'); readFail = null;
    let open; gate = new Promise((r) => { open = r; });
    const acting = store.act('s-assistant', 'ffffffff', 'remove'); await tick();
    assert.equal(store.of('s-assistant').errorKind, null); assert.equal(find(panel(), (n) => n.p?.role === 'alert').length, 0, 'no stale read error');
    open(); gate = null; await acting;
  }
  // A slow summary request: a second Get summary while it is sent does nothing.
  let release; askGate = new Promise((r) => { release = r; });
  const slow = store.askSummary('s-assistant'); await tick();
  assert.equal(store.of('s-assistant').ask.state, 'asking');
  { const p3 = posts.length; assert.equal(await store.askSummary('s-assistant'), false); assert.equal(posts.length, p3, 'no second request while one is sent'); }
  release(); askGate = null; await slow; askedAt = null;
  store.hideSummary('s-assistant'); assert.equal(cardOf(panel()), undefined, 'closed');
  // Reduced motion: no turning and no pulse, only the text. Both themes: dsh's color tokens only.
  const css = find(panel(), (n) => n.t === 'style')[0].c[0];
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[^}]*cp-td-btn\[data-refreshing="true"\] > \*,[^}]*cp-st-skel\{animation:none\}/);
  assert.match(css, /prefers-reduced-motion:reduce[^@]*\.cp-st-spin\{display:none\}/);
  assert.match(css, /\.cp-st-time\[data-refreshing="true"\]\{[^}]*color:var\(--dsw-alias-state-business-primary\)/);
  summary = { at: NOW, projects: [{ project: 'acme-web', text: 'Login page done.' }] }; items = []; await store.load('s-assistant');
}
// Collapse: the chat gives its room back.
tree = panel(); find(tree, (n) => n.t === 'button' && n.p['aria-expanded'] === true && n.p.className === 'cp-td-head')[0].p.onClick();
tree = panel(); assert.equal(attrs.get('data-composer-plus-status-seat'), 'closed'); assert.equal(find(tree, (n) => n.p?.className === 'cp-st-body').length, 0);

// Typing: dsh draws the dock seat again at each key; the seat draws nothing and the panel is not drawn.
const r1 = renders; for (let i = 0; i < 20; i++) seatOut('s-assistant');
assert.equal(renders, r1, 'the panel is not drawn while you type');
assert.equal(seatOut('s-assistant').t, 'span'); assert.equal(seatOut('s-assistant').p.hidden, true);

// Switched off: the seat and the overlay entries go. An open summary request ends (on again, the card does not wait), and
// the answer to a request that was sent while it went off sets no timer and no state.
const settings = [...live.values()].find(([o]) => o.name === 'settings.section')[0];
await store.askSummary('s-assistant'); assert.equal(store.of('s-assistant').ask.state, 'waiting');
await settings.inject().setFeature('assistantTodos', false); await tick();
assert.equal(entry('conversation.input.dock', 'assistant-todos'), undefined); assert.equal(entry('shell.overlay', 'assistant-status'), undefined);
assert.equal(store.of('s-assistant').ask, null, 'off ends the open summary request'); askedAt = null;
{
  let release; askGate = new Promise((r) => { release = r; });
  const pending = store.askSummary('s-assistant'); await tick();
  store.stop(); release(); askGate = null;
  assert.equal(await pending, false, 'an answer after stop does nothing'); assert.equal(store.of('s-assistant').ask, null); askedAt = null;
}
await settings.inject().setFeature('assistantTodos', true); await tick();
assert.ok(entry('shell.overlay', 'assistant-status'), 'on again');
store.stop(); for (const off of cleanups) off();
console.log('assistant-todos-client: ok');
