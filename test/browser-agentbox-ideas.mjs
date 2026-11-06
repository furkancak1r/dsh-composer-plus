// Real-app check of Next waiting chat with a fake model, on each dsh given. No real model, never the normal DSH_HOME.
// Two chats ask a question (dsh's orange dot), one after the other, and one chat finishes a turn while another chat is
// open (dsh's green dot). Then:
// - the sidebar header shows "Next waiting chat (3)" with an orange dot, first in dsh's header buttons;
// - Cmd+Shift+E (Ctrl+Shift+E) opens the chat that asked first, also while the composer has the focus; the count drops
//   by the chat on screen; the button opens the next one; the green chat comes last;
// - the command is on dsh's Keyboard shortcuts page;
// - when no other chat waits, the button is hidden and the key does nothing;
// - switched off in Settings, the button and the command go.
// PLAYWRIGHT=/path/to/playwright node test/browser-agentbox-ideas.mjs /path/to/dsh/lib/bin.js [...]
// Option picks: an answer that ends with an option list gets one button per option (the recommended one marked); text in
// the composer hides them; a double click sends one "Option N: …" message; Next message prediction makes no call meanwhile;
// a Turn rollback of the pick offers the options again; on a question card, keys 1–9 pick option N (not in the answer
// field); switched off, no buttons.
// SHOT=1 also writes assets/features/nextWaiting.webp and optionPicks.webp (English UI, demo chats only).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake OpenAI-compatible model: "ask:<topic>" asks one question with ask_user_question; "slow:<topic>" answers
// "Finished <topic>." after 4 s (time to open another chat, so this one gets the green dot); the rest answers "Done.".
const TITLES = { 'ask:deploy': 'Deploy target', 'ask:colors': 'Theme colors', 'slow:lint': 'Lint fixes', 'Plan the docs': 'Docs plan', 'opts:': 'Login fix' };
// "opts:<n>" answers with an option list; "ask:three" asks a question with three options. Next message prediction asks
// with its own prompt: the fake answers it and counts the calls.
const OPTIONS_ANSWER = (n) => `I fixed the login redirect (round ${n}).\n\n## Options\n\n1. Merge it now\n2. Add a test first (recommended)\n   with a fixture for the redirect\n3. Leave it for later`;
const sentToModel = []; let predictCalls = 0;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? []; const last = msgs.at(-1);
    if (/next message that the user will type/.test(JSON.stringify(msgs))) { predictCalls += 1; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta: { role: 'assistant', content: 'Run the tests.' }, finish_reason: 'stop' }] })}\n\n`); res.end('data: [DONE]\n\n'); return; }
    const users = msgs.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    const lastUser = users.filter((u) => !/runtime context|session title|Time sampled while preparing/i.test(u)).at(-1) ?? '';
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const end = () => res.end('data: [DONE]\n\n');
    if (/session title/i.test(JSON.stringify(last?.content))) { const k = Object.keys(TITLES).find((x) => JSON.stringify(last.content).includes(x)); send({ role: 'assistant', content: TITLES[k] ?? 'Demo task' }); send({}, 'stop'); end(); return; }
    if (last?.role === 'user') sentToModel.push(lastUser);
    const opts = lastUser.match(/opts:(\d+)/)?.[1];
    if (opts && last?.role !== 'tool') { send({ role: 'assistant', content: OPTIONS_ANSWER(opts) }); send({}, 'stop'); end(); return; }
    const slow = lastUser.match(/slow:(\w+)/)?.[1];
    if (slow) { setTimeout(() => { send({ role: 'assistant', content: `Finished ${slow}.` }); send({}, 'stop'); end(); }, 4000); return; }
    const topic = lastUser.match(/ask:(\w+)/)?.[1];
    if (topic && last?.role !== 'tool') {
      const question = topic === 'deploy' ? { id: 'target', header: 'Deploy', question: 'Which environment should I deploy to?', options: [{ label: 'Staging (Recommended)' }, { label: 'Production' }] }
        : topic === 'three' ? { id: 'size', header: 'Size', question: 'Which page size should the report use?', options: [{ label: 'A4' }, { label: 'Letter' }, { label: 'A5' }] }
        : { id: 'palette', header: 'Colors', question: 'Which color palette should the theme use?', options: [{ label: 'Blue' }, { label: 'Green' }] };
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [question] }) } }] });
      send({}, 'tool_calls'); end(); return;
    }
    send({ role: 'assistant', content: 'Done.' }); send({}, 'stop'); end();
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-next-waiting-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'next-waiting-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3198', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const consoleErrors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"idleSwitch":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
      await page.goto(url);
      for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      const sendIn = async (text) => {
        await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
        await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter');
      };
      const card = (text) => page.getByText(text, { exact: true }).first();
      const shown = (text) => card(text).isVisible().catch(() => false);
      const button = page.locator('[data-composer-plus-next-waiting] > button');
      const label = () => button.getAttribute('aria-label');
      const nextKey = () => page.keyboard.press('ControlOrMeta+Shift+KeyE');

      // No chat waits yet: no button.
      await page.locator('[class*="_headerActions"]').first().waitFor();
      assert.equal(await button.count(), 0, 'nothing waits: no button');
      // Two questions (deploy first), one green chat, then a fourth chat stays open.
      await sendIn('ask:deploy'); await card('Which environment should I deploy to?').waitFor({ timeout: 20000 }); await pause(1500);
      await sendIn('ask:colors'); await card('Which color palette should the theme use?').waitFor({ timeout: 20000 }); await pause(1500);
      await sendIn('slow:lint'); await pause(500);
      await sendIn('Plan the docs'); await page.getByText('Done.', { exact: true }).first().waitFor({ timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-next-waiting] > button')?.getAttribute('aria-label') === 'Next waiting chat (3)', null, { timeout: 20000 });
      assert.equal((await button.innerText()).trim(), '3', 'the count');
      const dot = await button.locator('span').evaluate((e) => e.style.background);
      assert.match(dot, /state-warn-primary/, 'orange dot: the next chat asks a question');
      const first = await page.evaluate(() => document.querySelector('[class*="_headerActions"]')?.firstElementChild?.hasAttribute('data-composer-plus-next-waiting'));
      assert.equal(first, true, 'first in dsh\'s header buttons');
      // The header fits: with the button, Collapse all projects and a long label (Turkish "Çalışma alanları"), dsh's search
      // icon was cut. Now its slot keeps 28 px, the label shortens and no header item overlaps another.
      const header = () => page.evaluate(() => {
        const head = document.querySelector('[class*="_listArea"]').parentElement.querySelector(':scope > [class*="_sectionHeader"]');
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
        const label = head.querySelector(':scope > [class*="_sectionLabel"]');
        const items = [label, head.querySelector(':scope > [class*="_searchSlot"]'), ...head.querySelector(':scope > [class*="_headerActions"]').querySelectorAll('button')].map(box);
        const overlap = items.some((a, i) => items.slice(i + 1).some((b) => a.right > b.left + 0.5 && b.right > a.left + 0.5));
        return { search: box(head.querySelector(':scope > [class*="_searchSlot"]')).width, overlap, clipped: label.scrollWidth > label.clientWidth };
      });
      await page.evaluate(() => { for (const el of document.querySelectorAll('[class*="_sectionLabel"]')) el.dataset.cpText = el.textContent; });
      for (const text of ['Workspaces', 'Çalışma alanları', 'Không gian làm việc']) {
        await page.evaluate((t) => { for (const el of document.querySelectorAll('[class*="_sectionLabel"]')) el.textContent = t; }, text);
        const fit = await header();
        assert.equal(fit.search, 28, `${text}: the search icon keeps its 28 px`); assert.equal(fit.overlap, false, `${text}: nothing overlaps`);
      }
      await page.evaluate(() => { for (const el of document.querySelectorAll('[class*="_sectionLabel"]')) el.textContent = el.dataset.cpText; });
      if (index === 0 && process.env.SHOT) {
        // The sidebar with the button and the rows with dsh's dots; nothing personal.
        await page.mouse.move(700, 500); await pause(800);
        const png = join(home, 'nextWaiting.png'); const area = { x: 0, y: 0, width: 640, height: 420 };
        await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/nextWaiting.webp')]);
      }

      // The key, with the focus in the composer: the chat that asked first opens; it no longer counts.
      await input.click(); await nextKey();
      await card('Which environment should I deploy to?').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await shown('Which color palette should the theme use?'), false, 'the chat that asked first opens first');
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-next-waiting] > button')?.getAttribute('aria-label') === 'Next waiting chat (2)', null, { timeout: 10000 });
      // The button: the second question. The deploy chat, now off screen, waits again and keeps its place before the green
      // chat (orange first, and it began to wait first). Its project is collapsed first ("Collapse all projects"): the
      // click opens the chat, opens the project again, and the chat's row blinks for 5 s, then dsh's selection stays.
      await page.locator('[data-composer-plus-collapse-projects] > button').click();
      await page.waitForFunction(() => document.querySelector('[data-row-key^="workspace:"][aria-expanded="true"]') === null, null, { timeout: 5000 });
      await button.click();
      await card('Which color palette should the theme use?').waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForFunction(() => document.querySelector('[data-row-key^="session:"][data-composer-plus-locate]') !== null, null, { timeout: 5000 });
      const located = await page.evaluate(() => {
        const r = document.querySelector('[data-composer-plus-locate]'); const box = r.getBoundingClientRect();
        return { selected: r.getAttribute('aria-selected'), text: r.textContent, animation: getComputedStyle(r).animationName,
          project: document.querySelector('[data-row-key^="workspace:"]')?.getAttribute('aria-expanded'), inView: box.top >= 0 && box.bottom <= innerHeight };
      });
      assert.deepEqual({ ...located, text: located.text.includes('Theme colors') }, { selected: 'true', text: true, animation: 'cp-locate', project: 'true', inView: true },
        'the opened chat\'s row: found, its project open again, in view, blinking');
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-locate]') === null, null, { timeout: 8000 });
      assert.equal(await page.locator('[data-row-key^="session:"][aria-selected="true"]').count(), 1, 'after 5 s dsh\'s own selected row stays');
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-next-waiting] > button')?.getAttribute('aria-label') === 'Next waiting chat (2)', null, { timeout: 10000 });
      assert.match(await button.locator('span').evaluate((e) => e.style.background), /state-warn-primary/, 'the deploy chat waits again: still orange next');
      // Answer both questions, then the green chat is the only one left.
      // Each answered chat finishes its turn on screen (the fake model says "Done."), so it gets no green dot.
      await page.getByText('Blue', { exact: true }).first().click();
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
      await card('Which color palette should the theme use?').waitFor({ state: 'hidden', timeout: 20000 });
      await card('Done.').waitFor({ state: 'visible', timeout: 20000 }); await pause(1000);
      await button.click();
      await card('Which environment should I deploy to?').waitFor({ state: 'visible', timeout: 10000 });
      await page.getByText('Staging', { exact: true }).first().click();
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
      await card('Which environment should I deploy to?').waitFor({ state: 'hidden', timeout: 20000 });
      await card('Done.').waitFor({ state: 'visible', timeout: 20000 }); await pause(1000);
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-next-waiting] > button')?.getAttribute('aria-label') === 'Next waiting chat (1)', null, { timeout: 20000 });
      await nextKey();
      await card('Finished lint.').waitFor({ state: 'visible', timeout: 10000 });
      await button.waitFor({ state: 'detached', timeout: 10000 });
      // Nothing waits: the key does nothing (the open chat stays).
      await nextKey(); await pause(800);
      assert.equal(await shown('Finished lint.'), true, 'nothing waits: the key does nothing');

      // dsh's Keyboard shortcuts page lists the command with its key.
      await page.keyboard.press('ControlOrMeta+Slash');
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 10000 });
      const rowText = await dialog.getByText('Next waiting chat', { exact: true }).first().locator('xpath=ancestor::li[1]').innerText();
      assert.match(rowText.replace(/\s+/g, ' '), /Next waiting chat (⇧ ⌘|Ctrl \+ Shift|Shift \+ Ctrl|Ctrl\+Shift) ?\+? ?E/i, `listed with its key: ${rowText}`);
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });

      // --- Option picks ---
      // An answer that ends with an option list: one button per option under it, the recommended one marked; Next
      // message prediction makes no call meanwhile.
      const picks = page.locator('[data-composer-plus-option-picks]');
      const predictBefore = predictCalls;
      await sendIn('opts:1'); await page.getByText('I fixed the login redirect (round 1).').first().waitFor({ timeout: 20000 });
      await picks.waitFor({ timeout: 20000 });
      const pickButtons = picks.locator('button');
      assert.equal(await pickButtons.count(), 3, 'one button per option');
      assert.deepEqual((await pickButtons.allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim()), ['1. Merge it now', '2. Add a test first Recommended', '3. Leave it for later']);
      assert.equal(await pickButtons.nth(1).getAttribute('data-recommended'), '', 'the recommended option is marked');
      assert.equal(await picks.evaluate((e) => e.closest('[data-turn-tail]') !== null), true, 'in dsh\'s turn tail, under the answer');
      await pause(2500);
      assert.equal(predictCalls, predictBefore, 'options show: Next message prediction makes no model call');
      assert.equal(await page.locator('[data-composer-plus-prediction]').count(), 0, 'and shows no guess');
      if (index === 0 && process.env.SHOT) {
        // The answer with its option buttons; made-up chat only.
        await page.mouse.move(1200, 120); await pause(600);
        const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
        const top = await rect(page.getByText('I fixed the login redirect (round 1).').first()); const bottom = await rect(picks);
        const area = { x: Math.max(0, top.x - 24), y: Math.max(0, top.y - 20), width: 760, height: Math.min(420, bottom.bottom - top.y + 40) };
        const png = join(home, 'optionPicks.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/optionPicks.webp')]);
      }
      // Text in the composer hides them; an empty composer shows them again.
      await input.click(); await page.keyboard.type('hm'); await picks.waitFor({ state: 'detached', timeout: 5000 });
      await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await picks.waitFor({ timeout: 5000 });
      // A double click sends one message: the whole item.
      const modelBefore = sentToModel.length;
      await pickButtons.nth(1).dblclick();
      await page.getByText('Done.', { exact: true }).last().waitFor({ timeout: 20000 }); await pause(1500);
      const picked = sentToModel.slice(modelBefore).filter((m) => m.includes('Option '));
      assert.equal(picked.length, 1, `one message: ${JSON.stringify(sentToModel.slice(modelBefore))}`);
      assert.match(picked[0], /Option 2: Add a test first\\nwith a fixture for the redirect/, 'the whole item, without the mark');
      assert.equal(await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'Option 2: Add a test first' }).count(), 1, 'a normal message in the chat');
      assert.equal(await picks.count(), 0, 'the next answer has no list: no buttons');
      // Turn rollback (Chat only) withdraws the pick and its answer: the option answer offers again (rule 9).
      const pickRow = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'Option 2: Add a test first' }).first();
      await pickRow.hover(); await pickRow.getByRole('button', { name: 'Roll back to before this message' }).click();
      const pop = page.locator('[data-composer-plus-rollback]');
      await pop.getByRole('button', { name: /^Chat only/ }).click(); await pop.waitFor({ state: 'detached', timeout: 20000 });
      await page.keyboard.press('Escape'); await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
      await picks.waitFor({ timeout: 20000 });
      assert.equal(await pickButtons.count(), 3, 'the withdrawn pick: the options offer again');
      // Question card keys: 1–9 pick option N after the first 800 ms; not while typing in the answer field.
      await sendIn('ask:three'); const sizeQ = card('Which page size should the report use?'); await sizeQ.waitFor({ timeout: 20000 });
      const radios = page.locator('[data-question-key] [role="radio"]');
      await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.evaluate(() => document.activeElement?.blur?.());
      await pause(1000);
      await page.keyboard.press('3');
      await page.waitForFunction(() => document.querySelectorAll('[data-question-key] [role="radio"]')[2]?.getAttribute('aria-checked') === 'true', null, { timeout: 5000 });
      await page.keyboard.press('9'); await pause(300);
      assert.equal(await radios.nth(2).getAttribute('aria-checked'), 'true', 'no option 9: nothing changes');
      const field = page.locator('[data-question-key] textarea, [data-question-key] input').first();
      await field.click(); await page.keyboard.type('1'); await pause(300);
      assert.equal(await field.inputValue(), '1', 'in the answer field, a digit is text');
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
      await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press('2');
      await page.waitForFunction(() => document.querySelectorAll('[data-question-key] [role="radio"]')[1]?.getAttribute('aria-checked') === 'true', null, { timeout: 5000 });
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
      await sizeQ.waitFor({ state: 'hidden', timeout: 20000 });
      // Switched off: no buttons and no keys.
      await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('dsh-composer-plus.features')); s.optionPicks = false; localStorage.setItem('dsh-composer-plus.features', JSON.stringify(s)); });
      await sendIn('opts:2'); await page.getByText('I fixed the login redirect (round 2).').first().waitFor({ timeout: 20000 });
      await page.reload(); await input.waitFor(); await page.getByText('I fixed the login redirect (round 2).').first().waitFor({ timeout: 20000 }); await pause(2500);
      assert.equal(await picks.count(), 0, 'off: no option buttons');
      await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('dsh-composer-plus.features')); delete s.optionPicks; localStorage.setItem('dsh-composer-plus.features', JSON.stringify(s)); });
      await page.reload(); await input.waitFor(); await picks.waitFor({ timeout: 20000 });

      // Switched off: no button host and no command (a waiting chat would show the button otherwise).
      await sendIn('ask:deploy'); await card('Which environment should I deploy to?').waitFor({ timeout: 20000 }); await pause(1000);
      await page.locator('button:visible', { hasText: 'New Session' }).first().click();
      await button.waitFor({ timeout: 10000 });
      await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('dsh-composer-plus.features')); s.nextWaiting = false; localStorage.setItem('dsh-composer-plus.features', JSON.stringify(s)); });
      await page.reload(); await input.waitFor(); await pause(3000);
      assert.equal(await page.locator('[data-composer-plus-next-waiting]').count(), 0, 'off: no button host');
      await page.keyboard.press('ControlOrMeta+Slash'); await dialog.waitFor({ timeout: 10000 });
      assert.equal(await dialog.getByText('Next waiting chat', { exact: true }).count(), 0, 'off: no command');
      await page.keyboard.press('Escape');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      const probe = page === undefined ? null : await page.evaluate(async () => {
        const id = document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.getAttribute('data-row-key')?.slice(8);
        const rb = id === undefined ? null : await fetch(`/api/composer-plus.rollback?sessionId=${encodeURIComponent(id)}`).then(async (r) => `${r.status} ${await r.text()}`, (e) => String(e));
        return { id, rb, slotErrors: [...document.querySelectorAll('[data-slot-error], [data-factory-error]')].map((e) => e.outerHTML.slice(0, 200)), tails: document.querySelectorAll('[data-turn-tail]').length };
      }).catch((e) => String(e));
      console.error(`probe: ${JSON.stringify(probe)}; console errors: ${JSON.stringify(consoleErrors.slice(-8))}`);
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
