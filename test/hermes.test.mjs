// Assistant on Hermes: the Host half with a fake Hermes gateway.
// - composerSections / hermesTurn: only the Composer Plus sections (not the dsh-only ones), the new user text after the
//   last reply, a replay turn for Hermes' own note.
// - hermesChunks: text, usage and finish from Hermes' SSE; an approval event goes to the callback; an error finish and a
//   cut stream throw.
// - bridgeRequest / bridgeChunks: OpenAI messages with tool calls and reasoning to dsh messages, and dsh chunks back.
// - mcpAnswer: initialize, tools/list, tools/call (a throw is an isError result), a notification, an unknown method.
// - installHermes: off by default; on starts the fake `hermes gateway` with the managed overlay and env; the assistant
//   chat's model call goes to Hermes (session header, system sections, user text) and other chats' calls do not; the
//   loopback MCP server refuses a wrong token and runs a tool through dsh's tool service in the assistant agent's scope;
//   the bridge runs Hermes' model call on dsh's llm; off stops the process.
import './temp-home.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERMES_PATH, HERMES_SECTION, HERMES_SOURCE, HERMES_TOOLS, bridgeChunks, bridgeRequest, composerSections, hermesChunks, hermesManaged, hermesTurn, installHermes, mcpAnswer } from '../index.js';

