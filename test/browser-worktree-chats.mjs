// Real-app check of Branch per chat (worktreeChats) on each dsh given (fake model, throwaway DSH_HOME, made-up git
// project; headless):
// - dsh 0.2.1+: the New chat screen shows the branch chip "⑂ main"; New branch + a first message → the fake model names
//   the branch, the Host creates <project>/.worktrees/feat-login-remember-me on branch feat/login-remember-me, copies only
//   the `.worktreeinclude` files (.env yes, .env.production no, node_modules as a clone), and opens a new chat there that
//   got the message. With dsh's Workspace tree view the branch folder shows inside its project (not as a top project).
// - every version: the open chat's header shows "⑂ <branch>" with its change count; a new file makes it count.
// PLAYWRIGHT=/path/to/playwright node test/browser-worktree-chats.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/worktreeChats.webp (English UI, demo project only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake model: the branch-name call (its system text asks for a git branch name) gets `feat/login-remember-me`; a chat
// title request gets a title; any other request answers "Got: <prompt>" for the newest known prompt, so the test sees
// which chat got what (dsh adds its own context messages, so the last message is not always the user's text).
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const all = JSON.stringify(msgs); const last = msgs.at(-1);
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    const say = (text) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); };
    if (/branch name/i.test(JSON.stringify(msgs[0] ?? '')) || /branch name/i.test(all.slice(0, 2000))) { say('feat/login-remember-me'); return; }
    if (/session title/i.test(JSON.stringify(last?.content))) { say('Demo chat'); return; }
    const prompt = ['Add a remember me box to the login form', 'Say hello'].findLast((p) => all.includes(p)) ?? 'something';
    say(`Got: ${prompt}`);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'maintenance.auto=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' });

