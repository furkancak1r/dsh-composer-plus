// Runs the real client.js "Copy path" project menu and "Collapse all projects" button with fake React and a mini DOM:
// right-click on a project row opens a menu at the pointer that copies the folder path; the header button goes first
// into dsh's header actions, closes every open project once (innermost first) and keeps the keyboard focus in the header.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

// Mini DOM: tag names, [a], [a="v"], [a^="v"], [a*="v"] and ':scope > A > B' (the selectors the plugin uses).
const matcher = (compound) => {
  const tag = /^[a-z]+/.exec(compound)?.[0];
  const attrs = [...compound.matchAll(/\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]/g)].map(([, name, op, value]) => ({ name, op, value }));
  return (e) => (tag === undefined || e.tagName === tag.toUpperCase()) && attrs.every(({ name, op, value }) => {
    const v = e.getAttribute(name);
    return v !== null && (op === undefined || (op === '=' ? v === value : op === '^=' ? v.startsWith(value) : v.includes(value)));
  });
};
const descendants = (e) => e.children.flatMap((c) => [c, ...descendants(c)]);
class El {
  constructor(tag, attrs = {}, children = []) { this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null; for (const c of children) this.append(c); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(c) { c.remove(); c.parentElement = this; this.children.push(c); }
  prepend(c) { c.remove(); c.parentElement = this; this.children.unshift(c); }
  remove() { if (this.parentElement !== null) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; }
  get nextElementSibling() { const s = this.parentElement?.children ?? []; return s[s.indexOf(this) + 1] ?? null; }
  querySelectorAll(sel) {
    if (!sel.startsWith(':scope > ')) return descendants(this).filter(matcher(sel));
    let level = [this];
    for (const part of sel.slice(':scope > '.length).split(' > ')) { const m = matcher(part); level = level.flatMap((e) => e.children.filter(m)); }
    return level;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel) { const m = matcher(sel); for (let e = this; e !== null; e = e.parentElement) if (m(e)) return e; return null; }
  click() { this.onclick?.(); }
  focus() { document.activeElement = this; }
}
const body = new El('body');
const listeners = {};
globalThis.document = { body, activeElement: body, createElement: (tag) => new El(tag),
  querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s),
  addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: (type, fn) => { if (listeners[type] === fn) delete listeners[type]; } };
let observer = null;
let observed = null;
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; }
  observe(target, opts) { assert.equal(target, body); observed = opts; observer = this; }
  disconnect() { observer = null; } };

// Fake React with per-component hook state; effects rerun when their dependencies change.
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), useCallback: (f) => f,
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; return cur.refs[i] ??= { current: v }; },
  useEffect: (f, deps) => { cur.effects.push([f, deps]); } };
