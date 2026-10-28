// Real-app check of Backup, Automatic backup, Session log check and Rescue console on each dsh given. A throwaway
// DSH_HOME with made-up data (demo chat logs, a fake token in the profile patch) and a throwaway backup folder next to it
// (COMPOSER_PLUS_BACKUP_DIR); never the normal DSH_HOME or ~/Desktop/dsh-backups. Headless, English UI.
// 1. Settings → Composer Plus shows the four rows; Automatic backup is off, the others on.
// 2. Back up now → the archive shows with "1 masked"; it is in the folder with its sidecars and the rescue console; the
//    fake token is not in the archive but in the vault; a second click while it runs sends nothing.
// 3. Check → "is OK". For another computer → a transfer folder.
// 4. Session log check: a damaged log is listed; Repair from backups puts back the healthy copy.
// 5. Delete asks first, then removes the archive.
// 6. Automatic backup on → Every/Keep menus and the next time; Rescue console off → its files go, on → they come back.
// 7. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-backup.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/{backup,autoBackup,sessionDoctor,rescueConsole}.webp.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); } };
const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
};
const header = (id) => `${JSON.stringify({ type: 'session', version: 4, id, createdAt: 1793000000000, cwd: '/Users/demo/acme-web', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })}\n`;
const logOf = (id) => Buffer.concat([zlib.zstdCompressSync(Buffer.from(header(id))), zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session/title', seq: 0, time: 1793000000000, data: { title: 'Demo' } })}\n`))]);
const shot = async (page, row, id) => {
  if (!process.env.SHOT) return;
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  const png = join(tmpdir(), `${id}-${process.pid}.png`);
  await page.screenshot({ path: png, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 4), width: Math.min(900, box.width + 16), height: Math.min(560, box.height + 8) } });
  execFileSync('cwebp', ['-quiet', '-q', '78', png, '-o', join(repo, 'assets/features', `${id}.webp`)]);
  await rm(png, { force: true });
  console.log(`shot: assets/features/${id}.webp ${(await stat(join(repo, 'assets/features', `${id}.webp`))).size} bytes`);
};
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-backup-check-')));
    const folder = `${home}-backups`;
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'backup-check', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n# demo values, not real: masked in backups\n# DEMO_API_TOKEN: demo-token-not-real\n');
    for (const id of ['session-demo-ok', 'session-demo-broken']) {
      const dir = join(home, 'sessions', '--Users-demo-acme-web--', id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), logOf(id));
    }
    await writeFile(join(home, 'demo-settings.yml'), 'demo:\n  DEMO_API_TOKEN: demo-token-not-real\n');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3197', '--no-open'], { cwd: home,
      env: { ...process.env, DSH_HOME: home, COMPOSER_PLUS_BACKUP_DIR: folder, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      const close = page.getByRole('dialog', { name: 'Get started' }).getByRole('button', { name: 'Close', exact: true });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await openSettings(page);
      await page.getByText('Composer Plus', { exact: true }).click();
      const settings = page.locator('[data-composer-plus-settings]'); await settings.waitFor();
      const sw = (title) => page.getByRole('switch', { name: title, exact: true });
      // A feature row: the row element that holds the feature's switch and its screenshot.
      const rowOf = (title) => sw(title).locator('xpath=..');
      // 1. Rows and defaults.
      assert.deepEqual(await Promise.all(['Backup', 'Automatic backup', 'Session log check', 'Rescue console'].map((n) => sw(n).isChecked())), [true, false, true, true]);
      // 2. Back up now; a second click while it runs sends nothing.
      let posts = 0; page.on('request', (r) => { if (r.url().endsWith('/api/composer-plus.backup') && r.method() === 'POST' && r.postData()?.includes('"backup"')) posts += 1; });
      const now = page.locator('[data-composer-plus-backup-now]');
      await now.click();
      await now.click({ force: true }).catch(() => {});
      await until(async () => (await page.locator('[data-composer-plus-backup-archive]').count()) === 1, 'the archive in the list');
      assert.equal(posts, 1, 'one backup request');
      await until(async () => /^Backed up: dsh-\d{8}-\d{9}\.tar\.gz \(.+, 1 masked\)\.$/.test(await page.locator('[data-composer-plus-backup-status]').innerText()), 'backup status');
      const files = await readdir(folder);
      const name = files.find((f) => /^dsh-\d{8}-\d{9}\.tar\.gz$/.test(f));
      for (const f of [`${name}.sha256`, `${name}.meta.json`, `${name}.redacted.json`, 'composer-plus-rescue.mjs']) assert.ok(files.includes(f), f);
      assert.ok(!zlib.gunzipSync(await readFile(join(folder, name))).includes('demo-token-not-real'), 'the token is masked in the archive');
      assert.ok((await readFile(join(folder, 'composer-plus-vault', name, 'demo-settings.yml'), 'utf8')).includes('demo-token-not-real'), 'the vault has it');
      await shot(page, rowOf('Backup'), 'backup');
      // 3. Check, For another computer.
      await page.locator(`[data-composer-plus-backup-verify="${name}"]`).click();
      await until(async () => /is OK: \d+ entries/.test(await page.locator('[data-composer-plus-backup-status]').innerText()), 'check result');
      await page.locator(`[data-composer-plus-backup-transfer="${name}"]`).click();
      await until(async () => /Ready: copy .*transfer-/.test(await page.locator('[data-composer-plus-backup-status]').innerText()), 'transfer result');
      assert.ok((await readdir(folder)).some((f) => f.startsWith('transfer-')));
      // 4. Session log check: break one log, check, repair.
      await writeFile(join(home, 'sessions', '--Users-demo-acme-web--', 'session-demo-broken', 'session.v4.jsonl.zstd'), 'not a log');
      await page.locator('[data-composer-plus-doctor-check]').click();
      await until(async () => /2 chat logs checked: 1 damaged\./.test(await page.locator('[data-composer-plus-doctor-result]').innerText().catch(() => '')), 'scan result');
      assert.match(await page.locator('[data-composer-plus-doctor]').innerText(), /session-demo-broken: no zstd frame/);
      await shot(page, rowOf('Session log check'), 'sessionDoctor');
      await page.locator('[data-composer-plus-doctor-repair]').click();
      await until(async () => /Repaired 1\./.test(await page.locator('[data-composer-plus-doctor]').innerText()), 'repair result');
      assert.deepEqual(await readFile(join(home, 'sessions', '--Users-demo-acme-web--', 'session-demo-broken', 'session.v4.jsonl.zstd')), logOf('session-demo-broken'), 'the healthy copy is back');
      // 5. Delete asks first.
      await page.locator(`[data-composer-plus-backup-delete="${name}"]`).click();
      assert.ok(await page.getByText(`Delete ${name}? Its vault copies go too.`).isVisible());
      await page.locator('[data-composer-plus-backup-delete-yes]').click();
      await until(async () => (await page.locator('[data-composer-plus-backup-archive]').count()) === 0, 'deleted');
      assert.ok(!(await readdir(folder)).some((f) => f.startsWith(name)));
      // 6. Automatic backup on: menus and the next time. Rescue console off and on.
      await sw('Automatic backup').click();
      await page.locator('[data-composer-plus-auto-backup="hours"]').waitFor();
      await until(async () => /Next backup:/.test(await rowOf('Automatic backup').innerText()), 'next time');
      await page.locator('[data-composer-plus-auto-backup="keep"]').click();
      await page.getByRole('menuitem', { name: '5 backups' }).or(page.getByRole('menuitemradio', { name: '5 backups' })).first().click();
      await until(async () => JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/auto-backup.json'), 'utf8')).keep === 5, 'keep saved');
      await shot(page, rowOf('Automatic backup'), 'autoBackup');
      await sw('Rescue console').click();
      await until(async () => !(await readdir(folder)).includes('composer-plus-rescue.mjs'), 'console removed');
      await sw('Rescue console').click();
      await until(async () => (await readdir(folder)).includes('composer-plus-rescue.mjs'), 'console back');
      await until(async () => /In the folder: composer-plus-rescue\.mjs/.test(await rowOf('Rescue console').innerText()), 'files shown');
      await shot(page, rowOf('Rescue console'), 'rescueConsole');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: four rows (Automatic backup off), Back up now (one request, token masked, vault copy, console files), Check, For another computer, session log check and repair, Delete with a confirm, Automatic backup menus, Rescue console off/on`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) { await rm(home, { recursive: true, force: true }); await rm(folder, { recursive: true, force: true }); } else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); }
