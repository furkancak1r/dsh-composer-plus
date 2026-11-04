// Task board (client half, real client.js with fake dsh stores and a fake fetch): the columns come from dsh's own chat
// list, session status and projects (orange → Review, running or a running subagent → Doing, the rest → Done with the
// green dot while unread; archived and subagent chats left out, a blank chat only as the new task, first in Doing; a
// Branch per chat project counts as its repository; newest first; Done shows 50; no Todo column, no Hide finished); × on a
// Done card and Clear all take finished cards off the board (one hide at a time, an older read dropped, a failure brings
// them back, a hidden chat that runs shows again; nothing without the Host's list); New task opens dsh's own new chat
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
let rev = 1; const posts = []; const gets = []; let gate = null; let refuse = null; let hiddenIds = []; let getGate = null;
let chats = { s1: { prompt: 'html css js ile satranç oyunu yap', tags: ['chess', 'game'], at: 1 } };
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('/api/composer-plus.board-chats')) return new Response('{}', { status: 404 });
  if (init?.method !== 'POST') {
    const q = new URLSearchParams(String(url).split('?')[1] ?? '');
    gets.push(Object.fromEntries(q));
    if (q.get('rev') === String(rev)) return Response.json({ rev, same: true });
    // The answer is the state when the read arrived; a held read answers it later.
    const answer = { rev, chats, hidden: hiddenIds };
    if (getGate) await getGate.promise;
    return Response.json(answer);
  }
  const body = JSON.parse(init.body); posts.push(body);
  if (gate) await gate.promise;
  if (refuse) { const r = refuse; refuse = null; return Response.json({ error: r.error }, { status: r.status }); }
  if (body.hide) { rev += 1; hiddenIds = [...new Set([...hiddenIds, ...body.hide])]; return Response.json({ rev, hidden: hiddenIds }); }
  if (body.unhide) { rev += 1; hiddenIds = hiddenIds.filter((id) => !body.unhide.includes(id)); return Response.json({ rev, hidden: hiddenIds }); }
  rev += 1; chats = { ...chats, [body.sessionId]: { prompt: '', tags: [], at: 9 } };
  return Response.json({ rev, sessionId: body.sessionId });
};
const hold = () => { let open; gate = { promise: new Promise((r) => { open = r; }) }; return () => { gate = null; open(); }; };

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, confirm: () => true, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: () => {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {} };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', StateDot: 'StateDot', Modal: 'Modal', Button: 'Button' } : {}));
const live = new Map(); let next = 0;
// dsh's services for the Task board key: the Keyboard shortcuts service (it refuses a default that another command has)
// and the layout (selectPanel opens a main panel). Only the board's key scope runs here.
const commands = []; const selected = []; let keyFibers = 0;
const shortcutsService = { register: (command) => { commands.push(command); return () => { commands.splice(commands.indexOf(command), 1); }; } };
const inject = (deps, setup) => {
  const offs = []; const fiber = { dispose: () => { for (const o of offs.splice(0).reverse()) o?.(); if (deps.join() === 'shortcuts,layout') keyFibers -= 1; } };
  if (deps.join() === 'shortcuts,layout') { keyFibers += 1; setup({ shortcuts: shortcutsService, layout: { selectPanel: (id) => selected.push(id) }, effect: (f) => offs.push(f()) }); }
  return fiber;
};
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x }, inject,
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
// Cmd+Shift+K (Ctrl+Shift+K) opens the board from anywhere, also from the composer; it is on dsh's Keyboard shortcuts page.
{
  const boardKey = commands.find((c) => c.id === 'composerPlus.taskBoard');
  assert.ok(boardKey, 'on by default: the Task board command'); assert.equal(keyFibers, 1);
  assert.match(boardKey.id, /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/u, 'dsh\'s command id pattern');
  assert.equal(boardKey.label(), 'dsh-composer-plus:board.title', 'its row on the Keyboard shortcuts page: the Task board label');
  assert.deepEqual(boardKey.regions, ['page', 'editable'], 'works while the composer has the focus'); assert.deepEqual(boardKey.modals, [], 'not in a dialog');
  assert.deepEqual(Object.keys(boardKey.defaults).sort(), ['desktop:linux', 'desktop:macos', 'desktop:windows', 'web:macos', 'web:windows'], 'no web Linux default, as in dsh');
  for (const binding of Object.values(boardKey.defaults)) assert.deepEqual(binding, { code: 'KeyK', modifiers: ['primary', 'shift'] }, 'Cmd+Shift+K / Ctrl+Shift+K');
  const handled = boardKey.resolve({}); assert.equal(handled.status, 'handled'); handled.run();
  assert.deepEqual(selected, ['composer-plus-board'], 'the key opens the board panel (the panel of the sidebar row)');
}
// A taken default (dsh refuses it) is handled by registerCommand, which test/next-waiting.test.mjs checks.
assert.match(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), /\.\.\.injectScope\(\['shortcuts', 'layout'\], \(scope\) => \{\n\s*\/\/ The key goes with the feature/, 'the key is part of the taskBoard feature');
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
assert.deepEqual(v.columns.map((c) => c.status), ['doing', 'review', 'done'], 'three columns: no Todo');
assert.deepEqual(ids(v, 'review'), ['s1'], 'orange: Review');
assert.deepEqual(ids(v, 'doing'), ['s2', 's3'], 'running, or a running subagent: Doing');
assert.deepEqual(ids(v, 'done'), ['s4'], 'Done: the finished chats that you did not read yet (green)');
assert.equal(v.columns[2].cards[0].state, 'unread', 'the green dot while unread');
assert.deepEqual(v.recent.map((c) => c.id), ['s8', 's9', 's7'], 'a read card leaves Done for Recently finished, newest first (s5 blank, s6 archived, kid a subagent left out; an answered request is not orange)');
assert.equal(v.recent[0].state, 'read'); assert.equal(v.recentCount, 3); assert.equal(v.unreadDone, 1);
// The board's own unread set: a chat that finished behind a panel while it was dsh's open chat (no dsh dot) stays in Done.
v = board.columns({ workspaces, list, statuses, fresh: new Set(['s9']) });
assert.deepEqual(ids(v, 'done'), ['s4', 's9'], 'fresh: unread for the board'); assert.equal(v.columns[2].cards[1].state, 'unread');
assert.deepEqual(v.recent.map((c) => c.id), ['s8', 's7']);
assert.deepEqual(ids(board.columns({ workspaces, list, statuses: new Map([['s2', { running: true }]]), fresh: new Set(['s2']) }), 'doing'), ['s2', 's3'], 'a fresh chat that runs again is in Doing');
v = board.columns({ workspaces, list, statuses, meta: chats });
assert.deepEqual(v.projects.map((p) => [p.id, p.name, p.active, p.waiting]), [['w1', 'acme', 3, 1], ['w3', 'blog', 0, 0]], 'a Branch per chat folder is no project of its own; acme has 1 chat that waits');
const s1 = v.columns[1].cards[0];
assert.equal(s1.title, 'Title s1'); assert.deepEqual(s1.tags, ['chess', 'game']); assert.equal(s1.prompt, 'html css js ile satranç oyunu yap'); assert.equal(s1.ask.kind, 'approval');
assert.deepEqual(v.counts, { running: 2, waiting: 1 });
assert.deepEqual(board.columns({ workspaces, list, statuses, meta: chats, project: 'w1' }).recent.map((c) => c.id), ['s8', 's9', 's7'], 'the branch chat belongs to its repository');
assert.deepEqual(ids(board.columns({ workspaces, list, statuses, project: 'w3' }), 'done'), []);
assert.equal(board.columns({ workspaces, list: { byId: Object.fromEntries([summary('n1', { title: undefined, displayTitle: 'acme' })]) }, statuses: new Map(), meta: { n1: { prompt: 'Make a chess game\nwith tests', tags: [], at: 1 } } }).recent[0].title,
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
assert.deepEqual(recentOf({ fresh: new Set(['s4']) }), ['w1'], 'finished behind a panel, not seen yet');
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
// Hidden chats (× and Clear all): left out of Done only; a hidden chat that runs or waits shows again.
v = board.columns({ workspaces, list, statuses, hidden: new Set(['s4', 's9', 's1', 's2']) });
assert.deepEqual(ids(v, 'done'), [], 'hidden finished chats are not in Done'); assert.deepEqual(v.recent.map((c) => c.id), ['s8', 's7'], 'nor in Recently finished');
assert.deepEqual(v.clearIds, ['s8', 's7'], 'Clear all takes the shown read finished ids'); assert.equal(v.unreadDone, 0);
assert.deepEqual(v.removed.map((c) => c.id), ['s4', 's9'], 'Removed: the hidden finished chats, newest first (not the ones that run or wait)');
assert.equal(v.removed[0].state, 'unread', 'a removed card keeps its state');
assert.deepEqual(ids(v, 'review'), ['s1'], 'a hidden chat that waits for you shows in Review');
assert.deepEqual(ids(v, 'doing'), ['s2', 's3'], 'a hidden chat that runs shows in Doing');
assert.deepEqual(v.counts, { running: 2, waiting: 1 }, 'the counts are the same');
v = board.columns({ workspaces, list, statuses, hidden: new Set(['s7']), project: 'w1' });
assert.deepEqual(v.clearIds, ['s8', 's9'], 'only the shown project; an unread (green) card stays'); assert.equal(v.unreadDone, 1, 's4 is unread');
assert.deepEqual(v.removed.map((c) => c.id), ['s7'], 'Removed of the shown project');
assert.deepEqual(board.columns({ workspaces, list, statuses, hidden: new Set(['s7']), project: 'w3' }).removed, [], 'another project: none');
assert.equal(board.columns({ workspaces, list, statuses, hideDone: true }).columns.length, 3, 'no Hide finished: Done always shows');
const many = { byId: Object.fromEntries(Array.from({ length: 60 }, (_, i) => summary(`m${i}`, { updatedAt: i }))) };
const manyUnread = new Map(Object.keys(many.byId).map((id) => [id, { completionUnread: true }]));
v = board.columns({ workspaces: { items: [], archivedSessionIds: [] }, list: many, statuses: manyUnread });
assert.equal(v.columns[2].cards.length, 50); assert.equal(v.hiddenDone, 10); assert.equal(v.columns[2].cards[0].id, 'm59');
assert.equal(v.unreadDone, 60, 'the unread count also counts the older ones');
assert.equal(board.columns({ workspaces: { items: [] }, list: many, statuses: manyUnread, doneAll: true }).columns[2].cards.length, 60);
// Recently finished: the 10 newest read cards until Show N older; Clear all takes them all.
v = board.columns({ workspaces: { items: [], archivedSessionIds: [] }, list: many, statuses: new Map() });
assert.equal(v.columns[2].cards.length, 0, 'nothing unread: Done has no card'); assert.equal(v.hiddenDone, 0);
assert.equal(v.recent.length, 10); assert.equal(v.recent[0].id, 'm59'); assert.equal(v.recentCount, 60);
assert.equal(v.clearIds.length, 60, 'Clear all also takes the older ones behind Show N older');
assert.equal(board.columns({ workspaces: { items: [] }, list: many, statuses: new Map(), recentAll: true }).recent.length, 60);
// The new task's blank chat is the first card of Doing (no other blank chat); once it has a message it is a normal card.
v = board.columns({ workspaces, list, statuses, task: 's5' });
assert.deepEqual(v.columns.map((c) => c.status), ['doing', 'review', 'done'], 'a new task waits: still no Todo');
assert.deepEqual(ids(v, 'doing'), ['s5', 's2', 's3'], 'the new task before its first message: first in Doing'); assert.equal(v.columns[0].cards[0].state, 'draft');
assert.deepEqual(ids(board.columns({ workspaces, list, statuses, task: 's5', project: 'w3' }), 'doing'), [], 'only in its own project');
assert.deepEqual(ids(board.columns({ workspaces, list, statuses, task: 's1' }), 'doing'), ['s2', 's3'], 'a chat with a message is not a draft');
assert.equal(board.columns({ workspaces, list, statuses, task: 's5' }).counts.running, 2, 'the new task is not counted as running');

// The store: read, then only a newer rev; the poll stops with the page.
board.start(); await tick();
assert.equal(board.getSnapshot().meta.s1.tags[1], 'game');
const polls = () => timers.filter((x) => x.ms === 2000).length;
assert.equal(polls(), 1, 'one poll timer');
await board.load(); assert.equal(gets.at(-1).rev, '1', 'a poll sends its rev');
board.stop(); assert.equal(polls(), 0, 'leaving the page stops the poll');
board.setProject('w1'); assert.equal(JSON.parse(mem.get('dsh-composer-plus.board.project')), 'w1', 'the project choice stays');
assert.equal(board.toggleHideDone, undefined, 'no Hide finished'); assert.equal('hideDone' in board.getSnapshot(), false);
assert.deepEqual([...board.getSnapshot().hidden], [], 'the Host\'s list of hidden chats');

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
assert.equal(cards.length, 4, 'Doing 2, Review 1, Done 1 unread card; the 3 read cards are in a closed Recently finished (the blank one is no task now)');
// Recently finished: a quiet row under the unread cards in Done; it opens the read cards in place (kept on this device).
{
  const pg = () => page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
  const doneCol = (el) => find(el, (n) => n.p?.['data-cpb-column'] === 'done')[0];
  const doneIds = (el) => find(doneCol(el), (n) => n.p?.['data-cpb-card'] !== undefined).map((n) => n.p['data-cpb-card']);
  const row = (el) => find(doneCol(el), (n) => n.p?.['data-cpb-recent-done'] !== undefined)[0];
  let el = pg();
  assert.equal(board.getSnapshot().recentOpen, false, 'closed by default');
  assert.deepEqual(doneIds(el), ['s4'], 'Done: the unread card only');
  assert.equal(row(el).p['aria-expanded'], false); assert.equal(row(el).c.at(-1).c[0], 'board.recentDone', 'Recently finished (N)');
  assert.equal(find(doneCol(el), (n) => n.p?.className === 'cpb-count')[0].c[0], '1', 'the Done count is the unread cards');
  assert.equal(find(doneCol(el), (n) => n.p?.['data-cpb-clear-all'] !== undefined).length, 0, 'closed: no Clear all (it never takes cards that you do not see)');
  row(el).p.onClick(); el = pg();
  assert.equal(board.getSnapshot().recentOpen, true); assert.equal(mem.get('dsh-composer-plus.board.recentDone'), 'true', 'kept on this device');
  assert.equal(row(el).p['aria-expanded'], true);
  assert.deepEqual(doneIds(el), ['s4', 's8', 's9', 's7'], 'open: the read cards under the row, newest first');
  const items = find(doneCol(el), (n) => n.p?.className === 'cpb-list')[0].c;
  assert.deepEqual(items.map((n) => n.p['data-cpb-card'] ?? (n.p['data-cpb-recent-done'] !== undefined ? 'row' : n.p.key)), ['s4', 'row', 's8', 's9', 's7'], 'unread first, then the row, then the read cards');
  assert.equal(find(doneCol(el), (n) => n.p?.['data-cpb-clear-all'] !== undefined).length, 1, 'open: Clear all');
  assert.equal(find(doneCol(el), (n) => n.p?.['data-cpb-recent-older'] !== undefined).length, 0, '3 read cards: no Show N older');
  row(el).p.onClick(); assert.equal(board.getSnapshot().recentOpen, false); assert.equal(mem.get('dsh-composer-plus.board.recentDone'), 'false');
  assert.match(src, /\.cpb-rdone\[aria-expanded=true\]>svg\{transform:none\}/, 'the chevron turns when it opens');
  // Many read cards: 10, then Show N older; a project pick starts again at 10.
  const many = { byId: Object.fromEntries(Array.from({ length: 14 }, (_, i) => summary(`r${i}`, { updatedAt: i }))) };
  const pgMany = () => page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(many), useSessionStatus: (f) => f(new Map()), useWorkspaces: (f) => f({ items: [], archivedSessionIds: [] }), t: (k) => k });
  board.toggleRecentDone(); el = pgMany();
  assert.equal(doneIds(el).length, 10, 'the 10 newest');
  const older = find(doneCol(el), (n) => n.p?.['data-cpb-recent-older'] !== undefined)[0];
  assert.equal(older.c[0], 'board.showOlder'); older.p.onClick();
  assert.equal(doneIds(pgMany()).length, 14, 'Show N older: all of them');
  board.setProject('all'); assert.equal(doneIds(pgMany()).length, 10, 'a project pick shows the 10 newest again');
  board.toggleRecentDone();
}
const card = cards.find((n) => n.p['data-cpb-card'] === 's4');
card.p.onClick({ target: { closest: () => null } }); assert.deepEqual(opened, ['s4'], 'a click opens the chat');
// A card that waits for you: a click (or Enter) opens the answer panel, not the chat (the panel has Open chat).
{
  const orange = cards.find((n) => n.p['data-cpb-card'] === 's1');
  assert.equal(orange.p['aria-haspopup'], 'dialog', 'a screen reader hears that it opens a panel'); assert.equal(card.p['aria-haspopup'], undefined, 'other cards open the chat');
  orange.p.onClick({ target: { closest: () => null } });
  assert.equal(board.getSnapshot().answering, 's1', 'a click on an orange card opens Answer'); assert.deepEqual(opened, ['s4'], 'and not the chat');
  board.close();
  let prevented = 0;
  orange.p.onKeyDown({ key: 'Enter', target: 'self', currentTarget: 'self', preventDefault() { prevented += 1; } });
  assert.equal(board.getSnapshot().answering, 's1', 'Enter on it opens Answer too'); assert.equal(prevented, 1); assert.deepEqual(opened, ['s4']);
  board.close();
}
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
// The projects are a dropdown at the top of the board (no side column): closed, the page shows no project list.
const side = () => page[1]({ ...injected, openSession: () => {}, useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
const navNames = (el) => find(el, (n) => n.p?.className === 'cpb-nav').map((n) => n.c[1].c[0]);
const menuOf = (e) => find(e, (n) => n.p?.['data-cpb-projects-menu'] !== undefined)[0];
const projectButton = (e) => find(e, (n) => n.p?.['data-cpb-project-button'] !== undefined)[0];
let el = side();
assert.equal(menuOf(el), undefined, 'closed: no project list'); assert.deepEqual(navNames(el), []);
assert.doesNotMatch(src, /cpb-side|cpb-brand/, 'no side column next to the board');
assert.equal(find(find(el, (n) => n.t === 'header')[0], (n) => n.p?.['data-cpb-project-button'] !== undefined).length, 1, 'the project button is at the top of the board');
assert.equal(projectButton(el).p['aria-expanded'], false); assert.equal(projectButton(el).p['aria-label'], 'board.projects: board.allProjects');
assert.equal(find(projectButton(el), (n) => n.p?.['data-cpb-waiting'] !== undefined).length, 1, 'a chat waits for you: the orange dot on the closed list');
projectButton(el).p.onClick(); el = side();
assert.equal(projectButton(el).p['aria-expanded'], true, 'a click opens the list');
assert.equal(menuOf(el).p.id, projectButton(el).p['aria-controls']);
// The project list: the search box and the filter; no match shows a note.
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
// The header has no Hide finished button any more.
assert.equal(find(el, (n) => n.p?.['data-cpb-hide-done'] !== undefined).length, 0, 'no Hide finished');
assert.doesNotMatch(src, /board\.hideDone|cpb-toggle|BOARD_KEYS\.hideDone/, 'no Hide finished text, style or saved choice');
assert.match(src, /\.cpb-main\{[^}]*container-type:inline-size/, 'the header reacts to the board width, not the window');
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
// Enter in Search projects picks the first project that the list shows and closes the list; an empty box or no match
// does nothing. A click on a row picks it. Esc and Tab out close the list; the board stays.
{
  const searchOf = (e) => find(e, (n) => n.p?.['data-cpb-search'] !== undefined)[0];
  const enter = (e) => { let prevented = 0; searchOf(e).p.onKeyDown({ key: 'Enter', preventDefault() { prevented += 1; }, stopPropagation() {}, nativeEvent: {} }); return prevented; };
  board.setProject('all'); board.toggleProjects(true);
  assert.equal(enter(side()), 1, 'Enter does not submit anything else'); assert.equal(board.getSnapshot().project, 'all', 'an empty box: nothing');
  assert.equal(board.getSnapshot().projectsOpen, true, 'and the list stays');
  board.setQuery('zzz'); enter(side()); assert.equal(board.getSnapshot().project, 'all', 'no match: nothing');
  board.setQuery('BL'); searchOf(side()).p.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {}, nativeEvent: { isComposing: true } });
  assert.equal(board.getSnapshot().project, 'all', 'Enter that ends an IME composition picks nothing');
  enter(side());
  assert.equal(board.getSnapshot().project, 'w3', 'Enter: the first match (blog)'); assert.equal(JSON.parse(mem.get('dsh-composer-plus.board.project')), 'w3', 'the pick stays');
  assert.equal(board.getSnapshot().projectsOpen, false, 'the list closes'); assert.equal(board.getSnapshot().query, '', 'and its box empties');
  el = side(); assert.equal(projectButton(el).p['aria-label'], 'board.projects: blog', 'the top shows the picked project'); assert.equal(projectButton(el).p.title, 'blog\n/w/blog/');
  assert.equal(find(find(el, (n) => n.t === 'h1')[0], (n) => n.c?.[0] === 'blog').length, 1, 'its name is the heading');
  board.toggleProjects(true); board.toggleRecent(); board.setQuery('a');
  enter(side()); assert.equal(board.getSnapshot().project, 'w1', 'with Active in the last 2 hours: the first project that the list shows (acme, not blog)');
  board.toggleRecent();
  board.toggleProjects(true);
  find(side(), (n) => n.p?.className === 'cpb-nav' && n.c[1]?.c?.[0] === 'board.allProjects')[0].p.onClick();
  assert.equal(board.getSnapshot().project, 'all', 'a click picks All projects'); assert.equal(board.getSnapshot().projectsOpen, false, 'and closes the list');
  board.toggleProjects(true);
  find(side(), (n) => n.p?.className === 'cpb-nav' && n.c[1]?.c?.[0] === 'blog')[0].p.onClick();
  assert.equal(board.getSnapshot().project, 'w3', 'a click picks a project');
  // Esc in the list closes it; it does not reach the page (the page would close a panel).
  board.toggleProjects(true); board.setQuery('bl');
  let stops = 0; const esc = { key: 'Escape', preventDefault() {}, stopPropagation() { stops += 1; } };
  menuOf(side()).p.onKeyDown(esc);
  assert.equal(board.getSnapshot().projectsOpen, false, 'Esc closes the list'); assert.equal(stops, 1); assert.equal(board.getSnapshot().query, '', 'a closed list forgets its search');
  board.toggleProjects(); assert.equal(board.getSnapshot().projectsOpen, true, 'a second click on the button: open'); board.toggleProjects(); assert.equal(board.getSnapshot().projectsOpen, false, 'and closed');
  // Tab out of the list (the focus goes to a card): closed. A focus inside it, or no new focus (a click on the page): open.
  board.toggleProjects(true); el = side();
  const wrap = find(el, (n) => n.p?.className === 'cpb-pwrap')[0];
  const inside = {}; wrap.p.ref.current = { contains: (x) => x === inside };
  wrap.p.onBlur({ relatedTarget: inside }); assert.equal(board.getSnapshot().projectsOpen, true, 'focus inside: open');
  wrap.p.onBlur({ relatedTarget: null }); assert.equal(board.getSnapshot().projectsOpen, true, 'no new focus: open (a press outside closes it)');
  wrap.p.onBlur({ relatedTarget: {} }); assert.equal(board.getSnapshot().projectsOpen, false, 'focus outside: closed');
  assert.match(src, /if \(s\.projectsOpen\) \{ event\.preventDefault\(\); board\.toggleProjects\(false\); return; \}/, 'Esc on the page closes an open list first');
  assert.match(src, /\.cpb-drop\{position:absolute;[^}]*z-index:20/, 'the list opens over the columns');
  assert.match(src, /\.cpb-drop\{[^}]*max-height:min\(/, 'a long list stays in the window');
  board.start(); board.toggleProjects(true); board.setQuery('bl'); board.stop(); await tick();
  assert.equal(board.getSnapshot().projectsOpen, false, 'leaving the board closes the list'); assert.equal(board.getSnapshot().query, '');
  board.setProject('all');
}
assert.match(src, /\.cpb-col\{flex:1 1 0;min-width:140px/, 'the columns share the width');

// × and Clear all: only in Done; one hide at a time in every entry point; the cards go at once; the Host's answer is the
// list; a read that started before the answer does not bring the cards back; a failure brings them back with its reason.
{
  const pgOf = () => page[1]({ ...injected, openSession: (id) => opened.push(id), useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), t: (k) => k });
  board.setProject('all'); hiddenIds = []; await board.load(true);
  board.toggleRecentDone(); assert.equal(board.getSnapshot().recentOpen, true, 'Recently finished is open for this part');
  let el = pgOf();
  const col = (e, st) => find(e, (n) => n.p?.['data-cpb-column'] === st)[0];
  const xs = (e, st) => find(col(e, st), (n) => n.p?.['data-cpb-hide'] !== undefined).map((n) => n.p['data-cpb-hide']);
  const cardIds = (e, st) => find(col(e, st), (n) => n.p?.['data-cpb-card'] !== undefined).map((n) => n.p['data-cpb-card']);
  assert.deepEqual(xs(el, 'done'), ['s4', 's8', 's9', 's7'], 'each finished card (unread and Recently finished) has its ×');
  assert.deepEqual([...xs(el, 'doing'), ...xs(el, 'review')], [], 'only Done cards have the ×');
  const x4 = find(col(el, 'done'), (n) => n.p?.['data-cpb-hide'] === 's4')[0];
  assert.equal(x4.p['aria-label'], 'board.hideCard: Title s4', 'the × names its card for a screen reader'); assert.equal(x4.p.title, 'board.hideCard');
  assert.equal(x4.t, 'button', 'a real button: a click on it does not open the chat (the card skips clicks on a button)');
  const top4 = find(find(col(el, 'done'), (n) => n.p?.['data-cpb-card'] === 's4')[0], (n) => n.p?.className === 'cpb-cardtop')[0];
  assert.equal(find(top4, (n) => n.p?.['data-cpb-hide'] !== undefined).length, 0, 'the × is not next to the title (the title keeps the full width)');
  const clear = find(col(el, 'done'), (n) => n.p?.['data-cpb-clear-all'] !== undefined);
  assert.equal(clear.length, 1, 'Clear all is in the Done column'); assert.equal(clear[0].c[0], 'board.clearAll'); assert.equal(clear[0].p.title, 'board.clearAllHint');
  assert.equal(find(col(el, 'doing'), (n) => n.p?.['data-cpb-clear-all'] !== undefined).length, 0, 'only in Done');
  // × on s4: it goes at once, a second hide (Clear all, another ×) while it runs does nothing.
  const release = hold(); posts.length = 0;
  const one = x4.p.onClick(); await tick();
  el = pgOf();
  assert.deepEqual(cardIds(el, 'done'), ['s8', 's9', 's7'], 'the card goes at once');
  assert.equal(find(col(el, 'done'), (n) => n.p?.['data-cpb-clear-all'] !== undefined)[0].p.disabled, true, 'Clear all waits while a hide runs');
  assert.equal(find(col(el, 'done'), (n) => n.p?.['data-cpb-hide'] === 's8')[0].p.disabled, true, 'and each ×');
  assert.equal(await board.hide(['s8']), false, 'a second hide while one runs (any entry point) does nothing');
  // A read that the Host answered before the hide ends after the hide's answer: it does not bring s4 back.
  let openGet; getGate = { promise: new Promise((r) => { openGet = r; }) };
  const loading = board.load(true); await tick();
  release(); assert.equal(await one, true);
  getGate = null; openGet(); await loading;
  assert.deepEqual(posts, [{ hide: ['s4'] }], 'one request, with only that chat');
  assert.deepEqual([...board.getSnapshot().hidden], ['s4'], 'the Host\'s answer is the list');
  el = pgOf(); assert.deepEqual(cardIds(el, 'done'), ['s8', 's9', 's7'], 'a read that started before the answer does not bring it back');
  // Undo shows after the ×, for 8 s; its timer ends it.
  const undoBar = (e) => find(e, (n) => n.p?.['data-cpb-undo'] !== undefined)[0];
  assert.deepEqual(board.getSnapshot().undo, ['s4'], 'Undo for the card that went');
  assert.equal(undoBar(el).c[0], 'board.undo'); assert.equal(find(el, (n) => n.p?.['data-cpb-undo-bar'] !== undefined)[0].c[0].c[0], 'board.undoText');
  const undoTimers = () => timers.filter((x) => x.ms === 8000);
  assert.equal(undoTimers().length, 1, 'one Undo timer'); undoTimers()[0].f();
  assert.equal(board.getSnapshot().undo, null, 'after 8 s Undo goes'); assert.equal(undoBar(pgOf()), undefined);
  // Removed (1): its panel lists s4 and puts it back.
  el = pgOf();
  const removedButton = find(col(el, 'done'), (n) => n.p?.['data-cpb-removed'] !== undefined)[0];
  assert.equal(removedButton.c[0], 'board.removed', 'Removed (N) under Done'); removedButton.p.onClick();
  const removedPanel = () => { const n = find(pgOf(), (x) => typeof x.t === 'function' && x.t.name === 'BoardRemoved')[0]; return n.t(n.p); };
  let rp = removedPanel();
  assert.equal(rp.p['data-cpb-panel'], 'removed');
  assert.deepEqual(find(rp, (n) => n.p?.['data-cpb-removed-card'] !== undefined).map((n) => n.p['data-cpb-removed-card']), ['s4'], 'the removed card');
  const putBack = find(rp, (n) => n.p?.['data-cpb-unhide'] === 's4')[0];
  assert.equal(putBack.c[0], 'board.putBack'); assert.equal(putBack.p['aria-label'], 'board.putBack: Title s4');
  posts.length = 0;
  const back = hold(); const backing = putBack.p.onClick(); await tick();
  assert.deepEqual(cardIds(pgOf(), 'done'), ['s4', 's8', 's9', 's7'], 'Put back: the card is in Done at once');
  assert.equal(find(removedPanel(), (n) => n.p?.['data-cpb-unhide'] !== undefined).length, 0, 'and not in Removed');
  assert.equal(await board.hide(['s8']), false, 'no hide while a put back runs');
  assert.equal(find(col(pgOf(), 'done'), (n) => n.p?.['data-cpb-hide'] === 's8')[0].p.disabled, true, 'the × waits too');
  back(); await backing; await tick(); await tick(); assert.deepEqual(posts, [{ unhide: ['s4'] }], 'one request');
  assert.deepEqual([...board.getSnapshot().hidden], [], 'the Host\'s answer');
  board.close(); assert.equal(board.getSnapshot().removedOpen, false, 'Esc or ✕ closes Removed');
  // Clear all asks first: the count and the project; an unread (green) card stays.
  el = pgOf(); posts.length = 0;
  find(col(el, 'done'), (n) => n.p?.['data-cpb-clear-all'] !== undefined)[0].p.onClick();
  assert.deepEqual(posts, [], 'no request before the answer');
  assert.deepEqual(board.getSnapshot().clearing, { ids: ['s8', 's9', 's7'], unread: 1, project: undefined }, 'the read cards; s4 is unread and stays');
  const dialog = () => { const n = find(pgOf(), (x) => typeof x.t === 'function' && x.t.name === 'BoardClearDialog')[0]; return n.t(n.p); };
  let d = dialog();
  assert.equal(d.p.title, 'board.clearTitle'); assert.equal(d.p.description, 'board.clearAllProjects', 'All projects: it says so');
  assert.equal(find(d, (n) => n.p?.['data-cpb-clear-note'] !== undefined)[0].c[0], 'board.clearKeep', 'the chats stay in dsh');
  assert.equal(find(d, (n) => n.p?.['data-cpb-clear-unread'] !== undefined)[0].c[0], 'board.clearUnread', 'the unread cards that stay');
  find(d.p.footer, (n) => n.p?.['data-cpb-clear-cancel'] !== undefined)[0].p.onClick();
  assert.equal(board.getSnapshot().clearing, null, 'Cancel: nothing goes'); assert.deepEqual(posts, []);
  board.setProject('w1'); el = pgOf();
  find(col(el, 'done'), (n) => n.p?.['data-cpb-clear-all'] !== undefined)[0].p.onClick();
  d = dialog(); assert.equal(d.p.description, 'board.clearProject', 'a project: its name'); assert.equal(board.getSnapshot().clearing.project, 'acme');
  find(d.p.footer, (n) => n.p?.['data-cpb-clear-confirm'] !== undefined)[0].p.onClick(); await tick(); await tick();
  assert.equal(board.getSnapshot().clearing, null, 'the dialog closes');
  assert.deepEqual(posts, [{ hide: ['s8', 's9', 's7'] }], 'Clear all sends the read cards that were in Done at the click');
  el = pgOf(); assert.deepEqual(cardIds(el, 'done'), ['s4'], 'the unread card stays');
  assert.equal(find(col(el, 'done'), (n) => n.p?.['data-cpb-clear-all'] !== undefined).length, 0, 'only unread cards: no Clear all');
  assert.equal(find(col(el, 'done'), (n) => n.p?.['data-cpb-recent-done'] !== undefined).length, 0, 'no read card: no Recently finished row');
  assert.deepEqual(cardIds(el, 'review'), ['s1'], 'Review stays'); assert.deepEqual(cardIds(el, 'doing'), ['s2', 's3'], 'Doing stays');
  assert.equal(await board.confirmClear(), false, 'the question is gone: a second confirm does nothing');
  // Undo puts back the whole Clear all.
  posts.length = 0;
  assert.equal(await undoBar(pgOf()).p.onClick(), undefined); await tick(); await tick();
  assert.deepEqual(posts, [{ unhide: ['s8', 's9', 's7'] }], 'Undo puts back every card of the last removal');
  assert.deepEqual(cardIds(pgOf(), 'done'), ['s4', 's8', 's9', 's7']); assert.equal(board.getSnapshot().undo, null, 'Undo goes after it');
  assert.equal(await board.undo(), false, 'nothing to undo');
  board.setProject('all');
  // One change of the list at a time also for Clear all: no question while a hide runs, no confirm while one runs.
  const busy = hold(); const running = board.hide(['s7']); await tick();
  assert.equal(board.askClear(['s8'], 0), false, 'no question while a hide runs');
  busy(); await running; board.askClear(['s8'], 0);
  const busy2 = hold(); const again = board.unhide(['s7']); await tick();
  assert.equal(await board.confirmClear(), false, 'no confirm while a put back runs');
  assert.deepEqual(board.getSnapshot().clearing?.ids, ['s8'], 'and the question stays open (it is not lost)'); busy2(); await again;
  board.cancelClear(); hiddenIds = []; await board.load(true);
  // A failed put back: the card goes back to Removed with the reason.
  await board.hide(['s9']); refuse = { status: 500, error: 'disk busy' };
  assert.equal(await board.unhide(['s9']), false); assert.equal(board.getSnapshot().toast, 'disk busy');
  assert.equal(cardIds(pgOf(), 'done').includes('s9'), false, 'a failed put back leaves the card off'); assert.equal(board.getSnapshot().unhiding, null);
  hiddenIds = []; await board.load(true); board.reset();
  // A failure: the cards come back, the reason shows.
  hiddenIds = []; await board.load(true);
  refuse = { status: 500, error: 'disk full' };
  assert.equal(await board.hide(['s4']), false);
  assert.equal(board.getSnapshot().toast, 'disk full', 'the reason shows'); assert.equal(board.getSnapshot().hiding, null);
  assert.deepEqual(cardIds(pgOf(), 'done'), ['s4', 's8', 's9', 's7'], 'a failed hide brings the cards back');
  assert.equal(await board.hide([]), false, 'nothing to hide: no request');
  // An older Host half (no list in its answer): no × and no Clear all.
  const realFetch = globalThis.fetch;
  let oldPosts = 0;
  globalThis.fetch = async (url, init) => { if (init?.method === 'POST') { oldPosts += 1; return Response.json({ rev: 78, sessionId: 'x' }); } return Response.json({ rev: 77, chats }); };
  await board.load(true);
  assert.equal(board.getSnapshot().hidden, null);
  el = pgOf(); assert.deepEqual(xs(el, 'done'), [], 'an older Host: no ×'); assert.equal(find(el, (n) => n.p?.['data-cpb-clear-all'] !== undefined).length, 0, 'and no Clear all');
  assert.equal(find(el, (n) => n.p?.['data-cpb-removed'] !== undefined).length, 0, 'and no Removed');
  assert.equal(await board.hide(['s4']), false, 'and no hide'); assert.equal(await board.unhide(['s4']), false, 'and no put back');
  assert.equal(board.askClear(['s4'], 0), false, 'and no question'); assert.equal(oldPosts, 0, 'no request to an older Host');
  globalThis.fetch = realFetch; hiddenIds = []; await board.load(true);
  assert.match(src, /\.cpb-x\{[^}]*flex:none/, 'the × keeps its size next to a long title');
  board.toggleRecentDone();
}

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
  assert.equal(run({ error: 'restart' }).c[0].c[0], 'board.progress.restart{"error":"restart"}', 'an older Host half: restart dsh, not an error');
  // dsh still runs the Host half it started with (no route: dsh's own empty 404) → "restart"; the route's own 404 keeps its text.
  const readProgress = eval(`(${/const readBoardProgress = (async \(id\) => \{[\s\S]*?\n    \});/.exec(src)[1].replace('BOARD_PROGRESS_ROUTE', "'/p'")})`);
  const realFetch = globalThis.fetch;
  for (const [res, want] of [[new Response('', { status: 404 }), 'restart'], [Response.json({ error: 'dsh has no open chat with this id' }, { status: 404 }), 'dsh has no open chat with this id'], [Response.json({ error: 'Task board is off' }, { status: 409 }), 'Task board is off']]) {
    globalThis.fetch = async () => res;
    await assert.rejects(readProgress('s2'), (e) => e.message === want, want);
  }
  globalThis.fetch = async () => Response.json({ mode: 'fast' }); assert.deepEqual(await readProgress('s2'), { mode: 'fast' });
  globalThis.fetch = realFetch;
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
  globalThis.fetch = async () => new Response('', { status: 404 });
  await m.setMode('fast');
  assert.equal(m.getSnapshot().error, 'restart', 'an older Host half: restart dsh'); assert.equal(m.getSnapshot().mode, 'ai');
  assert.match(src, /t\(state\.error === 'restart' \? 'board\.progress\.restart' : 'board\.down'/, 'Settings shows the restart text');
  globalThis.fetch = realFetch;
}

// The board's own unread set (watchFresh): dsh gives no green dot to a chat that finishes while it is the open chat, also
// behind a panel. Such a chat stays unread for the board until it is the open chat with no panel over it, runs again or goes.
{
  const watch = eval(`(${/function watchFresh\(board, status, list, panelInfo\) \{[\s\S]*?\n    \}/.exec(src)[0].replace('function watchFresh', 'function')})`);
  const store = (v) => { const fns = new Set(); return { v, getSnapshot() { return this.v; }, subscribe: (f) => { fns.add(f); return () => fns.delete(f); }, set(n) { this.v = n; for (const f of [...fns]) f(); }, fns }; };
  const row = (id, main, o = {}) => [id, { id, blank: false, running: false, retainedBy: main ? { mainView: 1 } : {}, ...o }];
  const st = store(new Map([['a', { running: true }], ['b', { running: true }]]));
  const ls = store({ byId: Object.fromEntries([row('a', true), row('b', false)]) });
  const panel = store({ activePanelId: 'composer-plus-board' });
  board.setFresh([], [...board.getSnapshot().fresh]);
  const stop = watch(board, st, ls, panel);
  st.set(new Map([['a', { running: false }], ['b', { running: false, completionUnread: true }]]));
  assert.deepEqual([...board.getSnapshot().fresh], ['a'], 'the open chat finished behind the board: unread for the board (b has dsh\'s own dot)');
  st.set(new Map([['a', { running: false }], ['b', { running: false }]]));
  assert.deepEqual([...board.getSnapshot().fresh], ['a'], 'another change keeps it');
  st.set(new Map([['a', { running: true }]])); assert.deepEqual([...board.getSnapshot().fresh], [], 'it runs again: dropped');
  st.set(new Map([['a', { running: false }]])); assert.deepEqual([...board.getSnapshot().fresh], ['a'], 'and finishes behind the board again');
  panel.set({ activePanelId: null }); assert.deepEqual([...board.getSnapshot().fresh], [], 'the chat shows (no panel over it): read');
  // A chat that finishes while you look at it (no panel): never unread. A chat that is not the open chat: dsh's dot does it.
  st.set(new Map([['a', { running: true }]])); st.set(new Map([['a', { running: false }]]));
  assert.deepEqual([...board.getSnapshot().fresh], [], 'finished on screen: read');
  panel.set({ activePanelId: 'composer-plus-board' });
  st.set(new Map([['b', { running: true }]])); st.set(new Map([['b', { running: false }]]));
  assert.deepEqual([...board.getSnapshot().fresh], [], 'not the open chat: not ours');
  // The chat goes away (archived, deleted): dropped.
  st.set(new Map([['a', { running: true }]])); st.set(new Map([['a', { running: false }]]));
  assert.deepEqual([...board.getSnapshot().fresh], ['a']);
  ls.set({ byId: Object.fromEntries([row('b', false)]) }); assert.deepEqual([...board.getSnapshot().fresh], [], 'a chat that went is dropped');
  stop(); assert.equal(st.fns.size + ls.fns.size + panel.fns.size, 0, 'stop removes every listener');
  assert.equal(typeof watch(board, st, ls, undefined), 'function', 'no panelInfo (another dsh): nothing to watch'); assert.equal(st.fns.size, 0, 'and no listener');
  assert.match(src, /\.\.\.injectScope\(\['layout', 'uiSession', 'sessions'\], \(scope\) => \{\n[^\n]*\n[^\n]*\n\s*scope\.effect\(\(\) => watchFresh\(board/, 'the watcher is part of the taskBoard feature (the switch removes it)');
  board.setFresh(['s9']); assert.deepEqual([...board.getSnapshot().fresh], ['s9']);
  const before = board.getSnapshot(); board.setFresh(['s9']); assert.equal(board.getSnapshot(), before, 'a call that changes nothing sets nothing');
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
board.toggleProjects(true); board.setQuery('ac');
await toggles.setFeature('taskBoard', false); await tick();
assert.ok(![...live.values()].some(([o]) => o.key === 'composer-plus-board' || o.id === 'composer-plus-board'), 'page and row removed');
assert.equal(board.getSnapshot().answering, null, 'the panel goes'); assert.equal(board.getSnapshot().task, null, 'the new task is forgotten');
assert.equal(board.getSnapshot().projectsOpen, false, 'the project list closes'); assert.equal(board.getSnapshot().query, '', 'and forgets its search');
assert.equal(board.getSnapshot().fresh.size, 0, 'the board\'s own unread set is forgotten');
assert.equal(commands.some((c) => c.id === 'composerPlus.taskBoard'), false, 'off: no Task board key'); assert.equal(keyFibers, 0, 'off: its scope is gone');
await toggles.setFeature('taskBoard', true); await tick();
assert.equal(commands.filter((c) => c.id === 'composerPlus.taskBoard').length, 1, 'on again: one key, not two');
await toggles.setFeature('taskBoard', false); await tick();
assert.match(src, /document\.addEventListener\('pointerdown', onDown, true\);\n\s*return \(\) => \{ document\.removeEventListener\('pointerdown', onDown, true\); \};/, 'the outside-press listener goes with the list and the page');
console.log('task board: client ok');
