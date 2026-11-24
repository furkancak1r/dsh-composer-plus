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
const posts = []; const gets = []; let gate = null; let failNext = null; let dismissFail = false;
// Refresh's summary request: the Host's open request time (`asked`), a refused request, a read that fails.
let askedAt = null; let askFail = null; let missed = false; let readFail = null; let askGate = null;
let outage; // the Host's `outage` (Resume after an AIProxy outage): {at, chats: [{id, title}]}
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
      // × of a task card (the Host's dismiss list): `dismissFail` answers as an older Host or a failed write.
      if (body.action === 'dismiss') return dismissFail ? Response.json({ error: 'bad request' }, { status: 400 }) : Response.json({ ok: true });
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
    return Response.json(q.get('sessionId') === null ? { on: switchOn } : { on: switchOn, items: switchOn ? items : [], tasks, projects, summary, outage, at: NOW,
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
// A small hook runtime per component: state and refs by call order; layout effects run at each render (their cleanups
// are kept: React runs them on unmount); effects are kept.
const layoutCleanups = [];
const runtime = () => {
  let hooks = []; let hi = 0; let effects = [];
  const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
    useState: (v) => { const i = hi++; if (!(i in hooks)) hooks[i] = typeof v === 'function' ? v() : v; return [hooks[i], (x) => { hooks[i] = typeof x === 'function' ? x(hooks[i]) : x; }]; },
    useRef: (v) => { const i = hi++; return hooks[i] ??= { current: v }; },
    useEffect: (f) => { effects.push(f); }, useLayoutEffect: (f) => { const off = f(); if (typeof off === 'function') layoutCleanups.push(off); }, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f };
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
// Where "Preparing the summary…" and its spinner show (not the screen reader line).
const waitMarks = (tr) => find(tr, (n) => n.p?.className === 'cp-st-spin' || (n.p?.className !== 'cp-st-sr' && (n.c ?? []).flat(Infinity).includes('status.summaryWaiting'))).map((n) => n.p.className);
tree = panel();
const root = find(tree, (n) => n.p?.['data-composer-plus-todos'] === '')[0];
assert.ok(root, 'the panel shows'); assert.equal(root.t, 'section');
// Damon card stack (2026-11-19): above the chat (`top`), the first flex item of dsh's chat body, as wide as the chat column.
const style = find(root, (n) => n.t === 'style')[0]; assert.match(style.c[0], /\{order:-1;flex:none;[^}]*width:var\(--dsh-chat-content-width,720px\)[^}]*max-height:40vh/, 'above the chat, at most 40% high');
assert.doesNotMatch(style.c[0], /\[data-composer-plus-todos\]\{[^}]*position:absolute/, 'only the side place is absolute');
assert.doesNotMatch(style.c[0], /:has\(> \[data-composer-plus-todos\]\)/, 'no :has() rule on the chat body');
// The place (Furkan, 2026-11-20): at the right of the chat by default (the old Durum panel's place), above the chat with
// the place button; the choice is kept in this browser. Flat inside: no card, tile or summary has its own background.
assert.match(style.c[0], /@media \(min-width:1000px\)\{\[data-composer-plus-todos\]\[data-place="side"\]\{position:absolute;top:12px;right:20px;[^}]*width:300px[^}]*\}\[data-composer-plus-status-seat="open"\] \[data-conversation-scroll\]\{padding-right:332px\}/, 'side: at the right, the chat moves left');
for (const cls of ['cp-cs-card', 'cp-st-summary']) assert.doesNotMatch(style.c[0], new RegExp(`\\.${cls}\\{[^}]*background:(?!none)`), `${cls}: no background (no box in a box)`);
// One list (Furkan, 2026-11-23): the left line only on the active item; no rules of the old Kartlar/Kuyruk/Brifing views.
assert.match(style.c[0], /\.cp-cs-card\{[^}]*border-left:2px solid transparent[^}]*\}[^{]*\.cp-cs-card\[data-active\]\{border-left-color:var\(--cp-co\)\}/, 'the left line only on the active item');
assert.doesNotMatch(style.c[0], /cp-cs-views|cp-q-|cp-b-|data-view|\.cp-st-ask\{/, 'no old view rules, no pill button');
{
  const placeBtn = (tr) => find(tr, (n) => n.t === 'button' && n.p['data-place-button'] !== undefined)[0];
  const rootOf = (tr) => find(tr, (n) => n.p?.['data-composer-plus-todos'] === '')[0];
  assert.equal(mem.get('dsh-composer-plus.status-place'), undefined, 'nothing saved yet');
  assert.equal(rootOf(tree).p['data-place'], 'side', 'the right side by default');
  assert.equal(attrs.get('data-composer-plus-status-seat'), 'open', 'the open side panel moves the chat left');
  let b = placeBtn(tree);
  assert.equal(b.p.type, 'button'); assert.equal(b.p['aria-label'], 'status.placeTop', 'its name says where it moves the panel'); assert.equal(b.p.title, 'status.placeTop');
  b.p.onClick(); let tr = panel();
  assert.equal(rootOf(tr).p['data-place'], 'top', 'above the chat after a click');
  assert.equal(mem.get('dsh-composer-plus.status-place'), 'top', 'the choice is saved');
  assert.equal(attrs.get('data-composer-plus-status-seat'), 'closed', 'above the chat: the chat keeps its width');
  b = placeBtn(tr); assert.equal(b.p['aria-label'], 'status.placeSide');
  // A new page (a reload) reads the saved place.
  rt.clear(); tr = panel(); assert.equal(rootOf(tr).p['data-place'], 'top', 'a reload keeps the place');
  placeBtn(tr).p.onClick(); tr = panel();
  assert.equal(rootOf(tr).p['data-place'], 'side'); assert.equal(mem.get('dsh-composer-plus.status-place'), 'side');
  rt.clear(); tr = panel(); assert.equal(rootOf(tr).p['data-place'], 'side', 'a reload keeps the right side');
  // Folded at the right, the panel still shows its header (and an Onay card): the chat keeps its room (review).
  find(tr, (n) => n.t === 'button' && n.p.className === 'cp-td-head')[0].p.onClick(); tr = panel();
  assert.equal(rootOf(tr).p['data-open'], 'false', 'folded'); assert.equal(attrs.get('data-composer-plus-status-seat'), 'open', 'folded at the right: the chat stays moved left');
  find(tr, (n) => n.t === 'button' && n.p.className === 'cp-td-head')[0].p.onClick();
  // Unmount (the feature goes off, the chat closes): the cleanup of the newest draw takes the mark off dsh's chat body
  // (AGENTS.md rule 1). Only the panel's cleanups: the seat's own cleanup would take the seat away.
  layoutCleanups.length = 0; tr = panel();
  for (const off of layoutCleanups.splice(0)) off();
  assert.equal(attrs.has('data-composer-plus-status-seat'), false, 'unmounted: no mark on the chat body');
  tree = panel();
}
// Heading: h2 > button[aria-expanded]; no aria-label on a span.
const h2 = find(root, (n) => n.t === 'h2')[0]; assert.equal(find(h2, (n) => n.t === 'button' && n.p['aria-expanded'] === true).length, 1, 'h2 > button[aria-expanded]');
assert.equal(find(root, (n) => n.t === 'span' && n.p['aria-label'] !== undefined).length, 0, 'no aria-label on a span');
assert.match(text(h2), /status\.title/); assert.match(text(h2), /status\.updated/, 'the last update time');
// The count bar: only the groups that have cards ("1 sorun · 2 senden · …").
assert.equal(text(find(h2, (n) => n.p?.['data-composer-plus-counts'] === '')[0]), 'cards.count.suruyor:{"count":1} · cards.queued:{"count":1} · cards.count.bitti:{"count":1}', 'the count bar: what runs, then Damon\'s queue');
const refresh = find(root, (n) => n.t === 'button' && n.p['aria-label'] === 'status.refresh')[0]; assert.ok(refresh, 'Refresh button with an aria-label');
// No summary by default: the Host has one (the assistant wrote it without a request), but the panel shows no card and
// no summary line in a project row. Get summary is a text button next to Refresh.
assert.equal(find(root, (n) => n.p?.className === 'cp-st-summary').length, 0, 'no summary card by default');
assert.doesNotMatch(text(root), /Login page done/, 'no summary text anywhere by default');
const summarize = find(root, (n) => n.t === 'button' && /-summarize$/.test(n.p.id ?? ''))[0];
assert.ok(summarize, 'Get summary button'); assert.equal(summarize.p['aria-label'], 'status.summarize', 'an icon button: its name'); assert.equal(summarize.p.title, 'status.summarize', 'and its tooltip');
assert.equal(summarize.p['aria-disabled'], false); assert.equal(text(summarize).trim(), '', 'no text label (an icon)');
// To-do items (Damon's item is behind the Sürüyor filter's "Damon'ın sırası" chip: see below).
assert.match(text(root), /Prosolocal'i internete açmak/);
const handover = find(root, (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? ''));
assert.equal(handover.length, 1, 'Hand over only for an item of the user');
// Your own note (an item of yours without a mark) is in the folded "Your notes" group at the bottom; Damon's item is a
// Sürüyor card.
const notesHead = find(root, (n) => n.t === 'button' && n.p['data-group'] === 'notes')[0];
assert.equal(notesHead.p["aria-expanded"], false, "your notes: folded"); assert.match(text(notesHead), /cards\.notes\s+1\s*$/, JSON.stringify(text(notesHead)));
assert.equal(find(root, (n) => n.t === 'ul' && n.p.id === notesHead.p['aria-controls'])[0].p.hidden, true);
const cardKeys = (tr, g) => find(tr, (n) => n.t === 'li' && n.p.className === 'cp-cs-card' && n.p['data-card'] === g).map((n) => n.p['data-key']);
// The Sürüyor filter's chips (one kind shows at a time; the choice stays in this browser).
const pickFilter = (f) => find(panel(), (n) => n.t === 'button' && n.p['data-filter'] === f)[0].p.onClick();
assert.deepEqual(cardKeys(root, 'suruyor'), ['c-run'], 'Sürüyor, Çalışıyor (the default): the running task');
pickFilter('todo'); assert.deepEqual(cardKeys(panel(), 'suruyor'), ['bbbbbbbb'], 'Damon\'ın sırası: Damon\'s item');
pickFilter('running');
assert.deepEqual(cardKeys(root, 'bitti'), ['c-done'], 'Bugün bitti: the ended task');
// Tasks: state, time, result; a click opens its chat.
const taskCard = (tr, key) => find(tr, (n) => n.t === 'li' && n.p['data-key'] === key)[0];
assert.match(text(taskCard(root, 'c-run')), /cards\.suruyor: .*Research Rome/, 'the group names the state (short lines: only the time)'); assert.doesNotMatch(text(taskCard(root, 'c-run')), /status\.task\.running/); assert.match(text(taskCard(root, 'c-done')), /Flights found: 3 options/);
assert.match(text(taskCard(root, 'c-run')), /dk|min/, 'the time it runs');
find(taskCard(root, 'c-run'), (n) => n.t === 'button' && n.p.className === 'cp-cs-title')[0].p.onClick(); assert.deepEqual(opened, ['c-run'], 'the title opens the task\'s chat');
// Projects (a button in the count bar): closed rows with one line (the summary's sentence, else the chat count).
const projectsBtn = () => find(panel(), (n) => n.t === 'button' && /-projects$/.test(n.p.id ?? ''))[0];
assert.equal(projectsBtn().p['aria-expanded'], false, 'the projects are behind their button'); assert.equal(find(root, (n) => n.p?.className === 'cp-st-row').length, 0);
projectsBtn().p.onClick(); tree = panel();
let rows = find(tree, (n) => n.t === 'button' && n.p.className === 'cp-st-row' && n.p['aria-expanded'] !== undefined);
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
// Get summary: one click asks the assistant (a POST), opens the card with "Preparing the summary…" (only there: the button
// is aria-disabled and keeps its label). The new summary replaces the placeholder; a project name in it opens and focuses the project row.
{
  mem.clear(); summary = { at: NOW - 60000, projects: [{ project: 'acme-web', text: 'Old summary.' }] }; await panelProps.store.load('s-assistant');
  const p0 = posts.length;
  find(panel(), (n) => n.t === 'button' && /-summarize$/.test(n.p.id ?? ''))[0].p.onClick();
  tree = panel();
  let c = find(tree, (n) => n.p?.className === 'cp-st-summary')[0];
  assert.ok(c, 'the card opens at once'); assert.match(text(c), /status\.summaryWaiting/);
  assert.equal(find(tree, (n) => /-summarize$/.test(n.p?.id ?? ''))[0].p['aria-disabled'], true);
  // One place says it: the card. The button keeps its label and has no second spinner.
  assert.deepEqual(waitMarks(tree), ['cp-st-wait', 'cp-st-spin'], 'one "Preparing the summary…" with one spinner, in the card');
  assert.equal(find(tree, (n) => /-summarize$/.test(n.p?.id ?? ''))[0].p['aria-label'], 'status.summarize');
  await tick();
  // The panel folded while the card waits: the button says it (the card does not show); unfolded, the card again.
  const head = () => find(panel(), (n) => n.t === 'button' && n.p.className === 'cp-td-head')[0];
  head().p.onClick(); assert.deepEqual(waitMarks(panel()), ['cp-st-spin'], 'folded: one spinner, in the button');
  assert.equal(find(panel(), (n) => /-summarize$/.test(n.p?.id ?? ''))[0].p['aria-label'], 'status.summaryWaiting', 'folded: the button\'s name says it');
  head().p.onClick(); assert.deepEqual(waitMarks(panel()), ['cp-st-wait', 'cp-st-spin'], 'unfolded: the card again');
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

// Card groups (2026-11-19): the marks and the owners put each item in its card group; your own notes are one folded
// group at the bottom whose header folds it; each card has its type for a screen reader; no owner line.
const cardsOf = (tr, g) => find(tr, (n) => n.t === 'li' && n.p.className === 'cp-cs-card' && n.p['data-card'] === g);
const groupBtn = (tr, g) => find(tr, (n) => n.t === 'button' && n.p['data-group'] === g)[0];
{
  const saved = items;
  items = [{ id: '11111111', text: 'U1', owner: 'user', created: 1 }, { id: '22222222', text: 'A1', owner: 'agent', created: 2 }, { id: '33333333', text: 'Senden: SAP alanını aç', owner: 'user', created: 3 },
    { id: '44444444', text: 'Sorun: Gece denetimi hata verdi', owner: 'agent', created: NOW - 60000 }, { id: '55555555', text: 'U2', owner: 'user', created: 5 }];
  await panelProps.store.load('s-assistant'); rt.clear();
  let tr = panel();
  assert.deepEqual(cardsOf(tr, 'sorun').map((n) => n.p['data-key']), ['44444444'], 'Sorun: the "Sorun:" item');
  assert.match(text(cardsOf(tr, 'sorun')[0]), /cards\.sorun: .*Gece denetimi hata verdi/, 'the card type for a screen reader, the title without the mark');
  assert.ok(find(cardsOf(tr, 'sorun')[0], (n) => n.t === 'span' && n.p['aria-hidden'] === true && text(n) === '▲').length === 1, 'the symbol is hidden from a screen reader');
  assert.deepEqual(cardsOf(tr, 'senden').map((n) => n.p['data-key']), ['33333333'], 'Senden: the "Senden:" item');
  pickFilter('todo'); assert.ok(cardsOf(panel(), 'suruyor').some((n) => n.p['data-key'] === '22222222'), 'Damon\'s item: Sürüyor (Damon\'ın sırası)'); pickFilter('running');
  // The order of the groups: Sorun, Senden, Sürüyor, Bugün bitti, your notes.
  const order = find(tr, (n) => n.t === 'section' && n.p['data-group'] !== undefined).map((n) => n.p['data-group']);
  assert.deepEqual(order, ['sorun', 'senden', 'suruyor', 'bitti', 'notes']);
  let g = groupBtn(tr, 'notes'); assert.equal(g.p['aria-expanded'], false); assert.match(text(g), /cards\.notes\s+2\s*$/);
  const notesList = () => find(panel(), (n) => n.t === 'ul' && n.p.id === groupBtn(panel(), 'notes').p['aria-controls'])[0];
  assert.deepEqual(find(notesList(), (n) => n.t === 'li').map((n) => text(n.c[0])), ['U1', 'U2'], 'your notes in their order');
  g.p.onClick(); assert.equal(notesList().p.hidden, false, 'a click opens your notes'); assert.equal(groupBtn(panel(), 'notes').p['aria-expanded'], true);
  assert.doesNotMatch(text(panel()), /todos\.owner/, 'no owner line');
  assert.equal(find(notesList(), (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? '')).length, 2, '→ gives a note to Damon');
  assert.equal(find(notesList(), (n) => n.t === 'button' && /todos\.remove:/.test(n.p['aria-label'] ?? '')).length, 2, '× on each note');
  groupBtn(panel(), 'notes').p.onClick(); assert.equal(notesList().p.hidden, true, 'a second click folds it');
  // Sorun: "Damon'a sor" writes the card's data into the composer (nothing sent).
  const before = posts.length; composer.draft = '';
  const ask = find(cardsOf(panel(), 'sorun')[0], (n) => n.t === 'button' && n.p['data-act'] === 'main')[0];
  assert.equal(ask.p['aria-label'], 'cards.ask:{"name":"Damon"}: Gece denetimi hata verdi', '→: its name and tooltip say the step and the card'); assert.equal(ask.p.title, ask.p['aria-label']);
  ask.p.onClick();
  assert.equal(composer.draft, 'status.insert.item:{"text":"Gece denetimi hata verdi"}\nstatus.insert.owner:{"owner":"Damon"}', 'the card\'s data, no mark, no id');
  // Senden (your step, no wait): Yaptım writes "Done: <step>".
  const sendenAct = find(cardsOf(panel(), 'senden')[0], (n) => n.t === 'button' && n.p['data-act'] === 'main')[0];
  assert.equal(sendenAct.p['aria-label'], 'cards.done: SAP alanını aç'); sendenAct.p.onClick();
  assert.match(composer.draft, /\ncards\.doneMessage:\{"item":"SAP alanını aç"\}$/); assert.equal(posts.length, before, 'nothing sent'); assert.equal(composer.submits, 0);
  composer.draft = '';
  items = saved; await panelProps.store.load('s-assistant'); rt.clear(); tree = panel();
}

// Issue #6: an item of Damon that waits for you is a Senden card: "Waiting for you", how long and the reason; after 24
// hours it is overdue and goes first. Its button is Yanıtla (the card's data into the composer). The panel sends
// nothing by itself.
{
  const saved = items; const p0 = posts.length;
  items = [{ id: '11111111', text: 'U1', owner: 'user', created: 1 }, { id: '22222222', text: 'Install ANR', owner: 'agent', created: 2, waiting: { reason: 'Needs the game folder path', since: Date.now() - 3 * 3600000 } },
    { id: '33333333', text: 'Old ask', owner: 'agent', created: 3, waiting: { reason: 'Needs the license key', since: Date.now() - 25 * 3600000 } }, { id: '44444444', text: 'A free', owner: 'agent', created: 4 }];
  await panelProps.store.load('s-assistant');
  const tr = panel();
  assert.deepEqual(cardsOf(tr, 'senden').map((n) => n.p['data-key']), ['33333333', '22222222'], 'overdue first, then the longest wait');
  const [overdue, waiting] = cardsOf(tr, 'senden');
  assert.match(text(waiting), /todos\.waiting\s+·\s+3/); assert.match(text(waiting), /Needs the game folder path/);
  assert.equal(find(waiting, (n) => n.p?.['data-state'] === 'overdue').length, 0, 'not overdue before 24 hours');
  assert.equal(find(overdue, (n) => n.p?.['data-state'] === 'overdue').length, 1, 'overdue after 24 hours'); assert.match(text(overdue), /todos\.overdue/); assert.match(text(overdue), /Needs the license key/);
  assert.equal(find(waiting, (n) => n.t === 'button' && n.p['data-act'] === 'main')[0].p['aria-label'], 'cards.reply: Install ANR', 'a wait: Yanıtla');
  pickFilter('todo'); assert.ok(cardsOf(panel(), 'suruyor').some((n) => n.p['data-key'] === '44444444'), 'an item of Damon without a wait: Sürüyor (Damon\'ın sırası)'); pickFilter('running');
  assert.match(text(find(tr, (n) => n.p?.['data-composer-plus-counts'] === '')[0]), /cards\.count\.senden:\{"count":2\}/, 'the count bar counts them');
  assert.equal(posts.length, p0, 'no message and no request by itself');
  // The wait time, Overdue and the day's end change while nothing runs: the stack draws again once a minute (no read,
  // no request); its cleanup stops the timer.
  {
    const realInterval = globalThis.setInterval; const realClear = globalThis.clearInterval; const timers = []; const cleared = [];
    globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; }; globalThis.clearInterval = (id) => { cleared.push(id); };
    try {
      rt.clear(); panel(); const own = []; for (const f of rt.effects()) { const off = f(); if (typeof off === 'function') own.push(off); } await tick();
      const minute = timers.find((x) => x.ms === 60000);
      assert.ok(minute, 'a one-minute timer');
      const g = gets.length; minute.fn(); await tick(); assert.equal(gets.length, g, 'it reads nothing'); assert.equal(posts.length, p0, 'and sends nothing');
      for (const off of own) off(); assert.ok(cleared.includes(timers.indexOf(minute) + 1), 'the timer stops with the panel');
    } finally { globalThis.setInterval = realInterval; globalThis.clearInterval = realClear; }
  }
  items = saved; await panelProps.store.load('s-assistant'); rt.clear(); tree = panel();
}

// Tasks: a running task is a Sürüyor card (İzle opens its chat), a waiting one a Senden card, a failed one a Sorun card
// (× hides it), an ended one a Bugün bitti card in a folded group ("▸ Bugün bitti 2 · 1 yeni"); Gördüm hides it in this
// browser (a new end of the same task shows it again). Folding the group marks its cards seen (no "new").
{
  const saved = tasks;
  tasks = [{ id: 'c-run', title: 'Research Rome', state: 'running', started: NOW - 125000 }, { id: 'c-ask', title: 'Deploy', state: 'waiting', started: NOW - 5000 },
    { id: 'c-done', title: 'Flights', state: 'done', started: NOW - 600000, ended: NOW - 60000, result: 'Flights found' }, { id: 'c-stop', title: 'Hotels', state: 'stopped', started: NOW - 900000, ended: NOW - 300000 },
    { id: 'c-fail', title: 'Crash', state: 'failed', started: NOW - 900000, ended: NOW - 200000 }];
  mem.delete('dsh-composer-plus.status-done-seen');
  await panelProps.store.load('s-assistant'); rt.clear();
  let tr = panel(); let h = groupBtn(tr, 'bitti');
  assert.ok(h, 'a Bugün bitti header'); assert.equal(h.p['aria-expanded'], false, 'folded by default'); assert.match(text(h), /cards\.bitti\s+2\s+cards\.fresh:\{"count":2\}$/, 'its count and the new ones');
  assert.deepEqual(cardsOf(tr, 'sorun').map((n) => n.p['data-key']), ['c-fail'], 'a failed task: Sorun');
  assert.deepEqual(cardsOf(tr, 'senden').map((n) => n.p['data-key']), ['c-ask'], 'a waiting task: Senden');
  const run = cardsOf(tr, 'suruyor').find((n) => n.p['data-key'] === 'c-run');
  assert.equal(find(run, (n) => /cards\.watch/.test(text(n)) || /cards\.watch/.test(n.p?.['aria-label'] ?? '')).length, 0, 'no İzle button');
  assert.equal(run.p['data-opens'], 'true');
  const o0 = opened.length; run.p.onClick({ target: { closest: () => null } }); assert.deepEqual(opened.slice(o0), ['c-run'], 'a click on the card opens the task\'s chat');
  run.p.onClick({ target: { closest: () => ({}) } }); assert.deepEqual(opened.slice(o0), ['c-run'], 'a click on a button in the card does not open it again');
  const doneList = () => find(panel(), (n) => n.t === 'ul' && n.p.id === groupBtn(panel(), 'bitti').p['aria-controls'])[0];
  assert.equal(doneList().p.hidden, true, 'the ended tasks are folded');
  assert.deepEqual(find(doneList(), (n) => n.t === 'li' && n.p.className === 'cp-cs-card').map((n) => n.p['data-key']), ['c-done', 'c-stop'], 'newest end first');
  assert.match(text(find(doneList(), (n) => n.p?.['data-key'] === 'c-done')[0]), /cards\.new/, 'a new end has the "new" mark');
  h.p.onClick(); assert.equal(doneList().p.hidden, false, 'a click opens the group');
  h = groupBtn(panel(), 'bitti'); h.p.onClick(); assert.ok(Number(mem.get('dsh-composer-plus.status-done-seen')) >= NOW, 'folding it again marks them seen');
  h = groupBtn(panel(), 'bitti'); assert.doesNotMatch(text(h), /cards\.fresh/, 'no new ones now'); h.p.onClick();
  const seen = find(find(doneList(), (n) => n.p?.['data-key'] === 'c-done')[0], (n) => n.t === 'button' && n.p['data-act'] === 'close')[0];
  assert.equal(seen.p['aria-label'], 'cards.seen: Flights', '×: Gördüm');
  const p0 = posts.length; seen.p.onClick(); assert.equal(focused.at(-1), 'cp-td-s-assistant', 'the focus goes to the stack title');
  assert.deepEqual(find(doneList(), (n) => n.t === 'li' && n.p.className === 'cp-cs-card').map((n) => n.p['data-key']), ['c-stop'], 'Gördüm: the card is gone');
  // Furkan, 2026-11-24: the × goes to the Host's list too (every browser and Tether), and this browser keeps it.
  assert.deepEqual(posts.slice(p0), [{ sessionId: 's-assistant', action: 'dismiss', task: `c-done|${NOW - 60000}` }], 'the Host gets the key');
  assert.equal(mem.get('dsh-composer-plus.status-tasks-dismissed'), JSON.stringify([`c-done|${NOW - 60000}`]), 'kept in this browser');
  rt.clear(); assert.equal(cardsOf(panel(), 'bitti').length, 1, 'still hidden after the panel opens again');
  // The same task ends again (a new end time): it shows again, and the old key goes.
  tasks = tasks.map((t) => (t.id === 'c-done' ? { ...t, ended: NOW - 1000 } : t)); await panelProps.store.load('s-assistant');
  tr = panel(); assert.match(text(groupBtn(tr, 'bitti')), /cards\.bitti\s+2/, 'a new end shows the card again');
  // × on a failed task's Sorun card (in its Ayrıntı) hides it the same way.
  const x = find(cardsOf(tr, 'sorun')[0], (n) => n.t === 'button' && n.p['aria-label'] === 'status.dismiss:{"task":"Crash"}')[0];
  // The Host call fails (an older Host, a failed write): this browser's list still hides the card.
  dismissFail = true; const p1 = posts.length;
  assert.ok(x, 'an × with an aria-label'); x.p.onClick(); assert.equal(cardsOf(panel(), 'sorun').length, 0, 'the failed card is hidden');
  assert.deepEqual(posts.slice(p1), [{ sessionId: 's-assistant', action: 'dismiss', task: `c-fail|${NOW - 200000}` }]);
  await tick(); rt.clear(); assert.equal(cardsOf(panel(), 'sorun').length, 0, 'the Host refused it: localStorage keeps it hidden');
  assert.ok(JSON.parse(mem.get('dsh-composer-plus.status-tasks-dismissed')).includes(`c-fail|${NOW - 200000}`));
  dismissFail = false;
  // Two windows: the other one hid Hotels after this panel read the list; this Gördüm keeps that key (it reads the list again).
  mem.set('dsh-composer-plus.status-tasks-dismissed', '[]'); rt.clear(); tr = panel();
  mem.set('dsh-composer-plus.status-tasks-dismissed', JSON.stringify([`c-stop|${NOW - 300000}`]));
  find(find(tr, (n) => n.p?.['data-key'] === 'c-done')[0], (n) => n.t === 'button' && n.p['data-act'] === 'close')[0].p.onClick();
  assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.status-tasks-dismissed')).sort(), [`c-done|${NOW - 1000}`, `c-stop|${NOW - 300000}`], 'both windows\' cards stay hidden');
  // A Bitti card ends with the day: an end that is not today shows no card.
  tasks = [{ id: 'c-old', title: 'Yesterday', state: 'done', started: NOW - 30 * 3600000, ended: NOW - 27 * 3600000 }]; await panelProps.store.load('s-assistant');
  assert.equal(groupBtn(panel(), 'bitti'), undefined, 'yesterday\'s end: no Bugün bitti card');
  mem.delete('dsh-composer-plus.status-tasks-dismissed'); mem.delete('dsh-composer-plus.status-done-seen'); tasks = saved; await panelProps.store.load('s-assistant'); rt.clear(); tree = panel();
}

// The Sürüyor filter (Furkan, 2026-11-24: "sürüyor kısmında damonın yapacağı ve aktif devam eden işler birleşik
// görünüyor"; then "tümü seçeneğine gerek yok"): two chips, Çalışıyor N (the default) and Damon'ın sırası N, buttons with
// aria-pressed; this browser keeps the choice. A card runs when the Host says that its task runs now (also an item with
// the task's words: one card), never by its text; an item of Damon without a running task is Damon's to-do. The header:
// "Sürüyor 3 · sırada 6". A waiting item stays in Senden; the count bar does not change.
{
  const savedItems = items; const savedTasks = tasks; const KEY = 'dsh-composer-plus.status-running-filter';
  mem.delete(KEY);
  items = [{ id: 'a0000001', text: 'Maccy 2.8.0 belleğini birkaç gün sonra yeniden ölç', owner: 'agent', created: NOW - 9000 },
    { id: 'a0000002', text: 'Her cuma 10:00–12:00 rapor hatırlatması', owner: 'agent', created: NOW - 8000 },
    { id: 'a0000003', text: 'Akşam AIProxy boşken yeni main\'i kur', owner: 'agent', created: NOW - 7000 },
    { id: 'a0000004', text: 'Gece testi çalışıyor mu bak (running)', owner: 'agent', created: NOW - 6000 },
    { id: 'a0000005', text: 'Yedek klasörünü kontrol et', owner: 'agent', created: NOW - 5000 },
    { id: 'a0000006', text: 'Stok raporunu güncelle', owner: 'agent', created: NOW - 4000 },
    { id: 'a0000007', text: 'Satınalma sorgularını çalıştır', owner: 'agent', created: NOW - 3000 },
    { id: 'a0000008', text: 'Haftalık stok raporu', owner: 'agent', created: NOW - 2000 },
    { id: 'a0000009', text: 'ANR kur', owner: 'agent', created: NOW - 1000, waiting: { reason: 'Klasör yolu', since: NOW - 60000 } }];
  tasks = [{ id: 'c-r1', title: 'Satınalma sorgularını çalıştır', state: 'running', started: NOW - 125000 },
    { id: 'c-r2', title: 'Montaj testi dalı', state: 'running', started: NOW - 65000 },
    { id: 'c-r3', title: 'Hava durumu CLI', state: 'running', started: NOW - 5000, chat: true },
    { id: 'c-d1', title: 'Haftalık stok raporu', state: 'done', started: NOW - 600000, ended: NOW - 60000 }];
  await panelProps.store.load('s-assistant'); rt.clear();
  const chip = (tr, f) => find(tr, (n) => n.t === 'button' && n.p['data-filter'] === f)[0];
  const shown = (tr) => cardsOf(tr, 'suruyor').map((n) => n.p['data-key']);
  const symOf = (n) => text(find(n, (m) => m.p?.className === 'cp-cs-sym')[0]);
  const openRun = () => { let tr = panel(); if (groupBtn(tr, 'suruyor').p['aria-expanded'] !== true) { groupBtn(tr, 'suruyor').p.onClick(); tr = panel(); } return tr; };
  let tr = panel();
  assert.match(text(groupBtn(tr, 'suruyor')), /cards\.suruyor\s+3\s+· cards\.queued:\{"count":6\}\s*$/, 'the header: the running count · the to-do count');
  tr = openRun();
  assert.equal(chip(tr, 'running').p.type, 'button'); assert.equal(chip(tr, 'todo').p.type, 'button');
  assert.equal(chip(tr, 'running').p['aria-pressed'], true, 'Çalışıyor is the default'); assert.equal(chip(tr, 'todo').p['aria-pressed'], false);
  assert.equal(chip(tr, 'all'), undefined, 'no Tümü chip');
  assert.match(text(chip(tr, 'running')), /^status\.task\.running\s+3$/); assert.match(text(chip(tr, 'todo')), /^cards\.queue:\{"name":"Damon"\}\s+6$/);
  assert.equal(find(tr, (n) => n.p?.role === 'group' && n.p.className === 'cp-cs-chips')[0]?.p['aria-label'], 'cards.suruyor', 'the chips are one named group');
  assert.deepEqual(shown(tr), ['c-r3', 'c-r2', 'a0000007'], 'only what runs now, newest start first; the item with a running task\'s words is that one card');
  for (const n of cardsOf(tr, 'suruyor')) {
    assert.equal(n.p['data-running'], 'true'); assert.equal(symOf(n), '●', 'the running mark');
    assert.match(text(find(n, (m) => m.p?.className === 'cp-st-sub')[0]), /\d/, 'the time it runs');
  }
  assert.deepEqual(cardsOf(tr, 'senden').map((n) => n.p['data-key']), ['a0000009'], 'a waiting item of Damon stays in Senden');
  assert.deepEqual(cardsOf(tr, 'bitti').map((n) => n.p['data-key']), ['a0000008'], 'an item with a done task\'s words: Bugün bitti');
  assert.match(text(find(tr, (n) => n.p?.['data-composer-plus-counts'] === '')[0]), /cards\.count\.suruyor:\{"count":3\} · cards\.queued:\{"count":6\}/, 'the count bar: 3 running · 6 queued');
  assert.equal(find(tr, (n) => n.p?.['data-composer-plus-run-empty'] === '').length, 0, 'no empty line while cards show');
  chip(tr, 'todo').p.onClick(); tr = panel();
  assert.equal(mem.get(KEY), 'todo', 'kept in this browser');
  assert.equal(chip(tr, 'todo').p['aria-pressed'], true); assert.equal(chip(tr, 'running').p['aria-pressed'], false);
  assert.equal(groupBtn(tr, 'suruyor').p['aria-expanded'], true, 'a chip keeps its group open (6 cards do not fit)');
  assert.deepEqual(shown(tr), ['a0000006', 'a0000005', 'a0000004', 'a0000003', 'a0000002', 'a0000001'], 'only Damon\'s to-dos, newest first; "çalışıyor" in a text is no running state');
  for (const n of cardsOf(tr, 'suruyor')) { assert.equal(n.p['data-running'], 'false'); assert.equal(symOf(n), '○', 'a neutral mark'); assert.match(text(n), /cards\.withAgent/); }
  assert.match(text(groupBtn(tr, 'suruyor')), /cards\.suruyor\s+3\s+· cards\.queued:\{"count":6\}\s*$/, 'the header stays');
  rt.clear(); tr = openRun(); assert.equal(chip(tr, 'todo').p['aria-pressed'], true, 'a reload keeps the choice');
  chip(tr, 'running').p.onClick(); assert.equal(mem.get(KEY), 'running');
  mem.set(KEY, 'all'); rt.clear(); tr = openRun(); assert.equal(chip(tr, 'running').p['aria-pressed'], true, 'an unknown stored value: the default');
  // Nothing runs (0 running; the item with a task's words is a to-do now: 7 queued): the header and the count bar say so,
  // the chip shows a line instead of an empty list.
  const runningTasks = tasks; tasks = tasks.filter((x) => x.state !== 'running'); await panelProps.store.load('s-assistant'); rt.clear(); tr = openRun();
  assert.match(text(groupBtn(tr, 'suruyor')), /cards\.suruyor\s+0\s+· cards\.queued:\{"count":7\}\s*$/);
  assert.doesNotMatch(text(find(tr, (n) => n.p?.['data-composer-plus-counts'] === '')[0]), /cards\.count\.suruyor/, 'no "0 running" in the count bar');
  assert.deepEqual(shown(tr), []); assert.equal(text(find(tr, (n) => n.p?.['data-composer-plus-run-empty'] === '')[0]), 'cards.filterEmpty', 'Çalışıyor 0: a line, not an empty list');
  chip(tr, 'todo').p.onClick(); tr = panel(); assert.equal(shown(tr).length, 7); assert.equal(find(tr, (n) => n.p?.['data-composer-plus-run-empty'] === '').length, 0);
  // Only running work (3 running, 0 queued): Damon'ın sırası 0 says so too.
  tasks = runningTasks; items = items.filter((i) => i.waiting || i.id === 'a0000007' || i.id === 'a0000008'); await panelProps.store.load('s-assistant'); tr = panel();
  assert.match(text(chip(tr, 'todo')), /\s0$/); assert.deepEqual(shown(tr), []); assert.equal(text(find(tr, (n) => n.p?.['data-composer-plus-run-empty'] === '')[0]), 'cards.filterEmpty');
  assert.doesNotMatch(text(find(tr, (n) => n.p?.['data-composer-plus-counts'] === '')[0]), /cards\.queued/, 'no "0 queued" in the count bar');
  chip(tr, 'running').p.onClick(); tr = panel();
  // The running mark pulses, it is still with reduced motion; a pressed chip has its own look; the focus ring is the panel's.
  const css = find(tr, (n) => n.t === 'style')[0].c[0];
  assert.match(css, /\.cp-cs-card\[data-running="true"\] \.cp-cs-sym\{[^}]*animation:cp-cs-run/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.cp-cs-card\[data-running="true"\] \.cp-cs-sym,[^}]*\{animation:none\}/);
  assert.match(css, /\.cp-cs-chip\[aria-pressed="true"\]\{[^}]*background:/); assert.match(css, /\[data-composer-plus-todos\] button:focus-visible\{outline:/);
  mem.delete(KEY); items = savedItems; tasks = savedTasks; await panelProps.store.load('s-assistant'); rt.clear(); tree = panel();
}

// 2026-11-17 ("sağ üstte durum var ama güzel durmuyor görevlerde zaten var"): Resume after an AIProxy outage shows no
// list of chat links. A card whose task the outage continued gets a short line; the other continued chats (an
// automation, this chat) are one count line without names or links.
{
  const saved = tasks;
  tasks = [{ id: 'c-run', title: 'Research Rome', state: 'running', started: NOW - 125000 }, { id: 'c-done', title: 'Flights', state: 'done', started: NOW - 600000, ended: NOW - 60000 },
    { id: 'c-calm', title: 'Hotels', state: 'running', started: NOW - 5000 }];
  outage = { at: NOW - 1000, chats: [{ id: 'c-run', title: 'Research Rome' }, { id: 'c-done', title: 'Flights' }, { id: 's-auto', title: 'Nightly error review' }, { id: 's-assistant', title: 'Damon' }] };
  await panelProps.store.load('s-assistant'); rt.clear();
  const tr = panel();
  const marked = (v) => find(tr, (n) => n.p?.['data-composer-plus-outage'] === v);
  const cardOf = (key) => find(tr, (n) => n.t === 'li' && n.p['data-key'] === key)[0];
  assert.equal(marked('').length, 0, 'no link list above the cards');
  assert.equal(marked('row').length, 2, 'a line in each continued task\'s card');
  for (const key of ['c-run', 'c-done']) assert.match(text(cardOf(key)), /status\.outageRow:\{"time":"\d{2}[.:]\d{2}"\}/, `${key}: the outage line with its time`);
  assert.doesNotMatch(text(cardOf('c-calm')), /status\.outage/, 'a task that the outage did not continue has no line');
  const note = marked('note'); assert.equal(note.length, 1, 'one line for the other chats');
  assert.match(text(note[0]), /^status\.outageMore:\{"time":"\d{2}[.:]\d{2}","count":2\}$/, 'only a count');
  assert.doesNotMatch(text(tr), /Nightly error review/, 'no names');
  outage = { at: NOW - 1000, chats: [{ id: 'c-run', title: 'Research Rome' }] }; await panelProps.store.load('s-assistant');
  assert.equal(find(panel(), (n) => n.p?.['data-composer-plus-outage'] === 'note').length, 0, 'all in the cards: no count line');
  tasks = saved; outage = { at: NOW - 86400000 * 2, chats: [{ id: 'c-run', title: 'Research Rome' }] }; await panelProps.store.load('s-assistant');
  assert.equal(find(panel(), (n) => n.p?.['data-composer-plus-outage'] !== undefined).length, 0, 'an older day\'s outage shows nothing');
  outage = undefined; await panelProps.store.load('s-assistant'); rt.clear(); tree = panel();
}

// 2026-11-16 ("prosolocal ne durumda görevlerde görünmüyor"): a delegated chat's row. The panel watches the chat's live
// state (its turn starts, ends or waits: a new read), and while the row runs without a turn (a background job) and no
// subagent runs, it reads the Host every 5 s.
{
  const saved = tasks;
  tasks = [{ id: 's-deploy', title: 'Canlı deploy', state: 'running', started: NOW - 5000, chat: true, result: 'prosolocal' }];
  await panelProps.store.load('s-assistant');
  const asked = []; const quiet = new Map();
  const watch = (pick) => pick({ get: (k) => { asked.push(k); return quiet.get(k); } });
  const realInterval = globalThis.setInterval; const realClear = globalThis.clearInterval; const timers = [];
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; }; globalThis.clearInterval = () => {};
  try {
    rt.clear(); rt.reset();
    const out = Panels({ ...panelProps, useSessions: (pick) => pick({ projectionsBySession: {} }), useSessionStatus: watch, t });
    rt.reset(); const inner = out.c[0][0].portal; inner.t(inner.p);
    assert.ok(asked.includes('s-deploy'), 'the panel watches the delegated chat\'s live state');
    for (const f of rt.effects()) f(); await tick();
    assert.ok(timers.some((x) => x.ms === 5000), 'a running delegated chat (no turn, no subagent): read every 5 s');
  } finally { globalThis.setInterval = realInterval; globalThis.clearInterval = realClear; }
  tasks = saved; await panelProps.store.load('s-assistant'); rt.clear(); tree = panel();
}

