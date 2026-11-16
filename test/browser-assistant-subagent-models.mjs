// Real-app check of subagent models in an old assistant chat, on each dsh given: a fake model with two models (demo and
// demo-small), a throwaway DSH_HOME and HOME, made-up projects only. Never the normal DSH_HOME, no real model. Headless.
// 1. dsh's setting `subagent-model-selection-settings` is off: the assistant chat and a chat of acme-web get a message
//    (two old chats). Quit dsh.
// 2. The setting is on (demo/demo and demo/demo-small). Start dsh again: dsh writes its policy only into new chats, so
//    both chats are old. The assistant chat gets one `subagent/model-selection-policy` event from Composer Plus; its
//    subagent runs on demo/demo-small. The acme-web chat gets no event, and its subagent cannot choose demo-small.
// 3. One more start: the assistant chat still has one event.
// 4. A new dsh home with the setting on: a new assistant chat gets exactly one event (dsh's own; Composer Plus adds none).
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-subagent-models.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3217.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
// Fake OpenAI-compatible model. "MODELS <chat>": list_subagent_models (when the chat has it), then a subagent on
// demo-small, then a reply. "CHILD <chat>": the subagent; its model is kept.
const calls = []; const children = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"},{"id":"demo-small"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { chunk({ role: 'assistant', content: t }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const tool = (name, args) => { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
    const last = textOf(msgs.at(-1)?.content);
    if (/session title/i.test(last)) return say('Demo chat');
    if (/You predict the next message|You complete the message that the user is typing|label a coding task/.test(msgs.map((m) => textOf(m.content)).join('\n'))) return say('');
    const own = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t) => !/^<|^Current runtime context|^Time sampled/.test(t.trim()));
    const newest = own.at(-1) ?? '';
    const lastUser = msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content) === newest);
    const results = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    const tools = (parsed.tools ?? []).map((t) => t.function?.name);
    const child = /^CHILD (\w+)/.exec(newest.trim())?.[1];
    if (child) { children.push({ chat: child, model: parsed.model }); return say(`child ${child} done`); }
    const chat = /^MODELS (\w+)/.exec(newest.trim())?.[1];
    // A request without tools (memory review, a title) is not the chat's turn.
    if (!chat || tools.length === 0) return say('ok');
    const entry = calls.find((c) => c.chat === chat) ?? (calls.push({ chat, tools, results: [] }), calls.at(-1));
    entry.results = results;
    const step = results.length - (tools.includes('list_subagent_models') ? 1 : 0);
    if (results.length === 0 && tools.includes('list_subagent_models')) return tool('list_subagent_models', { provider: 'demo' });
    if (step === 0) {
      const bg = (parsed.tools ?? []).find((t) => t.function?.name === 'subagent')?.function?.parameters?.properties?.run_in_background !== undefined;
      return tool('subagent', { description: 'Small model check', prompt: `CHILD ${chat}: say hi`, provider: 'demo', model: 'demo-small', ...(bg ? { run_in_background: true } : {}) });
    }
    return say(`Models checked ${chat}.`);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const patch = (on) => `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  config:
    providers:
      demo:
        displayName: Demo
        api: openai-completions
        baseURL: http://127.0.0.1:${fakePort}/v1
        apiKeyEnv: DEMO_KEY
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
          - { id: demo-small, name: Demo small, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
${on ? `- id: subagent-model-selection-settings
  config:
    enabled: true
    allowedModels:
      - { provider: demo, model: demo }
      - { provider: demo, model: demo-small }
