// Real-app check of Refresh and Get summary in the Assistant status panel on each dsh given: a fake model, a throwaway
// DSH_HOME and HOME, a made-up project (acme-web), Turkish UI. Never the normal DSH_HOME, no real model. Headless, with
// Chromium's sandbox.
// 1. Setup: the assistant writes a summary without a request (status_summary_set, as a morning automation) and adds a
//    to-do item. The panel shows no summary card: only the lists, "Liste HH:MM", Özet getir and Refresh.
// 2. Refresh: within 100 ms the button turns and is aria-disabled, the header says "Yenileniyor…", the old content stays
//    in place (dimmed), the polite status line says it. The lists come back in less than a second. No summary request.
// 3. Özet getir: the button and the card say "Özet hazırlanıyor…" while the assistant's turn writes it (a hidden note,
//    not a chat bubble); a second click and Refresh send no second request; the card then shows the new summary.
//    Close: the card goes and stays hidden, also after an unrequested summary.
// 4. A turn that ends without a summary: "Yeni özet gelmedi." and Try again (the 5-minute timer itself is in
//    test/assistant-todos-client.test.mjs).
// 5. Errors (the Host answers 500/502): a short reason and Try again; Try again works.
// 6. Keyboard (Enter keeps the focus), reduced motion (no turning, only the text), dark theme (the text reads).
// PLAYWRIGHT=/path/to/playwright node test/browser-status-refresh.mjs /path/to/dsh/lib/bin.js [...]
// DSH_NODE=<node or Electron binary> runs dsh with it (ELECTRON_RUN_AS_NODE=1 for the DeepSeek Harness app's own dsh).
// SHOTS=<folder> writes panel screenshots there.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = process.env.REPO || fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(100); }
};
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const NOTE = /^\[Composer Plus → Status panel\] The user clicked "Get summary"/;
const calls = [];
const model = { summary: 'write', delay: 2500 }; // the assistant's answer to the note: 'write' (status_summary_set) or 'skip'
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const tool = (name, args) => { send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
    const all = msgs.map((m) => textOf(m.content)).join('\n');
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Demo chat');
    if (/You predict the next message|You complete the message that the user is typing|label a coding task|Translate each line/.test(all)) return say('');
    const isOwn = (m) => m.role === 'user' && !/^<|^Current runtime context|^Time sampled/.test(textOf(m.content).trim());
    const newest = textOf(msgs.findLast(isOwn)?.content ?? '').trim();
    const after = msgs.slice(msgs.findLastIndex(isOwn) + 1).some((m) => m.role === 'tool');
    calls.push({ newest, after });
    if (after) return say('ok');
    if (/Morning summary please/.test(newest)) return tool('status_summary_set', { projects: [{ project: 'acme-web', text: 'Giriş sayfası yapılıyor.' }] });
    if (/Remember: buy milk/.test(newest)) return tool('todo_list_add', { text: 'Süt al', owner: 'user' });
    if (NOTE.test(newest)) {
      const answer = model.summary === 'write' ? () => tool('status_summary_set', { projects: [{ project: 'acme-web', text: 'Giriş sayfası bitti, testler geçiyor.' }] }) : () => say('ok');
      return setTimeout(answer, model.delay);
    }
    return say('ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    calls.length = 0; model.summary = 'write';
    const version = bin.includes('app.asar') ? 'app' : bin.match(/dsh-real-([^/]+)|\/(\d+\.\d+\.\d+[^/]*)\//)?.slice(1).find(Boolean) ?? bin;
    console.log(`dsh ${version}`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-status-refresh-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'status-refresh-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const dir = join(home, 'projects', 'acme-web'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'README.md'), '# acme-web\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid }, tables: { workspaces: { [wid]: { path: dir, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.env.DSH_NODE || process.execPath, [...(process.env.DSH_NODE ? ['--expose-internals'] : []), bin, '--profile', 'web', '--port', process.env.PORT || '3261', '--no-open'], { cwd: dir,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', TZ: 'Europe/Istanbul', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    const shot = async (name) => { if (process.env.SHOTS) await page.locator('[data-composer-plus-todos]').screenshot({ path: join(process.env.SHOTS, `${name}.png`) }); };
    try {
      for (let i = 0; i < 400 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})\n${log.slice(-2000)}`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"idleSwitch":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url); await page.waitForFunction(() => document.documentElement.lang === 'tr');
      for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      await page.keyboard.press('Escape');
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const send = async (text) => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      const panel = page.locator('[data-composer-plus-todos]');
      const card = panel.locator('.cp-st-summary');
      const refresh = panel.locator('.cp-st-top > button.cp-td-btn');
      const ask = panel.locator('.cp-st-ask');
      const spoken = () => panel.locator('[role="status"][aria-live="polite"]').innerText();

      // 1. Setup: an unrequested summary opens no card.
      await page.locator('button[aria-label="Damon"]').click();
      const sessionId = await until(async () => (await page.evaluate(async () => (await (await fetch('/api/composer-plus.assistant-status')).json()).sessionId)), 'assistant id');
      await send('Morning summary please');
      await until(async () => calls.some((c) => /Morning summary please/.test(c.newest) && c.after), 'the unrequested summary is written');
      await send('Remember: buy milk'); await panel.getByText('Süt al').waitFor({ timeout: 30000 });
      await pause(1500); await page.mouse.move(10, 10);
      assert.equal(await card.count(), 0, 'no summary card by default (an unrequested summary does not open it)');
      assert.equal(await panel.getByText('Giriş sayfası yapılıyor.').count(), 0, 'no summary text anywhere');
      assert.equal(await ask.innerText(), 'Özet getir');
      assert.match(await panel.locator('h2').innerText(), /Liste \d{2}[.:]\d{2}/, 'the list time is named "Liste"');
      await shot(`${version}-0-default`);
      note('1: no summary card by default (also after an unrequested status_summary_set); "Liste HH:MM", Özet getir and Refresh');

      // 2. Refresh: the loading state in the same frame, the lists in less than a second, no summary request.
      const summaryPosts = []; page.on('request', (r) => { if (r.method() === 'POST' && /"action":"summary"/.test(r.postData() ?? '')) summaryPosts.push(r); });
      const listRead = page.waitForResponse((r) => r.url().includes('refresh=1'));
      const ms = await refresh.evaluate((button) => new Promise((resolve) => {
        const t0 = performance.now(); button.click();
        const check = () => {
          const root = button.closest('[data-composer-plus-todos]');
          if (button.dataset.refreshing === 'true' && button.getAttribute('aria-disabled') === 'true' && root.querySelector('h2')?.textContent.includes('Yenileniyor…')) resolve(performance.now() - t0);
          else requestAnimationFrame(check);
        };
        check();
      }));
      assert.ok(ms < 100, `the loading state shows within 100 ms (${ms.toFixed(1)} ms)`);
      await shot(`${version}-1-refreshing`);
      assert.equal(await spoken(), 'Yenileniyor…', 'the polite status line says it');
      assert.equal(await panel.getByText('Süt al').isVisible(), true, 'the old content stays in place');
      await until(async () => Number(await panel.locator('section[aria-labelledby$="-todos"]').evaluate((el) => getComputedStyle(el).opacity)) < 0.6, 'and is dimmed (after its .15 s fade)', 400);
      const clickedAt = Date.now(); const read = await listRead; await read.finished();
      assert.ok(Date.now() - clickedAt < 1000, 'the lists come back in less than a second');
      await until(async () => (await refresh.getAttribute('aria-disabled')) === 'false', 'Refreshing ends after the read', 3000);
      assert.match(await panel.locator('h2').innerText(), /Liste \d/);
      assert.equal(summaryPosts.length, 0, 'Refresh asks for no summary'); assert.equal(await card.count(), 0, 'and opens no card');
      note(`2: Refresh: loading state in ${ms.toFixed(1)} ms (button turns, aria-disabled, header "Yenileniyor…"), the lists in less than a second, no summary`);

      // 3. Özet getir: the card waits, then shows the new summary; one request at a time; close hides it.
      model.delay = 5000;
      await ask.click();
      await card.getByText('Özet hazırlanıyor…').waitFor({ timeout: 3000 });
      assert.equal(await ask.innerText(), 'Özet hazırlanıyor…'); assert.equal(await ask.getAttribute('aria-disabled'), 'true');
      assert.equal(await spoken(), 'Özet hazırlanıyor…');
      // At once, while it waits (Playwright's click waits for a stable element; the summary could come meanwhile).
      await ask.evaluate((b) => b.click()); await refresh.evaluate((b) => b.click()); await pause(800);
      assert.equal(summaryPosts.length, 1, 'one summary request: a second click and Refresh send none');
      await page.mouse.move(10, 10); await shot(`${version}-2-summary-waiting`);
      await card.getByText('Giriş sayfası bitti, testler geçiyor.').waitFor({ timeout: 30000 });
      assert.equal(await card.getByText('Özet hazırlanıyor…').count(), 0);
      assert.match(await card.locator('h3').innerText(), /^Özet · \d{2}[.:]\d{2}/, 'the summary time is named "Özet"');
      assert.equal(calls.filter((c) => NOTE.test(c.newest) && !c.after).length, 1, 'one assistant turn for the note');
      assert.equal(await page.getByText(/Composer Plus → Status panel/).count(), 0, 'the note is not a chat bubble');
      await page.mouse.move(10, 10); await shot(`${version}-3-summary-done`);
      await card.getByRole('button', { name: 'Özeti gizle' }).click();
      assert.equal(await card.count(), 0, 'closed');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cp-st-ask')), true, 'the focus goes to Özet getir');
      await send('Morning summary please'); await until(async () => calls.filter((c) => /Morning summary please/.test(c.newest) && c.after).length === 2, 'a second unrequested summary');
      await pause(1500); assert.equal(await card.count(), 0, 'stays closed after an unrequested summary');
      note('3: Özet getir: "Özet hazırlanıyor…", one hidden note, the new summary with "Özet · HH:MM"; close keeps it hidden');

      // 4. A turn that ends without a summary.
      model.summary = 'skip'; model.delay = 500;
      await ask.click();
      await card.getByText('Yeni özet gelmedi.').waitFor({ timeout: 30000 });
      assert.equal(await card.getByRole('button', { name: 'Tekrar dene: Özet getir' }).count(), 1);
      await page.mouse.move(10, 10); await shot(`${version}-4-summary-late`);
      note('4: a turn without a summary: "Yeni özet gelmedi." and Try again');

      // 5. Errors from the Host: a reason and Try again.
      await page.route('**/api/composer-plus.assistant-todos**', (route) => {
        const req = route.request();
        if (req.method() === 'POST' && /"action":"summary"/.test(req.postData() ?? '')) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"asistan sohbeti yok"}' });
        if (req.method() === 'GET' && req.url().includes('refresh=1')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disk dolu"}' });
        return route.continue();
      });
      const alert = panel.locator('[role="alert"]');
      await refresh.click(); await alert.getByText(/Yenilenemedi: disk dolu/).waitFor({ timeout: 5000 });
      await card.getByRole('button', { name: 'Tekrar dene: Özet getir' }).click();
      await card.getByText(/Yeni özet istenemedi: asistan sohbeti yok/).waitFor({ timeout: 5000 });
      await page.mouse.move(10, 10); await shot(`${version}-5-errors`);
      await page.unroute('**/api/composer-plus.assistant-todos**');
      model.summary = 'write'; model.delay = 300;
      await alert.getByRole('button', { name: 'Tekrar dene: Yenile' }).click();
      await until(async () => (await alert.count()) === 0, 'Try again read again', 5000);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Yenile', 'Try again gives the focus to Refresh');
      await card.getByRole('button', { name: 'Tekrar dene: Özet getir' }).click();
      await card.getByText('Giriş sayfası bitti, testler geçiyor.').waitFor({ timeout: 30000 });
      note('5: a failed read and a failed request each show the reason and Try again; Try again works');

      // 6. Keyboard, reduced motion, dark theme.
      await refresh.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Yenile', 'Enter keeps the focus on Refresh');
      await until(async () => (await refresh.getAttribute('aria-disabled')) === 'false', 'idle again', 5000);
      await page.emulateMedia({ reducedMotion: 'reduce' }); model.delay = 1500;
      await ask.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cp-st-ask')), true, 'Enter keeps the focus on Özet getir');
      await refresh.click();
      assert.equal(await refresh.locator(':scope > *').evaluate((el) => getComputedStyle(el).animationName), 'none', 'reduced motion: the icon does not turn');
      assert.match(await panel.locator('h2').innerText(), /Yenileniyor…/, 'reduced motion: the text stays');
      assert.equal(await ask.locator('.cp-st-spin').evaluate((el) => getComputedStyle(el).display), 'none', 'reduced motion: no spinner');
      await card.getByText('Özet hazırlanıyor…').waitFor({ state: 'detached', timeout: 30000 });
      await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
      await until(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), 'dsh dark theme', 10000); await pause(300);
      model.delay = 2500;
      await ask.click(); await refresh.click(); await panel.locator('.cp-st-time[data-refreshing="true"]').waitFor();
      const contrast = await panel.locator('.cp-st-time[data-refreshing="true"]').evaluate((el) => {
        const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        const lum = (c) => { const [r, g, b] = rgb(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const bg = getComputedStyle(el.closest('[data-composer-plus-todos]')).backgroundColor;
        const s = getComputedStyle(el); const [a, b] = [lum(s.color), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05);
      });
      assert.ok(contrast >= 4.5, `dark: "Yenileniyor…" reads (contrast ${contrast.toFixed(2)})`);
      await shot(`${version}-6-dark`);
      await card.getByText('Özet hazırlanıyor…').waitFor({ state: 'detached', timeout: 30000 });
      note(`6: Enter keeps the focus; reduced motion shows only the text; dark theme text contrast ${contrast.toFixed(2)}`);

      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}\n${log.split('\n').filter((l) => /error|warn/i.test(l)).slice(-30).join('\n')}`);
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
