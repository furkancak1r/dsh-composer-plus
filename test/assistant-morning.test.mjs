// Morning summary (a setting of Assistant status panel, Host half) with fake dsh schedule services of both API shapes
// (0.2.0/0.2.1: create(sessionId, {weekly}) and delete({sessionId, id}); 0.2.2: create({timing, target}, actor) and
// edit({id, action})): off and 07:50 by default; on makes exactly one weekly Monday-Friday task at the time and the
// Host's time zone for the assistant chat; a time change changes only that task; off deletes only that task (a task that
// was there before stays); a task that the user deleted is made again by on; a failed create, delete or file write keeps
// the saved state and leaves no new task; no schedule service or Assistant off: an error, still off; bad bodies: 400.
import './temp-home.mjs';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_MORNING_PATH, MORNING_PROMPT, MORNING_TITLE, installAssistantMorning, morningSchedule } from '../index.js';

const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `keys ${keys}`);
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
/** A fake service that stores `{id, sessionId, title, prompt, weekly}` rows and checks the request shape of its version. */
function fakeService(shape) {
  const tasks = new Map(); let n = 0; const fail = { create: false, remove: undefined }; // remove: the id whose delete fails
  const add = (sessionId, title, prompt, weekly) => {
    if (fail.create) throw new Error('create failed');
    exact(weekly, ['time', 'time_zone', 'weekdays']); assert.match(weekly.time, CLOCK);
    const id = `schedule-${++n}`; tasks.set(id, { id, sessionId, title, prompt, weekly }); return { id, kind: 'weekly' };
  };
  const service = shape === '0.2.2' ? {
    async create(request, actor) {
      exact(request, ['title', 'prompt', 'timing', 'target']); exact(request.timing, ['kind', 'weekly']); assert.equal(request.timing.kind, 'weekly');
      assert.deepEqual(request.target, { kind: 'session', sessionId: actor }, 'target: the assistant chat, which is also the actor');
      return add(request.target.sessionId, request.title, request.prompt, request.timing.weekly);
    },
    async edit(request) {
      if (fail.remove === request.id) throw new Error('delete failed');
      exact(request, ['id', 'action']); assert.equal(request.action, 'delete');
      return tasks.delete(request.id) ? { id: request.id, deleted: true } : { id: request.id, code: 'schedule_not_found' };
    },
    async list() { throw new Error('the Host never lists the tasks'); },
  } : {
    async create(sessionId, request) { assert.equal(typeof sessionId, 'string'); exact(request, ['title', 'prompt', 'weekly']); return add(sessionId, request.title, request.prompt, request.weekly); },
    async delete(request) {
      if (fail.remove === request.id) throw new Error('delete failed');
      exact(request, ['sessionId', 'id']);
      const own = tasks.get(request.id)?.sessionId === request.sessionId;
      return own && tasks.delete(request.id) ? { id: request.id, deleted: true } : { id: request.id, deleted: false, code: 'schedule_not_found' };
    },
    async update() { throw new Error('not used'); }, async list() { throw new Error('the Host never lists the tasks'); }, async catalog() { throw new Error('the Host never lists the tasks'); },
  };
  return { service, tasks, fail };
}

assert.equal(morningSchedule(undefined, 'UTC'), undefined, 'no schedule service');
assert.equal(morningSchedule({ create() {} }, 'UTC'), undefined, 'a service without delete or edit');
assert.match(MORNING_PROMPT, /status_summary_set/); assert.match(MORNING_PROMPT, /chats_list/); assert.match(MORNING_PROMPT, /list_agents/); assert.match(MORNING_PROMPT, /schedule_list/);
assert.match(MORNING_PROMPT, /only one sentence/); assert.match(MORNING_PROMPT, /at most 8 projects/);
assert.doesNotMatch(MORNING_PROMPT, /[çğıöşüÇĞİÖŞÜ]/, 'English only');

