// Real-app check of "Fit question card to window" on each dsh given (fake model, throwaway DSH_HOME, made-up project,
// headless). The owner's dsh window is 1280 × 820 (measured with System Events); the page gets the same viewport and the
// owner's dragged chat width. The fake model asks one ask_user_question with a long question (1,400 characters) and
// three answers. Without the feature, dsh caps the card at min(60vh, 520px) and only the answers scroll: at 1280 × 820 a
// question of about 1,150 characters or more pushes its own end and the Skip/Submit row out of the card (the longest
// question in the owner's recent chat logs had 858 characters: at 820 px high it leaves the answers a 107 px box; at
// 600 px high it is cut too).
// 1. Switch off: records how dsh draws the card (evidence; a future dsh that fits the card does not fail it).
// 2. Switch on in Settings (live): the whole question and every answer can be scrolled into view inside the card, Skip
//    and Submit are in view at once, and the card stays inside the chat area. Also at 1280 × 600 and 1280 × 1000: the
//    card height follows the window.
// 3. Switch off in Settings: the style goes and dsh's own height cap is back; on again; pick an answer and submit: the
//    model gets it.
// PLAYWRIGHT=/path/to/playwright node test/browser-question-fit.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/questionFit.webp (English UI, demo project). KEEP=1 keeps the temp home with
// off.png and on.png.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WINDOW = { width: 1280, height: 820 };
const CHAT_WIDTH = '642.515625'; // the owner's `dsh.conversation.contentWidth` (a dragged chat width, px)

const sentence = 'The release branch has three open changes, and the main build failed twice this week because of a flaky login test. ';
const QUESTION = `${sentence.repeat(13).slice(0, 1360).trim()} Which plan do you want for the release?`;
const OPTIONS = [
  { label: 'Fix the test first (Recommended)', description: 'Fix the flaky login test, run the full build again and ship the release when the build passes twice in a row. This takes about one more day, but the release then has a green build, the change log stays the same and nobody needs to watch the next deploy closely.' },
  { label: 'Ship now', description: 'Ship the release today with the known flaky test.' },
  { label: 'Skip the flaky test', description: 'Mark the login test as skipped and ship; open a ticket to fix it next week.' },
];

