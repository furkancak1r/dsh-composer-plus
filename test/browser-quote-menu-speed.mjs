// Real-app speed check of Quote in reply's right-click menu: the time from a right-click on selected answer text (the
// `contextmenu` input) to the painted frame with the Copy, Quote menu, in a short chat and in a long Assistant chat (TURNS
// turns, default 2000: about 24,000 log events, answers of about 800 characters) with a full sidebar (46 projects).
// A fake model, a throwaway HOME and DSH_HOME, made-up chats. Headless, with Chromium's sandbox. Never the normal
// DSH_HOME, no real model.
// Before the right-clicks, a reader scrolls up 300 px. In dsh 0.2.2-rc.2 the Assistant's 8-turn view hid dsh's history
// edge, so dsh loaded every older page behind it (100,000 hidden elements) and each right-click waited 100-300 ms.
// It fails when a chat's median time is more than LIMIT ms (default 50), the menu is not Copy, Quote, or the scroll or the
// right-clicks draw more than 500 elements.
// Each run prints: delay (the input waits for the page), handlers (all contextmenu listeners and React's render of the
// menu), dom (input → menu in the page), visible (input → the next paint after it: Event Timing, else two frames).
// PLAYWRIGHT=/path/to/playwright node test/browser-quote-menu-speed.mjs /path/to/dsh/lib/bin.js [...]
// DSH_NODE=<node or Electron binary> runs dsh with it (ELECTRON_RUN_AS_NODE=1 for the DeepSeek Harness app's own dsh).
// PLUGIN=<folder> measures another Composer Plus checkout. RUNS=<n> right-clicks per chat (default 7).
// OFF=<id,id> switches Composer Plus features off. PROJECTS=<n> (default 45). PORT=<port> (default 3291).
// KEEP=1 keeps the throwaway home.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const plugin = resolve(process.env.PLUGIN || fileURLToPath(new URL('..', import.meta.url)));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(50); } };
const median = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length === 0 ? null : s[Math.floor(s.length / 2)]; };
const TURNS = Number(process.env.TURNS || 2000);
const RUNS = Number(process.env.RUNS || 7);
const LIMIT = Number(process.env.LIMIT || 50);
const PART = 'build is green';

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body);
    const text = /session title/i.test(parsed.messages.map((m) => textOf(m.content)).join('\n')) ? 'Demo' : '';
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));

/** A made-up answer of about 800 characters, as an assistant writes them: paragraphs, a list, a link, and in some turns a
 * code block, a `[!RESULT]` or `[!DETAILS]` callout or an `onay` block (the last turn has each of them). */
function answerText(turn, turns) {
  const last = turn === turns;
  return [`Answer ${turn}: the **demo** build is green. Module ${turn % 37} changed its \`config\` file and two tests; the [release notes](https://example.com/notes/${turn}) list the change.`,
    `The loader now reads ${turn % 11} files at start, and the cache keeps them for ten minutes. Nothing else in the demo changed, and the staging deploy can go on as planned.`,
    '- the unit tests pass\n- the browser check passes\n- the lint step reports no new warnings',
    ...(last || turn % 3 === 0 ? [`\`\`\`js\nexport function load(files) {\n  const out = new Map();\n  for (const f of files) out.set(f.name, f.size);\n  return out; // ${turn}\n}\n\`\`\``] : []),
    ...(last || turn % 5 === 0 ? ['> [!RESULT]\n> The demo tests pass on both machines.'] : []),
    ...(last || turn % 7 === 0 ? ['> [!DETAILS] Test output\n> 42 tests, 0 failures, 3.1 s.'] : []),
    ...(last || turn % 10 === 0 ? ['```onay\nOnaylıyorum: demo dalını push et.\n```'] : []),
  ].join('\n\n');
}
/** A made-up chat log in dsh's v4 event shapes: `turns` turns of a question, a tool call with its result and an answer
 * (answerText), about 12 events per turn. */
