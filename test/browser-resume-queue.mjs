// Real-app check of "Resume after restart" with a queue, on each dsh given: a fake model, a throwaway DSH_HOME, a real quit
// (SIGTERM) and a real start of the same profile. Never the normal DSH_HOME and no real model.
// 1. Switch on. A turn runs (the model hangs). Four messages wait in the queue: text, image + text, file + text, text.
//    Drag the fourth to the top (Queue drag-and-drop) and edit the old first one in place (Edit queued message in place).
// 2. Quit dsh while the turn runs. Start dsh again, no click. Expected: the continued request has only the hidden continue
//    note; the queue shows the same four rows in the same order (no empty row); then each queued message runs in its own
//    request, in that order, with its image or file.
// PLAYWRIGHT=/path/to/playwright node test/browser-resume-queue.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
};

const TASK = 'Rename the config loader';
const NOTE = 'Continue the task from where it stopped';
const Q = { alpha: 'alpha queued', edited: 'alpha, edited', bravo: 'bravo queued', charlie: 'charlie queued', delta: 'delta queued' };
// Fake OpenAI-compatible model: titles at once; the first task request hangs (so messages queue and the quit cuts a running
// turn); the continue request answers after 10 s (time to look at the queue after the start); the rest after 1 s. Each
// request records which texts, images and files its new user messages hold.
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
    if (JSON.stringify(msgs.at(-1)?.content ?? '').includes('Recent conversation:')) { answer(''); return; } // Composer Plus prediction
    const lastAssistant = msgs.findLastIndex((m) => m.role === 'assistant');
    const added = msgs.slice(lastAssistant + 1).filter((m) => m.role === 'user' && !/Current runtime context|Time sampled while preparing/.test(JSON.stringify(m.content)));
    const text = JSON.stringify(added.map((m) => m.content));
    const r = { note: text.includes(NOTE), task: text.includes(TASK), images: added.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length, file: text.includes('notes.txt') };
    for (const [k, v] of Object.entries(Q)) if (text.includes(v)) r[k] = true;
    requests.push(r);
    if (hang) { hang = false; res.write(chunk({ role: 'assistant', content: 'Working' })); const t = setTimeout(() => answer(' done.'), 120000); res.on('close', () => clearTimeout(t)); return; }
    const t = setTimeout(() => answer(r.note ? 'Continued: the loader is renamed.' : 'Queued task done.'), r.note ? 10000 : 1000);
    res.on('close', () => clearTimeout(t));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
