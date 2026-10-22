// Real-app check of "Export chat as Markdown" on each dsh given: a fake model, a throwaway DSH_HOME and a made-up project.
// Never the normal DSH_HOME and no real model.
// 1. Two turns in a demo chat; the fake reply has a code block (and one reply leaves its fence open).
// 2. Right-click the chat row → "Export as Markdown…": the dialog shows the message count; nothing is copied yet.
// 3. Copy to clipboard: the clipboard holds the title, the project, "## You" / "## Assistant" sections, the code block as
//    it is, the open fence closed, and no tool, reasoning or hidden context text.
// 4. Save .md file: the browser downloads "<chat title>.md" with the same Markdown; the dialog closes.
// 5. ↶ Chat only on the second message: a new export has 2 messages, without the withdrawn message and its reply.
// 6. Switch the feature off in Settings: the menu item is gone; on again: it is back.
// PLAYWRIGHT=/path/to/playwright node test/browser-export-markdown.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/exportMarkdown.webp (English UI, demo project only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIRST = 'How do I read the recipe file?';
const SECOND = 'And how do I test it?';
const REPLY_ONE = 'Use the fs module:\n\n```js\nimport { readFile } from \'node:fs/promises\';\nconst text = await readFile(\'recipes.json\', \'utf8\');\n```\n\nThat is all.';
const REPLY_TWO = 'Run the tests with:\n\n```sh\nnode --test';
// Fake OpenAI-compatible model: titles → a title; the first chat message → REPLY_ONE; the second → REPLY_TWO.
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const last = JSON.stringify(msgs.at(-1)?.content ?? '');
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = (text) => res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    if (/session title/i.test(last)) answer('Recipe file reading');
    else answer(JSON.stringify(msgs).includes(SECOND) ? REPLY_TWO : REPLY_ONE);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-export-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'export-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'recipe-box'); await mkdir(project, { recursive: true });
    await writeFile(join(project, 'README.md'), '# Recipe Box\nA small web app to save and search family recipes.\n');
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'recipe-box', sessionIds: [], createdAt: now, updatedAt: now } } },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light', acceptDownloads: true });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      // 1. Two turns.
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      await input.click(); await page.keyboard.type(FIRST); await page.keyboard.press('Enter');
      await page.getByText('That is all.', { exact: false }).first().waitFor({ timeout: 20000 });
      await input.click(); await page.keyboard.type(SECOND); await page.keyboard.press('Enter');
      await page.getByText('Run the tests with', { exact: false }).first().waitFor({ timeout: 20000 });
      const row = page.locator('[data-row-key^="session:"]').filter({ hasText: 'Recipe file reading' }).first();
      await row.waitFor({ timeout: 20000 }); await pause(800);
      // 2. Right-click → Export as Markdown…: the dialog with the message count.
      await page.evaluate(() => navigator.clipboard.writeText('-'));
      await row.click({ button: 'right' });
      await page.getByText('Export as Markdown…').first().click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Export as Markdown' });
      await dialog.getByText('4 message(s)').waitFor({ timeout: 10000 });
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '-', 'nothing is copied before the click');
      // The dialog has finished its opening animation (for the screenshot); two actions, as in dsh's own dialogs.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5000 }).catch(() => {});
      await pause(300);
      assert.deepEqual(await dialog.locator('[data-composer-plus-export-save], [data-composer-plus-export-copy]').allInnerTexts(), ['Save .md file', 'Copy to clipboard'], 'two footer actions');
      if (index === 0 && process.env.SHOT) {
        const box = await dialog.boundingBox();
        const clip = { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: Math.min(1280, box.width + 48), height: Math.min(800, box.height + 48) };
        const png = join(home, 'exportMarkdown.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.4)), '0', png, '-o', join(repo, 'assets/features/exportMarkdown.webp')]);
      }
      // 3. Copy.
      await dialog.getByRole('button', { name: 'Copy to clipboard' }).click();
      await dialog.getByText('Copied', { exact: false }).waitFor({ timeout: 5000 });
      const md = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(md, /^# Recipe file reading\n\nProject: recipe-box · Exported: \d{4}-\d{2}-\d{2}\n\n## You\n\nHow do I read the recipe file\?\n\n## Assistant\n\nUse the fs module:/);
      assert.ok(md.includes('```js\nimport { readFile } from \'node:fs/promises\';\nconst text = await readFile(\'recipes.json\', \'utf8\');\n```'), 'the code block is kept as it is');
      assert.ok(md.endsWith('## You\n\nAnd how do I test it?\n\n## Assistant\n\nRun the tests with:\n\n```sh\nnode --test\n```\n'), 'the open fence is closed at the end');
      assert.ok(!/system-reminder|Time sampled|runtime context/i.test(md), 'no hidden context');
      assert.equal(md.match(/^## /gm).length, 4, 'one section per message');
      // 4. Save: the download has the chat title as its name and the same Markdown.
      const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Save .md file' }).click()]);
      assert.equal(download.suggestedFilename(), 'Recipe file reading.md');
      assert.equal(await readFile(await download.path(), 'utf8'), md, 'the file holds the same Markdown');
      await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      // 5. ↶ Chat only on the second message (Turn rollback): the export no longer has that message or its reply.
      const second = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: SECOND }).first();
      await second.hover();
      await second.getByRole('button', { name: 'Roll back to before this message' }).click();
      const pop = page.locator('[data-composer-plus-rollback]');
      await pop.getByRole('button', { name: /^Chat only/ }).click();
      await pop.waitFor({ state: 'detached', timeout: 20000 });
      await row.click({ button: 'right' });
      await page.getByText('Export as Markdown…').first().click();
      await dialog.getByText('2 message(s)').waitFor({ timeout: 10000 });
      await dialog.getByRole('button', { name: 'Copy to clipboard' }).click();
      await dialog.getByText('Copied', { exact: false }).waitFor({ timeout: 5000 });
      const rolledBack = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(rolledBack.includes(FIRST) && rolledBack.includes('That is all.'), 'the first turn stays');
      assert.ok(!rolledBack.includes(SECOND) && !rolledBack.includes('Run the tests with'), 'the withdrawn message and its reply are out');
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      // 6. The switch removes the item and puts it back.
      const setSwitch = async (on) => {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        await page.locator('[data-composer-plus-settings]').waitFor();
        const sw = page.getByRole('switch', { name: 'Export chat as Markdown' }); await sw.waitFor({ timeout: 10000 });
        if ((await sw.isChecked()) !== on) await sw.click();
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const close = overlay.getByRole('button', { name: /^Close$/ });
        if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(400);
      };
      await setSwitch(false);
      await row.click({ button: 'right' }); await page.getByText('Copy session link').first().waitFor({ timeout: 5000 });
      assert.equal(await page.getByText('Export as Markdown…').count(), 0, 'switched off: no menu item'); await page.keyboard.press('Escape');
      await setSwitch(true);
      await row.click({ button: 'right' }); await page.getByText('Export as Markdown…').first().waitFor({ timeout: 5000 }); await page.keyboard.press('Escape');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: two turns → right-click → Export as Markdown… shows 4 messages, nothing copied → Copy: title, project, You/Assistant sections, code block kept, open fence closed, no hidden context → Save downloads "Recipe file reading.md" with the same text → ↶ Chat only on message 2: export has 2 messages, the withdrawn turn is out → switch off removes the item, on brings it back`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // tokens stay in the temp home
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
