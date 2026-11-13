// Real-app check of Quote in reply's right-click menu on each dsh given: two throwaway dsh on this Mac, A ("Office Mac")
// and B ("Studio Mac"), each with its own DSH_HOME, a fake model and made-up projects. Never the normal DSH_HOME, no real
// model, no real clipboard (the page's copy command is recorded, not run). Headless.
// 1. This Mac, English, light: a selection in an answer shows no floating button (not Composer Plus's, not dsh 0.2.2's
//    "Quote text"). A right-click on the selection opens the menu at the pointer: Copy, Quote. Copy runs the copy command
//    on the same text. Quote puts the part into the composer; the model gets it as a `> ` quote. A right-click in the
//    composer, with no selection, or beside the selected words in the same message opens no menu of ours (the browser's
//    menu stays). A mouse drag selection and a right-click at once where the drag ended (past the last selected
//    letter) opens our menu, not the browser's Copy.
// 2. Settings → Composer Plus → Application language → Türkçe: the same menu says Kopyala, Alıntıla (no reload).
// 3. The other Mac (Remote computers, B in A's window): its page shows the same menu (English, light).
// 4. A new window in Turkish (tr-TR) and dark: This Mac and the other Mac show Kopyala, Alıntıla on a dark menu.
// 5. Quote in reply off: no menu of ours; dsh 0.2.2's own "Quote text" button shows again. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-quote-menu.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/quoteReply.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DOOR = Number(process.env.COMPUTERS_PORT ?? 19512);
const listening = (port) => new Promise((resolve) => { const s = createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
const until = async (fn, ms = 15000, what = 'condition') => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); } };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');

const ANSWER = 'Water the beds at 6 am. Then check the soil with a finger.';
const PART = 'check the soil with a finger';
const sent = []; // the user's own text of each chat request
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = (text) => res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    const last = textOf(msgs.at(-1)?.content);
    if (/session title/i.test(last)) return answer('Garden watering');
    if (/You predict the next message|You complete the message that the user is typing|long-term memory/.test(JSON.stringify(msgs))) return answer('');
    sent.push(msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t) => !/^(Current runtime context|Time sampled|<system-reminder>)/.test(t)).at(-1) ?? '');
    answer(sent.at(-1).includes('Every day?') ? 'Noted.' : ANSWER);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

async function startDsh(bin, name, port, projectName) {
  const home = await realpath(await mkdtemp(join(tmpdir(), `dsh-quotemenu-${name.split(' ')[0].toLowerCase()}-`)));
  const profile = join(home, 'profiles/web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'quote-menu-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
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
  // macName() reads scutil: a fake scutil on PATH names each Mac.
  const bin2 = join(home, 'bin'); await mkdir(bin2);
  await writeFile(join(bin2, 'scutil'), `#!/bin/sh\necho "${name}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', String(port), '--no-open'], { cwd: project,
    env: { ...process.env, PATH: `${bin2}:${process.env.PATH}`, DSH_HOME: home, DEMO_KEY: 'demo', DSH_COMPUTERS_TEST_LOOPBACK: '1', DSH_COMPUTERS_PORT: String(DOOR),
      DSH_MOBILE_ADMIN_PORT: '0', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh ${name} exited (${child.exitCode}): ${log.slice(-800)}`); await pause(250); }
  const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, `${name}: URL`);
  return { home, url, log: () => log, stop: async () => { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); } };
}
const dismiss = async (page) => {
  for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
  const close = page.getByRole('dialog', { name: /^(Get started|Başlayın)$/ }).getByRole('button', { name: /^(Close|Kapat)$/ });
  if (await close.waitFor({ timeout: 1500 }).then(() => true, () => false)) await close.click();
};
async function openPage(context, url, errors) {
  const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url); await dismiss(page);
  await page.locator('[data-composer-input]').waitFor({ timeout: 20000 });
  return page;
}
async function openSettings(page) {
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await pause(100); }
  const direct = page.getByRole('button', { name: /^(Settings|Ayarlar)$/, exact: true });
  if (await direct.isVisible()) await direct.click();
  else { await page.getByRole('button', { name: /^(Account menu|Hesap menüsü)$/ }).click(); await page.getByRole('menuitem', { name: /^(Settings|Ayarlar)/ }).click(); }
  await page.getByText('Composer Plus', { exact: true }).click();
  const settings = page.locator('[data-composer-plus-settings]'); await settings.waitFor();
  return settings;
}
async function setSwitch(page, label, on) {
  const settings = await openSettings(page);
  const toggle = settings.getByRole('switch', { name: label, exact: true });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await until(async () => (await toggle.getAttribute('aria-checked')) === String(on), 10000, `${label} ${on ? 'on' : 'off'}`);
  return settings;
}
// The copy command of a page is recorded with the text that is selected at that moment, and it does not run.
const RECORD_COPY = () => { const real = document.execCommand.bind(document); document.execCommand = (cmd, ...rest) => { if (cmd !== 'copy') return real(cmd, ...rest); (window.__copied ??= []).push(String(getSelection())); return true; }; };

