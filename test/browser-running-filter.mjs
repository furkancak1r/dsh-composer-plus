// Real-app check of the Sürüyor filter (Furkan, 2026-11-24: the running work and Damon's to-dos looked the same; then
// "tümü seçeneğine gerek yok"). A throwaway dsh (scripts/demo-card-stack.mjs: its own DSH_HOME and HOME, a fake model on
// 127.0.0.1), headless Chromium with its sandbox, never the user's dsh home. The status answer of the Damon chat is a
// made-up fixture (page.route): 3 tasks that run now (two subagents, one delegated chat; an item with the words of one of
// them) and 6 items of Damon without a running task, a waiting item, a done task and 2 notes.
// 1. The header says "Sürüyor 3 · sırada 6"; open, two chips: "Çalışıyor 3" (pressed, the default) and "Damon'ın sırası 6";
//    no third chip. Only the 3 running cards show, each with the running mark (●, it pulses) and its time.
// 2. Keyboard: Tab from the group header reaches both chips with a visible focus ring; Enter on "Damon'ın sırası" shows
//    only the 6 to-dos (○, no animation); a reload keeps the choice; Space on "Çalışıyor" goes back.
// 3. prefers-reduced-motion: the running mark does not pulse. The waiting item stays in Senden. No page errors.
// PLAYWRIGHT=/path/to/playwright [SHOTS=<folder>] [SCHEME=light|dark] node test/browser-running-filter.mjs <dsh/lib/bin.js> [...]
// SHOTS writes <folder>/suruyor-calisiyor.png and <folder>/suruyor-damonin-sirasi.png (the panel, last dsh given).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeModel, demoHome, startDemo, seed } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
const { PLAYWRIGHT, SHOTS, SCHEME = 'dark' } = process.env;
if (!PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(PLAYWRIGHT);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const RUNNING = ['Satınalma sorguları (acme-web)', 'Montaj testi dalı', 'Hava durumu CLI güncellemesi'];
const TODOS = ['Maccy 2.8.0 belleğini birkaç gün sonra yeniden ölç', 'Her cuma 10:00–12:00 rapor hatırlatması', "Akşam AIProxy boşken yeni main'i kur",
  'Yedek klasörünü haftalık kontrol et', 'Stok raporu şablonunu güncelle', 'Fatura şablonunu gözden geçir'];
const fixture = () => {
  const now = Date.now(); const min = 60000;
  const items = [
    { id: 'f0000001', text: RUNNING[0], owner: 'agent', created: now - 15 * min },
    ...TODOS.map((text, i) => ({ id: `f00000${10 + i}`, text, owner: 'agent', created: now - (300 - i * 40) * min })),
    { id: 'f0000020', text: 'ANR kur', owner: 'agent', created: now - 50 * min, waiting: { reason: 'Oyun klasörünün yolu gerekiyor', since: now - 45 * min } },
    { id: 'f0000030', text: 'Kırtasiye siparişini ver', owner: 'user', created: now - 600 * min }, { id: 'f0000031', text: 'Toplantı notlarını oku', owner: 'user', created: now - 590 * min }];
  const tasks = [
    { id: 'c-run-1', title: RUNNING[0], state: 'running', started: now - 12 * min },
    { id: 'c-run-2', title: RUNNING[1], state: 'running', started: now - 4 * min, chat: true, result: 'acme-web · feat/montaj-testi' },
    { id: 'c-run-3', title: RUNNING[2], state: 'running', started: now - 40000 },
    { id: 'c-done-1', title: 'Haftalık stok raporu', state: 'done', started: now - 90 * min, ended: now - 70 * min, result: 'Rapor üretildi ve paylaşıldı.' }];
  return { on: true, items, tasks, projects: [], at: now };
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
    try {
      demo = await startDemo(bin, where, 3330 + index);
      await seed(demo.url, { model });
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2, colorScheme: SCHEME === 'light' ? 'light' : 'dark' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      // The Damon chat's status answer: the fixture (the item texts and task states are made up).
      await context.route(/\/api\/composer-plus\.assistant-todos\?/, (route) => {
        const u = new URL(route.request().url());
        if (route.request().method() !== 'GET' || u.searchParams.has('project')) return route.continue();
        return route.fulfill({ json: fixture() });
      });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(demo.url);
      for (const name of [/^(Continue|Devam)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }).catch(() => {}); }
      }
      await page.keyboard.press('Escape');
      const openDamon = async () => { await page.locator('button[aria-label="Damon"]').click(); await panel.waitFor({ timeout: 30000 }); };
      const panel = page.locator('[data-composer-plus-todos]');
      await openDamon();
      for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: 'Gizle', exact: true }).first(); if (!(await hide.waitFor({ timeout: 2000 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
      const head = panel.locator('button.cp-td-group[data-group="suruyor"]');
      const chip = (f) => panel.locator(`button.cp-cs-chip[data-filter="${f}"]`);
      const cards = panel.locator('li.cp-cs-card[data-card="suruyor"]');
      const titles = () => cards.locator('.cp-cs-title').allInnerTexts();
      // 1. The header and the default chip.
      await until(async () => (await head.count()) === 1 && /Sürüyor\s*3\s*· sırada 6/.test(await head.innerText()), 'the Sürüyor header with both counts');
      if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
      await chip('running').waitFor({ timeout: 10000 });
      assert.equal(await panel.locator('button.cp-cs-chip').count(), 2, 'two chips, no Tümü');
      assert.equal(await panel.locator('.cp-cs-chips').getAttribute('role'), 'group');
      assert.deepEqual([await chip('running').innerText(), await chip('todo').innerText()].map((s) => s.replace(/\s+/g, ' ').trim()), ['Çalışıyor 3', "Damon'ın sırası 6"]);
      assert.equal(await chip('running').getAttribute('aria-pressed'), 'true', 'Çalışıyor is the default'); assert.equal(await chip('todo').getAttribute('aria-pressed'), 'false');
      assert.deepEqual((await titles()).sort(), [...RUNNING].sort(), 'only the running work');
      assert.deepEqual(await cards.evaluateAll((els) => els.map((e) => [e.dataset.running, e.querySelector('.cp-cs-sym').textContent, getComputedStyle(e.querySelector('.cp-cs-sym')).animationName, /\d/.test(e.querySelector('.cp-st-sub')?.textContent ?? '')])),
        RUNNING.map(() => ['true', '●', 'cp-st-pulse', true]), 'each running card: the mark that pulses and its time');
      assert.equal(await panel.locator('li.cp-cs-card[data-card="senden"]').filter({ hasText: 'ANR kur' }).count(), 1, 'the waiting item stays in Senden');
      const shot = async (name) => {
        if (!SHOTS || index !== process.argv.length - 3) return;
        const had = await page.evaluate(() => document.activeElement?.dataset.filter);
        await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(5, 5); await pause(600);
        const b = await panel.boundingBox();
        await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: b.x - 34, y: Math.max(0, b.y - 12), width: b.width + 68, height: b.height + 24 } });
        note(`SHOT ${join(SHOTS, `${name}.png`)}`);
        if (had) await chip(had).focus();
      };
      await shot('suruyor-calisiyor');
      note('1: "Sürüyor 3 · sırada 6"; two chips (Çalışıyor pressed by default); only the 3 running cards, each with the pulsing mark and its time; the waiting item in Senden');
      // 2. Keyboard: Tab reaches the chips (a visible focus ring), Enter and Space choose; a reload keeps the choice.
      await head.focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.filter), 'running', 'Tab: the first chip');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.filter), 'todo', 'Tab: the second chip');
      assert.deepEqual(await chip('todo').evaluate((b) => [b.matches(':focus-visible'), getComputedStyle(b).outlineStyle !== 'none' && parseFloat(getComputedStyle(b).outlineWidth) > 0]), [true, true], 'a visible focus ring');
      await page.keyboard.press('Enter');
      await until(async () => (await chip('todo').getAttribute('aria-pressed')) === 'true', 'Enter chooses Damon\'ın sırası');
      assert.equal(await chip('running').getAttribute('aria-pressed'), 'false');
      assert.deepEqual(await titles(), [...TODOS].reverse(), 'only Damon\'s to-dos, newest first');
      assert.deepEqual(await cards.evaluateAll((els) => [...new Set(els.map((e) => `${e.dataset.running} ${e.querySelector('.cp-cs-sym').textContent} ${getComputedStyle(e.querySelector('.cp-cs-sym')).animationName}`))]), ['false ○ none'], 'a neutral mark, no animation');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.filter), 'todo', 'the focus stays on the chip');
      await shot('suruyor-damonin-sirasi');
      await page.reload();
      if (!(await panel.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await openDamon(); }
      // Six to-dos do not fit in the first CARDS_SHOWN cards: the group can start folded (its header keeps both counts).
      await until(async () => /Sürüyor\s*3\s*· sırada 6/.test(await head.innerText()), 'the header after the reload');
      if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
      await chip('todo').waitFor({ timeout: 20000 });
      assert.equal(await chip('todo').getAttribute('aria-pressed'), 'true', 'a reload keeps the choice');
      assert.deepEqual(await titles(), [...TODOS].reverse(), 'and its cards');
      await chip('running').focus(); await page.keyboard.press(' ');
      await until(async () => (await chip('running').getAttribute('aria-pressed')) === 'true', 'Space chooses Çalışıyor');
      note('2: Tab reaches both chips (focus ring), Enter shows only the 6 to-dos (○, no animation), a reload keeps the choice, Space goes back');
      // 3. Reduced motion: no pulse.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.deepEqual([...new Set(await cards.evaluateAll((els) => els.map((e) => getComputedStyle(e.querySelector('.cp-cs-sym')).animationName)))], ['none'], 'reduced motion: the mark is still');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.deepEqual(errors, [], 'no page errors');
      note('3: reduced motion: no pulse; no page errors');
      passed = true; console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(where.home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${where.home}\n${(demo?.log ?? '').split('\n').filter((l) => /error|warn/i.test(l)).slice(-20).join('\n')}`);
      await context?.close().catch(() => {});
      if (demo) { demo.child.kill('SIGTERM'); await new Promise((r) => { if (demo.child.exitCode !== null) r(); else demo.child.once('exit', r); }); }
      if (passed) await rm(where.home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); model.close(); }
