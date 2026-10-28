// Real-app check of the five-feature change on each dsh given (fake model, throwaway DSH_HOME, made-up git projects, a
// fake `gh` first on PATH that writes its arguments and stdin to a file and prints an issue URL; headless, no GitHub):
// 1. Git branch on chat rows: after a turn the chat row shows `main`; `git switch -c feature/login` + one more turn → the
//    pill shows `feature/login`; switched off → no pill.
// 2. Chats that changed this file: two chats write app.js; Changes → app.js "…" → Chats that changed this file lists both,
//    newest first; a click on the older one opens that chat and its request blinks.
// 3. Find in chat: Cmd+F on a Mac (Ctrl+F elsewhere) opens the box, Ctrl+F on a Mac does not; "npm test" → "1 / 3" and CSS
//    highlights; Enter → "2 / 3"; Shift+Enter back; Esc closes, the highlights go and the focus goes back to the composer;
//    Cmd/Ctrl+Alt+F does not open it.
// 4. Open GitHub issue: Feature ideas → Later list (an idea saved through the Host route) → Open GitHub issue → the fake gh
//    got `issue create --title=<title> --body-file -` in the project folder with the summary on stdin → "Issue #7" link.
// PLAYWRIGHT=/path/to/playwright node test/browser-five-features.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/{sessionBranch,findInChat}.webp (English UI, demo projects only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake model: "Edit app <n>" → one write tool call for app.js, then "Edited app <n>."; "Run the tests" → an answer that
// says npm test three times in three paragraphs; anything else: "Hello there.".
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = JSON.stringify(last?.content ?? '');
    if (/session title|next message|complete the message|improve a prompt/i.test(JSON.stringify(msgs[0]?.content ?? '') + text)) { res.end(chunk({ role: 'assistant', content: '' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); return; }
    const users = msgs.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    const prompt = users.findLast((u) => /Edit app \d|Run the tests|Say hello/.test(u)) ?? '';
    const edit = /Edit app (\d)/.exec(prompt);
    // dsh's write tool refuses a file that the chat did not read first: read app.js (missing for the first chat), then write it.
    const tools = msgs.filter((m) => m.role === 'tool').length;
    if (edit && tools < 2) {
      const [name, args] = tools === 0 ? ['read', { file_path: 'app.js' }] : ['write', { file_path: 'app.js', content: `export const v = ${edit[1]};\n` }];
      const call = { index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
      res.end(chunk({ role: 'assistant', tool_calls: [call] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    const answer = edit ? `Edited app ${edit[1]}.` : prompt.includes('Run the tests')
      ? 'First run npm test in the root.\n\nThen run NPM Test again in the web folder.\n\nIf npm test fails, read the log.' : 'Hello there.';
    res.end(chunk({ role: 'assistant', content: answer }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'maintenance.auto=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
const webp = (png, name) => execFileSync('cwebp', ['-q', '80', png, '-o', join(repo, 'assets/features', `${name}.webp`)], { stdio: 'ignore' });

const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-five-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'five-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // A fake gh: records its arguments, folder and stdin, and prints an issue URL like the real one.
    const fakeBin = join(home, 'bin'); await mkdir(fakeBin);
    const ghLog = join(home, 'gh-calls.jsonl');
    // node reads stdin itself; the arguments come after `--`.
    await writeFile(join(fakeBin, 'gh'), `#!/bin/sh
node -e 'const fs=require("fs");const stdin=fs.readFileSync(0,"utf8");fs.appendFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),stdin,prompt:process.env.GH_PROMPT_DISABLED})+"\\n")' ${JSON.stringify(ghLog)} "$@"
echo "Creating issue in acme/web"
echo
echo "https://github.com/acme/web/issues/7"
`);
    await chmod(join(fakeBin, 'gh'), 0o755);
    const project = join(home, 'projects', 'acme-web');
    await mkdir(project, { recursive: true }); git(project, 'init', '-q', '-b', 'main');
    await writeFile(join(project, 'README.md'), '# demo\n');
    git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'init');
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid },
      tables: { workspaces: { [wid]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3202', '--no-open'], { cwd: project,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const steps = []; let context;
    const step = (name) => { steps.push(name); console.log(`  ${name}`); };
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})\n${log}`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      // The init script runs at every load: a later step stores its switches in sessionStorage, so a reload keeps them.
      // Branch per chat off: a new chat in this git project would start on a new branch (its default).
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', sessionStorage.getItem('five.features') ?? '{"autoUpdate":false,"worktreeChats":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const send = async (text, answer) => {
        await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
        if (answer) await page.getByText(answer).first().waitFor({ timeout: 30000 });
        await pause(800);
      };
      const current = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => r.getAttribute('aria-selected') === 'true' || r.getAttribute('aria-current') === 'page')?.getAttribute('data-row-key').slice(8) ?? null);
      const newChat = async () => {
        await page.locator(`[data-row-key="workspace:${wid}"]`).hover();
        await page.getByRole('button', { name: 'New session in acme-web', exact: true }).click(); await pause(800);
      };

      // 1. Git branch on chat rows.
      await send('Edit app 1', 'Edited app 1.');
      assert.equal(await readFile(join(project, 'app.js'), 'utf8'), 'export const v = 1;\n', 'the first chat wrote app.js');
      const chat1 = await current(); assert.ok(chat1, 'the open chat has a sidebar row');
      const pill = (id) => page.locator(`[data-row-key="session:${id}"] [data-composer-plus-branch-name]`);
      await pill(chat1).waitFor({ timeout: 10000 });
      assert.equal(await pill(chat1).getAttribute('data-composer-plus-branch-name'), 'main');
      git(project, 'switch', '-q', '-c', 'feature/login');
      await send('Say hello', 'Hello there.');
      await page.waitForFunction((id) => document.querySelector(`[data-row-key="session:${id}"] [data-composer-plus-branch-name]`)?.dataset.composerPlusBranchName === 'feature/login', chat1, { timeout: 10000 });
      assert.equal(await pill(chat1).getAttribute('title'), 'Git branch at the last turn: feature/login');
      git(project, 'switch', '-q', 'main');
      if (process.env.SHOT) {
        const r = await page.locator(`[data-row-key="session:${chat1}"]`).boundingBox(); const shot = join(home, 'branch.png');
        await page.screenshot({ path: shot, clip: { x: 0, y: Math.max(0, r.y - 60), width: Math.min(360, r.x + r.width + 8), height: r.height + 100 } }); webp(shot, 'sessionBranch');
      }
      step('Git branch on chat rows');

      // 2. Chats that changed this file: a second chat writes app.js too.
      await newChat();
      await send('Edit app 2', 'Edited app 2.');
      assert.equal(await readFile(join(project, 'app.js'), 'utf8'), 'export const v = 2;\n', 'the second chat wrote app.js');
      const chat2 = await current();
      assert.notEqual(chat2, chat1);
      await page.getByRole('button', { name: 'Open right sidebar' }).click(); await pause(700);
      await page.getByText('Changes', { exact: true }).first().click();
      const panel = page.locator('[data-composer-plus-changes]'); await panel.waitFor({ timeout: 8000 });
      await panel.locator('[data-composer-plus-file-menu="app.js"]').waitFor({ timeout: 15000 });
      await panel.locator('[data-composer-plus-file-menu="app.js"]').click();
      await page.getByRole('menuitem', { name: 'Chats that changed this file' }).click();
      const rows = panel.locator('[data-composer-plus-file-chat]'); await rows.first().waitFor({ timeout: 15000 });
      const keys = await rows.evaluateAll((els) => els.map((e) => e.dataset.composerPlusFileChat.split('#')[0]));
      assert.deepEqual(keys, [chat2, chat1], 'both chats, newest first');
      assert.match(await rows.nth(0).innerText(), /this chat/, 'the open chat is marked');
      assert.match(await rows.nth(1).innerText(), /Edit app 1/, 'the request text');
      // Back shows the files again; the menu opens the list again.
      await page.locator('[data-composer-plus-file-chats-back]').click();
      await panel.locator('[data-composer-plus-file-menu="app.js"]').click();
      await page.getByRole('menuitem', { name: 'Chats that changed this file' }).click();
      await rows.first().waitFor({ timeout: 15000 });
      await rows.nth(1).click();
      await page.waitForFunction((id) => document.querySelector(`[data-row-key="session:${id}"]`)?.getAttribute('aria-selected') === 'true', chat1, { timeout: 10000 });
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-jump]') !== null, null, { timeout: 15000 });
      assert.match(await page.locator('[data-composer-plus-jump]').innerText(), /Edit app 1/, 'the request blinks');
      // The list belongs to the chat that opened it: the other chat's panel shows its own files.
      assert.equal(await page.locator('[data-composer-plus-file-chats]').count(), 0, 'chat 1 shows its own Changes view');
      step('Chats that changed this file');

      // 3. Find in chat (the right sidebar closed, so the chat has its full width).
      const collapse = page.getByRole('button', { name: 'Collapse right sidebar', exact: true });
      if (await collapse.isVisible().catch(() => false)) { await collapse.click(); await pause(500); }
      await send('Run the tests', 'If npm test fails, read the log.');
      await input.click();
      await page.keyboard.press('ControlOrMeta+Alt+KeyF'); await pause(400);
      assert.equal(await page.locator('[data-composer-plus-find]').count(), 0, 'Ctrl/Cmd+Alt+F stays dsh\'s');
      // On a Mac, Ctrl+F stays the text field key (cursor one character forward); Cmd+F opens the box there.
      if (await page.evaluate(() => /Mac/i.test(navigator.platform))) {
        await page.keyboard.press('Control+KeyF'); await pause(400);
        assert.equal(await page.locator('[data-composer-plus-find]').count(), 0, 'Ctrl+F on a Mac opens nothing');
      }
      await page.keyboard.press('ControlOrMeta+KeyF');
      const box = page.locator('[data-composer-plus-find] input'); await box.waitFor({ timeout: 5000 });
      // The box takes the focus in the next animation frame after it renders (it can be in the page a frame before that).
      await page.waitForFunction(() => document.activeElement === document.querySelector('[data-composer-plus-find] input'), null, { timeout: 3000 })
        .catch(() => assert.fail('the box takes the focus'));
      await page.keyboard.type('npm test');
      const count = page.locator('[data-composer-plus-find] [role="status"]');
      await page.waitForFunction(() => /\/ 3$/.test(document.querySelector('[data-composer-plus-find] [role="status"]')?.textContent ?? ''), null, { timeout: 5000 });
      assert.equal(await count.innerText(), '1 / 3');
      assert.ok(await page.evaluate(() => CSS.highlights.has('cp-find') && CSS.highlights.get('cp-find').size === 3), 'three highlights');
      await page.keyboard.press('Enter'); await page.waitForFunction(() => document.querySelector('[data-composer-plus-find] [role="status"]')?.textContent === '2 / 3', null, { timeout: 3000 });
      await page.keyboard.press('Shift+Enter'); await page.waitForFunction(() => document.querySelector('[data-composer-plus-find] [role="status"]')?.textContent === '1 / 3', null, { timeout: 3000 });
      if (process.env.SHOT) {
        await page.keyboard.press('Enter'); await pause(500);
        // From the box down to the last highlighted match, so the picture shows the box and the colored matches.
        const area = await page.evaluate(() => {
          const box = document.querySelector('[data-composer-plus-find]').getBoundingClientRect();
          const rects = [...CSS.highlights.get('cp-find')].map((r) => r.getBoundingClientRect());
          const left = Math.min(box.left, ...rects.map((r) => r.left)) - 16; const bottom = Math.max(...rects.map((r) => r.bottom)) + 16;
          return { x: Math.max(0, left), y: Math.max(0, box.top - 8), width: Math.min(innerWidth, box.right + 8) - Math.max(0, left), height: Math.min(innerHeight, bottom) - Math.max(0, box.top - 8) };
        });
        const shot = join(home, 'find.png'); await page.screenshot({ path: shot, clip: area }); webp(shot, 'findInChat');
      }
      await page.keyboard.press('Escape');
      await page.locator('[data-composer-plus-find]').waitFor({ state: 'detached', timeout: 3000 });
      assert.ok(await page.evaluate(() => !CSS.highlights.has('cp-find') && !CSS.highlights.has('cp-find-current')), 'Esc clears the highlights');
      assert.ok(await page.evaluate(() => document.activeElement?.closest('[data-composer-input]') !== null), 'the focus goes back to the composer');
      step('Find in chat');

      // 4. Open GitHub issue from the Later list.
      const saved = await page.evaluate(async (sessionId) => (await (await fetch('/api/composer-plus.later', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, add: { title: 'Pantry tracker', summary: 'Track food at home.', why: 'Less waste.' } }) })).json()), chat1);
      assert.equal(saved.ideas[0].title, 'Pantry tracker');
      // The Ideas page: a new right-sidebar tab ("New tab", next to the Changes tab), then dsh's guide entry.
      // The Ideas page: dsh's Start page lists it (a chat with no right-sidebar tab yet); else a new tab ("New tab") shows the
      // same guide.
      const guide = page.getByText('Feature ideas', { exact: true }).filter({ visible: true }).first();
      if (!(await guide.waitFor({ timeout: 4000 }).then(() => true, () => false))) {
        const openRight = page.getByRole('button', { name: 'Open right sidebar', exact: true });
        if (await openRight.isVisible().catch(() => false)) { await openRight.click(); await pause(700); }
        if (!(await guide.waitFor({ timeout: 3000 }).then(() => true, () => false))) await page.getByRole('button', { name: 'New tab', exact: true }).click();
      }
      await guide.click();
      const ideas = page.locator('[data-composer-plus-ideas]'); await ideas.waitFor({ timeout: 10000 });
      await ideas.locator('[data-composer-plus-ideas-later]').click();
      await ideas.locator(`[data-composer-plus-ideas-issue="${saved.ideas[0].id}"]`).click();
      const link = ideas.locator(`[data-composer-plus-ideas-issue-link="${saved.ideas[0].id}"]`); await link.waitFor({ timeout: 15000 });
      assert.equal(await link.getAttribute('href'), 'https://github.com/acme/web/issues/7'); assert.equal(await link.innerText(), 'Issue #7');
      const calls = (await readFile(ghLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(calls.length, 1, 'gh ran once');
      assert.deepEqual(calls[0].argv, ['issue', 'create', '--title=Pantry tracker', '--body-file', '-']);
      assert.equal(await realpath(calls[0].cwd), project, 'in the project folder');
      assert.equal(calls[0].stdin, 'Track food at home.\n\n**Why:** Less waste.\n');
      assert.equal(calls[0].prompt, '1', 'gh never prompts');
      step('Open GitHub issue');

      // Switches off: no pill, no find box.
      await page.evaluate(() => fetch('/api/composer-plus.branches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: false }) }));
      assert.deepEqual(await page.evaluate(async () => (await fetch('/api/composer-plus.branches')).json()), { on: false, branches: {} });
      await page.evaluate(() => { sessionStorage.setItem('five.features', '{"autoUpdate":false,"worktreeChats":false,"findInChat":false}'); });
      await page.reload(); await input.waitFor({ timeout: 20000 }); await pause(1500);
      assert.equal(await page.locator('[data-composer-plus-branch-name]').count(), 0, 'Host switch off: no pills');
      await input.click(); await page.keyboard.press('ControlOrMeta+KeyF'); await pause(400);
      assert.equal(await page.locator('[data-composer-plus-find]').count(), 0, 'feature off: no find box');
      step('switches off');

      assert.deepEqual(errors, [], 'no browser exceptions');
      results.push(`PASS ${bin}: ${steps.join(' · ')}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(tmpdir(), `five-failed-${Date.now()}.png`) }).catch(() => {});
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
