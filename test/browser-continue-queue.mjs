// Real-app check of issue #3 with a fake model, on each dsh given. No real model, never the normal DSH_HOME.
// A turn runs; one message waits in the queue; dsh's Stop; then Composer Plus ▶ (One-click Continue). Expected: the
// continued request has the continue note and not the queued text; the queue row stays and no empty row shows; when the
// continued turn ends, the queued message runs in its own request.
// PLAYWRIGHT=/path/to/playwright node test/browser-continue-queue.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TASK = 'Rename the config loader';
const QUEUED = 'Fix the footer bug later';
const NOTE = 'Continue the task from where it stopped';
// Fake OpenAI-compatible model: titles at once; the first task request hangs (so a message queues and Stop has a turn to
// stop); every later request answers in 1.5 s. Each request records which texts its user messages hold.
let requests = [];
let hang = true;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = (text) => res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    if (/session title/i.test(JSON.stringify(msgs.at(-1)?.content ?? ''))) { answer('Queue test'); return; }
    // Composer Plus' own next message prediction (on by default) is not a chat turn.
    if (JSON.stringify(msgs.at(-1)?.content ?? '').includes('Recent conversation:')) { answer(''); return; }
    // The user messages after the newest assistant message: what this step added.
    const lastAssistant = msgs.findLastIndex((m) => m.role === 'assistant');
    const added = JSON.stringify(msgs.slice(lastAssistant + 1).filter((m) => m.role === 'user').map((m) => m.content));
    requests.push({ note: added.includes(NOTE), queued: added.includes(QUEUED), task: added.includes(TASK) });
    if (hang) { hang = false; res.write(chunk({ role: 'assistant', content: 'Working' })); const t = setTimeout(() => answer(' done.'), 120000); res.on('close', () => clearTimeout(t)); return; }
    setTimeout(() => answer(added.includes(NOTE) ? 'Continued: the loader is renamed.' : 'Footer fixed.'), 1500);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
const failures = [];
try {
  for (const bin of process.argv.slice(2)) {
    requests = []; hang = true;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-continue-queue-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'continue-queue-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const port = 3196;
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', String(port), '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = [];
    let context;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
      await context.addInitScript(() => localStorage.setItem('dsh-composer-plus.features', JSON.stringify({ autoUpdate: false })));
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
      const send = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); await pause(700); };
      await send(TASK);
      await page.waitForFunction(() => document.body.innerText.includes('Working'), null, { timeout: 20000 });
      await send(QUEUED);
      const dock = page.locator('[data-queue-dock]'); await dock.waitFor({ timeout: 10000 });
      const rows = () => dock.locator('li:not([data-submission-echo])').allInnerTexts().catch(() => []);
      const report = { bin, queuedBefore: await rows() };
      // dsh's own Stop: the turn ends as aborted and the queue waits (keepInbox).
      await page.getByRole('button', { name: /^Stop/ }).first().click();
      const play = page.getByRole('button', { name: 'Continue', exact: true });
      await play.waitFor({ timeout: 15000 });
      await pause(800);
      report.afterStop = { requests: requests.length, rows: await rows() };
      await play.click();
      // Right after the click: the queued row is still there, and no empty row joined it.
      await pause(400);
      report.afterClick = await rows();
      for (let i = 0; i < 60 && requests.length < 3; i++) await pause(250);
      await pause(2500);
      report.requests = requests;
      report.rowsEnd = await rows();
      report.chat = await page.evaluate(() => document.body.innerText.includes('Footer fixed.'));
      report.errors = errors.slice(0, 5);
      console.log(JSON.stringify(report, null, 1));
      const [first, continued, next] = requests;
      const ok = first?.task === true && report.afterStop.requests === 1
        && report.queuedBefore.some((t) => t.includes(QUEUED))
        && continued?.note === true && continued.queued === false
        && report.afterClick.length === 1 && report.afterClick[0].includes(QUEUED)
        && next?.queued === true && next.note === false && requests.length === 3
        && report.rowsEnd.length === 0 && report.chat && errors.length === 0;
      if (!ok) failures.push(bin);
      console.log(ok ? 'PASS' : 'FAIL', bin);
    } finally {
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await pause(1500); if (child.exitCode === null) child.kill('SIGKILL');
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }
} finally { await browser.close(); fake.close(); }
if (failures.length) { console.log('failed:', failures.join(', ')); process.exitCode = 1; }