const body = (text) => (async function* () { yield new TextEncoder().encode(text); })();
const until = async (fn, what) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${what}`); };
const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out; };

// --- composerSections / hermesTurn ---
const prompt = '# dsh\nbase rules\n# Assistant (Composer Plus)\nBe short.\n## sub\nkeep\n# Assistant always free (Composer Plus)\ndsh tools only\n# Approve button (Composer Plus)\nonay rule\n# Other\nx';
assert.deepEqual(composerSections(prompt), ['# Assistant (Composer Plus)\nBe short.\n## sub\nkeep', '# Approve button (Composer Plus)\nonay rule']);
const sys = { role: 'system', content: [{ type: 'text', text: prompt }] };
const t1 = hermesTurn([sys, { role: 'user', content: [{ type: 'text', text: 'old' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  { role: 'user', content: [{ type: 'text', text: 'new' }, { type: 'image' }] }, { role: 'user', content: [{ type: 'text', text: 'second' }] }]);
assert.ok(t1.system.startsWith(HERMES_SECTION) && t1.system.includes('Be short.') && !t1.system.includes('dsh tools only') && !t1.system.includes('base rules'));
assert.equal(t1.text, 'new[an image: the user sees it in dsh]\n\nsecond');
assert.equal(t1.replay, false);
assert.equal(hermesTurn([sys, { role: 'assistant', content: [] }, { role: 'user', content: [], source: { kind: HERMES_SOURCE } }]).replay, true);
assert.ok(!HERMES_SECTION.includes('—'));

// --- hermesChunks ---
const sse = (...frames) => body(frames.join(''));
const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
let asked;
const ok = await collect(hermesChunks(sse(': keepalive\n\n', chunk({ choices: [{ delta: { role: 'assistant' } }] }), chunk({ choices: [{ delta: { content: 'Mer' } }] }),
  'event: approval.request\ndata: {"run_id":"r1","command":"rm -rf x"}\n\n', 'event: hermes.tool.progress\ndata: {"tool":"x"}\n\n',
  chunk({ choices: [{ delta: { content: 'haba' } }] }), chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }), 'data: [DONE]\n\n'), async (e) => { asked = e; }));
assert.deepEqual(ok.map((c) => c.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish']);
assert.equal(ok[3].block.text, 'Merhaba');
assert.deepEqual(ok[4].usage, { inputTokens: 7, outputTokens: 3 });
assert.equal(asked.run_id, 'r1');
await assert.rejects(collect(hermesChunks(sse(chunk({ choices: [{ delta: {}, finish_reason: 'error' }], error: { message: 'boom' } })))), /boom/);
await assert.rejects(collect(hermesChunks(sse(chunk({ choices: [{ delta: { content: 'cut' } }] })))), /stopped before its end/);
// A CRLF stream and a frame split over two chunks.
const split = (async function* () { const s = 'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_'; yield new TextEncoder().encode(s); yield new TextEncoder().encode('reason":"length"}]}\r\n\r\n'); })();
assert.equal((await collect(hermesChunks(split))).at(-1).reason.kind, 'max-tokens');

// --- bridgeRequest / bridgeChunks ---
const req = bridgeRequest({ model: 'dsh', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { role: 'assistant', content: null, reasoning_content: 'think', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web', arguments: '{"q":1}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'result' }], tools: [{ type: 'function', function: { name: 'web', description: 'd', parameters: { type: 'object' } } }, { type: 'function' }] });
assert.equal(req.system, 'S');
assert.deepEqual(req.messages.map((m) => m.role), ['user', 'assistant', 'tool']);
assert.deepEqual(req.messages[1].content, [{ type: 'reasoning', text: 'think' }, { type: 'tool-call', id: 'c1', name: 'web', arguments: '{"q":1}' }]);
assert.equal(req.messages[2].toolCallId, 'c1');
assert.deepEqual(req.tools, [{ name: 'web', description: 'd', parameters: { type: 'object' } }]);
const map = bridgeChunks();
assert.deepEqual(map({ type: 'tool-call-delta', index: 3, id: 'c9', name: 'a', argumentsDelta: '{' }), [{ delta: { tool_calls: [{ index: 0, id: 'c9', type: 'function', function: { name: 'a', arguments: '{' } }] } }]);
assert.deepEqual(map({ type: 'tool-call-delta', index: 3, id: 'c9', argumentsDelta: '}' }), [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }]);
assert.equal(map({ type: 'tool-call-delta', index: 5, id: 'd', name: 'b', argumentsDelta: '' })[0].delta.tool_calls[0].index, 1);
assert.deepEqual(map({ type: 'finish', reason: { kind: 'tool-calls' } }), [{ delta: {}, finish_reason: 'tool_calls' }]);
assert.deepEqual(map({ type: 'finish', reason: { kind: 'error', failure: { message: 'x' } } }), [{ error: 'x' }]);

// --- mcpAnswer ---
const fakeTools = { list: async () => [{ name: 'chats_list', inputSchema: {} }], call: async (name) => { if (name === 'bad') throw new Error('no'); return `ran ${name}`; } };
assert.equal((await mcpAnswer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, fakeTools)).result.protocolVersion, '2025-03-26');
assert.equal(await mcpAnswer({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeTools), undefined);
assert.equal((await mcpAnswer({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, fakeTools)).result.tools[0].name, 'chats_list');
assert.deepEqual((await mcpAnswer({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x', arguments: {} } }, fakeTools)).result, { content: [{ type: 'text', text: 'ran x' }], isError: false });
assert.equal((await mcpAnswer({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bad' } }, fakeTools)).result.isError, true);
assert.equal((await mcpAnswer({ jsonrpc: '2.0', id: 5, method: 'nope' }, fakeTools)).error.code, -32601);
assert.equal((await mcpAnswer({ id: 6 }, fakeTools)).error.code, -32600);

// --- hermesManaged ---
const managed = hermesManaged({ folder: '/a', delegate: 'go/flash' });
assert.equal(managed.delegation.model, 'go/flash');
assert.equal(managed.memory.memory_enabled, false);
assert.equal(managed.mcp_servers.composer_plus.headers.Authorization, 'Bearer ${COMPOSER_PLUS_TOKEN}');
assert.equal(hermesManaged({ folder: '/a' }).delegation, undefined);

// --- installHermes with a fake gateway ---
const home = await mkdtemp(join(tmpdir(), 'cp-hermes-'));
try {
  const listeners = {}; const routes = new Map(); let spawned; let gateway; const seen = [];
  const agent = { id: 'chat-1', status: 'idle' };
  const executed = [];
  const services = {
    tools: { get: (name) => (HERMES_TOOLS.includes(name) ? { description: `about ${name}`, parameters: { type: 'object' } } : undefined),
      execute: async (input) => { executed.push(input); return { results: [{ content: [{ type: 'text', text: `did ${input.calls[0].name}` }], isError: false }] }; } },
    agents: { get: (id) => (id === 'chat-1' ? agent : undefined) },
    llm: { listProviders: () => [{ id: 'p', name: 'P' }], listModels: async () => [{ id: 'm', name: 'M' }],
      prepareCall: async (route, _signal, shape) => ({ config: shape({}, { reasoning: { efforts: [{ id: 'low' }, { id: 'max' }] } }), stream: async function* (opts) {
        seen.push({ route, opts });
        yield { type: 'text-delta', index: 0, text: 'from dsh' }; yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }; yield { type: 'finish', reason: { kind: 'stop' } };
      } }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (n) => services[n],
    on: (name, fn) => { (listeners[name] ??= []).push(fn); },
    effect: () => {},
    logger: { warn: () => {} },
    connection: { fetch: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } } },
    sessionController: { resolveAgent: async (id) => (id === 'chat-1' ? { agent } : { error: { message: 'no' } }) },
    subprocess: {
      resolveExecutable: async () => null,
      spawn: ({ argv, env, signal }) => {
        if (argv[1] === '--version') return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: 'Hermes Agent v0.23.2' }) } } };
        spawned = { argv, env };
        let end; const done = new Promise((r) => { end = r; });
        gateway = createServer((q, s) => {
          if (q.headers.authorization !== `Bearer ${env.API_SERVER_KEY}`) { s.writeHead(401).end(); return; }
          if (q.url === '/health') { s.writeHead(200).end('{}'); return; }
          if (q.url.startsWith('/api/sessions/')) { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [] })); return; }
          let text = ''; q.on('data', (c) => { text += c; }); q.on('end', () => {
            gateway.last = { headers: q.headers, body: JSON.parse(text) };
            s.writeHead(200, { 'content-type': 'text/event-stream' });
            s.end(`${chunk({ choices: [{ delta: { content: 'Hermes says hi' } }] })}${chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })}data: [DONE]\n\n`);
          });
        }).listen(Number(env.API_SERVER_PORT), '127.0.0.1');
        signal.addEventListener('abort', () => { gateway.close(); end({ exitCode: 0 }); });
        return { done, collected: {} };
      },
    },
  };
  const assistant = { id: () => 'chat-1', isOn: () => true, ensure: async () => 'chat-1', folder: join(home, 'Assistant') };
  const h = installHermes(ctx, home, assistant, { executable: 'hermes-fake' });
  await h.ready;
  const route = routes.get(HERMES_PATH);
  const call = async (b) => (await route.fetch(new Request('http://x', b === undefined ? {} : { method: 'POST', body: JSON.stringify(b) }))).json();
  assert.deepEqual(await call(), { on: false, state: 'off' });
  assert.equal((await route.fetch(new Request('http://x', { method: 'POST', body: '{"on":1}' }))).status, 400);
  // Another chat's model call is not Hermes'.
  const llmStream = listeners['llm/stream'][0];
  assert.equal(llmStream({ sessionId: 'chat-1', messages: [] }, () => 'dsh loop'), 'dsh loop');
  assert.equal((await call({ on: true })).state, 'starting', 'on answers at once');
  await until(async () => (await call()).state === 'running', 'running');
  const started = await call();
  assert.equal(started.version, '0.23.2');
  assert.deepEqual(spawned.argv, ['hermes-fake', 'gateway']);
  assert.equal(spawned.env.API_SERVER_HOST, '127.0.0.1');
  assert.equal(JSON.parse(await readFile(join(spawned.env.HERMES_MANAGED_DIR, 'config.yaml'), 'utf8')).model.provider, 'composer-plus');
  assert.equal(JSON.parse(await readFile(join(home, 'storages', 'dsh-composer-plus', 'assistant-hermes.json'), 'utf8')).on, true);
  // The assistant chat's call goes to Hermes; another chat and an auxiliary call do not.
  assert.equal(llmStream({ sessionId: 'chat-2', messages: [] }, () => 'dsh loop'), 'dsh loop');
  assert.equal(llmStream({ sessionId: 'chat-1', purpose: 'title', messages: [] }, () => 'dsh loop'), 'dsh loop');
  const out = await collect(llmStream({ sessionId: 'chat-1', provider: 'p', model: 'm', messages: [sys, { role: 'user', content: [{ type: 'text', text: 'Selam' }] }] }, () => 'dsh loop'));
  assert.equal(out.find((c) => c.type === 'block-end').block.text, 'Hermes says hi');
  assert.equal(gateway.last.headers['x-hermes-session-id'], 'composer-plus-chat-1');
  assert.equal(gateway.last.body.messages[1].content, 'Selam');
  assert.ok(gateway.last.body.messages[0].content.includes('# Assistant (Composer Plus)'));
  // The loopback server: the token, MCP through dsh's tool service, the model bridge.
  const loop = spawned.env.COMPOSER_PLUS_URL; const auth = { authorization: `Bearer ${spawned.env.COMPOSER_PLUS_TOKEN}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${loop}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
  const listed = await (await fetch(`${loop}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
  assert.deepEqual(listed.result.tools.map((t) => t.name), HERMES_TOOLS);
  const ran = await (await fetch(`${loop}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chats_list', arguments: { limit: 3 } } }) })).json();
  assert.equal(ran.result.content[0].text, 'did chats_list');
  assert.equal(executed[0].agent, agent);
  assert.equal(executed[0].calls[0].arguments, '{"limit":3}');
  const refusedTool = await (await fetch(`${loop}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: {} } }) })).json();
  assert.equal(refusedTool.result.isError, true);
  const bridged = await (await fetch(`${loop}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'dsh', messages: [{ role: 'user', content: 'x' }] }) })).json();
  assert.equal(bridged.choices[0].message.content, 'from dsh');
  assert.deepEqual(seen.at(-1).route, { provider: 'p', model: 'm' });
  const sub = await (await fetch(`${loop}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'p/m', stream: true, messages: [{ role: 'user', content: 'x' }] }) })).text();
  assert.ok(sub.includes('"content":"from dsh"') && sub.trim().endsWith('data: [DONE]'));
  assert.equal(seen.at(-1).opts.reasoningEffort, 'max');
  // Subagent model: a listed dsh model is saved and Hermes starts again with it as delegate_task's model.
  const modelRoute = routes.get('/api/composer-plus.assistant-hermes-model');
  const setModel = async (model) => modelRoute.fetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ model }) }));
  assert.equal((await setModel({ provider: 'p', model: 'gone' })).status, 409, 'a model that dsh does not list');
  assert.deepEqual(await (await setModel({ provider: 'p', model: 'm' })).json(), { model: { provider: 'p', model: 'm' } });
  await until(async () => JSON.parse(await readFile(join(spawned.env.HERMES_MANAGED_DIR, 'config.yaml'), 'utf8')).delegation?.model === 'p/m', 'the restart with the subagent model');
  assert.equal((await call()).state, 'running');
  // Off: the gateway stops and the chat is dsh's again.
  assert.equal((await call({ on: false })).state, 'off');
  assert.equal(llmStream({ sessionId: 'chat-1', messages: [] }, () => 'dsh loop'), 'dsh loop');
  assert.equal((await fetch(`${loop}/mcp`, { method: 'POST', headers: auth, body: '{}' }).catch(() => ({ status: 0 }))).status, 0);
} finally { await rm(home, { recursive: true, force: true }); }
console.log('hermes: ok');
