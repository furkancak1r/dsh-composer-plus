// Real-app check of "Improve prompt" (magic wand) with a fake model server, on each dsh given. No real model, never the
// normal DSH_HOME. Headless. Two fake providers (Demo: demo, Fast: nano); dsh's default is Demo / demo.
// Checks: the wand is in the composer tool row (on by default) and disabled for an empty draft; a click sends the draft
// with the chat, the project brief (README, AGENTS.md) and a related file to the model; the improved text replaces the
// draft and is not sent; Cmd/Ctrl+Z brings the user's text back in one step, and so does the "Undo improvement" button;
// typing while a slow answer runs keeps the new text (the late answer does not overwrite it); Esc cancels; Settings has
// its own Model menu and Nano is then called; the improve prompt never reaches the chat; no page errors.
// Leaving the chat while a slow answer runs (owner's report): the model call goes on; back in the chat the wand shows it
// running, the answer lands in that chat's composer only, and the next click runs (no stuck guard).
// PLAYWRIGHT=/path/to/playwright node test/browser-prompt-improve.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/promptImprove.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IMPROVED = 'Add a logout button to the site header in `src/components/Header.tsx`.\n1. Clear the session on click.\n2. Run `npm test`.';

// Fake OpenAI-compatible server. An improve request answers with IMPROVED (+ the model id for nano); `slow` holds it.
const seen = [];
let slow = null;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"},{"id":"nano"}]}'); return; }
    const parsed = JSON.parse(body);
    const all = JSON.stringify(parsed.messages);
    const kind = /You improve a prompt that a user wrote/.test(all) ? 'improve' : /next message that the user will type/.test(all) ? 'predict' : /session title/i.test(all) ? 'title' : 'chat';
    const last = parsed.messages.at(-1)?.content;
    seen.push({ kind, model: parsed.model, input: typeof last === 'string' ? last : JSON.stringify(last) });
    if (kind === 'improve' && slow !== null) await slow;
    const text = kind === 'improve' ? IMPROVED + (parsed.model === 'nano' ? ' (nano)' : '')
      : kind === 'predict' ? '' : kind === 'title' ? 'Header work' : 'Done: the logout button is in src/components/Header.tsx.';
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.com' } });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-improve-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'improve-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    const provider = (id, name, models) => `      ${id}:
        displayName: ${name}
        api: openai-completions
        baseURL: http://127.0.0.1:${fakePort}/v1
        apiKeyEnv: DEMO_KEY
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
${models.map(([mid, mname]) => `          - { id: ${mid}, name: ${mname}, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }`).join('\n')}`;
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  config:
    providers:
