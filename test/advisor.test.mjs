// Advisor model (Host half, issue #8). Off by default; with a chosen model the tool `advisor` is registered and makes one
// tool-free model call that reads the chat as text (system prompt start, tool names, transcript without withdrawn steps,
// oldest part cut first, secret lines left out) and answers with the model, the tokens and the advice. Limits: uses per
// chat (a fork does not count its parent's), one call at a time. Subagents (unless allowed) and chats switched off get the
// tool restricted away and refused. Switch off or unload removes the tool.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADVISOR_PATH, ADVISOR_SYSTEM, ADVISOR_TOOL, advisorCalls, advisorInput, adviceText, askAdvisor, installAdvisor } from '../index.js';

let seq = 0;
const ev = (type, data, extra = {}) => ({ seq: ++seq, type, time: seq, data, ...extra });
const user = (text) => ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
const reply = (text) => ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (callId, name = ADVISOR_TOOL, args = {}) => ev('tool/call', { callId, name, arguments: args });
const result = (callId, text, isError = false) => ev('tool/result', { message: { role: 'tool', content: [{ type: 'text', text }], isError, source: { kind: 'tool', callId } } });
const system = (text) => ev('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text }] } });
const header = (tools) => ev('request/header', { header: { config: { provider: 'cheap', model: 'flash' }, tools: tools.map((name) => ({ name })) } });

// The text: prompt start, tool names, transcript; withdrawn steps out for both marker kinds; /compact keeps its messages.
for (const kind of ['composer-plus-rollback', 'dsh-rewind']) {
  const start = [system('You are the agent. Rules: be careful.'), header(['bash', 'read', ADVISOR_TOOL]), user('Fix the login bug')];
  const a = user('withdrawn question'); const b = reply('withdrawn answer');
  const events = [...start, a, b,
    ev('user/message', { source: { kind }, content: [] }, { sourceEventSeqs: [a.seq, b.seq] }),
    ev('user/message', { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }] }, { sourceEventSeqs: [a.seq - 1] }),
    call('c1', 'bash', '{"command":"npm test"}'), result('c1', 'not ok 1 - login'), call('c2')];
  const text = advisorInput(events);
  assert.match(text, /^The agent's system prompt \(start\):\nYou are the agent\. Rules: be careful\./);
  assert.match(text, /The agent's tools: bash, read, advisor/);
  assert.match(text, /User: Fix the login bug/); assert.match(text, /Tool call bash: \{"command":"npm test"\}/); assert.match(text, /Tool result: not ok 1 - login/);
  assert.ok(!text.includes('withdrawn'), `${kind}: a withdrawn step is left out`);
  assert.match(text, /called the advisor tool at the end of this chat/);
}
// Size cap: the oldest part goes first and the text says so; secret-looking lines are left out and counted.
{
  const events = [user('FIRST message'), ...Array.from({ length: 60 }, (_, i) => reply(`step ${i} ${'x'.repeat(400)}`)), user('API_KEY=sk-abcdefghijklmnop1234567890'), user('LAST message')];
  const text = advisorInput(events, 8000);
  assert.ok(text.length <= 8000 + 200, `capped (${text.length})`);
  assert.ok(!text.includes('FIRST message') && text.includes('LAST message'), 'the newest part stays');
  assert.match(text, /\[the earlier part of the chat is left out\]/);
  assert.ok(!text.includes('sk-abcdefghijklmnop'), 'no secret'); assert.match(text, /1 line\(s\) that looked like a secret were left out/);
}
// Uses: successful advisor results only; a fork's inherited ones do not count.
{
  const events = [call('a1'), result('a1', 'advice'), call('a2'), result('a2', 'failed', true), call('b1', 'bash'), result('b1', 'ok'), call('a3'), result('a3', 'advice')];
  assert.deepEqual([...advisorCalls(events)], ['a1', 'a3']);
  assert.deepEqual([...advisorCalls(events, 2)], ['a3'], 'from the fork offset');
}
assert.equal(adviceText({ model: 'opus', inputTokens: 10, outputTokens: 5, use: 1, maxUses: 3, advice: 'Do X.' }),
  'Advice from opus (10 input tokens, 5 output tokens; use 1 of 3 in this chat):\n\nDo X.');

// A fake dsh llm: counts calls, records the request, streams text and usage.
const fakeLlm = (opts = {}) => {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'strong', name: 'Strong' }, { id: 'cheap', name: 'Cheap' }],
    listModels: async (p) => (p === 'strong' ? [{ id: 'opus', name: 'Opus' }] : [{ id: 'flash', name: 'Flash' }]),
    resolveModelInfo: async () => ({ defaultMaxTokens: opts.defaultMax ?? 8000, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
    prepareCall: async (config, signal) => ({ config, stream: (request) => {
      calls.push({ config, request });
      return (async function* () {
        if (opts.gate) await opts.gate;
        yield { type: 'text-delta', text: opts.text ?? '<think>hidden</think>Try the token refresh first.' };
        yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 30 } };
        yield { type: 'finish', reason: { kind: opts.finish ?? 'stop' } };
      })();
    } }),
  };
};
// askAdvisor: no tools in the request, the system prompt, the answer cap ≤ the model default, a listed effort only.
{
  const llm = fakeLlm({ defaultMax: 2000 });
  const r = await askAdvisor({ llm, route: { provider: 'strong', model: 'opus' }, effort: 'high', maxTokens: 16000 }, 'the chat');
  assert.deepEqual(r, { text: 'Try the token refresh first.', inputTokens: 120, outputTokens: 30 });
  assert.equal(llm.calls.length, 1); const { config, request } = llm.calls[0];
  assert.equal(config.maxTokens, 2000, 'never above the model default'); assert.equal(config.reasoningEffort, 'high');
  assert.equal(request.tools, undefined, 'no tools'); assert.equal(request.system, ADVISOR_SYSTEM);
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'the chat' }] }]);
  const other = fakeLlm(); await askAdvisor({ llm: other, route: { provider: 'strong', model: 'opus' }, effort: 'xhigh', maxTokens: 4000 }, 'x');
  assert.equal(other.calls[0].config.reasoningEffort, undefined, 'an effort the model does not list is not sent');
  await assert.rejects(askAdvisor({ llm: fakeLlm({ text: '' }), route: { provider: 'strong', model: 'opus' }, maxTokens: 4000 }, 'x'), /no answer/);
  assert.match((await askAdvisor({ llm: fakeLlm({ finish: 'max-tokens' }), route: { provider: 'strong', model: 'opus' }, maxTokens: 4000 }, 'x')).text, /cut at the token limit/);
}

