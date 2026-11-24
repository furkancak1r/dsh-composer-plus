// Subagent models in an old assistant chat: recordSubagentPolicy writes dsh's `subagent/model-selection-policy` event
// with the routes of dsh's setting into the assistant chat once (root chat, no policy yet, setting on with valid routes).
// It writes nothing for another chat, a subagent chat, a chat that has a policy, a setting that is off, empty, missing or
// not valid, and it never throws on a dsh without the settings service or the session API. installAssistant calls it at
// its start for a live assistant agent and at each agent/created of the assistant chat (a prepended listener, before
// dsh-tool-subagent's own one), skips a chat that has the event, logs each line once and writes nothing while it is off.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_POLICY, installAssistant, recordSubagentPolicy } from '../index.js';

const ROUTES = [{ provider: 'demo', model: 'demo-large' }, { provider: 'demo', model: 'demo-small' }];
const session = (id, header = {}, events = []) => {
  const log = [...events];
  return { id, header, appended: [], snapshotEvents: () => log, append(type, data) { const e = { seq: log.length, type, data }; log.push(e); this.appended.push(e); return e; } };
};
const settings = (value) => ({ describe: () => [{ ns: 'other', value: { enabled: true } }, ...(value === undefined ? [] : [{ ns: 'subagent-model-selection-settings', value }])] });
const on = (allowedModels = ROUTES) => settings({ enabled: true, allowedModels });
const logs = []; const log = (text) => logs.push(text);

// Records once: only provider and model are copied; a second call finds the event and writes nothing.
let s = session('s-a', {}, [{ seq: 0, type: 'user/message', data: {} }]);
assert.equal(recordSubagentPolicy(s, settings({ enabled: true, allowedModels: [{ ...ROUTES[0], extra: 1 }, ROUTES[1]] }), 's-a', log), true);
assert.deepEqual(s.appended.map((e) => [e.type, e.data]), [[MODEL_POLICY, { allowedModels: ROUTES }]], 'one event, two keys per route');
assert.equal(recordSubagentPolicy(s, on(), 's-a', log), true, 'safe to call again: the chat has the event');
assert.equal(s.appended.length, 1);
// A chat that has a policy (dsh's own or an earlier one) keeps it.
s = session('s-a', {}, [{ seq: 0, type: MODEL_POLICY, data: { allowedModels: [ROUTES[0]] } }]);
assert.equal(recordSubagentPolicy(s, on(), 's-a', log), true); assert.equal(s.appended.length, 0, 'the first policy stays');
// Not the assistant chat, or no assistant chat yet; a subagent chat (also by its delegation depth).
for (const [chat, id, what] of [[session('s-b'), 's-a', 'another chat'], [session('s-a'), undefined, 'no assistant id'],
  [session('s-a', { origin: 'subagent', parentSession: 's-x' }), 's-a', 'subagent chat'], [session('s-a', { delegationDepth: 1 }), 's-a', 'depth 1']]) {
  assert.equal(recordSubagentPolicy(chat, on(), id, log), false, what); assert.equal(chat.appended.length, 0, what);
}
assert.deepEqual(logs, [], 'these cases are normal: no log line');
// The setting: off, no entry, empty, repeated, empty strings, not a list, not text.
for (const [value, what, logged] of [[{ enabled: false, allowedModels: ROUTES }, 'off', false], [undefined, 'no entry (a renamed setting)', true],
  [{ enabled: 'true', allowedModels: ROUTES }, 'enabled is not a boolean', true], [{ enabled: true, allowedModels: [] }, 'empty', true],
  [{ enabled: true, allowedModels: [ROUTES[0], { ...ROUTES[0] }] }, 'repeated', true], [{ enabled: true, allowedModels: [{ provider: '', model: 'm' }] }, 'empty provider', true],
  [{ enabled: true, allowedModels: [{ provider: 'p' }] }, 'no model', true], [{ enabled: true, allowedModels: 'demo' }, 'not a list', true],
  [{ enabled: true, allowedModels: [{ provider: 'p', model: 7 }] }, 'model is not text', true], [{ enabled: true, allowedModels: [null] }, 'null route', true]]) {
  logs.length = 0; s = session('s-a');
  assert.equal(recordSubagentPolicy(s, settings(value), 's-a', log), false, what);
  assert.equal(s.appended.length, 0, what); assert.equal(logs.length, logged ? 1 : 0, `${what}: log line`);
}
// Fail closed on another dsh: no settings service, a describe that throws, no session API, an append that throws.
for (const [chat, service, what] of [[session('s-a'), undefined, 'no settings service'], [session('s-a'), {}, 'no describe'],
  [session('s-a'), { describe: () => { throw new Error('not ready'); } }, 'describe throws'],
  [{ id: 's-a', header: {} }, on(), 'no session API'], [{ ...session('s-a'), append: () => { throw new Error('invalid event'); } }, on(), 'append throws']]) {
  logs.length = 0;
  assert.equal(recordSubagentPolicy(chat, service, 's-a', log), false, what);
  assert.equal(logs.length, 1, `${what}: one log line`);
}
assert.equal(recordSubagentPolicy(session('s-a'), undefined, 's-a'), false, 'the default log does not throw');

