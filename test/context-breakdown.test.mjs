// Context breakdown (Host half): the chat's model context now, from its log only. The surface is rebuilt as dsh does
// (append; replace of a range by /compact, Turn rollback, dsh-rewind or a new system prompt), each part priced with dsh's
// token-meter rule (4 characters per token, +4 per block and per message), tool results grouped by tool and MCP server,
// the tool definitions from the newest request header. A fork's copied events are in its context (they are counted).
import assert from 'node:assert/strict';
import { contextBreakdown, surfaceOf, eventTokens, installContext, CONTEXT_PATH } from '../index.js';

let seq = 0;
const ev = (type, data, surfaceOp = 'append', extra = {}) => ({ seq: ++seq, time: seq, type, data, ...(surfaceOp === null ? {} : { surfaceOp }), ...extra });
const text = (t) => [{ type: 'text', text: t }];
const sys = (t, op) => ev('system/message', { message: { role: 'system', content: text(t) } }, op);
const user = (t, kind = 'user', op) => ev('user/message', { role: 'user', source: { kind }, content: text(t) }, op);
const reply = (t, calls = []) => ev('assistant/message', { message: { role: 'assistant', content: [...text(t), ...calls.map(([id, name, args]) => ({ type: 'tool-call', id, name, arguments: args }))] } });
const call = (id, name) => ev('tool/call', { callId: id, name, arguments: '{}' }, null);
const result = (id, t) => ev('tool/result', { message: { role: 'tool', source: { kind: 'tool', callId: id }, content: text(t) } });

// dsh's heuristic: 'x' * 40 → 10 + 4 (block) + 4 (message); the system prompt has no block overhead.
assert.equal(eventTokens(user('x'.repeat(40))), 18);
assert.equal(eventTokens(sys('x'.repeat(40))), 14);
assert.equal(eventTokens(reply('abcd', [['c1', 'read', '{"file_path":"a"}']])), 1 + 4 + (1 + 5 + 4) + 4, 'text + tool call');
assert.equal(eventTokens(sys('')), 4, 'an empty system prompt: role framing only'); // content [{text:''}] is one block
assert.equal(eventTokens(ev('system/message', { message: { role: 'system', content: [] } })), 0);

seq = 0;
const s1 = sys('S'.repeat(400));
const events = [
  s1, user('<system-reminder>AGENTS.md text</system-reminder>', 'agent-instructions'), user('skills list', 'skill-catalog'),
  user('Fix the login'), reply('Reading it.', [['c1', 'read', '{}'], ['c2', 'mcp__github__get_issue', '{}'], ['c3', 'mcp__github__list_prs', '{}']]),
  call('c1', 'read'), result('c1', 'R'.repeat(400)), call('c2', 'mcp__github__get_issue'), result('c2', 'G'.repeat(800)), call('c3', 'mcp__github__list_prs'), result('c3', 'P'.repeat(80)),
  ev('request/header', { header: { config: { provider: 'p', model: 'big' }, tools: [{ name: 'read', parameters: {} }, { name: 'mcp__github__get_issue', parameters: {} }] } }, null),
  ev('request/context', { provider: 'p', model: 'big', contextWindow: 128000 }, null),
];
let r = contextBreakdown(events);
const part = (name) => r.parts.find((p) => p.part === name);
assert.equal(r.window, 128000); assert.equal(r.model, 'big'); assert.equal(r.compactions, 0);
assert.equal(part('mcp').labels[0].label, 'github', 'MCP results by server'); assert.equal(part('mcp').count, 2);
assert.deepEqual(part('tools').labels.map((l) => l.label), ['read']);
assert.equal(part('instructions').count, 1); assert.equal(part('skills').count, 1); assert.equal(part('user').count, 1); assert.equal(part('system').tokens, 104);
assert.deepEqual(part('definitions').labels.map((l) => l.label).sort(), ['dsh', 'mcp: github']); assert.equal(part('definitions').count, 2);
assert.equal(r.total, r.parts.reduce((n, p) => n + p.tokens, 0));
assert.ok(r.parts.every((p, i) => i === 0 || r.parts[i - 1].tokens >= p.tokens), 'biggest first');

// /compact replaces a range with its summary (counted as "summary", the replaced parts leave); a new system prompt
// replaces the old one.
const before = r.total;
const compact = user('summary of the work', 'compact-checkpoint', { op: 'replace', startSeq: events[3].seq, endSeq: events[10].seq });
const sys2 = sys('T'.repeat(40), { op: 'replace', startSeq: s1.seq, endSeq: s1.seq });
r = contextBreakdown([...events, compact, sys2]);
assert.equal(part('summary').count, 1); assert.equal(part('mcp'), undefined); assert.equal(part('tools'), undefined); assert.equal(part('user'), undefined);
assert.equal(part('system').tokens, 14, 'the newer system prompt only'); assert.equal(r.compactions, 1); assert.ok(r.total < before);
assert.deepEqual(surfaceOf([...events, compact, sys2]).map((e) => e.seq), [sys2.seq, events[1].seq, events[2].seq, compact.seq], 'model order kept');

// Turn rollback and dsh-rewind: the withdrawn messages leave the context; the marker is one small "rollback" node.
for (const kind of ['composer-plus-rollback', 'dsh-rewind']) {
  seq = 100;
  const a = user('keep'); const b = user('WITHDRAWN'); const c = reply('WITHDRAWN REPLY');
  const marker = user('(empty message)', kind, { op: 'replace', startSeq: b.seq, endSeq: c.seq });
  r = contextBreakdown([a, b, c, marker]);
  assert.equal(part('user').count, 1, kind); assert.equal(part('replies'), undefined, kind); assert.equal(part('rollback').count, 1, kind);
}
// A fork: its copied events are its context too (they are counted); an unknown replace range never drops text.
seq = 200;
const parentEvents = [user('parent ask'), reply('parent reply')];
r = contextBreakdown([...parentEvents, user('fork ask')]);
assert.equal(part('user').count, 2, 'inherited messages count: the model sees them'); assert.equal(part('replies').count, 1);
r = contextBreakdown([user('x'), user('odd', 'user', { op: 'replace', startSeq: 999, endSeq: 1000 })]);
assert.equal(part('user').count, 2, 'an unknown range: the node is kept');
// A non-surface event never counts; a log without a header has no definitions.
r = contextBreakdown([ev('turn/start', {}, null), user('hi')]);
assert.deepEqual(r.parts.map((p) => p.part), ['user']); assert.equal(r.window, undefined);

// The route: GET ?sessionId, read-only.
const routes = new Map();
let fail = false;
installContext({ connection: { fetch: { register: (x) => routes.set(x.path, x) } }, sessionQuery: { observeSession: async () => { if (fail) throw new Error('session not found: s1'); return { events, [Symbol.dispose]() {} }; } } });
const get = async (q) => { const res = await routes.get(CONTEXT_PATH).fetch(new Request(`http://h${CONTEXT_PATH}${q}`)); return { status: res.status, data: await res.json() }; };
assert.equal((await get('')).status, 400);
const ok = await get('?sessionId=s1'); assert.equal(ok.status, 200); assert.equal(ok.data.window, 128000); assert.ok(ok.data.parts.length > 3);
fail = true; assert.equal((await get('?sessionId=s1')).status, 404);
assert.deepEqual(routes.get(CONTEXT_PATH).methods, ['GET']);
console.log('context breakdown checks passed');
