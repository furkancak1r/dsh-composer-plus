// Real-app check of the Task board on each dsh given: a fake model, a throwaway DSH_HOME, made-up projects (acme-web,
// docs-site). Never the normal DSH_HOME, no real model. Headless.
// 1. Left sidebar → Task board: a chat started in dsh's own composer is on the board (no tags), not in docs-site. New task
//    (acme-web shown) opens dsh's own new chat in acme-web (the board goes); back on the board, the chat waits at the top of
//    Doing as "New task" (no Todo column); a click opens it, its first message goes from dsh's composer and the board comes back by itself. dsh names
//    it ("Chess game"), the tags come from the chat's own model ("chess", "game"); Doing while it runs, then Done (green).
// 2. Three tasks that wait for the user, never opened: an approval (a test gate asks before `--ask-me`), a question
//    (ask_user_question) and a plan review (/plan, exit_plan_mode). Each card is orange in Review; Answer on the board
//    answers it (Allow once, an option, Approve) and the chat goes on to Done.
// 3b. Done shows the unread (green) cards only: a card that you open leaves Done by itself and Recently finished (N)
//    shows it (closed by default, kept after a reload); a New task that finishes behind the board is green in Done (dsh
//    gives the open chat no dot) until you open it.
// 3. Done: × takes one card off the board (Undo shows for 8 s and puts it back), Clear all asks first (the count, All
//    projects, the unread card that stays, "the chats stay in dsh"; Cancel does nothing) and then takes the read Done
//    cards off it; Removed (N) lists them and Put back brings one back; no Hide finished. The chats stay in dsh's sidebar;
//    the cards stay off after a reload and after a dsh restart (step 9); a removed chat that runs again comes back. A
//    click on a card opens its chat.
// 4. Fit: at 1180 px the four columns fit the page and a long title wraps inside its card; at 900 px a title of normal
//    words breaks only between words (the time is on the meta row, not next to the title).
// 6. The projects: a dropdown at the top of the board (no side column; the board has the full width). The search box
//    (Enter picks the first match) and "Active in the last 2 hours" (an old project hides; the filter stays after a
//    reload); Esc and a press outside close it. Only the list scrolls (the search box stays in view); a project with a
//    waiting chat has dsh's orange dot.
// 7. A narrow board (760 px): the header stays on one line; the New task hint wraps in its card at the top of Doing.
// 8. Progress on hover: a running card (held) shows its box after a short hover: the time, the todo step, the running
//    tool; Settings → Task board → Progress on hover → AI summary adds the chat model's summary; back to Fast.
// 0. Cmd+Shift+K (Ctrl+Shift+K) opens the board from a chat, also from the composer; dsh's Keyboard shortcuts page lists it.
// 5. Settings → Composer Plus → Task board off: no sidebar row, no page, no key; on again.
// 9. A dsh restart (same DSH_HOME): the removed cards stay off the board; the chats are still in dsh.
// PLAYWRIGHT=/path/to/playwright node test/browser-task-board.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/taskBoard.webp (English UI, made-up projects).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat, readFile } from 'node:fs/promises';
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

