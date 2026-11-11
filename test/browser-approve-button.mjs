// Real-app check of the Approve button on each dsh given: a fake model, a throwaway DSH_HOME, a made-up project (demo-app).
// Never the normal DSH_HOME, no real model. Headless, with Chromium's sandbox.
// 1. The model's request has the prompt rule (# Approve button (Composer Plus), the `onay` block).
// 2. An answer with an `onay` block: dsh shows the block as code; under the answer one "Approve" button with the sentence,
//    in dsh's turn tail. Text in the composer hides it.
// 3. A double click sends one user message: the exact sentence reaches the model once and shows as your message; the
//    button goes; your message gets no button.
// 4. An answer whose sentence names a live target (npm publish): its button shows too (owner, 2026-11-11). The older
//    answer shows none.
// 5. Switched off (the Host switch): the next request has no rule and an `onay` answer shows no button.
// 6. A long sentence (the owner's, 2026-11-10: "Onayla" broke into "Onay / la" and the sentence was cut with "…") at
//    window widths 600, 940 and 1280: the label of each of the 13 languages stays on one line and is not cut; the button
//    shows the whole sentence, with no clipping and no ellipsis, and its last line is in view.
// 7. The owner's report (2026-11-11, Assistant chat: "onay butonu çıkmıyor kod bloğu çıkıyor"): the answer with the
//    `onay` block is in the middle of its turn (the model writes it with a tool call, then the turn goes on and ends with
//    "Done."). The button still shows, under the turn's end, and a click sends the sentence.
// 8. The `onay` answer ends its turn while a background subagent runs; the subagent's result then starts a new turn that
//    ends with "X finished." (owner, 2026-11-11: "onay butonu çıkmıyor"). The button of the earlier turn's sentence shows.
// 9. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-approve-button.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/approveButton.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, stat } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
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
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(200); }
};

const SENTENCE = (n) => `Approve: push the branch feature/login-fix-${n} of demo-app to origin.`;
const LIVE = 'Approve: run npm publish for demo-app.';
const MID = 'Onaylıyorum: Composer Plus kategori filtresi önerilen 8 kategoriyle yapılsın, sonraki sürüme girsin.';
const LATER = 'Onaylıyorum: demo-app için feature/later dalını origin\'e push et.';
const LONG = 'Onaylıyorum: bu turda Composer Plus Asistan iyileştirme otomasyonunu yeniden başlat; salt okunur inceleme alt ajanı, yeni bulguları tek tek doğrulasın, sorun yoksa dalı push etsin, main ile birleştirsin ve yerel kopyayı yedekleyip güncellesin.';
// The button label of each language: en and zh in client.js, the 11 others in locales/<id>.json.
const LABELS = [...readFileSync(join(repo, 'client.js'), 'utf8').matchAll(/'approve\.button': '([^']+)'/g)].map((m) => m[1])
  .concat(readdirSync(join(repo, 'locales')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(repo, 'locales', f), 'utf8'))['dsh-composer-plus']['approve.button']));