/** Select `part` in the newest answer of `frame` (a page or a frame); returns the selection's middle in page coordinates. */
async function selectPart(page, frame, part, offset = { x: 0, y: 0 }) {
  const box = await frame.evaluate((part) => {
    const all = [...document.querySelectorAll('[data-conversation-session] [data-chat-flow-kind="assistant-step"]')].filter((el) => el.textContent.includes(part));
    const root = all.at(-1); if (root === undefined) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const i = n.data.indexOf(part); if (i < 0) continue;
      const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + part.length);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      const r = range.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, part);
  assert.ok(box, `the answer holds "${part}"`);
  await page.mouse.move(offset.x + box.x, offset.y + box.y);
  return { x: offset.x + box.x, y: offset.y + box.y };
}
/** The open menu of `frame`: its item labels and whether it is dark (its background) with readable text. */
const menuOf = (frame) => frame.evaluate(() => {
  const menu = [...document.querySelectorAll('[role="menu"]')].find((m) => m.offsetParent !== null || m.getClientRects().length > 0);
  if (menu === undefined) return null;
  const rgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  let bg; for (let el = menu; el !== null; el = el.parentElement) { const c = rgb(getComputedStyle(el).backgroundColor); if (c.length >= 3 && (c[3] ?? 1) > 0.5) { bg = c; break; } }
  const item = menu.querySelector('[role="menuitem"]');
  const fg = rgb(getComputedStyle(item).color);
  const [a, b] = [lum(bg ?? [255, 255, 255]), lum(fg)].sort((x, y) => y - x);
  const r = menu.getBoundingClientRect();
  return { items: [...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent.trim()), dark: lum(bg ?? [255, 255, 255]) < 0.2, contrast: (a + 0.05) / (b + 0.05), left: r.left, top: r.top };
});
const noFloatingButton = (frame) => frame.evaluate(() => document.querySelectorAll('[data-composer-plus-quote], [data-text-interaction-surface] button').length === 0);

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    if (await listening(DOOR)) throw Error(`port ${DOOR} is in use: set COMPUTERS_PORT`);
    sent.length = 0;
    const b = await startDsh(bin, 'Studio Mac', 3261, 'garden-notes');
    const a = await startDsh(bin, 'Office Mac', 3262, 'recipe-box');
    const errors = []; const contexts = []; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      const newContext = async (locale, colorScheme) => {
        const c = await browser.newContext({ locale, colorScheme, viewport: { width: 1280, height: 820 }, deviceScaleFactor: index === 0 && process.env.SHOT ? 2 : 1 });
        await c.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
        await c.addInitScript(RECORD_COPY);
        contexts.push(c); return c;
      };
      const ctxB = await newContext('en-US', 'light');
      const ctxA = await newContext('en-US', 'light');
      // B: one chat with an answer.
      const pb = await openPage(ctxB, b.url, errors);
      await pb.locator('[data-composer-input]').click(); await pb.keyboard.type('Plan the garden watering'); await pb.keyboard.press('Enter');
      await pb.getByText(PART, { exact: false }).first().waitFor({ timeout: 20000 });
      // A: one chat with an answer.
      const pa = await openPage(ctxA, a.url, errors);
      const inputA = pa.locator('[data-composer-input]');
      await inputA.click(); await pa.keyboard.type('How do I water the beds?'); await pa.keyboard.press('Enter');
      await pa.getByText(PART, { exact: false }).first().waitFor({ timeout: 20000 });
      await pause(1500); // the turn settles: dsh 0.2.2 makes a finished answer quotable

      // 1. This Mac, English, light.
      await inputA.click(); await pa.keyboard.type('About the soil:', { delay: 5 });
      let at = await selectPart(pa, pa, PART);
      await pause(700);
      assert.equal(await noFloatingButton(pa), true, 'a selection shows no floating button');
      await pa.mouse.click(at.x, at.y, { button: 'right' });
      await until(() => menuOf(pa), 5000, 'the menu opens');
      let m = await menuOf(pa);
      assert.deepEqual(m.items, ['Copy', 'Quote'], 'English: Copy next to Quote');
      assert.ok(m.dark === false && m.contrast >= 4.5, `light menu, readable (${JSON.stringify(m)})`);
      assert.ok(Math.abs(m.left - at.x) < 40 && Math.abs(m.top - at.y) < 60, `at the pointer (${JSON.stringify([m, at])})`);
      if (index === 0 && process.env.SHOT) {
        const row = await pa.locator('[data-chat-flow-kind="assistant-step"]').filter({ hasText: PART }).last().boundingBox();
        const menuBox = await pa.getByRole('menu').boundingBox();
        const x = Math.max(0, row.x - 16); const y = Math.max(0, row.y - 16);
        const area = { x, y, width: Math.min(1280 - x, Math.max(row.x + row.width, menuBox.x + menuBox.width) - x + 16), height: Math.max(row.y + row.height, menuBox.y + menuBox.height) - y + 16 };
        const png = join(a.home, 'quoteReply.png'); await pa.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/quoteReply.webp')]);
        note(`shot: assets/features/quoteReply.webp ${(await stat(join(repo, 'assets/features/quoteReply.webp'))).size} bytes`);
      }
      await pa.getByRole('menuitem', { name: 'Copy', exact: true }).click();
      await pa.getByRole('menu').waitFor({ state: 'hidden', timeout: 5000 });
      assert.deepEqual(await pa.evaluate(() => window.__copied), [PART], 'Copy: the copy command on the selected part');
      at = await selectPart(pa, pa, PART);
      await pa.mouse.click(at.x, at.y, { button: 'right' });
      await pa.getByRole('menuitem', { name: 'Quote', exact: true }).click();
      await pa.getByRole('menu').waitFor({ state: 'hidden', timeout: 5000 });
      assert.equal(await inputA.evaluate((el) => el.contains(document.activeElement) || el === document.activeElement), true, 'the composer has the focus');
      await pa.keyboard.type('Every day?', { delay: 5 }); await pa.keyboard.press('Enter');
      await until(() => sent.length >= 3, 20000, 'the quote reaches the model');
      assert.ok(sent.at(-1).includes(`> ${PART}`) && sent.at(-1).startsWith('About the soil:') && sent.at(-1).trim().endsWith('Every day?'), `the model gets the quote: ${JSON.stringify(sent.at(-1))}`);
      await pa.getByText('Noted.', { exact: true }).first().waitFor({ timeout: 20000 });
      note(`1: This Mac, en, light: no floating button; right-click → [Copy, Quote] at the pointer; Copy copies "${PART}"; Quote → ${JSON.stringify(sent.at(-1))}`);
      // The browser's menu stays: a right-click in the composer, and with no selection in a message.
      await pa.evaluate(() => getSelection().removeAllRanges());
      await inputA.click({ button: 'right' }); await pause(400);
      assert.equal(await menuOf(pa), null, 'the composer: no menu of ours');
      at = await selectPart(pa, pa, PART); await pa.evaluate(() => getSelection().removeAllRanges());
      await pa.mouse.click(at.x, at.y, { button: 'right' }); await pause(400);
      assert.equal(await menuOf(pa), null, 'no selection: no menu of ours');
      // The same message, beside the selected words ("Water the beds", before the selection): no menu of ours.
      await selectPart(pa, pa, PART);
      const beside = await pa.evaluate(() => { const r = getSelection().getRangeAt(0).getClientRects()[0]; return { x: r.left - 60, y: r.top + r.height / 2 }; });
      await pa.mouse.click(beside.x, beside.y, { button: 'right' }); await pause(400);
      assert.equal(await menuOf(pa), null, 'beside the selection in the same message: no menu of ours');
      await pa.evaluate(() => getSelection().removeAllRanges());
      // A fast right-click where a mouse drag ended (just past the last selected letter, no wait): our menu, not the
      // browser's Copy. The browser keeps the selection there; the pointer is outside the boxes of the selected text.
      const drag = await pa.evaluate((part) => {
        const root = [...document.querySelectorAll('[data-conversation-session] [data-chat-flow-kind="assistant-step"]')].filter((el) => el.textContent.includes(part)).at(-1);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const i = n.data.indexOf(part); if (i < 0) continue;
          const range = document.createRange(); range.setStart(n, i); range.setEnd(n, n.data.length);
          const boxes = [...range.getClientRects()]; const first = boxes[0]; const last = boxes.at(-1);
          return { x0: first.left + 1, y0: (first.top + first.bottom) / 2, x1: last.right + 30, y1: (last.top + last.bottom) / 2 };
        }
        return null;
      }, PART);
      assert.ok(drag, `the answer holds "${PART}"`);
      await pa.mouse.move(drag.x0, drag.y0); await pa.mouse.down(); await pa.mouse.move(drag.x1, drag.y1, { steps: 8 }); await pa.mouse.up();
      assert.ok((await pa.evaluate(() => String(getSelection()))).includes(PART), 'the drag selected the part');
      await pa.mouse.click(drag.x1, drag.y1, { button: 'right' });
      await until(() => menuOf(pa), 5000, 'the menu opens on a fast right-click where the drag ended');
      assert.deepEqual((await menuOf(pa)).items, ['Copy', 'Quote'], 'a fast right-click after a drag: Copy next to Quote');
      await pa.keyboard.press('Escape'); await pa.getByRole('menu').waitFor({ state: 'hidden', timeout: 5000 });
      // The selection stays in the answer; a contextmenu event on the composer (its text position is not in the
      // selection) keeps the browser's menu. A real right-click there would move the selection first.
      await selectPart(pa, pa, PART);
      await inputA.evaluate((el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); });
      await pause(400);
      assert.equal(await menuOf(pa), null, 'a selection in the answer, a right-click on the composer: no menu of ours');
      await pa.evaluate(() => getSelection().removeAllRanges());
      note('1b: a drag selection, then a right-click at once where the drag ended → [Copy, Quote]; on the composer → no menu of ours');

      // 2. Application language → Türkçe: the labels change at once.
      let settings = await openSettings(pa);
      await settings.locator('[data-composer-plus-language] button[aria-haspopup=menu]').click();
      await pa.getByRole('menuitem', { name: 'Türkçe', exact: true }).click();
      await pa.waitForFunction(() => document.documentElement.lang === 'tr');
      for (let i = 0; i < 3; i++) { await pa.keyboard.press('Escape'); await pause(150); }
      at = await selectPart(pa, pa, PART);
      await pa.mouse.click(at.x, at.y, { button: 'right' });
      await until(() => menuOf(pa), 5000, 'the Turkish menu opens');
      assert.deepEqual((await menuOf(pa)).items, ['Kopyala', 'Alıntıla'], 'Türkçe: Kopyala next to Alıntıla');
      await pa.keyboard.press('Escape'); await pa.getByRole('menu').waitFor({ state: 'hidden', timeout: 5000 });
      settings = await openSettings(pa);
      await settings.locator('[data-composer-plus-language] button[aria-haspopup=menu]').click();
      await pa.getByRole('menuitem', { name: 'Sistem dili', exact: true }).click();
      await pa.waitForFunction(() => document.documentElement.lang === 'en');
      note('2: Application language Türkçe → [Kopyala, Alıntıla] without a reload; back to System language');

      // 3. The other Mac: B lets A in; A opens it in its window.
      const sb = await setSwitch(pb, 'Remote computers', true);
      await sb.getByRole('switch', { name: 'Let other computers open this Mac', exact: true }).click();
      await until(() => listening(DOOR), 15000, 'front door listening');
      await sb.getByRole('button', { name: 'Create pairing link', exact: true }).click();
      const link = await sb.getByRole('textbox', { name: 'Pairing link' }).inputValue();
      await setSwitch(pa, 'Remote computers', true);
      for (let i = 0; i < 3; i++) { await pa.keyboard.press('Escape'); await pause(150); }
      const picker = pa.locator('[data-composer-plus-computer-picker]'); await picker.waitFor({ timeout: 10000 });
      await picker.click();
      await pa.getByRole('menuitem', { name: 'Add a computer…' }).click();
      const dialog = pa.getByRole('dialog').filter({ hasText: 'Add a computer' });
      await dialog.getByRole('textbox', { name: 'Pairing link' }).fill(link);
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Studio');
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      const request = sb.locator('[data-composer-plus-computer-request]'); await request.waitFor({ timeout: 10000 });
      await request.getByRole('button', { name: 'Approve', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 10000 });
      /** Open Studio in `page` and check the menu of B's page there. */
      const remoteMenu = async (page, studio, want, dark) => {
        await page.locator('[data-composer-plus-computer-picker]').getByRole('button', { name: studio, exact: true }).click();
        const view = page.locator('iframe[data-composer-plus-computer-view]'); await view.waitFor({ timeout: 15000 });
        const frame = await until(() => page.frames().find((f) => /^http:\/\/127\.0\.0\.1:\d+\//.test(f.url()) && !f.url().startsWith(new URL(a.url).origin)), 15000, 'the relay frame');
        await until(() => frame.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].some((r) => r.textContent.includes('Garden watering'))).catch(() => false), 30000, 'B\'s chat list');
        await frame.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => r.textContent.includes('Garden watering')).querySelector('button, a, [role="button"]')?.click() ?? [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => r.textContent.includes('Garden watering')).click());
        await until(() => frame.evaluate((p) => document.body.innerText.includes(p), PART).catch(() => false), 15000, 'B\'s answer');
        await pause(1000);
        await frame.evaluate(RECORD_COPY);
        const box = await view.boundingBox();
        const p = await selectPart(page, frame, PART, box);
        await pause(500);
        assert.equal(await noFloatingButton(frame), true, 'the other Mac: no floating button');
        await page.mouse.click(p.x, p.y, { button: 'right' });
        await until(() => menuOf(frame), 5000, 'the other Mac\'s menu opens');
        const got = await menuOf(frame);
        assert.deepEqual(got.items, want, `the other Mac: ${want.join(', ')}`);
        assert.ok(got.dark === dark && got.contrast >= 4.5, `the other Mac: ${dark ? 'dark' : 'light'} menu, readable (${JSON.stringify(got)})`);
        // The quote count in B's composer (dsh's quote block, or > lines before dsh 0.2.2) goes up by one.
        const quotes = () => frame.evaluate((p) => [...document.querySelectorAll('[data-composer-seat]')].map((s) => s.innerText.split(p).length - 1).reduce((x, y) => x + y, 0), PART);
        const before = await quotes();
        await frame.getByRole('menuitem', { name: want[1], exact: true }).click();
        await until(async () => (await quotes()) === before + 1, 5000, 'the quote in B\'s composer');
        return frame;
      };
      const frameA = await remoteMenu(pa, 'Studio', ['Copy', 'Quote'], false);
      const remotePicker = pa.frameLocator('iframe[data-composer-plus-computer-view]').locator('[data-composer-plus-computer-picker]');
      await remotePicker.getByRole('button', { name: 'This Mac', exact: true }).click();
      await pa.locator('iframe[data-composer-plus-computer-view]').waitFor({ state: 'hidden', timeout: 10000 });
      assert.ok(frameA, 'B shown in A');
      note('3: the other Mac (en, light): no floating button; [Copy, Quote]; Quote → B\'s composer');

      // 4. A new window in Turkish and dark: This Mac and the other Mac.
      const ctxT = await newContext('tr-TR', 'dark');
      const pt = await openPage(ctxT, a.url, errors);
      await pt.waitForFunction(() => document.documentElement.lang === 'tr');
      await pt.locator('[data-row-key^="session:"]').filter({ hasText: /water|Garden/i }).first().click().catch(() => {});
      await until(() => pt.evaluate((p) => document.body.innerText.includes(p), PART), 15000, 'A\'s answer in the Turkish window');
      at = await selectPart(pt, pt, PART); await pause(500);
      assert.equal(await noFloatingButton(pt), true);
      await pt.mouse.click(at.x, at.y, { button: 'right' });
      await until(() => menuOf(pt), 5000, 'the Turkish dark menu opens');
      m = await menuOf(pt);
      assert.deepEqual(m.items, ['Kopyala', 'Alıntıla']);
      assert.ok(m.dark === true && m.contrast >= 4.5, `dark menu, readable (${JSON.stringify(m)})`);
      await pt.keyboard.press('Escape');
      await remoteMenu(pt, 'Studio', ['Kopyala', 'Alıntıla'], true);
      note('4: tr, dark: This Mac and the other Mac → [Kopyala, Alıntıla] on a dark menu');
      await ctxT.close(); contexts.splice(contexts.indexOf(ctxT), 1);

      // 5. Quote in reply off: no menu of ours; dsh 0.2.2's own button shows again.
      await setSwitch(pa, 'Quote in reply', false);
      for (let i = 0; i < 3; i++) { await pa.keyboard.press('Escape'); await pause(150); }
      at = await selectPart(pa, pa, PART); await pause(800);
      const dshButton = await pa.evaluate(() => document.querySelectorAll('[data-text-interaction-surface] button').length);
      const v022 = await pa.evaluate(() => document.querySelector('[data-text-interaction-source]') !== null);
      assert.equal(dshButton, v022 ? 1 : 0, v022 ? 'off: dsh\'s own "Quote text" button shows again' : 'off: no button (dsh before 0.2.2 has none)');
      await pa.evaluate(() => { const b = document.querySelector('[data-text-interaction-surface] button'); if (b) b.blur(); });
      await pa.mouse.click(at.x, at.y, { button: 'right' }); await pause(500);
      assert.equal(await menuOf(pa), null, 'off: no menu of ours');
      note(`5: off → no menu of ours; ${v022 ? 'dsh\'s own "Quote text" button shows again' : 'no button'}`);
      await setSwitch(pa, 'Remote computers', false); await setSwitch(pb, 'Remote computers', false);

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      for (const c of contexts) { const p = c.pages().at(-1); if (p) await p.screenshot({ path: join(a.home, `failed-${contexts.indexOf(c)}.png`) }).catch(() => {}); }
      console.error(`kept for inspection: ${a.home} ${b.home}; page errors: ${JSON.stringify(errors)}; sent: ${JSON.stringify(sent)}`);
      throw error;
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      await writeFile(join(a.home, 'server.log'), a.log()); await writeFile(join(b.home, 'server.log'), b.log());
      await a.stop(); await b.stop();
      if (passed && !process.env.KEEP) { await rm(a.home, { recursive: true, force: true }); await rm(b.home, { recursive: true, force: true }); }
    }
  }
} finally { await browser.close(); fake.close(); }
