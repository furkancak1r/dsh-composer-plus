// Isolated real-app check of "Order by → By status" with a fake model: one finished chat, one running chat, one chat with
// a Schedule automation and one plain chat, in "In one list". No real model, never the normal DSH_HOME.
// PLAYWRIGHT=/path/to/playwright node test/browser-status-order.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/statusOrder.webp (English UI, demo chats only). TR_SHOT=<dir> keeps the Turkish picture.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model. "Schedule …" asks for schedule_create once; "Run the long build" answers slowly.
const CHATS = { done: 'Fix the login redirect loop', running: 'Run the long build', automated: 'Schedule a daily dependency check', plain: 'Write release notes' };
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const end = () => res.end('data: [DONE]\n\n');
    if (/session title/i.test(JSON.stringify(last?.content))) { const k = Object.values(CHATS).find((x) => body.includes(x)); send({ role: 'assistant', content: k ?? 'Demo' }); send({}, 'stop'); end(); return; }
    if (last?.role !== 'tool' && body.includes(CHATS.automated)) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'schedule_create', arguments: JSON.stringify({ title: 'Dependency check', prompt: 'Check for outdated dependencies.', daily: { time: '09:00:00', time_zone: 'UTC' } }) } }] });
      send({}, 'tool_calls'); end(); return;
    }
    const slow = body.includes(CHATS.running) ? 120000 : body.includes(CHATS.done) ? 5000 : 0;
    const timer = setTimeout(() => { send({ role: 'assistant', content: 'Done.' }); send({}, 'stop'); end(); }, slow);
    res.on('close', () => clearTimeout(timer));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-status-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    // Schedule: 0.2.1's web app has it; 0.2.0-rc.2 ships it as an optional bundle. Insert the bundle's rows when needed.
    const webApp = readFileSync(join(bin, '../../../..', '@deepseek-ai/dsh-web-app/cordis.patch.yml'), 'utf8');
    const scheduleRows = webApp.includes("'@deepseek-ai/dsh-schedule'") ? '' : `- insert:
    - id: time-context
      name: '@deepseek-ai/dsh-time-context'
    - id: schedule
      name: '@deepseek-ai/dsh-schedule'
    - id: ui-schedule
      name: '@deepseek-ai/dsh-client-ui-schedule'
`;
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'status-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), `${scheduleRows}- id: ui-settings-general
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
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const contexts = []; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      const ready = async (page) => {
        for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
          const b = page.getByRole('button', { name });
          if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
        }
        await page.locator('[data-composer-input]').waitFor();
      };
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' }); contexts.push(context);
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url); await ready(page);
      const input = page.locator('[data-composer-input]');
      const say = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
      const newChat = async () => { await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await page.waitForTimeout(600); };
      const titleRow = (title) => page.locator('[data-row-key^="session:"]').filter({ hasText: title }).first();
      // Chats, oldest first: automated (approve schedule_create), plain, done (finishes in the background), running.
      await say(CHATS.automated);
      const allow = page.getByRole('button', { name: /^Allow once/ });
      if (await allow.first().waitFor({ timeout: 8000 }).then(() => true, () => false)) await allow.first().click();
      await page.waitForFunction(() => document.body.innerText.includes('Done.'), null, { timeout: 20000 }); await page.waitForTimeout(800);
      await newChat(); await say(CHATS.plain); await titleRow(CHATS.plain).waitFor({ timeout: 20000 }); await page.waitForTimeout(1500);
      // dsh shows the done dot only for a chat that finishes while it is not open: start "done", then open a new chat.
      await newChat(); await say(CHATS.done); await titleRow(CHATS.done).waitFor({ timeout: 20000 });
      await newChat(); await say(CHATS.running);
      await page.waitForFunction(() => document.querySelectorAll('[data-row-key^="session:"]').length >= 4, null, { timeout: 20000 });
      await page.waitForTimeout(6000); // "done" answers after 5 s

      // In one list.
      const viewOptions = page.getByRole('button', { name: 'View options', exact: true });
      await viewOptions.click(); await page.getByRole('menuitem', { name: 'In one list', exact: true }).click(); await page.waitForTimeout(600);
      const order = async () => page.evaluate((titles) => {
        const tree = document.querySelector('[role="tree"][class*="_flatList"]');
        const rows = [...tree.children].map((el) => ({ el, title: el.querySelector('[class*="_title"]')?.textContent ?? '', top: el.getBoundingClientRect().top }));
        return rows.sort((a, b) => a.top - b.top).map((r) => Object.entries(titles).find(([, t]) => r.title.includes(t))?.[0] ?? r.title);
      }, CHATS);
      const before = await order();
      await viewOptions.click();
      const option = page.getByRole('menuitem', { name: /^By status/ }); await option.waitFor();
      const items = await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts();
      assert.equal(items.indexOf('By status'), items.indexOf('Last updated') + 1, `"By status" follows "Last updated": ${items.join(' | ')}`);
      await option.click(); await page.waitForTimeout(600);
      assert.equal(await page.getByRole('menuitem', { name: 'By status selected', exact: true }).count(), 1, 'selected state announced; menu stays open');
      const after = await order();
      assert.deepEqual(after.filter((k) => k in CHATS), ['done', 'running', 'automated', 'plain'], `finished → running → automation → rest (dsh order was ${before.join(', ')})`);
      await page.mouse.move(1000, 700); await pause(300);
      const list = await page.locator('[role="menu"]').boundingBox();
      const shot = { x: 0, y: 0, width: 640, height: Math.min(800, Math.ceil(list.y + list.height + 24)) };
      const png = join(home, 'statusOrder.png'); await page.screenshot({ path: png, clip: shot });
      if (process.env.SHOT) execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(640 * 1.25)), '0', png, '-o', join(repo, 'assets/features/statusOrder.webp')]);
      // The choice survives a reload; dsh's own Last updated turns it off and restores dsh's order.
      const ordered = () => page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent.includes('_flatList"] > :has(') && s.textContent.includes('{ order: -')));
      await page.keyboard.press('Escape'); await page.reload(); await ready(page); await page.waitForTimeout(1200);
      assert.equal(await ordered(), true, 'order rule is back after a reload');
      await viewOptions.click();
      assert.equal(await page.getByRole('menuitem', { name: 'By status selected', exact: true }).count(), 1, 'still selected after a reload');
      await page.getByRole('menuitem', { name: 'Last updated', exact: true }).click(); await page.waitForTimeout(600);
      assert.equal(await ordered(), false, 'Last updated: dsh order again');
      await viewOptions.click();
      assert.equal(await page.getByRole('menuitem', { name: 'By status selected', exact: true }).count(), 0, 'not selected after Last updated');
      await page.keyboard.press('Escape');
      // Turkish label in the same place.
      if (process.env.TR_SHOT) {
        const tr = await browser.newContext({ locale: 'tr-TR', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' }); contexts.push(tr);
        const p2 = await tr.newPage(); await p2.goto(url); await ready(p2);
        await p2.getByRole('button', { name: 'Görünüm seçenekleri', exact: true }).click();
        await p2.getByRole('menuitem', { name: /^Duruma göre/ }).click(); await p2.waitForTimeout(500); await p2.mouse.move(1000, 700); await pause(300);
        await p2.screenshot({ path: join(process.env.TR_SHOT, 'statusOrder-tr.png'), clip: shot });
      }
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: By status after Last updated, finished → running → automation (Schedule) → rest, reload, Last updated restores dsh order, no page errors`);
    } catch (error) {
      const page = contexts.at(-1)?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      for (const context of contexts) await context.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
