// Real-app check of "Assistant callouts" on each dsh given: a fake model, a throwaway DSH_HOME and HOME, a made-up project
// (acme-web). Never the normal DSH_HOME, no real model. Headless, with Chromium's sandbox.
// 1. The assistant chat's request has the section; another chat's request does not.
// 2. An answer with the boxes (problem, approval, questions, important, running, result) and a details section: each box
//    has its kind and its label in the UI language, its marker is gone from the text, the colors differ; the `onay` block
//    after them still gets its Approve button.
// 3. The details section is closed: one button with the summary (aria-expanded false), its body hidden. A click opens
//    it; Enter and Space on the focused button close and open it. A screen reader finds it as a button with its name.
// 4. A streamed answer: while the details body streams in, the page above it does not move (the section stays closed).
// 5. Dark theme: the box colors and the label stay readable (contrast of the label to the box).
// 6. Turkish UI: the labels are Turkish.
// 7. Another chat with the same answer: plain quotes with their markers. Switched off in Settings: the request has no
//    section and the open assistant chat shows plain quotes again; on again: the boxes are back. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-callouts.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/assistantCallouts.webp (English UI, light theme, made-up content).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); }
};
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const RULE = '# Assistant callouts (Composer Plus)';
const SENTENCE = 'Approve: push the branch feature/login-fix of acme-web to origin.';
const ANSWER = [
  '**The login fix is ready, one test still fails.**',
  '',
  '> [!PROBLEM]',
  '> The login test fails on Safari: the **Sign in** button stays disabled.',
  '',
  'The other browsers pass.',
  '',
  '> [!APPROVAL]',
  '> Push the branch so that CI runs the Safari job.',
  '',
  '```onay',
  SENTENCE,
  '```',
  '',
  '> [!QUESTIONS]',
  '> - Keep Safari 16 in the test matrix?',
  '',
  '> [!IMPORTANT]',
  '> The release branch is frozen until Friday.',
  '',
  '> [!RUNNING]',
  '> The nightly test run of acme-web, about 10 minutes.',
  '',
  '> [!RESULT]',
  '> 41 of 42 tests pass.',
  '',
  '> [!DETAILS] Test output (3 files)',
  '> - login.spec.ts: 13 passed, 1 failed',
  '> - signup.spec.ts: 18 passed',
  '> - reset.spec.ts: 10 passed',
  '',
  'Plain quote:',
  '',
  '> Just a quote.',
].join('\n');
/** The contrast of a box's label (its ::before) to the box as the eye sees it, run in the page. */
const CONTRAST = (el) => {
  const parse = (c) => {
    const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(c);
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
    const rgb = /^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)$/.exec(c);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
    throw new Error(`color: ${c}`);
  };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const layers = []; for (let at = el; at; at = at.parentElement) { const c = parse(getComputedStyle(at).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
  let bg = [255, 255, 255, 1]; if (layers.at(-1)?.[3] >= 1) bg = layers.pop(); for (const c of layers.reverse()) bg = over(c, bg);
  const fg = over(parse(getComputedStyle(el, '::before').color), bg);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};
const KINDS = ['problem', 'approval', 'questions', 'important', 'running', 'result', 'details'];
const LABELS = { en: { problem: 'Problem', approval: 'Approval needed', questions: 'Open questions', important: 'Important', running: 'Still running', result: 'Result' },
  tr: { problem: 'Sorun', approval: 'Onay gerekli', questions: 'Açık sorular', important: 'Önemli', running: 'Süren işler', result: 'Sonuç' } };
// Fake OpenAI-compatible model. "boxes" answers with ANSWER; "stream" sends the details body in slow parts.
const calls = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const end = () => { send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const say = (t) => { send({ role: 'assistant', content: t }); end(); };
    const all = msgs.map((m) => textOf(m.content)).join('\n');
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Login fix');
    if (/You predict the next message|You complete the message that the user is typing|label a coding task/.test(all)) return say('');
    const own = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t) => !/^<|^Current runtime context|^Time sampled/.test(t.trim()));
    const last = own.at(-1) ?? '';
    const system = msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
    calls.push({ last, rule: system.includes(RULE) || all.includes(RULE) });
    if (/^boxes/.test(last.trim())) return say(ANSWER);
    if (/^stream/.test(last.trim())) {
      const parts = ['**Streamed answer.**\n\n> [!DETAILS] Long log\n> - line 1\n', ...Array.from({ length: 12 }, (_, i) => `> - line ${i + 2}\n`), '\nDone streaming.'];
      send({ role: 'assistant', content: '' });
      let i = 0; const step = () => { if (i < parts.length) { send({ content: parts[i++] }); setTimeout(step, 250); } else end(); }; step();
      return undefined;
    }
    return say('ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
let shotDone = false;
try {
  for (const bin of process.argv.slice(2)) {
    calls.length = 0;
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-callouts-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-callouts-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const dir = join(home, 'projects', 'acme-web'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'README.md'), '# acme-web\n');
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid }, tables: { workspaces: { [wid]: { path: dir, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3216', '--no-open'], { cwd: dir,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"idleSwitch":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const settings = async () => {
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        await page.locator('[data-composer-plus-settings]').waitFor();
      };
      const back = async () => {
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const button = overlay.getByRole('button', { name: /^Close$/ });
        if (await button.count()) await button.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(400);
      };
      const clear = async () => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.press('Escape'); };
      const send = async (text) => { await clear(); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      const idle = () => until(async () => (await page.locator('[data-composer-input]').count()) === 1 && (await page.getByRole('button', { name: /^Stop/ }).count()) === 0, 'idle', 40000);
      const assistantRow = () => page.locator('button[aria-label="Damon"]');
      const box = (kind) => page.locator(`blockquote[data-cp-callout="${kind}"]`).last();
      const toggle = () => box('details').locator(':scope > button.cp-co-toggle');
      const labelOf = (loc) => loc.evaluate((el) => getComputedStyle(el, '::before').content.replace(/^"|"$/g, ''));

      // Settings: the row has its screenshot and is on by default.
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      const sw = page.getByRole('switch', { name: 'Assistant callouts', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      assert.equal(await sw.locator('xpath=..').locator('[data-composer-plus-shot="assistantCallouts"]').count(), 1, 'the row has its screenshot');
      await back();

      // 1–2. The assistant chat: the section in the request; the boxes.
      await assistantRow().click();
      await until(async () => (await page.locator('[data-composer-plus-assistant]').count()) === 0, 'assistant chat open');
      await send('boxes 1');
      await box('details').waitFor({ timeout: 30000 }); await idle();
      assert.ok(calls.find((c) => c.last.startsWith('boxes 1'))?.rule, 'the assistant request carries the section');
      for (const kind of KINDS) assert.equal(await page.locator(`blockquote[data-cp-callout="${kind}"]`).count(), 1, `one ${kind} box`);
      for (const [kind, label] of Object.entries(LABELS.en)) assert.equal(await labelOf(box(kind)), label, `${kind} label`);
      for (const kind of KINDS) assert.doesNotMatch(await box(kind).innerText(), /\[!/, `${kind}: the marker is gone`);
      assert.match(await box('problem').innerText(), /The login test fails on Safari/);
      assert.equal(await page.locator('blockquote:not([data-cp-callout])').filter({ hasText: 'Just a quote.' }).count(), 1, 'a plain quote stays plain');
      const colors = await Promise.all(KINDS.slice(0, 6).map((k) => box(k).evaluate((el) => getComputedStyle(el).borderLeftColor)));
      assert.equal(new Set(colors).size, 6, `each box has its own color: ${colors}`);
      const approve = page.locator('[data-composer-plus-approve] button');
      await approve.waitFor({ timeout: 20000 });
      assert.match((await approve.innerText()).replace(/\s+/g, ' '), new RegExp(`Approve ${SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the onay block keeps its button');
      note('1-2: the section in the request; seven boxes with labels and colors; the onay button stays');

      // 3. The details section: closed, a button with the summary; click, Enter and Space.
      const details = box('details');
      assert.equal(await toggle().count(), 1, 'one button');
      assert.equal(await toggle().innerText(), 'Test output (3 files)', 'the summary');
      assert.equal(await toggle().getAttribute('aria-expanded'), 'false', 'closed by default');
      assert.equal(await details.getByText('signup.spec.ts: 18 passed').isVisible(), false, 'the body is hidden');
      assert.equal(await page.getByRole('button', { name: 'Test output (3 files)', exact: true }).count(), 1, 'a button for screen readers');
      if (process.env.SHOT && !shotDone) {
        await page.setViewportSize({ width: 1280, height: 1500 }); await pause(600);
        const first = page.getByText('The login fix is ready, one test still fails.', { exact: true }).last();
        await first.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.evaluate(() => window.scrollBy(0, 0));
        await page.mouse.move(1270, 1490); await pause(600);
        const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
        const top = await rect(first); const bottom = await rect(details);
        const area = { x: Math.max(0, top.x - 24), y: Math.max(0, top.y - 16), width: bottom.right + 24 - Math.max(0, top.x - 24), height: bottom.bottom - Math.max(0, top.y - 16) + 20 };
        const png = join(home, 'callouts.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '74', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/assistantCallouts.webp')]);
        await page.setViewportSize({ width: 1280, height: 900 }); await pause(400);
        shotDone = true; note(`SHOT: assets/features/assistantCallouts.webp ${(await stat(join(repo, 'assets/features/assistantCallouts.webp'))).size} bytes`);
      }
      await toggle().click();
      assert.equal(await toggle().getAttribute('aria-expanded'), 'true', 'a click opens it');
      assert.equal(await details.getByText('signup.spec.ts: 18 passed').isVisible(), true, 'the body shows');
      await toggle().focus(); await page.keyboard.press('Enter');
      assert.equal(await toggle().getAttribute('aria-expanded'), 'false', 'Enter closes it');
      await page.keyboard.press('Space');
      assert.equal(await toggle().getAttribute('aria-expanded'), 'true', 'Space opens it');
      await page.keyboard.press('Space');
      note('3: details closed by default; click, Enter and Space; a named button');

      // 4. Streaming: the details body streams in; the box above it does not move and the section stays closed.
      await send('stream 1');
      const streamed = page.locator('blockquote[data-cp-callout="details"]').filter({ hasText: 'Long log' });
      await streamed.waitFor({ timeout: 30000 });
      const anchor = page.getByText('Streamed answer.', { exact: true }).last();
      const ys = []; const heights = [];
      for (let i = 0; i < 10; i++) {
        ys.push(await anchor.evaluate((el) => Math.round(el.getBoundingClientRect().top)));
        heights.push(await streamed.evaluate((el) => Math.round(el.getBoundingClientRect().height)));
        await pause(250);
      }
      await idle();
      assert.equal(await streamed.locator(':scope > button.cp-co-toggle').getAttribute('aria-expanded'), 'false', 'still closed after streaming');
      assert.equal(new Set(heights).size, 1, `the closed section keeps its height while it streams: ${heights}`);
      assert.ok(Math.max(...ys) - Math.min(...ys) <= 2 || ys.every((y, i) => i === 0 || y <= ys[i - 1]), `no jump down while it streams: ${ys}`);
      assert.equal(await streamed.getByText('line 13').isVisible(), false, 'the streamed body is hidden');
      note(`4: streaming keeps the closed section at one height (${heights[0]} px)`);

      // 5. Light and dark theme: each label reads on its box.
      for (const kind of KINDS.slice(0, 6)) { const c = await box(kind).evaluate(CONTRAST); assert.ok(c >= 4.5, `light: the ${kind} label reads (contrast ${c.toFixed(2)})`); }
      await page.emulateMedia({ colorScheme: 'dark' }); await pause(600);
      const dark = await page.evaluate(() => document.documentElement.classList.contains('dark') || document.body.classList.contains('dark') || matchMedia('(prefers-color-scheme: dark)').matches);
      assert.ok(dark, 'the page is dark');
      const contrast = await box('problem').evaluate(CONTRAST);
      assert.ok(contrast >= 4.5, `dark: the label reads (contrast ${contrast.toFixed(2)})`);
      for (const kind of KINDS.slice(1, 6)) { const c = await box(kind).evaluate(CONTRAST); assert.ok(c >= 4.5, `dark: the ${kind} label reads (contrast ${c.toFixed(2)})`); }
      await page.emulateMedia({ colorScheme: 'light' }); await pause(300);
      note(`5: dark theme label contrast ${contrast.toFixed(2)}`);

      // 7a. Another chat: the same answer shows plain quotes with their markers, and no section in its request.
      const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first();
      await proj.hover(); await page.getByRole('button', { name: 'New session in acme-web', exact: true }).click(); await pause(800);
      await send('boxes 2');
      await page.getByText('Just a quote.', { exact: true }).last().waitFor({ timeout: 30000 }); await idle();
      assert.equal(calls.find((c) => c.last.startsWith('boxes 2'))?.rule, false, 'no section for another chat');
      assert.equal(await page.locator('blockquote[data-cp-callout]').count(), 0, 'no boxes in another chat');
      assert.ok(await page.locator('blockquote').filter({ hasText: '[!PROBLEM]' }).count() >= 1, 'the marker reads as plain text');
      note('7a: another chat: plain quotes with markers, no section');

      // 7b. Off in Settings: plain quotes in the assistant chat and no section; on again: the boxes are back.
      await settings(); await sw.click(); await until(async () => (await sw.getAttribute('aria-checked')) === 'false', 'switched off'); await back();
      await assistantRow().click(); await page.getByText('Just a quote.', { exact: true }).first().waitFor({ timeout: 20000 });
      assert.equal(await page.locator('blockquote[data-cp-callout]').count(), 0, 'off: no boxes');
      assert.equal(await page.locator('button.cp-co-toggle').count(), 0, 'off: no details buttons');
      assert.ok(await page.locator('blockquote').filter({ hasText: '[!PROBLEM]' }).count() >= 1, 'off: the markers are back in the text');
      await send('boxes 3'); await until(() => calls.find((c) => c.last.startsWith('boxes 3')), 'request'); await idle();
      assert.equal(calls.find((c) => c.last.startsWith('boxes 3')).rule, false, 'off: no section');
      await settings(); await sw.click(); await until(async () => (await sw.getAttribute('aria-checked')) === 'true', 'switched on'); await back();
      await assistantRow().click(); await box('details').waitFor({ timeout: 20000 });
      note('7b: off removes the boxes and the section; on brings them back');

      // 6. Turkish UI: a window with the Turkish system language shows Turkish labels.
      const trContext = await browser.newContext({ locale: 'tr-TR', viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
      await trContext.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"idleSwitch":false}'); });
      const tr = await trContext.newPage(); tr.on('pageerror', (e) => errors.push(String(e)));
      await tr.goto(url); await tr.waitForFunction(() => document.documentElement.lang === 'tr');
      for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = tr.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      await tr.keyboard.press('Escape');
      await tr.locator('button[aria-label="Damon"]').click();
      const trBox = (kind) => tr.locator(`blockquote[data-cp-callout="${kind}"]`).last();
      await trBox('details').waitFor({ timeout: 20000 });
      for (const [kind, label] of Object.entries(LABELS.tr)) assert.equal(await labelOf(trBox(kind)), label, `tr ${kind}`);
      await trContext.close();
      note('6: Turkish labels in a Turkish window');

      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}\n${log.split('\n').filter((l) => /error|warn|callout/i.test(l)).slice(-30).join('\n')}`);
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
