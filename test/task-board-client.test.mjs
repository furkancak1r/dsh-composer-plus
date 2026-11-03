// Task board (client half, real client.js with fake dsh stores and a fake fetch): the columns come from dsh's own chat
// list, session status and projects (orange → Review, running or a running subagent → Doing, the rest → Done with the
// green dot while unread; archived, blank and subagent chats left out; a Branch per chat project counts as its
// repository; newest first; Done shows 50; Hide finished); a start shows in Todo at once, runs one at a time and puts the
// prompt back on a failure; one answer at a time from every entry point, and a request that changed or was answered
// elsewhere is not answered; the answers have dsh's own shapes (approval outcome, plan review, questions); the poll asks
// only for a newer rev and stops with the page; switching the feature off removes the page, the row and the panels.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
let timers = []; let timerId = 0;
globalThis.setTimeout = (f, ms) => { const t = { id: ++timerId, f, ms }; timers.push(t); return t.id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
globalThis.document = { visibilityState: 'visible', querySelector: () => null };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// A fake Host: the record of the board's chats, its rev, and a gate to hold an answer.
let rev = 1; const posts = []; const gets = []; let gate = null; let refuse = null;
let chats = { s1: { prompt: 'html css js ile satranç oyunu yap', tags: ['chess', 'game'], at: 1 } };
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('/api/composer-plus.board-chats')) return new Response('{}', { status: 404 });
  if (init?.method !== 'POST') {
    const q = new URLSearchParams(String(url).split('?')[1] ?? '');
    gets.push(Object.fromEntries(q));
    if (q.get('rev') === String(rev)) return Response.json({ rev, same: true });
    return Response.json({ rev, chats });
  }
  const body = JSON.parse(init.body); posts.push(body);
  if (gate) await gate.promise;
  if (refuse) { const r = refuse; refuse = null; return Response.json({ error: r.error }, { status: r.status }); }
  rev += 1; chats = { ...chats, [`new${posts.length}`]: { prompt: body.prompt, tags: [], at: 9 } };
  return Response.json({ rev, sessionId: `new${posts.length}` });
};
const hold = () => { let open; gate = { promise: new Promise((r) => { open = r; }) }; return () => { gate = null; open(); }; };

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, confirm: () => true, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: () => {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {} };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', StateDot: 'StateDot' } : {}));
const live = new Map(); let next = 0;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
const page = [...live.values()].find(([o]) => o.name === 'main');
const row = [...live.values()].find(([o]) => o.name === 'sidebar.panellist');
assert.equal(page[0].key, 'composer-plus-board'); assert.equal(row[0].id, 'composer-plus-board', 'the sidebar row opens the same panel');
const injected = page[0].inject();
const { board } = injected;
assert.equal(injected.tw('status.waitingApproval'), 'workspace:status.waitingApproval', 'dsh\'s own words for the waits');
assert.equal(injected.ta('allowOnce'), 'approval:allowOnce'); assert.equal(injected.tq('plan.approve'), 'question:plan.approve');

// The columns from dsh's stores.
const summary = (id, o = {}) => [id, { id, displayTitle: `Title ${id}`, title: `Title ${id}`, blank: false, running: false, origin: 'user', updatedAt: 100, ...o }];
const ask = (kind, extra = {}) => ({ kind, key: `${kind}:1`, answerable: true, answer: async (v) => { answers.push([kind, v]); }, ...extra });
let answers = [];
const list = { byId: Object.fromEntries([summary('s1', { updatedAt: 500 }), summary('s2', { running: true }), summary('s3'), summary('s4', { updatedAt: 300 }), summary('s5', { blank: true }),
  summary('s6'), summary('kid', { origin: 'subagent', running: true }), summary('s7', { updatedAt: 50 }), summary('s8'), summary('s9', { title: undefined, displayTitle: 'acme' })]),
projectionsBySession: { s3: { values: { subagentCatalog: [{ id: 'kid' }] } } } };
const statuses = new Map([['s1', { pendingInteraction: ask('approval', { toolName: 'bash' }) }], ['s4', { completionUnread: true }], ['kid', { running: true }],
  ['s8', { pendingInteraction: ask('question', { answerable: false }) }]]);