// Fake model: the first user turn gets the question; after the answer it says "Thanks, noted." and keeps the answer.
let answered = '';
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (/session title|next message|complete the message|improve a prompt/i.test(JSON.stringify(msgs[0]?.content ?? '') + JSON.stringify(msgs.at(-1)?.content ?? ''))) { res.end(chunk({ role: 'assistant', content: 'Release plan' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); return; }
    if (!msgs.some((m) => m.role === 'tool')) {
      const call = { index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'plan', header: 'Release plan', question: QUESTION, options: OPTIONS }] }) } };
      res.end(chunk({ role: 'assistant', tool_calls: [call] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    answered = JSON.stringify(msgs.findLast((m) => m.role === 'tool')?.content ?? '');
    res.end(chunk({ role: 'assistant', content: 'Thanks, noted.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

/** In the page: where the card is, and whether the user can bring each part into view. Only boxes with overflow auto or
 * scroll move (the mouse wheel moves only those); a sticky footer covers what is under it. Scroll positions go back after. */
function measure() {
  const frame = document.querySelector('[data-question-key]');
  const card = frame.querySelector(':scope > section');
  const title = card.querySelector(':scope > header h2');
  const footer = card.querySelector(':scope > footer');
  const options = [...card.querySelectorAll('[role="radio"], [role="checkbox"]')];
  const buttons = footer === null ? [] : [...footer.querySelectorAll('button')].filter((b) => /^(Skip|Submit)$/.test(b.textContent.trim()));
  const chat = document.querySelector('[data-conversation-scroll]').getBoundingClientRect();
  const view = (el) => {
    let top = 0, bottom = innerHeight;
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (getComputedStyle(a).overflowY === 'visible') continue;
      const b = a.getBoundingClientRect(); top = Math.max(top, b.top + a.clientTop); bottom = Math.min(bottom, b.top + a.clientTop + a.clientHeight);
    }
    if (footer !== null && !footer.contains(el) && getComputedStyle(footer).position === 'sticky') bottom = Math.min(bottom, footer.getBoundingClientRect().top);
    return [top, bottom];
  };
  const scrollers = (el) => { const out = []; for (let a = el.parentElement; a; a = a.parentElement) if (/^(auto|scroll)$/.test(getComputedStyle(a).overflowY) && a.scrollHeight > a.clientHeight) out.push(a); return out; };
  const saved = [...document.querySelectorAll('*')].filter((a) => a.scrollTop !== 0).map((a) => [a, a.scrollTop]);
  const inView = (el, edge) => { const r = el.getBoundingClientRect(); const [top, bottom] = view(el); const y = edge === 'top' ? r.top : r.bottom; return y >= top - 1 && y <= bottom + 1; };
  const reach = (el, edge) => {
    for (let i = 0; i < 4; i++) for (const sc of scrollers(el)) {
      const r = el.getBoundingClientRect(); const [top, bottom] = view(el); const y = edge === 'top' ? r.top : r.bottom;
      if (y < top) sc.scrollTop -= top - y; else if (y > bottom) sc.scrollTop += y - bottom;
    }
    return inView(el, edge);
  };
  const atOnce = { titleTop: inView(title, 'top'), titleBottom: inView(title, 'bottom'), buttons: buttons.length > 0 && buttons.every((b) => inView(b, 'top') && inView(b, 'bottom')) };
  const parts = [['question', title], ...options.map((o, i) => [`answer ${i + 1}`, o]), ...buttons.map((b) => [b.textContent.trim(), b])];
  const unreadable = parts.filter(([, el]) => !(reach(el, 'top') && reach(el, 'bottom'))).map(([name]) => name);
  for (const a of document.querySelectorAll('*')) if (a.scrollTop !== 0) a.scrollTop = 0;
  for (const [a, top] of saved) a.scrollTop = top;
  const rect = card.getBoundingClientRect(); const titleRect = title.getBoundingClientRect(); const body = card.querySelector(':scope > [data-question-scroll]');
  return { viewport: [innerWidth, innerHeight], chat: [Math.round(chat.top), Math.round(chat.bottom)], card: [Math.round(rect.top), Math.round(rect.bottom), Math.round(rect.width)],
    maxHeight: getComputedStyle(card).maxHeight, question: [Math.round(titleRect.height), title.scrollHeight], answersBox: body === null ? null : [body.clientHeight, body.scrollHeight],
    atOnce, unreadable, styles: document.querySelectorAll('style[data-composer-plus-question-fit]').length };
}

const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-qfit-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'qfit-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid },
      tables: { workspaces: { [wid]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3205', '--no-open'], { cwd: project,
      env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: WINDOW, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript((width) => {
        if (sessionStorage.getItem('qfit.started') === null) {
          sessionStorage.setItem('qfit.started', '1');
          localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"questionFit":false}');
          localStorage.setItem('dsh.conversation.contentWidth', width);
        }
      }, CHAT_WIDTH);
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const setSwitch = async (on) => {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name: 'Fit question card to window' }); await sw.waitFor({ timeout: 10000 });
        if ((await sw.isChecked()) !== on) await sw.click();
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const close = overlay.getByRole('button', { name: /^Close$/ });
        if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(500);
      };
      const card = page.locator('[data-question-key] > section');
      const shoot = async (name) => { const r = await card.boundingBox(); const top = Math.max(0, r.y - 48);
        const clip = { x: Math.max(0, r.x - 24), y: top, width: r.width + 48, height: Math.min(WINDOW.height, r.y + r.height + 12) - top };
        const png = join(home, `${name}.png`); await page.screenshot({ path: png, clip }); return { png, clip }; };

      await input.click(); await page.keyboard.type('Ask me about the release plan'); await page.keyboard.press('Enter');
      await card.waitFor({ timeout: 30000 }); await pause(1200);
      const off = await page.evaluate(measure); await shoot('off');
      console.log(`${bin}\n  switch off: ${JSON.stringify(off)}`);
      await setSwitch(true);
      const on = await page.evaluate(measure);
      const shot = await shoot('on');
      // A card full of text: 1× width and quality 60 keep the image under 60 kB.
      if (process.env.SHOT) execFileSync('cwebp', ['-quiet', '-q', '60', '-resize', String(Math.round(shot.clip.width)), '0', shot.png, '-o', join(repo, 'assets/features/questionFit.webp')]);
      const sizes = {};
      for (const height of [600, 1000]) { await page.setViewportSize({ width: WINDOW.width, height }); await pause(600); sizes[height] = await page.evaluate(measure); }
      await page.setViewportSize(WINDOW); await pause(600);
      console.log(`  switch on:  ${JSON.stringify(on)}\n  600 high:   ${JSON.stringify(sizes[600])}\n  1000 high:  ${JSON.stringify(sizes[1000])}`);
      if (off.unreadable.length === 0 && off.atOnce.buttons) console.log('  note: this dsh already fits the card without the feature');

      assert.deepEqual(on.unreadable, [], 'switch on: the whole question and every answer can be scrolled into view');
      assert.ok(on.atOnce.titleTop && on.atOnce.buttons, 'switch on: the start of the question, Skip and Submit are in view at once');
      assert.equal(on.styles, 1, 'one style element');
      for (const m of [on, sizes[600], sizes[1000]]) {
        assert.deepEqual(m.unreadable, [], `${m.viewport[1]} px high: the question and every answer can be scrolled into view`);
        assert.ok(m.atOnce.titleTop && m.atOnce.buttons, `${m.viewport[1]} px high: the start of the question, Skip and Submit are in view`);
        assert.ok(m.card[0] >= m.chat[0] && m.card[1] <= m.chat[1], `${m.viewport[1]} px high: the card stays inside the chat area`);
      }
      const height = (m) => m.card[1] - m.card[0];
      assert.ok(height(sizes[600]) < height(on) && height(on) < height(sizes[1000]), `the card height follows the window: ${height(sizes[600])} < ${height(on)} < ${height(sizes[1000])}`);

      await setSwitch(false);
      const again = await page.evaluate(measure);
      assert.equal(again.styles, 0, 'switch off removes the style');
      assert.equal(again.maxHeight, off.maxHeight, 'switch off gives dsh its own height cap back');
      await setSwitch(true);
      await card.locator('[role="radio"]').nth(1).click();
      await card.getByRole('button', { name: 'Submit', exact: true }).click();
      await page.getByText('Thanks, noted.').first().waitFor({ timeout: 20000 });
      await card.waitFor({ state: 'detached', timeout: 5000 });
      assert.match(answered, /Ship now/, 'the model got the chosen answer');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      results.push(`PASS ${bin}: off ${JSON.stringify(off.unreadable)} unreadable · on everything readable at 600/820/1000 px, card ${height(sizes[600])}/${height(on)}/${height(sizes[1000])} px · switch off/on · answer sent`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      results.push(`FAIL ${bin}: ${error?.stack ?? error}\n  kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
for (const r of results) console.log(r);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
