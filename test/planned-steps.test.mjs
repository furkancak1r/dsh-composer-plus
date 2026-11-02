// Planned steps (Host half): the plan is checked; exactly one ready step answers the agent's next model request without
// the model (reasoning only when the plan message had it, text, the step's tool call); a failed guard, two ready steps,
// the last step, a user message, steer, Continue, /compact, a rollback marker, a foreign or reused step id, a request
// without the tool or with a purpose all go to the model. The switch is off by default and removes the tool, the section
// and the listener.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANNED_PATH, PLANNED_TOOL, installPlannedSteps, nextPlannedStep, parsePlan, plannedStepChunks, plannedStream } from '../index.js';

// Request messages as dsh builds them (role, content blocks, source; tool results carry toolCallId).
const sys = { role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } };
const user = (text, kind = 'user') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind } });
const ctxMsg = user('<runtime context>', 'runtime-context');
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) });
const model = (blocks, reasoning = true) => ({ role: 'assistant', content: [...(reasoning ? [{ type: 'reasoning', text: 'think' }] : []), ...blocks], source: { kind: 'model', provider: 'p', model: 'm' } });
const result = (id, text, isError = false) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text }], isError, source: { kind: 'tool', callId: id } });
const PLAN = { steps: [
  { id: 'test', after: 'root', when: 'ok', tool: 'bash', arguments: { command: 'npm test', description: 'Run the tests' } },
  { id: 'lint', after: 'test', when: 'always', tool: 'bash', arguments: { command: 'npm run lint' } },
] };
const TOOLS = new Set(['bash', 'read', 'grep', 'glob', PLANNED_TOOL]);
const planned = (plan = PLAN, reasoning = true) => [sys, user('Build and test'), ctxMsg,
  model([call('call_1', 'bash', { command: 'npm run build', description: 'Build' }), call('call_2', PLANNED_TOOL, plan)], reasoning),
  result('call_1', 'built\n'), result('call_2', 'Plan accepted')];
/** The assistant message that Composer Plus writes for `found`, as dsh would store it (blocks from the chunks). */
const stored = (found) => {
  const blocks = plannedStepChunks(found).filter((c) => c.type === 'block-end').map((c) => c.block);
  return { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' } };
};

// parsePlan: good plans and every refusal.
const steps = parsePlan(PLAN);
assert.deepEqual(steps.map((s) => [s.id, s.after, s.when, s.tool]), [['test', 'root', 'ok', 'bash'], ['lint', 'test', 'always', 'bash']]);
assert.equal(steps[1].args.description, 'Planned step lint', 'bash gets a description (dsh needs one)');
assert.deepEqual(parsePlan({ steps: [{ id: 'a', tool: 'read', arguments: { file_path: 'x' } }] }).map((s) => [s.after, s.when]), [['root', 'ok']], 'defaults');
for (const [bad, why] of [
  [undefined, /list of steps/], [{ steps: [] }, /1 to 8/], [{ steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, tool: 'read', arguments: {} })) }, /1 to 8/],
  [{ steps: [{ id: 'A', tool: 'read', arguments: {} }] }, /"id"/], [{ steps: [{ id: 'root', tool: 'read', arguments: {} }] }, /"id"/],
  [{ steps: [{ id: 'a', tool: 'read', arguments: {} }, { id: 'a', tool: 'read', arguments: {} }] }, /used twice/],
  [{ steps: [{ id: 'a', after: 'b', tool: 'read', arguments: {} }, { id: 'b', tool: 'read', arguments: {} }] }, /earlier step/],
  [{ steps: [{ id: 'a', when: 'maybe', tool: 'read', arguments: {} }] }, /"when"/],
  [{ steps: [{ id: 'a', tool: 'write', arguments: {} }] }, /"tool"/],
  [{ steps: [{ id: 'a', tool: 'read', arguments: 'x' }] }, /"arguments"/],
  [{ steps: [{ id: 'a', tool: 'bash', arguments: { command: 'x', run_in_background: true } }] }, /foreground/],
  [{ steps: [{ id: 'a', tool: 'read', arguments: { file_path: 'x'.repeat(9000) } }] }, /longer than/],
]) assert.throws(() => parsePlan(bad), why, JSON.stringify(bad)?.slice(0, 80));

