// Real-app check of Codex dark theme (codexTheme) on each dsh given: fake model, throwaway DSH_HOME, made-up project,
// headless, dark system palette. The chat has an answer with a link and a running turn (the Stop button).
// 1. Off by default: no theme style; dsh's own colors (the "before" look).
// 2. Settings → Composer Plus → Codex dark theme on: one style; the reference palette on the chat, sidebar, composer, bubble,
//    selected row, right panel, active Chat tab, caret, link and Stop button; no element moves or changes size; the keyboard
//    focus ring is off-white and visible; the macOS sidebar stays semi-transparent; the light palette does not change.
// 3. Switch off: no style, and every checked color is the same as in step 1.
// PLAYWRIGHT=/path/to/playwright node test/browser-codex-theme.mjs /path/to/dsh/lib/bin.js [...]
// SHOTS_DIR=/path writes theme-on.png and theme-off.png (first dsh). SHOT=1 writes assets/features/codexTheme.webp (needs cwebp).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OFF_WHITE = 'rgb(234, 232, 228)';

// Fake model: the first message gets an answer with a link; "Keep working" gets no answer (the turn keeps running).
const held = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const text = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
    const say = (content) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk({ role: 'assistant', content }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); };
    if (/session title/i.test(text(msgs.at(-1)))) { say('Warehouse handover screen'); return; }
    if (/predict the next message|complete the message|improve a prompt|branch name/i.test(text(msgs[0]))) { say('Thanks'); return; }
    if (text(msgs.filter((m) => m.role === 'user').at(-1)).includes('Keep working')) { held.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); return; }
    say('The handover screen lists open orders. See the [order rules](https://example.com/rules) first.\n\n- Check the stock\n- Print the labels');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

/** In the page: the color and the box of each checked part of dsh's UI (by dsh's markup attributes and roles). */
function look() {
  const rgb = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); };
  const body = document.body;
  const scroll = document.querySelector('[data-conversation-scroll]');
  const card = document.querySelector('[data-composer-card]');
  const input = document.querySelector('[data-composer-input]');
  const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
  const tab = [...document.querySelectorAll('[data-conversation-tabs] [role="tab"]')].find((t) => t.getAttribute('aria-selected') === 'true');
  const link = scroll?.querySelector('a[href^="https://example.com"]');
  const stop = document.querySelector('[data-composer-card] button[aria-label="Stop generating"]');
  const bubble = [...document.querySelectorAll('[data-conversation-scroll] *')].find((el) => el.children.length <= 2 && el.textContent.trim() === 'Show me the handover screen' && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)');
  const sidebar = [...document.querySelectorAll('[class*="_sidebarCol"]')][0];
  const newSession = [...document.querySelectorAll('button')].find((b) => /New session/.test(b.textContent));
  const tint = sidebar ? getComputedStyle(sidebar).backgroundImage + ' / ' + getComputedStyle(sidebar).backgroundColor : null;
  const parts = { body, scroll, card, input, row, tab, link, stop, bubble, sidebar, newSession };
  const out = { styles: document.querySelectorAll('style[data-composer-plus-codex-theme]').length, dark: body.hasAttribute('data-ds-dark-theme'), tint };
  for (const [k, el] of Object.entries(parts)) out[k] = { bg: rgb(el, 'backgroundColor'), color: rgb(el, 'color'), box: box(el) };
  out.caret = rgb(input, 'caretColor');
  out.tabLine = tab ? getComputedStyle(tab, '::after').backgroundColor : null;
  out.stopIcon = stop ? getComputedStyle(stop.querySelector('svg') ?? stop).color : null;
  out.linkLine = link ? getComputedStyle(link).textDecorationLine : null;
  out.tokens = Object.fromEntries(['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill', '--dsw-alias-label-primary', '--dsw-alias-state-business-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-error-primary', '--dsw-specific-sidebar-tint'].map((n) => [n, getComputedStyle(body).getPropertyValue(n).trim()]));
  // Every element's box (the first 1500): the theme must not move or size anything. A running animation (a spinner) is skipped.
  const moving = document.getAnimations().map((x) => x.effect?.target).filter((t) => t instanceof Element);
  out.boxes = [...document.querySelectorAll('body *')].slice(0, 1500).map((el) => (moving.some((t) => t.contains(el)) ? '-' : box(el)));
  return out;
}

const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true });
const results = [];
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-codex-theme-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'codex-theme-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  config:
    providers:
      demo:
        displayName: Demo
        api: openai-completions
        baseURL: http://127.0.0.1:${fakePort}/v1
        apiKeyEnv: DEMO_KEY
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
- id: permission-presets
  config: { default: full-access }
