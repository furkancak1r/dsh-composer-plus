// Resume after an AIProxy outage (Host half), with fakes only (no real AIProxy, no real dsh):
// - outageError: AIProxy's 499 request_cancelled and "Connection error." trigger; a user stop, a denied approval and other
//   errors (429, 503, 409, a 499 with another code) do not.
// - outageWatch: failures within the window are one outage; it waits for a failed health check (or a Connection error)
//   and then for the settle time of good checks; a 499 while AIProxy stays up continues nothing;
//   one message per chat per outage, at most perHour per hour; a chat that moved on gets nothing.
// - installOutageResume: on by default, the switch route (on, lang), the message in the UI language through dsh's prompt
//   (mode queue, as chat_send), only root chats on AIProxy, the outage line after dsh's notice of a failed subagent, and
//   the status panel's list of continued chats. Switched off, nothing continues.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUTAGE, OUTAGE_CHILD_NOTE, OUTAGE_NOTES, OUTAGE_PATH, installOutageResume, outageError, outageNote, outageWatch } from '../index.js';

const C499 = 'aiproxy API error (499): {"code":"request_cancelled","message":"İstek iptal edildi."}';
const err = (message) => ({ kind: 'error', error: { message, code: 'PI_AI_ERROR' } });

// --- the trigger filter ---
assert.equal(outageError(err(C499)), 'cancelled');
assert.equal(outageError(err('499: {"code":"request_cancelled","message":"İstek iptal edildi."}')), 'cancelled', 'the openai-completions form');
// A cancel while the answer streams: AIProxy writes the error into the stream (live logs of 2026-11-11 have the first form).
assert.equal(outageError(err('request_cancelled: İstek iptal edildi.')), 'cancelled', 'in the stream, openai-responses');
assert.equal(outageError(err('İstek iptal edildi.')), 'cancelled', 'in the stream, openai-completions');
assert.equal(outageError({ kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } }), 'connection');
for (const [reason, why] of [
  [{ kind: 'aborted', reason: { kind: 'user' } }, 'a user stop'],
  [{ kind: 'aborted', reason: { kind: 'disposed' } }, 'dsh quit'],
  [{ kind: 'blocked' }, 'a denied approval or a hook refusal'],
  [{ kind: 'completed' }, 'a finished turn'],
  [err('aiproxy API error (429): {"code":"upstream_rejected","message":"x"}'), '429'],
  [err('aiproxy API error (503): {"code":"upstream_rejected","message":"x"}'), '503'],
  [err('aiproxy API error (409): {"code":"session_mismatch","message":"x"}'), '409'],
  [err('aiproxy API error (499): {"code":"client_gone","message":"x"}'), 'a 499 with another code'],
  [err('aiproxy API error (500): {"code":"internal_error","message":"request_cancelled 499"}'), 'the words in another error'],
  [err('4990: {"code":"request_cancelled"}'), 'another status'],
  [err('upstream_rejected: request_cancelled: x'), 'another code first'],
  [err('İstek iptal edildi. Tekrar deneyin.'), 'another message'],
  [err('Connection error. Try again later'), 'another text'],
  [err('Insufficient Balance'), 'quota'],
  [{ kind: 'error' }, 'no error object'],
  [undefined, 'no reason'],
]) assert.equal(outageError(reason), undefined, why);
assert.equal(outageNote('tr'), 'AIProxy kesintisi nedeniyle tur yarıda kaldı. Kaldığın yerden devam et; tamamlanan adımları tekrarlama.');
assert.equal(outageNote('tr-TR'), OUTAGE_NOTES.tr, 'a region falls back to its base language');
assert.equal(outageNote('xx'), OUTAGE_NOTES.en);
assert.equal(outageNote(undefined), OUTAGE_NOTES.en);
for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty-x']) assert.equal(outageNote(id), OUTAGE_NOTES.en, id);
for (const [id, text] of Object.entries(OUTAGE_NOTES)) assert.ok(text.length > 20 && !text.includes('\u2014'), id);

