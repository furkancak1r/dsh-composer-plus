// Real-app check of "Assistant to-do list" on each dsh given: a fake model, a throwaway DSH_HOME and HOME, a made-up
// project (acme-web). Never the normal DSH_HOME, no real model. Headless.
// 1. The assistant chat: "Remember: buy milk" → the fake model calls todo_list_add (the assistant has the two tools and
//    Assistant always free lets them run); the request carries the list as runtime context and the section. The panel
//    shows at the right side of the chat (inside dsh's chat body, right of the messages, not in dsh's right sidebar).
// 2. Hand over (→): a normal user message "Do this for me: <item>" goes to the chat, the item moves to the group
//    "Assistant will do", the agent's next request has the item with owner agent.
// 3. "Is it done?" → the fake model calls todo_list_remove (reason completed): the item leaves the panel.
// 4. Remove (×): one click, no dialog, the item is gone. Keyboard: Tab reaches the buttons.
// 5. Reload: the list is still there (Host file). Another chat has no panel and no to-do tools.
// 6. Switch off in Settings: no panel, no tools, no context; on again: the panel is back. No page errors.
// 7. Status: "Morning summary please" → status_summary_set; the card shows today's summary, a project name opens its row
//    (chats, git branch and commits of the made-up repository). "Research Rome" → a background subagent: Tasks shows it
//    working, then done with its result, without Refresh. Refresh updates the time. Typing 30 keys does not draw the panel.
// 8. Owner groups: 2 items of the user and 3 of the assistant show in two folding groups ("You will do 2" first, then
//    "Assistant will do 3"), with no owner line in a row; Enter on a header folds it, and it stays folded after a reload.
// PLAYWRIGHT=/path/to/playwright node test/browser-assistant-todos.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/assistantTodos.webp (English UI, made-up project).
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
    const context = msgs.filter((m) => m.role === 'user' && /^Current runtime context/.test(textOf(m.content).trim())).map((m) => textOf(m.content)).at(-1) ?? '';
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
    if (/Is the milk done\?/.test(newest) && !after) {
      const id = /- ([0-9a-f]{8}) \(owner \w+\): "Buy milk"/.exec(context)?.[1] ?? 'ffffffff';
      return tool('todo_list_remove', { id, reason: 'completed' });
    }
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
let shotDone = false;
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
      const item = (text) => panel.locator('li').filter({ hasText: text });
      const group = (owner) => panel.locator(`ul[id$="-${owner}"] > li`);
      const groupHead = (owner) => panel.locator(`.cp-td-group[data-owner="${owner}"]`);
      const assistantRow = () => page.locator('button[aria-label="Assistant"]');

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
      await item('Buy milk').waitFor({ timeout: 30000 });
      const add = calls.find((c) => /Remember: buy milk/.test(c.newest) && !c.after);
      assert.ok(add.tools.includes('todo_list_add') && add.tools.includes('todo_list_remove'), 'the assistant has the two tools');
      assert.match(add.system, /Assistant to-do list \(Composer Plus\)/, 'the section');
      assert.match(add.system, /todo_list_add, todo_list_remove/, 'Assistant always free names them');
      const addResult = await until(() => calls.find((c) => /Remember: buy milk/.test(c.newest) && c.after), 'the tool result reached the model');
      assert.match(addResult.result, /^Added [0-9a-f]{8} \(owner user\)/, 'Assistant always free lets the tool run');
      // The panel sits inside dsh's chat body, right of the messages, and not in dsh's right sidebar.
      assert.equal(await panel.count(), 1);
      assert.equal(await panel.evaluate((el) => el.parentElement?.hasAttribute('data-conversation-content')), true, 'in the chat body');
      const box = await panel.boundingBox(); const bodyBox = await page.locator(`[data-conversation-content][data-conversation-session="${sessionId}"]`).boundingBox();
      assert.ok(box.x + box.width <= bodyBox.x + bodyBox.width + 1 && box.x > bodyBox.x + bodyBox.width / 2, `at the right side of the chat (${JSON.stringify(box)} in ${JSON.stringify(bodyBox)})`);
      assert.equal(await group('user').filter({ hasText: 'Buy milk' }).count(), 1, 'in the group "You will do"');
      // The panel covers no message: each user bubble ends left of it.
      for (const bubble of await page.getByText('Remember: buy milk', { exact: true }).all()) {
        const b = await bubble.boundingBox(); assert.ok(b === null || b.x + b.width <= box.x, `a message under the panel: ${JSON.stringify(b)} / ${JSON.stringify(box)}`);
      }
      note('1: todo_list_add from the agent shows in the panel at the right of the chat');

      // 2. Hand over.
      await send('Remember: call the bank'); await item('Call the bank').waitFor({ timeout: 30000 });
      await until(async () => !(await page.evaluate(() => document.querySelector('[data-composer-input]') === null)), 'idle');
      const before = calls.length;
      await page.getByRole('button', { name: 'Give to the assistant: Call the bank', exact: true }).click();
      await until(async () => (await group('agent').filter({ hasText: 'Call the bank' }).count()) === 1, 'owner agent: in the assistant\'s group');
      await until(async () => calls.slice(before).some((c) => /^Do this for me: Call the bank$/.test(c.newest.trim())), 'the hand-over message reached the agent');
      const handed = calls.slice(before).find((c) => /^Do this for me: Call the bank$/.test(c.newest.trim()));
      assert.match(handed.context, /\(owner agent\): "Call the bank"/, 'the agent sees the new owner');
      await page.getByText('Do this for me: Call the bank').first().waitFor({ timeout: 10000 });
      assert.equal(await page.getByRole('button', { name: 'Give to the assistant: Call the bank' }).count(), 0, 'no hand over for an item of the assistant');
      note('2: → sends "Do this for me: …" as a user message and the owner becomes the assistant');

      // 3. The agent removes a done item.
      await send('Is the milk done?');
      await until(async () => (await item('Buy milk').count()) === 0, 'the agent removed the done item', 30000);
      assert.match((await until(() => calls.find((c) => /Is the milk done\?/.test(c.newest) && c.after), 'remove result')).result, /^Removed [0-9a-f]{8} \(completed\): "Buy milk"/);
      note('3: todo_list_remove from the agent (reason completed) removes the item');

      // 4. Remove with one click, and the keyboard reaches the buttons.
      await send('Remember: buy milk'); await item('Buy milk').waitFor({ timeout: 30000 });
      const removeButton = page.getByRole('button', { name: 'Remove: Buy milk', exact: true });
      await removeButton.focus(); assert.equal(await removeButton.evaluate((b) => b === document.activeElement), true, 'keyboard focus');
      await page.keyboard.press('Enter');
      await until(async () => (await item('Buy milk').count()) === 0, 'removed');
      assert.equal(await page.getByRole('dialog').count(), 0, 'no confirmation dialog');
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-composer-plus-todos]') !== null), true, 'F-02: the focus stays in the panel');
      note('4: × removes at once (keyboard Enter), no dialog');

      // 5. Reload: the list stays. Another chat: no panel, no tools.
      await page.reload(); await input.waitFor({ timeout: 20000 });
      await assistantRow().click();
      await item('Call the bank').waitFor({ timeout: 20000 });
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
      await item('Call the bank').waitFor({ timeout: 20000 });
      note('6: off removes the panel, the tools, the section and the context; on brings the list back');

      // 7. Status.
      gate.open = false;
      await send('Morning summary please');
      const card = panel.locator('.cp-st-summary');
      await card.waitFor({ timeout: 30000 });
      assert.match(await card.innerText(), /Login page is done; tests pass\./);
      assert.match((await until(() => calls.find((c) => /Morning summary please/.test(c.newest) && c.after), 'summary result')).result, /summary of 1 projects/);
      // The other chat of acme-web (step 5) changed today: its project row; the summary's link opens it.
      await card.getByRole('button', { name: 'acme-web', exact: true }).click();
      const row = panel.getByRole('button', { name: /acme-web/ }).and(panel.locator('[aria-expanded]'));
      await until(async () => (await row.getAttribute('aria-expanded')) === 'true', 'the project row opens');
      const detail = panel.locator('.cp-st-detail');
      await detail.getByText('feature/login').first().waitFor({ timeout: 15000 });
      assert.match(await detail.innerText(), /Add the login page/);
      assert.ok(await detail.getByRole('button').count() >= 1, 'its chats are buttons');
      // A background subagent task: working, then done with its result (no Refresh).
      await send('Research Rome');
      const task = panel.locator('li').filter({ hasText: 'Rome flights' });
      await task.waitFor({ timeout: 30000 });
      await until(async () => /Working/.test(await task.innerText()), 'the task shows as working', 20000);
      gate.open = true;
      await until(async () => /Done/.test(await task.innerText()) && /Flights found: 3 options/.test(await task.innerText()), 'the task shows done with its result', 30000);
      // Refresh updates the time; the button has its name.
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
      assert.match(await panel.locator('h2').innerText(), /Updated/);
      // Refresh reads the open project's git details again: wait until they are back before the typing check.
      await detail.getByText('feature/login').first().waitFor({ timeout: 15000 }); await pause(1500);
      // Typing does not draw the panel: count DOM changes in the panel while 30 keys go into the composer.
      await page.evaluate(() => { window.__cpMut = 0; const el = document.querySelector('[data-composer-plus-todos]'); window.__cpObs = new MutationObserver((m) => { window.__cpMut += m.length; }); window.__cpObs.observe(el, { subtree: true, childList: true, characterData: true, attributes: true }); });
      await clear(); await page.keyboard.type('typing does not draw the panel', { delay: 10 });
      const mutations = await page.evaluate(() => { window.__cpObs.disconnect(); return window.__cpMut; });
      assert.equal(mutations, 0, `the panel changed ${mutations} times while typing`);
      await clear();
      note('7: summary card and project link (chats, git), a subagent task working then done, Refresh, no panel change while typing');

      // 8. Owner groups: 2 items of the user and 3 of the assistant ("Call the bank" from step 2 and two new ones).
      await send('Fill the list');
      await until(async () => (await group('user').count()) === 2 && (await group('agent').count()) === 3, 'two groups with 2 and 3 items');
      const heads = panel.locator('.cp-td-group');
      assert.deepEqual(await heads.evaluateAll((els) => els.map((b) => [b.dataset.owner, b.getAttribute('aria-expanded'), b.innerText.replace(/\s+/g, ' ').trim()])),
        [['user', 'true', '▾ You will do 2'], ['agent', 'true', '▾ Assistant will do 3']], 'the user\'s group first, both open, with counts');
      assert.deepEqual(await group('user').locator('.cp-td-text').allInnerTexts(), ['Pay rent', 'Call mom']);
      assert.deepEqual(await group('agent').locator('.cp-td-text').allInnerTexts(), ['Call the bank', 'Book flights', 'Draft the report']);
      assert.doesNotMatch(await panel.locator('section[aria-labelledby$="-todos"]').innerText(), /You do it|The assistant does it/, 'no owner line in a row');
      assert.equal(await group('agent').getByRole('button', { name: /^Give to the assistant/ }).count(), 0, '→ only on the user\'s items');
      // Keyboard: Enter on a header folds its group; the fold stays after a reload.
      await groupHead('agent').focus(); await page.keyboard.press('Enter');
      await until(async () => (await groupHead('agent').getAttribute('aria-expanded')) === 'false', 'folded');
      assert.equal(await group('agent').first().isVisible(), false, 'the folded list is hidden'); assert.equal(await group('user').first().isVisible(), true);
      await page.reload(); await input.waitFor({ timeout: 20000 }); await assistantRow().click();
      await groupHead('agent').waitFor({ timeout: 20000 });
      assert.equal(await groupHead('agent').getAttribute('aria-expanded'), 'false', 'still folded after a reload');
      await groupHead('agent').click(); await until(async () => (await group('agent').first().isVisible()), 'open again');
      await page.mouse.move(640, 790); // no hover color in the screenshot
      note('8: "You will do" (2) above "Assistant will do" (3), no owner line, Enter folds a group and it stays folded after a reload');

      if (process.env.SHOT && !shotDone) {
        const png = join(home, 'todos.png');
        await page.screenshot({ path: png });
        execFileSync('cwebp', ['-quiet', '-q', '72', '-resize', '960', '0', png, '-o', join(repo, 'assets/features/assistantTodos.webp')]);
        shotDone = true; note('SHOT: assets/features/assistantTodos.webp');
      }
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
