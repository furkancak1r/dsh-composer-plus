// Real-app check of Assistant on Hermes with the real Hermes Agent: a fake model, a throwaway DSH_HOME, HOME,
// USERPROFILE and HERMES_HOME, a made-up project (acme-web). Never the normal DSH_HOME or Hermes home, no real model.
// 1. Settings → Composer Plus → Assistant on Hermes is off by default; on starts `hermes gateway`, and the row says that
//    Hermes runs (SHOT=1 saves the row as assets/features/assistantHermes.webp).
// 2. A message in the assistant chat goes to Hermes, not to dsh's agent loop: Hermes' model call reaches the fake model
//    through Composer Plus' bridge (model `dsh`, with Hermes' own tools and the Composer Plus MCP tools), and the fake
//    model's tool call mcp__composer_plus__todo_list_add runs through dsh's tool pipeline: the item shows in the status
//    panel, and Hermes' answer shows in the chat.
// 3. Off: Hermes stops, and the next message goes to dsh's agent loop (the fake model sees dsh's tools again).
// PLAYWRIGHT=/path/to/playwright HERMES=/path/to/hermes node test/browser-assistant-hermes.mjs /path/to/dsh/lib/bin.js
// Windows desktop dsh: DSH_NODE="C:\...\DeepSeek Harness.exe" runs the bin inside app.asar (ELECTRON_RUN_AS_NODE).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
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

