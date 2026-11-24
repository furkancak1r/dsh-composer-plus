// Real-app check of the summary height handle in the Damon status panel (Furkan, 2026-11-24: "özet çok kısa oluyor
// ayarlanabilir yap"). A throwaway dsh (scripts/demo-card-stack.mjs: its own DSH_HOME and HOME, a fake model on 127.0.0.1,
// made-up data), headless Chromium with its sandbox, never the user's dsh home.
// 1. Get summary: the card shows a long summary at the default height (14vh), its text scrolls inside the card, and a
//    separator (role separator, aria values) is right under the card, over the Onay card.
// 2. A mouse drag on the separator makes the card taller (up to its whole text); the count bar, summary and Onay part grows
//    above the old 40vh cap without a scroll of its own, Onayla stays in view and the panel stays in the chat body.
// 3. A chat switch and a reload keep the height.
// 4. Down/Up change it by one line, a double-click gives the default back, a drag far down stops at the panel's room
//    (Onayla and some cards stay in view).
// SHOTS=<folder> writes 1-default.png, 2-taller.png and 3-after-reload.png (the panel and 34 px around it).
// PLAYWRIGHT=/path/to/playwright node test/browser-summary-resize.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeModel, demoHome, startDemo, seed } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const { SHOTS } = process.env;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const calls = [];
    const model = await fakeModel(calls);
    const where = await demoHome(model.address().port);
    let demo; let context; let page; let passed = false; const errors = [];
    const note = (line) => console.log(`  ${line}`);
    try {
      demo = await startDemo(bin, where, 3460 + index);
      const { sessionId } = await seed(demo.url, { model });
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(demo.url);
      for (const name of [/^(Continue|Devam)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }).catch(() => {}); }
      }
      await page.keyboard.press('Escape');
      const openDamon = async () => { await page.locator('button[aria-label="Damon"]').click(); await stack.waitFor({ timeout: 30000 }); };
      const stack = page.locator('[data-composer-plus-todos]');
      await openDamon();
      for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: 'Gizle', exact: true }).first(); if (!(await hide.waitFor({ timeout: 2000 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
      await stack.locator('[data-composer-plus-approve="card"]').waitFor({ timeout: 20000 });
      // 1. Get summary → the long summary at the default height.
      await stack.getByRole('button', { name: 'Özet getir', exact: true }).click();
      const card = stack.locator('.cp-st-summary'); const grip = stack.locator('[data-composer-plus-summary-grip]');
      await until(async () => (await card.innerText().catch(() => '')).includes('Ürün filtresi'), 'the long summary in the card', 60000);
      assert.ok(calls.some((c) => c.newest === 'Örnek verileri yükle'), 'the demo model answered');
      await page.mouse.move(5, 5); await pause(800);
      const geo = () => page.evaluate(() => {
        const root = document.querySelector('[data-composer-plus-todos]'); const r = (el) => el?.getBoundingClientRect();
        const c = root.querySelector('.cp-st-summary'); const g = root.querySelector('[data-composer-plus-summary-grip]'); const onay = root.querySelector('[data-card="onay"][role="region"]');
        const approve = root.querySelector('[data-composer-plus-approve="card"]'); const body = root.querySelector('.cp-st-body'); const chat = root.parentElement;
        return { card: r(c).height, cardScroll: c.scrollHeight, cardBottom: r(c).bottom, gripTop: r(g).top, gripBottom: r(g).bottom, onayTop: r(onay)?.top,
          approveBottom: r(approve)?.bottom, panelTop: r(root).top, panelBottom: r(root).bottom, chatBottom: r(chat).bottom, body: r(body)?.height ?? 0,
          fixed: r(root.querySelector('.cp-cs-fixed')).height, fixedScroll: root.querySelector('.cp-cs-fixed').scrollHeight,
          now: Number(g.getAttribute('aria-valuenow')), min: Number(g.getAttribute('aria-valuemin')), max: Number(g.getAttribute('aria-valuemax')), win: innerHeight,
          saved: localStorage.getItem('dsh-composer-plus.status-summary-height') };
      });
      let g0 = await geo();
      assert.equal(await grip.getAttribute('role'), 'separator'); assert.equal(await grip.getAttribute('aria-orientation'), 'horizontal');
      assert.equal(g0.saved, null, 'nothing saved yet');
      assert.ok(Math.abs(g0.card - Math.round(g0.win * 0.14)) <= 1, `the default height is 14vh (${g0.card} in ${g0.win})`);
      assert.ok(g0.cardScroll > g0.card + 20, `the long text scrolls inside the card (${g0.cardScroll} > ${g0.card})`);
      assert.ok(g0.gripTop >= g0.cardBottom - 1 && g0.onayTop >= g0.gripBottom - 1, `the separator is between the card and the Onay card (${JSON.stringify(g0)})`);
      assert.equal(g0.min, 92); assert.ok(g0.max > g0.now, `room to grow (${g0.now} < ${g0.max})`);
      if (SHOTS) { const b = await stack.boundingBox(); await page.screenshot({ path: join(SHOTS, '1-default.png'), clip: { x: b.x - 34, y: Math.max(0, b.y - 12), width: b.width + 68, height: b.height + 24 } }); }
      note(`1: the default height ${g0.card} px (14vh), the text scrolls (${g0.cardScroll} px), the separator under the card`);
      // 2. A drag down with the mouse: the card follows; the panel takes the room under it; Onayla stays in view.
      const gb = await grip.boundingBox();
      await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2); await page.mouse.down();
      for (let i = 1; i <= 5; i++) await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2 + i * 20);
      await page.mouse.up(); await page.mouse.move(5, 5); await pause(500);
      const g1 = await geo();
      assert.ok(Math.abs(g1.card - (g0.card + 100)) <= 2, `the card follows the mouse (${g0.card} → ${g1.card})`);
      assert.equal(Number(g1.saved), Math.round(g1.card), 'the height is saved'); assert.equal(g1.now, Number(g1.saved));
      // The old cap of the fixed part was 40vh (it scrolled in itself): now it takes the panel's room, the cards shrink.
      assert.ok(g1.fixed > g1.win * 0.4 && g1.fixedScroll <= g1.fixed + 1, `the fixed part is higher than the old 40vh cap and does not scroll (${g1.fixed}, ${g1.fixedScroll})`);
      assert.ok(g1.panelBottom >= g0.panelBottom, `the panel uses the room under it (${g0.panelBottom} → ${g1.panelBottom})`);
      assert.ok(g1.approveBottom <= g1.panelBottom + 1 && g1.panelBottom <= g1.chatBottom + 1, `Onayla stays in the panel, the panel in the chat body (${JSON.stringify(g1)})`);
      if (SHOTS) { const b = await stack.boundingBox(); await page.screenshot({ path: join(SHOTS, '2-taller.png'), clip: { x: b.x - 34, y: Math.max(0, b.y - 12), width: b.width + 68, height: b.height + 24 } }); }
      note(`2: a drag of 100 px: the card is ${g1.card} px, saved; the fixed part is ${Math.round(g1.fixed)} px (> 40vh); the panel ends at ${Math.round(g1.panelBottom)} (was ${Math.round(g0.panelBottom)}); Onayla in view`);
      // 3. A chat switch and a reload keep the height.
      const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first();
      await proj.hover(); await page.getByRole('button', { name: /^(New session in acme-web|acme-web içinde yeni oturum)$/ }).click(); await pause(800);
      await until(async () => (await stack.count()) === 0, 'no panel in another chat');
      await openDamon(); await card.waitFor({ timeout: 20000 }); await pause(500);
      assert.ok(Math.abs((await geo()).card - g1.card) <= 1, 'a chat switch keeps the height');
      await page.reload();
      if (!(await stack.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await openDamon(); }
      await card.waitFor({ timeout: 20000 }); await page.mouse.move(5, 5); await pause(800);
      const g2 = await geo();
      assert.ok(Math.abs(g2.card - g1.card) <= 1, `a reload keeps the height (${g1.card} → ${g2.card})`);
      if (SHOTS) { const b = await stack.boundingBox(); await page.screenshot({ path: join(SHOTS, '3-after-reload.png'), clip: { x: b.x - 34, y: Math.max(0, b.y - 12), width: b.width + 68, height: b.height + 24 } }); }
      note(`3: a chat switch and a reload keep ${g2.card} px`);
      // 4. Keys, double-click, the room.
      await grip.focus();
      assert.equal(await grip.evaluate((el) => getComputedStyle(el).outlineStyle), 'solid', 'a visible focus ring');
      await page.keyboard.press('ArrowDown'); await until(async () => Math.abs((await geo()).card - (g2.card + 18)) <= 1, 'Down: one line taller');
      await page.keyboard.press('ArrowUp'); await until(async () => Math.abs((await geo()).card - g2.card) <= 1, 'Up: one line shorter');
      await grip.dblclick(); await until(async () => (await geo()).saved === null, 'a double-click forgets the height');
      assert.ok(Math.abs((await geo()).card - Math.round(g0.win * 0.14)) <= 1, 'the default height again');
      const gb2 = await grip.boundingBox();
      await page.mouse.move(gb2.x + gb2.width / 2, gb2.y + 4); await page.mouse.down(); await page.mouse.move(gb2.x + gb2.width / 2, gb2.y + 2000, { steps: 8 }); await page.mouse.up(); await pause(500);
      const g3 = await geo();
      assert.ok(g3.card <= g3.max + 1 && g3.body >= 40, `a long drag stops at the room; some cards stay in view (${JSON.stringify(g3)})`);
      assert.ok(g3.approveBottom <= g3.panelBottom + 1, 'Onayla stays in view');
      note(`4: Down/Up by 18 px, a double-click gives the default, a long drag stops at ${g3.card} px (max ${g3.max}); ${Math.round(g3.body)} px of cards in view`);
      assert.deepEqual(errors, [], 'no page errors');
      passed = true; console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(where.home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${where.home}\n${(demo?.log ?? '').split('\n').filter((l) => /error|warn/i.test(l)).slice(-20).join('\n')}`);
      await context?.close().catch(() => {});
      if (demo) { demo.child.kill('SIGTERM'); await new Promise((r) => { if (demo.child.exitCode !== null) r(); else demo.child.once('exit', r); }); }
      model.close();
      if (passed) await rm(where.home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
