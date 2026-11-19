// Real-app check of the Damon card stack on each dsh given (scripts/demo-card-stack.mjs: a throwaway DSH_HOME and HOME,
// a fake model on 127.0.0.1, made-up projects and items). Headless, with Chromium's sandbox. Never the user's dsh home.
// 1. The Damon chat shows the card stack above the chat (inside dsh's chat body, above the messages, not at its right):
//    the count bar "1 onay · 1 sorun · 2 senden · 3 sürüyor · 2 bitti" (Turkish UI), then Onay, Sorun, Senden,
//    Sürüyor, Bugün bitti (folded) and Notların (folded), in that order.
// 2. The Onay card shows the whole approval sentence with one Onayla; there is no Approve button under Damon's reply,
//    and the sentence stays in the reply as gray text (no code block).
// 3. One click on Onayla sends the exact sentence as the user's message: the model gets it as the newest user message,
//    the chat shows it as the user's message, and the button goes.
// 4. Typing in the composer hides Onayla; the card stays.
// 5. Özet getir, Projeler, the → of a note and Yaptım of a Senden card still work (nothing sent by → or Yaptım).
// 6. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-card-stack.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/assistantTodos.webp (Turkish UI is used for the checks; the shot uses English).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APPROVAL, fakeModel, demoHome, startDemo, seed } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
const calls = [];
const model = await fakeModel(calls);
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
let shotDone = false;
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const where = await demoHome(model.address().port);
    let demo; let context; let page; let passed = false; const errors = [];
    const note = (line) => console.log(`  ${line}`);
    try {
      demo = await startDemo(bin, where, 3300 + index);
      const { sessionId, background } = await seed(demo.url, { model });
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
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
      // 1. Above the chat, in the chat body; the count bar; the order of the groups.
      assert.equal(await stack.evaluate((el) => el.parentElement?.hasAttribute('data-conversation-content')), true, 'in dsh\'s chat body');
      const box = await stack.boundingBox(); const scroll = await page.locator(`[data-conversation-session="${sessionId}"] [data-conversation-scroll]`).boundingBox();
      assert.ok(box.y + box.height <= scroll.y + 1, `above the chat (${JSON.stringify(box)} / ${JSON.stringify(scroll)})`);
      const counts = stack.locator('[data-composer-plus-counts]');
      // dsh before 0.2.2 has no background subagents: the two long tasks of the seed end at once there.
      const want = background ? '1 onay · 1 sorun · 2 senden · 3 sürüyor · 2 bitti' : '1 onay · 1 sorun · 2 senden · 1 sürüyor · 4 bitti';
      await until(async () => (await counts.innerText()).trim() === want, `the count bar (${await counts.innerText()})`, 20000);
      const order = await stack.evaluate((el) => [...el.querySelectorAll('[data-card="onay"][role="region"], section[data-group]')].map((n) => n.dataset.card ?? n.dataset.group));
      assert.deepEqual(order, ['onay', 'sorun', 'senden', 'suruyor', 'bitti', 'notes'], 'the order of the stack');
      assert.equal(await stack.locator('[data-group="bitti"] button[aria-expanded]').getAttribute('aria-expanded'), 'false', 'Bugün bitti starts folded');
      assert.equal(await stack.locator('[data-group="notes"] button[aria-expanded]').getAttribute('aria-expanded'), 'false', 'Notların starts folded');
      assert.ok(box.height <= 900 * 0.4 + 2, `at most 40% of the window (${box.height})`);
      note('1: the stack above the chat, the count bar, the order (Bugün bitti and Notların folded)');
      // 2. The Onay card: the whole sentence and one Onayla; none under the reply; the sentence in the reply as gray text.
      const onay = stack.locator('[data-card="onay"][role="region"]');
      await until(async () => (await onay.innerText()).includes(APPROVAL), 'the whole sentence in the Onay card');
      const approve = onay.locator('[data-composer-plus-approve="card"]');
      await approve.waitFor({ timeout: 20000 });
      assert.equal(await approve.count(), 1, 'one Onayla'); assert.equal((await approve.innerText()).trim(), 'Onayla');
      assert.equal(await page.locator('[data-composer-plus-approve]:not([data-composer-plus-approve="card"])').count(), 0, 'no Approve button under the reply');
      assert.equal(await page.locator('.md-code-block[data-composer-plus-onay="text"]').count(), 1, 'the sentence in the reply: gray text');
      assert.equal(await page.locator('.md-code-block[data-composer-plus-onay="button"]').count(), 0);
      note('2: the Onay card has the whole sentence and one Onayla; the reply has none (gray text)');
      // 4 first: typing hides Onayla, the card stays.
      const input = page.locator('[data-composer-input]');
      await input.click(); await page.keyboard.type('x', { delay: 5 });
      await until(async () => (await approve.count()) === 0, 'Onayla hides while you type');
      assert.ok(await onay.isVisible(), 'the card stays');
      await page.keyboard.press('Backspace'); await approve.waitFor({ timeout: 10000 });
      note('4: typing hides Onayla, the card stays; an empty composer brings it back');
      // 5. → of a note and Yaptım of a Senden card write into the composer and send nothing.
      const before = calls.length;
      await stack.locator('[data-group="notes"] button[aria-expanded]').click();
      await stack.getByRole('button', { name: 'Asistana devret: Kırtasiye siparişini ver', exact: true }).click();
      await until(async () => (await input.innerText()).includes('Bunu sen yap: Kırtasiye siparişini ver'), '→ writes the hand-over');
      await stack.locator('[data-card="senden"]').filter({ hasText: 'Gerekli Tarih alanını aç' }).getByRole('button', { name: 'Yaptım', exact: true }).click();
      await until(async () => (await input.innerText()).includes('Yaptım: Test sunucusunda Gerekli Tarih alanını aç'), 'Yaptım writes the step');
      await pause(1200); assert.equal(calls.length, before, 'nothing sent');
      // Projeler: the projects of the last 24 hours (the demo has no other chat: the empty line), in view.
      await stack.getByRole('button', { name: 'Projeler', exact: true }).click();
      const projects = stack.locator('section[aria-labelledby$="-projects-h"]');
      await projects.waitFor({ timeout: 10000 });
      const inView = () => projects.locator('h3').evaluate((el) => { const b = el.getBoundingClientRect(); const s = el.closest('.cp-st-body').getBoundingClientRect(); return { ok: b.top >= s.top - 1 && b.top < s.bottom, b: [b.top, b.bottom], s: [s.top, s.bottom] }; });
      await until(async () => (await inView()).ok, `the projects in view (${JSON.stringify(await inView())})`);
      await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.press('Escape');
      await approve.waitFor({ timeout: 10000 });
      note('5: → and Yaptım write into the composer, nothing sent; Projeler opens the projects');
      // 3. Onayla sends the exact sentence as the user's message, once.
      const sent = calls.length;
      await approve.click(); await approve.click({ timeout: 1000 }).catch(() => {});
      await until(() => calls.slice(sent).some((c) => c.newest === APPROVAL), 'the model got the sentence as the user\'s message');
      await until(async () => (await page.locator('[data-chat-node-key]').filter({ hasText: APPROVAL }).count()) >= 2, 'the chat shows the user\'s message');
      await pause(1500);
      // dsh 0.2.0 puts its runtime context after the message, so count the first step of the turn (no tool result yet).
      assert.equal(calls.slice(sent).filter((c) => c.newest === APPROVAL && c.step === 0).length, 1, `one user message: ${JSON.stringify(calls.slice(sent).map((c) => [c.newest.slice(0, 40), c.step]))}`);
      await until(async () => (await approve.count()) === 0, 'the button goes after the send');
      note('3: Onayla sent the exact sentence once as the user\'s message; the model got it; the button went');
      if (process.env.SHOT && !shotDone) {
        const png = join(where.home, 'stack.png'); await page.screenshot({ path: png });
        execFileSync('cwebp', ['-quiet', '-q', '72', '-resize', '960', '0', png, '-o', join(repo, 'assets/features/assistantTodos.webp')]);
        shotDone = true; note('SHOT: assets/features/assistantTodos.webp');
      }
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
