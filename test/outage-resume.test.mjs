// Resume after an AIProxy outage (Host half), with fakes only (no real AIProxy, no real dsh):
// - outageError: AIProxy's 499 request_cancelled and "Connection error." trigger; AIProxy's 429 and 503 upstream_rejected
//   (the provider refused the request) are 'rejected'; a user stop, a denied approval and other errors (409, 500, a 499
//   or 429 with another code) do not.
// - outageWatch: failures within the window are one outage; it waits for a failed health check (or a Connection error)
//   and then for the settle time of good checks; a 499 while AIProxy stays up continues nothing;
//   one message per chat per outage, at most perHour per hour; a chat that moved on gets nothing; `left(id, why)` gets
//   each chat that is not continued (no outage, gave up, max, limit, switched off, resume's answer), not after close.
//   A 'rejected' chat gets no health check: it is continued once after the fixed wait `retry`, in the same hourly limit;
//   the newest failure of a chat wins (also across the outage and the wait).
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
// The provider refused the request (live logs of 2026-11-13: 60 turn ends with these two texts).
const C429 = 'aiproxy API error (429): {"code":"upstream_rejected","message":"Sağlayıcı isteği reddetti (HTTP 429)."}';
const C503 = 'aiproxy API error (503): {"code":"upstream_rejected","message":"Sağlayıcı isteği reddetti (HTTP 503)."}';
assert.equal(outageError({ kind: 'error', error: { message: C429, code: 'RATE_LIMIT' } }), 'rejected', '429');
assert.equal(outageError({ kind: 'error', error: { message: C503, code: 'SERVER' } }), 'rejected', '503');
assert.equal(outageError(err('429: {"code":"upstream_rejected","message":"x"}')), 'rejected', 'the openai-completions form');
for (const [reason, why] of [
  [{ kind: 'aborted', reason: { kind: 'user' } }, 'a user stop'],
  [{ kind: 'aborted', reason: { kind: 'disposed' } }, 'dsh quit'],
  [{ kind: 'blocked' }, 'a denied approval or a hook refusal'],
  [{ kind: 'completed' }, 'a finished turn'],
  [err('aiproxy API error (429): {"code":"rate_limited","message":"x"}'), 'a 429 with another code'],
  [err('aiproxy API error (503): {"code":"all_failed","message":"x"}'), 'a 503 with another code'],
  [err('aiproxy API error (500): {"code":"upstream_rejected","message":"x"}'), 'upstream_rejected with another status'],
  [err('aiproxy API error (502): {"code":"internal_error","message":"upstream_rejected 429"}'), 'the words in another error'],
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
const T = { ...OUTAGE, window: 60, poll: 1, settle: 10, giveUp: 1000, hour: 3600, retry: 100 };
assert.ok(OUTAGE.retry >= 120000 && OUTAGE.retry <= 300000, 'the wait after a 429/503 is 2 to 5 minutes');
function rig({ healthy = () => true, resume, timing = T } = {}) {
  let clock = 0; const checks = []; const resumed = []; const left = [];
  const w = outageWatch({ now: () => clock, timing, sleep: async (ms) => { clock += ms; await null; },
    health: () => { const ok = healthy(clock); checks.push([clock, ok]); return ok; },
    left: (id, why) => left.push([id, why]),
    resume: resume ?? (async (id, seq) => { resumed.push([id, seq, clock]); return 'continued'; }) });
  return { w, checks, resumed, left, tick: (ms) => { clock += ms; }, at: () => clock };
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
  assert.deepEqual(r.left, [], 'a continued chat is not left');
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
  assert.deepEqual(r.left, [['a', 'limit']], 'the hourly limit leaves the chat');
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
  assert.deepEqual(r.left, [['solo', 'no outage'], ['x', 'no outage'], ['y', 'no outage']], 'each cancel is left');
}
{
  // AIProxy never comes back: the watch gives up, nothing continues.
  const r = rig({ healthy: () => false });
  r.w.fail('a', 1, 'connection'); await r.w.settled();
  assert.deepEqual(r.resumed, []);
  assert.ok(r.at() >= T.giveUp);
  assert.deepEqual(r.left, [['a', 'gave up']]);
}
{
  // More failed chats than `max`: the ones over the cap are left.
  const r = rig({ healthy: (t) => t > 2, timing: { ...T, max: 1 } });
  r.w.fail('a', 1, 'connection'); r.w.fail('b', 1, 'connection'); await r.w.settled();
  assert.deepEqual(r.resumed.map(([id]) => id), ['a']);
  assert.deepEqual(r.left, [['b', 'max']]);
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
  assert.deepEqual(r.left, [['moved', 'moved'], ['boom', 'failed']], 'each chat that is not continued is left, with why');
}
{
  // 429/503 upstream_rejected: AIProxy runs, the provider refused the request. No health check: one try after `retry`.
  const r = rig();
  r.w.fail('a', 5, 'rejected'); r.w.fail('b', 7, 'rejected');
  await r.w.settled();
  assert.deepEqual(r.resumed.map(([id, seq]) => [id, seq]), [['a', 5], ['b', 7]], 'each refused chat continues once');
  assert.ok(r.resumed.every(([, , at]) => at >= T.retry), 'only after the fixed wait');
  assert.deepEqual(r.checks, [], 'no health check');
  assert.deepEqual(r.left, []);
  // The provider refuses again: one more try; the third refusal in the same hour is left (no loop).
  r.w.fail('a', 9, 'rejected'); await r.w.settled();
  r.w.fail('a', 11, 'rejected'); await r.w.settled();
  assert.deepEqual(r.resumed.filter(([id]) => id === 'a').map(([, seq]) => seq), [5, 9], 'at most two per hour');
  assert.deepEqual(r.left, [['a', 'limit']], 'the hourly limit leaves the chat');
  // The limit is the same for outages: b continued once, an outage continues it once more, then a refusal is left.
  r.w.fail('b', 8, 'connection'); await r.w.settled();
  r.w.fail('b', 10, 'rejected'); await r.w.settled();
  assert.deepEqual(r.resumed.filter(([id]) => id === 'b').map(([, seq]) => seq), [7, 8]);
  assert.deepEqual(r.left.at(-1), ['b', 'limit']);
  // After an hour, it continues again.
  r.tick(T.hour); r.w.fail('a', 13, 'rejected'); await r.w.settled();
  assert.deepEqual(r.resumed.at(-1).slice(0, 2), ['a', 13], 'the limit is per hour');
}
{
  // A chat that is refused again during the wait: one try, for its newest turn, a full wait after it.
  const r = rig();
  r.w.fail('a', 1, 'rejected'); r.tick(60); r.w.fail('a', 2, 'rejected');
  await r.w.settled();
  assert.deepEqual(r.resumed.map(([id, seq]) => [id, seq]), [['a', 2]], 'one try, the newest refused turn');
  assert.ok(r.resumed[0][2] >= 60 + T.retry, 'the wait starts again');
}
{
  // The newest failure of a chat wins: an outage takes a chat that waits, a refusal takes a chat of the outage.
  const r = rig({ healthy: (t) => t >= 5 });
  r.w.fail('a', 1, 'rejected'); r.w.fail('a', 2, 'cancelled'); r.w.fail('b', 1, 'connection'); r.w.fail('b', 2, 'rejected');
  await r.w.settled();
  assert.deepEqual(r.resumed.map(([id, seq]) => [id, seq]).sort(), [['a', 2], ['b', 2]], 'each chat once, its newest failure');
  assert.deepEqual(r.left, []);
}
{
  // A chat that is refused again while its try runs: the older try is not left (the bot would lose the newer failure);
  // the newer try decides.
  let clock = 0; const left = []; const tries = []; let w;
  w = outageWatch({ now: () => clock, timing: T, health: () => true, sleep: async (ms) => { clock += ms; await null; }, left: (id, why) => left.push([id, why]),
    resume: async (id, seq) => { tries.push(seq); if (seq === 1) { w.fail('a', 2, 'rejected'); return 'moved'; } return 'limit-test'; } });
  w.fail('a', 1, 'rejected'); await w.settled(); await w.settled();
  assert.deepEqual(tries, [1, 2], 'one try per refusal');
  assert.deepEqual(left, [['a', 'limit-test']], 'only the newest try leaves the chat');
}
{
  // A refusal's try and an outage's try for the same chat at the same time: both count against the hourly limit.
  let clock = 0; let release; const tries = [];
  const w = outageWatch({ now: () => clock, timing: T, health: () => true, sleep: async (ms) => { clock += ms; await null; },
    resume: async (id, seq) => { tries.push(seq); if (seq === 1) await new Promise((r) => { release = r; }); return 'continued'; } });
  w.fail('a', 1, 'rejected');
  while (release === undefined) await null; // the refusal's try waits in resume()
  w.fail('a', 2, 'connection'); // an outage of the same chat: its try runs and ends first
  while (tries.length < 2) await null;
  release(); await w.settled();
  w.fail('a', 3, 'rejected'); await w.settled();
  assert.deepEqual(tries, [1, 2], 'two messages in the hour, then the limit');
}
{
  // One message earlier in the hour, then the same overlap: the second try finds the slot taken (the limit holds).
  let clock = 0; let release; const tries = []; const left = [];
  const w = outageWatch({ now: () => clock, timing: T, health: () => true, sleep: async (ms) => { clock += ms; await null; }, left: (id, why) => left.push([id, why]),
    resume: async (id, seq) => { tries.push(seq); if (seq === 1) await new Promise((r) => { release = r; }); return 'continued'; } });
  w.fail('a', 0, 'rejected'); await w.settled();
  w.fail('a', 1, 'rejected');
  while (release === undefined) await null;
  w.fail('a', 2, 'connection');
  while (tries.length < 3 && left.length === 0) await null; // the outage's try ends
  release(); await w.settled();
  assert.deepEqual(tries, [0, 1], 'at most two messages in the hour');
  assert.deepEqual(left, [['a', 'limit']]);
}
{
  // Switched off or closed during the wait after a refusal: nothing continues; off leaves the chat, close does not.
  let active = true; let clock = 0; const resumed = []; const left = [];
  const opts = { now: () => clock, timing: T, health: () => true, resume: async (id) => { resumed.push(id); return 'continued'; }, left: (id, why) => left.push([id, why]) };
  const w = outageWatch({ ...opts, active: () => active, sleep: async (ms) => { clock += ms; active = false; } });
  w.fail('a', 1, 'rejected'); await w.settled();
  assert.deepEqual([resumed, left], [[], [['a', 'off']]], 'switched off during the wait');
  const w2 = outageWatch({ ...opts, sleep: async (ms) => { clock += ms; await null; } });
  w2.fail('a', 1, 'rejected'); w2.close(); await w2.settled();
  assert.deepEqual([resumed, left.length], [[], 1], 'closed (plugin unload): nothing continues, nothing is left');
}
{
  // Switched off (active false) or closed during the wait: nothing continues.
  let active = true; let clock = 0; const resumed = []; const left = [];
  const w = outageWatch({ now: () => clock, timing: T, active: () => active, sleep: async (ms) => { clock += ms; if (clock > 3) active = false; },
    health: () => clock > 50, resume: async (id) => { resumed.push(id); return 'continued'; }, left: (id, why) => left.push([id, why]) });
  w.fail('a', 1, 'connection'); await w.settled();
  assert.deepEqual(resumed, [], 'switched off during the wait');
  assert.deepEqual(left, [['a', 'off']], 'switched off: the chat is left');
  const w2 = outageWatch({ now: () => clock, timing: T, sleep: async (ms) => { clock += ms; }, health: () => false, resume: async (id) => { resumed.push(id); return 'continued'; },
    left: (id, why) => left.push([id, why]) });
  w2.fail('a', 1, 'connection'); w2.close(); await w2.settled();
  assert.deepEqual(resumed, [], 'closed (plugin unload)');
  assert.equal(left.length, 1, 'closed: nothing is left (the plugin unloads)');
  // A throwing `left` is logged and does not stop the other chats.
  const logs = []; const seen = [];
  const w3 = outageWatch({ now: () => clock, timing: T, sleep: async (ms) => { clock += ms; }, health: () => true, resume: async () => 'continued', log: (t) => logs.push(t),
    left: (id) => { seen.push(id); if (id === 'a') throw new Error('x'); } });
  w3.fail('a', 1, 'cancelled'); w3.fail('b', 1, 'cancelled'); await w3.settled();
  assert.deepEqual(seen, ['a', 'b']);
  assert.ok(logs.includes('outage left a: x'));
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

  // The provider refused the request (429 or 503 upstream_rejected) while AIProxy runs: no health check (it would say
  // no here), each chat gets one message after the fixed wait, so dsh starts its queued messages too. A chat that you
  // stopped gets nothing.
  clock += T.hour; downUntil = Infinity;
  const h1 = chat('h1'); const h2 = chat('h2'); const h3 = chat('h3'); const t0 = clock;
  end(h1, { kind: 'error', error: { message: C429, code: 'RATE_LIMIT' } });
  end(h2, { kind: 'error', error: { message: C503, code: 'SERVER' } });
  end(h3, { kind: 'aborted', reason: { kind: 'user' } });
  assert.deepEqual(prompts, [], 'nothing at once');
  await handle.watch.settled();
  assert.deepEqual(prompts.map((p) => [p.sessionId, p.mode, p.content[0].text]), [['h1', 'queue', OUTAGE_NOTES.tr], ['h2', 'queue', OUTAGE_NOTES.tr]],
    'each refused chat gets one message; the chat that you stopped gets none');
  assert.ok(clock - t0 >= T.retry, 'after the wait');
  assert.equal(handle.takes(h1.session, { kind: 'error', error: { message: C429 } }), true, 'the Assistant keeps such a task until the try');
  assert.equal(handle.takes(h3.session, { kind: 'aborted', reason: { kind: 'user' } }), false);
  // A subagent that the provider refused: its parent's notice gets no outage line (AIProxy did not stop).
  end(chat('child3', { sub: true }), { kind: 'error', error: { message: C429, code: 'RATE_LIMIT' } });
  const notice3 = { ...notice, source: { ...notice.source, senderSessionId: 'child3' } };
  assert.equal((await preStep({}, async () => ({ kind: 'enter', messages: [notice3] }))).messages[0], notice3, 'a refused subagent: no outage line');
  prompts.length = 0; downUntil = -1;

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