// One ready step: the first step after the root calls passed.
let msgs = planned();
let found = nextPlannedStep(msgs, TOOLS);
assert.equal(found?.step.id, 'test'); assert.equal(found.n, 1); assert.equal(found.reasoning, true);
const chunks = plannedStepChunks(found);
assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'block-end', 'block-start', 'tool-call-delta', 'block-end', 'finish']);
const tc = chunks.find((c) => c.type === 'tool-call-delta');
assert.match(tc.id, /^cpgs-[0-9a-f]{8}-1$/); assert.equal(tc.name, 'bash'); assert.deepEqual(JSON.parse(tc.argumentsDelta), { command: 'npm test', description: 'Run the tests' });
assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
assert.match(chunks.find((c) => c.type === 'text-delta').text, /^Composer Plus · Planned steps: ran `test` \(after `root`, guard ok\) without a model call\.$/);
// No reasoning block when the plan message had none (a model without thinking).
assert.deepEqual(plannedStepChunks(nextPlannedStep(planned(PLAN, false), TOOLS)).map((c) => c.type).slice(0, 3), ['block-start', 'text-delta', 'block-end']);

// Chain: test ran (passed) → lint (always) is next; then the plan is over.
const s1 = stored(found); const id1 = s1.content.at(-1).id;
msgs = [...planned(), s1, result(id1, 'ok 1\n')];
found = nextPlannedStep(msgs, TOOLS); assert.equal(found?.step.id, 'lint'); assert.equal(found.n, 2);
const s2 = stored(found); const id2 = s2.content.at(-1).id;
assert.equal(nextPlannedStep([...msgs, s2, result(id2, 'clean\n')], TOOLS), undefined, 'after the last step the model answers');
// A failed test: lint still runs (always), a step after test with "ok" would not.
assert.equal(nextPlannedStep([...planned(), s1, result(id1, 'not ok\n[exit code: 1]')], TOOLS)?.step.id, 'lint', '"always" runs after a failed step');
const okAfterTest = { steps: [PLAN.steps[0], { ...PLAN.steps[1], when: 'ok' }] };
const fs1 = stored(nextPlannedStep(planned(okAfterTest), TOOLS));
assert.equal(nextPlannedStep([...planned(okAfterTest), fs1, result(fs1.content.at(-1).id, 'not ok\n[exit code: 1]')], TOOLS), undefined, 'a failed guard gives the turn back');
assert.equal(nextPlannedStep([...planned(okAfterTest), fs1, result(fs1.content.at(-1).id, 'boom', true)], TOOLS), undefined, 'an error result fails "ok"');
for (const mark of ['[timed out after 120s]', '[sandbox: file access denied under read-only mode]', '[still running after 60000ms; moved to background job x]']) {
  assert.equal(nextPlannedStep([...planned(okAfterTest), fs1, result(fs1.content.at(-1).id, `out\n${mark}`)], TOOLS), undefined, mark);
}

// Root failed: an "ok" step does not run.
const rootFailed = planned(); rootFailed[4] = result('call_1', 'error TS2304\n[exit code: 2]');
assert.equal(nextPlannedStep(rootFailed, TOOLS), undefined, 'a failed build stops the "ok" step');
// The plan call alone in its message: root = the plan call.
const alone = [sys, user('go'), ctxMsg, model([call('p1', PLANNED_TOOL, { steps: [{ id: 'ls', tool: 'glob', arguments: { pattern: '*.md' } }] })]), result('p1', 'Plan accepted')];
assert.equal(nextPlannedStep(alone, TOOLS)?.step.id, 'ls');
// A refused plan (the tool answered an error) runs nothing.
assert.equal(nextPlannedStep([...alone.slice(0, 4), result('p1', 'Error: bad', true)], TOOLS), undefined);
// Two ready steps: the model chooses.
const two = { steps: [{ id: 'a', tool: 'read', arguments: { file_path: 'a' } }, { id: 'b', tool: 'read', arguments: { file_path: 'b' } }] };
assert.equal(nextPlannedStep(planned(two), TOOLS), undefined, 'two ready steps: the model answers');
// A root result is missing (still running): nothing, also when the plan's own result is there.
assert.equal(nextPlannedStep(planned().slice(0, 5), TOOLS), undefined);
const twoRoots = [sys, user('go'), ctxMsg, model([call('r1', 'bash', { command: 'a', description: 'a' }), call('r2', 'bash', { command: 'b', description: 'b' }), call('p2', PLANNED_TOOL, PLAN)]), result('r1', 'ok'), result('p2', 'Plan accepted')];
assert.equal(nextPlannedStep(twoRoots, TOOLS), undefined, 'one root call has no result yet');
assert.equal(nextPlannedStep([...twoRoots, result('r2', 'ok')], TOOLS)?.step.id, 'test', 'all root calls done');
const alwaysPlan = { steps: [{ ...PLAN.steps[0], when: 'always' }] };
const twoRootsAlways = twoRoots.map((m) => (m.role === 'assistant' ? model([call('r1', 'bash', { command: 'a', description: 'a' }), call('r2', 'bash', { command: 'b', description: 'b' }), call('p2', PLANNED_TOOL, alwaysPlan)]) : m));
assert.equal(nextPlannedStep(twoRootsAlways, TOOLS), undefined, '"always" also waits for every root call');
// A step tool that the request does not offer: nothing.
assert.equal(nextPlannedStep(planned(), new Set([PLANNED_TOOL, 'read'])), undefined, 'bash not offered');

