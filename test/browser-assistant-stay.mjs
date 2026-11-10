// Real-app check: "Open waiting chat when idle" never moves you away from the Assistant chat. A fake model, a throwaway
// HOME and DSH_HOME, one made-up project (acme-web). Headless.
// 1. A chat in acme-web finishes a turn while the Assistant chat is open (dsh's green dot). After 40 s without input the
//    Assistant chat is still the open chat, and the finished chat keeps its dot.
// 2. A normal chat is open: the same finished chat opens after 30 s without input, as before.
// The page clock runs at normal speed (about 2 minutes for one dsh).
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-stay.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3219.
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

// Fake OpenAI-compatible model: "slow:<topic>" answers "Finished <topic>." after 4 s; the rest answers "Done.".
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const say = (t) => {
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Demo chat');
    if (/You predict the next message|You complete the message that the user is typing|label a coding task/.test(msgs.map((m) => textOf(m.content)).join('\n'))) return say('');
    const own = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t) => !/^<|^Current runtime context|^Time sampled/.test(t.trim()));
    const slow = own.at(-1)?.match(/slow:(\w+)/)?.[1];
    if (slow) { setTimeout(() => say(`Finished ${slow}.`), 4000); return; }
    say('Done.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-stay-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-stay-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3219', '--no-open'], { cwd: project,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const send = async (text) => { await input.click(); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      const newChat = async () => {
        await page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first().hover();
        await page.getByRole('button', { name: 'New session in acme-web', exact: true }).click(); await pause(800);
      };
      const finished = () => page.getByText('Finished lint.', { exact: true }).first().isVisible().catch(() => false);
      const assistantRow = page.locator('button[aria-label="Assistant"]');
      await assistantRow.waitFor({ timeout: 10000 });

      // 1. A chat finishes while the Assistant chat is open.
      await newChat(); await send('slow:lint'); await pause(500);
      await assistantRow.click();
      const assistantId = await until(() => page.evaluate(async () => { const r = await fetch('/api/composer-plus.assistant'); return r.ok ? (await r.json()).sessionId : undefined; }), 'assistant chat id');
      const assistantOpen = () => page.locator(`[data-row-key="session:${assistantId}"][aria-selected="true"]`).count().then((n) => n > 0);
      await until(assistantOpen, 'the Assistant chat is open');
      await page.waitForFunction(() => document.querySelectorAll('[data-state="done"]').length >= 1, null, { timeout: 20000 });
      await page.mouse.move(5, 5);
      await pause(40000);
      assert.equal(await finished(), false, 'the finished chat did not open');
      assert.equal(await assistantOpen(), true, 'the Assistant chat stays open after 40 s without input');
      assert.ok(await page.locator('[data-state="done"]').count() >= 1, 'the finished chat keeps its green dot');
      console.log(`dsh ${version}\n  1: the Assistant chat stayed open for 40 s without input while another chat finished`);

      // 2. A normal chat is open: the finished chat opens after 30 s without input.
      await newChat(); await send('Plan the docs'); await page.getByText('Done.', { exact: true }).first().waitFor({ timeout: 20000 });
      await page.mouse.move(30, 30);
      const from = Date.now();
      await until(finished, 'the finished chat opens from a normal chat', 45000);
      const idle = (Date.now() - from) / 1000;
      assert.ok(idle >= 29, `not before 30 s without input (${idle} s)`);
      console.log(`  2: from a normal chat, the finished chat opened after ${idle.toFixed(1)} s without input`);
      assert.deepEqual(errors, [], 'no page errors');
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