const mount = (C, props) => {
  const inst = { state: [], refs: [], deps: [], cleanups: [] };
  const render = () => {
    cur = inst; inst.si = 0; inst.ri = 0; inst.effects = [];
    const out = C(props);
    inst.effects.forEach(([f, deps], i) => {
      if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return;
      inst.cleanups[i]?.(); inst.cleanups[i] = f(); inst.deps[i] = deps;
    });
    return out;
  };
  return { render, settle: () => { render(); return render(); }, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const copied = [];
const load = (primitives) => {
  const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
    : n === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : {}));
  const regs = []; plugin.apply({ slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
  return (id) => { const reg = regs.find(([o]) => o.id === id); assert.equal(reg[0].name, 'shell.overlay'); assert.equal(reg[0].locale, 'dsh-composer-plus'); return reg[1]; };
};
const find = load({ Menu: 'Menu', Tooltip: 'Tooltip', IconCopyOutlineRegular: 'Copy', writeClipboard: async (text) => { copied.push(text); return true; } });

// --- Copy path ---
let items = [{ workspaceId: 'w1', path: '/Users/demo/acme web' }, { workspaceId: 'w2', path: 'C:\\work\\api' }];
const pm0 = mount(find('project-path-menu'), { useWorkspaces: (f) => f({ items }), t: (k) => k });
// dsh's Menu under <body> (dsh 0.2.2-rc.2 places it at anchorPoint with position: fixed).
const underBody = (r) => { assert.equal(r?.host, document.body, 'under <body>'); assert.equal(r.portal.p.style.position, 'fixed', 'in a fixed box'); return r.portal.c[0]; };
const pm = { settle: () => underBody(pm0.settle()), render: () => underBody(pm0.render()), unmount: pm0.unmount };
let out = pm.settle();
assert.equal(out.t, 'Menu'); assert.equal(out.p.open, false); assert.equal(out.p.portal, true); assert.equal(out.p.autoFocus, true, 'keyboard: the item gets the focus');
assert.equal(typeof listeners.contextmenu, 'function', 'listens for right-clicks');
const rightClick = (target, x = 40, y = 120) => { const e = { target, clientX: x, clientY: y, prevented: 0, preventDefault() { this.prevented += 1; } }; listeners.contextmenu(e); return e; };
const title = new El('span'); const rowW1 = new El('div', { 'data-row-key': 'workspace:w1' }, [title]); body.append(rowW1);
let e = rightClick(title); out = pm.render();
assert.equal(e.prevented, 1, 'a project row gets this menu instead of the browser menu');
assert.equal(out.p.open, true); assert.deepEqual(out.p.getAnchorRect(), { left: 40, right: 40, top: 120, bottom: 120 }, 'opens at the pointer');
assert.deepEqual(out.p.anchorPoint, { x: 40, y: 120 }, 'dsh 0.2.2-rc.2: opens at the pointer (anchorPoint)');
assert.deepEqual(out.p.items.map((i) => [i.id, i.label, i.icon.t]), [['copy-path', 'projectMenu.copyPath', 'Copy']]);
out.p.onSelect('copy-path'); out = pm.render();
assert.deepEqual(copied, ['/Users/demo/acme web'], 'copies the full folder path'); assert.equal(out.p.open, false, 'closes after copying');
rightClick(new El('div', { 'data-row-key': 'workspace:w2' })); pm.render().p.onSelect('copy-path');
assert.equal(copied.at(-1), 'C:\\work\\api', 'a Windows path is copied as is');
for (const target of [new El('div'), new El('div', { 'data-row-key': 'workspace:' }), new El('div', { 'data-row-key': 'workspace:gone' }),
  new El('div', { 'data-row-key': 'session:s1' }), null]) assert.equal(rightClick(target).prevented, 0, 'elsewhere, Ungrouped or unknown: browser menu stays');
assert.equal(pm.render().p.open, false);
rightClick(rowW1); out = pm.render(); assert.equal(out.p.open, true); out.p.onClose(); assert.equal(pm.render().p.open, false, 'Esc / outside click closes');
items = [...items, { workspaceId: 'w3', path: '/p/new' }]; pm.render();
rightClick(new El('div', { 'data-row-key': 'workspace:w3' })); pm.render().p.onSelect('copy-path'); assert.equal(copied.at(-1), '/p/new', 'a project added later works');
pm.unmount(); assert.equal(listeners.contextmenu, undefined, 'unmount removes the listener');
rowW1.remove();
assert.equal(mount(load({})('project-path-menu'), { useWorkspaces: (f) => f({ items }), t: (k) => k }).settle(), null, 'no Menu primitive: nothing');

// --- Collapse all projects ---
// dsh's sidebar: root > [sectionHeader > headerActions > [view options, add], listArea > tree > project sections].
const viewOptions = new El('button', { 'aria-label': 'View options' }); const add = new El('button', { 'aria-label': 'Add workspace' });
const actions = new El('div', { class: 'x_headerActions' }, [new El('span', { class: 'm_root' }, [viewOptions]), add]);
const tree = new El('div', { role: 'tree' });
body.append(new El('div', { class: 'x_root' }, [new El('div', { class: 'x_sectionHeader' }, [new El('span', { class: 'x_sectionLabel' }), actions]),
  new El('div', { class: 'x_listArea' }, [tree])]));
const order = [];
const project = (id, open, ...children) => {
  const row = new El('div', { 'data-row-key': `workspace:${id}`, 'aria-expanded': String(open) });
  row.onclick = () => { order.push(id); row.setAttribute('aria-expanded', String(row.getAttribute('aria-expanded') !== 'true')); }; // dsh's own toggle
  return new El('div', { style: '--dsh-workspace-indent: 0px' }, [row, ...(children.length > 0 ? [new El('div', { role: 'group' }, children)] : [])]);
};
const cb = mount(find('collapse-projects'), { t: (k) => k });
out = cb.settle();
const css = out.c[0].c[0];
// The button shows only while a project is open: the empty host is hidden (no `body:has(…)`, see has-selectors.test.mjs).
assert.ok(!css.includes('body:has('), 'no style rule on the whole page');
assert.ok(css.includes('[data-composer-plus-collapse-projects]:empty { display: none; }'), 'an empty host takes no room');
assert.ok(css.includes('[class*="_headerActions"]:has(> [data-composer-plus-collapse-projects]):not([class*="_headerActionsHidden"]) { max-width: 92px; }'), 'room for a third button');
assert.ok(observed.childList && observed.subtree && observed.attributes && observed.attributeFilter.includes('aria-expanded'), 'a project that opens or closes is seen (the shared body observer)');
assert.equal(out.c[1], null, 'no project rows yet (rail or loading): no button');
// 5 projects, all closed: the host is there, the button is not.
const rows = [project('a', false), project('b', false), project('c', false, project('c1', false)), project('d', false), project('e', false)];
for (const s of rows) tree.append(s);
observer.fn(); out = cb.settle();
const host = actions.children[0];
assert.equal(host.getAttribute('data-composer-plus-collapse-projects'), '', 'the host waits in the header');
assert.equal(out.c[1], null, 'no open project: no button');
// 3 open; "c" holds the child project "c1" (Workspace tree). dsh changes only `aria-expanded` on the rows.
for (const id of ['a', 'c', 'c1']) document.querySelector(`[data-row-key="workspace:${id}"]`).setAttribute('aria-expanded', 'true');
observer.fn(); out = cb.settle();
assert.equal(host.getAttribute('data-composer-plus-collapse-projects'), '', 'first in the header actions');
assert.equal(actions.children[1].children[0], viewOptions, 'dsh buttons keep their order'); assert.equal(actions.children[2], add);
assert.equal(out.c[1].host, host);
const trigger = out.c[1].portal; assert.equal(trigger.t, 'Tooltip'); assert.equal(trigger.p.label, 'collapseProjects.button');
const button = trigger.c[0]; assert.equal(button.t, 'button'); assert.equal(button.p.type, 'button'); assert.equal(button.p['aria-label'], 'collapseProjects.button');
observer.fn(); cb.render(); assert.equal(document.querySelectorAll('[data-composer-plus-collapse-projects]').length, 1, 'one host only');
const domButton = new El('button'); host.append(domButton); // where the portal renders it
button.p.onClick({ currentTarget: domButton, detail: 1 });
assert.deepEqual(order, ['c1', 'c', 'a'], 'every open project closes once, innermost first');
assert.equal(document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="true"]').length, 0, '3 of 5 open → all closed');
assert.equal(document.activeElement, body, 'a mouse click does not move the focus');
observer.fn(); assert.equal(cb.settle().c[1], null, 'all closed: the button goes');
document.querySelector('[data-row-key="workspace:b"]').click(); order.length = 0;
observer.fn(); assert.equal(cb.settle().c[1].host, host, 'a project opens: the button comes back'); domButton.focus();
button.p.onClick({ currentTarget: domButton, detail: 0 });
assert.deepEqual(order, ['b']); assert.equal(document.activeElement, viewOptions, 'after a key press the focus moves to the next header button');
cb.unmount(); assert.equal(observer, null, 'unmount stops watching');
assert.equal(document.querySelector('[data-composer-plus-collapse-projects]'), null, 'unmount removes the button host');
// dsh 0.2.2 and later: their project-row menu (contextMenus) takes the right-click first. Copy path is an item of it,
// with dsh's copy icon; it copies the clicked row's folder. The switch off withdraws it.
{
  const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
    : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu', writeClipboard: async (text) => { copied.push(text); return true; } } : {}));
  const contributions = []; const effects = [];
  const scope = { contextMenus: { register: (c) => { contributions.push(c); return () => contributions.splice(contributions.indexOf(c), 1); } },
    effect: (f) => { effects.push(f()); } };
  let fibers = 0;
  plugin.apply({ effect: (f) => f(), configForms: { get: () => ({}) }, slots: { inject: (n, f) => f(), register: () => () => {} }, locale: { register: () => () => {}, bind: () => (k) => `T:${k}` },
    inject: (deps, setup) => { if (deps.includes('contextMenus')) { fibers += 1; setup(scope); } return { dispose: () => { for (const off of effects.splice(0)) off?.(); fibers -= 1; } }; } });
  const mine = contributions.find((c) => c.id === 'composer-plus.copy-path');
  assert.ok(mine, 'Copy path joins dsh\'s project menu');
  assert.equal(mine.target, 'workspace');
  const [action] = mine.resolve({ workspaceId: 'w1', path: '/Users/demo/acme web', displayTitle: 'acme web' });
  assert.deepEqual([action.id, action.label, action.icon], ['copy-path', 'T:projectMenu.copyPath', { key: 'workspace.copy' }]);
  action.run(); assert.equal(copied.at(-1), '/Users/demo/acme web', 'copies the clicked project\'s folder');
  assert.deepEqual(mine.resolve({ workspaceId: 'w9', path: '', displayTitle: 'x' }), [], 'no folder: no item');
}
console.log('project-tools checks passed');
