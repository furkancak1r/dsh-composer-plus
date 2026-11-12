// Real-app check of Morning summary (a setting of Assistant status panel) on each dsh given: a fake model, a throwaway
// DSH_HOME and HOME, a made-up project (acme-web). Never the normal DSH_HOME, no real model. Headless.
// 1. Settings → Composer Plus shows Morning summary (off, 07:50) under the Assistant status panel row; its switch turns
//    it on: dsh's own schedule.json has exactly one task, weekly Monday-Friday at 07:50 in this Mac's time zone, for the
//    assistant chat.
// 2. The route changes the time: still one task, at the new time.
// 3. The route turns it off: the task is gone from schedule.json, and the saved state is off.
// 0. In dsh 0.2.0, Automation tasks (the schedule service) is an optional plugin, off by default: first without it, on
//    is refused with the reason and the setting stays off; then the check runs again with that plugin on.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-morning.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Fake OpenAI-compatible model: every answer is "ok" (no turn runs in this check).
const fake = createServer((req, res) => {
  req.resume(); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-morning-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    const bundles = (more = []) => writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-morning-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...more, 'dsh-composer-plus'] } } }));
    // dsh 0.2.0: the schedule service comes from this optional bundle.
    const optional = existsSync(join(bin, '../../../dsh-experimental-schedule-bundle/package.json'));
    await bundles();
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
    const wsId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wsId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wsId },
      tables: { workspaces: { [wsId]: { path: dir, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    let child; let log = '';
    const start = async () => {
      log = '';
      child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3231', '--no-open'], { cwd: dir,
        env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      return log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0];
    };
    const stop = async () => { if (child?.exitCode !== null) return; child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); }); };
    const errors = []; let context; let page; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    // dsh's own task table (storage domain "schedule"); only the morning summary's rows count.
    const scheduleFile = join(dshHome, 'storages/schedule.json');
    const tasks = async () => {
      const raw = JSON.parse(await readFile(scheduleFile, 'utf8').catch(() => '{}'));
      return Object.values(raw.tables?.tasks ?? {}).filter((t) => t?.record?.title === 'Morning summary');
    };
    const sessionOf = (t) => t.target?.sessionId ?? t.sessionId;
    try {
      let url = await start(); assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      const open = async () => {
        page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url);
        for (const name of [/^Continue$/, /^Configure later$/]) {
          const b = page.getByRole('button', { name });
          if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
        }
        const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
        if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
        await page.locator('[data-composer-input]').first().waitFor({ timeout: 20000 });
      };
      const api = (path, body) => page.evaluate(async ([p, b]) => {
        const r = await fetch(p, b === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, [path, body]);
      await open();
      if (optional) {
        // 0. No schedule service: on is refused with the reason, and the setting stays off.
        const refusedOn = await api('/api/composer-plus.assistant-morning', { on: true });
        assert.equal(refusedOn.status, 409, JSON.stringify(refusedOn)); assert.match(refusedOn.body.error, /no schedule service: turn on Automation tasks in Plugins/);
        assert.deepEqual((await api('/api/composer-plus.assistant-morning')).body, { on: false, time: '07:50' }, 'still off');
        await page.close(); await stop(); await bundles(['@deepseek-ai/dsh-experimental-schedule-bundle']);
        url = await start(); assert.ok(url, 'test server URL available again');
        await open();
        note('0: without the Automation tasks plugin: on is refused with the reason, still off; then that plugin is turned on');
      }
      const route = '/api/composer-plus.assistant-morning';
      assert.deepEqual(await api(route), { status: 200, body: { on: false, time: '07:50' } }, 'off and 07:50 by default');
      assert.equal((await tasks()).length, 0, 'no task before');

      // 1. The Settings switch turns it on.
      const direct = page.getByRole('button', { name: 'Settings', exact: true });
      if (await direct.isVisible()) await direct.click();
      else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
      await page.getByText('Composer Plus', { exact: true }).click();
      const box = page.locator('[data-composer-plus-morning]');
      await box.waitFor({ timeout: 10000 });
      assert.equal(await box.locator('input[type="time"]').inputValue(), '07:50');
      const sw = page.getByRole('switch', { name: 'Morning summary', exact: true });
      assert.equal(await sw.getAttribute('aria-checked'), 'false');
      await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'true' && await sw.isEnabled(), 'switch on');
      const assistantId = (await api('/api/composer-plus.assistant')).body?.sessionId;
      assert.ok(assistantId, 'the assistant chat exists');
      let mine = await until(async () => { const list = await tasks(); return list.length > 0 && list; }, 'the task in schedule.json');
      assert.equal(mine.length, 1, 'exactly one task');
      assert.equal(mine[0].record.kind, 'weekly'); assert.deepEqual(mine[0].record.weekdays, [1, 2, 3, 4, 5]);
      assert.equal(mine[0].record.time, '07:50:00.000'); assert.equal(mine[0].record.timeZone, zone);
      assert.equal(sessionOf(mine[0]), assistantId, 'for the assistant chat');
      assert.equal(mine[0].status, 'active');
      const saved = JSON.parse(await readFile(join(dshHome, 'storages/dsh-composer-plus/assistant-morning.json'), 'utf8'));
      assert.equal(saved.taskId, mine[0].record.id, 'the saved task id');
      note(`1: Settings → on: one weekly Mon-Fri 07:50 ${zone} task for the assistant chat in schedule.json`);

      // 2. A new time: still one task, at that time.
      assert.deepEqual((await api(route, { time: '06:35' })).body, { on: true, time: '06:35' });
      mine = await tasks();
      assert.equal(mine.length, 1); assert.equal(mine[0].record.time, '06:35:00.000'); assert.equal(sessionOf(mine[0]), assistantId);
      note('2: a new time: one task at 06:35');

      // 3. Off: the task is gone.
      assert.deepEqual((await api(route, { on: false })).body, { on: false, time: '06:35' });
      assert.equal((await tasks()).length, 0, 'the task is gone');
      assert.equal((await api(route, { on: 'yes' })).status, 400, 'a bad body');
      note('3: off: the task is gone from schedule.json');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}\n${log.split('\n').filter((l) => /error|warn|schedule|morning/i.test(l)).slice(-30).join('\n')}`);
      await context?.close().catch(() => {});
      await stop();
      if (passed) await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }
} finally { await browser.close(); fake.close(); }
