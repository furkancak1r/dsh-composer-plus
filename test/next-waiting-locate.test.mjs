// Runs the real client.js Next waiting chat button: a click opens the next chat (as before) and then finds that chat's
// row in dsh's sidebar with `locateChat`: a project that "Collapse all projects" closed opens again, then the row
// scrolls into view and blinks for 5 s (a temporary highlight, then dsh's own selected row stays). The switch removes
// the search, the blink and the style. The header style keeps dsh's search icon whole next to the button.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__nl = { NextWaitingButton, LOCATE_CSS, NEXT_WAITING_CSS };\n    ${ANCHOR}`));

// A fake dsh sidebar: header [actions], project p1 (closed) holds chat s1; a click on the project row draws its chat.
const timers = []; globalThis.setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; }; globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].f = () => {}; };
const run = () => { for (let i = 0; i < 50 && timers.some((x) => x.ms === 120); i++) { const k = timers.findIndex((x) => x.ms === 120); timers.splice(k, 1)[0].f(); } };
const clicks = []; let open = false; let chatRow;
const row = (key, attrs = {}) => ({ key, attrs: { 'data-row-key': key, ...attrs }, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; },
  removeAttribute(k) { delete this.attrs[k]; }, scrollIntoView(o) { this.scrolled = o; }, click() { clicks.push(key); if (key === 'workspace:p1') open = !open; } });
const project = row('workspace:p1', { 'aria-expanded': 'false' });
const rows = () => { project.attrs['aria-expanded'] = String(open); return open ? [project, (chatRow ??= row('session:s1'))] : [project]; };
const actions = { firstElementChild: null, prepend(c) { this.firstElementChild = c; c.parentElement = this; } };
globalThis.document = {
  createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; } }),
  querySelector(q) {
    if (q === '[data-composer-plus-next-waiting]') return actions.firstElementChild;
    if (q === '[class*="_listArea"]') return { parentElement: { querySelector: () => actions } };
    if (q === '[data-row-key]') return rows()[0];
    const key = /^\[data-row-key=(".*")\]$/.exec(q)?.[1];
    return key === undefined ? null : rows().find((r) => r.key === JSON.parse(key)) ?? null;
  },
  querySelectorAll: () => [],
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };

// Fake React with hook state per mount; effects run once, cleanups on unmount.
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.i++; if (!(i in cur.s)) cur.s[i] = v; return [cur.s[i], (x) => { cur.s[i] = x; }]; },
  useRef: (v) => { const i = cur.i++; if (!(i in cur.s)) cur.s[i] = { current: v }; return cur.s[i]; },
  useEffect: (f) => { const i = cur.i++; if (!(i in cur.c)) cur.c[i] = f(); } };
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) } : {}));
const { NextWaitingButton, LOCATE_CSS, NEXT_WAITING_CSS } = globalThis.__nl;
const workspaces = { items: [{ workspaceId: 'p1', path: '/demo/acme-web', sessionIds: ['s1'] }] };
const inst = { s: [], c: [] };
const opened = [];
const props = { t: (k) => k, useNextWaiting: (sel) => sel([{ sessionId: 's1', done: false }]), useWorkspaces: (sel) => sel(workspaces),
  open: () => { opened.push('s1'); return 's1'; } };
const render = () => { cur = inst; inst.i = 0; return NextWaitingButton(props); };
render(); const view = render();
const buttonOf = (v) => v.c[1].portal; // no Tooltip primitive here: the portal holds the button itself
const button = buttonOf(view); assert.equal(button.t, 'button');

// 1. The click opens the chat (unchanged), the closed project opens, the row scrolls into view and blinks.
button.p.onClick({ detail: 1 }); run();
assert.deepEqual(opened, ['s1'], 'the chat opens as before');
assert.deepEqual(clicks, ['workspace:p1'], 'the closed project opens (one click on its row)');
assert.deepEqual(chatRow.scrolled, { block: 'center', behavior: 'smooth' }, 'the row scrolls into view');
assert.ok('data-composer-plus-locate' in chatRow.attrs, 'the row blinks');
// 2. Temporary: after 5 s the mark goes and dsh's own selected row stays.
const blink = timers.find((x) => x.ms === 5000); assert.ok(blink, 'the blink lasts 5 s'); blink.f();
assert.ok(!('data-composer-plus-locate' in chatRow.attrs), 'then the highlight ends');
// 3. An open project is not closed again: a second click finds the row at once.
clicks.length = 0; button.p.onClick({ detail: 1 }); run();
assert.deepEqual(clicks, [], 'an open project stays open'); assert.ok('data-composer-plus-locate' in chatRow.attrs);
// 4. Nothing waits (open() gives no chat): no search.
props.open = () => undefined; delete chatRow.attrs['data-composer-plus-locate'];
buttonOf(render()).p.onClick({ detail: 1 }); run();
assert.ok(!('data-composer-plus-locate' in chatRow.attrs), 'no chat opened: no row is marked');
// 5. Switched off while the row blinks: unmount stops the search and removes the mark; the style goes with the slot.
props.open = () => 's1'; open = false; chatRow.attrs = { 'data-row-key': 'session:s1' };
buttonOf(render()).p.onClick({ detail: 1 }); run();
assert.ok('data-composer-plus-locate' in chatRow.attrs);
for (const c of inst.c) c?.();
assert.ok(!('data-composer-plus-locate' in chatRow.attrs), 'off: no row stays marked');
const style = view.c[0];
assert.equal(style.t, 'style', 'the style is a child of the slot, so it goes when the switch goes off');
assert.ok(style.c[0].includes(LOCATE_CSS) && LOCATE_CSS.includes('[data-composer-plus-locate]{animation:cp-locate 1s ease-in-out 5'), 'the blink style is in it');
assert.ok(LOCATE_CSS.includes('prefers-reduced-motion'), 'no animation for users who turn motion off');

// 6. The header fits: while the button shows, dsh's search slot keeps 28 px (its icon) and the header label shortens.
const header = '[class*="_sectionHeader"]:has(> [class*="_headerActions"] > [data-composer-plus-next-waiting] > button)';
assert.ok(NEXT_WAITING_CSS.includes(`${header} > [class*="_searchSlot"] { min-width: 28px; }`), 'the search icon is not cut');
assert.ok(NEXT_WAITING_CSS.includes(`${header} > [class*="_sectionLabel"] { flex-shrink: 1; text-overflow: ellipsis; }`), 'the label gives the room');
console.log('next-waiting-locate checks passed');