function chatLog(sid, cwd, title, turns) {
  const t0 = Date.now() - (turns + 5) * 60000; let seq = 0;
  const ev = (type, data, extra = {}) => JSON.stringify({ type, seq: seq++, time: t0 + seq * 1000, data, ...extra });
  const model = { kind: 'model', provider: 'demo', model: 'demo' };
  const lines = [JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: t0, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }),
    ev('session/title', { title, messageSeqs: [], source: { kind: 'user' } })];
  for (let turn = 1; turn <= turns; turn++) {
    const ask = { content: [{ type: 'text', text: `Question ${turn}: please check the demo build of module ${turn % 37}.` }], source: { kind: 'user', rpcId: randomUUID() }, role: 'user', id: randomUUID() };
    const call = `call_${turn}`;
    lines.push(ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [ask] }), ev('turn/start', { turn }),
      ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      ev('step/start', { turn, step: 1 }), ev('user/message', ask, { surfaceOp: 'append' }),
      ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: call, name: 'read', arguments: '{"file_path":"README.md"}' }], source: model, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' }),
      ev('tool/call', { turn, step: 1, callId: call, name: 'read', arguments: '{"file_path":"README.md"}' }));
    lines.push(ev('tool/result', { turn, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: call }, toolCallId: call, content: [{ type: 'text', text: `1: # demo\n2: line ${turn}` }], isError: false, id: randomUUID() } }, { sourceEventSeqs: [seq - 1], surfaceOp: 'append' }),
      ev('step/end', { turn, step: 1 }), ev('step/start', { turn, step: 2 }),
      ev('assistant/message', { turn, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: answerText(turn, turns) }], source: model, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' }),
      ev('step/end', { turn, step: 2 }), ev('turn/end', { turn, reason: { kind: 'completed' } }));
  }
  return Buffer.concat([zlib.zstdCompressSync(Buffer.from(`${lines[0]}\n`)), zlib.zstdCompressSync(Buffer.from(`${lines.slice(1).join('\n')}\n`))]);
}

/** In the page: each right-click's times (performance.now() ms). */
const PROBE = () => {
  if (window.cpSpeed !== undefined) return;
  const s = window.cpSpeed = { runs: [], cur: null };
  addEventListener('contextmenu', (e) => { s.cur = { input: e.timeStamp, start: performance.now() }; s.runs.push(s.cur); }, true);
  addEventListener('contextmenu', () => { if (s.cur !== null) s.cur.end = performance.now(); });
  new MutationObserver(() => {
    const c = s.cur;
    if (c === null || c.dom !== undefined || document.querySelector('[role="menu"]') === null) return;
    c.dom = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => { c.painted = performance.now(); }));
  }).observe(document.body, { childList: true, subtree: true });
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { const c = s.runs.find((r) => e.name === 'contextmenu' && Math.abs(r.input - e.startTime) < 2); if (c !== undefined) c.event = e.duration; } })
      .observe({ type: 'event', durationThreshold: 16 });
  } catch { /* no Event Timing: two frames */ }
};
/** Select PART in the newest answer on screen; returns its middle in the viewport. When no answer on screen has it, the
 * newest shown one is scrolled into view once. */