// --- outageWatch with a fake clock ---
const T = { ...OUTAGE, window: 60, poll: 1, settle: 10, giveUp: 1000, hour: 3600 };
function rig({ healthy = () => true, resume } = {}) {
  let clock = 0; const checks = []; const resumed = [];
  const w = outageWatch({ now: () => clock, timing: T, sleep: async (ms) => { clock += ms; await null; },
    health: () => { const ok = healthy(clock); checks.push([clock, ok]); return ok; },
    resume: resume ?? (async (id, seq) => { resumed.push([id, seq, clock]); return 'continued'; }) });
  return { w, checks, resumed, tick: (ms) => { clock += ms; }, at: () => clock };
}
{
  // A restart: AIProxy is down from 0 to 25; three chats fail; one outage, each chat once, after 10 good units.
  const r = rig({ healthy: (t) => t >= 25 });
  r.w.fail('a', 10, 'cancelled'); r.w.fail('b', 20, 'connection'); r.w.fail('a', 11, 'cancelled');
  await r.w.settled();
  assert.deepEqual(r.resumed.map(([id, seq]) => [id, seq]), [['a', 11], ['b', 20]], 'one message per chat, its newest failed turn');
  assert.ok(r.resumed.every(([, , at]) => at >= 25 + T.settle), 'only after AIProxy answered for the settle time');
  assert.ok(r.checks.some(([, ok]) => !ok), 'the health check saw it down');
  assert.deepEqual(r.w.last().chats, ['a', 'b']);
}
{
  // A failure after the outage was handled is a new outage (and gets its own message).
  const r = rig({ healthy: (t) => !(t >= 0 && t < 5) && !(t >= 100 && t < 105) });
  r.w.fail('a', 1, 'connection'); await r.w.settled();
  r.tick(100 - r.at()); r.w.fail('a', 2, 'connection'); await r.w.settled();
  assert.deepEqual(r.resumed.map(([id, seq]) => [id, seq]), [['a', 1], ['a', 2]]);
  // A third outage in the same hour: the hourly limit stops it.
  r.tick(10); r.w.fail('a', 3, 'connection'); await r.w.settled();
  assert.equal(r.resumed.length, 2, 'at most two automatic messages per chat per hour');
  // After an hour, it continues again.
  r.tick(T.hour); r.w.fail('a', 4, 'connection'); await r.w.settled();
  assert.deepEqual(r.resumed.at(-1).slice(0, 2), ['a', 4], 'the limit is per hour');
}
{
  // One 499 while AIProxy stays up (a request cancelled in AIProxy's window): nothing continues.
  const r = rig({ healthy: () => true });
  r.w.fail('solo', 5, 'cancelled'); await r.w.settled();
  assert.deepEqual(r.resumed, [], 'one cancel is no outage');
  assert.equal(r.w.last(), undefined);
  // Two cancels at once while AIProxy stays up: still no outage.
  r.w.fail('x', 6, 'cancelled'); r.w.fail('y', 7, 'cancelled'); await r.w.settled();
  assert.deepEqual(r.resumed, [], 'cancels without a failed health check');
}
{
  // AIProxy never comes back: the watch gives up, nothing continues.
  const r = rig({ healthy: () => false });
  r.w.fail('a', 1, 'connection'); await r.w.settled();
  assert.deepEqual(r.resumed, []);
  assert.ok(r.at() >= T.giveUp);
}
{
  // Down and up again before the settle time: the settle time starts again.
  const r = rig({ healthy: (t) => !(t < 3 || (t >= 6 && t < 8)) });
  r.w.fail('a', 1, 'connection'); await r.w.settled();
  assert.ok(r.resumed[0][2] >= 8 + T.settle, 'waits for good checks after the last bad one');
}
{
  // A chat that moved on or runs is not counted against its limit; a throwing resume does not stop the others.
  const answers = { moved: 'moved', boom: undefined, ok: 'continued' };
  const r = rig({ healthy: (t) => t > 2, resume: async (id) => { if (id === 'boom') throw new Error('x'); return answers[id]; } });
  r.w.fail('moved', 1, 'connection'); r.w.fail('boom', 1, 'connection'); r.w.fail('ok', 1, 'connection'); await r.w.settled();
  assert.deepEqual(r.w.last().chats, ['ok']);
}
{
  // Switched off (active false) or closed during the wait: nothing continues.
  let active = true; let clock = 0; const resumed = [];
  const w = outageWatch({ now: () => clock, timing: T, active: () => active, sleep: async (ms) => { clock += ms; if (clock > 3) active = false; },
    health: () => clock > 50, resume: async (id) => { resumed.push(id); return 'continued'; } });
  w.fail('a', 1, 'connection'); await w.settled();
  assert.deepEqual(resumed, [], 'switched off during the wait');
  const w2 = outageWatch({ now: () => clock, timing: T, sleep: async (ms) => { clock += ms; }, health: () => false, resume: async (id) => { resumed.push(id); return 'continued'; } });
  w2.fail('a', 1, 'connection'); w2.close(); await w2.settled();
  assert.deepEqual(resumed, [], 'closed (plugin unload)');
}

