// Real-app check of "Turn rollback" and "Delete chat" on each dsh given: a fake model, a throwaway DSH_HOME, a made-up
// git project. Never the normal DSH_HOME, no real model and no real project.
// 0. The composer's stats row starts with the project name.
// 1. Message 1 → the model edits app.js with bash (a command, not dsh's write tool) and adds notes.md. Message 2 → another
//    answer. ↶ on message 1 → the popover lists the 2 files → "Chat and files": both messages and replies are hidden, the
//    composer holds message 1 again, app.js is back, notes.md is gone, and the project's .git is unchanged. The next model
//    request has neither message. After a reload the rows stay hidden.
// 2. "Chat only" on a later message: files stay.
// 3. Delete chat: "…" → Delete… → Delete: the row goes away, the log folder leaves the sessions folder (to the macOS Trash,
//    with TRASH=1, else the trash folder under the test home), the id is archived; no browser exceptions.
// PLAYWRIGHT=/path/to/playwright node test/browser-turn-rollback.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/turnRollback.webp and deleteChat.webp (English UI, demo project only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, realpath, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model. "Rename the greeting" → one bash call that edits app.js and adds notes.md, then an answer.
const M1 = 'Rename the greeting to Hello, world';
const M2 = 'Now add a short comment on top';
const M3 = 'What does the app print now?';
const requests = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const end = () => res.end('data: [DONE]\n\n');
    if (/session title/i.test(JSON.stringify(last?.content))) { send({ role: 'assistant', content: 'Greeting change' }); send({}, 'stop'); end(); return; }
    requests.push(JSON.stringify(msgs));
    const users = msgs.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    // dsh adds context messages with the user role too: take the newest message that is one of the prompts.
    const lastUser = users.findLast((u) => [M1, M2, M3].some((m) => u.includes(m))) ?? '';
    if (last?.role !== 'tool' && lastUser.includes(M1)) {
      const command = "printf 'console.log(\"Hello, world\");\\n' > app.js && printf 'notes\\n' > notes.md";
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Edit the greeting' }) } }] });
      send({}, 'tool_calls'); end(); return;
    }
    const answer = lastUser.includes(M1) ? 'Renamed the greeting.' : lastUser.includes(M2) ? 'Added the comment.' : 'It prints Hi.';
    send({ role: 'assistant', content: answer }); send({}, 'stop'); end();
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' } });
const fingerprint = async (dir) => {
  const lines = [];
  const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else lines.push(`${p} ${createHash('sha1').update(await readFile(p)).digest('hex')}`); } };
  await walk(dir); return lines.sort().join('\n');
};

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    requests.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-turn-rollback-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'turn-rollback-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'greeter'); await mkdir(project, { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    await writeFile(join(project, 'app.js'), 'console.log("Hi");\n');
    await writeFile(join(project, 'README.md'), '# Greeter\n');
    git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'Initial greeter');
    const gitBefore = await fingerprint(join(project, '.git'));
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'greeter', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    let child; let log = ''; let allLogs = '';
    const start = async () => {
      log = '';
      child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3196', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), ...(process.env.TRASH ? {} : { COMPOSER_PLUS_TRASH: 'folder' }) }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      return url;
    };
    const stop = async () => { allLogs += log; if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 8000); }); } };
    const errors = []; let context; let passed = false;
    try {
      let url = await start();
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const open = async () => {
        await page.goto(url);
        for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
        await page.locator('[data-composer-input]').waitFor({ timeout: 20000 });
      };
      await open();
      const composer = page.locator('[data-composer-input]');
      const send = async (text, answer) => {
        await composer.click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
        // The bash call may need an approval in this profile: allow it once.
        const deadline = Date.now() + 30000;
        while (!(await page.getByText(answer).first().isVisible().catch(() => false))) {
          const allow = page.getByRole('button', { name: /^(Allow once|Allow|Approve)$/ }).first();
          if (await allow.isVisible().catch(() => false)) await allow.click();
          if (Date.now() > deadline) throw Error(`no answer: ${answer}`);
          await pause(200);
        }
        await pause(700);
      };
      // 1. Two messages; the first one's turn changes files through bash.
      await send(M1, 'Renamed the greeting.');
      // Project name in the composer: left of dsh's stats pills, the project folder as tooltip.
      const projectPill = page.locator('[data-composer-plus-project]');
      await projectPill.waitFor({ timeout: 10000 });
      assert.equal((await projectPill.innerText()).trim(), 'greeter');
      assert.equal(await projectPill.getAttribute('title'), project);
      // dsh 0.2.1 marks each pill (`data-composer-stat`); 0.2.0 has one `data-composer-stats` group.
      const first = await page.evaluate(() => document.querySelector('[data-composer-plus-project], [data-composer-stat], [data-composer-stats]')?.hasAttribute('data-composer-plus-project'));
      assert.equal(first, true, 'the project name comes first in the stats row');
      if (process.env.SHOT) {
        const dock = await page.locator('[data-composer-dock]').boundingBox();
        const card = await page.locator('[data-composer-input]').evaluate((el) => { const r = (el.closest('[data-composer-card]') ?? el).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; });
        const shot = join(home, 'project-name.png');
        const top = card.y - 12; const left = Math.max(0, Math.min(card.x, dock.x) - 12);
        const right = Math.min(1280, Math.max(card.x + card.width, dock.x + dock.width) + 12);
        await page.screenshot({ path: shot, clip: { x: left, y: top, width: right - left, height: dock.y + dock.height - top + 10 } });
        execFileSync('cwebp', ['-q', '82', shot, '-o', join(repo, 'assets/features/projectName.webp')], { stdio: 'ignore' });
      }
      assert.equal(await readFile(join(project, 'app.js'), 'utf8'), 'console.log("Hello, world");\n', 'the model changed app.js');
      await send(M2, 'Added the comment.');
      const userRows = page.locator('[data-chat-flow-kind="user"]');
      await userRows.nth(1).waitFor();
      // ↶ on message 1 (hover shows the action row).
      await userRows.nth(0).hover();
      const button = userRows.nth(0).getByRole('button', { name: 'Roll back to before this message' });
      await button.waitFor({ timeout: 10000 });
      await button.click();
      const pop = page.locator('[data-composer-plus-rollback]');
      await pop.getByText('Also put 2 files back as they were before this message:').waitFor({ timeout: 20000 });
      assert.deepEqual((await pop.locator('li').allInnerTexts()).sort(), ['Delete notes.md', 'Restore app.js']);
      if (process.env.SHOT) {
        await pause(300);
        const shot = join(home, 'rollback.png');
        const box = await pop.boundingBox(); const row = await userRows.nth(0).boundingBox();
        const top = Math.max(0, Math.min(box.y, row.y) - 16); const left = Math.max(0, Math.min(box.x, row.x) - 16);
        await page.screenshot({ path: shot, clip: { x: left, y: top, width: Math.min(1280 - left, Math.max(box.x + box.width, row.x + row.width) - left + 16), height: Math.max(box.y + box.height, row.y + row.height) - top + 16 } });
        execFileSync('cwebp', ['-q', '82', shot, '-o', join(repo, 'assets/features/turnRollback.webp')], { stdio: 'ignore' });
      }
      await pop.getByRole('button', { name: /^Chat and files/ }).click();
      await pop.waitFor({ state: 'detached', timeout: 20000 });
      await page.waitForFunction((m) => (document.querySelector('[data-composer-input]')?.innerText ?? '').trim() === m, M1, { timeout: 10000 });
      assert.equal(await readFile(join(project, 'app.js'), 'utf8'), 'console.log("Hi");\n', 'app.js is back');
      await assert.rejects(stat(join(project, 'notes.md')), 'notes.md is gone');
      assert.equal(await fingerprint(join(project, '.git')), gitBefore, 'the project .git is unchanged');
      await page.getByText('Renamed the greeting.').first().waitFor({ state: 'hidden', timeout: 5000 });
      await page.getByText('Added the comment.').first().waitFor({ state: 'hidden', timeout: 5000 });
      assert.equal(await userRows.filter({ visible: true }).count(), 0, 'both messages are hidden');
      // The next model request has neither message.
      await composer.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await page.keyboard.type(M3); await page.keyboard.press('Enter');
      await page.getByText('It prints Hi.').first().waitFor({ timeout: 20000 });
      const sent = requests.at(-1);
      assert.ok(!sent.includes(M1) && !sent.includes(M2) && !sent.includes('Renamed the greeting'), 'the model no longer sees the withdrawn messages');
      // After a reload the withdrawn rows stay hidden (spans come from the log).
      await page.reload(); await composer.waitFor({ timeout: 20000 });
      await page.getByText('It prints Hi.').first().waitFor({ timeout: 20000 });
      await pause(800);
      assert.equal(await page.getByText('Renamed the greeting.').filter({ visible: true }).count(), 0, 'still hidden after a reload');
      // 2. Chat only: files stay.
      await writeFile(join(project, 'app.js'), 'console.log("edited by hand");\n');
      const row3 = userRows.filter({ hasText: M3 }).first();
      await row3.hover();
      await row3.getByRole('button', { name: 'Roll back to before this message' }).click();
      await pop.getByRole('button', { name: /^Chat only/ }).click();
      await pop.waitFor({ state: 'detached', timeout: 20000 });
      await page.getByText('It prints Hi.').first().waitFor({ state: 'hidden', timeout: 5000 });
      assert.equal(await readFile(join(project, 'app.js'), 'utf8'), 'console.log("edited by hand");\n', 'Chat only keeps the files');
      // 3. Delete chat from the sidebar menu.
      // The one chat of this test home: its log folder is <sessions>/<project key>/<chat id>.
      const sessionsRoot = join(home, 'sessions');
      const chatFolders = async () => { const out = []; for (const p of await readdir(sessionsRoot)) for (const s of await readdir(join(sessionsRoot, p)).catch(() => [])) out.push(join(sessionsRoot, p, s)); return out; };
      const folders = await chatFolders();
      assert.equal(folders.length, 1, 'one chat log folder');
      const sessionId = folders[0].split('/').at(-1);
      const chatFolder = async () => (await chatFolders()).find((f) => f.endsWith(`/${sessionId}`));
      const sidebarRow = page.locator('[data-row-key^="session:"]').first();
      await sidebarRow.click({ button: 'right' });
      const del = page.getByRole('menuitem', { name: 'Delete…' });
      await del.waitFor({ timeout: 10000 });
      if (process.env.SHOT) {
        await pause(300);
        const menu = await del.locator('xpath=ancestor::*[@role="menu"][1]').boundingBox();
        const r = await sidebarRow.boundingBox();
        const shot = join(home, 'delete.png');
        const top = Math.max(0, r.y - 12); const bottom = Math.max(menu.y + menu.height, r.y + r.height) + 12;
        await page.screenshot({ path: shot, clip: { x: 0, y: top, width: Math.min(1280, Math.max(menu.x + menu.width, r.x + r.width) + 12), height: bottom - top } });
        execFileSync('cwebp', ['-q', '82', shot, '-o', join(repo, 'assets/features/deleteChat.webp')], { stdio: 'ignore' });
      }
      await del.click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Delete this chat?' });
      await dialog.waitFor({ timeout: 10000 });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await dialog.waitFor({ state: 'detached', timeout: 30000 });
      await page.locator('[data-row-key^="session:"]').waitFor({ state: 'detached', timeout: 10000 });
      assert.equal(await chatFolder(), undefined, 'the log folder left the sessions folder');
      const ws = JSON.parse(await readFile(join(home, 'storages/workspace.json'), 'utf8'));
      assert.ok(ws.global.archivedSessionIds.includes(sessionId), 'the id stays archived');
      const inFolderTrash = await lstat(join(home, 'trash')).then(() => true, () => false);
      console.log(`  deleted chat went to: ${inFolderTrash ? '<home>/trash' : 'the macOS Trash'}`);
      assert.deepEqual(errors, [], 'no browser exceptions');
      // Restart: dsh starts clean without the chat.
      await stop(); url = await start(); await open();
      // dsh opens a new empty chat in the project at start; the deleted chat itself has no row and its folder stays away.
      await pause(1000);
      assert.equal(await page.locator(`[data-row-key="session:${sessionId}"]`).count(), 0, 'no row for the deleted chat after a restart');
      assert.equal(await chatFolder(), undefined, 'dsh did not write the deleted chat back');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: bash edit → ↶ Chat and files: rows hidden, composer refilled, files back, .git unchanged, model context clean, hidden after reload → Chat only keeps files → Delete… moves the log to a trash, id archived, clean restart`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await stop();
      await writeFile(join(home, 'server.log'), allLogs);
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
