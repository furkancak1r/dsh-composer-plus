// Real-app check with a fake model, on each dsh given. No real model, never the normal DSH_HOME.
// A turn runs; five messages wait in the queue; dsh's Stop; then a sixth message is typed and sent at once.
// Expected: the sixth message runs alone in the next request; the five queued messages keep their order, stay out of
// that request, and then run one per request.
// CP=off: dsh without Composer Plus; CP=send-first-off: its Host switch off (both expect dsh's own order: queued message 1
// runs next, the sixth last). CP=queue-off: Composer Plus with its other queue features off. Default: on.
// SHOT=1 also writes assets/features/stopSendFirst.webp (English UI, made-up project): the sixth message runs alone, the
// five wait under it in their order.
// PLAYWRIGHT=/path/to/playwright node test/browser-queue-stop-send.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = process.env.CP ?? 'on';

const TASK = 'Rename the config loader';
const QUEUED = ['Queued one apple', 'Queued two banana', 'Queued three cherry', 'Queued four grape', 'Queued five lemon'];
const SIXTH = 'Sixth message melon';
const ALL = [TASK, ...QUEUED, SIXTH];
// Fake OpenAI-compatible model: titles at once; the first task request hangs (so messages queue and Stop has a turn to
// stop); every later request answers in 1.5 s. Each request records which of our texts its new user messages hold.
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
    const added = JSON.stringify(msgs.slice(lastAssistant + 1).filter((m) => m.role === 'user').map((m) => m.content));
    requests.push(ALL.filter((text) => added.includes(text)));
    if (hang) { hang = false; res.write(chunk({ role: 'assistant', content: 'Working' })); const t = setTimeout(() => answer(' done.'), 120000); res.on('close', () => clearTimeout(t)); return; }
    setTimeout(() => answer(`Answered ${requests.length}.`), 1500);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
