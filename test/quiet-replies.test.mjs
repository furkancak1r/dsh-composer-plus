// Damon's `[quiet]` reply leaves no trace (2026-11-19): one text rule for every view (test/fixtures/quiet-replies.json,
// the same table as Tether's QuietReplyTests), and the real Host: a `[quiet]` turn of the assistant chat gives no green dot
// (Tether's list and badge), `assistant-status` says `quiet`, and the status panel shows no `[quiet]` result. The push rule
// itself is quietTurn (test/tether-push-words.test.mjs); the handler's gate on it is checked below.
// Another chat's `[quiet]` turn, a real reply and a failed turn stay as before. The client half: watchAttention gives the
// quiet turn no notification and no badge, and watchQuietDot puts back dsh's dot state after it.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, damonPushWords, quietRun, quietReply, quietTurn, runReply, statusTasks, ASSISTANT_STATUS_PATH, ASSISTANT_SWITCH_PATH, MOBILE_PATH, UNREAD_PATH, ROLLBACK_SOURCE } from '../index.js';

const table = JSON.parse(readFileSync(new URL('./fixtures/quiet-replies.json', import.meta.url), 'utf8')).cases;
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// 1. One rule: the Host's quietReply and the client's quietText give the table's answer.
const quietText = new Function(`${src.match(/const quietText = [^\n]+/)[0]}; return quietText;`)();
for (const { text, quiet } of table) {
  assert.equal(quietReply(text), quiet, `Host: ${JSON.stringify(text)}`);
  assert.equal(quietText(text), quiet, `client: ${JSON.stringify(text)}`);
  // The push rule (quietTurn) uses the same text rule, and also skips an empty reply.
  assert.equal(quietTurn([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }], text), quiet || text.trim() === '', `push: ${JSON.stringify(text)}`);
}

// 2. quietRun: the run's last turn ended completed and each of its replies is only `[quiet]`.
const turn = (seq, text, end = 'completed') => [{ seq, type: 'turn/start' }, { seq: seq + 1, type: 'user/message', data: { source: { kind: 'composer-plus-assistant-news' }, content: [{ type: 'text', text: 'news' }] } },
  { seq: seq + 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'Routine.' }, { type: 'text', text }] } } },
  ...(end === null ? [] : [{ seq: seq + 3, type: 'turn/end', data: { reason: { kind: end } } }])];
