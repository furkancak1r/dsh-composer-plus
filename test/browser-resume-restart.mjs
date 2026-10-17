// Real-app check of "Resume after restart" on each dsh given: a fake slow model, a throwaway DSH_HOME, a real quit (SIGTERM)
// and a real start of the same profile. Never the normal DSH_HOME and no real model.
// 1. Switch on in Settings. Start two chats and a `/goal`; the model answers only after 60 s, so they run. Stop one chat
//    with dsh's Stop.
// 2. Quit dsh. Start dsh again: the running chat continues by itself (the fake model gets the hidden "continue" note), the
//    goal goes on with round 2, and the stopped chat does not continue.
// 3. Switch off, quit during a running turn, start again: nothing continues.
// PLAYWRIGHT=/path/to/playwright node test/browser-resume-restart.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/resumeAfterRestart.webp (English UI, demo chat only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Since 0.2.1-alpha.3 the web app has dsh's account menu (Settings is its first item) in place of the Settings button.
const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
};

const CHATS = { long: 'Migrate the build to the new bundler', stopped: 'Draft the weekly status report', goal: 'Ship the release checklist' };
const NOTE = 'Continue the task from where it stopped';
// Fake OpenAI-compatible model: titles at once; a request whose last user message is the continue note answers at once;
// every other request answers after 60 s (so the turn is still running when the test quits dsh). Goal rounds are recorded
// with their round number.
const seen = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    // dsh appends context notes after the prompt (runtime context; 0.2.1 also the sampled time): read the newest other one.
    const prompt = msgs.findLast((m) => m.role === 'user' && !/Current runtime context|Time sampled while preparing/.test(JSON.stringify(m.content))) ?? last;
    const lastText = JSON.stringify(prompt?.content ?? '');
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = (text) => res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    if (/session title/i.test(JSON.stringify(last?.content ?? ''))) { answer(Object.values(CHATS).find((x) => body.includes(x)) ?? 'Demo'); return; }
    const chat = Object.entries(CHATS).find(([, x]) => body.includes(x))?.[0] ?? 'other';
    const round = /<goal_round>[\s\S]*?Round: (\d+)\//.exec(lastText.replace(/\\n/g, '\n'))?.[1];
    seen.push({ chat, resumed: lastText.includes(NOTE), ...(round === undefined ? {} : { round: Number(round) }) });
    if (lastText.includes(NOTE)) { answer('Resumed after the restart: the bundler migration is done.'); return; }
    const timer = setTimeout(() => answer('Done.'), 60000);
    res.on('close', () => clearTimeout(timer));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    seen.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-resume-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'resume-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const logs = []; const errors = []; const contexts = []; let child; let passed = false;
    const start = async () => {
      child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3193', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' }); contexts.push(context);
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      await page.locator('[data-composer-input]').waitFor();
      return page;
    };
    const say = async (page, text) => {
      await page.locator('[data-composer-input]').click(); await page.keyboard.type(text);
      // A `/` command opens dsh's menu, whose first Enter only picks a row: close it, then Enter sends.
      const menu = page.locator('[data-trigger-menu]');
      if (text.startsWith('/') && await menu.waitFor({ timeout: 3000 }).then(() => true, () => false)) { await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' }); }
      await page.keyboard.press('Enter');
    };
    const newChat = async (page) => { await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600); };
    const row = (page, title) => page.locator('[data-row-key^="session:"]').filter({ hasText: title }).first();
    const setSwitch = async (page, on) => {
      await openSettings(page);
      await page.getByText('Composer Plus', { exact: true }).click();
      const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name: 'Resume after restart' });
      await sw.waitFor();
      if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
      await page.waitForFunction((want) => [...document.querySelectorAll('[data-composer-plus-settings] [role="switch"]')]
        .some((s) => s.getAttribute('aria-label') === 'Resume after restart' && s.getAttribute('aria-checked') === want), String(on));
      return sw;
    };
    const saved = async () => JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/resume.json'), 'utf8').catch(() => '{}'));
    try {
      // Run 1: switch on (from the default off), two running chats, stop one.
      let page = await open(await start());
      await setSwitch(page, true);
      assert.deepEqual(await saved(), { on: true, sessions: [] }, 'the switch is saved by the Host');
      await page.keyboard.press('Escape'); await pause(400);
      await newChat(page); await say(page, CHATS.stopped); await row(page, CHATS.stopped).waitFor({ timeout: 20000 });
      await pause(1500);
      await page.getByRole('button', { name: /^Stop/ }).first().click(); await pause(1500); // dsh's own Stop (aborted, cause user)
      await newChat(page); await say(page, CHATS.long); await row(page, CHATS.long).waitFor({ timeout: 20000 });
      // A goal: `/goal` arms it and dsh's goal driver starts round 1.
      await newChat(page); await say(page, `/goal ${CHATS.goal}`);
      for (let i = 0; i < 80 && !seen.some((s) => s.chat === 'goal' && s.round === 1); i++) await pause(250);
      assert.ok(seen.some((s) => s.chat === 'goal' && s.round === 1), `goal round 1 started (${JSON.stringify(seen)})`);
      for (let i = 0; i < 40 && (await saved()).sessions?.length !== 2; i++) await pause(250);
      assert.equal((await saved()).sessions.length, 2, 'the running chat and the goal chat are listed (the stopped one is not)');
      const requestsBefore = seen.length;
      // Quit while both run.
      await quit();
      assert.equal((await saved()).sessions.length, 2, 'both are still listed after the quit');
      // Run 2: start again; no click. The long chat continues by itself, the goal goes on with its next round, and the
      // stopped chat does not continue.
      const url2 = await start();
      const after = () => seen.slice(requestsBefore);
      for (let i = 0; i < 80 && !(after().some((s) => s.resumed) && after().some((s) => s.chat === 'goal')); i++) await pause(250);
      assert.deepEqual(after().filter((s) => s.resumed).map((s) => s.chat), ['long'], `the running chat continues without a click (requests after the start: ${JSON.stringify(after())})`);
      assert.deepEqual(after().filter((s) => s.chat === 'goal').map((s) => s.round), [2], 'the goal goes on with round 2 (armed again; no continue note)');
      assert.equal(after().some((s) => s.chat === 'stopped'), false, 'the chat that you stopped does not continue');
      // The old list is used once; the goal's round 2 runs now, so the goal chat is listed again (for the next quit).
      for (let i = 0; i < 20 && (await saved()).sessions.length !== 1; i++) await pause(250);
      assert.equal((await saved()).sessions.length, 1, 'the old list is forgotten; only the running goal round is listed');
      page = await open(url2);
      await row(page, CHATS.long).click();
      await page.getByText('Resumed after the restart', { exact: false }).waitFor({ timeout: 20000 });
      const content = page.locator('[data-conversation-content]');
      assert.equal(await content.getByText(NOTE, { exact: false }).count(), 0, 'the continue note is not a chat message');
      if (index === 0 && process.env.SHOT) {
        // The chat after the restart: your message, the turn the quit cut, and the answer that came without a click.
        await page.mouse.move(5, 5); await pause(600);
        const area = await content.boundingBox();
        const asked = await content.getByText(CHATS.long, { exact: true }).last().boundingBox();
        const answer = await content.getByText('Resumed after the restart', { exact: false }).last().boundingBox();
        const top = Math.max(0, asked.y - 28);
        const clip = { x: area.x, y: top, width: area.width, height: Math.min(800 - top, answer.y + answer.height + 12 - top) };
        const png = join(home, 'resumeAfterRestart.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/resumeAfterRestart.webp')]);
      }
      // Run 3: switch off, quit during a running turn, start again: nothing continues.
      await setSwitch(page, false); await page.keyboard.press('Escape'); await pause(400);
      await newChat(page); await say(page, 'Run the database backup'); await pause(3000);
      const before3 = seen.length;
      await quit();
      assert.deepEqual(await saved(), { on: false, sessions: [] }, 'off: nothing is listed');
      await start(); await pause(8000);
      assert.deepEqual(seen.slice(before3).filter((s) => s.resumed || s.chat === 'goal'), [], 'off: nothing continues after the restart (no continue, no goal round)');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: switch on → quit while a chat and a goal run → start: the chat continues without a click (hidden note), the goal goes on with round 2, a stopped chat does not; switch off → nothing continues`);
    } catch (error) {
      const page = contexts.at(-1)?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; model requests: ${JSON.stringify(seen)}`);
      throw error;
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      await writeFile(join(home, 'server.log'), logs.map((l) => l()).join('\n----- restart -----\n')); // tokens stay in the temp home
      if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
