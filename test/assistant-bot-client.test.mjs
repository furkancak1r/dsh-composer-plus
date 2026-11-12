// Assistant as a bot (client half, real client.js with fake dsh slots and a fake fetch):
// - Assistant apart from chats: one style rule hides the assistant chat's rows (project, flat list) but not the search
//   results, and the "Assistant" project only when it holds no other shown chat; the Assistant row shows the chat's state
//   (running with a subagent topic, waiting in orange, a new reply in green) and the open state. Off: the rule, the dot and
//   the row description go; Assistant off: no id, no rule.
// - Assistant messages only: a rule inside the assistant chat only.
// - Assistant always free and Assistant news from chats: Host switches (createMobile), the inactive note.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
globalThis.document = { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

let assistantOn = true; let statusId = 's-assistant'; const switches = { free: { on: true, active: true }, notify: { on: false, scope: 'automations' } }; const posts = [];
let statusReads = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === '/api/composer-plus.assistant-switch') { if (init?.method === 'POST') assistantOn = JSON.parse(init.body).on; return Response.json({ on: assistantOn }); }
  if (u === '/api/composer-plus.assistant-status') { statusReads++; return Response.json({ sessionId: assistantOn ? statusId : null }); }
  if (u === '/api/composer-plus.assistant') return Response.json({ sessionId: statusId });
  for (const [k, route] of [['free', '/api/composer-plus.assistant-free'], ['notify', '/api/composer-plus.assistant-notify']]) {
    if (u === route) { if (init?.method === 'POST') { posts.push([k, JSON.parse(init.body)]); switches[k] = { ...switches[k], ...JSON.parse(init.body) }; } return Response.json(switches[k]); }
  }
  return new Response('{}', { status: 404 });
};

let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: (f) => { f(); }, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: (f) => { f(); } };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Button: 'Button', StateDot: 'StateDot' }
  : n === 'react-dom' ? { createPortal: (el, host) => ({ t: 'Portal', p: { host }, c: [el] }) } : {}));
const live = new Map(); let next = 0; let settings;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: () => undefined, locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); if (o.name === 'settings.section') settings = o; return () => live.delete(key); } } });
await tick();
// Open waiting chat when idle, Assistant apart, Assistant messages only, callouts and the to-do list each need the id: they
// start together and share one read (the old copy read it five times, and five more when the switch answered).
assert.ok(statusReads >= 1 && statusReads <= 2, `assistant-status read at start: ${statusReads} (at most one per switch state)`);
const entry = (name, id) => [...live.values()].find(([o]) => o.name === name && (o.id === id || o.key === id));
const t = (k) => k;
const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : n?.c ? text(n.c) : '');
const find = (n, f) => (n == null || typeof n !== 'object' ? undefined : f(n) ? n : (n.c ?? []).flat(Infinity).map((c) => find(c, f)).find(Boolean));

// The fake dsh state: the assistant chat in the project "Assistant" (alone), a chat in acme-web.
const list = { byId: { 's-assistant': { blank: false }, 's-web': { blank: false } }, projectionsBySession: {} };
const workspaces = { items: [{ workspaceId: 'w-asst', sessionIds: ['s-assistant'] }, { workspaceId: 'w-web', sessionIds: ['s-web'] }], archivedSessionIds: [] };
let statuses = new Map();
const hooks = { useSessions: (f) => f(list), useWorkspaces: (f) => f(workspaces), useSessionStatus: (f) => f(statuses), usePanelInfo: (f) => f({ activePanelId: null }) };

