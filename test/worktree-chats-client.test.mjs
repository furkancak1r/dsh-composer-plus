// Branch per chat, client half: the header pill text, the send hook on the composer (installs once, gives the original
// sink back, refuses files, one start per chat), the feature switch (off gives every sink back), the New chat chip menu
// (other worktrees, the Workspace tree hint) and the header pill (newest read wins, a click opens Changes).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
const listeners = new Map();
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } },
  addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
  removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); } };
globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
// The helpers are module-private: run the module source with a hook that hands them out.
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__wt = { branchLabel, branchModeOf, chooseBranchMode, installBranchSink, BranchChip, BranchStatus };\n    ${ANCHOR}`));

// Fake Host: only the worktrees route answers; `reply` returns { status, body }, an Error to throw, or a promise of one.
const ROUTE = '/api/composer-plus.worktrees';
const calls = []; let reply = () => ({ status: 404, body: {} });
globalThis.fetch = async (url, init) => {
  const body = init?.body === undefined ? undefined : JSON.parse(init.body);
  if (!url.startsWith(ROUTE)) return { ok: false, status: 404, json: async () => ({}) };
  calls.push([url, body]);
  const r = await reply(url, body);
  if (r instanceof Error) throw r;
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

// Fake React with hooks; a mounted component runs its effects when their deps change.
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = typeof v === 'function' ? v() : v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; return cur.refs[i] ??= { current: v }; },
  useEffect: (f, deps) => { cur.effects.push([f, deps]); },
  useSyncExternalStore: (subscribe, get) => get() };
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
  return { render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const text = (n) => (n == null ? '' : typeof n === 'string' ? n : (n.c ?? []).map(text).join(''));
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', IconBranchOutlineRegular: 'IconBranch', IconChevronDownOutlineRegular: 'IconChevron' } : {}));
const { branchLabel, branchModeOf, chooseBranchMode, installBranchSink, BranchChip, BranchStatus } = globalThis.__wt;

// dsh: locale (the plugin's English pack, dsh's own sidebar labels), one composer shell per chat, navigation, slots.
let en;
const WORKSPACE = { 'viewOptions.label': 'View options', 'groupBy.workspaceTree': 'Workspace Tree' };
const bind = (ns) => (k, p = {}) => String((ns === 'workspace' ? WORKSPACE : en)[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => p[x]);
const opened = []; const workspaces = []; const tabs = [];
const shells = new Map();
const shell = (id) => {
  const s = { sent: [], notes: [], notify: (level, note) => s.notes.push([level, note]) };
  s.original = async (...args) => { s.sent.push(args); return { kind: 'success' }; };
  s.deps = { defaultSink: s.original };
  shells.set(id, s); return s;
};
const live = new Map(); let next = 0; const unloads = [];
const slots = { inject: (name, f) => { const off = f(); return () => off(); }, register: (o) => { const k = `${o.name}#${o.id ?? o.key}#${next++}`; live.set(k, o); return () => live.delete(k); } };
// dsh's composer blocks (the reason that the input shows) and its draft attachments (wire form, release).
const blocks = new Map(); const blockLog = []; const released = [];
const conversation = { input: { for: (scope) => shells.get(scope.id) },
  blocks: { set: (id, block) => { blockLog.push([id, block?.reason]); if (block === undefined) blocks.delete(id); else blocks.set(id, block); }, storeFor: (id) => ({ getSnapshot: () => blocks.get(id) }) },
  serializeDraftAttachments: async (ids) => ({ attachments: ids.map((id) => (id.startsWith('img') ? { type: 'image', mediaType: 'image/png', data: `b64-${id}` } : { type: 'file', receiptId: `rc-${id}` })) }),
  releaseDraftAttachment: (id) => released.push(id) };
