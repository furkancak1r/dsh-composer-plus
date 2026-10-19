// Resume after restart: the Host remembers the top-level chats that dsh stopped while they ran, and continues them once at
// the next start. Fake agents, goals and storage; the real index.js apply() wiring.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, RESUME_PATH, RESUME_MAX, resumeStore, resumeTracker, stoppedByDsh, wakeSession } from '../index.js';

const root = mkdtempSync(join(tmpdir(), 'cp-resume-'));
const tick = () => new Promise((r) => setTimeout(r, 5));
// The list is written by a queue of async writes: wait (at most 2 s) until the saved ids match. A fixed tick was too short
// on a busy CI runner.
const savedIds = async (home, want) => {
  const read = () => { try { return JSON.parse(readFileSync(join(home, 'storages/dsh-composer-plus/resume.json'), 'utf8')).sessions.map((s) => s.id); } catch { return undefined; } };
  for (let i = 0; i < 400 && JSON.stringify(read()) !== JSON.stringify(want); i++) await tick();
  return read();
};
const quit = { kind: 'aborted', reason: { kind: 'disposed' } };

assert.equal(stoppedByDsh(quit), true);
assert.equal(stoppedByDsh({ kind: 'aborted', reason: { kind: 'parent' } }), true, 'goal round cut by the goal driver shutdown');
assert.equal(stoppedByDsh({ kind: 'interrupted' }), true, 'crash');
for (const end of [{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'completed' }, { kind: 'error' }, { kind: 'max-tokens' }, { kind: 'blocked' }, undefined]) {
  assert.equal(stoppedByDsh(end), false, JSON.stringify(end));
}

