// Real-app check of "Project memory" on each dsh given: a fake model, a throwaway DSH_HOME, a made-up project (acme-web).
// Never the normal DSH_HOME, no real model. Headless.
// 1. Settings: the switch is off by default; with it off, a turn sends no memory section and no memory tools.
// 2. Switch on. Chat 1: "Remember: …" → after the turn the review (a call with the review system prompt) saves the entry.
//    The model also calls memory_remember once. The files are under DSH_HOME/storages/dsh-composer-plus/memory/, the
//    project folder has no new file.
// 3. Chat 2 in the same project: its request has the memory section with both entries and the three tools.
// 4. Switch off: the next request has no section and no tools. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-project-memory.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/projectMemory.webp (English UI, made-up project): the chat with the memory_remember step.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, realpath, stat } from 'node:fs/promises';
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

// Fake OpenAI-compatible model: the review gets a fixed change list; "Remember" chats call memory_remember once.
const seen = []; // {kind, system, tools, last}
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    const system = textOf(msgs.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    const last = textOf(msgs.at(-1)?.content);
    const kind = system.startsWith('You keep the long-term memory') ? 'review' : /session title/i.test(last) ? 'title'
      : /You predict the next message|You complete the message/.test(JSON.stringify(msgs)) ? 'predict' : 'chat';
    seen.push({ kind, system, tools: (parsed.tools ?? []).map((t) => t.function?.name), last });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    if (kind === 'review') return say('{"changes":[{"op":"add","text":"The user deploys acme-web with make release"}]}');
    if (kind === 'title') return say('Deploy notes');
    if (kind === 'predict') return say('');
    const asked = msgs.findLast((m) => m.role === 'user' && /Remember|What do you know/.test(textOf(m.content)));
    const toolDone = msgs.some((m) => m.role === 'tool');
    if (asked && /Remember/.test(textOf(asked.content)) && !toolDone && (parsed.tools ?? []).some((t) => t.function?.name === 'memory_remember')) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'memory_remember', arguments: JSON.stringify({ text: 'The user wants short answers' }) } }] });
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    return say('Noted.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-memory-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'memory-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'README.md'), '# acme-web\nA demo web shop.\n');
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    // Default workspace off: the global New Session opens the project (not the general folder).
    await mkdir(join(home, 'storages', 'dsh-composer-plus'), { recursive: true });
    await writeFile(join(home, 'storages', 'dsh-composer-plus', 'default-workspace.json'), JSON.stringify({ on: false }));
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3207', '--no-open'], { cwd: project, env: { ...process.env, HOME: home, DSH_HOME: home, DEMO_KEY: 'demo', DSH_PERMISSION_MODE: 'danger-full-access', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    const memDir = join(home, 'storages', 'dsh-composer-plus', 'memory');
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
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
      const say = async (text) => { await input.click(); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Enter'); };
      const newChat = async () => { await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(800); };
      const chats = () => seen.filter((s) => s.kind === 'chat');
      const memorySwitch = page.getByRole('switch', { name: 'Project memory', exact: true });

      // 1. Off by default: no section, no tools.
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      assert.equal(await memorySwitch.getAttribute('aria-checked'), 'false', 'off by default');
      await back();
      await say('Hello there');
      await until(() => chats().length >= 1, 'first chat request');
      assert.ok(!chats()[0].system.includes('# Memory (Composer Plus)'), 'off: no memory section');
      assert.ok(!chats()[0].tools.some((n) => n?.startsWith('memory_')), 'off: no memory tools');
      await pause(3000);
      assert.equal(seen.filter((s) => s.kind === 'review').length, 0, 'off: no review');
      note('1: off by default; a turn has no memory section, no memory tools and no review');

      // 2. On: a chat that asks to remember → the tool call, then the review after the turn.
      await settings(); await memorySwitch.click();
      await until(async () => (await memorySwitch.getAttribute('aria-checked')) === 'true', 'switched on');
      await back();
      await newChat();
      const before = chats().length;
      await say('Remember: I deploy acme-web with make release');
      await until(() => seen.some((s) => s.kind === 'review'), 'the review runs after the turn', 30000);
      const first = chats().slice(before)[0];
      assert.ok(first.system.includes('# Memory (Composer Plus)'), 'on: the section is in the system prompt');
      for (const name of ['memory_remember', 'memory_forget', 'memory_recall']) assert.ok(first.tools.includes(name), `on: the ${name} tool`);
      const review = seen.find((s) => s.kind === 'review');
      assert.match(review.last, /make release/); assert.match(review.last, /acme-web/);
      const projects = await until(async () => { const d = await readdir(join(memDir, 'projects')).catch(() => []); return d.length === 1 && d; }, 'one project memory');
      const main = await until(async () => { const t = await readFile(join(memDir, 'projects', projects[0], 'MEMORY.md'), 'utf8').catch(() => ''); return /make release/.test(t) && t; }, 'the review saved the entry');
      assert.match(main, /The user wants short answers/, 'the tool saved its entry');
      assert.match(main, /^- The user deploys acme-web with make release \[source: [^\]]+; added: \d{4}-\d{2}-\d{2}\]$/m);
      assert.deepEqual(JSON.parse(await readFile(join(memDir, 'projects', projects[0], 'project.json'), 'utf8')), { path: project });
      assert.deepEqual((await readdir(project)).sort(), ['README.md'], 'nothing new in the project folder');
      const journal = (await readFile(join(memDir, 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(journal.map((r) => r.actor).sort(), ['agent', 'review']);
      if (process.env.SHOT) {
        // The chat: your message, the memory_remember step and the answer.
        await page.mouse.move(5, 5); await pause(800);
        const content = page.locator('[data-conversation-content]');
        await content.getByText('Noted.', { exact: true }).last().waitFor({ timeout: 10000 });
        // Open the folded steps, so the picture shows the memory_remember call and its result.
        const steps = content.getByText(/^Completed in /).last();
        if (await steps.count()) { await steps.click(); await pause(600); }
        const called = content.getByText(/^Called tools/).last();
        if (await called.count()) { await called.click().catch(() => {}); await pause(600); }
        const call = content.getByText(/memory_remember/).first();
        if (await call.count()) { await call.click().catch(() => {}); await pause(600); }
        await page.mouse.move(5, 5); await pause(300);
        const area = await content.boundingBox();
        const asked = await content.getByText('Remember: I deploy acme-web with make release', { exact: true }).last().boundingBox();
        const answer = await content.getByText('Noted.', { exact: true }).last().boundingBox();
        const top = Math.max(0, asked.y - 24);
        const clip = { x: area.x, y: top, width: area.width, height: Math.min(900 - top, answer.y + answer.height + 16 - top) };
        const png = join(home, 'projectMemory.png'); await page.screenshot({ path: png, clip });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round(clip.width * 1.25))), '0', png, '-o', join(repo, 'assets/features/projectMemory.webp')]);
        note(`shot: assets/features/projectMemory.webp ${(await stat(join(repo, 'assets/features/projectMemory.webp'))).size} bytes`);
      }
      note(`2: on → section + 3 tools in the request; memory_remember and the review wrote ${join('storages/dsh-composer-plus/memory/projects', projects[0], 'MEMORY.md')} (2 entries, journal 2 rows); project folder unchanged`);

      // 3. A new chat in the same project reads both entries in its system prompt.
      await newChat();
      const before3 = chats().length;
      await say('What do you know about deploys?');
      const third = await until(() => chats().slice(before3)[0], 'chat 3 request');
      assert.match(third.system, /The user deploys acme-web with make release/); assert.match(third.system, /The user wants short answers/);
      note('3: a new chat in acme-web gets both entries in its system prompt');

      // 4. Off: no section, no tools.
      await settings(); await memorySwitch.click();
      await until(async () => (await memorySwitch.getAttribute('aria-checked')) === 'false', 'switched off');
      await back();
      await newChat();
      const before4 = chats().length;
      await say('Hello again');
      const fourth = await until(() => chats().slice(before4)[0], 'chat 4 request');
      assert.ok(!fourth.system.includes('# Memory (Composer Plus)') && !fourth.tools.some((n) => n?.startsWith('memory_')), 'off again: no section, no tools');
      assert.deepEqual(errors, [], 'no browser exceptions');
      note('4: off → no section, no tools; no page errors');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; model calls: ${JSON.stringify(seen.map((s) => ({ kind: s.kind, tools: s.tools.length, last: s.last.slice(0, 80) })))}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
