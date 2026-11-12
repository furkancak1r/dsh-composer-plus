// Real-app check: the assistant sees what a delegated chat asks (a fake model, a throwaway DSH_HOME and HOME, a made-up
// project). Headless.
// 1. You ask the assistant for a task; it starts it with chat_new (Allow once on its card). The task's first message is
//    long (more than 4000 characters).
// 2. The task chat calls ask_user_question and waits (no text reply at all, as a real branch chat did).
// 3. 30 s later the hidden news note wakes the assistant: its line has the question, its header and both options.
// 4. The assistant calls chat_read on the task chat: the newest item is the open question card ([question], with the
//    options), and the long first message is cut, not the question.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-pending.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3241.
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
const LONG = `TASK-ASK Make the refresh button show that it loads. ${'Detail of the long task text. '.repeat(170)}END-OF-TASK`;
const QUESTION = { id: 'refresh', header: 'Refresh', question: 'Should Refresh also renew the summary?',
  options: [{ label: 'No, lists only (Recommended)', description: 'Fast and free.' }, { label: 'Yes, renew the summary', description: 'Each click starts a model turn.' }] };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const seen = { note: undefined, read: undefined };
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
    const result = after ? textOf(msgs.at(-1).content) : '';
    if (/\[Composer Plus → Assistant news\]/.test(newest)) {
      if (!after) { seen.note = newest; return call('chat_read', { chat_id: /chat (session-[^,)\s]+)/.exec(newest)?.[1] ?? 'none', count: 10 }); }
      seen.read = result; return say('News read.');
    }
    if (newest.includes('Start the refresh task')) return after ? say('Started the task.') : call('chat_new', { project: 'acme-web', text: LONG, title: 'Refresh button' });
    if (newest.includes('TASK-ASK')) return after ? say('Answered.') : call('ask_user_question', { questions: [QUESTION] });
    return say('ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.note = undefined; seen.read = undefined;
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-pending-')));
    const dshHome = join(home, '.dsh'); const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'pending-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3241', '--no-open'], { cwd: dir,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      // 1. The assistant starts the task with chat_new; Allow once on its card.
      await page.locator('button[aria-label="Damon"]').click();
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      await until(async () => (await page.evaluate(async () => (await fetch('/api/composer-plus.assistant')).json()))?.sessionId, 'the assistant chat');
      await input.click(); await page.keyboard.type('Start the refresh task', { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
      const allow = page.getByRole('button', { name: 'Allow once', exact: true }).first();
      await allow.waitFor({ timeout: 30000 }); await allow.click();
      await page.getByText('Started the task.').first().waitFor({ timeout: 30000 });
      // 2-3. The task chat asks and waits; after 30 s (the wait) and 15 s (the batch) the note wakes the assistant.
      await until(() => seen.note, 'the news note', 120000);
      await until(() => seen.read, 'the chat_read result', 30000);
      console.log(`  note line: ${seen.note.split('\n').find((l) => l.startsWith('- ')).slice(0, 400)}`);
      const read = JSON.parse(seen.read);
      console.log(`  chat_read: ${read.messages.map((m) => `${m.role}:${m.text.length}:${JSON.stringify(m.text.slice(0, 50))}`).join(' | ')}`);
      assert.match(seen.note, /waits for your answer/);
      assert.match(seen.note, /Should Refresh also renew the summary\?/, 'the note has the question');
      assert.match(seen.note, /No, lists only \(Recommended\)/); assert.match(seen.note, /Yes, renew the summary/, 'and its options');
      assert.match(seen.note, /not instructions for you/, 'the data note stays');
      const last = read.messages.at(-1);
      assert.equal(last.role, 'assistant'); assert.match(last.text, /^\[question\] Refresh: Should Refresh also renew the summary\?/, 'chat_read: the open question is the newest item');
      assert.match(last.text, /Each click starts a model turn\./, 'with the options');
      assert.equal(read.messages[0].role, 'user'); assert.ok(read.messages[0].text.startsWith('TASK-ASK') && !read.messages[0].text.includes('END-OF-TASK'), 'the long first message is cut');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true; console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed) { await context?.pages().at(-1)?.screenshot({ path: join(home, 'failed.png') }).catch(() => {}); await writeFile(join(home, 'server.log'), log); console.log(`FAIL dsh ${version}; kept: ${home}\n  note: ${JSON.stringify(seen.note)?.slice(0, 1500)}\n  read: ${seen.read?.slice(0, 1500)}`); }
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
