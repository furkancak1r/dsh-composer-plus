// Real-app check of Quote from file preview on each dsh given: a fake model, a throwaway DSH_HOME and a made-up project
// (acme-web). Never the normal DSH_HOME, no real model. Headless.
// 1. Right sidebar → Files → src/login.js (code): select lines 2–3 → Quote → the model gets your text, `src/login.js:2-3`
//    and the two lines in a code block (no line numbers of the viewer in it).
// 2. notes.txt (plain text): a triple-click-like selection of line 2 → `notes.txt:2`.
// 3. docs/guide.md (Markdown): a part → the path and a `> ` quote.
// 4. docs/spec.pdf (PDF): the text of page 1 → `docs/spec.pdf#page=1` and a `> ` quote.
// 5. A selection in the preview's header (the path) shows no button; a selection in an answer shows no button either (Quote in
//    reply is in the right-click menu there).
// 6. Settings → Quote from file preview is on by default; switched off → no button; no page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-preview-quote.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/previewQuote.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'node:fs/promises';
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

// A one-page PDF with the text "Hello PDF line" (Helvetica, no other resources).
const PDF = (() => {
  const stream = 'BT /F1 18 Tf 20 120 Td (Hello PDF line) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  return `${out}xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
})();
const LOGIN = 'export function login(user) {\n  if (!user) throw Error("no user");\n  return token(user);\n}\n';
const TASK = 'Review the login code';
const sent = []; // the last user message of each chat request
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const last = textOf(msgs.at(-1)?.content);
    if (/session title/i.test(last)) return say('Login review');
    if (/You predict the next message|You complete the message that the user is typing/.test(JSON.stringify(msgs))) return say('');
    // dsh adds runtime notes after the prompt: the user's own message is the newest one that is not such a note.
    const own = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t) => !/^(Current runtime context|Time sampled)/.test(t)).at(-1) ?? '';
    sent.push(own);
    return say(`Answer ${sent.length}: the guard returns early.`);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    sent.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-previewquote-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'preview-quote-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
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
    const project = join(home, 'projects', 'acme-web');
    await mkdir(join(project, 'src'), { recursive: true }); await mkdir(join(project, 'docs'), { recursive: true });
    await writeFile(join(project, 'notes.txt'), 'first line\nsecond line\nthird line\n');
    await writeFile(join(project, 'src', 'login.js'), LOGIN);
    await writeFile(join(project, 'docs', 'guide.md'), '# Guide\n\nRun `npm test` before you push.\n');
    await writeFile(join(project, 'docs', 'spec.pdf'), PDF);
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3241', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const sendNow = async () => { const n = sent.length; await input.click(); await page.keyboard.press('Enter'); await until(() => sent.length > n, 'the model gets the message'); await until(async () => (await page.getByText(`Answer ${n + 1}:`).count()) > 0, 'the answer shows'); return sent.at(-1); };
      await input.click(); await page.keyboard.type(TASK, { delay: 5 }); await sendNow();

      // Open the right sidebar → Files, then a file of the project.
      const side = page.locator('[data-sidebar-right-session]').first();
      await page.getByRole('button', { name: 'Open right sidebar' }).click(); await pause(700);
      await page.getByText('Workspace files', { exact: true }).first().click(); await pause(800);
      const open = async (dir, file) => {
        const filesTab = side.locator('[role="tab"]').filter({ hasText: /^Files$/ }).first();
        if (await filesTab.isVisible().catch(() => false)) { await filesTab.click(); await pause(500); }
        const row = side.getByText(file, { exact: true }).first();
        if (dir && !(await row.isVisible().catch(() => false))) { await side.getByText(dir, { exact: true }).first().click(); await pause(500); }
        await row.click();
        await until(() => page.evaluate((file) => [...document.querySelectorAll('[data-textpreview-state="text"][data-document-preview]')].some((r) => r.offsetParent !== null && String(r.getAttribute('data-textpreview-url')).endsWith(file)), file), `${file} preview`);
        await pause(600);
      };
      // Select from the start of row `a` (or `aOffset` in it) to the end of row `b` (or the start of row `bStart`) of the shown preview.
      const selectRows = (rowSel, a, b, endAtNextStart = false) => page.evaluate(([rowSel, a, b, endAtNextStart]) => {
        const root = [...document.querySelectorAll('[data-textpreview-state="text"][data-document-preview]')].find((r) => r.offsetParent !== null);
        const rows = [...root.querySelectorAll(rowSel)];
        const range = document.createRange(); range.setStart(rows[a], 0);
        if (endAtNextStart) range.setEnd(rows[b + 1], 0); else range.setEnd(rows[b], rows[b].childNodes.length);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        return sel.toString();
      }, [rowSel, a, b, endAtNextStart]);
      const button = page.locator('[data-composer-plus-preview-quote]');
      const quote = async () => { await button.waitFor({ timeout: 5000 }); await button.click(); await button.waitFor({ state: 'detached', timeout: 5000 }); };

      // 1. Code: lines 2–3 of src/login.js.
      await open('src', 'login.js');
      await input.click(); await page.keyboard.type('Why this guard?', { delay: 5 });
      const picked = await selectRows('pre .line', 1, 2);
      assert.equal(picked, '  if (!user) throw Error("no user");\n  return token(user);', `the selection holds no line numbers: ${JSON.stringify(picked)}`);
      await button.waitFor({ timeout: 5000 });
      assert.equal(await button.innerText(), '❝ Quote');
      if (index === 0 && process.env.SHOT) {
        await page.mouse.move(640, 790); await pause(300);
        // Only the picture: the path label shows a made-up folder, not this computer's temp folder.
        await page.evaluate(() => {
          const label = [...document.querySelectorAll('[data-textpreview-path]')].find((l) => l.offsetParent !== null);
          // dsh's PathLabel: the label > a text span > [folder span, name span].
          const parts = label?.firstElementChild?.children;
          if (parts?.length === 2) parts[0].textContent = '~/projects/acme-web/src/';
          if (label) label.title = '~/projects/acme-web/src/login.js';
        });
        const box = await page.locator('[data-sidebar-right-panel]').first().boundingBox(); const b = await button.boundingBox();
        const x = Math.max(0, Math.min(box.x, b.x) - 8); const y = Math.max(0, box.y);
        const area = { x, y, width: Math.min(1280 - x, box.x + box.width - x), height: Math.min(800 - y, Math.max(260, b.y + b.height + 90 - y)) };
        const png = join(home, 'previewQuote.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/previewQuote.webp')]);
        note(`shot: assets/features/previewQuote.webp ${(await stat(join(repo, 'assets/features/previewQuote.webp'))).size} bytes`);
      }
      await quote();
      assert.equal(await input.evaluate((el) => el.contains(document.activeElement) || el === document.activeElement), true, 'the composer has the focus');
      const m1 = await sendNow();
      assert.equal(m1, 'Why this guard?\n\n`src/login.js:2-3`\n```\n  if (!user) throw Error("no user");\n  return token(user);\n```', `code: ${JSON.stringify(m1)}`);
      note('1: src/login.js lines 2–3 → Quote → "Why this guard?" + `src/login.js:2-3` + the code block reaches the model');

      // 2. Plain text: line 2 of notes.txt, selected up to the start of line 3 (as a triple-click does).
      await open(null, 'notes.txt');
      await selectRows('[data-textpreview-line]', 1, 1, true);
      await quote();
      await page.keyboard.type('Rename it.', { delay: 5 });
      const m2 = await sendNow();
      assert.equal(m2, '`notes.txt:2`\n```\nsecond line\n```\n\nRename it.', `text: ${JSON.stringify(m2)}`);
      note('2: notes.txt line 2 (triple-click end) → `notes.txt:2` + the line');

      // 3. Markdown: a part of the paragraph.
      await open('docs', 'guide.md');
      await page.evaluate(() => {
        const root = [...document.querySelectorAll('[data-document-markdown]')].find((r) => r.offsetParent !== null);
        const p = [...root.querySelectorAll('p')].find((x) => x.textContent.includes('before you push'));
        const range = document.createRange(); range.selectNodeContents(p); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      });
      await quote();
      const m3 = await sendNow();
      assert.equal(m3, '`docs/guide.md`\n> Run npm test before you push.', `Markdown: ${JSON.stringify(m3)}`);
      note('3: docs/guide.md → the path + a > quote');

      // 4. PDF: the text of page 1.
      await open('docs', 'spec.pdf');
      await until(() => page.evaluate(() => [...document.querySelectorAll('[data-pdf-text] span')].some((s) => s.textContent.includes('Hello PDF line'))), 'the PDF text layer', 20000);
      await page.evaluate(() => {
        const span = [...document.querySelectorAll('[data-pdf-text] span')].find((s) => s.textContent.includes('Hello PDF line'));
        const range = document.createRange(); range.selectNodeContents(span); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      });
      await quote();
      const m4 = await sendNow();
      assert.equal(m4, '`docs/spec.pdf#page=1`\n> Hello PDF line', `PDF: ${JSON.stringify(m4)}`);
      note('4: docs/spec.pdf → `docs/spec.pdf#page=1` + a > quote');

      // 5. The header (the file path) shows no button; Quote in reply still works on an answer.
      await open('src', 'login.js');
      await page.evaluate(() => {
        const root = [...document.querySelectorAll('[data-textpreview-state="text"][data-document-preview]')].find((r) => r.offsetParent !== null);
        const label = root.querySelector('[data-textpreview-path]'); const range = document.createRange(); range.selectNodeContents(label);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      });
      await pause(600);
      assert.equal(await button.count(), 0, 'the header: no button');
      await page.evaluate(() => {
        const a = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')].findLast((x) => x.textContent.includes('the guard returns early'));
        const range = document.createRange(); range.selectNodeContents(a); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      });
      await pause(800);
      assert.equal(await button.count(), 0, 'an answer: no preview button');
      await page.evaluate(() => window.getSelection().removeAllRanges());
      note('5: a selection of the path label or of an answer shows no preview button');

      // 6. Settings: on by default; switched off → no button.
      const direct = page.getByRole('button', { name: 'Settings', exact: true });
      if (await direct.isVisible()) await direct.click();
      else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
      await page.getByText('Composer Plus', { exact: true }).click();
      const sw = page.getByRole('switch', { name: 'Quote from file preview', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'false', 'switched off');
      await page.keyboard.press('Escape'); await pause(600);
      await selectRows('pre .line', 0, 1);
      await pause(800);
      assert.equal(await button.count(), 0, 'off: no button');
      note('6: on by default; switched off → no button');

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (page) await writeFile(join(home, 'failed.html'), await page.content().catch(() => '')).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; sent: ${JSON.stringify(sent)}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  fake.close();
}