const workspaces = { items: [{ workspaceId: 'w1', title: 'acme', path: '/w/acme', sessionIds: ['s1', 's2', 's3', 's4', 's5', 's6', 's8', 's9'] },
  { workspaceId: 'w2', title: 'feat-x', path: '/w/acme/.worktrees/feat-x', sessionIds: ['s7'] }, { workspaceId: 'w3', title: 'blog', path: '/w/blog/', sessionIds: [] }],
archivedSessionIds: ['s6'] };
const ids = (v, s) => v.columns.find((c) => c.status === s)?.cards.map((c) => c.id);
let v = board.columns({ workspaces, list, statuses, meta: chats });
assert.deepEqual(v.columns.map((c) => c.status), ['todo', 'doing', 'review', 'done']);
assert.deepEqual(ids(v, 'review'), ['s1'], 'orange: Review');
assert.deepEqual(ids(v, 'doing'), ['s2', 's3'], 'running, or a running subagent: Doing');
assert.deepEqual(ids(v, 'done'), ['s4', 's8', 's9', 's7'], 'the rest: Done, newest first (s5 blank, s6 archived, kid a subagent left out; an answered request is not orange)');
assert.equal(v.columns[3].cards[0].state, 'unread', 'the green dot while unread'); assert.equal(v.columns[3].cards[1].state, 'read');
assert.deepEqual(v.projects.map((p) => [p.id, p.name, p.active]), [['w1', 'acme', 3], ['w3', 'blog', 0]], 'a Branch per chat folder is no project of its own');
const s1 = v.columns[2].cards[0];
assert.equal(s1.title, 'Title s1'); assert.deepEqual(s1.tags, ['chess', 'game']); assert.equal(s1.prompt, 'html css js ile satranç oyunu yap'); assert.equal(s1.ask.kind, 'approval');
assert.deepEqual(v.counts, { running: 2, waiting: 1 });
assert.deepEqual(ids(board.columns({ workspaces, list, statuses, meta: chats, project: 'w1' }), 'done'), ['s4', 's8', 's9', 's7'], 'the branch chat belongs to its repository');
assert.deepEqual(ids(board.columns({ workspaces, list, statuses, project: 'w3' }), 'done'), []);
assert.equal(board.columns({ workspaces, list: { byId: Object.fromEntries([summary('n1', { title: undefined, displayTitle: 'acme' })]) }, statuses: new Map(), meta: { n1: { prompt: 'Make a chess game\nwith tests', tags: [], at: 1 } } }).columns[3].cards[0].title,
  'Make a chess game', 'no dsh title yet: the first line of the prompt');
// The project list: "Active in the last 2 hours" (waiting, running, unread, starting or changed in 2 hours) and the search.
const T = 10 * 3600 * 1000;
const quiet = { ...list, byId: Object.fromEntries(Object.entries(list.byId).map(([id, s]) => [id, { ...s, running: false }])) };
const quietWith = (id, o) => ({ ...quiet, byId: { ...quiet.byId, [id]: { ...quiet.byId[id], ...o } } });
const recentOf = (o) => board.columns({ workspaces, list: quiet, statuses: new Map(), now: T, ...o }).projects.filter((p) => p.recent).map((p) => p.id);
assert.deepEqual(v.projects.map((p) => p.recent), [true, false], 'a waiting or running chat makes its project recent');
assert.deepEqual(recentOf({}), [], 'old, idle and read chats: not recent');
assert.deepEqual(recentOf({ list: quietWith('s2', { running: true }) }), ['w1'], 'a running chat');
assert.deepEqual(recentOf({ list: quietWith('s7', { updatedAt: T - 3600 * 1000 }) }), ['w1'], 'changed 1 hour ago (in a Branch per chat folder: its repository)');
assert.deepEqual(recentOf({ list: quietWith('s4', { updatedAt: T - 3 * 3600 * 1000 }) }), [], '3 hours ago: not recent');
assert.deepEqual(recentOf({ statuses: new Map([['s4', { completionUnread: true }]]) }), ['w1'], 'finished and not opened yet');
assert.deepEqual(recentOf({ list: quietWith('s6', { updatedAt: T }) }), [], 'an archived chat does not count');
assert.deepEqual(recentOf({ list: quietWith('s5', { updatedAt: T }) }), [], 'a blank chat does not count');
assert.deepEqual(recentOf({ starting: [{ key: 'starting-9', project: 'w3', prompt: 'x', at: 1 }] }), ['w3'], 'a task that starts now');
const named = [{ id: 'a', name: 'Çalışma', path: '/w/x', recent: false }, { id: 'b', name: 'blog', path: '/w/blog', recent: true }, { id: 'c', name: 'Docs Site', path: '/w/d', recent: false }];
const listed = () => board.shownProjects(named).map((p) => p.id);
assert.deepEqual(listed(), ['a', 'b', 'c']);
board.setQuery('CALIS'); assert.deepEqual(listed(), ['a'], 'case, accents and dotless ı ignored');
board.setQuery('site docs'); assert.deepEqual(listed(), ['c'], 'every word, in any order');
board.setQuery('w'); assert.deepEqual(listed(), [], 'the name only, not the path');
board.setQuery('');
board.toggleRecent(); assert.deepEqual(listed(), ['b'], 'only recent projects');
assert.equal(mem.get('dsh-composer-plus.board.recent'), 'true', 'the filter stays on this device');
board.setQuery('cal'); assert.deepEqual(listed(), [], 'both at once');
board.setQuery(''); board.toggleRecent(); assert.equal(board.getSnapshot().recent, false);
// Hide finished, 50 shown.
v = board.columns({ workspaces, list, statuses, hideDone: true });
assert.deepEqual(v.columns.map((c) => c.status), ['todo', 'doing', 'review'], 'Hide finished hides Done');
const many = { byId: Object.fromEntries(Array.from({ length: 60 }, (_, i) => summary(`m${i}`, { updatedAt: i }))) };
v = board.columns({ workspaces: { items: [], archivedSessionIds: [] }, list: many, statuses: new Map() });
assert.equal(v.columns[3].cards.length, 50); assert.equal(v.hiddenDone, 10); assert.equal(v.columns[3].cards[0].id, 'm59');
assert.equal(board.columns({ workspaces: { items: [] }, list: many, statuses: new Map(), doneAll: true }).columns[3].cards.length, 60);
// Starting tasks show in Todo until their chat is on the list.
v = board.columns({ workspaces, list, statuses, starting: [{ key: 'starting-1', project: 'w1', prompt: 'Add a login page', at: 1 }, { key: 'starting-2', project: 'w1', prompt: 'x', at: 2, sessionId: 's2' }] });
assert.deepEqual(ids(v, 'todo'), ['starting-1'], 'a start whose chat shows leaves Todo');

