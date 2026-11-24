// Real-app check of the Damon canvas view (tuval, Furkan 2026-11-24) on each dsh given (scripts/demo-card-stack.mjs: a
// throwaway DSH_HOME and HOME, a fake model on 127.0.0.1, made-up projects and items). Headless, with Chromium's sandbox.
// Never the user's dsh home.
// 1. Canvas closed: the chat and the status panel show as before; the panel has the canvas button (a real button with
//    its name).
// 2. The button opens the canvas: it covers the whole chat body; the messages, the composer and the panel are hidden
//    (not visible to a click), the canvas shows the same cards as the panel (counts per group), each card focusable.
// 3. Pan (drag the background, the wheel), zoom (Ctrl+wheel, + and −), Fit all: every card inside the view.
// 4. Drag a card: its place is saved; after a reload and an open again, the card and the zoom are where they were. A new
//    card (the choice after the approval) gets a place that touches no other card.
// 5. Keyboard: Tab from the canvas reaches the cards and the Onayla button; Onayla on the canvas sends the exact sentence
//    once (the panel's path).
// 6. Esc and Back to the chat close it: the chat's scroll position and the composer draft are the same as before; the
//    focus goes back to the canvas button. No page errors.
// SHOTS=<folder> writes: 1-chat-before.png, 2-canvas-open.png, 3-canvas-pan-zoom.png, 4-chat-after.png.
// PLAYWRIGHT=/path/to/playwright node test/browser-status-canvas.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { APPROVAL, fakeModel, demoHome, startDemo, seed } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
/** The canvas cards as rectangles on screen, and the view's rectangle. */
const layout = (page) => page.evaluate(() => {
  const view = document.querySelector('[data-composer-plus-todos][data-canvas] .cp-cv-view');
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  return { view: r(view), cards: [...view.querySelectorAll('[data-cv-key]')].map((el) => ({ key: el.dataset.cvKey, ...r(el) })), pct: document.querySelector('[data-cv-pct]').textContent };
});
const overlaps = (cards) => {
  const out = [];
  for (const [i, a] of cards.entries()) for (const b of cards.slice(i + 1)) if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.key} × ${b.key}`);
  return out;
};
const calls = [];
const model = await fakeModel(calls);
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const where = await demoHome(model.address().port);
    let demo; let context; let page; let passed = false; const errors = [];
    const note = (line) => console.log(`  ${line}`);
    const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, name) }); };
    try {
      demo = await startDemo(bin, where, 3500 + index);
      const { sessionId } = await seed(demo.url, { model });
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1360, height: 820 }, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(demo.url);
      for (const name of [/^(Continue|Devam)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }).catch(() => {}); }
      }
      await page.keyboard.press('Escape');
      const openDamon = async () => { await page.locator('button[aria-label="Damon"]').click(); await page.locator('[data-composer-plus-todos]').waitFor({ timeout: 30000 }); };
      await openDamon();
      const stack = page.locator('[data-composer-plus-todos]');
      const approve = stack.locator('[data-composer-plus-approve="card"]');
      await approve.waitFor({ timeout: 20000 });
      // The optional setup and memory import cards are not part of this check: hide them for the pictures.
      for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: /^(Hide|Gizle)$/ }).first(); if (!(await hide.waitFor({ timeout: 1500 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
      // 1. Closed: the panel as before, with the canvas button.
      const openBtn = stack.locator('[data-composer-plus-canvas-open]');
      assert.equal(await openBtn.evaluate((b) => b.tagName), 'BUTTON'); assert.equal(await openBtn.getAttribute('aria-label'), 'Tuvali aç'); assert.equal(await openBtn.getAttribute('title'), 'Tuvali aç');
      assert.equal(await stack.getAttribute('data-place'), 'side', 'the panel at the right, as before');
      const counts = (await stack.locator('[data-composer-plus-counts]').innerText()).trim();
      // The draft and the scroll position are checked in step 6 (Onayla shows only while the composer is empty).
      const input = page.locator('[data-composer-input]');
      const scroller = page.locator(`[data-conversation-session="${sessionId}"] [data-conversation-scroll]`);
      // The panel's list keys (the same data on the canvas).
      const listKeys = await stack.evaluate((el) => [...el.querySelectorAll('li.cp-cs-card[data-key]')].map((li) => li.dataset.key).sort());
      await shot('1-chat-before.png');
      note(`1: closed: the chat, the panel at the right (${counts}), the canvas button`);
      // 2. Open: the canvas covers the chat body; the chat, the composer and the panel are hidden.
      await openBtn.click();
      const canvas = page.locator('[data-composer-plus-todos][data-canvas]');
      await canvas.waitFor({ timeout: 5000 });
      await page.waitForFunction(() => document.activeElement?.classList.contains('cp-cv-view'), null, { timeout: 3000 });
      const cover = await page.evaluate((id) => {
        const body = document.querySelector(`[data-conversation-session="${id}"][data-conversation-content]`); const cv = document.querySelector('[data-composer-plus-todos][data-canvas]');
        const b = body.getBoundingClientRect(); const c = cv.getBoundingClientRect();
        const scroll = body.querySelector('[data-conversation-scroll]'); const input = body.querySelector('[data-composer-input]');
        const hit = document.elementFromPoint(b.left + b.width / 2, b.bottom - 40);
        return { same: Math.abs(b.left - c.left) < 1 && Math.abs(b.top - c.top) < 1 && Math.abs(b.width - c.width) < 1 && Math.abs(b.height - c.height) < 1,
          scrollHidden: getComputedStyle(scroll).visibility === 'hidden', inputHidden: getComputedStyle(input).visibility === 'hidden', hitInCanvas: cv.contains(hit), mark: body.getAttribute('data-composer-plus-canvas') };
      }, sessionId);
      assert.deepEqual(cover, { same: true, scrollHidden: true, inputHidden: true, hitInCanvas: true, mark: 'open' }, 'the canvas covers the chat body; the chat and the composer are hidden');
      assert.equal(await page.locator('[data-composer-plus-todos]:not([data-canvas])').count(), 0, 'the panel list is not shown');
      let l = await layout(page);
      const keys = l.cards.map((c) => c.key);
      for (const k of listKeys) assert.ok(keys.some((x) => x.endsWith(`|${k}`)), `card ${k} on the canvas (${JSON.stringify(keys)})`);
      assert.ok(keys.includes('onay'), 'the Onay card'); assert.ok(keys.includes('notes'), 'your notes: the Kararlar button');
      assert.deepEqual(overlaps(l.cards), [], 'no two cards overlap');
      for (const c of l.cards) assert.ok(c.x >= l.view.x - 1 && c.y >= l.view.y - 1 && c.x + c.w <= l.view.x + l.view.w + 1 && c.y + c.h <= l.view.y + l.view.h + 1, `the first open fits all: ${c.key}`);
      assert.equal(await canvas.locator('[data-cv-key]').evaluateAll((els) => els.every((e) => e.tabIndex === 0 && e.getAttribute('aria-label'))), true, 'cards are focusable and named');
      await shot('2-canvas-open.png');
      note(`2: the canvas covers the chat body (chat and composer hidden), ${l.cards.length} cards, no overlap, all in view at ${l.pct}`);
      // 3. Pan: drag the background; the wheel; zoom: Ctrl+wheel and the buttons; Fit all.
      const v = l.view; const first = l.cards[0];
      // An empty point of the background: below the lowest card or at the right of the last column.
      const free = await page.evaluate(() => { const view = document.querySelector('.cp-cv-view').getBoundingClientRect();
        for (let y = view.bottom - 10; y > view.top + 10; y -= 15) for (let x = view.left + 10; x < view.right - 10; x += 15) { const el = document.elementFromPoint(x, y); if (el?.classList.contains('cp-cv-view') || el?.classList.contains('cp-cv-world')) return { x, y }; }
        return null; });
      assert.ok(free, 'an empty point of the canvas');
      // The drag leaves the canvas on purpose (the free point can be at its left edge): the drag goes on.
      await page.mouse.move(free.x, free.y); await page.mouse.down(); await page.mouse.move(free.x - 120, free.y - 60, { steps: 6 }); await page.mouse.up();
      l = await layout(page); const moved = l.cards.find((c) => c.key === first.key);
      assert.ok(Math.abs(moved.x - (first.x - 120)) < 2 && Math.abs(moved.y - (first.y - 60)) < 2, `the drag moved the canvas (${JSON.stringify([first, moved])})`);
      await page.mouse.move(v.x + v.w / 2, v.y + v.h / 2); await page.mouse.wheel(0, 100); await pause(200);
      const wheeled = (await layout(page)).cards.find((c) => c.key === first.key);
      assert.ok(Math.abs(wheeled.y - (moved.y - 100)) < 2, `the wheel moves the canvas (${moved.y} → ${wheeled.y})`);
      const pctBefore = (await layout(page)).pct;
      await page.keyboard.down('Control'); await page.mouse.wheel(0, -60); await page.keyboard.up('Control'); await pause(200);
      const pctPinch = (await layout(page)).pct;
      assert.ok(parseInt(pctPinch, 10) > parseInt(pctBefore, 10), `Ctrl+wheel (a trackpad pinch) zooms in (${pctBefore} → ${pctPinch})`);
      await canvas.locator('[data-cv-zoom="out"]').click(); await canvas.locator('[data-cv-zoom="out"]').click();
      assert.ok(parseInt((await layout(page)).pct, 10) < parseInt(pctPinch, 10), 'the − button zooms out');
      await shot('3-canvas-pan-zoom.png');
      await canvas.locator('[data-cv-fit]').click(); await pause(200);
      l = await layout(page);
      for (const c of l.cards) assert.ok(c.x >= l.view.x - 1 && c.y >= l.view.y - 1 && c.x + c.w <= l.view.x + l.view.w + 1 && c.y + c.h <= l.view.y + l.view.h + 1, `Fit all: ${c.key} in view`);
      note(`3: drag and wheel move the canvas; Ctrl+wheel ${pctBefore} → ${pctPinch}; − zooms out; Fit all shows every card (${l.pct})`);
      // 4. Drag a card by its label: saved; after a reload the card and the zoom are where they were.
      const noteCard = canvas.locator('[data-cv-key="notes"]'); const noteKey = await noteCard.getAttribute('data-cv-key');
      const label = noteCard.locator('.cp-cv-kind'); const lb = await label.boundingBox();
      await page.mouse.move(lb.x + 10, lb.y + 5); await page.mouse.down(); await page.mouse.move(lb.x + 10 + 200, lb.y + 5 + 150, { steps: 8 }); await page.mouse.up();
      await pause(400);
      const savedState = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-composer-plus.status-canvas')));
      assert.ok(savedState.pos[noteKey], 'the moved card\'s place is saved');
      const afterDrag = await layout(page);
      await page.reload();
      if (!(await page.locator('[data-composer-plus-todos]').waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await openDamon(); }
      assert.equal(await page.locator('[data-composer-plus-todos][data-canvas]').count(), 0, 'a reload shows the chat');
      await page.locator('[data-composer-plus-canvas-open]').click(); await canvas.waitFor({ timeout: 5000 }); await pause(400);
      const afterReload = await layout(page);
      assert.equal(afterReload.pct, afterDrag.pct, 'the zoom stays after a reload');
      const a1 = afterDrag.cards.find((c) => c.key === noteKey); const a2 = afterReload.cards.find((c) => c.key === noteKey);
      assert.ok(Math.abs(a1.x - a2.x) < 2 && Math.abs(a1.y - a2.y) < 2, `the card stays after a reload (${JSON.stringify([a1, a2])})`);
      note('4: a dragged card and the zoom stay after a reload (localStorage)');
      // 5. Keyboard: Tab reaches the Onay card's Onayla; Enter on it sends the exact sentence once.
      await canvas.locator('.cp-cv-view').focus();
      let reached = false;
      for (let n = 0; n < 40 && !reached; n++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.getAttribute('data-composer-plus-approve') === 'card'); }
      assert.ok(reached, 'Tab reaches Onayla on the canvas');
      const onayRect = await page.evaluate(() => { const b = document.activeElement.getBoundingClientRect(); const v = document.querySelector('.cp-cv-view').getBoundingClientRect(); return b.top >= v.top - 1 && b.bottom <= v.bottom + 1 && b.left >= v.left - 1 && b.right <= v.right + 1; });
      assert.ok(onayRect, 'the focused button is in view');
      const sent = calls.length;
      await page.keyboard.press('Enter');
      await until(() => calls.slice(sent).some((c) => c.newest === APPROVAL), 'the model got the sentence');
      await pause(1500);
      assert.equal(calls.slice(sent).filter((c) => c.newest === APPROVAL && c.step === 0).length, 1, 'one message');
      // The answer to the approval ends with an option list: the choice card comes, at a free place.
      await until(async () => (await canvas.locator('[data-cv-key="karar"]').count()) === 1, 'the choice card on the canvas', 20000);
      await pause(500);
      assert.deepEqual(overlaps((await layout(page)).cards.filter((c) => c.key !== noteKey)), [], 'the new card touches no other card');
      note('5: Tab reaches Onayla; Enter sent the exact sentence once; the new choice card got a free place');
      // 6. Esc closes; the chat comes back as it was; the focus goes back to the canvas button. Then Back to the chat.
      await canvas.locator('.cp-cv-view').focus();
      await page.keyboard.press('Escape');
      await until(async () => (await page.locator('[data-composer-plus-todos][data-canvas]').count()) === 0, 'Esc closes the canvas');
      // The focus moves one task after the close (the button is drawn again first).
      await until(() => page.evaluate(() => document.activeElement?.hasAttribute('data-composer-plus-canvas-open') === true), 'the focus goes back to the canvas button', 3000);
      assert.equal(await page.locator(`[data-conversation-session="${sessionId}"]`).first().evaluate((el) => el.hasAttribute('data-composer-plus-canvas')), false, 'no mark');
      // The draft: the approval sent nothing of it (Onayla shows only with an empty composer: type again after the send).
      // A low window, so that the chat scrolls; a draft in the composer.
      await page.setViewportSize({ width: 1360, height: 560 }); await pause(300);
      await input.click(); await page.keyboard.type('taslak kalsın', { delay: 5 });
      await until(async () => (await input.innerText()).includes('taslak kalsın'), 'the draft');
      await scroller.evaluate((el) => { el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 3); }); await pause(300);
      const scroll2 = await scroller.evaluate((el) => el.scrollTop);
      assert.ok(scroll2 > 0, `the chat scrolls (${scroll2})`);
      await page.locator('[data-composer-plus-canvas-open]').click(); await canvas.waitFor({ timeout: 5000 }); await pause(300);
      await canvas.locator('[data-composer-plus-canvas-close]').click();
      await until(async () => (await page.locator('[data-composer-plus-todos][data-canvas]').count()) === 0, 'Back to the chat closes it');
      await pause(300);
      assert.equal(await scroller.evaluate((el) => el.scrollTop), scroll2, 'the scroll position is the same');
      assert.match(await input.innerText(), /taslak kalsın/, 'the draft is the same');
      await page.setViewportSize({ width: 1360, height: 820 }); await pause(300);
      assert.equal(await page.locator('[data-composer-plus-todos]').getAttribute('data-place'), 'side', 'the panel is back');
      await shot('4-chat-after.png');
      note(`6: Esc and Back to the chat close it; scroll ${scroll2} and the draft stay; the focus goes back to the button`);
      assert.deepEqual(errors, [], 'no page errors');
      passed = true; console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(where.home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${where.home}\n${(demo?.log ?? '').split('\n').filter((line) => /error|warn/i.test(line)).slice(-20).join('\n')}`);
      await context?.close().catch(() => {});
      if (demo) { demo.child.kill('SIGTERM'); await new Promise((r) => { if (demo.child.exitCode !== null) r(); else demo.child.once('exit', r); }); }
      if (passed) await rm(where.home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); model.close(); }
