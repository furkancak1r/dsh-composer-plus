// Real-app check of "Goal check" on each dsh given: a fake model (agent + verifier), a throwaway DSH_HOME, a made-up git
// project (acme-web) whose `npm test` fails until logout.js exists. Never the normal DSH_HOME, no real model. Headless.
// 1. `/goal …` → round 1: the model calls update_goal complete at once → the Host runs `npm test` (exit 1) and denies:
//    "Goal check failed … `npm test` exited with code 1"; no verifier call; the goal bar and the Goal check row stay.
// 2. Round 2: write logout.js, `npm test` (passes), complete → the Host does not run the test again (test.js counts its
//    runs), one verifier call answers "not done" (README) → the model reads the gap; the goal stays active.
// 4. Between rounds 2 and 3: the row shows the failed verifier result; Run now updates it; Edit → Token limit → Save posts
//    {sessionId, check: {tokens}}; Clear posts check: null.
// 3. Round 3: README edit, `npm test`, complete → the verifier passes (its input has the goal, git status and the chat
//    log) → the goal completes: dsh's goal bar and the row go away.
// 5. Budget: a new chat, `/goal`, token limit 1 through the row → after one round dsh's goal bar shows a blocked goal.
// 6. Goal check off in Settings: complete passes at once (no test run, no verifier call); then on again.
// 7. No page errors.
// PLAYWRIGHT=/path/to/playwright node test/browser-goal-check.mjs /path/to/dsh/lib/bin.js [...]
// SHOT=1 also writes assets/features/goalCheck.webp (English UI, made-up project).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, stat } from 'node:fs/promises';
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

const OBJECTIVE = { A: 'Make the tests pass and add a logout button', B: 'Keep the footer tidy', C: 'Ship the footer link' };
const LOGOUT = 'export function logout(session) { session.clear(); }\n';
const README2 = '# acme-web\nA demo web shop.\n\n## Logout\nThe header has a logout button (`logout.js`).\n';
const verdict = (pass, missing, reason) => JSON.stringify({ pass, missing, reason });

