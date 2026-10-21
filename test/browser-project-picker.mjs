// Isolated real-app check of "Project search in a new chat": dsh's new chat project menu gets a search box, shows the
// projects A–Z, filters them, picks with Enter, a click and the keys, and keeps dsh's own "Add workspace…" footer.
// No model, never the normal DSH_HOME.
// PLAYWRIGHT=/path/to/playwright node test/browser-project-picker.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/projectPicker.webp (English UI, demo projects only). TR_SHOT=<dir> keeps a Turkish picture.
// EXTRA=/path/to/pluginA,... loads those plugin folders too; BUNDLES=a,b adds built-in dsh bundles (as a user profile can).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Saved in a mixed order, like a list that grew over time. "weather-cli" is dsh's default project here.
const NAMES = ['weather-cli', 'docs-site', 'acme-web', 'Zeta-tools', 'billing-api', 'mobile-app', 'design-system', 'analytics', 'cli-utils', 'game-jam'];
const AZ = [...NAMES].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-picker-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    const extra = (process.env.EXTRA ?? '').split(',').filter(Boolean).map((dir) => ({ dir, name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name }));
    for (const { dir, name } of extra) { await mkdir(join(profile, 'node_modules', dirname(name)), { recursive: true }); await symlink(dir, join(profile, 'node_modules', name)); }
    const builtins = (process.env.BUNDLES ?? '').split(',').filter(Boolean);
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'picker-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...builtins, ...extra.map((e) => e.name), 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    const ids = Object.fromEntries(NAMES.map((name) => [name, randomUUID()]));
    const at = new Date(Date.now() - 3600e3).toISOString();
    for (const name of NAMES) await mkdir(join(home, 'projects', name), { recursive: true });
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: NAMES.map((name) => ids[name]), archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids['weather-cli'] },
      tables: { workspaces: Object.fromEntries(NAMES.map((name) => [ids[name], { path: join(home, 'projects', name), title: name, sessionIds: [], createdAt: at, updatedAt: at }])) },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: join(home, 'projects/weather-cli'), env: { ...process.env, DSH_HOME: home, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const contexts = []; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      const ready = async (page) => {
        for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
          const button = page.getByRole('button', { name });
          if (await button.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await button.click(); await button.waitFor({ state: 'hidden' }); }
        }
        const close = page.getByRole('dialog', { name: /^(Get started|Başlayın)$/ }).getByRole('button', { name: /^(Close|Kapat)$/ });
        if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
        await page.locator('[data-row-key^="workspace:"]').first().waitFor();
      };
      const open = async (locale) => {
        const context = await browser.newContext({ locale, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' }); contexts.push(context);
        await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
        const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url); await ready(page);
        return page;
      };
      // The new chat screen: dsh's "New session" button in the sidebar header, or a project's own "New session".
      const newChat = async (page, label) => {
        const chip = page.locator('[class*="_heroWorkspaceRow"] > button[class*="_workspace"]');
        if (!(await chip.isVisible())) await page.getByRole('button', { name: label, exact: true }).first().click();
        await chip.waitFor();
        return chip;
      };
      const menu = (page) => page.locator('body > [role="menu"]').last();
      const box = (page) => menu(page).locator('[data-composer-plus-project-search] input');
      const shown = (page) => menu(page).evaluate((list) => [...list.querySelectorAll(':scope > [role="presentation"]:not([data-composer-plus-project-search]) button[role="menuitem"]')]
        .filter((b) => b.offsetParent !== null).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((b) => b.textContent.trim()));
      const openPicker = async (page, chip) => { await chip.click(); await box(page).waitFor(); };
      const chipText = (chip) => chip.textContent().then((s) => s.trim());

      const page = await open('en-US');
      let chip = await newChat(page, 'New session');
      await openPicker(page, chip);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search projects', 'the box has the focus');
      const order = await shown(page);
      assert.deepEqual(order.slice(0, AZ.length), AZ, 'projects A–Z on screen');
      assert.ok(order.includes('Add workspace…') && order.at(-1) === 'Add workspace…', 'dsh\'s footer stays last');
      // The box stays on top while the rows scroll.
      const top0 = (await box(page).boundingBox()).y;
      await menu(page).locator(':scope > [role="presentation"]').nth(1).evaluate((v) => { v.scrollTop = 200; });
      assert.equal((await box(page).boundingBox()).y, top0, 'box does not scroll away');

      // Type: the rows filter at once; the selected project keeps dsh's check.
      await page.keyboard.type('a');
      await page.keyboard.type('pi');
      assert.deepEqual((await shown(page)).filter((n) => n !== 'Add workspace…'), ['billing-api'], 'filtered by part of a name');
      await page.mouse.move(1000, 760); await pause(250);
      if (process.env.SHOT || process.env.KEEP_SHOT) {
        await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
        await page.keyboard.type('a'); await pause(200);
        const area = await menu(page).boundingBox(); const chipBox = await chip.boundingBox();
        const x = Math.max(0, Math.floor(Math.min(area.x, chipBox.x) - 24)); const y = Math.max(0, Math.floor(Math.min(area.y, chipBox.y) - 24));
        const clip = { x, y, width: 640, height: Math.min(800 - y, Math.ceil(Math.max(area.y + area.height, chipBox.y + chipBox.height) - y + 24)) };
        const png = join(home, 'projectPicker.png'); await page.screenshot({ path: png, clip });
        if (process.env.SHOT) execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/projectPicker.webp')]);
        await page.keyboard.press('Backspace'); await page.keyboard.type('api');
      }
      // Enter picks the first match: the chip shows it, the menu closes.
      await page.keyboard.press('Enter');
      await box(page).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('[class*="_heroWorkspaceRow"] > button[class*="_workspace"]')?.textContent.includes('billing-api'));
      assert.equal(await chipText(chip), 'billing-api', 'Enter picked the first match');

      // No match: a notice; Enter picks nothing (not "Add workspace…"); Esc clears; the next Esc closes the menu.
      await openPicker(page, chip);
      assert.equal(await box(page).inputValue(), '', 'a new menu starts with an empty box');
      await page.keyboard.type('nothing-here');
      await menu(page).getByText('No matching project', { exact: true }).waitFor();
      await page.keyboard.press('Enter'); await pause(300);
      assert.ok(await box(page).isVisible(), 'menu stays open'); assert.equal(await chipText(chip), 'billing-api');
      assert.equal(await page.getByRole('dialog').count(), 0, 'no Add workspace dialog');
      await page.keyboard.press('Escape');
      assert.equal(await box(page).inputValue(), '', 'Esc clears the box'); assert.ok(await box(page).isVisible(), 'and keeps the menu open');
      await page.keyboard.press('Escape'); await box(page).waitFor({ state: 'detached' });

      // Keys follow the order on screen: ↓ from the box goes to the first project A–Z, ↑ wraps to the footer.
      await openPicker(page, chip);
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), AZ[0], '↓ goes to the first row on screen');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), AZ[1]);
      await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'Add workspace…', 'wraps past the box to the footer');
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), AZ[0]);
      await page.keyboard.type('zet'); // typing on a row goes to the box
      assert.equal(await box(page).inputValue(), 'zet');
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); // dsh's own Enter on a row
      await box(page).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('[class*="_heroWorkspaceRow"] > button[class*="_workspace"]')?.textContent.includes('Zeta-tools'));

      // A click on a filtered row picks it (dsh's own row).
      await openPicker(page, chip);
      await page.keyboard.type('DESIGN');
      await menu(page).getByRole('menuitem', { name: 'design-system', exact: true }).click();
      await box(page).waitFor({ state: 'detached' });
      assert.equal(await chipText(chip), 'design-system');

      // Switch it off in Settings → the menu is dsh's own again (saved order, no box); on again → back.
      await page.evaluate(() => localStorage.setItem('dsh-composer-plus.features', JSON.stringify({ autoUpdate: false, projectPicker: false })));
      await page.reload(); await ready(page); chip = await newChat(page, 'New session');
      await chip.click(); await menu(page).getByRole('menuitem', { name: 'acme-web', exact: true }).waitFor();
      assert.equal(await menu(page).locator('[data-composer-plus-project-search]').count(), 0, 'off: no box');
      assert.deepEqual((await shown(page)).slice(0, NAMES.length), NAMES, 'off: dsh\'s saved order');
      await page.keyboard.press('Escape');
      await page.evaluate(() => localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'));

      // Turkish UI: Turkish label and placeholder.
      const tr = await open('tr-TR');
      const trChip = await newChat(tr, 'Yeni oturum');
      await openPicker(tr, trChip);
      assert.equal(await box(tr).getAttribute('placeholder'), 'Projelerde ara');
      await tr.keyboard.type('xyz'); await menu(tr).getByText('Eşleşen proje yok', { exact: true }).waitFor();
      await tr.keyboard.press('Escape'); await tr.keyboard.type('docs');
      if (process.env.TR_SHOT) { await tr.mouse.move(1000, 760); await pause(250); await tr.screenshot({ path: join(process.env.TR_SHOT, 'projectPicker-tr.png') }); }
      await tr.keyboard.press('Enter'); await box(tr).waitFor({ state: 'detached' });
      assert.equal(await chipText(trChip), 'docs-site');

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: A–Z order, box on top and focused, filter, Enter/click/keys pick, no-match notice, Esc clears then closes, footer kept, switch off restores dsh's menu, Turkish texts, no page errors`);
    } catch (error) {
      const page = contexts.at(-1)?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      for (const context of contexts) await context.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
