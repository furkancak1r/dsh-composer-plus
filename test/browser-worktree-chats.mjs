// Real-app check of Branch per chat (worktreeChats) on each dsh given (fake model, throwaway DSH_HOME, made-up git
// project; headless):
// - dsh 0.2.1+: the New chat screen shows the branch chip "main" between dsh's project and mode buttons, with their font,
//   color, height and icons; the switch off removes the chip and its style and gives the row its own order back.
//   With 15 other worktrees the chip's menu stops at 360 px, scrolls with the wheel and stays inside a low window.
//   New branch + a first message with an image and a file (the composer takes no text while the Host works) → the fake model names
//   the branch, the Host creates <project>/.worktrees/feat-login-remember-me on branch feat/login-remember-me, copies only
//   the `.worktreeinclude` files (.env yes, .env.production no, node_modules as a clone), and opens a new chat there that
//   got the message. With dsh's Workspace tree view the branch folder shows inside its project (not as a top project).
// - every version: the open chat's header shows "⑂ <branch>" with its change count; a new file makes it count.
// - every version: the chat's agent deletes the chat's own branch (bash: worktree remove + branch -D). The turn ends with
//   no "working-directory: directory does not exist", the chat stays open and selected, its branch folder row goes and
//   the chat shows under Ungrouped; on dsh 0.2.1 the model is told the main folder at the next turn.
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
// "Please delete the branch" gets a bash call that runs `removal` in the main checkout, then "Branch deleted."; "Where are
// you now" gets the newest working folder that dsh told the model ("unknown" when dsh tells none).
// The branch-name answer waits for `nameGate` (the test reads the locked composer meanwhile). Chat requests are kept.
let nameGate = Promise.resolve(); const chatBodies = []; let removal = { command: 'true', workdir: '/' }; let whereAnswer;
const PROMPTS = ['Add a remember me box to the login form', 'Say hello', 'Please delete the branch', 'Where are you now'];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const all = JSON.stringify(msgs); const last = msgs.at(-1);
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    const stream = (delta, finish) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk(delta) + chunk({}, finish) + 'data: [DONE]\n\n'); };
    const say = (text) => stream({ role: 'assistant', content: text }, 'stop');
    if (/branch name/i.test(JSON.stringify(msgs[0] ?? '')) || /branch name/i.test(all.slice(0, 2000))) { await nameGate; say('feat/login-remember-me'); return; }
    chatBodies.push(all);
    if (/session title/i.test(JSON.stringify(last?.content))) { say('Demo chat'); return; }
    const prompt = PROMPTS.map((p) => [p, all.lastIndexOf(p)]).filter(([, at]) => at !== -1).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'something';
    // Next message prediction (on by default) also reads the chat: it gets a plain guess, never a tool call.
    if (/predict the next message/i.test(JSON.stringify(msgs[0] ?? ''))) { say('Thanks'); return; }
    if (prompt === 'Please delete the branch') {
      // dsh adds its context message after the tool result: the call is done when a tool result follows the request.
      const asked = msgs.findLastIndex((m) => JSON.stringify(m.content ?? '').includes(prompt));
      if (msgs.slice(asked + 1).some((m) => m.role === 'tool')) { say('Branch deleted.'); return; }
      stream({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ ...removal, description: 'Remove the worktree and its branch' }) } }] }, 'tool_calls');
      return;
    }
    if (prompt === 'Where are you now') {
      const text = msgs.map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('\n'))).join('\n');
      whereAnswer = `Working in: ${[...text.matchAll(/Current working directory: "([^"]+)"/g)].at(-1)?.[1] ?? 'unknown'}`;
      say(whereAnswer); return;
    }
    say(`Got: ${prompt}`);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
