// Assistant chat_read (assistantRead) shows the newest reply (2026-11-15): an automation chat had one user message and
// then many replies on later nights. chatTranscript joins that run of replies into one message, and chat_read with count 1
// kept its start (the replies of 11-06 to 11-08), not its end (the reply of 11-15), so the assistant said "nothing new".
// - A too long reply keeps its end, with "…" at the start, in the same limits.
// - A too long user message keeps its start (the task).
// - The Markdown export (chatTranscript) does not change: it keeps the whole run, oldest first.
// - The open question stays the last item.
import assert from 'node:assert/strict';
import { ASSISTANT_LIMITS, assistantRead, chatTranscript } from '../index.js';

let n = 0;
const ev = (type, data) => ({ seq: n++, type, data });
const um = (text) => ev('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } });
const am = (text) => ev('assistant/message', { message: { content: [{ type: 'text', text }] } });
const turn = (text) => [ev('turn/start', {}), am(text), ev('turn/end', { reason: { kind: 'completed' } })];
const reply = (night) => `NIGHT-${night} report. ${'Nothing new in the audit. '.repeat(190)}`;
const NEWEST = 'NEWEST-REPLY-2026-11-15-0056';

const events = [ev('turn/start', {}), um('Run the nightly audit and tell me what is new.'), ev('turn/end', {}),
  ...turn(reply('11-06')), ...turn(reply('11-07')), ...turn(`${NEWEST} One new finding. ${'Detail line. '.repeat(380)}END-OF-NEWEST`)];
assert.ok(events.filter((e) => e.type === 'assistant/message').every((e) => e.data.message.content[0].text.length > 4900), 'three replies of about 5,000 characters');

// count 1: the joined replies are one message; the newest reply is in it, whole, and the text ends with it.
const read = assistantRead(events, 0, 1);
assert.equal(read.messages.length, 1);
const text = read.messages[0].text;
assert.ok(text.includes(NEWEST), 'chat_read shows the newest reply');
assert.ok(text.endsWith('END-OF-NEWEST'), 'up to its end');
assert.ok(text.startsWith('…'), 'the cut is marked at the start');
assert.equal(text.length, 2 * ASSISTANT_LIMITS.message + 1, 'the same limit as before');
assert.ok(!text.includes('NIGHT-11-06'), 'the oldest reply goes first');
assert.equal(read.more, true);

// count 2: the user message and the newest replies; an older long reply keeps its end too.
const two = assistantRead(events, 0, 2);
assert.deepEqual(two.messages.map((m) => m.role), ['user', 'assistant']);
assert.equal(two.messages[0].text, 'Run the nightly audit and tell me what is new.');
const small = assistantRead(events, 0, 2, { message: 1000, total: 2500 });
assert.ok(small.messages.at(-1).text.endsWith('END-OF-NEWEST'), 'small limits: still the newest end');
assert.ok(small.messages.reduce((s, m) => s + m.text.length, 0) <= 2500 + 2, 'small limits: the total holds');

// A long user message keeps its start (the task text), as before.
n = 0;
const task = assistantRead([um(`TASK-START ${'x'.repeat(5000)} TASK-END`)], 0, 1).messages[0].text;
assert.ok(task.startsWith('TASK-START') && task.endsWith('…'), 'a long user message keeps its start');
assert.equal(task.length, ASSISTANT_LIMITS.message + 1);

// The Markdown export keeps the whole run, oldest first.
const exported = chatTranscript(events);
assert.equal(exported.messages.length, 2);
assert.ok(exported.messages[1].text.startsWith('NIGHT-11-06') && exported.messages[1].text.endsWith('END-OF-NEWEST'), 'the export is not cut');

// An open question stays the last item, after the newest reply.
const asked = [...events, ev('turn/start', {}), ev('tool/call', { name: 'ask_user_question', callId: 'q1', arguments: JSON.stringify({ questions: [{ id: 'a', question: 'Deploy now?' }] }) })];
const withAsk = assistantRead(asked, 0, 1);
assert.match(withAsk.messages.at(-1).text, /^\[question\] Deploy now\?/);
assert.ok(withAsk.messages[0].text.endsWith('END-OF-NEWEST'));
console.log('chat-read-newest: ok');
