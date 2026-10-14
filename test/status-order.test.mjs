// Runs the real client.js "By status" order with fake React and a mini DOM: the item goes after dsh's "Last updated"
// in the open view options menu; selecting it orders the flat list finished → running/waiting → automated → rest with
// CSS `order` (pinned, archived, blank and subagent chats keep dsh's place); dsh's Manual / Last updated turn it off;
// a Schedule change refreshes the automated chats; the choice survives a reload; unmount cleans up.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

// Mini DOM: [a], [a="v"], [a*="v"] compounds, ':scope > X' and the menu/list selectors the component uses.
const matcher = (compound) => {
  const attrs = [...compound.matchAll(/\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]/g)].map(([, name, op, value]) => ({ name, op, value }));
  return (e) => attrs.every(({ name, op, value }) => { const v = e.getAttribute(name); return v !== null && (op === undefined || (op === '=' ? v === value : op === '^=' ? v.startsWith(value) : v.includes(value))); });
};
const descendants = (e) => e.children.flatMap((c) => [c, ...descendants(c)]);
const listeners = new Map();
class El {
  constructor(attrs = {}, children = []) { this.attrs = { ...attrs }; this.children = []; this.parentElement = null; for (const c of children) this.append(c); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(c) { c.remove(); c.parentElement = this; this.children.push(c); }
  after(c) { c.remove(); const s = this.parentElement.children; s.splice(s.indexOf(this) + 1, 0, c); c.parentElement = this.parentElement; }
  remove() { if (this.parentElement !== null) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; }
  matches(sel) { return matcher(sel)(this); }
  contains(n) { return n === this || descendants(this).includes(n); }
  closest(sel) { for (let e = this; e !== null; e = e.parentElement) if (e.matches(sel)) return e; return null; }
  querySelectorAll(sel) {
    if (!sel.startsWith(':scope > ')) return descendants(this).filter(matcher(sel));
    let level = [this];
    for (const part of sel.slice(':scope > '.length).split(' > ')) { const m = matcher(part); level = level.flatMap((e) => e.children.filter(m)); }
    return level;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  addEventListener(type, fn, capture) { assert.equal(capture, true); listeners.set(this, fn); }
  removeEventListener(type, fn) { if (listeners.get(this) === fn) listeners.delete(this); }
}
const body = new El();
globalThis.document = { body, createElement: () => new El(), querySelector: (s) => body.querySelector(s) };
let observer = null;
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() { observer = this; } disconnect() { observer = null; } };

let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useEffect: (f, deps) => { cur.effects.push([f, deps]); } };
const mount = (C, props) => {
  const inst = { state: [], deps: [], cleanups: [] };
  const render = () => {
    cur = inst; inst.si = 0; inst.effects = [];
    const out = C(props());
    inst.effects.forEach(([f, deps], i) => {
      if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return;
      inst.cleanups[i]?.(); inst.cleanups[i] = f(); inst.deps[i] = deps;
    });
    return out;
  };
  return { settle: async () => { render(); await new Promise((r) => setTimeout(r, 0)); render(); return render(); }, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? { MenuItemButton: 'MenuItemButton', IconCheckOutlineRegular: 'Check' } : {}));
