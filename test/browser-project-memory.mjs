// Real-app check of "Project memory" on each dsh given: a fake model, a throwaway DSH_HOME, a made-up project (acme-web).
// Never the normal DSH_HOME, no real model. Headless.
// 1. Settings: the switch is off by default; with it off, a turn sends no memory section and no memory tools.
// 2. Switch on. Chat 1: "Remember: …" → after the turn the review (a call with the review system prompt) saves the entry.
//    The model also calls memory_remember once. The files are under DSH_HOME/storages/dsh-composer-plus/memory/, the
//    project folder has no new file.
// 3. Chat 2 in the same project: its request has the memory section with both entries and the three tools.
// 4. Settings → Open memory: the notes by project; a request in the text field → the editor call (dsh's default model, the
//    editor system prompt, no tools) → the preview → Apply writes the file. A second click while it runs sends nothing.
// 5. Switch off: the dialog and its button go; the next request has no section and no tools. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-project-memory.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/projectMemory.webp (English UI, made-up projects): the Open memory dialog with a preview.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
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
    const kind = system.startsWith('You keep the long-term memory') ? 'review' : system.startsWith('You edit the long-term memory') ? 'edit' : /session title/i.test(last) ? 'title'
      : /You predict the next message|You complete the message/.test(JSON.stringify(msgs)) ? 'predict' : 'chat';
    seen.push({ kind, system, tools: (parsed.tools ?? []).map((t) => t.function?.name), last });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    if (kind === 'review') return say('{"changes":[{"op":"add","text":"The user deploys acme-web with make release"}]}');
    // The editor: the note "The user wants short answers" becomes a global note; a slow answer, so a second click can come in.
    const shortNote = /\[(\d+)\] \(project\) The user wants short answers/.exec(last)?.[1];
    if (kind === 'edit') { setTimeout(() => say('{"changes":[{"op":"remove","entry":' + shortNote + '},{"op":"add","text":"The user wants short answers in every project","global":true},{"op":"add","text":"Releases need a git tag first"}],"note":"Moves the short-answers note to the global memory and adds the tag rule."}'), 1500); return; }
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
      const editorStyles = () => page.evaluate(() => [...document.querySelectorAll('style')].filter((el) => el.textContent.includes('.cp-mem{')).length);

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
      note(`2: on → section + 3 tools in the request; memory_remember and the review wrote ${join('storages/dsh-composer-plus/memory/projects', projects[0], 'MEMORY.md')} (2 entries, journal 2 rows); project folder unchanged`);

      // 3. A new chat in the same project reads both entries in its system prompt.
      await newChat();
      const before3 = chats().length;
      await say('What do you know about deploys?');
      const third = await until(() => chats().slice(before3)[0], 'chat 3 request');
      assert.match(third.system, /The user deploys acme-web with make release/); assert.match(third.system, /The user wants short answers/);
      note('3: a new chat in acme-web gets both entries in its system prompt');

      // 4. Open memory: notes by project, a preview from dsh's default model, Apply.
      // A second project with a note, so the dialog shows the grouping (written as the store writes it).
      const other = join(home, 'projects', 'acme-blog'); await mkdir(other, { recursive: true });
      const otherId = createHash('sha256').update(await realpath(other)).digest('hex').slice(0, 32);
      await mkdir(join(memDir, 'projects', otherId), { recursive: true });
      await writeFile(join(memDir, 'projects', otherId, 'MEMORY.md'), '# Memory\n\n- The blog builds with Hugo [added: 2026-10-29]\n\n## Index\n');
      await writeFile(join(memDir, 'projects', otherId, 'project.json'), JSON.stringify({ path: other }));
      await settings();
      await page.locator('[data-composer-plus-memory-open]').click();
      const dialog = page.locator('[data-composer-plus-memory-editor]'); await dialog.waitFor();
      // All notes: one group per project with notes, A–Z (the global memory has no note yet, so it has no group).
      const groups = await until(async () => { const g = await dialog.locator('[data-composer-plus-memory-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-composer-plus-memory-group'))); return g.length === 2 && g; }, 'two groups');
      assert.deepEqual(groups, [otherId, projects[0]], 'grouped by project, acme-blog before acme-web');
      // The dialog is wide and its project list shows (dsh's Modal is 380 px by default).
      const wide = await dialog.boundingBox(); assert.ok(wide.width > 900, `dialog width ${wide.width}`);
      assert.ok(await dialog.locator('nav').isVisible(), 'the project list shows');
      const navBox = await dialog.locator('nav').boundingBox(); assert.ok(navBox.x >= wide.x - 1, 'the list is not cut off');
      await dialog.getByText('The blog builds with Hugo').waitFor();
      assert.equal(await editorStyles(), 1, 'one editor style');
      await dialog.locator(`[data-composer-plus-memory-project="${projects[0]}"]`).click();
      assert.equal(await dialog.locator('[data-composer-plus-memory-group]').count(), 1, 'one project selected');
      await dialog.locator('[data-composer-plus-memory-ask]').fill('Make the short-answers note global, and add that releases need a git tag first');
      const edits = () => seen.filter((x) => x.kind === 'edit').length;
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await until(async () => (await dialog.locator('[data-composer-plus-memory-preview-button]').getAttribute('aria-busy')) === 'true', 'preview runs');
      // A second ask while it runs: the button is off and the key sends nothing.
      assert.equal(await dialog.locator('[data-composer-plus-memory-preview-button]').isDisabled(), true);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await dialog.locator('[data-composer-plus-memory-preview]').waitFor({ timeout: 20000 });
      assert.equal(edits(), 1, 'one editor call');
      const edit = seen.find((x) => x.kind === 'edit');
      assert.equal(edit.tools.length, 0, 'no tools'); assert.match(edit.last, /The user wants short answers/); assert.doesNotMatch(edit.last, /Hugo/, 'only the selected project');
      assert.deepEqual(await dialog.locator('[data-composer-plus-memory-change]').evaluateAll((els) => els.map((e) => e.getAttribute('data-composer-plus-memory-change'))), ['remove', 'add', 'add']);
      const before5 = await readFile(join(memDir, 'projects', projects[0], 'MEMORY.md'), 'utf8');
      assert.match(before5, /short answers/, 'a preview writes nothing');
      if (process.env.SHOT) {
        // The picture shows a made-up home path, not this machine's temp folder (only the page's view changes).
        await dialog.locator('h3 small').evaluateAll((els, h) => { for (const el of els) el.textContent = el.textContent.replace(h, '~'); }, home);
        await page.mouse.move(5, 5); await pause(500);
        const box = await dialog.boundingBox();
        const png = join(home, 'projectMemory.png'); await page.screenshot({ path: png, clip: box });
        execFileSync('cwebp', ['-quiet', '-q', '76', '-resize', String(Math.min(1040, Math.round(box.width))), '0', png, '-o', join(repo, 'assets/features/projectMemory.webp')]);
        note(`shot: assets/features/projectMemory.webp ${(await stat(join(repo, 'assets/features/projectMemory.webp'))).size} bytes`);
      }
      await dialog.locator('[data-composer-plus-memory-apply]').click();
      await until(async () => !(await dialog.locator('[data-composer-plus-memory-preview]').count()), 'applied');
      const after5 = await readFile(join(memDir, 'projects', projects[0], 'MEMORY.md'), 'utf8');
      assert.doesNotMatch(after5, /The user wants short answers \[/); assert.match(after5, /Releases need a git tag first \[source: editor/);
      assert.match(await readFile(join(memDir, 'global', 'MEMORY.md'), 'utf8'), /short answers in every project/);
      const rows = (await readFile(join(memDir, 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.actor === 'editor');
      assert.equal(rows.length, 3, 'three editor rows in the journal');
      assert.ok(seen.filter((x) => x.kind === 'edit').length === 1, 'still one editor call');
      note('4: Open memory groups 2 projects + global; ⌘/Ctrl+Enter previews once (second key ignored); Apply writes 3 changes (journal actor editor)');

      // 5. Esc closes the dialog (not Settings); its style goes with it. Off: the button goes; no section, no tools.
      await page.keyboard.press('Escape');
      await until(async () => (await dialog.count()) === 0, 'Esc closes the dialog');
      assert.equal(await page.locator('[data-composer-plus-settings]').count(), 1, 'Settings stays open');
      assert.equal(await editorStyles(), 0, 'closed: no style');
      await memorySwitch.click();
      await until(async () => (await memorySwitch.getAttribute('aria-checked')) === 'false', 'switched off');
      assert.equal(await page.locator('[data-composer-plus-memory-open]').count(), 0, 'off: no button');
      await back();
      await newChat();
      const before4 = chats().length;
      await say('Hello again');
      const fourth = await until(() => chats().slice(before4)[0], 'chat 4 request');
      assert.ok(!fourth.system.includes('# Memory (Composer Plus)') && !fourth.tools.some((n) => n?.startsWith('memory_')), 'off again: no section, no tools');
      assert.deepEqual(errors, [], 'no browser exceptions');
      note('5: off → dialog, button and style gone; no section, no tools; no page errors');
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
