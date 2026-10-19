// Real-app check of "Feature ideas" on each dsh given: a fake model, a throwaway DSH_HOME and a made-up project. Never the
// normal DSH_HOME and no real model.
// 1. Start a chat in the demo project, open the Ideas page from the right sidebar: no model call before the click.
// 2. "Suggest features": one model call that sees the project brief (README) and no secret file; the answer becomes cards.
// 3. Drag the top card to the left: it is skipped. Undo brings it back.
// 4. ✓ on the top card: a new chat starts in the same project, in plan mode, with the idea as the request; dsh opens it.
// PLAYWRIGHT=/path/to/playwright node test/browser-feature-ideas.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/featureIdeas.webp (English UI, demo project only).
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

const IDEAS = [
  { title: 'Recipe sharing links', summary: 'Share a recipe with a public link that opens without an account.', why: 'Friends can cook from a recipe at once.', effort: 'small' },
  { title: 'Weekly meal planner', summary: 'Drag recipes into a 7-day plan and get one shopping list for the week.', why: 'Saves time on planning and shopping.', effort: 'medium' },
  { title: 'Pantry tracker', summary: 'Keep a list of what is at home and mark recipes you can cook now.', why: 'Less food goes to waste.', effort: 'medium' },
  { title: 'Cooking timer steps', summary: 'Start a timer from any step that has a time in it.', why: 'No need to switch apps while cooking.', effort: 'small' },
];
const FIRST_CHAT = 'Review the recipe search page';
// Fake OpenAI-compatible model. Ideas request (system prompt asks for a JSON array) → the list; titles → a title; every
// other request → a short answer. Every request is recorded.
const seen = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const request = JSON.parse(body); const msgs = request.messages ?? [];
    const all = JSON.stringify(msgs);
    const kind = /suggest new features for a software project/i.test(all) ? 'ideas' : /session title/i.test(JSON.stringify(msgs.at(-1)?.content ?? '')) ? 'title' : 'chat';
    seen.push({ kind, all });
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = (text) => res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    if (kind === 'ideas') answer('```json\n' + JSON.stringify(IDEAS) + '\n```');
    else if (kind === 'title') answer(/Weekly meal planner/.test(all) ? 'Weekly meal planner' : 'Recipe search review');
    else answer('I will read the related code first and then present a plan.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    seen.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ideas-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'ideas-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // A made-up project: a README the brief must use, and a secret file it must never send.
    const project = join(home, 'projects', 'recipe-box'); await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(project, 'README.md'), '# Recipe Box\nA small web app to save and search family recipes.\n');
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'recipe-box', description: 'Save and search family recipes', scripts: { test: 'node --test' } }, null, 2));
    await writeFile(join(project, '.env'), 'DEMO_SECRET=never-send-this\n');
    // The demo project is dsh's only workspace (otherwise dsh makes a default workspace outside the temp home).
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'recipe-box', sessionIds: [], createdAt: now, updatedAt: now } } },
    }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3197', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      await page.locator('[data-composer-input]').waitFor();
      // 1. A chat in the demo project, then the Ideas page from the right sidebar's guide.
      await page.locator('[data-composer-input]').click(); await page.keyboard.type(FIRST_CHAT); await page.keyboard.press('Enter');
      await page.getByText('I will read the related code first', { exact: false }).first().waitFor({ timeout: 20000 });
      const requestsBefore = seen.length;
      await page.getByRole('button', { name: /sidebar/i }).last().waitFor({ timeout: 5000 }).catch(() => {});
      const guide = page.getByText('Feature ideas', { exact: true });
      if (!(await guide.isVisible().catch(() => false))) {
        // The right sidebar is closed: open it with dsh's own toggle (its label differs between versions).
        const toggle = page.locator('button[aria-label*="ight sidebar" i], button[aria-label*="ight panel" i]').first();
        await toggle.click();
      }
      await guide.first().click();
      const ideasPage = page.locator('[data-composer-plus-ideas]'); await ideasPage.waitFor({ timeout: 10000 });
      await pause(500);
      assert.equal(seen.slice(requestsBefore).filter((s) => s.kind === 'ideas').length, 0, 'opening the page calls no model');
      // 2. Suggest: one model call with the brief; cards appear.
      await ideasPage.getByRole('button', { name: 'Suggest features' }).click();
      const top = () => ideasPage.locator('[data-composer-plus-idea]');
      await top().waitFor({ timeout: 20000 });
      const ideaCalls = seen.filter((s) => s.kind === 'ideas');
      assert.equal(ideaCalls.length, 1, 'one model call for the ideas');
      assert.match(ideaCalls[0].all, /Recipe Box/, 'the model sees the project README');
      assert.ok(!ideaCalls[0].all.includes('never-send-this'), 'the secret file is not sent');
      assert.match(ideaCalls[0].all, /in English \(en\), also when/, 'the cards come in the UI language');
      assert.equal(await top().getAttribute('aria-label'), IDEAS[0].title);
      await ideasPage.getByText('4 idea(s) left').waitFor();
      // 3. Drag the top card left past the line: skipped. Undo brings it back.
      const box = await top().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      for (let i = 1; i <= 12; i++) { await page.mouse.move(box.x + box.width / 2 - i * 20, box.y + box.height / 2 + i); await pause(16); }
      await page.mouse.up();
      await page.waitForFunction((title) => document.querySelector('[data-composer-plus-idea]')?.getAttribute('aria-label') !== title, IDEAS[0].title, { timeout: 5000 });
      assert.equal(await top().getAttribute('aria-label'), IDEAS[1].title, 'the dragged card is skipped');
      // A short drag springs back.
      const box2 = await top().boundingBox();
      await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2); await page.mouse.down();
      await page.mouse.move(box2.x + box2.width / 2 + 20, box2.y + box2.height / 2, { steps: 4 }); await pause(300); await page.mouse.up(); await pause(400);
      assert.equal(await top().getAttribute('aria-label'), IDEAS[1].title, 'a short drag keeps the card');
      await ideasPage.getByRole('button', { name: 'Undo' }).click();
      assert.equal(await top().getAttribute('aria-label'), IDEAS[0].title, 'Undo brings the skipped card back');
      await top().focus(); await page.keyboard.press('ArrowLeft');
      await page.waitForFunction((title) => document.querySelector('[data-composer-plus-idea]')?.getAttribute('aria-label') === title, IDEAS[1].title, { timeout: 5000 });
      // ✕ flies the card off to the left (like a drag) before it is skipped; Undo brings it back.
      await ideasPage.getByRole('button', { name: 'Skip this idea' }).click();
      const flewLeft = await page.waitForFunction(() => /translate\(-[1-9]/.test(document.querySelector('[data-composer-plus-idea]')?.style.transform ?? ''), null, { timeout: 2000 }).then(() => true, () => false);
      assert.ok(flewLeft, '✕ moves the card to the left first');
      await page.waitForFunction((title) => document.querySelector('[data-composer-plus-idea]')?.getAttribute('aria-label') === title, IDEAS[2].title, { timeout: 5000 });
      await ideasPage.getByRole('button', { name: 'Undo' }).click();
      assert.equal(await top().getAttribute('aria-label'), IDEAS[1].title, '← and ✕ skip too');
      if (index === 0 && process.env.SHOT) {
        // The Ideas page with the card stack, mid-drag to the right (the "Build" stamp shows), next to the chat.
        const b = await top().boundingBox();
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
        await page.mouse.move(b.x + b.width / 2 + 50, b.y + b.height / 2 + 6, { steps: 6 }); await pause(300);
        const area = await ideasPage.boundingBox();
        const clip = { x: Math.max(0, area.x - 8), y: Math.max(0, area.y - 40), width: Math.min(1280 - Math.max(0, area.x - 8), area.width + 16), height: Math.min(800 - Math.max(0, area.y - 40), 560) };
        const png = join(home, 'featureIdeas.png'); await page.screenshot({ path: png, clip });
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 }); await page.mouse.up(); await pause(400);
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(clip.width * 1.4)), '0', png, '-o', join(repo, 'assets/features/featureIdeas.webp')]);
      }
      // 4. ✓: a new chat in the same project, in plan mode, with the idea as the request; dsh opens it.
      const chatRequests = seen.length;
      await ideasPage.getByRole('button', { name: 'Build this feature' }).click();
      for (let i = 0; i < 80 && !seen.slice(chatRequests).some((s) => s.kind === 'chat' && s.all.includes(IDEAS[1].title)); i++) await pause(250);
      const planned = seen.slice(chatRequests).find((s) => s.kind === 'chat' && s.all.includes(IDEAS[1].title));
      assert.ok(planned, 'the new chat sends the idea to the model');
      assert.match(planned.all, /Implement this feature in this project: Weekly meal planner/);
      assert.ok(!planned.all.includes(FIRST_CHAT), 'it is a new chat, not the first one');
      // dsh opens the new chat; the result of its /plan command shows in the chat.
      await page.getByText('Plan mode on', { exact: false }).first().waitFor({ timeout: 20000 });
      await page.locator('[data-row-key^="session:"]').filter({ hasText: 'Weekly meal planner' }).first().waitFor({ timeout: 20000 });
      // Back in the first chat, its Ideas page lists the started idea and shows the next card.
      await page.locator('[data-row-key^="session:"]').filter({ hasText: 'Recipe search review' }).first().click();
      if (!(await ideasPage.waitFor({ timeout: 3000 }).then(() => true, () => false))) await page.getByText('Feature ideas', { exact: true }).first().click();
      await ideasPage.getByText('Started', { exact: true }).waitFor({ timeout: 10000 });
      assert.equal(await top().getAttribute('aria-label'), IDEAS[2].title, 'the next card is on top');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}: Ideas page → no model call before the click → one call with the project brief (no secret) → drag left skips, a short drag springs back, Undo, ← → ✓ starts a new chat in plan mode with the idea`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; model requests: ${JSON.stringify(seen.map((s) => s.kind))}`);
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // tokens stay in the temp home
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