const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wtc-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'wtc-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // The demo project: .env and node_modules are shared through .worktreeinclude; .env.production must never be copied.
    const project = join(home, 'projects', 'acme-web');
    await mkdir(join(project, 'node_modules/left-pad/.bin'), { recursive: true });
    await writeFile(join(project, 'README.md'), '# acme-web\n');
    await writeFile(join(project, '.gitignore'), '.env*\nnode_modules/\n');
    await writeFile(join(project, '.worktreeinclude'), '.env\nnode_modules/\n');
    await writeFile(join(project, '.env'), 'API_URL=http://localhost:3000\n');
    await writeFile(join(project, '.env.production'), 'API_URL=https://example.com\n');
    await writeFile(join(project, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
    await symlink('../index.js', join(project, 'node_modules/left-pad/.bin/left-pad'));
    git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'init');
    const id = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: id },
      tables: { workspaces: { [id]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3203', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const steps = []; const answers = []; let context;
    const step = (name) => { steps.push(name); console.log(`  ${name}`); };
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})\n${log}`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      // dsh's sidebar in Workspace tree view (its own saved setting), so branch folders nest inside their project.
      await context.addInitScript(() => {
        localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}');
        if (localStorage.getItem('dsh.workspace.view.v5') === null) localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({ groupBy: 'workspace-tree', orderBy: 'updated', groupExpansion: {}, sessionOrderByAccount: {}, archivedFilter: 'default' }));
      });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      // The Host's answers to the branch route, for the failure report.
      page.on('response', (r) => { if (r.url().includes('composer-plus.worktrees') && r.request().method() === 'POST') r.text().then((t) => answers.push(`${r.status()} ${t.slice(0, 400)}`), () => {}); });
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const send = async (text, answer) => {
        await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
        if (answer) await page.getByText(answer).first().waitFor({ timeout: 30000 });
        await pause(600);
      };
      const chip = page.locator('[data-composer-plus-new-branch-chip]');
      const hasHero = await chip.waitFor({ timeout: 8000 }).then(() => true, () => false);
      const wtPath = join(project, '.worktrees', 'feat-login-remember-me');
      if (hasHero) {
        assert.match(await chip.innerText(), /main/, 'the chip shows the current branch');
        await chip.click();
        await page.locator('[data-composer-plus-branch-new]').click();
        assert.equal(await chip.getAttribute('data-composer-plus-new-branch-chip'), 'new');
        assert.match(await chip.innerText(), /New branch/);
        await send('Add a remember me box to the login form', 'Got: Add a remember me box to the login form');
        // The new chat runs in the worktree, on the AI-named branch.
        assert.equal(git(wtPath, 'branch', '--show-current').trim(), 'feat/login-remember-me');
        assert.equal(await readFile(join(wtPath, '.env'), 'utf8'), 'API_URL=http://localhost:3000\n', '.env copied');
        await assert.rejects(stat(join(wtPath, '.env.production')), '.env.production is never copied');
        assert.equal(await readFile(join(wtPath, 'node_modules/left-pad/index.js'), 'utf8'), 'module.exports = 1;\n', 'node_modules copied');
        assert.equal(await readlink(join(wtPath, 'node_modules/left-pad/.bin/left-pad')), '../index.js', 'a symlink stays a link');
        assert.match(await readFile(join(project, '.git/info/exclude'), 'utf8'), /^\.worktrees\/$/m, '.worktrees/ is ignored locally');
        assert.equal(git(project, 'status', '--porcelain').trim(), '', 'the main checkout stays clean');
        step('New branch from the first message');
        // Workspace tree: the branch folder is a workspace nested inside acme-web (the main project row comes first).
        const rows = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="workspace:"]')].map((r) => ({ text: r.innerText.trim().split('\n')[0], left: Math.round(r.getBoundingClientRect().left + parseFloat(getComputedStyle(r).paddingLeft || '0')) })));
        const main = rows.find((r) => r.text.includes('acme-web')); const branch = rows.find((r) => r.text.includes('feat/login-remember-me'));
        assert.ok(main && branch, `both rows show: ${JSON.stringify(rows)}`);
        assert.ok(rows.indexOf(branch) > rows.indexOf(main), 'the branch row comes after its project');
        assert.ok(branch.left > main.left, `the branch row is indented inside its project: ${JSON.stringify(rows)}`);
        step('Branch folder nested in its project (Workspace tree)');
      }
      // Header pill: the open chat's branch and its change count (in the new worktree chat, or in a chat on main).
      if (!hasHero) await send('Say hello', 'Got: Say hello');
      const pill = page.locator('[data-composer-plus-branch-status]');
      await pill.waitFor({ timeout: 10000 });
      const branchName = hasHero ? 'feat/login-remember-me' : 'main';
      assert.equal(await pill.getAttribute('data-composer-plus-branch-status'), branchName);
      await writeFile(join(hasHero ? wtPath : project, 'notes.md'), 'todo\n');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForFunction(() => /1 change/.test(document.querySelector('[data-composer-plus-branch-status]')?.textContent ?? ''), null, { timeout: 10000 });
      if (process.env.SHOT && hasHero) {
        await chip.count(); const b = await pill.boundingBox(); const shot = join(home, 'wtc.png');
        await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: Math.min(1280, Math.ceil(b.x + b.width + 24)), height: 420 } });
        execFileSync('cwebp', ['-q', '80', shot, '-o', join(repo, 'assets/features', 'worktreeChats.webp')], { stdio: 'ignore' });
      }
      step(`Header pill (${branchName}, 1 change)`);
      assert.deepEqual(errors, [], 'no browser exceptions');
      results.push(`PASS ${bin}: ${steps.join(' · ')}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(tmpdir(), `wtc-failed-${Date.now()}.png`) }).catch(() => {});
      // The composer notice or a toast says why a send failed.
      const notes = await page?.evaluate(() => [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live]')].map((n) => n.innerText.trim()).filter(Boolean)).catch(() => []);
      if (notes?.length) console.log('  notices:', notes);
      if (answers.length) console.log('  worktrees POST:', answers);
      results.push(`FAIL ${bin} after [${steps.join(', ')}]: ${error?.stack ?? error}\n${log.slice(-1500)}`);
    } finally {
      await context?.close().catch(() => {});
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 8000); }); }
      await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
for (const r of results) console.log(r);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
