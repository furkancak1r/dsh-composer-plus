// Real-app check of "Turkish skill pack" on each dsh given: a fake model, a fake GitHub, a throwaway DSH_HOME and a
// made-up project (demo-app). Never the normal DSH_HOME, no real model, no real GitHub. Headless.
// 1. English UI: the switch is on by default, the row says "Not installed", the model's request has no
//    turkish-anti-ai-skill in its skill catalog, and nothing asked the fake GitHub.
// 2. Application language → Türkçe: the Host downloads the pack (only its Markdown files) and registers the skill: the
//    next chat's model request lists turkish-anti-ai-skill; the row says "Kuruldu".
// 3. Switch off: the copy is deleted, the next request has no such skill. Switch on again: it comes back.
// 4. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-turkish-skill.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/turkishSkill.webp (English UI: the Settings row while installed).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readdir, symlink, rm, realpath, stat } from 'node:fs/promises';
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

// Fake GitHub: one commit with the skill folder, a script and a README (only the Markdown of the folder may be asked for).
const COMMIT = createHash('sha1').update('demo').digest('hex');
const DIR = 'skills/turkish-anti-ai-skill';
const FILES = {
  [`${DIR}/SKILL.md`]: '---\nname: turkish-anti-ai-skill\ndescription: Writes natural Turkish text without AI patterns (demo copy for the test).\nlicense: MIT\n---\n\n# Demo rules\n\nWrite short sentences.\n',
  [`${DIR}/references/demo.md`]: '# Demo reference\n',
  'scripts/detect.py': 'print("never downloaded")\n',
  'README.md': '# demo\n',
};
const blob = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const githubCalls = [];
const github = createServer((req, res) => {
  githubCalls.push(req.url);
  if (req.url === '/api/repos/yucezerey/turkish-anti-ai-skill/commits/HEAD') { res.end(COMMIT); return; }
  if (req.url === `/api/repos/yucezerey/turkish-anti-ai-skill/git/trees/${COMMIT}?recursive=1`) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sha: COMMIT, truncated: false, tree: Object.entries(FILES).map(([path, text]) => ({ path, mode: '100644', type: 'blob', sha: blob(text), size: Buffer.byteLength(text) })) }));
    return;
  }
  const raw = req.url.match(new RegExp(`^/raw/yucezerey/turkish-anti-ai-skill/${COMMIT}/(.+)$`));
  if (raw && FILES[raw[1]] !== undefined) { res.end(FILES[raw[1]]); return; }
  res.statusCode = 404; res.end('not found');
}).listen(0, '127.0.0.1');
await new Promise((r) => github.once('listening', r));

