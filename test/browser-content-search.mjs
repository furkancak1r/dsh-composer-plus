// Real-app check of "Content search" on each dsh given: a fake model, a throwaway DSH_HOME and made-up chats. Never the
// normal DSH_HOME and no real model.
// 1. Two chats whose titles do not hold the word "kumquat"; only the first chat's message does. The second chat's answer
//    holds "şeker" (Turkish letters).
// 2. dsh's own sidebar search (the search button, then its shortcut): "kumquat" finds the first chat and shows the message
//    snippet; "seker" finds the second chat (unicode61 folds ş → s). The index is an owner-only file under the home's cache.
// 3. Switch off in Settings → Composer Plus: the row says that a restart applies it. After a dsh restart the same search
//    finds nothing (titles only, dsh's default); the title search still works.
// PLAYWRIGHT=/path/to/playwright node test/browser-content-search.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/contentSearch.webp (English UI, demo chats only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model: a title request gets a fixed title, a chat request a fixed answer.
const CHATS = [
  // dsh first titles a chat with the prompt's first words, then with the model's title: keep "kumquat" out of those words.
  { prompt: 'Dinner for two on Saturday: kumquat tart as dessert.', title: 'Weekend menu', answer: 'Kumquat tart, then a light salad.' },
  { prompt: 'How much sugar goes into the lemonade?', title: 'Lemonade recipe', answer: 'Use 120 g şeker for one litre of lemonade.' },
];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const all = JSON.stringify(msgs);
    const chat = CHATS.findLast((c) => all.includes(c.prompt)) ?? CHATS[0];
    const isTitle = /session title/i.test(JSON.stringify(msgs.at(-1)?.content ?? ''));
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: isTitle ? chat.title : chat.answer }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-content-search-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'content-search-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'party-planner'); await mkdir(project, { recursive: true });
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'party-planner', sessionIds: [], createdAt: now, updatedAt: now } } },
    }));
    const index = join(home, 'cache/composer-plus/session-search.db');
    let child; let log = '';
    const start = async () => {
      log = '';
      child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      return url;
    };
    const stop = async () => {
      if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 8000); }); }
    };
    const errors = []; let context; let passed = false; let allLogs = '';
    try {
      let url = await start();
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const open = async () => {
        await page.goto(url);
        for (const name of [/^Continue$/, /^Configure later$/]) {
          const b = page.getByRole('button', { name });
          if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
        }
        await page.locator('[data-composer-input]').waitFor({ timeout: 20000 });
      };
      await open();
      // 1. Two chats. The second starts from dsh's "New session" shortcut in the same project.
      for (const [i, chat] of CHATS.entries()) {
        if (i > 0) {
          await page.getByRole('button', { name: /^New session$/i }).first().click();
          await page.getByText(CHATS[0].prompt).waitFor({ state: 'detached', timeout: 10000 });
          await page.locator('[data-composer-input]').waitFor();
        }
        await page.locator('[data-composer-input]').click(); await page.keyboard.type(chat.prompt); await page.keyboard.press('Enter');
        await page.getByText(chat.answer, { exact: false }).first().waitFor({ timeout: 20000 });
        await page.locator('[data-row-key^="session:"]').filter({ hasText: chat.title }).first().waitFor({ timeout: 20000 });
      }
      await assert.rejects(stat(index), 'no index before the first search (openAt: first-search)');
      // 2. The built-in search: button first, then the shortcut.
      const searchBox = page.locator('input[class*="searchInput"]');
      const pending = page.getByRole('status', { name: 'Searching session history…' });
      // dsh waits 250 ms after the last key, then asks the Host; the pending row goes away with the answer.
      // The collapsed box keeps its input in the page (opacity 0): open it with dsh's own search button, as a user does.
      const searchButton = page.getByRole('button', { name: 'Search sessions' }).first();
      const search = async (text) => {
        if ((await searchButton.getAttribute('aria-expanded')) !== 'true') await searchButton.click();
        await page.waitForFunction(() => document.querySelector('button[aria-label="Search sessions"]')?.getAttribute('aria-expanded') === 'true');
        await pause(250); // dsh's slide-open animation
        await searchBox.fill(text);
        await pause(400);
        await pending.waitFor({ state: 'detached', timeout: 30000 });
      };
      const rows = () => page.locator('[class*="searchResultRow"]');
      await search('kumquat');
      await rows().first().waitFor({ timeout: 20000 });
      assert.equal(await rows().count(), 1, 'one chat holds the word');
      assert.match(await rows().first().innerText(), /Weekend menu/);
      const snippet = rows().first().locator('[class*="searchResultSnippet"]');
      assert.match(await snippet.innerText(), /kumquat tart/i, 'the message snippet shows');
      if (process.env.SHOT) {
        await pause(300);
        await page.screenshot({ path: join(home, 'full.png') });
        // The sidebar part with the search box and the result: from the box's top to below the result row.
        const top = (await searchBox.boundingBox()).y - 12;
        const bottom = (await rows().first().boundingBox()).y + (await rows().first().boundingBox()).height + 24;
        const right = (await rows().first().boundingBox()).x + (await rows().first().boundingBox()).width + 12;
        const shot = join(home, 'shot.png');
        await page.screenshot({ path: shot, clip: { x: 0, y: top, width: right, height: bottom - top } });
        execFileSync('cwebp', ['-q', '82', shot, '-o', join(repo, 'assets/features/contentSearch.webp')], { stdio: 'ignore' });
      }
      await searchBox.fill('');
      await page.locator('[data-composer-input]').click(); // an outside click closes the empty box
      await page.waitForFunction(() => document.querySelector('button[aria-label="Search sessions"]')?.getAttribute('aria-expanded') === 'false');
      // dsh's "session.search" shortcut: Cmd/Ctrl+K in the desktop app, Cmd/Ctrl+Alt+K in a browser (the browser keeps Cmd+K).
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+KeyK' : 'Control+Alt+KeyK');
      await page.waitForFunction(() => document.querySelector('button[aria-label="Search sessions"]')?.getAttribute('aria-expanded') === 'true', null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => document.activeElement?.className ?? ''), await searchBox.getAttribute('class'), 'Cmd+K focuses the search box');
      await search('seker');
      await rows().first().waitFor({ timeout: 20000 });
      assert.match(await rows().first().innerText(), /Lemonade recipe[\s\S]*şeker/, 'ş folds to s');
      const mode = (await stat(index)).mode & 0o777;
      assert.equal(mode, 0o600, 'owner-only index file');
      assert.equal((await stat(join(home, 'cache/composer-plus'))).mode & 0o077, 0, 'owner-only folder');
      // 3. Switch off: Settings → Composer Plus → Content search. The row tells to restart.
      await page.keyboard.press('Escape');
      await openSettings(page);
      const row = page.locator('[data-composer-plus-settings] > div').filter({ hasText: 'Content search' }).first();
      await row.getByRole('switch').click();
      await row.getByRole('alert').filter({ hasText: 'Restart dsh to apply this change.' }).waitFor({ timeout: 10000 });
      assert.deepEqual(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/content-search.json'), 'utf8')), { on: false });
      allLogs += log;
      await stop();
      url = await start();
      await open();
      // The Settings row agrees with the running dsh again: no restart note.
      await openSettings(page);
      const rowAfter = page.locator('[data-composer-plus-settings] > div').filter({ hasText: 'Content search' }).first();
      assert.equal(await rowAfter.getByRole('switch').getAttribute('aria-checked'), 'false');
      await pause(500);
      const hostState = await page.evaluate(() => fetch('/api/composer-plus.content-search').then((r) => r.json()));
      assert.deepEqual(hostState, { on: false, active: false }, 'the running index is off');
      assert.equal(await rowAfter.getByRole('alert').count(), 0, 'no restart note after the restart');
      await page.keyboard.press('Escape');
      await search('kumquat');
      await page.getByText('No matching sessions', { exact: true }).waitFor({ timeout: 20000 });
      assert.equal(await rows().count(), 0, 'switched off: message words are not searched');
      await search('Lemonade');
      await rows().first().waitFor({ timeout: 20000 });
      assert.equal(await rows().first().locator('[class*="searchResultSnippet"]').count(), 0, 'title match, no snippet');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: built-in search finds a word that is only in a message, with its snippet → shortcut, "seker" finds "şeker" → 0600 index under cache/ → switch off + restart → titles only`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), allLogs + log); // tokens stay in the temp home
      await stop();
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }

/** Open Settings → Composer Plus (a Settings button, or the account menu when there is none). */
async function openSettings(page) {
  if (!(await page.locator('[data-composer-plus-settings]').isVisible().catch(() => false))) {
    // Since 0.2.1-alpha.3 the web app has dsh's account menu (Settings is its first item) in place of the Settings button.
    const direct = page.getByRole('button', { name: 'Settings', exact: true });
    if (await direct.isVisible().catch(() => false)) await direct.click();
    else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
    await page.getByText('Composer Plus', { exact: true }).first().click();
  }
  await page.locator('[data-composer-plus-settings]').waitFor({ timeout: 10000 });
}
