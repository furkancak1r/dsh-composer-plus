// Real-app check of "Next message prediction" with a fake model server, on each dsh given. No real model, never the
// normal DSH_HOME. Two fake providers (Demo: demo, Fast: mini + nano); dsh's default is Demo / demo.
// Checks: on by default (the first finished turn already shows a prediction from dsh's default model); Settings lists
// dsh's models with "dsh default (Demo model)" first; switched off, a finished turn makes no prediction call; on again,
// Tab puts the prediction in the composer, Esc hides it; a model chosen in Settings is the one the prediction calls; the
// chat itself never gets the prediction prompt.
// PLAYWRIGHT=/path/to/playwright node test/browser-predict.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/nextPrediction.webp (English UI, made-up chat). TR_SHOT=<dir> keeps a Turkish picture.
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

// Fake OpenAI-compatible server. A prediction request has the prediction system prompt; it answers with the model id in
// the text, so the check sees which model dsh called.
const seen = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"},{"id":"mini"},{"id":"nano"}]}'); return; }
    const parsed = JSON.parse(body);
    const all = JSON.stringify(parsed.messages);
    const kind = /next message that the user will type/.test(all) ? 'predict' : /session title/i.test(all) ? 'title' : 'chat';
    seen.push({ kind, model: parsed.model });
    const text = kind === 'predict' ? (parsed.model === 'demo' ? 'Now add tests for the login form.' : `Run the full test suite (${parsed.model}).`)
      : kind === 'title' ? 'Login page' : 'Done: the login page is in src/login.tsx and the route is /login.';
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    seen.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-predict-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'predict-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    const provider = (id, name, models) => `      ${id}:
        displayName: ${name}
        api: openai-completions
        baseURL: http://127.0.0.1:${fakePort}/v1
        apiKeyEnv: DEMO_KEY
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
${models.map(([mid, mname]) => `          - { id: ${mid}, name: ${mname}, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }`).join('\n')}`;
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  config:
    providers:
${provider('demo', 'Demo', [['demo', 'Demo model']])}
${provider('fast', 'Fast', [['mini', 'Mini'], ['nano', 'Nano']])}
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3196', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const contexts = []; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      const open = async (locale) => {
        const context = await browser.newContext({ locale, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' }); contexts.push(context);
        await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
        const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url);
        for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
          const b = page.getByRole('button', { name });
          if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
        }
        const close = page.getByRole('dialog', { name: /^(Get started|Başlayın)$/ }).getByRole('button', { name: /^(Close|Kapat)$/ });
        if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
        await page.locator('[data-composer-input]').waitFor();
        return page;
      };
      const page = await open('en-US');
      const input = page.locator('[data-composer-input]');
      const prediction = page.locator('[data-composer-plus-prediction]');
      const send = async (p, text) => { await p.locator('[data-composer-input]').click(); await p.keyboard.type(text); await p.keyboard.press('Enter'); };
      const turnDone = async (p, count) => p.waitForFunction((n) => (document.body.innerText.match(/Done: the login page/g) ?? []).length >= n, count, { timeout: 30000 });
      // Settings: dsh's Settings button, or (0.2.1-alpha.3+) the account menu's first item. Back: the browser history.
      const settings = async (p) => {
        const direct = p.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await p.getByRole('button', { name: 'Account menu', exact: true }).click(); await p.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await p.getByText('Composer Plus', { exact: true }).click();
        await p.locator('[data-composer-plus-settings]').waitFor();
      };
      // dsh's Settings is an overlay over the chat: close it (its Close button, else Esc) to go on.
      const back = async (p) => {
        const overlay = p.locator('[class*="_overlay"]').filter({ has: p.locator('[data-composer-plus-settings]') });
        const close = overlay.getByRole('button', { name: /^(Close|Kapat)$/ });
        if (await close.count()) await close.first().click(); else await p.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(400);
      };

      // On by default: the first finished turn already shows a prediction, from dsh's default model.
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(500);
      await send(page, 'Add a login page');
      await turnDone(page, 1);
      await prediction.waitFor({ timeout: 20000 });
      assert.equal(seen.filter((s) => s.kind === 'predict').at(-1).model, 'demo', 'on by default, dsh default model');

      // Settings: the switch is on; the Model menu lists dsh's models, dsh's default first. Switch it off.
      await settings(page);
      const toggle = page.getByRole('switch', { name: 'Next message prediction' });
      assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'switch shows on');
      const model = page.getByRole('button', { name: 'Model', exact: true });
      await model.waitFor();
      assert.equal((await model.innerText()).trim(), 'dsh default (Demo model)', 'default follows dsh');
      await model.click();
      const items = await page.locator('body > [role="menu"]').last().innerText();
      for (const t of ['dsh default (Demo model)', 'Demo', 'Demo model', 'Fast', 'Mini', 'Nano']) assert.ok(items.includes(t), `menu lists ${t}`);
      await page.keyboard.press('Escape');
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-checked="false"]') !== null);
      await back(page);
      await prediction.waitFor({ state: 'detached' });

      // Off: a finished turn makes no prediction call.
      const before = seen.filter((s) => s.kind === 'predict').length;
      await send(page, 'Thanks, keep going');
      await turnDone(page, 2); await pause(2500);
      assert.equal(seen.filter((s) => s.kind === 'predict').length, before, 'switched off: no prediction call');
      assert.equal(await prediction.count(), 0);

      // On again: the next finished turn shows the prediction.
      await settings(page);
      await page.getByRole('switch', { name: 'Next message prediction' }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].some((s) => s.getAttribute('aria-label') === 'Next message prediction' && s.getAttribute('aria-checked') === 'true'));
      await back(page);
      await send(page, 'And now?');
      await turnDone(page, 3);
      await prediction.waitFor({ timeout: 20000 });
      assert.match(await prediction.innerText(), /Now add tests for the login form\.\s*Tab to accept/);
      assert.equal(seen.filter((s) => s.kind === 'predict').at(-1).model, 'demo', 'dsh default model');
      assert.equal(await page.locator('[data-composer-placeholder]').evaluate((el) => getComputedStyle(el).visibility), 'hidden', 'dsh placeholder hidden meanwhile');
      if (process.env.SHOT) {
        await page.mouse.move(1000, 100); await pause(300);
        const seat = await page.locator('[data-composer-seat]').boundingBox();
        const clip = { x: Math.max(0, seat.x - 24), y: Math.max(0, seat.y - 200), width: Math.min(1280 - Math.max(0, seat.x - 24), seat.width + 48), height: seat.height + 224 };
        const png = join(home, 'nextPrediction.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round(clip.width * 1.25))), '0', png, '-o', join(repo, 'assets/features/nextPrediction.webp')]);
      }
      // Esc hides it; it does not come back for this turn.
      await input.click(); await page.keyboard.press('Escape'); await prediction.waitFor({ state: 'detached' });
      // Tab on the next turn's prediction puts it in the composer.
      const predictsBefore = seen.filter((s) => s.kind === 'predict').length;
      await send(page, 'One more step');
      await turnDone(page, 4);
      await prediction.waitFor({ timeout: 20000 });
      await input.click(); await page.keyboard.press('Tab');
      await prediction.waitFor({ state: 'detached' });
      assert.equal((await input.innerText()).trim(), 'Now add tests for the login form.', 'Tab accepted the text');
      assert.equal(seen.filter((s) => s.kind === 'predict').length, predictsBefore + 1, 'one call per finished turn');
      // The prediction was never sent as a chat message.
      assert.ok(!(await page.locator('[data-composer-seat]').evaluate(() => document.body.innerText.includes('next message that the user will type'))), 'prompt not in the chat');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.press('Backspace');

      // Choose another model in Settings: the next prediction uses it.
      await settings(page);
      await page.getByRole('button', { name: 'Model', exact: true }).click();
      await page.locator('body > [role="menu"]').last().getByRole('menuitem', { name: 'Nano', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-composer-plus-prediction-model] button')].some((b) => b.textContent.includes('Nano')));
      await back(page);
      await send(page, 'Next');
      await turnDone(page, 5);
      await prediction.waitFor({ timeout: 20000 });
      assert.match(await prediction.innerText(), /Run the full test suite \(nano\)/);
      assert.equal(seen.filter((s) => s.kind === 'predict').at(-1).model, 'nano', 'the chosen model is called');

      // Turkish UI: Turkish hint.
      const tr = await open('tr-TR');
      await tr.locator('[data-composer-plus-prediction]').waitFor({ timeout: 20000 }).catch(() => {});
      if (await tr.locator('[data-composer-plus-prediction]').count() === 0) {
        await tr.locator('button:visible', { hasText: /Yeni oturum/i }).first().click(); await pause(500);
        await send(tr, 'Merhaba'); await tr.locator('[data-composer-plus-prediction]').waitFor({ timeout: 30000 });
      }
      assert.match(await tr.locator('[data-composer-plus-prediction]').innerText(), /Kabul için Tab/);
      if (process.env.TR_SHOT) await tr.screenshot({ path: join(process.env.TR_SHOT, 'nextPrediction-tr.png') });

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: on by default (first turn predicts), switch off stops calls, Settings lists dsh's models with the dsh default first, prediction after a finished turn, Esc hides, Tab accepts, one call per turn, chosen model used, Turkish hint, no page errors`);
    } catch (error) {
      const page = contexts.at(-1)?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; model calls: ${JSON.stringify(seen)}`);
      throw error;
    } finally {
      for (const context of contexts) await context.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