const ctx = { slots, configForms: { get: () => ({}) }, effect: (f) => { const off = f(); if (typeof off === 'function') unloads.push(off); },
  locale: { register: (ns, packs) => { if (ns === 'dsh-composer-plus') en = packs.en; return () => {}; }, bind, getLocale: () => ({ active: 'en', locales: [] }) },
  sessions: { scope: (id) => ({ id }), list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
  get: (name) => (name === 'conversation' ? conversation
    : name === 'uiWorkspace' ? { openSession: (id) => opened.push(id), openWorkspace: async (id) => { workspaces.push(id); } }
    : name === 'sidebarRight' ? { openTabIn: (id, kind) => tabs.push([id, kind]) } : undefined),
  inject: (deps, setup) => { const disposers = []; setup({ effect: (f) => { const off = f(); if (typeof off === 'function') disposers.push(off); }, uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
    sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } }, uiWorkspace: {}, workspaces: { list: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    sidebarRight: {}, sidebarRightTabs: { register: () => () => {} } }); return { dispose: () => disposers.forEach((f) => f()) }; } };
plugin.apply(ctx);
const t = bind('dsh-composer-plus');
const ids = () => [...live.values()].map((o) => o.id ?? o.key);
const reg = (id) => [...live.values()].find((o) => o.id === id);
const { setFeature } = reg('composer-plus').inject();
assert.ok(ids().includes('branch-chip') && ids().includes('branch-status'), 'on by default: the chip and the header pill');
assert.equal(reg('branch-chip').name, 'conversation.hero.options'); assert.equal(reg('branch-status').name, 'conversation.session.header.utilities');

// Header pill text: zero parts are left out; "not pushed" without an upstream; a detached HEAD is not a branch to push.
assert.equal(branchLabel({ branch: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 1, changes: 3 }, t), '⑂ feat/x · 3 changes · ↑2 ↓1');
assert.equal(branchLabel({ branch: 'feat/y', upstream: null, ahead: 0, behind: 0, changes: 1 }, t), '⑂ feat/y · 1 change · not pushed');
assert.equal(branchLabel({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0 }, t), '⑂ main', 'clean and in sync: the branch only');
assert.equal(branchLabel({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 4, changes: 0 }, t), '⑂ main · ↓4');
assert.equal(branchLabel({ branch: '(abc1234)', upstream: null, ahead: 0, behind: 0, changes: 2 }, t), '⑂ (abc1234) · 2 changes', 'the Host names a detached HEAD by its commit');
assert.equal(branchLabel({ branch: 'HEAD', upstream: null, ahead: 0, behind: 0, changes: 0 }, t), '⑂ detached HEAD');
assert.equal(branchLabel({ branch: null, upstream: null, changes: 0 }, t), '⑂ detached HEAD');
assert.equal(branchLabel({ branch: 'feat/z' }, t), '⑂ feat/z', 'no status read: the branch only');

