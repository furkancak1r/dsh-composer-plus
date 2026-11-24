// Real-app check of the dismissed task cards (Furkan, 2026-11-24: a failed task "hâlâ listede takılı kaldı"), on each dsh
// given, with the card stack demo (scripts/demo-card-stack.mjs: a throwaway DSH_HOME and HOME, a fake model on 127.0.0.1,
// made-up items). Headless, with Chromium's sandbox. Never the user's dsh home.
// 1. Two subagents of the Damon chat fail (the fake model answers HTTP 400): two Sorun cards.
// 2. × on the first card hides it, the Host keeps it (a second browser context has no such card), no message is sent.
// 3. "Damon'a sor" (→) of the second card writes its data ("Görev: …") into the composer; it is sent. The fake model, as
//    the prompt rule asks, starts a replacement and calls todo_list_remove with task in the same turn: the card leaves the
//    stack, for this page and the Host (no click on ×).
// 4. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-dismiss-task.mjs /path/to/dsh/lib/bin.js [...]
// SHOTS=<folder> writes the stack before and after each dismiss.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeModel, demoHome, startDemo, seed, rpcOf } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const calls = [];
const model = await fakeModel(calls);
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const where = await demoHome(model.address().port);
    let demo; let context; let page; let passed = false; const errors = [];
    const note = (line) => console.log(`  ${line}`);
    try {
      demo = await startDemo(bin, where, 3320 + index);
      const { sessionId } = await seed(demo.url, { model });
      const { rpc, get } = await rpcOf(demo.url);
      const status = () => get(`/api/composer-plus.assistant-todos?sessionId=${encodeURIComponent(sessionId)}`);
      await rpc('session/prompt', { request: { requestId: `fail-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: 'DEMO-FAILED-TASKS' }] } });
      await until(async () => ((await status()).tasks ?? []).filter((t) => t.state === 'failed').length === 2, 'two failed tasks', 60000);
      const failed = (await status()).tasks.filter((t) => t.state === 'failed');
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1360, height: 900 }, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(demo.url);
      for (const name of [/^(Continue|Devam)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }).catch(() => {}); }
      }
      await page.keyboard.press('Escape');
      await page.locator('button[aria-label="Damon"]').click();
      const stack = page.locator('[data-composer-plus-todos]');
      await stack.waitFor({ timeout: 30000 });
      const sorun = (title) => stack.locator(`[data-card="sorun"][data-key="${failed.find((t) => t.title === title).id}"]`);
      const shot = async (name) => { if (process.env.SHOTS) await stack.screenshot({ path: join(process.env.SHOTS, `${version}-${name}.png`) }); };
      // 1. Two Sorun cards of the failed tasks (with the provider error as their line).
      await until(async () => (await sorun('Derleme kontrolü').count()) === 1 && (await sorun('Rapor dışa aktarma').count()) === 1, 'two failed task cards');
      await pause(500); await shot('1-sorun-iki-hatali-kart');
      note('1: two failed subagents: two Sorun cards');
      // 2. × of the first card: hidden here, kept by the Host (another browser context does not show it), nothing sent.
      const before = calls.length;
      await sorun('Derleme kontrolü').locator('[data-act="close"]').click();
      await until(async () => (await sorun('Derleme kontrolü').count()) === 0, '× hides the card');
      await until(async () => !(await status()).tasks.some((t) => t.title === 'Derleme kontrolü'), 'the Host leaves the dismissed task out');
      const other = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1360, height: 900 } });
      try {
        const p2 = await other.newPage(); await p2.goto(demo.url);
        for (const name of [/^(Continue|Devam)$/, /^(Configure later|Daha sonra yapılandır)$/]) { const b = p2.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) await b.click(); }
        await p2.keyboard.press('Escape'); await p2.locator('button[aria-label="Damon"]').click();
        const s2 = p2.locator('[data-composer-plus-todos]'); await s2.waitFor({ timeout: 30000 });
        await until(async () => (await s2.locator('[data-card="sorun"]').filter({ hasText: 'Rapor dışa aktarma' }).count()) === 1, 'the other browser reads the stack');
        assert.equal(await s2.locator('[data-card="sorun"]').filter({ hasText: 'Derleme kontrolü' }).count(), 0, 'another browser (no localStorage key) does not show the dismissed card');
      } finally { await other.close(); }
      assert.equal(calls.length, before, '× sends no message');
      await shot('2-x-sonrasi');
      note('2: × hides the card here and in another browser (the Host list); nothing sent');
      // 3. → (Damon'a sor) of the second card, then send: Damon starts a replacement and dismisses the card itself.
      await sorun('Rapor dışa aktarma').locator('[data-act="main"]').click();
      const input = page.locator('[data-composer-input]');
      await until(async () => (await input.innerText()).includes('Görev: Rapor dışa aktarma'), '→ writes the card data');
      assert.match(await input.innerText(), /Durum: Hata verdi/);
      await input.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
      await until(() => calls.some((c) => /^Görev: Rapor dışa aktarma/m.test(c.newest)), 'the model got the card');
      await until(async () => (await sorun('Rapor dışa aktarma').count()) === 0, 'Damon\'s todo_list_remove takes the card away', 30000);
      await until(async () => (await status()).tasks.some((t) => t.title === 'Rapor dışa aktarma (yeniden)'), 'the replacement task runs or ended');
      assert.equal((await status()).tasks.some((t) => t.title === 'Rapor dışa aktarma'), false, 'the Host leaves it out');
      await pause(800); await shot('3-damon-kaldirdi');
      note('3: the sent card: Damon started a replacement and dismissed the card in the same turn (no × click)');
      assert.deepEqual(errors, [], 'no page errors');
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