// installAssistant: a live old assistant chat gets the event at the start; agent/created of the assistant chat (a resume)
// writes nothing more; another chat and a subagent of the assistant get nothing.
const home = await mkdtemp(join(tmpdir(), 'cp-assistant-models-'));
try {
  const dir = join(home, 'storages/dsh-composer-plus');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'assistant.json'), JSON.stringify({ sessionId: 's-a' }));
  const agent = (id, header) => ({ id, session: session(id, header, [{ seq: 0, type: 'user/message', data: {} }]) });
  const agents = new Map([['s-a', agent('s-a')]]);
  // Cordis order: a listener with `prepend` (true) goes first; dsh 0.2.0 and 0.2.1 read the policy in their own listener.
  const listeners = new Map(); const warns = []; let service = on(); let switchRoute;
  const ctx = {
    logger: { warn: (text) => warns.push(text) }, effect: () => {}, inject: () => ({ dispose: () => {} }),
    get: (name) => ({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] }, settings: service })[name],
    on: (name, fn, prepend) => { const list = listeners.get(name) ?? []; listeners.set(name, prepend === true ? [fn, ...list] : [...list, fn]); },
    connection: { fetch: { register: (route) => { if (route.path.endsWith('assistant-switch')) switchRoute = route; return () => {}; } } },
  };
  // dsh-tool-subagent of dsh 0.2.0/0.2.1: registered before Composer Plus, reads the policy when its listener runs.
  const seenByTool = [];
  ctx.on('agent/created', ({ agent: a }) => { seenByTool.push(a.session.snapshotEvents().some((e) => e.type === MODEL_POLICY)); });
  const emit = (a) => { agents.set(a.id, a); for (const fn of listeners.get('agent/created') ?? []) fn({ agent: a }); };
  const host = installAssistant(ctx, home, { folder: join(home, 'Assistant'), zone: 'UTC' });
  await host.ready;
  assert.deepEqual(agents.get('s-a').session.appended.map((e) => e.data), [{ allowedModels: ROUTES }], 'the live assistant chat at the start');
  // A chat that has the event is not read again: a click on Damon (sync) and agent/created skip it.
  let reads = 0; const live = agents.get('s-a').session; const read = live.snapshotEvents; live.snapshotEvents = () => { reads += 1; return read(); };
  emit(agents.get('s-a'));
  assert.equal(agents.get('s-a').session.appended.length, 1, 'once');
  assert.equal(reads, 1, 'only the tool stand-in read the log');
  // A new assistant agent (a resume after a restart): the policy is there before dsh's own listener reads it.
  const resumed = agent('s-a'); emit(resumed);
  assert.equal(seenByTool.at(-1), true, 'the prepended listener writes before the tool reads');
  // A setting of another shape: one log line per dsh run, not one per call.
  service = settings({ enabled: 'yes', allowedModels: ROUTES });
  for (let i = 0; i < 3; i++) emit(agent('s-a'));
  assert.equal(warns.filter((w) => /another shape/.test(w)).length, 1, 'one log line');
  service = on();
  // Assistant switched off: nothing is written.
  const post = (value) => switchRoute.fetch(new Request('http://x/', { method: 'POST', body: JSON.stringify({ on: value }) }));
  assert.equal((await post(false)).status, 200);
  const off = agent('s-a'); emit(off);
  assert.equal(off.session.appended.length, 0, 'switched off: nothing');
  assert.equal((await post(true)).status, 200);
  const other = agent('s-b'); const sub = agent('s-sub', { origin: 'subagent', parentSession: 's-a' });
  emit(other); emit(sub);
  assert.equal(other.session.appended.length + sub.session.appended.length, 0, 'other chats and subagents: nothing');
  // An assistant agent made again after a dsh restart (a new object, no policy in its log) gets it through agent/created.
  service = on([ROUTES[1]]);
  const again = agent('s-a'); emit(again);
  assert.deepEqual(again.session.appended.map((e) => e.data), [{ allowedModels: [ROUTES[1]] }], 'agent/created of the assistant chat');
} finally { await rm(home, { recursive: true, force: true }); }
console.log('assistant-subagent-models: ok');