// The send hook. "New branch" wraps the chat's composer sink once; "Current branch" gives the original back.
const s1 = shell('s1'); const chip1 = reg('branch-chip').inject('s1');
assert.equal(chip1.canBranch(), true);
shells.set('s0', { deps: {} }); assert.equal(reg('branch-chip').inject('s0').canBranch(), false, 'no dsh sink: no "New branch"');
chip1.ensureSink(); assert.equal(s1.deps.defaultSink, s1.original, 'nothing is wrapped on "Current branch"');
chooseBranchMode('s1', 'new');
let wrapper = s1.deps.defaultSink; assert.notEqual(wrapper, s1.original, '"New branch" wraps the composer send');
chip1.ensureSink(); chooseBranchMode('s1', 'new'); assert.equal(s1.deps.defaultSink, wrapper, 'it wraps once');
chooseBranchMode('s1', 'current'); assert.equal(s1.deps.defaultSink, s1.original, 'back on "Current branch": the original sink');
chooseBranchMode('s1', 'new'); wrapper = s1.deps.defaultSink;
const send = (body, files = []) => s1.deps.defaultSink(body, files, 'default', undefined);
assert.deepEqual(await send(''), { kind: 'success' }); assert.deepEqual(s1.sent, [['', [], 'default', undefined]], 'an empty message goes to dsh');
// One start per chat: a second send while the first runs is refused inside the wrapper; the menu cannot change the mode.
{
  const g = gate(); reply = async () => { await g.p; return { status: 200, body: { sessionId: 'new-1', branch: 'feat/fix-login', path: '/repo/.worktrees/feat-fix-login', workspaceId: 'w-2' } }; };
  const first = send('Fix login'); await tick();
  assert.equal(branchModeOf('s1'), 'busy');
  assert.deepEqual(blocks.get('s1'), { reason: en['worktree.creating'] }, 'while the branch is made, the composer takes no text');
  assert.deepEqual(await send('Fix login again'), { kind: 'error', text: en['worktree.busy'] }, 'a second send while the first runs');
  assert.equal(calls.length, 1, 'one start per chat');
  chooseBranchMode('s1', 'current'); assert.equal(branchModeOf('s1'), 'busy', 'no mode change while it runs'); assert.equal(s1.deps.defaultSink, wrapper);
  g.go(); assert.deepEqual(await first, { kind: 'success' });
  assert.deepEqual(calls[0], [ROUTE, { action: 'start', sessionId: 's1', text: 'Fix login' }]);
  assert.equal(blocks.has('s1'), false, 'the block goes when the chat starts');
  assert.deepEqual(opened, ['new-1'], 'the new chat opens'); assert.equal(s1.deps.defaultSink, s1.original, 'after the start: the original sink');
  assert.equal(branchModeOf('s1'), 'current');
}
// A failed start keeps "New branch" and shows the Host's reason, else a short text; an older Host asks for a restart.
chooseBranchMode('s1', 'new');
for (const [answer, shown] of [[{ status: 409, body: { error: 'this chat has no project folder' } }, 'this chat has no project folder'],
  [new TypeError('Failed to fetch'), en['worktree.failed']], [{ status: 500, body: {} }, en['worktree.failed']],
  [{ status: 200, body: {} }, en['worktree.failed']], [{ status: 404, body: {} }, en['worktree.restart']]]) {
  reply = () => answer;
  assert.deepEqual(await send('Fix login'), { kind: 'error', text: shown }, JSON.stringify(answer));
  assert.equal(branchModeOf('s1'), 'new'); assert.notEqual(s1.deps.defaultSink, s1.original, 'the wrapper stays for the next try');
  assert.equal(blocks.has('s1'), false, 'a failed start gives the composer back');
}
assert.equal(opened.length, 1, 'no chat opens after a failure');
// Attachments go with the first message in dsh's wire form; after the start this composer frees its drafts.
{
  reply = () => ({ status: 200, body: { sessionId: 'new-files' } }); released.length = 0;
  assert.deepEqual(await send('', ['img-1', 'doc-1']), { kind: 'success' }, 'files only');
  assert.deepEqual(calls.at(-1), [ROUTE, { action: 'start', sessionId: 's1', text: '', attachments: [{ type: 'image', mediaType: 'image/png', data: 'b64-img-1' }, { type: 'file', receiptId: 'rc-doc-1' }] }]);
  assert.deepEqual(released, ['img-1', 'doc-1']); assert.equal(opened.at(-1), 'new-files'); assert.equal(s1.deps.defaultSink, s1.original);
  // A failed start keeps the drafts (dsh puts them back) and frees no block that another plugin set.
  chooseBranchMode('s1', 'new'); reply = () => ({ status: 409, body: { error: 'a file of this message is not uploaded any more: add it again' } }); released.length = 0;
  assert.deepEqual(await send('Use this', ['doc-2']), { kind: 'error', text: 'a file of this message is not uploaded any more: add it again' });
  assert.deepEqual(released, [], 'the drafts stay'); assert.equal(blocks.has('s1'), false);
  const g = gate(); reply = async () => { await g.p; return { status: 500, body: {} }; };
  const failing = send('Again'); await tick(); blocks.set('s1', { reason: 'Model unavailable' });
  g.go(); await failing; assert.deepEqual(blocks.get('s1'), { reason: 'Model unavailable' }, 'another block stays'); blocks.delete('s1');
}
// Switched off: every composer gets its own sink back; a running start keeps its mark until the Host answers.
setFeature('worktreeChats', false);
assert.equal(s1.deps.defaultSink, s1.original, 'switched off: the original sink'); assert.equal(branchModeOf('s1'), 'current');
assert.ok(!ids().includes('branch-chip') && !ids().includes('branch-status'), 'and no slot');
// The wrapper alone (no mode listener while the feature is off): after a start it gives the original sink back itself.
{
  const deps = { defaultSink: async () => ({ kind: 'success' }) }; const original = deps.defaultSink; const started = [];
  chooseBranchMode('solo', 'new');
  const blockedSolo = [];
  installBranchSink('solo', deps, { start: async (id, body) => { started.push([id, body]); return { sessionId: 'solo-new' }; }, serialize: async () => [], release() {}, block: (id, reason) => blockedSolo.push(reason), open: (id) => started.push(id), t });
  const wrapped = deps.defaultSink; assert.notEqual(wrapped, original);
  installBranchSink('solo', deps, { start: () => assert.fail('a second wrapper'), open() {}, t }); assert.equal(deps.defaultSink, wrapped, 'it wraps once');
  assert.deepEqual(await deps.defaultSink('Hello', [], 'default'), { kind: 'success' });
  assert.deepEqual(started, [['solo', 'Hello'], 'solo-new']); assert.equal(deps.defaultSink, original, 'the original sink is back'); assert.equal(branchModeOf('solo'), 'current');
  assert.deepEqual(blockedSolo, [en['worktree.creating'], undefined], 'blocked while it ran');
}
setFeature('worktreeChats', true); assert.ok(ids().includes('branch-chip')); assert.equal(s1.deps.defaultSink, s1.original, 'on again: nothing wrapped until chosen');
{
  chooseBranchMode('s1', 'new'); const g = gate(); reply = async () => { await g.p; return { status: 200, body: { sessionId: 'new-2' } }; };
  const running = send('Add search'); await tick();
  setFeature('worktreeChats', false);
  assert.equal(s1.deps.defaultSink, s1.original); assert.equal(branchModeOf('s1'), 'busy', 'the running start keeps its mark');
  assert.deepEqual(blocks.get('s1'), { reason: en['worktree.creating'] }, 'and its composer block until the Host answers');
  setFeature('worktreeChats', true); chooseBranchMode('s1', 'new');
  assert.equal(s1.deps.defaultSink, s1.original, 'no second start of this chat while the first runs'); assert.equal(branchModeOf('s1'), 'busy');
  g.go(); assert.deepEqual(await running, { kind: 'success' }); assert.equal(opened.at(-1), 'new-2'); assert.equal(branchModeOf('s1'), 'current');
  assert.equal(blocks.has('s1'), false, 'then the block goes');
}

