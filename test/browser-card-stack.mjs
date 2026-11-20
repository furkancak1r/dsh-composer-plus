// Real-app check of the Damon card stack on each dsh given (scripts/demo-card-stack.mjs: a throwaway DSH_HOME and HOME,
// a fake model on 127.0.0.1, made-up projects and items). Headless, with Chromium's sandbox. Never the user's dsh home.
// 1. The Damon chat shows the card stack at the right of the chat by default (inside dsh's chat body, over no message,
//    not in dsh's right sidebar): the count bar "1 onay · 1 sorun · 2 senden · 3 sürüyor · 2 bitti" (Turkish UI), then Onay, Sorun, Senden,
//    Sürüyor, Bugün bitti (folded) and Notların (folded), in that order.
// 2. The Onay card shows the whole approval sentence with one Onayla; there is no Approve button under Damon's reply,
//    and the sentence stays in the reply as gray text (no code block).
// 3. One click on Onayla sends the exact sentence as the user's message: the model gets it as the newest user message,
//    the chat shows it as the user's message, and the button goes.
// 4. Typing in the composer hides Onayla; the card stays.
// 5. Özet getir, Projeler, the → of a note and Yaptım of a Senden card still work (nothing sent by → or Yaptım).
// 6. No page errors.
// 7. Kuyruk (phase 2): the Onay entry first, the choice (the option list of the newest answer) and the Senden cards one at
//    a time; Sonra moves an entry to the end; a choice sends "Option N: …" once; "N kalan" and "x/y cevaplandı".
// 8. Brifing: "Sıradaki tek iş · N işten 1.", four counts; Seni bekliyor opens the queue.
// 9. The place button (Furkan, 2026-11-20): Enter and Space move the stack above the chat and back, the focus stays on the
//    button, a reload keeps the choice. At 1360x770 and at 900 px, in both places: the page and the stack do not scroll
//    sideways, nothing leaves the stack, no part inside it is a box (background, shadow, border on two sides); above the
//    chat it stays in the chat column and above the messages; at the right it covers no message. Below 1000 px the stack
//    is above the chat and the button hides. SHOTS=<folder> writes the page at each place.
// PLAYWRIGHT=/path/to/playwright node test/browser-card-stack.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/assistantTodos.webp from its own demo with the English UI and English made-up data.
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
// The layout of the stack (Furkan, 2026-11-20: "box in box in box", too wide): nothing inside it leaves it sideways, the
// page does not scroll sideways, and no part inside it is a box of its own (a background, a shadow, or a border on two or
// more sides; buttons and small tags are not parts). Above the chat (`top`), it also stays inside the chat column.
const flatFaults = (page) => page.locator('[data-composer-plus-todos]').evaluate((root) => {
  const r = (el) => el.getBoundingClientRect(); const box = r(root); const faults = [];
  const name = (el) => `${el.tagName.toLowerCase()}.${typeof el.className === 'string' ? el.className.split(' ')[0] : ''}`;
  if (document.documentElement.scrollWidth > window.innerWidth + 1) faults.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
  if (root.scrollWidth > root.clientWidth + 1) faults.push(`the stack scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
  const counts = root.querySelector('[data-composer-plus-counts]');
  if (counts.scrollWidth > counts.clientWidth + 1) faults.push(`the counts are cut (${counts.textContent})`);
  const time = root.querySelector('.cp-st-time');
  if (time !== null && (time.clientWidth === 0 || time.scrollWidth > time.clientWidth + 1)) faults.push(`the list time is cut (${time.textContent})`);
  for (const el of root.querySelectorAll('*')) {
    const b = r(el); if (b.width === 0 || el.closest('.cp-st-sr, [hidden], details:not([open]) > :not(summary)')) continue;
    if (b.left < box.left - 1 || b.right > box.right + 1) faults.push(`${name(el)} leaves the stack (${Math.round(b.left)}–${Math.round(b.right)} / ${Math.round(box.left)}–${Math.round(box.right)})`);
    if (el.closest('button:not(.cp-b-tile), .cp-cs-tag, .cp-q-prog, .cp-st-skel, .cp-st-spin')) continue;
    const s = getComputedStyle(el); const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((d) => parseFloat(s[`border${d}Width`]) > 0 && s[`border${d}Style`] !== 'none');
    const bg = s.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
    if ((bg.length === 4 ? bg[3] : 1) > 0) faults.push(`${name(el)} has a background (${s.backgroundColor})`);
    if (s.boxShadow !== 'none') faults.push(`${name(el)} has a shadow`);
    if (sides.length >= 2) faults.push(`${name(el)} has a border on ${sides.join(', ')}`);
  }
  if (root.dataset.place !== 'side' || getComputedStyle(root).position !== 'absolute') {
    // The chat column: dsh's --dsh-chat-content-width, measured with a probe in the chat body.
    const probe = document.createElement('div'); probe.style.cssText = 'width:var(--dsh-chat-content-width,720px);height:0;visibility:hidden;position:absolute';
    root.parentElement.append(probe); const col = r(probe).width; probe.remove();
    if (box.width > col + 1) faults.push(`wider than the chat column (${Math.round(box.width)} > ${Math.round(col)})`);
  }
  return faults;
});
/** At the right of the chat: in the right part of the chat body, and no chat row reaches under it. */
const sideFaults = (page, sessionId) => page.evaluate((id) => {
  const root = document.querySelector('[data-composer-plus-todos]'); const body = root.parentElement; const b = root.getBoundingClientRect(); const c = body.getBoundingClientRect();
  const faults = [];
  if (getComputedStyle(root).position !== 'absolute' || b.right > c.right + 1 || b.left < c.left + c.width / 2) faults.push(`not at the right of the chat (${JSON.stringify([b.left, b.right])} in ${JSON.stringify([c.left, c.right])})`);
  // The 300px header: the counts have their own line (a narrow column broke them into one word per line).
  const head = root.querySelector('.cp-st-top > h2').getBoundingClientRect(); const top = root.querySelector('.cp-st-top').getBoundingClientRect();
  if (head.width < top.width - 12) faults.push(`the counts have no line of their own (${Math.round(head.width)} of ${Math.round(top.width)})`);
  for (const row of document.querySelectorAll(`[data-conversation-session="${id}"] [data-chat-node-key]`)) {
    const n = row.getBoundingClientRect(); if (n.width > 0 && n.bottom > b.top && n.top < b.bottom && n.right > b.left + 1) faults.push(`a chat row reaches under the stack (${Math.round(n.right)} > ${Math.round(b.left)})`);
  }
  return faults;
}, sessionId);
/** Above the chat: the stack ends above the chat's scroll body, at most 40% of the window high. */
const topFaults = (page, sessionId) => page.evaluate((id) => {
  const root = document.querySelector('[data-composer-plus-todos]'); const b = root.getBoundingClientRect();
  const s = document.querySelector(`[data-conversation-session="${id}"] [data-conversation-scroll]`).getBoundingClientRect();
  return [...(getComputedStyle(root).position === 'absolute' ? ['not in the flow above the chat'] : []), ...(b.bottom > s.top + 1 ? [`over the chat (${b.bottom} > ${s.top})`] : []),
    ...(b.height > window.innerHeight * 0.4 + 2 ? [`higher than 40% (${b.height})`] : [])];
}, sessionId);
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
      // 1. At the right of the chat by default (Furkan, 2026-11-20), in the chat body; the count bar; the order of the groups.
      assert.equal(await stack.evaluate((el) => el.parentElement?.hasAttribute('data-conversation-content')), true, 'in dsh\'s chat body');
      assert.equal(await stack.getAttribute('data-place'), 'side', 'the right side by default');
      assert.deepEqual(await sideFaults(page, sessionId), [], 'at the right of the chat, over no message');
      const counts = stack.locator('[data-composer-plus-counts]');
      // dsh before 0.2.2 has no background subagents: the two long tasks of the seed end at once there.
      const want = background ? '1 onay · 1 sorun · 2 senden · 3 sürüyor · 2 bitti' : '1 onay · 1 sorun · 2 senden · 1 sürüyor · 4 bitti';
      await until(async () => (await counts.innerText()).trim() === want, `the count bar (${await counts.innerText()})`, 20000);
      const order = await stack.evaluate((el) => [...el.querySelectorAll('[data-card="onay"][role="region"], section[data-group]')].map((n) => n.dataset.card ?? n.dataset.group));
      assert.deepEqual(order, ['onay', 'sorun', 'senden', 'suruyor', 'bitti', 'notes'], 'the order of the stack');
      assert.equal(await stack.locator('[data-group="bitti"] button[aria-expanded]').getAttribute('aria-expanded'), 'false', 'Bugün bitti starts folded');
      assert.equal(await stack.locator('[data-group="notes"] button[aria-expanded]').getAttribute('aria-expanded'), 'false', 'Notların starts folded');
      note('1: the stack at the right of the chat (the default), the count bar, the order (Bugün bitti and Notların folded)');
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
      // 7. Phase 2: the decision queue. The answer to the approval ends with an option list: the queue has the choice and
      // the two Senden cards (the Onay items still wait: the Onay card stays first, without Onayla now).
      await stack.locator('[data-view-button="queue"]').click();
      const queue = stack.locator('section[data-view="queue"]');
      await queue.waitFor({ timeout: 10000 });
      const entry = () => queue.locator('[data-queue-entry]').getAttribute('data-queue-entry');
      await until(async () => (await queue.innerText()).includes('4 kalan'), `the queue head (${await queue.innerText().catch(() => '')})`, 20000);
      assert.equal(await entry(), 'onay', 'the Onay entry first');
      assert.equal(await stack.locator('[data-card="onay"][role="region"]').count(), 1, 'one Onay card on screen');
      await queue.getByRole('button', { name: 'Sonraki', exact: true }).click();
      assert.equal(await entry(), 'karar', 'Sonraki: the choice');
      const choiceBtn = queue.locator('[data-composer-plus-choice="2"]');
      assert.equal((await choiceBtn.innerText()).trim(), '2. Yarın sabah denensin');
      // Sonra moves the choice to the end; Önceki goes back.
      await queue.getByRole('button', { name: 'Sonra', exact: true }).click();
      await until(async () => (await entry()) !== 'karar', 'Sonra moves the choice');
      const seenOrder = [];
      for (let i = 0; i < 4; i++) { seenOrder.push(await entry()); const next = queue.getByRole('button', { name: 'Sonraki', exact: true }); if (await next.isDisabled()) break; await next.click(); }
      assert.equal(seenOrder.at(-1), 'karar', `the choice is at the end (${seenOrder})`);
      // The choice sends "Option 2: …" once, as the button under the answer does.
      const before7 = calls.length;
      await choiceBtn.click(); await choiceBtn.click({ timeout: 1000 }).catch(() => {});
      await until(() => calls.slice(before7).some((c) => c.newest === 'Option 2: Yarın sabah denensin'), 'the model got the choice');
      await pause(1500);
      assert.equal(calls.slice(before7).filter((c) => c.newest === 'Option 2: Yarın sabah denensin' && c.step === 0).length, 1, 'one message for the choice');
      await until(async () => (await queue.innerText()).includes('3 kalan'), 'the choice left the queue');
      assert.match(await queue.innerText(), /1\/4 cevaplandı/, 'x/y cevaplandı');
      note('7: Kuyruk: Onay first, then the choice (Sonraki); Sonra moves it to the end; the choice sent "Option 2" once; 3 kalan, 1/4 cevaplandı');
      // 8. The briefing: the next entry, four counts; Seni bekliyor opens the queue.
      await stack.locator('[data-view-button="brief"]').click();
      const brief = stack.locator('section[data-view="brief"]');
      await brief.waitFor({ timeout: 10000 });
      assert.match(await brief.innerText(), /Sıradaki tek iş · 3 işten 1\./);
      assert.deepEqual(await brief.locator('[data-tile]').evaluateAll((els) => els.map((e) => e.dataset.tile)), ['senden', 'sorun', 'suruyor', 'bitti']);
      await brief.locator('[data-tile="senden"]').click();
      await queue.waitFor({ timeout: 10000 });
      await stack.locator('[data-view-button="stack"]').click();
      note('8: Brifing: Sıradaki tek iş · 3 işten 1., four counts, Seni bekliyor opens the queue');
      // 9. The place button (Furkan, 2026-11-20): keyboard only; the choice stays after a reload; both places are flat, do
      // not scroll sideways and stay in their room, at 1360x770 (the screenshot's window) and at 900 px.
      const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${version}-${name}.png`) }); };
      await stack.locator('[data-view-button="brief"]').click(); await brief.waitFor({ timeout: 10000 });
      await page.setViewportSize({ width: 1360, height: 770 }); await pause(300);
      const place = stack.locator('[data-place-button]');
      assert.equal(await place.getAttribute('aria-label'), 'Sohbetin üstünde göster', 'its name says where it moves the panel');
      assert.deepEqual([...await flatFaults(page), ...await sideFaults(page, sessionId)], [], 'right side, 1360x770: flat, at the right, over no message');
      await shot('side-1360');
      await place.focus(); await page.keyboard.press('Enter');
      await until(async () => (await stack.getAttribute('data-place')) === 'top', 'Enter moves the panel above the chat');
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-place-button')), true, 'the focus stays on the button');
      assert.equal(await place.getAttribute('aria-label'), 'Sağ panelde göster');
      await page.keyboard.press(' ');
      await until(async () => (await stack.getAttribute('data-place')) === 'side', 'Space moves it back to the right');
      await page.keyboard.press('Enter'); await until(async () => (await stack.getAttribute('data-place')) === 'top', 'above again');
      await page.reload();
      if (!(await stack.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await page.locator('button[aria-label="Damon"]').click(); await stack.waitFor({ timeout: 30000 }); }
      assert.equal(await stack.getAttribute('data-place'), 'top', 'a reload keeps the place above the chat');
      await brief.waitFor({ timeout: 10000 }); await pause(500);
      assert.deepEqual([...await flatFaults(page), ...await topFaults(page, sessionId)], [], 'above the chat, 1360x770: flat, in the chat column, above the chat');
      await shot('top-1360');
      await page.setViewportSize({ width: 900, height: 770 }); await pause(300);
      assert.deepEqual([...await flatFaults(page), ...await topFaults(page, sessionId)], [], 'above the chat, 900 px: flat, no sideways scroll');
      assert.equal(await place.isVisible(), false, 'below 1000 px the place button hides');
      await shot('top-900');
      await stack.locator('[data-view-button="stack"]').click(); await pause(300);
      assert.deepEqual(await flatFaults(page), [], 'the cards above the chat, 900 px: flat');
      await page.setViewportSize({ width: 1360, height: 770 }); await pause(300);
      await place.click(); await until(async () => (await stack.getAttribute('data-place')) === 'side', 'a click moves it to the right');
      await page.reload();
      if (!(await stack.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await page.locator('button[aria-label="Damon"]').click(); await stack.waitFor({ timeout: 30000 }); }
      assert.equal(await stack.getAttribute('data-place'), 'side', 'a reload keeps the right side');
      await pause(500);
      assert.deepEqual([...await flatFaults(page), ...await sideFaults(page, sessionId)], [], 'the cards at the right, 1360x770: flat, over no message');
      await shot('side-cards-1360');
      await page.setViewportSize({ width: 900, height: 770 }); await pause(300);
      assert.deepEqual([...await flatFaults(page), ...await topFaults(page, sessionId)], [], 'the right side at 900 px shows above the chat: flat, no sideways scroll');
      await page.setViewportSize({ width: 1280, height: 900 });
      note('9: the place button: Enter and Space, the focus stays, a reload keeps it; flat and no sideways scroll at 1360x770 and 900 px (both places)');
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
  // The Settings shot (SHOT=1): its own throwaway demo with the English UI and English made-up data (AGENTS.md rule 2),
  // on the last dsh given.
  if (process.env.SHOT) {
    const enModel = await fakeModel([], 'en');
    const where = await demoHome(enModel.address().port);
    let demo; let shotContext;
    try {
      demo = await startDemo(process.argv.at(-1), where, 3399);
      await seed(demo.url, { model: enModel });
      shotContext = await browser.newContext({ locale: 'en-US', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await shotContext.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      const shot = await shotContext.newPage(); await shot.goto(demo.url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = shot.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) await b.click(); }
      await shot.keyboard.press('Escape'); await shot.locator('button[aria-label="Damon"]').click();
      // The optional setup and memory import cards are not part of this feature: hide each for the picture.
      for (let n = 0; n < 3; n++) { const hide = shot.getByRole('button', { name: 'Hide', exact: true }).first(); if (!(await hide.waitFor({ timeout: 3000 }).then(() => true, () => false))) break; await hide.click(); await pause(500); }
      await shot.locator('[data-composer-plus-todos] [data-composer-plus-approve="card"]').waitFor({ timeout: 20000 });
      await pause(1500); await shot.mouse.move(640, 790);
      const png = join(where.home, 'stack.png'); await shot.screenshot({ path: png });
      execFileSync('cwebp', ['-quiet', '-q', '72', '-resize', '960', '0', png, '-o', join(repo, 'assets/features/assistantTodos.webp')]);
      console.log('  SHOT: assets/features/assistantTodos.webp');
    } finally {
      await shotContext?.close().catch(() => {});
      if (demo) { demo.child.kill('SIGTERM'); await new Promise((r) => { if (demo.child.exitCode !== null) r(); else demo.child.once('exit', r); }); }
      enModel.close(); await rm(where.home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); model.close(); }