`);
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    await writeFile(join(project, 'README.md'), '# acme-web\n');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3217', '--no-open'], { cwd: project,
      env: { ...process.env, DSH_HOME: home, HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 860 }, colorScheme: 'dark' });
      await context.addInitScript(() => { if (sessionStorage.getItem('ct.started') === null) { sessionStorage.setItem('ct.started', '1'); localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); } });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: 'Get started' }).getByRole('button', { name: 'Close', exact: true });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      await input.click(); await page.keyboard.type('Show me the handover screen'); await page.keyboard.press('Enter');
      await page.getByText('order rules').first().waitFor({ timeout: 30000 });
      await input.click(); await page.keyboard.type('Keep working'); await page.keyboard.press('Enter');
      await page.locator('[data-composer-card] button[aria-label="Stop generating"]').waitFor({ timeout: 20000 });
      await input.click(); await page.mouse.move(700, 300); await pause(800);

      const setTheme = async (on) => {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name: 'Codex dark theme', exact: true }); await sw.waitFor({ timeout: 10000 });
        if ((await sw.isChecked()) !== on) await sw.click();
        await page.waitForFunction((v) => document.querySelectorAll('style[data-composer-plus-codex-theme]').length === (v ? 1 : 0), on, { timeout: 10000 });
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const shut = overlay.getByRole('button', { name: /^Close$/ });
        if (await shut.count()) await shut.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await input.click(); await page.mouse.move(700, 300); await pause(800);
      };

      // 1. Off by default.
      const before = await page.evaluate(look);
      assert.equal(before.styles, 0, 'off by default: no theme style');
      assert.ok(before.dark, 'the system palette is dark, so dsh shows its dark palette');
      for (const k of ['scroll', 'card', 'row', 'tab', 'link', 'stop', 'bubble']) assert.ok(before[k].box, `${k} is on the page`);
      assert.notEqual(before.stop.bg, OFF_WHITE, "before: dsh's own blue Stop circle");

      // 2. On.
      await setTheme(true);
      const on = await page.evaluate(look);
      const expect = (got, want, what) => assert.equal(got, want, `${what}: ${got}`);
      expect(on.tokens['--dsw-alias-bg-base'], '#141414', 'chat background token');
      expect(on.body.bg, 'rgb(20, 20, 20)', 'page background');
      expect(on.card.bg, 'rgb(41, 41, 41)', 'message box');
      expect(on.bubble.bg, 'rgb(41, 41, 41)', 'message bubble');
      expect(on.row.bg, 'rgb(48, 48, 48)', 'selected chat row');
      expect(on.tab.color, OFF_WHITE, 'active Chat tab');
      expect(on.tabLine, OFF_WHITE, 'active Chat tab underline');
      expect(on.caret, OFF_WHITE, 'caret');
      expect(on.link.color, OFF_WHITE, 'link');
      expect(on.linkLine, 'underline', 'link underline');
      expect(on.stop.bg, OFF_WHITE, 'Stop circle');
      expect(on.stopIcon, 'rgb(38, 38, 38)', 'Stop square');
      expect(on.tokens['--dsw-alias-state-error-primary'], before.tokens['--dsw-alias-state-error-primary'], 'errors keep their red');
      assert.notEqual(on.tokens['--dsw-alias-state-success-primary'], before.tokens['--dsw-alias-state-success-primary'], 'done is sage now');
      const moved = (x, y) => x.boxes.map((v, i) => (v !== y.boxes[i] && v !== '-' && y.boxes[i] !== '-' ? `#${i}: ${y.boxes[i]} → ${v}` : null)).filter(Boolean);
      assert.equal(on.boxes.length, before.boxes.length, 'the same elements');
      assert.deepEqual(moved(on, before).slice(0, 5), [], 'no element moves or changes size');
      // Keyboard focus: Tab onto a button; its ring is off-white and 2 px.
      await page.locator('[data-composer-card] button[aria-label="Stop generating"]').focus();
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => { const el = document.activeElement; const s = getComputedStyle(el); return { tag: el.tagName, style: s.outlineStyle, color: s.outlineColor, width: s.outlineWidth }; });
      assert.ok(ring.style !== 'none' && ring.width !== '0px', `keyboard focus is visible (${JSON.stringify(ring)})`);
      expect(ring.color, OFF_WHITE, 'focus ring');
      // The ring on dsh's off-white Stop circle sits outside it (2 px), so it does not vanish on the fill.
      await page.locator('[data-composer-card] button[aria-label="Stop generating"]').focus();
      const stopRing = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { color: s.outlineColor, offset: s.outlineOffset, style: s.outlineStyle }; });
      assert.ok(stopRing.style !== 'none' && parseFloat(stopRing.offset) >= 2, `Stop focus ring outside the circle (${JSON.stringify(stopRing)})`);
      // Hover, selected and selected + hover stay apart in the sidebar.
      const workspaceRow = page.locator('[data-row-key^="workspace:"]').first();
      const rowBg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
      const resting = await rowBg(workspaceRow); await workspaceRow.hover(); await pause(250); const hovered = await rowBg(workspaceRow);
      const selectedRow = page.locator('[data-row-key^="session:"][aria-selected="true"]');
      await selectedRow.hover(); await pause(250); const selectedHover = await rowBg(selectedRow); await page.mouse.move(700, 300); await pause(250);
      assert.ok(new Set([resting, hovered, on.row.bg]).size === 3, `rest, hover and selected differ (${resting} / ${hovered} / ${on.row.bg})`);
      assert.ok(selectedHover !== hovered, `selected + hover differs from hover (${selectedHover})`);
      expect(selectedHover, 'rgb(48, 48, 48)', 'the selected row keeps #303030 under the mouse (muted text stays 4.5:1)');
      if (process.env.SHOTS_DIR && bin === process.argv[2]) { await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(700, 300); await pause(300); await page.screenshot({ path: join(process.env.SHOTS_DIR, 'theme-on.png') }); }
      if (process.env.SHOT && bin === process.argv[2]) {
        // The whole demo window with the theme on (English UI, made-up project), 640 px wide.
        await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(700, 300); await pause(300);
        const png = join(home, 'shot.png'); await page.screenshot({ path: png });
        execFileSync('cwebp', ['-quiet', '-q', '74', '-resize', '640', '0', png, '-o', join(repo, 'assets/features/codexTheme.webp')]);
      }
      // macOS: dsh's vibrancy sidebar (html[data-platform=darwin]) stays semi-transparent, with a stronger base than dsh's.
      const alpha = (v) => { const m = v.match(/^(?:rgba?|color)\((.*)\)$/); const p = m ? m[1].replace(/^srgb\s+/, '').split(/[\s,/]+/).filter(Boolean) : []; return p.length > 3 ? Number(p[3]) : 1; };
      const darwinTint = () => page.evaluate(() => { const root = document.documentElement; const had = root.getAttribute('data-platform'); root.setAttribute('data-platform', 'darwin');
        const col = document.querySelector('[class*="_sidebarCol"]'); const v = getComputedStyle(col).backgroundColor; if (had === null) root.removeAttribute('data-platform'); else root.setAttribute('data-platform', had); return v; });
      const tintOn = alpha(await darwinTint());
      assert.ok(tintOn > 0.5 && tintOn < 1, `macOS sidebar: semi-transparent with a stronger base (alpha ${tintOn})`);
      // The light palette does not change.
      await page.emulateMedia({ colorScheme: 'light' }); await pause(800);
      const light = await page.evaluate(look);
      assert.ok(!light.dark && light.styles === 1, 'light system palette: dsh shows its light palette, the style stays');
      expect(light.body.bg, 'rgb(255, 255, 255)', "light palette: dsh's own white");
      await page.emulateMedia({ colorScheme: 'dark' }); await pause(800);

      // 3. Off again: the old look, color for color.
      await setTheme(false);
      const after = await page.evaluate(look);
      assert.equal(after.styles, 0, 'off: no theme style');
      for (const k of ['body', 'scroll', 'card', 'input', 'row', 'tab', 'link', 'stop', 'bubble', 'sidebar', 'newSession']) assert.deepEqual(after[k], before[k], `off: ${k} as before`);
      for (const k of ['caret', 'tabLine', 'stopIcon', 'linkLine', 'tint']) assert.equal(after[k], before[k], `off: ${k} as before`);
      assert.deepEqual(after.tokens, before.tokens, 'off: dsh tokens as before');
      const tintOff = alpha(await darwinTint());
      assert.ok(tintOff < tintOn, `off: dsh's own thinner macOS tint (alpha ${tintOff} < ${tintOn})`);
      assert.deepEqual(moved(after, before).slice(0, 5), [], 'off: every box as before');
      if (process.env.SHOTS_DIR && bin === process.argv[2]) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'theme-off.png') });
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      results.push(`PASS ${bin}: off by default · on: reference palette, no box moved, focus ring off-white · light palette unchanged · off: old colors back`);
    } catch (error) {
      results.push(`FAIL ${bin}: ${error?.stack ?? error}\n  kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log);
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed) await rm(home, { recursive: true, force: true }); else console.log(`home: ${home}`);
    }
  }
} finally { for (const r of held) r.destroy(); await browser.close(); fake.close(); }
for (const r of results) console.log(r);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
