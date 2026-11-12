// Real-app check of the Assistant onboarding card on each dsh given: a fake model, a throwaway DSH_HOME and HOME, a
// made-up project (acme-web). Never the normal DSH_HOME, no real model. Headless.
// 1. A click on Assistant opens the new assistant chat: the welcome card shows above the input with its title, intro and
//    three examples, inside the chat's composer.
// 2. Switch off in Settings: the card and its style go; switch on and click Assistant again: the card comes back.
// 3. The first message hides the card; a new chat in another project never shows it; the next click on Assistant opens
//    the same chat without the card. No page errors.
// 0. Before that, a new user without Obsidian (Project memory on): the setup card shows the four steps as missing, the
//    official download link, Set up and Check again; a memory_remember of the assistant chat is refused and no memory file
//    is written. Set up writes AGENTS.md and the memory folder setting in ~/Assistant; a made-up Obsidian settings file
//    that knows ~/Assistant as a vault and a dsh restart make it ready (the welcome card shows).
// 0c. Memory import: the welcome card shows the ready prompt; Start sends it; the assistant starts a subagent that reads the
//    sources (acme-web's AGENTS.md and CLAUDE.md with a fake secret line) and saves facts: they arrive in the vault, the
//    secret does not, no memory file is written outside the vault, and a second run adds nothing.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-welcome.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=/path/to/file.png also saves a screenshot of step 1 (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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