// The store: read, then only a newer rev; the poll stops with the page.
board.start(); await tick();
assert.equal(board.getSnapshot().meta.s1.tags[1], 'game');
const polls = () => timers.filter((x) => x.ms === 2000).length;
assert.equal(polls(), 1, 'one poll timer');
await board.load(); assert.equal(gets.at(-1).rev, '1', 'a poll sends its rev');
board.stop(); assert.equal(polls(), 0, 'leaving the page stops the poll');
board.setProject('w1'); assert.equal(JSON.parse(mem.get('dsh-composer-plus.board.project')), 'w1', 'the project choice stays');
board.toggleHideDone(); assert.equal(board.getSnapshot().hideDone, true); assert.equal(mem.get('dsh-composer-plus.board.hideDone'), 'true', 'Hide finished stays on this device');
board.toggleHideDone();

// New task: one start at a time; the card shows in Todo at once; a failure puts the prompt back with the reason.
assert.equal(board.newTask(undefined), false, 'no project: no panel');
board.newTask('w1'); board.editDraft({ prompt: '  ' });
assert.equal(await board.create(), false, 'an empty prompt starts nothing'); assert.equal(posts.length, 0);
board.editDraft({ prompt: 'Add a login page' });
let open = hold();
const c1 = board.create(); await tick();
assert.equal(board.getSnapshot().draft, null, 'the panel closes');
assert.deepEqual(board.getSnapshot().starting.map((s) => s.prompt), ['Add a login page'], 'the card shows in Todo at once');
assert.equal(board.newTask('w1'), false, 'no second panel while a start runs');
assert.equal(await board.create(), false, 'and no second start');
board.editDraft({ prompt: 'Second' }); assert.equal(board.getSnapshot().draft, null, 'no panel to edit while a start runs');
open(); assert.equal(await c1, true);
assert.deepEqual(posts, [{ project: 'w1', prompt: 'Add a login page' }], 'one start');
assert.equal(board.getSnapshot().starting[0].sessionId, 'new1', 'the start knows its chat');
board.newTask('w1'); board.editDraft({ prompt: 'Keep me' });
refuse = { status: 502, error: 'admission refused; the new chat was archived' };
assert.equal(await board.create(), false);
assert.equal(board.getSnapshot().draft?.prompt, 'Keep me', 'the prompt is not lost'); assert.match(board.getSnapshot().draft.error, /admission refused/);
assert.equal(board.getSnapshot().starting.length, 1, 'the failed card leaves Todo');
board.close();