${provider('demo', 'Demo', [['demo', 'Demo model']])}
${provider('fast', 'Fast', [['nano', 'Nano']])}
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    // A made-up project: README, AGENTS.md, a Header component; git so that related files are found.
    const project = join(home, 'projects', 'acme-web');
    await mkdir(join(project, 'src', 'components'), { recursive: true });
    await writeFile(join(project, 'README.md'), '# acme-web\nA demo web shop built with React.\n');
    await writeFile(join(project, 'AGENTS.md'), '# Rules\nRun `npm test` after each change.\n');
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'acme-web', scripts: { test: 'vitest run' } }));
    await writeFile(join(project, 'src', 'components', 'Header.tsx'), 'export function Header() { return null }\n');
    await writeFile(join(project, 'src', 'components', 'Footer.tsx'), 'export function Footer() { return null }\n');
    git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '.'); git(project, 'commit', '-q', '-m', 'Add header and footer');
    // The demo project is dsh's only workspace (otherwise dsh makes a default workspace outside the temp home).
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3193', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      // Next message prediction off, so only the wand calls the improve model.
      // Branch per chat off: a new chat in this git project would start on a new branch (its default).
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      const draft = async () => (await input.innerText()).replace(/\n+$/, '');
      const wand = page.locator('[data-composer-plus-improve]');
      const improves = () => seen.filter((s) => s.kind === 'improve');
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      const clear = async () => { await input.click(); await page.keyboard.press(`${mod}+A`); await page.keyboard.press('Backspace'); await pause(200); };
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
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      assert.equal(await page.getByRole('switch', { name: 'Improve prompt' }).getAttribute('aria-checked'), 'true', 'on by default');
      await back();

      // A chat with one turn in the demo project, so the conversation is context.
      await wand.waitFor();
      assert.equal(await wand.isDisabled(), true, 'empty draft: disabled');
      // The wand sits in the composer's tool row and fits: it does not push Send out of the card.
      const seat = await page.locator('[data-composer-seat]').boundingBox(); const box = await wand.boundingBox();
      assert.ok(box.x >= seat.x && box.x + box.width <= seat.x + seat.width && box.width <= 32, 'inside the composer card');
      await input.click(); await page.keyboard.type('Start with the header', { delay: 20 }); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.innerText.includes('Done: the logout button is in src/components/Header.tsx.'), null, { timeout: 30000 });
      await pause(500);

      // A click: the draft and the context go to the model; the improved text replaces the draft and is not sent.
      const typed = 'add logout to header';
      await input.click(); await page.keyboard.type(typed, { delay: 20 });
      assert.equal(await wand.isDisabled(), false);
      // The Settings picture: a rough draft and the wand with its tooltip.
      if (process.env.SHOT) {
        await wand.hover(); await page.getByText('Improve prompt', { exact: true }).last().waitFor({ timeout: 5000 }); await pause(300);
        const s = await page.locator('[data-composer-seat]').boundingBox();
        const clip = { x: Math.max(0, s.x - 24), y: Math.max(0, s.y - 56), width: Math.min(1280 - Math.max(0, s.x - 24), s.width + 48), height: s.height + 80 };
        const png = join(home, 'promptImprove.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round(clip.width * 1.25))), '0', png, '-o', join(repo, 'assets/features/promptImprove.webp')]);
        await page.mouse.move(1000, 100); await pause(300);
      }
      await wand.click();
      await page.waitForFunction((t) => document.querySelector('[data-composer-input]')?.innerText.includes(t), 'Add a logout button to the site header', { timeout: 30000 });
      assert.equal(await draft(), IMPROVED, 'the improved text is in the composer');
      const sent = improves().at(-1);
      assert.equal(sent.model, 'demo', 'the chat\'s own model (Demo)');
      for (const part of ['<conversation>', 'User: Start with the header', 'Done: the logout button', '<project name="acme-web">', 'A demo web shop', 'Run `npm test` after each change', '<related-files>', 'src/components/Header.tsx', `<draft>\n${typed}\n</draft>`]) {
        assert.ok(sent.input.includes(part) || sent.input.includes(JSON.stringify(part).slice(1, -1)), `the model got ${part}`);
      }
      assert.equal(await wand.getAttribute('aria-label'), 'Undo improvement');
      assert.ok(!(await page.evaluate(() => document.body.innerText.includes('You improve a prompt'))), 'the improve prompt is not in the chat');
      // Cmd/Ctrl+Z: one step back to the user's text; Shift+Cmd+Z / Ctrl+Y forward again.
      await input.click(); await page.keyboard.press(`${mod}+Z`); await pause(300);
      assert.equal(await draft(), typed, 'one undo step brings the typed text back');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y'); await pause(300);
      assert.equal(await draft(), IMPROVED, 'redo');
      // The Undo improvement button does the same.
      await wand.click(); await pause(300);
      assert.equal(await draft(), typed, 'the button undoes');
      assert.equal(await wand.getAttribute('aria-label'), 'Improve prompt');

      // Typing while a slow answer runs: the late answer does not overwrite the new text.
      let release; slow = new Promise((r) => { release = r; });
      await wand.click(); await page.waitForFunction(() => document.querySelector('[data-composer-plus-improve]')?.getAttribute('aria-busy') === 'true');
      await input.click(); await page.keyboard.press('End'); await page.keyboard.type(' and a test', { delay: 20 });
      release(); slow = null;
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-improve]')?.getAttribute('aria-busy') === 'false', null, { timeout: 15000 });
      await pause(300);
      assert.equal(await draft(), `${typed} and a test`, 'new typing is kept');
      // Esc cancels a running improvement.
      slow = new Promise((r) => { release = r; });
      const n = improves().length;
      await wand.click(); await page.waitForFunction(() => document.querySelector('[data-composer-plus-improve]')?.getAttribute('aria-busy') === 'true');
      await input.click(); await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-improve]')?.getAttribute('aria-busy') === 'false', null, { timeout: 5000 });
      release(); slow = null; await pause(500);
      assert.equal(await draft(), `${typed} and a test`, 'cancelled: the text stays');
      // The model call can stop before it reaches the model (the Host aborts it with the request).
      assert.ok(improves().length <= n + 1, 'at most one call for the cancelled click');

      // Leave the chat while a slow answer runs and come back.
      {
        await clear(); await input.click(); await page.keyboard.type(typed, { delay: 20 });
        const header = page.locator('[data-row-key^="session:"]').filter({ hasText: 'Header work' }).first();
        await header.waitFor({ timeout: 20000 });
        const calls = improves().length;
        slow = new Promise((r) => { release = r; });
        await wand.click(); await page.waitForFunction(() => document.querySelector('[data-composer-plus-improve]')?.getAttribute('aria-busy') === 'true');
        await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(1500);
        assert.notEqual(await wand.getAttribute('aria-busy'), 'true', 'the new chat is not busy');
        await header.click(); await pause(1500);
        assert.equal(await wand.getAttribute('aria-busy'), 'true', 'back in the chat: it still runs');
        assert.equal(await wand.getAttribute('aria-label'), 'Improving your prompt… Click or press Esc to cancel.');
        assert.equal(improves().length, calls + 1, 'one model call');
        release(); slow = null;
        await page.waitForFunction((t) => document.querySelector('[data-composer-input]')?.innerText.includes(t), 'Add a logout button to the site header', { timeout: 15000 });
        assert.equal(await draft(), IMPROVED, 'the answer is in this chat\'s composer');
        assert.equal(await wand.getAttribute('aria-label'), 'Undo improvement');
        // Away when the answer comes: it waits for this chat; the other chat's composer is not touched.
        await wand.click(); await pause(300); assert.equal(await draft(), typed);
        slow = new Promise((r) => { release = r; });
        await wand.click(); await page.waitForFunction(() => document.querySelector('[data-composer-plus-improve]')?.getAttribute('aria-busy') === 'true');
        await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(1000);
        await input.click(); await page.keyboard.type('other chat', { delay: 20 });
        release(); slow = null; await pause(1500);
        assert.equal(await draft(), 'other chat', 'the other chat keeps its text');
        await header.click(); await pause(1500);
        await page.waitForFunction((t) => document.querySelector('[data-composer-input]')?.innerText.includes(t), 'Add a logout button to the site header', { timeout: 15000 });
        assert.equal(await wand.getAttribute('aria-busy'), 'false', 'the guard is free');
        await wand.click(); await pause(300); assert.equal(await draft(), typed, 'Undo improvement');
        // The next click runs at once: no "still running" from the Host.
        await wand.click();
        await page.waitForFunction((t) => document.querySelector('[data-composer-input]')?.innerText.includes(t), 'Add a logout button to the site header', { timeout: 15000 });
        assert.ok(!(await page.evaluate(() => document.body.innerText.includes('still running'))), 'no stuck guard');
        await wand.click(); await pause(300);
      }

      // Settings: its own Model menu; Nano is then called.
      await settings();
      const improveMenu = page.locator('[data-composer-plus-prediction-model] button[aria-label="Improve prompt: Model"]');
      await improveMenu.waitFor(); assert.equal(await improveMenu.textContent(), 'Same as the chat\'s model');
      await improveMenu.click();
      await page.locator('body > [role="menu"]').last().getByRole('menuitem', { name: 'Nano', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-composer-plus-prediction-model] button[aria-label="Improve prompt: Model"]')?.textContent === 'Nano', null, { timeout: 10000 });
      assert.deepEqual(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/improve.json'), 'utf8')), { model: { provider: 'fast', model: 'nano' } });
      await back();
      await wand.click();
      await page.waitForFunction(() => document.querySelector('[data-composer-input]')?.innerText.includes('(nano)'), null, { timeout: 30000 });
      assert.equal(improves().at(-1).model, 'nano', 'the chosen model is called');
      await clear();
      // Switched off: no wand.
      await settings(); await page.getByRole('switch', { name: 'Improve prompt' }).click(); await back();
      assert.equal(await wand.count(), 0, 'switched off: no wand');

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: wand in the tool row (on by default, disabled when empty), draft + chat + README + AGENTS.md + related file sent, improved text replaces the draft and is not sent, Cmd+Z one step back and redo, Undo improvement button, typing during a slow answer kept, Esc cancels, leave the chat and come back (still running, answer in that chat only, next click runs), own Model menu (Nano called, improve.json), switch off removes it, no page errors`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; model calls: ${JSON.stringify(seen.map((s) => ({ ...s, input: s.input.slice(0, 200) })))}`);
      throw error;
    } finally {
      slow = null;
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
