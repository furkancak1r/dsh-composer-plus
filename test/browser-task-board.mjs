// Real-app check of the Task board on each dsh given: a fake model, a throwaway DSH_HOME and two made-up projects
// (acme-web, docs-site). Never the normal DSH_HOME, no real model. Headless.
// 1. Left sidebar → Task board opens the page; three tasks are made on the page (New task → title → Enter), one with a
//    description and tags, one marked Human.
// 2. A chat in acme-web gets the board rule (it has open tasks) and the board tools; the fake model calls
//    board_next_task (takes the top todo that is not human), board_add_comment and board_update_task → review. The page
//    shows the card in Review within the poll time, with the agent's comment that links the chat.
// 3. Drag and drop: a todo card goes to Doing; the order is kept after a reload.
// 4. The panel: Status select, a comment (⌘/Ctrl+Enter), Esc closes; `/` search finds a task of another project.
// 5. Settings → Composer Plus → Task board: switch off → no sidebar row, no tools in the next request; on again.
// PLAYWRIGHT=/path/to/playwright node test/browser-task-board.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/taskBoard.webp (English UI, made-up projects).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'node:fs/promises';
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
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${typeof what === 'function' ? await what() : what}`); await pause(200); }
};

const ASK = 'Take the next task from the board and do it';
const requests = []; // {system, tools}
const results = new Map();
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    const system = textOf(msgs.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    const last = textOf(msgs.at(-1)?.content);
    for (const m of msgs) if (m.role === 'tool') results.set(m.tool_call_id, textOf(m.content));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const tool = (id, name, args) => { send({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
    if (/session title/i.test(last)) return say('Board task');
    if (/You predict the next message|You complete the message/.test(JSON.stringify(msgs))) return say('');
    requests.push({ system, tools: (parsed.tools ?? []).map((x) => x.function?.name) });
    if (!JSON.stringify(msgs).includes(ASK)) return say('Ready.');
    const calls = msgs.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    if (calls === 0) return tool(`call_next_${randomUUID().slice(0, 6)}`, 'board_next_task', {});
    const taken = /Moved to doing:\n(\S+#\d+)/.exec([...results.values()].join('\n'))?.[1] ?? 'acme-web#1';
    if (calls === 1) return tool(`call_comment_${randomUUID().slice(0, 6)}`, 'board_add_comment', { id: taken, body: 'Added the rate limit in `src/export.js`; `npm test` passes.' });
    if (calls === 2) return tool(`call_review_${randomUUID().slice(0, 6)}`, 'board_update_task', { id: taken, status: 'review' });
    return say(`Done: ${taken} is in review.`);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd, encoding: 'utf8', env: gitEnv });
const shot = async (page, home, name, loc) => {
  if (!process.env.SHOT) return;
  await page.mouse.move(5, 5); await pause(300);
  const b = await loc.boundingBox();
  const png = join(home, `${name}.png`);
  await page.screenshot({ path: png, clip: { x: b.x, y: b.y, width: b.width, height: b.height } });
  const out = join(repo, `assets/features/${name}.webp`);
  execFileSync('cwebp', ['-quiet', '-q', '74', '-resize', String(Math.min(960, Math.round(b.width))), '0', png, '-o', out]);
  console.log(`  shot: assets/features/${name}.webp ${(await stat(out)).size} bytes`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const bin of process.argv.slice(2)) {
    requests.length = 0; results.clear();
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-task-board-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'task-board-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const ids = {}; const tables = {}; const now = new Date().toISOString();
    for (const name of ['acme-web', 'docs-site']) {
      const project = join(home, 'projects', name);
      await mkdir(join(project, 'src'), { recursive: true });
      await writeFile(join(project, 'README.md'), `# ${name}\nA demo project.\n`);
      git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'Start');
      ids[name] = randomUUID(); tables[ids[name]] = { path: project, title: name, sessionIds: [], createdAt: now, updatedAt: now };
    }
    const acme = join(home, 'projects', 'acme-web');
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: Object.values(ids), archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids['acme-web'] },
      tables: { workspaces: tables } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3207', '--no-open'], { cwd: acme, env: { ...process.env, HOME: home, DSH_HOME: home, DEMO_KEY: 'demo', DSH_PERMISSION_MODE: 'danger-full-access', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false,"defaultWorkspace":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const failedUrls = []; page.on('response', (r) => { if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url().replace(/token=[^&]+/, 'token=…')}`); });
      page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`); });
      page.on('dialog', (d) => d.accept());
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const boardPage = page.locator('[data-composer-plus-board]');
      const openBoard = async () => { await page.getByRole('button', { name: 'Task board', exact: true }).click(); await boardPage.waitFor({ timeout: 10000 }); await boardPage.locator('[data-cpb-columns]').waitFor({ timeout: 10000 }); };

      // 1. The page and three tasks made on it.
      await openBoard();
      await boardPage.locator('.cpb-nav', { hasText: 'acme-web' }).click();
      await boardPage.locator('h1', { hasText: 'acme-web' }).waitFor();
      const panel = page.locator('[data-cpb-panel]');
      const create = async (title, extra) => {
        await page.keyboard.press('Escape'); await boardPage.locator('[data-cpb-new]').click();
        const field = panel.locator('[data-cpb-draft-title]'); await field.waitFor(); await field.fill(title);
        if (extra) await extra();
        await field.press('Enter');
        await until(async () => (await boardPage.locator('[data-cpb-card]', { hasText: title }).count()) === 1, `card "${title}"`);
        await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
      };
      await create('Rate limit the export endpoint', async () => { await panel.getByRole('textbox', { name: 'Tags' }).fill('backend'); await panel.getByRole('textbox', { name: 'Description' }).fill('Big exports slow the database. Limit each key to 5 exports per minute.'); });
      await create('Renew the TLS certificate', async () => { await panel.getByRole('switch', { name: 'Human' }).click(); });
      await create('Cache product images on the CDN', async () => { await panel.getByRole('textbox', { name: 'Tags' }).fill('perf'); });
      const column = (status) => boardPage.locator(`[data-cpb-column="${status}"]`);
      const titles = async (status) => column(status).locator('.cpb-cardtitle').allInnerTexts();
      assert.deepEqual(await titles('todo'), ['Rate limit the export endpoint', 'Renew the TLS certificate', 'Cache product images on the CDN'], 'new tasks go to the bottom of Todo');
      await boardPage.locator('[data-cpb-card]', { hasText: 'Renew' }).locator('[aria-label="Human task: agents skip it"]').waitFor();
      // A task of the other project, made with the Host route (for the search).
      const docs = join(home, 'projects', 'docs-site');
      assert.equal((await page.evaluate(async (p) => (await fetch('/api/composer-plus.board-tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'create', project: p, title: 'Fix the broken links on the FAQ page' }) })).status, docs)), 200);
      console.log('  1: sidebar → Task board, 3 tasks made on the page (tags, description, Human), new tasks at the bottom of Todo');

      // 2. The agent takes the top task that is not human and moves it to review.
      // Back to the chat: dsh's own chat row (its open selects the conversation panel again).
      await page.locator('[data-row-key^="session:"]').first().click();
      await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await input.waitFor({ timeout: 10000 }); await input.click();
      await page.keyboard.type(ASK, { delay: 5 }); await page.keyboard.press('Enter');
      await page.getByText('is in review', { exact: false }).first().waitFor({ timeout: 40000 });
      const chatRequest = requests.find((r) => r.tools.includes('board_next_task'));
      assert.ok(chatRequest, `the board tools are in the request (${JSON.stringify(requests.map((r) => r.tools.filter((x) => x.startsWith('board_'))))})`);
      assert.ok(requests.some((r) => r.system.includes('# Task board') && r.system.includes('Never move a task to done')), 'the board rule is in the system prompt (open tasks)');
      const nextResult = [...results.entries()].find(([id]) => id.startsWith('call_next_'))?.[1] ?? '';
      assert.match(nextResult, /^Moved to doing:\nacme-web#1 Rate limit the export endpoint \{backend\}/, nextResult);
      await openBoard();
      await until(async () => (await titles('review')).includes('Rate limit the export endpoint'), async () => `review: ${await titles('review')}`, 10000);
      assert.deepEqual(await titles('todo'), ['Renew the TLS certificate', 'Cache product images on the CDN'], 'the human task stays in Todo');
      await boardPage.locator('[data-cpb-card]', { hasText: 'Rate limit' }).click();
      await panel.locator('[data-cpb-comment="agent"]').waitFor();
      assert.match(await panel.locator('[data-cpb-comment="agent"]').innerText(), /src\/export\.js/);
      await panel.getByText('Open chat').waitFor();
      console.log('  2: tools + rule in the chat; board_next_task took acme-web#1 (not the human task), comment + review show on the page');

      // 4 (before the drag, the panel is open). Status select, a comment with ⌘/Ctrl+Enter, Esc closes.
      await panel.locator('[data-cpb-comment-box]').fill('Looks good, merging after lunch.');
      await panel.locator('[data-cpb-comment-box]').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await panel.locator('[data-cpb-comment="user"]').waitFor();
      await panel.locator('[data-cpb-status]').selectOption('doing');
      await until(async () => (await titles('doing')).includes('Rate limit the export endpoint'), 'status → doing');
      await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
      await page.keyboard.press('/');
      const search = page.locator('[data-cpb-search]'); await search.waitFor();
      await page.keyboard.type('broken links');
      await search.getByRole('option', { name: /Fix the broken links/ }).waitFor();
      await page.keyboard.press('Enter');
      await boardPage.locator('h1', { hasText: 'docs-site' }).waitFor();
      await panel.getByText('docs-site#4').waitFor();
      await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
      console.log('  4: Status → Doing, comment (⌘/Ctrl+Enter), Esc closes, / search opens docs-site#4 in its project');

      // 3. Drag a Todo card to Doing, before the card there; the order stays after a reload.
      await boardPage.locator('.cpb-nav', { hasText: 'acme-web' }).click();
      await boardPage.locator('h1', { hasText: 'acme-web' }).waitFor();
      await boardPage.locator('[data-cpb-card]', { hasText: 'Cache product' }).dragTo(boardPage.locator('[data-cpb-card]', { hasText: 'Rate limit' }), { targetPosition: { x: 20, y: 4 } });
      await until(async () => JSON.stringify(await titles('doing')) === JSON.stringify(['Cache product images on the CDN', 'Rate limit the export endpoint']), async () => `doing: ${await titles('doing')}`);
      await page.reload(); await input.waitFor({ timeout: 20000 }); await openBoard();
      await until(async () => JSON.stringify(await titles('doing')) === JSON.stringify(['Cache product images on the CDN', 'Rate limit the export endpoint']), async () => `after reload: ${await titles('doing')}`);
      console.log('  3: drag Todo → Doing above a card; the order stays after a reload');

      // 5. Switch off and on.
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
      const sw = () => page.locator('[data-composer-plus-settings]').getByRole('switch', { name: 'Task board', exact: true });
      await settings();
      await sw().scrollIntoViewIfNeeded();
      await page.locator('[data-composer-plus-board-backlog]').waitFor();
      await sw().click(); await until(async () => (await sw().getAttribute('aria-checked')) === 'false', 'switch off');
      assert.equal((await page.evaluate(async () => (await fetch('/api/composer-plus.board')).json())).on, false, 'the Host keeps the switch');
      await back();
      assert.equal(await page.getByRole('button', { name: 'Task board', exact: true }).count(), 0, 'off: no sidebar row');
      assert.equal(await boardPage.count(), 0, 'off: no page');
      await settings(); await sw().click(); await until(async () => (await sw().getAttribute('aria-checked')) === 'true', 'switch on'); await back();
      await page.getByRole('button', { name: 'Task board', exact: true }).waitFor();
      if (process.env.SHOT) {
        // The Settings picture: every column has cards (Todo, Doing, Review), no panel.
        const post = (body) => page.evaluate(async (b) => (await fetch('/api/composer-plus.board-tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(), body);
        await post({ op: 'move', id: 1, status: 'review' });
        await post({ op: 'create', project: acme, title: 'Log slow queries over 200 ms', description: 'Add the query and its plan to the log.', tags: 'backend' });
        await openBoard();
        await boardPage.locator('.cpb-nav', { hasText: 'acme-web' }).click();
        await until(async () => (await titles('review')).length === 1 && (await titles('todo')).length === 2, 'the picture board');
        await shot(page, home, 'taskBoard', boardPage);
      }
      assert.deepEqual(errors, [], 'no page errors');
      const ours = failedUrls.filter((u) => /composer-plus\.board/.test(u));
      assert.deepEqual(ours, [], `no failed request of the board: ${failedUrls.join(', ')}`);
      console.log('  5: switch off removes the row and the page (the Host keeps it); on brings them back');
      console.log(`PASS ${bin}`);
    } catch (error) {
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`FAIL ${bin}: ${error?.stack ?? error}\npage errors: ${JSON.stringify(errors).slice(0, 3000)}\n--- dsh log (end) ---\n${log.slice(-3000)}\nscreenshot: ${join(home, 'failed.png')}`);
      process.exitCode = 1;
    } finally {
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      if (process.exitCode !== 1) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
