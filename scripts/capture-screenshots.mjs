// Capture one screenshot per feature from a throwaway dsh with a fake model and made-up demo projects.
// Nothing personal: DSH_HOME, projects, chats and the model are all synthetic and deleted afterwards.
// PLAYWRIGHT=/path/to/playwright node scripts/capture-screenshots.mjs /path/to/dsh/lib/bin.js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass the dsh CLI entry path');
const { chromium } = require(process.env.PLAYWRIGHT);
const bin = process.argv[2];
const repo = fileURLToPath(new URL('..', import.meta.url));
const out = join(repo, 'assets/features');
const docs = join(repo, 'docs/images'); // README-only pictures, not shipped in the npm package
const only = process.env.ONLY?.split(',');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake OpenAI-compatible model: short replies; "use bash" asks for a tool; reviewer always denies ---
const REPLIES = {
  'Fix the login redirect loop': 'The redirect loop came from `/login` sending authenticated users back to itself. I changed `src/auth.ts` to redirect to `/dashboard` and added a test.',
  'Add dark mode to the settings page': 'Added a theme switch in `src/settings.tsx` and CSS variables for both themes.',
  'Write release notes for v2.4': 'Draft ready: three fixes, one new chart type and a faster export.',
};
let slow = 0;
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const payload = JSON.parse(body); const msgs = payload.messages ?? []; const last = msgs.at(-1);
    const users = msgs.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    const lastUser = users.filter((u) => !/runtime context|session title/i.test(u)).at(-1) ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo' };
    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } } : {}) })}\n\n`);
    const end = () => res.end('data: [DONE]\n\n');
    if (/final authorization reviewer|REVIEW_POLICY/.test(body)) { send({ role: 'assistant', content: '{"risk":"medium","decision":"deny","reason":"Pushes to a remote branch."}' }); send({}, 'stop'); end(); return; }
    if (/session title/i.test(JSON.stringify(last?.content))) { const k = Object.keys(REPLIES).find((x) => lastUser.includes(x)); send({ role: 'assistant', content: k ?? 'Demo task' }); send({}, 'stop'); end(); return; }
    if (last?.role !== 'tool' && /push the release branch/.test(lastUser)) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ description: 'Push the release branch', command: 'git push origin release/2.4' }) } }] });
      send({}, 'tool_calls'); end(); return;
    }
    const key = Object.keys(REPLIES).find((x) => lastUser.includes(x));
    setTimeout(() => { send({ role: 'assistant', content: key ? REPLIES[key] : 'Done.' }); send({}, 'stop'); end(); }, slow);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;

// --- throwaway home with demo projects (git repos with a few changes) ---
// dsh compares workspace paths after realpath (macOS /tmp → /private/tmp).
const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-shots-')));
const profile = join(home, 'profiles/web');
await mkdir(join(profile, 'node_modules'), { recursive: true });
await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'shots', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-auto-review', 'dsh-composer-plus'] } } }));
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
const projects = ['acme-web', 'weather-cli', 'docs-site'];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' } });
const ids = {};
for (const name of projects) {
  const dir = join(home, 'projects', name); await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/auth.ts'), "export function afterLogin(user) {\n  if (!user) return '/login';\n  return '/login';\n}\n");
  await writeFile(join(dir, 'README.md'), `# ${name}\n\nDemo project.\n`);
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'Initial commit');
  await writeFile(join(dir, 'src/auth.ts'), "export function afterLogin(user) {\n  if (!user) return '/login';\n  return '/dashboard';\n}\n");
  await writeFile(join(dir, 'src/auth.test.ts'), "import { afterLogin } from './auth';\n\ntest('goes to the dashboard', () => {\n  expect(afterLogin({ id: 1 })).toBe('/dashboard');\n});\n");
  git(dir, 'add', 'src/auth.ts');
  ids[name] = randomUUID();
}
const now = new Date().toISOString();
await mkdir(join(home, 'storages'), { recursive: true });
await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: projects.map((p) => ids[p]), archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids[projects[0]] },
  tables: { workspaces: Object.fromEntries(projects.map((p) => [ids[p], { path: join(home, 'projects', p), title: p, sessionIds: [], createdAt: now, updatedAt: now }])) },
}));

