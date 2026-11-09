// Real-app check of Remote computers on each dsh given: two throwaway dsh on this Mac, A ("Office Mac") and B ("Studio
// Mac"), each with its own DSH_HOME, a fake model and made-up projects. Never the normal DSH_HOME and no real model.
// The front door of B listens on 127.0.0.1 here (DSH_COMPUTERS_TEST_LOOPBACK=1) in place of a Tailscale address.
// 1. Off by default: no picker, no listener.
// 2. B: Settings → Remote computers on, Let other computers open this Mac on, Create pairing link.
// 3. A: switch on; the picker is in the left sidebar right of the brand, above New session, not in the chat header;
//    Add a computer… asks for a name (This Mac's name is refused), paste, Connect; B shows the request, Approve.
// 4. A: a long turn runs; one other computer: a left click on the picker opens Studio at once (a right-click shows the
//    menu with Add a computer…): B's dsh fills A's window (no new window), with B's chat and the same
//    picker (from A's relay) in the same place, as "Back to this Mac"; no banner. A's turn ends while B shows. One click
//    on it (one computer: no menu): A comes back with the finished turn; Studio again: the same page (no reload).
// 5. B removes A: A's next open shows the relay's text (no picker there): A's own "Back to this Mac" floats in the same
//    place; then the page closes with "pair again". A switches off: nothing stays, the relay closes.
// PLAYWRIGHT=/path/to/playwright node test/browser-computers.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/remoteComputers.webp (English UI, made-up names only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DOOR = Number(process.env.COMPUTERS_PORT ?? 19492);
const listening = (port) => new Promise((resolve) => { const s = createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
const until = async (fn, ms = 15000, what = 'condition') => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); } };
const openSettings = async (page) => {
  const direct = page.getByRole('button', { name: 'Settings', exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
};

const B_CHAT = 'Plan the garden watering schedule';
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const last = JSON.stringify(msgs.at(-1)?.content ?? '');
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = (text) => res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    if (/session title/i.test(last)) return answer(JSON.stringify(msgs).includes('garden') ? 'Garden watering' : 'Recipe search');
    // A turn that runs for some seconds (it must finish while the other Mac shows).
    if (last.includes('long story')) { setTimeout(() => answer('The story ends here.'), 6000); return; }
    answer('Water the beds at 6 am.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

async function startDsh(bin, name, port, projectName) {
  const home = await realpath(await mkdtemp(join(tmpdir(), `dsh-computers-${name}-`)));
  const profile = join(home, 'profiles/web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'computers-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  // The Browser tab (off on web by default) is on, like on desktop.
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: ui-sidebar-browser
  disabled: false
- id: llm-pi-ai
  config:
    providers:
      demo:
        displayName: Demo
        api: openai-completions
        baseURL: http://127.0.0.1:${fakePort}/v1
        apiKeyEnv: DEMO_KEY
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
  const project = join(home, 'projects', projectName); await mkdir(project, { recursive: true });
  const workspaceId = randomUUID(); const now = new Date().toISOString();
  await mkdir(join(home, 'storages'), { recursive: true });
  await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
    tables: { workspaces: { [workspaceId]: { path: project, title: projectName, sessionIds: [], createdAt: now, updatedAt: now } } } }));
  // macName() reads scutil; the test names each Mac through the environment of a fake scutil on PATH.
  const bin2 = join(home, 'bin'); await mkdir(bin2);
  await writeFile(join(bin2, 'scutil'), `#!/bin/sh\necho "${name}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', String(port), '--no-open'], { cwd: project,
    env: { ...process.env, PATH: `${bin2}:${process.env.PATH}`, DSH_HOME: home, DEMO_KEY: 'demo', DSH_COMPUTERS_TEST_LOOPBACK: '1', DSH_COMPUTERS_PORT: String(DOOR),
      DSH_MOBILE_ADMIN_PORT: '0', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh ${name} exited (${child.exitCode}): ${log.slice(-800)}`); await pause(250); }
  const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, `${name}: URL`);
  return { home, url, child, log: () => log, stop: async () => { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); } };
}
async function openPage(context, url, errors) {
  const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
  const close = page.getByRole('dialog', { name: 'Get started' }).getByRole('button', { name: 'Close', exact: true });
  if (await close.waitFor({ timeout: 1500 }).then(() => true, () => false)) await close.click();
  return page;
}
async function setSwitch(page, label, on) {
  // Settings may still be open (a modal): use it; else close what is open and open Settings.
  if (!(await page.locator('[data-composer-plus-settings]').isVisible().catch(() => false))) {
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await pause(150); }
    await openSettings(page);
  }
  const nav = page.getByText('Composer Plus', { exact: true });
  if (await nav.isVisible().catch(() => false)) await nav.click();
  const settings = page.locator('[data-composer-plus-settings]'); await settings.waitFor();
  const toggle = settings.getByRole('switch', { name: label, exact: true });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await until(async () => (await toggle.getAttribute('aria-checked')) === String(on), 10000, `${label} ${on ? 'on' : 'off'}`);
  return settings;
}
const switchOn = (page, label) => setSwitch(page, label, true);

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    if (await listening(DOOR)) throw Error(`port ${DOOR} is in use: set COMPUTERS_PORT`);
    const b = await startDsh(bin, 'Studio Mac', 3241, 'garden-notes');
    const a = await startDsh(bin, 'Office Mac', 3242, 'recipe-box');
    const errors = []; let ctxA, ctxB; let passed = false;
    try {
      ctxA = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: 'light' });
      ctxB = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 820 }, colorScheme: 'light' });
      for (const c of [ctxA, ctxB]) await c.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      await ctxA.grantPermissions(['clipboard-read', 'clipboard-write']);
      // B: one chat of its own.
      const pb = await openPage(ctxB, b.url, errors);
      const inputB = pb.locator('[data-composer-input]'); await inputB.waitFor();
      await inputB.click(); await pb.keyboard.type(B_CHAT); await pb.keyboard.press('Enter');
      await pb.getByText('Water the beds', { exact: false }).first().waitFor({ timeout: 20000 });
      // A: 1. off by default.
      const pa = await openPage(ctxA, a.url, errors);
      await pa.locator('[data-composer-input]').waitFor();
      await pause(1500);
      assert.equal(await pa.locator('[data-composer-plus-computer-picker]').count(), 0, 'off by default: no picker');
      assert.equal(await listening(DOOR), false, 'off by default: no front door');
      // 2. B lets other computers in and makes a link.
      const sb = await switchOn(pb, 'Remote computers');
      const accept = sb.getByRole('switch', { name: 'Let other computers open this Mac', exact: true });
      await accept.click();
      await until(() => listening(DOOR), 15000, 'front door listening');
      await sb.getByRole('button', { name: 'Create pairing link', exact: true }).click();
      const linkBox = sb.getByRole('textbox', { name: 'Pairing link' });
      await linkBox.waitFor();
      const link = await linkBox.inputValue();
      assert.match(link, /^dsh-computer:\/\/pair\?v=1&host=127\.0\.0\.1&port=\d+&fp=[0-9a-f]{64}&code=/);
      // 3. A switches on; the picker is in the sidebar's brand row (right of the brand, above New session).
      await switchOn(pa, 'Remote computers');
      await pa.keyboard.press('Escape');
      const picker = pa.locator('[data-composer-plus-computer-picker]');
      await picker.waitFor({ timeout: 10000 });
      assert.equal((await picker.innerText()).trim(), 'This Mac');
      const place = await pa.evaluate(() => {
        const host = document.querySelector('[data-composer-plus-computer-host]');
        const row = host?.parentElement; const brand = host?.previousElementSibling;
        const ns = document.querySelector('[class*="_newSession"]'); // on dsh web the brand is a "New session" button too
        const name = document.querySelector('[class*="_brandName"]').getBoundingClientRect();
        const p = document.querySelector('[data-composer-plus-computer-picker]').getBoundingClientRect();
        const b = brand.getBoundingClientRect(); const n = ns.getBoundingClientRect();
        return { inRow: /_logoRow/.test(row?.className ?? ''), afterBrand: /_brand/.test(brand?.className ?? ''), right: p.left >= b.right - 1, above: p.bottom <= n.top + 1, brandWhole: name.right <= b.right + 1,
          inHeader: !!document.querySelector('[data-conversation-header-leading] [data-composer-plus-computer-picker]'), region: getComputedStyle(host).getPropertyValue('-webkit-app-region') };
      });
      assert.deepEqual({ ...place, region: undefined }, { inRow: true, afterBrand: true, right: true, above: true, brandWhole: true, inHeader: false, region: undefined }, 'right of the brand, above New session, not in the chat header; the brand is not cut');
      await picker.click();
      await pa.getByRole('menuitem', { name: 'Add a computer…' }).click();
      const dialog = pa.getByRole('dialog').filter({ hasText: 'Add a computer' });
      await dialog.getByRole('textbox', { name: 'Pairing link' }).fill(link);
      const nameBox = dialog.getByRole('textbox', { name: 'Name', exact: true });
      assert.equal(await nameBox.inputValue(), 'Studio Mac', 'the name comes from the link');
      await nameBox.fill('office mac');
      await dialog.getByText('already has this name', { exact: false }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Connect', exact: true }).isDisabled(), true, 'This Mac\'s name: Connect is off');
      await nameBox.fill('Studio');
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      await dialog.getByText('Click Approve on Studio', { exact: false }).waitFor({ timeout: 10000 });
      // B: the request card; Approve.
      const request = sb.locator('[data-composer-plus-computer-request]');
      await request.waitFor({ timeout: 10000 });
      assert.match(await request.innerText(), /Office Mac wants to open this Mac/);
      await request.getByRole('button', { name: 'Approve', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 10000 });
      await sb.getByText('Office Mac can now open this Mac.', { exact: false }).waitFor({ timeout: 10000 });
      // 4. A: a long turn starts, then Studio fills the window.
      const inputA = pa.locator('[data-composer-input]');
      await inputA.click(); await pa.keyboard.type('Write a long story'); await pa.keyboard.press('Enter');
      await pa.locator('[data-row-key^="session:"]').first().waitFor({ timeout: 20000 });
      // One other computer: the picker names it and a click goes there at once; a right-click opens the whole menu.
      assert.equal(await picker.getAttribute('aria-haspopup'), null, 'one other computer: a button, no menu');
      assert.equal(await picker.getAttribute('title'), 'Switch to Studio (right-click for all computers)');
      await picker.click({ button: 'right' });
      if (index === 0 && process.env.SHOT) {
        await pa.getByRole('menuitem', { name: 'Studio' }).waitFor();
        await pause(500);
        const box = await picker.boundingBox();
        const menuBox = await pa.getByRole('menu').boundingBox();
        const clip = { x: 0, y: 0, width: Math.ceil(Math.max(box.x + box.width, menuBox.x + menuBox.width) + 24), height: Math.ceil(menuBox.y + menuBox.height + 24) };
        const png = join(a.home, 'remoteComputers.png'); await pa.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/remoteComputers.webp')]);
      }
      await pa.getByRole('menuitem', { name: 'Add a computer…' }).waitFor({ timeout: 5000 });
      await pa.keyboard.press('Escape'); await pa.getByRole('menu').waitFor({ state: 'hidden', timeout: 5000 });
      const popup = ctxA.waitForEvent('page', { timeout: 4000 }).catch(() => null);
      await picker.click();
      assert.equal(await pa.getByRole('menu').count(), 0, 'the left click opened no menu');
      const view = pa.locator('iframe[data-composer-plus-computer-view]');
      await view.waitFor({ timeout: 15000 });
      assert.equal(await popup, null, 'no new window');
      const box = await view.boundingBox();
      assert.ok(box.width >= 1270 && box.height >= 760, `the computer fills the window (${box.width}×${box.height})`);
      const remote = pa.frameLocator('iframe[data-composer-plus-computer-view]');
      await remote.getByText('garden-notes', { exact: false }).first().waitFor({ timeout: 30000 });
      await remote.locator('[data-row-key^="session:"]').filter({ hasText: 'Garden watering' }).first().waitFor({ timeout: 15000 });
      // B's page: the same picker (from A's relay) in the same place, as "Back to this Mac"; A's own picker does not float
      // over it, and no banner shows.
      const remotePicker = remote.locator('[data-composer-plus-computer-picker]');
      await remotePicker.waitFor({ timeout: 15000 });
      assert.equal((await remotePicker.innerText()).trim(), 'Back to this Mac');
      assert.equal(await remotePicker.getAttribute('aria-haspopup'), null, 'one computer: a button, no menu');
      await until(async () => (await pa.locator('[data-composer-plus-computer-float]').count()) === 0, 10000, 'no float after B said hello');
      const placeOf = async (frameOrPage) => frameOrPage.locator('[data-composer-plus-computer-host]').evaluate((h) => { const r = h.getBoundingClientRect(); return { right: Math.round(r.right), mid: Math.round(r.top + r.height / 2) }; });
      const aPlace = await placeOf(pa); const bPlace = await placeOf(remote);
      assert.ok(Math.abs(aPlace.right - bPlace.right) <= 2 && Math.abs(aPlace.mid - (bPlace.mid + box.y)) <= 2, `B's picker is in the place of A's (${JSON.stringify([aPlace, bPlace, box.y])})`);
      assert.equal(await pa.locator('[data-composer-plus-computer-back]').count(), 0, 'no banner');
      // A's turn ends while B shows.
      await pause(7000);
      await remotePicker.click();
      await view.waitFor({ state: 'hidden', timeout: 10000 });
      assert.equal((await picker.innerText()).trim(), 'This Mac', 'back on A: the picker says This Mac');
      await pa.getByText('The story ends here.', { exact: false }).first().waitFor({ timeout: 5000 });
      // Studio again: the same page, no reload (the marker set in it stays).
      const frame = pa.frames().find((f) => /^http:\/\/127\.0\.0\.1:\d+\//.test(f.url()) && !f.url().startsWith(new URL(a.url).origin));
      await frame.evaluate(() => { window.__kept = 1; });
      await picker.click();
      await view.waitFor({ timeout: 10000 });
      assert.equal(await frame.evaluate(() => window.__kept), 1, 'the hidden page stayed (no reload)');
      const relayPort = Number(new URL(frame.url()).port);
      assert.ok(await listening(relayPort), 'the relay listens');
      await remotePicker.click();
      await view.waitFor({ state: 'hidden', timeout: 10000 });
      // 5. B removes A; A's next open says that it must pair again. Then A switches off.
      await sb.locator('div').filter({ hasText: /^Office Mac/ }).getByRole('button', { name: 'Remove', exact: true }).last().click();
      await sb.getByText('None.', { exact: true }).waitFor({ timeout: 10000 });
      await pa.reload(); await pa.locator('[data-composer-input]').waitFor();
      await picker.click();
      // The relay answers its own text (no hello): A's picker floats over it in the same place as "Back to this Mac"; after
      // some seconds the page closes and the picker says why.
      const floatPicker = pa.locator('[data-composer-plus-computer-float] [data-composer-plus-computer-picker]');
      await floatPicker.waitFor({ timeout: 10000 });
      assert.equal((await floatPicker.innerText()).trim(), 'Back to this Mac');
      { const f = await floatPicker.boundingBox(); assert.ok(Math.abs(f.x + f.width - aPlace.right) <= 2 && Math.abs(f.y + f.height / 2 - aPlace.mid) <= 2, `the float is in the picker's place (${JSON.stringify([f, aPlace])})`); }
      assert.equal(await pa.locator('[data-composer-plus-computer-back]').count(), 0, 'no banner');
      await pa.getByText('That Mac removed this one', { exact: false }).first().waitFor({ timeout: 20000 });
      await until(async () => (await pa.locator('[data-composer-plus-computer-float]').count()) === 0, 5000, 'the float goes with the page');
      await view.waitFor({ state: 'detached', timeout: 10000 });
      // Studio must pair again: no computer to go to, so the click opens the menu, which says so.
      await picker.click();
      await pa.getByRole('menuitem', { name: /pair again/ }).waitFor({ timeout: 10000 });
      await pa.keyboard.press('Escape');
      await setSwitch(pa, 'Remote computers', false);
      await pa.keyboard.press('Escape');
      await until(async () => (await picker.count()) === 0, 10000, 'picker removed');
      assert.equal(await pa.locator('[data-composer-plus-computer-views], [data-composer-plus-computer-host], [data-composer-plus-computer-float]').count(), 0, 'nothing stays');
      await until(async () => !(await listening(relayPort)), 10000, 'relay closed');
      await setSwitch(pb, 'Remote computers', false);
      await until(async () => !(await listening(DOOR)), 10000, 'front door closed');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: off by default; picker right of the brand above New session; name asked (This Mac's refused); Approve on B; one left click on A's picker opens Studio (right-click: the menu), B fills A's window (no window), B's picker says Back to this Mac and switches back with one click (no banner), A's float over a page without a picker, A's turn finished meanwhile, no reload; B removes A → pair again; off leaves nothing`);
    } catch (error) {
      for (const [n, c] of [['a', ctxA], ['b', ctxB]]) { const p = c?.pages().at(-1); if (p) await p.screenshot({ path: join(n === 'a' ? a.home : b.home, 'failed.png') }).catch(() => {}); }
      console.error(`kept for inspection: ${a.home} ${b.home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await ctxA?.close(); await ctxB?.close();
      await writeFile(join(a.home, 'server.log'), a.log()); await writeFile(join(b.home, 'server.log'), b.log());
      await a.stop(); await b.stop();
      if (passed && !process.env.KEEP) { await rm(a.home, { recursive: true, force: true }); await rm(b.home, { recursive: true, force: true }); }
    }
  }
} finally { await browser.close(); fake.close(); }