for (const shape of ['0.2.0', '0.2.2']) {
  const home = await mkdtemp(join(tmpdir(), 'cp-morning-'));
  const dir = join(home, 'storages', 'dsh-composer-plus');
  const file = join(dir, 'assistant-morning.json');
  const fake = fakeService(shape);
  let schedule = fake.service; let assistantOn = true; let ensured = 0; let todosOn = true;
  const routes = new Map();
  const ctx = { get: (name) => (name === 'schedule' ? schedule : undefined), connection: { fetch: { register: (r) => { routes.set(r.path, r); return () => {}; } } } };
  const followers = [];
  const assistant = { isOn: () => assistantOn, ensure: async () => { ensured++; return 's-assistant'; }, id: () => 's-assistant', onSwitch: (fn) => followers.push(fn) };
  installAssistantMorning(ctx, home, assistant, { zone: 'Europe/Istanbul', todos: { isOn: () => todosOn, onSwitch: (fn) => followers.push(fn) } });
  const call = async (body) => {
    const r = await routes.get(ASSISTANT_MORNING_PATH).fetch(new Request(`http://x${ASSISTANT_MORNING_PATH}`, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  const saved = async () => JSON.parse(await readFile(file, 'utf8'));
  const mine = () => [...fake.tasks.values()].filter((t) => t.title === MORNING_TITLE);
  // A task that the user made before: it never changes.
  fake.tasks.set('schedule-user', { id: 'schedule-user', sessionId: 's-other', title: 'Weekly report', prompt: 'x', weekly: { time: '07:50:00', time_zone: 'UTC', weekdays: [1] } });
  const other = structuredClone(fake.tasks.get('schedule-user'));

  // Default: off, 07:50; a GET writes nothing.
  assert.deepEqual(await call(), { status: 200, body: { on: false, time: '07:50' } });
  await assert.rejects(stat(file), { code: 'ENOENT' });

  // On: exactly one task, Monday-Friday at 07:50 in the Host's zone, for the assistant chat (made first with ensure()).
  assert.deepEqual(await call({ on: true }), { status: 200, body: { on: true, time: '07:50' } });
  assert.equal(ensured, 1);
  assert.equal(mine().length, 1, `${shape}: one task`);
  const [task] = mine();
  assert.deepEqual(task.weekly, { time: '07:50:00', time_zone: 'Europe/Istanbul', weekdays: [1, 2, 3, 4, 5] });
  assert.equal(task.sessionId, 's-assistant'); assert.equal(task.prompt, MORNING_PROMPT);
  assert.deepEqual(await saved(), { on: true, time: '07:50', taskId: task.id, sessionId: 's-assistant' });
  assert.equal(((await stat(file)).mode & 0o777).toString(8), '600', 'owner-only');

  // A time change: only that task changes (made again at the new time; the old one goes).
  assert.deepEqual((await call({ time: '06:30' })).body, { on: true, time: '06:30' });
  assert.equal(mine().length, 1); assert.equal(mine()[0].weekly.time, '06:30:00'); assert.notEqual(mine()[0].id, task.id);
  assert.equal((await saved()).taskId, mine()[0].id);
  assert.deepEqual(fake.tasks.get('schedule-user'), other, 'the other task stays as it was');

  // A failed create: the saved state and the task stay.
  fake.fail.create = true;
  const kept = mine()[0].id;
  const failed = await call({ time: '08:00' });
  assert.equal(failed.status, 500); assert.match(failed.body.error, /create failed/); assert.equal(failed.body.time, '06:30');
  assert.deepEqual(mine().map((t) => t.id), [kept]); assert.equal((await saved()).time, '06:30');
  fake.fail.create = false;

  // A failed file write: the new task is deleted again; the old task and the saved state stay.
  await chmod(dir, 0o500);
  assert.equal((await call({ time: '09:15' })).status, 500);
  await chmod(dir, 0o700);
  assert.deepEqual(mine().map((t) => t.id), [kept], 'all or none: no second task');
  assert.deepEqual((await call()).body, { on: true, time: '06:30' });

  // A failed delete of the old task (the last change): the file and the tasks are as before.
  fake.fail.remove = kept;
  assert.equal((await call({ on: false })).status, 500);
  assert.deepEqual(mine().map((t) => t.id), [kept]); assert.deepEqual(await saved(), { on: true, time: '06:30', taskId: kept, sessionId: 's-assistant' });
  assert.equal((await call({ time: '10:00' })).status, 500, 'a time change whose old task cannot go');
  assert.deepEqual(mine().map((t) => t.id), [kept], 'its new task is deleted again'); assert.equal((await saved()).time, '06:30');
  fake.fail.remove = undefined;

  // Off: only this task goes; the other task stays.
  assert.deepEqual((await call({ on: false })).body, { on: false, time: '06:30' });
  assert.equal(mine().length, 0); assert.deepEqual(fake.tasks.get('schedule-user'), other);
  assert.deepEqual(await saved(), { on: false, time: '06:30' });
  // While off, a time change only saves the time.
  assert.deepEqual((await call({ time: '07:05' })).body, { on: false, time: '07:05' }); assert.equal(mine().length, 0);

  // The user deleted the task on the Automation tasks page: on again makes a new one (the old delete finds nothing).
  await call({ on: true });
  fake.tasks.delete(mine()[0].id);
  assert.deepEqual((await call({ on: true })).body, { on: true, time: '07:05' });
  assert.equal(mine().length, 1, 'a new task');

  // Two changes at the same time run one after the other: one task at the last time.
  const both = await Promise.all([call({ time: '05:45' }), call({ time: '05:50' })]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.deepEqual(mine().map((t) => t.weekly.time), ['05:50:00']);
  await call({ on: false });

  // No schedule service, or Assistant off: an error, and the setting stays off.
  schedule = undefined;
  let r = await call({ on: true });
  assert.equal(r.status, 409); assert.match(r.body.error, /no schedule service/); assert.equal(r.body.on, false);
  schedule = fake.service; assistantOn = false;
  r = await call({ on: true });
  assert.equal(r.status, 409); assert.equal(r.body.on, false); assert.equal(mine().length, 0);
  assistantOn = true;
  // Assistant or the status panel goes off while the summary is on: its task goes and the setting is off.
  for (const which of [0, 1]) {
    r = await call({ on: true }); assert.equal(r.body.on, true); assert.equal(mine().length, 1);
    followers[which](false);
    for (let i = 0; i < 50 && mine().length > 0; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(mine().length, 0, `the task goes when ${which === 0 ? 'Assistant' : 'the status panel'} goes off`);
    assert.equal((await call()).body.on, false);
  }
  // The status panel off: no new task (its summary would have nowhere to go).
  todosOn = false;
  r = await call({ on: true });
  assert.equal(r.status, 409); assert.match(r.body.error, /status panel is off/); assert.equal(r.body.on, false); assert.equal(mine().length, 0);
  todosOn = true;

  // Bad bodies.
  for (const bad of ['not json', [], null, {}, { on: 'yes' }, { on: true, time: '08:00' }, { time: '7:50' }, { time: '24:00' }, { time: '12:60' }, { time: '08:00:00' }, { time: 750 }, { scope: 'all' }]) {
    assert.equal((await call(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(mine().length, 0); assert.deepEqual(fake.tasks.get('schedule-user'), other);
  await rm(home, { recursive: true, force: true });
  console.log(`  ${shape}: ok`);
}
console.log('assistant morning: ok');

// Client half (real client.js, fake dsh slots and fetch): the setting shows under the Assistant status panel row only
// while that feature is on; the switch and the time field post one change at a time; a bad time is not sent; a refused
// change keeps the saved state and shows the reason.
{
  const { readFileSync } = await import('node:fs');
  const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  globalThis.document = { visibilityState: 'visible', body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  let morning = { on: false, time: '07:50' }; const posts = []; let gate; let refuse; let todosOn = true;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === ASSISTANT_MORNING_PATH) {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body); posts.push(body); if (gate) await gate;
        if (refuse) { const error = refuse; refuse = undefined; return Response.json({ error, ...morning }, { status: 409 }); }
        morning = { ...morning, ...body };
      }
      return Response.json(morning);
    }
    if (u.startsWith('/api/composer-plus.assistant-todos')) { if (init?.method === 'POST') todosOn = JSON.parse(init.body).on; return Response.json({ on: todosOn }); }
    return new Response('{}', { status: 404 });
  };
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  let hooks = []; let hi = 0;
  const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useEffect: (f) => { f(); }, useLayoutEffect: (f) => { f(); }, useRef: (v) => ({ current: v }),
    useState: (v) => { const i = hi++; if (!(i in hooks)) hooks[i] = typeof v === 'function' ? v() : v; return [hooks[i], (x) => { hooks[i] = typeof x === 'function' ? x(hooks[i]) : x; }]; },
    useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f };
  const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
  const live = new Map(); let next = 0;
  plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: () => undefined, locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x },
    slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
  await tick();
  const [section, Settings] = [...live.values()].find(([o]) => o.name === 'settings.section');
  const toggles = section.inject().hooks.composerPlusToggles;
  const find = (n, f) => (n == null || typeof n !== 'object' ? undefined : f(n) ? n : (n.c ?? []).flat(Infinity).map((c) => find(c, f)).find(Boolean));
  const t = (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`);
  const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : n?.c ? text(n.c) : '');
  const element = () => find(Settings({ ...section.inject(), useComposerPlusToggles: (f) => f(toggles.getSnapshot()), t }), (n) => typeof n.t === 'function' && n.t.name === 'AssistantMorning');
  const draw = () => { hi = 0; const el = element(); return el.t(el.p); };
  assert.ok(element(), 'the setting under the Assistant status panel row');
  let out = draw();
  const sw = () => find(out, (n) => n.t === 'Switch'); const input = () => find(out, (n) => n.t === 'input');
  assert.equal(sw().p.checked, false, 'off by default'); assert.equal(sw().p.label, 'morning.title');
  assert.equal(input().p.type, 'time'); assert.equal(input().p.value, '07:50'); assert.equal(input().p['aria-label'], 'morning.time');
  assert.match(text(out), /morning\.help/);
  // On: one post; a second change while it runs is not sent.
  let open; gate = new Promise((r) => { open = r; });
  sw().p.onChange(true); out = draw();
  assert.equal(sw().p.checked, true, 'the switch moves at once'); assert.equal(sw().p.disabled, true); assert.equal(input().p.disabled, true);
  sw().p.onChange(false); input().p.onChange({ target: { value: '08:10' } }); out = draw(); input().p.onBlur(); await tick();
  assert.deepEqual(posts, [{ on: true }], 'one change at a time');
  open(); gate = undefined; await tick(); out = draw();
  assert.equal(sw().p.checked, true); assert.equal(sw().p.disabled, false);
  // The time: Enter or leaving the field sends a valid new time once; an empty or the same time sends nothing.
  input().p.onChange({ target: { value: '' } }); out = draw(); input().p.onBlur(); await tick();
  input().p.onChange({ target: { value: '07:50' } }); out = draw(); input().p.onKeyDown({ key: 'Enter', preventDefault() {} }); await tick();
  assert.equal(posts.length, 1, 'no post for an empty or the same time');
  input().p.onChange({ target: { value: '06:45' } }); out = draw(); input().p.onKeyDown({ key: 'Enter', preventDefault() {} }); await tick();
  assert.deepEqual(posts.at(-1), { time: '06:45' }); out = draw(); assert.equal(input().p.value, '06:45');
  // A refused change: the saved state stays and the reason shows.
  refuse = 'This dsh has no schedule service: turn on Automation tasks in Plugins.';
  sw().p.onChange(false); await tick(); out = draw();
  assert.equal(sw().p.checked, true, 'still on');
  const status = find(out, (n) => typeof n.t === 'function' && n.t.name === 'MobileStatus');
  assert.match(text(status.t(status.p)), /morning\.down:.*no schedule service/, 'the reason shows');
  // The Assistant status panel off: the setting stays reachable, so a task that is on can still be switched off.
  await section.inject().setFeature('assistantTodos', false); await tick();
  assert.notEqual(element(), undefined, 'the switch stays while the Assistant status panel is off');
  console.log('  client: ok');
}
