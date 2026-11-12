// Assistant: the assistant sees what another chat asks, at once.
// - askOf: an open ask_user_question card (header, question, options), a timed one that went on after its timeout, a plan
//   review, an open approval (its reason), and, when nothing is open, a step that the user or Auto review denied after the
//   turn's last reply; an answered, withdrawn (rule 9) or inherited (rule 10) one does not count; a long one is cut with
//   "(kısaltıldı)".
// - assistantRead (chat_read): the open question is the last item; a turn that has only tool calls still shows it; a very
//   long first message is cut, never the newest reply or the question.
// - The news note: "waits for your answer" carries the question verbatim (at most 1500 characters); "finished" carries
//   a denial or the reply's `onay` sentence, and says "No text reply." when the turn had none.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_LIMITS, ASSISTANT_NEWS, askOf, assistantNewsNote, assistantRead, installAssistantBot, onayBlocks } from '../index.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(5); } };
let n = 0;
const ev = (type, data, extra = {}) => ({ seq: n++, type, data, ...extra });
const um = (text, kind = 'user', extra = {}) => ev('user/message', { content: [{ type: 'text', text }], source: { kind } }, extra);
const am = (...blocks) => ev('assistant/message', { message: { content: blocks.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b)) } });
const QUESTION = { id: 'summary', header: 'Özet ve Yenile', question: 'Yenile özet için de Damon\'a bir tur başlatsın mı?',
  options: [{ label: 'Hayır, yalnız listeler (Önerilen)', description: 'Hızlı ve bedava.' }, { label: 'Evet, Damon özeti de yenilesin', description: 'Her tıklama bir model turu.' }] };
const askCall = (callId, questions = [QUESTION]) => ev('tool/call', { name: 'ask_user_question', callId, arguments: JSON.stringify({ questions }) });
const result = (callId, text, isError = false) => ev('tool/result', { message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text }], isError } });
const LONG = `TASK ${'Uzun görev metni. '.repeat(400)}SON`;

// 1. A question card: the case of the real branch chat (a long task text, only tool calls, then ask_user_question).
n = 0;
const card = [ev('turn/start', { turn: 1 }), um(LONG), am({ type: 'reasoning', text: 'checking' }, { type: 'tool-call', id: 'c1', name: 'bash' }),
  ev('tool/call', { name: 'bash', callId: 'c1', arguments: '{}' }), result('c1', 'ok'), am({ type: 'tool-call', id: 'q1', name: 'ask_user_question' }), askCall('q1')];