async function selectPart(page, scrolled = false) {
  const at = await page.evaluate((part) => {
    // The open chat's composer (dsh keeps the composer of a chat opened before, at height 0).
    const composer = Math.min(innerHeight, ...[...document.querySelectorAll('[data-composer-input]')].map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top));
    for (const root of [...document.querySelectorAll('[data-conversation-session] [data-chat-flow-kind="assistant-step"]')].reverse()) {
      if (!root.textContent.includes(part) || root.getClientRects().length === 0) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const i = n.data.indexOf(part); if (i < 0) continue;
        const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + part.length);
        const r = range.getBoundingClientRect();
        if (r.height === 0 || r.top < 60 || r.bottom > composer - 60) continue;
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  }, PART);
  if (at !== null || scrolled) return at;
  await page.evaluate((part) => {
    const root = [...document.querySelectorAll('[data-conversation-session] [data-chat-flow-kind="assistant-step"]')].reverse().find((el) => el.getClientRects().length > 0 && el.textContent.includes(part));
    root?.scrollIntoView({ block: 'center' });
  }, PART);
  await pause(1500);
  return selectPart(page, true);
}
/** The open chat's elements and its scroll box: `{ elements, top, end }`. */
const chatState = (page) => page.evaluate(() => {
  const flow = [...document.querySelectorAll('[data-conversation-session] [data-chat-flow]')].find((el) => el.getClientRects().length > 0);
  const scroller = flow?.closest('[data-conversation-scroll]') ?? flow?.parentElement;
  return { elements: document.getElementsByTagName('*').length, top: Math.round(scroller?.scrollTop ?? 0), end: Math.round((scroller?.scrollHeight ?? 0) - (scroller?.clientHeight ?? 0)) };
});

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
const failures = [];
try {
  for (const bin of process.argv.slice(2)) {
    const version = await readFile(join(bin, '../../package.json'), 'utf8').then((s) => JSON.parse(s).version, () => (bin.includes('app.asar') ? 'app' : bin));
    console.log(`dsh ${version}, Composer Plus ${plugin}, ${TURNS} turns`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-quote-speed-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(plugin, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'quote-speed-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
        baseURL: http://127.0.0.1:${fake.address().port}/v1
        apiKeyEnv: DEMO_KEY
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
          - { id: demo, name: Demo model, contextWindow: 1000000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
    // acme-web with a short chat, the Assistant folder with the long Assistant chat, and a full sidebar: PROJECTS more
    // made-up projects (default 45) with 7 one-turn chats each.
    const sessionDir = (folder, sid) => join(dshHome, 'sessions', `-${folder.replace(/[^A-Za-z0-9_]/g, '-')}--`, sid);
    const now = new Date().toISOString(); const tables = {};
    const acme = join(home, 'projects', 'acme-web'); await mkdir(acme, { recursive: true }); await writeFile(join(acme, 'README.md'), '# acme-web\n');
    const short = `session-${randomUUID()}`;
    await mkdir(sessionDir(acme, short), { recursive: true });
    await writeFile(join(sessionDir(acme, short), 'session.v4.jsonl.zstd'), chatLog(short, acme, 'Short demo chat', 3));
    const acmeId = randomUUID(); tables[acmeId] = { path: acme, title: 'acme-web', sessionIds: [short], createdAt: now, updatedAt: now };
    const more = [];
    for (let p = 0; p < Number(process.env.PROJECTS ?? 45); p++) {
      const dir = join(home, 'projects', `demo-${p}`); await mkdir(dir, { recursive: true });
      const ids = [];
      for (let c = 0; c < 7; c++) {
        const sid = `session-${randomUUID()}`; ids.push(sid);
        await mkdir(sessionDir(dir, sid), { recursive: true });
        await writeFile(join(sessionDir(dir, sid), 'session.v4.jsonl.zstd'), chatLog(sid, dir, `Demo chat ${p}.${c}`, 1));
      }
      const wid = randomUUID(); more.push(wid); tables[wid] = { path: dir, title: `demo-${p}`, sessionIds: ids, createdAt: now, updatedAt: now };
    }
    const assistantDir = join(home, 'Assistant'); await mkdir(assistantDir, { recursive: true });
    const bot = `session-${randomUUID()}`;
    await mkdir(sessionDir(assistantDir, bot), { recursive: true });
    await writeFile(join(sessionDir(assistantDir, bot), 'session.v4.jsonl.zstd'), chatLog(bot, assistantDir, 'Damon', TURNS));
    const botId = randomUUID(); tables[botId] = { path: assistantDir, title: 'Damon', sessionIds: [bot], createdAt: now, updatedAt: now };
    await mkdir(join(dshHome, 'storages', 'dsh-composer-plus'), { recursive: true });
    await writeFile(join(dshHome, 'storages', 'dsh-composer-plus', 'assistant.json'), JSON.stringify({ sessionId: bot }));
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [acmeId, botId, ...more], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: acmeId }, tables: { workspaces: tables } }));

    const child = spawn(process.env.DSH_NODE || process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3291', '--no-open'], { cwd: acme,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 600 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})\n${log.slice(-2000)}`); await pause(100); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      // OFF=<id,id> switches those Composer Plus features off (to find which one costs the time).
      await context.addInitScript((json) => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', json); },
        JSON.stringify({ autoUpdate: false, ...Object.fromEntries((process.env.OFF ?? '').split(',').filter(Boolean).map((id) => [id, false])) }));
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await page.locator('[data-composer-input]').waitFor({ timeout: 30000 });
      await page.evaluate(PROBE);

      const chats = [
        ['short chat (3 turns)', async () => {
          const row = page.locator(`[data-row-key="session:${short}"]`).first();
          if (!(await row.isVisible())) await page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first().click();
          await row.click(); await page.getByText('Answer 3: the').first().waitFor({ timeout: 30000 });
        }],
        [`long Assistant chat (${TURNS} turns)`, async () => {
          await page.locator('button[aria-label="Damon"]').click(); await page.getByText(`Answer ${TURNS}: the`).first().waitFor({ timeout: 120000 });
        }],
      ];
      for (const [label, open] of chats) {
        await open();
        await pause(2500); // the chat settles: dsh 0.2.2 makes a finished answer quotable
        // A reader scrolls up a little with the wheel, as before a selection. dsh 0.2.2-rc.2 loads older pages while its
        // history edge is near the chat's top: with the Assistant's 8-turn view the drawn page must not grow.
        const before = await chatState(page);
        await page.mouse.move(640, 400); await page.mouse.wheel(0, -300); await pause(4000);
        const after = await chatState(page);
        console.log(`  ${label}: ${before.elements} elements; after a 300 px wheel scroll up ${after.elements} (scroll ${after.top} of ${after.end})`);
        if (after.elements > before.elements + 500) failures.push(`${version}, ${label}: a small scroll drew ${after.elements - before.elements} more elements (dsh loaded older pages)`);
        const from = await page.evaluate(() => window.cpSpeed.runs.length);
        let items;
        for (let i = 0; i < RUNS; i++) {
          const at = await selectPart(page);
          assert.ok(at, `${label}: an answer holds "${PART}"`);
          await page.mouse.move(at.x, at.y); await pause(400);
          await page.mouse.click(at.x, at.y, { button: 'right' });
          await until(() => page.evaluate(() => window.cpSpeed.cur?.painted !== undefined), `${label}: the menu opens`, 10000);
          items = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.textContent.trim()));
          await pause(150); // Event Timing reports after the paint
          await page.keyboard.press('Escape');
          await until(() => page.evaluate(() => document.querySelector('[role="menu"]') === null), `${label}: the menu closes`, 5000);
          await page.evaluate(() => getSelection().removeAllRanges()); await pause(300);
        }
        const runs = await page.evaluate((from) => window.cpSpeed.runs.slice(from), from);
        const end = await chatState(page);
        const ms = (x) => (typeof x === 'number' ? Math.round(x) : null);
        const rows = runs.map((r) => ({ delay: ms(r.start - r.input), handlers: ms(r.end - r.start), dom: ms(r.dom - r.input), visible: ms(r.event ?? (r.painted - r.input)) }));
        const med = Object.fromEntries(['delay', 'handlers', 'dom', 'visible'].map((k) => [k, median(rows.map((r) => r[k]))]));
        console.log(`  ${label}: median ${JSON.stringify(med)} ms; each visible: ${rows.map((r) => r.visible).join(', ')}; ${end.elements} elements at the end`);
        if (JSON.stringify(items) !== JSON.stringify(['Copy', 'Quote'])) failures.push(`${version}, ${label}: the menu is ${JSON.stringify(items)}, not Copy, Quote`);
        if (runs.length !== RUNS || !(med.visible <= LIMIT)) failures.push(`${version}, ${label}: the menu shows ${med.visible} ms after the right-click (limit ${LIMIT} ms, ${runs.length} of ${RUNS} runs)`);
        if (end.elements > before.elements + 500) failures.push(`${version}, ${label}: the right-clicks drew ${end.elements - before.elements} more elements`);
      }
      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
    } finally {
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
      else console.log(`  home kept: ${home}`);
    }
  }
} finally { await browser.close(); fake.close(); }
if (failures.length > 0) { console.error(`FAIL\n${failures.join('\n')}`); process.exit(1); }
console.log('PASS');