// Fake OpenAI-compatible model: every answer is "ok"; "save this" in the assistant chat calls memory_remember once. The
// import prompt starts a subagent; the subagent calls memory_import_sources, then memory_import with two facts (and one
// fact that copies the secret line), then answers with the counts.
const toolResults = []; const importAnswers = [];
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join('') : '');
const call = (res, model, name, args) => {
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const msgs = parsed.messages ?? []; const tool = msgs.findLast((m) => m.role === 'tool');
    const own = msgs.findLast((m) => m.role === 'user' && /^save this/.test(String(typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''))));
    if (own !== undefined && msgs.indexOf(tool) < msgs.indexOf(own) && (parsed.tools ?? []).some((t) => t.function?.name === 'memory_remember')) {
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_mem', type: 'function', function: { name: 'memory_remember', arguments: '{"text":"The user likes tea"}' } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    const names = (parsed.tools ?? []).map((t) => t.function?.name);
    const firstUser = textOf(msgs.find((m) => m.role === 'user' && !/^<|^Current runtime context|^Time sampled/.test(textOf(m.content).trim()))?.content);
    const lastUser = textOf(msgs.findLast((m) => m.role === 'user' && !/^<|^Current runtime context|^Time sampled/.test(textOf(m.content).trim()))?.content);
    const toolsDone = msgs.slice(msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content) === lastUser) + 1).filter((m) => m.role === 'tool');
    // The subagent: its task is the import prompt; it has the two import tools.
    if (names.includes('memory_import_sources') && /memory_import_sources/.test(firstUser)) {
      if (toolsDone.length === 0) return call(res, parsed.model, 'memory_import_sources', {});
      if (toolsDone.length === 1) {
        const read = JSON.parse(textOf(toolsDone[0].content));
        const web = read.files.find((f) => f.path.endsWith('acme-web/AGENTS.md'));
        return call(res, parsed.model, 'memory_import', { facts: [
          { text: 'acme-web deploys with make release.', source: web.path, project: web.project },
          { text: 'The user wants answers in English.', source: read.files.find((f) => f.scope === 'global')?.path ?? web.path },
          { text: 'The deploy token is FAKE_TOKEN_9f8e7d6c5b4a3f2e1d', source: web.path, project: web.project },
        ] });
      }
      importAnswers.push(textOf(toolsDone.at(-1).content));
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: `Import done: ${textOf(toolsDone.at(-1).content)}` }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    // The assistant: the import prompt starts one background subagent with the prompt as its task.
    if (names.includes('subagent') && /memory_import_sources/.test(lastUser) && toolsDone.length === 0) {
      const bg = (parsed.tools ?? []).find((t) => t.function?.name === 'subagent')?.function?.parameters?.properties?.run_in_background !== undefined;
      return call(res, parsed.model, 'subagent', { description: 'Memory import', prompt: lastUser, ...(bg ? { run_in_background: true } : {}) });
    }
    if (tool !== undefined) toolResults.push(String(typeof tool.content === 'string' ? tool.content : (tool.content ?? []).map((c) => c.text ?? '').join('')));
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-welcome-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-welcome-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const dir = join(home, 'projects', 'acme-web'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'README.md'), '# acme-web\n');
    await writeFile(join(dir, 'AGENTS.md'), '# acme-web\n- Deploys go through make release.\n- API_TOKEN=FAKE_TOKEN_9f8e7d6c5b4a3f2e1d\n');
    await writeFile(join(dir, 'CLAUDE.md'), '- Use pnpm.\n');
    await mkdir(join(home, '.claude'), { recursive: true }); await writeFile(join(home, '.claude', 'CLAUDE.md'), '- Answer in English.\n');
    await mkdir(join(dshHome, 'storages/dsh-composer-plus'), { recursive: true });
    await writeFile(join(dshHome, 'storages/dsh-composer-plus/memory.json'), '{"on":true}');
    const wsId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wsId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wsId },
      tables: { workspaces: { [wsId]: { path: dir, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    let child; let log = '';
    const start = async () => {
      log = '';
      child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3214', '--no-open'], { cwd: dir,
        env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      return log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0];
    };
    const stop = async () => { child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); }); };
    const errors = []; let context; let page; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      let url = await start(); assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      let input = page.locator('[data-composer-input]'); await input.first().waitFor({ timeout: 20000 });
      const api = (path) => page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, body: await r.json().catch(() => null) }; }, path);
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
      const assistantRow = () => page.locator('button[aria-label="Damon"]');
      let card; let setupCard;
      const bind = () => { input = page.locator('[data-composer-input]'); card = page.locator('[data-composer-plus-assistant-welcome]:not([data-composer-plus-assistant-setup])'); setupCard = page.locator('[data-composer-plus-assistant-setup]'); };
      bind();
      const memFiles = async (at) => { const out = []; const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) { if (e.isDirectory()) await walk(join(d, e.name)); else if (e.name.endsWith('.md')) out.push(join(d, e.name)); } }; await walk(at); return out; };

      // 0. A new user without Obsidian: the setup card; the assistant saves no memory.
      await assistantRow().waitFor({ timeout: 10000 });
      await assistantRow().click();
      const id0 = await until(async () => { const r = await api('/api/composer-plus.assistant'); return r.status === 200 && r.body.sessionId; }, 'assistant chat id');
      await setupCard.waitFor({ timeout: 20000 });
      assert.equal(await card.count(), 0, 'no welcome card before the setup is ready');
      const setupText = await setupCard.innerText();
      for (const part of ['Set up Obsidian for Damon', 'Obsidian is installed', 'Obsidian knows the folder ~/Assistant as a vault', 'Project memory is on', 'AGENTS.md']) assert.ok(setupText.includes(part), `setup card has "${part}": ${setupText}`);
      // /Applications is not in the made-up home: on a Mac with Obsidian there, the first step is done.
      const appThere = process.platform === 'darwin' && existsSync('/Applications/Obsidian.app');
      assert.deepEqual(await setupCard.locator('[data-step]').evaluateAll((els) => els.map((e) => [e.dataset.step, e.dataset.state])), [['obsidian', appThere ? 'done' : 'missing'], ['vault', 'missing'], ['memory', 'missing'], ['rules', 'missing']]);
      if (!appThere) assert.equal(await setupCard.getByRole('link', { name: 'Download Obsidian' }).getAttribute('href'), 'https://obsidian.md/download');
      await input.first().click(); await page.keyboard.type('save this', { delay: 5 }); await page.keyboard.press('Enter');
      await until(() => toolResults.length > 0, 'the memory_remember result', 30000);
      assert.match(toolResults[0], /Assistant setup: Obsidian and its vault are not ready, so this chat saves no memory yet/, `refused: ${toolResults[0]}`);
      await pause(3500); // the memory review of the turn (2 s after it)
      assert.deepEqual(await memFiles(join(dshHome, 'storages/dsh-composer-plus/memory')), [], 'no memory file under the dsh home');
      assert.deepEqual(await memFiles(join(home, 'Assistant')), [], 'no memory file in the assistant folder');
      assert.ok(await setupCard.isVisible(), 'the setup card stays after the first message');
      note('0a: no Obsidian: the setup card (4 steps missing, download link); memory_remember refused; no memory file written');
      // Set up: AGENTS.md and the memory folder in ~/Assistant; Obsidian is still missing.
      await setupCard.getByRole('button', { name: 'Set up', exact: true }).click();
      await until(async () => (await setupCard.locator('[data-step="rules"]').getAttribute('data-state')) === 'done', 'rules done');
      assert.equal(await setupCard.locator('[data-step="memory"]').getAttribute('data-state'), 'restart');
      assert.ok(readFileSync(join(home, 'Assistant', 'AGENTS.md'), 'utf8').startsWith('# Vault rules'));
      assert.equal(JSON.parse(readFileSync(join(dshHome, 'storages/dsh-composer-plus/memory-folder.json'), 'utf8')).folder, join(home, 'Assistant', 'Memory'));
      // The user installs Obsidian and opens ~/Assistant as a vault (made up here: its settings file), then restarts dsh.
      const obsidian = process.platform === 'darwin' ? join(home, 'Library/Application Support/obsidian') : join(home, '.config/obsidian');
      await mkdir(obsidian, { recursive: true });
      await writeFile(join(obsidian, 'obsidian.json'), JSON.stringify({ vaults: { abc123: { path: join(home, 'Assistant'), ts: 1, open: true } } }));
      await context.close(); await stop();
      url = await start(); assert.ok(url, 'test server URL after the restart');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      await page.locator('[data-composer-input]').first().waitFor({ timeout: 20000 }); bind();
      const ready = await until(async () => { const r = await api('/api/composer-plus.assistant-setup'); return r.status === 200 && r.body.ready === true && r.body; }, 'setup ready after the restart');
      assert.deepEqual(ready.steps, { obsidian: true, vault: true, memory: 'done', rules: true });
      await assistantRow().click(); await pause(1500);
      assert.equal(await setupCard.count(), 0, 'ready: no setup card');
      note(`0b: Set up wrote AGENTS.md and the memory folder; with Obsidian's vault and a restart the setup is ready (${id0})`);
      // 0c. Memory import from the welcome card of a new assistant chat.
      await context.close(); await stop();
      await writeFile(join(dshHome, 'storages/dsh-composer-plus/assistant.json'), '{}');
      url = await start(); assert.ok(url);
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url); await page.locator('[data-composer-input]').first().waitFor({ timeout: 20000 }); bind();
      await assistantRow().click();
      const importBox = page.locator('[data-composer-plus-memory-import]');
      await importBox.waitFor({ timeout: 20000 });
      const promptText = await importBox.locator('textarea').inputValue();
      assert.match(promptText, /^Import my earlier memory into Obsidian\./); assert.match(promptText, /memory_import_sources/);
      const vaultMemory = join(home, 'Assistant', 'Memory');
      // The first run from the card's Start; a later run is a message in the chat (the card goes with the first message).
      const runImport = async (n) => {
        if (n === 1) await importBox.getByRole('button', { name: 'Start', exact: true }).click();
        else { await input.first().click(); await page.keyboard.type('Run the memory import again (memory_import_sources, then memory_import).', { delay: 2 }); await page.keyboard.press('Enter'); }
        await until(() => importAnswers.length >= n, `import run ${n}`, 60000);
        await pause(3000); // the memory review of the turns
        return JSON.parse(importAnswers[n - 1]);
      };
      const firstRun = await runImport(1);
      assert.equal(firstRun.added, 2, `two facts: ${JSON.stringify(firstRun)}`); assert.equal(firstRun.secret, 1, 'the secret fact is skipped');
      const vaultFiles = await memFiles(vaultMemory);
      const vaultText = (await Promise.all(vaultFiles.map((f) => readFile(f, 'utf8')))).join('\n');
      assert.match(vaultText, /acme-web deploys with make release\./); assert.match(vaultText, /The user wants answers in English\./);
      assert.doesNotMatch(vaultText, /FAKE_TOKEN/, 'the secret is not in the vault');
      assert.deepEqual(await memFiles(join(dshHome, 'storages/dsh-composer-plus/memory')), [], 'no memory file outside the vault');
      const secondRun = await runImport(2);
      assert.equal(secondRun.added, 0, `a second run adds nothing: ${JSON.stringify(secondRun)}`);
      assert.equal((await Promise.all((await memFiles(vaultMemory)).map((f) => readFile(f, 'utf8')))).join('\n'), vaultText, 'the vault did not change');
      assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8').includes('FAKE_TOKEN'), true, 'the source file did not change');
      note(`0c: the import prompt ran twice: ${JSON.stringify(firstRun)}, then ${JSON.stringify(secondRun)}; the facts are in the vault, the secret is not`);
      // The rest of the test starts with a new assistant chat (the old one has a message): Delete chat is not needed,
      // a new assistant.json makes the Host start a new chat.
      await context.close(); await stop();
      await writeFile(join(dshHome, 'storages/dsh-composer-plus/assistant.json'), '{}');
      url = await start(); assert.ok(url);
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      await page.locator('[data-composer-input]').first().waitFor({ timeout: 20000 }); bind();

      // 1. The first click: the card shows above the input of the new assistant chat.
      await assistantRow().waitFor({ timeout: 10000 });
      assert.equal(await card.count(), 0, 'no card before the click');
      await assistantRow().click();
      const id = await until(async () => { const r = await api('/api/composer-plus.assistant'); return r.status === 200 && r.body.sessionId; }, 'assistant chat id');
      await card.waitFor({ timeout: 20000 });
      const words = await card.innerText();
      for (const part of ['Your personal assistant', 'One lasting chat for small tasks', 'Remind me to drink water in 2 minutes', 'Find flights to Rome', 'Which chats wait for me?']) assert.ok(words.includes(part), `card text has "${part}": ${words}`);
      assert.equal(await card.getAttribute('aria-label'), 'Your personal assistant');
      const inChat = await page.locator(`[data-conversation-session="${id}"]`).count();
      const place = await page.evaluate(() => {
        const c = document.querySelector('[data-composer-plus-assistant-welcome]').getBoundingClientRect();
        const inputs = [...document.querySelectorAll('[data-composer-input]')].map((i) => i.getBoundingClientRect()).filter((r) => r.width > 0);
        const i = inputs.find((r) => r.top >= c.bottom - 1) ?? null;
        return { card: [c.top, c.bottom, c.width], input: i && [i.top, i.width], style: getComputedStyle(document.querySelector('[data-composer-plus-assistant-welcome]')).borderRadius };
      });
      assert.ok(place.input !== null && place.card[1] <= place.input[0] + 1, `the card is above the input: ${JSON.stringify(place)}`);
      assert.ok(place.card[2] > 200, `the card has its width: ${JSON.stringify(place)}`);
      if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
      note(`1: the first open of ${id} shows the card above the input (${JSON.stringify(place)}, chat view ${inChat})`);

      // 2. Switch off: the card and its style go. On, and a click: it comes back.
      await settings();
      const sw = page.getByRole('switch', { name: 'Assistant', exact: true });
      await sw.click(); await until(async () => (await sw.getAttribute('aria-checked')) === 'false', 'switch off'); await back();
      assert.equal(await card.count(), 0, 'no card while off');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent.includes('data-composer-plus-assistant-welcome'))), false, 'no style while off');
      await settings(); await sw.click(); await until(async () => (await sw.getAttribute('aria-checked')) === 'true', 'switch on'); await back();
      await assistantRow().click();
      await card.waitFor({ timeout: 20000 });
      note('2: off removes the card and its style; on + click shows it again');

      // 3. The first message hides it; another new chat never has it; the next click opens the chat without it.
      await input.first().click(); await page.keyboard.type('hello', { delay: 5 }); await page.keyboard.press('Enter');
      await card.waitFor({ state: 'detached', timeout: 10000 });
      await page.getByText('ok', { exact: true }).first().waitFor({ timeout: 30000 });
      const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first();
      await proj.hover(); await page.getByRole('button', { name: 'New session in acme-web', exact: true }).click(); await pause(1500);
      assert.equal(await card.count(), 0, 'no card in a new chat of another project');
      await assistantRow().click(); await pause(1500);
      assert.equal((await api('/api/composer-plus.assistant')).body.sessionId, id, 'the same assistant chat');
      assert.equal(await card.count(), 0, 'no card once the chat has a message');
      assert.equal(existsSync(join(home, 'Assistant')), true, '~/Assistant');
      note('3: the first message hides it; not in another new chat; not on the next open');
      // 4. The fixed name: the project of ~/Assistant and the chat header are Damon (the folder keeps its name).
      const project = Object.values(JSON.parse(readFileSync(join(dshHome, 'storages/workspace.json'), 'utf8')).tables?.workspaces ?? {}).find((w) => w.path === join(home, 'Assistant'));
      assert.equal(project?.title, 'Damon', `the project title: ${JSON.stringify(project)}`);
      await until(async () => (await page.locator('[class*="_crumbCurrent"]').filter({ hasText: /^Damon$/ }).count()) > 0, 'the chat header says Damon');
      note('4: the project and the chat header are Damon');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}\n${log.split('\n').filter((l) => /error|warn|assistant/i.test(l)).slice(-30).join('\n')}`);
      await context?.close().catch(() => {});
      await stop();
      if (passed) await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }
} finally { await browser.close(); fake.close(); }