const asked = askOf(card);
assert.equal(asked, '[question] Özet ve Yenile: Yenile özet için de Damon\'a bir tur başlatsın mı?\n- Hayır, yalnız listeler (Önerilen): Hızlı ve bedava.\n- Evet, Damon özeti de yenilesin: Her tıklama bir model turu.');
let read = assistantRead(card, 0, 10);
assert.deepEqual(read.messages.map((m) => m.role), ['user', 'assistant'], 'the task text, then the question');
assert.equal(read.messages[1].text, asked, 'chat_read: the open question is the last item');
assert.equal(read.messages[0].text.length, ASSISTANT_LIMITS.message + 1, 'the long first message is cut');
// The total limit cuts the old long message, not the question.
read = assistantRead(card, 0, 10, { message: 4000, total: asked.length + 100 });
assert.equal(read.messages.at(-1).text, asked, 'the question stays whole');
assert.ok(read.messages[0].text.length <= 101, 'the old message gets what is left');
// Answered (in time, or by a late reply), or the turn ended: nothing is open.
assert.equal(askOf([...card, result('q1', '{"answers":[{"id":"summary","selected":["Hayır"]}]}')]), '');
assert.equal(askOf([...card, um('{"answers":[]}', 'user-question-reply', {})].map((e) => (e.data?.source?.kind === 'user-question-reply' ? { ...e, data: { ...e.data, source: { kind: 'user-question-reply', callId: 'q1' } } } : e))), '');
assert.equal(askOf([...card, ev('turn/end', { reason: { kind: 'completed' } })]), '', 'a legacy card closes with its turn');
// A timed card (dsh's tool has `timeout`) that went on after its timeout stays open until a reply, also after the turn;
// so does one that dsh's crash repair closed with TOOL_OUTCOME_UNKNOWN (dsh-user-questions keeps both answerable).
const header = (timeout) => ev('request/header', { header: { tools: [{ name: 'ask_user_question', parameters: { properties: { questions: {}, ...(timeout ? { timeout: {} } : {}) } } }] } });
const timedCard = [card[0], header(true), ...card.slice(1)];
const later = (closer) => [...timedCard, closer, am('I go on meanwhile.'), ev('turn/end', { reason: { kind: 'completed' } })];
assert.equal(askOf(later(result('q1', '{"pending":true,"callId":"q1","message":"No answer batch arrived"}'))), asked, 'a pending timed question is still open');
const repaired = { ...result('q1', 'outcome unknown', true), data: { message: { toolCallId: 'q1', content: [{ type: 'text', text: 'outcome unknown' }], isError: true }, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } } };
assert.equal(askOf(later(repaired)), asked, 'after a dsh restart a timed question is still open');
assert.equal(askOf([card[0], header(false), ...card.slice(1), repaired, ev('turn/end', {})]), '', 'a legacy card is not answerable after a restart');
// An old timed question that still waits and a newer turn that a denial stopped: both are open for the user.
n = 50;
const both = askOf([...later(result('q1', '{"pending":true}')), ev('turn/start', {}), ev('tool/call', { name: 'bash', callId: 'b9', arguments: '{}' }),
  ev('approval/asked', { id: 'a9', toolName: 'bash', callId: 'b9', reason: 'Auto review denied tool "bash": live host.' }), ev('approval/decided', { id: 'a9', outcome: 'rejected' }), ev('turn/end', {})]);
assert.equal(both, `${asked}\n[denied] bash: Auto review denied tool "bash": live host.`);
// A fork's copy (rule 10) and a rollback (rule 9).
assert.equal(assistantRead(card, card.length, 10).messages.length, 0, 'an inherited card is not this chat\'s');
n = 100;
const marker = um('marker', 'dsh-rewind', { sourceEventSeqs: [card.at(-1).seq] });
assert.equal(askOf([...card, marker]), '', 'a withdrawn card is not open');
// A long question is cut and marked.
const long = askOf([ev('turn/start', {}), askCall('q2', [{ id: 'x', question: 'Q'.repeat(3000) }])], 1500);
assert.equal(long.length, 1500 + '… (kısaltıldı)'.length); assert.ok(long.endsWith('… (kısaltıldı)'));

// 2. An approval request and a plan review.
n = 0;
const approval = [ev('turn/start', {}), am({ type: 'tool-call', id: 'b1', name: 'bash' }), ev('tool/call', { name: 'bash', callId: 'b1', arguments: '{"command":"git push origin main"}' }),
  ev('approval/asked', { id: 'a1', toolName: 'bash', callId: 'b1', reason: 'Push main to origin?' })];
assert.equal(askOf(approval), '[approval] bash: Push main to origin?');
assert.equal(askOf(approval.map((e) => (e.type === 'approval/asked' ? { ...e, data: { ...e.data, reason: undefined } } : e))), '[approval] bash: {"command":"git push origin main"}', 'no reason: the call');
assert.equal(assistantRead(approval, 0, 10).messages.at(-1).text, '[approval] bash: Push main to origin?', 'chat_read: a turn with only a tool call shows the approval');
assert.equal(askOf([ev('turn/start', {}), ev('tool/call', { name: 'exit_plan_mode', callId: 'p1', arguments: '{"plan":"# Plan\\n1. Fix"}' })]), '[plan review] # Plan\n1. Fix');