// installAdvisor: the route, the switch, the tool, the limits, subagents and the per-chat switch.
const root = await mkdtemp(join(tmpdir(), 'cp-advisor-'));
try {
  const routes = new Map(); const live = new Map(); const effects = []; const handlers = new Map();
  const llm = fakeLlm();
  const agents = new Map();
  const restrictions = new Map(); // agent id → Set of denied names
  const agent = (id, { origin, parentSession, events = [], inherited = 0 } = {}) => {
    const a = { id, status: 'idle', session: { id, header: { origin, parentSession }, inheritedEventCount: inherited, snapshotEvents: () => a.events }, events,
      ctx: { tools: { restrict: ({ deny }) => {
        if (!live.has(ADVISOR_TOOL)) throw new Error('unknown global tool');
        restrictions.set(id, new Set(deny)); return () => restrictions.delete(id);
      } } } };
    agents.set(id, a); handlers.get('agent/created')?.({ agent: a }); return a;
  };
  const ctx = {
    get: (name) => ({ llm, agents: { get: (id) => agents.get(id), list: () => [...agents.values()] } })[name],
    effect: (fn) => effects.push(fn()),
    on: (name, fn) => handlers.set(name, fn),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    inject: (deps, setup) => {
      assert.deepEqual(deps, ['tools']);
      setup({ tools: { register: (t) => { live.set(t.name, t); } } });
      return { dispose: () => live.delete(ADVISOR_TOOL) };
    },
  };
  const home = join(root, 'home');
  const host = installAdvisor(ctx, home);
  await host.ready;
  const req = async (body, query = '') => {
    const r = await routes.get(ADVISOR_PATH).fetch(new Request(`http://h${ADVISOR_PATH}${query}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  assert.deepEqual((await req()).body, { on: false, maxUses: 3, maxTokens: 16000, subagents: false }, 'off by default, no model');
  assert.equal(live.size, 0, 'off: no tool');
  for (const bad of [{ on: 'yes' }, { on: true, x: 1 }, {}, [], { maxUses: 0 }, { maxUses: 21 }, { maxTokens: 999 }, { model: { provider: 'x' } }, { effort: '' }, { sessionId: 's', off: 1 }]) {
    assert.equal((await req(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await req({ model: { provider: 'nope', model: 'x' } })).status, 409, 'a model that dsh does not list');
  // On without a model: still no tool (the user must choose the advisor model).
  await req({ on: true });
  assert.equal(live.size, 0, 'on without a model: no tool');
  assert.equal((await req(undefined, '?sessionId=s1')).body.ready, false);
  const catalog = (await req(undefined, '?catalog=1')).body.catalog;
  assert.deepEqual(catalog.groups.map((g) => g.id), ['strong', 'cheap']);
  assert.deepEqual((await req({ model: { provider: 'strong', model: 'opus' } })).body.model, { provider: 'strong', model: 'opus' });
  assert.ok(live.has(ADVISOR_TOOL), 'on + model: the tool');
  assert.deepEqual((await req(undefined, '?efforts=1')).body.efforts, [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]);
  assert.equal((await req({ effort: 'high' })).body.effort, 'high');
  assert.equal((await req({ maxUses: 2 })).body.maxUses, 2);
  assert.equal((await req({ maxTokens: 4000 })).body.maxTokens, 4000);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'storages', 'dsh-composer-plus', 'advisor.json'), 'utf8')),
    { on: true, model: { provider: 'strong', model: 'opus' }, effort: 'high', maxUses: 2, maxTokens: 4000, subagents: false, off: {} });
  const tool = live.get(ADVISOR_TOOL);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} }, 'no parameters');

  // One call per use, in the same turn: the result has the model, the tokens and the advice.
  const chat = agent('s1', { events: [system('Agent prompt'), user('Build the parser'), call('u1')] });
  const out = await tool.execute({}, { agent: chat, callId: 'u1' });
  assert.match(out, /^Advice from opus \(120 input tokens, 30 output tokens; use 1 of 2 in this chat\):\n\nTry the token refresh first\.$/);
  assert.equal(llm.calls.length, 1, 'one model call');
  assert.equal(llm.calls[0].config.maxTokens, 4000); assert.equal(llm.calls[0].config.reasoningEffort, 'high');
  assert.match(llm.calls[0].request.messages[0].content[0].text, /User: Build the parser/);
  // The limit: two uses in the log (one logged, one answered in this run before dsh logs it) → no third call.
  chat.events.push(result('u1', out), call('u2'));
  await tool.execute({}, { agent: chat, callId: 'u2' });
  chat.events.push(call('u3'));
  await assert.rejects(tool.execute({}, { agent: chat, callId: 'u3' }), /limit of this chat is reached \(2 uses\)/);
  assert.equal(llm.calls.length, 2, 'no model call at the limit');
  // A fork does not count its parent's advice.
  chat.events.splice(chat.events.length - 1, 0, result('u2', 'advice'));
  assert.equal(advisorCalls(chat.events).size, 2, 'the parent used its two');
  const fork = agent('s2', { events: [...chat.events, call('f1')], inherited: chat.events.length });
  await tool.execute({}, { agent: fork, callId: 'f1' }); assert.equal(llm.calls.length, 3);
  // One call at a time per chat.
  let open; const gate = new Promise((r) => { open = r; });
  const slow = fakeLlm({ gate }); ctx.get = (name) => ({ llm: slow, agents: { get: (id) => agents.get(id), list: () => [...agents.values()] } })[name];
  const c3 = agent('s3', { events: [user('Plan')] });
  const first = tool.execute({}, { agent: c3, callId: 'x1' });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(tool.execute({}, { agent: c3, callId: 'x2' }), /already answers another call/);
  open(); await first;
  ctx.get = (name) => ({ llm, agents: { get: (id) => agents.get(id), list: () => [...agents.values()] } })[name];

  // Subagents: restricted away and refused, until the user allows them.
  const kid = agent('k1', { origin: 'subagent', parentSession: 's1', events: [user('task')] });
  assert.ok(restrictions.get('k1')?.has(ADVISOR_TOOL), 'a subagent does not see the tool');
  await assert.rejects(tool.execute({}, { agent: kid, callId: 'k' }), /not available in subagent chats/);
  assert.equal((await req({ subagents: true })).body.subagents, true);
  assert.ok(!restrictions.has('k1'), 'allowed: the restriction goes');
  await req({ subagents: false }); assert.ok(restrictions.get('k1')?.has(ADVISOR_TOOL));

  // Per chat: off hides it in that chat and in its subagents; on again brings it back.
  assert.deepEqual((await req({ sessionId: 's3', off: true })).body, { on: true, ready: true, sessionId: 's3', off: true });
  assert.ok(restrictions.get('s3')?.has(ADVISOR_TOOL));
  await assert.rejects(tool.execute({}, { agent: c3, callId: 'x3' }), /switched the advisor off for this chat/);
  await req({ subagents: true });
  const kid3 = agent('k3', { origin: 'subagent', parentSession: 's3' });
  assert.ok(restrictions.get('k3')?.has(ADVISOR_TOOL), 'a subagent follows its root chat');
  assert.deepEqual((await req(undefined, '?sessionId=s3')).body.off, true);
  await req({ sessionId: 's3', off: false });
  assert.ok(!restrictions.has('s3') && !restrictions.has('k3'));
  await req({ subagents: false });

  // A model that dsh no longer lists: refused, no call.
  const before = llm.calls.length;
  llm.listModels = async () => [];
  await assert.rejects(tool.execute({}, { agent: agent('s4', { events: [user('x')] }), callId: 'z' }), /No advisor model/);
  assert.equal(llm.calls.length, before);
  llm.listModels = async (p) => (p === 'strong' ? [{ id: 'opus', name: 'Opus' }] : [{ id: 'flash', name: 'Flash' }]);

  // Switch off: no tool, no restriction left; a new model resets the effort; on again after a restart.
  await req({ on: false });
  assert.equal(live.size, 0, 'off removes the tool'); assert.equal(restrictions.size, 0, 'and every restriction');
  assert.equal((await req({ model: { provider: 'cheap', model: 'flash' } })).body.effort, undefined, 'a new model drops the effort');
  await req({ on: true }); assert.ok(live.has(ADVISOR_TOOL));
  const again = installAdvisor({ ...ctx, connection: { fetch: { register: () => {} } } }, home);
  await again.ready; assert.ok(live.has(ADVISOR_TOOL), 'the saved state comes back after a restart');
  effects.forEach((f) => typeof f === 'function' && f()); assert.equal(live.size, 0, 'unload removes the tool');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('advisor checks passed');
