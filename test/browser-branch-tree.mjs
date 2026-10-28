// Real-app check of Branches in the workspace tree (branchTree) on each dsh given (fake model, throwaway DSH_HOME, made-up
// git project acme-web; headless):
// - off by default: the existing worktree `.worktrees/feat-search` is not a project;
// - switched on in Settings: it becomes a project nested in acme-web (dsh's Workspace Tree view);
// - a chat in acme-web whose agent runs `git switch -c feat/login-form` (a bash tool call of the fake model) while the
//   folder is clean: acme-web goes back to main, `.worktrees/feat-login-form` is the branch's worktree and a project, the
//   chat's copy opens there and continues (the next model request has the hidden note and the old messages), the old chat
//   is archived, and the copy's tools run in the new folder;
// - a chat whose agent switches to a new branch with an uncommitted file: nothing moves;
// - the branch folder deleted on disk: the project leaves the tree on window focus and its chat goes to Ungrouped.
// PLAYWRIGHT=/path/to/playwright node test/browser-branch-tree.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/branchTree.webp (English UI, demo project only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake model. "Start the login form" → a bash call `git switch -c feat/login-form`, then (after the move) a bash call
// `pwd` and the answer "Moved: <pwd output>". "Try a dirty branch" → write wip.txt, `git switch -c feat/dirty`, answer.
// Anything else: "Hello there.". Requests are kept for the checks.
const bodies = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const all = JSON.stringify(msgs);
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const say = (text) => res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    const bash = (command) => res.end(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Run a git command' }) } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
    if (/session title|next message|complete the message|improve a prompt/i.test(JSON.stringify(msgs[0]?.content ?? '') + JSON.stringify(msgs.at(-1)?.content ?? ''))) { say(''); return; }
    bodies.push(all);
    const tools = msgs.filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content));
    if (msgs.filter((m) => m.role === 'tool').length > 6) { say('Stopped.'); return; } // a red run ends
    if (all.includes('Start the login form')) {
      if (!all.includes('now has its own worktree folder')) { bash('git switch -c feat/login-form'); return; }
      const pwd = tools.findLast((t) => t.includes('worktrees'));
      if (pwd === undefined) { bash('pwd'); return; }
      say(`Moved: ${/\.worktrees\/[a-z-]+/.exec(pwd)?.[0]}`); return;
    }
    if (all.includes('Try a dirty branch')) {
      if (tools.length === 0) { bash('echo wip > wip.txt && git switch -c feat/dirty'); return; }
      say('Dirty done.'); return;
    }
    say('Hello there.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'maintenance.auto=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' });

const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) await direct.click();
  else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
  await page.getByText('Composer Plus', { exact: true }).click();
};
const closeSettings = async (page) => {
  const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
  const close = overlay.getByRole('button', { name: /^Close$/ });
  if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached' }); await pause(400);
};
// The sidebar's project rows (first text line, left edge of the text) and chat rows.
const projectRows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-row-key^="workspace:"]')].map((r) => ({ key: r.getAttribute('data-row-key'), text: r.innerText.trim().split('\n')[0], left: Math.round(r.getBoundingClientRect().left + parseFloat(getComputedStyle(r).paddingLeft || '0')) })));
const waitRow = (page, text, present = true) => page.waitForFunction(([t, p]) => [...document.querySelectorAll('[data-row-key^="workspace:"]')].some((r) => r.innerText.includes(t)) === p, [text, present], { timeout: 45000 });

