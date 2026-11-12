// Real-app performance measure of Composer Plus on each dsh given. A fake model, a throwaway HOME and DSH_HOME, made-up
// projects (demo-0 … demo-9) with made-up chats. Headless. Never the normal DSH_HOME, no real model, no network service.
// What the user feels, with every default feature on:
// - load: dsh start → first chat composer; plugin client parse and setup (the browser's script time at load);
// - chat switch: a click on a chat row → its messages drawn (median of SWITCHES clicks between a long and a short chat);
// - the long chat: the Assistant chat with TURNS synthetic turns: open time, scroll and type work (CPU ×4);
// - idle: the browser's script and style time, DOM node count growth and Host requests in IDLE_S seconds with nothing to do;
// - Host work per model step: the size of the system prompt and the context that the plugin adds (memory, to-do list).
// It prints one JSON line per dsh (`RESULT {...}`) and fails only on page errors: the numbers are for the commit messages.
// PLAYWRIGHT=/path/to/playwright node test/browser-perf.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3231. TURNS=<n> (default 1000), IDLE_S=<s> (default 30), SWITCHES=<n> (default 6).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(50); } };
const TURNS = Number(process.env.TURNS || 1000);
const IDLE_S = Number(process.env.IDLE_S || 30);
const SWITCHES = Number(process.env.SWITCHES || 6);
const PAD = 'x'.repeat(Number(process.env.PAD || 0)); // more bytes per tool result: a log as large as a real one
/** CPU time (ms) that process `pid` used so far (macOS and Linux `ps`). */
const cpuOf = (pid) => { const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString().trim(); const [m, sec] = t.split(':'); return Math.round((Number(m) * 60 + Number(sec)) * 1000); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? null : s[Math.floor(s.length / 2)]; };

// Fake model: each request is kept (its system text and the plugin's context messages), and answers one short line.
const requests = [];
const STREAM_TEXT = `${Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: the demo build ran its **tests** and the \`config\` loader read ${i} files.`).join('\n\n')}

- step one of the demo
- step two of the demo

\`\`\`js
const demo = ${'['}1, 2, 3${']'};
console.log(demo.length);
\`\`\`

> [!RESULT]
> The demo stream finished.

Stream probe done.`;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body);
    const all = parsed.messages.map((m) => textOf(m.content)).join('\n');
    const helper = /session title|You predict the next message|You complete the message|long-term memory|label a coding task|Translate each line/i.test(all);
    // The system prompt: the system messages, or (a chat whose log has none) dsh's in-history `<system-reminder>` copy.
    const system = parsed.messages.filter((m) => m.role === 'system' || m.role === 'developer' || (m.role === 'user' && /^<system-reminder>/.test(textOf(m.content)))).map((m) => textOf(m.content)).at(-1) ?? '';
    if (!helper) requests.push({ system, messages: parsed.messages.map((m) => ({ role: m.role, text: textOf(m.content) })), tools: (parsed.tools ?? []).map((t) => JSON.stringify(t).length) });
    const text = /session title/i.test(all) ? 'Demo' : helper ? '' : `Reply ${requests.length}: the build is green.`;
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // "stream probe": a long Markdown answer in STREAM_CHUNKS pieces, one each 20 ms (a streamed reply).
    if (!helper && /stream probe/.test(textOf(parsed.messages.filter((m) => m.role === 'user').at(-3)?.content) + textOf(parsed.messages.filter((m) => m.role === 'user').at(-2)?.content) + textOf(parsed.messages.filter((m) => m.role === 'user').at(-1)?.content))) {
      const pieces = STREAM_TEXT.match(/[\s\S]{1,24}/g);
      let i = 0;
      const timer = setInterval(() => {
        if (i < pieces.length) { res.write(chunk({ ...(i === 0 ? { role: 'assistant' } : {}), content: pieces[i++] })); return; }
        clearInterval(timer); res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
      }, 20);
      return;
    }
    res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