// New chat chip: "⑂ main", a menu with the modes, the other worktrees and the Workspace tree hint.
const worktree = (path, branch, extra = {}) => ({ path, branch, main: false, current: false, upstream: `origin/${branch}`, ahead: 0, behind: 0, changes: 0, ...extra });
const LIST = { repo: true, root: '/repo', top: '/repo', worktree: false, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0,
  worktrees: [worktree('/repo', 'main', { main: true, current: true }), worktree('/repo/.worktrees/feat-a', 'feat/a', { ahead: 1, changes: 2 }), worktree('/repo/.worktrees/fix-b', 'fix/b', { upstream: null })] };
reply = (url, body) => (body?.action === 'open' ? (body.path.endsWith('feat-a') ? { status: 200, body: { workspaceId: 'w-a' } } : { status: 403, body: { error: 'not a worktree of this repository' } })
  : { status: 200, body: LIST });
const s2 = shell('s2');
const chipOf = async (id) => {
  const v = mount(BranchChip, { sessionId: id, ...reg('branch-chip').inject(id), t });
  assert.equal(v.render(), null, 'nothing while the first read runs'); await tick();
  return { v, menu: () => v.render()?.c[1] };
};
let chip = await chipOf('s2');
assert.deepEqual(calls.at(-1), [`${ROUTE}?sessionId=s2&list=1`, undefined]);
let menu = chip.menu(); const item = (id) => menu.p.items.find((i) => i.id === id);
assert.equal(menu.t, 'Menu'); assert.equal(menu.p.anchor.p['data-composer-plus-new-branch-chip'], 'current'); assert.equal(text(menu.p.anchor), 'main');
// It looks like dsh's project and mode buttons: branch icon (16 px), label, chevron (12 px); the menu opens from its start.
assert.deepEqual(menu.p.anchor.c.map((c) => c.t ?? 'text'), ['IconBranch', 'span', 'IconChevron']); assert.equal(menu.p.anchor.c[0].p.size, 16);
assert.deepEqual(menu.p.anchor.c[2].p, { size: 12, className: 'cp-branch-chevron' }); assert.equal(menu.p.anchor.p.className, 'cp-branch cp-branch-chip'); assert.equal(menu.p.align, 'start');
// Its style (only while the chip shows) puts dsh's project button first and the options box before the mode button.
{ const css = text(chip.v.render().c[0]);
  assert.match(css, /\.cp-branch-chip\{gap:4px;color:var\(--dsw-alias-label-primary\);font-weight:500\}/);
  assert.match(css, /\[class\*="_heroWorkspaceRow"\]:has\(>\[class\*="_heroOptions"\] \[data-composer-plus-new-branch-chip\]\)>button\[class\*="_workspace"\]\{order:-2\}/);
  assert.match(css, /\[class\*="_heroWorkspaceRow"\]>\[class\*="_heroOptions"\]:has\(\[data-composer-plus-new-branch-chip\]\)\{order:-1;margin-left:0\}/); }
