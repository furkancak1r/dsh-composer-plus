// The Host's per-turn readers give the same result as before on random chat logs, and read less of a long log:
// - lastReply (Turn finished push, Assistant news, the status panel) looks for withdraw markers only in the last turn;
// - predictTranscript (Next message prediction) reads the log from its end until its context is full.
// The reference functions below are the old code, word for word.
import assert from 'node:assert/strict';
import { lastReply, predictTranscript, ROLLBACK_SOURCE, REWIND_SOURCE } from '../index.js';

const PREDICT_CONTEXT = 6000;
const textBlocks = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') : '');
const rollbackSpans = (events, kinds) => events.filter((e) => e.type === 'user/message' && kinds.includes(e.data?.source?.kind) && Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.length > 0)
  .map((e) => [Math.min(...e.sourceEventSeqs), e.seq]);
const withdrawn = (events) => { const spans = rollbackSpans(events, [ROLLBACK_SOURCE, REWIND_SOURCE]); return (seq) => spans.some(([a, b]) => seq >= a && seq <= b); };
function oldLastReply(events) {
  const start = events.findLastIndex((e) => e.type === 'turn/start');
  const gone = withdrawn(events);
  for (let i = events.length - 1; i > start; i--) {
    const text = events[i].type === 'assistant/message' && !gone(events[i].seq) ? textBlocks(events[i].data?.message?.content).trim() : '';
    if (text !== '') return text;
  }
  return '';
}
function oldPredictTranscript(events) {
  const lines = [];
  for (const e of events) {
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') { const text = textBlocks(e.data.content).trim(); if (text !== '') lines.push({ who: 'User', text }); }
    else if (e.type === 'assistant/message') { const text = textBlocks(e.data?.message?.content).trim(); if (text !== '') lines.push({ who: 'Agent', text }); }
  }
  if (lines.at(-1)?.who !== 'Agent') return undefined;
  const out = []; let size = 0;
  for (let i = lines.length - 1; i >= 0 && size < PREDICT_CONTEXT; i--) {
    const room = PREDICT_CONTEXT - size;
    const text = lines[i].text.length > room ? `…${lines[i].text.slice(-room)}` : lines[i].text;
    out.unshift(`${lines[i].who}: ${text}`); size += text.length;
  }
  return out.join('\n\n');
}

// A seeded random chat log: turns, user messages (own and context), replies (text, tool calls, empty), tool results and
// withdraw markers of both kinds that hide a range of earlier events (also one across a turn start).
let seed = 1;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const words = (n) => Array.from({ length: n }, () => pick(['ok', 'the', 'build', 'login', 'fix', 'test', '', ' ', 'long'.repeat(400)])).join(' ');
function randomLog(n) {
  const events = [];
  for (let seq = 0; seq < n; seq++) {
    const r = rand();
    if (r < 0.08) events.push({ seq, type: 'turn/start', data: {} });
    else if (r < 0.12) events.push({ seq, type: 'turn/end', data: { reason: { kind: 'completed' } } });
    else if (r < 0.32) events.push({ seq, type: 'user/message', data: { source: { kind: pick(['user', 'user', 'runtime-context', 'subagent-settled']) }, content: [{ type: 'text', text: words(1 + Math.floor(rand() * 4)) }] } });
    else if (r < 0.62) events.push({ seq, type: 'assistant/message', data: { message: { content: pick([[{ type: 'text', text: words(1 + Math.floor(rand() * 5)) }], [{ type: 'tool-call', id: 'c', name: 'bash' }], [{ type: 'reasoning', text: 'x' }, { type: 'text', text: words(2) }], []]) } } });
    else if (r < 0.7 && seq > 2) {
      const from = Math.max(0, seq - 1 - Math.floor(rand() * 12));
      events.push({ seq, type: 'user/message', data: { source: { kind: pick([ROLLBACK_SOURCE, REWIND_SOURCE]) }, content: [] }, sourceEventSeqs: Array.from({ length: seq - from }, (_, k) => from + k) });
    } else events.push({ seq, type: pick(['tool/call', 'tool/result', 'step/start', 'step/end']), data: {} });
  }
  return events;
}
let compared = 0;
for (let round = 0; round < 3000; round++) {
  const events = randomLog(1 + Math.floor(rand() * 80));
  assert.equal(lastReply(events), oldLastReply(events), `lastReply round ${round}`);
  assert.equal(predictTranscript(events), oldPredictTranscript(events), `predictTranscript round ${round}`);
  compared++;
}
// A marker in an older turn that reaches into the last turn cannot exist (a marker comes after what it hides), but a
// marker of the last turn that hides a reply of an older turn must not matter either.
const say = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const crossing = [say(0, 'older'), { seq: 1, type: 'turn/start' }, say(2, 'kept'), say(3, 'gone'), { seq: 4, type: 'user/message', data: { source: { kind: ROLLBACK_SOURCE } }, sourceEventSeqs: [0, 1, 2, 3] }];
assert.equal(lastReply(crossing), oldLastReply(crossing));

// Less work in a long log: the old code read every event; the new code stops early.
const long = [];
for (let t = 0; t < 2000; t++) long.push({ seq: long.length, type: 'turn/start' }, { seq: long.length + 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `question ${t}` }] } }, say(long.length + 2, `answer ${t} `.repeat(20)));
let reads = 0;
const counted = new Proxy(long, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
predictTranscript(counted);
assert.ok(reads < 400, `predictTranscript read ${reads} of ${long.length} events`);
console.log(`turn work: ${compared} random logs give the old results; prediction reads ${reads} of ${long.length} events`);