const failures = [];
try {
  for (const bin of process.argv.slice(2)) {
    requests = []; hang = true;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-queue-stop-send-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    if (mode !== 'off') { await symlink(repo, join(profile, 'node_modules/dsh-composer-plus')); bundles.push('dsh-composer-plus'); }
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'queue-stop-send-test', private: true, dsh: { profile: { bundles } } }));
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
    const port = 3197;
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', String(port), '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = [];
    const report0 = {};
    let context;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      const off = mode === 'queue-off' ? { queueReorder: false, queueEdit: false, continueButton: false } : {};
      await context.addInitScript((features) => localStorage.setItem('dsh-composer-plus.features', JSON.stringify(features)), { autoUpdate: false, ...off });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      // CP=send-first-off: the Host switch off, so dsh's own order (the bug) is expected.
      if (mode === 'send-first-off') report0.switch = await page.evaluate(async () => (await fetch('/api/composer-plus.send-first', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":false}' })).json());
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
      const type = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
      await type(TASK); await pause(700);
      await page.waitForFunction(() => document.body.innerText.includes('Working'), null, { timeout: 20000 });
      for (const text of QUEUED) { await type(text); await pause(500); }
      const dock = page.locator('[data-queue-dock]'); await dock.waitFor({ timeout: 10000 });
      // dsh collapses a queue of two or more rows under a "N queued messages" header: open it first.
      const rows = async () => {
        const header = dock.locator('button[aria-expanded="false"]').first();
        if (await header.count().catch(() => 0)) await header.click().catch(() => {});
        return (await dock.locator('li:not([data-submission-echo])').allInnerTexts().catch(() => [])).map((t) => ALL.find((x) => t.includes(x)) ?? t);
      };
      const report = { bin, mode, ...report0, queuedBefore: await rows() };
      await page.getByRole('button', { name: /^Stop/ }).first().click();
      await pause(Number(process.env.DELAY ?? 300));
      const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${mode}-${name}.png`) }); };
      await shot('1-stopped');
      await type(SIXTH); // typed and sent right after Stop
      await pause(600);
      await shot('2-sent');
      report.afterSend = { rows: await rows(), requests: requests.slice(), dock: await dock.innerText().catch(() => '') };
      if (process.env.SHOT && mode === 'on') {
        await page.mouse.move(1200, 120); await pause(300);
        const sixth = await page.getByText(SIXTH, { exact: true }).first().boundingBox();
        const card = await input.evaluate((el) => { const c = (el.closest('[data-composer-card]') ?? el).getBoundingClientRect(); return { x: c.x, y: c.y, width: c.width, height: c.height }; });
        const d = await dock.boundingBox();
        const left = Math.max(0, Math.min(card.x, d.x) - 16); const right = Math.min(1280, Math.max(card.x + card.width, d.x + d.width) + 16);
        const top = Math.max(0, sixth.y - 120); const bottom = Math.min(900, card.y + card.height + 4);
        const png = join(home, 'stopSendFirst.png');
        await page.screenshot({ path: png, clip: { x: left, y: top, width: right - left, height: bottom - top } });
        const out = join(repo, 'assets/features/stopSendFirst.webp');
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round((right - left) * 1.25))), '0', png, '-o', out]);
        report.shot = (await stat(out)).size;
      }
      for (let i = 0; i < 40 && requests.length < 3; i++) await pause(250);
      await pause(1800);
      await shot('3-two-answers');
      for (let i = 0; i < 80 && requests.length < 7; i++) await pause(250);
      await pause(2500);
      report.requests = requests;
      report.rowsEnd = await rows();
      // The order of the user messages in the chat, by their first place in the page text.
      report.chatOrder = await page.evaluate((all) => { const text = document.querySelector('main')?.innerText ?? document.body.innerText; return all.map((t) => [t, text.indexOf(t)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]).map(([t]) => t); }, ALL);
      // Settings → Composer Plus: the row, its screenshot and the Host switch (off, then back on; the Host answers both).
      if (mode === 'on') {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        await page.locator('[data-composer-plus-settings]').waitFor();
        const sw = page.getByRole('switch', { name: 'Send after Stop goes first' });
        report.settings = { row: await sw.waitFor({ timeout: 10000 }).then(() => true, () => false) };
        if (report.settings.row) {
          report.settings.on = await sw.isChecked();
          report.settings.shot = await page.locator('[data-composer-plus-settings] img[src*="stopSendFirst"]').count();
          await sw.click(); await pause(600);
          report.settings.hostOff = await page.evaluate(async () => (await fetch('/api/composer-plus.send-first')).json());
          report.settings.offShown = await sw.isChecked();
          await sw.click(); await pause(600);
          report.settings.hostOn = await page.evaluate(async () => (await fetch('/api/composer-plus.send-first')).json());
        }
      }
      report.errors = errors.slice(0, 5);
      console.log(JSON.stringify(report, null, 1));
      const [first, second, ...rest] = requests;
      // Without the fix (dsh alone, or the switch off), dsh runs queued message 1 next and the sixth last.
      const expected = mode === 'on' || mode === 'queue-off' ? [SIXTH, ...QUEUED] : [...QUEUED, SIXTH];
      const ok = first?.length === 1 && first[0] === TASK
        && report.queuedBefore.join() === QUEUED.join()
        && [second, ...rest].length === expected.length && [second, ...rest].every((r, i) => r?.length === 1 && r[0] === expected[i])
        && (expected[0] !== SIXTH || report.afterSend.rows.join() === QUEUED.join())
        && report.rowsEnd.length === 0 && errors.length === 0
        && (mode !== 'on' || (report.settings?.on === true && report.settings.hostOff?.on === false && report.settings.offShown === false && report.settings.hostOn?.on === true));
      if (!ok) failures.push(`${bin} (${mode})`);
      console.log(ok ? 'PASS' : 'FAIL', bin, mode);
    } finally {
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await pause(1500); if (child.exitCode === null) child.kill('SIGKILL');
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }
} finally { await browser.close(); fake.close(); }
if (failures.length) { console.log('failed:', failures.join(', ')); process.exitCode = 1; }
