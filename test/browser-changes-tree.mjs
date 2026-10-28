// Real-app check of the Changes panel Tree (the branch map) on each dsh given: a fake model, a throwaway DSH_HOME and a made-up
// project with a git history (main, develop, a feature branch merged into develop, a hotfix merged into main, two open
// feature branches, tags, origin/main). Never the normal DSH_HOME and no real model. Headless.
// 1. A finished chat in the demo project; the right sidebar → Changes opens on Tree: the branch map with the counts, a box
//    per branch (blue main, green in main, orange not yet), rows by level, one arrow per branch to its target, the legend.
// 2. The cards filter the map; the same card again shows all.
// 3. A click on a box shows its commits (first-parent line); a click on a commit shows its files; a click on a file
//    shows its diff. ← goes back one step and marks the box or row that was open, in view (measured with
//    getBoundingClientRect: the page is in a background tab, so nothing waits for paint).
// 4. Merged → the merge commit's files; Waiting → the files that the branch brings into its target, and a diff.
// 5. A branch that is deleted while it is open says so.
// 6. The mode menu has Tree first; Uncommitted leaves it; the branch chip goes back. The project's git state is unchanged.
// 7. Switch the feature off in Settings: the Changes page is gone; on again: it is back.
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
    res.end(chunk({ role: 'assistant', content: /session title/i.test(last) ? 'Release plan' : 'Two branches wait to merge.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
/** The demo history (made-up project, as the owner's sketch): develop with feature/login merged, feature/report waiting on
 * develop, hotfix/payment merged into main, develop merged into main, feature/dark-mode waiting on main. */
async function demoRepo(dir) {
  await mkdir(join(dir, 'src'), { recursive: true });
  let n = 0;
  const when = () => `2026-10-${String(10 + n).padStart(2, '0')}T10:00:00`;
  const commit = async (file, text, msg) => { await mkdir(join(dir, 'src'), { recursive: true }); await writeFile(join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', msg, `--date=${when()}`); n += 1; };
  const merge = (branch, msg) => { execFileSync('git', ['merge', '-q', '--no-ff', branch, '-m', msg], { cwd: dir, env: { ...gitEnv, GIT_COMMITTER_DATE: when(), GIT_AUTHOR_DATE: when() } }); n += 1; };
  git(dir, 'init', '-q', '-b', 'main');
  await commit('README.md', '# shop\n\nDemo project.\n', 'Initial commit');
  git(dir, 'tag', 'v1.0.0');
  git(dir, 'checkout', '-q', '-b', 'develop');
  await commit('src/app.ts', 'export const app = {};\n', 'Set up the app shell');
  git(dir, 'checkout', '-q', '-b', 'feature/login');
  await commit('src/login.ts', "export function login(user) {\n  if (!user.email) return 'Enter your email';\n  return 'ok';\n}\n", 'Add the login screen');
  git(dir, 'checkout', '-q', 'develop'); merge('feature/login', 'Merge feature/login');
  git(dir, 'checkout', '-q', '-b', 'feature/report');
  await commit('src/report.ts', "export function report(orders) {\n  return orders.length + ' orders';\n}\n", 'Add the sales report');
  git(dir, 'checkout', '-q', 'main'); git(dir, 'checkout', '-q', '-b', 'hotfix/payment');
  await commit('src/payment.ts', 'export const retry = 3;\n', 'Retry a failed payment');
  git(dir, 'checkout', '-q', 'main'); merge('hotfix/payment', 'Merge hotfix/payment');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  merge('develop', 'Release 1.1.0');
  git(dir, 'tag', 'v1.1.0');
  git(dir, 'checkout', '-q', '-b', 'feature/dark-mode');
  await commit('src/theme.ts', "export const theme = 'dark';\n", 'Add a dark theme');
  git(dir, 'checkout', '-q', 'main');
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
      // Branch per chat off: a new chat in this git project would start on a new branch (its default).
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      // 1. A finished chat, then Changes in the right sidebar: it opens on Tree, the branch map.
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      await input.click(); await page.keyboard.type('Which branches wait to merge?'); await page.keyboard.press('Enter');
      await page.getByText('Two branches wait to merge.').first().waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: 'Open right sidebar' }).click(); await pause(700);
      await page.getByText('Changes', { exact: true }).first().click();
      const panel = page.locator('[data-composer-plus-changes]'); await panel.waitFor({ timeout: 8000 });
      const map = panel.locator('[data-composer-plus-map]'); await map.waitFor({ timeout: 8000 });
      const chip = panel.locator('[data-composer-plus-branch-chip]');
      assert.equal((await chip.innerText()).replace(/\s+/g, ''), 'main→origin/main');
      const box = (name) => map.locator(`[data-composer-plus-branch="refs/heads/${name}"]`);
      const pill = (name) => map.locator(`[data-composer-plus-pill="refs/heads/${name}"]`);
      const states = await map.locator('[data-composer-plus-state]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-composer-plus-branch').replace('refs/heads/', ''), e.getAttribute('data-composer-plus-state')]).sort());
      assert.deepEqual(states, [['develop', 'merged'], ['feature/dark-mode', 'waiting'], ['feature/login', 'merged'], ['feature/report', 'waiting'], ['hotfix/payment', 'merged'], ['main', 'main']], 'origin/main is not repeated');
      const cards = await map.locator('[data-composer-plus-map-card]').allInnerTexts();
      assert.deepEqual(cards.map((x) => x.replace(/\s+/g, ' ').trim()), ['6 Total branches', '3 Merged', '2 Waiting to merge']);
      const color = (name) => box(name).evaluate((e) => getComputedStyle(e).borderTopColor);
      const [blue, green, orange] = [await color('main'), await color('feature/login'), await color('feature/report')];
      assert.equal(new Set([blue, green, orange]).size, 3, `three box colors: ${blue} ${green} ${orange}`);
      assert.equal(await color('develop'), green); assert.equal(await color('feature/dark-mode'), orange);
      assert.equal(await pill('feature/login').innerText(), '✅ Merged'); assert.equal(await pill('feature/report').innerText(), '⏳ Waiting');
      assert.equal(await map.locator('[data-composer-plus-pill="refs/heads/main"]').count(), 0, 'no label on main');
      // Rows by level: main lowest; develop and hotfix one row above; login and report above develop.
      const top = async (name) => (await box(name).boundingBox()).y;
      assert.ok(await top('develop') < await top('main') && await top('feature/login') < await top('develop') && await top('feature/report') < await top('develop'), 'rows by level, main at the bottom');
      assert.equal(Math.round(await top('develop')), Math.round(await top('hotfix/payment')), 'develop and hotfix on one row');
      // One arrow per branch with a target (dashed when it waits); login's arrow ends at develop's box.
      const arrows = await map.locator('[data-composer-plus-arrow]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-composer-plus-arrow').replace('refs/heads/', ''), e.getAttribute('stroke-dasharray')]).sort());
      assert.deepEqual(arrows, [['develop', null], ['feature/dark-mode', '4 3'], ['feature/login', null], ['feature/report', '4 3'], ['hotfix/payment', null]]);
      const ends = await page.evaluate(() => {
        const g = document.querySelector('[data-composer-plus-arrow="refs/heads/feature/login"]'); const path = g.querySelectorAll('path')[1];
        const svg = g.ownerSVGElement.getBoundingClientRect(); const pt = path.getPointAtLength(path.getTotalLength());
        const target = document.querySelector('[data-composer-plus-branch="refs/heads/develop"]').getBoundingClientRect();
        return { x: svg.left + pt.x, y: svg.top + pt.y, left: target.left, right: target.right, top: target.top };
      });
      assert.ok(ends.x > ends.left && ends.x < ends.right && Math.abs(ends.y - ends.top) < 12, `login's arrow ends at the top of develop's box: ${JSON.stringify(ends)}`);
      // Three arrows go into main: they end side by side, not on one point.
      const intoMain = await page.evaluate(() => ['develop', 'hotfix/payment', 'feature/dark-mode'].map((n) => {
        const p = document.querySelector(`[data-composer-plus-arrow="refs/heads/${n}"]`).querySelectorAll('path')[1]; return Math.round(p.getPointAtLength(p.getTotalLength()).x); }));
      assert.equal(new Set(intoMain).size, 3, `arrow ends into main: ${intoMain}`);
      assert.deepEqual(await map.getByText(/^(Green|Orange|Blue):/).allInnerTexts(), ['Green: in the main branch', 'Orange: not in the main branch yet', 'Blue: main branch']);
      assert.equal(await panel.locator('[data-composer-plus-commit]').count(), 0, 'no commits before a click');
      if (index === 0 && process.env.SHOT) {
        // Settings picture: the branch map.
        await page.mouse.move(5, 795); await pause(300);
        const png = join(home, 'changesPanel.png'); await page.screenshot({ path: png });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', '1600', '0', png, '-o', join(repo, 'assets/features/changesPanel.webp')]);
      }
      // 2. The cards filter: Waiting keeps the two waiting boxes and the boxes that their arrows reach; again → all.
      await map.locator('[data-composer-plus-map-card="waiting"]').click();
      await box('feature/login').waitFor({ state: 'detached', timeout: 3000 });
      assert.equal(await map.locator('[data-composer-plus-state]').count(), 4, 'report, dark-mode, develop and main');
      await map.locator('[data-composer-plus-map-card="waiting"]').click(); await box('feature/login').waitFor({ timeout: 3000 });
      // Keyboard: a box has a focus ring.
      await box('main').focus(); await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => { const e = document.activeElement; return { visible: e.matches(':focus-visible'), outline: getComputedStyle(e).outlineStyle }; });
      assert.equal(ring.visible, true); assert.notEqual(ring.outline, 'none', 'the focused item has a focus ring');
      // 3. A box → its commits (first-parent line: login's commit is behind develop's merge, not in main's list).
      const inView = (sel) => page.evaluate((q) => {
        const row = document.querySelector(q); const scroller = row.closest('[data-composer-plus-changes]').lastElementChild;
        const r = row.getBoundingClientRect(); const b = scroller.getBoundingClientRect();
        return { inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1, scrollable: scroller.scrollHeight > scroller.clientHeight };
      }, sel);
      await box('main').click();
      const commits = panel.locator('[data-composer-plus-commits="refs/heads/main"]'); await commits.waitFor({ timeout: 8000 });
      assert.deepEqual(await commits.locator('[data-composer-plus-commit] > span:first-child').allInnerTexts(), ['Release 1.1.0', 'Merge hotfix/payment', 'Initial commit']);
      assert.equal(await panel.locator('[data-composer-plus-tree-back]').innerText(), '← Branch map');
      await panel.locator('[data-composer-plus-tree-back]').click(); await map.waitFor();
      assert.equal(await box('main').getAttribute('aria-current'), 'true', 'back: the box is marked');
      await box('feature/login').click();
      const login = panel.locator('[data-composer-plus-commits="refs/heads/feature/login"]'); await login.waitFor({ timeout: 8000 });
      const sha = git(project, 'rev-parse', 'feature/login').trim();
      await login.locator(`[data-composer-plus-commit="${sha}"]`).click();
      await panel.getByText('src/login.ts', { exact: true }).click();
      await panel.getByText("+  if (!user.email) return 'Enter your email';", { exact: true }).waitFor({ timeout: 8000 });
      assert.equal(await panel.locator('[data-composer-plus-tree-back]').innerText(), '← feature/login');
      await panel.locator('[data-composer-plus-tree-back]').click(); await login.waitFor({ timeout: 2000 });
      assert.equal(await login.locator(`[data-composer-plus-commit="${sha}"]`).getAttribute('aria-current'), 'true', 'back: the commit is marked');
      await panel.locator('[data-composer-plus-tree-back]').click(); await map.waitFor({ timeout: 2000 });
      // 4. Merged → the merge commit's files; Waiting → what the branch brings into develop, with a diff.
      await pill('feature/login').click();
      await panel.locator('[data-composer-plus-detail="merge"]').waitFor({ timeout: 8000 });
      assert.equal(await panel.locator('[data-composer-plus-detail]').innerText(), '✅ feature/login → develop');
      await panel.getByText('src/login.ts', { exact: true }).waitFor({ timeout: 8000 });
      await panel.locator('[data-composer-plus-tree-back]').click(); await map.waitFor({ timeout: 2000 });
      await pill('feature/report').click();
      await panel.locator('[data-composer-plus-detail="pending"]').waitFor({ timeout: 8000 });
      assert.equal(await panel.locator('[data-composer-plus-detail]').innerText(), '⏳ feature/report → develop');
      await panel.getByText('src/report.ts', { exact: true }).click();
      await panel.getByText("+  return orders.length + ' orders';", { exact: true }).waitFor({ timeout: 8000 });
      assert.equal(await panel.locator('[data-composer-plus-ws]').count(), 1, 'a diff: the whitespace switch shows');
      await panel.locator('[data-composer-plus-tree-back]').click(); await map.waitFor({ timeout: 2000 });
      assert.equal(await box('feature/report').getAttribute('aria-current'), 'true');
      // Low page: ← marks the box that was open, in view.
      await page.setViewportSize({ width: 1280, height: 300 }); await pause(300);
      await box('main').click(); await commits.waitFor({ timeout: 8000 });
      await panel.locator('[data-composer-plus-tree-back]').click(); await map.waitFor({ timeout: 2000 });
      const view = await inView('[data-composer-plus-branch="refs/heads/main"]');
      assert.ok(view.scrollable, 'the map scrolls at this height'); assert.equal(view.inside, true, 'back: the box is in view');
      await page.setViewportSize({ width: 1280, height: 800 }); await pause(300);
      // 5. A branch that is deleted while it is open (the map refreshes every 15 s; ⟳ asks at once).
      git(project, 'branch', 'gone-soon', 'feature/report');
      await panel.getByRole('button', { name: 'Refresh' }).click();
      await box('gone-soon').waitFor({ timeout: 8000 });
      await box('gone-soon').click(); await panel.locator('[data-composer-plus-commits="refs/heads/gone-soon"]').waitFor({ timeout: 8000 });
      git(project, 'branch', '-D', 'gone-soon');
      await panel.getByRole('button', { name: 'Refresh' }).click();
      await panel.getByText('This branch no longer exists.', { exact: true }).waitFor({ timeout: 8000 });
      await panel.locator('[data-composer-plus-tree-back]').click(); await map.waitFor({ timeout: 2000 });
      await box('gone-soon').waitFor({ state: 'detached', timeout: 8000 });
      // 6. The mode menu: Tree first; Uncommitted leaves it; the branch chip goes back to the map.
      await panel.getByRole('button', { name: /^Tree/ }).first().click();
      const items = await page.locator('[role^="menuitem"]').allInnerTexts();
      assert.equal(items[0].trim(), 'Tree', 'Tree is the first item');
      await page.getByText('Uncommitted', { exact: true }).last().click();
      await map.waitFor({ state: 'detached', timeout: 5000 });
      await panel.getByText('README.md', { exact: true }).waitFor({ timeout: 8000 });
      await chip.click(); await map.waitFor({ timeout: 8000 });
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
      console.log(`PASS ${bin}: opens on the branch map (6 boxes, counts, colors, rows, arrows, legend) → cards filter → box → commits → files → diff → back marks → Merged → merge commit → Waiting → pending files + diff → in view on a low page → deleted branch note → menu Tree first / Uncommitted / chip → git state unchanged → switch off/on`);
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
