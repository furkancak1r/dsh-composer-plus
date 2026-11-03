// Real-app check of the Task board on each dsh given: a fake model, a throwaway DSH_HOME, made-up projects (acme-web,
// docs-site). Never the normal DSH_HOME, no real model. Headless.
// 1. Left sidebar → Task board: a chat started in dsh's own composer is on the board (no tags), not in docs-site. New task
//    (acme-web shown) opens dsh's own new chat in acme-web (the board goes); back on the board, the chat waits in Todo as
//    "New task"; a click opens it, its first message goes from dsh's composer and the board comes back by itself. dsh names
//    it ("Chess game"), the tags come from the chat's own model ("chess", "game"); Doing while it runs, then Done (green).
// 2. Three tasks that wait for the user, never opened: an approval (a test gate asks before `--ask-me`), a question
//    (ask_user_question) and a plan review (/plan, exit_plan_mode). Each card is orange in Review; Answer on the board
//    answers it (Allow once, an option, Approve) and the chat goes on to Done.
// 3. A click on a card opens its chat. Hide finished hides Done and stays after a reload.
// 4. Fit: at 1180 px the four columns fit the page and a long title wraps inside its card; at 900 px a title of normal
//    words breaks only between words (the time is on the meta row, not next to the title).
// 6. The project list: the search box and "Active in the last 2 hours" (an old project hides; the filter stays after a reload).
// 5. Settings → Composer Plus → Task board off: no sidebar row, no page; on again.
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
};
// The Turkish title is like the owner's report ("Pending durumunda kalma sorunu"): words that a narrow card broke.
const TITLES = { [P.chess]: 'Chess game', [P.approve]: 'Slow demo check', [P.question]: 'Theme color', [P.plan]: 'Export feature plan', [P.old]: 'FAQ page', [P.words]: 'Pending durumunda kalma sorunu' };
const tagCalls = [];
let release = null; // holds the chess chat's answer while the test looks at Doing
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
    if (/You predict the next message|You complete the message/.test(all)) return say('');
    const results = msgs.filter((m) => m.role === 'tool').length;
    if (all.includes(P.chess)) { if (release) await release; return say('The chess game is in index.html.'); }
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
    tagCalls.length = 0;
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
    await mkdir(join(home, 'storages', 'dsh-composer-plus'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: Object.values(ids), archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids['acme-web'] },
      tables: { workspaces: tables } }));
    // The old notebook board of an earlier version: it stays as it is.
    const oldBoard = '{"v":1,"next":2,"projects":[],"tasks":[{"id":1,"title":"Old task"}]}';
    await writeFile(join(home, 'storages/dsh-composer-plus/board.json'), oldBoard);
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3207', '--no-open'], { cwd: acme, env: { ...process.env, HOME: home, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
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

      // 1. A prompt starts a chat; it is in Doing while it runs, then in Done with the green dot.
      await openBoard();
      await until(async () => (await titles('done')).includes('FAQ page'), async () => `done: ${await titles('done')}`, 20000);
      assert.equal(await card('FAQ page').locator('[data-cpb-tag]').count(), 0, 'a chat that the board did not start has no tags');
      await boardPage.locator('.cpb-nav', { hasText: 'docs-site' }).click();
      await boardPage.locator('h1', { hasText: 'docs-site' }).waitFor();
      assert.equal(await card('FAQ page').count(), 0, 'a chat of another project is not in docs-site');
      console.log('  1a: a chat started in dsh\'s composer is on the board (All projects), not in another project');
      await boardPage.locator('.cpb-nav', { hasText: 'acme-web' }).click();
      await boardPage.locator('h1', { hasText: 'acme-web' }).waitFor();
      let open; release = new Promise((r) => { open = r; });
      // New task: dsh's own new chat in acme-web; the board goes. Its composer is dsh's (the + attach button is there).
      await boardPage.locator('[data-cpb-new]').click();
      await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await input.waitFor({ timeout: 10000 });
      const chip = async () => page.evaluate(() => document.querySelector('[class*="_heroWorkspaceRow"] button[class*="_workspace"]')?.textContent?.trim() ?? '');
      await until(async () => /acme-web/.test(await chip()), async () => `new chat project: ${await chip()}`, 10000);
      // Back to the board before a message: the new chat waits in Todo as "New task"; a click opens it again.
      await openBoard();
      await until(async () => (await titles('todo')).join() === 'New task', async () => `todo: ${await titles('todo')}`, 10000);
      assert.match(await column('todo').locator('[data-cpb-when]').innerText(), /Write the first message/);
      await column('todo').locator('[data-cpb-card]').click();
      await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      await until(async () => /acme-web/.test(await chip()), 'the same new chat in acme-web', 10000);
      // The first message, from dsh's own composer: the board comes back by itself.
      await input.click(); await page.keyboard.type(P.chess, { delay: 5 }); await page.keyboard.press('Enter');
      await boardPage.waitFor({ timeout: 15000 });
      console.log('  1c: New task opens dsh\'s new chat in acme-web; Todo shows it as "New task" until its first message; that message brings the board back');
      await until(async () => (await titles('doing')).includes('Chess game'), async () => `doing: ${await titles('doing')} todo: ${await titles('todo')}`, 20000);
      assert.deepEqual(await titles('todo'), [], 'it left Todo');
      await until(async () => (await card('Chess game').locator('[data-cpb-tag]').allInnerTexts()).join() === 'chess,game', 'the tags', 15000);
      assert.deepEqual(tagCalls.find((c) => c.prompt === P.chess)?.model, 'demo', 'the tags come from the chat\'s own model');
      assert.equal(await card('Chess game').locator('.cpb-preview').innerText(), P.chess, 'the prompt shows under the AI title');
      open(); release = null;
      await until(async () => (await titles('done')).includes('Chess game'), async () => `done: ${await titles('done')}`, 20000);
      // It is still dsh's open chat behind the board: no green dot, as in dsh's own sidebar (dsh's `isMain` rule). The
      // green dot of a chat that is not open is checked in step 2.
      assert.equal(await card('Chess game').getAttribute('data-cpb-state'), 'read', 'dsh\'s open chat: no green dot');
      console.log('  1b: chat "Chess game" (dsh title), tags chess+game from its first message (the chat\'s model), Doing → Done');

      // 2. Three waiting chats, never opened: each is orange in Review and is answered on the board.
      for (const p of [P.approve, P.question, P.plan]) await task(p === P.plan ? `/plan ${p}` : p);
      await until(async () => (await titles('review')).length === 3, async () => `review: ${await titles('review')} doing: ${await titles('doing')} todo: ${await titles('todo')} done: ${await titles('done')}`, 40000);
      for (const name of ['Slow demo check', 'Theme color', 'Export feature plan']) assert.equal(await card(name).getAttribute('data-cpb-state'), 'waiting', `${name} is orange`);
      assert.match(await card('Slow demo check').locator('.cpb-wait').innerText(), /Waiting for approval/);
      assert.match(await card('Theme color').locator('.cpb-wait').innerText(), /Waiting for answer/);
      assert.match(await card('Export feature plan').locator('.cpb-wait').innerText(), /Plan awaiting review/);
      const panel = page.locator('[data-cpb-panel="answer"]');
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
      await page.setViewportSize({ width: 760, height: 820 }); await pause(400);
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
      console.log(`  4: at 1180 px the 4 columns fit (overflow ${fit.colsOverflow}px) and a long title wraps in its card; in ${colWidth} px columns titles break only between words`);

      // 6. The project list: search, and "Active in the last 2 hours" (docs-site has no chat: it hides; stays after a reload).
      const navs = async () => (await boardPage.locator('.cpb-nav').allInnerTexts()).map((x) => x.split('\n')[0].trim());
      const search = boardPage.locator('[data-cpb-search]');
      assert.equal(await search.getAttribute('placeholder'), 'Search projects', 'the label of Project search in a new chat');
      // The box keeps the height of a project row, also when the list is longer than the side (the owner, with about 20
      // projects, saw it squeezed: the side is a flex column). A short side gives the same overflow as a long list.
      const heights = await boardPage.evaluate((el) => {
        const side = el.querySelector('.cpb-side'); side.style.height = '150px';
        const out = { search: el.querySelector('[data-cpb-search]').getBoundingClientRect().height, nav: el.querySelector('.cpb-nav').getBoundingClientRect().height, scrolls: side.scrollHeight > side.clientHeight };
        side.style.height = ''; return out;
      });
      assert.ok(heights.scrolls && heights.search >= heights.nav, `the search box is as tall as a project row in a long list (${JSON.stringify(heights)})`);
      // Only the states have colors: a project folder has the row's text color, and a card's project chip has no dot.
      const colors = await boardPage.evaluate((el) => ({
        folders: [...el.querySelectorAll('.cpb-nav')].slice(1).map((n) => getComputedStyle(n.querySelector('path')).stroke === getComputedStyle(n).color),
        chips: [...el.querySelectorAll('.cpb-card .cpb-chip')].map((c) => c.children.length),
      }));
      assert.ok(colors.folders.length === 2 && colors.folders.every(Boolean), `a project folder has no color of its own (${JSON.stringify(colors)})`);
      assert.ok(colors.chips.every((n) => n === 0), `a card's project has no colored dot (${JSON.stringify(colors)})`);
      await search.fill('DOCS'); await until(async () => (await navs()).join() === 'All projects,docs-site', async () => `search: ${await navs()}`, 5000);
      await search.press('Escape'); assert.equal(await search.inputValue(), '', 'Esc empties the box');
      assert.equal(await boardPage.count(), 1, 'and the page stays');
      await until(async () => (await navs()).join() === 'All projects,acme-web,docs-site', async () => `after Esc: ${await navs()}`, 5000);
      const recentButton = boardPage.locator('[data-cpb-recent]');
      assert.equal(await recentButton.innerText(), 'Active in the last 2 hours', 'the label of Recent projects filter');
      await recentButton.click(); await until(async () => (await navs()).join() === 'All projects,acme-web', async () => `recent: ${await navs()}`, 5000);
      await search.fill('docs'); await boardPage.locator('[data-cpb-noproject]', { hasText: 'No matching project' }).waitFor();
      await search.fill('');
      await page.reload(); await input.waitFor({ timeout: 20000 }); await openBoard();
      assert.equal(await boardPage.locator('[data-cpb-recent]').getAttribute('aria-pressed'), 'true', 'the filter stays after a reload');
      assert.deepEqual(await navs(), ['All projects', 'acme-web']);
      await boardPage.locator('[data-cpb-recent]').click(); await until(async () => (await navs()).length === 3, 'filter off', 5000);
      console.log('  6: project search (DOCS → docs-site, Esc empties) and Active in the last 2 hours (docs-site hides, kept after a reload)');

      // 3. Hide finished: Done goes, and stays hidden after a reload. A click on a card opens its chat.
      await boardPage.locator('[data-cpb-hide-done]').click();
      await column('done').waitFor({ state: 'detached' });
      await page.reload(); await input.waitFor({ timeout: 20000 }); await openBoard();
      assert.equal(await column('done').count(), 0, 'Hide finished stays after a reload');
      assert.equal(await boardPage.locator('[data-cpb-hide-done]').getAttribute('aria-pressed'), 'true');
      await boardPage.locator('[data-cpb-hide-done]').click(); await column('done').waitFor();
      if (process.env.SHOT) {
        // The Settings picture: a running card (held), an orange card, finished cards; no panel.
        let openShot; release = new Promise((res) => { openShot = res; });
        await task(P.chess); await task(P.question);
        await until(async () => (await titles('doing')).length >= 1 && (await titles('review')).length >= 1, 'the picture board', 30000);
        await until(async () => (await column('doing').locator('[data-cpb-tag]').count()) >= 2 && (await column('review').locator('.cpb-preview').count()) >= 1, 'the tags of the picture', 15000);
        await pause(500);
        await shot(page, home, 'taskBoard', boardPage);
        openShot(); release = null;
      }
      await card('Chess game').first().click();
      await boardPage.waitFor({ state: 'detached', timeout: 10000 });
      // The chat opens. Its sidebar row can be under "Show N more sessions" (more chats now), so check the chat header.
      await page.locator('[data-composer-input]').waitFor({ timeout: 10000 });
      await page.getByText('The chess game is in index.html.', { exact: true }).first().waitFor({ timeout: 10000 });
      console.log('  3: Hide finished hides Done and stays after a reload; a click on a card opens its chat');

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
      await sw().click(); await until(async () => (await sw().getAttribute('aria-checked')) === 'false', 'switch off');
      assert.equal((await page.evaluate(async () => (await fetch('/api/composer-plus.board')).json())).on, false, 'the Host keeps the switch');
      await back();
      assert.equal(await page.getByRole('button', { name: 'Task board', exact: true }).count(), 0, 'off: no sidebar row');
      assert.equal(await boardPage.count(), 0, 'off: no page');
      await settings(); await sw().click(); await until(async () => (await sw().getAttribute('aria-checked')) === 'true', 'switch on'); await back();
      await page.getByRole('button', { name: 'Task board', exact: true }).waitFor();
      assert.equal(await readFile(join(home, 'storages/dsh-composer-plus/board.json'), 'utf8'), oldBoard, 'the old board file stays as it was');
      assert.deepEqual(errors, [], 'no page errors');
      const ours = failedUrls.filter((u) => /composer-plus\.board/.test(u));
      assert.deepEqual(ours, [], `no failed request of the board: ${failedUrls.join(', ')}`);
      console.log('  5: switch off removes the row and the page (the Host keeps it); on brings them back; board.json untouched');
      console.log(`PASS ${bin}`);
    } catch (error) {
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`FAIL ${bin}: ${error?.stack ?? error}\npage errors: ${JSON.stringify(errors).slice(0, 3000)}\n--- dsh log (end) ---\n${log.slice(-3000)}\nscreenshot: ${join(home, 'failed.png')}`);
      process.exitCode = 1;
    } finally {
      release = null;
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      if (process.exitCode !== 1) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
