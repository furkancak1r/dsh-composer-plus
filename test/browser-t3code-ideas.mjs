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
// 5. The agent calls `request_secret` (dsh's desktop view "standard", which folds the turn's steps): the card opens the
//    closed step group by itself and is on the screen without a click. The card has a label, a purpose and a password
//    field. Save sends
//    the value; while the turn runs, the file is owner-only (0600 in a 0700 folder). The agent's `read` of the file is
//    denied; its `cat` result reaches the model as `[secret]`. The value is not in any model request, the chat log, the
//    dsh output or the page. The file is gone when the turn ends; the row says "Saved".
// 6. Decline: the agent reads "did not give". 7. dsh's Stop while the card waits: the card goes, no file.
// 8. Switched off (Settings → Composer Plus → Secret input): the tool is not in the next model request.
// Quote in reply:
// 9. A selection shows no floating button; a right-click on a part of an answer → the menu (Copy, Quote) → Quote → the
//    quote goes after the text that you typed, the composer has the focus, and the sent message holds your text, the quote
//    and the next line in order. (The menu's labels, This Mac and the other Mac, light and dark: browser-quote-menu.mjs.)
// 10. Switched off: no menu of ours.
// Side chat:
// 11. While the chat waits on an approval card (its turn runs), a queued message waits too. The side question → a new chat
//     opens with the bar ("Side chat of …: read-only"). Its model request has the chat's task, the lead and the question,
//     not the queued message; its write is denied (dsh's read-only mode) and no approval card shows; the chat's card stays.
// 12. Bring back: the chat opens and its composer holds the question (quoted) and the answer. 13. Switched off: no button.
// Diff notes (the demo project is a git repository with one changed file):
// 14. Right sidebar → Changes → Uncommitted → the file's diff: + on a line → a note → Save; Shift+click a range on another
//     line → a note. The bar says "2 note(s) on the diff". 15. Send to composer: the chat's composer has both notes as
//     Markdown after your text; the bar goes; the sent message holds them. 16. Switched off: no + and no bar.
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
const QUOTE_TASK = 'Explain the release steps';
const NOTES_TASK = 'Review my cart change';
const SIDE_TASK = 'Refactor the cart module'; const SIDE_Q = 'Which file holds the cart totals?'; const SIDE_QUEUED = 'Then update the changelog';
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
    if (all.includes(NOTES_TASK)) {
      calls.push({ task: 'N', msgs });
      return say(textOf(msgs.at(-1)?.content).includes('src/cart.js') ? 'I will apply your notes.' : 'Open Changes to see the diff.');
    }
    if (all.includes(SIDE_Q)) {
      calls.push({ task: 'SQ', msgs, tools: parsed.tools ?? [] });
      // Count the side chat's own tool calls only (the copied part has the chat's bash call).
      const at = msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content).includes(SIDE_Q));
      if (msgs.slice(at).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length === 0) return call('write', { file_path: 'notes.txt', content: 'side note' }, 'I will write a note.');
      return say('Side answer: the totals are in cart/totals.js. I could not write a note: this side chat is read-only.');
    }
    if (all.includes(SIDE_TASK)) {
      calls.push({ task: 'SP', msgs });
      if (own === 0) return call('bash', { command: 'rm -rf build-old', description: 'Delete the old build folder' }, 'I will clean up first.');
      return say('Parent goes on.');
    }
    if (all.includes(QUOTE_TASK)) {
      calls.push({ task: 'Q', msgs });
      return say(textOf(msgs.at(-1)?.content).includes('Do it on Friday.') ? 'Noted: the tag goes out on Friday.' : 'Step one: run the tests.\n\nStep two: tag the release and push the tag.');
    }
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
    // Also a test-only route that queues a message through dsh's own prompt (the composer is hidden under a card).
    await writeFile(gate, "export const name = 't3code-ideas-ask-gate';\nexport const inject = ['connection', 'sessionController'];\nexport function apply(ctx) {\n  ctx.connection.fetch.register({ path: '/api/t3ideas-test.queue', methods: ['POST'], requestBody: 'buffered', fetch: async (request) => { const b = await request.json(); await ctx.sessionController.prompt({ requestId: crypto.randomUUID(), sessionId: b.sessionId, mode: 'queue', content: [{ type: 'text', text: b.text }] }, AbortSignal.timeout(10000)); return Response.json({ ok: true }); } });\n  ctx.on('tools/pre-execute', async (exec, next) => {\n    const d = await next();\n    return exec.name === 'bash' && String(exec.arguments?.command ?? '').includes('build-old') && d?.kind === 'allow' ? { kind: 'ask', reason: 'Deletes a folder' } : d;\n  });\n}\n");
    await writeFile(join(profile, 'cordis.patch.yml'), `- insert:
    - id: t3code-ideas-ask-gate
      name: ${gate}
- id: ui-settings-general
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
    const project = join(home, 'projects', 'demo-app');
    await mkdir(join(project, 'build-old'), { recursive: true });
    await writeFile(join(project, 'build-old', 'app.js'), 'console.log("old build");\n');
    // Diff notes: a made-up repository with one changed file (src/cart.js).
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
    const git = (...args) => execFileSync('git', args, { cwd: project, env: gitEnv, encoding: 'utf8' });
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(project, 'src', 'cart.js'), 'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n');
    git('init', '-q', '-b', 'main'); git('add', 'src/cart.js'); git('commit', '-q', '-m', 'Add the cart');
    await writeFile(join(project, 'src', 'cart.js'), 'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price * i.qty;\n  return Math.round(sum * 100) / 100;\n}\n');
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
      // The desktop view ("standard", set above) folds the running turn's steps into a closed group: the card must open
      // it by itself (owner report: the card waited unseen inside the closed group). No click on the group here.
      await secretCard.waitFor({ state: 'visible', timeout: 30000 });
      await until(async () => {
        const box = await secretCard.boundingBox();
        return box !== null && box.height > 0 && box.y >= 0 && box.y + box.height <= 800;
      }, 'the card is on the screen without a click', 5000);
      assert.equal(await secretCard.evaluate((c) => c.closest('[data-step-process]')?.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') ?? 'no group'), 'true', 'the step group that holds the card is open');
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
      note(`5: "standard" view: the card opens its closed step group by itself and is on the screen → card (password field) → Save → file 0600 in 0700 while the turn runs → read denied → cat result "token=[secret]" → file gone; value in no model request and not in the page; tool schema ${schemaChars} characters`);

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

      // 9. Quote in reply: select a part of an answer, right-click it → Quote → the quote at the composer's caret, after your text.
      await newChat();
      await send(QUOTE_TASK);
      await until(async () => (await page.getByText('Step two: tag the release and push the tag.').count()) > 0, 'chat Q answers');
      // Select `text` inside the first matching element (`scope`) of the open chat; the browser fires selectionchange.
      const select = (scope, text) => page.evaluate(([scope, text]) => {
        const root = [...document.querySelectorAll(scope)].find((el) => el.textContent.includes(text));
        if (root === undefined) return false;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const i = n.data.indexOf(text);
          if (i < 0) continue;
          const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + text.length);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          return true;
        }
        return false;
      }, [scope, text]);
      const ANSWER = '[data-conversation-session] [data-chat-flow-kind="assistant-step"]';
      // The middle of the selection: a right-click there opens the menu.
      const middle = () => page.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      const ourMenu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Quote', exact: true }) });
      await input.click(); await page.keyboard.type('About step two:', { delay: 5 });
      assert.equal(await select(ANSWER, 'tag the release and push the tag'), true, 'the answer text is selectable');
      await pause(500);
      assert.equal(await page.locator('[data-composer-plus-quote], [data-text-interaction-surface] button').count(), 0, 'no floating button');
      let at = await middle();
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await ourMenu.waitFor({ timeout: 5000 });
      assert.deepEqual(await ourMenu.getByRole('menuitem').allInnerTexts(), ['Copy', 'Quote']);
      await ourMenu.getByRole('menuitem', { name: 'Quote', exact: true }).click();
      await ourMenu.waitFor({ state: 'hidden', timeout: 5000 });
      assert.equal(await input.evaluate((el) => el.contains(document.activeElement) || el === document.activeElement), true, 'the composer has the focus');
      await page.keyboard.type('Do it on Friday.', { delay: 5 });
      await page.keyboard.press('Enter');
      await until(async () => (await page.getByText('Noted: the tag goes out on Friday.').count()) > 0, 'chat Q answers the quote');
      const sent = textOf(calls.filter((c) => c.task === 'Q').at(-1).msgs.at(-1).content);
      assert.equal(sent, 'About step two:\n\n> tag the release and push the tag\n\nDo it on Friday.', `the message holds your text, the quote and the next line in order: ${JSON.stringify(sent)}`);
      note('9: no floating button; right-click on a part of the answer → Copy, Quote → Quote → "About step two:\\n\\n> …\\n\\nDo it on Friday." reaches the model');

      // 10. Switched off: no menu of ours.
      await openSettings();
      const sw3 = page.getByRole('switch', { name: 'Quote in reply', exact: true });
      await sw3.waitFor({ timeout: 10000 });
      assert.equal(await sw3.getAttribute('aria-checked'), 'true', 'Quote in reply is on by default');
      await sw3.click();
      await until(async () => (await sw3.getAttribute('aria-checked')) === 'false', 'Quote in reply switched off');
      await page.keyboard.press('Escape'); await pause(600);
      assert.equal(await select(ANSWER, 'run the tests'), true);
      at = await middle(); await page.mouse.click(at.x, at.y, { button: 'right' });
      await pause(800);
      assert.equal(await ourMenu.count(), 0, 'off: no menu of ours');
      await page.keyboard.press('Escape');
      note('10: switched off → no menu of ours');

      // 11. Side chat while the chat waits on an approval card, with a queued message.
      await newChat();
      await send(SIDE_TASK);
      await card.waitFor({ timeout: 30000 });
      const parentId = await until(() => page.evaluate(() => document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.getAttribute('data-row-key')?.slice(8)), 'parent chat id');
      // dsh hides the composer while the card shows: queue a message through dsh's own prompt (test-only route).
      const post = (path, body) => page.evaluate(async ([path, body]) => {
        const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, data: await r.json().catch(() => ({})) };
      }, [path, body]);
      assert.equal((await post('/api/t3ideas-test.queue', { sessionId: parentId, text: SIDE_QUEUED })).status, 200, 'a message waits in the queue');
      assert.equal((await post('/api/composer-plus.side-chat', { sessionId: parentId, text: '  ' })).status, 400, 'an empty question is refused');
      // The composer (and its side button) is hidden under the card: this step uses the button's route; step 12 the button.
      const side = await post('/api/composer-plus.side-chat', { sessionId: parentId, text: SIDE_Q });
      assert.equal(side.status, 200, JSON.stringify(side.data));
      // The copy already has the chat's (closed) bash call: wait for the second request, the one after its own write.
      await until(async () => calls.filter((c) => c.task === 'SQ').length >= 2, 'the side chat writes and reads the result', 40000);
      const sq = calls.filter((c) => c.task === 'SQ');
      const firstSide = JSON.stringify(sq[0].msgs);
      assert.ok(firstSide.includes(SIDE_TASK), 'the side chat knows the chat\'s task');
      assert.ok(!firstSide.includes(SIDE_QUEUED), 'the queued message does not run in the side chat');
      // dsh adds its runtime-context messages after the question: find the side chat's own first message.
      const asked = sq[0].msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).find((x) => x.startsWith('Side question.'));
      assert.ok(asked?.endsWith(SIDE_Q), `its first own message is the lead and the question: ${JSON.stringify(asked?.slice(-80))}`);
      const writeResult = textOf(sq[1].msgs.filter((m) => m.role === 'tool').at(-1).content);
      assert.match(writeResult, /read-only|denied|sandbox/i, `the write is denied: ${writeResult.slice(0, 200)}`);
      assert.equal(await access(join(project, 'notes.txt')).then(() => true, () => false), false, 'no file written');
      assert.equal(await card.isVisible(), true, 'the chat\'s card stays');
      assert.equal(calls.filter((c) => c.task === 'SP').length, 1, 'the chat made no model call meanwhile');
      note('11: side chat while the chat waits on its card: it knows the task, gets the lead + question, its write is denied, no card in it, the chat\'s card stays');
      // The button path: a side question typed in another chat's composer opens the side chat with the bar.
      await card.getByRole('button', { name: 'Reject', exact: true }).click();
      // The chat ends its turn, then runs the queued message.
      await until(async () => calls.filter((c) => c.task === 'SP').length >= 3 && (await page.getByText('Parent goes on.').count()) > 0, 'the chat runs its turn and the queued message', 40000);
      assert.ok(JSON.stringify(calls.filter((c) => c.task === 'SP').at(-1).msgs).includes(SIDE_QUEUED), 'the queued message ran in the chat');
      await pause(800);
      const sideButton = page.locator('[data-composer-plus-side]');
      await input.click(); await page.keyboard.type(SIDE_Q, { delay: 3 });
      await sideButton.click();
      const bar = page.locator('[data-composer-plus-side-bar]');
      await bar.waitFor({ timeout: 20000 });
      assert.match(await bar.innerText(), /Side chat of .*read-only/);
      await until(async () => (await page.getByText(/^Side answer: the totals are in cart\/totals\.js/).count()) > 0, 'the side chat answers', 40000);
      const sideRow = await page.evaluate(() => document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.innerText ?? '');
      assert.match(sideRow, /↳ Which file holds the cart totals\?/, `the side chat is named after the question: ${sideRow}`);
      if (index === 0 && process.env.SHOT) {
        await page.mouse.move(1000, 100); await pause(400);
        const box = await bar.boundingBox();
        const area = { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 140), width: Math.min(1280, box.width + 32), height: box.height + 156 };
        const png = join(home, 'sideChat.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/sideChat.webp')]);
        note(`shot: assets/features/sideChat.webp ${(await stat(join(repo, 'assets/features/sideChat.webp'))).size} bytes`);
      }
      // 12. Bring back.
      const back = bar.getByRole('button', { name: 'Bring back', exact: true });
      await until(async () => !(await back.isDisabled()), 'Bring back is on after the answer', 20000);
      await back.click();
      await until(async () => (await input.innerText()).includes('> Which file holds the cart totals?'), 'the chat composer holds the side chat', 20000);
      const draft = await input.innerText();
      assert.match(draft, /> Which file holds the cart totals\?\s+Side answer: the totals are in cart\/totals\.js/, `question quoted, then the answer: ${JSON.stringify(draft)}`);
      assert.equal(await page.evaluate(() => document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.getAttribute('data-row-key')?.slice(8)), parentId, 'the chat is open');
      assert.equal(await bar.count(), 0, 'no bar in the chat itself');
      note('12: Bring back opens the chat; its composer holds the quoted question and the answer');

      // 13. Switched off: no side button.
      await openSettings();
      const sw4 = page.getByRole('switch', { name: 'Side chat', exact: true });
      await sw4.waitFor({ timeout: 10000 });
      assert.equal(await sw4.getAttribute('aria-checked'), 'true', 'Side chat is on by default');
      await sw4.click();
      await until(async () => (await sw4.getAttribute('aria-checked')) === 'false', 'Side chat switched off');
      await page.keyboard.press('Escape'); await pause(600);
      assert.equal(await sideButton.count(), 0, 'off: no side button');
      note('13: switched off → no side button');

      // 14. Diff notes: Changes → Uncommitted → the file's diff → a note on one line and on a Shift range.
      await newChat();
      await send(NOTES_TASK);
      await until(async () => (await page.getByText('Open Changes to see the diff.').count()) > 0, 'chat N answers');
      const notesChat = await page.evaluate(() => document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.getAttribute('data-row-key')?.slice(8));
      if (!(await page.locator('[data-composer-plus-changes]').isVisible().catch(() => false))) {
        await page.getByRole('button', { name: 'Open right sidebar' }).click(); await pause(700);
        await page.getByText('Changes', { exact: true }).first().click();
      }
      const changes = page.locator('[data-composer-plus-changes]'); await changes.waitFor({ timeout: 10000 });
      await changes.getByRole('button', { name: /^Tree/ }).first().click();
      await page.getByText('Uncommitted', { exact: true }).last().click();
      await changes.getByText('src/cart.js', { exact: true }).click();
      const row = (text) => changes.locator('.cp-note-row').filter({ hasText: text }).first();
      await row('return Math.round').waitFor({ timeout: 10000 });
      const addOn = async (text, shift = false) => { await row(text).hover(); await row(text).locator('[data-composer-plus-note-add]').click({ modifiers: shift ? ['Shift'] : [] }); };
      await addOn('return Math.round');
      const noteField = changes.locator('[data-composer-plus-note-form] textarea');
      await noteField.fill('Round in one place, not here.');
      await noteField.press('Enter');
      await addOn('+  for (const i of items) sum += i.price * i.qty;');
      await addOn('-  for (const i of items) sum += i.price;', true);
      await noteField.fill('Check qty for undefined.');
      await changes.locator('[data-composer-plus-note-save]').click();
      const notesBar = changes.locator('[data-composer-plus-notes-bar]');
      await until(async () => (await notesBar.getAttribute('data-composer-plus-notes-bar').catch(() => null)) === '2', 'two notes in the bar');
      assert.match(await notesBar.innerText(), /2 note\(s\) on the diff/);
      if (index === 0 && process.env.SHOT) {
        await page.mouse.move(1270, 790); await pause(400);
        const box = await changes.boundingBox();
        const area = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 520) };
        const png = join(home, 'diffComments.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/diffComments.webp')]);
        note(`shot: assets/features/diffComments.webp ${(await stat(join(repo, 'assets/features/diffComments.webp'))).size} bytes`);
      }
      note('14: Changes → Uncommitted → src/cart.js: a note on one line and on a Shift range; the bar shows 2 notes');

      // 15. Send to composer: both notes as Markdown after your text; the bar goes; the model gets them.
      await input.click(); await page.keyboard.type('Please fix these:', { delay: 3 });
      await notesBar.getByRole('button', { name: 'Send to composer', exact: true }).click();
      await notesBar.waitFor({ state: 'detached', timeout: 5000 });
      await input.click(); await page.keyboard.press('Enter');
      await until(async () => (await page.getByText('I will apply your notes.').count()) > 0, 'chat N answers the notes');
      const notesSent = textOf(calls.filter((c) => c.task === 'N').at(-1).msgs.findLast((m) => m.role === 'user' && textOf(m.content).includes('src/cart.js')).content);
      assert.ok(notesSent.startsWith('Please fix these:\n\n`src/cart.js:4`\n```diff\n+  return Math.round(sum * 100) / 100;\n```\nRound in one place, not here.'), `the first note after your text: ${JSON.stringify(notesSent.slice(0, 260))}`);
      // git shows the two changed lines as a block of two removed and two added lines: the range keeps the rows between.
      assert.ok(notesSent.endsWith('`src/cart.js:3`\n```diff\n-  for (const i of items) sum += i.price;\n-  return sum;\n+  for (const i of items) sum += i.price * i.qty;\n```\nCheck qty for undefined.'), `the range note: ${JSON.stringify(notesSent)}`);
      assert.equal(await page.evaluate(() => document.querySelector('[data-row-key^="session:"][aria-selected="true"]')?.getAttribute('data-row-key')?.slice(8)), notesChat, 'the same chat');
      note('15: Send to composer → the composer had "Please fix these:" + both notes (file:line, diff block, note); the model got them; the bar went');

      // 16. Switched off: no + and no bar.
      await addOn('return Math.round');
      await noteField.fill('one more');
      await noteField.press('Enter');
      await notesBar.waitFor({ timeout: 5000 });
      await openSettings();
      const sw5 = page.getByRole('switch', { name: 'Diff notes', exact: true });
      await sw5.waitFor({ timeout: 10000 });
      assert.equal(await sw5.getAttribute('aria-checked'), 'true', 'Diff notes is on by default');
      await sw5.click();
      await until(async () => (await sw5.getAttribute('aria-checked')) === 'false', 'Diff notes switched off');
      await page.keyboard.press('Escape'); await pause(600);
      assert.equal(await changes.locator('[data-composer-plus-note-add]').count(), 0, 'off: no +');
      assert.equal(await notesBar.count(), 0, 'off: no bar');
      note('16: switched off → no + and no bar');

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
