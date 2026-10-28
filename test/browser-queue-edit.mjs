// Real-app check of "Edit queued message in place" with images and files, on each dsh given (fake model, throwaway
// DSH_HOME, headless; never the normal DSH_HOME). A slow turn runs; three messages wait in the queue, the second with an
// image and a text file. Steps:
// 1. The second row's Edit button works (dsh's own Edit is off for a row with attachments). The editor shows the text and
//    two chips. A grip drag and a grip ↑ key do nothing while it is open.
// 2. Remove the image, add a new PNG and a new text file, change the text, press Enter: the row keeps its place, shows
//    the old file, the new image and the new file, and the new text.
// 3. A double-click on the third row opens the editor; Esc keeps the text.
// 4. The slow turn stops; the queued messages run. The model request of the edited message has the new text, the new
//    image (`data:image/png`) and both files, and not the removed image.
// PLAYWRIGHT=/path/to/playwright node test/browser-queue-edit.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/queueEdit.webp (English UI, demo project only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 16x16 PNGs: red (the first image) and blue (the new one).
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4o6FBEmIY1TCqYfhqAAAyBCwQhvh37QAAAABJRU5ErkJggg==', 'base64');
const BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPQiLpDEmIY1TCqYfhqAABeaV4QTcmYsgAAAABJRU5ErkJggg==', 'base64');