// → writes "<Do this for me:> <item>" in the composer and sends nothing: no POST, the owner and the groups stay.
const arrow = () => find(panel(), (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? ''))[0];
const postsBefore = posts.length;
// The card tests above wrote into the composer: start these checks from a fresh composer.
Object.assign(composer, { draft: '', occurrences: [], rev: 0, inserts: [], focused: 0, submits: 0 });
arrow().p.onClick(); await tick();
assert.equal(posts.length, postsBefore, '→ sends nothing to the Host');
assert.equal(composer.draft, 'todos.handoverMessage Prosolocal\'i internete açmak', 'the text is in the empty composer');
assert.deepEqual(composer.inserts.at(-1).span, { start: 0, end: 0, draftRev: 0 }, 'at the end of the draft');
assert.equal(composer.focused, 1, 'the focus goes to the composer (caret after the text)');
assert.equal(composer.submits, 0, 'not sent');
tree = panel(); assert.equal(arrow() !== undefined, true, 'the item stays the user\'s');
assert.deepEqual(find(tree, (n) => n.t === 'section' && n.p['data-group'] !== undefined).map((n) => n.p['data-group']), ['suruyor', 'bitti', 'notes'], 'no group change');
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
// "Mesaj kutusuna yaz" on every card (Damon's item, each task, in its Ayrıntı for a task) and on each project row (the
// Projects button opens them): the data (the format: test/status-insert.test.mjs), appended after the draft, focus in
// the composer, nothing sent, no id.
{
  if (projectsBtn().p['aria-expanded'] !== true) projectsBtn().p.onClick();
  // A project row and a Sürüyor card: → ("status.insert…" in its name); a Bugün bitti card: "Mesaj kutusuna yaz" in its "…" menu.
  const writes = () => find(panel(), (n) => n.t === 'button' && /^status\.insert(Short)?:/.test(n.p['aria-label'] ?? ''));
  const names = writes().map((b) => b.p['aria-label']); pickFilter('todo'); names.push(...writes().map((b) => b.p['aria-label']).filter((n) => !names.includes(n)));
  assert.deepEqual(names, ['status.insert:{"item":"acme-web"}', 'status.insert:{"item":"weather-cli"}', 'status.insertShort: Research Rome', 'status.insertShort: Rapor yaz'],
    'on each project, each running task (Çalışıyor) and Damon\'s item (Damon\'ın sırası)');
  assert.ok(writes().every((b) => b.p.type === 'button'), 'a real button (keyboard)');
  const menuOf = (key) => find(panel(), (n) => n.t === 'Menu' && n.p.anchor?.p?.['data-more'] === key)[0];
  const flights = menuOf('c-done');
  assert.ok(flights, 'a Bugün bitti card has a "…" menu'); assert.equal(flights.p.anchor.p['aria-label'], 'cards.more:{"item":"Flights"}', '"…": its name names the card');
  assert.deepEqual(flights.p.items.map((i) => i.id), ['open', 'write'], 'Open chat, Write in the message box');
  const by = (name) => (name === 'Flights' ? { p: { onClick: () => menuOf('c-done').p.onSelect('write') } }
    : writes().find((b) => b.p['aria-label'] === `status.insert:{"item":"${name}"}` || b.p['aria-label'] === `status.insertShort: ${name}`));
  const before = posts.length; composer.draft = 'Note'; const focus0 = composer.focused;
  by('Rapor yaz').p.onClick(); pickFilter('running');
  assert.equal(composer.draft, 'Note\nstatus.insert.item:{"text":"Rapor yaz"}\nstatus.insert.owner:{"owner":"Damon"}', 'the item\'s data after the draft');
  by('Research Rome').p.onClick();
  assert.match(composer.draft, /\nstatus\.insert\.task:\{"title":"Research Rome"\}\nstatus\.insert\.state:\{"state":"status\.task\.running · \d+ (dk|min)\.?"\}$/, 'the task, its state and time');
  by('Flights').p.onClick();
  assert.match(composer.draft, /\nstatus\.insert\.task:\{"title":"Flights"\}\nstatus\.insert\.state:\{"state":"status\.task\.done · 9 (dk|min)\.?"\}\nstatus\.insert\.result:\{"result":"Flights found: 3 options"\}$/, 'an ended task: its time to the end and its result');
  by('acme-web').p.onClick();
  assert.match(composer.draft, /\nstatus\.insert\.project:\{"title":"acme-web"\}\nstatus\.projectChats:\{"count":2\}$/, 'the project and its line');
  assert.equal(composer.focused, focus0 + 4); assert.equal(composer.submits, 0); assert.equal(posts.length, before, 'nothing sent');
  assert.doesNotMatch(composer.draft, /bbbbbbbb|c-run|w-web|s-assistant/, 'no id in the text');
  // A project row keeps its row button (a click opens the row) and puts → next to it.
  const rowOf = (name) => find(panel(), (n) => n.t === 'li' && find(n, (m) => m.p?.['aria-label'] === `status.insert:{"item":"${name}"}`).length === 1)[0];
  const projectLine = rowOf('acme-web').c.flat().filter(Boolean)[0];
  assert.equal(projectLine.p.className, 'cp-st-line'); assert.deepEqual(projectLine.c.flat().map((n) => n.p.className), ['cp-st-row', 'cp-td-btn'], 'a project: the row button, then →');
  composer.draft = '';
}
// The composer refuses (it sends now): a notice, nothing else.
composer.refuse = true; composer.draft = ''; arrow().p.onClick(); composer.refuse = false;
assert.equal(composer.draft, ''); assert.deepEqual(notices.at(-1), ['s-assistant', 'info', 'quote.changed'], 'the user sees why');
// The end comes from the published draft: when the editor is a revision ahead of it, dsh refuses the insert (no wrong place).
composer.stale = true; const n0 = notices.length; arrow().p.onClick(); composer.stale = false;
assert.equal(composer.draft, ''); assert.equal(notices.length, n0 + 1, 'an older draft: refused, with the notice');
assert.equal(posts.length, postsBefore, 'still nothing sent');
// Remove.
pickFilter('todo'); tree = panel();
find(tree, (n) => n.t === 'button' && /todos\.remove:.*Rapor/.test(n.p['aria-label'] ?? ''))[0].p.onClick(); await tick(); pickFilter('running');
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
  const askBtn = () => find(panel(), (n) => n.t === 'button' && /-summarize$/.test(n.p.id ?? ''))[0];
  const cardOf = (tr) => find(tr, (n) => n.p?.className === 'cp-st-summary')[0];
  const spoken = (tr) => text(find(tr, (n) => n.p?.role === 'status' && n.p['aria-live'] === 'polite' && n.p['data-composer-plus-active'] === undefined)[0]);
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
  assert.match(text(bodyNode), /Prosolocal|Research Rome|Fresh item/, 'the old content stays (dimmed), so the panel does not jump');
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
  // The card closed while it waits: Get summary says it instead (one place, one spinner).
  assert.equal(store.of('s-assistant').ask.state, 'waiting');
  assert.deepEqual(waitMarks(panel()), ['cp-st-spin'], 'card closed: one spinner, in the button');
  assert.equal(askBtn().p['aria-label'], 'status.summaryWaiting', 'card closed: the button\'s name says it');
  // Reduced motion: no turning and no pulse, only the text. Both themes: dsh's color tokens only.
  const css = find(panel(), (n) => n.t === 'style')[0].c[0];
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[^}]*cp-td-btn\[data-refreshing="true"\] > \*,[^}]*cp-st-skel\{animation:none\}/);
  assert.match(css, /prefers-reduced-motion:reduce[^@]*\.cp-st-spin\{display:none\}/);
  assert.match(css, /\.cp-st-time\[data-refreshing="true"\]\{[^}]*color:var\(--dsw-alias-state-business-primary\)/);
  summary = { at: NOW, projects: [{ project: 'acme-web', text: 'Login page done.' }] }; items = []; await store.load('s-assistant');
}
// Collapse: the chat gives its room back.
tree = panel(); find(tree, (n) => n.t === 'button' && n.p['aria-expanded'] === true && n.p.className === 'cp-td-head')[0].p.onClick();
tree = panel(); assert.equal(find(tree, (n) => n.p?.className === 'cp-st-body').length, 0, 'a closed stack: only the count bar');
assert.equal(find(tree, (n) => n.p?.['data-open'] === 'false').length, 1);

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