// Fake OpenAI-compatible model. Hermes' calls (they carry the MCP tool) ask once for todo_list_add on "Remember: buy
// milk", then answer; dsh's own calls answer "dsh loop".
const calls = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const p = JSON.parse(body); const msgs = p.messages ?? []; const tools = (p.tools ?? []).map((t) => t.function?.name);
    const last = msgs.at(-1); const text = JSON.stringify(msgs.filter((m) => m.role === 'user').at(-1)?.content ?? '');
    const hermes = tools.includes('mcp__composer_plus__todo_list_add');
    calls.push({ hermes, tools, text, last: last?.role });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`);
    if (hermes && last?.role === 'user' && /Remember: buy milk/.test(text)) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'mcp__composer_plus__todo_list_add', arguments: '{"text":"Buy milk","owner":"user"}' } }] });
      send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: hermes ? (last?.role === 'tool' ? 'Added it to your list.' : 'Hermes demo reply.') : 'dsh loop' }); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-hermes-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-hermes-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // A throwaway Hermes profile (it shares the install's dependencies; a new data root would install them again).
    const hermesProfile = `cptest-${randomUUID().slice(0, 8)}`;
    execFileSync(process.env.HERMES ?? 'hermes', ['profile', 'create', hermesProfile, '--no-alias'], { stdio: 'ignore' });
    // A profile other than the default waits for a host gateway that serves many profiles, unless it stands alone.
    execFileSync(process.env.HERMES ?? 'hermes', ['-p', hermesProfile, 'config', 'set', 'gateway.standalone', 'true'], { stdio: 'ignore' });
    const hermesHome = execFileSync(process.env.HERMES ?? 'hermes', ['-p', hermesProfile, 'config', 'path'], { encoding: 'utf8' }).trim().replace(/[\\/]config\.yaml$/, '');
    // The desktop app's dsh needs its own runtime (ELECTRON_RUN_AS_NODE) to read app.asar.
    const runtime = process.env.DSH_NODE ?? process.execPath;
    const child = spawn(runtime, [bin, '--profile', 'web', '--port', '3237', '--no-open'], { cwd: dir,
      env: { ...process.env, ...(process.env.DSH_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}), HOME: home, USERPROFILE: home, DSH_HOME: dshHome, HERMES_HOME: hermesHome,
        ...(process.env.HERMES ? { PATH: `${join(process.env.HERMES, '..')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` } : {}),
        DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const stop = async () => { if (child.exitCode !== null) return; child.kill(); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); }); };
    const errors = []; let context; let page; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 400 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})\n${log}`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const api = (path, body) => page.evaluate(async ([p, b]) => {
        const r = await fetch(p, b === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, [path, body]);
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
      const route = '/api/composer-plus.assistant-hermes';

      // 1. Off by default; the switch starts Hermes.
      assert.deepEqual((await api(route)).body, { on: false, state: 'off' });
      await settings();
      const sw = page.getByRole('switch', { name: 'Assistant on Hermes', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'false', 'off by default');
      await sw.click();
      const row = page.locator('[data-composer-plus-hermes="running"]');
      await row.waitFor({ timeout: 600000 });
      const state = (await api(route)).body;
      assert.equal(state.state, 'running', JSON.stringify(state)); assert.match(state.version, /^\d+\.\d+\.\d+$/);
      if (process.env.SHOT === '1') {
        await row.scrollIntoViewIfNeeded();
        const card = sw.locator('xpath=ancestor::*[.//*[@data-composer-plus-hermes]][1]');
        const b = await card.boundingBox(); const pad = 12;
        const png = await page.screenshot({ clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: b.height + pad * 2 } });
        // The browser makes the WebP (no cwebp needed).
        const webp = await page.evaluate(async (src) => {
          const img = new Image(); img.src = `data:image/png;base64,${src}`; await img.decode();
          const c = document.createElement('canvas'); c.width = Math.round(img.width * 0.625); c.height = Math.round(img.height * 0.625);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL('image/webp', 0.78).split(',')[1];
        }, png.toString('base64'));
        await writeFile(join(repo, 'assets/features/assistantHermes.webp'), Buffer.from(webp, 'base64'));
        note('SHOT: assets/features/assistantHermes.webp');
      }
      await back();
      note(`1: Settings → on: Hermes ${state.version} runs`);

      // 2. The assistant chat goes to Hermes; Hermes' tool call adds a to-do through dsh.
      await page.locator('button[aria-label="Damon"]').click();
      await until(async () => (await api('/api/composer-plus.assistant-status')).body?.sessionId, 'assistant chat');
      await input.click(); await page.keyboard.type('Remember: buy milk', { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
      await page.locator('[data-composer-plus-todos] li').filter({ hasText: 'Buy milk' }).waitFor({ timeout: 180000 });
      await page.getByText('Added it to your list.').first().waitFor({ timeout: 120000 });
      const viaHermes = calls.filter((c) => c.hermes);
      assert.ok(viaHermes.length >= 2, 'Hermes called the model through the bridge');
      assert.ok(!calls.some((c) => !c.hermes && /Remember: buy milk/.test(c.text) && c.tools.includes('chats_list')), 'dsh\'s agent loop did not answer it');
      note('2: the message went to Hermes; its MCP tool call added "Buy milk" to the status panel; its answer shows');

      // 3. Off: dsh's agent loop answers again.
      assert.equal((await api(route, { on: false })).body.state, 'off');
      const before = calls.length;
      await input.click(); await page.keyboard.type('Hello again', { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
      await until(() => calls.slice(before).some((c) => !c.hermes && /Hello again/.test(c.text)), 'dsh loop call');
      note('3: off: the next message goes to dsh\'s agent loop');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log('PASS');
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}\n${log.split('\n').filter((l) => /error|warn|hermes/i.test(l)).slice(-40).join('\n')}`);
      await context?.close().catch(() => {});
      await stop();
      if (passed) await rm(home, { recursive: true, force: true }).catch(() => {});
      if (passed) for (const args of [['profile', 'delete', hermesProfile, '--yes'], ['profile', 'purge-identity', hermesProfile]]) { try { execFileSync(process.env.HERMES ?? 'hermes', args, { stdio: 'ignore' }); } catch { /* the next step or the user */ } }
      if (!passed) await writeFile(join(home, 'calls.json'), JSON.stringify(calls, null, 1)).catch(() => {});
    }
  }
} finally { await browser.close(); fake.close(); }