const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-btree-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'btree-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
`);
    const project = join(home, 'projects', 'acme-web');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'README.md'), '# acme-web\n');
    await writeFile(join(project, '.gitignore'), '.env\n');
    await writeFile(join(project, '.worktreeinclude'), '.env\n');
    await writeFile(join(project, '.env'), 'API_URL=http://localhost:3000\n');
    git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'init');
    await writeFile(join(project, '.git/info/exclude'), '.worktrees/\n');
    git(project, 'worktree', 'add', '-q', join(project, '.worktrees', 'feat-search'), '-b', 'feat/search');
    const id = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: id },
      tables: { workspaces: { [id]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3207', '--no-open'], { cwd: project, env: { ...process.env, ...gitEnv, DSH_HOME: home, DEMO_KEY: 'demo', DSH_PERMISSION_MODE: 'danger-full-access', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const steps = []; let context;
    const step = (name) => { steps.push(name); console.log(`  ${name}`); };
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})\n${log}`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => {
        localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}');
        if (localStorage.getItem('dsh.workspace.view.v5') === null) localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({ groupBy: 'workspace-tree', orderBy: 'updated', groupExpansion: {}, sessionOrderByAccount: {}, archivedFilter: 'default' }));
      });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      // Off by default: the existing worktree is not a project.
      await pause(1500);
      assert.ok(!(await projectRows(page)).some((r) => r.text.includes('feat/search')), 'off by default: no branch project');
      await openSettings(page);
      const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name: 'Branches in the workspace tree' });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.isChecked(), false, 'the switch is off by default');
      await sw.click(); await page.waitForFunction(() => true); await pause(300);
      assert.equal(await sw.isChecked(), true);
      assert.deepEqual(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/branch-tree.json'), 'utf8')), { on: true });
      assert.equal((await stat(join(home, 'storages/dsh-composer-plus/branch-tree.json'))).mode & 0o777, 0o600);
      await closeSettings(page);
      step('Off by default; switched on in Settings');
      // The existing worktree shows as a project nested in acme-web.
      await waitRow(page, 'feat/search');
      let rows = await projectRows(page);
      const main = rows.find((r) => r.text.includes('acme-web')); const search = rows.find((r) => r.text.includes('feat/search'));
      assert.ok(rows.indexOf(search) > rows.indexOf(main) && search.left > main.left, `nested in its project: ${JSON.stringify(rows)}`);
      step('Existing worktree branch added, nested in its project');
      // A chat in acme-web whose agent creates and checks out a branch: it moves into the branch.
      await input.click(); await page.keyboard.type('Start the login form'); await page.keyboard.press('Enter');
      await page.getByText('Moved: .worktrees/feat-login-form').first().waitFor({ timeout: 60000 });
      const wt = join(project, '.worktrees', 'feat-login-form');
      assert.equal(git(project, 'branch', '--show-current').trim(), 'main', 'the project folder is back on main');
      assert.equal(git(wt, 'branch', '--show-current').trim(), 'feat/login-form', 'the branch has its worktree');
      assert.equal(await readFile(join(wt, '.env'), 'utf8'), 'API_URL=http://localhost:3000\n', '.worktreeinclude files copied');
      await waitRow(page, 'feat/login-form');
      const moved = bodies.find((b) => b.includes('now has its own worktree folder'));
      assert.ok(moved?.includes('Start the login form'), 'the copy has the old messages and the hidden note');
      assert.ok(!(await page.getByText('now has its own worktree folder').count()), 'the note is not a chat bubble');
      // The open chat is the copy, under the branch project; the old chat is archived (not in the sidebar).
      const open = await page.evaluate(() => document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.getAttribute('data-row-key'));
      assert.ok(open, 'a chat is open');
      const groups = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].map((r) => r.getAttribute('data-row-key')));
      assert.equal(groups.length, 1, `one chat row (the old one is archived): ${JSON.stringify(groups)}`);
      // The open chat row sits after the branch project's row (inside it), not after acme-web's own row.
      const order = await page.evaluate(() => [...document.querySelectorAll('[data-row-key]')].map((r) => (r.getAttribute('data-row-key').startsWith('session:') ? (r.getAttribute('aria-selected') === 'true' ? 'OPEN' : 'chat') : r.innerText.trim().split('\n')[0])));
      const above = order.slice(0, order.indexOf('OPEN')).filter((x) => x !== 'chat').at(-1);
      assert.match(above ?? '', /feat\/login-form/, `the open chat is the copy in the branch project: ${JSON.stringify(order)}`);
      step('Chat moved into its new branch and went on (pwd = the worktree)');
      if (process.env.SHOT) {
        const shot = join(home, 'bt.png');
        await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 760, height: 420 } });
        execFileSync('cwebp', ['-q', '80', shot, '-o', join(repo, 'assets/features', 'branchTree.webp')], { stdio: 'ignore' });
      }
      // Not clean: nothing moves.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n'); await pause(800);
      const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first();
      await proj.hover(); const plus = proj.getByRole('button', { name: /New session|New chat/i });
      if (await plus.count()) await plus.first().click(); await pause(800);
      await input.click(); await page.keyboard.type('Try a dirty branch'); await page.keyboard.press('Enter');
      await page.getByText('Dirty done.').first().waitFor({ timeout: 60000 }); await pause(1500);
      assert.equal(git(project, 'branch', '--show-current').trim(), 'feat/dirty', 'not clean: the folder stays on the new branch');
      await assert.rejects(stat(join(project, '.worktrees', 'feat-dirty')), 'no worktree');
      await rm(join(project, 'wip.txt')); git(project, 'switch', '-q', 'main');
      step('Uncommitted change: the chat stays');
      // The branch folder deleted on disk: the project leaves the tree on focus; its chat goes to Ungrouped.
      await rm(wt, { recursive: true, force: true });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await waitRow(page, 'feat/login-form', false);
      rows = await projectRows(page);
      assert.ok(rows.some((r) => r.text.includes('Ungrouped')), `its chat shows under Ungrouped: ${JSON.stringify(rows)}`);
      step('Deleted branch folder: project removed, chat in Ungrouped');
      // Off: no new branch project.
      await openSettings(page); await sw.click(); await pause(300); assert.equal(await sw.isChecked(), false); await closeSettings(page);
      git(project, 'worktree', 'add', '-q', join(project, '.worktrees', 'feat-later'), '-b', 'feat/later');
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await pause(2500);
      assert.ok(!(await projectRows(page)).some((r) => r.text.includes('feat/later')), 'switched off: no sync');
      step('Switch off stops the sync');
      assert.deepEqual(errors, [], 'no browser exceptions');
      results.push(`PASS ${bin}: ${steps.join(' · ')}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(tmpdir(), `btree-failed-${Date.now()}.png`) }).catch(() => {});
      console.log('  model requests:', bodies.length, bodies.slice(-4).map((b) => b.slice(-400)));
      try { console.log('  git:', git(project, 'branch', '--show-current'), git(project, 'worktree', 'list')); } catch {}
      results.push(`FAIL ${bin} after [${steps.join(', ')}]: ${error?.stack ?? error}\n${log.slice(-2500)}`);
    } finally {
      await context?.close().catch(() => {});
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 8000); }); }
      await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
for (const r of results) console.log(r);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
