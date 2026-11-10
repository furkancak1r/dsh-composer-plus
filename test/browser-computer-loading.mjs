// Real-app check of Remote computers while a computer connects, headless, on each dsh given: a throwaway DSH_HOME with
// the Turkish UI, no model, and one paired computer ("Studio") whose address takes TCP connections but never answers TLS
// (a Mac that sleeps). The relay waits 5 s, then shows its "does not answer" page. Before the fix the window was empty
// (black in a dark theme) for those 5 s and that page was in English.
// 1. One click on Studio: a centered spinner with "Studio cihazına bağlanılıyor…" shows at once and stays during the
//    wait; the picker floats over it and still works (Bu Mac goes back, Studio again shows the spinner again).
// 2. The relay's page replaces the spinner, in Turkish: "Bu bilgisayar Tailscale üzerinden yanıt vermiyor.", the hint
//    and "Tekrar dene".
// 3. With prefers-reduced-motion, the spinner does not turn (dsh's own spinner CSS).
// PLAYWRIGHT=/path/to/playwright node test/browser-computer-loading.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
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
const CONNECTING = 'Studio cihazına bağlanılıyor…';
const UNREACHABLE = 'Bu bilgisayar Tailscale üzerinden yanıt vermiyor.';

// The sleeping computer: it takes each connection and says nothing.
const held = [];
const asleep = createServer((s) => { held.push(s); s.on('error', () => {}); }).listen(0, '127.0.0.1');
await new Promise((r) => asleep.once('listening', r));

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-computer-loading-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'computer-loading-check', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    // Remote computers on, with Studio paired (a made-up token and certificate fingerprint).
    await mkdir(join(home, 'storages/dsh-composer-plus'), { recursive: true });
    await writeFile(join(home, 'storages/dsh-composer-plus/computers.json'), JSON.stringify({ on: true, accept: false,
      list: [{ fp: 'ab'.repeat(32), host: '127.0.0.1', port: asleep.address().port, token: 'x'.repeat(43), deviceId: 'd1', expiresAt: null, label: 'Studio' }] }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3251', '--no-open'], { cwd: home,
      env: { ...process.env, DSH_HOME: home, DSH_COMPUTERS_PORT: '19493', DSH_MOBILE_ADMIN_PORT: '0', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    let context; let passed = false; const errors = [];
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'tr-TR', viewport: { width: 1280, height: 820 }, colorScheme: 'dark' });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) await b.click(); }
      const close = page.getByRole('dialog', { name: /^(Get started|Başlayın)$/ }).getByRole('button', { name: /^(Close|Kapat)$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const picker = page.locator('[data-composer-plus-computer-picker]').first();
      await picker.waitFor({ timeout: 20000 });
      const part = (name) => page.locator('[data-composer-plus-computer-picker]').last().getByRole('button', { name, exact: true });
      const spinner = page.locator('[data-composer-plus-computer-loading]');
      const remote = page.frameLocator('iframe[data-composer-plus-computer-view]');
      const turning = () => spinner.locator('svg[data-state="ongoing"] g').evaluate((g) => getComputedStyle(g).animationName);

      // 1. The click: the spinner at once, in the middle of the window, over the empty page.
      const t0 = Date.now();
      await part('Studio').click();
      await spinner.waitFor({ timeout: 1500 });
      assert.equal((await spinner.innerText()).trim(), CONNECTING, 'the Turkish text');
      assert.equal(await spinner.getAttribute('role'), 'status');
      const box = await spinner.boundingBox();
      assert.ok(box.width >= 1270 && box.height >= 700, `the spinner fills the window (${box.width}×${box.height})`);
      assert.notEqual(await turning(), 'none', 'the spinner turns');
      // The picker floats over the spinner and takes the click.
      const back = part('Bu Mac');
      const onTop = await back.evaluate((b) => { const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
      assert.equal(onTop, true, 'the picker is over the spinner');
      await back.click();
      await spinner.waitFor({ state: 'detached', timeout: 2000 });
      assert.equal(await page.locator('[data-composer-plus-computer-views]').evaluate((r) => r.style.visibility), 'hidden', 'Bu Mac is back');
      await part('Studio').click();
      await spinner.waitFor({ timeout: 1500 });
      // Still connecting after 3 s (the relay waits 5 s): the spinner stays and the page has no text yet.
      await pause(Math.max(0, 3000 - (Date.now() - t0)));
      assert.equal(await spinner.isVisible(), true, 'the spinner stays during the wait');
      assert.equal(await remote.getByText(UNREACHABLE).count(), 0, 'no answer yet');

      // 2. The relay's page replaces the spinner, in Turkish.
      await remote.getByText(UNREACHABLE, { exact: true }).waitFor({ timeout: 15000 });
      const waited = Date.now() - t0;
      await spinner.waitFor({ state: 'detached', timeout: 2000 });
      await remote.getByText('Bilgisayarın uyanık ve Tailscale’in açık olduğundan emin olun.', { exact: true }).waitFor();
      await remote.getByRole('link', { name: 'Tekrar dene', exact: true }).waitFor();
      assert.ok(waited >= 4000, `the page came after the relay's wait (${waited} ms)`);

      // 3. Reduced motion: the next try shows the spinner without motion.
      await pause(1500); // the relay's `failed` event reaches this window: the next pick loads the computer again
      await part('Bu Mac').click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await part('Studio').click();
      await spinner.waitFor({ timeout: 1500 });
      assert.equal(await turning(), 'none', 'no motion with prefers-reduced-motion');
      await remote.getByText(UNREACHABLE, { exact: true }).waitFor({ timeout: 15000 });
      await spinner.waitFor({ state: 'detached', timeout: 2000 });
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS ${bin}: the spinner showed at once with "${CONNECTING}", the picker worked over it, the Turkish page replaced it after ${waited} ms, no motion with reduced motion`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); for (const s of held) s.destroy(); asleep.close(); }
