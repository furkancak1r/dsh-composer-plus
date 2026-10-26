// Real-app check of "Allow for this chat" with a time limit, on each dsh given. Isolated: own DSH_HOME, a fake model that is
// also the Auto Review reviewer (it always denies, so dsh asks the user), a made-up project. Never the normal profile.
// 1. /permission auto → a bash call → the approval card shows "Allow for this chat" with "for 1 hour" → click it.
// 2. The same tool again: no card (allowed by the grant); the header chip names the end time.
// 3. Settings → Allow for this chat → Time limit shows "1 hour" and lists the choices.
// 4. The grant is moved 61 minutes into the past in chat-grants.json (as if an hour went by) and the page reloads: the
//    next bash call shows the card again, and the chip is gone.
// PLAYWRIGHT=/path/to/playwright node test/browser-grant-ttl.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model. A user message "Run step N" → one bash call, then "Step N done.". The Auto Review reviewer
// (system prompt "final authorization reviewer") always answers deny, so each call that it sees waits for the user.
let reviews = 0;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const end = () => res.end('data: [DONE]\n\n');
    const text = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); end(); };
    if (JSON.stringify(msgs[0]?.content ?? '').includes('final authorization reviewer')) { reviews++; return text('{"risk":"high","decision":"deny"}'); }
    if (/session title/i.test(JSON.stringify(last?.content))) return text('Grant check');
    const step = JSON.stringify(msgs.filter((m) => m.role === 'user').map((m) => m.content)).match(/Run step (\d+)/g)?.at(-1)?.match(/\d+/)[0];
    if (last?.role !== 'tool' && step) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `echo step ${step}`, description: `Step ${step}` }) } }] });
      send({}, 'tool_calls'); end(); return;
    }
    text(`Step ${step ?? '?'} done.`);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    reviews = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-grant-ttl-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'grant-ttl-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-auto-review', 'dsh-composer-plus'] } } }));
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
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 860 } });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of ['Continue', 'Configure later']) { const b = page.getByRole('button', { name, exact: true }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) await b.click(); }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
      const send = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); await pause(800); };
      await send('/permission auto');
      await page.getByText('Auto review', { exact: true }).first().waitFor({ timeout: 15000 }); // dsh's permission chip

      // 1. The reviewer denies → dsh asks; the card has "Allow for this chat", its title names the time.
      await send('Run step 1');
      const allowChat = page.getByRole('button', { name: 'Allow for this chat', exact: true });
      await allowChat.waitFor({ timeout: 30000 });
      assert.match(await allowChat.getAttribute('title'), /without asking in this chat for 1 hour/);
      await allowChat.click();
      await page.getByText('Step 1 done.').waitFor({ timeout: 20000 });
      const grantsFile = join(home, 'storages', 'dsh-composer-plus', 'chat-grants.json');
      const saved = JSON.parse(await readFile(grantsFile, 'utf8'));
      assert.equal(saved.ttlMs, 3600e3);
      const [sid] = Object.keys(saved.grants); assert.ok(saved.grants[sid].bash > 0, 'the grant is saved with its time');

      // 2. Same tool again: the grant answers it; the chip names the end time.
      const reviewsBefore = reviews;
      await send('Run step 2');
      await page.getByText('Step 2 done.').waitFor({ timeout: 30000 });
      assert.ok(reviews > reviewsBefore, 'the reviewer saw the call (and denied it)');
      assert.equal(await allowChat.count(), 0, 'no card while the grant runs');
      const chip = page.getByRole('button', { name: /1 tool\(s\) allowed/ });
      assert.match(await chip.getAttribute('title'), /bash \(until \d{1,2}:\d{2}/);

      // 3. Settings → Allow for this chat → Time limit.
      const openSettings = async () => {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
      };
      await openSettings();
      const limit = page.getByRole('button', { name: 'Allow for this chat: Time limit' });
      await limit.waitFor({ timeout: 10000 });
      assert.equal((await limit.innerText()).trim(), '1 hour');
      await limit.click();
      for (const name of ['15 minutes', '1 hour', '4 hours', '8 hours', 'Until revoked']) await page.getByRole('menuitemradio', { name }).or(page.getByRole('menuitem', { name })).first().waitFor();
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

      // 4. An hour later (the grant moved 61 min into the past): the card shows again, the chip is gone.
      saved.grants[sid].bash -= 61 * 60e3;
      await writeFile(grantsFile, JSON.stringify(saved));
      await page.reload();
      await input.waitFor();
      await page.getByText('Step 2 done.').waitFor({ timeout: 20000 });
      await send('Run step 3');
      await allowChat.waitFor({ timeout: 30000 });
      assert.equal(await page.getByRole('button', { name: /tool\(s\) allowed/ }).count(), 0, 'the chip is gone');
      assert.deepEqual(JSON.parse(await readFile(grantsFile, 'utf8')).grants, saved.grants, 'nothing new was granted');
      await page.getByRole('button', { name: /^(Allow once|Approve|Allow)$/ }).first().click().catch(() => {});
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: Auto Review deny → Allow for this chat (1 hour) → same tool allowed without a card, chip with the end time, Settings Time limit, after 61 min the card shows again`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
