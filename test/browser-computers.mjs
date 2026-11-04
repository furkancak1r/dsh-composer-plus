// Real-app check of Remote computers on each dsh given: two throwaway dsh on this Mac, A ("Office Mac") and B ("Studio
// Mac"), each with its own DSH_HOME, a fake model and made-up projects. Never the normal DSH_HOME and no real model.
// The front door of B listens on 127.0.0.1 here (DSH_COMPUTERS_TEST_LOOPBACK=1) in place of a Tailscale address.
// 1. Off by default: no picker in the chat header, no listener.
// 2. B: Settings → Remote computers on, Let other computers open this Mac on, Create pairing link.
// 3. A: switch on, the picker at the left of the chat title, Add a computer…, paste, Connect; B shows the request, Approve.
// 4. A: pick Studio Mac in the picker: B's dsh opens (in A's Browser tab when this dsh has one, else in a new window) and
//    shows B's own chat; the page has no picker of its own (`via`).
// 5. B removes A: A's next open says that it must pair again. A switches off: the picker goes and the relay port closes.
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
    answer(/session title/i.test(last) ? (JSON.stringify(msgs).includes('garden') ? 'Garden watering' : 'Recipe search') : 'Water the beds at 6 am.');
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
      // 3. A switches on; the picker shows at the left of the chat title; Add a computer…
      await switchOn(pa, 'Remote computers');
      await pa.keyboard.press('Escape');
      const picker = pa.locator('[data-composer-plus-computer-picker]');
      await picker.waitFor({ timeout: 10000 });
      assert.equal((await picker.innerText()).trim(), 'This Mac');
      // The picker sits in the header, left of everything else there, and is not a window drag area.
      const leading = await pa.evaluate(() => { const el = document.querySelector('[data-composer-plus-computer-picker]'); return { inLeading: !!el?.closest('[data-conversation-header-leading]'), region: getComputedStyle(el).webkitAppRegion ?? getComputedStyle(el).getPropertyValue('-webkit-app-region') }; });
      assert.equal(leading.inLeading, true, 'in conversation.header.leading');
      await picker.click();
      await pa.getByRole('menuitem', { name: 'Add a computer…' }).click();
      const dialog = pa.getByRole('dialog').filter({ hasText: 'Add a computer' });
      await dialog.getByRole('textbox', { name: 'Pairing link' }).fill(link);
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      await dialog.getByText('Click Approve on Studio Mac', { exact: false }).waitFor({ timeout: 10000 });
      // B: the request card; Approve.
      const request = sb.locator('[data-composer-plus-computer-request]');
      await request.waitFor({ timeout: 10000 });
      assert.match(await request.innerText(), /Office Mac wants to open this Mac/);
      await request.getByRole('button', { name: 'Approve', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 10000 });
      await sb.getByText('Office Mac can now open this Mac.', { exact: false }).waitFor({ timeout: 10000 });
      // 4. A: start a chat (the Browser tab belongs to a chat), then pick Studio Mac.
      const inputA = pa.locator('[data-composer-input]');
      await inputA.click(); await pa.keyboard.type('Find a soup recipe'); await pa.keyboard.press('Enter');
      await pa.getByText('Water the beds', { exact: false }).first().waitFor({ timeout: 20000 });
      await picker.click();
      if (index === 0 && process.env.SHOT) {
        await pa.getByRole('menuitem', { name: 'Studio Mac' }).waitFor();
        await pause(500);
        const box = await picker.boundingBox();
        const menuBox = await pa.getByRole('menu').boundingBox();
        const clip = { x: Math.max(0, box.x - 260), y: 0, width: 700, height: Math.ceil(menuBox.y + menuBox.height + 24) };
        const png = join(a.home, 'remoteComputers.png'); await pa.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/remoteComputers.webp')]);
      }
      const popup = ctxA.waitForEvent('page', { timeout: 4000 }).catch(() => null);
      await pa.getByRole('menuitem', { name: 'Studio Mac' }).click();
      // In the Browser tab (an iframe on web), else in a new window.
      const win = await popup;
      let remote;
      if (win) { await win.waitForLoadState(); remote = win; }
      else {
        const frame = await until(async () => pa.frames().find((f) => /^http:\/\/127\.0\.0\.1:\d+\//.test(f.url()) && !f.url().startsWith(new URL(a.url).origin)), 15000, 'Browser tab with the computer');
        remote = frame;
      }
      // B's own dsh: its project, and its chat in its sidebar (a narrow tab shows the sidebar as icons: open it then).
      await remote.getByText('garden-notes', { exact: false }).first().waitFor({ timeout: 30000 });
      const chatRow = remote.locator('[data-row-key^="session:"]').filter({ hasText: 'Garden watering' });
      if (!(await chatRow.first().isVisible().catch(() => false))) await remote.getByRole('button', { name: /Open sidebar/ }).first().click().catch(() => {});
      await chatRow.first().waitFor({ timeout: 15000 });
      assert.equal(await remote.locator('[data-composer-plus-computer-picker]').count(), 0, 'no picker inside the other computer\'s page');
      await until(async () => /Studio Mac/.test(await picker.innerText()), 5000, 'the picker names the computer');
      const relayPort = Number(new URL(win ? win.url() : remote.url()).port);
      assert.ok(await listening(relayPort), 'the relay listens');
      // 5. B removes A; A's next open says it must pair again. Then A switches off.
      await sb.locator('div').filter({ hasText: /^Office Mac/ }).getByRole('button', { name: 'Remove', exact: true }).last().click();
      await sb.getByText('None.', { exact: true }).waitFor({ timeout: 10000 });
      if (win) await win.close();
      await picker.click();
      await pa.getByRole('menuitem', { name: 'Studio Mac' }).click();
      // The tab shows the relay's reason, and the picker then marks the computer (its next open is refused).
      await until(async () => { for (const f of pa.frames()) if (/removed this one/.test(await f.locator('body').innerText().catch(() => ''))) return true; return false; }, 20000, 'the tab says that the Mac removed this one');
      await pa.keyboard.press('Escape');
      await picker.click();
      await pa.getByRole('menuitem', { name: /pair again/ }).waitFor({ timeout: 10000 });
      await pa.keyboard.press('Escape');
      await setSwitch(pa, 'Remote computers', false);
      await pa.keyboard.press('Escape');
      await until(async () => (await picker.count()) === 0, 10000, 'picker removed');
      await until(async () => !(await listening(relayPort)), 10000, 'relay closed');
      await setSwitch(pb, 'Remote computers', false);
      await until(async () => !(await listening(DOOR)), 10000, 'front door closed');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: off by default, B accepts + pairing link, A adds with Approve on B, A opens B's dsh (${win ? 'window' : 'Browser tab'}) with B's chat and no nested picker, B removes A, switch off closes the relay and the front door`);
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