// Fake model: "Slow task" streams until the test stops it; every request is kept, to read what the model got.
let slowOpen = null;
const requests = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (/session title/i.test(JSON.stringify(last?.content))) { res.end(chunk({ role: 'assistant', content: 'Demo chat' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); return; }
    requests.push(msgs);
    const users = msgs.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    if (users.some((u) => u.includes('Slow task')) && !users.some((u) => u.includes('queued')) && slowOpen === null) {
      slowOpen = res; res.write(chunk({ role: 'assistant', content: 'Working' }));
      for (let i = 0; i < 600 && !res.destroyed && slowOpen === res; i++) { res.write(chunk({ content: ' .' })); await pause(150); }
      slowOpen = null; res.end(chunk({}, 'stop') + 'data: [DONE]\n\n'); return;
    }
    res.end(chunk({ role: 'assistant', content: 'Done.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
const failures = [];
try {
  for (const bin of process.argv.slice(2)) {
    requests.length = 0; slowOpen = null;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-qedit-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'qedit-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3209', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const steps = []; let context;
    const step = (name) => { steps.push(name); console.log(`  ${name}`); };
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})\n${log}`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
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
      const send = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); await pause(900); };
      await send('Slow task');
      await page.waitForFunction(() => document.body.innerText.includes('Working'), null, { timeout: 20000 });
      // The composer's own file picker: the second queued message gets an image and a text file.
      const files = page.locator('[data-composer-seat] input[type=file]').first();
      await send('first queued');
      await files.setInputFiles([{ name: 'red.png', mimeType: 'image/png', buffer: RED }, { name: 'spec.txt', mimeType: 'text/plain', buffer: Buffer.from('old spec\n') }]);
      await input.click(); await page.keyboard.type('second queued');
      // dsh refuses Enter until the file upload ends ("still uploading"): wait for its send button.
      await page.waitForFunction(() => { const b = document.querySelector('[data-composer-seat] button[aria-label^="Queue"], [data-composer-seat] button[aria-label^="Send"]'); return b !== null && !b.disabled; }, null, { timeout: 15000 });
      await page.keyboard.press('Enter'); await pause(900);
      await send('third queued');
      const dock = page.locator('[data-queue-dock]'); await dock.waitFor({ timeout: 10000 });
      const header = dock.locator('button[aria-expanded="false"]'); if (await header.count()) { await header.first().click(); await pause(400); }
      const rows = dock.locator('li:not([data-submission-echo])');
      await page.waitForFunction(() => document.querySelectorAll('[data-queue-dock] li:not([data-submission-echo])').length === 3, null, { timeout: 10000 })
        .catch(async (error) => { console.log('dock:', JSON.stringify(await dock.evaluate((d) => d.innerText)), 'debug shot:', process.env.DEBUG_SHOT ?? '-'); if (process.env.DEBUG_SHOT) await page.screenshot({ path: process.env.DEBUG_SHOT }); throw error; });
      const texts = async () => (await rows.evaluateAll((lis) => lis.map((li) => li.innerText.replace(/\s+/g, ' ').trim())));
      const before = await texts();
      assert.ok(before[1].includes('second queued') && before[1].includes('spec.txt'), `the second row has the file: ${before[1]}`);
      // 1. dsh's own Edit is hidden; the plugin's Edit works on the row with attachments.
      const editBtn = rows.nth(1).locator('[data-composer-plus-queue-edit-button] button');
      assert.equal(await editBtn.isDisabled(), false, 'Edit works on a row with attachments');
      assert.equal(await rows.nth(1).locator('[data-composer-plus-native-edit]').isVisible(), false, 'dsh\'s own Edit is hidden');
      await editBtn.click();
      const editor = dock.locator('[data-composer-plus-queue-editor]'); await editor.waitFor({ timeout: 5000 });
      const area = editor.locator('textarea');
      assert.equal(await area.inputValue(), 'second queued');
      assert.equal(await editor.locator('.cp-qe-chip').count(), 2, 'two attachment chips');
      await editor.locator('.cp-qe-chip img').waitFor({ timeout: 5000 }); // the kept image's thumbnail loads from dsh
      // The grips are off while it is open; a drag and a key move do nothing.
      const grips = dock.locator('[data-queue-grip] button');
      const gripStates = await grips.evaluateAll((list) => list.map((b) => b.disabled));
      assert.ok(gripStates.length >= 2 && gripStates.every(Boolean), `the grips are off while a message is open for editing: ${JSON.stringify(gripStates)}`);
      // Called anyway (a key on a focused grip, a pointer down): the queue stays.
      await grips.last().dispatchEvent('keydown', { key: 'ArrowUp', bubbles: true });
      const box = await grips.last().boundingBox();
      if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x, box.y - 60, { steps: 8 }); await page.mouse.up(); }
      await pause(800);
      assert.equal(await page.evaluate(() => document.querySelector('[data-queue-drag-slot]') !== null), false, 'no drag');
      assert.equal(await editor.count(), 1, 'the editor stays open');
      step('Edit button on a row with attachments; the queue does not move while it is open');
      // 2. Remove the image, add a new image and a new file, change the text, Enter.
      await editor.getByRole('button', { name: /^Remove red\.png$|^Remove Image$/ }).click();
      assert.equal(await editor.locator('.cp-qe-chip').count(), 1);
      await editor.locator('input[type=file]').setInputFiles([{ name: 'blue.png', mimeType: 'image/png', buffer: BLUE }, { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# new notes\n') }]);
      await page.waitForFunction(() => document.querySelectorAll('[data-composer-plus-queue-editor] .cp-qe-chip').length === 3, null, { timeout: 5000 });
      await area.fill('second, with a blue image');
      if (process.env.SHOT) {
        await page.waitForFunction(() => ![...document.querySelectorAll('[data-composer-plus-queue-editor] .cp-qe-chip small')].length, null, { timeout: 10000 });
        await pause(300); const b = await dock.boundingBox(); const shot = join(home, 'queue.png');
        await page.screenshot({ path: shot, clip: { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 } });
        execFileSync('cwebp', ['-q', '80', shot, '-o', join(repo, 'assets/features/queueEdit.webp')], { stdio: 'ignore' });
      }
      const save = editor.getByRole('button', { name: 'Save queued message' });
      await page.waitForFunction(() => { const b = [...document.querySelectorAll('[data-composer-plus-queue-editor] button')].find((x) => x.getAttribute('aria-label') === 'Save queued message'); return b && !b.disabled; }, null, { timeout: 10000 });
      assert.ok(save);
      await area.press('Enter');
      await editor.waitFor({ state: 'detached', timeout: 10000 });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-queue-dock] li')].some((li) => li.innerText.includes('second, with a blue image')), null, { timeout: 10000 });
      const after = await texts();
      assert.equal(after.length, 3); assert.ok(after[0].startsWith('first queued') && after[2].startsWith('third queued'), `the order stays: ${JSON.stringify(after)}`);
      assert.ok(after[1].includes('spec.txt') && after[1].includes('notes.md'), `old and new file: ${after[1]}`);
      assert.equal(await rows.nth(1).locator('img').count(), 1, 'one image: the new one');
      step('Remove an image, add an image and a file, change the text: saved in place');
      // 3. Double-click the third row; Esc keeps it.
      await rows.nth(2).getByText('third queued').dblclick(); await editor.waitFor({ timeout: 5000 });
      await page.keyboard.type(' nope'); await page.keyboard.press('Escape'); await editor.waitFor({ state: 'detached', timeout: 5000 });
      assert.ok((await texts())[2].startsWith('third queued') && !(await texts())[2].includes('nope'), 'Esc keeps it');
      step('Double-click opens the editor; Esc cancels');
      // 4. The slow turn ends normally (dsh keeps the queue after a Stop): the queue runs. The edited message reaches the
      // model with its new parts.
      slowOpen = null; // the stream loop sees this and finishes the answer
      await page.waitForFunction(() => document.querySelector('[data-queue-dock]') === null, null, { timeout: 60000 })
        .catch(async (error) => { if (process.env.DEBUG_SHOT) await page.screenshot({ path: process.env.DEBUG_SHOT }); console.log('requests:', requests.length, 'dock:', JSON.stringify(await dock.evaluate((d) => d.innerText).catch(() => null))); throw error; });
      await pause(1500);
      const all = requests.map((msgs) => JSON.stringify(msgs));
      const edited = all.find((m) => m.includes('second, with a blue image'));
      assert.ok(edited, 'the model got the edited message');
      const lastUser = JSON.parse(edited).filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content)).find((c) => c.includes('second, with a blue image'));
      assert.match(lastUser, /data:image\/png;base64,/, 'the new image reaches the model');
      assert.match(lastUser, /spec\.txt/, 'the kept file reaches the model'); assert.match(lastUser, /notes\.md/, 'the new file reaches the model');
      assert.equal((lastUser.match(/data:image\//g) ?? []).length, 1, 'only one image: the removed one is gone');
      assert.ok(!all.some((m) => m.includes('second queued')), 'the old text never reached the model');
      step('The model gets the edited message: new text, the new image, the old and the new file');
      assert.deepEqual(errors.filter((e) => !/favicon|ERR_ABORTED|net::/.test(e)), [], 'no page errors');
      console.log('PASS', bin);
    } catch (error) {
      failures.push(bin); console.log('FAIL', bin, steps.length, 'steps passed'); console.log(error); console.log(errors.slice(0, 5));
    } finally {
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await pause(1500); if (child.exitCode === null) child.kill('SIGKILL');
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }
} finally { await browser.close(); fake.close(); }
if (failures.length) { console.log('failed:', failures.join(', ')); process.exitCode = 1; }
