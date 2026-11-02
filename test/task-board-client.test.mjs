// Task board (client half, real client.js with a fake fetch): the store reads a view and then only asks for a newer rev;
// one change of a card at a time from every entry point (drag, Status, Human, comment, delete); a drag moves the card on
// screen at once and is refused while another change runs; text edits run in order and send the value they started
// from; a refused edit (409) reads the task again and keeps the reason; a new task is a draft that is created only with a
// title (Esc drops it, a close with a title creates it); a failed create puts the draft back; a stopped page stops the
// timer; switching the feature off removes the page, the sidebar row and the draft.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
let timers = []; let timerId = 0;
globalThis.setTimeout = (f, ms) => { const t = { id: ++timerId, f, ms }; timers.push(t); return t.id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
globalThis.document = { visibilityState: 'visible' };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// A fake Host: the board, its rev, and gates to hold an answer.
let rev = 1; const posts = []; const gets = []; let gate = null; let refuse = null;
const view = (project = '/w/acme') => ({ rev, backlog: false, statuses: ['todo', 'doing', 'review', 'done'], project, hiddenDone: 0,
  projects: [{ path: '/w/acme', name: 'acme', slug: 'acme', open: 2, total: 2 }],
  tasks: [{ id: 1, key: 'acme#1', path: '/w/acme', title: 'One', preview: '', tags: [], human: false, status: 'todo', position: 1, comments: 0 },
    { id: 2, key: 'acme#2', path: '/w/acme', title: 'Two', preview: '', tags: [], human: true, status: 'todo', position: 2, comments: 0 }] });
const task = (id, extra = {}) => ({ id, key: `acme#${id}`, ...view().tasks.find((x) => x.id === id), description: 'Start', comments: [], project: 'acme', ...extra });
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('/api/composer-plus.board-tasks')) return new Response('{}', { status: 404 });
  if (init?.method !== 'POST') {
    const q = new URLSearchParams(String(url).split('?')[1]);
    gets.push(Object.fromEntries(q));
    if (q.has('task')) return Response.json({ rev, task: task(Number(q.get('task'))) });
    if (q.get('rev') === String(rev)) return Response.json({ rev, same: true });
    return Response.json(view(q.get('project') ?? '/w/acme'));
  }
  const body = JSON.parse(init.body); posts.push(body);
  if (gate) await gate.promise;
  if (refuse) { const r = refuse; refuse = null; return Response.json({ error: r.error }, { status: r.status }); }
  rev += 1;
  if (body.op === 'create') return Response.json({ rev, task: task(3, { title: body.title }) });
  return Response.json({ rev, task: task(body.id) });
};
const hold = () => { let open; gate = { promise: new Promise((r) => { open = r; }) }; return () => { const g = gate; gate = null; open(); return g; }; };

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, confirm: () => true, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: () => {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input' } : {}));
const live = new Map(); let next = 0;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
const page = [...live.values()].find(([o]) => o.name === 'main');
const row = [...live.values()].find(([o]) => o.name === 'sidebar.panellist');
assert.equal(page[0].key, 'composer-plus-board'); assert.equal(row[0].id, 'composer-plus-board', 'the sidebar row opens the same panel');
assert.equal(row[0].label(), 'board.title');
const { board } = page[0].inject();

// Read, then only a newer rev; the poll runs while the page shows and stops with it.
board.start(); await tick();
assert.equal(board.getSnapshot().view.tasks.length, 2); assert.equal(gets[0].project, 'all', 'no saved project: every project first');
const polls = () => timers.filter((x) => x.ms === 2000).length;
assert.equal(polls(), 1, 'one poll timer');
await board.load(); assert.equal(gets.at(-1).rev, '1', 'a poll sends its rev'); assert.equal(board.getSnapshot().view.tasks.length, 2);
board.stop(); assert.equal(polls(), 0, 'leaving the page stops the poll');
await board.setProject('/w/acme'); assert.equal(JSON.parse(mem.get('dsh-composer-plus.board.project')), '/w/acme', 'the project choice stays');

// One change at a time: while a Status change runs, a drag, Human, a comment and a delete do nothing.
let open = hold();
const status = board.change({ op: 'update', id: 1, status: 'doing' }); await tick();
assert.equal(board.getSnapshot().pending, 1);
assert.equal(board.move(2, 'review'), false, 'a drag is refused');
assert.equal(await board.change({ op: 'update', id: 2, human: false }), false, 'Human is refused');
assert.equal(await board.change({ op: 'comment', id: 1, body: 'x' }), false, 'a comment is refused');
assert.equal(posts.length, 1, 'only the first change reached the Host');
open(); await status; await tick();
assert.equal(board.getSnapshot().pending, 0);
// A drag moves the card on screen at once, before the Host answers.
open = hold();
const moved = board.move(2, 'doing', undefined); await tick();
const col = (st) => board.getSnapshot().view.tasks.filter((x) => x.status === st).map((x) => x.id);
assert.deepEqual([col('todo'), col('doing')], [[1], [2]], 'optimistic');
assert.deepEqual(posts.at(-1), { op: 'move', id: 2, status: 'doing' });
assert.equal(board.move(1, 'done'), false, 'a second drag waits');
open(); await moved; await tick();
// A drag while another card is dragged: no poll replaces the board meanwhile.
board.drag(1); const before = gets.length; await board.load(true); assert.equal(gets.length, before, 'no read while dragging'); board.drag(null);

// Text edits run in order and send their start value; a 409 keeps the reason and reads the task again.
await board.open(1); await tick(); assert.equal(board.getSnapshot().task.id, 1);
open = hold();
const e1 = board.edit(1, 'title', 'One!', 'One'); const e2 = board.edit(1, 'description', 'Mine', 'Start');
await tick(); assert.deepEqual(posts.at(-1), { op: 'update', id: 1, title: 'One!', was: { title: 'One' } }, 'the first edit goes first');
open(); await e1; await e2;
assert.deepEqual(posts.at(-1), { op: 'update', id: 1, description: 'Mine', was: { description: 'Start' } }, 'then the second, with its start value');
refuse = { status: 409, error: 'the description changed meanwhile' };
const reads = gets.filter((g) => g.task === '1').length;
assert.equal(await board.edit(1, 'description', 'Other', 'Old'), false);
assert.equal(board.getSnapshot().toast, 'the description changed meanwhile', 'the reason shows');
assert.equal(gets.filter((g) => g.task === '1').length, reads + 1, 'the task is read again');

// New task: a draft; nothing is created without a title; Esc drops it; a close with a title creates it.
board.newTask(); assert.equal(board.getSnapshot().draft.project, '/w/acme');
const count = posts.length;
assert.equal(await board.create(), false, 'no title: nothing'); assert.equal(posts.length, count);
board.discard(); assert.equal(board.getSnapshot().draft, null); assert.equal(posts.length, count, 'Esc: nothing created');
board.newTask(); board.editDraft({ title: 'Ship it', tags: 'release' });
open = hold();
const c1 = board.create(); const c2 = board.create(); await tick();
assert.equal(await c2, false, 'a second create while one runs');
open(); assert.equal(await c1, true);
assert.deepEqual(posts.filter((p) => p.op === 'create'), [{ op: 'create', project: '/w/acme', title: 'Ship it', tags: 'release' }], 'one create');
await tick(); assert.equal(board.getSnapshot().draft, null); assert.equal(board.getSnapshot().taskId, 3, 'the new task opens');
// A failed create puts the draft back with its text.
board.newTask(); board.editDraft({ title: 'Keep me' });
refuse = { status: 400, error: 'a title has at most 300 characters' };
board.close(); await tick();
assert.equal(board.getSnapshot().draft?.title, 'Keep me', 'not lost'); assert.equal(board.getSnapshot().toast, 'a title has at most 300 characters');

// The off state and an older Host.
refuse = null;
globalThis.fetch = async () => Response.json({ error: 'Task board is off' }, { status: 409 });
await board.load(true); assert.equal(board.getSnapshot().off, true);
globalThis.fetch = async () => new Response('', { status: 404 });
await board.load(true); assert.equal(board.getSnapshot().restart, true);

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
assert.ok(/feature\('taskBoard', \(\) => \[ctx\.slots\.inject\('main'/.test(src), 'installed with feature(id, setup)');

// Switching the feature off removes the page, the sidebar row and a draft.
const toggles = [...live.values()].find(([o]) => o.id === 'composer-plus')[0].inject();
globalThis.fetch = async (url, init) => (url === '/api/composer-plus.board' ? Response.json({ on: JSON.parse(init?.body ?? '{"on":true}').on, backlog: false }) : Response.json({}, { status: 409 }));
board.newTask(); board.editDraft({ title: '' });
await toggles.setFeature('taskBoard', false); await tick();
assert.ok(![...live.values()].some(([o]) => o.key === 'composer-plus-board' || o.id === 'composer-plus-board'), 'page and row removed');
assert.equal(board.getSnapshot().draft, null, 'the draft goes');
console.log('task board: client ok');
