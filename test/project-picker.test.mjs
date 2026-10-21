// Runs the real client.js "Project search in a new chat" with fake React and a mini DOM: while dsh's new chat project
// menu is open, a search box goes on top of it, the rows show in A–Z order (CSS `order`, dsh's DOM order stays), the
// search hides rows (accent and case insensitive), Enter picks the first match on screen, the arrow keys follow the
// order on screen, Esc clears the box first, rows that dsh draws again are sorted again, and closing or switching it
// off gives dsh its menu back.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));

// Mini DOM: compounds of tag, [a], [a="v"], [a*="v"], joined by ' > ', and ':scope > X'.
const compound = (part) => {
  const tag = /^[a-z]+/.exec(part)?.[0];
  const attrs = [...part.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)].map(([, name, op, value]) => ({ name, op, value }));
  return (e) => (tag === undefined || e.tag === tag) && attrs.every(({ name, op, value }) => {
    const v = e.getAttribute(name); return v !== null && (op === undefined || (op === '=' ? v === value : v.includes(value)));
  });
};
const chain = (sel) => { const parts = sel.split(' > ').map(compound);
  return (e) => { let n = e; for (let i = parts.length - 1; i >= 0; i--) { if (n === null || !parts[i](n)) return false; n = i > 0 ? n.parentElement : n; } return true; }; };
const descendants = (e) => e.children.flatMap((c) => [c, ...descendants(c)]);
let active = null; const clicks = [];
class El {
  constructor(tag, attrs = {}, children = [], text = '') {
    this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.style = {}; this.text = text; this.disabled = false;
    for (const c of children) this.append(c);
  }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(c) { c.remove(); c.parentElement = this; this.children.push(c); mutated(this); }
  prepend(c) { c.remove(); c.parentElement = this; this.children.unshift(c); mutated(this); }
  remove() { const p = this.parentElement; if (p !== null) { p.children = p.children.filter((x) => x !== this); this.parentElement = null; mutated(p); } }
  matches(sel) { return chain(sel)(this); }
  contains(n) { return n === this || descendants(this).includes(n); }
  querySelectorAll(sel) {
    if (sel.startsWith(':scope > ')) { const m = chain(sel.slice(':scope > '.length)); return this.children.filter(m); }
    return descendants(this).filter(chain(sel));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  focus() { active = this; }
  click() { clicks.push(this.textContent); }
}
const observers = [];
const mutated = (target) => { for (const o of [...observers]) if (o.target === target) o.fn(); };
globalThis.MutationObserver = class {
  constructor(fn) { this.fn = fn; }
  observe(target, opts) { assert.deepEqual(opts, { childList: true }); this.target = target; observers.push(this); }
  disconnect() { const i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1); }
};
const body = new El('body');
globalThis.document = { body, documentElement: { lang: 'en' }, createElement: (tag) => new El(tag),
  get activeElement() { return active; }, querySelector: (sel) => descendants(body).find(chain(sel)) ?? null };
const keys = [];
window.addEventListener = (type, fn, capture) => { assert.equal(type, 'keydown'); assert.equal(capture, true, 'before dsh\'s own menu keys'); keys.push(fn); };
window.removeEventListener = (type, fn) => { const i = keys.indexOf(fn); if (i >= 0) keys.splice(i, 1); };
const press = (key, o = {}) => { const e = { key, stopped: false, prevented: false, ...o, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
  for (const fn of [...keys]) fn(e); return e; };

let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; return cur.refs[i] ??= { current: v }; },
  useEffect: (f, deps) => { cur.effects.push([f, deps]); } };
const mount = (C, props) => {
  const inst = { state: [], refs: [], deps: [], cleanups: [] };
  let out;
  const render = () => {
    cur = inst; inst.si = 0; inst.ri = 0; inst.effects = [];
    out = C(props);
    inst.effects.forEach(([f, deps], i) => {
      if (inst.deps[i] !== undefined && deps.every((d, j) => Object.is(d, inst.deps[i][j]))) return;
      inst.cleanups[i]?.(); inst.cleanups[i] = f(); inst.deps[i] = deps;
    });
  };
  // Like React: render again while a state change is pending.
  const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const settle = () => { for (let i = 0; i < 6; i++) { const before = [...inst.state]; render(); if (same(before, inst.state)) break; } return out; };
  return { settle, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const primitives = { Input: 'Input', IconSearchOutlineRegular: 'Search' };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : {}));
