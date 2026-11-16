// Real-app check of "Advisor model" on each dsh given: a fake OpenAI-compatible server with two models (a cheap chat model
// and a strong advisor), a throwaway DSH_HOME, a made-up project (demo-app). Never the normal DSH_HOME, no real model. Headless.
// 1. Settings: Advisor model is off by default; the chat request has no advisor tool. Switch it on: still no tool until the
//    advisor's Model is chosen; choose "Strong" and Uses per chat = 2.
// 2. Chat A: the chat model calls `advisor` → the strong model gets ONE request with no tools, the chat as text (the user's
//    task) → its advice comes back as the tool result in the same turn; the chat model then answers. The chat shows the
//    Advice row with the model and the tokens; opening it shows the advice.
// 3. The limit: the second and third calls in the same chat → use 2 of 2, then an error result and no strong-model request.
// 4. Per chat: "Advisor on" in the chat header → off → the next request of that chat has no advisor tool.
// 5. Switch off: the next request of a new chat has no advisor tool. 6. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-advisor.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/advisor.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'node:fs/promises';
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
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); }
};

const TASK = { A: 'Choose a cache strategy for the demo app', B: 'Ask the advisor two more times', C: 'Plan the demo app release', D: 'Check the demo app again' };
const ADVICE = 'Use a write-through cache with a 5 minute TTL, and add a test for stale reads first.';
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const chats = []; // chat-model calls: {task, tools, results}
const advisors = []; // strong-model calls: {tools, system, text}
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"cheap"},{"id":"strong"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const all = JSON.stringify(msgs);
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Demo chat');
    if (/You predict the next message|You complete the message that the user is typing/.test(all)) return say('');
    if (parsed.model === 'strong') {
      advisors.push({ tools: parsed.tools, system: textOf(msgs.find((m) => m.role === 'system')?.content), text: textOf(msgs.at(-1)?.content) });
      return say(ADVICE);
    }
    const task = all.includes(TASK.D) ? 'D' : all.includes(TASK.C) ? 'C' : all.includes(TASK.B) ? 'B' : all.includes(TASK.A) ? 'A' : '?';
    const tools = (parsed.tools ?? []).map((t) => t.function?.name ?? t.name);
    const results = msgs.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    chats.push({ task, tools, results });
    // A user message starts a round; the model calls the advisor while it has the tool and its round wants more advice.
    const lastUser = msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content).includes(TASK[task]));
    const asked = msgs.slice(lastUser).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    const want = task === 'A' ? 1 : task === 'B' ? 2 : task === 'C' || task === 'D' ? 1 : 0;
    if (tools.includes('advisor') && asked < want) {
      send({ role: 'assistant', content: 'I will ask the advisor first.', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'advisor', arguments: '{}' } }] });
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    if (task === 'D' || task === 'C') return say('Done without the advisor.');
    const last = results.at(-1) ?? '';
    return say(last.includes(ADVICE) ? 'The advisor suggests a write-through cache; I will add the stale-read test first.' : last.includes('limit of this chat is reached') ? 'The advisor limit is reached, so I go on alone.' : 'Done without the advisor.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    chats.length = 0; advisors.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-advisor-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'advisor-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
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
          - { id: cheap, name: Cheap model, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
          - { id: strong, name: Strong model, contextWindow: 200000, maxTokens: 8000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: cheap }
`);
    const project = join(home, 'projects', 'demo-app');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'README.md'), '# demo-app\n\nA made-up app for the advisor check.\n');
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'demo-app', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3208', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const settings = async () => {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        await page.locator('[data-composer-plus-settings]').waitFor();
      };
      const back = async () => {
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const button = overlay.getByRole('button', { name: /^Close$/ });
        if (await button.count()) await button.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(400);
      };
      const route = () => page.evaluate(async () => (await fetch('/api/composer-plus.advisor')).json());
      const send = async (text) => { await input.click(); await page.keyboard.type(text, { delay: 10 }); await page.keyboard.press('Enter'); };
      const newChat = async () => {
        const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'demo-app' }).first();
        await proj.hover();
        await page.getByRole('button', { name: 'New session in demo-app', exact: true }).click(); await pause(800);
      };
      // Agent requests only (they offer tools); Project memory's review and the title call have none.
      const agentCalls = () => chats.filter((c) => c.tools.length > 0);
      const chatCalls = (task) => agentCalls().filter((c) => c.task === task);

      // 1. Off by default; on without a model: no tool; choose the Strong model and 2 uses.
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      const sw = page.getByRole('switch', { name: 'Advisor model', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'false', 'Advisor model is off by default');
      assert.equal((await route()).on, false);
      await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'true' && (await route()).on === true, 'switched on');
      await page.getByText('Choose the advisor model: until then, the agent does not get the tool.').waitFor({ timeout: 10000 });
      const modelMenu = page.locator('[data-composer-plus-prediction-model] button[aria-label="Advisor model: Model"]');
      await modelMenu.waitFor({ timeout: 10000 });
      assert.equal(await modelMenu.textContent(), 'No model (choose one)');
      await modelMenu.click(); await page.getByRole('menuitem', { name: 'Strong model', exact: true }).click();
      await until(async () => (await route()).model?.model === 'strong', 'the advisor model is saved');
      await page.locator('[data-composer-plus-advisor="uses"]').click(); await page.getByRole('menuitem', { name: '2', exact: true }).click();
      await until(async () => (await route()).maxUses === 2, 'uses per chat = 2');
      if (process.env.SHOT) {
        const rowBox = await page.locator('[data-composer-plus-settings] > div').filter({ has: sw }).last().boundingBox();
        const png = join(home, 'advisor-settings.png');
        await page.screenshot({ path: png, clip: { x: rowBox.x, y: rowBox.y, width: rowBox.width, height: rowBox.height } });
      }
      await back();
      note('1: off by default; on without a model shows the hint; Strong model and 2 uses chosen');

      // 2. Chat A: one advisor call in the same turn; the advice is the tool result; the Advice row shows it.
      await send(TASK.A);
      await page.getByText('The advisor suggests a write-through cache; I will add the stale-read test first.').waitFor({ timeout: 40000 });
      const a = chatCalls('A');
      assert.ok(a[0].tools.includes('advisor'), 'the advisor tool is offered');
      assert.equal(a.length, 2, `chat A: the advisor call and the final answer in one turn: ${a.length}`);
      assert.equal(advisors.length, 1, 'one strong-model request');
      assert.equal(advisors[0].tools, undefined, 'the advisor request has no tools');
      assert.match(advisors[0].system, /You are the advisor of an AI coding agent/);
      assert.ok(advisors[0].text.includes(`User: ${TASK.A}`) && advisors[0].text.includes('Tool call advisor'), 'the chat goes as text');
      assert.match(a[1].results.at(-1), /^Advice from strong \(1234 input tokens, 56 output tokens; use 1 of 2 in this chat\):/);
      const row = page.locator('[data-tool="advisor"][data-state="done"]').first();
      // dsh folds the turn's tool calls ("Called tools"); open the folds above the row.
      for (const fold of [/^Completed in /, /^Called tools$/]) if (!(await row.isVisible().catch(() => false))) await page.getByText(fold).first().click().catch(() => {});
      await row.waitFor({ timeout: 10000 });
      assert.match(await row.locator('summary').innerText(), /Advice · strong · 1,234 input, 56 output tokens · use 1 of 2/);
      await row.locator('summary').click();
      await row.getByText(ADVICE).waitFor({ timeout: 5000 });
      note(`2: chat A → one advisor request (no tools, chat as text), advice in the same turn, Advice row: "${(await row.locator('summary').innerText()).trim()}"`);
      if (process.env.SHOT) {
        await page.mouse.move(1000, 100); await pause(400);
        const first = await page.getByText(TASK.A, { exact: true }).first().boundingBox();
        const end = await page.getByText('The advisor suggests a write-through cache; I will add the stale-read test first.').first().boundingBox();
        const box = await row.boundingBox();
        const left = Math.max(0, Math.min(box.x, end.x) - 24); const right = Math.min(1280, Math.max(first.x + first.width, box.x + box.width) + 24);
        const top = Math.max(0, first.y - 16); const bottom = Math.min(800, end.y + end.height + 16);
        const png = join(home, 'advisor.png');
        await page.screenshot({ path: png, clip: { x: left, y: top, width: right - left, height: bottom - top } });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round((right - left) * 1.25))), '0', png, '-o', join(repo, 'assets/features/advisor.webp')]);
        note(`shot: assets/features/advisor.webp ${(await stat(join(repo, 'assets/features/advisor.webp'))).size} bytes`);
      }

      // 3. The limit in the same chat: use 2 of 2, then an error result and no strong-model request.
      await send(TASK.B);
      await page.getByText('The advisor limit is reached, so I go on alone.').waitFor({ timeout: 40000 });
      assert.equal(advisors.length, 2, 'the third call made no strong-model request');
      const b = chatCalls('B');
      assert.ok(b.some((c) => c.results.some((r) => /use 2 of 2 in this chat/.test(r))), 'use 2 of 2');
      assert.ok(b.at(-1).results.at(-1).includes('The advisor limit of this chat is reached (2 uses)'), b.at(-1).results.at(-1));
      note(`3: limit → use 2 of 2, then "limit of this chat is reached"; strong-model requests: ${advisors.length}`);

      // 4. Per chat: the header button switches it off for this chat; the next request has no advisor tool.
      const chip = page.locator('[data-composer-plus-advisor-chat]');
      await chip.waitFor({ timeout: 10000 });
      assert.equal(await chip.getAttribute('data-composer-plus-advisor-chat'), 'on');
      await chip.click();
      await until(async () => (await chip.getAttribute('data-composer-plus-advisor-chat')) === 'off', 'the chat is switched off');
      const before = agentCalls().length;
      await send(TASK.D);
      await page.getByText('Done without the advisor.').waitFor({ timeout: 40000 });
      assert.ok(!agentCalls()[before].tools.includes('advisor'), 'per-chat off: no advisor tool in this chat');
      note('4: "Advisor on" → off in the chat header → the next request of this chat has no advisor tool');

      // 5. Switch off: a new chat's request has no advisor tool.
      await settings(); await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'false' && (await route()).on === false, 'switched off');
      await back();
      await newChat();
      const before2 = agentCalls().length;
      await send(TASK.C);
      await until(async () => agentCalls().length > before2, 'chat C asks the model');
      assert.ok(!agentCalls()[before2].tools.includes('advisor'), 'off: no advisor tool');
      note('5: switched off → no advisor tool in the next request');

      assert.deepEqual(errors, [], 'no browser exceptions');
      note('6: no page errors');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; chat calls: ${JSON.stringify(chats.map((c) => ({ task: c.task, advisor: c.tools.includes('advisor'), results: c.results.map((r) => r.slice(0, 80)) })))}; advisor calls: ${advisors.length}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