// Store: a missing or broken file is off; writes are owner-only and in order.
{
  const file = join(root, 's', 'resume.json');
  const store = resumeStore(file);
  assert.deepEqual(await store.read(), { on: false, sessions: [] });
  await store.write({ on: true, sessions: [{ id: 'a', at: 1 }] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  store.write({ on: true, sessions: [] }); await store.write({ on: true, sessions: [{ id: 'b', at: 2 }] });
  assert.deepEqual(await store.read(), { on: true, sessions: [{ id: 'b', at: 2 }] }, 'last write wins');
  writeFileSync(file, '{"on":true,"sessions":[{"id":"ok","at":3},{"id":7},{"at":1},"x"]}');
  assert.deepEqual(await store.read(), { on: true, sessions: [{ id: 'ok', at: 3 }] }, 'bad rows are dropped');
  writeFileSync(file, '{broken'); assert.deepEqual(await store.read(), { on: false, sessions: [] });
}

// Tracker: which chats a quit leaves in the list.
const memStore = (data = { on: false, sessions: [] }) => {
  const s = { data, writes: 0, fail: false,
    read: async () => structuredClone(s.data),
    write: async (d) => { if (s.fail) throw new Error('disk full'); s.writes++; s.data = structuredClone(d); },
    flush: async () => {} };
  return s;
};
const agent = (id, root = true) => ({ id, root, status: 'idle' });
let clock = 1000;
const track = (store, more = {}) => resumeTracker({ store, isRoot: (a) => a.root, now: () => clock++, ...more });
{
  const store = memStore();
  const t = track(store); await t.ready;
  const a = agent('a');
  t.status(a, 'running'); await tick();
  assert.deepEqual(store.data.sessions, [], 'off: nothing is saved');
  await t.setOn(true);
  const [b, c, d, e, sub] = ['b', 'c', 'd', 'e', 'sub'].map((id) => agent(id, id !== 'sub'));
  for (const x of [b, c, d, e, sub]) t.status(x, 'running');
  await tick();
  assert.deepEqual(store.data.sessions.map((s) => s.id), ['b', 'c', 'd', 'e'], 'running top-level chats are saved; subagents are not');
  t.turnEnd('b', { kind: 'completed' }); t.status(b, 'idle');
  t.turnEnd('c', { kind: 'aborted', reason: { kind: 'user' } }); t.status(c, 'idle');
  t.turnEnd('d', quit); t.status(d, 'idle');
  t.turnEnd('e', { kind: 'error' }); t.status(e, 'idle');
  await tick();
  assert.deepEqual(store.data.sessions.map((s) => s.id), ['d'], 'only the chat dsh stopped stays (done, stopped by you, failed are removed)');
  t.status(e, 'running'); t.turnEnd('e', { kind: 'completed' }); t.status(e, 'idle'); await tick();
  assert.deepEqual(store.data.sessions.map((s) => s.id), ['d'], 'a second run that finishes removes it again');
  t.status(e, 'running'); t.status(e, 'idle'); await tick();
  assert.deepEqual(store.data.sessions.map((s) => s.id), ['d'], 'idle before any turn started (stopped at once) removes it');
  t.status(e, 'running'); t.turnStart('e'); t.status(e, 'idle'); await tick();
  assert.deepEqual(store.data.sessions.map((s) => s.id), ['d', 'e'], 'an open turn without an end (the shutdown could not write it) keeps the chat');
  await t.close();
  const writes = store.writes; t.status(agent('late'), 'running'); await tick();
  assert.equal(store.writes, writes, 'no writes after unload');
}
{
  // Switching on mid-turn adopts the chats that already run; switching off forgets everything; a failed save changes nothing.
  const store = memStore();
  const t = track(store, { running: () => ['x'] }); await t.ready;
  await t.setOn(true);
  assert.deepEqual(store.data, { on: true, sessions: [{ id: 'x', at: store.data.sessions[0].at }] });
  t.status(agent('x'), 'idle'); await tick();
  assert.deepEqual(store.data.sessions.map((s) => s.id), ['x'], 'an adopted turn that ends without a turn end (shutdown) stays');
  store.fail = true;
  await assert.rejects(t.setOn(false), /disk full/);
  assert.equal(t.isOn(), true, 'still on after a failed save');
  store.fail = false;
  await t.setOn(false);
  assert.deepEqual(store.data, { on: false, sessions: [] });
}

// Wake: continue each saved chat once, newest first, capped, and forget the list before the first wake.
{
  const store = memStore({ on: true, sessions: Array.from({ length: RESUME_MAX + 3 }, (_, i) => ({ id: `s${i}`, at: i })) });
  const order = [];
  const t = track(store, { wakeOne: async (id) => { order.push(id); if (id === 's21') throw new Error('gone'); return 'continued'; } });
  const results = await t.wake();
  assert.equal(order.length, RESUME_MAX, 'cap');
  assert.equal(order[0], `s${RESUME_MAX + 2}`, 'newest first');
  assert.equal(results.find((r) => r.id === 's21').result, 'failed', 'one failure does not stop the rest');
  assert.deepEqual(store.data.sessions, [], 'the list is forgotten');
  assert.deepEqual(await t.wake(), [], 'only once per start');
}
{
  // A chat from the last run that is running again before wake() keeps its new entry.
  const store = memStore({ on: true, sessions: [{ id: 'old', at: 1 }] });
  const t = track(store, { wakeOne: async () => 'continued' }); await t.ready;
  t.status(agent('new'), 'running');
  await t.wake(); await tick();
  assert.deepEqual(store.data.sessions.map((s) => s.id), ['new']);
}
{
  const store = memStore({ on: false, sessions: [{ id: 'a', at: 1 }] });
  let woke = 0; const t = track(store, { wakeOne: async () => { woke++; } });
  assert.deepEqual(await t.wake(), []); assert.equal(woke, 0, 'off: a saved list never wakes');
}

// wakeSession: what happens to one chat.
const session = (events, status = 'idle') => {
  const a = { id: 'w', status, steered: [], steer(m) { this.steered.push(m); } };
  return { a, deps: {
    sessionController: { resolveAgent: async (id) => (id === 'missing' ? { error: {} } : { agent: a }) },
    sessionQuery: { observeSession: async () => ({ events, [Symbol.dispose]() {} }) } } };
};
const ended = (reason, { start = 4000, goalRound = false } = {}) => [{ type: 'turn/start', seq: 1, time: start },
  ...(goalRound ? [{ type: 'user/message', seq: 2, time: start, data: { source: { kind: 'goal' } } }] : []),
  { type: 'turn/end', seq: 3, time: start + 1000, data: { reason } }];
{
  let s = session(ended(quit));
  assert.equal(await wakeSession(s.deps, 'w'), 'continued');
  assert.deepEqual(s.a.steered[0].content, [], 'the same empty marker as One-click Continue');
  assert.equal(s.a.steered[0].source.kind, 'composer-plus-continue');
  s = session(ended({ kind: 'interrupted' })); assert.equal(await wakeSession(s.deps, 'w'), 'continued', 'crash');
  for (const reason of [{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'completed' }, { kind: 'error' }]) {
    s = session(ended(reason)); assert.equal(await wakeSession(s.deps, 'w'), 'skipped', JSON.stringify(reason)); assert.equal(s.a.steered.length, 0);
  }
  s = session([{ type: 'turn/start', seq: 1 }]); assert.equal(await wakeSession(s.deps, 'w'), 'skipped', 'open turn');
  s = session(ended(quit), 'running'); assert.equal(await wakeSession(s.deps, 'w'), 'busy');
  s = session(ended(quit)); assert.equal(await wakeSession(s.deps, 'missing'), 'unavailable');
  s = session(ended(quit)); assert.equal(await wakeSession({ ...s.deps, archived: () => true }, 'w'), 'archived'); assert.equal(s.a.steered.length, 0);
  // Goals: dsh disarms every goal at start. A goal that the restart stopped is armed again; a goal round is then continued by
  // dsh's goal driver (no extra step), any other turn gets the continue step.
  const goals = (goal, fail = false) => ({ calls: [], get: () => goal, resume(agentArg, ref) { this.calls.push(ref); if (fail) throw new Error('round cap'); } });
  s = session(ended({ kind: 'aborted', reason: { kind: 'parent' } }, { goalRound: true }));
  let g = goals({ id: 'g1', revision: 3, phase: 'active', activation: 'disarmed', updatedAt: 1 });
  assert.equal(await wakeSession({ ...s.deps, goals: g }, 'w'), 'goal', 'goal round: armed again, the goal driver goes on');
  assert.deepEqual(g.calls, [{ id: 'g1', revision: 3 }]); assert.equal(s.a.steered.length, 0);
  s = session(ended(quit)); g = goals({ id: 'g1', revision: 3, phase: 'active', activation: 'disarmed', updatedAt: 1 });
  assert.equal(await wakeSession({ ...s.deps, goals: g }, 'w'), 'continued', 'an ordinary turn in a chat with a goal: continue step only');
  assert.equal(s.a.steered.length, 1); assert.equal(g.calls.length, 0, 'the goal is not armed for an ordinary turn');
  s = session(ended(quit, { start: 4000, goalRound: true })); g = goals({ id: 'g1', revision: 4, phase: 'paused', updatedAt: 5000 });
  assert.equal(await wakeSession({ ...s.deps, goals: g }, 'w'), 'goal', 'paused by the shutdown (after the turn started)');
  s = session(ended(quit, { start: 4000, goalRound: true })); g = goals({ id: 'g1', revision: 4, phase: 'paused', updatedAt: 3000 });
  assert.equal(await wakeSession({ ...s.deps, goals: g }, 'w'), 'continued', 'paused by you before: the goal stays paused, the turn continues');
  assert.equal(g.calls.length, 0);
  s = session(ended(quit, { goalRound: true })); g = goals({ id: 'g1', revision: 3, phase: 'active', activation: 'disarmed', updatedAt: 1 }, true);
  assert.equal(await wakeSession({ ...s.deps, goals: g }, 'w'), 'continued', 'no goal rounds left: continue the turn');
  s = session(ended(quit, { goalRound: true })); g = goals({ id: 'g1', revision: 3, phase: 'complete', updatedAt: 1 });
  assert.equal(await wakeSession({ ...s.deps, goals: g }, 'w'), 'continued'); assert.equal(g.calls.length, 0);
  s = session(ended(quit, { goalRound: true })); g = goals({ id: 'g1', revision: 3, phase: 'active', activation: 'armed', updatedAt: 1 });
  assert.equal(await wakeSession({ ...s.deps, goals: g }, 'w'), 'continued', 'already armed: not resumed twice'); assert.equal(g.calls.length, 0);
  s = session(ended(quit, { goalRound: true }));
  assert.equal(await wakeSession({ ...s.deps, goals: { get() { throw new Error('not live'); } } }, 'w'), 'continued', 'a goal service error does not block');
}

// apply(): the route, the events, and a full quit → start cycle on one dsh home.
async function boot(home, { agents, goals } = {}) {
  process.env.DSH_HOME = home;
  const routes = new Map(); const hooks = new Map(); const effects = []; const readyFns = [];
  const services = { agents, goals, appReady: { onReady: (fn) => { readyFns.push(fn); return () => {}; } } };
  apply({
    on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
    get: (name) => services[name],
    effect: (fn) => { effects.push(fn()); },
    connection: { fetch: { register: (r) => routes.set(r.path, r) }, authenticatedUrl: (b) => b },
    sessionController: { resolveAgent: async (id) => (agents.byId.has(id) ? { agent: agents.byId.get(id) } : { error: {} }) },
    sessionQuery: { observeSession: async (id) => ({ events: agents.byId.get(id).events, [Symbol.dispose]() {} }) },
    subprocess: {},
  });
  const call = async (body) => {
    const r = await routes.get(RESUME_PATH).fetch(new Request(`http://h${RESUME_PATH}`, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, json: await r.json() };
  };
  const emit = (name, ...args) => { for (const fn of hooks.get(name) ?? []) fn(...args); };
  return { call, emit, ready: () => readyFns.forEach((f) => f()), unload: () => effects.forEach((f) => f?.()) };
}
const liveAgents = (ids) => {
  const byId = new Map(ids.map((id) => [id, { id, status: 'idle', events: [], steered: [], session: { header: {} }, steer(m) { this.steered.push(m); } }]));
  return { byId, roots: () => [...byId.values()] };
};
{
  const home = mkdtempSync(join(root, 'home-'));
  // Run 1: switch on, two chats run, one finishes, dsh quits (the other one's turn ends as aborted/disposed).
  let agents = liveAgents(['one', 'two']);
  let app = await boot(home, { agents });
  assert.deepEqual((await app.call()).json, { on: false }, 'off by default');
  assert.equal((await app.call('{x')).status, 400); assert.equal((await app.call({ on: 1 })).status, 400);
  assert.deepEqual((await app.call({ on: true })).json, { on: true });
  const [one, two] = ['one', 'two'].map((id) => agents.byId.get(id));
  for (const a of [one, two]) { a.status = 'running'; app.emit('agent/status', { agent: a, status: 'running' }); }
  app.emit('session/event', { id: 'one' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  one.status = 'idle'; app.emit('agent/status', { agent: one, status: 'idle' });
  app.emit('session/event', { id: 'two' }, { type: 'turn/end', data: { reason: quit } });
  two.status = 'idle'; app.emit('agent/status', { agent: two, status: 'idle' });
  await tick(); app.unload(); await tick();
  assert.deepEqual(await savedIds(home, ['two']), ['two'], 'only the chat the quit stopped is saved');
  // Run 2: dsh starts; after appReady the stopped chat continues without a click; the finished one does not.
  agents = liveAgents(['one', 'two']);
  agents.byId.get('two').events = ended(quit);
  agents.byId.get('one').events = ended({ kind: 'completed' });
  app = await boot(home, { agents });
  await tick();
  assert.equal(agents.byId.get('two').steered.length, 0, 'nothing happens before dsh is ready');
  app.ready(); await tick(); await tick();
  assert.equal(agents.byId.get('two').steered.length, 1, 'continued after the restart');
  assert.equal(agents.byId.get('one').steered.length, 0);
  assert.deepEqual(await savedIds(home, []), [], 'list forgotten');
  // The hidden continue note replaces the marker in the next step (shared with One-click Continue).
  app.unload();
  // Run 3: the user switched it off: nothing is tracked, and a saved list never wakes.
  mkdirSync(join(home, 'storages/dsh-composer-plus'), { recursive: true });
  writeFileSync(join(home, 'storages/dsh-composer-plus/resume.json'), JSON.stringify({ on: false, sessions: [{ id: 'two', at: 1 }] }));
  agents = liveAgents(['two']); agents.byId.get('two').events = ended(quit);
  app = await boot(home, { agents }); app.ready(); await tick(); await tick();
  assert.equal(agents.byId.get('two').steered.length, 0, 'off: no continue');
  app.unload();
}
{
  // A profile without agents/goals/appReady services still loads; the route answers.
  const home = mkdtempSync(join(root, 'home-'));
  process.env.DSH_HOME = home;
  const routes = new Map();
  apply({ on() {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } }, sessionController: {}, sessionQuery: {}, subprocess: {} });
  const r = await routes.get(RESUME_PATH).fetch(new Request(`http://h${RESUME_PATH}`));
  assert.deepEqual(await r.json(), { on: false });
}
// Client: the Settings row reads and moves the Host switch; an older Host half (no route yet) asks for a restart.
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  let hostState = { on: false };
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (url !== RESUME_PATH) return new Response('{}', { status: url === '/api/composer-plus.mobile' ? 200 : 404 });
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); if (hostState !== 404) hostState = { on: JSON.parse(init.body).on }; }
    return hostState === 404 ? new Response('', { status: 404 }) : new Response(JSON.stringify(hostState), { status: 200 });
  };
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }),
    useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
  const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
  const live = new Map(); let next = 0;
  plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
  await tick();
  const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
  const section = opts.inject();
  const t = (k, p) => (p?.error ? `${k}:${p.error}` : k);
  const row = () => Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, mobile: section.mobile, resume: section.resume, t })
    .c.slice(5).find((r) => r.p.key === 'resumeAfterRestart');
  assert.equal(row().c[2].p.checked, false, 'off by default');
  assert.equal(row().c[0].p.id, 'resumeAfterRestart', 'the row has its screenshot');
  await section.setFeature('resumeAfterRestart', true);
  assert.deepEqual(posts, [{ on: true }], 'the switch goes to the Host');
  assert.equal(mem.get('dsh-composer-plus.features') ?? null, null, 'not in browser storage');
  assert.equal(row().c[2].p.checked, true);
  const status = row().c[1].c[3];
  assert.equal(status.t.name, 'MobileStatus'); assert.equal(status.p.prefix, 'resume');
  hostState = 404;
  await section.setFeature('resumeAfterRestart', false);
  assert.equal(section.resume.getSnapshot().restart, true);
  assert.equal(section.resume.getSnapshot().on, true, 'the switch goes back');
  assert.equal(status.t({ mobile: section.resume, t, prefix: 'resume' }).c[0], 'resume.restart');
}
rmSync(root, { recursive: true, force: true });
console.log('resume-after-restart checks passed');
