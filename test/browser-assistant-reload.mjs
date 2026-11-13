// Real-app check: after a page reload, the Assistant row opens the assistant chat also when dsh has not listed its chats
// yet. A fake model, a throwaway HOME and DSH_HOME, one made-up project (acme-web). Headless Chromium.
// 1. The Assistant row opens the assistant chat; one message makes it a real chat.
// 2. Reload while dsh's chat list (session/list) is held; the Assistant row is clicked before the list comes. dsh's
//    openSession refuses a chat that it does not list yet: the panel says "Opening the assistant chat…" until the list
//    comes, then the assistant chat opens (before the fix the panel stayed on "Opening…" for good).
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-reload.mjs /path/to/dsh/lib/bin.js [...]
// The Playwright must have its own headless Chromium installed (the check does not use Chrome). PORT=<port> uses another
// port than 3297. TMPDIR=/tmp keeps the throwaway homes in /tmp.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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

// Fake OpenAI-compatible model: every turn answers "Done.".
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const { model } = JSON.parse(body);
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`${chunk({ role: 'assistant', content: 'Done.' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-reload-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-reload-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3297', '--no-open'], { cwd: project,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(home, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    let context; let page; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      page = await context.newPage();
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const assistantRow = page.locator('button[aria-label="Damon"]');
      await assistantRow.waitFor({ timeout: 20000 });

      // 1. The assistant chat opens; one message makes it a real chat.
      await assistantRow.click();
      const id = await until(() => page.evaluate(async () => { const r = await fetch('/api/composer-plus.assistant'); return r.ok ? (await r.json()).sessionId : undefined; }), 'assistant chat id');
      const chatShown = () => page.locator(`[data-conversation-session="${id}"]`).first().isVisible().catch(() => false);
      await until(chatShown, 'the assistant chat is open');
      const input = page.locator(`[data-conversation-session="${id}"] [data-composer-input]`).first();
      await input.click(); await page.keyboard.type('hello', { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
      await page.locator(`[data-conversation-session="${id}"]`).getByText('Done.', { exact: true }).first().waitFor({ timeout: 30000 });
      console.log(`dsh ${version}\n  1: the Assistant row opened the assistant chat`);

      // 2. Reload; dsh's chat list is held until the Assistant row was clicked.
      const held = []; let hold = true;
      await page.route(/\/session\/list(\?|$)/, (route) => { if (hold) held.push(route); else route.continue(); });
      const status = page.waitForResponse((r) => r.url().includes('/api/composer-plus.assistant-status'));
      await page.reload();
      await status; // the client knows the assistant chat's id (as after any reload)
      await assistantRow.waitFor({ timeout: 20000 });
      await until(() => held.length > 0, 'dsh asked for its chat list');
      await assistantRow.click();
      const panel = page.locator('[data-composer-plus-assistant]');
      await panel.waitFor({ timeout: 10000 });
      await pause(1000);
      assert.match(await panel.innerText(), /Opening the assistant chat/, 'the panel waits while dsh has no chat list');
      hold = false; for (const route of held.splice(0)) await route.continue();
      await until(chatShown, 'the assistant chat opens once dsh lists its chats (before the fix: "Opening…" for good)', 20000);
      assert.equal(await panel.count(), 0, 'the opening panel closed');
      console.log('  2: after a reload, a click before dsh listed its chats opened the assistant chat when the list came');
      passed = true;
      console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}`);
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 3000); } });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