// dsh's New chat row: the project button, our chip and the mode button (place and computed look), the options box when
// it shows, and the number of chip style tags in the page.
const heroLayout = (page) => page.evaluate(() => {
  const row = document.querySelector('[class*="_heroWorkspaceRow"]');
  const read = (button) => {
    if (!button) return null;
    const r = button.getBoundingClientRect(); const s = getComputedStyle(button); const svgs = button.querySelectorAll('svg');
    return { order: s.order, box: { left: r.left, right: r.right, mid: r.top + r.height / 2 },
      look: { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, height: r.height,
        paddingLeft: s.paddingLeft, borderRadius: s.borderRadius, icon: svgs[0]?.getAttribute('width'), chevron: svgs[svgs.length - 1]?.getAttribute('width'),
        chevronColor: svgs.length < 2 ? null : getComputedStyle(svgs[svgs.length - 1]).color } };
  };
  const options = row?.querySelector(':scope > [class*="_heroOptions"]');
  return { project: read(row?.querySelector(':scope > button[class*="_workspace"]')), chip: read(document.querySelector('[data-composer-plus-new-branch-chip]')),
    mode: read(row?.querySelector('[data-slot="conversation.hero.agentPreset"] button[aria-haspopup="menu"]')),
    options: options && getComputedStyle(options).display !== 'none' ? getComputedStyle(options).order : null,
    styles: [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('.cp-branch-chip')).length };
});
// Settings → Composer Plus → the Branch per chat switch (0.2.1 has Settings in the account menu), then close Settings.
const setSwitch = async (page, on) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) await direct.click();
  else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
  await page.getByText('Composer Plus', { exact: true }).click();
  const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name: 'Branch per chat' }); await sw.waitFor({ timeout: 10000 });
  if ((await sw.isChecked()) !== on) await sw.click();
  const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
  const close = overlay.getByRole('button', { name: /^Close$/ });
  if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached' }); await pause(400);
};
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
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 1000, input: [ text, image ], reasoningEfforts: false }
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
    // 15 more worktrees (outside the project, so its checkout stays clean): the chip's menu must stop and scroll.
    for (let n = 1; n <= 15; n++) git(project, 'worktree', 'add', '-q', '-b', `feat/demo-${n}`, join(home, 'projects', 'acme-web-wt', `demo-${n}`));
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
        // The chip sits between dsh's project and mode buttons and looks like them.
        const hero = await heroLayout(page);
        assert.ok(hero.project && hero.mode && hero.chip, `project, chip and mode show: ${JSON.stringify(hero)}`);
        assert.ok(hero.project.box.right <= hero.chip.box.left + 1 && hero.chip.box.right <= hero.mode.box.left + 1, `order project → chip → mode: ${JSON.stringify(hero)}`);
        for (const b of [hero.project, hero.mode]) assert.ok(Math.abs(b.box.mid - hero.chip.box.mid) <= 1, `one line: ${JSON.stringify(hero)}`);
        for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'height', 'paddingLeft', 'borderRadius', 'icon', 'chevron', 'chevronColor']) {
          assert.equal(hero.chip.look[key], hero.project.look[key], `${key} as the project button`);
          // dsh's own two buttons differ only in the chevron (project 12 px, mode 14 px): the chip takes the project's.
          if (key !== 'chevron') assert.equal(hero.chip.look[key], hero.mode.look[key], `${key} as the mode button`);
        }
        assert.equal(hero.styles, 1, 'one chip style');
        step('Chip between project and mode, same look');
        // The menu with 15 other worktrees stops at 360 px, scrolls with the wheel and stays in the window (also a low one).
        const menuBox = () => page.evaluate(() => {
          // dsh's rows box (`_viewport`) holds the rows; the menu's first child is its material layer.
          const list = document.querySelector('[role="menu"].cp-branch-menu'); const view = list?.querySelector('[data-composer-plus-branch-item]')?.closest('[role="presentation"]');
          if (!list || !view) return null;
          const r = list.getBoundingClientRect(); const items = list.querySelectorAll('[data-composer-plus-branch-item]'); const last = items[items.length - 1]?.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height, inner: innerHeight, rows: items.length, scrollHeight: view.scrollHeight, clientHeight: view.clientHeight,
            scrollTop: view.scrollTop, overflow: getComputedStyle(view).overflowY, lastShown: last !== undefined && last.top >= r.top - 1 && last.bottom <= r.bottom + 1 };
        });
        const openMenu = async () => { await chip.click(); await page.locator('[role="menu"].cp-branch-menu').waitFor({ timeout: 5000 }); await pause(300); return menuBox(); };
        let m = await openMenu();
        assert.equal(m.rows, 15, `15 other worktrees: ${JSON.stringify(m)}`);
        assert.ok(m.height <= 361 && m.height >= 340, `the menu stops at 360 px: ${JSON.stringify(m)}`);
        assert.ok(m.overflow === 'auto' && m.scrollHeight > m.clientHeight + 100, `its rows scroll: ${JSON.stringify(m)}`);
        assert.ok(m.top >= 0 && m.bottom <= m.inner, `in the window: ${JSON.stringify(m)}`);
        assert.equal(m.lastShown, false, 'the last worktree is below the fold');
        await page.mouse.move(Math.round((await page.locator('[role="menu"].cp-branch-menu').boundingBox()).x + 40), Math.round(m.top + m.height / 2));
        await page.mouse.wheel(0, 3000); await pause(400);
        m = await menuBox();
        assert.ok(m.scrollTop > 0 && m.lastShown && m.height <= 361, `the wheel scrolls to the last worktree: ${JSON.stringify(m)}`);
        await page.keyboard.press('Escape'); await page.locator('[role="menu"].cp-branch-menu').waitFor({ state: 'detached' });
        for (const height of [420, 330]) {
          await page.setViewportSize({ width: 1280, height });
          m = await openMenu();
          assert.ok(m.top >= 0 && m.bottom <= m.inner && m.height <= Math.min(361, height - 23), `${height} px window: the menu stays in it: ${JSON.stringify(m)}`);
          assert.ok(m.scrollHeight > m.clientHeight, `${height} px window: its rows scroll: ${JSON.stringify(m)}`);
          await page.keyboard.press('Escape'); await page.locator('[role="menu"].cp-branch-menu').waitFor({ state: 'detached' });
        }
        await page.setViewportSize({ width: 1280, height: 800 }); await pause(300);
        step('Long branch menu stops at 360 px, scrolls, stays in the window');
        // Switched off, the chip and its style are gone and dsh's row has its own order; on again, it comes back.
        await setSwitch(page, false);
        await chip.waitFor({ state: 'detached', timeout: 5000 });
        const off = await heroLayout(page);
        assert.equal(off.chip, null); assert.equal(off.styles, 0, 'no chip style');
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent.includes('cp-branch-menu'))), false, 'no menu style');
        assert.equal(off.project.order, '0', 'dsh row order back'); assert.ok(off.options === null || off.options === '0', `options box order back: ${off.options}`);
        assert.ok(off.project.box.right <= off.mode.box.left + 1, 'project → mode as dsh draws them');
        await setSwitch(page, true);
        await chip.waitFor({ timeout: 8000 });
        step('Switch off removes the chip and its style; on brings it back');
        await chip.click();
        await page.locator('[data-composer-plus-branch-new]').click();
        assert.equal(await chip.getAttribute('data-composer-plus-new-branch-chip'), 'new');
        assert.match(await chip.innerText(), /New branch/);
        // The first message carries an image and a file. While the Host makes the branch, the composer takes no text.
        await page.locator('input[type="file"]').first().setInputFiles([
          { name: 'mockup.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') },
          { name: 'spec.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember me: 30 days\n') }]);
        await page.waitForFunction(() => document.querySelectorAll('[data-composer-seat] img').length > 0, null, { timeout: 10000 });
        await pause(1500); // the file upload ends
        let openGate; nameGate = new Promise((r) => { openGate = r; });
        await input.click(); await page.keyboard.type('Add a remember me box to the login form'); await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('[data-composer-plus-new-branch-chip]')?.getAttribute('data-composer-plus-new-branch-chip') === 'busy', null, { timeout: 10000 });
        const locked = await page.evaluate(() => { const i = document.querySelector('[data-composer-input]'); return { editable: i?.getAttribute('contenteditable'), shown: document.querySelector('[data-composer-placeholder]')?.textContent ?? i?.getAttribute('data-placeholder') }; });
        assert.notEqual(locked.editable, 'true', `the composer takes no text while the branch is made: ${JSON.stringify(locked)}`);
        assert.match(locked.shown ?? '', /Creating branch/, `the composer says why: ${JSON.stringify(locked)}`);
        await input.click({ force: true }); await page.keyboard.type('typed meanwhile');
        assert.ok(!(await input.innerText()).includes('typed meanwhile'), 'typing does nothing meanwhile');
        step('Composer locked while the branch is made');
        openGate();
        await page.getByText('Got: Add a remember me box to the login form').first().waitFor({ timeout: 30000 }); await pause(600);
        // The new chat's own turn (not its title or prediction request): the message with its image and file.
        const firstAsk = chatBodies.find((b) => b.includes('Add a remember me box') && !/session title|Generate the session title/i.test(b) && /image/.test(b));
        assert.ok(firstAsk && /data:image\/png;base64/.test(firstAsk) && firstAsk.includes('mockup.png'), 'the new chat got the image');
        assert.ok(/File \\"spec\.txt\\" \(21 bytes/.test(firstAsk), 'the new chat got the file');
        assert.equal(await page.locator('[data-composer-input]').getAttribute('contenteditable'), 'true', 'the new chat composer takes text');
        // The new chat runs in the worktree, on the AI-named branch.
        assert.equal(git(wtPath, 'branch', '--show-current').trim(), 'feat/login-remember-me');
        assert.equal(await readFile(join(wtPath, '.env'), 'utf8'), 'API_URL=http://localhost:3000\n', '.env copied');
        await assert.rejects(stat(join(wtPath, '.env.production')), '.env.production is never copied');
        assert.equal(await readFile(join(wtPath, 'node_modules/left-pad/index.js'), 'utf8'), 'module.exports = 1;\n', 'node_modules copied');
        assert.equal(await readlink(join(wtPath, 'node_modules/left-pad/.bin/left-pad')), '../index.js', 'a symlink stays a link');
        assert.match(await readFile(join(project, '.git/info/exclude'), 'utf8'), /^\.worktrees\/$/m, '.worktrees/ is ignored locally');
        assert.equal(git(project, 'status', '--porcelain').trim(), '', 'the main checkout stays clean');
        step('New branch from the first message, with its image and file');
        // Workspace tree: the branch folder is a workspace nested inside acme-web (the main project row comes first).
        const rows = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="workspace:"]')].map((r) => ({ text: r.innerText.trim().split('\n')[0], left: Math.round(r.getBoundingClientRect().left + parseFloat(getComputedStyle(r).paddingLeft || '0')) })));
        const main = rows.find((r) => r.text.includes('acme-web')); const branch = rows.find((r) => r.text.includes('feat/login-remember-me'));
        assert.ok(main && branch, `both rows show: ${JSON.stringify(rows)}`);
        assert.ok(rows.indexOf(branch) > rows.indexOf(main), 'the branch row comes after its project');
        assert.ok(branch.left > main.left, `the branch row is indented inside its project: ${JSON.stringify(rows)}`);
        step('Branch folder nested in its project (Workspace tree)');
        // Git branch on chat rows: no pill under the branch folder (its row already names the branch); a chat in "In one
        // list" keeps it. The branch is recorded at the end of the turn.
        const badges = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-row-key^="session:"]')]
          .map((r) => [r.innerText.trim().split('\n')[0], r.querySelector('[data-composer-plus-branch-name]')?.getAttribute('data-composer-plus-branch-name') ?? null])));
        await page.waitForFunction(() => document.querySelector('[data-row-key^="session:"]') !== null, null, { timeout: 10000 }); await pause(1500);
        const tree = await badges();
        const wtRow = Object.keys(tree).find((k) => !/^New/.test(k));
        assert.ok(wtRow !== undefined, `the worktree chat row shows: ${JSON.stringify(tree)}`);
        assert.equal(tree[wtRow], null, `no branch pill under the branch folder: ${JSON.stringify(tree)}`);
        await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('dsh.workspace.view.v5')); localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({ ...v, groupBy: 'flat' })); });
        await page.reload(); await page.locator('[data-row-key^="session:"]').first().waitFor({ timeout: 15000 });
        await page.waitForFunction(() => document.querySelector('[data-composer-plus-branch-name="feat/login-remember-me"]') !== null, null, { timeout: 10000 });
        await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('dsh.workspace.view.v5')); localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({ ...v, groupBy: 'workspace-tree' })); });
        await page.reload(); await page.locator('[data-row-key^="session:"]').first().waitFor({ timeout: 15000 });
        step('No branch pill under the branch folder; "In one list" keeps it');
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
      // The chat's own branch is deleted by its agent (bash: `git worktree remove` + `git branch -D` in the main folder).
      // The turn ends without "working-directory: directory does not exist" (dsh 0.2.1), the chat stays open and in
      // focus, its branch folder row goes and the chat shows under Ungrouped; on dsh 0.2.1 it goes on in the main folder.
      // dsh 0.2.0 has no New chat chip: there the chat starts in a branch folder that the Host route `open` adds.
      const openChat = () => page.evaluate(() => document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.getAttribute('data-row-key')?.slice(8) ?? null);
      let delPath = wtPath; let delBranch = 'feat/login-remember-me';
      if (!hasHero) {
        delPath = join(project, '.worktrees', 'feat-cleanup'); delBranch = 'feat/cleanup';
        git(project, 'worktree', 'add', '-q', '-b', delBranch, delPath);
        const opened = await page.evaluate(async ([sessionId, path]) => (await fetch('/api/composer-plus.worktrees', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'open', sessionId, path }) })).json(), [await openChat(), delPath]);
        assert.ok(opened.workspaceId, `the branch folder is a project: ${JSON.stringify(opened)}`);
        const row = page.locator(`[data-row-key="workspace:${opened.workspaceId}"]`); await row.waitFor({ timeout: 10000 }); await row.hover();
        await page.getByRole('button', { name: `New session in ${delBranch}`, exact: true }).click(); await pause(800);
        await send('Say hello', 'Got: Say hello');
      }
      const delChat = await openChat();
      assert.ok(delChat, 'the branch chat is open');
      const branchRow = () => page.evaluate((name) => [...document.querySelectorAll('[data-row-key^="workspace:"]')].some((r) => r.innerText.trim().split('\n')[0] === name), delBranch);
      assert.equal(await branchRow(), true, 'its branch folder row shows');
      removal = { command: `git worktree remove --force ${JSON.stringify(delPath)} && git branch -D ${delBranch} && echo removed`, workdir: project };
      await input.click(); await page.keyboard.type('Please delete the branch'); await page.keyboard.press('Enter');
      const ended = await page.waitForFunction(() => /Branch deleted\.|directory does not exist/.test(document.body.innerText), null, { timeout: 30000 }).then(() => page.evaluate(() => document.body.innerText));
      const failure = ended.match(/[^\n]*directory does not exist[^\n]*/)?.[0];
      assert.equal(failure, undefined, `the turn ends without a folder error: ${failure}`);
      await page.getByText('Branch deleted.').first().waitFor({ timeout: 30000 }); await pause(1500);
      assert.equal(git(project, 'branch', '--list', delBranch).trim(), '', 'the branch is gone');
      assert.equal(await openChat(), delChat, 'the same chat stays open and selected');
      assert.equal(await page.locator('[data-composer-input]').getAttribute('contenteditable'), 'true', 'its composer takes text');
      await page.waitForFunction((name) => ![...document.querySelectorAll('[data-row-key^="workspace:"]')].some((r) => r.innerText.trim().split('\n')[0] === name), delBranch, { timeout: 10000 });
      const ungrouped = await page.evaluate((id) => {
        const rows = [...document.querySelectorAll('[data-row-key]')]; const group = rows.findIndex((r) => r.getAttribute('data-row-key') === 'workspace:');
        return { label: group === -1 ? null : rows[group].innerText.trim().split('\n')[0], after: group !== -1 && rows.findIndex((r) => r.getAttribute('data-row-key') === `session:${id}`) > group };
      }, delChat);
      assert.deepEqual(ungrouped, { label: 'Ungrouped', after: true }, 'the chat shows under Ungrouped');
      whereAnswer = undefined;
      await send('Where are you now');
      for (let i = 0; i < 60 && whereAnswer === undefined; i++) await pause(500);
      const where = whereAnswer;
      assert.ok(where, 'the chat answered');
      await page.getByText(where, { exact: true }).first().waitFor({ timeout: 30000 });
      if (hasHero) assert.equal(where, `Working in: ${project}`, 'dsh 0.2.1: the chat goes on in the main folder');
      assert.equal(await openChat(), delChat, 'still the same chat');
      assert.ok(!/directory does not exist/.test(await page.evaluate(() => document.body.innerText)), 'no folder error later');
      step(`Branch deleted from its own chat: chat stays open, under Ungrouped (${where})`);
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
