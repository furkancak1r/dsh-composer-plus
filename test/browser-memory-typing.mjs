// Real-app check of the typing lag in Settings → Composer Plus → Project memory → Open memory, on each dsh given.
// Throwaway DSH_HOME, fake model, made-up projects (demo-0 … demo-21) with made-up notes and chats. Headless.
// Cause found here: Collapse all projects had a `body:has(…)` style rule. With it, each key press made the browser compute
// the style of the whole page again (about 33 ms per key at CPU ×4, with 22 projects open in "Workspace tree").
// 1. Every feature on (the defaults, plus Project memory): the style work per key press stays under STYLE_MAX_MS.
// 2. Collapse all projects still shows while a project is open (the button is in the header).
// 3. The typed text arrives whole, and the page has no errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-memory-typing.mjs /path/to/dsh/lib/bin.js [...]
// OFF=a,b switches off those features; ONLY=a,b switches off every client feature except those (to find a slow one).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); } };
const STYLE_MAX_MS = 5; // with the old rule: about 33 ms; without it: about 0.3 ms
const CLIENT = ['changesPanel', 'featureIdeas', 'contentSearch', 'turnRollback', 'deleteChat', 'projectName', 'projectStatus', 'sessionBranch', 'markProjectRead', 'activeProjectsFirst', 'recentProjects', 'collapseProjects', 'statusOrder', 'notifications', 'idleSwitch', 'allowForChat',
  'continueButton', 'inputHistory', 'planToggle', 'keepFocus', 'questionFit', 'headerFit', 'queueReorder', 'queueEdit', 'copyDeeplink', 'copyMessageLink', 'exportMarkdown', 'copyProjectPath', 'projectPicker', 'findInChat', 'promptImprove', 'handoffChat', 'contextBreakdown', 'worktreeChats', 'backup', 'sessionDoctor'];
const off = process.env.ONLY ? CLIENT.filter((id) => !process.env.ONLY.split(',').includes(id)) : (process.env.OFF ?? '').split(',').filter(Boolean);

