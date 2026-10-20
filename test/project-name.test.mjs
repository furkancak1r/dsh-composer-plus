// Project name in the composer: the name comes from dsh's project title, else the last folder of the chat's working
// directory; the pill shows it with the path as tooltip, and the switch adds and removes its dock slot.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ on: true }) });
eval(src.replace('    function ComposerHistory({', '    globalThis.__pn = { projectNameOf, ProjectNamePill };\n    function ComposerHistory({'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect() {}, useSyncExternalStore: (s, g) => g() };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
const { projectNameOf, ProjectNamePill } = globalThis.__pn;

// 1. The name: dsh's project title first; else the folder name of the chat's cwd (or the project's path); else nothing.
const workspaces = { items: [{ workspaceId: 'w1', title: 'Greeter app', path: '/Users/demo/projects/greeter', sessionIds: ['s1'] },
  { workspaceId: 'w2', title: '  ', path: '/Users/demo/projects/party-planner/', sessionIds: ['s2'] }] };
const sessions = { byId: { s1: { cwd: '/Users/demo/projects/greeter' }, s3: { cwd: 'C:\\Users\\demo\\work\\billing\\' } } };
assert.equal(projectNameOf('s1', workspaces, sessions), 'Greeter app', 'dsh\'s project title');
assert.equal(projectNameOf('s2', workspaces, sessions), 'party-planner', 'a blank title falls back to the folder name (trailing slash too)');
assert.equal(projectNameOf('s3', workspaces, sessions), 'billing', 'a Windows path works too');
assert.equal(projectNameOf('s4', workspaces, sessions), null, 'no project, no cwd: nothing');
assert.equal(projectNameOf('s1', undefined, undefined), null, 'stores not loaded yet');

// 2. The pill: name as label, the folder path as tooltip; nothing without a name.
const hook = (value) => (select) => select(value);
const pill = ProjectNamePill({ sessionId: 's1', useWorkspaces: hook(workspaces), useSessions: hook(sessions) });
assert.equal(pill.p.title, '/Users/demo/projects/greeter');
assert.equal(pill.c.at(-1).c[0], 'Greeter app');
assert.equal(ProjectNamePill({ sessionId: 's4', useWorkspaces: hook(workspaces), useSessions: hook(sessions) }), null);

// 3. The switch: on by default; it adds the dock slot left of dsh's pills and removes it again.
let next = 0; const live = new Map();
const slots = { inject: (name, f) => { const off = f(); return () => off(); }, register: (o) => { const k = `${o.name}#${o.id}#${next++}`; live.set(k, o); return () => live.delete(k); } };
plugin.apply({ slots, configForms: { get: () => ({}) }, effect: () => {}, locale: { register: () => () => {}, bind: () => (k) => k, getLocale: () => ({ active: 'en', locales: [] }) },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } }, get: () => undefined, inject: () => ({ dispose() {} }) });
const slot = () => [...live.values()].find((o) => o.id === 'project-name');
assert.equal(slot()?.name, 'conversation.composer.dock'); assert.ok(slot().order < 0, 'before dsh\'s own stats pills (order 0 and 1)');
const settings = [...live.values()].find((o) => o.id === 'composer-plus');
settings.inject().setFeature('projectName', false); assert.equal(slot(), undefined, 'switched off: the pill goes away');
settings.inject().setFeature('projectName', true); assert.ok(slot(), 'switched on again');
console.log('project-name checks passed');