/** A made-up chat log in the event shapes of a real dsh 0.2.2 log: `turns` turns, each a user message, a tool call with
 * its result and a text reply. `subagents` adds subagent/catalog rows (their logs are not written: a gone child). */
function chatLog(sid, cwd, title, turns, { subagents = 0, ago = 0 } = {}) {
  const t0 = Date.now() - ago * 60000 - (turns + 5) * 60000; let seq = 0;
  const ev = (type, data, extra = {}) => JSON.stringify({ type, seq: seq++, time: t0 + seq * 1000, data, ...extra });
  const lines = [JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: t0, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }),
    ev('session/title', { title, messageSeqs: [], source: { kind: 'user' } })];
  for (let turn = 1; turn <= turns; turn++) {
    const ask = { content: [{ type: 'text', text: `Question ${turn}: please check the demo build and tell me what changed in module ${turn % 37}.` }], source: { kind: 'user', rpcId: randomUUID() }, role: 'user', id: randomUUID() };
    const call = `call_${turn}`;
    lines.push(ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [ask] }), ev('turn/start', { turn }),
      ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      ev('step/start', { turn, step: 1 }), ev('user/message', ask, { surfaceOp: 'append' }),
      ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: call, name: 'read', arguments: '{"file_path":"README.md"}' }], source: { kind: 'model', provider: 'demo', model: 'demo' }, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' }),
      ev('tool/call', { turn, step: 1, callId: call, name: 'read', arguments: '{"file_path":"README.md"}' }));
    lines.push(ev('tool/result', { turn, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: call }, toolCallId: call, content: [{ type: 'text', text: `1: # demo\n2: line ${turn}\n${PAD}` }], isError: false, id: randomUUID() } }, { sourceEventSeqs: [seq - 1], surfaceOp: 'append' }),
      ev('step/end', { turn, step: 1 }), ev('step/start', { turn, step: 2 }),
      ev('assistant/message', { turn, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: `Answer ${turn}: the **demo** build is green. Module ${turn % 37} changed its \`config\` file and two tests.\n\n- one\n- two${turn % 5 === 0 ? '\n\n> [!RESULT]\n> The demo tests pass.' : ''}${turn === turns ? '\n\n```onay\nOnaylıyorum: demo dalını push et.\n```' : ''}` }], source: { kind: 'model', provider: 'demo', model: 'demo' }, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' }),
      ev('step/end', { turn, step: 2 }));
    if (subagents > 0 && turn > turns - subagents) lines.push(ev('subagent/catalog', { version: 1, childId: randomUUID(), childCreatedAt: t0 + seq * 1000, mode: 'continuable', label: `Demo task ${turn}` }));
    lines.push(ev('turn/end', { turn, reason: { kind: 'completed' } }));
  }
  return Buffer.concat([zlib.zstdCompressSync(Buffer.from(`${lines[0]}\n`)), zlib.zstdCompressSync(Buffer.from(`${lines.slice(1).join('\n')}\n`))]);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    requests.length = 0;
    const version = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(bin, '../../package.json'), 'utf8'))).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-perf-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'perf-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...(process.env.NOPLUGIN ? [] : ['dsh-composer-plus'])] } } }));
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
          - { id: demo, name: Demo model, contextWindow: 1000000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    // 10 made-up projects with 30 short chats each, the Assistant folder with one long chat, and made-up memory notes.
    const store = join(dshHome, 'storages', 'dsh-composer-plus');
    const memDir = join(store, 'memory');
    const tables = {}; const wids = []; const now = new Date().toISOString();
    const sessionDir = (folder, sid) => join(dshHome, 'sessions', `-${folder.replace(/[^A-Za-z0-9_]/g, '-')}--`, sid);
    let short; let first;
    for (let p = 0; p < 10; p++) {
      const folder = join(home, 'projects', `demo-${p}`); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'README.md'), `# demo-${p}\n`);
      first ??= folder;
      const id = createHash('sha256').update(await realpath(folder)).digest('hex').slice(0, 32);
      await mkdir(join(memDir, 'projects', id), { recursive: true });
      await writeFile(join(memDir, 'projects', id, 'MEMORY.md'), `# Memory\n\n${Array.from({ length: 40 }, (_, i) => `- Demo note ${i} of project ${p}: the build uses make release and the tests run with npm test. [source: demo; added: 2026-10-29]`).join('\n')}\n\n## Index\n- [[deploy]]\n`);
      await writeFile(join(memDir, 'projects', id, 'deploy.md'), '# deploy\n\n- Staging first. [added: 2026-10-29]\n');
      await writeFile(join(memDir, 'projects', id, 'project.json'), JSON.stringify({ path: folder }));
      const chats = [];
      for (let c = 0; c < 30; c++) {
        const sid = `session-${randomUUID()}`; chats.push(sid);
        await mkdir(sessionDir(folder, sid), { recursive: true });
        await writeFile(join(sessionDir(folder, sid), 'session.v4.jsonl.zstd'), chatLog(sid, folder, `Demo chat ${p}.${c}`, c === 0 ? 3 : 1, { ago: c === 0 ? 0 : 30 + p * 30 + c }));
        if (p === 0 && c === 0) short = sid;
      }
      const wid = randomUUID(); wids.push(wid);
      tables[wid] = { path: folder, title: `demo-${p}`, sessionIds: chats, createdAt: now, updatedAt: now };
    }
    await mkdir(join(memDir, 'global'), { recursive: true });
    await writeFile(join(memDir, 'global', 'MEMORY.md'), `# Memory\n\n${Array.from({ length: 30 }, (_, i) => `- Global demo note ${i}: the user wants short answers in plain words. [added: 2026-10-30]`).join('\n')}\n\n## Index\n`);
    await writeFile(join(store, 'memory.json'), JSON.stringify({ on: true }));
    await writeFile(join(store, 'default-workspace.json'), JSON.stringify({ on: false }));
    // The Assistant chat: TURNS turns and 40 subagent rows; its folder is ~/Assistant.
    const assistantDir = join(home, 'Assistant'); await mkdir(assistantDir, { recursive: true });
    const long = `session-${randomUUID()}`;
    await mkdir(sessionDir(assistantDir, long), { recursive: true });
    await writeFile(join(sessionDir(assistantDir, long), 'session.v4.jsonl.zstd'), chatLog(long, assistantDir, 'Damon', TURNS, { subagents: 40 }));
    await writeFile(join(store, 'assistant.json'), JSON.stringify({ sessionId: long }));
    await writeFile(join(store, 'assistant-todos.json'), JSON.stringify({ lists: { [long]: Array.from({ length: 12 }, (_, i) => ({ id: `0000000${i.toString(16)}`.slice(-8), text: `Demo to-do item ${i}: check the staging deploy`, owner: i % 2 ? 'agent' : 'user', created: Date.now() })) } }));
    const awid = randomUUID(); wids.push(awid);
    tables[awid] = { path: assistantDir, title: 'Damon', sessionIds: [long], createdAt: now, updatedAt: now };
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: wids, archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wids[0] }, tables: { workspaces: tables } }));

    const port = process.env.PORT || '3231';
    const started = Date.now();
    const child = spawn(process.execPath, [...(process.env.HOSTPROF ? ['--cpu-prof', `--cpu-prof-dir=${process.env.HOSTPROF}`] : []), bin, '--profile', 'web', '--port', port, '--no-open'], { cwd: first,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false; const result = { dsh: version, turns: TURNS, plugin: !process.env.NOPLUGIN, ...(process.env.OFF ? { off: process.env.OFF } : {}) };
    try {
      for (let i = 0; i < 400 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(100); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      result.hostReadyMs = Date.now() - started;
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      await context.addInitScript((json) => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', json); }, JSON.stringify({ autoUpdate: false, ...Object.fromEntries((process.env.OFF ?? '').split(',').filter(Boolean).map((id) => [id, false])) }));
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const hostCalls = []; page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) hostCalls.push({ at: Date.now(), path: u.pathname }); });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      if (process.env.BPROF) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
      const t0 = Date.now();
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await page.locator('[data-composer-input]').waitFor({ timeout: 30000 });
      result.firstComposerMs = Date.now() - t0;
      if (!process.env.NOPLUGIN) { await page.locator('button[aria-label="Damon"]').waitFor({ timeout: 30000 }); result.pluginRowMs = Date.now() - t0; }
      await pause(3000);
      if (process.env.BPROF) await writeFile(join(process.env.BPROF, 'load.cpuprofile'), JSON.stringify((await cdp.send('Profiler.stop')).profile));
      result.loadHostCalls = hostCalls.filter((c) => c.path.startsWith('/api/composer-plus.')).length;
      if (process.env.PATHS) { const n = {}; for (const c of hostCalls) if (c.path.startsWith('/api/composer-plus.')) n[c.path.slice(19)] = (n[c.path.slice(19)] ?? 0) + 1; console.log('LOAD PATHS', JSON.stringify(Object.fromEntries(Object.entries(n).filter(([, v]) => v > 1)))); }
      const load = await metrics();
      result.loadScriptMs = Math.round(load.ScriptDuration * 1000); result.loadTaskMs = Math.round(load.TaskDuration * 1000);
      result.loadHeapMB = +(load.JSHeapUsedSize / 1e6).toFixed(1);

      // Chat switch: the short chat ↔ the long Assistant chat (the Assistant row opens it).
      const shortRow = page.locator(`[data-row-key="session:${short}"]`).first();
      const showShort = async () => {
        if (await shortRow.isVisible()) return;
        const project = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'demo-0' }).first();
        if (await project.getAttribute('aria-expanded') !== 'true') await project.click();
        await shortRow.waitFor({ timeout: 10000 });
      };
      const openShort = async () => { await showShort(); const t = Date.now(); await shortRow.click(); await page.getByText('Answer 3: the').first().waitFor({ timeout: 30000 }); return Date.now() - t; };
      const longRow = process.env.NOPLUGIN ? page.locator(`[data-row-key="session:${long}"]`).first() : page.locator('button[aria-label="Damon"]');
      const openLong = async () => {
        if (process.env.NOPLUGIN && !(await longRow.isVisible())) { const p = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'Damon' }).first(); if (await p.getAttribute('aria-expanded') !== 'true') await p.click(); await longRow.waitFor({ timeout: 10000 }); }
        const t = Date.now(); await longRow.click(); await page.getByText(`Answer ${TURNS}: the`).first().waitFor({ timeout: 60000 }); return Date.now() - t; };
      await page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'demo-0' }).first().waitFor();
      const toShort = []; const toLong = [];
      // A chat that dsh has not loaded yet (no live agent): the time of the Host routes that the client calls when it opens.
      const timed = async (path) => page.evaluate(async (u) => { const t = performance.now(); const r = await fetch(u); await r.text(); return Math.round(performance.now() - t); }, path);
      result.coldSideChatMs = await timed(`/api/composer-plus.side-chat?sessionId=${long}`);
      result.coldMemoryChatMs = await timed(`/api/composer-plus.memory-chat?sessionId=${long}`);
      result.firstLongOpenMs = await openLong();
      // The status panel's read (the client asks it every 5 s while the Assistant runs): from the cache, and with the chat
      // list read again (a root chat's turn start or end makes the next read do that).
      if (!process.env.NOPLUGIN) {
        const statusMs = async (q) => { const xs = []; for (let i = 0; i < 5; i++) xs.push(await timed(`/api/composer-plus.assistant-todos?sessionId=${long}&lang=en${q}`)); return median(xs); };
        result.statusCachedMs = await statusMs(''); result.statusRelistMs = await statusMs('&refresh=1');
      }
      if (process.env.BPROF) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
      const switchCalls = []; const switchCpu = [];
      for (let i = 0; i < SWITCHES; i++) {
        let c = hostCalls.length; let c0 = cpuOf(child.pid); toShort.push(await openShort()); await pause(600); switchCalls.push(hostCalls.slice(c).filter((x) => x.path.startsWith('/api/composer-plus.')).length); switchCpu.push(cpuOf(child.pid) - c0);
        c = hostCalls.length; c0 = cpuOf(child.pid); toLong.push(await openLong()); await pause(600); switchCalls.push(hostCalls.slice(c).filter((x) => x.path.startsWith('/api/composer-plus.')).length); switchCpu.push(cpuOf(child.pid) - c0);
      }
      result.hostSwitchCpuMs = median(switchCpu);
      result.switchHostCalls = median(switchCalls);
      if (process.env.BPROF) await writeFile(join(process.env.BPROF, 'switch.cpuprofile'), JSON.stringify((await cdp.send('Profiler.stop')).profile));
      if (process.env.PATHS) { const c = hostCalls.length; await openShort(); await pause(600); console.log('SWITCH PATHS', JSON.stringify(hostCalls.slice(c).map((x) => `${x.at - hostCalls[c].at}ms ${x.path.replace('/api/composer-plus.', '')}`))); }
      result.switchToShortMs = median(toShort); result.switchToLongMs = median(toLong);

      // The long chat: scroll and type at CPU ×4 (a slower Mac).
      await pause(1500);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      let before = await metrics();
      const scroller = await page.evaluateHandle(() => [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? document.scrollingElement);
      for (let i = 0; i < 20; i++) { await scroller.evaluate((el) => { el.scrollTop -= 600; }); await pause(60); }
      let after = await metrics();
      result.scrollScriptMs = Math.round((after.ScriptDuration - before.ScriptDuration) * 1000); result.scrollStyleMs = Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000);
      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await pause(500);
      const text = 'Please check the staging deploy of demo';
      await page.locator('[data-composer-input]').click();
      if (process.env.BPROF) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
      before = await metrics();
      await page.keyboard.type(text, { delay: 30 });
      await pause(800);
      after = await metrics();
      if (process.env.BPROF) await writeFile(join(process.env.BPROF, 'type.cpuprofile'), JSON.stringify((await cdp.send('Profiler.stop')).profile));
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const per = (key) => +(((after[key] - before[key]) * 1000) / text.length).toFixed(2);
      result.typeScriptMsPerKey = per('ScriptDuration'); result.typeStyleMsPerKey = per('RecalcStyleDuration'); result.typeTaskMsPerKey = per('TaskDuration');
      await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');

      // Idle: nothing to do for IDLE_S seconds in the long chat.
      await pause(2000);
      const callsBefore = hostCalls.length;
      before = await metrics();
      const hostBefore = cpuOf(child.pid);
      if (process.env.SAMPLE) execFileSync('sample', [String(child.pid), String(Math.min(IDLE_S, 20)), '-mayDie', '-file', process.env.SAMPLE]);
      await pause(Math.max(0, IDLE_S - (process.env.SAMPLE ? Math.min(IDLE_S, 20) + 1 : 0)) * 1000);
      after = await metrics();
      const idle = hostCalls.slice(callsBefore);
      result.hostIdleCpuMs = cpuOf(child.pid) - hostBefore;
      if (process.env.IDLE_SERIES) { result.hostIdleSeries = []; for (let i = 0; i < Number(process.env.IDLE_SERIES); i++) { const c0 = cpuOf(child.pid); await pause(30000); result.hostIdleSeries.push(cpuOf(child.pid) - c0); } }
      result.idleScriptMs = Math.round((after.ScriptDuration - before.ScriptDuration) * 1000);
      result.idleStyleMs = Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000);
      result.idleLayoutMs = Math.round((after.LayoutDuration - before.LayoutDuration) * 1000);
      result.idleTaskMs = Math.round((after.TaskDuration - before.TaskDuration) * 1000);
      result.idleNodesDelta = after.Nodes - before.Nodes;
      result.idleHostCalls = idle.length;
      result.idleHostPaths = Object.fromEntries(Object.entries(idle.reduce((m, c) => ({ ...m, [c.path]: (m[c.path] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 6));

      // A streamed reply in the long chat (CPU ×4): the browser's work while it streams.
      await page.locator('[data-composer-input]').click();
      await page.keyboard.type('stream probe please');
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      if (process.env.BPROF) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
      before = await metrics();
      await page.keyboard.press('Enter');
      await page.getByText('Stream probe done.').first().waitFor({ timeout: 60000 });
      await pause(500);
      after = await metrics();
      if (process.env.BPROF) await writeFile(join(process.env.BPROF, 'stream.cpuprofile'), JSON.stringify((await cdp.send('Profiler.stop')).profile));
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      result.streamScriptMs = Math.round((after.ScriptDuration - before.ScriptDuration) * 1000);
      result.streamStyleMs = Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000);
      result.streamLayoutMs = Math.round((after.LayoutDuration - before.LayoutDuration) * 1000);
      result.streamTaskMs = Math.round((after.TaskDuration - before.TaskDuration) * 1000);
      await pause(1500);

      // Turns in the long Assistant chat: the time from Enter to the reply on the page, the Host's CPU per turn, and what
      // the plugin adds to the model request.
      const turnMs = []; const turnCpu = []; const turnCalls = [];
      for (let i = 0; i < 5; i++) {
        const n = requests.length;
        await page.locator('[data-composer-input]').click();
        await page.keyboard.type(`perf probe ${i}`);
        const c0 = cpuOf(child.pid); const t = Date.now(); const k = hostCalls.length;
        await page.keyboard.press('Enter');
        await until(() => requests.length > n, 'the model request', 30000);
        await page.getByText(`Reply ${n + 1}: the build`).first().waitFor({ timeout: 30000 });
        turnMs.push(Date.now() - t);
        await pause(2500); // the turn's end work (memory review delay, news, status) runs in this time
        turnCpu.push(cpuOf(child.pid) - c0);
        turnCalls.push(hostCalls.slice(k).filter((x) => x.path.startsWith('/api/composer-plus.')).map((x) => x.path.slice(19)));
      }
      result.turnHostCalls = median(turnCalls.map((c) => c.length));
      if (process.env.PATHS) console.log('TURN PATHS', JSON.stringify(turnCalls.at(-1)));
      result.turnMs = median(turnMs); result.hostTurnCpuMs = median(turnCpu);
      const r = requests.at(-1);
      if (process.env.DUMP) await writeFile(process.env.DUMP, JSON.stringify(r, null, 1));
      const sections = [...r.system.matchAll(/^# (.+)$/gm)].map((m) => m[1]);
      const sizeOf = (title) => { const at = r.system.indexOf(`# ${title}`); if (at < 0) return 0; const next = r.system.slice(at + 2).search(/\n# /); return next < 0 ? r.system.length - at : next + 2; };
      result.systemChars = r.system.length;
      result.pluginSections = Object.fromEntries(sections.filter((s) => /Composer Plus/.test(s)).map((s) => [s, sizeOf(s)]));
      result.todoContextChars = r.messages.filter((m) => m.role === 'user' && /Assistant to-do list \(Composer Plus\)/.test(m.text)).map((m) => m.text.length).at(-1) ?? 0;
      result.toolsJsonChars = r.tools.reduce((a, b) => a + b, 0); result.toolCount = r.tools.length;
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`RESULT ${JSON.stringify(result)}`);
      console.log(`PASS ${bin}`);
    } catch (error) {
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; partial: ${JSON.stringify(result)}`);
      throw error;
    } finally {
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
