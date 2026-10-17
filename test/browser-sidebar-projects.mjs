// Isolated real-app check of the sidebar project features: the recent projects filter, Copy path (right-click) and
// Collapse all projects. No model, never the normal DSH_HOME.
// PLAYWRIGHT=/path/to/playwright node test/browser-sidebar-projects.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/{recentProjects,copyProjectPath,collapseProjects}.webp (English UI, demo projects only).
// TR_SHOT=<dir> keeps the Turkish pictures there.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-sidebar-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'sidebar-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    // acme-web was added now; weather-cli and docs-site 5 hours ago and have no chats, so the filter hides those two.
    const ago = (hours) => new Date(Date.now() - hours * 3600e3).toISOString();
    const projects = [['acme-web', ago(0)], ['weather-cli', ago(5)], ['docs-site', ago(5)]];
    const ids = Object.fromEntries(projects.map(([name]) => [name, randomUUID()]));
    for (const [name] of projects) await mkdir(join(home, 'projects', name), { recursive: true });
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: projects.map(([name]) => ids[name]), archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids['acme-web'] },
      tables: { workspaces: Object.fromEntries(projects.map(([name, at]) => [ids[name], { path: join(home, 'projects', name), title: name, sessionIds: [], createdAt: at, updatedAt: at }])) },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3197', '--no-open'], { cwd: join(home, 'projects/acme-web'), env: { ...process.env, DSH_HOME: home, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const contexts = []; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      // dsh shows its setup dialogs again after every page load (no model is configured here).
      const ready = async (page) => {
        for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
          const button = page.getByRole('button', { name });
          if (await button.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await button.click(); await button.waitFor({ state: 'hidden' }); }
        }
        // 0.2.1-alpha.3+ opens a "Get started" sign-in dialog instead: close it.
        const close = page.getByRole('dialog', { name: /^(Get started|Başlayın)$/ }).getByRole('button', { name: /^(Close|Kapat)$/ });
        if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
        await page.locator('[data-row-key^="workspace:"]').first().waitFor();
      };
      const open = async (locale) => {
        const context = await browser.newContext({ locale, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' }); contexts.push(context);
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
        await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
        const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url); await ready(page);
        return page;
      };
      const row = (page, name) => page.locator(`[data-row-key="workspace:${ids[name]}"]`);
      const shown = async (page) => { const out = []; for (const [name] of projects) if (await row(page, name).isVisible()) out.push(name); return out; };
      const openMenu = async (page, label) => {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.locator('[data-composer-plus-recent-option]').waitFor();
        return page.locator('[role="menu"]');
      };
      const clip = async (list) => { const box = await list.boundingBox(); return { x: 0, y: 0, width: 640, height: Math.min(800, Math.ceil(box.y + box.height + 24)) }; };
      const save = async (page, id, area, trDir) => {
        const png = join(trDir ?? home, `${id}${trDir ? '-tr' : ''}.png`); await page.screenshot({ path: png, clip: area });
        if (process.env.SHOT && !trDir) execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, `assets/features/${id}.webp`)]);
      };
      const top = { x: 0, y: 0, width: 640, height: 420 };
      const openProjects = (page) => page.locator('[data-row-key^="workspace:"][aria-expanded="true"]');
      const collapseButton = (page) => page.locator('[data-composer-plus-collapse-projects] > button');
      /** Copy path: right-click a project row → menu at the pointer → the clipboard holds that project's folder. */
      const copyPath = async (page, name, label) => {
        await page.evaluate(() => navigator.clipboard.writeText('-'));
        await row(page, name).click({ button: 'right' });
        const item = page.getByRole('menuitem', { name: label, exact: true });
        await item.waitFor();
        return item;
      };
      /** Collapse all: open these projects, check the button shows, click it, check all are closed and the button hides. */
      const collapseAll = async (page, names, label) => {
        for (const name of names) if ((await row(page, name).getAttribute('aria-expanded')) !== 'true') await row(page, name).click();
        await collapseButton(page).waitFor();
        assert.equal(await openProjects(page).count(), names.length, `${names.length} projects open`);
        assert.equal(await collapseButton(page).getAttribute('aria-label'), label);
      };

      const page = await open('en-US');
      assert.deepEqual(await shown(page), ['acme-web', 'weather-cli', 'docs-site'], 'off by default: every project shows');
      let list = await openMenu(page, 'View options');
      assert.ok(await list.getByText('Filter projects', { exact: true }).isVisible(), 'section label in the native menu');
      await list.getByRole('menuitem', { name: /^Active in the last 2 hours/ }).click();
      await row(page, 'weather-cli').waitFor({ state: 'hidden' });
      assert.deepEqual(await shown(page), ['acme-web'], 'only the project added in the last 2 hours stays');
      assert.equal(await list.getByRole('menuitem', { name: 'Active in the last 2 hours selected', exact: true }).count(), 1, 'selected state is announced');
      await page.mouse.move(1000, 700); await pause(300);
      const png = join(home, 'recentProjects.png'); await page.screenshot({ path: png, clip: await clip(list) });
      if (process.env.SHOT) execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(640 * 1.25)), '0', png, '-o', join(repo, 'assets/features/recentProjects.webp')]);
      await page.keyboard.press('Escape'); await list.waitFor({ state: 'detached' });
      assert.deepEqual(await shown(page), ['acme-web'], 'closing the menu keeps the filter');

      await page.reload(); await ready(page); await pause(800);
      assert.deepEqual(await shown(page), ['acme-web'], 'the choice survives a reload');
      list = await openMenu(page, 'View options');
      await list.getByRole('menuitem', { name: /^Active in the last 2 hours/ }).click();
      await row(page, 'weather-cli').waitFor();
      assert.deepEqual(await shown(page), ['acme-web', 'weather-cli', 'docs-site'], 'selecting it again shows every project');
      await list.getByRole('menuitem', { name: 'Manual', exact: true }).click(); await list.waitFor({ state: 'detached' }); // native rows still work

      // Copy path: the clipboard holds the real folder; Esc closes the menu; the session/empty area keeps the browser menu.
      let item = await copyPath(page, 'weather-cli', 'Copy path');
      await page.mouse.move(1000, 700); await pause(300);
      await save(page, 'copyProjectPath', top);
      await item.click(); await item.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), join(home, 'projects', 'weather-cli'), 'clipboard holds the project folder');
      item = await copyPath(page, 'docs-site', 'Copy path');
      await page.keyboard.press('Escape'); await item.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '-', 'Esc copies nothing');

      // Collapse all: no open project → no button. 3 projects open → the button shows next to dsh's buttons; one click closes all.
      await page.mouse.move(1000, 700);
      for (const name of ['acme-web', 'weather-cli', 'docs-site']) if ((await row(page, name).getAttribute('aria-expanded')) === 'true') await row(page, name).click();
      await pause(300);
      assert.equal(await collapseButton(page).isVisible(), false, 'hidden while every project is closed');
      await collapseAll(page, ['acme-web', 'weather-cli', 'docs-site'], 'Collapse all projects');
      const header = await page.getByRole('button', { name: 'View options', exact: true }).boundingBox();
      const own = await collapseButton(page).boundingBox(); const add = await page.getByRole('button', { name: 'Add workspace', exact: true }).boundingBox();
      assert.ok(own.x + own.width <= header.x && header.x + header.width <= add.x && Math.abs(own.y - header.y) < 2, 'button sits before View options, same row, nothing clipped');
      await collapseButton(page).hover(); await page.getByText('Collapse all projects', { exact: true }).last().waitFor(); await pause(200);
      await save(page, 'collapseProjects', top);
      await collapseButton(page).click();
      await collapseButton(page).waitFor({ state: 'hidden' });
      assert.equal(await openProjects(page).count(), 0, 'every project is closed');
      await page.reload(); await ready(page); await pause(600);
      assert.equal(await openProjects(page).count(), 0, 'dsh saved the closed state');
      assert.equal(await collapseButton(page).isVisible(), false, 'still hidden after reload');
      // Keyboard: Enter on the button closes all and the focus stays in the header.
      await collapseAll(page, ['weather-cli'], 'Collapse all projects');
      await collapseButton(page).focus(); await page.keyboard.press('Enter');
      await collapseButton(page).waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'View options', 'focus moves to the next header button');

      const tr = await open('tr-TR');
      list = await openMenu(tr, 'Görünüm seçenekleri');
      assert.ok(await list.getByText('Projeleri filtrele', { exact: true }).isVisible(), 'Turkish section label');
      await list.getByRole('menuitem', { name: /^Son 2 saatte aktif olanlar/ }).click();
      await row(tr, 'docs-site').waitFor({ state: 'hidden' });
      assert.deepEqual(await shown(tr), ['acme-web']);
      await tr.mouse.move(1000, 700); await pause(300);
      const trDir = process.env.TR_SHOT ?? home;
      await save(tr, 'recentProjects', await clip(list), trDir);
      await tr.keyboard.press('Escape'); await list.waitFor({ state: 'detached' });
      list = await openMenu(tr, 'Görünüm seçenekleri'); await list.getByRole('menuitem', { name: /^Son 2 saatte aktif olanlar/ }).click(); // show all again
      await tr.keyboard.press('Escape'); await row(tr, 'docs-site').waitFor();
      item = await copyPath(tr, 'docs-site', 'Yolu kopyala');
      await tr.mouse.move(1000, 700); await pause(300); await save(tr, 'copyProjectPath', top, trDir);
      await item.click(); await item.waitFor({ state: 'detached' });
      assert.equal(await tr.evaluate(() => navigator.clipboard.readText()), join(home, 'projects', 'docs-site'));
      await collapseAll(tr, ['acme-web', 'docs-site'], 'Tüm projeleri daralt');
      await collapseButton(tr).hover(); await tr.getByText('Tüm projeleri daralt', { exact: true }).last().waitFor(); await pause(200);
      await save(tr, 'collapseProjects', top, trDir);
      await collapseButton(tr).click(); await collapseButton(tr).waitFor({ state: 'hidden' });
      assert.equal(await openProjects(tr).count(), 0);
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: recent filter (en/tr, reload, deselect), Copy path (clipboard = folder, Esc), Collapse all (hidden when none open, 3 open → 0, saved, keyboard focus), Turkish labels, no page errors`);
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
