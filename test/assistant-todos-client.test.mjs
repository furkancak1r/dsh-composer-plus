// Assistant to-do list (client half, real client.js with fake dsh slots and a fake fetch): one dock entry while the
// feature is on, a panel only in the assistant chat, portaled to dsh's chat body (the right side of the chat, not dsh's
// right sidebar). Each item has real buttons with an aria-label: Hand over (only for an item of the user) sends the
// action with the prefix in the UI language; Remove removes at once. The store: one action per chat at a time, a read
// that started before an action does not overwrite its answer, a failed action keeps the reason. Switched off, the dock
// entry goes.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

let switchOn = true;
let items = [{ id: 'aaaaaaaa', text: 'Prosolocal\'i internete açmak', owner: 'user', created: 1 }, { id: 'bbbbbbbb', text: 'Rapor yaz', owner: 'agent', created: 2 }];
const posts = []; let gate = null; let failNext = null;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === '/api/composer-plus.assistant-status') return Response.json({ sessionId: 's-assistant' });
  if (u.startsWith('/api/composer-plus.assistant-todos')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body); posts.push(body);
      if ('on' in body) { switchOn = body.on; return Response.json({ on: switchOn }); }
      if (gate) await gate;
      if (failNext) { const error = failNext; failNext = null; return Response.json({ error, on: true, items }, { status: 502 }); }
      if (body.action === 'remove') items = items.filter((i) => i.id !== body.id);
      else items = items.map((i) => (i.id === body.id ? { ...i, owner: 'agent' } : i));
      return Response.json({ on: true, items });
    }
    const q = new URL(u, 'http://x').searchParams.get('sessionId');
    return Response.json(q === null ? { on: switchOn } : { on: switchOn, items: switchOn ? items : [] });
  }
  return new Response('{}', { status: 404 });
};

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
// A small hook runtime: state, refs and layout effects run at each render (enough for these components).
let hooks = []; let hi = 0;
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
  useState: (v) => { const i = hi++; if (!(i in hooks)) hooks[i] = typeof v === 'function' ? v() : v; return [hooks[i], (x) => { hooks[i] = typeof x === 'function' ? x(hooks[i]) : x; }]; },
  useRef: (v) => { const i = hi++; return hooks[i] ??= { current: v }; },
  useEffect: () => {}, useLayoutEffect: (f) => { f(); }, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f };
const portals = [];
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => { portals.push(host); return { portal: el, host }; } }
  : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
