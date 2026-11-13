// Real-app check: the assistant's chat_send answers a question card that waits in another chat (a fake model, a throwaway
// DSH_HOME and HOME, a made-up project). Headless.
// 1. A chat in acme-web calls ask_user_question and waits (dsh's question card, the orange dot in the sidebar).
// 2. The assistant sends that chat an answer with chat_send (Allow once on its card).
// 3. The card closes: the tool result has the answer (custom text, not an error), the dot goes, and the same turn goes on
//    (no second turn/start) and ends with its reply.
// 4. The hidden news note of that turn's end reaches the assistant with the reply.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-card-answer.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3244.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
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
const ANSWER = 'ANSWER-TEXT: use the item card value';
const QUESTION = { id: 'field', header: 'Field', question: 'Which minimum stock field should the panel read?',
  options: [{ label: 'Item card (Recommended)' }, { label: 'Warehouse row' }] };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const seen = { note: undefined, result: undefined, ids: {} };
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
    if (/\[Composer Plus → Assistant news\]/.test(newest)) { if (/Got the answer/.test(newest)) seen.note = newest; return say('News read.'); }
    if (newest.includes('Answer the stock chat')) return after ? say('Sent.') : call('chat_send', { chat_id: seen.ids.stock, text: ANSWER });
    // The task chat: the card's tool result and the message come in one request (the message joins the next step).
    if (newest.includes('ANSWER-TEXT')) { seen.result = textOf(msgs.findLast((m) => m.role === 'tool')?.content); return say('Got the answer.'); }
    if (newest.includes('STOCK-ASK')) return after ? say('Card answered.') : call('ask_user_question', { questions: [QUESTION] });
    return say('ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.note = undefined; seen.result = undefined; seen.ids = {};
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-card-')));
    const dshHome = join(home, '.dsh'); const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'card-answer-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3244', '--no-open'], { cwd: dir,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    // A chat's log (dsh writes zstd frames; the zstd CLI reads all of them), as events.
    const events = (id) => execFileSync('find', [join(dshHome, 'sessions'), '-path', `*${id}/*`, '-name', 'session.*']).toString().trim().split('\n').filter((f) => /\.jsonl(\.zstd)?$/.test(f))
      .map((f) => (f.endsWith('.zstd') ? execFileSync('zstd', ['-dcq', f]).toString() : readFileSync(f, 'utf8'))).join('\n').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"predict":false,"idleSwitch":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const send = async (text) => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      // 1. The stock chat asks and waits on its card.
      await send('STOCK-ASK please');
      await page.getByText(QUESTION.question, { exact: true }).first().waitFor({ timeout: 30000 });
      const list = await page.evaluate(async () => (await fetch('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: { _request: {} } } }) })).json());
      seen.ids.stock = (list?.result?.value?.items ?? []).find((s) => s.cwd?.endsWith('/projects/acme-web'))?.sessionId;
      assert.ok(seen.ids.stock, 'the stock chat id');
      await until(async () => (await page.locator('[data-state="warning"]').count()) >= 1, 'the orange dot of the waiting chat');
      // 2. The assistant answers it with chat_send; Allow once on its card.
      await page.locator('button[aria-label="Damon"]').click();
      await until(async () => (await page.evaluate(async () => (await fetch('/api/composer-plus.assistant')).json()))?.sessionId, 'the assistant chat');
      await pause(800); await send('Answer the stock chat');
      const allow = page.getByRole('button', { name: 'Allow once', exact: true }).first();
      await allow.waitFor({ timeout: 30000 }); await allow.click();
      await page.getByText('Sent.').first().waitFor({ timeout: 30000 });
      // 3. The card got the message as its answer, and the same turn went on.
      await until(() => seen.result !== undefined, 'the stock chat continues', 30000);
      assert.match(seen.result, /"custom":"ANSWER-TEXT: use the item card value"/, `the card's result is the message: ${seen.result.slice(0, 300)}`);
      assert.doesNotMatch(seen.result, /aborted/, 'not an aborted question');
      await until(async () => (await page.locator('[data-state="warning"]').count()) === 0, 'the orange dot goes');
      // 4. The note of that turn's end.
      await until(() => seen.note, 'the task note with the reply', 120000);
      assert.match(seen.note, /your delegated task\): finished\. Last reply: "Got the answer\."/);
      const log2 = events(seen.ids.stock);
      assert.equal(log2.filter((e) => e.type === 'turn/start').length, 1, 'one turn: the card did not wait for a second turn');
      assert.equal(log2.findLast((e) => e.type === 'turn/end')?.data?.reason?.kind, 'completed');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true; console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed) { await context?.pages().at(-1)?.screenshot({ path: join(home, 'failed.png') }).catch(() => {}); await writeFile(join(home, 'server.log'), log); console.log(`FAIL dsh ${version}; kept: ${home}\n  result: ${seen.result?.slice(0, 500)}\n  note: ${JSON.stringify(seen.note)?.slice(0, 1500)}`); }
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
