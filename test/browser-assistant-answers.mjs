// Real-app check of Assistant messages only, folded answers, on each dsh given (throwaway DSH_HOME and HOME, a made-up
// assistant chat log, no model call). Headless.
// The case: you ask, the reply comes, then a subagent's message arrives mid-turn and wakes a next step whose reply ends
// the turn; then a hidden agent message starts the next turn, with its own reply; then a news turn with only [quiet] (its
// reply and its news note go) and a news turn with a real reply (its reply shows). dsh folds every reply but a turn's last
// into the turn's process (0.2.0-0.2.1 always, 0.2.2 with foldedReplies: final, set here), and the view hides the control
// that opens it. Every reply must show, in time order; the agent message rows and the tool row stay hidden.
// The quiet news turn starts with a [quiet] text sent with a tool call: with FOLDED_REPLIES=all (dsh 0.2.2's default)
// dsh shows that text, and this view hides it too.
// PLAYWRIGHT=/path/to/playwright [FOLDED_REPLIES=all] node test/browser-assistant-answers.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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
const QUIET = '[quiet]'; // turn 3: a news turn whose reply is only [quiet] (the assistant has nothing to say): hidden
// Turn 3's news note goes with its quiet reply; turn 4 is a news turn with a real reply: its note and reply stay as dsh draws them.
const NEWS = ['[Composer Plus → Assistant news] QUIET-NEWS acme finished.', '[Composer Plus → Assistant news] LOUD-NEWS deploy failed.', '[Composer Plus → Assistant news] DENY-NEWS a copy ended.', '[Composer Plus → Assistant news] LOOK-NEWS a check ended.'];
const NEWS_ANSWER = 'The acme deploy failed: the login test is red.';
// Turn 5 (2026-11-27), in the real order (review 4): a "gave it to a subagent" line with the call that Auto review denies
// (dsh's own denial text), then the denial line with another tool call, then [quiet]: the denial line is for you and
// shows, in the chat and as a card; the first line stays hidden. Turn 6 (review 3): such a line without a denial stays
// hidden and makes no card.
const DENY = 'Auto review denied bash: it writes to the live server.';
const LOOK = 'LOOK-LINE gave the check to a subagent.';
const STARTED = 'STARTED-LINE copying, gave it to a subagent.';
const AUTO_DENIED = 'Error: Auto review rejected tool "chats_list"; its body was not executed';
const SHOTS = process.env.SHOTS; const TAG = process.env.TAG ? `-${process.env.TAG}` : ''; const BEFORE = process.env.BEFORE === '1';
/** SHOTS=<folder>: the page as `<name><TAG>.png` (damon-sohbet: the chat shown; damon-kartlar: the cards); never replaces a
 * file. BEFORE=1: only the two shots, no checks (for a client.js before the 2026-11-27 fix). */
