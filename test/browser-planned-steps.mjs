// Real-app check of "Planned steps" on each dsh given: a fake model, a throwaway DSH_HOME, a made-up project (demo-app).
// Never the normal DSH_HOME, no real model. Headless.
// 1. Settings: Planned steps is off by default; the model's request has no plan_next_steps tool. Switch it on.
// 2. Chat A "Build and test": the model calls bash `node build.js` and plan_next_steps (test after root when ok). The
//    build passes → Composer Plus runs `node test.js` without a model call. Model chat calls in the turn: 2 (plan,
//    final), not 3; the turn's steps show "Composer Plus · Planned steps: ran `test` … without a model call".
// 3. Chat B "Build and test (broken)": the build fails (exit 1) → the guard fails → no planned step; the model answers.
// 4. Chat C: a planned `read` of `.env` (Protected files default) → dsh's tools/pre-execute gates refuse the planned call
//    like any other call: the model reads "Protected file: .env" in the tool result.
// 5. Chat D: a throwaway gate plugin (in the test's own DSH_HOME) asks for `node test.js --ask-me` → dsh shows its
//    approval card for the planned step; it runs only after Allow once.
// 6. Switch off: the next request has no plan tool (the tool, the section and the listener are gone); route on: false.
// 7. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-planned-steps.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/plannedSteps.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, stat } from 'node:fs/promises';
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