assert.equal(new Set(LABELS).size, 13, `13 labels: ${LABELS}`);
const ANSWER = (sentence) => `The login fix is ready on its branch. Pushing it needs your approval:\n\n\`\`\`onay\n${sentence}\n\`\`\`\n`;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const RULE = '# Approve button (Composer Plus)';
// Fake OpenAI-compatible model: "approve:<n>" and "live" answer with an `onay` block; the rest answers "Done.". Every chat
// request is kept (`calls`): its last user text and whether the system prompt had the rule.
const calls = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    // Text and a tool call in one answer: dsh runs the tool and the turn goes on (the answer is not the turn's last).
    const sayThenTool = (t) => { send({ role: 'assistant', content: t }); send({ tool_calls: [{ index: 0, id: 'call_mid_todo', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'Plan the category filter', status: 'pending' }] }) } }] }); send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
    const all = JSON.stringify(msgs);
    if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Login fix');
    if (/You predict the next message|You complete the message that the user is typing|next message that the user will type/.test(all)) return say('');
    const users = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter((u) => !/runtime context|Time sampled while preparing/i.test(u));
    const last = users.at(-1) ?? '';
    calls.push({ last, rule: all.includes(RULE) });
    const n = last.match(/^approve:(\d+)$/)?.[1];
    if (n) return say(ANSWER(SENTENCE(n)));
    if (last === 'live') return say(ANSWER(LIVE));
    if (last === 'long') return say(ANSWER(LONG));
    if (last === 'mid') return msgs.at(-1)?.role === 'tool' ? say('Done.') : sayThenTool(ANSWER(MID));
    // 8: a background subagent, then the `onay` answer ends the turn; the child answers later, its result starts a new turn.
    if (last === 'later') {
      if (msgs.at(-1)?.role === 'tool') return say(ANSWER(LATER));
      const background = (parsed.tools ?? []).find((t) => t.function?.name === 'subagent')?.function?.parameters?.properties?.run_in_background !== undefined;
      send({ tool_calls: [{ index: 0, id: 'call_later_sub', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ description: 'Check demo-app', prompt: 'sleep-child: check demo-app.', ...(background ? { run_in_background: true } : {}) }) } }] });
      send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    if (last.includes('sleep-child')) { setTimeout(() => say('Child done.'), 3000); return; }
    if (/Background subagent .* finished/.test(last)) return say('X finished.');
    return say('Done.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  for (const [index, bin] of process.argv.slice(2).entries()) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-approve-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'approve-button-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    const project = join(home, 'projects', 'demo-app'); await mkdir(project, { recursive: true });
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3207', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"idleSwitch":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^(Continue|Devam et)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
        const b = page.getByRole('button', { name });
        if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); }
      }
      const input = page.locator('[data-composer-input]'); await input.waitFor();
      const typeSend = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
      const approve = page.locator('[data-composer-plus-approve]');

      // 1–2. The rule in the request; an answer with an `onay` block gets one Approve button in dsh's turn tail.
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(600);
      await typeSend('approve:1');
      await page.getByText(SENTENCE(1), { exact: true }).first().waitFor({ timeout: 20000 });
      assert.ok(calls.find((c) => c.last === 'approve:1')?.rule, 'the request carries the prompt rule');
      await approve.waitFor({ timeout: 20000 });
      const button = approve.locator('button');
      assert.equal(await button.count(), 1, 'one button for one block');
      assert.equal((await button.innerText()).replace(/\s+/g, ' ').trim(), `Approve ${SENTENCE(1)}`, 'the label and the sentence');
      assert.equal(await approve.evaluate((e) => e.closest('[data-turn-tail]') !== null), true, 'in dsh\'s turn tail, under the answer');
      assert.ok(await page.locator('.md-code-block').filter({ hasText: SENTENCE(1) }).count() >= 1, 'dsh shows the block as code, unchanged');
      if (index === 0 && process.env.SHOT) {
        await page.mouse.move(1200, 120); await pause(600);
        const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
        const top = await rect(page.getByText('The login fix is ready on its branch.', { exact: false }).first()); const bottom = await rect(approve);
        const area = { x: Math.max(0, top.x - 24), y: Math.max(0, top.y - 20), width: 760, height: Math.min(420, bottom.bottom - top.y + 40) };
        const png = join(home, 'approveButton.png'); await page.screenshot({ path: png, clip: area });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round(area.width * 1.25)), '0', png, '-o', join(repo, 'assets/features/approveButton.webp')]);
        console.log(`shot: assets/features/approveButton.webp ${(await stat(join(repo, 'assets/features/approveButton.webp'))).size} bytes`);
      }
      // Text in the composer hides it; an empty composer shows it again.
      await input.click(); await page.keyboard.type('hm'); await approve.waitFor({ state: 'detached', timeout: 5000 });
      await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await approve.waitFor({ timeout: 5000 });

      // 3. A double click sends the exact sentence once, as your message.
      const before = calls.length;
      await button.dblclick();
      await page.getByText('Done.', { exact: true }).last().waitFor({ timeout: 20000 }); await pause(1500);
      const sent = calls.slice(before).filter((c) => c.last.includes('feature/login-fix-1'));
      assert.equal(sent.length, 1, `one message: ${JSON.stringify(calls.slice(before).map((c) => c.last))}`);
      assert.equal(sent[0].last, SENTENCE(1), 'the exact sentence');
      const mine = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: SENTENCE(1) });
      assert.equal(await mine.count(), 1, 'a normal message of yours in the chat');
      assert.equal(await approve.count(), 0, 'sent: no button, and your message has none');

      // 4. A live target: the button shows too; the older answer shows none.
      await typeSend('live');
      await page.getByText(LIVE, { exact: true }).first().waitFor({ timeout: 20000 }); await approve.waitFor({ timeout: 20000 });
      assert.equal(await approve.count(), 1, 'a live sentence gets its button');
      assert.equal((await approve.locator('button').innerText()).replace(/\s+/g, ' ').trim(), `Approve ${LIVE}`, 'the label and the live sentence');
      assert.ok(await page.locator('.md-code-block').filter({ hasText: LIVE }).count() >= 1, 'the block shows as code');
      await typeSend('approve:2'); await page.getByText(SENTENCE(2), { exact: true }).first().waitFor({ timeout: 20000 });
      await approve.waitFor({ timeout: 20000 });
      assert.equal(await approve.count(), 1, 'only the newest answer has buttons');
      assert.equal((await approve.locator('button').innerText()).includes(SENTENCE(2)), true);
      await page.reload(); await input.waitFor(); await approve.waitFor({ timeout: 20000 });
      assert.equal(await approve.count(), 1, 'after a reload: the same one button (the chat log is read, not changed)');

      // 5. Switched off (Host switch): no rule in the next request, no button.
      const route = (body) => page.evaluate(async (b) => (await fetch('/api/composer-plus.approve-button', b === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(), body);
      assert.deepEqual(await route(), { on: true }, 'on by default');
      assert.deepEqual(await route({ on: false }), { on: false });
      await page.reload(); await input.waitFor(); await pause(1000);
      await typeSend('approve:3'); await page.getByText(SENTENCE(3), { exact: true }).first().waitFor({ timeout: 20000 }); await pause(2500);
      assert.equal(calls.find((c) => c.last === 'approve:3')?.rule, false, 'off: the request has no rule');
      assert.equal(await approve.count(), 0, 'off: no button');
      assert.deepEqual(await route({ on: true }), { on: true });
      await page.reload(); await input.waitFor(); await approve.waitFor({ timeout: 20000 });

      // 6. A long sentence: each language's label on one line, the whole sentence in view, at 600, 940 and 1280 px.
      await typeSend('long'); await page.getByText(LONG, { exact: true }).first().waitFor({ timeout: 20000 });
      const long = approve.locator('button').filter({ hasText: 'Composer Plus Asistan' });
      await long.waitFor({ timeout: 20000 });
      for (const width of [600, 940, 1280]) {
        await page.setViewportSize({ width, height: 800 }); await pause(400);
        if (process.env.KEEP) await approve.screenshot({ path: join(home, `long-${width}.png`) });
        for (const label of LABELS) {
          // The label's own text node gets each language's text (React keeps the node), then the old text again.
          const m = await long.evaluate((b, label) => {
            const strong = b.querySelector('strong'); const span = b.querySelector('.cp-op-n'); const was = strong.firstChild.nodeValue;
            strong.firstChild.nodeValue = label;
            const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); const rects = [...r.getClientRects()].filter((x) => x.width > 0);
              return { count: new Set(rects.map((x) => Math.round(x.top))).size, bottom: Math.max(...rects.map((x) => x.bottom)) }; };
            const box = b.getBoundingClientRect(); const tail = b.closest('[data-turn-tail]').getBoundingClientRect();
            const out = { label: lines(strong).count, labelCut: strong.scrollWidth > strong.clientWidth + 1, text: span.textContent,
              clipped: span.scrollHeight > span.clientHeight + 1 || span.scrollWidth > span.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1,
              ellipsis: [b, strong, span].some((e) => getComputedStyle(e).textOverflow === 'ellipsis' || getComputedStyle(e).webkitLineClamp !== 'none'),
              lastLine: lines(span).bottom, bottom: box.bottom, inside: box.left >= tail.left - 1 && box.right <= tail.right + 1 };
            strong.firstChild.nodeValue = was;
            return out;
          }, label);
          const at = `${width} px, "${label}"`;
          assert.equal(m.label, 1, `${at}: the label is on one line`);
          assert.equal(m.labelCut, false, `${at}: the label is not cut`);
          assert.equal(m.text, LONG, `${at}: the button shows the whole sentence`);
          assert.equal(m.clipped, false, `${at}: no clipped text`); assert.equal(m.ellipsis, false, `${at}: no ellipsis or line clamp`);
          assert.ok(m.lastLine <= m.bottom, `${at}: the last line is inside the button`); assert.ok(m.inside, `${at}: the button stays in the chat column`);
        }
      }
      await page.setViewportSize({ width: 1280, height: 800 });

      // 7. The approval in the middle of the turn: the turn ends with "Done.", the button is under the turn's end.
      // dsh folds the earlier answer into "Completed in …" (the block is in the page, not visible).
      const dones = page.getByText('Done.', { exact: true }); const doneBefore = await dones.count();
      await typeSend('mid'); await page.getByText(MID, { exact: true }).first().waitFor({ state: 'attached', timeout: 20000 });
      await until(async () => (await dones.count()) > doneBefore, 'the turn goes on and ends with Done.');
      const midButton = approve.locator('button').filter({ hasText: MID });
      await midButton.waitFor({ timeout: 20000 });
      assert.equal(await approve.count(), 1, 'one button group, under the turn end');
      assert.equal((await midButton.innerText()).replace(/\s+/g, ' ').trim(), `Approve ${MID}`, 'the label and the sentence of the earlier answer');
      const before7 = calls.length; await midButton.click();
      await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: MID }).first().waitFor({ timeout: 20000 }); await pause(1500);
      assert.equal(calls.slice(before7).filter((c) => c.last === MID).length, 1, 'the click sends the sentence once');

      // 8. The approval of an earlier turn, then a new turn from a subagent's result: the button still shows.
      await until(async () => (await dones.count()) > doneBefore + 1, 'the answer to the sent sentence');
      await approve.waitFor({ state: 'detached', timeout: 20000 }); await pause(1000);
      await typeSend('later'); await page.getByText(LATER, { exact: true }).first().waitFor({ state: 'attached', timeout: 20000 });
      await page.getByText('X finished.', { exact: true }).first().waitFor({ timeout: 30000 });
      const tails = page.locator('[data-turn-tail]');
      await until(async () => (await tails.last().locator('[data-composer-plus-approve] button').filter({ hasText: LATER }).count()) === 1, 'the button in the newest turn\'s tail');
      assert.equal(await approve.count(), 1, 'one button group, under the newest turn');
      assert.ok(calls.some((c) => /Background subagent .* finished/.test(c.last)), 'the new turn came from the subagent\'s result');
      assert.equal(await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'Background subagent' }).count(), 0, 'dsh does not show the result as your message');

      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; calls: ${JSON.stringify(calls.slice(-6))}`);
      throw error;
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log); // the token stays inside the temporary home, never stdout
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