` : ''}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    calls.length = 0; children.length = 0;
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-models-')));
    const dshHome = join(home, '.dsh'); const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-models-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    const id = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: id }, tables: { workspaces: { [id]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const logs = []; const errors = []; let child; let context; let passed = false;
    const start = async (on) => {
      await writeFile(join(profile, 'cordis.patch.yml'), patch(on));
      child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3217', '--no-open'], { cwd: project,
        env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = ''; logs.push(() => log); child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await page.locator('[data-composer-input]').waitFor({ timeout: 20000 });
      return page;
    };
    const quit = async () => {
      await context?.close().catch(() => {}); context = undefined;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM'); await Promise.race([exited, pause(15000)]); assert.notEqual(child.exitCode, null, 'dsh quit');
    };
    const sessionLog = (sid) => execFileSync('find', [join(dshHome, 'sessions'), '-path', `*${sid}/*`, '-name', 'session.*']).toString().trim().split('\n')
      .filter((f) => /\.jsonl(\.zstd)?$/.test(f)).map((f) => (f.endsWith('.zstd') ? execFileSync('zstd', ['-dcq', f]).toString() : readFileSync(f, 'utf8'))).join('\n');
    const policies = (sid) => (sessionLog(sid).match(/"type":"subagent\/model-selection-policy"/g) ?? []).length;
    try {
      const api = (page, path, init) => page.evaluate(async ([p, i]) => { const r = await fetch(p, i); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, init]);
      const send = async (page, text) => {
        const input = page.locator('[data-composer-input]'); await input.click();
        await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.type(text, { delay: 5 });
        await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
      };
      const allowUntil = async (page, text, ms = 40000) => {
        const end = Date.now() + ms;
        while ((await page.getByText(text).count()) === 0) {
          if (Date.now() > end) throw Error(`timed out: ${text}`);
          const allow = page.getByRole('button', { name: /^(Allow once|Allow|Approve)$/ }).first();
          if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {}); else await pause(200);
        }
      };
      const damon = async (page) => {
        await page.locator('button[aria-label="Damon"]').click();
        const sid = await until(async () => { const r = await api(page, '/api/composer-plus.assistant'); return r.status === 200 && r.body.sessionId; }, 'assistant chat id');
        await until(async () => (await page.locator(`[data-conversation-session="${sid}"]`).count()) > 0, 'the assistant chat is open');
        return sid;
      };
      // 1. Setting off: two old chats (the assistant chat and a chat of acme-web), each with a message.
      let page = await start(false);
      const assistantId = await damon(page);
      await send(page, 'hello damon'); await page.getByText('ok', { exact: true }).first().waitFor({ timeout: 30000 });
      const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first(); await proj.hover();
      await page.getByRole('button', { name: 'New session in acme-web', exact: true }).click(); await pause(800);
      await send(page, 'hello acme');
      const listed0 = async () => (await api(page, '/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: { _request: {} } } }) })).body?.result?.value?.items ?? [];
      const acmeId = await until(async () => (await listed0()).find((s) => s.cwd === project && s.running !== true && s.blank !== true)?.sessionId, 'the acme-web chat ended its turn');
      assert.equal(policies(assistantId) + policies(acmeId), 0, 'setting off: no policy');
      await quit();
      // 2. Setting on, dsh starts again: both chats are old for dsh.
      page = await start(true);
      assert.equal(await damon(page), assistantId, 'the same assistant chat');
      await send(page, 'MODELS damon'); await allowUntil(page, 'Models checked damon.');
      await until(() => children.some((c) => c.chat === 'damon'), 'the assistant subagent ran');
      assert.equal(policies(assistantId), 1, 'one policy event in the old assistant chat');
      assert.deepEqual(children.filter((c) => c.chat === 'damon').map((c) => c.model), ['demo-small'], `the assistant subagent runs on demo-small (${JSON.stringify(calls)})`);
      const listed = calls.find((c) => c.chat === 'damon').results[0] ?? '';
      assert.match(listed, /demo-small/, `list_subagent_models shows demo-small: ${listed.slice(0, 300)}`);
      await page.locator(`[data-row-key="session:${acmeId}"]`).first().click(); await pause(800);
      await send(page, 'MODELS acme'); await allowUntil(page, 'Models checked acme.');
      await pause(2000);
      assert.equal(policies(acmeId), 0, 'another old chat keeps dsh\'s rule: no policy');
      assert.equal(children.some((c) => c.chat === 'acme' && c.model === 'demo-small'), false, `another old chat cannot choose demo-small (${JSON.stringify(children)})`);
      await quit();
      // 3. One more start: the event is not written again.
      page = await start(true);
      await damon(page); await send(page, 'MODELS again'); await allowUntil(page, 'Models checked again.');
      assert.equal(policies(assistantId), 1, 'still one policy event after another start');
      // 4. A new assistant chat while the setting is on (Delete chat, then Damon makes a new one): dsh writes its own
      //    event, and Composer Plus adds none.
      const deleted = await api(page, '/api/composer-plus.delete-chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: assistantId }) });
      assert.equal(deleted.status, 200, `deleted: ${JSON.stringify(deleted.body)}`);
      const fresh = await damon(page);
      assert.notEqual(fresh, assistantId, 'a new assistant chat');
      await send(page, 'MODELS fresh'); await allowUntil(page, 'Models checked fresh.');
      assert.equal(policies(fresh), 1, 'a new assistant chat has exactly one policy event');
      assert.deepEqual(children.filter((c) => c.chat === 'fresh').map((c) => c.model), ['demo-small'], 'its subagent runs on demo-small');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}: the old assistant chat got one policy event, its subagent ran on demo-small; another old chat got none (children: ${JSON.stringify(children)})`);
    } finally {
      await context?.close().catch(() => {});
      if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (!passed) console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; calls: ${JSON.stringify(calls).slice(0, 2000)}; children: ${JSON.stringify(children)}\n${logs.map((l) => l()).join('\n-----\n').slice(-3000)}`);
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
