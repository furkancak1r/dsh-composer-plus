// Real-app check: Markdown images in the Damon reply cards (Furkan, 2026-11-26: "kartlara görüntüler gelmiyor düzelt").
// dsh asks agents to write a local image as ![alt](<absolute path>); its own chat view shows it through its file route
// (/api/file), and the cards must show it the same way. A throwaway dsh (scripts/demo-card-stack.mjs: its own DSH_HOME and
// HOME, a fake model on 127.0.0.1, made-up files), headless Chrome with its sandbox.
// 1. A reply with two images (absolute paths with spaces, in angle brackets): two img elements that loaded (naturalWidth > 0)
//    through dsh's /api/file.
// 2. A relative image path loads from the chat's folder; a missing image shows its alt text; a .pdf is no image (its alt
//    text shows, no img element).
// SHOTS=<folder> [TAG=<text>] writes kart-resim<TAG>.png (the card with two images) and kart-resim-kenar<TAG>.png (the edge
// cases); it never replaces a file. BEFORE=1: only the measurement and the pictures (for a client.js without the fix).
// TMPDIR=<folder> PLAYWRIGHT=/path/to/playwright node test/browser-reply-images.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { fakeModel, demoHome, startDemo, seed, rpcOf } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const TAG = process.env.TAG ? `-${process.env.TAG}` : ''; const BEFORE = process.env.BEFORE === '1';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};
/** A w×h PNG: a band of `band` over `bg` (RGB arrays). */
const png = (w, h, bg, band) => {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const rows = []; for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); const c = y > h / 3 && y < (2 * h) / 3 ? band : bg; for (let x = 0; x < w; x++) row.set(c, 1 + x * 3); rows.push(row); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
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
    const shot = async (locator, name) => { if (!process.env.SHOTS || index > 0) return; const path = join(process.env.SHOTS, `${name}${TAG}.png`); if (existsSync(path)) throw Error(`${path} exists: use another TAG`); await locator.screenshot({ path }); };
    try {
      // Made-up files: two images in a folder with spaces (outside the chat's folder), a relative one in the Damon folder
      // (~/Assistant of the throwaway HOME), a .pdf.
      const folder = join(where.home, 'Belgeler', 'kart resim');
      await mkdir(folder, { recursive: true }); await mkdir(join(where.home, 'Assistant', 'resim'), { recursive: true });
      await writeFile(join(folder, 'ilk görünüm.png'), png(480, 270, [235, 240, 250], [59, 108, 246]));
      await writeFile(join(folder, 'bir tıklamadan sonra.png'), png(480, 270, [240, 250, 240], [22, 163, 74]));
      await writeFile(join(where.home, 'Assistant', 'resim', 'goreli.png'), png(240, 120, [250, 245, 235], [217, 119, 6]));
      await writeFile(join(folder, 'rapor.pdf'), '%PDF-1.4\n% made-up\n');
      demo = await startDemo(bin, where, 3700 + index);
      const { sessionId } = await seed(demo.url, { model });
      const { rpc } = await rpcOf(demo.url);
      context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1360, height: 900 } });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(demo.url);
      for (const name of [/^(Continue|Devam)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }).catch(() => {}); }
      }
      await page.keyboard.press('Escape');
      await page.locator('button[aria-label="Damon"]').click(); await page.locator('[data-composer-plus-todos]').waitFor({ timeout: 30000 });
      for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: /^(Hide|Gizle)$/ }).first(); if (!(await hide.waitFor({ timeout: 1500 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
      const feed = page.locator('[data-composer-plus-reply-feed]');
      await feed.waitFor({ timeout: 20000 });
      await rpc('session/prompt', { request: { requestId: `images-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: `DEMO-IMAGES ${folder}` }] } });
      const two = feed.locator('article.cp-rc').filter({ has: page.locator('h3', { hasText: 'İki ekran görüntüsü.' }) });
      const edge = feed.locator('article.cp-rc').filter({ has: page.locator('h3', { hasText: 'Kenar durumları.' }) });
      await two.waitFor({ timeout: 30000 }); await edge.waitFor({ timeout: 10000 });
      // The images load lazily: each card comes into view first, then its images get time to load (or to fail).
      const measure = async (card) => {
        await card.evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await until(() => card.evaluate((el) => [...el.querySelectorAll('img')].every((img) => img.complete)), 'the images settle', 10000).catch(() => {});
        await pause(800);
        return card.evaluate((el) => ({
          imgs: [...el.querySelectorAll('img')].map((img) => ({ alt: img.alt, natural: [img.naturalWidth, img.naturalHeight], shown: [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)], route: new URL(img.currentSrc || img.src).pathname, path: new URL(img.currentSrc || img.src).searchParams.get('path') })),
          text: el.querySelector('.cp-rc-body')?.innerText ?? '',
        }));
      };
      const m = { two: await measure(two) };
      await shot(two, 'kart-resim');
      m.edge = await measure(edge);
      await shot(edge, 'kart-resim-kenar');
      console.log(`  MEASURE ${JSON.stringify(m)}`);
      if (BEFORE) { passed = true; console.log(`PASS (before) dsh ${version}`); continue; }
      // 1. Two images, loaded through dsh's file route, with their alt texts.
      assert.deepEqual(m.two.imgs.map((i) => [i.alt, i.route, i.path]), [['İlk görünüm', '/api/file', join(folder, 'ilk görünüm.png')], ['Bir tıklamadan sonra', '/api/file', join(folder, 'bir tıklamadan sonra.png')]], 'two images from their absolute paths');
      for (const i of m.two.imgs) assert.ok(i.natural[0] > 0 && i.shown[0] > 0, `the image loaded and shows: ${JSON.stringify(i)}`);
      // 2. The relative image from the chat's folder; the missing image and the .pdf: their alt text, no picture.
      assert.deepEqual(m.edge.imgs.filter((i) => i.natural[0] > 0).map((i) => [i.alt, i.path]), [['Göreli', join(where.home, 'Assistant', 'resim', 'goreli.png')]], 'only the relative image loads');
      assert.ok(!m.edge.imgs.some((i) => i.alt === 'Rapor'), 'a .pdf is no img');
      for (const alt of ['Eksik görüntü', 'Rapor']) assert.ok(m.edge.text.includes(alt), `the alt text shows: ${alt}`);
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
