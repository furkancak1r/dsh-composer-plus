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
// PLAYWRIGHT=/path/to/playwright node test/browser-t3code-ideas.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/rejectNote.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat, access } from 'node:fs/promises';
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
const calls = []; // {task, msgs}
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const all = JSON.stringify(msgs);
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Clean up the build');
    if (/You predict the next message|You complete the message that the user is typing/.test(all)) return say('');
    const task = all.includes(TASK.C) ? 'C' : all.includes(TASK.B) ? 'B' : all.includes(TASK.A) ? 'A' : '?';
    calls.push({ task, msgs });
    const own = msgs.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
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
    calls.length = 0;
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

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
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