const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3189', '--no-open'], { cwd: join(home, 'projects', projects[0]), env: { ...process.env, DSH_HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
try {
  for (let i = 0; i < 160 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(log); await pause(250); }
  const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, log);
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await context.addInitScript(() => {
    localStorage.setItem('dsh-composer-plus.features', JSON.stringify({ autoUpdate: false }));
    window.__shown = [];
    window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } constructor(t, o) { window.__shown.push({ t, ...o }); } close() {} };
  });
  const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  for (const name of ['Continue', 'Configure later']) { const x = page.getByRole('button', { name, exact: true }); if (await x.waitFor({ timeout: 3000 }).then(() => 1, () => 0)) await x.click(); }
  const input = page.locator('[data-composer-input]'); await input.waitFor();
  const shot = async (id, clip, dir = out) => {
    if (only && !only.includes(id)) return;
    const png = join(home, `${id}.png`);
    await page.screenshot({ path: png, ...(clip ? { clip } : {}) });
    execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(Math.round((clip?.width ?? 1280) * 1.25)), '0', png, '-o', join(dir, `${id}.webp`)]);
    console.log('shot', id);
  };
  const say = async (text) => { await input.click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
  const box = async (locator, pad = 24) => { const b = await locator.boundingBox(); return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: Math.min(1280 - Math.max(0, b.x - pad), b.width + pad * 2), height: Math.min(800 - Math.max(0, b.y - pad), b.height + pad * 2) }; };
  const whole = { x: 0, y: 0, width: 1280, height: 800 };
  // The composer card only: dsh's stats row below it shows fake-model numbers.
  // The composer card without dsh's stats row (fake-model numbers): crop the seat just above that row.
  const composer = async () => {
    const seat = await page.locator('[data-composer-seat]').first().boundingBox();
    const stats = await page.getByText(/turns? \d+ steps?/).last().boundingBox().catch(() => null);
    const bottom = stats !== null && stats.y > seat.y ? stats.y - 4 : seat.y + seat.height;
    return { x: seat.x - 20, y: seat.y - 14, width: seat.width + 40, height: bottom - seat.y + 14 };
  };

  // The picker opens with the first workspace highlighted; ArrowDown moves through them in sidebar order.
  const pickWorkspace = async (name) => {
    const chooser = page.getByRole('button', { name: /Choose workspace/ });
    if (!await chooser.isVisible().catch(() => false)) return;
    if ((await chooser.innerText()).trim() === name) return;
    await chooser.click(); await page.waitForTimeout(300);
    for (let i = 0; i < projects.indexOf(name); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter'); await page.waitForTimeout(800);
    const label = (await chooser.innerText().catch(() => '')).trim();
    if (label !== name) throw Error(`could not choose ${name} (chip shows "${label}")`);
  };
  // A finished chat in acme-web gives the other features something to show.
  await pickWorkspace('acme-web');
  await say('Fix the login redirect loop');
  if (!await page.getByText('I changed').first().waitFor({ timeout: 20000 }).then(() => true, () => false)) {
    await page.screenshot({ path: join(home, 'debug-first-turn.png') }); throw Error(`first turn did not finish; see ${home}/debug-first-turn.png\n${log.slice(-3000)}`);
  }
  await page.waitForTimeout(800);

  // Input history: an empty composer recalls the sent message with ↑.
  await input.click(); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(300);
  await shot('inputHistory', await composer());
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');

  // Plan toggle: Shift+Tab adds /plan to the draft.
  await input.click(); await page.keyboard.type('refactor the session store'); await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(300);
  await shot('planToggle', await composer());
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');

  // Changes panel in the right sidebar.
  await page.getByRole('button', { name: 'Open right sidebar' }).click(); await page.waitForTimeout(700);
  await page.getByText('Changes', { exact: true }).first().click();
  const panel = page.locator('[data-composer-plus-changes]'); await panel.waitFor({ timeout: 8000 });
  await panel.getByText('src/auth.ts', { exact: true }).click(); await page.waitForTimeout(1200);
  await shot('changesPanel', whole);
  await page.getByRole('button', { name: 'Close right sidebar' }).click().catch(() => {});

  // Copy deeplink: right-click the chat row.
  const row = page.locator('[data-row-key^="session:"]').first();
  await row.click({ button: 'right' }); await page.getByText('Copy deeplink').first().waitFor();
  await shot('copyDeeplink', { x: 0, y: 0, width: 640, height: 420 });
  await page.keyboard.press('Escape');

  // Continue: a stopped turn shows ▶.
  slow = 8000; await say('Add dark mode to the settings page'); await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /^Stop/ }).first().click(); await page.waitForTimeout(1200);
  await shot('continueButton', await composer());

  // Queue drag-and-drop: queue messages while a turn runs.
  await say('Write release notes for v2.4'); await page.waitForTimeout(800);
  for (const t of ['Then update the changelog', 'And bump the version to 2.4.0']) { await say(t); await page.waitForTimeout(400); }
  const head = page.getByText(/queued/i).first(); if (await head.isVisible().catch(() => false)) { await head.click().catch(() => {}); await page.waitForTimeout(500); }
  await page.locator('[data-queue-grip]').first().waitFor({ timeout: 5000 });
  const list = await page.locator('[data-queue-grip]').first().locator('xpath=ancestor::ul[1]').boundingBox(); const seat = await composer();
  await shot('queueReorder', { x: seat.x, y: list.y - 60, width: seat.width, height: seat.y + seat.height - (list.y - 60) });

  // Project status / active projects first: a running chat in weather-cli, project collapsed.
  await page.getByRole('button', { name: /^Stop/ }).first().click().catch(() => {}); await page.waitForTimeout(1500);
  slow = 15000;
  const weather = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'weather-cli' }).first();
  await weather.hover(); await weather.getByRole('button', { name: /New session/ }).click().catch(async () => { await weather.click(); });
  await page.waitForTimeout(800); await pickWorkspace('weather-cli'); await say('Add dark mode to the settings page'); await page.waitForTimeout(2500);
  const proj = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'weather-cli' }).first();
  if ((await proj.getAttribute('aria-expanded')) === 'true') { await proj.click(); await page.waitForTimeout(600); }
  await shot('projectStatus', { x: 0, y: 0, width: 640, height: 420 });
  // README hero: running project on top + Changes panel with a diff, all in one window.
  await page.getByRole('button', { name: 'Open right sidebar' }).click(); await page.waitForTimeout(700);
  await page.getByText('Changes', { exact: true }).first().click().catch(() => {});
  await panel.getByText('src/auth.ts', { exact: true }).click(); await page.waitForTimeout(1200);
  await shot('hero', whole, docs);
  await page.getByRole('button', { name: 'Close right sidebar' }).click().catch(() => {});
  await page.getByRole('button', { name: /^Stop/ }).first().click().catch(() => {}); slow = 0; await page.waitForTimeout(1500);

  // Allow for this chat: Auto Review denies, the card shows the extra button.
  await input.click(); await page.keyboard.type('/permission auto'); await page.keyboard.press('Enter'); await page.waitForTimeout(1000);
  const ack = page.getByRole('dialog').getByRole('checkbox'); if (await ack.count()) await ack.first().click();
  const enable = page.getByRole('dialog').getByRole('button').last(); if (await enable.isVisible().catch(() => false)) { await enable.click(); await page.waitForTimeout(800); }
  await say('push the release branch');
  const card = page.locator('[data-approval-key]'); await card.waitFor({ timeout: 20000 });
  await card.getByRole('button', { name: 'Allow for this chat' }).waitFor({ timeout: 5000 });
  await shot('allowForChat', await box(card, 32));
  await card.getByRole('button', { name: 'Reject' }).click().catch(() => {}); await page.waitForTimeout(1000);

  // Notifications: rendered as a macOS-style banner from the plugin's own notification text.
  await page.evaluate(() => {
    const n = document.createElement('div'); n.id = 'demo-banner';
    n.innerHTML = '<div style="display:flex;gap:12px;align-items:flex-start"><div style="width:38px;height:38px;border-radius:9px;background:linear-gradient(#69B9FF,#324DE2);flex:none"></div><div><div style="font-weight:600">Fix the login redirect loop</div><div style="opacity:.75;margin-top:2px">Approve bash?</div></div><div style="margin-left:auto;opacity:.5;font-size:12px">now</div></div>';
    Object.assign(n.style, { position: 'fixed', top: '16px', right: '16px', width: '340px', padding: '12px 14px', borderRadius: '16px', background: 'rgba(246,246,246,.96)', boxShadow: '0 10px 30px rgba(0,0,0,.18)', font: '13px -apple-system,system-ui,sans-serif', color: '#111', zIndex: 99999 });
    document.body.append(n);
  });
  await shot('notifications', { x: 880, y: 0, width: 400, height: 140 });
  await page.evaluate(() => document.getElementById('demo-banner')?.remove());

  // Settings page: language selector + updates row + switches.
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByText('Composer Plus', { exact: true }).click();
  await page.locator('[data-composer-plus-language]').waitFor();
  // README Settings picture: the feature list with a hover preview open.
  await page.locator('[data-composer-plus-shot="changesPanel"]').hover(); await page.locator('[data-composer-plus-shot-preview]').waitFor();
  await page.waitForTimeout(400); await shot('settings', whole, docs); await page.mouse.move(5, 795);
  await page.locator('[data-composer-plus-language] button[aria-haspopup=menu]').click(); await page.waitForTimeout(400);
  await shot('language', whole); await page.keyboard.press('Escape');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  // Updates: answer the check with a newer demo release so the row shows "available" + "Update now", plus the notification.
  await page.route('**/api/composer-plus.update', (route) => route.fulfill({ json: { name: 'dsh-composer-plus', current: '1.2.0', latest: '1.3.0', managed: true, newer: true, url: 'https://github.com/furkancak1r/dsh-composer-plus/releases' } }));
  await page.reload(); await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByText('Composer Plus', { exact: true }).click();
  const updateRow = page.locator('[data-composer-plus-update]'); await updateRow.waitFor(); await updateRow.getByText('Update now').waitFor({ timeout: 8000 });
  await page.evaluate(() => {
    const n = document.createElement('div'); n.id = 'demo-banner';
    n.innerHTML = '<div style="display:flex;gap:12px;align-items:flex-start"><div style="width:38px;height:38px;border-radius:9px;background:linear-gradient(#7C8CFF,#5B3FE0);flex:none"></div><div><div style="font-weight:600">Composer Plus</div><div style="opacity:.75;margin-top:2px">Composer Plus 1.3.0 is installed. Restart dsh to use it.</div></div></div>';
    Object.assign(n.style, { position: 'fixed', top: '16px', right: '16px', width: '360px', padding: '12px 14px', borderRadius: '16px', background: 'rgba(246,246,246,.97)', boxShadow: '0 10px 30px rgba(0,0,0,.18)', font: '13px -apple-system,system-ui,sans-serif', color: '#111', zIndex: 2147483647 });
    document.body.append(n);
  });
  const r = await updateRow.boundingBox();
  await shot('autoUpdate', { x: r.x - 24, y: 0, width: 1280 - (r.x - 24), height: r.y + r.height + 24 });
  // README language picture: the whole app in Türkçe (last step; later steps would need English labels).
  await page.evaluate(() => document.getElementById('demo-banner')?.remove());
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByText('Composer Plus', { exact: true }).click();
  await page.locator('[data-composer-plus-language] button[aria-haspopup=menu]').click(); await page.getByText('Türkçe', { exact: true }).last().click();
  await page.getByText('Ayarlar', { exact: true }).first().waitFor(); await page.keyboard.press('Escape');
  await page.getByText('Değişiklikler', { exact: true }).first().waitFor({ timeout: 5000 }); // open Changes tab title follows the language
  await page.waitForTimeout(800);
  await shot('language-tr', whole, docs);
  assert.deepEqual(errors, []);
  console.log('done', home);
} finally {
  await browser.close(); child.kill(); fake.close();
  if (!process.env.KEEP) await rm(home, { recursive: true, force: true });
}
