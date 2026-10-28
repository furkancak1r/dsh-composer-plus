// Isolated real-app check of "Default workspace for New session": with no choice, the global New session (sidebar button,
// ⌘N / Ctrl+N) opens dsh's general folder (made and added as a project at the first use), not the open chat's project;
// with a project chosen in Settings, it opens that project from any chat; a project's own "+" keeps its project; the new
// chat's project button still changes the project; switched off, dsh picks again. No model, never the normal DSH_HOME or
// HOME. PLAYWRIGHT=/path/to/playwright node test/browser-default-workspace.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/defaultWorkspace.webp (English UI, demo projects only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NAMES = ['acme-web', 'docs-site', 'billing-api', 'weather-cli'];
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-defws-')));
    const osHome = join(home, 'os-home'); // the general folder goes under HOME/Documents: never the real one
    const general = join(osHome, 'Documents/deepseek-harness/default-workspace');
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'defws-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    const ids = Object.fromEntries(NAMES.map((name) => [name, randomUUID()]));
    // acme-web is the most recent project: dsh's own New session would open it.
    const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    for (const name of NAMES) await mkdir(join(home, 'projects', name), { recursive: true });
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: NAMES.map((name) => ids[name]), archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: Object.fromEntries(NAMES.map((name, i) => [ids[name], { path: join(home, 'projects', name), title: name, sessionIds: [], createdAt: at(10 + i), updatedAt: at(i) }])) },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3197', '--no-open'], { cwd: join(home, 'projects/weather-cli'),
      env: { ...process.env, DSH_HOME: home, HOME: osHome, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const ready = async () => {
        for (const name of [/^Continue$/, /^Configure later$/]) {
          const button = page.getByRole('button', { name });
          if (await button.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await button.click(); await button.waitFor({ state: 'hidden' }); }
        }
        const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
        if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
        await page.locator('[data-row-key^="workspace:"]').first().waitFor();
      };
      await page.goto(url); await ready();
      const chip = page.locator('[class*="_heroWorkspaceRow"] > button[class*="_workspace"]');
      const chipIs = async (title, why) => {
        await page.waitForFunction((t) => document.querySelector('[class*="_heroWorkspaceRow"] > button[class*="_workspace"]')?.textContent.trim() === t, title, { timeout: 15000 })
          .catch(async () => { throw Error(`${why}: the project button shows "${(await chip.textContent().catch(() => '?'))?.trim()}", not "${title}"`); });
      };
      const sidebarNew = () => page.getByRole('button', { name: 'New session', exact: true }).first().click();
      // A project's own "+" shows on hover; it is in the project row (or next to it, by dsh version).
      const projectNew = async (name) => {
        await page.locator(`[data-row-key="workspace:${ids[name]}"]`).hover();
        await page.getByRole('button', { name: `New session in ${name}`, exact: true }).click();
      };
      const pick = async (name) => { await chip.click(); await page.locator('body > [role="menu"]').last().getByRole('menuitem', { name, exact: true }).click(); };
      const host = (path, body) => page.evaluate(async ([p, b]) => { const r = await fetch(p, b === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.json(); }, [path, body]);

      // 1. No choice: the general folder, made and added as a project. Not acme-web (dsh's most recent project).
      await sidebarNew();
      await chipIs('Default workspace', 'no choice → general folder');
      assert.ok((await stat(general)).isDirectory(), 'the general folder was made under HOME/Documents');
      assert.equal((await host('/api/composer-plus.default-workspace')).general.path, general);

      // 2. A project's own "+" keeps its project; then the global button opens the general folder again, not that project.
      await projectNew('billing-api'); await chipIs('billing-api', 'a project\'s "+"');
      await sidebarNew(); await chipIs('Default workspace', 'global button from a billing-api new chat');
      // 3. The new chat's project button changes the project.
      await pick('docs-site'); await chipIs('docs-site', 'the project button changes it');

      // 4. Settings → choose weather-cli through the picker of the Composer Plus section.
      // Since 0.2.1-alpha.3 the web app has dsh's account menu (Settings is its first item) in place of the Settings button.
      const direct = page.getByRole('button', { name: 'Settings', exact: true });
      if (await direct.isVisible()) await direct.click();
      else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
      await page.getByText('Composer Plus', { exact: true }).click();
      const row = page.locator('[data-composer-plus-default-workspace]');
      await row.scrollIntoViewIfNeeded();
      await row.getByRole('button').click();
      await page.locator('body > [role="menu"]').last().getByRole('menuitem', { name: 'weather-cli', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-default-workspace] button')?.textContent.includes('weather-cli'));
      assert.equal((await host('/api/composer-plus.default-workspace')).workspaceId, ids['weather-cli'], 'saved on the Host');
      if (process.env.SHOT) {
        // The row's text column (not its thumbnail) with the open menu: the general folder first, then the projects A–Z.
        const column = row.locator('xpath=..');
        await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await row.getByRole('button').click();
        const menu = page.locator('body > [role="menu"]').last(); await menu.waitFor();
        await menu.getByRole('menuitem', { name: 'docs-site', exact: true }).hover(); await pause(300);
        const a = await column.boundingBox(); const m = await menu.boundingBox();
        const x = Math.floor(Math.min(a.x, m.x) - 12); const y = Math.floor(Math.min(a.y, m.y) - 10);
        const clip = { x, y, width: Math.ceil(Math.min(Math.max(a.x + a.width, m.x + m.width) - x + 12, 760)), height: Math.ceil(Math.max(a.y + a.height, m.y + m.height) - y + 12) };
        const png = join(home, 'defaultWorkspace.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/defaultWorkspace.webp')]);
        await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' }); // the menu, then Settings below
      }
      await page.keyboard.press('Escape');
      await page.locator('[data-composer-plus-settings]').waitFor({ state: 'detached' });
      // From an acme-web chat screen, the button and the shortcut both open weather-cli.
      await projectNew('acme-web'); await chipIs('acme-web', 'acme-web "+"');
      await sidebarNew(); await chipIs('weather-cli', 'global button → chosen project');
      await projectNew('acme-web'); await chipIs('acme-web', 'acme-web "+" again');
      // dsh's New session shortcut in a browser: primary+Alt+N (the desktop app has primary+N; the browser keeps that one).
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+n' : 'Control+Alt+n');
      await chipIs('weather-cli', 'the New session shortcut → chosen project');

      // 5. Switched off: dsh picks again (the open chat's project).
      assert.equal((await host('/api/composer-plus.default-workspace', { on: false })).on, false);
      await page.reload(); await ready();
      await projectNew('billing-api'); await chipIs('billing-api', 'billing-api "+"');
      await sidebarNew(); await chipIs('billing-api', 'off → dsh keeps the open chat\'s project');
      assert.equal((await host('/api/composer-plus.default-workspace', { on: true })).on, true);

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: general folder made and opened, "+" keeps its project, project button changes it, Settings choice opens from any chat (button and shortcut), switch off gives dsh's choice back, no page errors`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