assert.deepEqual(menu.p.items.map((i) => i.id), ['current', 'new', 'worktrees', 'wt:/repo/.worktrees/feat-a', 'wt:/repo/.worktrees/fix-b', 'hint', 'tree-hint'], 'the current worktree is not listed');
assert.equal(menu.p.selectedId, 'current'); assert.equal(item('current').label, 'Current branch (main)');
assert.equal(item('new').label.p['data-composer-plus-branch-new'], ''); assert.equal(text(item('new').label), 'New branchThe AI names it from your first message.');
const featA = item('wt:/repo/.worktrees/feat-a').label; assert.equal(featA.p['data-composer-plus-branch-item'], '/repo/.worktrees/feat-a');
assert.equal(featA.c[0], '⑂ feat/a'); assert.equal(text(featA.c[1]), '2 changes · ↑1');
assert.equal(text(item('wt:/repo/.worktrees/fix-b').label.c[1]), 'not pushed');
// The tree hint names dsh's own labels and shows only while another grouping is active.
assert.equal(item('tree-hint').text.p['data-composer-plus-branch-hint'], '');
assert.equal(text(item('tree-hint').text), 'To see branch folders inside their project: View options → Workspace Tree');
const hinted = () => chip.menu().p.items.some((i) => i.id === 'tree-hint');
for (const [saved, shown] of [[{ groupBy: 'workspace-tree' }, false], [{ groupBy: 'flat' }, true], [{ groupBy: 'workspace' }, true], ['not json', true]]) {
  mem.set('dsh.workspace.view.v5', typeof saved === 'string' ? saved : JSON.stringify(saved));
  assert.equal(hinted(), shown, `groupBy ${JSON.stringify(saved)}`);
}
mem.delete('dsh.workspace.view.v5'); assert.equal(hinted(), true, 'dsh default grouping: the hint');
// "New branch" from the menu: the chip says so and the composer send is wrapped.
menu.p.onSelect('new'); menu = chip.menu();
assert.equal(branchModeOf('s2'), 'new'); assert.equal(menu.p.anchor.p['data-composer-plus-new-branch-chip'], 'new'); assert.equal(text(menu.p.anchor), 'New branch');
assert.equal(menu.p.selectedId, 'new'); assert.notEqual(s2.deps.defaultSink, s2.original);
{
  const g = gate(); const prev = reply; reply = async () => { await g.p; return { status: 200, body: { sessionId: 'new-3' } }; };
  const running = s2.deps.defaultSink('Add dark mode', [], 'default'); await tick(); menu = chip.menu();
  assert.equal(menu.p.anchor.p['data-composer-plus-new-branch-chip'], 'busy'); assert.equal(text(menu.p.anchor), 'Creating branch…'); assert.equal(menu.p.anchor.p.disabled, true);
  g.go(); await running; reply = prev; assert.equal(chip.menu().p.anchor.p['data-composer-plus-new-branch-chip'], 'current');
}
// Another worktree: the Host registers it, then dsh opens its project; an error shows in the composer.
menu = chip.menu(); menu.p.onSelect('wt:/repo/.worktrees/feat-a'); await tick();
assert.deepEqual(calls.at(-1), [ROUTE, { action: 'open', sessionId: 's2', path: '/repo/.worktrees/feat-a' }]); assert.deepEqual(workspaces, ['w-a']);
menu.p.onSelect('wt:/repo/.worktrees/fix-b'); await tick();
assert.deepEqual(s2.notes, [['error', 'not a worktree of this repository']]); assert.deepEqual(workspaces, ['w-a']);
// The chip goes (the chat left the New chat screen): "New branch" ends and the composer gets its own sink back.
chip.menu().p.onSelect('new'); assert.notEqual(s2.deps.defaultSink, s2.original);
chip.v.unmount(); assert.equal(branchModeOf('s2'), 'current'); assert.equal(s2.deps.defaultSink, s2.original, 'no branch from a chip that is gone');
// No "New branch" without dsh's sink; no chip outside a repository or when the read fails.
chip = await chipOf('s0'); assert.ok(!chip.menu().p.items.some((i) => i.id === 'new'));
reply = () => ({ status: 200, body: { repo: false } }); chip = await chipOf('s2'); assert.equal(chip.menu(), undefined, 'not a repository: no chip');
reply = () => new TypeError('Failed to fetch'); chip = await chipOf('s2'); assert.equal(chip.menu(), undefined, 'a failed read: no chip');

