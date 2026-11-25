// Real-app check of the Damon canvas view (tuval, like the "Sonsuz tuval" HTML mockup) and the Damon reply cards
// (assistantReplyCards) on each dsh given (scripts/demo-card-stack.mjs: a throwaway DSH_HOME and HOME, a fake model on
// 127.0.0.1, made-up projects and items). Headless, with Chromium's sandbox. Never the user's dsh home.
// 1. Reply cards: the chat is hidden behind the cards by default (the message box stays where it was, usable); the
//    newest reply is a card with its title, its Senden line, a closed details section, Onayla and the option buttons; the
//    card is New until a click; "Sohbeti göster" shows the chat, the choice stays after a reload, "Sohbeti gizle" hides it.
// 2. The canvas button opens the canvas: it covers the whole chat body; the chat, the message box and the panel are hidden;
//    the Damon hub in the middle, the panel's groups as islands around it (no two overlap, none covers the hub), a line to
//    each island, a moving line for each running task; the same cards as the panel; a minimap.
// 3. Pan (drag, Shift+wheel), zoom at the pointer (the wheel, + and −), the zoom levels (far: counts only; near: cards),
//    "Damon'a dön"; the view stays after a reload.
// 4. "Yalnız bana bekleyenler" hides the cards that do not wait for you.
// 5. A click on a card opens the side panel with its buttons; Esc closes the side panel first, then the canvas.
// 5b. The Kararlar button on the canvas opens the decision dialog; Esc closes only the dialog.
// 6. Keyboard: Tab reaches the Onay card; Enter opens its side panel; Onayla there sends the exact sentence once.
// 7. Esc and Back to the chat close the canvas: the scroll position and the draft are the same; the focus goes back to
//    the canvas button. No page errors.
// SHOTS=<folder> [TAG=<text>] [SCHEME=light|dark] writes (with -<TAG> before .png): composer-plus-<scheme> (the canvas at
// 75%, for test/browser-canvas-mockup.mjs PAIR=1), tuval-yan-panel-<scheme>, kartlar-sohbet-gizli-<scheme>,
// sohbet-acik-<scheme>, yanit-karti-<scheme>. SHOT=1 (with the English model, LANG=en) writes
// assets/features/assistantReplyCards.webp.
// PLAYWRIGHT=/path/to/playwright node test/browser-status-canvas.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL, fakeModel, demoHome, startDemo, seed, rpcOf } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light'; const TAG = process.env.TAG ? `-${process.env.TAG}` : '';
const EN = process.env.LANG_UI === 'en';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const rect = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
/** The canvas: the view, the hub, the islands and the cards as rectangles on screen, the zoom text and level. */
const layout = (page) => page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  const view = document.querySelector('[data-composer-plus-todos][data-canvas] .cp-cv-view');
  const shown = (el) => getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
  return { view: r(view), hub: r(view.querySelector('[data-cv-hub]')), islands: [...view.querySelectorAll('[data-cv-island]')].map((el) => ({ key: el.dataset.cvIsland, ...r(el) })),
    cards: [...view.querySelectorAll('.cp-cv-world [data-cv-key]')].filter(shown).map((el) => ({ key: el.dataset.cvKey, ...r(el) })), pct: document.querySelector('[data-cv-pct]').textContent,
    zoom: view.querySelector('.cp-cv-world').dataset.zoom, paths: view.querySelectorAll('.cp-cv-lines path').length, runs: view.querySelectorAll('.cp-cv-lines path.run').length };
});
const overlaps = (boxes) => {
  const out = [];
  for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) out.push(`${a.key} × ${b.key}`);
  return out;
};
const calls = [];
const model = await fakeModel(calls, EN ? 'en' : 'tr');
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const where = await demoHome(model.address().port);
    let demo; let context; let page; let passed = false; const errors = [];
    const note = (line) => console.log(`  ${line}`);
    const shot = async (name, opts = {}) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${name}-${SCHEME}${TAG}.png`), ...opts }); };
    try {
      demo = await startDemo(bin, where, 3500 + index);
      const { sessionId } = await seed(demo.url, { model });
      const { rpc } = await rpcOf(demo.url);
      context = await browser.newContext({ locale: EN ? 'en-US' : 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1360, height: 820 }, colorScheme: SCHEME, ...(process.env.SHOT ? { deviceScaleFactor: 2 } : {}) });
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
      await stack.locator('[data-composer-plus-approve="card"]').waitFor({ timeout: 20000 });
      // The optional setup and memory import cards are not part of this check: hide them for the pictures.
      for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: /^(Hide|Gizle)$/ }).first(); if (!(await hide.waitFor({ timeout: 1500 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
      const feed = page.locator('[data-composer-plus-reply-feed]');
      const input = page.locator('[data-composer-input]');
      const scroller = page.locator(`[data-conversation-session="${sessionId}"] [data-conversation-scroll]`);
      // 1. Reply cards: the seed's answer is older than the first view (read); a new reply comes as a New card on top.
      await feed.waitFor({ timeout: 20000 });
      const covered = await page.evaluate((id) => {
        const body = document.querySelector(`[data-conversation-session="${id}"][data-conversation-content]`);
        const scroll = body.querySelector('[data-conversation-scroll]'); const f = document.querySelector('[data-composer-plus-reply-feed]'); const box = document.querySelector('[data-composer-input]');
        const s = scroll.getBoundingClientRect(); const r = f.getBoundingClientRect(); const i = box.getBoundingClientRect(); const flow = body.querySelector('[data-chat-flow]');
        const seat = scroll.querySelector('[data-composer-seat]').getBoundingClientRect(); const hit = document.elementFromPoint(i.left + 20, i.top + i.height / 2);
        return { same: Math.abs(s.left - r.left) < 1 && Math.abs(s.top - r.top) < 1 && Math.abs(s.width - r.width) < 1 && Math.abs(seat.top - (r.top + r.height)) < 1,
          chatHidden: getComputedStyle(flow).visibility === 'hidden', inputShown: getComputedStyle(box).visibility === 'visible' && i.height > 0, inputBelow: i.top >= r.top + r.height - 1, inputHit: box.contains(hit) };
      }, sessionId);
      assert.deepEqual(covered, { same: true, chatHidden: true, inputShown: true, inputBelow: true, inputHit: true }, 'the cards cover the chat; the message box stays below them, usable');
      assert.equal(await feed.locator('[data-unread]').count(), 0, 'the replies before the first view are read');
      await rpc('session/prompt', { request: { requestId: `card-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: 'DEMO-REPLY-CARD' }] } });
      const newCard = feed.locator('article.cp-rc').first();
      await until(async () => (await newCard.getAttribute('data-unread')) === '' && (await newCard.locator('[data-composer-plus-approve="reply"]').count()) === 1, 'the new reply card with Onayla', 30000);
      assert.equal(await newCard.getAttribute('data-first'), '', 'the newest unread card is first');
      const title = EN ? 'The login-fix branch is ready.' : 'Montaj testi dalı hazır.';
      assert.equal(await newCard.locator('h3').innerText(), title, 'the bold first line is the title');
      assert.match(await newCard.locator('[data-reply-for]').innerText(), EN ? /turn on the due-date field/ : /Gerekli Tarih alanını aç/, 'the Senden line');
      assert.equal(await newCard.locator('details').evaluate((d) => d.open), false, '[!DETAILS] stays closed');
      assert.equal(await newCard.locator('.cp-rc-opt').count(), 2, 'the option buttons'); assert.equal(await newCard.locator('.cp-rc-opt[data-recommended]').count(), 1, 'the recommended option');
      assert.equal(await newCard.locator('.cp-rc-new').count(), 1, 'the New label');
      assert.match(await feed.locator('[data-reply-unread]').innerText(), /1/, 'one unread');
      const shownPicks = await page.locator('[data-conversation-session] [data-composer-plus-option-picks] button').evaluateAll((els) => els.filter((e) => e.checkVisibility({ visibilityProperty: true })).length);
      assert.equal(shownPicks, 0, 'the chat is hidden: the option buttons show on the card only');
      // The colors of the card's text read on its background (WCAG AA 4.5:1 for normal text).
      const contrast = await newCard.evaluate((el) => {
        const rgb = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); return m ? m[1].split(',').map(Number) : [0, 0, 0, 1]; };
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        let bg = el; while (bg && rgb(getComputedStyle(bg).backgroundColor)[3] === 0) bg = bg.parentElement;
        const back = lum(rgb(getComputedStyle(bg ?? document.body).backgroundColor));
        const ratio = (node) => { const l = lum(rgb(getComputedStyle(node).color)); return (Math.max(l, back) + 0.05) / (Math.min(l, back) + 0.05); };
        return Object.fromEntries([['title', 'h3'], ['for', '[data-reply-for]'], ['new', '.cp-rc-new'], ['time', '.cp-rc-top span:last-child'], ['option', '.cp-rc-opt']].map(([k, q]) => [k, Math.round(ratio(el.querySelector(q)) * 10) / 10]));
      });
      for (const [k, v] of Object.entries(contrast)) assert.ok(v >= 4.5, `contrast ${k} ${v} ≥ 4.5 (${SCHEME})`);
      await shot('kartlar-sohbet-gizli');
      await newCard.screenshot({ path: process.env.SHOTS ? join(process.env.SHOTS, `yanit-karti-${SCHEME}${TAG}.png`) : join(where.home, 'card.png') });
      if (process.env.SHOT && EN && index === 0) {
        const png = join(where.home, 'reply.png'); await page.screenshot({ path: png, clip: await feed.evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: Math.min(b.width, 900), height: Math.min(b.height, 620) }; }) });
        execFileSync('cwebp', ['-quiet', '-q', '72', '-resize', '1100', '0', png, '-o', join(repo, 'assets/features/assistantReplyCards.webp')]);
        note(`SHOT: assets/features/assistantReplyCards.webp ${statSync(join(repo, 'assets/features/assistantReplyCards.webp')).size} bytes`);
      }
      await newCard.locator('h3').click();
      await until(async () => (await newCard.getAttribute('data-unread')) === null, 'a click marks it read', 5000);
      assert.equal(await feed.locator('[data-reply-unread]').count(), 0, 'no unread');
      note(`1: the cards cover the chat (message box below); a new reply is a New card on top with Onayla and 2 options; contrast ${JSON.stringify(contrast)}; a click reads it`);
      // The toggle: show the chat (remembered after a reload), then hide it again.
      const toggle = stack.locator('[data-composer-plus-chat-toggle]');
      assert.equal(await toggle.getAttribute('data-composer-plus-chat-toggle'), 'show');
      await toggle.click();
      await until(async () => (await feed.count()) === 0, 'Sohbeti göster shows the chat', 5000);
      assert.equal(await scroller.evaluate((el) => getComputedStyle(el).visibility), 'visible', 'the chat shows');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
      await shot('sohbet-acik');
      await page.reload();
      if (!(await stack.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await openDamon(); }
      await pause(1500);
      assert.equal(await feed.count(), 0, 'the chat stays shown after a reload');
      await stack.locator('[data-composer-plus-chat-toggle="hide"]').click();
      await feed.waitFor({ timeout: 10000 });
      note('1b: Sohbeti göster shows the chat, the choice stays after a reload; Sohbeti gizle hides it');
      // 2. Open the canvas.
      const openBtn = stack.locator('[data-composer-plus-canvas-open]');
      await openBtn.click();
      const canvas = page.locator('[data-composer-plus-todos][data-canvas]');
      await canvas.waitFor({ timeout: 5000 });
      await page.waitForFunction(() => document.activeElement?.classList.contains('cp-cv-view'), null, { timeout: 3000 });
      const cover = await page.evaluate((id) => {
        const body = document.querySelector(`[data-conversation-session="${id}"][data-conversation-content]`); const cv = document.querySelector('[data-composer-plus-todos][data-canvas]');
        const b = body.getBoundingClientRect(); const c = cv.getBoundingClientRect();
        const input = body.querySelector('[data-composer-input]'); const hit = document.elementFromPoint(b.left + b.width / 2, b.bottom - 40);
        return { same: Math.abs(b.left - c.left) < 1 && Math.abs(b.top - c.top) < 1 && Math.abs(b.width - c.width) < 1 && Math.abs(b.height - c.height) < 1,
          inputHidden: getComputedStyle(input).visibility === 'hidden', hitInCanvas: cv.contains(hit), mark: body.getAttribute('data-composer-plus-canvas') };
      }, sessionId);
      assert.deepEqual(cover, { same: true, inputHidden: true, hitInCanvas: true, mark: 'open' }, 'the canvas covers the chat body; the chat and the message box are hidden');
      await pause(400);
      let l = await layout(page);
      // client.js canvasHome: 75%, or smaller (at least 50%) so that the columns keep 58 px from the sides.
      const homePct = (w) => `${Math.round(Math.max(0.5, Math.min(0.75, (w - 116) / 1440)) * 100)}%`;
      assert.equal(l.pct, homePct(l.view.w), `the first open: Damon in the middle at ${homePct(l.view.w)}`);
      const mid = (b) => [b.x + b.w / 2, b.y + b.h / 2];
      assert.ok(Math.abs(mid(l.hub)[0] - mid(l.view)[0]) < 2 && Math.abs(mid(l.hub)[1] - mid(l.view)[1]) < 2, 'the hub in the middle');
      assert.deepEqual(l.islands.map((i) => i.key).sort(), ['bitti', 'kararlar', 'onay', 'senden', 'sorun', 'suruyor', 'updates'].sort(), 'the islands');
      assert.deepEqual(overlaps([...l.islands, { key: 'hub', ...l.hub }]), [], 'no two islands overlap, none covers the hub');
      // The demo's long tasks can end before this step (dsh's subagent life): the moving lines match the running cards.
      const runCards = await canvas.locator('.cp-cv-world [data-cv-key][data-run]').count();
      assert.ok(l.paths >= l.islands.length, `a line to each island (${l.paths})`); assert.equal(l.runs, runCards, `a moving line for each running task (${l.runs})`);
      const left = l.islands.filter((i) => ['onay', 'senden', 'sorun'].includes(i.key)); const right = l.islands.filter((i) => ['suruyor', 'bitti', 'kararlar'].includes(i.key));
      assert.ok(left.every((i) => i.x + i.w < l.hub.x) && right.every((i) => i.x > l.hub.x + l.hub.w), 'your groups at the left, the work at the right');
      assert.ok(l.islands.find((i) => i.key === 'updates').y + l.islands.find((i) => i.key === 'updates').h < l.hub.y, 'the updates above the hub');
      assert.equal(await canvas.locator('[data-cv-minimap]').count(), 1, 'the minimap');
      assert.equal(await canvas.locator('[data-cv-key]').evaluateAll((els) => els.every((e) => e.tabIndex === 0 && e.getAttribute('aria-label'))), true, 'cards are focusable and named');
      assert.equal(await canvas.locator('[data-cv-key="onay"] [data-composer-plus-approve="card"]').count(), 1, 'the Onay card with Onayla');
      await shot('composer-plus');
      note(`2: the canvas covers the chat body; hub in the middle at ${l.pct}; ${l.islands.length} islands, no overlap; ${l.paths} lines (${l.runs} moving); minimap`);
      // 2b. After "Damon'a dön", the zoom buttons at the bottom left cover no island, in each window width.
      const zoomFree = [];
      for (const width of [1280, 1360, 1440, 1920]) {
        await page.setViewportSize({ width, height: 820 }); await pause(300);
        await canvas.locator('[data-cv-home]').click(); await pause(300);
        const m = await page.evaluate(() => {
          const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
          const view = document.querySelector('[data-composer-plus-todos][data-canvas] .cp-cv-view');
          return { pct: view.querySelector('[data-cv-pct]').textContent, view: r(view), zoom: { key: 'zoom', ...r(view.querySelector('.cp-cv-zm')) },
            islands: [...view.querySelectorAll('[data-cv-island]')].map((el) => ({ key: el.dataset.cvIsland, ...r(el) })) };
        });
        const hit = overlaps([m.zoom, ...m.islands]).filter((o) => o.startsWith('zoom'));
        assert.deepEqual(hit, [], `${width} px: the zoom buttons cover no island (${m.pct})`);
        const sorun = m.islands.find((i) => i.key === 'sorun');
        zoomFree.push(`${width} px ${m.pct}: zoom right ${Math.round(m.zoom.x + m.zoom.w - m.view.x)}, Sorun left ${Math.round(sorun.x - m.view.x)}`);
      }
      await page.setViewportSize({ width: 1360, height: 820 }); await pause(300); await canvas.locator('[data-cv-home]').click(); await pause(300);
      note(`2b: the zoom buttons cover no island: ${zoomFree.join('; ')}`);
      // 3. Pan, zoom, levels, home.
      const free = await page.evaluate(() => { const view = document.querySelector('.cp-cv-view').getBoundingClientRect();
        for (let y = view.top + 20; y < view.bottom - 150; y += 15) for (let x = view.left + 60; x < view.right - 200; x += 15) { const el = document.elementFromPoint(x, y); if (el?.classList.contains('cp-cv-view') || el?.classList.contains('cp-cv-world')) return { x, y }; }
        return null; });
      assert.ok(free, 'an empty point of the canvas');
      await page.mouse.move(free.x, free.y); await page.mouse.down(); await page.mouse.move(free.x - 120, free.y - 60, { steps: 6 }); await page.mouse.up();
      let l2 = await layout(page);
      assert.ok(Math.abs(l2.hub.x - (l.hub.x - 120)) < 2 && Math.abs(l2.hub.y - (l.hub.y - 60)) < 2, 'the drag moved the canvas');
      await page.mouse.move(l2.view.x + l2.view.w / 2, l2.view.y + l2.view.h / 2);
      await page.mouse.wheel(100, 0); await pause(200);
      const l2b = await layout(page); assert.ok(Math.abs(l2b.hub.x - (l2.hub.x - 100)) < 2 && l2b.pct === l2.pct, `a sideways wheel moves the canvas (${l2.hub.x} → ${l2b.hub.x}, ${l2b.pct})`);
      await page.keyboard.down('Shift'); await page.mouse.wheel(0, 100); await page.keyboard.up('Shift'); await pause(200);
      const l3 = await layout(page); assert.ok(Math.abs(l3.hub.x - l2b.hub.x) > 20 && Math.abs(l3.hub.y - l2b.hub.y) < 2 && l3.pct === l2b.pct, `Shift+wheel moves the canvas sideways (${l2b.hub.x} → ${l3.hub.x}, ${l3.pct})`);
      await page.mouse.wheel(0, 300); await pause(200);
      const l4 = await layout(page); assert.ok(parseInt(l4.pct, 10) < parseInt(l3.pct, 10), `the wheel zooms out (${l3.pct} → ${l4.pct})`);
      for (let n = 0; n < 4; n++) await canvas.locator('[data-cv-zoom="out"]').click();
      l = await layout(page); assert.equal(l.zoom, 'far', `far at ${l.pct}`); assert.equal(l.cards.length, 0, 'far: no cards, only the counts');
      assert.ok(await canvas.locator('[data-cv-island="onay"] [data-cv-count]').isVisible(), 'far: the island count');
      await canvas.locator('[data-cv-home]').click(); await pause(200);
      l = await layout(page); assert.equal(l.pct, homePct(l.view.w)); assert.equal(l.zoom, 'near'); assert.ok(l.cards.length > 0, 'near: the cards');
      assert.ok(Math.abs(mid(l.hub)[0] - mid(l.view)[0]) < 2, "Damon'a dön: the hub in the middle");
      await canvas.locator('[data-cv-zoom="in"]').click(); await canvas.locator('[data-cv-zoom="in"]').click(); await pause(300);
      const closePct = (await layout(page)).pct;
      assert.equal((await layout(page)).zoom, 'close', `close at ${closePct}`);
      await page.reload();
      if (!(await stack.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await openDamon(); }
      assert.equal(await canvas.count(), 0, 'a reload shows the chat');
      await stack.locator('[data-composer-plus-canvas-open]').click(); await canvas.waitFor({ timeout: 5000 }); await pause(400);
      assert.equal((await layout(page)).pct, closePct, 'the view stays after a reload');
      await canvas.locator('[data-cv-home]').click(); await pause(200);
      note('3: drag and Shift+wheel move; the wheel and −/+ zoom at the pointer; far shows counts only; home; the view stays after a reload');
      // 4. Only what waits for you.
      await canvas.locator('[data-cv-only]').click(); await pause(200);
      l = await layout(page);
      assert.ok(l.cards.length > 0 && l.cards.every((c) => /^(onay|karar|senden\|)/.test(c.key)), `only the waiting cards: ${l.cards.map((c) => c.key).join(', ')}`);
      await until(async () => (await canvas.locator('[data-cv-island="bitti"]').evaluate((el) => getComputedStyle(el).opacity)) === '0.4', 'an island without one is dimmed (after its .2 s fade)', 3000);
      await canvas.locator('[data-cv-only]').click(); await pause(200);
      note(`4: Yalnız bana bekleyenler: ${l.cards.length} cards`);
      // 5. The side panel: a click on a For you card; Esc closes it first, the focus goes back to the card.
      const senden = canvas.locator('[data-cv-key^="senden|"]').first(); const sendenKey = await senden.getAttribute('data-cv-key');
      await senden.locator('.cp-cs-title').first().click();
      const side = canvas.locator('[data-cv-side]');
      await side.waitFor({ timeout: 3000 });
      assert.equal(await side.getAttribute('data-cv-side'), sendenKey, 'the side panel shows the card');
      assert.equal(await side.locator('[data-act="main"]').count(), 1, 'with its own buttons');
      assert.ok(await page.evaluate(() => document.activeElement?.closest('[data-cv-side]') !== null), 'the focus in the side panel');
      await shot('tuval-yan-panel');
      await page.keyboard.press('Escape');
      await until(async () => (await side.count()) === 0, 'Esc closes the side panel', 3000);
      assert.equal(await canvas.count(), 1, 'the canvas stays open');
      await until(() => page.evaluate((k) => document.activeElement?.getAttribute('data-cv-key') === k, sendenKey), 'the focus back on the card', 3000);
      note('5: a card click opens the side panel with its buttons; Esc closes only the side panel; the focus is back on the card');
      // 5b. The Kararlar button on the canvas: the decision dialog; Esc closes only the dialog.
      const decideBtn = canvas.locator('[data-cv-island="kararlar"] button[aria-haspopup="dialog"]');
      // The island's title by keyboard (the minimap covers the bottom right corner): the focus pans it into view, Enter
      // zooms to the island.
      await canvas.locator('[data-cv-key="onay"]').focus(); await page.keyboard.press('Shift+Tab'); await pause(100);
      await canvas.locator('[data-cv-island="kararlar"] .cp-cv-ih').evaluate((b) => b.focus()); await page.keyboard.press('Enter'); await pause(300);
      const k = await layout(page); const isl = k.islands.find((i) => i.key === 'kararlar');
      assert.ok(Math.abs(isl.x + isl.w / 2 - (k.view.x + k.view.w / 2)) < 2, `the title zooms to the island (${k.pct})`);
      await decideBtn.click();
      const dialog = page.locator('dialog[data-composer-plus-decide][open]');
      await dialog.waitFor({ timeout: 5000 });
      assert.equal(await dialog.evaluate((d) => d.matches(':modal')), true, 'a modal dialog over the canvas');
      await pause(300); await page.keyboard.press('Escape');
      await until(async () => (await dialog.count()) === 0, 'Esc closes the dialog', 5000);
      await pause(300);
      assert.equal(await canvas.count(), 1, 'the canvas stays open');
      note('5b: Kararlar on the canvas opens the modal decision dialog; Esc closes only the dialog');
      // 6. Keyboard: Tab reaches the Onay card; Enter opens it; Onayla in the side panel sends the sentence once.
      await canvas.locator('.cp-cv-view').focus();
      let reached = false;
      for (let n = 0; n < 60 && !reached; n++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.getAttribute('data-cv-key') === 'onay'); }
      assert.ok(reached, 'Tab reaches the Onay card');
      await page.keyboard.press('Enter');
      await side.waitFor({ timeout: 3000 });
      const sideApprove = side.locator('[data-composer-plus-approve="card"]');
      assert.equal(await sideApprove.count(), 1, 'Onayla in the side panel');
      const sent = calls.length;
      await sideApprove.focus(); await page.keyboard.press('Enter');
      await until(() => calls.slice(sent).some((c) => c.newest === (EN ? 'Approve: merge the login-fix branch of acme-web into main and run the build script on the test server.' : APPROVAL)), 'the model got the sentence');
      await pause(1500);
      assert.equal(calls.slice(sent).filter((c) => c.newest === (EN ? 'Approve: merge the login-fix branch of acme-web into main and run the build script on the test server.' : APPROVAL) && c.step === 0).length, 1, 'one message');
      // The sentence is sent: the Onay card shows only with its button (main 0c6e3ae5), so it leaves; its side panel closes
      // and the focus goes to the canvas.
      await until(async () => (await side.count()) === 0, 'the side panel of the sent approval closes', 5000);
      await until(() => page.evaluate(() => document.activeElement?.classList.contains('cp-cv-view') === true), 'the focus on the canvas', 3000);
      note('6: Tab reaches the Onay card, Enter opens it in the side panel, Onayla there sent the exact sentence once; the card left, its side panel closed, the focus on the canvas');
      // 7. Esc and Back to the chat; the chat comes back as it was.
      await page.keyboard.press('Escape');
      await until(async () => (await canvas.count()) === 0, 'Esc closes the canvas');
      await until(() => page.evaluate(() => document.activeElement?.hasAttribute('data-composer-plus-canvas-open') === true), 'the focus goes back to the canvas button', 3000);
      // The scroll position and the draft: shown chat, a low window, a draft.
      await stack.locator('[data-composer-plus-chat-toggle="show"]').click(); await until(async () => (await feed.count()) === 0, 'the chat shows', 5000);
      await page.setViewportSize({ width: 1360, height: 560 }); await pause(300);
      await input.click(); await page.keyboard.type('taslak kalsın', { delay: 5 });
      await until(async () => (await input.innerText()).includes('taslak kalsın'), 'the draft');
      await scroller.evaluate((el) => { el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 3); }); await pause(300);
      const scroll2 = await scroller.evaluate((el) => el.scrollTop);
      assert.ok(scroll2 > 0, `the chat scrolls (${scroll2})`);
      await page.locator('[data-composer-plus-canvas-open]').click(); await canvas.waitFor({ timeout: 5000 }); await pause(300);
      await canvas.locator('[data-composer-plus-canvas-close]').click();
      await until(async () => (await canvas.count()) === 0, 'Back to the chat closes it');
      await pause(300);
      assert.equal(await scroller.evaluate((el) => el.scrollTop), scroll2, 'the scroll position is the same');
      assert.match(await input.innerText(), /taslak kalsın/, 'the draft is the same');
      await page.setViewportSize({ width: 1360, height: 820 }); await pause(300);
      assert.equal(await stack.getAttribute('data-place'), 'side', 'the panel is back');
      note(`7: Esc and Back to the chat close it; scroll ${scroll2} and the draft stay; the focus goes back to the button`);
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
