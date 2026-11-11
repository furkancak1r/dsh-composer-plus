// Real-app check of "Resume after an AIProxy outage" on each dsh given: a throwaway DSH_HOME and HOME, a made-up project
// (acme-web), and a fake provider named "aiproxy" whose /health and model calls can go down. Never the normal DSH_HOME,
// never the real AIProxy (COMPOSER_PLUS_HEALTH_URL points at the fake). Headless.
// 1. Settings: the row is on by default and has its screenshot.
// 2. Two chats run a slow turn (one already streams). The fake goes down: the running requests end with AIProxy's
//    request_cancelled (a 499 answer, or an error inside the stream for the one that streams) and new
//    requests get a refused connection, so both turns fail. The fake comes back: after the settle time each chat gets one
//    "continue" message (the English UI text) and finishes. A third chat that you stopped gets nothing.
// 3. The Assistant chat's status panel lists the two chats that continued.
// PLAYWRIGHT=/path/to/playwright node test/browser-outage-resume.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/outageResume.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
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
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const NOTE = 'The turn stopped because of an AIProxy outage.';
const CHATS = ['Migrate the build to the new bundler', 'Write the API docs for the billing module'];
const STOPPED = 'Draft the weekly status report';

// The fake AIProxy. `down`: /health answers 503 and every request is refused at once (the socket closes); the requests
// that wait end with 499 request_cancelled when it goes down, as AIProxy's own shutdown does.
const state = { down: false, waiting: new Set(), notes: [], users: [] };
const fake = createServer((req, res) => {
  if (state.down) { req.socket.destroy(); return; }
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Demo chat');
    const all = msgs.map((m) => textOf(m.content)).join('\n');
    if (/You predict the next message|You complete the message that the user is typing|label a coding task/.test(all)) return say('');
    const own = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t) => !/^<|^Current runtime context|^Time sampled/.test(t.trim()));
    const newest = own.at(-1) ?? '';
    if (newest.startsWith(NOTE)) { state.notes.push(own.find((t) => CHATS.includes(t) || t === STOPPED)); return say('Continued: the migration plan is done.'); }
    if (CHATS.includes(newest) || newest === STOPPED) {
      state.users.push(newest);
      // A slow turn: it waits until the fake goes down (then 499) or the test ends.
      // The first chat already streams (AIProxy sent the headers): its cancel comes inside the stream, as AIProxy's shutdown
      // writes it (server.mjs, headersSent). The second one gets the plain 499 answer.
      const streaming = newest === CHATS[0];
      if (streaming) { res.writeHead(200, { 'content-type': 'text/event-stream' }); send({ role: 'assistant', content: 'Working on it' }); }
      const entry = { res, end: () => {
        if (streaming) { res.end(`data: ${JSON.stringify({ error: { code: 'request_cancelled', message: 'İstek iptal edildi.' } })}\n\n`); return; }
        res.writeHead(499, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'request_cancelled', message: 'İstek iptal edildi.' } }));
      } };
      state.waiting.add(entry); res.on('close', () => state.waiting.delete(entry));
      return undefined;
    }
    return say('ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const goDown = () => { state.down = true; for (const w of [...state.waiting]) w.end(); state.waiting.clear(); };

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
let shotDone = false;
try {
  for (const bin of process.argv.slice(2)) {
    Object.assign(state, { down: false, notes: [], users: [] });
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-outage-resume-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'outage-resume-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  config:
    providers:
      aiproxy:
        displayName: AIProxy
        api: openai-completions
        baseURL: http://127.0.0.1:${fakePort}/v1
        apiKeyEnv: DEMO_KEY
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: aiproxy, model: demo }
`);
    const dir = join(home, 'projects', 'acme-web'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'README.md'), '# acme-web\n');
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid }, tables: { workspaces: { [wid]: { path: dir, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3215', '--no-open'], { cwd: dir,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', TZ: 'Europe/Istanbul', COMPOSER_PLUS_HEALTH_URL: `http://127.0.0.1:${fakePort}/health`,
        npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
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
      const clear = async () => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.press('Escape'); };
      const send = async (text) => { await clear(); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      const newChat = async () => {
        const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first();
        await proj.hover(); await page.getByRole('button', { name: 'New session in acme-web', exact: true }).click(); await pause(800);
      };

      // 1. Settings.
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      const sw = page.getByRole('switch', { name: 'Resume after an AIProxy outage', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      assert.equal(await sw.locator('xpath=..').locator('[data-composer-plus-shot="outageResume"]').count(), 1, 'the row has its screenshot');
      await back();
      note('1: Settings row on by default, with its screenshot');

      // 2. Two chats run, one more is stopped by you; the fake goes down and comes back.
      for (const text of CHATS) { await newChat(); await send(text); await until(() => state.users.includes(text), `"${text}" reached the model`); }
      await newChat(); await send(STOPPED); await until(() => state.users.includes(STOPPED), 'the third chat runs');
      await page.getByRole('button', { name: /^Stop/ }).first().click();
      await until(() => !state.users.includes(STOPPED) || state.waiting.size === CHATS.length, 'the stopped request ended', 10000).catch(() => {});
      await pause(500);
      goDown();
      await pause(3000);
      state.down = false;
      await until(() => state.notes.length >= CHATS.length, 'both chats continued', 60000);
      await pause(3000);
      assert.deepEqual([...state.notes].sort(), [...CHATS].sort(), 'each failed chat continued once; the stopped chat did not');
      note('2: after the outage, each failed chat got one message and finished; the stopped chat got none');

      // 3. The Assistant chat's status panel lists them.
      await page.locator('button[aria-label="Damon"]').click(); // the assistant's fixed name (main, feat/fixed-damon-assistant-name)
      const line = page.locator('[data-composer-plus-outage]');
      await until(async () => (await line.count()) === 1 || (await page.getByRole('button', { name: 'Refresh', exact: true }).click().then(() => false, () => false)), 'the outage line', 30000);
      assert.match(await line.innerText(), /Continued after the AIProxy outage/);
      assert.equal(await line.getByRole('button').count(), CHATS.length, 'one link per continued chat');
      note('3: the status panel lists the continued chats');

      if (process.env.SHOT && !shotDone) {
        await page.mouse.move(640, 790);
        const png = join(home, 'outage.png');
        await page.screenshot({ path: png });
        execFileSync('cwebp', ['-quiet', '-q', '72', '-resize', '960', '0', png, '-o', join(repo, 'assets/features/outageResume.webp')]);
        shotDone = true; note('SHOT: assets/features/outageResume.webp');
      }
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}\n${log.split('\n').filter((l) => /error|warn|outage/i.test(l)).slice(-30).join('\n')}`);
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
