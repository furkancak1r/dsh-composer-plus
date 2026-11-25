// Real-app check of the Damon card stack on each dsh given (scripts/demo-card-stack.mjs: a throwaway DSH_HOME and HOME,
// a fake model on 127.0.0.1, made-up projects and items). Headless, with Chromium's sandbox. Never the user's dsh home.
// 1. The Damon chat shows the card stack at the right of the chat by default (inside dsh's chat body, over no message,
//    not in dsh's right sidebar): the count bar "1 onay · 1 sorun · 2 senden · 2 sürüyor · sırada 1 · 2 bitti" (Turkish UI), then Onay, Sorun, Senden,
//    Sürüyor, Bugün bitti (folded) and the Kararlar button (your notes), in that order.
// 2. The Onay card shows the whole approval sentence with one Onayla; there is no Approve button under Damon's reply,
//    and the sentence stays in the reply as gray text (no code block).
// 3. One click on Onayla sends the exact sentence as the user's message: the model gets it as the newest user message,
//    the chat shows it as the user's message, and the button goes.
// 4. Typing in the composer hides Onayla; the card stays.
// 5. Özet getir, Projeler and Yaptım of a Senden card still work (nothing sent by Yaptım).
// 6. No page errors.
// 7. One list (Furkan, 2026-11-23): no Kartlar/Kuyruk/Brifing switch; after the send the Onay card and its count go (no
//    Onayla: Furkan, 2026-11-25); the choice (the option list of the newest answer) is the first Senden card and the
//    active item (the only card with a left line), its → focuses the buttons under the answer (one set on screen) and the
//    answer's numbered list is hidden while they show; 2 sends "Option 2: …" once.
// 8. The cards have icon buttons (each with its name as the tooltip) and no İzle.
// 9. The place button (Furkan, 2026-11-20): Enter and Space move the stack above the chat and back, the focus stays on the
//    button, a reload keeps the choice. At 1360x770 and at 900 px, in both places: the page and the stack do not scroll
//    sideways, nothing leaves the stack, no part inside it is a box (background, shadow, border on two sides); above the
//    chat it stays in the chat column and above the messages; at the right it covers no message. Below 1000 px the stack
//    is above the chat and the button hides. SHOTS=<folder> writes the page at each place.
// 10. Kararlar (Furkan, 2026-11-24): the notes are one button with the count of decisions (a badge) and of the other
//    notes. A click opens a modal dialog over the whole page (the top layer, a blurred backdrop, the chat inert): one
//    decision card with its options; one click sends "Karar: <item> → <option>" once as the user's message and shows the
//    next card at once; → skips; a decision without options says so; Esc closes the dialog and
//    the focus goes back to the button. The notes: Yaptım sends "Not tamam: <item>", Sil (keyboard) removes a note on
//    the Host without a message. DECIDE_SHOTS=<folder> writes the screenshots of the dialog.
// PLAYWRIGHT=/path/to/playwright node test/browser-card-stack.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/assistantTodos.webp from its own demo with the English UI and English made-up data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APPROVAL, DECISIONS, fakeModel, demoHome, startDemo, seed, rpcOf } from '../scripts/demo-card-stack.mjs';
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
    if (el.closest('button, summary, .cp-cs-tag, .cp-st-skel, .cp-st-spin')) continue;
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
      // The chat shows (Sohbeti göster): this check reads the buttons and the list under Damon's reply. The reply cards
      // that cover the chat by default are checked in test/browser-status-canvas.mjs.
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.assistant-chat-shown') === null) localStorage.setItem('dsh-composer-plus.assistant-chat-shown', '1'); });
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
      // Sürüyor counts what runs; Damon's item without a task is "sırada" (the Sürüyor filter, 2026-11-24).
      const want = background ? '1 onay · 1 sorun · 2 senden · 2 sürüyor · sırada 1 · 2 bitti' : '1 onay · 1 sorun · 2 senden · sırada 1 · 4 bitti';
      await until(async () => (await counts.innerText()).trim() === want, `the count bar (${await counts.innerText()})`, 20000);
      const order = await stack.evaluate((el) => [...el.querySelectorAll('[data-card="onay"][role="region"], section[data-group]')].map((n) => n.dataset.card ?? n.dataset.group));
      assert.deepEqual(order, ['onay', 'sorun', 'senden', 'suruyor', 'bitti', 'notes'], 'the order of the stack');
      assert.equal(await stack.locator('button.cp-td-group[data-group="bitti"]').getAttribute('aria-expanded'), 'false', 'Bugün bitti starts folded');
      const decide = stack.locator('button.cp-dc-open');
      assert.equal(await decide.getAttribute('aria-label'), 'Kararlar: 0 karar ve 2 not bekliyor. Karar kartlarını aç', 'the Kararlar button counts your notes');
      note('1: the stack at the right of the chat (the default), the count bar, the order (Bugün bitti folded, the Kararlar button last)');
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
      // 5. Yaptım of a Senden card writes into the composer and sends nothing.
      const before = calls.length;
      await stack.locator('[data-card="senden"]').filter({ hasText: 'Gerekli Tarih alanını aç' }).getByRole('button', { name: 'Yaptım: Test sunucusunda Gerekli Tarih alanını aç', exact: true }).click();
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
      note('5: Yaptım writes into the composer, nothing sent; Projeler opens the projects');
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
      // 7. One list: the sentence went, so the Onay card goes with its button (Furkan, 2026-11-25: its "Onay:" items show
      // nothing without a button); the answer to the approval ends with an option list: the choice is the first Senden
      // card and the active item; its buttons are only under the answer, and the answer's list is hidden.
      assert.equal(await stack.locator('[data-view-button], section[data-view]').count(), 0, 'one list: no view switch');
      const activeOf = () => stack.locator('[data-active]').evaluateAll((els) => els.map((e) => e.dataset.card));
      await until(async () => (await stack.locator('[data-card="karar"]').count()) === 1, 'the choice card', 20000);
      await until(async () => (await onay.count()) === 0, 'no Onayla: no Onay card');
      assert.doesNotMatch(await counts.innerText(), /onay/, 'no "onay" in the count bar');
      assert.deepEqual(await activeOf(), ['karar'], 'the choice is the active item');
      const lines = await stack.locator('.cp-cs-card').evaluateAll((els) => els.filter((e) => e.offsetParent !== null).map((e) => [e.dataset.card, getComputedStyle(e).borderLeftColor]));
      const clear = lines.filter(([card]) => card !== 'karar').map(([, c]) => c);
      assert.ok(clear.every((c) => c === 'rgba(0, 0, 0, 0)'), `only the active item has a left line (${JSON.stringify(lines)})`);
      assert.notEqual(lines.find(([card]) => card === 'karar')[1], 'rgba(0, 0, 0, 0)', 'the active item has its line');
      const picks = page.locator('[data-composer-plus-option-picks] button');
      assert.equal(await picks.count(), 2, 'the option buttons under the answer');
      assert.equal(await stack.locator('[data-composer-plus-choice]').count(), 0, 'no second set in the panel');
      const lists = () => page.locator('[data-chat-node-key]').filter({ hasText: 'Servis betiği ne zaman denensin?' }).locator('ol').evaluateAll((els) => els.map((e) => getComputedStyle(e).display));
      assert.deepEqual(await lists(), ['none'], 'the answer\'s numbered list is hidden: the options show once, as buttons');
      assert.equal(await picks.nth(1).getAttribute('title'), 'Yarın sabah denensin', 'the whole item in the tooltip');
      // For you can start folded (the stack shows CARDS_SHOWN cards before it folds a group): open it.
      const sendenHead = stack.locator('button.cp-td-group[data-group="senden"]');
      if ((await sendenHead.getAttribute('aria-expanded')) !== 'true') await sendenHead.click();
      await stack.locator('[data-card="karar"] [data-act="main"]').click();
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-composer-plus-option-picks]') !== null), true, '→ focuses the buttons under the answer');
      // The choice is active; after 800 ms, 2 sends "Option 2: …" once.
      await stack.locator('.cp-td-head').focus();
      assert.deepEqual(await activeOf(), ['karar'], 'the choice is still active');
      await pause(1000);
      const before7 = calls.length;
      await page.keyboard.press('2'); await page.keyboard.press('2');
      await until(() => calls.slice(before7).some((c) => c.newest === 'Option 2: Yarın sabah denensin'), 'the model got the choice');
      await pause(1500);
      assert.equal(calls.slice(before7).filter((c) => c.newest === 'Option 2: Yarın sabah denensin' && c.step === 0).length, 1, 'one message for the choice');
      await until(async () => (await stack.locator('[data-card="karar"]').count()) === 0, 'the choice left the list');
      note('7: one list: after the send no Onay card and no "onay" count; the choice is the first Senden card and active (the only left line); its buttons only under the answer, whose list is hidden; 2 sent "Option 2" once');
      // 8. Icon buttons: each has a name and the same tooltip; no İzle.
      const unnamed = await stack.locator('.cp-cs-card button.cp-td-btn').evaluateAll((els) => els.filter((b) => !b.getAttribute('aria-label') || b.title !== b.getAttribute('aria-label')).length);
      assert.equal(unnamed, 0, 'each icon button has its name as its tooltip');
      assert.equal(await stack.getByRole('button', { name: 'İzle', exact: true }).count(), 0, 'no İzle');
      note('8: icon buttons with names and tooltips; no İzle');
      // 9. The place button (Furkan, 2026-11-20): keyboard only; the choice stays after a reload; both places are flat, do
      // not scroll sideways and stay in their room, at 1360x770 (the screenshot's window) and at 900 px.
      const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${version}-${name}.png`) }); };
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
      await pause(500);
      assert.deepEqual([...await flatFaults(page), ...await topFaults(page, sessionId)], [], 'above the chat, 1360x770: flat, in the chat column, above the chat');
      await shot('top-1360');
      await page.setViewportSize({ width: 900, height: 770 }); await pause(300);
      assert.deepEqual([...await flatFaults(page), ...await topFaults(page, sessionId)], [], 'above the chat, 900 px: flat, no sideways scroll');
      assert.equal(await place.isVisible(), false, 'below 1000 px the place button hides');
      await shot('top-900');
      await page.setViewportSize({ width: 1360, height: 770 }); await pause(300);
      await place.click(); await until(async () => (await stack.getAttribute('data-place')) === 'side', 'a click moves it to the right');
      await page.reload();
      if (!(await stack.waitFor({ timeout: 10000 }).then(() => true, () => false))) { await page.keyboard.press('Escape'); await page.locator('button[aria-label="Damon"]').click(); await stack.waitFor({ timeout: 30000 }); }
      assert.equal(await stack.getAttribute('data-place'), 'side', 'a reload keeps the right side');
      await pause(500);
      assert.deepEqual([...await flatFaults(page), ...await sideFaults(page, sessionId)], [], 'the cards at the right, 1360x770: flat, over no message');
      await shot('side-cards-1360');
      // Folded at the right, the header and the Onay card still show: they cover no message either (review).
      const head = stack.locator('.cp-td-head'); await head.click();
      await until(async () => (await stack.getAttribute('data-open')) === 'false', 'folded');
      assert.deepEqual(await sideFaults(page, sessionId), [], 'folded at the right: over no message');
      await head.click(); await until(async () => (await stack.getAttribute('data-open')) === 'true', 'open again');
      await page.setViewportSize({ width: 900, height: 770 }); await pause(300);
      assert.deepEqual([...await flatFaults(page), ...await topFaults(page, sessionId)], [], 'the right side at 900 px shows above the chat: flat, no sideways scroll');
      await page.setViewportSize({ width: 1280, height: 900 });
      note('9: the place button: Enter and Space, the focus stays, a reload keeps it; flat and no sideways scroll at 1360x770 and 900 px (both places)');
      // 10. Kararlar: the decision notes come (the demo's DEMO-DECISIONS); the button's badge counts them.
      const { rpc } = await rpcOf(demo.url);
      await rpc('session/prompt', { request: { requestId: `decide-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: 'DEMO-DECISIONS' }] } });
      const badge = decide.locator('[data-decide-count]');
      await until(async () => (await badge.count()) === 1 && (await badge.innerText()).trim() === String(DECISIONS.length), 'the badge counts the decisions', 30000);
      assert.equal(await decide.getAttribute('aria-label'), `Kararlar: ${DECISIONS.length} karar ve 2 not bekliyor. Karar kartlarını aç`);
      const decideShot = async (name) => {
        if (!process.env.DECIDE_SHOTS || index !== 0) return;
        const path = join(process.env.DECIDE_SHOTS, `${name}.png`); await page.screenshot({ path }); console.log(`  ${path}`);
      };
      await page.mouse.move(5, 5); await pause(600);
      await decideShot('1-panel-butonu');
      await decide.click();
      const dlg = page.locator('dialog[data-composer-plus-decide]');
      await dlg.waitFor({ timeout: 10000 });
      const modal = await dlg.evaluate((d) => ({ open: d.open, modal: d.matches(':modal'), label: document.getElementById(d.getAttribute('aria-labelledby'))?.textContent,
        filter: getComputedStyle(d, '::backdrop').backdropFilter }));
      assert.equal(modal.open && modal.modal, true, 'a modal dialog (the top layer)'); assert.equal(modal.label, 'Kararlar', 'aria-labelledby');
      assert.match(modal.filter, /blur\(\d+px\)/, `the backdrop is blurred (${modal.filter})`);
      assert.equal(await dlg.getAttribute('aria-modal'), 'true'); assert.equal(await dlg.getAttribute('role'), 'dialog');
      // A click outside the dialog hits the backdrop (the dialog), not the chat behind it.
      assert.equal(await page.evaluate(() => { const d = document.querySelector('dialog[data-composer-plus-decide]'); const r = d.getBoundingClientRect(); const hit = document.elementFromPoint(Math.max(2, r.left - 40), r.top + 10); return hit === d; }), true, 'the page behind the dialog takes no click');
      const card = dlg.locator('[data-decision]');
      await until(async () => (await card.innerText()).includes(DECISIONS[0][0]), 'the first decision card');
      assert.equal((await dlg.locator('[data-dc-progress]').innerText()).trim(), `1 / ${DECISIONS.length}`);
      assert.deepEqual(await dlg.locator('button[data-option]').evaluateAll((els) => els.map((b) => b.innerText.replace(/\s+/g, ' ').trim())), ['1 Kısa şablon Önerilen', '2 Uzun şablon', '3 Bu hafta gönderme']);
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-dc-focus')), true, 'the focus is in the dialog (the question)');
      await pause(400); await decideShot('2-karar-karti');
      // One click: the exact message once; the next card at once.
      const before10 = calls.length;
      const first = dlg.locator('button[data-option="1"]');
      await first.click(); await first.click({ timeout: 300 }).catch(() => {});
      await until(async () => (await card.innerText()).includes(DECISIONS[1][0]), 'the next card at once');
      const want10 = `Karar: ${DECISIONS[0][0]} → Kısa şablon`;
      await until(() => calls.slice(before10).some((c) => c.newest === want10), 'the model got the decision as the user\'s message');
      await pause(1200);
      assert.equal(calls.slice(before10).filter((c) => c.newest === want10 && c.step === 0).length, 1, 'one message for one click');
      assert.equal(calls.slice(before10).filter((c) => c.step === 0 && /^Karar:/.test(c.newest)).length, 1, 'the second click on the old card sent nothing');
      assert.equal((await dlg.locator('[data-dc-progress]').innerText()).trim(), `2 / ${DECISIONS.length}`);
      await page.mouse.move(5, 5); await pause(400); await decideShot('3-bir-tiklamadan-sonra');
      // → skips (after the key guard); the decision without options says so.
      await pause(900); await page.keyboard.press('ArrowRight');
      await until(async () => (await card.innerText()).includes(DECISIONS[2][0]), '→ skips');
      await pause(900); await page.keyboard.press('ArrowRight');
      await until(async () => (await card.innerText()).includes(DECISIONS[3][0]), 'the decision without options');
      assert.equal(await dlg.locator('button[data-option]').count(), 0); assert.match(await card.innerText(), /Damon seçenek eklemedi/);
      await pause(900); await page.keyboard.press('ArrowRight');
      // The notes after the decisions.
      await until(async () => (await dlg.locator('[data-note]').count()) === 2, 'the other notes');
      await pause(300); await decideShot('4-notlar-listesi');
      for (let n = 0; n < 2; n++) { await pause(500); await dlg.locator('[data-note]').first().getByRole('button', { name: /^Atla:/ }).click(); }
      await dlg.locator('[data-dc="back"]').waitFor();
      // Esc closes it, the focus goes back to the button.
      await page.keyboard.press('Escape');
      await until(async () => (await dlg.count()) === 0, 'Esc closes the dialog');
      await until(() => page.evaluate(() => document.activeElement?.classList.contains('cp-dc-open') === true), 'the focus goes back to the Kararlar button');
      assert.equal((await badge.innerText()).trim(), String(DECISIONS.length - 1), 'the answered decision left the badge at once');
      // Open again: answer the rest (a click, the free text), then the notes with Yaptım: "Hepsi bitti" and Kapat.
      await decide.click(); await dlg.waitFor({ timeout: 10000 });
      await until(async () => (await card.innerText()).includes(DECISIONS[1][0]), 'the skipped decisions come back in a new opening');
      // A user reads each card: a click in the first 0.4 s after the last one does nothing (a double click).
      await pause(500); await dlg.locator('button[data-option="1"]').click();
      await until(async () => (await card.innerText()).includes(DECISIONS[2][0]), 'next');
      await pause(500); await dlg.locator('button[data-option="2"]').click();
      await until(async () => (await card.innerText()).includes(DECISIONS[3][0]), 'next');
      await pause(500);
      await dlg.getByRole('textbox', { name: 'Başka bir cevap' }).fill('Türkçe yazılsın');
      await dlg.getByRole('button', { name: 'Gönder', exact: true }).click();
      await until(async () => (await dlg.locator('[data-note]').count()) === 2, 'the notes');
      const before10b = calls.length;
      await pause(500); await dlg.locator('[data-note]').first().getByRole('button', { name: 'Yaptım: Kırtasiye siparişini ver', exact: true }).click();
      // Sil (the old × of a note): keyboard, at once, no message; the item leaves the Host's list.
      const sil = dlg.getByRole('button', { name: 'Sil: Toplantı notlarını oku', exact: true });
      await pause(500); await sil.focus(); await page.mouse.move(5, 5); await pause(300); await decideShot('6-sil-dugmesi');
      await page.keyboard.press('Enter');
      await until(async () => (await dlg.locator('.cp-dc-empty').count()) === 1, '"Hepsi bitti"');
      assert.equal((await dlg.locator('.cp-dc-empty').innerText()).trim(), 'Hepsi bitti');
      assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog[data-composer-plus-decide]') != null), true, 'the focus stays in the dialog');
      await until(() => ['Not tamam: Kırtasiye siparişini ver', `Karar: ${DECISIONS[3][0]} → Türkçe yazılsın`].every((m) => calls.some((c) => c.newest === m)), 'Yaptım and the free text went as messages');
      const todoFile = join(where.home, '.dsh/storages/dsh-composer-plus/assistant-todos.json');
      await until(() => !JSON.parse(readFileSync(todoFile, 'utf8')).lists[sessionId].some((i) => i.text === 'Toplantı notlarını oku'), 'Sil removed the note on the Host', 5000);
      await pause(800); assert.equal(calls.slice(before10b).some((c) => c.newest === 'Not tamam: Toplantı notlarını oku'), false, 'Sil sends no message');
      await page.mouse.move(5, 5); await pause(300); await decideShot('5-hepsi-bitti');
      await dlg.locator('[data-dc="close"]').click();
      await until(async () => (await dlg.count()) === 0, 'Kapat closes it');
      note('10: Kararlar: the badge counts the decisions; a modal dialog over the page (blurred backdrop); one click sent "Karar: … → …" once and showed the next card; → skips; no options: the note; Esc closes, the focus goes back; Yaptım sent "Not tamam", Sil removed a note on the Host without a message');
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
      await shotContext.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); localStorage.setItem('dsh-composer-plus.assistant-chat-shown', '1'); });
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
