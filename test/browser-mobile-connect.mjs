// Real-app check of Mobile connect (Tether) on each dsh given. Isolated: own DSH_HOME, no model, never the normal profile.
// Default off (no button, no listener) → switch on in Settings → the sidebar-foot button opens the pairing popover →
// a fake phone pairs with the gateway (pinned TLS, approve on the Mac) and calls session/list through it into this dsh →
// switch off → button and ports are gone.
// The phone side needs this Mac's Wi-Fi address (en0). The ports (MOBILE_PORT, MOBILE_ADMIN_PORT; default 19390/19391) must be
// free: pick other ports while the live dsh has Mobile connect on.
// PLAYWRIGHT=/path/to/playwright node test/browser-mobile-connect.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/mobileConnect.webp (English UI, no project or chat data). The picture shows made-up
// addresses and a demo QR code, never this Mac's network data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normFp } from '../tether/gateway/server.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = Number(process.env.MOBILE_PORT ?? 19390), ADMIN = Number(process.env.MOBILE_ADMIN_PORT ?? 19391);
// Since 0.2.1-alpha.3 the web app has dsh's account menu (Settings is its first item) in place of the Settings button.
const settingsLauncher = (page) => page.getByRole('button', { name: /^(Settings|Account menu)$/ });
const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
};
const listening = (port) => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});
const until = async (fn, ms = 15000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); }
};
// The phone: HTTPS that accepts only the pinned certificate (like the iOS app), the request body goes after the pin check.
const phone = (pairing, method, path, body, token) => new Promise((ok, bad) => {
  const req = request({ host: pairing.host, port: pairing.port, method, path, rejectUnauthorized: false, agent: false,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }).on('end', () => ok({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
  });
  req.on('socket', (s) => s.on('secureConnect', () => {
    if (normFp(s.getPeerCertificate().fingerprint256) !== normFp(pairing.fp)) req.destroy(Error('certificate pin mismatch'));
    else req.end(body === undefined ? undefined : JSON.stringify(body));
  }));
  req.on('error', bad);
  req.setTimeout(15000, () => req.destroy(Error(`timeout ${method} ${path}`)));
});

for (const port of [PORT, ADMIN]) if (await listening(port)) throw Error(`port ${port} is in use: set MOBILE_PORT / MOBILE_ADMIN_PORT to free ports`);
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mobile-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'mobile-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    // Notifications and Bonjour stay off; the QR code is drawn (macOS swift) like in normal use.
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3196', '--no-open'], { cwd: home,
      env: { ...process.env, DSH_HOME: home, DSH_MOBILE_PORT: String(PORT), DSH_MOBILE_ADMIN_PORT: String(ADMIN), npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      if (index === 0 && process.env.SHOT) {
        const { SDKROOT, ...env } = process.env; // like the gateway: a stale SDKROOT breaks the swift script
        const demoQr = join(home, 'demo-qr.png');
        execFileSync('swift', [join(repo, 'tether/gateway/qr.swift'), `tether://pair?v=1&host=192.168.1.20&port=19390&fp=${'ab'.repeat(32)}&code=demo&mac=Demo%20Mac`, demoQr], { env });
        // Only the browser's view of the pairing page changes; the checks below talk to the real gateway.
        await context.route(new RegExp(`^http://127\\.0\\.0\\.1:${ADMIN}/`), async (route) => {
          if (new URL(route.request().url()).pathname === '/qr.png') return route.fulfill({ path: demoQr, contentType: 'image/png' });
          const response = await route.fetch();
          if (!(response.headers()['content-type'] ?? '').includes('json')) return route.fulfill({ response });
          const state = await response.json();
          if (state.address) state.address = '192.168.1.20';
          if (state.mac) state.mac = 'Demo Mac';
          for (const p of state.pending ?? []) p.ip = '192.168.1.23';
          return route.fulfill({ response, json: state });
        });
      }
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of ['Continue', 'Configure later']) { const b = page.getByRole('button', { name, exact: true }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) await b.click(); }
      // 0.2.1-alpha.3+ opens a "Get started" sign-in dialog instead (no model here): close it.
      const close = page.getByRole('dialog', { name: 'Get started' }).getByRole('button', { name: 'Close', exact: true });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const button = page.getByRole('button', { name: 'Mobile connect', exact: true });
      await settingsLauncher(page).waitFor();
      await pause(1500);
      assert.equal(await button.count(), 0, 'off by default: no sidebar button');
      assert.equal(await listening(ADMIN), false, 'off by default: no listener');

      // Switch it on in Settings → Composer Plus.
      await openSettings(page);
      await page.getByText('Composer Plus', { exact: true }).click();
      const settings = page.locator('[data-composer-plus-settings]'); await settings.waitFor();
      const toggle = settings.getByRole('switch', { name: 'Mobile connect (iPhone)' });
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await toggle.click();
      await until(async () => (await toggle.getAttribute('aria-checked')) === 'true', 10000, 'switch on');
      await until(() => listening(ADMIN), 15000, 'admin page listening');
      await page.keyboard.press('Escape');
      await button.waitFor({ timeout: 10000 });

      // The popover shows the Tether pairing page with a QR code.
      await button.click();
      const panel = page.getByRole('dialog', { name: 'Mobile connect · Tether' }); await panel.waitFor();
      const frame = page.frameLocator('iframe.dshm-frame');
      await frame.locator('#qr:not([hidden])').waitFor({ timeout: 20000 });
      await until(async () => /Ready/.test(await frame.locator('#status').innerText()), 20000, 'gateway connected to dsh (status "Ready")');

      // A fake phone pairs and calls dsh through the gateway.
      const admin = (path, body) => fetch(`http://127.0.0.1:${ADMIN}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'x-dsh-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      const state = await until(async () => { const s = await admin('/state'); return s.code ? s : null; }, 10000, 'pairing code');
      // The QR text is a tether://pair link (the iPhone Camera opens it in Tether).
      assert.match(state.code.payload, /^tether:\/\/pair\?/);
      const pairing = Object.fromEntries(new URL(state.code.payload).searchParams); pairing.port = Number(pairing.port);
      assert.equal((await phone(pairing, 'GET', '/me', undefined, undefined).catch(() => ({ status: 0 }))).status, 401, 'no token: refused');
      const paired = phone(pairing, 'POST', '/pair', { code: pairing.code, name: 'Test iPhone' });
      const pending = await until(async () => (await admin('/state')).pending[0], 10000, 'pairing request');
      if (index === 0 && process.env.SHOT) {
        // The request card takes the QR code's place, the way a user sees it in dsh.
        await frame.locator('#req:not([hidden])').waitFor();
        assert.match(await frame.locator('#req-who').innerText(), /Test iPhone wants to connect/);
        await page.mouse.move(640, 200); await pause(800);
        const box = await panel.boundingBox();
        const foot = await button.boundingBox();
        const clip = { x: 0, y: Math.max(0, box.y - 16), width: Math.ceil(box.x + box.width + 14), height: Math.ceil(foot.y + foot.height + 12 - Math.max(0, box.y - 16)) };
        const png = join(home, 'mobileConnect.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/mobileConnect.webp')]);
      }
      await admin('/approve', { id: pending.id });
      await frame.locator('#note').getByText('Test iPhone is connected.').waitFor({ timeout: 10000 }); // the outcome stays on the page
      const { status, json: device } = await paired;
      assert.equal(status, 200); assert.match(device.token, /^[A-Za-z0-9_-]{43}$/);
      const me = await until(async () => { const r = (await phone(pairing, 'GET', '/me', undefined, device.token)).json; return r.upstream === 'connected' ? r : null; }, 15000, 'upstream connected');
      assert.equal(me.name, 'Test iPhone');
      const list = await phone(pairing, 'POST', '/api/session/list', { type: 'client-request', rpcId: 'e2e-1', method: 'session/list', payload: { args: { _request: {} } } }, device.token);
      assert.equal(list.status, 200, JSON.stringify(list.json)); assert.equal(list.json.result?.ok, true, JSON.stringify(list.json.result?.error));
      assert.equal((await phone(pairing, 'POST', '/api/host/shutdown', { type: 'client-request', rpcId: 'x', method: 'host/shutdown', payload: { args: {} } }, device.token)).status, 403, 'allowlist');
      await frame.locator('#devices').getByText('Test iPhone').waitFor({ timeout: 10000 }); // the page polls every second
      await frame.locator('#devices').getByText(/Paired /).waitFor();

      // Access log: the pairing and the phone's connection (from this Mac's Wi-Fi address) show with the device name.
      await frame.locator('#log summary').click();
      await until(async () => /Allowed · Wi‑Fi/.test(await frame.locator('#log-table').innerText()), 10000, 'allowed Wi-Fi entry in the log');
      assert.match(await frame.locator('#log-table').innerText(), new RegExp(`${pairing.host.replace(/\./g, '\\.')} · Test iPhone`));

      // Tailscale only: the LAN phone is refused at once and the log says why; off lets it in again.
      const tailnetOnly = frame.getByRole('checkbox', { name: /Tailscale only/ });
      assert.equal(await tailnetOnly.isChecked(), false, 'off by default');
      await tailnetOnly.check();
      await until(async () => (await admin('/state')).tailnetOnly === true, 10000, 'Tailscale only saved');
      await assert.rejects(phone(pairing, 'GET', '/me', undefined, device.token), 'a LAN phone cannot connect');
      await until(async () => /Refused · Tailscale only/.test(await frame.locator('#log-table').innerText()), 10000, 'refused entry in the log');
      assert.match(await frame.locator('#log-sum').innerText(), /refused in the last 24 hours/);
      // PANEL_SHOT=<file.png>: a picture of the panel for a visual check (it shows this Mac's address: keep it local).
      if (process.env.PANEL_SHOT && index === 0) await panel.screenshot({ path: process.env.PANEL_SHOT });
      await tailnetOnly.uncheck();
      await until(async () => (await admin('/state')).tailnetOnly === false, 10000, 'Tailscale only off');
      assert.equal((await phone(pairing, 'GET', '/me', undefined, device.token)).status, 200, 'the LAN phone connects again');

      // Remove: one click, no dialog; the phone's key stops working at once.
      let dialogs = 0; page.on('dialog', (d) => { dialogs++; d.dismiss(); });
      await frame.getByRole('button', { name: 'Remove Test iPhone' }).click();
      await frame.locator('#note').getByText('Test iPhone was removed. It must pair again to connect.').waitFor({ timeout: 10000 });
      assert.equal(dialogs, 0, 'Remove asks nothing');
      assert.equal((await phone(pairing, 'GET', '/me', undefined, device.token)).status, 401, 'the removed phone cannot connect');
      await frame.locator('#devices').getByText('No iPhone yet.').waitFor({ timeout: 10000 });

      // Switch off: the button goes, the ports close, the phone can no longer reach dsh.
      await page.keyboard.press('Escape');
      await openSettings(page);
      await page.getByText('Composer Plus', { exact: true }).click();
      await settings.waitFor();
      await toggle.click();
      await until(async () => (await toggle.getAttribute('aria-checked')) === 'false', 10000, 'switch off');
      await until(async () => !(await listening(ADMIN)), 10000, 'admin page closed');
      await page.keyboard.press('Escape');
      await until(async () => (await button.count()) === 0, 10000, 'button removed');
      await assert.rejects(phone(pairing, 'GET', '/me', undefined, undefined), 'the phone port is closed');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: off by default, switch on, popover with QR + "Ready", fake iPhone paired and called session/list through the gateway, allowlist 403, access log, Tailscale only refuses and lets in again, one-click Remove → 401, switch off closes everything`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