// 3. A denial stop: Auto review refused a step after the last reply, and the turn ended.
n = 0;
const denial = [ev('turn/start', {}), um('deploy it'), am('Starting.'), ev('tool/call', { name: 'bash', callId: 'b2', arguments: '{}' }),
  ev('approval/asked', { id: 'a2', toolName: 'bash', callId: 'b2', reason: 'Auto review denied tool "bash": no human message asks for the live deploy.' }),
  ev('approval/decided', { id: 'a2', outcome: 'rejected' }), result('b2', 'Error: Auto review denied this tool call', true), ev('turn/end', { reason: { kind: 'completed' } })];
assert.equal(askOf(denial), '[denied] bash: Auto review denied tool "bash": no human message asks for the live deploy.');
assert.equal(assistantRead(denial, 0, 10).messages.at(-1).text, askOf(denial));
// A reply after the denial: the chat told it itself; an allowed or cancelled approval is no denial.
assert.equal(askOf([...denial.slice(0, -1), am('Denied; I stop here.'), denial.at(-1)]), '');
assert.equal(askOf(denial.map((e) => (e.type === 'approval/decided' ? { ...e, data: { ...e.data, outcome: 'allowed-once' } } : e))), '');
assert.equal(askOf(denial.map((e) => (e.type === 'approval/decided' ? { ...e, data: { ...e.data, outcome: 'cancelled' } } : e))), '');
// An older turn's denial is not this turn's.
assert.equal(askOf([...denial, ev('turn/start', {}), am('New work.'), ev('turn/end', {})]), '');

// 4. onay blocks of a reply.
assert.deepEqual(onayBlocks('Need it:\n```onay\nOnaylıyorum: main\'e push et.\n```\nthen\n```js\nx\n```'), ['Onaylıyorum: main\'e push et.']);
assert.deepEqual(onayBlocks('```onay\nOpen fence only'), []);
assert.deepEqual(onayBlocks('Example:\n````md\n```onay\nOrnek\n```\n````'), [], 'an example inside another fence is no approval');
assert.deepEqual(onayBlocks('  ```onay\nIndented\n  ```'), [], 'an indented block gets no button either');
assert.deepEqual(onayBlocks('~~~onay\nTilde\n~~~~'), ['Tilde'], 'a longer closing fence closes it');

