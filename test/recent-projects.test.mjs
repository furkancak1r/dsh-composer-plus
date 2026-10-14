// Runs the real client.js RecentProjectsFilter with fake React/DOM: the option joins dsh's open view options menu,
// selecting it hides the projects without activity in the last 2 hours (one style rule on the project sections),
// time passing hides a project that went quiet, the choice survives a reload, and unmounting cleans up.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

// Minimal DOM with only the selectors the component uses.
const node = (attrs = {}, className = '') => ({ attrs, className, children: [], parent: null,
  setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
  append(child) { child.parent = this; this.children.push(child); },
  remove() { if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
  matches(sel) { return sel === '[role="menu"][class*="viewOptionsMenu"]' && this.attrs.role === 'menu' && this.className.includes('viewOptionsMenu'); },
  querySelector(sel) {
    const m = /^:scope > \[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel); assert.ok(m, sel);
    return this.children.find((c) => m[1] in c.attrs && (m[2] === undefined || c.attrs[m[1]] === m[2])) ?? null;
  } });
const body = node();
const all = (n) => [n, ...n.children.flatMap(all)];
globalThis.document = { body, createElement: () => node(),
  querySelector: (sel) => { const name = /^\[([\w-]+)\]$/.exec(sel)[1]; return all(body).find((n) => name in n.attrs) ?? null; } };
let observed = null;
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; }
  observe(target, opts) { assert.equal(target, body); assert.deepEqual(opts, { childList: true }); observed = this.fn; }
  disconnect() { observed = null; } };
let tick = null;
globalThis.setInterval = (fn, ms) => { assert.equal(ms, 60000); tick = fn; return 1; };
globalThis.clearInterval = () => { tick = null; };

let state = [], si = 0, effects = [], prevDeps = [], cleanups = [];
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = si++; if (!(i in state)) state[i] = typeof v === 'function' ? v() : v; return [state[i], (x) => { state[i] = typeof x === 'function' ? x(state[i]) : x; }]; },
  useEffect: (f, deps) => { effects.push([f, deps]); } };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? { MenuItemButton: 'MenuItemButton', IconCheckOutlineRegular: 'Check', IconAlarmClockOutlineRegular: 'Clock' } : {}));
const regs = []; plugin.apply({ slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
const [opt, C] = regs.find(([o]) => o.id === 'recent-projects');
assert.equal(opt.name, 'shell.overlay'); assert.equal(opt.locale, 'dsh-composer-plus');

const H = 3600e3; let now = Date.UTC(2026, 9, 14, 12); Date.now = () => now;
const at = (hours) => now - hours * H;
const summary = (id, o = {}) => [id, { id, blank: false, running: false, origin: 'user', updatedAt: at(5), retainedBy: {}, ...o }];
const list = { phase: 'ready', ids: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'], projectionsBySession: {}, byId: Object.fromEntries([
  summary('s1', { updatedAt: at(1) }), summary('s2', { updatedAt: at(3) }), summary('s3', { running: true }), summary('s4'),
  summary('s5', { updatedAt: at(0.5) }), summary('s6', { blank: true, updatedAt: at(0.1) }), summary('s7', { retainedBy: { mainView: 1 } }),
  summary('s8', { updatedAt: at(1.5) }), summary('s9', { origin: 'subagent', updatedAt: at(0.2) }), summary('s10')]) };
const statuses = new Map([['s4', { pendingInteraction: { kind: 'approval' } }]]);
const ws = (workspaceId, path, sessionIds, added = at(9)) => ({ workspaceId, path, sessionIds, createdAt: new Date(added).toISOString() });
const workspaces = { phase: 'ready', archivedSessionIds: ['s5'], items: [
  ws('recent', '/p/web', ['s1']), ws('old', '/p/old', ['s2']), ws('running', '/p/run', ['s3']), ws('waiting', '/p/wait', ['s4']),
  ws('archived', '/p/arch', ['s5']), ws('blank', '/p/blank', ['s6']), ws('open', '/p/open', ['s7']), ws('added', '/p/new', [], at(0.5)),
  ws('parent', '/p/mono/', []), ws('child', '/p/mono/app', ['s8']), ws('prefix', '/p/mon', []), ws('subagent', '/p/sub', ['s9'])] };

