// Real-app check of the Project memory features on each dsh given: a fake model, a throwaway DSH_HOME, made-up projects
// (acme-web, acme-blog). Never the normal DSH_HOME, no real model. Headless.
// History: Open memory → acme-web → an Apply makes a version → History lists it → its diff → Restore brings the old note back.
// Suggest: a new chat → Suggest for memory → the model's notes → Accept saves one with its source, Reject saves nothing.
// PLAYWRIGHT=/path/to/playwright node test/browser-memory-features.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/<feature>.webp (English UI, made-up projects). ONLY=history,export,… runs those parts.
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
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : undefined;
const part = (name) => ONLY === undefined || ONLY.has(name);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); }
};
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');

// Fake OpenAI-compatible model. `answers[kind]` (a function of the last message) answers the side calls.
const seen = []; // {kind, system, tools, last, messages}
const answers = {};
// `toolCall`: the next chat request whose newest user message matches `when` calls this tool once (then the model says "Noted.").
let toolCall;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    const system = textOf(msgs.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    const last = textOf(msgs.at(-1)?.content);
    const kind = system.startsWith('You keep the long-term memory') ? 'review' : system.startsWith('You edit the long-term memory') ? 'edit'
      : system.startsWith('You suggest notes for the long-term memory') ? 'suggest' : /session title/i.test(last) ? 'title'
        : /You predict the next message|You complete the message/.test(JSON.stringify(msgs)) ? 'predict' : 'chat';
    seen.push({ kind, system, tools: (parsed.tools ?? []).map((t) => t.function?.name), last, messages: msgs });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    if (answers[kind]) return say(answers[kind](last));
    if (kind === 'chat' && toolCall !== undefined) {
      const asked = msgs.findLast((m) => m.role === 'user' && toolCall.when.test(textOf(m.content)));
      const done = asked !== undefined && msgs.slice(msgs.lastIndexOf(asked)).some((m) => m.role === 'tool');
      if (asked && !done && (parsed.tools ?? []).some((t) => t.function?.name === toolCall.name)) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] });
        send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
      }
    }
    if (kind === 'review') return say('{"changes":[]}');
    if (kind === 'title') return say('Release notes');
    if (kind === 'predict') return say('');
    return say('Noted.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-memfeat-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'memory-features-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const projects = join(home, 'projects');
    const web = join(projects, 'acme-web'); const blog = join(projects, 'acme-blog');
    await mkdir(join(web, 'src'), { recursive: true }); await mkdir(blog, { recursive: true });
    await writeFile(join(web, 'README.md'), '# acme-web\nA demo web shop.\n');
    await writeFile(join(web, 'package.json'), JSON.stringify({ name: 'acme-web', scripts: { test: 'node --test', build: 'vite build' } }, null, 2));
    await writeFile(join(web, 'src', 'cart.ts'), 'export const cart = [];\n');
    await writeFile(join(blog, 'README.md'), '# acme-blog\nA demo blog.\n');
    const now = new Date().toISOString();
    const wsWeb = randomUUID(); const wsBlog = randomUUID();
    await mkdir(join(home, 'storages', 'dsh-composer-plus'), { recursive: true });
    await writeFile(join(home, 'storages', 'dsh-composer-plus', 'default-workspace.json'), JSON.stringify({ on: false }));
    await writeFile(join(home, 'storages', 'dsh-composer-plus', 'memory.json'), JSON.stringify({ on: true }));
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wsWeb, wsBlog], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wsWeb },
      tables: { workspaces: { [wsWeb]: { path: web, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now }, [wsBlog]: { path: blog, title: 'acme-blog', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    // Made-up notes for acme-web, written as the store writes them.
    const memDir = join(home, 'storages', 'dsh-composer-plus', 'memory');
    const idOf = async (path) => createHash('sha256').update(await realpath(path)).digest('hex').slice(0, 32);
    const webId = await idOf(web); const blogId = await idOf(blog);
    await mkdir(join(memDir, 'projects', webId), { recursive: true });
    await writeFile(join(memDir, 'projects', webId, 'MEMORY.md'), '# Memory\n\n- The user runs the tests with `npm run test` [added: 2026-10-30]\n- The user wants short answers [added: 2026-10-31]\n- Releases need a git tag first [added: 2026-11-01]\n\n## Index\n');
    await writeFile(join(memDir, 'projects', webId, 'project.json'), JSON.stringify({ path: web }));

    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3208', '--no-open'], { cwd: web, env: { ...process.env, HOME: home, DSH_HOME: home, DEMO_KEY: 'demo', DSH_PERMISSION_MODE: 'danger-full-access', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"nextPrediction":false}'); });
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
      const shot = async (locator, name, width = 1040) => {
        if (!process.env.SHOT) return;
        // The picture shows a made-up home path, not this machine's temp folder (only the page's view changes).
        await page.evaluate((h) => { const walk = (n) => { if (n.nodeType === 3 && n.nodeValue.includes(h)) n.nodeValue = n.nodeValue.replaceAll(h, '~'); else for (const c of n.childNodes) walk(c); }; walk(document.body); }, home);
        await page.mouse.move(5, 5); await pause(500);
        const box = await locator.boundingBox();
        const png = join(home, `${name}.png`); await page.screenshot({ path: png, clip: box });
        execFileSync('cwebp', ['-quiet', '-q', '76', '-resize', String(Math.min(width, Math.round(box.width))), '0', png, '-o', join(repo, `assets/features/${name}.webp`)]);
        note(`shot: assets/features/${name}.webp ${(await stat(join(repo, `assets/features/${name}.webp`))).size} bytes`);
      };
      const openMemory = async () => {
        await settings();
        await page.locator('[data-composer-plus-memory-open]').click();
        const dialog = page.locator('[data-composer-plus-memory-editor]'); await dialog.waitFor();
        await dialog.getByText('Releases need a git tag first').first().waitFor();
        return dialog;
      };
      const say = async (text) => { await input.click(); await page.keyboard.type(text, { delay: 3 }); await page.keyboard.press('Enter'); };
      const newChat = async () => { await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(800); };
      const closeMemory = async (dialog) => { await page.keyboard.press('Escape'); await until(async () => (await dialog.count()) === 0, 'the dialog closes'); await back(); };

      if (part('history')) {
        // An Apply of Open memory makes a version (the notes before it).
        answers.edit = (last) => JSON.stringify({ changes: [{ op: 'remove', entry: Number(/\[(\d+)\] \(project\) The user wants short answers/.exec(last)[1]) }, { op: 'add', text: 'The user wants answers in English' }], note: 'Replaces the short-answers note.' });
        const dialog = await openMemory();
        await dialog.locator(`[data-composer-plus-memory-project="${webId}"]`).click();
        await dialog.locator('[data-composer-plus-memory-ask]').fill('I want answers in English, not short ones');
        await dialog.locator('[data-composer-plus-memory-preview-button]').click();
        await dialog.locator('[data-composer-plus-memory-apply]').click();
        await until(async () => !(await dialog.locator('[data-composer-plus-memory-preview]').count()), 'applied');
        assert.doesNotMatch(await readFile(join(memDir, 'projects', webId, 'MEMORY.md'), 'utf8'), /short answers/);
        await dialog.locator(`[data-composer-plus-memory-history-open="${webId}"]`).click();
        const version = dialog.locator('[data-composer-plus-memory-version]').first(); await version.waitFor();
        assert.match(await version.textContent(), /Before a change by Open memory/);
        await version.click();
        const diff = dialog.locator('[data-composer-plus-memory-diff]'); await diff.waitFor();
        assert.match(await diff.textContent(), /\+- The user wants short answers/);
        await shot(dialog, 'memoryHistory');
        await dialog.locator('[data-composer-plus-memory-restore]').click();
        await dialog.getByText(/Version restored/).waitFor();
        const main = await readFile(join(memDir, 'projects', webId, 'MEMORY.md'), 'utf8');
        assert.match(main, /short answers/); assert.doesNotMatch(main, /answers in English/);
        const versions = await readdir(join(memDir, 'history', webId));
        assert.equal(versions.length, 2, 'the Apply and the restore each kept a version');
        await closeMemory(dialog);
        note('history: Apply kept a version; History lists it with its diff; Restore brought the old note back and kept the memory before it');
      }

      if (part('export')) {
        // AGENTS.md with the team's own text: Export adds the section at the end; the diff shows first; Write writes it.
        await writeFile(join(web, 'AGENTS.md'), '# Team rules\n\n- Use tabs in TypeScript files.\n');
        const dialog = await openMemory();
        await dialog.locator(`[data-composer-plus-memory-project="${webId}"]`).click();
        await dialog.locator(`[data-composer-plus-memory-export="${webId}"]`).click();
        const preview = dialog.locator('[data-composer-plus-memory-export-preview]'); await preview.waitFor();
        assert.match(await preview.textContent(), /\+- Releases need a git tag first/);
        assert.equal(await readFile(join(web, 'AGENTS.md'), 'utf8'), '# Team rules\n\n- Use tabs in TypeScript files.\n', 'a preview writes nothing');
        await shot(dialog, 'memoryExport');
        await dialog.locator('[data-composer-plus-memory-export-apply]').click();
        await dialog.getByText('AGENTS.md was written.').waitFor();
        const agents = await readFile(join(web, 'AGENTS.md'), 'utf8');
        assert.match(agents, /^# Team rules\n\n- Use tabs in TypeScript files\.\n\n<!-- BEGIN COMPOSER PLUS MEMORY/);
        assert.match(agents, /- Releases need a git tag first\n<!-- END COMPOSER PLUS MEMORY -->\n$/);
        assert.doesNotMatch(agents, /added:|source:/, 'no dates or sources');
        await closeMemory(dialog);
        note('export: Export to AGENTS.md showed the diff, wrote nothing until Write, then added the marked section after the team\'s text');
      }

      if (part('source')) {
        // The agent saves a note with memory_remember: the note keeps this chat and the message; Source opens it there.
        toolCall = { name: 'memory_remember', args: { text: 'Checkout uses the Stripe test keys on staging' }, when: /Remember: checkout/ };
        await say('Remember: checkout uses the Stripe test keys on staging');
        const main = await until(async () => { const t = await readFile(join(memDir, 'projects', webId, 'MEMORY.md'), 'utf8'); return /Stripe test keys/.test(t) && t; }, 'the tool saved the note');
        const src = /Stripe test keys on staging \[source: (session-[\w-]+) #(\d+);/.exec(main);
        assert.ok(src, `the note has a source: ${main}`);
        // Another chat, so that Source must switch chats.
        await newChat(); await say('Hello'); await until(() => seen.filter((x) => x.kind === 'chat').length >= 3, 'second chat answered');
        const dialog = await openMemory();
        const link = dialog.locator(`[data-composer-plus-memory-source="${src[1]}"]`); await link.waitFor();
        await shot(dialog, 'memorySource');
        await link.click();
        await until(async () => (await page.locator('[data-composer-plus-memory-editor]').count()) === 0 && (await page.locator('[data-composer-plus-settings]').count()) === 0, 'the dialog and Settings close');
        await until(async () => page.locator(`[data-row-key="session:${src[1]}"][aria-selected="true"]`).count(), 'the source chat opens');
        await page.locator('[data-composer-plus-jump]').first().waitFor({ timeout: 10000 });
        note(`source: memory_remember saved ${src[1]} #${src[2]}; Source closed the dialog and Settings and opened that chat at the message (it blinked)`);
      }

      if (part('copy')) {
        // acme-web → acme-blog: tick two notes, search the project, press Enter; both notes are in acme-blog's memory.
        const dialog = await openMemory();
        await dialog.locator(`[data-composer-plus-memory-project="${webId}"]`).click();
        await dialog.locator(`[data-composer-plus-memory-copy="${webId}"]`).click();
        const boxes = dialog.locator('[data-composer-plus-memory-pick]'); await boxes.first().waitFor();
        await boxes.nth(0).check(); await boxes.nth(2).check();
        await dialog.locator('[data-composer-plus-memory-copy-search]').fill('BLOG');
        await until(async () => (await dialog.locator('[data-composer-plus-memory-copy-to]').count()) === 1, 'the search leaves acme-blog');
        await shot(dialog, 'memoryCopy');
        await dialog.locator('[data-composer-plus-memory-copy-search]').press('Enter');
        await dialog.getByText(/Copied 2 note\(s\) to acme-blog/).waitFor();
        const blogMain = await readFile(join(memDir, 'projects', blogId, 'MEMORY.md'), 'utf8');
        assert.match(blogMain, /npm run test/); assert.match(blogMain, /Releases need a git tag first/);
        assert.deepEqual(JSON.parse(await readFile(join(memDir, 'projects', blogId, 'project.json'), 'utf8')), { path: blog });
        await closeMemory(dialog);
        note('copy: two notes ticked, "BLOG" found acme-blog, Enter copied both into acme-blog\'s memory');
      }

      if (part('stale')) {
        // Two notes that name what acme-web has, two that name what it does not have any more.
        const main = join(memDir, 'projects', webId, 'MEMORY.md');
        await writeFile(main, (await readFile(main, 'utf8')).replace('\n## Index', '- The cart lives in `src/cart.ts` [added: 2026-11-02]\n- The old checkout was in `src/checkout.ts` [added: 2026-10-20]\n- Deploy with `npm run deploy` [added: 2026-10-21]\n\n## Index'));
        const dialog = await openMemory();
        await dialog.locator(`[data-composer-plus-memory-project="${webId}"]`).click();
        const summary = dialog.locator('[data-composer-plus-memory-stale-summary]'); await summary.waitFor();
        assert.match(await summary.textContent(), /2 note\(s\) name a file, script or branch/);
        const marks = await dialog.locator('[data-composer-plus-memory-stale]').allTextContents();
        assert.deepEqual(marks.map((m) => m.trim()).sort(), ['⚠ file not found: src/checkout.ts', '⚠ npm script not found: deploy']);
        await shot(dialog, 'memoryStale');
        await closeMemory(dialog);
        note('stale: acme-web\'s notes checked: src/checkout.ts and npm run deploy marked, src/cart.ts and npm run test not');
      }

      if (part('perchat')) {
        const chats = () => seen.filter((x) => x.kind === 'chat');
        const hasMemory = (req) => req.system.includes('# Memory (Composer Plus)') || req.tools.some((n) => n?.startsWith('memory_'));
        // dsh 0.2.1+: the New chat screen has the chip; switch it off before the first message.
        await newChat();
        const chip = page.locator('[data-composer-plus-memory-chat-chip]');
        const hasChip = await chip.waitFor({ timeout: 5000 }).then(() => true, () => false);
        if (hasChip) {
          assert.equal(await chip.getAttribute('data-composer-plus-memory-chat-chip'), 'on');
          await chip.click();
          await until(async () => (await chip.getAttribute('data-composer-plus-memory-chat-chip')) === 'off', 'the chip says off');
          const before = chats().length;
          await say('A test with no memory');
          const first = await until(() => chats().slice(before)[0], 'the off chat\'s first request');
          assert.ok(!hasMemory(first), 'off from the New chat screen: no memory section, no memory tools in the first request');
          note('perchat: the New chat chip switched the memory off; the first request had no memory section and no memory tools');
        } else note('perchat: no New chat chip on this dsh (0.2.0 has no slot there); the header button is checked instead');
        if (!hasChip) { await say('First message'); await until(() => chats().length > 0 && !chats().at(-1).last.includes('placeholder'), 'first answer'); }
        // The chat header: the button shows this chat's choice; switch it (back) and check the next request.
        const toggle = page.locator('[data-composer-plus-memory-chat]'); await toggle.waitFor({ timeout: 15000 });
        if (!hasChip) {
          await toggle.click();
          await until(async () => (await toggle.getAttribute('data-composer-plus-memory-chat')) === 'off', 'header says off');
          const before = chats().length;
          await say('Second message, memory off');
          const req = await until(() => chats().slice(before)[0], 'request after off');
          assert.ok(!hasMemory(req), 'off from the header: no memory section, no memory tools');
        }
        assert.equal(await toggle.getAttribute('data-composer-plus-memory-chat'), 'off');
        if (process.env.SHOT) {
          // The chat column: the header with the button (its hint shows on hover) and the first answers.
          await toggle.hover(); await pause(1200);
          const column = page.locator('[data-composer-input]').locator('xpath=ancestor::*[.//*[contains(@class,"_titleRow")]][1]');
          const box = await column.boundingBox();
          const png = join(home, 'memoryPerChat.png');
          await page.screenshot({ path: png, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 520) } });
          execFileSync('cwebp', ['-quiet', '-q', '76', '-resize', String(Math.min(1040, Math.round(box.width))), '0', png, '-o', join(repo, 'assets/features/memoryPerChat.webp')]);
          note(`shot: assets/features/memoryPerChat.webp ${(await stat(join(repo, 'assets/features/memoryPerChat.webp'))).size} bytes`);
        }
        // A narrow window: the header button does not overlap dsh's header items, and each one gets a click.
        for (const width of [900, 640, 480]) {
          await page.setViewportSize({ width, height: 900 }); await pause(500);
          const bad = await page.evaluate(() => {
            const row = document.querySelector('[class*="_titleRow"]');
            if (!row) return ['no header row'];
            const items = [...row.querySelectorAll('button, [class*="_crumbCurrent"]')].filter((el) => el.getClientRects().length > 0);
            const boxes = items.map((el) => el.getBoundingClientRect());
            const out = [];
            boxes.forEach((a, i) => boxes.forEach((b, j) => { if (j > i && !items[i].contains(items[j]) && !items[j].contains(items[i]) && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${items[i].textContent.trim()} × ${items[j].textContent.trim()}`); }));
            const me = row.querySelector('[data-composer-plus-memory-chat]');
            if (me) { const r = me.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!me.contains(hit)) out.push('the memory button gets no click'); }
            else out.push('no memory button');
            return out;
          });
          assert.deepEqual(bad, [], `${width} px: no overlap in the header`);
        }
        await page.setViewportSize({ width: 1280, height: 900 }); await pause(300);
        // Another chat in the same project still gets the memory.
        await newChat();
        const before2 = chats().length;
        await say('Another chat');
        const other = await until(() => chats().slice(before2)[0], 'the other chat\'s request');
        assert.ok(other.system.includes('# Memory (Composer Plus)') && other.tools.includes('memory_remember'), 'another chat is not changed');
        const saved = JSON.parse(await readFile(join(home, 'storages', 'dsh-composer-plus', 'memory-chats.json'), 'utf8'));
        assert.equal(Object.keys(saved.off).length, 1, 'one chat switched off, saved on the Host');
        note('perchat: the header button shows off; another chat still has the memory section and tools; memory-chats.json holds the one chat');
      }

      if (part('suggest')) {
        // A new chat in acme-web: no suggest call before the click; the dialog lists the model's notes (a saved one left out);
        // Accept saves one with this chat and message as its source; Reject sends nothing; a global one goes to the global memory.
        answers.suggest = (last) => {
          assert.match(last, /\[L1\] User: Use pnpm in this repo/, 'the request numbers the chat lines');
          return JSON.stringify({ suggestions: [
            { text: 'The user wants pnpm in acme-web, never npm', why: 'The user said so in the first message.', line: 1 },
            { text: 'Releases of acme-web go out on Fridays only', why: 'The user set the release day.', line: 1, topic: 'release' },
            { text: 'The user prefers short commit messages', why: 'The user asked for one-line commits.', line: 1, global: true },
            { text: 'Releases need a git tag first', why: 'Already saved.', line: 1 },
          ] });
        };
        await newChat();
        const before = seen.length;
        await say('Use pnpm in this repo, never npm. Releases go out on Fridays only, and keep commit messages to one line.');
        await until(() => seen.slice(before).some((x) => x.kind === 'chat'), 'the chat answered');
        const button = page.locator('[data-composer-plus-memory-suggest]'); await button.waitFor({ timeout: 15000 });
        const sid = await button.getAttribute('data-composer-plus-memory-suggest');
        await pause(1500);
        assert.equal(seen.filter((x) => x.kind === 'suggest').length, 0, 'no suggest call before the click');
        await button.click();
        const list = page.locator('[data-composer-plus-memory-suggest-dialog]');
        await list.locator('[data-composer-plus-memory-suggestion-accept="0"]').waitFor();
        assert.equal(seen.filter((x) => x.kind === 'suggest').length, 1, 'one suggest call');
        assert.equal(await list.locator('[data-composer-plus-memory-suggestion]').count(), 3, 'the saved note is left out');
        await list.getByText(/1 suggestion\(s\) were left out/).waitFor();
        await list.locator('[data-composer-plus-memory-suggestion-accept="0"]').click();
        await list.locator('[data-composer-plus-memory-suggestion="saved"]').waitFor();
        const main = await readFile(join(memDir, 'projects', webId, 'MEMORY.md'), 'utf8');
        const src = new RegExp(`The user wants pnpm in acme-web, never npm \\[source: ${sid} #(\\d+);`).exec(main);
        assert.ok(src, `the note keeps its source: ${main}`);
        const modal = page.getByRole('dialog').filter({ has: list });
        await shot(modal, 'memorySuggest');
        // The background review of a finished turn can run at any time; Accept and Reject must add no suggest or edit call.
        const asks = () => seen.filter((x) => x.kind === 'suggest' || x.kind === 'edit').length;
        const calls = asks();
        await list.locator('[data-composer-plus-memory-suggestion-reject="1"]').click();
        await list.locator('[data-composer-plus-memory-suggestion="rejected"]').waitFor();
        await list.locator('[data-composer-plus-memory-suggestion-accept="2"]').click();
        await until(async () => (await list.locator('[data-composer-plus-memory-suggestion="saved"]').count()) === 2, 'the global note saved');
        assert.match(await readFile(join(memDir, 'global', 'MEMORY.md'), 'utf8'), /The user prefers short commit messages \[source: /);
        assert.doesNotMatch(await readFile(join(memDir, 'projects', webId, 'MEMORY.md'), 'utf8'), /Fridays/, 'a rejected note is not saved');
        assert.equal(asks(), calls, 'Reject and Accept call no model');
        await page.locator('[data-composer-plus-memory-suggest-close]').click();
        await until(async () => (await list.count()) === 0, 'the dialog closes');
        note(`suggest: no model call before the click; 3 of 4 suggestions shown (a saved one left out); Accept saved one with [source: ${sid} #${src[1]}], Reject saved nothing, a global one went to the global memory`);
      }

      assert.deepEqual(errors, [], 'no browser exceptions');
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