// Header pill: one read on open, 500 ms after a turn ends and on window focus; the newest read wins; a click opens Changes.
{
  let statuses = new Map([['s3', { running: false }]]); let toggles = {};
  reply = () => ({ status: 200, body: { repo: true, root: '/repo', branch: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 1, changes: 3, worktree: true } });
  const v = mount(BranchStatus, { sessionId: 's3', useSessionStatus: (sel) => sel(statuses), useComposerPlusToggles: (sel) => sel(toggles), ...reg('branch-status').inject('s3'), t });
  assert.equal(v.render(), null); await tick();
  assert.deepEqual(calls.at(-1), [`${ROUTE}?sessionId=s3`, undefined]);
  let pill = v.render().c[1]; const label = '⑂ feat/x · 3 changes · ↑2 ↓1';
  assert.equal(pill.t, 'button'); assert.equal(text(pill), label); assert.equal(pill.p.title, label); assert.equal(pill.p['aria-label'], label);
  assert.equal(pill.p['data-composer-plus-branch-status'], 'feat/x');
  pill.p.onClick(); assert.deepEqual(tabs, [['s3', 'composer-plus-changes']], 'a click opens Changes for this chat');
  toggles = { changesPanel: false }; pill = v.render().c[1]; assert.equal(pill.t, 'span', 'Changes is off: not a button'); assert.equal(pill.p.onClick, undefined);
  const reads = () => calls.filter(([url]) => url === `${ROUTE}?sessionId=s3`).length;
  const before = reads();
  statuses = new Map([['s3', { running: true }]]); v.render(); statuses = new Map([['s3', { running: false }]]); v.render();
  assert.equal(reads(), before, 'not at once');
  await new Promise((r) => setTimeout(r, 520)); v.render(); assert.equal(reads(), before + 1, 'read again 500 ms after the turn ended');
  await tick();
  const gA = gate(); const gB = gate(); let n = 0;
  reply = async () => { const mine = ++n; await (mine === 1 ? gA.p : gB.p); return { status: 200, body: { repo: true, branch: mine === 1 ? 'old' : 'new', upstream: null, ahead: 0, behind: 0, changes: 0 } }; };
  const focus = () => { for (const fn of [...(listeners.get('focus') ?? [])]) fn(); v.render(); };
  focus(); focus(); assert.equal(n, 2, 'each focus reads');
  gB.go(); await tick(); gA.go(); await tick();
  assert.equal(text(v.render().c[1]), '⑂ new · not pushed', 'the newest read wins');
  reply = () => ({ status: 200, body: { repo: false } }); focus(); await tick(); assert.equal(v.render(), null, 'not a repository: no pill');
  const focusBefore = listeners.get('focus').size; v.unmount(); assert.equal(listeners.get('focus').size, focusBefore - 1, 'unmount removes the focus listener');
}

// Unload: the wrapped composer gets its own sink back.
chooseBranchMode('s1', 'new'); assert.notEqual(s1.deps.defaultSink, s1.original);
for (const off of unloads) off();
assert.equal(s1.deps.defaultSink, s1.original, 'unload gives the original sink back'); assert.equal(branchModeOf('s1'), 'current');
console.log('worktree chats client checks passed');
