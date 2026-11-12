// Real-app check of "Running subagents in the chat header" on each dsh given (fake model, throwaway DSH_HOME and HOME,
// made-up project, headless). The chat starts three subagents: one finishes, two keep running.
// 1. On (default): dsh's header counter says "2 subagents running" (not the total, 3). A click opens dsh's list: its first
//    line is "Subagents in total: 3", then dsh's three rows (one done, two running). Closed, the line goes.
// 2. When the two running subagents end, the counter says "0 subagents running".
// 3. Switched off: dsh's own counter ("3 subagents") is back and its list has no total line; on again: running count.
// PLAYWRIGHT=/path/to/playwright node test/browser-subagent-running.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/subagentRunning.webp (English UI, demo project). KEEP=1 keeps the temp home.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake model: the chat's first request starts three subagents in the background. "Child A" answers at once; "Child B"
// and "Child C" wait until `release()`. Then the chat says "Started the work.".
let held = [];
const release = () => { for (const r of held.splice(0)) say(r, 'Done.'); };
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
const say = (res, content) => { if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk({ role: 'assistant', content }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); };
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    const text = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
    if (/session title/i.test(text(msgs.at(-1)))) { say(res, 'Order rules check'); return; }
    if (/predict the next message|complete the message|improve a prompt|branch name/i.test(text(msgs[0]))) { say(res, 'Thanks'); return; }
    const firstUser = text(msgs.find((m) => m.role === 'user'));
    if (firstUser.includes('Child A')) { say(res, 'Checked.'); return; }
    if (firstUser.includes('Child B') || firstUser.includes('Child C')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); held.push(res); return; }
    if (!msgs.some((m) => m.role === 'tool')) {
      // 0.2.0's tool waits unless run_in_background is true; 0.2.1+ always returns at once (no such parameter).
      const bg = (parsed.tools ?? []).find((t) => t.function?.name === 'subagent')?.function?.parameters?.properties?.run_in_background !== undefined;
      const call = (index, task) => ({ index, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ description: `Check part ${task}`, prompt: `Child ${task}: check part ${task}.`, ...(bg ? { run_in_background: true } : {}) }) } });
      // dsh 0.2.2-rc.2 team chat: one shared task too, so that dsh's task board shows under the list.
      const team = (parsed.tools ?? []).some((t) => t.function?.name === 'team_task_create')
        ? [{ index: 3, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'team_task_create', arguments: JSON.stringify({ subject: 'Review the order rules', description: 'Read the rules and list the gaps.' }) } }] : [];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', tool_calls: [call(0, 'A'), call(1, 'B'), call(2, 'C'), ...team] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
      return;
    }
    say(res, 'Started the work.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
const results = [];
try {
  for (const bin of process.argv.slice(2)) {
    held = [];
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-sar-')));
    // dsh 0.2.2-rc.2 and later ship Agent Team: each new chat is a team chat here (its task board shows in the list).
    const team = existsSync(join(dirname(bin), '../../dsh-agent-team/package.json'));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'sar-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
- id: permission-presets
  config: { default: full-access }
${team ? '- id: agent-team\n  config: { defaultEnabled: true }\n' : ''}`);
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    await writeFile(join(project, 'README.md'), '# acme-web\n');
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid },
      tables: { workspaces: { [wid]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT ?? '3213', '--no-open'], { cwd: project,
      env: { ...process.env, DSH_HOME: home, HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: 'dark' });
      await context.addInitScript(() => { if (sessionStorage.getItem('sar.started') === null) { sessionStorage.setItem('sar.started', '1'); localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); } });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      await input.click(); await page.keyboard.type('Check the order rules'); await page.keyboard.press('Enter');
      await page.getByText('Started the work.').first().waitFor({ timeout: 30000 });
      // dsh's counter button: aria-haspopup "tree" before 0.2.2-rc.2, "dialog" (in `[data-subagent-action]`) in 0.2.2-rc.2.
      const COUNTER = '[aria-haspopup="tree"], [data-subagent-action] > button[aria-haspopup="dialog"], [data-subagent-action] button[aria-haspopup="dialog"]';
      const counter = page.locator(COUNTER).first();
      const counterText = () => counter.innerText().then((s) => s.replace(/\s+/g, ' ').trim());
      const waitText = async (re, what) => { await page.waitForFunction(([src, sel]) => { const b = document.querySelector(sel); return b !== null && new RegExp(src).test(b.textContent.replace(/\s+/g, ' ').trim()); }, [re.source, COUNTER], { timeout: 30000 }).catch(() => {}); const s = await counterText(); assert.match(s, re, `${what} (header: "${s}")`); return s; };
      const totalLine = page.locator('[data-composer-plus-subagent-total]');

      // 1. Two of three run: the header shows 2; the list's first line shows the total 3.
      const shown = await waitText(/^2 subagents running$/, 'the header shows the running subagents');
      assert.ok(await page.locator('[data-composer-plus-subagent-running="2"]').count() === 1, 'our entry drew dsh\'s counter');
      await counter.click();
      const tree = page.getByRole('tree', { name: 'Subagent sessions' }); await tree.waitFor({ timeout: 10000 });
      await totalLine.waitFor({ timeout: 10000 });
      assert.equal(await totalLine.innerText(), 'Subagents in total: 3', 'the list shows the total');
      const order = await page.evaluate(() => { const line = document.querySelector('[data-composer-plus-subagent-total]'); const next = line.nextElementSibling; return next?.hasAttribute('data-subagent-section-header') ? 'header' : next?.getAttribute('role') ?? next?.tagName; });
      assert.equal(order, team ? 'header' : 'tree', 'the total is the first line, above dsh\'s rows (and above the team chat\'s "Subagents" header)');
      assert.equal(await tree.getByRole('treeitem').count(), 3, 'dsh\'s three rows');
      if (team) {
        // dsh's Agent Team task board under the list (it is in the child slot that dsh's own entry declares).
        const board = page.locator('[data-subagent-panel] [data-team-panel]');
        await board.waitFor({ timeout: 10000 });
        assert.match(await board.innerText(), /Shared tasks[\s\S]*Review the order rules/, 'the team chat\'s task board shows under the list');
      }
      const lineBox = await totalLine.boundingBox(); const treeBox = await tree.boundingBox();
      assert.ok(lineBox && treeBox && lineBox.y + lineBox.height <= treeBox.y + 1 && lineBox.width > 100, `the line is above the rows and inside the menu (${JSON.stringify(lineBox)} / ${JSON.stringify(treeBox)})`);
      if (process.env.SHOT || process.env.KEEP) {
        const head = await counter.boundingBox();
        const clip = { x: Math.max(0, head.x - 260), y: 0, width: 620, height: Math.min(820, treeBox.y + treeBox.height + 16) };
        const png = join(home, 'shot.png'); await page.screenshot({ path: png, clip });
        if (process.env.SHOT) execFileSync('cwebp', ['-quiet', '-q', '62', '-resize', '620', '0', png, '-o', join(repo, 'assets/features/subagentRunning.webp')]);
      }
      await page.keyboard.press('Escape'); await tree.waitFor({ state: 'detached', timeout: 10000 });
      assert.equal(await totalLine.count(), 0, 'closed: the line goes');

      // 3. Switched off: dsh's own counter (total) and no line; on again: the running count.
      const setSwitch = async (on) => {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name: 'Running subagents in the chat header', exact: true }); await sw.waitFor({ timeout: 10000 });
        if ((await sw.isChecked()) !== on) await sw.click();
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const close = overlay.getByRole('button', { name: /^Close$/ });
        if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(600);
      };
      await setSwitch(false);
      await waitText(/^3 subagents$/, 'switched off: dsh\'s own counter (the total)');
      await counter.click(); await tree.waitFor({ timeout: 10000 }); await pause(300);
      assert.equal(await totalLine.count(), 0, 'switched off: no total line');
      await page.keyboard.press('Escape'); await tree.waitFor({ state: 'detached', timeout: 10000 });
      await setSwitch(true);
      await waitText(/^2 subagents running$/, 'on again: the running count');

      // 2. The two running subagents end: 0.
      release();
      await waitText(/^0 subagents running$/, 'none running: 0');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      results.push(`PASS ${bin}: header "${shown}" with 3 in total · list first line "Subagents in total: 3" · off: "3 subagents", no line · on again · all done: "0 subagents running"${team ? ' · team chat: task board under the list' : ''}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      results.push(`FAIL ${bin}: ${error?.stack ?? error}\n  kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
    } finally {
      release();
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log);
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
      else console.log(`home: ${home}`);
    }
  }
} finally { release(); await browser.close(); fake.close(); }
for (const r of results) console.log(r);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
