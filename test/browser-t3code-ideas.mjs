// Real-app check of the t3code ideas on each dsh given: a fake model, a throwaway DSH_HOME, a made-up project (demo-app).
// Never the normal DSH_HOME, no real model. Headless.
// Reject with note:
// 1. The agent's `rm -rf build-old` waits for dsh's approval card (a test-only gate answers `ask`). The card has
//    "Reject with note…" next to dsh's Reject; a click opens the field; Enter in the empty field does nothing (dsh's card
//    would allow on Enter outside a text field: nothing is allowed); the note + Enter rejects.
// 2. The next model request ends with the rejection result and then the note (one model call); the command did not run;
//    the note shows in the chat; the agent answers.
// 3. Esc in the field closes it without a rejection; dsh's own Reject still works.
// 4. Switched off: no button on the next card. No page errors.
// Secret input:
// 5. The agent calls `request_secret`: dsh's row of the call shows the card (label, purpose, a password field). Save sends
//    the value; while the turn runs, the file is owner-only (0600 in a 0700 folder). The agent's `read` of the file is
//    denied; its `cat` result reaches the model as `[secret]`. The value is not in any model request, the chat log, the
//    dsh output or the page. The file is gone when the turn ends; the row says "Saved".
// 6. Decline: the agent reads "did not give". 7. dsh's Stop while the card waits: the card goes, no file.
// 8. Switched off (Settings → Composer Plus → Secret input): the tool is not in the next model request.
// PLAYWRIGHT=/path/to/playwright node test/browser-t3code-ideas.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/rejectNote.webp and secretInput.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat, access, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
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