const regs = []; plugin.apply({ slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
const [opt, StatusOrder] = regs.find(([o]) => o.id === 'status-order');
assert.equal(opt.name, 'shell.overlay'); assert.equal(opt.locale, 'dsh-composer-plus'); assert.ok(opt.inject().hooks.schedule.getSnapshot, 'Schedule comes through a store');

// Chats: f finished, r running, w waiting, k parent of a running subagent, a automated, o other, p pinned+finished,
// x archived+finished, b blank, s subagent.
const s = (id, o = {}) => [id, { id, blank: false, running: false, origin: 'user', ...o }];
const list = { ids: ['o', 'a', 'w', 'f', 'r', 'k', 'p', 'x', 'b', 's'], projectionsBySession: { k: { values: { subagentCatalog: [{ id: 's' }] } } },
  byId: Object.fromEntries([s('o'), s('a'), s('w'), s('f'), s('r', { running: true }), s('k'), s('p'), s('x'), s('b', { blank: true }), s('s', { origin: 'subagent', running: true })]) };
const statuses = new Map([['f', { completionUnread: true }], ['w', { pendingInteraction: { kind: 'question' } }], ['p', { completionUnread: true }], ['x', { completionUnread: true }]]);
const workspaces = { pinnedSessionIds: ['p'], archivedSessionIds: ['x'] };
let tasks = [{ sessionId: 'a', status: 'active' }, { sessionId: 'o', status: 'inactive' }];
let changed = null; let reads = 0;
let schedule = { catalog: async () => { reads += 1; return { ok: true, value: tasks }; }, onChange: (fn) => { changed = fn; return () => { changed = null; }; } };
const props = () => ({ useSessions: (f) => f(list), useSessionStatus: (f) => f(statuses), useWorkspaces: (f) => f(workspaces), useSchedule: (f) => f(schedule), t: (k) => k });
const css = (out) => out.c[0]?.c[0] ?? '';
// One rule per rank: its selector list spans several lines, so read each block up to its "{ order: n; }".
const orders = (out) => Object.fromEntries([...css(out).matchAll(/([^{}]+)\{ order: (-?\d+); \}/g)].flatMap(([, sel, n]) => [...sel.matchAll(/"session:(\w+)"/g)].map((m) => [m[1], Number(n)])));

const so = mount(StatusOrder, props);
let out = await so.settle();
assert.equal(out.c[0], null, 'off by default: dsh order'); assert.equal(out.c[1], null, 'no menu, no item'); assert.equal(reads, 0, 'off: Schedule not read');
// dsh opens the view options menu: label rows and item rows (each item row wraps a menuitem button).
const item = (label) => new El({ class: 'itemWrap', 'data-label': label }, [new El({ role: 'menuitem' })]);
const rows = new El({ role: 'presentation' }, [new El({ role: 'presentation', 'data-label': 'Group by' }), item('WorkSpace'), item('Workspace Tree'), item('In one list'),
  new El({ role: 'separator' }), new El({ role: 'presentation', 'data-label': 'Order by' }), item('Manual'), item('Last updated'), new El({ role: 'separator' }), item('Hide archived')]);
const menu = new El({ role: 'menu', class: 'x_list x_viewOptionsMenu' }, [rows]); body.append(menu);
observer.fn(); out = await so.settle();
const host = rows.children[8];
assert.equal(host.getAttribute('data-composer-plus-status-order'), '', 'item goes right after Last updated');
assert.equal(rows.children[7].getAttribute('data-label'), 'Last updated'); assert.equal(out.c[1].host, host);
const button = () => out.c[1].portal;
assert.equal(button().t, 'MenuItemButton'); assert.equal(button().c[0].c[0].c[0], 'statusOrder.option'); assert.equal(button().c[0].c.length, 3);

// Select: finished → running/waiting → automated; pinned, archived, blank and subagent chats keep dsh's place.
button().p.onSelect(); out = await so.settle();
assert.equal(mem.get('dsh-composer-plus.statusOrder'), '1'); assert.ok(reads > 0, 'reads the Schedule catalog');
assert.deepEqual(orders(out), { f: -3, w: -2, r: -2, k: -2, a: -1 });
assert.ok(css(out).startsWith('[role="tree"][class*="_flatList"] { display: flex; flex-direction: column; }'), 'flat list only');
assert.match(css(out), /\[role="tree"\]\[class\*="_flatList"\] > :has\(> \[data-row-key="session:f"\]\) \{ order: -3; \}/);
assert.equal(button().c[0].c[1].c[0].t, 'Check', 'check mark'); assert.equal(button().c[0].c[2].c[0], 'statusOrder.selected', 'state for screen readers');
assert.deepEqual(rows.children.filter((c) => c.getAttribute('data-composer-plus-dsh-order') !== null).map((c) => c.getAttribute('data-label')), ['Manual', 'Last updated'], 'dsh order rows marked');
assert.match(css(out), /\[data-composer-plus-dsh-order\] > \[role="menuitem"\] > svg:last-child \{ visibility: hidden; \}/, 'one check in Order by');

// Changes: opening the finished chat clears dsh's done dot; a new automation; the subagent stops.
statuses.delete('f'); tasks = [...tasks, { sessionId: 'o', status: 'active' }]; list.byId.s.running = false; changed(); out = await so.settle();
assert.deepEqual(orders(out), { w: -2, r: -2, a: -1, o: -1 });

// dsh's own Manual / Last updated turn it off; group rows do not.
const click = (row) => listeners.get(rows)({ target: row.children[0] });
click(rows.children[3]); out = await so.settle(); assert.equal(mem.get('dsh-composer-plus.statusOrder'), '1', '"In one list" keeps it');
click(rows.children[6]); out = await so.settle();
assert.equal(out.c[0], null, 'Manual: dsh order again'); assert.equal(mem.has('dsh-composer-plus.statusOrder'), false); assert.equal(changed, null, 'stops listening to Schedule');

// Reload with the stored choice; no Schedule service: automated chats are simply not ranked.
mem.set('dsh-composer-plus.statusOrder', '1'); schedule = undefined; so.unmount();
assert.equal(observer, null, 'unmount stops watching'); assert.ok(!rows.children.some((c) => c.getAttribute('data-composer-plus-status-order') !== null), 'unmount removes the item host');
out = await mount(StatusOrder, props).settle();
assert.deepEqual(orders(out), { w: -2, r: -2 }, 'stored choice applies after a reload; no Schedule, no automated rank');
console.log('status-order checks passed');