// Assistant apart from chats: on by default, its overlay hides the rows.
const [apartOpts, Apart] = entry('shell.overlay', 'assistant-apart');
let css = Apart({ ...apartOpts.inject(), ...hooks }).c.join('');
assert.match(css, /--dsh-workspace-indent"\] > \[data-row-key="session:s-assistant"\]/, 'the row under its project');
assert.match(css, /_flatList"\] > \[data-row-key="session:s-assistant"\]/, 'the row in the flat list');
assert.match(css, /:not\(\[class\*="_searchTree"\]\)/, 'search results stay');
assert.match(css, /\[data-row-key="workspace:w-asst"\]/, 'the Assistant project holds no other chat: hidden');
assert.doesNotMatch(css, /w-web|s-web/, 'other projects and chats stay');
assert.match(css, /display: none !important/);
// Another shown chat in the Assistant project: the project stays, only the assistant row goes.
workspaces.items[0].sessionIds.push('s-note'); list.byId['s-note'] = { blank: false };
css = Apart({ ...apartOpts.inject(), ...hooks }).c.join('');
assert.doesNotMatch(css, /workspace:w-asst/, 'a project with another chat stays');
// A blank, archived or subagent chat does not keep it.
list.byId['s-note'] = { blank: true };
assert.match(Apart({ ...apartOpts.inject(), ...hooks }).c.join(''), /workspace:w-asst/);
workspaces.items[0].sessionIds.pop(); delete list.byId['s-note'];

// The Assistant row: the state dot of the chat.
const [rowOpts, RowIcon] = entry('sidebar.panellist', 'composer-plus-assistant');
const button = { attrs: new Map(), style: {}, setAttribute(k, v) { this.attrs.set(k, v); }, removeAttribute(k) { this.attrs.delete(k); } };
const render = (extra) => { const el = RowIcon({ ...rowOpts.inject(), ...hooks, size: 16, active: false, t, ...extra }); const out = typeof el.t === 'function' ? el.t(el.p) : el; return out; };
let out = render();
assert.equal(out.p['data-composer-plus-assistant-state'], 'idle', 'idle: no dot');
assert.equal(find(out, (n) => n.t === 'StateDot'), undefined);
statuses = new Map([['s-assistant', { running: true }]]);
out = render(); assert.equal(out.p['data-composer-plus-assistant-state'], 'ongoing'); assert.equal(find(out, (n) => n.t === 'StateDot').p.state, 'ongoing');
assert.equal(out.p.title, 'assistantApart.running');
statuses = new Map([['s-assistant', { pendingInteraction: { kind: 'approval' } }]]);
out = render(); assert.equal(find(out, (n) => n.t === 'StateDot').p.state, 'warning', 'waiting: the orange warning dot'); assert.equal(out.p.title, 'assistantApart.waiting');
statuses = new Map([['s-assistant', { completionUnread: true }]]);
out = render(); assert.equal(find(out, (n) => n.t === 'StateDot').p.state, 'done'); assert.equal(out.p.title, 'assistantApart.done');
// A background topic (a running subagent of the assistant chat) counts as working.
statuses = new Map([['s-sub', { running: true }]]); list.projectionsBySession['s-assistant'] = { values: { subagentCatalog: [{ id: 's-sub' }] } };
out = render(); assert.equal(out.p['data-composer-plus-assistant-state'], 'ongoing', 'a background topic counts');
statuses = new Map(); delete list.projectionsBySession['s-assistant'];
// The row description for screen readers (aria-description) and the open state: the layout effect writes them on the
// row's button (useRef gives the button here, as React's ref would after mount). The row's end seat (below) needs
// document.createElement and button.append.
globalThis.document.createElement = (tag) => ({ tag, attrs: new Map(), style: {}, removed: false, setAttribute(k, v) { this.attrs.set(k, v); }, remove() { this.removed = true; } });
button.appended = []; button.append = (el) => { button.appended.push(el); };
const realRef = React.useRef;
React.useRef = () => ({ current: { closest: () => button } });
statuses = new Map([['s-assistant', { pendingInteraction: { kind: 'question' } }]]);
render();
assert.equal(button.attrs.get('aria-description'), 'assistantApart.waiting', 'the state for screen readers');
list.byId['s-assistant'].retainedBy = { mainView: 1 };
render();
assert.equal(button.attrs.get('aria-current'), 'page', 'the open chat marks the row as current');
React.useRef = realRef; delete list.byId['s-assistant'].retainedBy; statuses = new Map();
list.byId['s-assistant'].retainedBy = { mainView: 1 };
out = render(); assert.equal(out.p['data-open'], 'true', 'the open assistant chat marks the row');
assert.equal(render({ active: true }).p['data-open'], undefined, 'not while a panel is selected');
delete list.byId['s-assistant'].retainedBy;
// The dot sits at the row's right end (a seat at the end of the row button, like a project row's status), not on the
// icon. In the collapsed rail (size 18) the row has no end: the dot stays on the icon. The seat goes when the row goes.
// A small hook runtime: state that persists between draws, and layout effects that rerun only when their deps change.
{
  const real = [React.useState, React.useLayoutEffect];
  let hook = 0; const cells = []; const effects = [];
  React.useRef = () => ({ current: { closest: () => button } });
  React.useState = (v) => { const i = hook++; if (!(i in cells)) cells[i] = v; return [cells[i], (x) => { cells[i] = x; }]; };
  React.useLayoutEffect = (fn, deps) => {
    const i = hook++; const prev = effects[i];
    if (prev !== undefined && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]))) return;
    prev?.off?.(); const off = fn(); effects[i] = { deps, off: typeof off === 'function' ? off : undefined };
  };
  const draw = (size) => { hook = 0; return render({ size }); };
  const unmount = () => { for (const e of effects.splice(0)) e?.off?.(); cells.length = 0; };
  const portalOf = (n) => find(n, (x) => x.t === 'Portal');
  button.appended.length = 0;
  statuses = new Map([['s-assistant', { running: true }]]);
  draw(16); out = draw(16); // the first draw adds the seat, the next one fills it
  const seat = button.appended[0];
  assert.equal(button.appended.length, 1, 'one seat at the end of the row button');
  assert.ok(seat.attrs.has('data-composer-plus-assistant-dot') && seat.attrs.get('aria-hidden') === 'true', 'the seat: its attribute, hidden from screen readers');
  assert.match(seat.style.cssText, /margin-left:auto/, 'pushed to the right end of the row');
  assert.match(seat.style.cssText, /order:1/, 'after the label even when dsh adds the label later');
  assert.equal(portalOf(out)?.p.host, seat, 'the dot goes into the seat');
  assert.equal(find(portalOf(out), (n) => n.t === 'StateDot').p.state, 'ongoing', "dsh's own state dot");
  assert.equal(portalOf(out).c[0].p.title, 'assistantApart.running', 'the dot has the state as its tooltip');
  assert.equal(find(out, (n) => n.p?.style?.position === 'absolute'), undefined, 'no dot over the icon');
  // A new state redraws the same seat (no second seat).
  statuses = new Map([['s-assistant', { pendingInteraction: { kind: 'approval' } }]]);
  out = draw(16);
  assert.equal(button.appended.length, 1, 'still one seat');
  assert.equal(find(portalOf(out), (n) => n.t === 'StateDot').p.state, 'warning');
  // Idle: no dot, the empty seat stays (it takes no space).
  statuses = new Map(); out = draw(16);
  assert.equal(portalOf(out), undefined); assert.equal(find(out, (n) => n.t === 'StateDot'), undefined, 'idle: no dot');
  unmount();
  assert.ok(seat.removed, 'the seat goes with the row');
  // The collapsed rail: no seat, the dot stays on the icon.
  button.appended.length = 0; statuses = new Map([['s-assistant', { running: true }]]);
  draw(18); out = draw(18);
  assert.equal(button.appended.length, 0, 'the collapsed rail adds no seat');
  assert.equal(portalOf(out), undefined);
  assert.ok(find(out, (n) => n.p?.style?.position === 'absolute' && find(n, (x) => x.t === 'StateDot') !== undefined), 'in the rail the dot stays on the icon');
  // Expanding the rail again moves the dot to a new seat at the row's end.
  draw(16); out = draw(16);
  assert.equal(button.appended.length, 1); assert.equal(portalOf(out)?.p.host, button.appended[0], 'expanded again: the dot is at the end');
  assert.equal(button.appended[0].style.marginRight, undefined, 'dsh before 0.2.2-rc.2 (same padding on both sides): no shift');
  assert.match(find(portalOf(out), (n) => n.t === 'style').c.join(''), /_panelEntry.*:hover.*\[data-composer-plus-assistant-dot\]\{visibility:hidden\}/, 'the dot gives way to dsh 0.2.2-rc.2\'s pin button');
  unmount();
  // dsh 0.2.2-rc.2 keeps 38 px on the right of a wide panel row for its pin button (12 px on the left): the dot moves into
  // that room, where the project rows' status sits. Only with a mouse (hover): a touch screen shows no pin button.
  const realStyle = globalThis.getComputedStyle; const realMedia = globalThis.matchMedia;
  globalThis.getComputedStyle = () => ({ paddingLeft: '9px', paddingRight: '38px' }); globalThis.matchMedia = () => ({ matches: true });
  button.appended.length = 0; draw(16); draw(16);
  assert.equal(button.appended[0].style.marginRight, '-29px', '0.2.2-rc.2: the dot sits in the pin room');
  unmount(); globalThis.matchMedia = () => ({ matches: false });
  button.appended.length = 0; draw(16); draw(16);
  assert.equal(button.appended[0].style.marginRight, undefined, 'no hover: no shift');
  unmount(); globalThis.getComputedStyle = realStyle; globalThis.matchMedia = realMedia;
  [React.useState, React.useLayoutEffect] = real; React.useRef = realRef; statuses = new Map();
}
delete globalThis.document.createElement;