// Fake OpenAI-compatible model: records whether the request's text names the skill; answers "Done.".
const chats = [];
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const say = (t) => { res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })}\n\n`); res.end('data: [DONE]\n\n'); };
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Demo');
    if (/You predict the next message|You complete the message that the user is typing/.test(body)) return say('');
    chats.push({ skill: body.includes('turkish-anti-ai-skill'), task: msgs.map((m) => textOf(m.content)).join('\n').match(/Task \d/)?.[0] });
    return say('Done.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    chats.length = 0; githubCalls.length = 0;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-turkish-skill-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'turkish-skill-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'demo-app');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'notes.md'), '# Demo app\n');
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'demo-app', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const cache = join(home, 'cache', 'composer-plus', 'turkish-skill');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3208', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo',
      COMPOSER_PLUS_TURKISH_SKILL_BASE: `http://127.0.0.1:${github.address().port}`, npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' } });
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
        const direct = page.getByRole('button', { name: /^(Settings|Ayarlar)$/, exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: /^(Account menu|Hesap menüsü)$/ }).click(); await page.getByRole('menuitem', { name: /^(Settings|Ayarlar)/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        await page.locator('[data-composer-plus-settings]').waitFor();
      };
      const back = async () => {
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const button = overlay.getByRole('button', { name: /^(Close|Kapat)$/ });
        if (await button.count()) await button.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(400);
      };
      const choose = async (label) => {
        await page.locator('[data-composer-plus-language] button[aria-haspopup=menu]').click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
      };
      const route = () => page.evaluate(async () => (await fetch('/api/composer-plus.turkish-skill')).json());
      const send = async (text) => { await input.click(); await page.keyboard.type(text, { delay: 10 }); await page.keyboard.press('Enter'); };
      const newChat = async (label) => {
        const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'demo-app' }).first();
        await proj.hover();
        await page.getByRole('button', { name: label, exact: true }).click(); await pause(800);
      };
      const ask = async (task, label) => { await newChat(label); const before = chats.length; await send(task); await until(() => chats.slice(before).some((c) => c.task === task), `model call for ${task}`); return chats.slice(before).find((c) => c.task === task); };
      const row = () => page.locator('[data-composer-plus-settings] > div').filter({ has: page.getByRole('switch', { name: /^(Turkish skill pack|Türkçe skill paketi)$/ }) }).last();

      // 1. English: on by default, not installed, no GitHub call, no skill in the request.
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      const sw = page.getByRole('switch', { name: 'Turkish skill pack', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      await until(async () => (await route()).turkish === false, 'the English UI language was reported');
      await page.getByText('Not installed: the app language is not Türkçe.').waitFor({ timeout: 10000 });
      await back();
      const en = await ask('Task 1', 'New session in demo-app');
      assert.equal(en.skill, false, 'English: the skill is not in the request');
      assert.deepEqual(githubCalls, [], 'English: nothing asked GitHub');
      note('1: English → switch on by default, "Not installed", no skill in the request, no GitHub call');

      // 2. Türkçe: downloaded (Markdown of the skill folder only) and registered.
      await settings(); await choose('Türkçe');
      await page.waitForFunction(() => document.documentElement.lang === 'tr');
      await until(async () => (await route()).installed === true, 'installed after Türkçe', 30000);
      await page.getByText(/^Kuruldu \(sürüm [0-9a-f]{7}\)/).waitFor({ timeout: 10000 });
      assert.ok(githubCalls.every((u) => !/detect\.py|README/.test(u)), `only the skill's Markdown is asked for: ${JSON.stringify(githubCalls)}`);
      assert.deepEqual((await readdir(join(cache, COMMIT), { recursive: true })).sort(), ['SKILL.md', 'references', 'references/demo.md']);
      assert.equal((await stat(join(cache, COMMIT, 'SKILL.md'))).mode & 0o777, 0o600);
      await back();
      const tr = await ask('Task 2', 'demo-app içinde yeni oturum');
      assert.equal(tr.skill, true, 'Türkçe: the skill is in the request');
      note(`2: Türkçe → downloaded ${githubCalls.length} files/calls from the fake GitHub, row "Kuruldu", skill in the next request`);

      // 3. Off: unregistered and deleted; on: back.
      await settings();
      const swTr = page.getByRole('switch', { name: 'Türkçe skill paketi', exact: true });
      await swTr.click();
      await until(async () => (await route()).on === false && !existsSync(cache), 'switched off and deleted');
      await back();
      const off = await ask('Task 3', 'demo-app içinde yeni oturum');
      assert.equal(off.skill, false, 'off: the skill is gone from the request');
      await settings(); await swTr.click();
      await until(async () => (await route()).installed === true, 'installed again');
      note('3: off → copy deleted, no skill in the request; on → installed again');

      if (process.env.SHOT) {
        // The row in the English UI while the pack is installed (the language switch stays on English only for the shot:
        // the Host keeps the pack until the next language report, which the switch back to English sends).
        await choose('English'); await page.waitForFunction(() => document.documentElement.lang === 'en');
        await page.evaluate(async () => { await fetch('/api/composer-plus.turkish-skill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"lang":"tr"}' }); });
        // Close and open Settings again, so the row reads the Host's state.
        await back(); await settings(); await page.getByText(/^Installed \(version [0-9a-f]{7}\)/).waitFor({ timeout: 10000 });
        const r = row(); await r.scrollIntoViewIfNeeded(); await page.mouse.move(1200, 50); await pause(400);
        const box = await r.boundingBox();
        const png = join(home, 'turkishSkill.png');
        await page.screenshot({ path: png, clip: { x: box.x - 16, y: box.y - 8, width: box.width + 32, height: box.height + 16 } });
        execFileSync('cwebp', ['-quiet', '-q', '80', '-resize', String(Math.min(960, Math.round((box.width + 32) * 1.25))), '0', png, '-o', join(repo, 'assets/features/turkishSkill.webp')]);
        note(`shot: assets/features/turkishSkill.webp ${(await stat(join(repo, 'assets/features/turkishSkill.webp'))).size} bytes`);
      }

      assert.deepEqual(errors, [], 'no browser exceptions');
      note('4: no page errors');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; github: ${JSON.stringify(githubCalls)}; chats: ${JSON.stringify(chats)}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); github.close(); }
