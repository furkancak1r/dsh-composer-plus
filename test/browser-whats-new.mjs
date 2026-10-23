// Isolated real-app check of What's new (Automatic updates): a saved record for the running version shows its release notes
// once after a start, with the GitHub link; Esc and Close close it; the next start shows nothing; an older record goes
// without a dialog; a newer one (restart pending) stays. No model and no GitHub call: the update check route is answered
// by the test. Never the normal DSH_HOME.
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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch({ channel: 'chrome' });
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
      const startWith = async (record) => {
        await page.evaluate(([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, [KEY, record === null ? null : JSON.stringify(record)]);
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
      const notes = '## Tether\n\n- **New:** a demo note for this check.\n\nSecond paragraph.';
      const link = `https://github.com/furkancak1r/dsh-composer-plus/releases/tag/v${version}`;
      // 1. The running version's record: the dialog shows once, as plain text, with the GitHub link.
      await startWith({ version, notes, url: link });
      await dialog.waitFor({ timeout: 10000 });
      const body = await dialog.locator('[data-composer-plus-whats-new]').innerText();
      assert.equal(body.trim(), 'Tether\n\n- New: a demo note for this check.\n\nSecond paragraph.', 'the notes show as plain text');
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
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: What's new shows ${version}'s notes once (plain text, GitHub link), Esc and Close close it, no repeat, an older record goes, a newer one waits`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); }