// The prompts of the test, and what the fake model does with each.
const P = {
  chess: 'html css js ile satranç oyunu yap',
  approve: 'Run the slow demo check',
  question: 'Pick a color for the theme',
  plan: 'Plan the export feature',
  long: 'Refactor the very long module name supercalifragilisticexpialidocious_and_another_unbroken_identifier_that_is_far_too_long_for_a_card into smaller parts',
  old: 'Write the FAQ page',
  words: 'Find why the job stays pending',
  notes: 'Draft the release notes',
  work: 'Build the export page step by step',
  green: 'Sketch the onboarding flow',
  tail: 'Tidy the changelog',
};
// The Turkish title is like the owner's report ("Pending durumunda kalma sorunu"): words that a narrow card broke.
const TITLES = { [P.chess]: 'Chess game', [P.approve]: 'Slow demo check', [P.question]: 'Theme color', [P.plan]: 'Export feature plan', [P.old]: 'FAQ page', [P.words]: 'Pending durumunda kalma sorunu', [P.notes]: 'Release notes', [P.work]: 'Export page', [P.green]: 'Onboarding flow', [P.tail]: 'Changelog tidy' };
const tagCalls = [];
let release = null; // holds the chess chat's answer while the test looks at Doing
let greenGate = null; // holds the onboarding chat's answer until another chat is open (then it finishes unread: green)
let workFlag = ''; // the work chat's bash waits for this file (its turn runs) while the test looks at its progress
let summaryCalls = 0;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    const system = textOf(msgs.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    const all = JSON.stringify(msgs);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const tool = (name, args) => { send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
    if (/label a coding task for a kanban board/.test(system)) {
      const prompt = textOf(msgs.at(-1)?.content); tagCalls.push({ model: parsed.model, prompt });
      return say(prompt === P.chess ? '["Chess", "game"]' : prompt === P.long ? '["refactor"]' : '["demo"]');
    }
    if (/session title/i.test(system) || /session title/i.test(textOf(msgs.at(-1)?.content))) {
      const hit = Object.keys(TITLES).find((p) => all.includes(JSON.stringify(p).slice(1, -1)));
      return say(hit ? TITLES[hit] : 'Refactor module');
    }
    if (/progress note of a running coding task/.test(system)) { summaryCalls += 1; return say('Building the export page: step 2 of 3, the tests run now.'); }
    if (/You predict the next message|You complete the message/.test(all)) return say('');
    const results = msgs.filter((m) => m.role === 'tool').length;
    if (all.includes(P.chess)) { if (release) await release; return say('The chess game is in index.html.'); }
    if (all.includes(P.green) && greenGate) { await greenGate; return say('Done.'); }
    if (all.includes(P.work)) {
      if (results === 0) return tool('todo_write', { todos: [{ content: 'Write the page', status: 'completed' }, { content: 'Run the tests', status: 'in_progress' }, { content: 'Ship it', status: 'pending' }] });
      if (results === 1) { send({ role: 'assistant', content: 'The page is written. Now the tests run.' }); return tool('bash', { command: `until [ -f '${workFlag}' ]; do sleep 0.2; done`, description: 'Run the page tests' }); }
      return say('The export page is done.');
    }
    if (all.includes(P.approve)) return results === 0 ? tool('bash', { command: 'node -e "console.log(42)" --ask-me', description: 'Run the demo check' }) : say('The check passed.');
    if (all.includes(P.question)) return results === 0 ? tool('ask_user_question', { questions: [{ id: 'color', question: 'Which theme color?', header: 'Theme', options: [{ label: 'Blue' }, { label: 'Green' }] }] }) : say(`Using ${/Green/.test(textOf(msgs.at(-1)?.content)) ? 'green' : 'the color'}.`);
    if (all.includes(P.plan)) return results === 0 ? tool('exit_plan_mode', { plan: '# Export plan\n\n1. Add the CSV writer.\n2. Add the button.' }) : say('Plan approved; starting.');
    return say('Done.');
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

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    tagCalls.length = 0; summaryCalls = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-task-board-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'task-board-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    // A test-only gate: dsh asks the user before a bash call with `--ask-me` (as dsh's own approval: the same card).
    const gate = join(home, 'ask-gate.mjs');
    await writeFile(gate, "export const name = 'task-board-ask-gate';\nexport function apply(ctx) {\n  ctx.on('tools/pre-execute', async (exec, next) => {\n    const d = await next();\n    return exec.name === 'bash' && String(exec.arguments?.command ?? '').includes('--ask-me') ? { kind: 'ask', reason: 'Run the demo check?' } : d;\n  });\n}\n");
    await writeFile(join(profile, 'cordis.patch.yml'), `- insert:
    - id: task-board-ask-gate
      name: ${gate}
- id: ui-settings-general
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
    workFlag = join(home, 'work-go');
    await mkdir(join(home, 'storages', 'dsh-composer-plus'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: Object.values(ids), archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids['acme-web'] },
      tables: { workspaces: tables } }));
    // The old notebook board of an earlier version: it stays as it is.
    const oldBoard = '{"v":1,"next":2,"projects":[],"tasks":[{"id":1,"title":"Old task"}]}';
    await writeFile(join(home, 'storages/dsh-composer-plus/board.json'), oldBoard);
    // dsh in the throwaway DSH_HOME; step 9 starts it again with the same home (a restart).
    let child; let log = '';
    const startDsh = async () => {
      log = '';
      child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3207', '--no-open'], { cwd: acme, env: { ...process.env, HOME: home, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      return log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0];
    };
    const stopDsh = async () => { child.kill('SIGTERM'); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r))); };
    const errors = []; let context; let page;
    try {
      const url = await startDsh(); assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false,"defaultWorkspace":false,"idleSwitch":false,"notifications":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const failedUrls = []; page.on('response', (r) => { if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url().replace(/token=[^&]+/, 'token=…')}`); });
      page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`); });
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
      const column = (status) => boardPage.locator(`[data-cpb-column="${status}"]`);
      const card = (title) => boardPage.locator('[data-cpb-card]', { has: page.locator('[data-cpb-title]', { hasText: title }) });
      const titles = async (status) => column(status).locator('[data-cpb-title]').allInnerTexts();
      // Done shows the unread cards; a read card leaves them for Recently finished (a row that opens them in place).
      const recentRow = () => column('done').locator('[data-cpb-recent-done]');
      const openRecent = async () => { if ((await recentRow().count()) > 0 && (await recentRow().getAttribute('aria-expanded')) !== 'true') await recentRow().click(); };
      // The projects are a dropdown at the top of the board: open it, then a row picks a project and closes it.
      const projectsMenu = boardPage.locator('[data-cpb-projects-menu]');
      const openProjects = async () => { if (!(await projectsMenu.isVisible())) await boardPage.locator('[data-cpb-project-button]').click(); await projectsMenu.waitFor({ timeout: 5000 }); };
      const pickProject = async (name) => {
        await openProjects(); await projectsMenu.locator('.cpb-nav', { hasText: name }).click();
        await projectsMenu.waitFor({ state: 'detached', timeout: 5000 }); await boardPage.locator('h1', { hasText: name }).waitFor();
      };
      /** A board task the user's way: New task on the board (acme-web shown), the first message in dsh's composer; the board comes back. */
      const task = async (text) => {
        await boardPage.locator('[data-cpb-new]').click();
        await boardPage.waitFor({ state: 'detached', timeout: 10000 });
        await input.waitFor({ timeout: 10000 }); await pause(300);
        await input.click(); await page.keyboard.insertText(text); await pause(200); await page.keyboard.press('Enter');
        await boardPage.waitFor({ timeout: 15000 }); await boardPage.locator('[data-cpb-columns]').waitFor({ timeout: 10000 });
      };

      // An existing chat, started in dsh's own composer (not on the board), in acme-web (dsh's default project).
      await input.click(); await page.keyboard.type(P.old, { delay: 5 }); await page.keyboard.press('Enter');
      await page.getByText('Done.', { exact: true }).first().waitFor({ timeout: 30000 });

      // 0. Cmd+Shift+K (Ctrl+Shift+K) opens the board from the chat, also while the composer has the focus; dsh's Keyboard
      //    shortcuts page lists it.
      await input.click(); assert.equal(await boardPage.count(), 0, 'the chat is open');
      await page.keyboard.press('ControlOrMeta+Shift+KeyK');
      await boardPage.waitFor({ timeout: 5000 });
      await page.keyboard.press('ControlOrMeta+Slash');
      const keys = page.getByRole('dialog'); await keys.waitFor({ timeout: 10000 });
      const keyRow = await keys.getByText('Task board', { exact: true }).first().locator('xpath=ancestor::li[1]').innerText();
      assert.match(keyRow.replace(/\s+/g, ' '), /Task board (⇧ ⌘|Ctrl \+ Shift|Shift \+ Ctrl|Ctrl\+Shift) ?\+? ?K/i, `listed with its key: ${keyRow}`);
      await page.keyboard.press('Escape'); await keys.waitFor({ state: 'hidden' });
      // Back to the chat (its sidebar row), then the key again: the board.
      await page.locator('[data-row-key^="session:"]').first().click(); await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await input.click(); await page.keyboard.press('ControlOrMeta+Shift+KeyK'); await boardPage.waitFor({ timeout: 5000 });
      console.log('  0: Cmd+Shift+K opens the board from the chat (the composer has the focus); dsh\'s Keyboard shortcuts page lists it');

      // 1. A prompt starts a chat; it is in Doing while it runs, then in Done with the green dot.
      await openBoard();
      // FAQ page finished while you looked at it: read, so it is not in Done but in Recently finished (closed by default).
      await recentRow().waitFor({ timeout: 20000 });
      assert.equal(await recentRow().getAttribute('aria-expanded'), 'false', 'Recently finished is closed by default');
      assert.equal(await recentRow().innerText(), 'Recently finished (1)');
      assert.deepEqual(await titles('done'), [], 'a read card is not in Done');
      await recentRow().click(); await until(async () => (await titles('done')).includes('FAQ page'), async () => `done: ${await titles('done')}`, 5000);
      assert.equal(await column('todo').count(), 0, 'no Todo column');
      assert.equal(await boardPage.locator('[data-cpb-hide-done]').count(), 0, 'no Hide finished');
      assert.equal(await card('FAQ page').locator('[data-cpb-tag]').count(), 0, 'a chat that the board did not start has no tags');
      await pickProject('docs-site');
      assert.equal(await card('FAQ page').count(), 0, 'a chat of another project is not in docs-site');
      console.log('  1a: a chat started in dsh\'s composer is on the board (All projects), not in another project');
      await pickProject('acme-web');
      let open; release = new Promise((r) => { open = r; });
      // New task: dsh's own new chat in acme-web; the board goes. Its composer is dsh's (the + attach button is there).
      await boardPage.locator('[data-cpb-new]').click();
      await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await input.waitFor({ timeout: 10000 });
      const chip = async () => page.evaluate(() => document.querySelector('[class*="_heroWorkspaceRow"] button[class*="_workspace"]')?.textContent?.trim() ?? '');
      await until(async () => /acme-web/.test(await chip()), async () => `new chat project: ${await chip()}`, 10000);
      // Back to the board before a message: the new chat waits at the top of Doing as "New task"; a click opens it again.
      await openBoard();
      await until(async () => (await titles('doing'))[0] === 'New task', async () => `doing: ${await titles('doing')}`, 10000);
      assert.equal(await column('todo').count(), 0, 'still no Todo column');
      const draftCard = column('doing').locator('[data-cpb-card][data-cpb-state="draft"]');
      assert.match(await draftCard.locator('[data-cpb-when]').innerText(), /Write the first message/);
      assert.equal(await draftCard.locator('[data-cpb-dot]').count(), 0, 'no blue dot: it does not run');
      await draftCard.click();
      await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await until(async () => /acme-web/.test(await chip()), 'the same new chat in acme-web', 10000);
      // The first message, from dsh's own composer: the board comes back by itself.
      await input.click(); await page.keyboard.type(P.chess, { delay: 5 }); await page.keyboard.press('Enter');
      await boardPage.waitFor({ timeout: 15000 });
      console.log('  1c: New task opens dsh\'s new chat in acme-web; Doing shows it first as "New task" until its first message; that message brings the board back');
      await until(async () => (await titles('doing')).includes('Chess game'), async () => `doing: ${await titles('doing')}`, 20000);
      assert.equal(await column('doing').locator('[data-cpb-state="draft"]').count(), 0, 'no New task card any more');
      await until(async () => (await card('Chess game').locator('[data-cpb-tag]').allInnerTexts()).join() === 'chess,game', 'the tags', 15000);
      assert.deepEqual(tagCalls.find((c) => c.prompt === P.chess)?.model, 'demo', 'the tags come from the chat\'s own model');
      assert.equal(await card('Chess game').locator('.cpb-preview').innerText(), P.chess, 'the prompt shows under the AI title');
      open(); release = null;
      await until(async () => (await titles('done')).includes('Chess game'), async () => `done: ${await titles('done')}`, 20000);
      // It is still dsh's open chat behind the board, so dsh gives it no green dot (its `isMain` rule); you did not see the
      // answer yet, so the board keeps it green in Done (its own unread set) until you open it.
      assert.equal(await card('Chess game').getAttribute('data-cpb-state'), 'unread', 'finished behind the board: green');
      const doneCount = () => column('done').locator('.cpb-colhead .cpb-count').innerText().catch(() => '0');
      assert.equal(await doneCount(), '1', 'the Done count is the unread cards');
      console.log('  1b: chat "Chess game" (dsh title), tags chess+game from its first message (the chat\'s model), Doing → Done');

      // 2. Three waiting chats, never opened: each is orange in Review and is answered on the board.
      for (const p of [P.approve, P.question, P.plan]) await task(p === P.plan ? `/plan ${p}` : p);
      await until(async () => (await titles('review')).length === 3, async () => `review: ${await titles('review')} doing: ${await titles('doing')} done: ${await titles('done')}`, 40000);
      for (const name of ['Slow demo check', 'Theme color', 'Export feature plan']) assert.equal(await card(name).getAttribute('data-cpb-state'), 'waiting', `${name} is orange`);
      // The closed project list has dsh's orange dot (a chat waits); the open list shows it on acme-web, none on docs-site.
      await boardPage.locator('[data-cpb-project-button] [data-cpb-waiting]').waitFor({ timeout: 5000 });
      await openProjects();
      const projectRow = (name) => boardPage.locator('[data-cpb-projects] .cpb-nav', { hasText: name });
      await projectRow('acme-web').locator('[data-cpb-waiting]').waitFor({ timeout: 5000 });
      assert.equal(await projectRow('docs-site').locator('[data-cpb-waiting]').count(), 0, 'no waiting chat: no dot');
      assert.match(await projectRow('acme-web').locator('.cpb-sr').textContent(), /3 waiting for you/, 'a screen reader reads the counts');
      await page.keyboard.press('Escape'); await projectsMenu.waitFor({ state: 'detached', timeout: 3000 });
      assert.match(await card('Slow demo check').locator('.cpb-wait').innerText(), /Waiting for approval/);
      assert.match(await card('Theme color').locator('.cpb-wait').innerText(), /Waiting for answer/);
      assert.match(await card('Export feature plan').locator('.cpb-wait').innerText(), /Plan awaiting review/);
      const panel = page.locator('[data-cpb-panel="answer"]');
      // A click on an orange card (not on Answer) opens the answer panel, not the chat.
      await card('Slow demo check').locator('[data-cpb-title]').click();
      await panel.locator('[data-cpb-allow]').waitFor({ timeout: 5000 });
      assert.equal(await boardPage.count(), 1, 'a click on an orange card keeps the board (no chat opens)');
      await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached', timeout: 3000 });
      await card('Slow demo check').locator('[data-cpb-answer]').click();
      await panel.locator('[data-cpb-allow]').waitFor();
      assert.equal(await panel.locator('[data-cpb-allow]').innerText(), 'Allow once', 'dsh\'s own label');
      await panel.locator('[data-cpb-allow]').click();
      await until(async () => (await titles('done')).includes('Slow demo check'), async () => `done: ${await titles('done')}`, 20000);
      // Not dsh's open chat (later tasks opened after it): green until opened.
      assert.equal(await card('Slow demo check').getAttribute('data-cpb-state'), 'unread', 'green until opened');
      await card('Slow demo check').locator('[data-cpb-dot="done"]').waitFor();
      await card('Theme color').locator('[data-cpb-answer]').click();
      await panel.getByRole('radio', { name: 'Green' }).click();
      await panel.locator('[data-cpb-send]').click();
      await until(async () => (await titles('done')).includes('Theme color'), async () => `done: ${await titles('done')}`, 20000);
      await card('Export feature plan').locator('[data-cpb-answer]').click();
      await panel.locator('.cpb-plan', { hasText: 'Add the CSV writer' }).waitFor();
      await panel.locator('[data-cpb-approve]').click();
      await until(async () => (await titles('done')).includes('Export feature plan'), async () => `done: ${await titles('done')}`, 20000);
      assert.equal(await panel.count(), 0, 'the panel closes after an answer');
      assert.deepEqual(await titles('review'), [], 'nothing waits');
      await until(async () => (await projectRow('acme-web').locator('[data-cpb-waiting]').count()) === 0, 'the orange dot goes when nothing waits', 5000);
      console.log('  2: approval (Allow once), question (Green) and plan review (Approve) of never-opened chats: orange in Review, answered on the board, then Done');

      // 4. Fit: four columns in the page at 1180 px; a long title wraps inside its card.
      await task(P.long); await task(P.words);
      await until(async () => (await titles('done')).some((x) => x.startsWith('Refactor')), 'the long card', 20000);
      await until(async () => (await titles('done')).includes(TITLES[P.words]), 'the Turkish title', 20000);
      await page.setViewportSize({ width: 1180, height: 820 }); await pause(400);
      const fit = await boardPage.evaluate((el) => {
        const cols = el.querySelector('[data-cpb-columns]');
        const long = [...el.querySelectorAll('[data-cpb-card]')].find((c) => c.querySelector('[data-cpb-title]').textContent.startsWith('Refactor'));
        const t = long.querySelector('[data-cpb-title]');
        return { colsOverflow: cols.scrollWidth - cols.clientWidth, cardOverflow: long.scrollWidth - long.clientWidth, titleRight: t.getBoundingClientRect().right, cardRight: long.getBoundingClientRect().right };
      });
      assert.ok(fit.colsOverflow <= 1, `the columns fit (${JSON.stringify(fit)})`);
      assert.ok(fit.cardOverflow <= 1 && fit.titleRight <= fit.cardRight + 0.5, `a long title stays in its card (${JSON.stringify(fit)})`);
      // A narrow window (the columns at their 140 px minimum): each word of a title stays whole on one line (the owner saw
      // "firması / na", "araştırm / ası").
      // Three columns: 480 px puts them at their minimum (no project column next to them). On dsh 0.2.2 the board gets the
      // whole 540 px window ((540 - 40 - 20) / 3 = 160 px columns), so the test uses 480 px: (480 - 40 - 20) / 3 = 140 px.
      await page.setViewportSize({ width: 480, height: 820 }); await pause(400);
      const colWidth = await column('done').evaluate((el) => Math.round(el.getBoundingClientRect().width));
      assert.ok(colWidth <= 150, `the columns are at their minimum width (${colWidth}px)`);
      const words = await boardPage.evaluate((el) => [...el.querySelectorAll('[data-cpb-card]')].flatMap((c) => {
        const t = c.querySelector('[data-cpb-title]'); const out = [];
        if (t.textContent.startsWith('Refactor')) return out; // an unbroken name longer than the card has to break
        const node = t.firstChild; const text = node?.textContent ?? '';
        for (const m of text.matchAll(/\S+/g)) {
          const r = document.createRange(); r.setStart(node, m.index); r.setEnd(node, m.index + m[0].length);
          if (r.getClientRects().length > 1) out.push(m[0]);
        }
        const when = c.querySelector('[data-cpb-when]');
        if (when === null || when.closest('.cpb-cardtop') !== null) out.push(`time next to "${text}"`);
        return out;
      }));
      assert.deepEqual(words, [], `at ${colWidth} px columns no word of a title breaks, and the time is not beside the title`);
      await page.setViewportSize({ width: 1440, height: 860 });
      console.log(`  4: at 1180 px the columns fit (overflow ${fit.colsOverflow}px) and a long title wraps in its card; in ${colWidth} px columns titles break only between words`);

      // 6. The projects: a dropdown at the top of the board (no side column; the board has the full width). Search, Enter
      //    (the first match), "Active in the last 2 hours" (docs-site has no chat: it hides; stays after a reload), Esc and
      //    a press outside close it.
      const pageBox = await boardPage.evaluate((el) => ({ page: el.getBoundingClientRect().width, main: el.querySelector('.cpb-main').getBoundingClientRect().width, side: el.querySelectorAll('nav').length }));
      assert.ok(pageBox.side === 0 && pageBox.main >= pageBox.page - 1, `closed: no project list; the board has the full width (${JSON.stringify(pageBox)})`);
      const projectButton = boardPage.locator('[data-cpb-project-button]');
      assert.equal(await projectButton.getAttribute('aria-expanded'), 'false');
      const nameCut = await projectButton.locator('span').first().evaluate((el) => ({ text: el.textContent, cut: el.scrollWidth - el.clientWidth }));
      assert.ok(nameCut.text === 'acme-web' && nameCut.cut <= 0, `a wide board shows the whole project name (${JSON.stringify(nameCut)})`);
      assert.equal(await projectButton.locator('xpath=ancestor::header').count(), 1, 'the project button is at the top of the board');
      await projectButton.click(); await projectsMenu.waitFor({ timeout: 3000 });
      assert.equal(await projectButton.getAttribute('aria-expanded'), 'true', 'a click opens the list');
      const navs = async () => (await projectsMenu.locator('.cpb-nav').allInnerTexts()).map((x) => x.split('\n')[0].trim());
      const search = boardPage.locator('[data-cpb-search]');
      assert.equal(await search.evaluate((el) => el === document.activeElement), true, 'the focus is in Search projects');
      assert.equal(await search.getAttribute('placeholder'), 'Search projects', 'the label of Project search in a new chat');
      // The list opens over the columns, in the window; a short window: the search box keeps the height of a project row
      // and only the project list scrolls (the search box stays).
      const over = await boardPage.evaluate((el) => {
        const m = el.querySelector('[data-cpb-projects-menu]').getBoundingClientRect(); const col = el.querySelector('[data-cpb-column="doing"]').getBoundingClientRect();
        const top = document.elementFromPoint(m.left + 20, Math.min(m.bottom, col.top + 30) - 4);
        return { inWindow: m.left >= 0 && m.right <= innerWidth && m.bottom <= innerHeight, overCols: m.bottom > col.top && el.querySelector('[data-cpb-projects-menu]').contains(top) };
      });
      assert.ok(over.inWindow && over.overCols, `the list opens over the columns, in the window (${JSON.stringify(over)})`);
      const scroll = await boardPage.evaluate((el) => {
        const menu = el.querySelector('[data-cpb-projects-menu]'); const box = el.querySelector('[data-cpb-projects]'); const input = el.querySelector('[data-cpb-search]');
        menu.style.maxHeight = '260px';
        for (let i = 0; i < 12; i++) { const b = box.firstElementChild.cloneNode(true); b.setAttribute('data-cpb-clone', ''); box.append(b); }
        const before = input.getBoundingClientRect().top; box.scrollTop = 200; menu.scrollTop = 200;
        const out = { boxScrolls: box.scrollHeight > box.clientHeight, boxMoved: box.scrollTop > 0, menuScrolls: menu.scrollHeight > menu.clientHeight + 1, searchMoved: input.getBoundingClientRect().top - before,
          search: input.getBoundingClientRect().height, nav: box.firstElementChild.getBoundingClientRect().height, menuH: menu.getBoundingClientRect().height };
        for (const b of box.querySelectorAll('[data-cpb-clone]')) b.remove(); menu.style.maxHeight = ''; box.scrollTop = 0;
        return out;
      });
      assert.ok(scroll.boxScrolls && scroll.boxMoved && !scroll.menuScrolls && Math.abs(scroll.searchMoved) < 1 && scroll.menuH <= 261, `only the project list scrolls (${JSON.stringify(scroll)})`);
      assert.ok(scroll.search >= scroll.nav, `the search box is as tall as a project row in a long list (${JSON.stringify(scroll)})`);
      assert.equal(await boardPage.locator('[data-cpb-projects] .cpb-nav', { hasText: 'acme-web' }).getAttribute('title'), `acme-web\n${acme}`, 'the tooltip: the full name, then the path');
      // Only the states have colors: a project folder has the row's text color, and a card's project chip has no dot.
      const colors = await boardPage.evaluate((el) => ({
        folders: [...el.querySelectorAll('[data-cpb-projects] .cpb-nav')].map((n) => getComputedStyle(n.querySelector('path')).stroke === getComputedStyle(n).color),
        chips: [...el.querySelectorAll('.cpb-card .cpb-chip')].map((c) => c.children.length),
      }));
      assert.ok(colors.folders.length === 2 && colors.folders.every(Boolean), `a project folder has no color of its own (${JSON.stringify(colors)})`);
      assert.ok(colors.chips.every((n) => n === 0), `a card's project has no colored dot (${JSON.stringify(colors)})`);
      await search.fill('DOCS'); await until(async () => (await navs()).join() === 'All projects,docs-site', async () => `search: ${await navs()}`, 5000);
      await search.press('Escape'); assert.equal(await search.inputValue(), '', 'Esc empties the box');
      assert.equal(await boardPage.count(), 1, 'and the page stays'); assert.equal(await projectsMenu.count(), 1, 'and the list stays');
      await until(async () => (await navs()).join() === 'All projects,acme-web,docs-site', async () => `after Esc: ${await navs()}`, 5000);
      // Enter: the first match; the list closes and the board shows that project. An empty box: nothing.
      await search.press('Enter'); assert.equal(await projectsMenu.count(), 1, 'Enter in an empty box picks nothing');
      await search.fill('DOCS'); await search.press('Enter');
      await projectsMenu.waitFor({ state: 'detached', timeout: 3000 }); await boardPage.locator('h1', { hasText: 'docs-site' }).waitFor({ timeout: 3000 });
      assert.equal(await projectButton.evaluate((el) => el === document.activeElement), true, 'the focus goes back to the project button');
      // A second Esc closes the list; the board stays (no panel closes). A press outside it closes it too.
      await openProjects(); assert.equal(await search.inputValue(), '', 'a closed list forgets its search');
      await search.press('Escape'); await projectsMenu.waitFor({ state: 'detached', timeout: 3000 });
      assert.equal(await boardPage.count(), 1, 'Esc closes only the list');
      await openProjects(); await column('done').click({ position: { x: 20, y: 20 } }); await projectsMenu.waitFor({ state: 'detached', timeout: 3000 });
      await pickProject('acme-web'); await openProjects();
      const recentButton = boardPage.locator('[data-cpb-recent]');
      assert.equal(await recentButton.innerText(), 'Active in the last 2 hours', 'the label of Recent projects filter');
      assert.equal(await recentButton.locator('[data-cpb-check]').count(), 0, 'off: no check mark');
      assert.notEqual(await recentButton.evaluate((b) => getComputedStyle(b).borderTopStyle), 'none', 'the filter has a border (a button)');
      await recentButton.click(); await until(async () => (await navs()).join() === 'All projects,acme-web', async () => `recent: ${await navs()}`, 5000);
      assert.equal(await recentButton.locator('[data-cpb-check]').count(), 1, 'on: a check mark');
      await search.fill('docs'); await boardPage.locator('[data-cpb-noproject]', { hasText: 'No matching project' }).waitFor();
      await search.fill('');
      await page.reload(); await input.waitFor({ timeout: 20000 }); await openBoard();
      assert.equal(await projectsMenu.count(), 0, 'after a reload the list is closed');
      await boardPage.locator('h1', { hasText: 'acme-web' }).waitFor({ timeout: 5000 }); await openProjects();
      assert.equal(await boardPage.locator('[data-cpb-recent]').getAttribute('aria-pressed'), 'true', 'the filter stays after a reload');
      assert.deepEqual(await navs(), ['All projects', 'acme-web']);
      await boardPage.locator('[data-cpb-recent]').click(); await until(async () => (await navs()).length === 3, 'filter off', 5000);
      await page.keyboard.press('Escape'); await projectsMenu.waitFor({ state: 'detached', timeout: 3000 });
      console.log('  6: projects dropdown at the top (board full width; opens over the columns; only the list scrolls): search (DOCS, Esc empties, Enter picks docs-site), Esc and a press outside close it, Active in the last 2 hours (docs-site hides, kept after a reload)');

      // 7. A narrow board: the header is one line; a New task's hint wraps in its card (the top of Doing).
      await boardPage.locator('[data-cpb-new]').click(); await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await input.waitFor({ timeout: 10000 }); await openBoard();
      await until(async () => (await titles('doing'))[0] === 'New task', async () => `doing: ${await titles('doing')}`, 10000);
      for (const width of [900, 760]) {
        await page.setViewportSize({ width, height: 820 }); await pause(400);
        const head = await boardPage.evaluate((el) => {
          const items = [...el.querySelector('.cpb-head').children].filter((x) => getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().width > 0);
          const tops = items.map((x) => Math.round(x.getBoundingClientRect().top + x.getBoundingClientRect().height / 2));
          const hint = el.querySelector('[data-cpb-column="doing"] [data-cpb-state="draft"] [data-cpb-when]'); const card = hint.closest('[data-cpb-card]');
          const clear = el.querySelector('[data-cpb-clear-all]'); const head = clear?.closest('.cpb-colhead');
          return { spread: Math.max(...tops) - Math.min(...tops), headH: el.querySelector('.cpb-head').getBoundingClientRect().height,
            hintCut: hint.scrollWidth - hint.clientWidth, hintRight: hint.getBoundingClientRect().right - card.getBoundingClientRect().right,
            clearOut: clear ? clear.getBoundingClientRect().right - head.getBoundingClientRect().right : 0, clearCut: clear ? clear.scrollWidth - clear.clientWidth : 0 };
        });
        assert.ok(head.spread <= 4 && head.headH <= 66, `at ${width} px the header is one line (${JSON.stringify(head)})`);
        assert.ok(head.hintCut <= 1 && head.hintRight <= 0.5, `at ${width} px the New task hint is not cut (${JSON.stringify(head)})`);
        assert.ok(head.clearOut <= 0.5 && head.clearCut <= 1, `at ${width} px Clear all stays whole in the Done head (${JSON.stringify(head)})`);
        const heads = await boardPage.evaluate((el) => [...el.querySelectorAll('.cpb-colhead')].map((x) => Math.round(x.getBoundingClientRect().height)));
        assert.ok(Math.max(...heads) - Math.min(...heads) <= 1, `the Done head with Clear all is as tall as the others (${heads})`);
      }
      await page.setViewportSize({ width: 1440, height: 860 }); await pause(300);
      // Its first message: the board comes back and the New task card goes.
      await column('doing').locator('[data-cpb-state="draft"]').click(); await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await input.click(); await page.keyboard.insertText(P.notes); await pause(200); await page.keyboard.press('Enter');
      await boardPage.locator('[data-cpb-columns]').waitFor({ timeout: 15000 });
      await until(async () => (await column('doing').locator('[data-cpb-state="draft"]').count()) === 0, 'the New task card goes after the first message', 10000);
      await until(async () => (await titles('done')).includes('Release notes'), async () => `done: ${await titles('done')}`, 20000);
      console.log('  7: the New task card is the top of Doing; at 900 and 760 px the header is one line, the hint is not cut and Clear all fits');

      // 3. Done: × on one card, then Clear all. No chat is deleted; the cards stay off after a reload; a removed chat that
      //    runs again comes back.
      const sidebarChat = (title) => page.locator('[data-row-key^="session:"]', { hasText: title });
      /** A chat's row in dsh's sidebar (it can be under "Show N more sessions"). */
      const sidebarRow = async (title) => {
        const row = sidebarChat(title).first();
        for (let i = 0; i < 5 && !(await row.isVisible().catch(() => false)); i++) {
          const more = page.getByRole('button', { name: /^Show \d+ more/ }).first();
          if (!(await more.isVisible().catch(() => false))) break;
          await more.click(); await pause(300);
        }
        await row.waitFor({ timeout: 10000 });
        return row;
      };
      const doneBefore = await titles('done');
      assert.ok(doneBefore.includes('FAQ page') && doneBefore.length >= 5, `finished cards (${doneBefore})`);
      assert.equal(await column('doing').locator('[data-cpb-hide]').count() + await column('review').locator('[data-cpb-hide]').count(), 0, 'only Done cards have the ×');
      assert.equal(await card('FAQ page').locator('[data-cpb-hide]').getAttribute('aria-label'), 'Remove from the board: FAQ page');
      // × and Undo: the card goes, Undo puts it back.
      const undoButton = boardPage.locator('[data-cpb-undo]');
      await card('FAQ page').locator('[data-cpb-hide]').click();
      await until(async () => !(await titles('done')).includes('FAQ page'), 'the × takes the card off', 5000);
      assert.equal(await boardPage.count(), 1, 'the × does not open the chat');
      assert.match(await boardPage.locator('[data-cpb-undo-bar]').innerText(), /1 removed from the board\. The chats stay in dsh\./);
      await undoButton.click();
      await until(async () => (await titles('done')).includes('FAQ page'), 'Undo puts the card back', 5000);
      await until(async () => (await undoButton.count()) === 0, 'Undo goes after it', 3000);
      assert.equal(Object.keys(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/board-chats.json'), 'utf8')).hidden).length, 0, 'the Host list is empty again');
      await card('FAQ page').locator('[data-cpb-hide]').click();
      await until(async () => !(await titles('done')).includes('FAQ page'), 'the × takes the card off', 5000);
      assert.deepEqual((await titles('done')).sort(), doneBefore.filter((x) => x !== 'FAQ page').sort(), 'only that card');
      // Undo goes by itself after 8 s.
      await undoButton.waitFor({ state: 'detached', timeout: 12000 });
      let record = JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/board-chats.json'), 'utf8'));
      assert.equal(Object.keys(record.hidden).length, 1, 'the Host keeps it in board-chats.json');
      await page.reload(); await input.waitFor({ timeout: 20000 }); await openBoard();
      assert.equal((await titles('done')).includes('FAQ page'), false, 'still off after a reload');
      assert.equal(await recentRow().getAttribute('aria-expanded'), 'true', 'Recently finished stays open after a reload (this device)');
      // Clear all asks first; Cancel changes nothing.
      const clear = column('done').locator('[data-cpb-clear-all]');
      assert.equal(await clear.innerText(), 'Clear all'); assert.equal(await clear.getAttribute('title'), 'Take the cards of Recently finished off the board. It asks first; unread cards stay. The chats stay in dsh.');
      const doneAtClear = await titles('done');
      // dsh keeps its green dots only in its window: after the reloads, count the unread cards now.
      const unreadNow = await column('done').locator('[data-cpb-card][data-cpb-state="unread"]').count();
      const readNow = doneAtClear.length - unreadNow;
      const dialog = page.getByRole('dialog', { name: 'Clear all?' });
      await clear.click(); await dialog.waitFor({ timeout: 5000 });
      // The board shows acme-web (the project picked in step 1, kept after a reload): the dialog names it.
      assert.equal(await boardPage.locator('h1').innerText(), 'acme-web');
      assert.match(await dialog.innerText(), new RegExp(`${readNow} finished card\\(s\\) of acme-web leave the board`), 'the count and the project');
      assert.match(await dialog.innerText(), /No chat is deleted: the chats stay in dsh\. Undo or Removed brings the cards back\./);
      if (unreadNow > 0) assert.match(await dialog.innerText(), new RegExp(`${unreadNow} unread card\\(s\\) stay on the board`));
      await dialog.locator('[data-cpb-clear-cancel]').click(); await dialog.waitFor({ state: 'detached', timeout: 5000 });
      assert.deepEqual((await titles('done')).sort(), doneAtClear.sort(), 'Cancel: nothing goes');
      // A green card: the onboarding chat finishes after another chat (the changelog one) became dsh's open chat.
      let openGreen; greenGate = new Promise((r) => { openGreen = r; });
      await task(P.green); await task(P.tail);
      await until(async () => (await titles('done')).includes('Changelog tidy'), async () => `done: ${await titles('done')}`, 20000);
      openGreen(); greenGate = null;
      // Onboarding flow finishes while another chat is open: dsh's green dot. Changelog tidy finishes behind the board while
      // it is dsh's open chat: the board's own green. Both stay in Done until you open them.
      await until(async () => (await card('Onboarding flow').getAttribute('data-cpb-state').catch(() => '')) === 'unread', 'a green card in Done', 20000);
      await until(async () => (await card('Changelog tidy').getAttribute('data-cpb-state').catch(() => '')) === 'unread', 'finished behind the board: green', 10000);
      const greens = await column('done').locator('[data-cpb-card][data-cpb-state="unread"] [data-cpb-title]').allInnerTexts();
      await clear.click(); await dialog.waitFor({ timeout: 5000 });
      assert.match(await dialog.innerText(), new RegExp(`${greens.length} unread card\\(s\\) stay on the board`), 'the unread card that stays');
      if (process.env.SHOT) { await pause(800); await page.screenshot({ path: join(repo, 'build', 'board-clear-dialog.png') }); console.log('  shot: build/board-clear-dialog.png'); }
      await dialog.locator('[data-cpb-clear-confirm]').click(); await dialog.waitFor({ state: 'detached', timeout: 5000 });
      await until(async () => (await titles('done')).join() === greens.join(), async () => `done after Clear all: ${await titles('done')} (green: ${greens})`, 5000);
      assert.ok((await titles('review')).length === 0 && (await titles('doing')).length === 0, 'nothing else changed');
      record = JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/board-chats.json'), 'utf8'));
      const removedCount = Object.keys(record.hidden).length;
      assert.equal(removedCount, doneBefore.length + 2 - greens.length, 'every read Done chat is on the Host\'s list (and FAQ page from the ×)');
      // Removed (N): Put back brings one card back.
      const removedButton = column('done').locator('[data-cpb-removed]');
      assert.equal(await removedButton.innerText(), `Removed (${removedCount})`);
      await removedButton.click();
      const removedPanel = page.locator('[data-cpb-panel="removed"]'); await removedPanel.waitFor();
      assert.match(await removedPanel.innerText(), /These chats stay in dsh\. Put back shows a card in Done again\./);
      assert.equal(await removedPanel.locator('[data-cpb-removed-card]').count(), removedCount);
      await removedPanel.locator('[data-cpb-removed-card]', { hasText: 'Slow demo check' }).locator('[data-cpb-unhide]').click();
      await until(async () => (await titles('done')).includes('Slow demo check'), 'Put back shows the card in Done', 5000);
      await until(async () => (await removedPanel.locator('[data-cpb-removed-card]').count()) === removedCount - 1, 'and it leaves Removed', 5000);
      if (process.env.SHOT) { await page.screenshot({ path: join(repo, 'build', 'board-removed.png') }); console.log('  shot: build/board-removed.png'); }
      await page.keyboard.press('Escape'); await removedPanel.waitFor({ state: 'detached', timeout: 3000 });
      // Clear all again: the put back card goes; the green ones stay.
      await clear.click(); await dialog.waitFor({ timeout: 5000 }); await dialog.locator('[data-cpb-clear-confirm]').click(); await dialog.waitFor({ state: 'detached' });
      await until(async () => !(await titles('done')).includes('Slow demo check'), 'Clear all again', 5000);
      // The card moves at once; the Host's list follows when its write ends.
      const hostCount = () => page.evaluate(async () => (await (await fetch('/api/composer-plus.board-chats')).json()).hidden.length);
      await until(async () => (await hostCount()) === removedCount, async () => `Host list: ${await hostCount()} (expected ${removedCount})`, 5000);
      // Open the green cards: each one leaves Done by itself and is in Recently finished (read).
      for (const g of greens) { await card(g).click(); await boardPage.waitFor({ state: 'detached', timeout: 10000 }); await openBoard(); }
      await until(async () => (await column('done').locator('[data-cpb-card][data-cpb-state="unread"]').count()) === 0, 'no green card', 10000);
      await recentRow().click(); await until(async () => (await recentRow().getAttribute('aria-expanded')) === 'false', 'closed', 3000);
      assert.deepEqual(await titles('done'), [], 'a card that you opened left Done');
      assert.equal(await recentRow().innerText(), `Recently finished (${greens.length})`, 'Recently finished has them');
      assert.equal(await clear.count(), 0, 'closed: no Clear all (it never takes cards that you do not see)');
      // The chevron: right while closed, down while open (after its 120 ms turn).
      const chevron = async () => { await pause(300); return recentRow().locator('svg').evaluate((el) => getComputedStyle(el).transform); };
      assert.equal(await chevron(), 'matrix(0, -1, 1, 0, 0, 0)', 'closed: the chevron points right');
      if (process.env.SHOT) { await page.screenshot({ path: join(repo, 'build', 'board-recent-closed.png') }); console.log('  shot: build/board-recent-closed.png'); }
      await recentRow().click(); await until(async () => (await titles('done')).length === greens.length, 'open: the read cards', 3000);
      assert.equal(await chevron(), 'none', 'open: the chevron points down');
      for (const g of greens) assert.equal(await card(g).getAttribute('data-cpb-state'), 'read', `${g} is read`);
      await clear.click(); await dialog.waitFor({ timeout: 5000 }); await dialog.locator('[data-cpb-clear-confirm]').click(); await dialog.waitFor({ state: 'detached' });
      await until(async () => (await titles('done')).length === 0, async () => `done after the last Clear all: ${await titles('done')}`, 5000);
      assert.equal(await clear.count(), 0, 'an empty Done has no Clear all');
      await undoButton.waitFor({ state: 'detached', timeout: 12000 });
      // No chat is deleted: dsh's sidebar still lists them; one opens and runs again, and its card comes back.
      await pickProject('acme-web');
      await sidebarRow('Theme color');
      const faq = await sidebarRow('FAQ page');
      await faq.click(); await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await page.getByText('Done.', { exact: true }).first().waitFor({ timeout: 10000 });
      await input.click(); await page.keyboard.insertText('And add a contact link'); await pause(200); await page.keyboard.press('Enter');
      await page.getByText('Done.', { exact: true }).nth(1).waitFor({ timeout: 30000 });
      await openBoard();
      await until(async () => (await titles('done')).includes('FAQ page'), async () => `done: ${await titles('done')}`, 15000);
      assert.equal((await titles('done')).length, 1, 'only the chat that ran again comes back');
      assert.equal(await page.evaluate(async () => (await (await fetch('/api/composer-plus.board-chats')).json()).hidden.length), removedCount + greens.length - 1, 'it left the Host list');
      if (process.env.SHOT) {
        // The Settings picture: a running card (held), an orange card, finished cards; no panel.
        let openShot; release = new Promise((res) => { openShot = res; });
        await task(P.chess); await task(P.question);
        await until(async () => (await titles('doing')).length >= 1 && (await titles('review')).length >= 1, 'the picture board', 30000);
        await until(async () => (await column('doing').locator('[data-cpb-tag]').count()) >= 2 && (await column('review').locator('.cpb-preview').count()) >= 1, 'the tags of the picture', 15000);
        await pause(500);
        // The picture is taken in step 8 (with the progress box); this sets up its Review card.
        openShot(); release = null;
      }
      await card('FAQ page').first().click();
      await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      // The chat opens. Its sidebar row can be under "Show N more sessions" (more chats now), so check the chat text.
      await page.locator('[data-composer-input]').waitFor({ timeout: 10000 });
      await page.getByText('And add a contact link', { exact: true }).first().waitFor({ timeout: 10000 });
      console.log('  3b: Done shows the unread cards; an opened card leaves it for Recently finished (closed by default, kept after a reload); a chat that finishes behind the board is green until opened');
      console.log('  3: × takes one Done card off and Undo puts it back (8 s); Clear all asks (count, project, unread stays; Cancel does nothing), then takes the read cards; Removed → Put back; kept on the Host after a reload; chats stay in dsh; one that runs again comes back; a click opens a chat');

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

      // 8. Progress on hover: the work chat runs (its bash is held); its box shows the time, the todo step and the step
      //    that runs now (Fast, no model call); then AI summary from Settings, and back to Fast.
      await openBoard();
      await task(P.work);
      await until(async () => (await titles('doing')).includes('Export page'), async () => `doing: ${await titles('doing')}`, 20000);
      const workCard = card('Export page');
      const box = page.locator('[data-cpb-progress]');
      await page.mouse.move(2, 2);
      await workCard.hover(); await pause(150);
      assert.equal(await box.count(), 0, 'a short pass opens no box');
      await box.waitFor({ timeout: 5000 });
      await until(async () => /Run the page tests/.test(await box.innerText().catch(() => '')), async () => `box: ${await box.innerText().catch(() => '')}`, 10000);
      const boxText = await box.innerText();
      assert.match(boxText, /Running for (<1m|\d+m)/, 'the time'); assert.match(boxText, /Step 2 of 3: Run the tests/, 'the todo step');
      assert.match(boxText, /Now: bash · Run the page tests/, 'the step that runs now');
      assert.equal(await box.getAttribute('role'), 'tooltip'); assert.equal(await workCard.getAttribute('aria-describedby'), await box.getAttribute('id'), 'the card names its box');
      assert.equal(await box.getAttribute('data-cpb-progress-mode'), 'fast', 'Fast (no AI) by default'); assert.equal(summaryCalls, 0, 'no model call in Fast');
      const inView = await box.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
      assert.ok(inView, 'the box is in the window');
      await page.keyboard.press('Escape'); await box.waitFor({ state: 'detached', timeout: 3000 });
      await page.mouse.move(2, 2);
      // Keyboard focus opens it at once.
      await workCard.focus(); await box.waitFor({ timeout: 3000 }); await page.mouse.move(2, 2);
      await boardPage.locator('[data-cpb-new]').focus(); await box.waitFor({ state: 'detached', timeout: 3000 });
      // Settings: AI summary.
      await settings();
      const modeButton = page.locator('[data-composer-plus-board-progress] button');
      await modeButton.scrollIntoViewIfNeeded();
      assert.equal(await modeButton.innerText(), 'Fast (no AI)', 'the default in Settings');
      await modeButton.click(); await page.getByRole('menuitem', { name: 'AI summary', exact: true }).click();
      await until(async () => (await modeButton.innerText()) === 'AI summary', 'mode AI', 5000);
      assert.equal((await page.evaluate(async () => (await fetch('/api/composer-plus.board-progress')).json())).mode, 'ai', 'the Host keeps the mode');
      await back(); await openBoard();
      await card('Export page').hover();
      await box.waitFor({ timeout: 5000 });
      await until(async () => /Building the export page: step 2 of 3/.test(await box.innerText().catch(() => '')), async () => `ai box: ${await box.innerText().catch(() => '')}`, 15000);
      assert.equal(summaryCalls, 1, 'one summary call for this step');
      assert.match(await box.innerText(), /Now: bash · Run the page tests/, 'the fast lines stay under the summary');
      await page.mouse.move(2, 2); await box.waitFor({ state: 'detached', timeout: 3000 });
      if (process.env.SHOT) {
        // Keyboard focus keeps the box open while the picture helper moves the pointer away.
        await card('Export page').focus(); await box.waitFor();
        await until(async () => /Building the export page/.test(await box.innerText().catch(() => '')), 'the summary in the picture', 10000);
        await shot(page, home, 'taskBoard', boardPage);
        assert.equal(await box.count(), 1, 'the picture has the box');
        await boardPage.locator('[data-cpb-new]').focus(); await box.waitFor({ state: 'detached', timeout: 3000 });
      }
      await settings(); await modeButton.click(); await page.getByRole('menuitem', { name: 'Fast (no AI)', exact: true }).click();
      await until(async () => (await modeButton.innerText()) === 'Fast (no AI)', 'mode fast', 5000);
      await back();
      await writeFile(workFlag, 'go');
      await openBoard();
      await until(async () => (await titles('done')).includes('Export page'), async () => `done: ${await titles('done')}`, 20000);
      assert.equal(await card('Export page').getAttribute('title'), 'Export page', 'a finished card: its native title again');
      console.log('  8: progress on hover (400 ms; focus at once; Esc closes): time, todo step, the running step (Fast, no model call); AI summary from Settings (one call), back to Fast');
      await settings();
      await sw().scrollIntoViewIfNeeded();
      await sw().click(); await until(async () => (await sw().getAttribute('aria-checked')) === 'false', 'switch off');
      assert.equal((await page.evaluate(async () => (await fetch('/api/composer-plus.board')).json())).on, false, 'the Host keeps the switch');
      await back();
      assert.equal(await page.getByRole('button', { name: 'Task board', exact: true }).count(), 0, 'off: no sidebar row');
      assert.equal(await boardPage.count(), 0, 'off: no page');
      await page.keyboard.press('ControlOrMeta+Shift+KeyK'); await pause(600);
      assert.equal(await boardPage.count(), 0, 'off: Cmd+Shift+K opens nothing');
      await page.keyboard.press('ControlOrMeta+Slash');
      const keysOff = page.getByRole('dialog'); await keysOff.waitFor({ timeout: 10000 });
      assert.equal(await keysOff.getByText('Task board', { exact: true }).count(), 0, 'off: no Task board row on the Keyboard shortcuts page');
      await page.keyboard.press('Escape'); await keysOff.waitFor({ state: 'hidden' });
      await settings(); await sw().click(); await until(async () => (await sw().getAttribute('aria-checked')) === 'true', 'switch on'); await back();
      await page.getByRole('button', { name: 'Task board', exact: true }).waitFor();
      await page.keyboard.press('ControlOrMeta+Shift+KeyK'); await boardPage.waitFor({ timeout: 5000 });
      assert.equal(await readFile(join(home, 'storages/dsh-composer-plus/board.json'), 'utf8'), oldBoard, 'the old board file stays as it was');
      assert.deepEqual(errors, [], 'no page errors');
      const ours = failedUrls.filter((u) => /composer-plus\.board/.test(u));
      assert.deepEqual(ours, [], `no failed request of the board: ${failedUrls.join(', ')}`);
      console.log('  5: switch off removes the row and the page (the Host keeps it); on brings them back; board.json untouched');

      // 9. A dsh restart: the cards that were taken off stay off; the chats are still in dsh.
      await openBoard();
      const doneAtStop = await titles('done');
      const hiddenAtStop = await page.evaluate(async () => (await (await fetch('/api/composer-plus.board-chats')).json()).hidden);
      assert.ok(hiddenAtStop.length >= 5, `chats off the board before the restart (${hiddenAtStop.length})`);
      await stopDsh();
      const again = await startDsh(); assert.ok(again, 'dsh started again');
      await page.goto(again); await input.waitFor({ timeout: 20000 }); await openBoard();
      await until(async () => (await titles('done')).length > 0, 'the board after the restart', 15000);
      const afterRestart = await page.evaluate(async () => (await (await fetch('/api/composer-plus.board-chats')).json()).hidden);
      assert.deepEqual(afterRestart.sort(), hiddenAtStop.sort(), 'the Host read its list again');
      // (A chat that waited for an answer before the stop can be in Done now: dsh does not keep its open question.)
      const onBoard = await boardPage.locator('[data-cpb-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-cpb-card')));
      assert.deepEqual(onBoard.filter((id) => afterRestart.includes(id)), [], 'after a dsh restart, no removed card is on the board');
      const doneNow = await titles('done');
      assert.ok(doneAtStop.every((x) => doneNow.includes(x)), `the cards that were in Done stay (${doneAtStop} → ${doneNow})`);
      // A removed chat is still in dsh's sidebar.
      await sidebarRow('Slow demo check');
      console.log('  9: after a dsh restart the removed cards stay off the board');
      console.log(`PASS ${bin}`);
    } catch (error) {
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`FAIL ${bin}: ${error?.stack ?? error}\npage errors: ${JSON.stringify(errors).slice(0, 3000)}\n--- dsh log (end) ---\n${log.slice(-3000)}\nscreenshot: ${join(home, 'failed.png')}`);
      process.exitCode = 1;
    } finally {
      release = null;
      await context?.close().catch(() => {});
      if (child) await stopDsh();
      if (process.exitCode !== 1) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
