// Assistant onboarding (client half, real client.js with fake dsh slots and a fake fetch): the first open of the assistant
// chat shows a welcome card above the input (dsh's input dock) that says what the assistant does. Only in the chat that
// the Assistant row opened, only while it has no message; the first message hides it. Switching the feature off removes
// the dock entry, and so the card and its style.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

let switchOn = true; let chat = 's-assistant';
globalThis.fetch = async (url, init) => {
  if (String(url) === '/api/composer-plus.assistant-switch') {
    if (init?.method === 'POST') switchOn = JSON.parse(init.body).on;
    return Response.json({ on: switchOn });
  }
  if (String(url) === '/api/composer-plus.assistant') return Response.json({ sessionId: chat });
  return new Response('{}', { status: 404 });
};

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: () => {}, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {} };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
const live = new Map(); let next = 0; const opened = [];
const services = { uiWorkspace: { openSession: (id) => opened.push(id) } };
let settings;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: (n) => services[n], locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); if (o.name === 'settings.section') settings = o; return () => live.delete(key); } } });
await tick();
const welcome = () => [...live.values()].find(([o]) => o.name === 'conversation.input.dock' && o.id === 'assistant-welcome');
const page = () => [...live.values()].find(([o]) => o.name === 'main' && o.key === 'composer-plus-assistant');

// On (the Host says on): one dock entry, after dsh's todo bar (0) and before its goal bar (10).
const [entry, Welcome] = welcome() ?? [];
assert.ok(entry, 'the welcome card is in dsh\'s input dock while the feature is on');
assert.equal(entry.order, 1);
const { assistant } = entry.inject('any');
const t = (k) => k;
const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join(' ') : n?.c ? text(n.c) : '');
const fresh = { blank: true, promptAttempted: false, running: false, subagent: null, removed: false };
const view = (sessionId, s) => Welcome({ sessionId, assistant, t, useSession: (pick) => pick(s) });

// Before the Assistant row opened a chat, no chat shows the card (not every new chat is the assistant's).
assert.equal(view('s-assistant', fresh), null, 'no card before the row opened the chat');

// The row's panel opens the chat: its empty screen shows the card.
const [pageEntry] = page();
await pageEntry.inject().assistant.open(pageEntry.inject().openSession); await tick();
assert.deepEqual(opened, ['s-assistant']);
const card = view('s-assistant', fresh);
assert.ok(card, 'the first open of the assistant chat shows the card');
assert.equal(card.t, 'section'); assert.equal(card.p['data-composer-plus-assistant-welcome'], '');
assert.equal(card.p['aria-label'], 'assistant.welcome.title');
for (const key of ['assistant.welcome.title', 'assistant.welcome.intro', 'assistant.welcome.remind', 'assistant.welcome.research', 'assistant.welcome.chats']) assert.match(text(card), new RegExp(key.replace(/\./g, '\\.')));
const style = card.c.find((c) => c?.t === 'style');
assert.ok(style && /\[data-composer-plus-assistant-welcome\]/.test(style.c[0]), 'the style is inside the card: it goes with the card');

// Another chat, the chat with a message, a sent first message, a running turn and an unknown chat state: no card.
assert.equal(view('s-other', fresh), null, 'not in another blank chat');
assert.equal(view('s-assistant', { ...fresh, blank: false }), null, 'not after the chat has messages');
assert.equal(view('s-assistant', { ...fresh, promptAttempted: true }), null, 'the first message hides it at once');
assert.equal(view('s-assistant', { ...fresh, running: true }), null, 'not while a turn runs');
assert.equal(view('s-assistant', undefined), null, 'not while dsh has no session snapshot');

// A deleted assistant chat is made again: the card follows the new chat.
chat = 's-new';
await assistant.open(pageEntry.inject().openSession); await tick();
assert.ok(view('s-new', fresh), 'the new assistant chat shows it'); assert.equal(view('s-assistant', fresh), null, 'the old one does not');
// A failed open keeps the chat that was opened last.
const hostFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url) === '/api/composer-plus.assistant' ? Response.json({ error: 'busy' }, { status: 409 }) : hostFetch(url, init));
await assistant.open(pageEntry.inject().openSession);
assert.equal(assistant.getSnapshot().status, 'error'); assert.ok(view('s-new', fresh), 'a failed open keeps the last chat');
globalThis.fetch = hostFetch;

// Off: the dock entry goes (and with it the card and its style); on again: it comes back.
await settings.inject().setFeature('assistant', false); await tick();
assert.equal(welcome(), undefined, 'no dock entry while off');
await settings.inject().setFeature('assistant', true); await tick();
assert.ok(welcome(), 'back when on');
console.log('assistant welcome: ok');
