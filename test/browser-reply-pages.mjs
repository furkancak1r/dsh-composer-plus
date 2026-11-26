// Real-app check of Load earlier in the Damon reply cards (Güncellemeler; Furkan, 2026-11-26: "hepsi birden gözükmesin
// öncekini yükle olayı burada da geçerli olsun performans açısından") on each dsh given. A throwaway dsh
// (scripts/demo-card-stack.mjs: its own DSH_HOME and HOME, a fake model on 127.0.0.1, made-up projects), never the user's
// dsh home. Headless, with Chromium's sandbox.
// 1. 20 more replies than one page: the feed draws only the cards of the newest 8 replies, and Load earlier (dsh's own
//    label and look) is at the older end of the list.
// 2. A click adds the next 8 replies; the cards that showed keep their order, their read state and their New marks; the
//    first card on screen keeps its place. The next clicks show all; then the button goes.
// 3. A new reply shows at once (New, on top); the loaded cards stay.
// 4. Open the chat again (a reload): one page again.
// SHOTS=<folder> [TAG=<text>] writes guncellemeler-ilk<TAG>.png (the first view, top), guncellemeler-ilk-alt<TAG>.png
// (its end, with Load earlier) and guncellemeler-sonra<TAG>.png (after one click, at the place of the click); it never
// replaces a file. BEFORE=1: only the first view of the feed (for a client.js without Load earlier), no checks of it.
// PLAYWRIGHT=/path/to/playwright node test/browser-reply-pages.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeModel, demoHome, startDemo, seed, rpcOf } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const TAG = process.env.TAG ? `-${process.env.TAG}` : ''; const BEFORE = process.env.BEFORE === '1';
const MORE = 20; // replies sent after the seed (more than two pages)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const calls = [];
const model = await fakeModel(calls, 'tr');
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const where = await demoHome(model.address().port);
    let demo; let context; let page; let passed = false; const errors = [];
    const note = (line) => console.log(`  ${line}`);
    // A screenshot never replaces a file (the folder can hold the owner's earlier pictures): a new TAG gives new names.
    const shot = async (name) => { if (!process.env.SHOTS) return; const path = join(process.env.SHOTS, `guncellemeler-${name}${TAG}.png`); if (existsSync(path)) throw Error(`${path} exists: use another TAG`); await page.screenshot({ path }); };
    const bottom = () => page.locator('[data-composer-plus-reply-feed]').evaluate((f) => { f.scrollTop = f.scrollHeight; }).then(() => pause(300));
    try {
      demo = await startDemo(bin, where, 3600 + index);
      const { sessionId } = await seed(demo.url, { model });
      const { rpc } = await rpcOf(demo.url);
      // The updates: one turn each, each a card. dsh joins queued messages into one turn, so the next one goes after the
      // model answered the last one and its turn ended (a short wait).
      const say = async (text) => {
        await rpc('session/prompt', { request: { requestId: `pages-${text}-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] } });
        await until(() => calls.some((c) => c.newest === text), `the model got "${text}"`, 30000); await pause(700);
      };
      for (let n = 1; n <= MORE; n++) await say(`DEMO-REPLY ${n}`);
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1360, height: 820 } });
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
      for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: /^(Hide|Gizle)$/ }).first(); if (!(await hide.waitFor({ timeout: 1500 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
      const feed = page.locator('[data-composer-plus-reply-feed]');
      await feed.waitFor({ timeout: 20000 });
      const cards = feed.locator('article.cp-rc');
      const total = MORE + 1; // the seed's answer and the updates
      // The model answers the queued updates one by one: wait until each is a card, or (before the change) until the feed has them.
      const older = feed.locator('[data-reply-older]');
      const state = () => cards.evaluateAll((els) => els.map((el) => ({ seq: el.dataset.reply, unread: el.hasAttribute('data-unread'), title: el.querySelector('h3')?.textContent })));
      // The newest reply (update 20) is a card when the feed is ready.
      await until(async () => (await state()).some((c) => /Güncelleme 20:/.test(c.title)), 'the newest update is a card', 60000);
      // A turn that settled after the first view is New: read all, so the check starts from a known state.
      const readAll = feed.locator('[data-reply-read-all]');
      if (await readAll.count()) { await readAll.click(); await until(async () => (await feed.locator('[data-unread]').count()) === 0, 'all read', 5000); }
      if (BEFORE) {
        await shot('ilk'); await bottom(); await shot('ilk-alt');
        note(`BEFORE: the feed draws ${await cards.count()} cards at once (no Load earlier)`);
        passed = true; console.log(`PASS (before) dsh ${version}`); continue;
      }
      // 1. One page first: the cards of the newest 8 replies; the button at the older end, with dsh's own label and look.
      let first = await state();
      assert.equal(first.length, 8, `one page: ${JSON.stringify(first.map((c) => c.title))}`);
      assert.deepEqual(first.map((c) => c.title), Array.from({ length: 8 }, (_, i) => `Güncelleme ${MORE - i}: örnek iş bitti.`), 'the newest 8, newest first (all read: they came before the first view)');
      assert.equal(await older.innerText(), 'Öncekileri yükle', "dsh's Turkish label");
      assert.equal(await older.getAttribute('data-reply-older'), '8');
      const look = await older.evaluate((b) => { const s = getComputedStyle(b); const last = [...b.closest('.cp-rf-in').children].at(-1); return { last: last.contains(b), size: s.fontSize, pad: s.padding, border: s.borderStyle }; });
      assert.deepEqual(look, { last: true, size: '12px', pad: '4px 12px', border: 'none' }, "dsh's look, at the older end (below the cards)");
      await shot('ilk'); await bottom(); await shot('ilk-alt'); await feed.evaluate((f) => { f.scrollTop = 0; });
      note(`1: ${first.length} of ${total} replies show first; "Öncekileri yükle" below them`);
      // 2. Read states: a new reply is unread; Load earlier keeps it and the read ones as they are.
      await say('DEMO-REPLY 21');
      // 3. A new reply shows at once, New, on top.
      await until(async () => { const s = await state(); return s[0]?.title === 'Güncelleme 21: örnek iş bitti.' && s[0].unread; }, 'the new reply shows at once, New, on top', 30000);
      first = await state();
      assert.equal(first.length, 8, 'still one page (the newest 8 replies)');
      assert.deepEqual(first.filter((c) => c.unread).map((c) => c.title), ['Güncelleme 21: örnek iş bitti.'], 'one New card');
      note('3: a new reply shows at once as New, on top');
      // The feed scrolls: the first card on screen keeps its place after the click.
      await feed.evaluate((f) => { f.scrollTop = f.scrollHeight; }); await pause(300);
      const at = () => feed.evaluate((f) => { const top = f.getBoundingClientRect().top; const c = [...f.querySelectorAll('article.cp-rc')].find((el) => el.getBoundingClientRect().bottom > top); return { seq: c.dataset.reply, top: Math.round(c.getBoundingClientRect().top) }; });
      const placeBefore = await at();
      await older.click(); await pause(500);
      const after = await state();
      assert.deepEqual(after.slice(0, 8), first, 'the cards that showed keep their order, read state and New mark');
      assert.equal(after.length, 16, 'one more page: 8 replies');
      assert.deepEqual(after.slice(8).map((c) => c.title), Array.from({ length: 8 }, (_, i) => `Güncelleme ${MORE - 7 - i}: örnek iş bitti.`), 'the next 8 older replies');
      const placeAfter = await feed.evaluate((f, seq) => Math.round(f.querySelector(`article.cp-rc[data-reply="${seq}"]`).getBoundingClientRect().top), placeBefore.seq);
      assert.ok(Math.abs(placeAfter - placeBefore.top) <= 1, `the first card on screen keeps its place (${placeBefore.top} → ${placeAfter})`);
      await shot('sonra'); // the place of the click: the first card on screen where it was, the next 8 below
      await feed.evaluate((f) => { f.scrollTop = 0; }); await pause(200);
      note(`2: a click shows 8 more (${after.length} cards); the first card on screen stayed at ${placeAfter}px; order and read marks the same`);
      await older.click(); await pause(400);
      assert.equal(await cards.count(), total + 1, 'every reply shows');
      assert.equal(await older.count(), 0, 'no button when all show');
      // 4. Open the chat again (a reload): one page again.
      await page.reload();
      if (!(await feed.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await openDamon(); await feed.waitFor({ timeout: 20000 }); }
      await until(async () => (await cards.count()) === 8, 'one page again after the chat opens again', 10000);
      assert.equal(await older.count(), 1, 'Load earlier again');
      note('4: after a reload, one page shows again');
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
