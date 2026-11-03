// Task board (client half, real client.js with fake dsh stores and a fake fetch): the columns come from dsh's own chat
// list, session status and projects (orange → Review, running or a running subagent → Doing, the rest → Done with the
// green dot while unread; archived and subagent chats left out, a blank chat only as the new task in Todo; a Branch per
// chat project counts as its repository; newest first; Done shows 50; Hide finished); New task opens dsh's own new chat
// (one at a time, a failure shows its reason), records it, and its first message brings the board back (once, only for
// that chat); one answer at a time from every entry point, and a request that changed or was answered
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
  rev += 1; chats = { ...chats, [body.sessionId]: { prompt: '', tags: [], at: 9 } };
  return Response.json({ rev, sessionId: body.sessionId });
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
assert.deepEqual(v.columns.map((c) => c.status), ['doing', 'review', 'done'], 'no new task waits: no Todo column');
assert.deepEqual(ids(v, 'review'), ['s1'], 'orange: Review');
assert.deepEqual(ids(v, 'doing'), ['s2', 's3'], 'running, or a running subagent: Doing');
assert.deepEqual(ids(v, 'done'), ['s4', 's8', 's9', 's7'], 'the rest: Done, newest first (s5 blank, s6 archived, kid a subagent left out; an answered request is not orange)');
assert.equal(v.columns[2].cards[0].state, 'unread', 'the green dot while unread'); assert.equal(v.columns[2].cards[1].state, 'read');
assert.deepEqual(v.projects.map((p) => [p.id, p.name, p.active, p.waiting]), [['w1', 'acme', 3, 1], ['w3', 'blog', 0, 0]], 'a Branch per chat folder is no project of its own; acme has 1 chat that waits');
const s1 = v.columns[1].cards[0];
assert.equal(s1.title, 'Title s1'); assert.deepEqual(s1.tags, ['chess', 'game']); assert.equal(s1.prompt, 'html css js ile satranç oyunu yap'); assert.equal(s1.ask.kind, 'approval');
assert.deepEqual(v.counts, { running: 2, waiting: 1 });
assert.deepEqual(ids(board.columns({ workspaces, list, statuses, meta: chats, project: 'w1' }), 'done'), ['s4', 's8', 's9', 's7'], 'the branch chat belongs to its repository');
assert.deepEqual(ids(board.columns({ workspaces, list, statuses, project: 'w3' }), 'done'), []);
assert.equal(board.columns({ workspaces, list: { byId: Object.fromEntries([summary('n1', { title: undefined, displayTitle: 'acme' })]) }, statuses: new Map(), meta: { n1: { prompt: 'Make a chess game\nwith tests', tags: [], at: 1 } } }).columns[2].cards[0].title,
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
assert.deepEqual(v.columns.map((c) => c.status), ['doing', 'review'], 'Hide finished hides Done');
assert.deepEqual(board.columns({ workspaces, list, statuses, hideDone: true, task: 's5' }).columns.map((c) => c.status), ['todo', 'doing', 'review'], 'and Todo shows with a new task');
const many = { byId: Object.fromEntries(Array.from({ length: 60 }, (_, i) => summary(`m${i}`, { updatedAt: i }))) };
v = board.columns({ workspaces: { items: [], archivedSessionIds: [] }, list: many, statuses: new Map() });
assert.equal(v.columns[2].cards.length, 50); assert.equal(v.hiddenDone, 10); assert.equal(v.columns[2].cards[0].id, 'm59');
assert.equal(board.columns({ workspaces: { items: [] }, list: many, statuses: new Map(), doneAll: true }).columns[2].cards.length, 60);
// The new task's blank chat shows in Todo (no other blank chat); once it has a message it is a normal card.
v = board.columns({ workspaces, list, statuses, task: 's5' });
assert.deepEqual(v.columns.map((c) => c.status), ['todo', 'doing', 'review', 'done'], 'a new task waits: Todo shows');
assert.deepEqual(ids(v, 'todo'), ['s5'], 'the new task before its first message'); assert.equal(v.columns[0].cards[0].state, 'draft');
assert.equal(ids(board.columns({ workspaces, list, statuses, task: 's5', project: 'w3' }), 'todo'), undefined, 'only in its own project (no Todo in another)');
assert.equal(ids(board.columns({ workspaces, list, statuses, task: 's1' }), 'todo'), undefined, 'a chat with a message is not a draft');

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

// New task: dsh's own New session; one at a time; the chat is recorded; its first message brings the board back.
const opens = []; let openGate = null; let openFails = null;
const openNew = async (project) => { opens.push(project); if (openGate) await openGate.promise; if (openFails) { const e = openFails; openFails = null; throw e; } return `chat${opens.length}`; };
assert.equal(await board.newTask('w1', undefined), false, 'no New session in this dsh: nothing');
let releaseOpen; openGate = { promise: new Promise((res) => { releaseOpen = res; }) };
const n1 = board.newTask('w1', openNew); await tick();
assert.equal(await board.newTask('w1', openNew), false, 'a second New task while one opens');
assert.deepEqual(opens, ['w1'], 'one New session');
openGate = null; releaseOpen(); assert.equal(await n1, true);
assert.equal(board.getSnapshot().task, 'chat1', 'the new task waits for its first message');
assert.deepEqual(posts, [{ sessionId: 'chat1' }], 'the Host records the chat');
await board.newTask(undefined, openNew); assert.equal(opens[1], undefined, 'All projects: dsh picks the project');
assert.equal(board.getSnapshot().task, 'chat2', 'the newest task');
assert.equal(board.sent('chat1'), false, 'another chat\'s message does not bring the board back');
assert.equal(board.sent('chat2'), true, 'its first message: back to the board'); assert.equal(board.getSnapshot().task, null);
assert.equal(board.sent('chat2'), false, 'once');
openFails = new Error('the new chat did not open');
assert.equal(await board.newTask('w1', openNew), false); assert.equal(board.getSnapshot().toast, 'the new chat did not open', 'a failure shows its reason');
assert.equal(board.getSnapshot().task, null);
refuse = { status: 404, error: 'this is not a dsh chat' };
assert.equal(await board.newTask('w1', openNew), false); assert.equal(board.getSnapshot().task, null, 'the Host refused: no task'); assert.equal(board.getSnapshot().toast, 'this is not a dsh chat');
// The watcher: the task's chat leaves blank → back(); another chat or a still blank one does nothing.
const listeners = new Set(); let snap = { byId: { chat9: { blank: true }, other: { blank: false } } };
const fakeList = { getSnapshot: () => snap, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
const fire = () => { for (const fn of [...listeners]) fn(); };
const watch = eval(`(${/function watchBoardTask\(board, list, back\) \{[\s\S]*?\n    \}/.exec(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))[0]})`);
let backs = 0; const stopWatch = watch(board, fakeList, () => { backs += 1; });
await board.newTask('w1', async () => 'chat9');
fire(); assert.equal(backs, 0, 'still blank');
snap = { byId: { chat9: { blank: false } } }; fire(); assert.equal(backs, 1, 'the first message went: back to the board');
fire(); assert.equal(backs, 1, 'once');
stopWatch(); assert.equal(listeners.size, 0, 'the feature going off stops the watcher');
// openBoardTask: dsh's startSession, then the blank chat in the main view.
const openTask = eval(`(${/function openBoardTask\(uiWorkspace, list, project, wait = 15000\) \{[\s\S]*?\n    \}/.exec(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))[0]})`);
snap = { byId: { old: { id: 'old', blank: true, retainedBy: { mainView: 1 } } } };
const started = [];
// dsh moves the main view in two steps: first the old blank chat stays retained, then the new one comes. Another blank
// chat that is not in the main view (an older empty chat in the sidebar) is not the new one.
const ui = { startSession: (w) => { started.push(w); fire(); snap = { byId: { other: { id: 'other', blank: true, retainedBy: {} }, old: { id: 'old', blank: true, retainedBy: { mainView: 1 } }, fresh: { id: 'fresh', blank: true, retainedBy: { mainView: 1 } } } }; fire(); } };
assert.equal(await openTask(ui, fakeList, 'w1'), 'fresh', 'the blank chat that dsh opened in the main view, not the one that was open before'); assert.deepEqual(started, ['w1']);
await assert.rejects(openTask({}, fakeList, 'w1'), /no New session/);
await assert.rejects(openTask({ startSession: () => { throw new Error('boom'); } }, fakeList, 'w1'), /boom/);
assert.equal(listeners.size, 0, 'no listener left');
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
assert.equal(cards.length, 7, '7 chats (the blank one is no task now)');
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
assert.match(src, /\.cpb-search\{flex:none;[^}]*height:36px/, 'the search box keeps its height in a long project list (the side is a flex column)');
const top = find(tree, (n) => n.p?.className === 'cpb-cardtop');
assert.ok(top.length > 0 && top.every((n) => find(n, (x) => x.p?.['data-cpb-when'] !== undefined).length === 0), 'the time is not next to the title (the title has the full width)');
assert.equal(find(cards.find((n) => n.p['data-cpb-card'] === 's4'), (x) => x.p?.['data-cpb-when'] !== undefined).length, 1, 'the time is on the meta row');
// The project list: the search box and the filter; no match shows a note.
const side = () => page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
const navNames = (el) => find(el, (n) => n.p?.className === 'cpb-nav').map((n) => n.c[1].c[0]);
let el = side();
assert.deepEqual(navNames(el), ['board.allProjects', 'acme', 'blog']);
// Only the states have colors: a project row and a card's project chip use the text color, not a color per project.
const folders = find(el, (n) => n.p?.className === 'cpb-nav').slice(1).map((n) => n.c[0]);
assert.ok(folders.length === 2 && folders.every((f) => find(f.t(f.p ?? {}), (x) => x.t === 'path')[0].p.stroke === 'currentColor'), 'a project folder has no color of its own');
const chips = find(el, (n) => n.p?.className === 'cpb-chip');
assert.ok(chips.length > 0 && chips.every((n) => n.c.length === 1 && typeof n.c[0] === 'string'), 'a card shows its project as plain text, without a colored dot');
assert.doesNotMatch(src, /BOARD_COLORS|boardColor/, 'no project colors');
// Only the project list scrolls: the projects are in their own box, after the search box and the filter.
const projectsBox = find(el, (n) => n.p?.['data-cpb-projects'] !== undefined)[0];
assert.deepEqual(find(projectsBox, (n) => n.p?.className === 'cpb-nav').map((n) => n.c[1].c[0]), ['acme', 'blog'], 'the project rows are in the scrolling box');
assert.equal(find(projectsBox, (n) => n.p?.['data-cpb-search'] !== undefined || n.p?.['data-cpb-recent'] !== undefined).length, 0, 'the search box and the filter stay outside it');
assert.match(src, /\.cpb-projects\{[^}]*overflow-y:auto/, 'the project box scrolls');
// The orange dot: acme has a chat that waits; blog has none. The count reads as the counts line.
const navRow = (name) => find(el, (n) => n.p?.className === 'cpb-nav' && n.c[1]?.c?.[0] === name)[0];
const dotOf = (row) => find(row, (n) => n.p?.['data-cpb-waiting'] !== undefined);
assert.equal(dotOf(navRow('acme')).length, 1, 'a project with a waiting chat has the orange dot');
assert.equal(find(dotOf(navRow('acme'))[0], (n) => n.t === 'StateDot')[0].p.state, 'warning', 'dsh\'s own orange dot');
assert.equal(dotOf(navRow('blog')).length, 0, 'no waiting chat: no dot');
{
  // Running chats but none that waits: the count, no dot.
  const calm = page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(list), useSessionStatus: (f) => f(new Map([['kid', { running: true }]])), useWorkspaces: (f) => f(workspaces), t: (k) => k });
  const acme = find(calm, (n) => n.p?.className === 'cpb-nav' && n.c[1]?.c?.[0] === 'acme')[0];
  assert.equal(dotOf(acme).length, 0, 'running only: no orange dot');
  assert.equal(find(acme, (n) => n.p?.className === 'cpb-count')[0].c[1].c[0], '2', 'the count of running chats');
}
assert.equal(dotOf(navRow('board.allProjects')).length, 1, 'All projects has it too');
assert.equal(find(navRow('acme'), (n) => n.p?.className === 'cpb-sr')[0].c[0], 'board.counts', 'a screen reader reads the counts, not a bare number');
assert.equal(find(navRow('blog'), (n) => n.p?.className === 'cpb-count')[0].c.length, 0, 'no running or waiting chat: no count');
// The tooltip of a project row: the full name, then the path.
assert.equal(navRow('acme').p.title, 'acme\n/w/acme');
// The header: Hide finished keeps its name for a screen reader and as a tooltip; a narrow board shows only its icon.
const hideButton = find(el, (n) => n.p?.['data-cpb-hide-done'] !== undefined)[0];
assert.equal(hideButton.p['aria-label'], 'board.hideDone'); assert.equal(hideButton.p.title, 'board.hideDone');
assert.equal(hideButton.c[1].c[0], 'board.hideDone', 'the visible name is in its own span (hidden in a narrow board)');
assert.match(src, /\.cpb-main\{[^}]*container-type:inline-size/, 'the header reacts to the board width, not the window');
assert.match(src, /@container \(max-width:620px\)\{\.cpb-toggle>span\{display:none\}/, 'icon only in a narrow board');
assert.doesNotMatch(src, /\.cpb-head\{[^}]*flex-wrap:wrap/, 'the header does not wrap to a second line');
assert.match(src, /\.cpb-card\[data-cpb-state=draft\] \.cpb-when\{[^}]*white-space:normal/, 'the draft hint wraps instead of being cut');
assert.match(src, /\.cpb-filter\{[^}]*border:\.5px solid/, 'the filter looks like a button');
const search = find(el, (n) => n.p?.['data-cpb-search'] !== undefined)[0];
assert.equal(search.p.placeholder, 'projectPicker.search', 'the label of Project search in a new chat');
search.p.onChange({ target: { value: 'blo' } }); el = side();
assert.deepEqual(navNames(el), ['board.allProjects', 'blog'], 'the search filters the list; All projects stays');
let stopped = 0;
find(el, (n) => n.p?.['data-cpb-search'] !== undefined)[0].p.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped += 1; } });
assert.equal(board.getSnapshot().query, '', 'Esc empties the box'); assert.equal(stopped, 1, 'and the page does not get that Esc');
const recentButton = find(side(), (n) => n.p?.['data-cpb-recent'] !== undefined)[0];
assert.equal(recentButton.p['aria-pressed'], false); assert.equal(recentButton.c[1].c[0], 'recentProjects.option', 'the label of Recent projects filter');
assert.equal(recentButton.c.at(-1), null, 'off: no check mark');
recentButton.p.onClick(); el = side();
const recentOn = find(el, (n) => n.p?.['data-cpb-recent'] !== undefined)[0];
assert.equal(recentOn.p['aria-pressed'], true); assert.equal(find(recentOn.c.at(-1).t(), (n) => n.p?.['data-cpb-check'] !== undefined).length, 1, 'on: a check mark');
assert.deepEqual(navNames(el), ['board.allProjects', 'acme'], 'only the project with a waiting chat');
board.setQuery('blog'); el = side();
assert.deepEqual(navNames(el), ['board.allProjects']); assert.equal(find(el, (n) => n.p?.['data-cpb-noproject'] !== undefined)[0].c[0], 'projectPicker.empty');
board.setQuery(''); board.toggleRecent();
assert.match(src, /\.cpb-col\{flex:1 1 0;min-width:140px/, 'the columns share the width');

// The page: New task calls dsh's New session for the shown project; the draft card says "New task", opens its chat.
const newCalls = [];
board.setProject('w1');
let pg = page[1]({ ...injected, openSession: (id) => opened.push(id), openNewTask: async (p) => { newCalls.push(p); return 's5'; }, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
await find(pg, (n) => n.p?.['data-cpb-new'] !== undefined)[0].p.onClick(); await tick();
assert.deepEqual(newCalls, ['w1'], 'the shown project');
pg = page[1]({ ...injected, openSession: (id) => opened.push(id), openNewTask: async () => 's5', useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
const draft = find(pg, (n) => n.p?.['data-cpb-card'] === 's5')[0];
assert.equal(draft.p['data-cpb-state'], 'draft'); assert.equal(find(draft, (n) => n.p?.['data-cpb-title'] !== undefined)[0].c[0], 'board.newTask');
assert.equal(find(draft, (n) => n.p?.['data-cpb-when'] !== undefined)[0].c[0], 'board.waitingFirst');
draft.p.onClick({ target: { closest: () => null } }); assert.equal(opened.at(-1), 's5', 'a click opens its chat to write the first message');
board.setProject('all');
pg = page[1]({ ...injected, openSession: () => {}, openNewTask: async (p) => { newCalls.push(p); return 's5'; }, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
await find(pg, (n) => n.p?.['data-cpb-new'] !== undefined)[0].p.onClick(); await tick();
assert.equal(newCalls.at(-1), undefined, 'All projects: dsh picks');
pg = page[1]({ ...injected, openNewTask: undefined, openSession: () => {}, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
assert.equal(find(pg, (n) => n.p?.['data-cpb-new'] !== undefined).length, 0, 'no New session: no button');
await assert.rejects(injected.openNewTask('w1'), /no New session/, 'the injected opener before dsh\'s services come');
assert.doesNotMatch(src, /function BoardNewTask|data-cpb-prompt/, 'no panel of our own for the prompt');
board.sent('s5');

// The off state and an older Host.
// Progress on hover: the lines from the Host's answer.
const boardElapsed = eval(`(${/const boardElapsed = (\(since, now = Date\.now\(\)\) => \{[\s\S]*?\n    \});/.exec(src)[1]})`);
const lines = eval(`(${/function boardProgressLines(\(p, t, now = Date\.now\(\)\) \{[\s\S]*?\n    \})/.exec(src)[0].replace('function boardProgressLines', 'function')})`);
const tt = (k, v) => `${k}${v ? JSON.stringify(v) : ''}`;
const NOW = 10 * 60000;
assert.equal(boardElapsed(NOW - 30000, NOW), '<1m'); assert.equal(boardElapsed(NOW - 4 * 60000, NOW), '4m'); assert.equal(boardElapsed(0, 65 * 60000), '1h 5m'); assert.equal(boardElapsed(undefined, NOW), '');
const full = { mode: 'fast', since: NOW - 4 * 60000, todos: { done: 1, total: 3, current: 'Write the tests' }, tool: { name: 'bash', detail: 'Run the unit tests', running: true }, said: 'Now I write the tests.' };
assert.deepEqual(lines(full, tt, NOW).map((l) => l.text), ['board.progress.for{"time":"4m"}', 'board.progress.step{"n":"2","total":"3","step":"Write the tests"}', 'board.progress.now{"step":"bash · Run the unit tests"}', 'Now I write the tests.'], 'fast: time, step, tool, the agent\'s line');
assert.equal(lines({ ...full, tool: { name: 'read', detail: '', running: false } }, tt, NOW)[2].text, 'board.progress.last{"step":"read"}', 'a finished step');
assert.equal(lines({ ...full, todos: { done: 3, total: 3 } }, tt, NOW)[1].text, 'board.progress.done{"done":"3","total":"3"}', 'no step in progress: the count');
assert.deepEqual(lines({ ...full, mode: 'ai', summary: 'Writing the tests.' }, tt, NOW)[0], { kind: 'summary', text: 'Writing the tests.' }, 'AI: the summary first');
assert.deepEqual(lines({ ...full, mode: 'ai', pending: true }, tt, NOW)[0], { kind: 'summary', text: 'board.progress.summarizing', muted: true }, 'AI: while the first summary is written');
assert.equal(lines({ said: 'Same', summary: 'Same' }, tt, NOW).filter((l) => l.text === 'Same').length, 1, 'the same line once');
assert.deepEqual(lines({}, tt, NOW), []); assert.deepEqual(lines(null, tt, NOW), []);
// The reads of a box: now, then every 2 s; stop ends them, and a read that ends after stop is dropped.
const poll = eval(`(${/function pollBoardProgress(\(sessionId, call, onData, every = BOARD_POLL_MS\) \{[\s\S]*?\n    \})/.exec(src)[0].replace('function pollBoardProgress', 'function').replace('BOARD_POLL_MS', '2000')})`);
{
  const seen = []; let reads = 0; let late;
  const stop = poll('s2', async (id) => { reads += 1; if (reads === 3) return new Promise((r) => { late = r; }); return { id, n: reads }; }, (x) => seen.push(x));
  await tick();
  assert.deepEqual(seen, [{ data: { id: 's2', n: 1 } }], 'read at once');
  const next = timers.find((x) => x.ms === 2000); assert.ok(next, 'then again in 2 s');
  timers = timers.filter((x) => x !== next); next.f(); await tick();
  assert.equal(seen.length, 2);
  const third = timers.find((x) => x.ms === 2000); timers = timers.filter((x) => x !== third); third.f(); await tick();
  stop(); late({ id: 's2', n: 3 }); await tick();
  assert.equal(seen.length, 2, 'a read that ends after the box closed is dropped');
  assert.equal(timers.filter((x) => x.ms === 2000).length, 0, 'and no next read');
  const stop1 = poll('s3', async () => ({ ok: 1 }), () => {}); await tick();
  assert.equal(timers.filter((x) => x.ms === 2000).length, 1, 'a next read waits');
  stop1(); assert.equal(timers.filter((x) => x.ms === 2000).length, 0, 'closing the box cancels the next read');
  const errs = []; const stop2 = poll('s2', async () => { throw new Error('gone'); }, (x) => errs.push(x)); await tick(); stop2();
  assert.deepEqual(errs, [{ error: 'gone' }]); timers = timers.filter((x) => x.ms !== 2000);
}
// The page: a running card opens the box after 400 ms of hover (at once on focus); other cards have none.
{
  const pg = () => page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
  board.setProject('all');
  let el = pg();
  const runCard = find(el, (n) => n.p?.['data-cpb-card'] === 's2')[0];
  const doneCard = find(el, (n) => n.p?.['data-cpb-card'] === 's4')[0];
  assert.equal(runCard.p.title, undefined, 'a running card: no native title next to the box');
  assert.equal(typeof runCard.p.onMouseEnter, 'function'); assert.equal(doneCard.p.onMouseEnter, undefined, 'only a running card has the box');
  const fakeEl = { getBoundingClientRect: () => ({ left: 10, top: 100, bottom: 160, width: 180 }) };
  globalThis.window.innerHeight = 900;
  timers = [];
  runCard.p.onMouseEnter({ currentTarget: fakeEl });
  const wait = timers.find((x) => x.ms === 400); assert.ok(wait, 'the box waits 400 ms (a pointer that passes opens nothing)');
  runCard.p.onMouseLeave(); assert.equal(timers.includes(wait), false, 'leaving before cancels it');
  const placeOf = eval(`(${/const placeOf = (\(el\) => \{[\s\S]*?\n      \});/.exec(src)[1]})`);
  globalThis.window.innerWidth = 1000;
  assert.deepEqual(placeOf({ getBoundingClientRect: () => ({ left: 10, top: 100, bottom: 160, width: 180 }) }), { left: 10, width: 220, top: 166 }, 'under the card, at least 220 px wide');
  assert.deepEqual(placeOf({ getBoundingClientRect: () => ({ left: 900, top: 100, bottom: 160, width: 300 }) }), { left: 692, width: 300, top: 166 }, 'a card at the right edge: the box stays in the window');
  assert.deepEqual(placeOf({ getBoundingClientRect: () => ({ left: 10, top: 700, bottom: 800, width: 180 }) }), { left: 10, width: 220, bottom: 206 }, 'no room below: above the card');
  assert.match(src, /className: 'cpb-list', onScroll: \(\) => hideProgress\(\)/, 'a column scroll closes the box');
  assert.match(src, /hover !== null && view\.columns\.some\(\(col\) => col\.status === 'doing'/, 'the box shows only for a card that is still in Doing');
  assert.match(src, /if \(live\.current\.hover !== null\) \{ event\.preventDefault\(\); hideProgress\(\); return; \}/, 'Esc closes the box first');
  assert.match(src, /\.cpb-progress\{position:fixed;[^}]*pointer-events:none/, 'the box is above the columns and lets the pointer through');
  // The box itself: role tooltip, the lines, and the card names it while it shows.
  const box = eval(`(${/function BoardProgressBox\([\s\S]*?\n    \}/.exec(src)[0].replace('function BoardProgressBox', 'function')})`);
  let hookState = null;
  const R = { ...React, useState: () => [hookState, () => {}], useEffect: () => {} };
  const run = (st) => { hookState = st; return new Function('React', 'boardProgressLines', 'pollBoardProgress', 'readBoardProgress', `return (${box.toString()})`)(R, lines, poll, async () => full)({ sessionId: 's2', place: { left: 1 }, t: tt }); };
  const shown = run({ data: full });
  assert.equal(shown.p.role, 'tooltip'); assert.equal(shown.p.id, 'cpb-progress-s2'); assert.deepEqual(shown.p.style, { left: 1 });
  assert.equal(shown.c[0].length, 4, 'four lines');
  assert.equal(run(null).c[0].c[0], 'board.loading', 'while the first read runs');
  assert.equal(run({ error: 'x' }).c[0].c[0], 'board.progress.failed{"error":"x"}');
  assert.equal(run({ data: { mode: 'fast' } }).c[0].c[0], 'board.progress.none', 'a turn with no step yet');
}
// A card that leaves Doing (its turn ends) gets no leave event. Its box must not come back by itself when the chat runs
// again (it reads every 2 s, in AI summary mode with model calls). Hooks that keep their state between renders.
{
  const saved = { useState: React.useState, useRef: React.useRef, useEffect: React.useEffect };
  const slots = []; let at = 0; let effects = [];
  React.useState = (v) => { const i = at++; if (!(i in slots)) slots[i] = typeof v === 'function' ? v() : v; return [slots[i], (n) => { slots[i] = typeof n === 'function' ? n(slots[i]) : n; }]; };
  React.useRef = (v) => { const i = at++; if (!(i in slots)) slots[i] = { current: v }; return slots[i]; };
  React.useEffect = (f, deps) => {
    const i = at++; const old = slots[i];
    if (old === undefined || deps === undefined || deps.some((d, k) => !Object.is(d, old.deps[k]))) effects.push(() => { if (typeof old?.cleanup === 'function') old.cleanup(); slots[i] = { deps, cleanup: f() }; });
  };
  const listOf = (running) => ({ ...list, byId: { ...list.byId, s2: { ...list.byId.s2, running } } });
  const render = (running) => {
    at = 0; effects = [];
    const el = page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(listOf(running)), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
    for (const e of effects) e();
    return el;
  };
  const hasBox = (el) => find(el, (n) => n.t?.name === 'BoardProgressBox').length > 0;
  const rect = { getBoundingClientRect: () => ({ left: 10, top: 100, bottom: 160, width: 180 }) };
  const cardOf = (el, id) => find(el, (n) => n.p?.['data-cpb-card'] === id)[0];
  const enter = (el, id = 's2') => cardOf(el, id).p.onMouseEnter({ currentTarget: rect });
  const fire = () => { const w = timers.find((x) => x.ms === 400); timers = timers.filter((x) => x !== w); w?.f(); };
  const boxOf = (el) => find(el, (n) => n.t?.name === 'BoardProgressBox')[0]?.p.sessionId;
  try {
    enter(render(true)); fire();
    assert.equal(hasBox(render(true)), true, 'the hovered running card shows its box');
    assert.equal(hasBox(render(false)), false, 'the turn ended: no box');
    render(false);
    assert.equal(hasBox(render(true)), false, 'the chat runs again, nobody pointed at it: no box');
    // The 400 ms wait ends after the card left Doing.
    enter(render(true)); render(false); fire(); render(false);
    assert.equal(hasBox(render(true)), false, 'a late wait does not bring the box back either');
    // s2 has the keyboard focus (its box shows), the pointer waits on s3 (also in Doing); s2's turn ends: s3's box opens.
    let el = render(true);
    cardOf(el, 's2').p.onFocus({ target: rect, currentTarget: rect });
    assert.equal(boxOf(render(true)), 's2');
    enter(render(true), 's3'); render(false); render(false); fire();
    assert.equal(boxOf(render(false)), 's3', 'the wait on another card goes on');
    el = render(false); cardOf(el, 's3').p.onMouseLeave(); render(false);
  } finally {
    Object.assign(React, saved);
    for (const s of slots) if (typeof s?.cleanup === 'function') s.cleanup();
    timers = timers.filter((x) => x.ms !== 400 && x.ms !== 2000);
  }
}
// Settings → Progress on hover: Fast by default, one change at a time, a failure keeps the saved mode.
{
  const make = eval(`(${/function createBoardProgressMode\([\s\S]*?\n    \}/.exec(src)[0].replace('function createBoardProgressMode', 'function').replace('route = BOARD_PROGRESS_ROUTE', "route = '/p'")})`);
  const sent = []; let fail = false; let release;
  const realFetch = globalThis.fetch;
  let holdGet = null;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') { sent.push(JSON.parse(init.body)); await new Promise((r) => { release = r; }); return fail ? Response.json({ error: 'disk full' }, { status: 500 }) : Response.json(JSON.parse(init.body)); }
    if (holdGet) await holdGet.promise;
    return Response.json({ mode: 'fast' });
  };
  const m = make();
  {
    // A load that started before a change and ends during it does not undo the change.
    let openGet; holdGet = { promise: new Promise((r) => { openGet = r; }) };
    const loading = m.load(); await tick();
    const change = m.setMode('ai'); await tick();
    release(); await change;
    holdGet = null; openGet(); await loading;
    assert.equal(m.getSnapshot().mode, 'ai', 'an older load that ends after the change does not overwrite it');
    sent.length = 0;
    const back = m.setMode('fast'); await tick(); release(); await back;
    sent.length = 0;
  }
  assert.equal(m.getSnapshot().mode, 'fast', 'Fast (no AI) by default');
  const first = m.setMode('ai'); const second = m.setMode('fast'); await tick();
  assert.deepEqual(sent, [{ mode: 'ai' }], 'one change at a time');
  await m.load(); assert.equal(m.getSnapshot().mode, 'ai', 'a load during the change does not undo it');
  release(); await first; await second;
  assert.equal(m.getSnapshot().mode, 'ai'); assert.equal(m.getSnapshot().busy, false); assert.equal(m.getSnapshot().error, undefined);
  fail = true; const third = m.setMode('fast'); await tick(); release(); await third;
  assert.equal(m.getSnapshot().mode, 'ai', 'a failed change keeps the saved mode'); assert.equal(m.getSnapshot().error, 'disk full');
  await m.setMode('slow'); assert.equal(sent.length, 2, 'no unknown mode');
  globalThis.fetch = realFetch;
}

globalThis.fetch = async () => Response.json({ error: 'Task board is off' }, { status: 409 });
await board.load(true); assert.equal(board.getSnapshot().off, true);
globalThis.fetch = async () => new Response('', { status: 404 });
await board.load(true); assert.equal(board.getSnapshot().restart, true);
assert.ok(/feature\('taskBoard', \(\) => \[ctx\.slots\.inject\('main'/.test(src), 'installed with feature(id, setup)');

// Switching the feature off removes the page, the sidebar row and the panels.
const toggles = [...live.values()].find(([o]) => o.id === 'composer-plus')[0].inject();
globalThis.fetch = async (url, init) => (url === '/api/composer-plus.board' ? Response.json({ on: JSON.parse(init?.body ?? '{"on":true}').on }) : Response.json({ rev: 9, sessionId: 'chatX' }));
board.openAnswer('s1'); await board.newTask('w1', async () => 'chatX');
assert.equal(board.getSnapshot().task, 'chatX', 'a new task waits');
await toggles.setFeature('taskBoard', false); await tick();
assert.ok(![...live.values()].some(([o]) => o.key === 'composer-plus-board' || o.id === 'composer-plus-board'), 'page and row removed');
assert.equal(board.getSnapshot().answering, null, 'the panel goes'); assert.equal(board.getSnapshot().task, null, 'the new task is forgotten');
console.log('task board: client ok');
