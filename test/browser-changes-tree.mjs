// Real-app check of the Changes panel branch tree on each dsh given: a fake model, a throwaway DSH_HOME and a made-up
// project with a git history (main, a merged side branch, an open feature branch, a tag, origin/main). Never the normal
// DSH_HOME and no real model. Headless.
// 1. A finished chat in the demo project; the right sidebar → Changes shows Uncommitted with the branch chip "main → origin/main".
// 2. A click on the branch chip opens the tree: one row per commit with its lanes (SVG), HEAD marked and in view.
// 3. A click on a branch above the tree marks that branch's commit and scrolls it into the middle of the page
//    (measured with getBoundingClientRect: the page is in a background tab, so nothing waits for paint).
// 4. A click on a commit row shows that commit's files; a click on a file shows its diff; ← Tree goes back, marked on it.
// 5. The mode menu has Tree; Uncommitted leaves the tree. The project's git state is unchanged (no checkout, no write).
// 6. Switch the feature off in Settings: the Changes page is gone; on again: it is back.
// PLAYWRIGHT=/path/to/playwright node test/browser-changes-tree.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/changesPanel.webp (English UI, demo project only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model: one short answer (and a title).
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const last = JSON.stringify(JSON.parse(body).messages?.at(-1)?.content ?? '');
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: /session title/i.test(last) ? 'Guest checkout' : 'The guest checkout branch is merged.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
/** The demo history (made-up project): 2 releases on main, a merged branch, an open branch and origin/main behind. */
async function demoRepo(dir) {
  await mkdir(join(dir, 'src/cart'), { recursive: true }); await mkdir(join(dir, 'test'), { recursive: true });
  let n = 0;
  const commit = async (file, text, msg) => { await writeFile(join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', msg, `--date=2026-10-${String(10 + n).padStart(2, '0')}T10:00:00`); n += 1; };
  git(dir, 'init', '-q', '-b', 'main');
  await commit('README.md', '# shop\n\nDemo project.\n', 'Initial commit');
  await commit('src/cart/service.ts', 'export const cart = [];\n', 'Add the cart service');
  git(dir, 'tag', 'v1.0.0');
  git(dir, 'checkout', '-q', '-b', 'guest-checkout');
  await commit('src/cart/address.ts', "export function address(cart) {\n  if (cart.guest) return askAddress(cart);\n  return cart.user.address;\n}\n", 'Ask guests for an address');
  await commit('test/cart.test.ts', "test('guest address', () => {});\n", 'Test the guest address step');
  git(dir, 'checkout', '-q', 'main');
  await commit('src/cart/service.ts', 'export const cart = [];\nexport const total = () => 0;\n', 'Add the cart total');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'merge', '-q', '--no-ff', 'guest-checkout', '-m', 'Merge branch guest-checkout');
  git(dir, 'checkout', '-q', '-b', 'dark-mode', 'HEAD~1');
  await commit('src/theme.ts', "export const theme = 'dark';\n", 'Add a dark theme');
  git(dir, 'checkout', '-q', 'main');
  await commit('CHANGELOG.md', '# 1.1.0\n\n- Guest checkout\n', 'Release 1.1.0');
  git(dir, 'tag', 'v1.1.0');
  // A made-up remote (never fetched): main tracks origin/main, which the history above left one merge behind.
  git(dir, 'remote', 'add', 'origin', 'https://example.com/demo/shop.git');
  git(dir, 'config', 'branch.main.remote', 'origin'); git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
  await writeFile(join(dir, 'README.md'), '# shop\n\nDemo project with guest checkout.\n');
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tree-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'tree-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'shop'); await mkdir(project, { recursive: true });
    await demoRepo(project);
    const fingerprint = () => [git(project, 'rev-parse', 'HEAD'), git(project, 'branch', '--show-current'), git(project, 'status', '--porcelain'), git(project, 'for-each-ref')].join('|');
    const before = fingerprint();
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'shop', sessionIds: [], createdAt: now, updatedAt: now } } },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3199', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      // 1. A finished chat, then Changes in the right sidebar.
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      await input.click(); await page.keyboard.type('Is the guest checkout branch merged?'); await page.keyboard.press('Enter');
      await page.getByText('The guest checkout branch is merged.').first().waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'Open right sidebar' }).click(); await pause(700);
      await page.getByText('Changes', { exact: true }).first().click();
      const panel = page.locator('[data-composer-plus-changes]'); await panel.waitFor({ timeout: 8000 });
      await panel.getByText('README.md', { exact: true }).waitFor({ timeout: 8000 });
      const chip = panel.locator('[data-composer-plus-branch-chip]');
      assert.equal((await chip.innerText()).replace(/\s+/g, ''), 'main→origin/main');
      // 2. The branch chip opens the tree; HEAD is marked and visible.
      await chip.click();
      const tree = panel.locator('[data-composer-plus-tree]'); await tree.waitFor({ timeout: 8000 });
      const rows = tree.locator('[data-composer-plus-commit]');
      assert.equal(await rows.count(), 8, 'one row per commit of all branches');
      const subjects = await rows.locator('span:nth-last-child(2)').allInnerTexts();
      // The tips share one commit second here, so their order is git's; the root is always last.
      assert.ok(subjects.slice(0, 2).includes('Release 1.1.0') && subjects.includes('Add a dark theme')); assert.equal(subjects.at(-1), 'Initial commit');
      const head = git(project, 'rev-parse', 'HEAD').trim();
      assert.equal(await tree.locator(`[data-composer-plus-commit="${head}"]`).getAttribute('aria-current'), 'true', 'HEAD is marked');
      const lanes = await tree.locator('svg').evaluateAll((svgs) => Math.max(...svgs.map((s) => s.querySelectorAll('path').length)));
      assert.ok(lanes >= 3, `the merge row draws its lines (${lanes} paths)`);
      assert.ok(await tree.locator(`[data-composer-plus-commit="${head}"] circle`).count() === 2, 'HEAD has a ring and a dot');
      const branchChips = await panel.locator('[data-composer-plus-branch]').evaluateAll((els) => els.map((e) => e.getAttribute('data-composer-plus-branch')));
      assert.deepEqual(branchChips, ['main', 'dark-mode', 'guest-checkout', 'origin/main'], 'current branch first, then local, then remote; no tags');
      // Keyboard: Tab from main to the unmarked dark-mode chip shows the browser's focus ring.
      await panel.locator('[data-composer-plus-branch="main"]').focus(); await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => { const e = document.activeElement; return { name: e.getAttribute('data-composer-plus-branch'), visible: e.matches(':focus-visible'), outline: getComputedStyle(e).outlineStyle }; });
      assert.equal(ring.name, 'dark-mode'); assert.equal(ring.visible, true);
      assert.notEqual(ring.outline, 'none', 'the focused branch chip has a focus ring');
      // 3. A branch chip: its commit is marked and in the middle of the scroll box (measured, no paint needed).
      const inView = (sha) => page.evaluate((s) => {
        const row = document.querySelector(`[data-composer-plus-commit="${s}"]`); const box = row.closest('[data-composer-plus-tree]').parentElement;
        const r = row.getBoundingClientRect(); const b = box.getBoundingClientRect();
        return { inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1, scrollable: box.scrollHeight > box.clientHeight };
      }, sha);
      const dark = git(project, 'rev-parse', 'dark-mode').trim();
      await panel.locator('[data-composer-plus-branch="dark-mode"]').click();
      await page.waitForFunction((s) => document.querySelector(`[data-composer-plus-commit="${s}"]`)?.getAttribute('aria-current') === 'true', dark);
      assert.equal(await tree.locator('[aria-current="true"]').count(), 1, 'one marked row');
      assert.equal((await inView(dark)).inside, true, 'the branch row is in view');
      // Low page: origin/main → its commit → ← Tree brings it back into view.
      await page.setViewportSize({ width: 1280, height: 300 }); await pause(300);
      await panel.locator('[data-composer-plus-branch="origin/main"]').click(); await pause(200);
      await tree.locator(`[data-composer-plus-commit="${git(project, 'rev-parse', 'origin/main').trim()}"]`).click(); await pause(100);
      await panel.locator('[data-composer-plus-tree-back]').click();
      const view = await inView(git(project, 'rev-parse', 'origin/main').trim());
      assert.ok(view.scrollable, 'the tree scrolls at this height'); assert.equal(view.inside, true, 'back: the commit is in view again');
      await page.setViewportSize({ width: 1280, height: 800 }); await pause(300);
      // 4. A commit: its files and a diff; back to the tree.
      const side = git(project, 'rev-parse', 'guest-checkout~1').trim();
      await tree.locator(`[data-composer-plus-commit="${side}"]`).click();
      await panel.getByText('Ask guests for an address', { exact: true }).waitFor({ timeout: 8000 });
      await panel.getByText('src/cart/address.ts', { exact: true }).click();
      await panel.getByText("+  if (cart.guest) return askAddress(cart);", { exact: true }).waitFor({ timeout: 8000 });
      if (index === 0 && process.env.SHOT) {
        // Settings picture: the tree with a branch marked (the README hero keeps the diff view).
        await panel.locator('[data-composer-plus-tree-back]').click(); await tree.waitFor();
        await panel.locator('[data-composer-plus-branch="guest-checkout"]').click(); await pause(600);
        await page.mouse.move(5, 795);
        const png = join(home, 'changesPanel.png'); await page.screenshot({ path: png });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', '1600', '0', png, '-o', join(repo, 'assets/features/changesPanel.webp')]);
        await tree.locator(`[data-composer-plus-commit="${side}"]`).click(); await panel.getByText('src/cart/address.ts', { exact: true }).waitFor();
      }
      await panel.locator('[data-composer-plus-tree-back]').click();
      await tree.waitFor({ timeout: 2000 });
      assert.equal(await tree.locator(`[data-composer-plus-commit="${side}"]`).getAttribute('aria-current'), 'true', 'back: the commit that was open is marked');
      // 5. The mode menu: Tree is listed; Uncommitted leaves the tree.
      await panel.getByRole('button', { name: /^Tree/ }).first().click();
      await page.getByRole('menuitem', { name: 'Tree' }).or(page.getByRole('menuitemradio', { name: 'Tree' })).or(page.getByRole('menuitemcheckbox', { name: 'Tree' })).first().waitFor({ timeout: 5000 });
      await page.getByText('Uncommitted', { exact: true }).last().click();
      await tree.waitFor({ state: 'detached', timeout: 5000 });
      await panel.getByText('README.md', { exact: true }).waitFor({ timeout: 8000 });
      assert.equal(fingerprint(), before, 'the project git state is unchanged');
      // 6. The switch removes the page and puts it back.
      const setSwitch = async (on) => {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        await page.locator('[data-composer-plus-settings]').waitFor();
        const sw = page.getByRole('switch', { name: 'Changes panel' }); await sw.waitFor({ timeout: 10000 });
        if ((await sw.isChecked()) !== on) await sw.click();
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const close = overlay.getByRole('button', { name: /^Close$/ });
        if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(400);
      };
      await setSwitch(false);
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      await setSwitch(true);
      await page.getByText('Changes', { exact: true }).first().click().catch(() => {});
      await panel.waitFor({ timeout: 8000 });
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: branch chip → tree (8 rows, HEAD marked, lanes drawn, chips main/dark-mode/guest-checkout/origin/main) → dark-mode chip marks and shows its commit → commit → files → diff → ← Tree marks it → menu Tree / Uncommitted → git state unchanged → switch off/on`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // tokens stay in the temp home
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
