// Real-app check of "Keep composer focus" with a fake model and a demo skill, on each dsh given. No real model,
// never the normal DSH_HOME. dsh makes the composer read-only while it resolves a slash command, so the browser drops
// the focus to the page. Switch off: the run records that loss (evidence; a future dsh that keeps the focus does not
// fail it). Switch on: after `/release-notes` + Enter, typing goes on in the composer without a click, in a blank and
// in an open chat, and a command with its own popup (`/permission`) keeps the focus in that popup.
// PLAYWRIGHT=/path/to/playwright node test/browser-keep-focus.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/keepFocus.webp (English UI, demo chat only).
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

// Fake OpenAI-compatible model: every answer is "Done."; title requests get a short title.
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const last = (JSON.parse(body).messages ?? []).at(-1);
    const text = /session title/i.test(JSON.stringify(last?.content)) ? 'Release notes' : 'Done.';
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

/** Page init script: feature switches, plus evidence of focus moves and composer editable/phase changes, in order. */
function recordFocus(features) {
  localStorage.setItem('dsh-composer-plus.features', features);
  window.__focusLog = [];
  const name = (t) => (t?.closest?.('[data-composer-input]') ? 'composer' : t === document.body ? 'body' : t?.tagName?.toLowerCase() ?? 'none');
  const note = (what) => {
    const input = document.querySelector('[data-composer-input]');
    window.__focusLog.push(`${Math.round(performance.now())}ms ${what} | editable=${input?.getAttribute('contenteditable')} phase=${input?.getAttribute('data-phase')}`);
  };
  document.addEventListener('focusin', (e) => note(`focusin ${name(e.target)}`), true);
  document.addEventListener('focusout', (e) => note(`focusout ${name(e.target)} -> ${name(e.relatedTarget)}`), true);
  new MutationObserver((list) => { for (const m of list) if (m.target.matches?.('[data-composer-input]')) note(`set ${m.attributeName}`); })
    .observe(document, { subtree: true, attributes: true, attributeFilter: ['contenteditable', 'data-phase'] });
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-focus-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'focus-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
`);
    // A demo skill: `/release-notes` goes the same way as the user's own skill shortcuts.
    await mkdir(join(home, 'skills/release-notes'), { recursive: true });
    await writeFile(join(home, 'skills/release-notes/SKILL.md'), '---\nname: release-notes\ndescription: Draft short release notes for the latest changes.\n---\n\nWrite three short release notes.\n');
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3194', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const contexts = []; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      const run = async (keepFocus) => {
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' }); contexts.push(context);
        await context.addInitScript(recordFocus, JSON.stringify(keepFocus ? { autoUpdate: false } : { autoUpdate: false, keepFocus: false }));
        const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url);
        for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
          const b = page.getByRole('button', { name });
          if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
        }
        const input = page.locator('[data-composer-input]'); await input.waitFor();
        await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
        const focus = () => page.evaluate(() => { const a = document.activeElement; return a === null || a === document.body ? 'body' : a.closest('[data-composer-input]') ? 'composer' : a.tagName.toLowerCase(); });
        // Type the command, then send it with Enter. When dsh's / menu is open, its first Enter only picks the
        // highlighted row. A keyboard macro is faster than the menu, so close the menu first: Enter then sends.
        const send = async (text) => {
          await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');
          await page.keyboard.type(text);
          const menu = page.locator('[data-trigger-menu]');
          if (await menu.waitFor({ timeout: 3000 }).then(() => true, () => false)) { await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' }); }
          await page.evaluate(() => { window.__focusLog.length = 0; });
          await page.keyboard.press('Enter');
        };
        // Like a keyboard macro: send the command, then type on at once without a click.
        const command = async (text, next) => {
          await send(text);
          await page.waitForFunction(() => { const el = document.querySelector('[data-composer-input]'); return (el?.getAttribute('data-phase') ?? 'plain') === 'plain' && el?.innerText.trim() === ''; }, null, { timeout: 15000 });
          await pause(500);
          const where = await focus();
          await page.keyboard.type(next); await pause(300);
          return { where, typed: (await input.innerText()).trim(), log: await page.evaluate(() => window.__focusLog.slice(0, 16)) };
        };
        const done = (count) => page.waitForFunction((n) => (document.body.innerText.match(/Done\./g) ?? []).length >= n, count, { timeout: 20000 });
        const blank = await command('/release-notes', 'next'); await done(1); await pause(800);
        const open = await command('/release-notes', 'and add a changelog entry'); await done(2); await pause(500);
        if (keepFocus && index === 0 && process.env.SHOT) {
          // The sent command, the answer and the composer with the text typed after it; nothing below the card.
          await page.mouse.move(5, 5); await pause(300);
          const card = await page.locator('[data-composer-card]').first().boundingBox();
          const sent = await page.locator('[data-conversation-content]').getByText('/release-notes', { exact: true }).last().boundingBox();
          const top = Math.max(0, Math.min(sent.y - 16, card.y - 260));
          const clip = { x: Math.max(0, card.x - 20), y: top, width: card.width + 40, height: card.y + card.height + 3 - top };
          const png = join(home, 'keepFocus.png'); await page.screenshot({ path: png, clip });
          execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/keepFocus.webp')]);
        }
        // `/permission` opens dsh's own popup after the command resolves; its search field must keep the focus.
        await send('/permission'); await pause(1000);
        const popup = await page.evaluate(() => {
          const a = document.activeElement; const where = a === null || a === document.body ? 'body' : a.closest('[data-composer-input]') ? 'composer' : a.getAttribute('aria-label') ?? a.tagName.toLowerCase();
          return `${where}; popup ${document.querySelector('input[aria-label="Filter options"]') === null ? 'closed' : 'open'}`;
        });
        await page.keyboard.press('Escape'); await pause(300);
        await context.close(); contexts.pop();
        return { blank, open, popup };
      };
      const off = await run(false);
      const on = await run(true);
      const show = (label, r) => `  ${label}: blank chat -> ${r.blank.where} (typed "${r.blank.typed}"), open chat -> ${r.open.where} (typed "${r.open.typed}"), /permission -> ${r.popup}`;
      console.log(`${bin}\n${show('switch off', off)}\n    ${off.open.log.join('\n    ')}\n${show('switch on', on)}\n    ${on.open.log.join('\n    ')}`);
      if (off.blank.where === 'composer' && off.open.where === 'composer') console.log('  note: this dsh keeps the composer focus without the feature');
      assert.deepEqual([on.blank.where, on.blank.typed], ['composer', 'next'], 'blank chat: typing goes on in the composer after a slash command');
      assert.deepEqual([on.open.where, on.open.typed], ['composer', 'and add a changelog entry'], 'open chat: typing goes on in the composer after a slash command');
      assert.equal(on.popup, 'Filter options; popup open', 'an open command popup keeps the focus in its search field');
      assert.equal(on.popup, off.popup, 'a command popup keeps the same focus as without the feature');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = contexts.at(-1)?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