assert.equal(quietRun(turn(1, '[quiet]')), true);
assert.equal(quietRun(turn(1, ' [QUIET]\n')), true);
assert.equal(quietRun(turn(1, '')), false, 'a run without a reply is not a quiet reply here');
assert.equal(quietRun(turn(1, 'The deploy failed.')), false);
assert.equal(quietRun(turn(1, '[quiet]', 'error')), false, 'a failed turn is news');
assert.equal(quietRun(turn(1, '[quiet]', null)), false, 'a running turn');
assert.equal(quietRun([...turn(1, '[quiet]'), { seq: 9, type: 'turn/start' }]), false, 'a new turn started');
const two = [...turn(1, 'Real.'), ...turn(9, '[quiet]')];
assert.equal(quietRun(two), false, 'a run with a real reply before its [quiet] reply is news');
assert.equal(quietRun(two, 4), true, 'a run that starts after the real reply is quiet');
// A text sent with a tool call shows in the chat with dsh's default (foldedReplies: all): the run is news.
const work = { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool-call', id: 'c1', name: 'chats_list', arguments: '{}' }] } } };
assert.equal(quietRun([turn(1, '[quiet]')[0], work, ...turn(1, '[quiet]').slice(1)]), false, 'a progress text with a tool call is news');
const silentWork = { ...work, data: { message: { content: [{ type: 'reasoning', text: 'Look.' }, { type: 'tool-call', id: 'c2', name: 'chats_list', arguments: '{}' }] } } };
assert.equal(quietRun([turn(1, '[quiet]')[0], silentWork, ...turn(1, '[quiet]').slice(1)]), true, 'a tool call without text does not count');
// A real reply that a rollback withdrew does not count.
assert.equal(quietRun([...two, { seq: 20, type: 'user/message', sourceEventSeqs: [3], data: { source: { kind: ROLLBACK_SOURCE } } }, ...turn(21, '[quiet]')], 0), true, 'a withdrawn reply does not count');
// runReply: the words of a run that is news, its newest real text, also when the last reply is [quiet].
assert.equal(runReply(two), 'Real.', 'a real reply, then [quiet] in a later turn of the run');
assert.equal(runReply([turn(1, '[quiet]')[0], work, ...turn(1, '[quiet]').slice(1)]), 'Checking.', 'a real text with a tool call, then [quiet]');
assert.equal(runReply(turn(1, '[quiet]')), '', 'a quiet run has no words');
assert.equal(runReply(two, 4), '', 'only the run\'s own texts');

// 3. The real Host (apply): green dots, pushes and assistant-status.
const root = mkdtempSync(join(tmpdir(), 'cp-quiet-'));
process.env.DSH_MOBILE_IFACE = 'cp-test-none'; // never a LAN port, a certificate or Bonjour
const home = join(root, 'home'); const store = join(home, 'storages', 'dsh-composer-plus');
mkdirSync(store, { recursive: true });
writeFileSync(join(store, 'mobile.json'), JSON.stringify({ on: true }));
writeFileSync(join(store, 'assistant.json'), JSON.stringify({ sessionId: 's-damon' }));
process.env.DSH_HOME = home; process.env.DSH_MOBILE_DIR = join(home, 'mobile'); process.env.DSH_MOBILE_ADMIN_PORT = '0';
const routes = new Map(); const handlers = new Map(); const logs = new Map(); const agents = new Map();
const agentOf = (id) => { if (!agents.has(id)) agents.set(id, { id, status: 'idle', session: { header: {}, snapshotEvents: () => logs.get(id) ?? [] } }); return agents.get(id); };
const disposers = [];
apply({ on: (name, f) => { handlers.set(name, [...(handlers.get(name) ?? []), f]); }, sessionController: {}, sessionQuery: {}, subprocess: {},
  get: (name) => (name === 'agents' ? { get: (id) => agents.get(id), list: () => [...agents.values()] } : undefined),
  connection: { fetch: { register: (r) => routes.set(r.path, r) }, authenticatedUrl: (base) => `${base}/?token=t` },
  effect: (f) => { disposers.push(f()); }, inject: () => ({ dispose() {} }) });
const route = async (path, body) => {
  const r = await routes.get(path).fetch(new Request(`http://h${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
  return r.json();
};
const unread = async () => (await route(UNREAD_PATH)).unread.slice().sort();
await route(ASSISTANT_STATUS_PATH); // the assistant chat id is read from its file
const run = async (id, text, end = 'completed') => {
  const agent = agentOf(id);
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'running' });
  logs.set(id, [...(logs.get(id) ?? []), ...turn((logs.get(id)?.length ?? 0) + 1, text, end)]);
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'idle' });
  await new Promise((r) => setTimeout(r, 0));
};
assert.equal((await route(ASSISTANT_STATUS_PATH)).sessionId, 's-damon', 'the assistant chat is known');
await run('s-damon', 'The deploy of acme failed.');
assert.deepEqual(await unread(), ['s-damon'], 'a real reply of the assistant gives the green dot');
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, undefined, 'a real reply: not quiet');
await route(UNREAD_PATH, { sessionIds: ['s-damon'] }); // you read it on a device
await run('s-damon', '[quiet]');
assert.deepEqual(await unread(), [], 'a [quiet] turn of the assistant gives no green dot (Tether list and badge)');
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, true, 'assistant-status says quiet');
await run('s-damon', 'New risk on prod.');
assert.deepEqual(await unread(), ['s-damon'], 'the next real reply gives the dot again');
await run('s-damon', ' [QUIET]\n');
assert.deepEqual(await unread(), ['s-damon'], 'an unread real reply keeps its dot through a later [quiet] turn');
await route(UNREAD_PATH, { sessionIds: ['s-damon'] });
await run('s-damon', '[quiet]', 'error');
assert.deepEqual(await unread(), ['s-damon'], 'a failed turn still gives the dot');
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, undefined, 'a failed turn: not quiet');
await run('s-web', '[quiet]');
assert.deepEqual(await unread(), ['s-damon', 's-web'], 'another chat\'s [quiet] turn keeps its dot as before');
// One run of the assistant chat with a real reply, then (a subagent's message mid-run) a [quiet] reply: news.
await route(UNREAD_PATH, { sessionIds: ['s-damon'] });
{
  const agent = agentOf('s-damon');
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'running' });
  const at = logs.get('s-damon').length + 1;
  logs.set('s-damon', [...logs.get('s-damon'), ...turn(at, 'Started the audit.'), ...turn(at + 4, '[quiet]')]);
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'idle' });
}
assert.ok((await unread()).includes('s-damon'), 'a run with a real reply keeps its dot, also when its last reply is [quiet]');
// The next run starts before a client asks: the answer is still the run that ended.
for (const f of handlers.get('agent/status') ?? []) f({ agent: agentOf('s-damon'), status: 'running' });
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, undefined, 'and assistant-status does not say quiet');
{
  const agent = agentOf('s-damon');
  logs.set('s-damon', [...logs.get('s-damon'), ...turn(logs.get('s-damon').length + 1, '[quiet]')]);
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'idle' });
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'running' }); // the next run starts at once
}
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, true, 'a quiet run stays quiet in assistant-status while the next run runs');
// Mobile connect off (the desktop alone): assistant-status still says which run was quiet (the client's notification and dot).
for (const f of handlers.get('agent/status') ?? []) f({ agent: agentOf('s-damon'), status: 'idle' });
await route(MOBILE_PATH, { on: false });
await run('s-damon', 'Real news.');
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, undefined, 'Mobile connect off: a real reply is not quiet');
await run('s-damon', '[quiet]');
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, true, 'Mobile connect off: a quiet run is quiet');
// A run of a subagent edge is not counted, and an idle edge of a chat that was not running changes nothing.
{
  const agent = agentOf('s-damon');
  for (const f of handlers.get('agent/status') ?? []) f({ agent: { ...agent, id: 's-damon', session: { header: { origin: 'subagent' } } }, status: 'running' });
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'idle' });
}
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, true, 'an idle edge of a chat that was not running changes nothing');
// A run that started while Assistant was off (no run record: the Host did not know the chat as the assistant) clears
// the old quiet result at its end, so the next notification is not dropped as quiet.
await route(ASSISTANT_SWITCH_PATH, { on: false });
for (const f of handlers.get('agent/status') ?? []) f({ agent: agentOf('s-damon'), status: 'running' });
await route(ASSISTANT_SWITCH_PATH, { on: true });
logs.set('s-damon', [...logs.get('s-damon'), ...turn(logs.get('s-damon').length + 1, 'A real reply.')]);
for (const f of handlers.get('agent/status') ?? []) f({ agent: agentOf('s-damon'), status: 'idle' });
assert.equal((await route(ASSISTANT_STATUS_PATH)).quiet, undefined, 'a run without a run record clears the old quiet result');
// A run that is news says its newest real text, also when its last reply is [quiet]: the desktop notification's words.
await run('s-damon', 'Started the audit.');
assert.equal((await route(ASSISTANT_STATUS_PATH)).reply, 'Started the audit.');
{
  const agent = agentOf('s-damon');
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'running' });
  const at = logs.get('s-damon').length + 1;
  logs.set('s-damon', [...logs.get('s-damon'), ...turn(at, 'Found 2 issues.'), ...turn(at + 4, '[quiet]')]);
  for (const f of handlers.get('agent/status') ?? []) f({ agent, status: 'idle' });
}
const status2 = await route(ASSISTANT_STATUS_PATH);
assert.deepEqual([status2.quiet, status2.reply], [undefined, 'Found 2 issues.'], 'a run with a real text, then [quiet]: news, with the real words');
for (const d of disposers) d?.();
rmSync(root, { recursive: true, force: true });
// The handler pushes Turn finished only when quietTurn says the turn has something to say (apply() builds the real gateway,
// so the gate is read from the source: the push line and the quiet value that it reads).
const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
assert.match(host, /const words = pushWords\(events, run\?\.from\);\s*if \(words !== undefined\) mobile\?\.push\('Turn finished', words, agent\.id\);/, 'the Host pushes the words of pushWords (test/tether-push-words.test.mjs)');
assert.equal(host.match(/mobile\?\.push\('Turn finished'/g)?.length, 1, 'one Turn finished push in the Host');

// 3b. The status panel: a task whose last reply is only `[quiet]` shows no result line; a real reply shows its first line.
const NOW = Date.now(); const ev = (seq, type, data) => ({ seq, type, data, time: NOW - 1000 });
const child = (text) => ({ status: 'idle', session: { snapshotEvents: () => [ev(0, 'turn/start', {}), ev(1, 'assistant/message', { message: { content: [{ type: 'text', text }] } }), ev(2, 'turn/end', { reason: { kind: 'completed' } })] } });
const kids = { 'c-quiet': child(' [QUIET]\n'), 'c-real': child('Flights found: 3 options') };
const catalog = Object.keys(kids).map((id, i) => ev(i, 'subagent/catalog', { version: 0, childId: id, childCreatedAt: NOW - 60000 + i, mode: 'one-shot', label: id }));
const rows = Object.fromEntries((await statusTasks(catalog, 0, (id) => kids[id], { now: NOW })).map((t) => [t.id, t]));
assert.equal(rows['c-quiet'].result, undefined, 'a [quiet] reply is no result line in the status panel');
assert.equal(rows['c-real'].result, 'Flights found: 3 options');

// 4. The client half: watchAttention (Notifications) and watchQuietDot.
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {}, focus() {} };
globalThis.document = { hasFocus: () => false };
let badge = 0; Object.defineProperty(globalThis, 'navigator', { value: { setAppBadge: (n) => { badge = n; return Promise.resolve(); }, clearAppBadge: () => { badge = 0; return Promise.resolve(); } }, configurable: true });
const shown = [];
globalThis.Notification = class { static get permission() { return 'granted'; } constructor(title, o) { this.title = title; this.body = o.body; shown.push(this); } close() {} };
eval(src.replace('    function AssistantPage({', '    globalThis.__quiet = { watchAttention, watchQuietDot, newsRowKeys, attentionBody };\n    function AssistantPage({'));
const React = { createElement: () => ({}), Fragment: 'F', useState: (v) => [v, () => {}], useEffect: () => {}, useSyncExternalStore: (_s, g) => g() };
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: () => ({}) } : {}));
const { watchAttention, watchQuietDot, newsRowKeys, attentionBody } = globalThis.__quiet;

// One rule on every side: for each completed turn of the shared table (the iOS QuietReplyTests read it too), the Host's
// quietRun and runReply and the client's newsRowKeys (the news note goes only with a quiet turn) give its answer. A step is
// its message content; dsh maps each block 1:1 to the chat node (text → text, reasoning → reasoning, tool-call →
// tool-call: dsh-client-ui-chat toAssistantBlock).
const block = (b) => (b === 'tool' ? { type: 'tool-call', id: 'c', name: 'chats_list', arguments: '{}' } : b === 'think' ? { type: 'reasoning', text: 'Look.' } : { type: 'text', text: b });
for (const { steps, quiet, reply, push } of JSON.parse(readFileSync(new URL('./fixtures/quiet-replies.json', import.meta.url), 'utf8')).turns) {
  const contents = steps.map((s) => s.map(block));
  const events = [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'user/message', data: { source: { kind: 'composer-plus-assistant-news' }, content: [block('news')] } },
    ...contents.map((content, i) => ({ seq: 2 + i, type: 'assistant/message', data: { message: { content } } })), { seq: 9, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  const nodes = new Map([['note', { key: 'note', kind: 'context', location: { kind: 'step', turn: { turn: 1 } }, data: { source: { kind: 'composer-plus-assistant-news' } } }],
    ...contents.map((content, i) => [`s${i}`, { key: `s${i}`, kind: 'assistant-step', data: { turn: 1, step: i + 1, blocks: content.map((b) => ({ kind: b.type, text: b.text })) } }])]);
  const label = JSON.stringify(steps);
  assert.equal(quietRun(events), quiet, `Host: ${label}`);
  assert.equal(runReply(events), reply, `Host words: ${label}`);
  assert.equal(damonPushWords(events) ?? null, push, `Damon's push: ${label}`);
  assert.equal(newsRowKeys({ nodes }).includes('note'), quiet, `client: ${label}`);
}
// A message that you steered into a running news turn (dsh logs it as a `user` message in the same turn): the part after
// it answers you, so a [quiet] news start does not hide that answer (review 2026-11-24).
for (const { steps, push } of JSON.parse(readFileSync(new URL('./fixtures/quiet-replies.json', import.meta.url), 'utf8')).steered) {
  const events = [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'user/message', data: { source: { kind: 'composer-plus-assistant-news' }, content: [block('news')] } },
    ...steps.map((s, i) => (typeof s === 'string' ? { seq: 2 + i, type: 'user/message', data: { source: s.startsWith('@') ? { kind: s.slice(1) } : { kind: 'user', rpcId: 'r' }, content: [block(s)] } }
      : { seq: 2 + i, type: 'assistant/message', data: { message: { content: s.map(block) } } })), { seq: 20, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  assert.equal(damonPushWords(events) ?? null, push, `Damon's push, steered: ${JSON.stringify(steps)}`);
}
// The notification body never shows `[quiet]` (dsh's turnOutline keeps the turn's last text, also after a real reply).
const tr = (k) => k;
for (const reply of ['[quiet]', ' [QUIET] ']) assert.equal(attentionBody('done', undefined, reply, tr), 'notify.done', JSON.stringify(reply));
assert.equal(attentionBody('done', undefined, 'Deployed v2.', tr), 'Deployed v2.', 'a real reply is the body');
const st = (o = {}) => ({ running: false, pendingInteraction: undefined, completionUnread: false, ...o });
let snap = new Map(); const ls = new Set();
const status = { getSnapshot: () => snap, subscribe: (l) => { ls.add(l); return () => ls.delete(l); } };
const pub = (m) => { snap = m; for (const l of [...ls]) l(); };
// dsh's turnOutline response of the assistant chat is its last turn's last text: `[quiet]` after a real reply.
const list = { getSnapshot: () => ({ byId: { 's-damon': { displayTitle: 'Damon' }, 's-web': { displayTitle: 'Fix login' } }, projectionsBySession: { 's-damon': { values: { turnOutline: [{ turn: 1, response: '[quiet]' }] } } } }) };
let ends = { quiet: true, reply: '' }; const asked = [];
const quiet = (id) => (id === 's-damon' ? (asked.push(id), Promise.resolve(ends)) : undefined);
const off = watchAttention(status, list, (k) => k, () => {}, quiet);
const settle = () => new Promise((r) => setTimeout(r, 0));
pub(new Map([['s-damon', st({ running: true })], ['s-web', st({ running: true })]]));
pub(new Map([['s-damon', st()], ['s-web', st()]])); await settle();
assert.deepEqual(shown.map((n) => n.title), ['Fix login'], 'the quiet assistant turn gives no notification; another chat still does');
assert.equal(badge, 1, 'only the other chat counts in the dock badge');
assert.deepEqual(asked, ['s-damon'], 'only the assistant chat is asked');
ends = { quiet: false, reply: 'Found 2 issues.\nDetails.' };
pub(new Map([['s-damon', st({ running: true })], ['s-web', st()]])); pub(new Map([['s-damon', st()], ['s-web', st()]])); await settle();
assert.deepEqual(shown.map((n) => n.title), ['Fix login', 'Damon'], 'a real assistant reply notifies as before');
assert.equal(shown.at(-1).body, 'Found 2 issues.', 'with the run\'s real words, not dsh\'s last text [quiet]');
ends = {}; // an older Host or a failed read: the plain notification
pub(new Map([['s-damon', st({ running: true })], ['s-web', st()]])); pub(new Map([['s-damon', st()], ['s-web', st()]])); await settle();
assert.equal(shown.at(-1).body, 'notify.done', 'no words from the Host: never [quiet]');
off();

// watchQuietDot: dsh's dot of the assistant chat goes after a quiet turn, only when the chat had no dot before it.
const cleared = []; const api = { markRead: (ids) => { cleared.push(...ids); const m = new Map(snap); for (const id of ids) m.set(id, { ...m.get(id), completionUnread: false }); snap = m; return true; } };
snap = new Map([['s-damon', st()]]);
let isQuiet = true;
const offDot = watchQuietDot(status, () => 's-damon', api, async () => ({ quiet: isQuiet }));
pub(new Map([['s-damon', st({ running: true })]])); pub(new Map([['s-damon', st({ completionUnread: true })]])); await settle();
assert.deepEqual(cleared, ['s-damon'], 'a quiet turn leaves no dsh dot');
isQuiet = false;
pub(new Map([['s-damon', st({ running: true })]])); pub(new Map([['s-damon', st({ completionUnread: true })]])); await settle();
assert.deepEqual(cleared, ['s-damon'], 'a real reply keeps its dot');
isQuiet = true;
pub(new Map([['s-damon', st({ running: true })]])); pub(new Map([['s-damon', st({ completionUnread: true })]])); await settle();
assert.deepEqual(cleared, ['s-damon'], 'an unread real reply keeps its dot through a later quiet turn');
offDot();
assert.equal(typeof watchQuietDot(status, () => 's-damon', undefined), 'function', 'no markRead API (another dsh): nothing to do');
console.log('quiet replies: one rule, no dot, no push, no notification, no status line for a [quiet] turn');
