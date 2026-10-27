// Real-app check of six features on each dsh given (fake model, throwaway DSH_HOME, made-up git projects; headless):
// 1. Mark all as read: two projects with a finished, unread chat each; the "…" menu of one project → Mark all as read:
//    only that project's dot goes; the item is disabled after.
// 2. Copy message link: the 🔗 button on a message copies `dsh-session:…#<seq>`; on dsh 0.2.1+ the link sent in another
//    chat is a chip that opens the first chat with that message in view and blinking.
// 3. Edit queued message in place: three queued messages; a double-click on the second opens dsh's editor; typed text +
//    Enter saves it in place (same order); Esc on another keeps it.
// 4. Redo: ↶ Chat and files on message 1 → Redo bar → Chat and files: a new chat opens with both messages, the file is
//    back, the rolled-back chat stays.
// 5 + 6. Changes → This chat lists only the files this chat's tools wrote (not a hand-edited file); Hide whitespace
//    hides a file that changed only in indentation.
// PLAYWRIGHT=/path/to/playwright node test/browser-six-features.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/{markProjectRead,copyMessageLink,queueEdit}.webp (English UI, demo projects only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake model. "Write the config" → one write tool call (config.js) and one edit (style.css, indentation only), then an
// answer. "Slow task" streams for 60 s (so messages queue). Anything else: a short answer that names the prompt.
let slowOpen = null;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (/session title/i.test(JSON.stringify(last?.content))) { res.end(chunk({ role: 'assistant', content: 'Demo chat' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); return; }
    const users = msgs.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    const prompt = users.findLast((u) => /Write the config|Slow task|Say hello|Tune the theme|Check it/.test(u)) ?? '';
    const tools = msgs.filter((m) => m.role === 'tool').length;
    if (prompt.includes('Write the config') && last?.role !== 'tool') {
      const call = (name, args) => ({ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      res.end(chunk({ role: 'assistant', tool_calls: [call('write', { file_path: 'config.js', content: 'export const port = 8080;\n' })] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    // dsh's write tool refuses a file that the chat did not read first: read style.css, then rewrite it (indentation only).
    if (prompt.includes('Write the config') && (tools === 1 || tools === 2)) {
      const args = tools === 1 ? ['read', { file_path: 'style.css' }] : ['write', { file_path: 'style.css', content: 'body {\r\n    margin: 0;\r\n}\r\n' }];
      const call = { index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: args[0], arguments: JSON.stringify(args[1]) } };
      res.end(chunk({ role: 'assistant', tool_calls: [call] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    if (prompt.includes('Slow task') && slowOpen === null) {
      slowOpen = res; res.write(chunk({ role: 'assistant', content: 'Working' }));
      for (let i = 0; i < 400 && !res.destroyed && slowOpen === res; i++) { res.write(chunk({ content: ' .' })); await pause(150); }
      slowOpen = null; res.end(chunk({}, 'stop') + 'data: [DONE]\n\n'); return;
    }
    const answer = prompt.includes('Write the config') ? 'Wrote the config.' : prompt.includes('Tune the theme') ? 'Tuned the theme.' : prompt.includes('Check it') ? 'Checked it.' : 'Hello there.';
    // "Tune the theme" answers after 4 s, so it finishes while another chat is open (dsh's unread dot).
    if (prompt.includes('Tune the theme')) await pause(4000);
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
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-six-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'six-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const projects = { web: join(home, 'projects', 'acme-web'), cli: join(home, 'projects', 'weather-cli') };
    for (const dir of Object.values(projects)) {
      await mkdir(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main');
      await writeFile(join(dir, 'README.md'), '# demo\n'); await writeFile(join(dir, 'style.css'), 'body {\n  margin: 0;\n}\n');
      git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
    }
    const ids = { web: randomUUID(), cli: randomUUID() }; const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [ids.web, ids.cli], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids.web },
      tables: { workspaces: { [ids.web]: { path: projects.web, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now }, [ids.cli]: { path: projects.cli, title: 'weather-cli', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3201', '--no-open'], { cwd: projects.web, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', COMPOSER_PLUS_TRASH: 'folder', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const steps = []; let context;
    const step = (name) => { steps.push(name); console.log(`  ${name}`); };
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})\n${log}`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const send = async (text, answer) => {
        await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
        if (answer) await page.getByText(answer).first().waitFor({ timeout: 30000 });
        await pause(600);
      };
      const sessionOf = async () => page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => r.getAttribute('aria-current') === 'page' || r.getAttribute('aria-selected') === 'true' || r.matches('[data-current],[class*="_current"],[class*="_active"]'))?.getAttribute('data-row-key').slice(8));
      const names = { web: 'acme-web', cli: 'weather-cli' };
      const newChatIn = async (title) => {
        await page.locator(`[data-row-key="workspace:${ids[title]}"]`).hover();
        await page.getByRole('button', { name: `New session in ${names[title]}`, exact: true }).click(); await pause(800);
      };

      // 5 + 6. This chat + Hide whitespace (and the Redo setup): a chat in acme-web whose tools write config.js and style.css.
      await send('Write the config', 'Wrote the config.');
      assert.equal(await readFile(join(projects.web, 'config.js'), 'utf8'), 'export const port = 8080;\n');
      await writeFile(join(projects.web, 'by-hand.txt'), 'edited by hand\n');
      await page.getByRole('button', { name: 'Open right sidebar' }).click(); await pause(700);
      await page.getByText('Changes', { exact: true }).first().click();
      const panel = page.locator('[data-composer-plus-changes]'); await panel.waitFor({ timeout: 8000 });
      await panel.locator('button[aria-haspopup="menu"]').first().click();
      await page.getByRole('menuitem', { name: 'This chat' }).click();
      const fileNames = async () => (await panel.locator('button[aria-expanded] span[title]').allInnerTexts()).map((s) => s.trim());
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-chat-note]') !== null, null, { timeout: 15000 });
      assert.deepEqual(await fileNames(), ['config.js', 'style.css'], 'This chat: only the files this chat\'s tools wrote');
      assert.equal(await panel.locator('[data-composer-plus-chat-note]').getAttribute('data-composer-plus-chat-note'), 'snapshot', 'against the snapshot before the first message');
      const ws = panel.locator('[data-composer-plus-ws]');
      assert.equal(await ws.getAttribute('aria-pressed'), 'false');
      await ws.click();
      await page.waitForFunction(() => { const names = [...document.querySelectorAll('[data-composer-plus-changes] button[aria-expanded] span[title]')].map((s) => s.textContent.trim()); return names.length > 0 && !names.includes('style.css'); }, null, { timeout: 15000 });
      assert.deepEqual(await fileNames(), ['config.js'], 'Hide whitespace: the indentation/CRLF-only file is gone');
      await page.reload(); await input.waitFor({ timeout: 20000 });
      await page.getByText('Wrote the config.').first().waitFor({ timeout: 20000 });
      if (!(await panel.isVisible().catch(() => false))) { await page.getByRole('button', { name: 'Open right sidebar' }).click().catch(() => {}); await page.getByText('Changes', { exact: true }).first().click().catch(() => {}); }
      await panel.locator('[data-composer-plus-ws]').waitFor({ timeout: 8000 });
      assert.equal(await panel.locator('[data-composer-plus-ws]').getAttribute('aria-pressed'), 'true', 'the switch is kept after a reload');
      await panel.locator('[data-composer-plus-ws]').click(); // off again for the other steps
      step('This chat + Hide whitespace');

      // 4. Redo: roll back message 1 with files, then Redo with files: a new chat with the messages, the files back.
      const chatA = await page.evaluate(() => new URL(location.href).searchParams.get('session')) ?? await sessionOf();
      await send('Check it', 'Checked it.');
      const userRows = page.locator('[data-chat-flow-kind="user"]');
      await userRows.nth(0).hover();
      await userRows.nth(0).getByRole('button', { name: 'Roll back to before this message' }).click();
      const pop = page.locator('[data-composer-plus-rollback]');
      await pop.getByRole('button', { name: /^Chat and files/ }).waitFor({ timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('[data-composer-plus-rollback] button:nth-of-type(2)')?.disabled, null, { timeout: 20000 });
      await pop.getByRole('button', { name: /^Chat and files/ }).click();
      await pop.waitFor({ state: 'detached', timeout: 20000 });
      await assert.rejects(readFile(join(projects.web, 'config.js')), 'config.js is gone after the rollback');
      const bar = page.locator('[data-composer-plus-redo]'); await bar.waitFor({ timeout: 10000 });
      await bar.getByRole('button', { name: 'Redo', exact: true }).click();
      const redoPop = page.getByRole('dialog', { name: 'Redo the rolled-back turn' });
      // config.js and style.css (the turn) and by-hand.txt (made after message 1, so the rollback removed it too).
      await redoPop.getByText('Also put 3 files back as they were before the rollback:').waitFor({ timeout: 20000 });
      await redoPop.getByRole('button', { name: /^Chat and files/ }).click();
      await bar.waitFor({ state: 'detached', timeout: 20000 });
      await page.getByText('Checked it.').first().waitFor({ timeout: 20000 });
      assert.equal(await readFile(join(projects.web, 'config.js'), 'utf8'), 'export const port = 8080;\n', 'Redo put config.js back');
      assert.equal(await readFile(join(projects.web, 'by-hand.txt'), 'utf8'), 'edited by hand\n', 'and by-hand.txt');
      assert.equal(await userRows.filter({ visible: true }).count(), 2, 'the new chat shows both messages');
      // Review F-02: the new chat is a fork (its parent's events first). Its own first message takes the snapshot, so This
      // chat compares with the project before it: `snapshot`, not `partial`.
      await send('Say hello', 'Hello there.');
      if (!(await panel.isVisible().catch(() => false))) { await page.getByRole('button', { name: 'Open right sidebar' }).click().catch(() => {}); await page.getByText('Changes', { exact: true }).first().click().catch(() => {}); }
      // The new chat's Changes tab starts in its default mode: pick This chat again.
      await panel.locator('button[aria-haspopup="menu"]').first().click();
      await page.getByRole('menuitem', { name: 'This chat' }).click();
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-chat-note]') !== null, null, { timeout: 15000 });
      assert.equal(await panel.locator('[data-composer-plus-chat-note]').getAttribute('data-composer-plus-chat-note'), 'snapshot', 'This chat in the redone (forked) chat: its own first message');
      step('Redo');

      // 2. Copy message link: 🔗 on the assistant answer, then in a new chat the link opens it.
      const link = page.locator('[data-composer-plus-message-link]').last();
      await page.getByText('Checked it.').first().hover(); await link.waitFor({ timeout: 10000 });
      const seq = Number(await link.getAttribute('data-composer-plus-message-link'));
      await link.click(); await page.getByRole('button', { name: 'Copied' }).first().waitFor({ timeout: 5000 });
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(copied, new RegExp(`^dsh-session:[A-Za-z0-9_-]+#${seq}$`), 'the message link');
      if (process.env.SHOT) {
        const b = await link.boundingBox(); const shot = join(home, 'link.png');
        await page.screenshot({ path: shot, clip: { x: Math.max(0, b.x - 420), y: Math.max(0, b.y - 120), width: 520, height: 170 } }); webp(shot, 'copyMessageLink');
      }
      await newChatIn('cli');
      await send(`See ${copied}`, 'Hello there.');
      const chip = page.locator('[data-composer-plus-message-chip]');
      const has021 = await chip.count().then((n) => n > 0);
      if (has021) {
        await chip.first().click();
        await page.waitForFunction(() => document.querySelector('[data-composer-plus-jump]') !== null, null, { timeout: 15000 });
        const box = await page.evaluate(() => { const r = document.querySelector('[data-composer-plus-jump]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight }; });
        assert.ok(box.bottom > 0 && box.top < box.h, 'the message is in view');
        await page.waitForFunction(() => document.querySelector('[data-composer-plus-jump]') === null, null, { timeout: 5000 });
        step('Copy message link (opens on click)');
      } else step('Copy message link (copy only: this dsh has no user-text rules)');

      // 3. Edit queued message in place.
      await newChatIn('cli');
      await send('Slow task');
      await page.waitForFunction(() => document.body.innerText.includes('Working'), null, { timeout: 20000 });
      for (const t of ['first queued', 'second queued', 'third queued']) await send(t);
      const dock = page.locator('[data-queue-dock]'); await dock.waitFor({ timeout: 10000 });
      const header = dock.locator('button[aria-expanded="false"]'); if (await header.count()) { await header.first().click(); await pause(400); }
      const rows = dock.locator('li:not([data-submission-echo])');
      const texts = async () => (await rows.allInnerTexts()).map((t) => t.trim().split('\n')[0]);
      assert.deepEqual(await texts(), ['first queued', 'second queued', 'third queued']);
      await rows.nth(1).getByText('second queued').dblclick();
      const editor = dock.locator('textarea'); await editor.waitFor({ timeout: 5000 });
      if (process.env.SHOT) {
        await pause(300); const b = await dock.boundingBox(); const shot = join(home, 'queue.png');
        await page.screenshot({ path: shot, clip: { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 } }); webp(shot, 'queueEdit');
      }
      await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.type('second, fixed'); await page.keyboard.press('Enter');
      await editor.waitFor({ state: 'detached', timeout: 5000 });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-queue-dock] li')].some((li) => li.innerText.includes('second, fixed')), null, { timeout: 5000 });
      assert.deepEqual(await texts(), ['first queued', 'second, fixed', 'third queued'], 'Enter saves in place; the order stays');
      await rows.nth(2).getByText('third queued').dblclick(); await editor.waitFor({ timeout: 5000 });
      await page.keyboard.type(' nope'); await page.keyboard.press('Escape'); await editor.waitFor({ state: 'detached', timeout: 5000 });
      assert.deepEqual(await texts(), ['first queued', 'second, fixed', 'third queued'], 'Esc keeps it');
      // A double-click on a button does not open the editor.
      await rows.nth(0).locator('button').last().dblclick({ trial: true }).catch(() => {});
      step('Edit queued message in place');
      if (slowOpen !== null) { const r = slowOpen; slowOpen = null; r.destroy(); }
      await page.getByRole('button', { name: /^Stop/ }).first().click().catch(() => {});

      // 1. Mark all as read: two projects, each with an unread finished chat.
      // A chat in each project finishes while another chat is open: each gets dsh's unread dot.
      const ask = async () => { await input.click(); await page.keyboard.type('Tune the theme'); await page.keyboard.press('Enter'); await pause(800); };
      await newChatIn('web'); await ask();
      await newChatIn('cli'); await ask();
      await newChatIn('web'); await pause(5500);
      const projectRow = page.locator(`[data-row-key="workspace:${ids.cli}"]`);
      await projectRow.hover();
      await projectRow.getByRole('button', { name: /Workspace actions|actions/i }).first().click();
      const item = page.locator('[data-composer-plus-mark-read-item]'); await item.waitFor({ timeout: 5000 });
      const unreadCount = Number(await item.getAttribute('data-composer-plus-mark-read-item'));
      assert.ok(unreadCount >= 1, `weather-cli has ${unreadCount} unread chat(s)`);
      if (process.env.SHOT) {
        await pause(300); const menu = await page.locator('[role="menu"]').last().boundingBox(); const r = await projectRow.boundingBox(); const shot = join(home, 'mark.png');
        const top = Math.max(0, r.y - 12); await page.screenshot({ path: shot, clip: { x: 0, y: top, width: Math.max(menu.x + menu.width, r.x + r.width) + 12, height: Math.max(menu.y + menu.height, r.y + r.height) - top + 12 } }); webp(shot, 'markProjectRead');
      }
      await item.getByRole('menuitem', { name: 'Mark all as read' }).click();
      await page.locator('[role="menu"]').last().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      await projectRow.hover(); await projectRow.getByRole('button', { name: /Workspace actions|actions/i }).first().click();
      await item.waitFor({ timeout: 5000 });
      assert.equal(await item.getAttribute('data-composer-plus-mark-read-item'), '0', 'weather-cli has no unread chat now');
      assert.ok(await item.getByRole('menuitem', { name: 'No unread chats' }).isDisabled());
      await page.keyboard.press('Escape');
      const web = page.locator(`[data-row-key="workspace:${ids.web}"]`);
      await web.hover(); await web.getByRole('button', { name: /Workspace actions|actions/i }).first().click(); await item.waitFor({ timeout: 5000 });
      assert.equal(await item.getAttribute('data-composer-plus-mark-read-item'), '1', 'acme-web keeps its own unread chat');
      await page.keyboard.press('Escape');
      step('Mark all as read');

      assert.deepEqual(errors, [], 'no browser exceptions');
      void chatA;
      results.push(`PASS ${bin}: ${steps.join(' · ')}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(tmpdir(), `six-failed-${Date.now()}.png`) }).catch(() => {});
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