// Answers: one at a time (buttons, Enter, ⌘/Ctrl+Enter all go through board.answer); a changed or settled request is not answered.
answers = [];
let gateAnswer; const slow = ask('approval', { answer: (v2) => { answers.push(['approval', v2]); return new Promise((r) => { gateAnswer = r; }); } });
board.openAnswer('s1');
const a1 = board.answer(slow, 'allowed-once', slow); await tick();
assert.equal(board.getSnapshot().busy, slow.key);
assert.equal(await board.answer(slow, 'rejected', slow), false, 'a second click while one runs');
assert.equal(await board.answer(ask('question'), { answers: [] }, undefined), false, 'any other answer while one runs');
assert.deepEqual(answers, [['approval', 'allowed-once']], 'only the first one');
gateAnswer(); assert.equal(await a1, true); assert.equal(board.getSnapshot().answering, null, 'the panel closes');
board.openAnswer('s1');
assert.equal(await board.answer(ask('approval'), 'rejected', ask('approval', { key: 'approval:2' })), false, 'the request changed meanwhile');
assert.equal(board.getSnapshot().toast, 'answered'); assert.equal(board.getSnapshot().answering, null);
assert.equal(await board.answer(ask('approval', { answerable: false }), 'rejected'), false, 'answered elsewhere');
const failing = ask('approval', { answer: async () => { throw new Error('pending approval approval:1 is already settled'); } });
board.openAnswer('s1');
assert.equal(await board.answer(failing, 'rejected', failing), false); assert.match(board.getSnapshot().toast, /already settled/); assert.equal(board.getSnapshot().busy, null);
// A question that continued without its answer: answered over the Remote, then closed (as dsh's own card).
let dismissed = 0;
const continued = ask('question', { snapshot: () => ({ channel: 'rpc' }), dismiss: async () => { dismissed += 1; } });
assert.equal(await board.answer(continued, { answers: [{ id: 'q1', selected: ['A'] }] }, continued), true); assert.equal(dismissed, 1);

