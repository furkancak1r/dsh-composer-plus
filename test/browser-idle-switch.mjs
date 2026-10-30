// Real-app check of "Open waiting chat when idle" with a fake model, on each dsh given. No real model, never the normal
// DSH_HOME. Two chats ask a question (dsh's `ask_user_question`, the orange dot) while a third chat is open:
// - typing in the composer, the mouse and the scroll wheel keep the open chat (each one restarts the 30 s);
// - a draft in the composer blocks the switch even after 30 s without input;
// - after 30 s idle, the chat that asked first opens and stays while its question waits;
// - after you answer it, the other one opens after another 30 s idle;
// - two chats finish a turn while another chat is open (dsh's green dot): the first one opens after 30 s idle, the
//   second one waits for your next input and then opens after another 30 s idle;
// - switch off: nothing opens.
// The page clock runs at normal speed: the test waits the real 30 s (about 5 minutes for one dsh).
// PLAYWRIGHT=/path/to/playwright node test/browser-idle-switch.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/idleSwitch.webp (English UI, demo chats only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model: "ask:<topic>" asks one question with ask_user_question; "slow:<topic>" answers
// "Finished <topic>." after 4 s (time to open another chat, so this one gets the green dot); the rest answers "Done.".
const TITLES = { 'ask:deploy': 'Deploy target', 'ask:colors': 'Theme colors', 'Plan the docs': 'Docs plan' };
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    const users = msgs.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    const lastUser = users.filter((u) => !/runtime context|session title|Time sampled while preparing/i.test(u)).at(-1) ?? '';
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const end = () => res.end('data: [DONE]\n\n');
    if (/session title/i.test(JSON.stringify(last?.content))) { const k = Object.keys(TITLES).find((x) => JSON.stringify(last.content).includes(x)); send({ role: 'assistant', content: TITLES[k] ?? 'Demo task' }); send({}, 'stop'); end(); return; }
    const slow = lastUser.match(/slow:(\w+)/)?.[1];
    if (slow) { setTimeout(() => { send({ role: 'assistant', content: `Finished ${slow}.` }); send({}, 'stop'); end(); }, 4000); return; }
    const topic = lastUser.match(/ask:(\w+)/)?.[1];
    if (topic && last?.role !== 'tool') {
      const question = topic === 'deploy' ? { id: 'target', header: 'Deploy', question: 'Which environment should I deploy to?', options: [{ label: 'Staging (Recommended)' }, { label: 'Production' }] }
        : { id: 'palette', header: 'Colors', question: 'Which color palette should the theme use?', options: [{ label: 'Blue' }, { label: 'Green' }] };
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [question] }) } }] });
      send({}, 'tool_calls'); end(); return;
    }
    send({ role: 'assistant', content: 'Done.' }); send({}, 'stop'); end();
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-idle-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'idle-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3197', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const contexts = []; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      const run = async (on) => {
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' }); contexts.push(context);
        await context.addInitScript((features) => { localStorage.setItem('dsh-composer-plus.features', features); }, JSON.stringify(on ? { autoUpdate: false } : { autoUpdate: false, idleSwitch: false }));
        const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url);
        for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
          const b = page.getByRole('button', { name });
          if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
        }
        const input = page.locator('[data-composer-input]'); await input.waitFor();
        const sendIn = async (text) => {
          await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
          await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
        };
        /** The open chat's title (dsh's header), or '' for a new chat. */
        const openTitle = () => page.evaluate(() => {
          const t = document.querySelector('[data-conversation-title], header h1, [data-session-title]');
          return (t?.textContent ?? document.title ?? '').trim();
        });
        const card = (text) => page.getByText(text, { exact: true }).first(); // not the sidebar's hidden status label
        const question = (text) => card(text).isVisible().catch(() => false);
        // Two chats ask, in this order; then a third chat stays open and idle.
        await sendIn('ask:deploy'); await card('Which environment should I deploy to?').waitFor({ timeout: 20000 });
        await pause(1500);
        await sendIn('ask:colors'); await card('Which color palette should the theme use?').waitFor({ timeout: 20000 });
        await pause(1500);
        await sendIn('Plan the docs'); await page.getByText('Done.', { exact: true }).first().waitFor({ timeout: 20000 });
        // The two questions stay waiting (dsh's orange dot on their rows) while the third chat is open.
        const dots = await page.locator('[data-state="warning"]').count();
        assert.ok(dots >= 2, `two waiting chats show the orange dot (found ${dots})`);
        assert.equal(await question('Which environment should I deploy to?'), false, 'the docs chat is on screen');
        const t0 = Date.now();
        // Activity for 40 s: typing, mouse moves, the wheel. Nothing may move.
        await input.click();
        for (let i = 0; i < 4; i++) {
          await page.keyboard.type('x'); await pause(4000);
          await page.mouse.move(400 + i * 10, 300); await pause(3000);
          await page.mouse.wheel(0, i % 2 ? 120 : -120); await pause(3000);
        }
        assert.ok(Date.now() - t0 >= 40000);
        assert.equal(await question('Which environment should I deploy to?'), false, 'activity keeps the open chat');
        // A draft in the composer ("xxxx") blocks the switch also after 32 s without input.
        await pause(32000);
        assert.equal(await question('Which environment should I deploy to?'), false, 'a draft in the composer blocks the switch');
        // Clear the draft and leave the page alone: the first question opens after 30 s idle.
        await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');
        await page.mouse.move(5, 5);
        const idleFrom = Date.now();
        if (!on) {
          await pause(40000);
          assert.equal(await question('Which environment should I deploy to?'), false, 'switch off: nothing opens');
          await context.close(); contexts.pop();
          return {};
        }
        await card('Which environment should I deploy to?').waitFor({ state: 'visible', timeout: 40000 });
        const first = (Date.now() - idleFrom) / 1000;
        assert.ok(first >= 29, `not before 30 s idle (${first} s)`);
        assert.equal(await question('Which color palette should the theme use?'), false, 'the chat that asked first opens first');
        if (index === 0 && process.env.SHOT) {
          // The opened chat with its question card and the sidebar row with the orange dot; nothing personal.
          await pause(800);
          const clip = { x: 0, y: 0, width: 1280, height: 800 };
          const png = join(home, 'idleSwitch.png'); await page.screenshot({ path: png, clip });
          execFileSync('cwebp', ['-quiet', '-q', '72', '-resize', '1280', '0', png, '-o', join(repo, 'assets/features/idleSwitch.webp')]);
        }
        // While that question waits on screen, the other one never replaces it.
        await pause(35000);
        assert.equal(await question('Which color palette should the theme use?'), false, 'an open waiting chat stays');
        // Answer it (clicks): the other question opens after the next 30 s idle.
        await page.getByText('Staging', { exact: true }).first().click();
        await page.getByRole('button', { name: 'Submit', exact: true }).click();
        await card('Which environment should I deploy to?').waitFor({ state: 'hidden', timeout: 20000 });
        await page.mouse.move(5, 5);
        const secondFrom = Date.now();
        await card('Which color palette should the theme use?').waitFor({ state: 'visible', timeout: 45000 });
        const second = (Date.now() - secondFrom) / 1000;
        assert.ok(second >= 25, `the next one after another 30 s idle (${second} s)`);
        // Answer it too and let its turn finish on screen (no green dot), so no chat waits any more.
        await page.getByText('Blue', { exact: true }).first().click();
        await page.getByRole('button', { name: 'Submit', exact: true }).click();
        await card('Which color palette should the theme use?').waitFor({ state: 'hidden', timeout: 20000 });
        await pause(3000);
        // Green dot: two chats finish while a new chat is open.
        await sendIn('slow:lint'); await pause(1500);
        await sendIn('slow:release'); await pause(300);
        await page.locator('button:visible', { hasText: 'New Session' }).first().click();
        await page.waitForFunction(() => document.querySelectorAll('[data-state="done"]').length >= 2, null, { timeout: 20000 });
        const finished = (topic) => card(`Finished ${topic}.`).isVisible().catch(() => false);
        assert.equal(await finished('lint'), false, 'the finished chats are not on screen');
        await page.mouse.move(30, 30);
        const greenFrom = Date.now();
        await card('Finished lint.').waitFor({ state: 'visible', timeout: 45000 });
        const green = (Date.now() - greenFrom) / 1000;
        assert.ok(green >= 29, `green: not before 30 s idle (${green} s)`);
        // The opened green chat stays until your next input; the other green dot stays too.
        await pause(40000);
        assert.equal(await finished('release'), false, 'green: the next one waits for your input');
        assert.ok(await page.locator('[data-state="done"]').count() >= 1, 'green: the other chat keeps its dot');
        await page.mouse.move(60, 60);
        const greenNextFrom = Date.now();
        await card('Finished release.').waitFor({ state: 'visible', timeout: 45000 });
        const greenNext = (Date.now() - greenNextFrom) / 1000;
        assert.ok(greenNext >= 29, `green: the next one after another 30 s idle (${greenNext} s)`);
        await context.close(); contexts.pop();
        return { first, second, green, greenNext };
      };
      const on = await run(true);
      console.log(`${bin}\n  switch on: first question after ${on.first.toFixed(1)} s idle, second ${on.second.toFixed(1)} s after the answer`);
      console.log(`  green: first finished chat after ${on.green.toFixed(1)} s idle, the second one held for 40 s, then ${on.greenNext.toFixed(1)} s after the next input`);
      await run(false);
      console.log('  switch off: nothing opened after 40 s idle');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = contexts.at(-1)?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
