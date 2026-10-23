// Isolated real-app check: every feature row in Settings → Composer Plus shows its screenshot thumbnail, and every
// thumbnail image loads from the Host route. No model, never the normal DSH_HOME.
// PLAYWRIGHT=/path/to/playwright node test/browser-settings-shots.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Since 0.2.1-alpha.3 the web app has dsh's account menu (Settings is its first item) in place of the Settings button.
const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
};
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-shots-check-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'shots-check', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3199', '--no-open'], { cwd: home, env: { ...process.env, DSH_HOME: home, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of ['Continue', 'Configure later']) { const b = page.getByRole('button', { name, exact: true }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) await b.click(); }
      // 0.2.1-alpha.3+ opens a "Get started" sign-in dialog instead (no model here): close it.
      const close = page.getByRole('dialog', { name: 'Get started' }).getByRole('button', { name: 'Close', exact: true });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await openSettings(page);
      await page.getByText('Composer Plus', { exact: true }).click();
      const settings = page.locator('[data-composer-plus-settings]'); await settings.waitFor();
      // Every row with a switch (one per feature) also holds a thumbnail; every thumbnail image decodes.
      const report = await settings.evaluate(async (root) => {
        const rows = [...root.querySelectorAll('[role="switch"]')].map((s) => s.parentElement);
        const shots = [...root.querySelectorAll('[data-composer-plus-shot] img')];
        // The thumbnails load lazily: rows below the fold never start. Ask each one to load now, then wait.
        for (const img of shots) img.loading = 'eager';
        await Promise.all(shots.map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
        return {
          rows: rows.length,
          missing: rows.filter((row) => row.querySelector('[data-composer-plus-shot]') === null).map((row) => row.innerText.split('\n')[0]),
          broken: shots.filter((img) => img.naturalWidth === 0).map((img) => img.closest('[data-composer-plus-shot]').getAttribute('data-composer-plus-shot')),
          update: root.querySelector('[data-composer-plus-update] [data-composer-plus-shot]') !== null,
          language: root.querySelector('[data-composer-plus-language] [data-composer-plus-shot]') !== null,
          // "How to use it": each feature row links its README row (English UI → README.md).
          help: rows.map((row) => row.querySelector('[data-composer-plus-help]')).map((a) => a && { id: a.dataset.composerPlusHelp, href: a.href, target: a.target, rel: a.rel, label: a.getAttribute('aria-label') }),
          languageHelp: root.querySelector('[data-composer-plus-language] [data-composer-plus-help="language"]')?.href ?? null,
        };
      });
      assert.equal(report.languageHelp, 'https://github.com/furkancak1r/dsh-composer-plus/blob/main/README.md#feature-language', 'the Application language row has a ? link too');
      assert.ok(report.rows >= 20, `all feature rows rendered (${report.rows})`);
      assert.deepEqual(report.missing, [], 'every feature row has a screenshot');
      assert.deepEqual(report.broken, [], 'every screenshot loads');
      assert.ok(report.update && report.language, 'the update and language rows have one too');
      assert.ok(report.help.every(Boolean), 'every feature row has a ? link');
      for (const h of report.help) {
        assert.equal(h.href, `https://github.com/furkancak1r/dsh-composer-plus/blob/main/README.md#feature-${h.id.toLowerCase()}`, `${h.id}: the link opens its README row`);
        assert.equal(h.target, '_blank'); assert.equal(h.rel, 'noopener noreferrer'); assert.match(h.label, /^How to use it: .+ \(opens the README\)$/);
      }
      // Switch the UI to Türkçe: the links follow it to README.tr.md.
      await page.locator('[data-composer-plus-language] button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Türkçe' }).or(page.getByRole('menuitemradio', { name: 'Türkçe' })).or(page.getByRole('option', { name: 'Türkçe' })).first().click();
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-help="changesPanel"]')?.href.includes('/README.tr.md#feature-changespanel'), null, { timeout: 10000 });
      const trLabel = await page.locator('[data-composer-plus-help="changesPanel"]').getAttribute('aria-label');
      assert.match(trLabel, /^Nasıl kullanılır: .+ \(README’yi açar\)$/, 'the label follows the language too');
      assert.equal(await page.locator('[data-composer-plus-language] [data-composer-plus-help="language"]').getAttribute('href'),
        'https://github.com/furkancak1r/dsh-composer-plus/blob/main/README.tr.md#feature-language', 'the language row follows the language too');
      // Keyboard: the language row's ? link can take the focus (it is a real link with a name).
      await page.locator('[data-composer-plus-language] [data-composer-plus-help="language"]').focus();
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.composerPlusHelp), 'language', 'the ? link takes the keyboard focus');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: ${report.rows} feature rows, each with a loading screenshot and a ? link to its README row (README.md, then README.tr.md in Türkçe); the language row has its ? link too; update and language rows have a screenshot`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); }