const TASK = { A: 'Clean up the old build folder', B: 'Clean up the old build folder again', C: 'Clean up the old build folder once more' };
const NOTE = 'Do not delete it. Move it to archive/build-old instead.';
const SECRET_TASK = { S: 'Publish the demo package with my token', D: 'Publish the demo package, ask me first', T: 'Publish the demo package when I am back', O: 'Publish the demo package one more time' };
const VALUE = `npm_demo_${randomUUID().replaceAll('-', '')}`;
const calls = []; // {task, msgs, tools}
const fileSeen = []; // the secret file while the turn runs: {path, mode, dirMode}
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const call = (name, args, text = '') => {
      send({ role: 'assistant', content: text, tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n');
    };
    const all = JSON.stringify(msgs);
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Clean up the build');
    if (/You predict the next message|You complete the message that the user is typing/.test(all)) return say('');
    const own = msgs.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    const secretTask = Object.keys(SECRET_TASK).find((k) => all.includes(SECRET_TASK[k]));
    if (secretTask !== undefined) {
      calls.push({ task: secretTask, msgs, tools: parsed.tools ?? [] });
      const last = textOf(msgs.at(-1)?.content);
      if (secretTask === 'O') return say('Switched off: no secret tool.');
      if (own === 0) return call('request_secret', { label: 'npm token', purpose: 'Publish demo-app to the demo registry.' }, 'I need your npm token.');
      const path = /to (\S+) \(owner-only\)/.exec(all)?.[1];
      if (secretTask === 'S' && own === 1 && path !== undefined) {
        try { fileSeen.push({ path, mode: statSync(path).mode & 0o777, dirMode: statSync(join(path, '..')).mode & 0o777 }); } catch (error) { fileSeen.push({ path, error: String(error) }); }
        return call('read', { file_path: path });
      }
      if (secretTask === 'S' && own === 2) return call('bash', { command: `printf 'token=%s\\n' "$(cat ${path})"`, description: 'Show the token line' });
      return say(`Done. Last result: ${last.slice(0, 200)}`);
    }
    const task = all.includes(TASK.C) ? 'C' : all.includes(TASK.B) ? 'B' : all.includes(TASK.A) ? 'A' : '?';
    calls.push({ task, msgs });
    if (task !== '?' && own === 0) {
      send({ role: 'assistant', content: 'I will delete the old build folder.', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'rm -rf build-old', description: 'Delete the old build folder' }) } }] });
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    return say(all.includes(NOTE) ? 'Understood: I will move build-old to archive/ instead of deleting it.' : 'The command was rejected, so I stopped.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    calls.length = 0; fileSeen.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-t3ideas-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 't3code-ideas-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    // A test-only gate: dsh's approval card for `rm -rf build-old` (this permission mode would run it without a card).
    const gate = join(home, 'ask-gate.mjs');
    await writeFile(gate, "export const name = 't3code-ideas-ask-gate';\nexport function apply(ctx) {\n  ctx.on('tools/pre-execute', async (exec, next) => {\n    const d = await next();\n    return exec.name === 'bash' && String(exec.arguments?.command ?? '').includes('build-old') && d?.kind === 'allow' ? { kind: 'ask', reason: 'Deletes a folder' } : d;\n  });\n}\n");
    await writeFile(join(profile, 'cordis.patch.yml'), `- insert:
    - id: t3code-ideas-ask-gate
      name: ${gate}
- id: ui-settings-general
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
    const project = join(home, 'projects', 'demo-app');
    await mkdir(join(project, 'build-old'), { recursive: true });
    await writeFile(join(project, 'build-old', 'app.js'), 'console.log("old build");\n');
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'demo-app', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3227', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      const send = async (text) => { await input.click(); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Enter'); };
      const newChat = async () => {
        const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'demo-app' }).first();
        await proj.hover();
        await page.getByRole('button', { name: 'New session in demo-app', exact: true }).click(); await pause(800);
      };
      const folderKept = () => access(join(project, 'build-old', 'app.js')).then(() => true, () => false);
      const card = page.locator('[data-approval-key]').first();

      // 1. The button on dsh's card, the field, Enter on an empty field.
      await send(TASK.A);
      await card.waitFor({ timeout: 30000 });
      const button = card.getByRole('button', { name: 'Reject with note…', exact: true });
      await button.waitFor({ timeout: 10000 });
      // The portal adds the button after dsh's buttons in the DOM; CSS `order` puts it left of Reject on screen.
      const order = await card.locator('button').evaluateAll((list) => list.map((b) => ({ text: b.innerText, x: b.getBoundingClientRect().x })).sort((a, b) => a.x - b.x).map((b) => b.text));
      assert.deepEqual(order.slice(-3), ['Reject with note…', 'Reject', 'Allow once'], `the button sits left of Reject: ${JSON.stringify(order)}`);
      await button.click();
      const field = card.getByRole('textbox', { name: 'Tell the agent why, or what to do instead' });
      await field.waitFor();
      assert.equal(await field.evaluate((el) => el === document.activeElement), true, 'the field has the focus');
      const shown = async () => (await card.locator('button').evaluateAll((list) => list.filter((b) => b.offsetParent !== null).map((b) => b.innerText))).sort();
      assert.deepEqual(await shown(), ['Cancel', 'Reject'], 'while you write: only Cancel and Reject (no Allow once, no second Reject)');
      await page.keyboard.press('Enter');
      await pause(800);
      assert.equal(await card.isVisible(), true, 'Enter in the empty field allows nothing and rejects nothing');
      assert.equal(calls.filter((c) => c.task === 'A').length, 1, 'no model call yet');
      await field.fill(NOTE);
      if (index === 0 && process.env.SHOT) {
        await page.mouse.move(1000, 100); await pause(400);
        const box = await card.boundingBox();
        const area = { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: Math.min(1280, box.width + 32), height: Math.min(800, box.height + 32) };
        const png = join(home, 'rejectNote.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/rejectNote.webp')]);
        note(`shot: assets/features/rejectNote.webp ${(await stat(join(repo, 'assets/features/rejectNote.webp'))).size} bytes`);
      }
      await field.press('Enter');
      note('1: "Reject with note…" next to Reject; the field has the focus; Enter on an empty field does nothing');

      // 2. The next model request: the rejection, then the note. The command did not run.
      await until(async () => calls.filter((c) => c.task === 'A').length >= 2, 'model call after the rejection');
      await until(async () => (await page.getByText('Understood: I will move build-old to archive/ instead of deleting it.').count()) > 0, 'chat A answers');
      const after = calls.filter((c) => c.task === 'A')[1];
      const tail = after.msgs.slice(-2).map((m) => ({ role: m.role, text: textOf(m.content) }));
      assert.equal(tail[0].role, 'tool'); assert.match(tail[0].text, /rejected/);
      assert.deepEqual(tail[1], { role: 'user', text: NOTE }, 'the note comes after the rejection');
      assert.equal(calls.filter((c) => c.task === 'A').length, 2, 'one model call for the rejection and the note');
      assert.equal(await folderKept(), true, 'the command did not run');
      assert.ok(await page.getByText(NOTE, { exact: true }).count() >= 1, 'the note shows in the chat');
      note('2: next request ends with the rejection and then the note (1 model call); build-old kept; the note shows in the chat');

      // 3. Esc closes the field; dsh's own Reject still works.
      await newChat();
      await send(TASK.B);
      await card.waitFor({ timeout: 30000 });
      await card.getByRole('button', { name: 'Reject with note…', exact: true }).click();
      const field2 = card.getByRole('textbox', { name: 'Tell the agent why, or what to do instead' });
      await field2.fill('not sent');
      await field2.press('Escape');
      await field2.waitFor({ state: 'detached' });
      assert.equal(await card.isVisible(), true, 'Esc in the field rejects nothing');
      assert.deepEqual(await shown(), ['Allow once', 'Reject', 'Reject with note…'], 'Esc brings dsh\'s buttons back');
      await card.getByRole('button', { name: 'Reject', exact: true }).click();
      await until(async () => (await page.getByText('The command was rejected, so I stopped.').count()) > 0, 'chat B answers');
      assert.ok(!JSON.stringify(calls.filter((c) => c.task === 'B').at(-1).msgs).includes('not sent'), 'the closed note was not sent');
      assert.equal(await folderKept(), true);
      note('3: Esc closes the field without a rejection; dsh\'s Reject works; the closed note was not sent');

      // 4. Switched off: no button.
      const direct = page.getByRole('button', { name: 'Settings', exact: true });
      if (await direct.isVisible()) await direct.click();
      else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
      await page.getByText('Composer Plus', { exact: true }).click();
      const sw = page.getByRole('switch', { name: 'Reject with note', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'false', 'switched off');
      await page.keyboard.press('Escape'); await pause(600);
      await newChat();
      await send(TASK.C);
      await card.waitFor({ timeout: 30000 });
      await pause(800);
      assert.equal(await card.getByRole('button', { name: 'Reject with note…', exact: true }).count(), 0, 'off: no button');
      await card.getByRole('button', { name: 'Reject', exact: true }).click();
      note('4: switched off → no button on the card');

      // 5. Secret input: the card on dsh's row of the call, Save, the file while the turn runs, the masks, no trace.
      const secrets = join(home, 'storages', 'dsh-composer-plus', 'secrets');
      const secretFiles = () => readdir(secrets).catch(() => []);
      const secretCard = page.locator('[data-composer-plus-secret]').first();
      const currentChat = () => page.evaluate(() => new URL(location.href).searchParams.get('session')
        ?? [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => r.getAttribute('aria-current') === 'page' || r.getAttribute('aria-selected') === 'true')?.getAttribute('data-row-key').slice(8));
      const asks = async () => { const id = await currentChat(); assert.ok(id, 'the open chat has an id'); return page.evaluate(async (sid) => (await fetch(`/api/composer-plus.secret-answer?sessionId=${encodeURIComponent(sid)}`)).json(), id); };
      await newChat();
      await send(SECRET_TASK.S);
      await secretCard.waitFor({ timeout: 30000 });
      assert.match(await secretCard.innerText(), /Secret: npm token/); assert.match(await secretCard.innerText(), /Publish demo-app to the demo registry\./);
      const secretField = secretCard.getByRole('textbox', { name: 'npm token' }).or(secretCard.locator('input[type="password"]')).first();
      assert.equal(await secretField.getAttribute('type'), 'password'); assert.equal(await secretField.getAttribute('autocomplete'), 'off');
      const toolEntry = calls.find((c) => c.task === 'S').tools.find((x) => (x.function?.name ?? x.name) === 'request_secret');
      assert.ok(toolEntry, 'the tool is in the model request');
      const schemaChars = JSON.stringify(toolEntry).length;
      assert.equal(await secretCard.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'Save is off for an empty field');
      await secretField.fill(VALUE);
      if (index === 0 && process.env.SHOT) {
        await page.mouse.move(1000, 100); await pause(400);
        const box = await secretCard.boundingBox();
        const area = { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: Math.min(1280, box.width + 32), height: Math.min(800, box.height + 32) };
        const png = join(home, 'secretInput.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/secretInput.webp')]);
        note(`shot: assets/features/secretInput.webp ${(await stat(join(repo, 'assets/features/secretInput.webp'))).size} bytes`);
      }
      await secretCard.getByRole('button', { name: 'Save', exact: true }).click();
      await until(async () => (await page.getByText(/^Done\. Last result: token=\[secret\]/).count()) > 0, 'chat S ends with the masked cat result');
      const sCalls = calls.filter((c) => c.task === 'S');
      assert.equal(sCalls.length, 4, 'request_secret, read, bash, answer');
      assert.equal(fileSeen.length, 1); assert.equal(fileSeen[0].error, undefined, `the file exists while the turn runs: ${fileSeen[0].error}`);
      assert.deepEqual([fileSeen[0].mode, fileSeen[0].dirMode], [0o600, 0o700], 'owner-only file and folder');
      assert.ok(fileSeen[0].path.startsWith(`${secrets}/`), 'the file is in the secrets folder');
      const toolTexts = (c) => c.msgs.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
      assert.match(toolTexts(sCalls[1]).at(-1), /saved "npm token" to .*\(owner-only\)/, 'the tool result names the file, not the value');
      assert.match(toolTexts(sCalls[2]).at(-1), /holds a secret from Composer Plus/, 'the read tool is denied');
      assert.equal(toolTexts(sCalls[3]).at(-1).trim(), 'token=[secret]', 'the cat result reaches the model masked');
      assert.ok(calls.every((c) => !JSON.stringify(c.msgs).includes(VALUE)), 'the value is in no model request');
      await until(async () => (await secretFiles()).length === 0, 'the file goes when the turn ends', 10000);
      // dsh folds a finished turn ("Completed in 1s"; the rows are `hidden="until-found"`): read the row's text as it is.
      const rowText = () => page.locator('[data-tool="request_secret"]').first().textContent({ timeout: 2000 }).catch(() => '');
      await until(async () => (await rowText()).includes('npm token · Saved'), 'the row says "npm token · Saved"', 10000);
      assert.ok(!(await page.content()).includes(VALUE), 'the value is not in the page');
      note(`5: card (password field) → Save → file 0600 in 0700 while the turn runs → read denied → cat result "token=[secret]" → file gone; value in no model request and not in the page; tool schema ${schemaChars} characters`);

      // 6. Decline.
      await newChat();
      await send(SECRET_TASK.D);
      await secretCard.waitFor({ timeout: 30000 });
      await secretCard.getByRole('button', { name: 'Decline', exact: true }).click();
      await until(async () => (await page.getByText(/^Done\. Last result: The user did not give this secret/).count()) > 0, 'chat D goes on without the secret');
      assert.deepEqual(await secretFiles(), [], 'no file after Decline');
      await until(async () => (await rowText()).includes('npm token · Declined'), 'the row says "npm token · Declined"', 10000);
      note('6: Decline → the agent reads "did not give" and goes on; no file');

      // 7. dsh's Stop while the card waits.
      await newChat();
      await send(SECRET_TASK.T);
      await secretCard.waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: /^Stop/ }).first().click();
      await secretCard.waitFor({ state: 'detached', timeout: 15000 });
      assert.deepEqual((await asks()).asks, [], 'no open ask after Stop');
      assert.deepEqual(await secretFiles(), [], 'no file after Stop');
      note('7: Stop while the card waits → the card goes, no open ask, no file');

      // 8. Switched off: the tool is not in the next model request.
      const openSettings = async () => {
        const direct2 = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct2.isVisible()) await direct2.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
      };
      await openSettings();
      const sw2 = page.getByRole('switch', { name: 'Secret input', exact: true });
      await sw2.waitFor({ timeout: 10000 });
      assert.equal(await sw2.getAttribute('aria-checked'), 'true', 'Secret input is on by default');
      await sw2.click();
      await until(async () => (await sw2.getAttribute('aria-checked')) === 'false', 'Secret input switched off');
      assert.equal((await page.evaluate(async () => (await fetch('/api/composer-plus.secrets')).json())).on, false, 'the Host keeps the switch');
      await page.keyboard.press('Escape'); await pause(600);
      await newChat();
      await send(SECRET_TASK.O);
      await until(async () => (await page.getByText('Switched off: no secret tool.').count()) > 0, 'chat O answers');
      assert.ok(!calls.find((c) => c.task === 'O').tools.some((x) => (x.function?.name ?? x.name) === 'request_secret'), 'off: no tool in the request');
      note('8: switched off → the tool is not in the next model request');

      // No trace of the value anywhere in the dsh home (chat logs decompressed) or in dsh's output.
      assert.ok(!log.includes(VALUE), 'the value is not in the dsh output');
      const leaks = [];
      const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(p); continue; }
          if (!entry.isFile()) continue;
          const data = p.endsWith('.zstd') ? execFileSync('zstd', ['-dcq', p], { maxBuffer: 256 * 1024 * 1024 }) : await (await import('node:fs/promises')).readFile(p);
          if (data.includes(VALUE)) leaks.push(p);
        }
      };
      await walk(home);
      assert.deepEqual(leaks, [], 'the value is in no file of the dsh home');
      note('no trace: the value is in no file of the dsh home (chat logs decompressed) and not in the dsh output');

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (page) await writeFile(join(home, 'failed.html'), await page.content().catch(() => '')).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; calls: ${JSON.stringify(calls.map((c) => ({ task: c.task, last: c.msgs.at(-1)?.role })))}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