const failures = [];
try {
  for (const bin of process.argv.slice(2)) {
    requests = []; hang = true;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-resume-queue-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'resume-queue-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const logs = []; const errors = []; const contexts = []; let child; let passed = false;
    const report = { bin };
    const start = async () => {
      child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3211', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = ''; logs.push(() => log); child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available'); return url;
    };
    const quit = async () => {
      for (const context of contexts.splice(0)) await context.close().catch(() => {});
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM'); // the same shutdown as quitting the desktop app
      await Promise.race([exited, pause(15000)]); assert.notEqual(child.exitCode, null, 'dsh quit');
    };
    const open = async (url) => {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } }); contexts.push(context);
      await context.addInitScript(() => localStorage.setItem('dsh-composer-plus.features', JSON.stringify({ autoUpdate: false })));
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      await page.locator('[data-composer-input]').waitFor();
      return page;
    };
    const dockOf = (page) => page.locator('[data-queue-dock]');
    const expand = async (page) => { const h = dockOf(page).locator('button[aria-expanded="false"]'); if (await h.count()) { await h.first().click(); await pause(400); } };
    // Each queued row: its first text line and whether it shows an image or a file.
    const rows = (page) => dockOf(page).locator('li:not([data-submission-echo])').evaluateAll((lis) => lis.map((li) => ({
      text: li.innerText.trim().split('\n').find((l) => /queued|edited/.test(l)) ?? li.innerText.trim().split('\n')[0],
      image: li.querySelector('img') !== null, file: li.innerText.includes('notes.txt') }))).catch(() => []);
    try {
      // Run 1: switch on; a running turn; a queue of four; drag and edit.
      let page = await open(await start());
      await openSettings(page);
      await page.getByText('Composer Plus', { exact: true }).click();
      const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name: 'Resume after restart' });
      await sw.waitFor(); if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
      for (let i = 0; i < 40 && !(await readFile(join(home, 'storages/dsh-composer-plus/resume.json'), 'utf8').catch(() => '')).includes('"on":true'); i++) await pause(250);
      await page.keyboard.press('Escape'); await pause(400);
      const input = page.locator('[data-composer-input]');
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
      const send = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); await pause(700); };
      const attach = async (name, mimeType, buffer) => { await page.locator('input[type=file]').first().setInputFiles({ name, mimeType, buffer }); await pause(1500); };
      await send(TASK);
      await page.waitForFunction(() => document.body.innerText.includes('Working'), null, { timeout: 20000 });
      await send(Q.alpha);
      await attach('dot.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGPUqDjBQApgIkk1w6gG4gATkergYFQDMYDkUAIAf1wBiN9Wj5AAAAAASUVORK5CYII=', 'base64'));
      await send(Q.bravo);
      await attach('notes.txt', 'text/plain', Buffer.from('demo notes\n'));
      await send(Q.charlie);
      await send(Q.delta);
      await dockOf(page).waitFor({ timeout: 10000 }); await expand(page);
      report.queued = await rows(page);
      // Drag the fourth row to the top, like a hand.
      const grips = dockOf(page).locator('[data-queue-grip] button');
      const g = await grips.nth(3).boundingBox();
      const top = await dockOf(page).locator('li:not([data-submission-echo])').first().boundingBox();
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
      for (let i = 1; i <= 15; i++) { await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + (top.y + 3 - g.y - g.height / 2) * i / 15); await pause(40); }
      await pause(250); await page.mouse.up(); await pause(2500);
      report.dragged = await rows(page);
      // Edit the old first row in place.
      await dockOf(page).getByText(Q.alpha, { exact: true }).dblclick();
      const editor = dockOf(page).locator('textarea'); await editor.waitFor({ timeout: 5000 });
      await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.type(Q.edited); await page.keyboard.press('Enter');
      await editor.waitFor({ state: 'detached', timeout: 5000 }); await pause(1500);
      report.before = await rows(page);
      const want = [Q.delta, Q.edited, Q.bravo, Q.charlie];
      assert.deepEqual(report.before.map((r) => r.text), want, `drag and edit worked before the quit (${JSON.stringify(report)})`);
      const saved = JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/resume.json'), 'utf8'));
      assert.equal(saved.sessions.length, 1, 'the running chat is listed');
      const requestsBefore = requests.length;
      await quit();
      // Run 2: start; no click.
      const url2 = await start();
      for (let i = 0; i < 120 && !requests.slice(requestsBefore).some((r) => r.note); i++) await pause(250);
      page = await open(url2);
      await page.locator('[data-row-key^="session:"]').filter({ hasText: 'Queue test' }).first().click();
      await dockOf(page).waitFor({ timeout: 10000 }).catch(() => {}); await expand(page);
      report.afterStart = await rows(page);
      for (let i = 0; i < 160 && requests.length < requestsBefore + 5; i++) await pause(250);
      await pause(3000);
      report.requests = requests.slice(requestsBefore);
      report.rowsEnd = await rows(page);
      report.errors = errors.slice(0, 5);
      console.log(JSON.stringify(report, null, 1));
      const [cont, ...rest] = report.requests;
      const only = (r, key) => r !== undefined && Object.keys(Q).every((k) => (k === key) === (r[k] === true));
      const ok = cont?.note === true && Object.keys(Q).every((k) => cont[k] !== true)
        && JSON.stringify(report.afterStart.map((r) => r.text)) === JSON.stringify(want)
        && report.afterStart[2]?.image === true && report.afterStart[3]?.file === true
        && rest.length === 4 && only(rest[0], 'delta') && only(rest[1], 'edited') && only(rest[2], 'bravo') && only(rest[3], 'charlie')
        && rest[2].images === 1 && rest[3].file === true && rest.every((r) => !r.note)
        && report.rowsEnd.length === 0 && errors.length === 0;
      if (!ok) failures.push(bin);
      passed = ok;
      console.log(ok ? 'PASS' : 'FAIL', bin);
    } catch (error) {
      failures.push(bin);
      console.error(`kept for inspection: ${home}; report: ${JSON.stringify(report)}; requests: ${JSON.stringify(requests)}; page errors: ${JSON.stringify(errors)}`);
      console.error(error);
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      await writeFile(join(home, 'server.log'), logs.map((l) => l()).join('\n----- restart -----\n')); // tokens stay in the temp home
      if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
      else console.log(`home kept: ${home}`);
    }
  }
} finally { await browser.close(); fake.close(); }
if (failures.length) { console.log('failed:', failures.join(', ')); process.exitCode = 1; }
