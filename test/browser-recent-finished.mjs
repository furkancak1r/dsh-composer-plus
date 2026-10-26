// Isolated real-app check of the recent projects filter with a finished chat. A chat in weather-cli finishes while a
// chat in acme-web is open, so dsh shows its done dot. The page clock runs 2.5 hours ahead, so the chat is older than
// 2 hours: the filter keeps weather-cli until you open that chat. Fake model, never the normal DSH_HOME.
// Tether's green dots follow dsh's dot (Mobile connect on; its gateway cannot start on a missing network interface, so no
// port and no Bonjour): the Host's unread list has a chat that finished in the background, loses it when the chat is
// opened here or when a page reload shows it without a dot, and never keeps a chat that finished while it was open.
// PLAYWRIGHT=/path/to/playwright node test/browser-recent-finished.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model: the title at once, the reply after 6 s.
const TASK = 'Fix the login redirect loop';
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const last = (JSON.parse(body).messages ?? []).at(-1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const reply = (text) => { send({ role: 'assistant', content: text }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    if (/session title/i.test(JSON.stringify(last?.content))) { reply(TASK); return; }
    const timer = setTimeout(() => reply('Done.'), 6000);
    res.on('close', () => clearTimeout(timer));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-recent-done-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'recent-done-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // Three projects, all added 5 hours ago and without chats.
    const added = new Date(Date.now() - 5 * 3600e3).toISOString();
    const names = ['acme-web', 'weather-cli', 'docs-site'];
    const ids = Object.fromEntries(names.map((name) => [name, randomUUID()]));
    for (const name of names) await mkdir(join(home, 'projects', name), { recursive: true });
    await mkdir(join(home, 'storages/dsh-composer-plus'), { recursive: true });
    await writeFile(join(home, 'storages/dsh-composer-plus/mobile.json'), JSON.stringify({ on: true }));
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: names.map((name) => ids[name]), archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids['acme-web'] },
      tables: { workspaces: Object.fromEntries(names.map((name) => [ids[name], { path: join(home, 'projects', name), title: name, sessionIds: [], createdAt: added, updatedAt: added }])) },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3196', '--no-open'], { cwd: join(home, 'projects/acme-web'), env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), DSH_MOBILE_IFACE: 'cp-test-none', DSH_MOBILE_ADMIN_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      // From the first render on, the filter sees each chat of this test as older than 2 hours (no render with the real clock).
      await context.addInitScript(() => { const now = Date.now; Date.now = () => now.call(Date) + 2.5 * 3600e3; });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const button = page.getByRole('button', { name });
        if (await button.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await button.click(); await button.waitFor({ state: 'hidden' }); }
      }
      await page.locator('[data-composer-input]').waitFor();
      const row = (name) => page.locator(`[data-row-key="workspace:${ids[name]}"]`);
      const doneDot = row('weather-cli').locator('[title="A chat finished"]');
      const newChatIn = async (name) => {
        await row(name).hover();
        await page.getByRole('button', { name: `New session in ${name}`, exact: true }).click();
        await pause(600);
      };
      const unread = () => page.evaluate(() => fetch('/api/composer-plus.unread').then((r) => r.json()).then((j) => j.unread));
      const until = async (test, what, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await pause(250)) if (await test()) return; assert.fail(what); };
      const send = async (text) => { await page.locator('[data-composer-input]').click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); await pause(1000); };
      /** Select or deselect "Active in the last 2 hours", then close the menu. */
      const filter = async () => {
        await page.getByRole('button', { name: 'View options', exact: true }).click();
        await page.getByRole('menuitem', { name: /^Active in the last 2 hours/ }).click();
        await page.keyboard.press('Escape'); await page.locator('[role="menu"]').waitFor({ state: 'detached' });
      };

      // The weather-cli chat finishes while a chat in acme-web is open, so dsh shows its done dot.
      await newChatIn('weather-cli');
      await page.locator('[data-composer-input]').click(); await page.keyboard.type(TASK); await page.keyboard.press('Enter');
      const chat = page.locator('[data-row-key^="session:"]').filter({ hasText: TASK }).first();
      await chat.waitFor({ timeout: 20000 });
      await newChatIn('acme-web');
      await doneDot.waitFor({ state: 'attached', timeout: 30000 });
      const chatId = (await chat.getAttribute('data-row-key')).slice('session:'.length);
      await until(async () => (await unread()).includes(chatId), 'Tether: a chat that finished in the background is unread');

      // The chat is older than 2 hours, but you did not open it yet. One style rule hides docs-site, and the same rule
      // decides weather-cli, so its visibility is final when docs-site is hidden.
      await filter();
      await row('docs-site').waitFor({ state: 'hidden' });
      assert.equal(await row('weather-cli').isVisible(), true, 'a project with a finished chat that you did not open stays');

      // Open the finished chat, then go to another chat: dsh clears the done dot, so the quiet project hides.
      await filter();
      await chat.click(); await doneDot.waitFor({ state: 'detached' });
      await until(async () => !(await unread()).includes(chatId), 'Tether: opened here, so read');
      await newChatIn('acme-web');
      await filter();
      await row('weather-cli').waitFor({ state: 'hidden' });
      assert.equal(await row('docs-site').isVisible(), false);
      await filter();

      // Another background finish, then a page reload: dsh starts with no dots, so the Host forgets the chat too.
      await chat.click(); await send('Again');
      await newChatIn('acme-web');
      await doneDot.waitFor({ state: 'attached', timeout: 30000 });
      await until(async () => (await unread()).includes(chatId), 'Tether: unread again after a background finish');
      await page.reload(); await page.locator('[data-composer-input]').waitFor();
      await until(async () => !(await unread()).includes(chatId), 'Tether: no dot after the reload, so read');
      assert.equal(await doneDot.count(), 0, 'dsh shows no dot after a reload');
      // A turn that finishes while its chat is open: no dot in dsh, none on the Host.
      await chat.click(); await send('Third');
      const done = page.getByText('Done.', { exact: true });
      await until(async () => (await done.count()) >= 3, 'the third turn finished', 30000);
      await pause(1500);
      assert.equal((await unread()).includes(chatId), false, 'Tether: finished while open, so read');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: finished chat older than 2 hours keeps its project until opened, then the project hides; Tether's unread list follows dsh's dot (open, reload, finished while open); no page errors`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