// Assistant messages only: a rule inside the assistant chat only.
const [viewOpts, View] = entry('shell.overlay', 'assistant-chat-view');
const viewCss = View({ ...viewOpts.inject(), t: (k) => k }).c[0].c.join(''); // <style> (the view cap's button needs a long chat: test/assistant-cap.test.mjs)
assert.match(viewCss, /\[data-conversation-session="s-assistant"\] \[data-chat-flow-kind="tool-call"\]/);
assert.match(viewCss, /\[data-conversation-session="s-assistant"\] \[data-chat-group-key\]/);
assert.match(viewCss, /\[data-conversation-session="s-assistant"\] \[data-chat-flow-kind="turn-process"\]/);
assert.doesNotMatch(viewCss, /data-chat-flow-kind="user"|turn-tail/, 'your messages and the turn tail stay');
for (const rule of viewCss.split(',\n')) assert.match(rule, /^\[data-conversation-session="s-assistant"\] /, 'every rule is inside the assistant chat');

// Settings: the four switches; the two Host ones go to the Host.
const toggles = settings.inject().hooks.composerPlusToggles;
assert.equal(toggles.getSnapshot().assistantFree, true); assert.equal(toggles.getSnapshot().assistantNotify, false, 'news: off by default');
await settings.inject().setFeature('assistantNotify', true); await tick();
assert.deepEqual(posts.at(-1), ['notify', { on: true }]); assert.equal(toggles.getSnapshot().assistantNotify, true);
// Tell me about: the menu under the switch while on; a pick posts {scope} once and shows at once.
{
  const [, Settings] = [...live.values()].find(([o]) => o.name === 'settings.section');
  const tree = () => Settings({ ...settings.inject(), useComposerPlusToggles: (f) => f(toggles.getSnapshot()), t });
  const scopeEl = () => find(tree(), (n) => typeof n.t === 'function' && n.t.name === 'AssistantNotifyScope');
  const el = scopeEl(); assert.ok(el, 'the scope menu while news is on');
  let menu = find(el.t(el.p), (n) => n.t === 'Menu');
  assert.equal(menu.p.selectedId, 'automations'); assert.deepEqual(menu.p.items.map((i) => i.id), ['automations', 'all']);
  assert.equal(text(menu.p.anchor), 'assistantNotify.scope.automations');
  menu.p.onSelect('all'); await tick();
  assert.deepEqual(posts.at(-1), ['notify', { scope: 'all' }]); assert.equal(switches.notify.scope, 'all');
  const count = posts.length; menu = find(el.t(el.p), (n) => n.t === 'Menu'); menu.p.onSelect('all'); await tick();
  assert.equal(posts.length, count, 'the same choice posts nothing');
  assert.equal(find(el.t(el.p), (n) => n.t === 'Menu').p.selectedId, 'all');
  menu.p.onSelect('automations'); await tick();
  // An older Host half (no scope in its answer): no menu.
  const old = { ...el.p, store: { subscribe: () => () => {}, getSnapshot: () => ({ on: true }) } };
  assert.equal(el.t(old), null, 'no scope from the Host: no menu');
  await settings.inject().setFeature('assistantNotify', false); await tick();
  assert.equal(scopeEl(), undefined, 'no menu while news is off');
  await settings.inject().setFeature('assistantNotify', true); await tick();
}
await settings.inject().setFeature('assistantFree', false); await tick();
assert.deepEqual(posts.at(-1), ['free', { on: false }]);
await settings.inject().setFeature('assistantFree', true); await tick();
// The inactive note: only when the Host says the rule is not active.
const [, Settings] = [...live.values()].find(([o]) => o.name === 'settings.section');
const settingsTree = (state) => { switches.free = state; return Settings({ ...settings.inject(), useComposerPlusToggles: (f) => f(toggles.getSnapshot()), t }); };
await settings.inject().setFeature('assistantFree', true); await tick();
switches.free = { on: true, active: false };
await settings.inject().setFeature('assistantFree', true); await tick();
const note = () => { const el = find(settingsTree(switches.free), (n) => typeof n.t === 'function' && n.t.name === 'AssistantFreeNote'); assert.ok(el, 'the note element'); return el.t(el.p); };
assert.match(text(note()), /assistantFree\.inactive/, 'the note when not active');
switches.free = { on: true, active: true };
await settings.inject().setFeature('assistantFree', true); await tick();
assert.equal(note(), null, 'no note while active');

// Switch Assistant apart off: its overlay goes, the row icon is plain again.
const toggled = (id, on) => { toggles.update((d) => { d[id] = on; }); };
toggled('assistantApart', false); await tick();
assert.equal(entry('shell.overlay', 'assistant-apart'), undefined, 'the rule goes');
out = render(); assert.equal(out.t === 'svg' || out.p?.['data-composer-plus-assistant-state'] === undefined, true, 'the plain icon');
assert.equal(entry('sidebar.panellist', 'composer-plus-assistant') !== undefined, true, 'the Assistant row stays');
toggled('assistantApart', true); await tick();
assert.ok(entry('shell.overlay', 'assistant-apart'), 'back on');
toggled('assistantChatView', false); await tick();
assert.equal(entry('shell.overlay', 'assistant-chat-view'), undefined);
toggled('assistantChatView', true); await tick();

// Assistant off: the Host gives no id, so no rule.
await settings.inject().setFeature('assistant', false); await tick();
const [apartAgain, ApartAgain] = entry('shell.overlay', 'assistant-apart');
assert.equal(ApartAgain({ ...apartAgain.inject(), ...hooks }), null, 'no id: no rule');
console.log('assistant bot client: ok');
