// Mark all as read (client half): the real client.js `markReadApi` against a stand-in for dsh's UiSession (the private
// `completionUnread` Set and `publishStatus()`, as in dsh 0.2.0-rc.2 and 0.2.1-rc.2), and the menu item: only the
// project's own chats lose their dot, the item is disabled when none has one, a click closes dsh's menu, and an
// unknown dsh (no such fields) gets no item. The feature's switch removes its overlay.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hook = '    function MarkProjectRead(';
assert.ok(src.includes(hook));
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const events = [];
globalThis.KeyboardEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
globalThis.document = { dispatchEvent: (e) => { events.push(e); }, querySelectorAll: () => [], body: { children: [] }, addEventListener() {}, removeEventListener() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.Element = class Element {};
eval(src.replace(hook, '    globalThis.__mr = { markReadApi, MarkProjectRead: (p) => MarkProjectRead(p) };\n' + hook));
let state = []; let at = 0;
const React = {
  createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }), Fragment: 'F',
  useRef: (v) => ({ current: v }),
  useState: (v) => { const k = at++; if (!(k in state)) state[k] = v; return [state[k], (x) => { state[k] = typeof x === 'function' ? x(state[k]) : x; }]; },
  useEffect: () => {},
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (e, host) => ({ portal: e, host }) } : n === '@deepseek-ai/dsh-client-ui-primitives' ? { MenuItemButton: 'MenuItemButton' } : {}));
const { markReadApi, MarkProjectRead } = globalThis.__mr;

// 1. The API on dsh's own unread set.
let published = 0;
const ui = { completionUnread: new Set(['a1', 'a2', 'b1']), publishStatus() { published += 1; } };
const api = markReadApi(ui);
assert.deepEqual(api.unreadOf(['a1', 'a2', 'a3']), ['a1', 'a2']);
assert.equal(api.markRead(['a1', 'a2', 'a3']), true); assert.equal(published, 1, 'dsh republishes its status once');
assert.deepEqual([...ui.completionUnread], ['b1'], 'another project\'s dot stays');
assert.equal(api.markRead(['a1']), false); assert.equal(published, 1, 'nothing to clear: no republish');
// An unknown dsh: no API, so no item.
assert.equal(markReadApi({}), undefined); assert.equal(markReadApi({ completionUnread: new Set() }), undefined); assert.equal(markReadApi(undefined), undefined);

// 2. The item in an open project menu (the "…" press set the target).
const items = [{ workspaceId: 'w1', sessionIds: ['b1', 'b2'] }, { workspaceId: 'w2', sessionIds: ['c1'] }];
const host = { isConnected: true };
const render = () => { at = 0; return MarkProjectRead({ useWorkspaces: (f) => f({ items }), useSessionStatus: (f) => f(new Map()), api, t: (k) => k }); };
assert.equal(render(), null, 'no menu open: nothing');
state[0] = { workspaceId: 'w1', host };
let out = render();
const find = (e, test) => { if (e === null || typeof e !== 'object') return undefined; if (test(e)) return e; for (const x of [...(e.c ?? []), e.portal].filter(Boolean)) { const f = find(x, test); if (f) return f; } return undefined; };
let item = find(out, (e) => e.t === 'MenuItemButton');
assert.equal(out.host, host, 'the item goes into dsh\'s open menu');
assert.equal(item.p.disabled, false); assert.deepEqual(item.c, ['markRead.menu']);
assert.equal(find(out, (e) => e.p?.['data-composer-plus-mark-read-item'] !== undefined).p['data-composer-plus-mark-read-item'], '1');
item.p.onSelect();
assert.deepEqual([...ui.completionUnread], [], 'b1 (project w1) is read now');
assert.equal(events.at(-1).key, 'Escape', 'dsh\'s menu closes');
out = render(); item = find(out, (e) => e.t === 'MenuItemButton');
assert.equal(item.p.disabled, true); assert.deepEqual(item.c, ['markRead.none'], 'no unread chat: disabled');
const n = events.length; item.p.onSelect(); assert.equal(events.length, n, 'a disabled item does nothing');
// The menu closed: no portal.
host.isConnected = false; assert.equal(render(), null);

// 2b. Which press arms the item: only the row's "…" button, never dsh's "+" (new session, the row's last icon button),
// and any other press in between ends the wait (the item never goes into an unrelated menu).
{
  class Node0 extends globalThis.Element {
    constructor(tag, attrs = {}, kids = []) { super(); this.tag = tag; this.attrs = { ...attrs }; this.kids = []; this.parent = null; this.className = attrs.class ?? ''; for (const k of kids) this.append(k); }
    append(k) { k.parent = this; this.kids.push(k); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    matches(sel) {
      if (sel === 'button') return this.tag === 'button';
      if (sel === '[role="menu"]') return this.attrs.role === 'menu';
      if (sel === '[data-row-key^="workspace:"]') return String(this.attrs['data-row-key'] ?? '').startsWith('workspace:');
      if (sel === '[data-composer-plus-mark-read]') return 'data-composer-plus-mark-read' in this.attrs;
      return false;
    }
    closest(sel) { for (let e = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
    all() { return this.kids.flatMap((k) => [k, ...k.all()]); }
    querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  }
  const dots = new Node0('button', { class: 'Rows_iconButton', 'aria-label': 'Workspace actions for Shop' });
  const plus = new Node0('button', { class: 'Rows_iconButton', 'aria-label': 'New session in Shop' });
  const row = new Node0('div', { 'data-row-key': 'workspace:w1' }, [new Node0('span', {}, [dots, plus])]);
  const other = new Node0('button', { 'aria-label': 'Session actions for Chat' });
  const listeners = {}; let observed;
  globalThis.document = { ...globalThis.document, body: { children: [] }, addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener() {},
    createElement: (tag) => new Node0(tag), querySelectorAll: () => [] };
  globalThis.MutationObserver = class { constructor(f) { observed = f; } observe() {} disconnect() {} };
  const effects = []; const saved = React.useEffect; React.useEffect = (f) => { effects.push(f); };
  state = []; render(); React.useEffect = saved;
  effects[0]();
  const openMenu = () => { const menu = new Node0('div', { role: 'menu' }); document.body.children = [menu]; observed(); return menu; };
  listeners.pointerdown({ target: plus }); let menu = openMenu();
  assert.equal(menu.querySelector('[data-composer-plus-mark-read]'), null, 'the "+" button arms nothing');
  listeners.pointerdown({ target: dots }); listeners.pointerdown({ target: other }); menu = openMenu();
  assert.equal(menu.querySelector('[data-composer-plus-mark-read]'), null, 'another press in between: not in that menu');
  listeners.pointerdown({ target: dots }); menu = openMenu();
  assert.notEqual(menu.querySelector('[data-composer-plus-mark-read]'), null, 'the "…" button: the item goes into its menu');
  assert.equal(state[0].workspaceId, 'w1');
}

// 3. The feature: on by default, its own switch, an overlay only when dsh has the unread set.
assert.match(src, /'projectStatus', 'markProjectRead', 'activeProjectsFirst'/);
assert.match(src, /feature\('markProjectRead', \(\) => injectScope\(\['uiSession'\]/);
assert.ok(!/OFF_BY_DEFAULT = \[[^\]]*markProjectRead/.test(src), 'on by default');
console.log('mark read checks passed');
