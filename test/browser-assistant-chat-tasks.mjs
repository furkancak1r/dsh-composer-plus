// Real-app check: a delegated chat (chat_new) shows as a Running card of the Damon card stack while it works, also after
// its turn ended (2026-11-16: a live deploy chat did not show). A fake model, a throwaway DSH_HOME and HOME, a made-up
// project (acme-web). Never the normal DSH_HOME, no real model. Headless.
// 1. "Start the deploy task" → chat_new (Allow once). The task chat starts a background bash job (sleep) and ends its turn.
//    A Running card "Deploy acme" (Working; a click opens it) shows while the job runs (old code: done at once).
// 2. The job ends: the card goes to "Bugün bitti"/"Done today" (done), without Refresh.
// 3. "Start the approval task" → chat_new; the task chat ends its turn with an onay block: a "For you" card waits for the user.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-chat-tasks.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3243.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const JOB_SECONDS = 25;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { chunk({ role: 'assistant', content: t }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const call = (name, args) => { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
    const all = msgs.map((m) => textOf(m.content)).join('\n');
    if (/session title/i.test(textOf(msgs.at(-1)?.content)) || /You predict the next message|You complete the message that the user is typing|label a coding task/.test(all)) return say('Demo chat');
    const own = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t) => !/^<|^Current runtime context|^Time sampled/.test(t.trim()));
    const newest = own.at(-1) ?? '';
    const after = msgs.at(-1)?.role === 'tool';
    if (/\[Composer Plus → Assistant news\]/.test(newest)) return say('[quiet]');
    if (newest.includes('Start the deploy task')) return after ? say('Started the task.') : call('chat_new', { project: 'acme-web', text: 'TASK-JOB run the deploy', title: 'Deploy acme' });
    if (newest.includes('Start the approval task')) return after ? say('Started the second task.') : call('chat_new', { project: 'acme-web', text: 'TASK-ONAY ask for the deploy line', title: 'Approve acme' });
    if (newest.includes('TASK-JOB')) return after ? say('The deploy runs in the background.') : call('bash', { command: `sleep ${JOB_SECONDS}`, description: 'Run the deploy', run_in_background: true });
    if (newest.includes('TASK-ONAY')) return say('Ready.\n\n```onay\nCANLI DEPLOY PROSOLOCAL 15c101d7 ŞİMDİ\n```');
    return say('ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-chat-tasks-')));
    const dshHome = join(home, '.dsh'); const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'chat-tasks-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid }, tables: { workspaces: { [wid]: { path: dir, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    // Full access: the task chat's bash job runs without an approval card (the throwaway project only).
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3243', '--no-open'], { cwd: dir,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', DSH_PERMISSION_MODE: 'danger-full-access', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"predict":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await page.locator('button[aria-label="Damon"]').click();
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      await until(async () => (await page.evaluate(async () => (await fetch('/api/composer-plus.assistant')).json()))?.sessionId, 'the assistant chat');
      const send = async (text) => { await input.click(); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      const allow = async () => { const b = page.getByRole('button', { name: 'Allow once', exact: true }).first(); await b.waitFor({ timeout: 30000 }); await b.click(); };
      const panel = page.locator('[data-composer-plus-todos]');
      // A task is a card in its group: running → Sürüyor ("Running"), waiting → Senden ("For you"), done → Bugün bitti
      // ("Done today", a group that starts folded: the text is read from the DOM, not from what shows).
      const card = (kind, title) => panel.locator(`li.cp-cs-card[data-card="${kind}"]`).filter({ hasText: title });
      const text = (loc) => loc.evaluate((el) => el.textContent);
      const liveRow = (title) => card('suruyor', title);
      const waitRow = (title) => card('senden', title);
      const historyRow = (title) => card('bitti', title);
      // 1. The delegated chat's turn ends while its background job runs: a working row.
      await send('Start the deploy task'); await allow();
      await page.getByText('Started the task.').first().waitFor({ timeout: 30000 });
      const started = Date.now();
      await until(async () => (await liveRow('Deploy acme').count()) > 0 && /Working/.test(await text(liveRow('Deploy acme'))), 'the delegated chat shows as a Running card, working', 20000);
      assert.equal(await liveRow('Deploy acme').getAttribute('data-opens'), 'true', 'a click on the Running card opens its chat (no Watch button)');
      // Its turn ended (the reply came) and the row still works.
      const sid = await page.evaluate(async () => (await (await fetch(`/api/composer-plus.assistant-todos?sessionId=${encodeURIComponent((await (await fetch('/api/composer-plus.assistant')).json()).sessionId)}`)).json()).tasks.find((t) => t.title === 'Deploy acme')?.id);
      assert.ok(sid, 'the row has the chat id');
      await pause(Math.max(0, 6000 - (Date.now() - started)));
      assert.match(await text(liveRow('Deploy acme')), /Working/, 'still working after its turn ended (the job runs)');
      assert.equal(await historyRow('Deploy acme').count(), 0, 'not a Done today card while the job runs');
      // 2. The job ends: a Done today card, without Refresh.
      await until(async () => (await historyRow('Deploy acme').count()) > 0, 'the card goes to Done today when the job ends', (JOB_SECONDS + 20) * 1000);
      assert.match(await text(historyRow('Deploy acme')), /Done/, 'the Done today card says Done');
      assert.equal(await historyRow('Deploy acme').locator('button[aria-label="Seen: Deploy acme"]').count(), 1, 'the Done today card has Seen (its group is folded: found in the DOM)');
      assert.equal(await liveRow('Deploy acme').count(), 0, 'no Running card after the job');
      // 3. A delegated chat that ends its turn with an onay block waits for the user.
      await send('Start the approval task'); await allow();
      await page.getByText('Started the second task.').first().waitFor({ timeout: 30000 });
      await until(async () => (await waitRow('Approve acme').count()) > 0 && /Waiting/i.test(await text(waitRow('Approve acme'))), 'the onay chat is a For you card, waiting for the user', 30000);
      assert.equal(await liveRow('Approve acme').count(), 0, 'not a Running card');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true; console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed) { await context?.pages().at(-1)?.screenshot({ path: join(home, 'failed.png') }).catch(() => {}); await writeFile(join(home, 'server.log'), log); console.log(`FAIL dsh ${version}; kept: ${home}`); }
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
