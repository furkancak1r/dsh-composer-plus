// Real-app check of "Queue drag-and-drop" with a slow fake model, on each dsh given. No real model, never the normal
// DSH_HOME. A turn runs; three messages wait in the queue; the grip of the third row is dragged above the first with the
// mouse. Expected: grips show, the drag moves the texts (dsh's own queue rows), and nothing is lost.
// PLAYWRIGHT=/path/to/playwright node test/browser-queue-drag.mjs /path/to/dsh/lib/bin.js [...]
// EXTRA=/path/to/pluginA,/path/to/pluginB also loads those plugin folders (by their package name), as a user profile can.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model: the first answer takes 60 s (so messages queue), later answers are fast.
let slow = true;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const last = (JSON.parse(body).messages ?? []).at(-1);
    const title = /session title/i.test(JSON.stringify(last?.content));
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // A real run streams all the time: one token every 150 ms for 90 s, so the chat redraws during the drag.
    if (!title && slow) { slow = false; res.write(chunk({ role: 'assistant', content: 'Working' })); for (let i = 0; i < 600 && !res.destroyed; i++) { res.write(chunk({ content: ' .' })); await pause(150); } }
    res.end(chunk({ role: 'assistant', content: title ? 'Queue test' : 'Done.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
const failures = [];
try {
  for (const bin of process.argv.slice(2)) {
    slow = true;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-queue-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    const extra = (process.env.EXTRA ?? '').split(',').filter(Boolean).map((dir) => ({ dir, name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name }));
    for (const { dir, name } of extra) { await mkdir(join(profile, 'node_modules', dirname(name)), { recursive: true }); await symlink(dir, join(profile, 'node_modules', name)); }
    // BUNDLES=a,b adds built-in dsh bundles (the owner's desktop profile has @deepseek-ai/dsh-experimental-auto-review).
    const builtins = (process.env.BUNDLES ?? '').split(',').filter(Boolean);
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'queue-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...builtins, ...extra.map((e) => e.name), 'dsh-composer-plus'] } } }));
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
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 1000, input: [ text, image ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    const port = 3195;
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
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
      const send = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); await pause(700); };
      await send('Start a long task');
      await page.waitForFunction(() => document.body.innerText.includes('Working'), null, { timeout: 20000 });
      const report0 = {};
      const attachImage = async () => {
        // dsh's own attach input (the + button's file picker), with a 16x16 PNG
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGPUqDjBQApgIkk1w6gG4gATkergYFQDMYDkUAIAf1wBiN9Wj5AAAAAASUVORK5CYII=', 'base64');
        const files = page.locator('input[type=file]');
        report0.fileInputs = await files.count();
        if (report0.fileInputs) await files.first().setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
        await pause(1500);
      };
      // IMAGE=1: the second queued message has an image, as in the owner's queue (an image row between text rows).
      for (const t of ['first queued', 'second queued', 'third queued', 'fourth queued']) { if (process.env.IMAGE && t.startsWith('second')) await attachImage(); await send(t); }
      if (process.env.DEBUG_SHOT) await page.screenshot({ path: process.env.DEBUG_SHOT });
      const dock = page.locator('[data-queue-dock]'); await dock.waitFor({ timeout: 10000 });
      // dsh folds a queue of 2 or more under a count header: open it as a user would.
      const header = dock.locator('button[aria-expanded]');
      const hasHeader = await header.count();
      const expanded0 = hasHeader ? await header.getAttribute('aria-expanded') : 'none';
      if (hasHeader && expanded0 === 'false') { await header.click(); await pause(400); }
      const texts = () => dock.locator('li:not([data-submission-echo])').allInnerTexts();
      const before = await texts();
      const grips = dock.locator('[data-queue-grip] button');
      const gripCount = await grips.count();
      const report = { ...report0, bin, header: hasHeader > 0, expanded0, rows: before.map((t) => t.trim().split('\n')[0]), grips: gripCount };
      // Drag row `from` to the top or the bottom with the mouse, in small steps like a hand.
      const drag = async (from, toTop) => {
        const g = await grips.nth(from).boundingBox();
        const rowsBox = await dock.locator('li:not([data-submission-echo])').evaluateAll((lis) => lis.map((li) => { const r = li.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
        const y = toTop ? rowsBox[0].top + 3 : rowsBox.at(-1).bottom - 3;
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 15; i++) { await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + (y - g.y - g.height / 2) * i / 15); await pause(40); }
        const mark = await page.evaluate(() => [...document.querySelectorAll('[data-queue-dock] li')].map((li) => `${li.style.opacity || '-'}/${li.style.boxShadow ? 'line' : '-'}`));
        await page.mouse.up();
        await pause(3000);
        return { mark, after: (await texts()).map((t) => t.trim().split('\n')[0]) };
      };
      if (gripCount >= 3) {
        report.gripDisabled = await grips.nth(2).isDisabled();
        report.up = await drag(2, true);
        report.after = report.up.after;
        report.down = await drag(0, false);
      }
      report.errors = errors.slice(0, 5);
      console.log(JSON.stringify(report, null, 1));
      // Up: third goes first. Down: the first row (now third) goes last. With IMAGE=1 the image row is in that range.
      const ok = report.grips >= 3 && report.up?.after?.[0]?.startsWith('third queued') && report.down?.after?.at(-1)?.startsWith('third queued')
        && report.down.after.length === report.rows.length;
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