// The answer shapes of the panel (the same as dsh's own question card).
const r = (...a) => JSON.parse(JSON.stringify(a));
const qs = [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, { id: 'q2', question: 'Many?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }];
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const shape = eval(`(${/const boardQuestionAnswer = (\([\s\S]*?\}\) \}\));/.exec(src)[1]})`);
assert.deepEqual(r(shape(qs, { q1: { selected: ['A'], custom: '' }, q2: { selected: ['X', 'Y'], custom: ' more ' } })),
  r({ answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X', 'Y'], custom: 'more' }] }), 'options, and own text with a multi-select');
assert.deepEqual(r(shape(qs.slice(0, 1), { q1: { selected: ['A'], custom: 'Mine' } })), r({ answers: [{ id: 'q1', selected: [], custom: 'Mine' }] }), 'own text replaces a single choice');
const planOf = eval(`(${/const boardPlanOf = (\(ask\) => \{[\s\S]*?\n    \});/.exec(src)[1]})`);
assert.deepEqual(planOf({ questions: [{ id: 'plan-review', detail: '# Plan', options: [{ label: 'Approve and leave plan mode' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve and leave plan mode' } }] }),
  { id: 'plan-review', plan: '# Plan', approve: 'Approve and leave plan mode', decline: 'Keep planning' });

// The page: a waiting card has Answer; a click on a card opens its chat; the answer panel uses dsh's labels.
const find = (node, pred, out = []) => { if (node && typeof node === 'object') { if (pred(node)) out.push(node); for (const c of node.c ?? []) find(c, pred, out); } return out; };
const opened = [];
const pageEl = page[1]({ ...injected, openSession: (id) => opened.push(id), useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
board.setProject('all');
const tree = page[1]({ ...injected, openSession: (id) => opened.push(id), useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
assert.ok(pageEl);
const cards = find(tree, (n) => n.p?.['data-cpb-card'] !== undefined);
assert.equal(cards.length, 8, '7 chats and the start whose chat is not on the list yet');
assert.equal(cards.find((n) => n.p['data-cpb-state'] === 'starting')?.p.role, undefined, 'a starting card opens nothing');
const card = cards.find((n) => n.p['data-cpb-card'] === 's4');
card.p.onClick({ target: { closest: () => null } }); assert.deepEqual(opened, ['s4'], 'a click opens the chat');
const answerButton = find(tree, (n) => n.p?.['data-cpb-answer'] === 's1')[0];
assert.ok(answerButton, 'the orange card has Answer'); answerButton.p.onClick(); assert.equal(board.getSnapshot().answering, 's1');
const tree2 = page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
const panelEl = find(tree2, (n) => typeof n.t === 'function' && n.t.name === 'BoardAnswer')[0];
const allow = find(panelEl.t(panelEl.p), (n) => n.p?.['data-cpb-allow'] !== undefined)[0];
assert.equal(allow.c[0], 'approval:allowOnce', 'dsh\'s own button label');
answers = [];
await allow.p.onClick(); await tick(); assert.deepEqual(answers, [['approval', 'allowed-once']]);
const titles = find(tree, (n) => n.p?.['data-cpb-title'] !== undefined).map((n) => n.c[0]);
assert.ok(titles.includes('Title s1'));
assert.match(src, /\.cpb-cardtitle\{[^}]*overflow-wrap:anywhere/, 'a long title wraps inside its card');
assert.doesNotMatch(src, /\.cpb-cardtitle\{[^}]*word-break/, 'a title breaks between words, not in a word');
const top = find(tree, (n) => n.p?.className === 'cpb-cardtop');
assert.ok(top.length > 0 && top.every((n) => find(n, (x) => x.p?.['data-cpb-when'] !== undefined).length === 0), 'the time is not next to the title (the title has the full width)');
assert.equal(find(cards.find((n) => n.p['data-cpb-card'] === 's4'), (x) => x.p?.['data-cpb-when'] !== undefined).length, 1, 'the time is on the meta row');
// The project list: the search box and the filter; no match shows a note.
const side = () => page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
const navNames = (el) => find(el, (n) => n.p?.className === 'cpb-nav').map((n) => n.c[1].c[0]);
let el = side();
assert.deepEqual(navNames(el), ['board.allProjects', 'acme', 'blog']);
const search = find(el, (n) => n.p?.['data-cpb-search'] !== undefined)[0];
assert.equal(search.p.placeholder, 'projectPicker.search', 'the label of Project search in a new chat');
search.p.onChange({ target: { value: 'blo' } }); el = side();
assert.deepEqual(navNames(el), ['board.allProjects', 'blog'], 'the search filters the list; All projects stays');
let stopped = 0;
find(el, (n) => n.p?.['data-cpb-search'] !== undefined)[0].p.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped += 1; } });
assert.equal(board.getSnapshot().query, '', 'Esc empties the box'); assert.equal(stopped, 1, 'and the page does not get that Esc');
const recentButton = find(side(), (n) => n.p?.['data-cpb-recent'] !== undefined)[0];
assert.equal(recentButton.p['aria-pressed'], false); assert.equal(recentButton.c.at(-1).c[0], 'recentProjects.option', 'the label of Recent projects filter');
recentButton.p.onClick(); el = side();
assert.deepEqual(navNames(el), ['board.allProjects', 'acme'], 'only the project with a waiting chat');
board.setQuery('blog'); el = side();
assert.deepEqual(navNames(el), ['board.allProjects']); assert.equal(find(el, (n) => n.p?.['data-cpb-noproject'] !== undefined)[0].c[0], 'projectPicker.empty');
board.setQuery(''); board.toggleRecent();
assert.match(src, /\.cpb-col\{flex:1 1 0;min-width:140px/, 'the columns share the width');

// The off state and an older Host.
globalThis.fetch = async () => Response.json({ error: 'Task board is off' }, { status: 409 });
await board.load(true); assert.equal(board.getSnapshot().off, true);
globalThis.fetch = async () => new Response('', { status: 404 });
await board.load(true); assert.equal(board.getSnapshot().restart, true);
assert.ok(/feature\('taskBoard', \(\) => \[ctx\.slots\.inject\('main'/.test(src), 'installed with feature(id, setup)');

// Switching the feature off removes the page, the sidebar row and the panels.
const toggles = [...live.values()].find(([o]) => o.id === 'composer-plus')[0].inject();
globalThis.fetch = async (url, init) => (url === '/api/composer-plus.board' ? Response.json({ on: JSON.parse(init?.body ?? '{"on":true}').on }) : Response.json({}, { status: 409 }));
board.newTask('w1');
await toggles.setFeature('taskBoard', false); await tick();
assert.ok(![...live.values()].some(([o]) => o.key === 'composer-plus-board' || o.id === 'composer-plus-board'), 'page and row removed');
assert.equal(board.getSnapshot().draft, null, 'the panel goes');
console.log('task board: client ok');