// Neutral messages between: runtime context, developer (tool registry) and system messages do not end the plan.
const dev = { role: 'developer', content: [{ type: 'tool-addition', toolName: 'x' }], source: { kind: 'tool-registry' } };
assert.equal(nextPlannedStep([...planned(), ctxMsg, dev, sys], TOOLS)?.step.id, 'test', 'neutral messages');
// Every other user message ends the plan: the user, steer, Continue, /compact, a rollback marker.
for (const kind of ['user', 'steer', 'composer-plus-resume', 'compact-checkpoint', 'composer-plus-rollback', 'dsh-rewind', 'goal-round']) {
  assert.equal(nextPlannedStep([...planned(), user('more', kind)], TOOLS), undefined, `${kind} ends the plan`);
}
// The model answered after the plan (a real assistant message): the plan is over.
assert.equal(nextPlannedStep([...planned(), model([{ type: 'text', text: 'Done.' }])], TOOLS), undefined);
const afterModel = [...planned(), model([call('call_9', 'read', { file_path: 'x' })]), result('call_9', 'x')];
assert.equal(nextPlannedStep(afterModel, TOOLS), undefined, 'a newer model message without a plan');
// A step message of another plan (wrong tag), a reused step, or a step number that the plan does not have: nothing.
const wrongTag = { ...s1, content: s1.content.map((b) => (b.type === 'tool-call' ? { ...b, id: 'cpgs-00000000-1' } : b)) };
assert.equal(nextPlannedStep([...planned(), wrongTag, result('cpgs-00000000-1', 'ok')], TOOLS), undefined, 'a step of another plan');
assert.equal(nextPlannedStep([...planned(), s1, result(id1, 'ok'), s1, result(id1, 'ok')], TOOLS), undefined, 'the same step twice');
const tag = id1.split('-')[1];
const ghost = { ...s1, content: s1.content.map((b) => (b.type === 'tool-call' ? { ...b, id: `cpgs-${tag}-9` } : b)) };
assert.equal(nextPlannedStep([...planned(), ghost, result(`cpgs-${tag}-9`, 'ok')], TOOLS), undefined, 'a step number outside the plan');
// A fork starts with the parent's events; the fork's own first message ends the inherited plan.
assert.equal(nextPlannedStep([...planned(), user('In this branch, try something else')], TOOLS), undefined, 'fork: its own message');
// Bad input never throws.
for (const bad of [undefined, null, [], [null], [{ role: 'assistant' }], [{ role: 'assistant', content: 'x' }]]) assert.equal(nextPlannedStep(bad, TOOLS), undefined);
const badArgs = planned(); badArgs[3] = model([call('call_1', 'bash', { command: 'x' }), { type: 'tool-call', id: 'call_2', name: PLANNED_TOOL, arguments: '{not json' }]);
assert.equal(nextPlannedStep(badArgs, TOOLS), undefined, 'arguments that are not JSON');

