// Project name in the composer: the name comes from dsh's project title, else the last folder of the chat's working
// directory; the pill shows it with the path as tooltip, a click finds the chat in the sidebar (opens the left sidebar,
// parent projects, the project and "Show more", then scrolls and blinks 5 s), and the switch adds and removes its slot.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ on: true }) });
eval(src.replace('    function ComposerHistory({', '    globalThis.__pn = { projectNameOf, ProjectNamePill, locateChat };\n    function ComposerHistory({'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect() {}, useSyncExternalStore: (s, g) => g() };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
const { projectNameOf, ProjectNamePill, locateChat } = globalThis.__pn;

// 1. The name: dsh's project title first; else the folder name of the chat's cwd (or the project's path); else nothing.
const workspaces = { items: [{ workspaceId: 'w1', title: 'Greeter app', path: '/Users/demo/projects/greeter', sessionIds: ['s1'] },
  { workspaceId: 'w2', title: '  ', path: '/Users/demo/projects/party-planner/', sessionIds: ['s2'] }] };
const sessions = { byId: { s1: { cwd: '/Users/demo/projects/greeter' }, s3: { cwd: 'C:\\Users\\demo\\work\\billing\\' } } };
assert.equal(projectNameOf('s1', workspaces, sessions), 'Greeter app', 'dsh\'s project title');
assert.equal(projectNameOf('s2', workspaces, sessions), 'party-planner', 'a blank title falls back to the folder name (trailing slash too)');
assert.equal(projectNameOf('s3', workspaces, sessions), 'billing', 'a Windows path works too');
assert.equal(projectNameOf('s4', workspaces, sessions), null, 'no project, no cwd: nothing');
assert.equal(projectNameOf('s1', undefined, undefined), null, 'stores not loaded yet');

// 2. The pill: name as label, the folder path as tooltip; nothing without a name.
const hook = (value) => (select) => select(value);
const pill = ProjectNamePill({ sessionId: 's1', useWorkspaces: hook(workspaces), useSessions: hook(sessions), t: (k) => k });
assert.equal(pill.t, 'button', 'a button: a click shows the chat in the sidebar');
assert.equal(pill.p.title, '/Users/demo/projects/greeter\nprojectName.locate', 'the folder path, then what a click does');
assert.equal(pill.c.at(-1).c[0], 'Greeter app'); assert.equal(typeof pill.p.onClick, 'function');
assert.equal(ProjectNamePill({ sessionId: 's4', useWorkspaces: hook(workspaces), useSessions: hook(sessions) }), null);

// 2b. Locate: a fake sidebar in which each click draws the next level, as dsh does.
function sidebar({ open = true, projectOpen = false, more = true, parentOpen = true, nested = false } = {}) {
  const state = { open, projectOpen, more: !more, parentOpen, clicks: [] };
  const el = (key, extra = {}) => ({ key, attrs: { ...extra }, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    scrollIntoView(o) { state.scrolled = o; }, click() { state.clicks.push(key); if (key === 'toggle') state.open = true; if (key === 'workspace:w1') state.projectOpen = !state.projectOpen;
      if (key === 'workspace:wp') state.parentOpen = !state.parentOpen; if (key === 'overflow:w1') state.more = true; }, closest() { return this; } });
  const rows = {};
  const draw = () => {
    const list = [];
    if (!state.open) return list;
    if (nested) list.push(rows.wp ??= el('workspace:wp'));
    if (!nested || state.parentOpen) {
      list.push(rows.w1 ??= el('workspace:w1')); rows.w1.attrs['aria-expanded'] = String(state.projectOpen);
      if (state.projectOpen) { if (state.more) list.push(rows.s1 ??= el('session:s1')); else list.push(rows.more ??= el('overflow:w1', { 'aria-expanded': 'false' })); }
    }
    if (nested) rows.wp.attrs['aria-expanded'] = String(state.parentOpen);
    return list;
  };
  const toggle = el('toggle');
  const doc = { querySelector(q) { if (q === '[class*="_panelIcon"]') return state.open ? null : toggle; const rowsNow = draw();
      if (q === '[data-row-key]' || q.startsWith('[data-row-key^=')) return rowsNow[0] ?? null; const key = JSON.parse(q.slice('[data-row-key='.length, -1)); return rowsNow.find((r) => r.key === key) ?? null; },
    querySelectorAll(q) { return draw().filter((r) => 'data-composer-plus-locate' in r.attrs); } };
  const queue = []; const wait = (fn) => queue.push(fn); const run = () => { for (let i = 0; i < 50 && queue.length; i++) queue.shift()(); };
  return { state, doc, wait, run, rows };
}
const ws = { items: [{ workspaceId: 'wp', path: '/p/outer', sessionIds: [] }, { workspaceId: 'w1', path: '/p/outer/inner', sessionIds: ['s1'] }] };
let sb = sidebar({ open: false, projectOpen: false });
locateChat('s1', ws, sb.doc, sb.wait); sb.run();
assert.deepEqual(sb.state.clicks, ['toggle', 'workspace:w1', 'overflow:w1'], 'opens the sidebar, the project, then Show more');
assert.deepEqual(sb.state.scrolled, { block: 'center', behavior: 'smooth' }); assert.ok('data-composer-plus-locate' in sb.rows.s1.attrs, 'the row blinks');
sb = sidebar({ projectOpen: true, more: false }); locateChat('s1', ws, sb.doc, sb.wait); sb.run();
assert.deepEqual(sb.state.clicks, [], 'an open project is never closed: no click when the row is already drawn');
sb = sidebar({ nested: true, parentOpen: false }); locateChat('s1', ws, sb.doc, sb.wait); sb.run();
assert.equal(sb.state.clicks[0], 'workspace:wp', 'project tree: the parent project opens first');
assert.ok(sb.state.clicks.includes('workspace:w1') && 'data-composer-plus-locate' in sb.rows.s1.attrs);
// A second click stops the first search and its blink; the blink ends after 5 s.
const realTimeout = globalThis.setTimeout; const timers = []; globalThis.setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
sb = sidebar(); const first = sidebar({ projectOpen: false }); locateChat('s1', ws, first.doc, first.wait);
locateChat('s1', ws, sb.doc, sb.wait); first.run(); assert.deepEqual(first.state.clicks, ['workspace:w1'], 'the old search stops at the new click');
sb.run(); const blink = timers.find((x) => x.ms === 5000); assert.ok(blink, 'the blink lasts 5 s'); blink.f();
assert.ok(!('data-composer-plus-locate' in sb.rows.s1.attrs), 'then it ends'); globalThis.setTimeout = realTimeout;
// An open sidebar that shows search results (no rows) is never toggled; a closed one is opened once only.
sb = sidebar({ open: false }); sb.doc.querySelector = ((q0) => (q) => (q === '[class*="_panelIcon"]' ? { closest: () => ({ click() { sb.state.clicks.push('toggle'); } }) } : null))();
locateChat('s1', ws, sb.doc, sb.wait); sb.run(); assert.deepEqual(sb.state.clicks, ['toggle'], 'the toggle is clicked once, never again');
// Windows paths: a project inside a closed parent folder opens the parent first.
const win = { items: [{ workspaceId: 'wp', path: 'C:\\work\\outer', sessionIds: [] }, { workspaceId: 'w1', path: 'C:\\work\\outer\\inner\\', sessionIds: ['s1'] }] };
sb = sidebar({ nested: true, parentOpen: false }); locateChat('s1', win, sb.doc, sb.wait); sb.run();
assert.equal(sb.state.clicks[0], 'workspace:wp', 'a Windows parent folder counts too');
// A chat that the view does not show (for example an archived-only filter) gives up after a few tries.
sb = sidebar(); locateChat('s9', { items: [] }, sb.doc, sb.wait); sb.run(); assert.equal(sb.state.scrolled, undefined);

// 3. The switch: on by default; it adds the dock slot left of dsh's pills and removes it again.
let next = 0; const live = new Map();
const slots = { inject: (name, f) => { const off = f(); return () => off(); }, register: (o) => { const k = `${o.name}#${o.id}#${next++}`; live.set(k, o); return () => live.delete(k); } };
plugin.apply({ slots, configForms: { get: () => ({}) }, effect: () => {}, locale: { register: () => () => {}, bind: () => (k) => k, getLocale: () => ({ active: 'en', locales: [] }) },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } }, get: () => undefined, inject: () => ({ dispose() {} }) });
const slot = () => [...live.values()].find((o) => o.id === 'project-name');
assert.equal(slot()?.name, 'conversation.composer.dock'); assert.ok(slot().order < 0, 'before dsh\'s own stats pills (order 0 and 1)');
const settings = [...live.values()].find((o) => o.id === 'composer-plus');
settings.inject().setFeature('projectName', false); assert.equal(slot(), undefined, 'switched off: the pill goes away');
settings.inject().setFeature('projectName', true); assert.ok(slot(), 'switched on again');
console.log('project-name checks passed');