const props = { useWorkspaces: (f) => f(workspaces), useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), t: (k) => k };
const render = () => {
  si = 0; effects = [];
  const out = C(props);
  effects.forEach(([f, deps], i) => {
    if (prevDeps[i] !== undefined && deps.every((d, j) => Object.is(d, prevDeps[i][j]))) return;
    cleanups[i]?.(); cleanups[i] = f(); prevDeps[i] = deps;
  });
  return out;
};
const settle = () => { render(); return render(); }; // effects may set state; the second render shows it
const style = (out) => out.c[0]?.c[0] ?? null;
const hiddenKeys = (out) => [...new Set([...(style(out) ?? '').matchAll(/"workspace:([^"]*)"/g)].map((m) => m[1]))].sort();
const text = (el) => (typeof el === 'string' ? el : el === null || el === undefined || el === false ? '' : el.c.map(text).join(''));
const optionOf = (out) => out.c[1].portal.c[2];

let out = settle();
assert.equal(style(out), null, 'off by default: nothing hidden');
assert.equal(out.c[1], null, 'no menu open, no option');
// dsh opens its view options menu: a <body> child whose viewport holds the native rows.
const menu = node({ role: 'menu' }, 'x_list x_viewOptionsMenu'); const viewport = node({ role: 'presentation' }); menu.append(viewport); body.append(menu);
observed(); out = settle();
const host = viewport.children.find((c) => 'data-composer-plus-recent-projects' in c.attrs);
assert.ok(host, 'rows join the open menu list'); assert.equal(out.c[1].host, host);
const [sep, label, item] = out.c[1].portal.c;
assert.equal(sep.p.role, 'separator'); assert.equal(label.c[0], 'recentProjects.label');
assert.equal(item.t, 'MenuItemButton'); assert.equal(item.p.icon.t, 'Clock'); assert.equal(text(item), 'recentProjects.option', 'no check while off');

// Select: stale projects hide, the choice is stored, the state is announced.
item.p.onSelect(); out = settle();
assert.equal(mem.get('dsh-composer-plus.recentProjects'), '1');
assert.deepEqual(hiddenKeys(out), ['', 'added', 'archived', 'blank', 'old', 'parent', 'prefix', 'subagent'],
  'kept only with an active chat (recent, running, waiting, open); a new or parent project without chats is hidden');
assert.match(style(out), /^\[style\*="--dsh-workspace-indent"\]:has\(> \[data-row-key="workspace:old"\], > \* > \[data-row-key="workspace:old"\]\)/m);
assert.match(style(out), /\{ display: none !important; \}$/);
assert.ok(text(optionOf(out)).endsWith('recentProjects.selected'), 'selected state for screen readers');
assert.equal(optionOf(out).c[0].c[1].c[0].t, 'Check', 'visible check mark');

// Time passes: chats from 1 and 1.5 hours ago become older than 2 hours.
now += 1.2 * H; tick(); out = settle();
assert.deepEqual(hiddenKeys(out), ['', 'added', 'archived', 'blank', 'child', 'old', 'parent', 'prefix', 'recent', 'subagent']);

// Unmount (feature switched off or page closed) and mount again: cleanup, then the stored choice applies.
for (const c of cleanups) c?.(); cleanups = []; prevDeps = [];
assert.equal(observed, null, 'unmount stops watching'); assert.equal(tick, null, 'unmount stops the timer');
assert.ok(!viewport.children.some((c) => 'data-composer-plus-recent-projects' in c.attrs), 'unmount removes its rows from the menu');
state = []; out = settle();
assert.ok(hiddenKeys(out).includes('old'), 'the choice survives a reload');

// Select again: everything shows, storage cleared, no timer.
optionOf(out).p.onSelect(); out = settle();
assert.equal(style(out), null); assert.equal(mem.has('dsh-composer-plus.recentProjects'), false); assert.equal(tick, null, 'no timer while off');
// The menu closes: the option goes with it.
menu.remove(); observed(); out = settle(); assert.equal(out.c[1], null);
console.log('recent-projects checks passed');
