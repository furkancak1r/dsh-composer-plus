// Real-app check of Assistant messages only, folded answers, on each dsh given (throwaway DSH_HOME and HOME, a made-up
// assistant chat log, no model call). Headless.
// The case: you ask, the reply comes, then a subagent's message arrives mid-turn and wakes a next step whose reply ends
// the turn; then a hidden agent message starts the next turn, with its own reply. dsh folds every reply but a turn's last
// into the turn's process (0.2.0-0.2.1 always, 0.2.2 with foldedReplies: final, set here), and the view hides the control
// that opens it. Every reply must show, in time order; the agent message rows and the tool row stay hidden.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-answers.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const REPLIES = ['Promes is fine.', 'GIB has no code.', 'Second result.'];
const HIDDEN = ['RELAY-ONE from the subagent', 'RELAY-TWO from the subagent', 'chats_list'];

// The assistant chat's log: the event shapes of a real dsh 0.2.2 log (texts made up).
function chatLog(sid, cwd) {
  const t0 = Date.now() - 600000; let seq = 0;
  const ev = (type, data, extra = {}) => JSON.stringify({ type, seq: seq++, time: t0 + seq * 1000, data, ...extra });
  const msg = (text, source) => ({ content: [{ type: 'text', text }], source, role: 'user', id: randomUUID() });
  const relay = (text) => msg(text, { kind: 'agent-message', form: 'relay', senderSessionId: randomUUID() });
  const reply = (turn, step, content) => ev('assistant/message', { turn, step, message: { role: 'assistant', content, source: { kind: 'model', provider: 'demo', model: 'demo' }, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' });
  const ask = msg('promes status?', { kind: 'user' }); const one = relay(HIDDEN[0]); const two = relay(HIDDEN[1]);
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: t0, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }),
    ev('session/title', { title: 'Damon', messageSeqs: [], source: { kind: 'user' } }),
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [ask] }), ev('turn/start', { turn: 1 }),
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    ev('step/start', { turn: 1, step: 1 }), ev('user/message', ask, { surfaceOp: 'append' }),
    reply(1, 1, [{ type: 'reasoning', text: 'Checking.' }, { type: 'tool-call', id: 'call_1', name: 'chats_list', arguments: '{}' }]),
    ev('tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'chats_list', arguments: '{}' }),
  ];
  lines.push(ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1', content: [{ type: 'text', text: '{"chats":[]}' }], isError: false, id: randomUUID() } }, { sourceEventSeqs: [seq - 1], surfaceOp: 'append' }));
  lines.push(ev('step/end', { turn: 1, step: 1 }), ev('step/start', { turn: 1, step: 2 }),
    ev('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [one] }), // the subagent's message comes during step 2
    reply(1, 2, [{ type: 'reasoning', text: 'Answer it.' }, { type: 'text', text: REPLIES[0] }]), ev('step/end', { turn: 1, step: 2 }),
    ev('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
    ev('step/start', { turn: 1, step: 3 }), ev('user/message', one, { surfaceOp: 'append' }),
    reply(1, 3, [{ type: 'text', text: REPLIES[1] }]), ev('step/end', { turn: 1, step: 3 }), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    // A hidden agent message starts the next turn.
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [two] }), ev('turn/start', { turn: 2 }),
    ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    ev('step/start', { turn: 2, step: 1 }), ev('user/message', two, { surfaceOp: 'append' }),
    reply(2, 1, [{ type: 'text', text: REPLIES[2] }]), ev('step/end', { turn: 2, step: 1 }), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  // dsh wants the header line alone in the first zstd frame.
  return Buffer.concat([zlib.zstdCompressSync(Buffer.from(`${lines[0]}\n`)), zlib.zstdCompressSync(Buffer.from(`${lines.slice(1).join('\n')}\n`))]);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-answers-')));
    const dshHome = join(home, '.dsh'); const profile = join(dshHome, 'profiles/web'); const cwd = join(home, 'Assistant');
    await mkdir(join(profile, 'node_modules'), { recursive: true }); await mkdir(cwd);
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'answers-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    // dsh 0.2.2 keeps every reply by default; the owner's setting folds all but the final answer (0.2.0-0.2.1 always do).
    const fold = /^0\.2\.[01]-/.test(version) ? '' : '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    foldedReplies: final\n';
    await writeFile(join(profile, 'cordis.patch.yml'), `${fold}- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`);
    const sid = `session-${randomUUID()}`; const wid = randomUUID(); const now = new Date().toISOString();
    const dir = join(dshHome, 'sessions', `-${cwd.replace(/[^A-Za-z0-9_]/g, '-')}--`, sid); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), chatLog(sid, cwd));
    await mkdir(join(dshHome, 'storages/dsh-composer-plus'), { recursive: true });
    await writeFile(join(dshHome, 'storages/dsh-composer-plus/assistant.json'), JSON.stringify({ sessionId: sid }));
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid }, tables: { workspaces: { [wid]: { path: cwd, title: 'Damon', sessionIds: [sid], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', process.env.PORT || '3215', '--no-open'], { cwd,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      await page.locator('button[aria-label="Damon"]').click();
      const chat = page.locator(`[data-conversation-session="${sid}"]`);
      await chat.getByText(REPLIES[2]).first().waitFor({ timeout: 30000 }); await pause(1500); // the fold has run
      // Shown: drawn with a height, not in a hidden (content-visibility) or invisible subtree.
      const shown = (text) => chat.getByText(text).evaluateAll((els) => els.filter((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.getBoundingClientRect().height > 0).map((el) => el.getBoundingClientRect().top));
      const tops = [];
      for (const text of REPLIES) { const at = await shown(text); assert.equal(at.length, 1, `the reply "${text}" shows`); tops.push(at[0]); }
      assert.ok(tops[0] < tops[1] && tops[1] < tops[2], `the replies are in time order (${tops.join(' < ')})`);
      for (const text of HIDDEN) assert.equal((await shown(text)).length, 0, `"${text}" stays hidden`);
      assert.ok(await chat.getByText('promes status?').first().isVisible(), 'your message shows');
      assert.deepEqual(errors, [], 'no page errors');
      passed = true; console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed) { await context?.pages().at(-1)?.screenshot({ path: join(home, 'failed.png') }).catch(() => {}); await writeFile(join(home, 'server.log'), log); console.log(`  kept: ${home}`); }
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
