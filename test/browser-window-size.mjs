// Real-app check of "Remember window size" (windowSize) on each dsh given: throwaway DSH_HOME, no model, headless.
// dsh's web page is a browser tab (http:), not the desktop app (dsh-app:), so the feature must do nothing there:
// 1. Settings → Composer Plus has the "Remember window size" row with its screenshot, switched on by default.
// 2. In the tab, the plugin does not move the window, reads it on no timer and writes no window size, also when a
//    saved size is in the storage.
// 3. Switch off and on: no page error, no stored size.
// The desktop half (save after a resize, restore at the next start, a place off the screen) is checked in a hidden
// Electron 44 window with the real installWindowSize: test/electron-window-size.cjs.
// PLAYWRIGHT=/path/to/playwright node test/browser-window-size.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/windowSize.webp (English UI, made-up sizes only; needs cwebp).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY = 'dsh-composer-plus.windowSize';
const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
};
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true });
let shotDone = false;
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-window-size-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'window-size-check', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3197', '--no-open'], { cwd: home, env: { ...process.env, DSH_HOME: home, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
      // A saved size from an earlier desktop start, and spies on the window calls the feature could make.
      await context.addInitScript((key) => {
        localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}');
        localStorage.setItem(key, '{"x":40,"y":40,"w":1500,"h":900}');
        window.__calls = [];
        for (const name of ['moveTo', 'resizeTo']) { const real = window[name]; window[name] = (...a) => { window.__calls.push([name, ...a]); return real.apply(window, a); }; }
      }, KEY);
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of ['Continue', 'Configure later']) { const b = page.getByRole('button', { name, exact: true }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) await b.click(); }
      const close = page.getByRole('dialog', { name: 'Get started' }).getByRole('button', { name: 'Close', exact: true });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await openSettings(page);
      await page.getByText('Composer Plus', { exact: true }).click();
      const settings = page.locator('[data-composer-plus-settings]'); await settings.waitFor();
      // 1. The row, its screenshot and its switch (on).
      const sw = settings.getByRole('switch', { name: 'Remember window size' }); await sw.waitFor();
      const row = sw.locator('xpath=..');
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      assert.equal(await row.locator('[data-composer-plus-shot="windowSize"]').count(), 1, 'the row has its screenshot');
      assert.match(await row.innerText(), /desktop app/, 'the row says it is for the desktop app');
      // 2. A browser tab: nothing moves, nothing is written (wait for two timer rounds).
      await pause(2500);
      let state = await page.evaluate((key) => ({ calls: window.__calls, saved: localStorage.getItem(key), protocol: location.protocol }), KEY);
      assert.equal(state.protocol, 'http:');
      assert.deepEqual(state.calls, [], 'a browser tab is not moved or sized');
      assert.equal(state.saved, '{"x":40,"y":40,"w":1500,"h":900}', 'a browser tab writes no window size');
      // 3. Off and on again.
      await sw.click(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh-composer-plus.features') ?? '{}').windowSize === false);
      // An on choice is stored too (true), since 1.29.0 (NATIVE_FEATURES); older copies removed it.
      await sw.click(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh-composer-plus.features') ?? '{}').windowSize !== false);
      await pause(1500);
      state = await page.evaluate(() => ({ calls: window.__calls }));
      assert.deepEqual(state.calls, [], 'switching on in a tab does not move the window');
      if (process.env.SHOT && !shotDone) {
        // The Settings row, and below it the same window at dsh's start size and at the remembered size (made-up numbers).
        await row.scrollIntoViewIfNeeded(); await page.mouse.move(5, 815); await pause(400);
        await page.evaluate(() => {
          const n = document.createElement('div'); n.id = 'demo-window-size';
          const win = (w, h, label, strong) => `<div style="display:flex;flex-direction:column;align-items:center;gap:8px"><div style="width:${w}px;height:${h}px;border-radius:8px;border:1.5px solid ${strong ? '#3964fe' : '#b8bcc6'};background:${strong ? 'rgba(57,100,254,.08)' : '#f4f5f7'};display:flex;align-items:center;justify-content:center;font:12px system-ui;color:#555">${label}</div></div>`;
          n.innerHTML = `<div style="display:flex;align-items:flex-end;gap:28px;justify-content:center">${win(128, 82, '1280 × 820', false)}<div style="font:20px system-ui;color:#888;padding-bottom:30px">→</div>${win(184, 108, '1840 × 1080', true)}</div>`;
          Object.assign(n.style, { padding: '16px 0 4px' });
          const sw = [...document.querySelectorAll('[role="switch"]')].find((s) => s.getAttribute('aria-label') === 'Remember window size' || s.closest('div')?.innerText.includes('Remember window size'));
          sw.parentElement.after(n);
        });
        const box = await row.boundingBox(); const demo = await page.locator('#demo-window-size').boundingBox();
        const clip = { x: box.x - 12, y: box.y - 4, width: box.width + 24, height: demo.y + demo.height - box.y + 12 };
        const png = join(home, 'windowSize.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/windowSize.webp')]);
        await page.evaluate(() => document.getElementById('demo-window-size')?.remove());
        shotDone = true;
      }
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: the Remember window size row has its screenshot and is on; a browser tab is not moved, sized or saved, also after off and on`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); }