// The listener: one ready step → chunks (no next()); otherwise next() and its stream.
const nextStream = () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })();
const opts = (messages, extra = {}) => ({ sessionId: 's1', provider: 'p', model: 'm', messages, tools: [...TOOLS].map((name) => ({ name })), ...extra });
const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out; };
let nexts = 0;
const counted = () => { nexts++; return nextStream(); };
assert.equal((await collect(plannedStream(opts(planned()), counted))).filter((c) => c.type === 'tool-call-delta').length, 1); assert.equal(nexts, 0, 'no model call');
await collect(plannedStream(opts(planned(), { purpose: 'compaction' }), counted)); assert.equal(nexts, 1, 'compaction goes to the model');
await collect(plannedStream(opts(planned(), { sessionId: undefined }), counted)); assert.equal(nexts, 2, 'no chat: the model');
await collect(plannedStream(opts(planned(), { tools: [{ name: 'bash' }] }), counted)); assert.equal(nexts, 3, 'the plan tool is not offered (switch off in this chat)');
await collect(plannedStream(opts([...planned(), user('stop')]), counted)); assert.equal(nexts, 4, 'a user message: the model');
await collect(plannedStream({ get messages() { throw Error('boom'); }, sessionId: 's', tools: [{ name: PLANNED_TOOL }] }, counted)); assert.equal(nexts, 5, 'a throwing request goes to the model');

// The switch: off by default; on registers the tool, the section and the listener; off removes all three.
const root = await mkdtemp(join(tmpdir(), 'cp-planned-'));
try {
  const routes = new Map(); const live = { tools: new Map(), sections: new Map(), on: new Map() }; const effects = [];
  let disposed = 0;
  const ctx = {
    effect: (fn) => effects.push(fn()),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    inject: (deps, setup) => {
      assert.deepEqual(deps, ['tools', 'systemPrompt']);
      const offs = [];
      setup({ tools: { register: (t) => { live.tools.set(t.name, t); offs.push(() => live.tools.delete(t.name)); } },
        systemPrompt: { section: (s) => { live.sections.set(s.name, s); offs.push(() => live.sections.delete(s.name)); } },
        on: (name, fn) => { live.on.set(name, fn); offs.push(() => live.on.delete(name)); } });
      return { dispose: () => { disposed++; offs.forEach((f) => f()); } };
    },
  };
  const home = join(root, 'home');
  const host = installPlannedSteps(ctx, home);
  await host.ready;
  const req = async (body) => { const r = await routes.get(PLANNED_PATH).fetch(new Request(`http://h${PLANNED_PATH}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  assert.deepEqual((await req()).body, { on: false }, 'off by default');
  assert.equal(live.tools.size + live.sections.size + live.on.size, 0, 'off: nothing registered');
  for (const bad of [{ on: 'yes' }, { on: true, x: 1 }, {}, []]) assert.equal((await req(bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await req({ on: true })).body, { on: true });
  assert.deepEqual(JSON.parse(await readFile(join(home, 'storages', 'dsh-composer-plus', 'planned-steps.json'), 'utf8')), { on: true });
  assert.ok(live.tools.has(PLANNED_TOOL) && live.sections.has('composer-plus:planned-steps') && live.on.get('llm/stream') === plannedStream);
  assert.match(live.sections.get('composer-plus:planned-steps').text(), /plan_next_steps/);
  // The tool: a good plan answers "Plan accepted"; a bad plan throws (dsh shows the error to the model).
  assert.match(await live.tools.get(PLANNED_TOOL).execute(PLAN), /^Plan accepted: test \(bash, after root, when ok\); lint/);
  await assert.rejects(live.tools.get(PLANNED_TOOL).execute({ steps: [{ id: 'a', tool: 'write', arguments: {} }] }), /"tool"/);
  // Two clicks in a row end on the newest one.
  await Promise.all([req({ on: false }), req({ on: true }), req({ on: false })]);
  assert.deepEqual((await req()).body, { on: false });
  assert.equal(live.tools.size + live.sections.size + live.on.size, 0, 'off removes the tool, the section and the listener');
  assert.ok(disposed >= 1);
  // A restart reads the saved switch.
  await req({ on: true });
  const again = installPlannedSteps({ ...ctx, connection: { fetch: { register: () => {} } } }, home);
  await again.ready; assert.ok(live.tools.has(PLANNED_TOOL), 'the saved "on" comes back after a restart');
  // Plugin unload disposes the fiber.
  const before = disposed; effects.forEach((f) => typeof f === 'function' && f()); assert.ok(disposed > before, 'unload disposes');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('planned steps checks passed');