const regs = []; plugin.apply({ slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
const [opt, Search] = regs.find(([o]) => o.id === 'project-picker-search');
assert.equal(opt.name, 'shell.overlay'); assert.equal(opt.locale, 'dsh-composer-plus');

// dsh's new chat screen: the hero project button, and its menu (portaled to <body>) while the button is expanded.
const chip = new El('button', { class: 'bocITq_workspace', 'aria-expanded': 'false', 'aria-haspopup': 'menu' });
body.append(new El('div', { class: 'ST7X_W_heroWorkspaceRow' }, [chip]));
const row = (name) => new El('div', { class: '_itemWrap_4ub78_90' }, [new El('button', { role: 'menuitem', class: '_item_4ub78_90' }, [new El('span', {}, [], name)])]);
const names = ['serit', 'aiproxy', 'Zeta', 'ağaç-proje', 'dsh-composer-plus', 'promes', '3', 'prosolocal'];
let viewport, footer, list;
const openMenu = () => {
  viewport = new El('div', { role: 'presentation' }, names.map(row));
  footer = new El('div', { role: 'presentation' }, [new El('div', {}, [new El('button', { role: 'menuitem' }, [], 'Add workspace…')])]);
  list = new El('div', { role: 'menu', 'data-menu-material': 'translucent' }, [new El('div', { 'aria-hidden': 'true' }), viewport, footer]);
  list.offsetHeight = 420;
  chip.setAttribute('aria-expanded', 'true');
  body.append(list); // dsh's portal; the <body> observer sees it
};
const closeMenu = () => { chip.setAttribute('aria-expanded', 'false'); list.remove(); };
const rowsOf = () => viewport.children.filter((c) => c.querySelector(':scope > button[role="menuitem"]') !== null);
const onScreen = () => rowsOf().filter((r) => r.style.display !== 'none').sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((r) => r.textContent);
const host = () => list.children.find((c) => c.getAttribute('data-composer-plus-project-search') !== null);
const t = (k) => k;

const view = mount(Search, { t });
assert.equal(view.settle(), null, 'nothing while no menu is open');
assert.deepEqual(keys, [], 'no key listener while closed');

// A menu that is not the project menu (the chip is not expanded) stays untouched.
const other = new El('div', { role: 'menu' }, [new El('div', { role: 'presentation' }, [row('b'), row('a')])]);
body.append(other); view.settle();
assert.equal(other.children.length, 1, 'another menu gets no box'); assert.equal(other.children[0].children[0].style.order, undefined);
other.remove();

openMenu();
let out = view.settle();
assert.equal(out.host, host(), 'the box is portaled into its own host'); assert.equal(list.children[0], host(), 'host is first, above dsh\'s scrolling rows');
assert.deepEqual(rowsOf().map((r) => r.textContent), names, 'dsh\'s DOM order is not changed');
assert.deepEqual(onScreen(), ['3', 'ağaç-proje', 'aiproxy', 'dsh-composer-plus', 'promes', 'prosolocal', 'serit', 'Zeta'], 'A–Z on screen, case and accent aware');
const input = () => out.portal.c[0];
assert.equal(input().t, 'Input'); assert.equal(input().p['aria-label'], 'projectPicker.search'); assert.equal(input().p.placeholder, 'projectPicker.search');
assert.equal(out.portal.c[1], null, 'no empty notice');
const box = new El('input'); input().p.ref.current = box; host().append(box); // what React would render into the host
view.settle(); box.focus();
assert.equal(keys.length, 1, 'one key listener while open');

// Search: every word must appear; accents, case and Turkish ı do not matter.
const type = (q) => { input().p.onChange({ target: { value: q } }); box.value = q; out = view.settle(); };
type('PRO');
assert.deepEqual(onScreen(), ['ağaç-proje', 'aiproxy', 'promes', 'prosolocal'], 'part of a name, any case');
assert.equal(list.style.minHeight, '420px', 'menu keeps its height while the list gets shorter'); assert.equal(viewport.style.flexGrow, '1');
type('agac'); assert.deepEqual(onScreen(), ['ağaç-proje'], 'ğ and ç match g and c');
type('dsh plus'); assert.deepEqual(onScreen(), ['dsh-composer-plus'], 'words in any place');
type('zzz'); assert.deepEqual(onScreen(), []); assert.equal(out.portal.c[1].p.role, 'status'); assert.equal(out.portal.c[1].c[0], 'projectPicker.empty');
let e = press('Enter'); assert.equal(e.prevented, true); assert.deepEqual(clicks, [], 'Enter with no match picks nothing (not Add workspace)');

// Enter picks the first match on screen, not the first in dsh's DOM.
type('pro');
e = press('Enter'); assert.deepEqual(clicks, ['ağaç-proje']); assert.equal(e.stopped, true, 'dsh does not handle this Enter');
clicks.length = 0;

// Arrow keys: box → rows on screen → footer → box.
box.focus(); e = press('ArrowDown'); assert.equal(active.textContent, 'ağaç-proje'); assert.equal(e.stopped, true); assert.equal(e.prevented, true);
press('ArrowDown'); assert.equal(active.textContent, 'aiproxy');
press('ArrowDown'); press('ArrowDown'); press('ArrowDown'); assert.equal(active.textContent, 'Add workspace…', 'footer comes after the rows');
press('ArrowDown'); assert.equal(active, box, 'wraps to the box');
press('ArrowUp'); assert.equal(active.textContent, 'Add workspace…');
press('Home'); assert.equal(active.textContent, 'ağaç-proje'); press('End'); assert.equal(active.textContent, 'Add workspace…');
box.focus(); e = press('Home'); assert.equal(e.prevented, false, 'Home in the box moves the caret'); assert.equal(active, box);
// Tab from the box goes to the first row on screen; typing on a row goes back to the box.
e = press('Tab'); assert.equal(active.textContent, 'ağaç-proje'); assert.equal(e.prevented, true);
press('x'); assert.equal(active, box, 'typing on a row goes to the box');
// IME composition and shortcuts stay with dsh and the browser.
e = press('ArrowDown', { isComposing: true }); assert.equal(e.stopped, false); assert.equal(active, box);
e = press('ArrowDown', { metaKey: true }); assert.equal(e.stopped, false);
// Focus outside the menu: no key is taken.
active = chip; e = press('ArrowDown'); assert.equal(e.stopped, false); box.focus();

// Esc clears the search first; the next Esc goes to dsh, which closes the menu.
e = press('Escape'); assert.equal(e.stopped, true); assert.equal(e.prevented, true); out = view.settle(); box.value = '';
assert.equal(onScreen().length, names.length, 'cleared: every row shows');
e = press('Escape'); assert.equal(e.stopped, false, 'empty box: dsh closes the menu');

// dsh draws a new row (a project was added): it is sorted in and filtered with the query.
type('b');
viewport.append(row('beta-app')); out = view.settle();
assert.deepEqual(onScreen().slice(0, 1), ['beta-app']);
type(''); assert.deepEqual(onScreen().slice(0, 4), ['3', 'ağaç-proje', 'aiproxy', 'beta-app']);

// Close: the state resets; the next menu starts empty and gets a new box.
type('ser'); closeMenu(); out = view.settle();
assert.equal(out, null); assert.deepEqual(keys, [], 'key listener removed');
openMenu(); out = view.settle(); input().p.ref.current = box; host().append(box); view.settle();
assert.equal(input().p.value, '', 'a new menu starts with an empty box'); assert.equal(onScreen().length, names.length);

// Switched off while open: the box goes and dsh's rows lose every style this feature set.
type('pro'); view.unmount();
assert.equal(host(), undefined, 'host removed');
for (const r of rowsOf()) { assert.equal(r.style.order, ''); assert.equal(r.style.display, ''); }
assert.equal(list.style.minHeight, ''); assert.equal(viewport.style.flexGrow, ''); assert.deepEqual(keys, []); assert.equal(observers.length, 0, 'observers stopped');

// Turkish UI language: Turkish order (ç after c, ı before i, ş after s).
closeMenu();
document.documentElement.lang = 'tr';
names.splice(0, names.length, 'şube', 'su', 'çay', 'cam', 'ılık', 'iz');
const tr = mount(Search, { t }); tr.settle(); openMenu(); tr.settle();
assert.deepEqual(onScreen(), ['cam', 'çay', 'ılık', 'iz', 'su', 'şube']);
tr.unmount(); closeMenu();
document.documentElement.lang = 'not a language tag'; // dsh never sets this; a bad tag must not break the menu
const bad = mount(Search, { t }); bad.settle(); openMenu(); bad.settle(); assert.equal(onScreen().length, names.length); bad.unmount(); closeMenu();

// Without dsh's Input primitive the feature does nothing.
delete primitives.Input;
const none = mount(Search, { t }); none.settle(); openMenu(); assert.equal(none.settle(), null); none.unmount(); closeMenu();
console.log('project picker: A–Z order, search (accents, words), Enter, arrows/Tab/Home/End, Esc, redraw, close, switch off, Turkish order');