async function shot(page, name) {
  if (!SHOTS) return;
  const file = join(SHOTS, `${name}${TAG}.png`);
  if (existsSync(file)) throw Error(`${file} exists`);
  await page.screenshot({ path: file }); console.log(`  SHOT: ${file}`);
}

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
  // A news turn as the Host writes it (wakeWithContinue: empty markers in both queues; the note itself has its own id).
  // `work`: steps whose text comes with a tool call (dsh 0.2.2's default foldedReplies: all shows that text), each
  // [text, result text].
  const newsTurn = (turn, text, answer, work = []) => {
    const marker = () => ({ id: randomUUID(), role: 'user', content: [], source: { kind: 'composer-plus-assistant-news' } });
    lines.push(ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [marker()] }), ev('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [marker()] }),
      ev('turn/start', { turn }), ev('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
      ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      ev('step/start', { turn, step: 1 }), ev('user/message', msg(text, { kind: 'composer-plus-assistant-news', form: 'snapshot' }), { surfaceOp: 'append' }));
    let step = 1;
    for (const [said, out] of work) {
      const callId = `call_${turn}_${step}`;
      lines.push(reply(turn, step, [{ type: 'text', text: said }, { type: 'tool-call', id: callId, name: 'chats_list', arguments: '{}' }]), ev('tool/call', { turn, step, callId, name: 'chats_list', arguments: '{}' }));
      lines.push(ev('tool/result', { turn, step, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: out }], isError: out === AUTO_DENIED, id: randomUUID() } }, { sourceEventSeqs: [seq - 1], surfaceOp: 'append' }),
        ev('step/end', { turn, step }), ev('step/start', { turn, step: step + 1 }));
      step += 1;
    }
    lines.push(reply(turn, step, [{ type: 'reasoning', text: 'Routine.' }, { type: 'text', text: answer }]), ev('step/end', { turn, step }), ev('turn/end', { turn, reason: { kind: 'completed' } }));
  };
  const ok = '{"chats":[]}';
  newsTurn(3, NEWS[0], QUIET, [[QUIET, ok]]); // [quiet] with a tool call, then [quiet]: the whole turn is quiet
  newsTurn(4, NEWS[1], NEWS_ANSWER);
  newsTurn(5, NEWS[2], ` ${QUIET}\n`, [[STARTED, AUTO_DENIED], [DENY, ok]]);
  newsTurn(6, NEWS[3], QUIET, [[LOOK, ok]]);
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
    // FOLDED_REPLIES=all checks dsh 0.2.2's default, where a text sent with a tool call shows too.
    const fold = /^0\.2\.[01]-/.test(version) ? '' : `- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    foldedReplies: ${process.env.FOLDED_REPLIES ?? 'final'}\n`;
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
      // 1600 px: dsh hides its turn rail while the chat is 900 px wide or less (`@container (width<=900px)`).
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1600, height: 1000 } });
      // The chat is shown (Sohbeti göster): Assistant reply cards (on by default) hide it behind their cards. The cards are
      // checked at the end, with the chat hidden again.
      await context.addInitScript(() => { localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); if (sessionStorage.getItem('cards') !== '1') localStorage.setItem('dsh-composer-plus.assistant-chat-shown', '1'); });
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
      await chat.getByText(NEWS_ANSWER).first().scrollIntoViewIfNeeded(); await shot(page, 'damon-sohbet');
      if (BEFORE) { await page.evaluate(() => { sessionStorage.setItem('cards', '1'); localStorage.removeItem('dsh-composer-plus.assistant-chat-shown'); });
        await page.reload(); await page.locator('button[aria-label="Damon"]').click(); await page.locator('[data-composer-plus-reply-feed] article.cp-rc').filter({ hasText: NEWS_ANSWER }).first().waitFor({ timeout: 30000 }); await pause(1000);
        await shot(page, 'damon-kartlar'); passed = true; console.log(`BEFORE dsh ${version}: shots only`); continue; }
      assert.equal((await shown(DENY)).length, 1, 'a text with a denied tool call before [quiet] (an Auto review denial) shows');
      // dsh 0.2.2 with foldedReplies: all shows each text sent with a tool call itself (as on main); folded, it stays hidden.
      const unfolded = !/^0\.2\.[01]-/.test(version) && process.env.FOLDED_REPLIES === 'all';
      assert.equal((await shown(LOOK)).length, unfolded ? 1 : 0, 'a text with a tool call before [quiet], without a denial: as dsh draws it');
      assert.equal((await shown(STARTED)).length, unfolded ? 1 : 0, 'the denied call\'s own text (before its result): as dsh draws it');
      const tops = [];
      for (const text of REPLIES) { const at = await shown(text); assert.equal(at.length, 1, `the reply "${text}" shows`); tops.push(at[0]); }
      assert.ok(tops[0] < tops[1] && tops[1] < tops[2], `the replies are in time order (${tops.join(' < ')})`);
      for (const text of HIDDEN) assert.equal((await shown(text)).length, 0, `"${text}" stays hidden`);
      assert.equal((await shown(QUIET)).length, 0, 'a reply that is only [quiet] is hidden');
      // The news note of each turn: dsh 0.2.2 draws it as a context row (folded into the turn's process), 0.2.0-0.2.1 not at
      // all. The quiet turn's row gets this view's 0-height rule; the note of a news turn with a real reply keeps dsh's own
      // style, and its reply shows.
      const noteRule = (turn) => chat.locator(`[data-chat-flow-kind="context"][data-chat-turn="${turn}"]`).evaluateAll((els) => els.map((el) => getComputedStyle(el).visibility));
      const drawn = /^0\.2\.[01]-/.test(version) ? [] : ['x'];
      assert.deepEqual(await noteRule(3), drawn.map(() => 'hidden'), 'the quiet turn\'s news note is hidden');
      assert.deepEqual(await noteRule(4), drawn.map(() => 'visible'), 'the news note of a turn with a real reply keeps dsh\'s own style');
      for (const note of NEWS) assert.equal((await shown(note.split('] ')[1])).length, 0, `the news text "${note}" is not on screen`);
      assert.equal((await shown(NEWS_ANSWER)).length, 1, 'the real reply of a news turn shows');
      // dsh's turn tail of the quiet turn: its Copy/time row (the hidden reply's) goes; the tail itself stays in the page.
      const tail = await chat.locator('[data-turn-tail="3"] > [data-clock]').evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
      assert.deepEqual(tail, ['none'], 'the quiet turn shows no Copy/time row');
      const otherTail = await chat.locator('[data-turn-tail="2"] > [data-clock]').evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().height > 0).length);
      assert.equal(otherTail, 1, 'a turn with a reply keeps its Copy/time row');
      // dsh's turn rail: its hover tooltip shows a turn's last text. The quiet turn's tooltip does not show; a real one does.
      const mark = (turn) => chat.locator(`nav[class*="_frame"] button[aria-label$=" ${turn}"]`).first();
      const tip = chat.locator('nav[class*="_frame"] > [role="tooltip"]');
      if (await mark(3).count() > 0) {
        await mark(4).hover(); await tip.waitFor({ timeout: 5000 });
        assert.ok(await tip.isVisible() && (await tip.textContent()).includes(NEWS_ANSWER.slice(0, 20)), 'a real turn\'s rail tooltip shows');
        await mark(3).hover(); await pause(300);
        assert.equal(await tip.evaluateAll((els) => els.filter((el) => el.checkVisibility()).length), 0, 'the quiet turn\'s rail tooltip does not show');
        await page.mouse.move(10, 10);
      } else console.log(`  (dsh ${version}: no turn rail drawn)`);
      assert.ok(await chat.getByText('promes status?').first().isVisible(), 'your message shows');
      // The reply cards (the chat hidden again): a card per reply, none for the [quiet] turn or a [quiet] text; the denial
      // before [quiet] is a card.
      await page.evaluate(() => { sessionStorage.setItem('cards', '1'); localStorage.removeItem('dsh-composer-plus.assistant-chat-shown'); });
      await page.reload(); await page.locator('button[aria-label="Damon"]').click();
      const cards = page.locator('[data-composer-plus-reply-feed] article.cp-rc');
      await cards.filter({ hasText: NEWS_ANSWER }).first().waitFor({ timeout: 30000 }); await pause(1000);
      await shot(page, 'damon-kartlar');
      const texts = await cards.evaluateAll((els) => els.map((el) => el.querySelector('h3')?.textContent.trim()));
      assert.deepEqual(texts, [...REPLIES, NEWS_ANSWER, DENY], 'one card per reply in time order, the denial too, none for [quiet] or the looking line');
      assert.equal(await page.locator('[data-composer-plus-reply-feed]').getByText(QUIET).count(), 0, 'no card shows [quiet]');
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
