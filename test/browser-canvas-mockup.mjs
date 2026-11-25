// Screenshots of the canvas (tuval) mockup HTML (Damon's "Sonsuz tuval" option of 2026-11-19), and side-by-side pictures
// of the mockup and the Composer Plus canvas. Headless Chromium with its sandbox; the mockup is a local file without
// network requests (its CSP is default-src 'none').
// - MOCKUP=<file.html> OUT=<folder> [TAG=<text>]: writes <OUT>/mockup-<light|dark>[-<TAG>].png (the canvas part of the
//   page, 1360×820 window), plus mockup-far-light[-<TAG>].png (zoomed out: counts only) and mockup-side-light[-<TAG>].png
//   (a card open in the side panel).
// - PAIR=1 also writes <OUT>/yan-yana-<light|dark>[-<TAG>].png: the mockup at the left, <OUT>/composer-plus-<scheme>[-<TAG>].png
//   (test/browser-status-canvas.mjs with SHOTS, SCHEME and TAG) at the right, the same height.
// PLAYWRIGHT=/path/to/playwright MOCKUP=… OUT=… node test/browser-canvas-mockup.mjs
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { PLAYWRIGHT, MOCKUP, OUT, TAG, PAIR } = process.env;
if (!PLAYWRIGHT || !MOCKUP || !OUT) throw Error('Set PLAYWRIGHT, MOCKUP and OUT');
const { chromium } = require(PLAYWRIGHT);
const tag = TAG ? `-${TAG}` : '';
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 820 }, colorScheme: scheme, locale: 'tr-TR' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${pathToFileURL(MOCKUP).href}#tuval`);
    const mock = page.locator('#p-tuval .mock');
    await mock.waitFor(); await page.waitForTimeout(400);
    await mock.screenshot({ path: join(OUT, `mockup-${scheme}${tag}.png`) });
    if (scheme === 'light') {
      await page.locator('#cv').focus();
      for (let n = 0; n < 5; n++) await page.keyboard.press('-');
      await page.waitForTimeout(300); await mock.screenshot({ path: join(OUT, `mockup-far-light${tag}.png`) });
      await page.keyboard.press('0'); await page.waitForTimeout(300);
      await page.locator('#world [data-cv]').first().click(); await page.waitForTimeout(500);
      await mock.screenshot({ path: join(OUT, `mockup-side-light${tag}.png`) });
    }
    if (errors.length > 0) throw Error(`page errors: ${errors.join('; ')}`);
    await context.close();
    if (PAIR) {
      const cp = join(OUT, `composer-plus-${scheme}${tag}.png`);
      if (!existsSync(cp)) throw Error(`missing ${cp}`);
      const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
      const pair = await browser.newContext({ viewport: { width: 2000, height: 700 }, colorScheme: scheme });
      const p = await pair.newPage();
      const bg = scheme === 'dark' ? '#111' : '#fafafa'; const fg = scheme === 'dark' ? '#eee' : '#222';
      await p.setContent(`<body style="margin:0;padding:16px;display:flex;gap:16px;align-items:flex-start;background:${bg};color:${fg};font:600 15px -apple-system,sans-serif">`
        + `<figure style="margin:0"><figcaption style="margin-bottom:8px">HTML mockup (2026-11-19)</figcaption><img style="height:640px;border:1px solid #8884" src="${img(join(OUT, `mockup-${scheme}${tag}.png`))}"></figure>`
        + `<figure style="margin:0"><figcaption style="margin-bottom:8px">Composer Plus${TAG ? ` ${TAG}` : ''}</figcaption><img style="height:640px;border:1px solid #8884" src="${img(cp)}"></figure></body>`);
      await p.screenshot({ path: join(OUT, `yan-yana-${scheme}${tag}.png`), fullPage: true });
      await pair.close();
    }
  }
  console.log('PASS mockup shots');
} finally { await browser.close(); }
