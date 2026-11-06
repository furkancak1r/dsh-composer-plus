// Real-app check of "Report an issue" on each dsh given: a fake model, a fake `gh` (first on PATH, it only writes its
// argv and stdin to a file), a throwaway DSH_HOME and HOME, and no GitHub token in the environment. No real model, no real
// gh, no network to GitHub: no issue can be opened. Headless, English UI.
// 1. Settings → Composer Plus: the switch is on, "Report an issue…" shows under the intro and opens the panel.
// 2. Bug is picked; the report goes to the model (one call, with the bug sections); the draft shows with "[Bug]" and the
//    version line; the title is edited.
// 3. Open issue: the fake gh gets `issue create --repo=furkancak1r/dsh-composer-plus`, the edited title and the body on
//    stdin; "Issue #77 is open." with its link.
// 4. A text with a key is refused, and gh does not run.
// 5. gh fails: its reason shows with "Open on GitHub instead" (GitHub's page with the draft).
// 6. A chat's right-click menu → "Report a Composer Plus issue…" opens the same panel; Close closes it.
// 7. The switch off: no Settings button and no menu item. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-issue-report.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/issueReport.webp (English UI, made-up report).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); } };
const REPORT = 'Settings search does not find the Backup row when I type "backup". It worked before the update.';
const DRAFT = { title: 'Settings search misses the Backup row', body: '### What happened\nTyping "backup" in the Settings search shows no rows.\n\n### Steps to reproduce\n1. Open Settings → Composer Plus.\n2. Type "backup" in the search field.\n\n### Expected\nThe Backup row shows.\n\n### Actual\nNo matching features.' };

