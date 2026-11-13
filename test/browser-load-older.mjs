// Real-app check: a click on a button that shows earlier messages keeps the reader's place. A fake model, a throwaway
// HOME and DSH_HOME, made-up chats (acme-web, the Assistant chat). Headless. Never the normal DSH_HOME, no real model.
// 1. Assistant messages only (Composer Plus): the Assistant chat opens with its newest 8 turns. The reader scrolls up to
//    "Show earlier messages" and clicks it (the chat at its end, at the top, a little below the top): the first message
//    on screen and its offset stay (2 px), and a chat that followed its end still follows it. Then a new message at the
//    end is still followed (the reader at the end sees the reply).
// 2. dsh's own "Load earlier" at the top of a long chat and of the Assistant chat: the same check (dsh's code).
// PLAYWRIGHT=/path/to/playwright node test/browser-load-older.mjs /path/to/dsh/lib/bin.js [...]
// PORT=<port> uses another port than 3281. KEEP=1 keeps the throwaway home. BOT_TURNS=<n> turns in the Assistant chat
// (default 40). TRAIL=1 prints the scroll position every 200 ms after each click.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(100); } };
const SLACK = 2; // px

// Fake model: one short reply; dsh's and the plugin's helper calls get an empty answer.
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
let replies = 0;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body);
    const all = parsed.messages.map((m) => textOf(m.content)).join('\n');
    const helper = /session title|You predict the next message|You complete the message|long-term memory|label a coding task|Translate each line/i.test(all);
    const text = /session title/i.test(all) ? 'Demo' : helper ? '' : `Fresh reply ${++replies}: the demo build is green.`;
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } : {}) })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));

/** A made-up chat log in dsh's v4 event shapes: `turns` turns of a question, a tool call with its result and an answer. */
function chatLog(sid, cwd, title, turns, { short = false } = {}) {
  const t0 = Date.now() - (turns + 5) * 60000; let seq = 0;
  const ev = (type, data, extra = {}) => JSON.stringify({ type, seq: seq++, time: t0 + seq * 1000, data, ...extra });
  const model = { kind: 'model', provider: 'demo', model: 'demo' };
  const lines = [JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: t0, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }),
    ev('session/title', { title, messageSeqs: [], source: { kind: 'user' } })];
  for (let turn = 1; turn <= turns; turn++) {
    const ask = { content: [{ type: 'text', text: `Question ${turn}: what changed in module ${turn}?` }], source: { kind: 'user', rpcId: randomUUID() }, role: 'user', id: randomUUID() };
    const call = `call_${turn}`;
    lines.push(ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [ask] }), ev('turn/start', { turn }),
      ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      ev('step/start', { turn, step: 1 }), ev('user/message', ask, { surfaceOp: 'append' }),
      ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: call, name: 'read', arguments: '{"file_path":"README.md"}' }], source: model, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' }),
      ev('tool/call', { turn, step: 1, callId: call, name: 'read', arguments: '{"file_path":"README.md"}' }));
    lines.push(ev('tool/result', { turn, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: call }, toolCallId: call, content: [{ type: 'text', text: `1: # demo\n2: line ${turn}` }], isError: false, id: randomUUID() } }, { sourceEventSeqs: [seq - 1], surfaceOp: 'append' }),
      ev('step/end', { turn, step: 1 }), ev('step/start', { turn, step: 2 }),
      ev('assistant/message', { turn, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: short ? `Answer ${turn}: done.` : `Answer ${turn}: module ${turn} changed its config file and two tests.\n\n- the loader reads ${turn} files\n- the tests pass\n- nothing else changed` }], source: model, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' }),
      ev('step/end', { turn, step: 2 }), ev('turn/end', { turn, reason: { kind: 'completed' } }));
  }
  return Buffer.concat([zlib.zstdCompressSync(Buffer.from(`${lines[0]}\n`)), zlib.zstdCompressSync(Buffer.from(`${lines.slice(1).join('\n')}\n`))]);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
