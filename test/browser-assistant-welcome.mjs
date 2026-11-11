// Real-app check of the Assistant onboarding card on each dsh given: a fake model, a throwaway DSH_HOME and HOME, a
// made-up project (acme-web). Never the normal DSH_HOME, no real model. Headless.
// 1. A click on Assistant opens the new assistant chat: the welcome card shows above the input with its title, intro and
//    three examples, inside the chat's composer.
// 2. Switch off in Settings: the card and its style go; switch on and click Assistant again: the card comes back.
// 3. The first message hides the card; a new chat in another project never shows it; the next click on Assistant opens
//    the same chat without the card. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-welcome.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=/path/to/file.png also saves a screenshot of step 1 (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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

// Fake OpenAI-compatible model: every answer is "ok".
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-welcome-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-welcome-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const dir = join(home, 'projects', 'acme-web'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'README.md'), '# acme-web\n');
    const wsId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wsId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wsId },
      tables: { workspaces: { [wsId]: { path: dir, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3214', '--no-open'], { cwd: dir,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.first().waitFor({ timeout: 20000 });
      const api = (path) => page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, body: await r.json().catch(() => null) }; }, path);
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
      const assistantRow = () => page.locator('button[aria-label="Damon"]');
      const card = page.locator('[data-composer-plus-assistant-welcome]');

      // 1. The first click: the card shows above the input of the new assistant chat.
      await assistantRow().waitFor({ timeout: 10000 });
      assert.equal(await card.count(), 0, 'no card before the click');
      await assistantRow().click();
      const id = await until(async () => { const r = await api('/api/composer-plus.assistant'); return r.status === 200 && r.body.sessionId; }, 'assistant chat id');
      await card.waitFor({ timeout: 20000 });
      const words = await card.innerText();
      for (const part of ['Your personal assistant', 'One lasting chat for small tasks', 'Remind me to drink water in 2 minutes', 'Find flights to Rome', 'Which chats wait for me?']) assert.ok(words.includes(part), `card text has "${part}": ${words}`);
      assert.equal(await card.getAttribute('aria-label'), 'Your personal assistant');
      const inChat = await page.locator(`[data-conversation-session="${id}"]`).count();
      const place = await page.evaluate(() => {
        const c = document.querySelector('[data-composer-plus-assistant-welcome]').getBoundingClientRect();
        const inputs = [...document.querySelectorAll('[data-composer-input]')].map((i) => i.getBoundingClientRect()).filter((r) => r.width > 0);
        const i = inputs.find((r) => r.top >= c.bottom - 1) ?? null;
        return { card: [c.top, c.bottom, c.width], input: i && [i.top, i.width], style: getComputedStyle(document.querySelector('[data-composer-plus-assistant-welcome]')).borderRadius };
      });
      assert.ok(place.input !== null && place.card[1] <= place.input[0] + 1, `the card is above the input: ${JSON.stringify(place)}`);
      assert.ok(place.card[2] > 200, `the card has its width: ${JSON.stringify(place)}`);
      if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
      note(`1: the first open of ${id} shows the card above the input (${JSON.stringify(place)}, chat view ${inChat})`);

      // 2. Switch off: the card and its style go. On, and a click: it comes back.
      await settings();
      const sw = page.getByRole('switch', { name: 'Assistant', exact: true });
      await sw.click(); await until(async () => (await sw.getAttribute('aria-checked')) === 'false', 'switch off'); await back();
      assert.equal(await card.count(), 0, 'no card while off');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent.includes('data-composer-plus-assistant-welcome'))), false, 'no style while off');
      await settings(); await sw.click(); await until(async () => (await sw.getAttribute('aria-checked')) === 'true', 'switch on'); await back();
      await assistantRow().click();
      await card.waitFor({ timeout: 20000 });
      note('2: off removes the card and its style; on + click shows it again');

      // 3. The first message hides it; another new chat never has it; the next click opens the chat without it.
      await input.first().click(); await page.keyboard.type('hello', { delay: 5 }); await page.keyboard.press('Enter');
      await card.waitFor({ state: 'detached', timeout: 10000 });
      await page.getByText('ok', { exact: true }).first().waitFor({ timeout: 30000 });
      const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first();
      await proj.hover(); await page.getByRole('button', { name: 'New session in acme-web', exact: true }).click(); await pause(1500);
      assert.equal(await card.count(), 0, 'no card in a new chat of another project');
      await assistantRow().click(); await pause(1500);
      assert.equal((await api('/api/composer-plus.assistant')).body.sessionId, id, 'the same assistant chat');
      assert.equal(await card.count(), 0, 'no card once the chat has a message');
      assert.equal(existsSync(join(home, 'Assistant')), true, '~/Assistant');
      note('3: the first message hides it; not in another new chat; not on the next open');
      // 4. The fixed name: the project of ~/Assistant and the chat header are Damon (the folder keeps its name).
      const project = Object.values(JSON.parse(readFileSync(join(dshHome, 'storages/workspace.json'), 'utf8')).tables?.workspaces ?? {}).find((w) => w.path === join(home, 'Assistant'));
      assert.equal(project?.title, 'Damon', `the project title: ${JSON.stringify(project)}`);
      await until(async () => (await page.locator('[class*="_crumbCurrent"]').filter({ hasText: /^Damon$/ }).count()) > 0, 'the chat header says Damon');
      note('4: the project and the chat header are Damon');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}\n${log.split('\n').filter((l) => /error|warn|assistant/i.test(l)).slice(-30).join('\n')}`);
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
    }
  }
} finally { await browser.close(); fake.close(); }