const live = new Map(); let next = 0;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: () => undefined, locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
await tick();
const dock = () => [...live.values()].find(([o]) => o.name === 'conversation.input.dock' && o.id === 'assistant-todos');
const [entry, Entry] = dock() ?? [];
assert.ok(entry, 'the to-do list is in dsh\'s input dock while the feature is on'); assert.equal(entry.locale, 'dsh-composer-plus');
const props = entry.inject('s-assistant');
const t = (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`);
const body = { tag: 'chat-body' };
const mark = { closest: (sel) => (sel === '[data-conversation-content]' ? body : null) };
const render = (sessionId, s = { running: false }) => {
  hi = 0;
  const out = Entry({ ...props, sessionId, t, useSession: (pick) => pick(s), useTurnEnd: undefined });
  if (out === null) return null;
  // The inner panel: render it with the mark in place (its ref is the first ref of the panel).
  hi = 0; hooks[2] ??= { current: mark }; hooks[2].current = mark;
  return out.t(out.p);
};
const find = (n, pred) => { if (n === null || typeof n !== 'object') return []; const own = pred(n) ? [n] : []; return [...own, ...(n.c ?? []).flat().flatMap((c) => find(c, pred)), ...(n.portal ? find(n.portal, pred) : [])]; };
const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join(' ') : n?.portal ? text(n.portal) : n?.c ? text(n.c) : '');

// Another chat: nothing.
assert.equal(render('s-other'), null, 'only the assistant chat has the list');
// The assistant chat: the first render reads the list.
render('s-assistant'); await props.store.load('s-assistant'); await tick();
let tree = render('s-assistant');
const panel = find(tree, (n) => n.p?.['data-composer-plus-todos'] === '')[0];
assert.ok(panel, 'the panel shows'); assert.equal(portals.at(-1), body, 'portaled to dsh\'s chat body, not to the right sidebar');
assert.equal(panel.t, 'section'); assert.match(panel.p['aria-labelledby'], /^cp-td-/);
const style = find(panel, (n) => n.t === 'style')[0]; assert.match(style.c[0], /position:absolute;top:12px;right:20px/, 'at the right side of the chat');
assert.match(text(panel), /todos\.title/); assert.match(text(panel), /Prosolocal'i internete açmak/); assert.match(text(panel), /todos\.ownerUser/); assert.match(text(panel), /todos\.ownerAgent/);
const buttons = find(panel, (n) => n.t === 'button');
for (const b of buttons) { assert.equal(b.p.type, 'button'); assert.ok(b.p['aria-label'] || b.p['aria-expanded'] !== undefined, 'each button has a name or a state'); }
const handover = buttons.filter((b) => /todos\.handover:/.test(b.p['aria-label'] ?? ''));
assert.equal(handover.length, 1, 'Hand over only for an item of the user'); assert.match(handover[0].p['aria-label'], /Prosolocal/);
const removes = buttons.filter((b) => /todos\.remove:/.test(b.p['aria-label'] ?? '')); assert.equal(removes.length, 2);

// Hand over: one click, the prefix in the UI language, the owner changes.
handover[0].p.onClick(); await tick();
assert.deepEqual(posts.at(-1), { sessionId: 's-assistant', id: 'aaaaaaaa', action: 'handover', prefix: 'todos.handoverMessage' });
tree = render('s-assistant');
assert.equal(find(tree, (n) => n.t === 'button' && /todos\.handover:/.test(n.p['aria-label'] ?? '')).length, 0, 'now the assistant does it');
// Remove: one click, no confirmation.
find(tree, (n) => n.t === 'button' && /todos\.remove:.*Rapor/.test(n.p['aria-label'] ?? ''))[0].p.onClick(); await tick();
assert.deepEqual(posts.at(-1), { sessionId: 's-assistant', id: 'bbbbbbbb', action: 'remove' });
assert.doesNotMatch(text(render('s-assistant')), /Rapor yaz/);

// One action per chat at a time; a read that started before an action does not overwrite its answer.
const before = posts.length;
let open; gate = new Promise((r) => { open = r; });
const first = props.store.act('s-assistant', 'aaaaaaaa', 'remove');
assert.equal(props.store.of('s-assistant').busy, true);
assert.equal(await props.store.act('s-assistant', 'aaaaaaaa', 'remove'), false, 'a second action waits');
tree = render('s-assistant'); assert.ok(find(tree, (n) => n.t === 'button' && n.p.disabled === true).length > 0, 'the buttons are disabled while it runs');
open(); gate = null; assert.equal(await first, true); assert.equal(posts.length, before + 1);
assert.deepEqual(props.store.of('s-assistant').items, [], 'the action\'s answer');
// A load that started before an action ends after it: dropped.
items = [{ id: 'cccccccc', text: 'new', owner: 'user', created: 3 }];
let slow; const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { if (init === undefined) await new Promise((r) => { slow = r; }); return origFetch(url, init); };
const read = props.store.load('s-assistant');
await tick();
items = []; // the action below removes it
globalThis.fetch = origFetch;
await props.store.act('s-assistant', 'cccccccc', 'remove');
items = [{ id: 'cccccccc', text: 'new', owner: 'user', created: 3 }]; slow(); await read; await tick();
assert.deepEqual(props.store.of('s-assistant').items, [], 'an older read does not bring the removed item back');
// A failed action keeps the reason and the Host's list.
items = [{ id: 'dddddddd', text: 'x', owner: 'user', created: 4 }]; await props.store.load('s-assistant');
failNext = 'the chat is gone';
assert.equal(await props.store.act('s-assistant', 'dddddddd', 'handover', 'Bunu sen yap:'), false);
tree = render('s-assistant');
assert.match(text(find(tree, (n) => n.p?.role === 'alert')[0]), /todos\.failed:.*the chat is gone/);
assert.match(text(tree), /dddddddd|x/);

// Collapse: the header button toggles aria-expanded and hides the list.
const head = find(tree, (n) => n.t === 'button' && n.p['aria-expanded'] !== undefined)[0];
assert.equal(head.p['aria-expanded'], true); head.p.onClick();
tree = render('s-assistant'); assert.equal(find(tree, (n) => n.t === 'ul').length, 0); assert.equal(find(tree, (n) => n.t === 'button' && n.p['aria-expanded'] === false).length, 1);

// Switched off: the dock entry goes.
const settings = [...live.values()].find(([o]) => o.name === 'settings.section')[0];
await settings.inject().setFeature('assistantTodos', false); await tick();
assert.equal(dock(), undefined, 'switched off: no dock entry');
await settings.inject().setFeature('assistantTodos', true); await tick();
assert.ok(dock(), 'on again');
console.log('assistant-todos-client: ok');