const failures = [];
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(await readFile(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-load-older-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'load-older-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // acme-web with one long chat, and the Assistant folder with the Assistant chat (more turns than dsh's first window).
    const sessionDir = (folder, sid) => join(dshHome, 'sessions', `-${folder.replace(/[^A-Za-z0-9_]/g, '-')}--`, sid);
    const now = new Date().toISOString(); const tables = {};
    const acme = join(home, 'projects', 'acme-web'); await mkdir(acme, { recursive: true }); await writeFile(join(acme, 'README.md'), '# acme-web\n');
    const long = `session-${randomUUID()}`;
    await mkdir(sessionDir(acme, long), { recursive: true });
    await writeFile(join(sessionDir(acme, long), 'session.v4.jsonl.zstd'), chatLog(long, acme, 'Long demo chat', 200));
    const acmeId = randomUUID(); tables[acmeId] = { path: acme, title: 'acme-web', sessionIds: [long], createdAt: now, updatedAt: now };
    const assistantDir = join(home, 'Assistant'); await mkdir(assistantDir, { recursive: true });
    const bot = `session-${randomUUID()}`;
    await mkdir(sessionDir(assistantDir, bot), { recursive: true });
    await writeFile(join(sessionDir(assistantDir, bot), 'session.v4.jsonl.zstd'), chatLog(bot, assistantDir, 'Damon', Number(process.env.BOT_TURNS || 40), { short: true }));
    const botId = randomUUID(); tables[botId] = { path: assistantDir, title: 'Damon', sessionIds: [bot], createdAt: now, updatedAt: now };
    await mkdir(join(dshHome, 'storages', 'dsh-composer-plus'), { recursive: true });
    await writeFile(join(dshHome, 'storages', 'dsh-composer-plus', 'assistant.json'), JSON.stringify({ sessionId: bot }));
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [acmeId, botId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: acmeId }, tables: { workspaces: tables } }));

    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3281', '--no-open'], { cwd: acme,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 400 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(100); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await page.locator('[data-composer-input]').waitFor({ timeout: 30000 });

      // The first message row on screen in a chat (or the row `key`), its offset below the top of the chat's scroll box,
      // and the box's position and end. On the page, so a check can measure and click in one task.
      await page.evaluate(() => {
        window.cpPlace = (sid, key) => {
          const flow = document.querySelector(`[data-conversation-session="${sid}"] [data-chat-flow]`);
          if (flow === null) return null;
          const scroller = flow.closest('[data-conversation-scroll]') ?? flow.parentElement;
          const top = scroller.getBoundingClientRect().top;
          const shown = (el) => { const b = el.getBoundingClientRect(); return b.height > 0 && b.bottom > top + 1; };
          const row = key !== undefined ? flow.querySelector(`[data-chat-anchor-key="${CSS.escape(key)}"]`)
            : [...flow.querySelectorAll('[data-chat-anchor-key]')].find(shown);
          return { key: row?.getAttribute('data-chat-anchor-key'), text: row?.textContent.trim().slice(0, 40), offset: row ? +(row.getBoundingClientRect().top - top).toFixed(1) : null,
            scrollTop: Math.round(scroller.scrollTop), floor: Math.round(scroller.scrollHeight - scroller.clientHeight), height: scroller.clientHeight, boxTop: top };
        };
      });
      const place = (sid, key) => page.evaluate(([sid, key]) => window.cpPlace(sid, key), [sid, key]);
      // Compare the row that was first on screen before a click with its place after it.
      // `fits`: the chat had no scroll range, so a browser cannot keep the row higher than the end allows: the row may move
      // down by the empty room below the chat's end, and it must stay on screen.
      const compare = async (sid, before, label, { fits = false } = {}) => {
        const trail = [];
        for (let i = 0; i < 15; i++) { await pause(200); const p = await place(sid, before.key); trail.push(`${p.scrollTop}/${p.floor}`); }
        if (process.env.TRAIL) console.log(`  scrollTop/end every 200 ms: ${trail.join(' ')}`);
        const after = await place(sid, before.key);
        const moved = after.offset === null ? Infinity : Math.abs(after.offset - before.offset);
        const atEnd = Math.abs(after.floor - after.scrollTop) <= SLACK;
        console.log(`  ${label}: "${before.text}" at ${before.offset} px before, ${after.offset} px after (moved ${moved === Infinity ? 'off screen' : `${moved.toFixed(1)} px`}); scrollTop ${before.scrollTop} → ${after.scrollTop} of ${after.floor}${atEnd ? ' (at the end)' : ''}`);
        if (fits) { if (after.offset === null || after.offset < before.offset - SLACK || after.offset > after.height) failures.push(`${version}, ${label}: the first message on screen left the screen (${after.offset} px)`); return; }
        if (moved > SLACK) failures.push(`${version}, ${label}: the first message on screen moved by ${moved === Infinity ? 'more than the screen' : `${moved.toFixed(1)} px`}${atEnd ? ' and the chat jumped to its end' : ''}`);
      };
      // Click `button` with the mouse at its place on screen (no scroll into view) and compare.
      // The button must be inside the chat's scroll box (on screen), and it must go after the click (the click did reveal).
      const clickKeeps = async (sid, button, label, options) => {
        const before = await place(sid);
        assert.ok(before?.key, `${label}: a message row on screen`);
        const b = await button.boundingBox();
        assert.ok(b !== null && b.y >= before.boxTop && b.y + b.height <= before.boxTop + before.height, `${label}: the button is on screen (${b?.y} px, box ${before.boxTop} px)`);
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        await button.waitFor({ state: 'detached', timeout: 5000 });
        await compare(sid, before, label, options);
      };
      const following = (sid) => page.evaluate((sid) => document.querySelector(`[data-conversation-session="${sid}"] [data-chat-following-tail]`) !== null, sid);
      // Scroll up with the mouse wheel over the chat until `button` is on screen at the top (as a reader does).
      const scrollUpTo = async (sid, button, height) => {
        const box = await page.locator(`[data-conversation-session="${sid}"] [data-chat-flow]`).first().boundingBox();
        await page.mouse.move(box.x + box.width / 2, height / 2);
        await until(async () => {
          const b = await button.boundingBox().catch(() => null);
          if (b !== null && b.y >= 0 && b.y + b.height <= height && (await place(sid)).scrollTop <= 4) return true;
          await page.mouse.wheel(0, -1200); await pause(120); return false;
        }, 'the button on screen', 60000);
        await pause(1500); // dsh samples a reader's scroll after 500 ms
      };
      const earlier = page.locator('[data-composer-plus-assistant-earlier-button]');
      const openBot = async () => { await page.locator('button[aria-label="Damon"]').click(); await earlier.waitFor({ timeout: 30000 }); await pause(1500); };
      const openLong = async () => {
        const row = page.locator(`[data-row-key="session:${long}"]`).first();
        if (!(await row.isVisible())) await page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first().click();
        await row.click(); await page.getByText('Answer 200: module').first().waitFor({ timeout: 30000 }); await pause(1000);
      };

      // 1. Composer Plus, Show earlier messages in the Assistant chat (it opens with its newest 8 turns). (a) The 8 short
      // turns fit on a tall screen: the chat is at its end (dsh follows the end) and the button is on screen. (b) The
      // reader scrolls up to the button at the top of the chat. (c) The same, a little below the top. Opening another
      // chat and the Assistant chat again shows the cap again.
      await page.setViewportSize({ width: 1280, height: 2400 });
      await openBot();
      const fit = await place(bot);
      assert.ok(fit.floor <= SLACK, `the 8 short turns fit on the screen (end ${fit.floor})`);
      assert.ok(await following(bot), 'the chat follows its end before the click');
      await clickKeeps(bot, earlier, 'Show earlier messages, chat at its end (Composer Plus)', { fits: true });
      assert.ok(await following(bot), 'the chat still follows its end after the click');
      await page.setViewportSize({ width: 1280, height: 800 });
      await openLong(); await openBot();
      await scrollUpTo(bot, earlier, 800);
      await clickKeeps(bot, earlier, 'Show earlier messages, at the top (Composer Plus)');
      await openLong(); await openBot();
      await scrollUpTo(bot, earlier, 800);
      await page.mouse.wheel(0, 12); await pause(1500);
      assert.ok((await place(bot)).scrollTop > 4, 'a little below the top');
      await clickKeeps(bot, earlier, 'Show earlier messages, below the top (Composer Plus)');
      // A new message at the end is still followed: go to the end, send, the reply is on screen at the end.
      await page.locator(`[data-conversation-session="${bot}"] [data-chat-flow]`).first().evaluate((flow) => { const s = flow.closest('[data-conversation-scroll]') ?? flow.parentElement; s.scrollTop = s.scrollHeight; });
      await pause(1000);
      assert.ok(await following(bot), 'at the end the chat follows its end again');
      const n = replies;
      await page.locator('[data-composer-input]').click();
      await page.keyboard.type('One more check please');
      await page.keyboard.press('Enter');
      await page.getByText(`Fresh reply ${n + 1}: the demo build is green.`).first().waitFor({ timeout: 30000 });
      await pause(1500);
      const end = await place(bot);
      assert.ok(Math.abs(end.floor - end.scrollTop) <= SLACK, `the chat follows a new reply at its end (scrollTop ${end.scrollTop}, end ${end.floor})`);
      console.log('  a new reply at the end is followed');

      // 2. dsh's own Load earlier at the top of a chat: go to the top in one move and click it before dsh loads every page
      // by itself (a wheel scroll to the top loads them all on the way). Measured and clicked in one page task.
      // (a) a long normal chat, (b) the Assistant chat after Show earlier messages (Assistant messages only hides rows).
      const dshOlder = async (sid, label) => {
        const before = await page.evaluate(async (sid) => {
          const flow = document.querySelector(`[data-conversation-session="${sid}"] [data-chat-flow]`);
          const scroller = flow.closest('[data-conversation-scroll]') ?? flow.parentElement;
          scroller.scrollTop = 0;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const button = flow.querySelector('[data-chat-history] button, [class*="_older"] button');
          if (button === null || button.disabled || button.getClientRects().length === 0) return null;
          const place = window.cpPlace(sid);
          button.click();
          return place;
        }, sid);
        if (before === null) console.log(`  ${label}: every message was already loaded (no click)`);
        else await compare(sid, before, label);
      };
      await dshOlder(bot, 'Load earlier in the Assistant chat (dsh)');
      await openLong();
      await dshOlder(long, 'Load earlier (dsh)');
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