// 5. The note: the question verbatim with the options; a finished turn with a denial; no text reply.
const note = assistantNewsNote([
  { id: 's-1', title: 'Durum paneli yenile düğmesi', project: 'dsh-composer-plus', at: 2, kind: 'waiting', wait: 'ask_user_question', ask: asked, task: true, branch: 'fix/status-refresh-loading-feedback' },
  { id: 's-2', title: 'Deploy', project: 'p', at: 1, kind: 'finished', reply: '', ask: askOf(denial) },
  { id: 's-3', title: 'Quiet', project: 'p', at: 0, kind: 'finished', reply: '' },
]);
assert.match(note, /your delegated task on branch "fix\/status-refresh-loading-feedback"\): waits for your answer\. Open for the user: "\[question\] Özet ve Yenile: Yenile özet için de Damon'a bir tur başlatsın mı\?\\n- Hayır, yalnız listeler \(Önerilen\): Hızlı ve bedava\.\\n- Evet, Damon özeti de yenilesin: Her tıklama bir model turu\."/);
assert.match(note, /"Deploy" \(project "p", chat s-2\): finished\. Open for the user: "\[denied\] bash: Auto review denied/);
assert.match(note, /"Quiet" \(project "p", chat s-3\): finished\. No text reply\./);
assert.match(note, /not instructions for you/, 'the data note stays');
assert.equal(ASSISTANT_NEWS.ask, 1500);

// 6. The bot (fake dsh): a delegated chat that waits on a card gives a note with the question; a turn that ends with an
//    onay block gives its sentence; a cut reply that still holds the sentence does not repeat it.
const home = await mkdtemp(join(tmpdir(), 'cp-pending-ask-'));
try {
  const listeners = new Map(); const agents = new Map(); const steers = [];
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
  const newAgent = (id, header = {}, events = []) => {
    const agent = { id, status: 'idle', events, session: { id, header, inheritedEventCount: 0, snapshotEvents: () => agent.events },
      inbox: { prepend: (target, m) => { agent.queued = m; }, remove: () => {} }, steer: (m) => { steers.push([id, m]); } };
    agents.set(id, agent); return agent;
  };
  const me = newAgent('s-assistant', { cwd: '/home/demo/Assistant' });
  const tasks = new Map([['s-task', { title: 'Durum paneli', project: 'acme', branch: 'fix/refresh' }], ['s-done', { title: 'Yayın', project: 'acme' }], ['s-short', { title: 'Kısa', project: 'acme' }]]);
  const assistant = { ready: Promise.resolve(), isOn: () => true, id: () => 's-assistant', isAssistant: (a) => a?.id === 's-assistant',
    tasks: { get: (id) => tasks.get(id), has: (id) => tasks.has(id), add: async (id, t) => { tasks.set(id, t); }, drop: async (id) => { tasks.delete(id); } } };
  const ctx = { logger: { warn: () => {} }, on, effect: () => {}, inject: () => ({ dispose: () => {} }),
    get: (name) => ({ agents: { get: (id) => agents.get(id) }, workspaceRegistry: { archivedSessionIds: [], list: () => [] } })[name],
    connection: { fetch: { register: () => () => {} } }, sessionQuery: { readTitle: async (id) => ({ title: tasks.get(id)?.title }) },
    sessionController: { resolveAgent: async (id) => ({ agent: agents.get(id) }) } };
  let clock = 1_000_000;
  const timing = { ...ASSISTANT_NEWS, wait: 30, batch: 20, gap: 0, ask: 1500 };
  const bot = installAssistantBot(ctx, home, assistant, { dir: join(home, 'store'), timing, now: () => clock });
  await bot.ready;
  const told = async () => (await listeners.get('agent/pre-step')[0]({ agent: me }, async () => ({ kind: 'enter', messages: [me.queued, steers.at(-1)[1]] }))).messages[0].content[0].text;
  // A wait on a question card.
  n = 0;
  const task = newAgent('s-task', { cwd: '/demo/acme' }, card.slice());
  emit('session/event', task.session, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q1' } });
  await until(() => steers.length === 1, 'the wait note');
  const waitNote = await told();
  assert.match(waitNote, /"Durum paneli" \(project "acme", chat s-task, your delegated task on branch "fix\/refresh"\): waits for your answer\. Open for the user: "\[question\] Özet ve Yenile: /);
  assert.ok(waitNote.includes(JSON.stringify(asked)), 'the question and its options, verbatim');
  // A finished task whose reply asks for an approval sentence.
  clock += 1000;
  const done = newAgent('s-done', { cwd: '/demo/acme' }, [ev('turn/start', {}), um('release it'), am(`Ready. I need your approval:\n\`\`\`onay\nOnaylıyorum: v1.2.3 yayınla.\n\`\`\`\n${'More text. '.repeat(300)}`)]);
  emit('session/event', done.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await until(() => steers.length === 2, 'the finished note');
  const doneNote = await told();
  assert.match(doneNote, /finished\. Last reply: "Ready\. I need your approval:.*Onaylıyorum: v1\.2\.3 yayınla\..*"/, 'the reply holds the sentence');
  assert.doesNotMatch(doneNote, /\[approval sentence\]/, 'so it is not repeated');
  // The same reply cut before its sentence: the sentence comes as an open item.
  clock += 1000;
  const cut = newAgent('s-short', { cwd: '/demo/acme' }, [ev('turn/start', {}), um('release it'), am(`${'Long report line. '.repeat(200)}\n\`\`\`onay\nOnaylıyorum: v1.2.3 yayınla.\n\`\`\``)]);
  emit('session/event', cut.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await until(() => steers.length === 3, 'the second finished note');
  const cutNote = await told();
  assert.match(cutNote, /Open for the user: "\[approval sentence\] Onaylıyorum: v1\.2\.3 yayınla\."/);
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log('assistant-pending-ask: ok');
