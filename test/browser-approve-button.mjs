// Real-app check of the Approve button on each dsh given: a fake model, a throwaway DSH_HOME, a made-up project (demo-app).
// Never the normal DSH_HOME, no real model. Headless, with Chromium's sandbox.
// 1. The model's request has the prompt rule (# Approve button (Composer Plus), the `onay` block).
// 2. An answer with an `onay` block: dsh shows the block as code; under the answer one "Approve" button with the sentence,
//    in dsh's turn tail. Text in the composer hides it.
// 3. A double click sends one user message: the exact sentence reaches the model once and shows as your message; the
//    button goes; your message gets no button.
// 4. An answer whose sentence names a live target (npm publish): the plain block, no button. The older answer shows none.
// 5. Switched off (the Host switch): the next request has no rule and an `onay` answer shows no button.
// 6. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-approve-button.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/approveButton.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
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

const SENTENCE = (n) => `Approve: push the branch feature/login-fix-${n} of demo-app to origin.`;
const LIVE = 'Approve: run npm publish for demo-app.';
const ANSWER = (sentence) => `The login fix is ready on its branch. Pushing it needs your approval:\n\n\`\`\`onay\n${sentence}\n\`\`\`\n`;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const RULE = '# Approve button (Composer Plus)';
// Fake OpenAI-compatible model: "approve:<n>" and "live" answer with an `onay` block; the rest answers "Done.". Every chat
// request is kept (`calls`): its last user text and whether the system prompt had the rule.
const calls = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const all = JSON.stringify(msgs);
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Login fix');
    if (/You predict the next message|You complete the message that the user is typing|next message that the user will type/.test(all)) return say('');
    const users = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((u) => !/runtime context|Time sampled while preparing/i.test(u));
    const last = users.at(-1) ?? '';
    calls.push({ last, rule: all.includes(RULE) });
    const n = last.match(/^approve:(\d+)$/)?.[1];
    if (n) return say(ANSWER(SENTENCE(n)));
    if (last === 'live') return say(ANSWER(LIVE));
    return say('Done.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-approve-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'approve-button-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    const project = join(home, 'projects', 'demo-app'); await mkdir(project, { recursive: true });
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3207', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"idleSwitch":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      const typeSend = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
      const approve = page.locator('[data-composer-plus-approve]');

      // 1–2. The rule in the request; an answer with an `onay` block gets one Approve button in dsh's turn tail.
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
      await typeSend('approve:1');
      await page.getByText(SENTENCE(1), { exact: true }).first().waitFor({ timeout: 20000 });
      assert.ok(calls.find((c) => c.last === 'approve:1')?.rule, 'the request carries the prompt rule');
      await approve.waitFor({ timeout: 20000 });
      const button = approve.locator('button');
      assert.equal(await button.count(), 1, 'one button for one block');
      assert.equal((await button.innerText()).replace(/\s+/g, ' ').trim(), `Approve ${SENTENCE(1)}`, 'the label and the sentence');
      assert.equal(await approve.evaluate((e) => e.closest('[data-turn-tail]') !== null), true, 'in dsh\'s turn tail, under the answer');
      assert.ok(await page.locator('.md-code-block').filter({ hasText: SENTENCE(1) }).count() >= 1, 'dsh shows the block as code, unchanged');
      if (index === 0 && process.env.SHOT) {
        await page.mouse.move(1200, 120); await pause(600);
        const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
        const top = await rect(page.getByText('The login fix is ready on its branch.', { exact: false }).first()); const bottom = await rect(approve);
        const area = { x: Math.max(0, top.x - 24), y: Math.max(0, top.y - 20), width: 760, height: Math.min(420, bottom.bottom - top.y + 40) };
        const png = join(home, 'approveButton.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/approveButton.webp')]);
        console.log(`shot: assets/features/approveButton.webp ${(await stat(join(repo, 'assets/features/approveButton.webp'))).size} bytes`);
      }
      // Text in the composer hides it; an empty composer shows it again.
      await input.click(); await page.keyboard.type('hm'); await approve.waitFor({ state: 'detached', timeout: 5000 });
      await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await approve.waitFor({ timeout: 5000 });

      // 3. A double click sends the exact sentence once, as your message.
      const before = calls.length;
      await button.dblclick();
      await page.getByText('Done.', { exact: true }).last().waitFor({ timeout: 20000 }); await pause(1500);
      const sent = calls.slice(before).filter((c) => c.last.includes('feature/login-fix-1'));
      assert.equal(sent.length, 1, `one message: ${JSON.stringify(calls.slice(before).map((c) => c.last))}`);
      assert.equal(sent[0].last, SENTENCE(1), 'the exact sentence');
      const mine = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: SENTENCE(1) });
      assert.equal(await mine.count(), 1, 'a normal message of yours in the chat');
      assert.equal(await approve.count(), 0, 'sent: no button, and your message has none');

      // 4. A live target: the plain block, no button; the older answer shows none either.
      await typeSend('live');
      await page.getByText(LIVE, { exact: true }).first().waitFor({ timeout: 20000 }); await pause(2500);
      assert.equal(await approve.count(), 0, 'a live sentence gets no button');
      assert.ok(await page.locator('.md-code-block').filter({ hasText: LIVE }).count() >= 1, 'the plain block shows');
      await typeSend('approve:2'); await page.getByText(SENTENCE(2), { exact: true }).first().waitFor({ timeout: 20000 });
      await approve.waitFor({ timeout: 20000 });
      assert.equal(await approve.count(), 1, 'only the newest answer has buttons');
      assert.equal((await approve.locator('button').innerText()).includes(SENTENCE(2)), true);
      await page.reload(); await input.waitFor(); await approve.waitFor({ timeout: 20000 });
      assert.equal(await approve.count(), 1, 'after a reload: the same one button (the chat log is read, not changed)');

      // 5. Switched off (Host switch): no rule in the next request, no button.
      const route = (body) => page.evaluate(async (b) => (await fetch('/api/composer-plus.approve-button', b === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(), body);
      assert.deepEqual(await route(), { on: true }, 'on by default');
      assert.deepEqual(await route({ on: false }), { on: false });
      await page.reload(); await input.waitFor(); await pause(1000);
      await typeSend('approve:3'); await page.getByText(SENTENCE(3), { exact: true }).first().waitFor({ timeout: 20000 }); await pause(2500);
      assert.equal(calls.find((c) => c.last === 'approve:3')?.rule, false, 'off: the request has no rule');
      assert.equal(await approve.count(), 0, 'off: no button');
      assert.deepEqual(await route({ on: true }), { on: true });
      await page.reload(); await input.waitFor(); await approve.waitFor({ timeout: 20000 });

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; calls: ${JSON.stringify(calls.slice(-6))}`);
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
