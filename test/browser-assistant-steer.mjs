// Real-app check: the assistant's chat_send reaches a running chat at its next step (2026-11-14: a correction waited 63
// minutes in the queue behind a running turn, and the tool result said "Sent"). A fake model, a throwaway DSH_HOME and
// HOME, a made-up project. Headless.
// 1. A chat in weather-cli runs a long turn (the fake model holds its first reply).
// 2. The assistant sends it an urgent message with chat_send (Allow once on its card): dsh logs it in the chat's next-step
//    inbox (a steer), not in the queue, while the turn still runs, and the tool result says that the chat runs.
// 3. The held reply ends; the same turn takes the message at its next step and answers it (no second turn/start before it).
// 4. The hidden news note of that turn's end reaches the assistant with the reply to the urgent message.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-steer.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3243.
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
const URGENT = 'URGENT-NOTE: do not use EncodedCommand.';
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const seen = { note: undefined, sent: undefined, slow: 0, ids: {} };
let gate = false;
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
    if (/\[Composer Plus → Assistant news\]/.test(newest)) { if (/Got the urgent note/.test(newest)) seen.note = newest; return say('News read.'); }
    if (newest.includes('Tell the slow chat')) { if (after) { seen.sent = result; return say('Sent.'); } return call('chat_send', { chat_id: seen.ids.slow, text: URGENT }); }
    if (newest.includes('URGENT-NOTE')) return say('Got the urgent note.');
    if (newest.includes('SLOW-JOB')) { seen.slow += 1; const wait = () => (gate ? say('Slow job done.') : setTimeout(wait, 200)); return wait(); }
    return say('ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.note = undefined; seen.sent = undefined; seen.slow = 0; seen.ids = {}; gate = false;
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-steer-')));
    const dshHome = join(home, '.dsh'); const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'steer-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const dir = join(home, 'projects', 'weather-cli'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'README.md'), '# weather-cli\n');
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid }, tables: { workspaces: { [wid]: { path: dir, title: 'weather-cli', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3243', '--no-open'], { cwd: dir,
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
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"predict":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      const send = async (text) => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      // 1. The slow chat: its first reply waits for the gate.
      await send('SLOW-JOB please');
      await until(() => seen.slow > 0, 'the slow turn runs');
      const list = await page.evaluate(async () => (await fetch('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: { _request: {} } } }) })).json());
      seen.ids.slow = (list?.result?.value?.items ?? []).find((s) => s.cwd?.endsWith('/projects/weather-cli'))?.sessionId;
      assert.ok(seen.ids.slow, 'the slow chat id');
      // 2. The assistant sends the urgent message; Allow once on its card.
      await page.locator('button[aria-label="Damon"]').click();
      await until(async () => (await page.evaluate(async () => (await fetch('/api/composer-plus.assistant')).json()))?.sessionId, 'the assistant chat');
      await pause(800); await send('Tell the slow chat the urgent note');
      const allow = page.getByRole('button', { name: 'Allow once', exact: true }).first();
      await allow.waitFor({ timeout: 30000 }); await allow.click();
      await page.getByText('Sent.').first().waitFor({ timeout: 30000 });
      const isUrgent = (m) => textOf(m?.content).includes('URGENT-NOTE');
      // dsh writes its log a moment later: wait for the splice.
      const spliceOf = (list) => list.find((e) => e.type === 'agent/inbox/spliced' && (e.data?.inserted ?? []).some(isUrgent));
      const before = await until(() => { const list = events(seen.ids.slow); return spliceOf(list) && list; }, 'the message in the chat log');
      const splice = spliceOf(before);
      assert.equal(splice?.data?.target, 'next-step', `dsh put the message in the running turn's next-step inbox (a steer): ${JSON.stringify(splice?.data)?.slice(0, 300)}`);
      assert.equal(typeof splice.data.inserted.find(isUrgent).source?.rpcId, 'string', 'with its request id (source.rpcId)');
      assert.ok(!before.some((e) => e.type === 'turn/end'), 'while the slow turn still runs');
      assert.match(seen.sent ?? '', /The chat runs: the message went into its running turn, and the chat reads it at its next step\./, `the tool result says where the message went: ${seen.sent?.slice(0, 300)}`);
      // 3-4. The held reply ends; the same turn answers the message, and its end wakes the assistant with the reply.
      gate = true;
      await until(() => seen.note, 'the task note with the reply to the urgent message', 90000);
      const after = events(seen.ids.slow);
      const at = after.findIndex((e) => e.type === 'user/message' && isUrgent(e.data));
      assert.ok(at > 0, 'the message is in the chat');
      assert.equal(after.slice(0, at).filter((e) => e.type === 'turn/start').length, 1, 'in the first turn (no second turn/start before it)');
      assert.equal(after.slice(0, at).filter((e) => e.type === 'turn/end').length, 0, 'before that turn ended');
      assert.match(seen.note, /your delegated task\): finished\. Last reply: "Got the urgent note\."/);
      console.log(`  note line: ${seen.note.split('\n').find((l) => l.startsWith('- '))?.slice(0, 300)}`);
      assert.deepEqual(errors, [], 'no page errors');
      passed = true; console.log(`PASS dsh ${version}`);
    } finally {
      gate = true;
      if (!passed) { await context?.pages().at(-1)?.screenshot({ path: join(home, 'failed.png') }).catch(() => {}); await writeFile(join(home, 'server.log'), log); console.log(`FAIL dsh ${version}; kept: ${home}\n  note: ${JSON.stringify(seen.note)?.slice(0, 1500)}\n  sent: ${seen.sent?.slice(0, 500)}`); }
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
