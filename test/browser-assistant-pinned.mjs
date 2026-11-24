// Real-app check that the Damon row always stays in the left sidebar, headless, on each dsh given: a throwaway DSH_HOME
// and HOME, no model, no chat. dsh 0.2.2-rc.2 and later draw an Unpin button at the right end of each panel row except
// Plugins and keep the choice in memory only. Composer Plus hides that button in the Damon row only.
// 1. The Damon row shows, right under Task board. dsh's Unpin button of the Damon row is in the page but not shown
//    (display: none), and it takes no space. Task board keeps its own Unpin button (normal rows stay as dsh made them).
// 2. A real click on the hidden button is not possible: Playwright finds no visible target. A keyboard user cannot reach it:
//    Tab from the Damon row goes past it.
// 3. Task board can still be unpinned and pinned again from More (dsh's own behavior stays for other rows).
// 4. A narrow window (the sidebar as a drawer): the Damon row has no Unpin button there too. The collapsed rail draws none.
// 5. dsh before 0.2.2-rc.2 (no Unpin button): the row shows, nothing else changes. The buttons are found by dsh's own label
//    ("Unpin <name> from sidebar"), so a dsh that renames the class names fails here instead of passing by mistake.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-pinned.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-pinned-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-pinned-check', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3214', '--no-open'], { cwd: home,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const nav = page.getByRole('navigation', { name: 'Global panels' });
      const damon = nav.getByRole('button', { name: 'Damon', exact: true });
      await damon.waitFor({ timeout: 20000 });
      // dsh's own label of the button (`panels.unpin`), not its class names: a renamed class must fail this check.
      const unpinOf = (name) => nav.locator(`button[aria-label="Unpin ${name} from sidebar"]`);
      const order = await nav.locator('button[class*="_panelRow"]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
      assert.equal(order.indexOf('Damon'), order.indexOf('Task board') + 1, `Damon right under Task board: ${order.join(', ')}`);
      const hasPin = (await unpinOf('Task board').count()) > 0;
      const pinVersion = !/^0\.2\.[01]-|^0\.2\.2-rc\.1$/.test(version); // ponytail: the dsh versions that this repo tests
      assert.equal(hasPin, pinVersion, `dsh ${version}: Unpin buttons ${hasPin ? 'found' : 'not found'} (dsh 0.2.2-rc.2 and later draw them)`);
      if (!hasPin) {
        assert.equal(await unpinOf('Damon').count(), 0);
        passed = true;
        console.log(`PASS dsh ${version}: no Unpin buttons in this dsh; the Damon row shows right under Task board`);
        continue;
      }
      // 1. Hover each row: Task board keeps its button (dsh fades it in on hover), Damon's is display: none (no space).
      await nav.getByRole('button', { name: 'Task board', exact: true }).hover(); await pause(300);
      assert.notEqual(await unpinOf('Task board').evaluate((el) => getComputedStyle(el).display), 'none', 'Task board keeps dsh\'s Unpin button (not hidden)');
      await damon.hover(); await pause(300);
      assert.equal(await unpinOf('Damon').count(), 1, 'dsh draws the Damon row\'s Unpin button');
      const shown = await unpinOf('Damon').evaluate((el) => ({ display: getComputedStyle(el).display, width: el.getBoundingClientRect().width }));
      assert.deepEqual(shown, { display: 'none', width: 0 }, `the Damon row's Unpin button is not shown: ${JSON.stringify(shown)}`);
      assert.equal(await unpinOf('Damon').isVisible(), false);
      // 2. No click and no keyboard path to it: Tab from the Damon row goes to the next control, not to its button.
      const clicked = await unpinOf('Damon').click({ timeout: 1500 }).then(() => true, () => false);
      assert.equal(clicked, false, 'the hidden button cannot be clicked');
      await damon.focus(); await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), unpin: /_panelUnpin/.test(document.activeElement?.className ?? '') }));
      assert.ok(!(focused.unpin && /Damon/.test(focused.label ?? '')), `Tab skips the Damon row's Unpin button: ${JSON.stringify(focused)}`);
      assert.equal(await damon.isVisible(), true, 'the Damon row still shows');
      // 3. Normal rows keep dsh's pin behavior: Task board unpins, moves into More, and pins back.
      await nav.getByRole('button', { name: 'Task board', exact: true }).hover();
      await unpinOf('Task board').click();
      await nav.getByRole('button', { name: 'Task board', exact: true }).waitFor({ state: 'detached', timeout: 5000 });
      assert.ok(await damon.isVisible(), 'Damon stays when another row is unpinned');
      await nav.getByRole('button', { name: 'More', exact: true }).click();
      const pin = page.getByRole('menuitem', { name: 'Pin Task board to sidebar', exact: true });
      await pin.waitFor({ timeout: 5000 });
      assert.equal(await page.getByRole('menuitem', { name: 'Pin Damon to sidebar', exact: true }).count(), 0, 'More does not list Damon (it is never unpinned)');
      await pin.click();
      await nav.getByRole('button', { name: 'Task board', exact: true }).waitFor({ timeout: 5000 });
      // 4. A narrow window (below 768 px) shows the sidebar as a drawer with the same wide rows: the same rule applies.
      await page.setViewportSize({ width: 700, height: 800 }); await pause(600);
      const opener = page.locator('[data-sidebar-opener]').first();
      if (!(await damon.isVisible())) { await opener.click(); await damon.waitFor({ timeout: 5000 }); }
      assert.equal(await page.locator('[role="dialog"][data-shortcut-modal="sidebar"]').count(), 1, 'the narrow window shows the sidebar as a drawer');
      assert.equal(await unpinOf('Damon').evaluate((el) => getComputedStyle(el).display), 'none', 'drawer: the Damon row has no Unpin button');
      assert.notEqual(await unpinOf('Task board').evaluate((el) => getComputedStyle(el).display), 'none', 'drawer: Task board keeps its button');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}: the Damon row has no Unpin button (display ${shown.display}, width ${shown.width}; also in the drawer); Task board unpins and pins again from More`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); }