// Fake OpenAI-compatible model. The agent's steps per goal round are scripted; a held round waits for the test.
const seen = []; // {kind, input}
const emitted = new Map(); // tool call id → {chat, round, name}
const updates = new Map(); // update_goal call id → {chat, round, text}
const holds = new Map(); // 'A2' → {promise, release}
const waiting = new Set();
let verdicts = [];
const hold = (key) => { let release; const promise = new Promise((r) => { release = r; }); holds.set(key, { promise, release }); };
const release = (key) => { holds.get(key)?.release(); holds.delete(key); };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const PLANS = {
  A1: ['get_goal', 'update_goal'],
  A2: ['get_goal', ['write', { file_path: 'logout.js', content: LOGOUT }], ['bash', { command: 'npm test', description: 'Run the tests' }], 'update_goal'],
  A3: ['get_goal', ['read', { file_path: 'README.md' }], ['write', { file_path: 'README.md', content: README2 }], ['bash', { command: 'npm test', description: 'Run the tests' }], 'update_goal'],
  C1: ['get_goal', 'update_goal'],
};
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
    const system = textOf(msgs.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    const all = JSON.stringify(msgs);
    const kind = system.startsWith('You are an independent verifier') ? 'verifier' : /You predict the next message|You complete the message that the user is typing/.test(all) ? 'predict'
      : /session title/i.test(textOf(msgs.at(-1)?.content)) ? 'title' : 'chat';
    seen.push({ kind, input: textOf(msgs.at(-1)?.content) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
    const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
    if (kind === 'verifier') return say(verdicts.shift() ?? verdict(true, [], 'All parts are done.'));
    if (kind === 'predict') return say('');
    if (kind === 'title') return say('Goal work');
    // The update_goal results that dsh sent back (the model reads them).
    const ids = new Set();
    for (const m of msgs) {
      for (const tc of m.tool_calls ?? []) if (tc.function?.name === 'update_goal') ids.add(tc.id);
      if (m.role === 'tool' && ids.has(m.tool_call_id) && !updates.has(m.tool_call_id)) updates.set(m.tool_call_id, { ...emitted.get(m.tool_call_id), text: textOf(m.content) });
    }
    const at = msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content).includes('<goal_round>'));
    if (at < 0) return say('Ready.');
    const prompt = textOf(msgs[at].content);
    const objective = JSON.parse(prompt.match(/Objective: (".*?")\n/)[1]);
    const chat = Object.keys(OBJECTIVE).find((k) => OBJECTIVE[k] === objective) ?? '?';
    const round = Number(prompt.match(/Round: (\d+)\//)[1]);
    const key = `${chat}${round}`;
    const step = msgs.slice(at + 1).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    if (step === 0 && holds.has(key)) { waiting.add(key); await holds.get(key)?.promise; waiting.delete(key); }
    const plan = PLANS[key] ?? [];
    if (step >= plan.length) return say(`Round ${round} of the ${chat} goal ended.`);
    let [name, args] = Array.isArray(plan[step]) ? plan[step] : [plan[step], {}];
    if (name === 'update_goal') {
      const ref = msgs.map((m) => (m.role === 'tool' ? textOf(m.content).match(/"goal":\{"id":"([^"]+)","revision":(\d+)/) : null)).filter(Boolean).at(-1);
      args = { goal_id: ref[1], revision: Number(ref[2]), action: 'complete' };
    }
    const id = `call_${key}_${step}_${randomUUID().slice(0, 6)}`;
    emitted.set(id, { chat, round, name });
    send({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', ...a], { cwd, encoding: 'utf8', env: gitEnv });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const bin of process.argv.slice(2)) {
    seen.length = 0; emitted.clear(); updates.clear(); holds.clear(); waiting.clear(); verdicts = [];
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-goal-check-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'goal-check-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
    // The made-up project: `npm test` counts its runs in .runs.log (git-ignored) and fails until logout.js exists.
    const project = join(home, 'projects', 'acme-web');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'acme-web', private: true, scripts: { test: 'node test.js' } }, null, 2));
    await writeFile(join(project, 'test.js'), "const fs = require('node:fs');\nconst path = require('node:path');\nfs.appendFileSync(path.join(__dirname, '.runs.log'), 'run\\n');\nif (!fs.existsSync(path.join(__dirname, 'logout.js'))) { console.error('not ok 1 - logout.js is missing'); process.exit(1); }\nconsole.log('ok 1 - logout button');\n");
    await writeFile(join(project, 'README.md'), '# acme-web\nA demo web shop.\n');
    await writeFile(join(project, '.gitignore'), '.runs.log\n');
    git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'Add the shop');
    const runs = async () => (await readFile(join(project, '.runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const workspaceId = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: workspaceId },
      tables: { workspaces: { [workspaceId]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    // Full access: the agent's bash calls run without an approval card.
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3204', '--no-open'], { cwd: project, env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', DSH_PERMISSION_MODE: 'danger-full-access', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false; const evidence = [];
    const note = (line) => { evidence.push(line); console.log(`  ${line}`); };
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
      // Branch per chat off: a new chat in this git project would start on a new branch (its default).
      await context.addInitScript(() => { if (localStorage.getItem('dsh-composer-plus.features') === null) localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false}'); });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      const posts = []; const reads = [];
      page.on('request', (r) => {
        if (!r.url().includes('/api/composer-plus.goal-check')) return;
        if (r.method() === 'POST') posts.push(JSON.parse(r.postData() ?? 'null'));
        else { const id = new URL(r.url()).searchParams.get('sessionId'); if (id) reads.push(id); }
      });
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
      const route = (id) => page.evaluate(async (q) => (await fetch(`/api/composer-plus.goal-check${q}`)).json(), id === undefined ? '' : `?sessionId=${encodeURIComponent(id)}`);
      const startGoal = async (objective) => { await input.click(); await page.keyboard.type(`/goal ${objective}`, { delay: 15 }); await page.keyboard.press('Enter'); };
      const verifiers = () => seen.filter((s) => s.kind === 'verifier');
      const updateOf = (chat, round) => [...updates.values()].find((u) => u.chat === chat && u.round === round);
      const bar = page.locator('[data-goal-bar]');
      const row = page.locator('[data-composer-plus-goal-check]');
      // The row's text and its result (status) text and tooltip; null without a row.
      const info = () => page.evaluate(() => {
        const r = document.querySelector('[data-composer-plus-goal-check]'); if (!r) return null;
        const s = r.querySelector('.cp-gc-line > .cp-gc-ok, .cp-gc-line > .cp-gc-bad, .cp-gc-line > [role="status"]');
        return { text: r.innerText, status: s?.textContent ?? '', title: s?.getAttribute('title') ?? '' };
      });
      const barText = () => page.evaluate(() => { const b = document.querySelector('[data-goal-bar]'); return b === null ? null : { text: b.innerText, title: b.querySelector('[title]')?.getAttribute('title') ?? '' }; });

      // Settings: Goal check is on by default and has its own Model menu; prediction off (fewer model calls).
      await settings();
      const predict = page.getByRole('switch', { name: 'Next message prediction' });
      if (await predict.getAttribute('aria-checked') === 'true') await predict.click();
      const goalSwitch = page.getByRole('switch', { name: 'Goal check', exact: true });
      assert.equal(await goalSwitch.getAttribute('aria-checked'), 'true', 'Goal check is on by default');
      const modelMenu = page.locator('[data-composer-plus-prediction-model] button[aria-label="Goal check: Model"]');
      await modelMenu.waitFor({ timeout: 10000 });
      assert.equal(await modelMenu.textContent(), 'Same as the chat\'s model');
      await back();

      // 1. Round 1: complete at once → the Host's npm test fails → deny; no verifier call; the goal stays.
      hold('A2');
      await startGoal(OBJECTIVE.A);
      await bar.waitFor({ timeout: 30000 });
      await row.waitFor({ timeout: 30000 });
      await until(() => waiting.has('A2'), 'round 2 starts');
      const r1 = updateOf('A', 1);
      assert.ok(r1, 'round 1 called update_goal');
      assert.match(r1.text, /Goal check failed/);
      assert.ok(r1.text.includes('`npm test` exited with code 1'), r1.text);
      assert.equal(verifiers().length, 0, 'no verifier call after a failed test');
      assert.equal(await runs(), 1, 'the Host ran npm test once');
      await until(async () => /Test failed \(exit 1\)/.test((await info())?.status ?? ''), 'the row shows the failed test');
      assert.equal(await bar.isVisible(), true, 'dsh goal bar still shows');
      const chatA = reads.at(-1);
      assert.ok(chatA, 'chat id from the row\'s read');
      assert.equal((await route(chatA)).goal.phase, 'active');
      note(`1: round 1 complete → "${r1.text.split('\n')[0].slice(0, 40)}…", "\`npm test\` exited with code 1", verifier calls 0, test runs 1, goal bar + row "✗ Test failed (exit 1)", phase active`);

      // 2. Round 2: the agent's own passing run is used (no new run); the verifier finds a gap.
      verdicts.push(verdict(false, ['README does not mention the logout button'], 'Docs missing'));
      hold('A3'); release('A2');
      await until(() => waiting.has('A3'), 'round 3 starts', 45000);
      const r2 = updateOf('A', 2);
      assert.ok(r2?.text.includes('README does not mention the logout button'), r2?.text);
      assert.match(r2.text, /Goal check failed/);
      assert.equal(await runs(), 2, 'only the agent\'s own npm test ran in round 2');
      assert.equal(verifiers().length, 1, 'one verifier call');
      assert.ok(verifiers()[0].input.includes('The agent\'s own newest run of `npm test` passed'), 'the verifier read the agent\'s own run');
      assert.equal(await readFile(join(project, 'logout.js'), 'utf8'), LOGOUT);
      note('2: round 2 write + npm test + complete → test runs 2 (agent only, Host reused it), verifier calls 1 ("agent\'s own newest run"), result has "README does not mention the logout button", goal active');

      // 4. The row between rounds: the failed verifier result, Run now, Edit → Token limit → Save, Clear.
      await until(async () => /Verifier: not done/.test((await info())?.status ?? ''), 'the row shows the failed verifier');
      assert.match((await info()).title, /README does not mention the logout button/);
      verdicts.push(verdict(false, ['The README has no logout section'], 'Docs still missing'));
      await row.getByRole('button', { name: 'Run now', exact: true }).click();
      await until(async () => /no logout section/.test((await info())?.title ?? ''), 'Run now updates the result');
      assert.equal(verifiers().length, 2, 'Run now called the verifier');
      assert.equal(await runs(), 2, 'Run now used the agent\'s own run');
      assert.deepEqual(posts.at(-1), { sessionId: posts.at(-1).sessionId, run: true });
      await row.getByRole('button', { name: 'Edit', exact: true }).click();
      await row.locator('input[aria-label="Token limit"]').fill('500000');
      await row.getByRole('button', { name: 'Save', exact: true }).click();
      await until(async () => /Budget: [\d,]+ \/ 500,000 tokens/.test((await info())?.text ?? ''), 'the budget shows');
      const saved = posts.find((p) => p?.check !== undefined);
      assert.deepEqual(saved, { sessionId: saved.sessionId, check: { tokens: 500000 } });
      const sessionA = saved.sessionId;
      // The row has the width and the centering of dsh's goal bar: its visible bar is the first child of the
      // `[data-goal-bar]` dock (the dock is wider; the bar inside it has a max-width and margin auto).
      const edges = await page.evaluate(() => {
        const r = document.querySelector('[data-composer-plus-goal-check]').getBoundingClientRect();
        const g = document.querySelector('[data-goal-bar] > div').getBoundingClientRect();
        return { row: [r.left, r.right], bar: [g.left, g.right] };
      });
      assert.ok(Math.abs(edges.row[0] - edges.bar[0]) <= 1 && Math.abs(edges.row[1] - edges.bar[1]) <= 1, `row edges line up with the goal bar: ${JSON.stringify(edges)}`);
      // With the longest status (a failed verifier and a budget), the status line stays one row: Edit, Run now and Clear too.
      const tops = await row.locator('.cp-gc-line').first().evaluate((line) => [line.querySelector('strong'), ...line.querySelectorAll('button')].map((el) => [el.textContent, Math.round(el.getBoundingClientRect().top)]));
      assert.deepEqual(tops.map(([t]) => t), ['Goal check', 'Edit', 'Run now', 'Clear']);
      assert.ok(tops.every(([, top]) => Math.abs(top - tops[0][1]) <= 2), `one line: ${JSON.stringify(tops)}`);
      if (process.env.SHOT) {
        await page.mouse.move(1000, 100); await pause(300);
        const box = async (loc) => loc.boundingBox();
        const b = await box(bar); const r = await box(row);
        const card = await input.evaluate((el) => { const c = (el.closest('[data-composer-card]') ?? el).getBoundingClientRect(); return { x: c.x, y: c.y, width: c.width, height: c.height }; });
        const left = Math.max(0, Math.min(b.x, r.x, card.x) - 16); const right = Math.min(1280, Math.max(b.x + b.width, r.x + r.width, card.x + card.width) + 16);
        // From above the goal bar to just under the composer card (the stats row below it stays out).
        const top = Math.max(0, b.y - 14); const bottom = Math.min(800, Math.max(r.y + r.height, card.y + card.height) + 4);
        const png = join(home, 'goalCheck.png');
        await page.screenshot({ path: png, clip: { x: left, y: top, width: right - left, height: bottom - top } });
        execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.min(960, Math.round((right - left) * 1.25))), '0', png, '-o', join(repo, 'assets/features/goalCheck.webp')]);
        note(`shot: assets/features/goalCheck.webp ${(await stat(join(repo, 'assets/features/goalCheck.webp'))).size} bytes`);
      }
      await row.getByRole('button', { name: 'Clear', exact: true }).click();
      await until(async () => !/Budget:/.test((await info())?.text ?? 'Budget:'), 'Clear removes the budget');
      assert.deepEqual(posts.at(-1), { sessionId: sessionA, check: null });
      note(`4: row "✗ Verifier: not done" (title has the README gap), Run now → title "The README has no logout section" (verifier calls 2, test runs 2), Edit → Token limit 500000 → Save posted ${JSON.stringify({ sessionId: '…', check: { tokens: 500000 } })} and showed the budget, Clear posted check: null`);

      // 3. Round 3: README + npm test + complete → the verifier passes → the goal completes.
      verdicts.push(verdict(true, [], 'The logout button exists, the tests pass and the README documents it.'));
      release('A3');
      await bar.waitFor({ state: 'detached', timeout: 30000 });
      await row.waitFor({ state: 'detached', timeout: 10000 });
      assert.equal((await route(sessionA)).goal.phase, 'complete');
      const r3 = updateOf('A', 3);
      assert.ok(r3 && !/Goal check failed/.test(r3.text) && r3.text.includes('"phase":"complete"'), r3?.text);
      assert.equal(verifiers().length, 3);
      assert.equal(await runs(), 3, 'round 3: the agent\'s own run only');
      const v3 = verifiers()[2].input;
      for (const part of [JSON.stringify(OBJECTIVE.A), 'git status --short', 'logout.js', 'README.md', 'Chat log since the goal started', 'Tool call bash', '[automatic goal round 3]']) assert.ok(v3.includes(part), `the verifier input has ${part}`);
      note('3: round 3 README + npm test + complete → verifier pass → phase complete, goal bar and row gone; verifier input has the objective, "git status --short" (logout.js, README.md) and the chat log; test runs 3');

      // 5. Budget: a token limit of 1 → dsh's own blocked state after one round.
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(800);
      hold('B1');
      await startGoal(OBJECTIVE.B);
      await row.waitFor({ timeout: 30000 });
      await until(() => waiting.has('B1'), 'chat B round 1 starts');
      await row.getByRole('button', { name: 'Edit', exact: true }).click();
      await row.locator('input[aria-label="Token limit"]').fill('1');
      await row.getByRole('button', { name: 'Save', exact: true }).click();
      await until(async () => /Budget: [\d,]+ \/ 1 tokens/.test((await info())?.text ?? ''), 'the budget of 1 shows');
      const savedB = posts.at(-1);
      assert.deepEqual(savedB, { sessionId: savedB.sessionId, check: { tokens: 1 } });
      assert.notEqual(savedB.sessionId, sessionA);
      release('B1');
      await until(async () => (await route(savedB.sessionId)).goal?.phase === 'blocked', 'the goal is blocked');
      const blocked = await until(async () => { const b = await barText(); return /Blocked Goal/.test(b?.text ?? '') && b; }, 'dsh goal bar shows Blocked Goal');
      assert.match(blocked.title, /Goal check budget: the goal used \d+ tokens \(limit 1\)/);
      note(`5: chat B token limit 1 (posted {sessionId, check: {tokens: 1}}) → after one round phase blocked, goal bar "Blocked Goal", title "${blocked.title}"`);

      // 6. Goal check off: complete passes at once; then on again.
      await settings(); await goalSwitch.click();
      await until(async () => (await goalSwitch.getAttribute('aria-checked')) === 'false' && (await route()).on === false, 'switched off');
      await back();
      assert.equal(await row.count(), 0, 'switched off: no row');
      const [vBefore, runsBefore] = [verifiers().length, await runs()];
      await page.locator('button:visible', { hasText: 'New Session' }).first().click(); await pause(800);
      await startGoal(OBJECTIVE.C);
      const c1 = await until(() => updateOf('C', 1), 'chat C completes');
      assert.ok(!/Goal check failed/.test(c1.text) && c1.text.includes('"phase":"complete"'), c1.text);
      assert.equal(verifiers().length, vBefore, 'off: no verifier call');
      assert.equal(await runs(), runsBefore, 'off: no test run');
      await until(async () => (await bar.count()) === 0, 'chat C goal bar gone');
      await settings(); await goalSwitch.click();
      await until(async () => (await goalSwitch.getAttribute('aria-checked')) === 'true' && (await route()).on === true, 'switched on again');
      await back();
      note(`6: switch off → chat C complete passed at once (phase complete, verifier calls ${vBefore} → ${verifiers().length}, test runs ${runsBefore} → ${await runs()}); switch on again (route on: true)`);

      assert.deepEqual(errors, [], 'no browser exceptions');
      note('7: no page errors');
      passed = true;
      console.log(`PASS ${bin}`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      console.error(`kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}; model calls: ${JSON.stringify(seen.map((s) => ({ kind: s.kind, input: s.input.slice(0, 120) })))}; updates: ${JSON.stringify([...updates.values()].map((u) => ({ ...u, text: u.text.slice(0, 200) })))}; waiting: ${[...waiting]}`);
      throw error;
    } finally {
      for (const key of [...holds.keys()]) release(key);
      await context?.close();
      await writeFile(join(home, 'server.log'), log);
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); });
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); fake.close(); }