const TASK = { A: 'Build and test the demo app', B: 'Build and test the broken demo app', C: 'Check the demo app settings', D: 'Build and test with approval' };
const PLAN = { steps: [{ id: 'test', after: 'root', when: 'ok', tool: 'bash', arguments: { command: 'node test.js', description: 'Run the tests' } }] };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
// Fake OpenAI-compatible model. Chat calls are counted per task; title and prediction calls are answered and not counted.
const chats = []; // {task, tools: [names], last}
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const all = JSON.stringify(msgs);
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say(all.includes(TASK.B) ? 'Broken build' : 'Build and test');
    if (/You predict the next message|You complete the message that the user is typing/.test(all)) return say('');
    const task = all.includes(TASK.D) ? 'D' : all.includes(TASK.C) ? 'C' : all.includes(TASK.B) ? 'B' : all.includes(TASK.A) ? 'A' : '?';
    const tools = (parsed.tools ?? []).map((t) => t.function?.name ?? t.name);
    chats.push({ task, tools, last: msgs.at(-1), results: msgs.filter((m) => m.role === 'tool').map((m) => textOf(m.content)) });
    // The first call of a task: build + plan (only when the tool is offered); later calls: the final answer.
    const ownTurn = msgs.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    if (task !== '?' && ownTurn === 0) {
      const build = { index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: task === 'B' ? 'node build.js --broken' : 'node build.js', description: 'Build the app' }) } };
      const steps = task === 'C' ? { steps: [{ id: 'env', tool: 'read', arguments: { file_path: '.env' } }] }
        : task === 'D' ? { steps: [{ id: 'test', tool: 'bash', arguments: { command: 'node test.js --ask-me', description: 'Run the tests' } }] } : PLAN;
      const plan = { index: 1, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'plan_next_steps', arguments: JSON.stringify(steps) } };
      send({ role: 'assistant', content: 'I will build the app and run the tests when the build passes.', tool_calls: tools.includes('plan_next_steps') ? [build, plan] : [build] });
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    const results = msgs.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    if (task === 'C') return say(results.some((r) => r.includes('Protected file: .env')) ? 'The settings file is protected, so I did not read it.' : 'I read the settings file.');
    return say(results.some((r) => r.includes('ok 1 - checkout works')) ? 'The build passed and all tests pass.' : 'The build failed, so I did not run the tests.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const bin of process.argv.slice(2)) {
    chats.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-planned-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'planned-steps-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    // A test-only gate: asks the user before `node test.js --ask-me` (the planned step of chat D).
    const gate = join(home, 'ask-gate.mjs');
    await writeFile(gate, "export const name = 'planned-steps-ask-gate';\nexport function apply(ctx) {\n  ctx.on('tools/pre-execute', async (exec, next) => {\n    const d = await next();\n    return exec.name === 'bash' && String(exec.arguments?.command ?? '').includes('--ask-me') && d?.kind === 'allow' ? { kind: 'ask', reason: 'demo gate' } : d;\n  });\n}\n");
    await writeFile(join(profile, 'cordis.patch.yml'), `- insert:
    - id: planned-steps-ask-gate
      name: ${gate}
- id: ui-settings-general
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
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    // The made-up project: build.js fails with --broken; test.js counts its runs in .runs.log.
    const project = join(home, 'projects', 'demo-app');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'build.js'), "if (process.argv.includes('--broken')) { console.error('error: src/cart.js:12 unexpected token'); process.exit(1); }\nconsole.log('built dist/app.js');\n");
    await writeFile(join(project, '.env'), 'DEMO_TOKEN=not-a-real-token\n');
    await writeFile(join(project, 'test.js'), "require('node:fs').appendFileSync(require('node:path').join(__dirname, '.runs.log'), 'run\\n');\nconsole.log('ok 1 - checkout works');\n");
    const runs = async () => (await readFile(join(project, '.runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'demo-app', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    // The default permission mode: dsh asks before a bash call (the planned step must show the same card).
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3207', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      const route = () => page.evaluate(async () => (await fetch('/api/composer-plus.planned-steps')).json());
      const send = async (text) => { await input.click(); await page.keyboard.type(text, { delay: 10 }); await page.keyboard.press('Enter'); };
      // A new chat in the demo-app project (dsh's own "New Session" button opens its default workspace).
      const newChat = async () => {
        const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'demo-app' }).first();
        await proj.hover();
        await page.getByRole('button', { name: 'New session in demo-app', exact: true }).click(); await pause(800);
      };
      let approvals = 0;
      const allowAll = async (until2) => {
        // Click each approval card that dsh shows (the permission mode decides) until `until2` holds; count them.
        const end = Date.now() + 40000;
        while (!(await until2())) {
          if (Date.now() > end) throw Error('timed out waiting through approvals');
          const allow = page.getByRole('button', { name: /^(Allow once|Allow|Approve)$/ }).first();
          if (await allow.isVisible().catch(() => false)) { await allow.click().catch(() => {}); approvals++; await pause(300); } else await pause(200);
        }
      };
      const chatCalls = (task) => chats.filter((c) => c.task === task);

      // 1. Off by default; switch on. Prediction off (fewer model calls).
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      const sw = page.getByRole('switch', { name: 'Planned steps', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'false', 'Planned steps is off by default');
      assert.deepEqual(await route(), { on: false });
      await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'true' && (await route()).on === true, 'switched on');
      await back();
      note('1: off by default (switch and route), switched on');

      // 2. Chat A: build passes → the planned test step runs without a model call (after the approval card).
      await send(TASK.A);
      await allowAll(async () => (await page.getByText('The build passed and all tests pass.').count()) > 0);
      const a = chatCalls('A');
      assert.ok(a[0].tools.includes('plan_next_steps'), 'the plan tool is offered while on');
      assert.equal(a.length, 2, `chat A: 2 model calls (plan, final), not 3: ${JSON.stringify(a.map((c) => c.last?.role))}`);
      assert.equal(await runs(), 1, 'the planned test step ran once');
      // dsh folds the turn's steps under "Completed in …": open it to see the step's line and its tool call.
      await page.getByText(/^Completed in /).first().click();
      const line = page.getByText(/Composer Plus · Planned steps: ran `?test`? \(after `?root`?, guard ok\) without a model call\./).first();
      await line.waitFor({ timeout: 10000 });
      note(`2: chat A → model calls ${a.length} (plan + final), test runs ${await runs()}, step line shown in the turn's steps, approval cards: ${approvals}`);
      if (process.env.SHOT) {
        await page.mouse.move(1000, 100); await pause(400);
        // From the user's message to the final answer: the build call, the step line, the test call, the answer.
        const first = await page.getByText(TASK.A, { exact: true }).first().boundingBox();
        const done = await page.getByText('The build passed and all tests pass.', { exact: true }).first().boundingBox();
        const lineBox = await line.boundingBox();
        const left = Math.max(0, Math.min(lineBox.x, done.x) - 24); const right = Math.min(1280, Math.max(first.x + first.width, lineBox.x + lineBox.width) + 24);
        const top = Math.max(0, first.y - 16); const bottom = Math.min(800, done.y + done.height + 16);
        const png = join(home, 'plannedSteps.png');
        await page.screenshot({ path: png, clip: { x: left, y: top, width: right - left, height: bottom - top } });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round((right - left) * 1.25))), '0', png, '-o', join(repo, 'assets/features/plannedSteps.webp')]);
        note(`shot: assets/features/plannedSteps.webp ${(await stat(join(repo, 'assets/features/plannedSteps.webp'))).size} bytes`);
      }

      // 3. Chat B: the build fails → the guard fails → the model answers (no planned step).
      await newChat();
      await send(TASK.B);
      await allowAll(async () => (await page.getByText('The build failed, so I did not run the tests.').count()) > 0);
      const b = chatCalls('B');
      assert.equal(b.length, 2, `chat B: the model answers after the failed build: ${b.length}`);
      assert.equal(b[1].last?.role, 'tool', 'the second call follows the tool results');
      assert.ok(b[1].results.some((r) => r.includes('unexpected token') && r.includes('[exit code: 1]')), `the build failed in demo-app (its own build.js): ${JSON.stringify(b[1].results)}`);
      assert.equal(await runs(), 1, 'no test run after a failed build');
      note(`3: chat B → build exit 1, guard failed, model calls ${b.length}, test runs still ${await runs()}`);

      // 4. Chat C: the planned read of .env goes through dsh's gates: Protected files refuses it.
      await newChat();
      await send(TASK.C);
      await allowAll(async () => (await page.getByText(/^The settings file is protected|^I read the settings file/).count()) > 0);
      assert.equal(await page.getByText('The settings file is protected, so I did not read it.').count(), 1, 'Protected files refused the planned read');
      const c = chatCalls('C');
      assert.equal(c.length, 2, 'chat C: plan + final');
      note(`4: chat C → the planned read of .env was refused by Protected files (dsh's tools/pre-execute), model calls ${c.length}`);

      // 5. Chat D: the planned step needs approval: dsh's card shows, the step runs only after Allow once.
      await newChat();
      const runsD = await runs();
      await send(TASK.D);
      const allowD = page.getByRole('button', { name: /^(Allow once|Allow|Approve)$/ }).first();
      await allowD.waitFor({ timeout: 30000 });
      assert.equal(await runs(), runsD, 'the planned step waits for the approval');
      assert.equal(chatCalls('D').length, 1, 'no model call while the card waits');
      await allowD.click();
      await until(async () => chatCalls('D').length >= 2 && (await page.getByText('The build passed and all tests pass.').count()) >= 1, 'chat D answers', 30000);
      assert.equal(await runs(), runsD + 1, 'the planned step ran after Allow once');
      assert.equal(chatCalls('D').length, 2, 'chat D: plan + final');
      note(`5: chat D → dsh's approval card for the planned step, test not run before the click, ran after Allow once; model calls ${chatCalls('D').length}`);

      // 6. Switch off: the tool is gone from the next request.
      await settings(); await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'false' && (await route()).on === false, 'switched off');
      await back();
      await newChat();
      const before = chats.length;
      await send(TASK.A);
      await allowAll(async () => chats.length >= before + 2);
      assert.ok(!chats[before].tools.includes('plan_next_steps'), 'off: no plan tool in the request');
      note('6: switched off → the next request has no plan_next_steps tool');

      assert.deepEqual(errors, [], 'no browser exceptions');
      note('7: no page errors');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; chat calls: ${JSON.stringify(chats.map((c) => ({ task: c.task, last: c.last?.role, plan: c.tools.includes('plan_next_steps') })))}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