// --- installOutageResume with a fake dsh ---
const home = await mkdtemp(join(tmpdir(), 'cp-outage-'));
try {
  const routes = new Map(); const hooks = new Map(); const effects = []; const prompts = [];
  const header = (provider) => ({ type: 'request/header', data: { header: { config: { provider, model: 'm' } } } });
  const agents = new Map(); const archived = [];
  const chat = (id, { provider = 'aiproxy', sub = false } = {}) => {
    const events = [header(provider)];
    const session = { id, header: sub ? { origin: 'subagent', delegationDepth: 1 } : {}, snapshotEvents: () => events };
    const agent = { id, status: 'idle', session, events };
    agents.set(id, agent); return agent;
  };
  const end = (agent, reason) => {
    const seq = agent.events.length;
    agent.events.push({ type: 'turn/start', seq: seq - 1 }, { type: 'turn/end', seq, data: { reason } });
    for (const fn of hooks.get('session/event') ?? []) fn(agent.session, agent.events.at(-1));
  };
  let downUntil = -1; // AIProxy is down until this fake time
  const down = (ms = 20) => { downUntil = clock + ms; };
  let clock = 0;
  const ctx = {
    on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
    get: (name) => ({ workspaceRegistry: { archivedSessionIds: archived }, llm: { listProviders: () => [{ id: 'aiproxy', name: 'AIProxy' }, { id: 'local', name: 'Local' }] } })[name],
    effect: (fn) => effects.push(fn()),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionController: {
      resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { message: 'gone' } }),
      prompt: async (req) => { prompts.push(req); },
    },
    sessionQuery: { readTitle: async (id) => ({ title: `Title ${id}` }) },
  };
  const handle = installOutageResume(ctx, home, { timing: T, now: () => clock, sleep: async (ms) => { clock += ms; await null; }, health: () => clock >= downUntil });
  await handle.ready;
  const call = async (body) => {
    const r = await routes.get(OUTAGE_PATH).fetch(new Request(`http://h${OUTAGE_PATH}`, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, json: await r.json() };
  };
  assert.deepEqual((await call()).json, { on: true }, 'on by default');
  for (const bad of ['{x', { on: 1 }, { lang: 'not a tag!' }, { on: true, x: 1 }, {}]) assert.equal((await call(bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await call({ lang: 'tr' })).json, { on: true });
  assert.deepEqual(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/outage-resume.json'), 'utf8')), { on: true, lang: 'tr' });

  // An outage: two root chats on AIProxy fail, a chat on another provider and a stopped chat do not count.
  const a = chat('a'); const b = chat('b'); const other = chat('other', { provider: 'local' }); const stopped = chat('stopped');
  down();
  end(a, err(C499)); end(b, { kind: 'error', error: { message: 'Connection error.' } });
  end(other, { kind: 'error', error: { message: 'Connection error.' } });
  end(stopped, { kind: 'aborted', reason: { kind: 'user' } });
  // A subagent of a: its parent's notice gets the outage line.
  const child = chat('child', { sub: true });
  end(child, err(C499));
  await handle.watch.settled();
  assert.deepEqual(prompts.map((p) => [p.sessionId, p.mode, p.content[0].text]), [['a', 'queue', OUTAGE_NOTES.tr], ['b', 'queue', OUTAGE_NOTES.tr]],
    'each failed root chat on AIProxy gets one message in the UI language, through dsh\'s prompt');
  assert.ok(prompts.every((p) => typeof p.requestId === 'string'));
  assert.deepEqual(handle.last().chats, [{ id: 'a', title: 'Title a' }, { id: 'b', title: 'Title b' }], 'the status panel list');

  const notice = { id: 'n1', role: 'user', content: [{ type: 'text', text: 'Background subagent child failed before it finished.' }], source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child' } };
  const plain = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } };
  const preStep = hooks.get('agent/pre-step')[0];
  const out = await preStep({}, async () => ({ kind: 'enter', messages: [plain, notice] }));
  assert.equal(out.messages[0], plain);
  assert.deepEqual(out.messages[1].content.map((c) => c.text), ['Background subagent child failed before it finished.', OUTAGE_CHILD_NOTE]);
  assert.equal(notice.content.length, 1, 'dsh\'s message object is not changed');
  const again = await preStep({}, async () => ({ kind: 'enter', messages: [notice] }));
  assert.equal(again.messages[0], notice, 'the line goes once');
  const other2 = { ...notice, source: { ...notice.source, senderSessionId: 'nobody' } };
  assert.equal((await preStep({}, async () => ({ kind: 'enter', messages: [other2] }))).messages[0], other2, 'another subagent: unchanged');

  // A chat that moved on (a newer turn) or runs, or is archived, gets nothing.
  prompts.length = 0; clock += T.hour;
  down();
  end(a, err(C499)); end(b, err(C499)); const c = chat('c'); end(c, err(C499));
  a.events.push({ type: 'turn/start', seq: 99 }); // you continued it
  b.status = 'running'; archived.push('c');
  await handle.watch.settled();
  assert.deepEqual(prompts, [], 'moved on, running or archived: no message');
  b.status = 'idle'; archived.length = 0;

  // Switched off: nothing continues, and no outage line.
  assert.deepEqual((await call({ on: false })).json, { on: false });
  clock += T.hour; down();
  const d = chat('d'); end(d, err(C499)); end(chat('e'), err(C499)); end(chat('child2', { sub: true }), err(C499));
  await handle.watch.settled();
  assert.deepEqual(prompts, [], 'off: nothing continues');
  const notice2 = { ...notice, source: { ...notice.source, senderSessionId: 'child2' } };
  assert.equal((await preStep({}, async () => ({ kind: 'enter', messages: [notice2] }))).messages[0], notice2, 'off: no outage line');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/outage-resume.json'), 'utf8')), { on: false, lang: 'tr' }, 'the language stays');

  // Unload: the watch stops.
  assert.deepEqual((await call({ on: true })).json, { on: true });
  for (const fn of effects) fn?.();
  down(); end(chat('f'), err(C499)); end(chat('g'), err(C499));
  await handle.watch.settled();
  assert.deepEqual(prompts, [], 'unloaded: nothing continues');
} finally { await rm(home, { recursive: true, force: true }); }
console.log('outage-resume: ok');
