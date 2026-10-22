// Real-app check of "Complete while typing" with a fake model server, on each dsh given. No real model, never the normal
// DSH_HOME. Two fake providers (Demo: demo, Fast: nano); dsh's default is Demo / demo.
// Checks: off by default (typing makes no completion call); switched on in Settings, typing shows grey text after the
// cursor (dsh's composer hint) after a pause, from the model chosen for Next message prediction; typing along the guess
// makes no new call; Tab adds it; Esc hides it; a slash command gets nothing; the chat never gets the completion prompt.
// PLAYWRIGHT=/path/to/playwright node test/browser-complete.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/typingCompletion.webp (English UI, made-up chat).
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

// Fake OpenAI-compatible server. A completion request has the completion system prompt and answers with the rest of
// "Add a logout button to the header"; the model id goes in the answer, so the check sees which model dsh called.
const seen = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"},{"id":"nano"}]}'); return; }
    const parsed = JSON.parse(body);
    const all = JSON.stringify(parsed.messages);
    const kind = /complete the message that the user is typing/.test(all) ? 'complete' : /next message that the user will type/.test(all) ? 'predict' : /session title/i.test(all) ? 'title' : 'chat';
    const typed = /<<<([\s\S]*?)>>>/.exec(parsed.messages.at(-1)?.content?.[0]?.text ?? parsed.messages.at(-1)?.content ?? '')?.[1] ?? '';
    seen.push({ kind, model: parsed.model, typed });
    const goal = 'Add a logout button to the header';
    const text = kind === 'complete' ? (goal.startsWith(typed) ? goal.slice(typed.length) : ' please') + (parsed.model === 'nano' ? ' (nano)' : '')
      : kind === 'predict' ? 'Now add tests.' : kind === 'title' ? 'Header work' : 'Done: the header is in src/Header.tsx.';
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
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-complete-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'complete-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
${provider('fast', 'Fast', [['nano', 'Nano']])}
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3192', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      // The next message prediction is on by default; it is switched off here so that only completions call the model.
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      const hint = () => input.evaluate((el) => el.style.getPropertyValue('--dsh-composer-hint'));
      const after = () => input.evaluate((el) => { const p = el.querySelector('p:last-child'); return p === null ? '' : getComputedStyle(p, '::after').content; });
      const completes = () => seen.filter((s) => s.kind === 'complete');
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
      const clear = async () => { await input.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.press('Backspace'); await pause(200); };

      // Off by default: typing makes no completion call.
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(500);
      await input.click(); await page.keyboard.type('Add a logout', { delay: 40 }); await pause(1200);
      assert.equal(completes().length, 0, 'off by default: no call');
      assert.equal(await hint(), '');
      await clear();

      // Settings: the switch is off; switch it on. The next message prediction off, so only completions call the model.
      await settings();
      const toggle = page.getByRole('switch', { name: 'Complete while typing' });
      assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'switch shows off');
      await toggle.click();
      await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].some((s) => s.getAttribute('aria-label') === 'Complete while typing' && s.getAttribute('aria-checked') === 'true'));
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      // The Model menu is under this switch too (the same choice as the prediction's).
      assert.ok(await page.locator('[data-composer-plus-prediction-model]').count() >= 2, 'Model menu under both switches');
      await back();

      // Typing: after a pause the rest shows after the cursor, in dsh's caption colour.
      await input.click(); await page.keyboard.type('Add a logout', { delay: 40 });
      await page.waitForFunction(() => document.querySelector('[data-composer-input]')?.style.getPropertyValue('--dsh-composer-hint') !== '', null, { timeout: 15000 });
      assert.equal(await hint(), JSON.stringify(' button to the header'));
      assert.equal(await after(), JSON.stringify(' button to the header'), 'dsh draws it after the last line');
      assert.equal(completes().at(-1).typed, 'Add a logout'); assert.equal(completes().at(-1).model, 'demo', 'dsh default model');
      const typedCalls = completes().length;
      assert.ok(typedCalls <= 3, `one ask per pause, not per keystroke (${typedCalls})`);
      if (process.env.SHOT) {
        await page.mouse.move(1000, 100); await pause(300);
        const seat = await page.locator('[data-composer-seat]').boundingBox();
        const clip = { x: Math.max(0, seat.x - 24), y: Math.max(0, seat.y - 40), width: Math.min(1280 - Math.max(0, seat.x - 24), seat.width + 48), height: seat.height + 64 };
        const png = join(home, 'typingCompletion.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round(clip.width * 1.25))), '0', png, '-o', join(repo, 'assets/features/typingCompletion.webp')]);
      }
      // Typing along the guess: the rest gets shorter, no new call.
      await page.keyboard.type(' bu', { delay: 40 }); await pause(900);
      assert.equal(await hint(), JSON.stringify('tton to the header')); assert.equal(completes().length, typedCalls, 'no call along the guess');
      // Tab adds it.
      await page.keyboard.press('Tab'); await pause(300);
      assert.equal((await input.innerText()).trim(), 'Add a logout button to the header', 'Tab added the rest');
      assert.equal(await hint(), '');
      await clear();
      // Esc hides it.
      await page.keyboard.type('Add a', { delay: 40 });
      await page.waitForFunction(() => document.querySelector('[data-composer-input]')?.style.getPropertyValue('--dsh-composer-hint') !== '', null, { timeout: 15000 });
      await page.keyboard.press('Escape'); await pause(300);
      assert.equal(await hint(), '', 'Esc hides it');
      await clear();
      // A slash command gets nothing.
      const beforeSlash = completes().length;
      await page.keyboard.type('/plan add', { delay: 40 }); await pause(1200);
      assert.equal(completes().length, beforeSlash, 'slash command: no call');
      await page.keyboard.press('Escape'); await clear();

      // Another model chosen in Settings (the prediction's Model menu) is the one the completion calls.
      await settings();
      await page.locator('[data-composer-plus-prediction-model] button').first().click();
      await page.locator('body > [role="menu"]').last().getByRole('menuitem', { name: 'Nano', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-composer-plus-prediction-model] button')].every((b) => b.textContent.includes('Nano')));
      await back();
      // Text that the last guess does not fit (a fitting guess is reused with no call, whatever the model).
      await input.click(); await page.keyboard.type('Fix the', { delay: 40 });
      await page.waitForFunction(() => document.querySelector('[data-composer-input]')?.style.getPropertyValue('--dsh-composer-hint').includes('nano'), null, { timeout: 15000 });
      assert.equal(completes().at(-1).model, 'nano', 'the chosen model is called');
      // Enter sends the typed text only, not the grey rest; the chat never gets the completion prompt.
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.innerText.includes('Done: the header is in src/Header.tsx.'), null, { timeout: 30000 });
      assert.ok(!(await page.evaluate(() => document.body.innerText.includes('complete the message that the user is typing'))), 'prompt not in the chat');
      assert.ok(!(await page.evaluate(() => document.body.innerText.includes('please (nano)'))), 'the grey rest is not sent');
      assert.equal(await hint(), '', 'no hint on the empty composer');

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: off by default (no call), Settings switch on with the shared Model menu, grey rest after the cursor after a pause, one call per pause, no call along the guess, Tab adds, Esc hides, slash command skipped, chosen model used, Enter sends only the typed text, no page errors`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; model calls: ${JSON.stringify(seen)}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
