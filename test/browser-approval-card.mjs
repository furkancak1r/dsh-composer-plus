// Real-app check of the Onay card without a button (Furkan, 2026-11-25: "onay butonu gelince görüyorum zaten"). A
// throwaway dsh (scripts/demo-card-stack.mjs: its own DSH_HOME and HOME, a fake model on 127.0.0.1, made-up data),
// headless Chromium with its sandbox, never the user's dsh home.
// 1. The seed: two "Onay:" items and an `onay` block in Damon's last answer: the Onay card with one Onayla, "1 onay".
// 2. A new message of yours: the block has no button now. The two "Onay:" items stay in the Host's list, but the panel
//    shows no Onay card, no note ("… Onayla gelir"), no "onay" in the count bar and no Onay item in the queue.
// PLAYWRIGHT=/path/to/playwright [SHOTS=<folder> PREFIX=<file name start>] [SCHEME=light|dark] [OLD=1] node test/browser-approval-card.mjs <dsh/lib/bin.js>
// SHOTS writes <folder>/<PREFIX>-blok-var.png and <folder>/<PREFIX>-blok-yok.png (the panel). OLD=1: the code before the
// fix (only the picture without the block, no check of step 2).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeModel, demoHome, startDemo, seed, rpcOf } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
const { PLAYWRIGHT, SHOTS, PREFIX = 'onay-karti', SCHEME = 'dark', OLD } = process.env;
if (!PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one dsh CLI entry path');
const { chromium } = require(PLAYWRIGHT);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const calls = [];
const model = await fakeModel(calls);
const where = await demoHome(model.address().port);
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
let demo; let passed = false;
try {
  demo = await startDemo(process.argv[2], where, 3471);
  const { sessionId } = await seed(demo.url, { model });
  const context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2, colorScheme: SCHEME === 'light' ? 'light' : 'dark' });
  await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
  const page = await context.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(demo.url);
  for (const name of [/^(Continue|Devam)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
    const b = page.getByRole('button', { name });
    if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }).catch(() => {}); }
  }
  await page.keyboard.press('Escape');
  await page.locator('button[aria-label="Damon"]').click();
  const panel = page.locator('[data-composer-plus-todos]');
  await panel.waitFor({ timeout: 30000 });
  for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: 'Gizle', exact: true }).first(); if (!(await hide.waitFor({ timeout: 2000 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
  const onay = panel.locator('[data-card="onay"][role="region"]');
  const counts = panel.locator('[data-composer-plus-counts]');
  const shot = async (name) => {
    if (!SHOTS) return;
    await page.mouse.move(5, 5); await pause(1000);
    const b = await panel.boundingBox(); const path = join(SHOTS, `${PREFIX}-${name}.png`);
    await page.screenshot({ path, clip: { x: b.x - 34, y: Math.max(0, b.y - 12), width: b.width + 68, height: b.height + 24 } });
    console.log(`  ${path}`);
  };
  // 1. The block: the Onay card with its button.
  await onay.locator('[data-composer-plus-approve="card"]').waitFor({ timeout: 20000 });
  assert.equal(await onay.locator('[data-composer-plus-approve="card"]').count(), 1, 'a block: the Onay card with one Onayla');
  assert.match(await counts.innerText(), /^1 onay · /, 'the count bar counts the approval');
  if (!OLD) await shot('blok-var');
  console.log('  1: a block: the Onay card with one Onayla, "1 onay"');
  // 2. A new message of yours: the block has no button now.
  const { rpc, get } = await rpcOf(demo.url);
  await rpc('session/prompt', { request: { requestId: `thanks-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: 'Teşekkürler' }] } });
  await until(() => calls.some((c) => c.newest === 'Teşekkürler'), 'the model got the message');
  await until(async () => (await page.locator('[data-chat-node-key]').filter({ hasText: 'Bu bir demo modelidir' }).count()) > 0, 'the reply');
  await until(async () => (OLD ? /Onayla gelir/.test(await panel.innerText()) : (await onay.count()) === 0), 'the panel after the reply');
  const items = ((await get(`/api/composer-plus.assistant-todos?sessionId=${encodeURIComponent(sessionId)}`)).items ?? []).filter((i) => /^Onay:/.test(i.text));
  assert.equal(items.length, 2, 'the "Onay:" items stay in the Host\'s list');
  await shot('blok-yok');
  if (!OLD) {
    await pause(1500);
    assert.equal(await onay.count(), 0, 'no block: no Onay card');
    assert.doesNotMatch(await panel.innerText(), /Onayla gelir/, 'no note');
    assert.doesNotMatch(await counts.innerText(), /onay/, 'no "onay" in the count bar');
    assert.doesNotMatch(await panel.locator('[data-composer-plus-active]').evaluate((e) => e.textContent), /Onay/, 'no Onay item in the queue');
    console.log('  2: no block: the "Onay:" items stay in the list; no Onay card, no note, no count, no queue item');
  }
  assert.deepEqual(errors, [], 'no page errors');
  await context.close();
  passed = true; console.log('PASS');
} finally {
  if (demo) { demo.child.kill('SIGTERM'); await new Promise((r) => { if (demo.child.exitCode !== null) r(); else demo.child.once('exit', r); }); }
  await browser.close(); model.close();
  if (passed) await rm(where.home, { recursive: true, force: true }); else console.log(`  home kept: ${where.home}\n${(demo?.log ?? '').split('\n').filter((l) => /error|warn/i.test(l)).slice(-15).join('\n')}`);
}