const list = Array.from({ length: 120 }, (_, i) => `- Item ${i}: some **bold** text and \`code ${i}\` with a [link](https://example.com/${i}).`).join('\n');
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body);
    const all = JSON.stringify(parsed.messages);
    const text = /session title/i.test(all) ? 'Demo' : /next message|complete the message|long-term memory/.test(all) ? '' : `Here is the list:\n\n${list}`;
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-memtyping-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'memtyping-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // 22 made-up projects with 10 chats each and about 150 notes, like a real memory.
    const store = join(home, 'storages', 'dsh-composer-plus');
    const memDir = join(store, 'memory');
    const tables = {}; const ids = []; const now = new Date().toISOString();
    let first;
    for (let p = 0; p < 22; p++) {
      const folder = join(home, 'projects', `demo-${p}`); await mkdir(folder, { recursive: true });
      first ??= folder;
      const id = createHash('sha256').update(await realpath(folder)).digest('hex').slice(0, 32);
      await mkdir(join(memDir, 'projects', id), { recursive: true });
      const notes = Array.from({ length: p % 3 === 0 ? 14 : 4 }, (_, i) => `- Demo note ${i} of project ${p}: the build uses make release, the tests run with npm test, and the deploy goes to the staging server first. [source: demo; added: 2026-10-29]`).join('\n');
      await writeFile(join(memDir, 'projects', id, 'MEMORY.md'), `# Memory\n\n${notes}\n\n## Index\n`);
      await writeFile(join(memDir, 'projects', id, 'project.json'), JSON.stringify({ path: folder }));
      const chats = [];
      for (let c = 0; c < 10; c++) {
        const sid = `session-${randomUUID()}`; chats.push(sid);
        const dir = join(home, 'sessions', `-${folder.replace(/[^A-Za-z0-9_]/g, '-')}--`, sid); await mkdir(dir, { recursive: true });
        const at = Date.now() - c * 60000;
        const header = `${JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: at, cwd: folder, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })}\n`;
        const title = `${JSON.stringify({ type: 'session/title', seq: 0, time: at, data: { title: `Demo chat ${p}.${c}` } })}\n`;
        await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([zlib.zstdCompressSync(Buffer.from(header)), zlib.zstdCompressSync(Buffer.from(title))]));
      }
      const wid = randomUUID(); ids.push(wid);
      tables[wid] = { path: folder, title: `demo-${p}`, sessionIds: chats, createdAt: now, updatedAt: now };
    }
    await mkdir(join(memDir, 'global'), { recursive: true });
    await writeFile(join(memDir, 'global', 'MEMORY.md'), `# Memory\n\n${Array.from({ length: 6 }, (_, i) => `- Global demo note ${i}: the user wants short answers. [added: 2026-10-30]`).join('\n')}\n\n## Index\n`);
    await writeFile(join(store, 'memory.json'), JSON.stringify({ on: true }));
    await writeFile(join(store, 'default-workspace.json'), JSON.stringify({ on: false }));
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ids, archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids[0] }, tables: { workspaces: tables } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3214', '--no-open'], { cwd: first, env: { ...process.env, HOME: home, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      const features = { autoUpdate: false, nextPrediction: false };
      for (const id of off) features[id] = false;
      await context.addInitScript(([f, open]) => {
        localStorage.setItem('dsh-composer-plus.features', f);
        // "Workspace tree" with every project open.
        if (localStorage.getItem('dsh.workspace.view.v5') === null) localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({ groupBy: 'workspace-tree', orderBy: 'updated', groupExpansion: Object.fromEntries(open.map((id) => [id, true])), sessionOrderByAccount: {}, archivedFilter: 'default' }));
      }, [JSON.stringify(features), ids]);
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      await until(async () => (await page.locator('[data-row-key^="session:"]').count()) >= 10, 'the chat rows of the open projects', 20000);
      // A chat with two long replies behind Settings.
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(800);
      for (let t = 0; t < 2; t++) {
        await input.click(); await page.keyboard.type(`Show the list ${t}`); await page.keyboard.press('Enter');
        await until(async () => (await page.getByText('Item 119: some').count()) >= t + 1, `turn ${t}`);
      }
      await pause(1000);
      if (!off.includes('collapseProjects')) assert.equal(await page.locator('[data-composer-plus-collapse-projects] > button').isVisible(), true, 'Collapse all projects shows while projects are open');
      const direct = page.getByRole('button', { name: 'Settings', exact: true });
      if (await direct.isVisible()) await direct.click(); else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
      await page.getByText('Composer Plus', { exact: true }).click();
      await page.locator('[data-composer-plus-settings]').waitFor();
      await page.locator('[data-composer-plus-memory-open]').click();
      const dialog = page.locator('[data-composer-plus-memory-editor]'); await dialog.waitFor();
      await dialog.getByText('Demo note 0 of project 0').first().waitFor();
      const ask = dialog.locator('[data-composer-plus-memory-ask]'); await ask.click();
      // A slower Mac: CPU ×4. The browser's own counters: style and layout time while typing.
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await cdp.send('Performance.enable');
      await pause(500);
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      const text = 'Move the note about the staging server to the global memory please';
      const before = await metrics();
      await page.keyboard.type(text, { delay: 30 });
      await pause(800);
      const after = await metrics();
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const per = (key) => +(((after[key] - before[key]) * 1000) / text.length).toFixed(2);
      const result = { styleMs: per('RecalcStyleDuration'), layoutMs: per('LayoutDuration'), scriptMs: per('ScriptDuration'), taskMs: per('TaskDuration') };
      console.log(`  per key press (CPU ×4): ${JSON.stringify(result)}${off.length > 0 ? ` with ${off.length} features off` : ''}`);
      assert.equal(await ask.inputValue(), text, 'every key arrived');
      assert.ok(result.styleMs < STYLE_MAX_MS, `style work per key press ${result.styleMs} ms (limit ${STYLE_MAX_MS} ms)`);
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
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