// Fake OpenAI-compatible server: the issue draft for an issue request, a short reply for a chat.
const seen = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const all = JSON.stringify(parsed.messages);
    const kind = /You write one GitHub issue for Composer Plus/.test(all) ? 'issue' : /session title/i.test(all) ? 'title' : /next message that the user will type/.test(all) ? 'predict' : 'chat';
    seen.push({ kind, all });
    const text = kind === 'issue' ? JSON.stringify(DRAFT) : kind === 'title' ? 'Weekly menu' : kind === 'predict' ? '' : 'Done: the weekly menu is ready.';
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-issue-')));
    // The fake gh: it records each call; FAIL in the folder makes it refuse like gh without a login.
    const bins = join(home, 'bin'); const ghLog = join(home, 'gh-calls.jsonl');
    await mkdir(bins, { recursive: true });
    await writeFile(join(bins, 'gh'), `#!/usr/bin/env node
const fs = require('fs'); const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), token: Object.keys(process.env).filter((k) => /TOKEN/.test(k)) }) + '\\n');
if (fs.existsSync(${JSON.stringify(join(bins, 'FAIL'))})) { process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exit(4); }
process.stdout.write('https://github.com/furkancak1r/dsh-composer-plus/issues/77\\n');
`);
    await chmod(join(bins, 'gh'), 0o755);
    const ghCalls = async () => (await readFile(ghLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'issue-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 4000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    const project = join(home, 'projects', 'meal-planner');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'README.md'), '# meal-planner\nA demo app that plans weekly meals.\n');
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'meal-planner', sessionIds: [], createdAt: now, updatedAt: now } } },
    }));
    // No GitHub token and a throwaway HOME and gh config: a real gh (if the fake one were not first) has no login.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH_|GITHUB_)/.test(k)));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: project,
      env: { ...env, HOME: home, GH_CONFIG_DIR: join(home, 'gh-config'), PATH: `${bins}:${process.env.PATH}`, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      // A chat for the menu (step 6).
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      await input.click(); await page.keyboard.type('Plan a weekly menu'); await page.keyboard.press('Enter');
      await page.getByText('the weekly menu is ready', { exact: false }).first().waitFor({ timeout: 20000 });
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
      // 1. Settings: the switch and the button.
      await settings();
      assert.equal(await page.getByRole('switch', { name: 'Report an issue', exact: true }).getAttribute('aria-checked'), 'true', 'on by default');
      await page.locator('[data-composer-plus-issue-open]').click();
      const dialog = page.getByRole('dialog', { name: 'Report a Composer Plus issue', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.locator('[data-composer-plus-issue-type="bug"]').getAttribute('aria-pressed'), 'true', 'Bug is picked');
      assert.equal(await dialog.locator('[data-composer-plus-issue-write]').isDisabled(), true, 'no draft without a report');
      assert.equal(seen.filter((s) => s.kind === 'issue').length, 0, 'no model call before the click');
      // 2. Draft.
      await dialog.locator('[data-composer-plus-issue-text]').fill(REPORT);
      await dialog.locator('[data-composer-plus-issue-write]').click();
      const title = dialog.locator('[data-composer-plus-issue-title]'); await title.waitFor({ timeout: 20000 });
      assert.equal(await title.inputValue(), `[Bug] ${DRAFT.title}`);
      const body = await dialog.locator('[data-composer-plus-issue-body]').inputValue();
      assert.ok(body.startsWith(DRAFT.body), 'the model\'s body'); assert.match(body, /\n---\nComposer Plus \d+\.\d+\.\d+ · dsh \S+ · \S+ \S+ · drafted with AI/);
      assert.ok(!body.includes(home), 'no home path');
      const asks = seen.filter((s) => s.kind === 'issue'); assert.equal(asks.length, 1, 'one model call');
      assert.match(asks[0].all, /What happened, Steps to reproduce, Expected, Actual/); assert.ok(asks[0].all.includes('Settings search does not find the Backup row'));
      await title.fill(`[Bug] ${DRAFT.title} after the update`);
      if (process.env.SHOT) {
        // The picture shows the start of the title, without the focus ring.
        await title.evaluate((el) => { el.setSelectionRange(0, 0); el.scrollLeft = 0; el.blur(); });
        await pause(500);
        const png = join(tmpdir(), `issueReport-${process.pid}.png`);
        await dialog.screenshot({ path: png });
        execFileSync('cwebp', ['-quiet', '-q', '72', '-resize', '640', '0', png, '-o', join(repo, 'assets/features/issueReport.webp')]);
        await rm(png, { force: true });
        console.log(`shot: assets/features/issueReport.webp ${(await stat(join(repo, 'assets/features/issueReport.webp'))).size} bytes`);
      }
      // 3. Open issue.
      await dialog.locator('[data-composer-plus-issue-submit]').click();
      await dialog.locator('[data-composer-plus-issue-done="77"]').waitFor({ timeout: 20000 });
      assert.match(await dialog.locator('[data-composer-plus-issue-done]').innerText(), /Issue #77 is open\. View on GitHub/);
      assert.equal(await dialog.getByRole('link', { name: 'View on GitHub' }).getAttribute('href'), 'https://github.com/furkancak1r/dsh-composer-plus/issues/77');
      let calls = await ghCalls(); assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv, ['issue', 'create', '--repo=furkancak1r/dsh-composer-plus', `--title=[Bug] ${DRAFT.title} after the update`, '--body-file', '-']);
      assert.equal(calls[0].stdin, `${body}\n`); assert.deepEqual(calls[0].token, [], 'no token in this test');
      assert.equal(await dialog.locator('[data-composer-plus-issue-text]').inputValue(), '', 'the report clears');
      // 4. A key is refused before gh.
      await dialog.locator('[data-composer-plus-issue-text]').fill('My token is ghp_abcdefghijklmnopqrstuvwxyz0123 and it fails.');
      await dialog.locator('[data-composer-plus-issue-write]').click(); await title.waitFor({ timeout: 20000 });
      await dialog.locator('[data-composer-plus-issue-body]').fill('Token ghp_abcdefghijklmnopqrstuvwxyz0123 fails.');
      await dialog.locator('[data-composer-plus-issue-submit]').click();
      await dialog.getByRole('alert').filter({ hasText: 'looks like a key, token or password' }).waitFor({ timeout: 10000 });
      assert.equal((await ghCalls()).length, 1, 'no gh for a key');
      // 5. gh fails: its reason and GitHub's own page.
      await writeFile(join(bins, 'FAIL'), '');
      await dialog.locator('[data-composer-plus-issue-body]').fill('The search field ignores the word backup.');
      await dialog.locator('[data-composer-plus-issue-submit]').click();
      await dialog.getByRole('alert').filter({ hasText: 'gh auth login' }).waitFor({ timeout: 20000 });
      const href = await dialog.locator('[data-composer-plus-issue-browser]').getAttribute('href');
      const fallback = new URL(href); assert.equal(fallback.origin + fallback.pathname, 'https://github.com/furkancak1r/dsh-composer-plus/issues/new');
      assert.equal(fallback.searchParams.get('body'), 'The search field ignores the word backup.');
      await dialog.getByRole('button', { name: 'Close', exact: true }).first().click(); await dialog.waitFor({ state: 'detached' });
      await back();
      // 6. The chat's right-click menu opens the same panel.
      const row = page.locator('[data-row-key^="session:"]').first(); await row.waitFor();
      await row.click({ button: 'right' });
      await page.getByText('Report a Composer Plus issue…').first().click();
      await dialog.waitFor(); assert.equal(await dialog.locator('[data-composer-plus-issue-text]').inputValue(), '', 'a new panel');
      await dialog.getByRole('button', { name: 'Close', exact: true }).first().click(); await dialog.waitFor({ state: 'detached' });
      // 7. Switched off: no button, no menu item.
      await settings();
      await page.getByRole('switch', { name: 'Report an issue', exact: true }).click();
      assert.equal(await page.locator('[data-composer-plus-issue-open]').count(), 0, 'no Settings button');
      await back();
      await row.click({ button: 'right' }); await page.getByText('Copy session link').first().waitFor({ timeout: 5000 });
      assert.equal(await page.getByText('Report a Composer Plus issue…').count(), 0, 'no menu item'); await page.keyboard.press('Escape');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: Settings button, draft (one model call, [Bug], version line), edit, Open issue (fake gh: --repo, title, stdin), key refused, gh failure + GitHub page, right-click menu, switch off`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); fake.close(); }
