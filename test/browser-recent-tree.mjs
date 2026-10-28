// Isolated real-app check of "Active in the last 2 hours" in dsh's "Workspace tree" view. Fake model, never the normal
// DSH_HOME. Projects: mono (/projects/mono) holds mono-app (/projects/mono/app); weather-cli is apart. Two chats in mono
// and one in weather-cli are made first; then the page clock runs 3 hours ahead and one new chat runs in mono-app.
// Expected in the tree: mono stays (its child mono-app is active) and its two old chats hide; mono-app and its new chat
// show; weather-cli hides. In "WorkSpace": no chat row hides (the filter is for projects only there), and mono hides
// (no active chat of its own). Off: everything shows again.
// Then Project status: a chat that runs in mono-app also shows its spinner on mono's row, also while mono is collapsed;
// in "WorkSpace" mono shows only its own chats (no spinner); when the chat ends, the spinner goes.
// SHOTS=<dir> keeps three sidebar pictures there (before and after the filter, and the parent's spinner).
// PLAYWRIGHT=/path/to/playwright node test/browser-recent-tree.mjs /path/to/dsh/lib/bin.js [...]
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

// Fake OpenAI-compatible model: each title is the task text; each reply comes at once.
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const last = JSON.stringify(msgs.at(-1)?.content ?? '');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const reply = (text) => { send({ role: 'assistant', content: text }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    if (/session title/i.test(last)) { reply([...TASKS, SLOW].find((t) => JSON.stringify(msgs).includes(t)) ?? 'Chat'); return; }
    if (last.includes('Recent conversation:')) { reply(''); return; } // Composer Plus' next message prediction
    if (JSON.stringify(msgs).includes(SLOW)) { held.push(() => reply('Done.')); return; } // runs until the test releases it
    reply('Done.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const OLD = ['Old mono task one', 'Old mono task two', 'Old weather task'];
const NEW = 'New app task';
const TASKS = [...OLD, NEW];
const SLOW = 'Slow app task';
const held = [];

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-recent-tree-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'recent-tree-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const added = new Date(Date.now() - 5 * 3600e3).toISOString();
    const projects = [['mono', 'mono'], ['mono-app', 'mono/app'], ['weather-cli', 'weather-cli']];
    const ids = Object.fromEntries(projects.map(([name]) => [name, randomUUID()]));
    for (const [, dir] of projects) await mkdir(join(home, 'projects', dir), { recursive: true });
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: projects.map(([name]) => ids[name]), archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids.mono },
      tables: { workspaces: Object.fromEntries(projects.map(([name, dir]) => [ids[name], { path: join(home, 'projects', dir), title: name, sessionIds: [], createdAt: added, updatedAt: added }])) },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: join(home, 'projects/mono'), env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => {
        if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"nextPrediction":false}');
        // The page clock: real time until the test sets the offset, then 3 hours ahead (the old chats are then 3 hours old).
        const now = Date.now; Date.now = () => now.call(Date) + Number(localStorage.getItem('test.clockAhead') ?? 0);
      });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const ready = async () => {
        for (const name of [/^Continue$/, /^Configure later$/]) {
          const button = page.getByRole('button', { name });
          if (await button.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await button.click(); await button.waitFor({ state: 'hidden' }); }
        }
        await page.locator('[data-composer-input]').waitFor();
      };
      await page.goto(url); await ready();
      const row = (name) => page.locator(`[data-row-key="workspace:${ids[name]}"]`);
      const chatRow = (text) => page.locator('[data-row-key^="session:"]').filter({ hasText: text }).first();
      const until = async (test, what, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await pause(250)) if (await test()) return; assert.fail(what); };
      const newChatIn = async (name, text, wait = true) => {
        await row(name).hover();
        await page.getByRole('button', { name: `New session in ${name}`, exact: true }).click();
        await pause(600);
        await page.locator('[data-composer-input]').click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
        await until(async () => (await chatRow(text).count()) > 0, `chat "${text}" shows`);
        if (wait) await until(async () => (await page.getByText('Done.', { exact: true }).count()) > 0, `chat "${text}" finished`);
      };
      // Project status marker of a project row: its hover text, or null when the row shows none.
      const status = async (name) => {
        const mark = row(name).locator('[data-composer-plus-project-status] [title]');
        return (await mark.count()) === 0 ? null : mark.first().getAttribute('title');
      };
      const view = async (label) => {
        await page.getByRole('button', { name: 'View options', exact: true }).click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await page.locator('[role="menu"]').waitFor({ state: 'detached' }); await pause(400);
      };
      const filter = async () => {
        await page.getByRole('button', { name: 'View options', exact: true }).click();
        await page.getByRole('menuitem', { name: /^Active in the last 2 hours/ }).click();
        await page.keyboard.press('Escape'); await page.locator('[role="menu"]').waitFor({ state: 'detached' }); await pause(400);
      };
      const expand = async (name) => { if ((await row(name).getAttribute('aria-expanded')) !== 'true') await row(name).click(); await pause(300); };
      const shown = async () => {
        const out = {};
        for (const [name] of projects) out[name] = await row(name).isVisible();
        for (const text of TASKS) out[text] = (await chatRow(text).count()) > 0 && await chatRow(text).isVisible();
        return out;
      };

      await view('Workspace Tree');
      for (const [name, text] of [['mono', OLD[0]], ['mono', OLD[1]], ['weather-cli', OLD[2]]]) await newChatIn(name, text);
      // 3 hours later (page clock), a new chat in mono-app. The old chats are now 3 hours old.
      await page.evaluate(() => localStorage.setItem('test.clockAhead', String(3 * 3600e3)));
      await page.reload(); await ready();
      await newChatIn('mono-app', NEW);
      for (const name of ['mono', 'mono-app', 'weather-cli']) await expand(name);
      if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'tree-all.png'), clip: { x: 0, y: 0, width: 420, height: 520 } });
      const before = await shown();
      assert.ok(Object.values(before).every(Boolean), `filter off: every project and chat shows ${JSON.stringify(before)}`);

      await filter();
      await until(async () => !(await row('weather-cli').isVisible()), 'tree: weather-cli hides');
      const tree = await shown();
      assert.deepEqual(tree, { mono: true, 'mono-app': true, 'weather-cli': false, [OLD[0]]: false, [OLD[1]]: false, [OLD[2]]: false, [NEW]: true },
        'tree: the parent of an active project stays, its old chats hide, the active chat shows');
      if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'tree-filtered.png'), clip: { x: 0, y: 0, width: 420, height: 520 } });

      await view('WorkSpace');
      await until(async () => !(await row('mono').isVisible()), 'WorkSpace: mono hides (no active chat of its own)');
      for (const name of ['mono-app']) await expand(name);
      const flat = await shown();
      assert.deepEqual(flat, { mono: false, 'mono-app': true, 'weather-cli': false, [OLD[0]]: false, [OLD[1]]: false, [OLD[2]]: false, [NEW]: true },
        'WorkSpace: projects are filtered as before; mono-app and its chat show');

      await view('Workspace Tree');
      await until(async () => await row('mono').isVisible(), 'tree again: mono shows');
      await filter(); // off
      for (const name of ['mono', 'mono-app', 'weather-cli']) await expand(name);
      await until(async () => Object.values(await shown()).every(Boolean), 'filter off: every project and chat shows again');

      // Project status in the tree: mono's row also shows the chat that runs in mono-app, also while mono is collapsed.
      assert.equal(await status('mono'), null, 'nothing runs yet');
      await newChatIn('mono-app', SLOW, false);
      await until(async () => (await status('mono-app')) === '1 chat(s) running', 'mono-app shows its running chat');
      await until(async () => (await status('mono')) === '1 chat(s) running', 'tree: mono shows the chat that runs in mono-app');
      assert.equal(await status('weather-cli'), null, 'weather-cli shows nothing');
      await row('mono').click();
      await until(async () => !(await row('mono-app').isVisible()), 'mono collapses');
      assert.equal(await status('mono'), '1 chat(s) running', 'collapsed mono still shows the running chat inside it');
      if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'tree-status.png'), clip: { x: 0, y: 0, width: 420, height: 520 } });
      await view('WorkSpace');
      await until(async () => (await status('mono')) === null, 'WorkSpace: mono shows only its own chats');
      assert.equal(await status('mono-app'), '1 chat(s) running', 'WorkSpace: mono-app shows its running chat');
      await view('Workspace Tree');
      await until(async () => (await status('mono')) === '1 chat(s) running', 'tree again: mono shows the spinner');
      while (held.length > 0) held.shift()();
      await until(async () => (await status('mono')) === null && (await status('mono-app')) === null, 'the chat ended: no spinner (the chat is open, so no done dot)');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: tree keeps the parent of an active project and hides its old chats; WorkSpace filters projects only; off shows all; the parent row shows its branch's running chat in the tree only; no page errors`);
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
} finally { while (held.length > 0) held.shift()(); await browser.close(); fake.close(); }
