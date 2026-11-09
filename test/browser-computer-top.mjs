// Real-app check of the other Mac's page in this Mac's macOS window (Remote computers), headless, on each dsh given:
// throwaway DSH_HOME, no model. The page in the window's webview is a plain web page (dsh's preload marks only its own
// page with `data-platform`), so it draws no title bar row of its own. Before the fix the webview started under a
// 48 px band (`--dsh-frame-top-clearance`): the page sat 48 px lower with an empty bar above it. Now the webview fills
// the window and the page gets the mark (`data-platform=darwin`): it draws dsh's own title bar row, as this Mac's page.
// This check loads the real dsh page twice in a 1280 x 820 frame: as the webview showed it before (top 48, no mark) and
// as it does now (top 0, the mark), and compares the chat header and the sidebar brand with dsh's own macOS page.
// PLAYWRIGHT=/path/to/playwright node test/browser-computer-top.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const W = 1280; const H = 820; const BAND = 48; // dsh: html[data-platform=darwin]{--dsh-frame-top-clearance:48px}
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-computer-top-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'computer-top-check', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: home, env: { ...process.env, DSH_HOME: home, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: W, height: H } });
      // A frame named "mark" runs client.js's own mark script at DOMContentLoaded: the time of the webview's `dom-ready`.
      const mark = readFileSync(join(repo, 'client.js'), 'utf8').match(/const COMPUTER_PAGE_MARK = ("(?:[^"\\]|\\.)*");/)[1];
      await context.addInitScript(({ code }) => {
        localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}');
        if (window.name === 'mark') document.addEventListener('DOMContentLoaded', () => { (0, eval)(code); });
      }, { code: JSON.parse(mark) });
      // The window's own page once, so the start notices are gone for the frames below (same origin, same storage).
      const page = await context.newPage();
      await page.goto(url);
      for (const name of ['Continue', 'Configure later']) { const b = page.getByRole('button', { name, exact: true }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) await b.click(); }
      const close = page.getByRole('dialog', { name: 'Get started' }).getByRole('button', { name: 'Close', exact: true });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      // One view: the dsh page in a frame at `top` px of a 1280 x 820 window, with or without the platform mark.
      const measure = async ({ top, mark }) => {
        await page.setContent(`<body style="margin:0;background:#888"><iframe id="v" name="${mark ? 'mark' : 'plain'}" src="${url}" style="position:fixed;left:0;top:${top}px;width:${W}px;height:${H - top}px;border:0"></iframe></body>`);
        const frame = await (await page.waitForSelector('#v')).contentFrame();
        await frame.waitForSelector('[class*="_logoRow"] [class*="_brand"]', { timeout: 30000, state: 'attached' });
        if (mark) await frame.waitForFunction(() => document.documentElement.dataset.platform === 'darwin', null, { timeout: 5000 });
        await pause(600);
        const failed = await frame.evaluate(() => document.body.innerText.includes('Failed to load plugins'));
        assert.equal(failed, false, 'dsh\'s page started (no plugin failed)');
        return frame.evaluate((offset) => {
          const box = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r === undefined ? null : { top: Math.round(r.top + offset), bottom: Math.round(r.bottom + offset), height: Math.round(r.height) }; };
          return { platform: document.documentElement.dataset.platform ?? null, brand: box('[class*="_logoRow"] [class*="_brand"]'), strip: box('[class*="_topStrip"]'), clearance: getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance').trim() || null };
        }, top);
      };
      // dsh's own macOS page (this Mac): the mark at the top of the window.
      const own = await measure({ top: 0, mark: true });
      const before = await measure({ top: BAND, mark: false });
      const after = await measure({ top: 0, mark: true });
      console.log(JSON.stringify({ bin, own, before, after }));
      assert.equal(own.strip !== null, true, 'dsh\'s macOS page draws its title bar row (top strip)');
      assert.equal(before.platform, null); assert.equal(before.strip, null, 'before: the page has no title bar row of its own');
      assert.ok(before.brand.top - own.brand.top >= 0 && before.brand.top > BAND, `before: the page starts under a ${BAND} px empty band`);
      assert.deepEqual(after, own, 'after: the other Mac\'s page lays out as dsh\'s own macOS page');
      passed = true;
      console.log(`PASS ${bin}: before, the page started ${BAND} px down with no title bar row; now it fills the window like dsh's own page (brand at ${after.brand.top} px)`);
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true }); else console.error(`kept for inspection: ${home}`);
    }
  }
} finally { await browser.close(); }
