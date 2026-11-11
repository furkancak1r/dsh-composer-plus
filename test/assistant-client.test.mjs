// Assistant (client half, real client.js with fake dsh slots and a fake fetch): on by default (the row shows before the
// Host answers); a Host that says off removes the row and the panel;
// the Host switch turns it on: the sidebar row sits right under Task board and opens the panel, which asks the Host for
// the chat and opens it with dsh's openSession. One open at a time from every entry point; a failure shows the reason and
// Try again; an older Host half (404) says to restart dsh. Switching off removes the row and the panel.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

let switchOn = false; let known = null; const asks = []; let answer = () => Response.json({ sessionId: 's-assistant' }); let gate = null;
globalThis.fetch = async (url, init) => {
  if (String(url) === '/api/composer-plus.assistant-switch') {
    if (init?.method === 'POST') switchOn = JSON.parse(init.body).on;
    return Response.json({ on: switchOn });
  }
  if (String(url) === '/api/composer-plus.assistant') { asks.push(url); if (gate) await gate.promise; return answer(); }
  if (String(url) === '/api/composer-plus.assistant-status') return Response.json({ sessionId: switchOn ? known : null });
  return new Response('{}', { status: 404 });
};

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: (f) => { f(); }, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {} };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
const live = new Map(); let next = 0; const opened = [];
const services = { uiWorkspace: { openSession: (id) => opened.push(id) } };
let settings;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: (n) => services[n], locale: { register: () => () => {}, bind: (ns) => (k, v) => `${ns}:${k}${v?.error ? `(${v.error})` : ''}`, resolveText: (x) => x },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); if (o.name === 'settings.section') settings = o; return () => live.delete(key); } } });
const rows = () => [...live.values()].filter(([o]) => o.name === 'sidebar.panellist').map(([o]) => o);
const pages = () => [...live.values()].filter(([o]) => o.name === 'main').map(([o, C]) => [o, C]);
assert.ok(rows().some((o) => o.id === 'composer-plus-assistant'), 'on before the Host answers (not in OFF_BY_DEFAULT)');
await tick();

// This Host was switched off: the row and the panel go.
assert.ok(!rows().some((o) => o.id === 'composer-plus-assistant'), 'no sidebar row while off');
assert.ok(!pages().some(([o]) => o.key === 'composer-plus-assistant'), 'no panel while off');
const toggles = settings.inject().hooks.composerPlusToggles;
assert.equal(toggles.getSnapshot().assistant, false, 'the Host says off');

// On: the row is right under Task board and selects its own panel.
await settings.inject().setFeature('assistant', true); await tick();
assert.equal(switchOn, true, 'the switch goes to the Host');
const row = rows().find((o) => o.id === 'composer-plus-assistant');
const board = rows().find((o) => o.id === 'composer-plus-board');
assert.ok(row, 'the sidebar row'); assert.ok(board, 'Task board is on by default');
assert.equal(row.order, board.order + 1, 'right under Task board');
assert.equal(row.label(), 'Damon', 'the fixed name, in every UI language');
const [page, Page] = pages().find(([o]) => o.key === 'composer-plus-assistant');
const props = page.inject();
const t = (k, v) => `${k}${v?.error ? `(${v.error})` : ''}`;

// The panel asks the Host and opens the chat; a second open while one runs sends nothing.
gate = (() => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; })();
let view = Page({ ...props, t });
assert.equal(asks.length, 1, 'the panel asks once');
React.useEffect = () => {}; // later renders: the panel is already open (its effect ran once)
props.assistant.open(props.openSession); props.assistant.open(props.openSession);
assert.equal(asks.length, 1, 'one open at a time');
assert.equal(props.assistant.getSnapshot().status, 'opening');
assert.deepEqual(opened, [], 'no chat is known yet: it waits for the Host');
gate.open(); gate = null; await tick();
assert.deepEqual(opened, ['s-assistant'], 'the chat opens'); assert.equal(props.assistant.getSnapshot().status, 'idle');

// Open speed: a known chat opens at once, as a sidebar row does; the Host's answer (it can take 0.5 s: it checks the chat's
// log and resumes its agent) does not hold it. The answer opens nothing more when it names the same chat.
gate = (() => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; })();
props.assistant.open(props.openSession);
assert.deepEqual(opened, ['s-assistant', 's-assistant'], 'the known chat opens before the Host answers');
gate.open(); gate = null; await tick();
assert.deepEqual(opened, ['s-assistant', 's-assistant'], 'the same answer opens nothing more');
// The known chat was deleted: the Host makes a new one, and its answer opens it.
answer = () => Response.json({ sessionId: 's-assistant-new' });
await props.assistant.open(props.openSession);
assert.deepEqual(opened.slice(-2), ['s-assistant', 's-assistant-new'], 'a new chat from the Host opens after the known one');
answer = () => Response.json({ sessionId: 's-assistant' });
await props.assistant.open(props.openSession);
opened.length = 0;

// A failure shows the Host's reason and Try again; Try again asks again.
answer = () => Response.json({ error: 'This dsh has no projects' }, { status: 409 });
await props.assistant.open(props.openSession);
view = Page({ ...props, t });
const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : n?.c ? text(n.c) : '');
assert.match(text(view), /assistant\.failed\(This dsh has no projects\)/);
const retry = view.c.find((c) => c?.t === 'Button');
assert.ok(retry, 'Try again'); answer = () => Response.json({ sessionId: 's-assistant' });
retry.p.onClick(); await tick();
assert.deepEqual(opened, ['s-assistant', 's-assistant'], 'the known chat opens at each click; the failed answer opens nothing');
// An older Host half: restart text, no Try again.
answer = () => new Response('not found', { status: 404 });
await props.assistant.open(props.openSession);
view = Page({ ...props, t });
assert.match(text(view), /assistant\.restart/); assert.equal(view.c.find((c) => c?.t === 'Button'), undefined, 'no Try again');

// After a reload the store knows no chat yet: the Host's assistant-status (Assistant apart from chats) gives it.
known = 's-status';
await settings.inject().setFeature('assistant', false); await tick();
await settings.inject().setFeature('assistant', true); await tick();
const [page2] = pages().find(([o]) => o.key === 'composer-plus-assistant');
const props2 = page2.inject(); opened.length = 0;
gate = (() => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; })();
props2.assistant.open(props2.openSession);
assert.deepEqual(opened, ['s-status'], 'the chat from assistant-status opens before the Host answers');
answer = () => Response.json({ sessionId: 's-status' });
gate.open(); gate = null; await tick();
assert.deepEqual(opened, ['s-status']);

// Off: the row and the panel go.
await settings.inject().setFeature('assistant', false); await tick();
assert.ok(!rows().some((o) => o.id === 'composer-plus-assistant')); assert.ok(!pages().some(([o]) => o.key === 'composer-plus-assistant'));
assert.equal(props.assistant.getSnapshot().status, 'idle', 'reset when off');
console.log('assistant client: ok');
