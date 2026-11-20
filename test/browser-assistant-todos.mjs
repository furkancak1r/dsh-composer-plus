// Real-app check of "Assistant to-do list" on each dsh given: a fake model, a throwaway DSH_HOME and HOME, a made-up
// project (acme-web). Never the normal DSH_HOME, no real model. Headless.
// 1. The assistant chat: "Remember: buy milk" → the fake model calls todo_list_add (the assistant has the two tools and
//    Assistant always free lets them run); the request carries the list as runtime context and the section. The card
//    stack shows at the right of the chat by default (in dsh's chat body, over no message, not in dsh's right sidebar); the
//    user's own items without a mark are in the folded "Your notes" group.
// 2. → (in "Your notes") writes "Do this for me: <item>" at the end of the composer, after the draft that is there, on
//    its own line; the focus and the caret are at its end, nothing is sent and the item stays the user's note. Sent, the
//    agent gives it to itself: it is a Running card.
// 3. "Is it done?" → the fake model calls todo_list_remove (reason completed): the item leaves the stack.
// 4. Remove (×): one click, no dialog, the item is gone. Keyboard: Tab reaches the buttons.
// 5. Reload: the list is still there (Host file). Another chat has no stack and no to-do tools.
// 6. Switch off in Settings: no stack, no tools, no context; on again: the stack is back. No page errors.
// 7. Status: "Morning summary please" → status_summary_set; the summary card shows today's summary, a project name opens
//    its row in the Projects section (chats, git branch and commits of the made-up repository). "Research Rome" → a
//    background subagent: a Running card shows it, then it is a Done today card with its result, without Refresh.
//    Refresh updates the list time. Typing 30 keys does not draw the stack.
// 8. Groups: 2 notes of the user ("Your notes 2") and 3 Running cards of the assistant, no owner groups; Enter on a
//    group header folds it. After a reload "Your notes" and "Done today" start folded again.
//    The turn after "Research Rome" (a subagent and no to-do change) has the to-do nudge in its runtime context.
// 9. Issue #6: todo_list_add with waiting is a "For you" card with "Waiting for you", the reason and Reply, and the
//    count bar counts it. The ended subagent task is a "Done today" card (folded group); Seen hides it, and it stays
//    hidden after a reload.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-todos.mjs /path/to/dsh/lib/bin.js [...]
// The Settings screenshot comes from test/browser-card-stack.mjs (SHOT=1).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, readFile, rm } from 'node:fs/promises';
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
const calls = [];
const gate = { open: false };
// A long item with an unbroken token: it must wrap and never run under its → and × buttons.
const LONG = 'Check each log line of the nightly import job and note each failed row https://example.com/imports/nightly/2026/staging/failed-rows-with-order-numbers before the meeting';
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const tool = (name, args) => { send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
    const all = msgs.map((m) => textOf(m.content)).join('\n');
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Demo chat');
    if (/You predict the next message|You complete the message that the user is typing|label a coding task/.test(all)) return say('');
    const own = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((t) => !/^<|^Current runtime context|^Time sampled/.test(t.trim()));
    const newest = own.at(-1) ?? '';
    const system = msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
    // dsh's runtime context: "Current runtime context…" before 0.2.2-rc.2, a <system-reminder> block ("The following information describes your current session…") in 0.2.2-rc.2.
    const context = msgs.filter((m) => m.role === 'user' && /^(<system-reminder>\s*)?(Current runtime context|The following information describes your current session)/.test(textOf(m.content).trim())).map((m) => textOf(m.content)).at(-1) ?? '';
    const tools = (parsed.tools ?? []).map((t) => t.function?.name);
    // A tool result after the newest own message: the same turn (dsh adds a new runtime-context message after the result
    // when the list changed, so the last message is not always the tool result).
    const isOwn = (m) => m.role === 'user' && !/^<|^Current runtime context|^Time sampled/.test(textOf(m.content).trim());
    const toolMsgs = msgs.slice(msgs.findLastIndex(isOwn) + 1).filter((m) => m.role === 'tool');
    const after = toolMsgs.length > 0;
    const result = after ? textOf(toolMsgs.at(-1).content) : '';
    calls.push({ newest, system, context, tools, after, result });
    if (/Remember: buy milk/.test(newest) && !after) return tool('todo_list_add', { text: 'Buy milk', owner: 'user' });
    if (/Remember: call the bank/.test(newest) && !after) return tool('todo_list_add', { text: 'Call the bank', owner: 'user' });
    if (/^Do this for me: Call the bank$/.test(newest.trim()) && !after) return tool('todo_list_add', { text: 'Call the bank', owner: 'agent' });
    if (/Is the milk done\?/.test(newest) && !after) {
      const id = /- ([0-9a-f]{8}) \(owner \w+\): "Buy milk"/.exec(context)?.[1] ?? 'ffffffff';
      return tool('todo_list_remove', { id, reason: 'completed' });
    }
    if (/Wait for the ANR path/.test(newest) && !after) return tool('todo_list_add', { text: 'Install ANR', owner: 'agent', waiting: 'Needs the game folder path' });
    if (/^Add a long one$/.test(newest.trim()) && !after) return tool('todo_list_add', { text: LONG, owner: 'agent' });
    if (/Morning summary please/.test(newest) && !after) return tool('status_summary_set', { projects: [{ project: 'acme-web', text: 'Login page is done; tests pass.' }] });
    if (/Research Rome/.test(newest) && !after) {
      const bg = (parsed.tools ?? []).find((t) => t.function?.name === 'subagent')?.function?.parameters?.properties?.run_in_background !== undefined;
      return tool('subagent', { description: 'Rome flights', prompt: 'CHILD: find flights to Rome', ...(bg ? { run_in_background: true } : {}) });
    }
    if (/^CHILD: find flights/.test(newest.trim())) { const wait = () => (gate.open ? say('Flights found: 3 options\nDetails follow') : setTimeout(wait, 200)); return wait(); }
    const fill = [{ text: 'Pay rent', owner: 'user' }, { text: 'Book flights', owner: 'agent' }, { text: 'Call mom', owner: 'user' }, { text: 'Draft the report', owner: 'agent' }];
    if (/^Fill the list$/.test(newest.trim()) && toolMsgs.length < fill.length) return tool('todo_list_add', fill[toolMsgs.length]);
    if (after) return say(`Tool said: ${result.slice(0, 80)}`);
    return say('ok');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const bin of process.argv.slice(2)) {
    calls.length = 0;
    const version = JSON.parse(readFileSync(join(bin, '../../package.json'), 'utf8')).version;
    console.log(`dsh ${version}`);
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-assistant-todos-')));
    const dshHome = join(home, '.dsh');
    const profile = join(dshHome, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-todos-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: gitEnv }); execFileSync('git', ['add', '.'], { cwd: dir, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'Add the login page'], { cwd: dir, env: gitEnv }); execFileSync('git', ['switch', '-q', '-c', 'feature/login'], { cwd: dir, env: gitEnv });
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid }, tables: { workspaces: { [wid]: { path: dir, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3214', '--no-open'], { cwd: dir,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', TZ: 'Europe/Istanbul', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let page; let passed = false;
    const note = (line) => console.log(`  ${line}`);
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const close = page.getByRole('dialog', { name: /^Get started$/ }).getByRole('button', { name: /^Close$/ });
      if (await close.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
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
      const clear = async () => { await input.click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.press('Escape'); };
      const send = async (text) => { await clear(); await page.keyboard.type(text, { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); };
      const panel = page.locator('[data-composer-plus-todos]');
      // The card stack: the user's own items without a mark are rows of the folded "Your notes" group; every other item and
      // task is a card `li.cp-cs-card[data-card=sorun|senden|suruyor|bitti]` in its group (a group folds by itself when
      // it does not fit, so `open(group)` first where a check needs the card in view).
      const noteRow = (text) => panel.locator('section[data-group="notes"] li').filter({ hasText: text });
      const cards = (kind, text = '') => panel.locator(`li.cp-cs-card[data-card="${kind}"]`).filter({ hasText: text });
      const groupHead = (g) => panel.locator(`button.cp-td-group[data-group="${g}"]`);
      const open = async (g) => { const head = groupHead(g); await head.waitFor({ timeout: 20000 }); if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click(); };
      const assistantRow = () => page.locator('button[aria-label="Damon"]');

      // Settings: the row has its screenshot and is on by default.
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      const sw = page.getByRole('switch', { name: 'Assistant status panel', exact: true });
      await sw.waitFor({ timeout: 10000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      assert.equal(await sw.locator('xpath=..').locator('[data-composer-plus-shot="assistantTodos"]').count(), 1, 'the row has its screenshot');
      await back();

      // 1. The assistant chat; the agent adds an item.
      await assistantRow().click();
      await until(async () => (await page.locator('[data-composer-plus-assistant]').count()) === 0, 'assistant chat open');
      const sessionId = await until(async () => (await page.evaluate(async () => (await (await fetch('/api/composer-plus.assistant-status')).json()).sessionId)), 'assistant id');
      await send('Remember: buy milk');
      await noteRow('Buy milk').waitFor({ state: 'attached', timeout: 30000 });
      const add = calls.find((c) => /Remember: buy milk/.test(c.newest) && !c.after);
      assert.ok(add.tools.includes('todo_list_add') && add.tools.includes('todo_list_remove'), 'the assistant has the two tools');
      assert.match(add.system, /Assistant to-do list \(Composer Plus\)/, 'the section');
      assert.match(add.system, /todo_list_add, todo_list_remove/, 'Assistant always free names them');
      const addResult = await until(() => calls.find((c) => /Remember: buy milk/.test(c.newest) && c.after), 'the tool result reached the model');
      assert.match(addResult.result, /^Added [0-9a-f]{8} \(owner user\)/, 'Assistant always free lets the tool run');
      // The stack is in dsh's chat body, at the right of the chat by default (Furkan, 2026-11-20; the place button moves it
      // above the chat: test/browser-card-stack.mjs), and not in dsh's right sidebar.
      assert.equal(await panel.count(), 1);
      assert.equal(await panel.evaluate((el) => el.parentElement?.hasAttribute('data-conversation-content')), true, 'in the chat body');
      assert.equal(await panel.getAttribute('data-place'), 'side', 'the right side by default');
      const box = await panel.boundingBox(); const bodyBox = await page.locator(`[data-conversation-content][data-conversation-session="${sessionId}"]`).boundingBox();
      assert.ok(box.x + box.width <= bodyBox.x + bodyBox.width + 1 && box.x > bodyBox.x + bodyBox.width / 2, `at the right side of the chat (${JSON.stringify(box)} in ${JSON.stringify(bodyBox)})`);
      assert.equal(await noteRow('Buy milk').count(), 1, 'a note of the user, in "Your notes"');
      assert.equal(await groupHead('notes').getAttribute('aria-expanded'), 'false', '"Your notes" starts folded');
      assert.equal(await panel.locator('li.cp-cs-card').filter({ hasText: 'Buy milk' }).count(), 0, 'a note of the user is no card');
      // The stack covers no message: each user bubble ends left of it.
      for (const bubble of await page.getByText('Remember: buy milk', { exact: true }).all()) {
        const b = await bubble.boundingBox(); assert.ok(b === null || b.x + b.width <= box.x + 1, `a message under the stack: ${JSON.stringify(b)} / ${JSON.stringify(box)}`);
      }
      note('1: todo_list_add from the agent shows in the card stack at the right of the chat (a note of the user, "Your notes" folded)');

      // 2. → writes in the composer and sends nothing; a draft that is there stays. The user sends it: the agent takes it.
      await send('Remember: call the bank'); await noteRow('Call the bank').waitFor({ state: 'attached', timeout: 30000 });
      await until(async () => !(await page.evaluate(() => document.querySelector('[data-composer-input]') === null)), 'idle');
      await clear(); await page.keyboard.type('Also check the invoice', { delay: 5 }); await page.keyboard.press('Escape');
      const before = calls.length;
      await open('notes');
      await page.getByRole('button', { name: 'Give to the assistant: Call the bank', exact: true }).click();
      await until(async () => (await input.innerText()).includes('Do this for me: Call the bank'), 'the text is in the composer');
      assert.equal((await input.innerText()).replace(/\n+/g, '\n').trim(), 'Also check the invoice\nDo this for me: Call the bank', 'the draft stays, the text on its own line');
      assert.equal(await input.evaluate((el) => el.contains(document.activeElement) || el === document.activeElement), true, 'the focus is in the composer');
      await page.keyboard.type(' today', { delay: 5 }); // the caret is at the end
      assert.match(await input.innerText(), /Do this for me: Call the bank today$/, 'the caret is after the text');
      await pause(1500);
      assert.equal(calls.length, before, 'nothing was sent');
      assert.equal(await noteRow('Call the bank').count(), 1, 'the item stays a note of the user');
      // The fake model plays the assistant: "Do this for me: …" gives the item owner agent: a Running card ("Your notes" loses it).
      await clear(); await page.keyboard.type('Do this for me: Call the bank', { delay: 5 }); await page.keyboard.press('Escape'); await page.keyboard.press('Enter');
      await until(async () => (await cards('suruyor', 'Call the bank').count()) === 1 && (await noteRow('Call the bank').count()) === 0, 'a Running card after the send');
      assert.equal(await page.getByRole('button', { name: 'Give to the assistant: Call the bank' }).count(), 0, 'no → for an item of the assistant');
      // A claimed command (/goal): dsh 0.2.1 makes it a chip, 0.2.0 keeps it as text. The text still goes at the end.
      await send('Remember: call the bank'); await until(async () => (await noteRow('Call the bank').count()) === 1, 'a user note again');
      await clear(); await page.keyboard.type('/goal', { delay: 30 }); await page.keyboard.press('Space'); await page.keyboard.type('ship it', { delay: 5 });
      await page.keyboard.press('Escape');
      const goalBefore = (await input.innerText()).trim();
      await open('notes');
      await page.getByRole('button', { name: 'Give to the assistant: Call the bank', exact: true }).click();
      await until(async () => (await input.innerText()).includes('Do this for me: Call the bank'), 'the text after a command');
      assert.match((await input.innerText()).replace(/\n+/g, '\n').trim(), /ship it\nDo this for me: Call the bank$/, `after the command's text (${goalBefore})`);
      await clear(); await send('Do this for me: Call the bank'); // the later steps expect the assistant's item
      await until(async () => (await cards('suruyor', 'Call the bank').count()) === 1, 'a Running card again');
      note('2: → (Your notes) writes "Do this for me: …" in the composer after the draft, focus at the end, nothing sent; sent, the item is a Running card');

      // 3. The agent removes a done item.
      await send('Is the milk done?');
      await until(async () => (await noteRow('Buy milk').count()) === 0, 'the agent removed the done item', 30000);
      assert.match((await until(() => calls.find((c) => /Is the milk done\?/.test(c.newest) && c.after), 'remove result')).result, /^Removed [0-9a-f]{8} \(completed\): "Buy milk"/);
      note('3: todo_list_remove from the agent (reason completed) removes the item');

      // 4. Remove with one click, and the keyboard reaches the buttons.
      await send('Remember: buy milk'); await noteRow('Buy milk').waitFor({ state: 'attached', timeout: 30000 });
      await open('notes');
      const removeButton = page.getByRole('button', { name: 'Remove: Buy milk', exact: true });
      await removeButton.focus(); assert.equal(await removeButton.evaluate((b) => b === document.activeElement), true, 'keyboard focus');
      await page.keyboard.press('Enter');
      await until(async () => (await noteRow('Buy milk').count()) === 0, 'removed');
      assert.equal(await page.getByRole('dialog').count(), 0, 'no confirmation dialog');
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-composer-plus-todos]') !== null), true, 'F-02: the focus stays in the panel');
      note('4: × removes at once (keyboard Enter), no dialog');

      // 5. Reload: the list stays. Another chat: no panel, no tools.
      await page.reload(); await input.waitFor({ timeout: 20000 });
      await assistantRow().click();
      await cards('suruyor', 'Call the bank').waitFor({ state: 'attached', timeout: 20000 });
      const file = JSON.parse(await readFile(join(dshHome, 'storages/dsh-composer-plus/assistant-todos.json'), 'utf8'));
      assert.deepEqual(file.lists[sessionId].map((i) => [i.text, i.owner]), [['Call the bank', 'agent']], 'saved on the Host');
      const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'acme-web' }).first();
      await proj.hover(); await page.getByRole('button', { name: 'New session in acme-web', exact: true }).click(); await pause(800);
      const mark = calls.length; await send('hello other chat');
      await until(async () => calls.length > mark, 'other chat call');
      assert.equal(await panel.count(), 0, 'no panel in another chat');
      assert.ok(!calls.at(-1).tools.includes('todo_list_add'), 'no to-do tools in another chat');
      assert.doesNotMatch(calls.at(-1).context, /Assistant to-do list/, 'no list context in another chat');
      note('5: the list survives a reload (Host file); another chat has no panel and no tools');

      // 6. Switch off and on.
      await settings(); await sw.click(); await until(async () => (await sw.getAttribute('aria-checked')) === 'false', 'switch off'); await back();
      await assistantRow().click(); await pause(1500);
      assert.equal(await panel.count(), 0, 'no panel while off');
      const offMark = calls.length; await send('Remember: buy milk');
      await until(async () => calls.length > offMark, 'a call after off');
      const off = calls[offMark];
      assert.ok(!off.tools.includes('todo_list_add'), 'tools gone'); assert.doesNotMatch(off.system, /Assistant to-do list \(Composer Plus\)/, 'section gone');
      assert.doesNotMatch(off.context, /Assistant to-do list/, 'context gone');
      await settings(); await sw.click(); await until(async () => (await sw.getAttribute('aria-checked')) === 'true', 'switch on'); await back();
      await assistantRow().click();
      await cards('suruyor', 'Call the bank').waitFor({ state: 'attached', timeout: 20000 });
      note('6: off removes the panel, the tools, the section and the context; on brings the list back');

      // 7. Status.
      gate.open = false;
      await send('Morning summary please');
      const card = panel.locator('.cp-st-summary');
      await card.waitFor({ timeout: 30000 });
      assert.match(await card.innerText(), /Login page is done; tests pass\./);
      assert.match(await card.locator('h3').innerText(), /^Summary · \d/, 'a neutral title at any hour, not "Morning summary"');
      assert.match((await until(() => calls.find((c) => /Morning summary please/.test(c.newest) && c.after), 'summary result')).result, /summary of 1 projects/);
      // The other chat of acme-web (step 5) changed today: its project row; the summary's link opens it.
      await card.getByRole('button', { name: 'acme-web', exact: true }).click();
      const row = panel.locator('section[aria-labelledby$="-projects-h"] .cp-st-row').filter({ hasText: 'acme-web' });
      await until(async () => (await row.getAttribute('aria-expanded')) === 'true', 'the project row opens in the Projects section');
      const detail = panel.locator('.cp-st-detail');
      await detail.getByText('feature/login').first().waitFor({ timeout: 15000 });
      assert.match(await detail.innerText(), /Add the login page/);
      assert.ok(await detail.getByRole('button').count() >= 1, 'its chats are buttons');
      // A background subagent task: working, then done with its result (no Refresh).
      await send('Research Rome');
      // A running task is a Running card; ended, it is a Done today card (that group starts folded: read the text, not what shows).
      const has = async (loc, re) => (await loc.count()) === 1 && re.test(await loc.evaluate((el) => el.textContent));
      const running = cards('suruyor', 'Rome flights');
      await running.waitFor({ state: 'attached', timeout: 30000 });
      await until(() => has(running, /Working/), 'the task shows as a working Running card', 20000);
      gate.open = true;
      const ended = cards('bitti', 'Rome flights');
      await until(async () => (await has(ended, /Done/)) && (await has(ended, /Flights found: 3 options/)) && (await running.count()) === 0, 'the task is a Done today card with its result', 30000);
      // Refresh updates the list time; the button has its name (test/browser-status-refresh.mjs checks its feedback).
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
      await until(async () => /List \d/.test(await panel.locator('h2').innerText()) && /List \d/.test(await panel.locator('.cp-st-time').innerText()), 'the list time after Refresh', 5000);
      // Refresh reads the open project's git details again: wait until they are back before the typing check.
      await detail.getByText('feature/login').first().waitFor({ timeout: 15000 }); await pause(1500);
      // Typing does not draw the panel: count DOM changes in the panel while 30 keys go into the composer.
      await page.evaluate(() => { window.__cpMut = 0; const el = document.querySelector('[data-composer-plus-todos]'); window.__cpObs = new MutationObserver((m) => { window.__cpMut += m.length; }); window.__cpObs.observe(el, { subtree: true, childList: true, characterData: true, attributes: true }); });
      await clear(); await page.keyboard.type('typing does not draw the panel', { delay: 10 });
      const mutations = await page.evaluate(() => { window.__cpObs.disconnect(); return window.__cpMut; });
      assert.equal(mutations, 0, `the panel changed ${mutations} times while typing`);
      await clear();
      note('7: summary card and project link (Projects section: chats, git), a subagent task as a Running then a Done today card, Refresh, no stack change while typing');

      // 8. Groups: 2 notes of the user and 3 Running cards of the assistant ("Call the bank" from step 2 and two new ones).
      const nudgeMark = calls.length;
      await send('Fill the list');
      // The "Research Rome" turn started a subagent and did not change the list: the next turn gets the to-do nudge.
      await until(() => calls.length > nudgeMark, 'a call after the subagent turn');
      assert.ok(calls.slice(calls.findIndex((c) => /Research Rome/.test(c.newest))).some((c) => /To-do list: in your last turn you started work/.test(c.context)),
        'the to-do nudge after a turn that started a subagent without a to-do item');
      assert.ok(!calls.slice(0, calls.findIndex((c) => /Research Rome/.test(c.newest))).some((c) => /To-do list: in your last turn/.test(c.context)), 'no nudge before it');
      await until(async () => (await panel.locator('section[data-group="notes"] li').count()) === 2 && (await cards('suruyor').count()) === 3, 'two notes and three Running cards');
      const heads = panel.locator('button.cp-td-group');
      assert.deepEqual(await heads.evaluateAll((els) => els.map((b) => [b.dataset.group, b.getAttribute('aria-expanded'), [...b.children].slice(0, 3).map((c) => c.textContent.trim()).join(' ')])),
        [['suruyor', 'true', '▾ Running 3'], ['bitti', 'false', '▸ Done today 1'], ['notes', 'false', '▸ Your notes 2']], 'Running open; Done today and Your notes folded; with counts');
      assert.deepEqual((await panel.locator('section[data-group="notes"] .cp-cs-main').allInnerTexts()).sort(), ['Call mom', 'Pay rent'].sort());
      assert.deepEqual((await cards('suruyor').locator('.cp-cs-title').allInnerTexts()).sort(), ['Book flights', 'Call the bank', 'Draft the report'], 'the assistant\'s items are Running cards');
      assert.doesNotMatch(await panel.evaluate((el) => el.textContent), /You will do|Damon will do|You do it|The assistant does it/, 'no owner groups, no owner line');
      await open('notes');
      assert.equal(await panel.locator('section[data-group="suruyor"]').getByRole('button', { name: /^Give to the assistant/ }).count(), 0, '→ only on the user\'s notes');
      assert.equal(await panel.locator('section[data-group="notes"]').getByRole('button', { name: /^Give to the assistant/ }).count(), 2);
      // Keyboard: Enter on a header folds its group.
      await groupHead('suruyor').focus(); await page.keyboard.press('Enter');
      await until(async () => (await groupHead('suruyor').getAttribute('aria-expanded')) === 'false', 'folded');
      assert.equal(await cards('suruyor').first().isVisible(), false, 'the folded list is hidden'); assert.equal(await panel.locator('section[data-group="notes"] li').first().isVisible(), true);
      // A reload starts the groups as at first: Running open (it fits), Done today and Your notes folded.
      await page.reload(); await input.waitFor({ timeout: 20000 }); await assistantRow().click();
      await groupHead('suruyor').waitFor({ timeout: 20000 });
      assert.equal(await groupHead('suruyor').getAttribute('aria-expanded'), 'true', 'Running is open again after a reload');
      assert.equal(await groupHead('bitti').getAttribute('aria-expanded'), 'false', 'Done today starts folded');
      assert.equal(await groupHead('notes').getAttribute('aria-expanded'), 'false', 'Your notes starts folded');
      await page.mouse.move(640, 790); // no hover color in the screenshot
      note('8: "Your notes" (2, folded) and "Running" (3 cards), no owner groups; Enter folds a group; after a reload Done today and Your notes start folded');

      // 9. Waiting for the user (a "For you" card), and Seen (an ended task is a "Done today" card).
      await send('Wait for the ANR path');
      const anr = cards('senden', 'Install ANR');
      await until(async () => (await anr.count()) === 1 && /Waiting for you/.test(await anr.evaluate((el) => el.textContent)), 'the waiting card', 30000);
      assert.match(await anr.evaluate((el) => el.textContent), /Needs the game folder path/, 'the reason');
      assert.match(await anr.evaluate((el) => el.textContent), /Waiting for you · \d+ (sec|min)/, 'the wait time');
      assert.equal(await anr.getByRole('button', { name: 'Reply', exact: true }).count(), 1, 'Reply');
      assert.match((await until(() => calls.find((c) => /Wait for the ANR path/.test(c.newest) && c.after), 'waiting result')).result, /owner agent, waiting for the user/);
      assert.match(await panel.locator('[data-composer-plus-counts]').innerText(), /(^| · )1 for you( · |$)/, 'the count bar counts it');
      assert.equal(await groupHead('senden').getAttribute('aria-expanded'), 'true', 'For you is open');
      assert.equal(await groupHead('bitti').getAttribute('aria-expanded'), 'false', 'Done today is folded');
      await open('bitti');
      const rome = cards('bitti', 'Rome flights');
      await rome.waitFor({ timeout: 5000 });
      assert.match(await rome.innerText(), /Done/);
      assert.equal(await panel.getByRole('button', { name: 'Hide from the list: Rome flights', exact: true }).count(), 0, 'no × on a done card: it has Seen');
      await rome.getByRole('button', { name: 'Seen', exact: true }).click();
      await until(async () => (await rome.count()) === 0, 'the card is hidden');
      assert.equal(await groupHead('bitti').count(), 0, 'no done card is left: the group goes');
      await page.reload(); await input.waitFor({ timeout: 20000 }); await assistantRow().click();
      await anr.waitFor({ state: 'attached', timeout: 20000 }); await pause(1000);
      assert.equal(await rome.count(), 0, 'still hidden after a reload (this browser)');
      note('9: an agent item waits for the user (For you card: reason, time, Reply, count bar); Seen hides a Done today card, also after a reload');

      // 10. "Write in the message box" on the assistant's cards, the tasks and the projects: the data goes after the draft,
      //     on new lines, the focus is in the composer, nothing is sent, no id. Click, Enter and Space. A long card
      //     title wraps and never runs under its buttons.
      await send('Add a long one'); await cards('suruyor', 'Check each log line').waitFor({ state: 'attached', timeout: 30000 });
      await send('Research Rome');
      const rome2 = cards('bitti', 'Rome flights');
      await until(async () => (await has(rome2, /Done/)) && (await cards('suruyor', 'Rome flights').count()) === 0, 'the second task ended', 30000);
      for (const g of ['senden', 'suruyor', 'bitti', 'notes']) await open(g);
      const projectsButton = panel.locator('button.cp-st-ask[aria-expanded]');
      if ((await projectsButton.getAttribute('aria-expanded')) !== 'true') await projectsButton.click();
      const projectRows = panel.locator('section[aria-labelledby$="-projects-h"] li');
      await until(async () => (await projectRows.count()) > 0, 'a project row');
      // No text runs under its buttons (a card line, a note, a project row), and no button leaves the stack.
      const overlaps = await panel.evaluate((root) => [...root.querySelectorAll('.cp-cs-line, .cp-st-line')].filter((line) => line.offsetParent !== null && line.closest('details') === null).flatMap((line) => {
        const text = line.querySelector(':scope > .cp-cs-main, :scope > .cp-st-row'); const buttons = [...line.querySelectorAll(':scope > .cp-cs-act, :scope > .cp-td-btn')].filter((b) => b.offsetParent !== null);
        if (text === null || buttons.length === 0) return [];
        const t = text.getBoundingClientRect(); const out = root.getBoundingClientRect();
        return buttons.flatMap((b) => { const r = b.getBoundingClientRect(); return t.right > r.left + 0.5 || r.right > out.right + 0.5 || r.width < 20 ? [`${line.innerText.slice(0, 30)}: text ${Math.round(t.right)} > button ${Math.round(r.left)} (stack ${Math.round(out.right)})`] : []; });
      }));
      assert.deepEqual(overlaps, [], 'no card text runs under its buttons');
      // The Details of a card hold its "Write in the message box" (a running item of Damon has it as its main button).
      for (const card of [anr, rome2]) await card.locator('summary').click();
      const writeTo = (name) => panel.getByRole('button', { name: `Write in the message box: ${name}`, exact: true });
      assert.equal(await writeTo(LONG).getAttribute('title') ?? await writeTo(LONG).innerText(), 'Write in the message box', 'its label');
      for (const name of ['Call the bank', 'Install ANR', 'Rome flights', 'acme-web']) assert.equal(await writeTo(name).count(), 1, `→ on ${name}`);
      assert.equal(await panel.getByRole('button', { name: 'Give to the assistant: Pay rent', exact: true }).count(), 1, 'a note of the user keeps Give to the assistant');
      await clear(); await page.keyboard.type('Draft note', { delay: 5 }); await page.keyboard.press('Escape');
      const sent = calls.length;
      const composerText = async () => (await input.innerText()).replace(/\n+/g, '\n').trim();
      await writeTo('Install ANR').click();
      await until(async () => (await composerText()).includes('Reason: Needs the game folder path'), 'the item in the composer');
      assert.match(await composerText(), /^Draft note\nTo-do: Install ANR\nWho does it: Damon\nState: Waiting for you · \d+ (sec|min)\nReason: Needs the game folder path$/, 'the draft, then the item, one field per line');
      assert.equal(await input.evaluate((el) => el.contains(document.activeElement) || el === document.activeElement), true, 'the focus is in the composer');
      await page.keyboard.type(' (asked)', { delay: 5 });
      assert.match(await composerText(), /path \(asked\)$/, 'the caret is at the end');
      await writeTo('Rome flights').focus(); await page.keyboard.press('Enter');
      await until(async () => /Task: Rome flights\nState: Done · \d+ (sec|min)\nResult: Flights found: 3 options$/.test(await composerText()), 'Enter writes the task');
      await writeTo('acme-web').focus(); await page.keyboard.press('Space');
      await until(async () => /\nProject: acme-web\n(\d+ chats changed|Summary: .+)$/.test(await composerText()), 'Space writes the project');
      await pause(1500);
      assert.equal(calls.length, sent, 'nothing was sent');
      const ids = [sessionId, ...JSON.parse(await readFile(join(dshHome, 'storages/dsh-composer-plus/assistant-todos.json'), 'utf8')).lists[sessionId].map((i) => i.id)];
      const all = await composerText(); for (const id of ids) assert.ok(!all.includes(id), `no id (${id}) in the text`);
      await page.mouse.move(640, 790);
      await panel.locator('.cp-st-body').evaluate((el) => { el.scrollTop = 0; });
      if (process.env.SHOT_PANEL) { await page.screenshot({ path: process.env.SHOT_PANEL }); note(`SHOT_PANEL: ${process.env.SHOT_PANEL}`); }
      await clear();
      note('10: "Write in the message box" on the assistant\'s cards, tasks and projects writes the data (click, Enter, Space) after the draft, focus at the end, nothing sent, no id; a long card title does not run under its buttons');

      assert.deepEqual(errors, [], 'no page errors');
      passed = true;
      console.log(`PASS dsh ${version}`);
    } finally {
      if (!passed && page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      if (!passed) console.log(`  home kept: ${home}\n${log.split('\n').filter((l) => /error|warn|todo/i.test(l)).slice(-30).join('\n')}`);
      await context?.close().catch(() => {});
      child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
      if (passed) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
