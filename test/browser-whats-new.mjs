// Isolated real-app check of What's new (Automatic updates): a saved record for the running version shows the release notes
// that ship with it (release-notes.json, from the real Host) once after a start, with the GitHub link; Esc and Close close
// it; the next start shows nothing; an older record goes without a dialog; a newer one (restart pending) stays. A Turkish
// browser (tr-TR) shows the Turkish title and notes (test/update.test.mjs checks a language switch while it is open). No
// model and no GitHub call: the update check route is answered by the test. Never the normal DSH_HOME.
// PLAYWRIGHT=/path/to/playwright node test/browser-whats-new.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version;
const KEY = 'dsh-composer-plus.update.whatsNew';
const shipped = JSON.parse(await readFile(join(repo, 'release-notes.json'), 'utf8')).notes;
/** The dialog's plain text of a Markdown note (headings and bold marks go), as client.js shows it. */
const plain = (text) => text.trim().replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*\n]+)\*\*/g, '$1');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SEEN = 'dsh-composer-plus.update.seen';
// Since 0.2.1-alpha.3 the web app has dsh's account menu (Settings is its first item) in place of the Settings button.
const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
};
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-whats-new-check-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'whats-new-check', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: home, env: { ...process.env, DSH_HOME: home, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      // The start-up update check (15 s) gets an "up to date" answer: no GitHub call, no install.
      const checks = [];
      await context.route((u) => u.pathname.endsWith('/api/composer-plus.update'), async (route) => {
        const q = new URL(route.request().url()).searchParams;
        checks.push(q.get('current') === '1' ? 'current' : 'check');
        if (q.get('current') === '1') return route.continue(); // the real Host answers the running version
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ name: 'dsh-composer-plus', current: version, latest: version, managed: true, newer: false }) });
      });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const dismissStart = async () => {
        for (const name of ['Continue', 'Configure later']) { const b = page.getByRole('button', { name, exact: true }); if (await b.waitFor({ timeout: 1500 }).then(() => true, () => false)) await b.click(); }
        const close = page.getByRole('dialog', { name: 'Get started' }).getByRole('button', { name: 'Close', exact: true });
        if (await close.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      };
      const dialog = page.getByRole('dialog', { name: `What’s new in Composer Plus ${version}` });
      // A record for the running version comes from an install on an older version (seen: 0.0.1); with any other record,
      // this copy already ran the running version (seen: the running version), so only the record decides.
      const startWith = async (record) => {
        const seen = record?.version === version ? '0.0.1' : version;
        await page.evaluate(([k, v, s, sv]) => { if (v === null) localStorage.removeItem(k); else { localStorage.setItem(k, v); localStorage.setItem(s, sv); } }, [KEY, record === null ? null : JSON.stringify(record), SEEN, seen]);
        const before = checks.filter((c) => c === 'current').length;
        await page.reload();
        await dismissStart();
        // Wait until the page asked the Host for its version (only when a record exists), then for the dialog to render.
        for (let i = 0; i < 40 && record !== null && checks.filter((c) => c === 'current').length === before; i++) await pause(250);
        if (record !== null) assert.ok(checks.filter((c) => c === 'current').length > before, 'the page asked the running version');
        await pause(1000);
      };
      const stored = () => page.evaluate((k) => localStorage.getItem(k), KEY);
      await page.goto(url);
      await dismissStart();
      // The first start of a fresh profile only remembers the running version (no window); wait for it before the records.
      await page.waitForFunction((s) => localStorage.getItem(s) !== null, SEEN, { timeout: 15000 });
      assert.equal(await page.getByRole('dialog', { name: /What’s new in Composer Plus/ }).count(), 0, 'a fresh install shows no window');
      const notes = '## Tether\n\n- **New:** a demo note for this check.\n\nSecond paragraph.';
      const link = `https://github.com/furkancak1r/dsh-composer-plus/releases/tag/v${version}`;
      // 1. The running version's record: the dialog shows once, as plain text, with the GitHub link. The real Host gives
      // the notes that ship with this copy: the English ones in an English UI, not the record's saved GitHub text.
      await startWith({ version, notes, url: link });
      await dialog.waitFor({ timeout: 10000 });
      const text = dialog.locator('[data-composer-plus-whats-new]');
      assert.equal((await text.innerText()).trim(), plain(shipped.en), 'the shipped English notes show as plain text');
      assert.equal(await text.getAttribute('lang'), 'en');
      assert.equal(await dialog.locator('[data-composer-plus-whats-new-link]').getAttribute('href'), link);
      assert.equal(await stored(), null, 'shown once: the record is gone');
      // 2. Esc closes it.
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      // 3. The next start shows nothing.
      await startWith(null); assert.equal(await dialog.count(), 0, 'not shown again');
      // 4. Close closes it.
      await startWith({ version, notes: 'Fixes.', url: link }); await dialog.waitFor({ timeout: 10000 });
      await dialog.locator('[data-composer-plus-whats-new-close]').click(); await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      // 5. An older record (a newer copy already runs): no dialog, the record goes.
      await startWith({ version: '0.0.1', notes: 'Old.' });
      assert.equal(await page.getByRole('dialog', { name: /What’s new in Composer Plus/ }).count(), 0); assert.equal(await stored(), null, 'an older record goes');
      // 6. A newer record (installed, restart pending): no dialog, the record stays for the next start.
      await startWith({ version: '99.0.0', notes: 'Later.' });
      assert.equal(await page.getByRole('dialog', { name: /What’s new in Composer Plus/ }).count(), 0); assert.ok(await stored(), 'a newer record stays');
      // 7. A Turkish browser: the Turkish title and the Turkish notes of the real Host, not the record's English text.
      const trPage = await browser.newContext({ locale: 'tr-TR', viewport: { width: 1280, height: 900 } }).then(async (c) => {
        await c.route((u) => u.pathname.endsWith('/api/composer-plus.update'), async (route) => (new URL(route.request().url()).searchParams.get('current') === '1' ? route.continue()
          : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ name: 'dsh-composer-plus', current: version, latest: version, managed: true, newer: false }) })));
        const p = await c.newPage(); p.on('pageerror', (e) => errors.push(String(e))); return p;
      });
      await trPage.goto(url);
      await trPage.waitForFunction((s) => localStorage.getItem(s) !== null, SEEN, { timeout: 15000 });
      await trPage.evaluate(([k, v, s]) => { localStorage.setItem(k, v); localStorage.setItem(s, '0.0.1'); }, [KEY, JSON.stringify({ version, notes: 'GitHub English.', url: link }), SEEN]);
      await trPage.reload();
      for (const name of ['Devam et', 'Daha sonra yapılandır']) { const b = trPage.getByRole('button', { name, exact: true }); if (await b.waitFor({ timeout: 1500 }).then(() => true, () => false)) await b.click(); }
      const trStart = trPage.getByRole('dialog', { name: /^(Get started|Başlayın)$/ }).getByRole('button', { name: /^(Close|Kapat)$/ });
      if (await trStart.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await trStart.click(); await trStart.waitFor({ state: 'hidden' }); }
      const trDialog = trPage.getByRole('dialog', { name: `Composer Plus ${version} sürümündeki yenilikler` });
      await trDialog.waitFor({ timeout: 15000 });
      const trText = trDialog.locator('[data-composer-plus-whats-new]');
      assert.equal((await trText.innerText()).trim(), plain(shipped.tr), 'the Turkish notes in a Turkish UI');
      assert.equal(await trText.getAttribute('lang'), 'tr');
      assert.equal(await trDialog.locator('[data-composer-plus-whats-new-close]').innerText(), 'Kapat');
      await trDialog.locator('[data-composer-plus-whats-new-close]').click(); await trDialog.waitFor({ state: 'hidden', timeout: 5000 });
      await trPage.context().close();
      // 8. A new version runs (seen: an older version; any install path): the notes show once by themselves, then not again.
      await page.evaluate(([k, s]) => { localStorage.removeItem(k); localStorage.setItem(s, '0.0.1'); }, [KEY, SEEN]);
      await page.reload(); await dismissStart();
      await dialog.waitFor({ timeout: 15000 });
      assert.equal((await dialog.locator('[data-composer-plus-whats-new]').innerText()).trim(), plain(shipped.en), 'the seen path shows the shipped notes');
      assert.equal(await dialog.locator('[data-composer-plus-whats-new-link]').getAttribute('href'), link);
      assert.equal(await page.evaluate((s) => localStorage.getItem(s), SEEN), version, 'the seen version moved on');
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      await startWith(null); assert.equal(await dialog.count(), 0, 'the seen path shows it once');
      // 9. Settings → Composer Plus → Composer Plus updates → What's new in this version: the running version's notes.
      await openSettings(page);
      await page.getByText('Composer Plus', { exact: true }).click();
      const open = page.locator('[data-composer-plus-update] [data-composer-plus-whats-new-open]');
      await open.waitFor({ timeout: 10000 });
      assert.equal(await open.innerText(), 'What’s new in this version'); assert.equal(await open.getAttribute('data-composer-plus-whats-new-open'), version);
      await open.click(); await dialog.waitFor({ timeout: 5000 });
      assert.equal((await dialog.locator('[data-composer-plus-whats-new]').innerText()).trim(), plain(shipped.en), 'the button opens the shipped notes');
      assert.equal(await dialog.locator('[data-composer-plus-whats-new-link]').getAttribute('href'), link);
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      assert.ok(await page.locator('[data-composer-plus-settings]').isVisible(), 'Esc closes only the notes, Settings stays open');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: What's new shows ${version}'s shipped notes once (plain text, GitHub link, English UI: English, tr-TR: Turkish), Esc and Close close it, no repeat, an older record goes, a newer one waits; a new version after any install shows once; Settings → What’s new in this version opens the running notes`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); }
