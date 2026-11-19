// Real-app check of Turn rollback in the Damon (Assistant) chat, headless, on each dsh given: a fake model, a throwaway
// DSH_HOME and HOME, no real model. 2026-11-19: Furkan could not roll back a message in Damon. Assistant always free sends
// each message that you type while Damon works into the running turn (dsh's steer), and dsh draws it as a `steering` row:
// ↶ was put only on `user` rows, so that message had no ↶.
// 1. Damon: "first note" → reply. "SLOW job" holds the model; "steer note" typed meanwhile goes into that turn (a
//    `steering` row). Every message of yours, the steering one too, has ↶ (Roll back to before this message) and 🔗.
// 2. ↶ on the steering message → Chat only: it and everything after it leave the chat, the earlier messages stay, the
//    composer holds "steer note" again, and the next model request does not have it.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-rollback.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3298.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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
const own = (t) => !/^<|^Current runtime context|^Time sampled/.test(t.trim());
// Fake model: "SLOW" holds its answer until the test lets it go; any other message gets "reply to <message>".
const requests = []; let release = null;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const say = (t) => {
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const all = msgs.map((m) => textOf(m.content)).join('\n');
    if (/session title/i.test(textOf(msgs.at(-1)?.content)) || /You predict the next message|You complete the message that the user is typing|label a coding task/.test(all)) return say('Demo');
    const users = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter(own);
    requests.push(users);
    const newest = users.at(-1) ?? '';
    if (newest.startsWith('SLOW')) { release = () => say('slow done'); return; }
    say(`reply to ${newest}`);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    requests.length = 0; release = null;
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-rollback-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-rollback-check', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3298', '--no-open'], { cwd: home,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false,"typingCompletion":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await page.locator('button[aria-label="Damon"]').click();
      const damon = await until(async () => { const r = await page.evaluate(async () => (await fetch('/api/composer-plus.assistant')).json()); return r?.sessionId; }, 'the Damon chat id');
      const chat = page.locator(`[data-conversation-session="${damon}"]`);
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const send = async (text) => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      // Only the chat's rows (the composer holds the rolled-back text again).
      const flow = chat.locator('[data-chat-flow]');
      const shown = (text) => flow.getByText(text, { exact: true }).filter({ visible: true });
      const visibleRows = () => flow.locator('[data-chat-flow-kind]').evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => `${el.dataset.chatFlowKind}: ${el.innerText.split('\n')[0]}`));
      // 1. A plain message, then a message typed while Damon works: it goes into the running turn.
      await send('first note'); await shown('reply to first note').first().waitFor({ timeout: 30000 });
      await send('SLOW job'); await until(() => release !== null, 'the slow turn runs');
      await send('steer note');
      // dsh shows it as a pending steer until the running turn takes it at its next step (after the held answer); then it
      // is a `steering` row.
      await chat.locator('[data-pending-steering]').filter({ hasText: 'steer note' }).first().waitFor({ timeout: 15000 });
      release(); await shown('reply to steer note').first().waitFor({ timeout: 30000 });
      const steering = chat.locator('[data-chat-flow-kind="steering"]').filter({ hasText: 'steer note' });
      await steering.waitFor({ timeout: 15000 });
      const want = [{ kind: 'user', text: 'first note', rollback: true, link: true }, { kind: 'user', text: 'SLOW job', rollback: true, link: true }, { kind: 'steering', text: 'steer note', rollback: true, link: true }];
      const readRows = () => chat.locator('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]').evaluateAll((els) => els.map((el) => ({
        kind: el.dataset.chatFlowKind, text: el.innerText.split('\n')[0], rollback: el.querySelector('button[aria-label="Roll back to before this message"]') !== null,
        link: el.querySelector('[data-composer-plus-message-link]') !== null })));
      let rows = [];
      await until(async () => { rows = await readRows(); return JSON.stringify(rows) === JSON.stringify(want); }, 'the rows get their buttons', 10000).catch(() => {});
      assert.deepEqual(rows, want, `dsh ${version}: every message of yours has ↶ and 🔗, the steering one too: ${JSON.stringify(rows)}`);
      // 2. ↶ on the steering message → Chat only.
      await steering.hover();
      await steering.getByRole('button', { name: 'Roll back to before this message' }).click();
      const pop = page.locator('[data-composer-plus-rollback]');
      await pop.getByRole('button', { name: /^Chat only/ }).click();
      await pop.waitFor({ state: 'detached', timeout: 20000 });
      await page.waitForFunction(() => (document.querySelector('[data-composer-input]')?.innerText ?? '').trim() === 'steer note', null, { timeout: 10000 });
      await until(async () => (await shown('steer note').count()) === 0 && (await shown('reply to steer note').count()) === 0, 'the withdrawn rows leave the chat', 10000)
        .catch(async (error) => { throw Error(`${error.message}: ${JSON.stringify(await visibleRows())}`); });
      assert.equal(await shown('first note').count(), 1, 'the earlier message stays');
      assert.equal(await shown('SLOW job').count(), 1, 'the message before the steering one stays');
      await send('after rollback'); await shown('reply to after rollback').first().waitFor({ timeout: 30000 });
      const sent = requests.at(-1);
      assert.ok(sent.includes('after rollback') && sent.includes('first note') && !sent.includes('steer note'), `the model no longer sees the withdrawn message: ${JSON.stringify(sent)}`);
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}: ↶ on each Damon message (also the steering one); rollback of the steering message hides it and what came after, refills the composer, the model no longer sees it`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); fake.close(); }
