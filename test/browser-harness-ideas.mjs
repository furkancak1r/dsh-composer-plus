// Real-app check of the harness features on each dsh given: a fake model, a throwaway DSH_HOME and a made-up git project
// (acme-web with a .env file). Never the normal DSH_HOME, no real model. Headless.
// 1. Protected files: the agent's `read` of `.env` is denied with "Protected file: .env matches ".env*"", its `read` of
//    README.md runs; Settings → Protected files shows the three defaults; adding `docs/**` (write only) saves it.
// 2. Improve prompt on `/goal make the tests pass`: the wand is on (a /goal objective), the Host gets the whole draft, the
//    composer keeps `/goal` and shows the rewritten objective.
// 3. Context: right sidebar → Context lists the parts of the chat's context with tokens (Your messages, Tool results …).
// 4. Continue in a new chat: right-click the chat → Continue in a new chat… → the note (fake model) → edit → Start new
//    chat → a new chat opens whose first message is the edited note and a dsh-session: link.
// 5. Switching each feature off removes its item / page; no page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-harness-ideas.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/{protectedFiles,contextBreakdown,handoffChat}.webp (English UI, made-up project).
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
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${typeof what === 'function' ? await what() : what}`); await pause(200); }
};

const ASK = 'Check the login settings';
const NOTE = '## Task\n- Fix the login settings\n## Outputs\n- src/login.js\n## Completed\n- Read README.md\n## Decisions\n- none\n## Open issues\n- .env could not be read\n## Next action\n- Ask the user for the login secret';
const GOAL = 'Make every login test pass.\nDone when:\n1. `npm test` passes and its output is in the chat.\n2. A part that cannot be done is marked as unresolved.';
const seen = []; // {kind, text}
const results = new Map(); // tool call id → result text
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    const system = textOf(msgs.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    const last = textOf(msgs.at(-1)?.content);
    const kind = system.startsWith('You write a handoff note') ? 'handoff' : system.startsWith('You rewrite the objective of a /goal') ? 'goal-improve'
      : system.startsWith('You improve a prompt') ? 'improve' : /You predict the next message|You complete the message/.test(JSON.stringify(msgs)) ? 'predict'
      : /session title/i.test(last) ? 'title' : 'chat';
    seen.push({ kind, text: last, system });
    for (const m of msgs) if (m.role === 'tool') results.set(m.tool_call_id, textOf(m.content));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const tool = (id, name, args) => { send({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
    if (kind === 'handoff') return say(NOTE);
    if (kind === 'goal-improve') return say(GOAL);
    if (kind === 'improve') return say('Improved.');
    if (kind === 'predict') return say('');
    if (kind === 'title') return say('Login settings');
    // The chat: read .env (denied), read README.md, then answer.
    const tools = msgs.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    if (!JSON.stringify(msgs).includes(ASK)) return say('Ready.');
    if (tools === 0) return tool(`call_env_${randomUUID().slice(0, 6)}`, 'read', { file_path: '.env' });
    if (tools === 1) return tool(`call_readme_${randomUUID().slice(0, 6)}`, 'read', { file_path: 'README.md' });
    return say('The .env file is protected, so I read README.md only. Please give me the login secret.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd, encoding: 'utf8', env: gitEnv });
const shot = async (page, home, name, loc, pad = 12, from = undefined) => {
  if (!process.env.SHOT) return;
  await page.mouse.move(1260, 20); await pause(300);
  let b = await loc.boundingBox();
  // `from`: from the top of that element down to the end of `loc`.
  if (from !== undefined) { const t = await from.boundingBox(); b = { x: t.x, y: t.y, width: t.width, height: b.y + b.height - t.y }; }
  const vp = page.viewportSize();
  const x = Math.max(0, b.x - pad); const y = Math.max(0, b.y - pad);
  const width = Math.min(vp.width - x, b.width + 2 * pad); const height = Math.min(vp.height - y, b.height + 2 * pad);
  const png = join(home, `${name}.png`);
  await page.screenshot({ path: png, clip: { x, y, width, height } });
  const out = join(repo, `assets/features/${name}.webp`);
  execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round(width * 1.25))), '0', png, '-o', out]);
  console.log(`  shot: assets/features/${name}.webp ${(await stat(out)).size} bytes`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.length = 0; results.clear();
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-harness-ideas-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'harness-ideas-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'acme-web');
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(project, 'README.md'), '# acme-web\nA demo web shop. The login reads LOGIN_SECRET from .env.\n');
    await writeFile(join(project, '.env'), 'LOGIN_SECRET=demo-not-a-secret\n');
    await writeFile(join(project, 'src', 'login.js'), 'export const login = () => process.env.LOGIN_SECRET;\n');
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'acme-web', private: true, scripts: { test: 'node --test' } }, null, 2));
    await writeFile(join(project, '.gitignore'), '.env\n');
    git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'Add the shop');
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3206', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', DSH_PERMISSION_MODE: 'danger-full-access', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const failedUrls = []; page.on('response', (r) => { if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url().replace(/token=[^&]+/, 'token=…')}`); });
      page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`); });
      const improves = []; const handoffs = [];
      page.on('request', (r) => {
        if (r.url().includes('/api/composer-plus.improve') && r.method() === 'POST') improves.push(JSON.parse(r.postData() ?? 'null'));
        if (r.url().includes('/api/composer-plus.handoff') && r.method() === 'POST') handoffs.push(JSON.parse(r.postData() ?? 'null'));
      });
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
      const setSwitch = async (label, on) => {
        const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name: label, exact: true });
        if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
        await until(async () => (await sw.getAttribute('aria-checked')) === String(on), async () => `${label} ${on} (now ${await sw.getAttribute('aria-checked')}, ${await sw.isDisabled() ? 'disabled' : 'enabled'})`, 10000);
      };

      // 1. Protected files: the agent's read of .env is denied, README.md runs.
      await input.click(); await page.keyboard.type(ASK, { delay: 10 }); await page.keyboard.press('Enter');
      await page.getByText('so I read README.md only', { exact: false }).first().waitFor({ timeout: 30000 });
      const envResult = [...results.entries()].find(([id]) => id.startsWith('call_env_'))?.[1] ?? '';
      const readmeResult = [...results.entries()].find(([id]) => id.startsWith('call_readme_'))?.[1] ?? '';
      assert.match(envResult, /Protected file: \.env matches "\.env\*"/, envResult);
      assert.ok(!envResult.includes('demo-not-a-secret'), 'the secret never reaches the model');
      assert.match(readmeResult, /A demo web shop/, 'README.md is read');
      await settings();
      const list = page.locator('[data-composer-plus-protected]');
      await list.waitFor({ timeout: 10000 });
      for (const p of ['.env*', '*.pem', '*.key']) await list.getByText(p, { exact: true }).waitFor();
      await list.getByRole('textbox').fill('docs/**');
      await list.getByRole('button', { name: /^Protection: read and write$/ }).click();
      await list.getByRole('button', { name: 'Add', exact: true }).click();
      await list.getByText('docs/**', { exact: true }).waitFor();
      const saved = await page.evaluate(async () => (await fetch('/api/composer-plus.protected-files')).json());
      assert.deepEqual(saved.patterns.at(-1), { pattern: 'docs/**', mode: 'write' });
      const row = page.locator('[data-composer-plus-settings] > div').filter({ has: list });
      await row.evaluate((el) => el.scrollIntoView({ block: 'center' })); await pause(300);
      await shot(page, home, 'protectedFiles', row);
      console.log('  1: .env denied ("Protected file: .env matches ".env*""), README.md read, defaults shown, docs/** (write only) saved');

      // Settings: the three new rows have their switches and screenshots.
      for (const name of ['Protected files', 'Continue in a new chat', 'Context breakdown']) {
        await page.locator('[data-composer-plus-settings]').getByRole('switch', { name, exact: true }).waitFor();
      }
      await back();

      // 2. Improve prompt on a /goal draft.
      await input.click(); await page.keyboard.type('/goal', { delay: 30 }); await page.keyboard.press('Space'); await pause(300);
      await page.keyboard.type('make the tests pass', { delay: 10 }); await pause(300);
      const wand = page.locator('[data-composer-plus-improve]');
      await until(async () => !(await wand.isDisabled()), 'the wand is on for a /goal objective', 10000);
      await wand.click();
      await until(async () => (await input.innerText()).includes('Done when:'), 'the objective is rewritten', 20000);
      assert.equal(improves.at(-1)?.text?.replace(/\s+/g, ' ').trim(), '/goal make the tests pass');
      assert.ok(seen.some((s) => s.kind === 'goal-improve' && s.text.includes('<draft>\nmake the tests pass\n</draft>')), 'the objective only goes to the model');
      const composerText = await page.evaluate(() => document.querySelector('[data-composer-input]')?.closest('[data-composer-seat]')?.innerText ?? '');
      assert.ok(/\/goal/.test(composerText) && !/\/goal\s*\/goal/.test(composerText), `the command stays once: ${composerText.slice(0, 120)}`);
      // Clear the draft without sending it.
      await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
      console.log('  2: /goal draft → wand on, Host got the whole draft, model got the objective only, composer keeps /goal + "Done when:"');

      // 3. Context page.
      const contextPage = page.locator('[data-composer-plus-context]');
      if (!(await contextPage.waitFor({ timeout: 2000 }).then(() => true, () => false))) {
        const guide = page.getByText('Context', { exact: true });
        if (!(await guide.first().isVisible().catch(() => false))) await page.locator('button[aria-label*="ight sidebar" i], button[aria-label*="ight panel" i]').first().click();
        await guide.first().click();
      }
      await contextPage.waitFor({ timeout: 10000 });
      await contextPage.getByText('Your messages').waitFor({ timeout: 10000 });
      await contextPage.getByText('Tool results').waitFor();
      const header = await contextPage.locator('strong').first().innerText();
      assert.match(header, /of 100,000 tokens/, header);
      await contextPage.getByRole('button', { name: /Tool results/ }).click();
      await contextPage.getByText('read', { exact: true }).waitFor();
      // Only the filled part of the page (the rest is empty).
      await shot(page, home, 'contextBreakdown', contextPage.locator('> *').last(), 0, contextPage);
      console.log(`  3: Context page "${header}", Your messages and Tool results (read) listed`);

      // 4. Continue in a new chat.
      const chatRow = page.locator('[data-row-key^="session:"]').filter({ hasText: 'Login settings' }).first();
      await chatRow.waitFor({ timeout: 20000 });
      await chatRow.click({ button: 'right' });
      await page.getByText('Continue in a new chat…').first().click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Continue in a new chat' });
      const note = dialog.locator('[data-composer-plus-handoff-note]');
      await until(async () => (await note.inputValue()).includes('## Next action'), 'the note is written', 20000);
      const handoffCall = seen.find((s) => s.kind === 'handoff');
      assert.ok(handoffCall.text.includes(ASK) && handoffCall.text.includes('Tool call read'), 'the note reads the chat and its tool calls');
      await note.fill(`${NOTE}\n- Edited by hand`);
      await shot(page, home, 'handoffChat', dialog, 8);
      const before = await page.locator('[data-row-key^="session:"]').count();
      await dialog.locator('[data-composer-plus-handoff-start]').click();
      await dialog.waitFor({ state: 'detached', timeout: 20000 });
      await page.getByText('Edited by hand', { exact: false }).first().waitFor({ timeout: 20000 });
      const firstMessage = await page.getByText('Continue this work. The earlier chat, for reference only:', { exact: false }).first().innerText().catch(() => '');
      assert.ok(handoffs.at(-1)?.start === true && handoffs.at(-1)?.note.includes('Edited by hand'), 'the edited note was sent');
      await until(async () => (await page.locator('[data-row-key^="session:"]').count()) > before, 'a new chat in the sidebar');
      console.log(`  4: Continue in a new chat… → note written (chat + tool calls), edited, Start → new chat opened with the note${firstMessage ? ' and the link' : ''}`);

      // 5. Switch off: the menu item and the page go; the gate stops.
      await settings();
      await setSwitch('Continue in a new chat', false); await setSwitch('Context breakdown', false); await setSwitch('Protected files', false);
      assert.equal((await page.evaluate(async () => (await fetch('/api/composer-plus.protected-files')).json())).on, false, 'the Host keeps the switch');
      await back();
      await chatRow.click({ button: 'right' }); await pause(500);
      assert.equal(await page.getByText('Continue in a new chat…').count(), 0, 'switched off: no menu item'); await page.keyboard.press('Escape');
      assert.equal(await contextPage.count(), 0, 'switched off: no Context page');
      await settings();
      await setSwitch('Continue in a new chat', true); await setSwitch('Context breakdown', true); await setSwitch('Protected files', true);
      await back();
      assert.deepEqual(errors, [], 'no page errors');
      const ours = failedUrls.filter((u) => /composer-plus\.(protected-files|handoff|context|improve|goal-check)/.test(u));
      assert.deepEqual(ours, [], `no failed request of these features: ${failedUrls.join(', ')}`);
      console.log(`PASS ${bin}`);
    } catch (error) {
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`FAIL ${bin}: ${error?.stack ?? error}\npage errors: ${JSON.stringify(errors).slice(0, 3000)}\n--- dsh log (end) ---\n${log.slice(-3000)}\nscreenshot: ${join(home, 'failed.png')}`);
      process.exitCode = 1;
    } finally {
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      if (process.exitCode !== 1) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
