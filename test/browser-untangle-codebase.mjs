// Real-app check of "Untangle codebase" on each dsh given: a fake model, a throwaway DSH_HOME, a made-up project
// (demo-app). Never the normal DSH_HOME, no real model. Headless.
// 1. Settings: the row has its screenshot and is on by default (route on: true).
// 2. Chat A: `/untangle-codebase src/api` → the model request carries the skill body (<skill_content
//    name="untangle-codebase">, "Start a thorough refactor") and the user's focus text; no skill catalog entry names it.
// 3. In chat A, `/untang` in the composer → dsh's `/` menu shows the skill with dsh's "user-only" mark.
// 4. Chat B: the model calls the `skill` tool with "untangle-codebase" itself → dsh refuses it ("not available for model
//    invocation"): only the user can start it.
// 5. Switch off: the `/` menu has no entry, and `/untangle-codebase lib` reaches the model as plain text (no body).
// 6. Switch on, then a user skill DSH_HOME/skills/untangle-codebase: the menu shows the user's copy, and
//    `/untangle-codebase docs` injects the user's body, not ours (rank 600: user skills win).
// 7. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-untangle-codebase.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/untangleCodebase.webp (English UI, made-up project).
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
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(250); }
};

const TASK = { A: '/untangle-codebase src/api', B: 'Load the untangle skill yourself', C: '/untangle-codebase lib', D: '/untangle-codebase docs' };
const ANSWER = { A: 'Before I start: should I also remove comments that restate the code, and tests that cannot catch a bug?', B: 'Only you can start that skill.', C: 'Plain text, no skill.', D: 'The local copy runs.' };
const LOCAL = 'LOCAL DEMO COPY OF THE SKILL';
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
// Fake OpenAI-compatible model: each chat call is kept with its full text; title calls are answered and not kept.
const chats = []; // {task, text, results}
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const text = msgs.map((m) => textOf(m.content)).join('\n');
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Untangle demo');
    if (/You predict the next message|You complete the message that the user is typing/.test(text)) return say('');
    const task = Object.keys(TASK).find((k) => text.includes(TASK[k])) ?? '?';
    const results = msgs.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    chats.push({ task, text, results });
    if (task === 'B' && results.length === 0) {
      send({ role: 'assistant', content: 'I will load it.', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'skill', arguments: JSON.stringify({ name: 'untangle-codebase' }) } }] });
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    return say(ANSWER[task] ?? 'ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const catalogNames = (text) => [...text.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)].flatMap((m) => [...m[1].matchAll(/^- `([^`]+)`/gm)].map((x) => x[1]));

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
let shotDone = false;
try {
  for (const bin of process.argv.slice(2)) {
    chats.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-untangle-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    // dsh watches this root from the start; a model-visible demo skill proves that the catalog is sent and leaves ours out.
    await mkdir(join(home, 'skills', 'demo-notes'), { recursive: true });
    await writeFile(join(home, 'skills', 'demo-notes', 'SKILL.md'), '---\nname: demo-notes\ndescription: Write short release notes for the demo app.\n---\n\nWrite three bullets.\n');
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'untangle-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // The made-up project.
    const project = join(home, 'projects', 'demo-app');
    await mkdir(join(project, 'src', 'api'), { recursive: true });
    await writeFile(join(project, 'src', 'api', 'orders.js'), "export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n");
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'demo-app', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3211', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
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
      const route = () => page.evaluate(async () => (await fetch('/api/composer-plus.untangle-codebase')).json());
      const clear = async () => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.press('Escape'); };
      const send = async (text) => { await clear(); await page.keyboard.type(text, { delay: 10 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      const newChat = async () => {
        const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'demo-app' }).first();
        await proj.hover();
        await page.getByRole('button', { name: 'New session in demo-app', exact: true }).click(); await pause(800);
      };
      const allowAll = async (done) => {
        const end = Date.now() + 40000;
        while (!(await done())) {
          if (Date.now() > end) throw Error('timed out waiting through approvals');
          const allow = page.getByRole('button', { name: /^(Allow once|Allow|Approve)$/ }).first();
          if (await allow.isVisible().catch(() => false)) { await allow.click().catch(() => {}); await pause(300); } else await pause(200);
        }
      };
      // The `/` menu's option for the skill, after typing `/untang` (null when the menu does not list it).
      const menuOption = async () => {
        await clear(); await page.keyboard.type('/untang', { delay: 20 }); await pause(700);
        const option = page.getByRole('option').filter({ hasText: 'untangle-codebase' }).first();
        return (await option.count()) ? option : null;
      };
      const callsOf = (task) => chats.filter((c) => c.task === task);

      // 1. Settings row: screenshot, on by default.
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      const sw = page.getByRole('switch', { name: 'Untangle codebase', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      assert.equal(await sw.locator('xpath=..').locator('[data-composer-plus-shot="untangleCodebase"]').count(), 1, 'the row has its screenshot');
      assert.deepEqual(await route(), { on: true });
      await back();
      note('1: Settings row with its screenshot, on by default (switch and route)');

      // 2. Chat A: the skill body and the focus reach the model; the model's catalog does not list it.
      await send(TASK.A);
      await allowAll(async () => (await page.getByText(ANSWER.A).count()) > 0);
      const a = callsOf('A')[0];
      assert.ok(a.text.includes('<skill_content name="untangle-codebase">'), 'the skill body is injected');
      assert.ok(a.text.includes('Start a thorough refactor of this codebase and complete it to the end.'), 'the shipped body');
      assert.ok(!a.text.includes('disable-model-invocation'), 'no frontmatter in the body');
      assert.ok(a.text.includes(TASK.A), 'the focus text is in the user message');
      assert.ok(catalogNames(a.text).includes('demo-notes'), `the model's skill catalog is in the request: ${JSON.stringify(catalogNames(a.text))}`);
      assert.ok(!catalogNames(a.text).includes('untangle-codebase'), `not in the model's skill catalog: ${JSON.stringify(catalogNames(a.text))}`);
      note(`2: chat A → body + focus in the request; model catalog: ${JSON.stringify(catalogNames(a.text))}`);

      // 3. The `/` menu lists it as user-only.
      const option = await until(menuOption, 'the / menu lists untangle-codebase');
      const optionText = await option.innerText();
      assert.match(optionText, /user-only/, `dsh's user-only mark: ${optionText}`);
      assert.match(optionText, /Untangle a whole codebase in one pass/);
      note(`3: / menu → "${optionText.replace(/\s+/g, ' ').slice(0, 90)}…"`);
      if (process.env.SHOT && !shotDone) {
        await page.mouse.move(1000, 100); await pause(400);
        const list = await page.getByRole('listbox').first().boundingBox();
        const box = await input.boundingBox();
        // The `/` menu over the composer: the skill with dsh's "user-only" mark, and the typed command.
        const top = Math.max(0, list.y - 12);
        const left = Math.max(0, Math.min(list.x, box.x) - 16); const right = Math.min(1280, Math.max(list.x + list.width, box.x + box.width) + 16);
        const bottom = Math.min(800, box.y + box.height + 56);
        const png = join(home, 'untangleCodebase.png');
        await page.screenshot({ path: png, clip: { x: left, y: top, width: right - left, height: bottom - top } });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round((right - left) * 1.25))), '0', png, '-o', join(repo, 'assets/features/untangleCodebase.webp')]);
        note(`shot: assets/features/untangleCodebase.webp ${(await stat(join(repo, 'assets/features/untangleCodebase.webp'))).size} bytes`);
        shotDone = true;
      }
      await clear();

      // 4. Chat B: the model cannot load it with the skill tool.
      await newChat();
      await send(TASK.B);
      await allowAll(async () => callsOf('B').length >= 2);
      const refused = callsOf('B')[1].results.join('\n');
      assert.match(refused, /not available for model invocation/, `dsh refuses the model's own load: ${refused}`);
      assert.ok(!callsOf('B')[1].text.includes('Start a thorough refactor'), 'no body after the refused load');
      note('4: chat B → the skill tool call is refused: "not available for model invocation"');

      // 5. Switch off: no menu entry, and the command is plain text.
      await settings(); await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'false' && (await route()).on === false, 'switched off');
      await back();
      await newChat();
      await until(async () => (await menuOption()) === null, 'the / menu drops the skill');
      await send(TASK.C);
      await allowAll(async () => (await page.getByText(ANSWER.C).count()) > 0);
      assert.ok(!callsOf('C')[0].text.includes('<skill_content name="untangle-codebase">'), 'off: no body');
      note('5: switched off → no / menu entry, `/untangle-codebase lib` reaches the model as plain text');

      // 6. Switch on, then a user skill with the same name wins.
      await settings(); await sw.click();
      await until(async () => (await sw.getAttribute('aria-checked')) === 'true' && (await route()).on === true, 'switched on');
      await back();
      await mkdir(join(home, 'skills', 'untangle-codebase'));
      await writeFile(join(home, 'skills', 'untangle-codebase', 'SKILL.md'), `---\nname: untangle-codebase\ndescription: Local demo copy of the untangle skill.\n---\n\n${LOCAL}\n`);
      await newChat();
      await until(async () => { const o = await menuOption(); return o !== null && /Local demo copy/.test(await o.innerText()); }, 'the / menu shows the user copy');
      await send(TASK.D);
      await allowAll(async () => (await page.getByText(ANSWER.D).count()) > 0);
      const d = callsOf('D')[0].text;
      assert.ok(d.includes(LOCAL) && !d.includes('Start a thorough refactor'), 'the user copy is injected, not ours');
      note('6: a user skill with the same name wins (menu and body)');

      assert.deepEqual(errors, [], 'no browser exceptions');
      note('7: no page errors');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; chat calls: ${JSON.stringify(chats.map((c) => ({ task: c.task, results: c.results.map((r) => r.slice(0, 80)) })))}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
