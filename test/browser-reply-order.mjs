// Real-app check of the Damon reply cards' order, pointer and text selection, and of the chat toggle icon in the status
// panel header (Furkan, 2026-11-26: "yeni gelen kart en altta gözüksün", "text alanları ... I ya benzeyen şeyin çıkması
// lazım", "sohbeti göster butonunu da simgeye dönüştür"). A throwaway dsh (scripts/demo-card-stack.mjs: its own DSH_HOME
// and HOME, a fake model on 127.0.0.1, made-up data), headless Chrome with its sandbox, a 1440×900 window.
// 1. Order: the cards go from the oldest (top) to the newest (bottom), as in a chat.
// 2. The newest card is in view when the chat opens (a reload) and when a new card comes (also after you scrolled up).
// 3. Pointer: text in a card has the text cursor; buttons, the details summary and links have the hand; the card frame
//    has the arrow. A mouse drag selects text of a card and does not mark the card read; a click does.
// 4. The chat toggle in the panel header is an icon button in the row of the other icons (same size and color), named
//    "Sohbeti göster" (aria-label and title); a click shows the chat (its label is then "Sohbeti gizle"), a second click
//    hides it again.
// 5. A reply with two independent topics (a `---` line between them) shows as two cards, each with its own title.
// The measurements print first (MEASURE {...}), then the checks run. SHOTS=<folder> [TAG=<text>] writes
// kart-sirasi-<TAG>.png (after a reload), yeni-kart-<TAG>.png (after a new card) and panel-basligi-<TAG>.png (the
// panel header) and iki-konu-<TAG>.png (a reply with two topics).
// PLAYWRIGHT=/path/to/playwright node test/browser-reply-order.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeModel, demoHome, startDemo, seed, rpcOf } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const TAG = process.env.TAG ? `-${process.env.TAG}` : '';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
/** The feed: the cards from top to bottom (seq, unread), the scroll state and whether the newest card is in view. */
const feedState = (page) => page.evaluate(() => {
  const f = document.querySelector('[data-composer-plus-reply-feed]'); if (f === null) return null;
  const box = f.getBoundingClientRect();
  const cards = [...f.querySelectorAll('article.cp-rc')].map((el) => ({ seq: Number(el.dataset.reply), unread: el.hasAttribute('data-unread'), top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
  const newest = cards.reduce((a, c) => (a === null || c.seq > a.seq ? c : a), null);
  return { seqs: cards.map((c) => c.seq), unread: cards.filter((c) => c.unread).map((c) => c.seq), atEnd: f.scrollHeight - f.scrollTop - f.clientHeight < 2, scrolls: f.scrollHeight > f.clientHeight + 2,
    newestShown: newest !== null && newest.bottom > box.top + 1 && newest.top < box.bottom - 1, newestBottomShown: newest !== null && newest.bottom <= box.bottom + 1 && newest.bottom > box.top };
});
const calls = [];
const model = await fakeModel(calls, 'tr');
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const where = await demoHome(model.address().port);
    let demo; let context; let page; let passed = false; const errors = [];
    const shot = async (name, opts = {}) => { if (process.env.SHOTS && index === 0) await page.screenshot({ path: join(process.env.SHOTS, `${name}${TAG}.png`), ...opts }); };
    try {
      demo = await startDemo(bin, where, 3600 + index);
      const { sessionId } = await seed(demo.url, { model });
      const { rpc } = await rpcOf(demo.url);
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
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
      for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: /^(Hide|Gizle)$/ }).first(); if (!(await hide.waitFor({ timeout: 1500 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
      const feed = page.locator('[data-composer-plus-reply-feed]');
      await feed.waitFor({ timeout: 20000 });
      const cardCount = () => feed.locator('article.cp-rc').count();
      const ask = async (text) => {
        const before = await cardCount();
        await rpc('session/prompt', { request: { requestId: `order-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] } });
        await until(async () => (await cardCount()) > before, `the card of ${text}`);
        await pause(300);
      };
      for (const text of ['DEMO-NOTE 1', 'DEMO-NOTE 2', 'DEMO-NOTE 3', 'DEMO-REPLY-CARD']) await ask(text);
      const m = {};
      m.afterReplies = await feedState(page);
      // 2. The chat opens again (a reload): the newest card is in view.
      await page.reload();
      if (!(await stack.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await openDamon(); }
      await feed.waitFor({ timeout: 20000 }); await until(async () => (await cardCount()) >= 5, 'the cards after the reload'); await pause(800);
      m.opened = await feedState(page);
      await shot('kart-sirasi');
      // 3. Pointer and text selection, on the newest card (the DEMO-REPLY-CARD answer: its Onayla and
      // option buttons show while it is the newest answer).
      const rich = feed.locator('article.cp-rc').filter({ has: page.locator('.cp-rc-opt') }).last();
      m.cursor = await rich.evaluate((card) => {
        const c = (q) => { const el = card.querySelector(q); return el === null ? null : getComputedStyle(el).cursor; };
        return { card: getComputedStyle(card).cursor, title: c('h3'), time: c('.cp-rc-top'), forYou: c('[data-reply-for]'), body: c('.cp-rc-body'), approvalText: c('.cp-rc-ok>p'),
          option: c('.cp-rc-opt'), approve: c('[data-composer-plus-approve="reply"]'), summary: c('summary'), userSelect: getComputedStyle(card.querySelector('h3')).userSelect };
      });
      const unreadBefore = (await rich.getAttribute('data-unread')) === '';
      const h3 = await rich.locator('h3').boundingBox();
      await page.mouse.move(h3.x + 3, h3.y + h3.height / 2); await page.mouse.down();
      await page.mouse.move(h3.x + Math.min(h3.width - 3, 260), h3.y + h3.height / 2, { steps: 8 }); await page.mouse.up(); await pause(300);
      m.selection = { text: await page.evaluate(() => String(globalThis.getSelection?.() ?? '')), unreadBefore, unreadAfterDrag: (await rich.getAttribute('data-unread')) === '' };
      await page.evaluate(() => globalThis.getSelection?.()?.removeAllRanges?.());
      await rich.locator('h3').click(); await pause(300);
      m.selection.unreadAfterClick = (await rich.getAttribute('data-unread')) === '';
      // A new card comes while you read an older one (the feed scrolled up).
      await feed.evaluate((el) => { el.scrollTop = 0; }); await pause(300);
      await ask('DEMO-NOTE 4'); await pause(500);
      m.newCard = await feedState(page);
      await shot('yeni-kart');
      // 4. The chat toggle in the panel header.
      const top = stack.locator('.cp-st-top');
      const tb = await top.boundingBox();
      await shot('panel-basligi', { clip: { x: tb.x - 8, y: tb.y - 8, width: tb.width + 16, height: tb.height + 16 } });
      const toggle = top.locator('[data-composer-plus-chat-toggle]');
      m.toggle = await toggle.evaluate((b) => {
        const ref = b.parentElement.querySelector('[data-composer-plus-canvas-open]') ?? b.parentElement.querySelector('[id$="-refresh"]');
        const r = b.getBoundingClientRect(); const q = ref.getBoundingClientRect();
        return { icon: b.querySelector('svg') !== null, text: b.textContent.trim(), label: b.getAttribute('aria-label'), title: b.getAttribute('title'), className: b.className,
          size: [Math.round(r.width), Math.round(r.height)], refSize: [Math.round(q.width), Math.round(q.height)], sameRow: Math.abs(r.top - q.top) < 2,
          color: getComputedStyle(b).color, refColor: getComputedStyle(ref).color, state: b.dataset.composerPlusChatToggle };
      });
      await toggle.click();
      await until(async () => (await feed.count()) === 0, 'the toggle shows the chat', 5000);
      m.toggle.afterClick = { label: await toggle.getAttribute('aria-label'), title: await toggle.getAttribute('title'), state: await toggle.getAttribute('data-composer-plus-chat-toggle'), pressed: await toggle.getAttribute('aria-pressed') };
      await toggle.click(); await feed.waitFor({ timeout: 10000 });
      // 5. A reply with two independent topics split by a `---` line: two cards with their own titles (a `---` in a code
      // block does not split).
      await ask('DEMO-TWO-TOPICS'); await pause(500);
      m.twoTopics = await feed.evaluate((f) => { const all = [...f.querySelectorAll('article.cp-rc')]; const seq = all.at(-1).dataset.reply;
        return all.filter((el) => el.dataset.reply === seq).map((el) => ({ title: el.querySelector('h3').textContent, forYou: el.querySelector('[data-reply-for]')?.textContent ?? '' })); });
      await shot('iki-konu');
      console.log(`  MEASURE ${JSON.stringify(m)}`);
      // The checks.
      for (const [k, s] of Object.entries({ afterReplies: m.afterReplies, opened: m.opened, newCard: m.newCard })) {
        assert.deepEqual(s.seqs, [...s.seqs].sort((a, b) => a - b), `${k}: the oldest card on top, the newest at the bottom (${s.seqs.join(', ')})`);
      }
      assert.ok(m.opened.scrolls, 'the feed scrolls (enough cards for the check)');
      assert.ok(m.opened.atEnd && m.opened.newestBottomShown, `the chat opens at the newest card: ${JSON.stringify(m.opened)}`);
      assert.ok(m.newCard.atEnd && m.newCard.newestBottomShown, `a new card comes into view: ${JSON.stringify(m.newCard)}`);
      for (const k of ['title', 'time', 'forYou', 'body', 'approvalText']) assert.equal(m.cursor[k], 'text', `the text cursor over ${k}`);
      for (const k of ['option', 'approve', 'summary']) assert.equal(m.cursor[k], 'pointer', `the hand over ${k}`);
      assert.equal(m.cursor.card, 'default', 'the arrow over the card frame');
      assert.ok(m.selection.unreadBefore, 'the card is unread before the drag');
      assert.ok(m.selection.text.length >= 5, `a drag selects the text (${JSON.stringify(m.selection.text)})`);
      assert.ok(m.selection.unreadAfterDrag, 'a text selection does not mark the card read');
      assert.equal(m.selection.unreadAfterClick, false, 'a click marks it read');
      assert.deepEqual([m.toggle.icon, m.toggle.text, m.toggle.label, m.toggle.title, m.toggle.state], [true, '', 'Sohbeti göster', 'Sohbeti göster', 'show'], `the toggle is an icon named Sohbeti göster: ${JSON.stringify(m.toggle)}`);
      assert.ok(m.toggle.className.split(' ').includes('cp-td-btn') && m.toggle.sameRow, 'in the row of the header icons, with their class');
      assert.deepEqual([m.toggle.size, m.toggle.color], [m.toggle.refSize, m.toggle.refColor], 'the same size and color as the other icons');
      assert.deepEqual(m.toggle.afterClick, { label: 'Sohbeti gizle', title: 'Sohbeti gizle', state: 'hide', pressed: 'true' }, 'a click shows the chat');
      assert.deepEqual(m.twoTopics.map((c) => c.title), ['Kur kolonu dört firmada aynı raporlarda.', 'Yerel model 11 dakika kapalı kaldı.'], 'two topics: two cards, each with its title');
      assert.match(m.twoTopics[0].forYou, /4 raporu/, 'the first card keeps its Senden line');
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
