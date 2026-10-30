// Real-app check of the open chat's header in a narrow window, on each dsh given (fake model, throwaway DSH_HOME, made-up
// git project, headless). The chat has a running subagent and two background jobs (dsh's header options), its project is
// on a git branch (Composer Plus's ⑂ branch pill) and it has three "Allow for this chat" grants (Composer Plus's chip).
// Without the fit style, from about 760 px the title goes to nothing and dsh's options slide over Open in and the pill.
// 1. Wide (1920, 1600 px: dsh's header fits on one line): the header is the same, item by item, with and without the style.
// 2. Narrow (1280 … 440 px) and a 1440 px window with the right sidebar open: no two header items overlap, each one gets
//    a click at its center, none is outside the header, the title keeps at least 110 px, and the Chat tab gets a click.
// 3. Settings: Branch per chat and Allow for this chat off → their styles and items go; Fit chat header to window alone
//    keeps dsh's own header (subagent + jobs) free of overlap down to 320 px and in a 1280 px window with the right sidebar
//    (without it dsh's buttons overlap there). Then Fit chat header to window off too → no fit style, dsh's own header
//    overlaps again (evidence); all three on again → three styles, 760 px fixed again.
// PLAYWRIGHT=/path/to/playwright node test/browser-header-fit.mjs /path/to/dsh/lib/bin.js [...]
// KEEP=1 keeps the temp home with one PNG per width (`w<width>.png`, `w<width>-nofit.png`). SHOT=1 also writes
// assets/features/headerFit.webp (English UI, demo project; dsh's own 400 px header without and with the style; needs cwebp
// and a python3 with Pillow, or PYTHON=/path/to/python3).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Wide: dsh's own header fits on one line and leaves the title 120 px or more. Narrow: it does not (at 1280 px dsh's header
// leaves this title 12 px).
const WIDE = [1920, 1600];
const NARROW = [1280, 1100, 960, 860, 760, 680, 600, 520, 440];

// Fake model: the chat's first request starts a subagent and two background jobs; the subagent's own request never
// answers (so it keeps running); then the chat says "Started the work.".
const held = [];
const fake = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
    const msgs = JSON.parse(body).messages ?? [];
    const text = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
    const say = (content) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk({ role: 'assistant', content }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); };
    if (/session title/i.test(text(msgs.at(-1)))) { say('Warehouse handover screen for open orders'); return; }
    if (/predict the next message|complete the message|improve a prompt|branch name/i.test(text(msgs[0]))) { say('Thanks'); return; }
    const firstUser = text(msgs.find((m) => m.role === 'user'));
    if (firstUser.includes('Child task')) { held.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); return; } // the subagent keeps running
    if (!msgs.some((m) => m.role === 'tool')) {
      const call = (index, name, args) => ({ index, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', tool_calls: [
        call(0, 'subagent', { description: 'Check order rules', prompt: 'Child task: check the order rules.' }),
        call(1, 'bash', { description: 'Watch the build', command: 'sleep 600', run_in_background: true }),
        call(2, 'bash', { description: 'Watch the tests', command: 'sleep 600', run_in_background: true }),
      ] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
      return;
    }
    say('Started the work.');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => fake.once('listening', r));
const fakePort = fake.address().port;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'maintenance.auto=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' });

/** In the page: the open chat's header row, each item in it (owner, text, box), the pairs that overlap, the items that a
 * click at their center does not reach and the items outside the header. dsh's slot wrappers (`display: contents`) and
 * style tags are skipped. */
function measure() {
  const row = [...document.querySelectorAll('[class*="_titleRow"]')].find((r) => r.querySelector('[class*="_titleCluster"]') && r.getBoundingClientRect().width > 0);
  if (!row) return null;
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }; };
  const flat = (el) => [...el.children].flatMap((c) => (c.tagName === 'STYLE' ? [] : getComputedStyle(c).display === 'contents' ? flat(c) : [c]));
  const title = row.querySelector('[class*="_crumbCurrent"]');
  const items = [{ name: 'title', owner: 'dsh', el: row.querySelector('[class*="_crumbs"]'), text: 'title' }];
  for (const [where, sel] of [['actions', '[class*="_headerActions"]'], ['utilities', '[class*="_headerUtilities"]'], ['corner', '[class*="_headerCorner"]']]) {
    for (const el of flat(row.querySelector(sel) ?? document.createElement('i'))) {
      if (el.getBoundingClientRect().width === 0) continue;
      const cp = el.matches('[data-composer-plus-branch-status], [data-composer-plus-grants], [class*="cp-"]');
      const label = el.getAttribute('aria-label') || el.querySelector('[aria-label]')?.getAttribute('aria-label') || el.textContent;
      items.push({ name: where, owner: cp ? 'CP' : 'dsh', el, text: (label || '').trim().slice(0, 40) });
    }
  }
  const hb = row.getBoundingClientRect();
  const out = items.map((it) => ({ ...it, box: box(it.el) }));
  const overlaps = [];
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i].box, b = out[j].box;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 1 && h > 1) overlaps.push(`${out[i].owner}:${out[i].text} × ${out[j].owner}:${out[j].text} (${w}px)`);
  }
  const unreachable = out.filter((it) => it.name !== 'title').filter((it) => {
    const target = it.el.matches('button, a') ? it.el : it.el.querySelector('button, a') ?? it.el;
    const r = target.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === null || !(target.contains(hit) || hit.contains(target));
  }).map((it) => `${it.owner}:${it.text}`);
  // dsh's corner (the right sidebar button) sits 16 px into the header's right padding on purpose (margin-right: -16px).
  const outside = out.filter((it) => it.box.right > hb.right + 17 || it.box.left < hb.left - 1).map((it) => `${it.owner}:${it.text}`);
  const tab = [...document.querySelectorAll('[data-conversation-tabs] [role="tab"]')].find((b) => b.getBoundingClientRect().width > 0);
  const tr = tab?.getBoundingClientRect(); const tabHit = tr && document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
  if (tab && !(tab === tabHit || tab.contains(tabHit))) unreachable.push('dsh:tab');
  // An item's text on two lines: a button taller than dsh's 28-30 px header controls.
  const twoLines = out.filter((it) => it.name !== 'title' && it.el.getBoundingClientRect().height > 34).map((it) => `${it.owner}:${it.text}`);
  return { row: box(row), twoLines, titleWidth: title ? Math.round(title.getBoundingClientRect().width) : 0,
    items: out.map(({ el, ...it }) => `${it.owner}:${it.text}@${it.box.left}-${it.box.right}/${it.box.top}`), overlaps, unreachable, outside,
    styles: document.querySelectorAll('style[data-composer-plus-header-fit]').length };
}

const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  for (const bin of process.argv.slice(2)) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-hfit-')));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'hfit-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
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
- id: permission-presets
  config: { default: full-access }
`);
    const project = join(home, 'projects', 'acme-web'); await mkdir(project, { recursive: true });
    await writeFile(join(project, 'README.md'), '# acme-web\n');
    git(project, 'init', '-q', '-b', 'feat/order-warehouse-handover-screen'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'init');
    for (let n = 1; n <= 18; n++) await writeFile(join(project, `change-${n}.txt`), `${n}\n`);
    const wid = randomUUID(); const now = new Date().toISOString();
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [wid], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: wid },
      tables: { workspaces: { [wid]: { path: project, title: 'acme-web', sessionIds: [], createdAt: now, updatedAt: now } } } }));
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3213', '--no-open'], { cwd: project,
      env: { ...process.env, DSH_HOME: home, HOME: home, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; let context; let passed = false;
    try {
      for (let i = 0; i < 200 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      context = await browser.newContext({ locale: 'en-US', viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
      await context.addInitScript(() => { if (sessionStorage.getItem('hfit.started') === null) { sessionStorage.setItem('hfit.started', '1'); localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false}'); } });
      const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      for (const name of [/^Continue$/, /^Configure later$/]) { const b = page.getByRole('button', { name }); if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }); } }
      const input = page.locator('[data-composer-input]'); await input.waitFor({ timeout: 20000 });
      await input.click(); await page.keyboard.type('Start the work'); await page.keyboard.press('Enter');
      await page.getByText('Started the work.').first().waitFor({ timeout: 30000 });
      // Three grants for this chat through the Host route (the same call as the approval card's button), then a reload.
      const sessionId = (await page.locator('[data-row-key^="session:"]').first().getAttribute('data-row-key')).slice('session:'.length);
      await page.evaluate(async (id) => { for (const tool of ['bash', 'write', 'edit']) await fetch('/api/composer-plus.grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'grant', sessionId: id, tool }) }); }, sessionId);
      await page.reload(); await input.waitFor({ timeout: 20000 });
      await page.locator('[data-composer-plus-branch-status]').waitFor({ timeout: 20000 });
      await page.locator('[data-composer-plus-grants]').waitFor({ timeout: 20000 });
      await page.getByRole('button', { name: /background jobs? running/ }).waitFor({ timeout: 20000 });
      await pause(1000);
      const fitOn = (on) => page.evaluate((v) => { for (const st of document.querySelectorAll('style[data-composer-plus-header-fit]')) st.disabled = !v; }, on);
      const at = async (width, name = `w${width}`) => {
        await page.setViewportSize({ width, height: 900 }); await pause(600);
        const m = await page.evaluate(measure);
        if (process.env.KEEP && m) { const r = m.row; const x = Math.max(0, r.left - 20); await page.screenshot({ path: join(home, `${name}.png`), clip: { x, y: 0, width: Math.min(width, r.right + 40) - x, height: r.bottom + 50 } }); }
        return m;
      };
      const ok = (m, label) => {
        assert.ok(m, `${label}: the header row shows`);
        assert.deepEqual(m.overlaps, [], `${label}: no header items overlap: ${m.items.join(' | ')}`);
        assert.deepEqual(m.unreachable, [], `${label}: each item gets a click: ${m.items.join(' | ')}`);
        assert.deepEqual(m.outside, [], `${label}: no item outside the header`);
        assert.deepEqual(m.twoLines, [], `${label}: each item keeps its text on one line`);
        assert.ok(m.titleWidth >= 110, `${label}: the title keeps at least 110 px (${m.titleWidth})`);
        if (cpItems) assert.ok(m.items.some((i) => i.startsWith('CP:⑂')) && m.items.some((i) => /tool\(s\) allowed/.test(i)), `${label}: the branch pill and the grants chip show`);
      };
      let cpItems = true;

      // 1. Wide: the same header with and without the fit style.
      for (const width of WIDE) {
        const fit = await at(width); await fitOn(false); const plain = await at(width, `w${width}-nofit`); await fitOn(true);
        assert.equal(fit.styles, 3, 'one fit style per feature (Fit chat header, Branch per chat, Allow for this chat)');
        assert.ok(plain.titleWidth >= 120 && new Set(plain.items.map((i) => i.split('/').at(-1))).size <= 3, `${width} px is wide: dsh's header fits on one line (${plain.titleWidth} px title)`);
        assert.deepEqual(fit.items, plain.items, `${width} px: the wide header is not changed`);
        assert.deepEqual(fit.row, plain.row, `${width} px: the wide header row keeps its size`);
        ok(fit, `${width} px`);
        console.log(`  ${width} px: same as dsh's header (${fit.items.length} items, one line)`);
      }
      // 2. Narrow, and a wide window with the right sidebar open.
      const before = [];
      for (const width of NARROW) {
        await fitOn(false); const plain = await at(width, `w${width}-nofit`); await fitOn(true);
        if (plain.overlaps.length > 0) before.push(`${width}: ${plain.overlaps.join(', ')}`);
        const m = await at(width); ok(m, `${width} px`);
        console.log(`  ${width} px: no overlap, title ${m.titleWidth} px, row ${m.row.bottom - m.row.top} px high`);
      }
      console.log(`  without the fit style: ${before.length === 0 ? 'no overlap' : before.join(' · ')}`);
      await page.setViewportSize({ width: 1440, height: 900 }); await pause(400);
      await page.getByRole('button', { name: 'Open right sidebar' }).click(); await pause(1200);
      const aside = await at(1440, 'w1440-sidebar'); ok(aside, '1440 px with the right sidebar');
      console.log(`  1440 px + right sidebar: row ${aside.row.width} px wide, no overlap`);
      await page.getByRole('button', { name: 'Collapse right sidebar' }).first().click(); await pause(600);

      // 3. Settings switches.
      const setSwitches = async (wanted) => {
        await page.setViewportSize({ width: 1280, height: 900 }); await pause(400);
        const direct = page.getByRole('button', { name: 'Settings', exact: true });
        if (await direct.isVisible()) await direct.click();
        else { await page.getByRole('button', { name: 'Account menu', exact: true }).click(); await page.getByRole('menuitem', { name: /^Settings/ }).click(); }
        await page.getByText('Composer Plus', { exact: true }).click();
        for (const [name, on] of Object.entries(wanted)) {
          const sw = page.locator('[data-composer-plus-settings]').getByRole('switch', { name, exact: true }); await sw.waitFor({ timeout: 10000 });
          if ((await sw.isChecked()) !== on) await sw.click();
          await page.waitForFunction(([n, v]) => [...document.querySelectorAll('[data-composer-plus-settings] [role="switch"]')].some((x) => x.getAttribute('aria-label') === n && x.getAttribute('aria-checked') === String(v)), [name, on], { timeout: 10000 }).catch(() => {});
        }
        const overlay = page.locator('[class*="_overlay"]').filter({ has: page.locator('[data-composer-plus-settings]') });
        const close = overlay.getByRole('button', { name: /^Close$/ });
        if (await close.count()) await close.first().click(); else await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached' }); await pause(800);
      };
      const FIT = 'Fit chat header to window', BRANCH = 'Branch per chat', GRANTS = 'Allow for this chat';
      // 3a. Only dsh's own header items: Fit chat header to window alone keeps them apart.
      await setSwitches({ [BRANCH]: false, [GRANTS]: false });
      cpItems = false;
      const DSH_NARROW = [760, 600, 520, 480, 440, 400, 360, 320];
      const dshBefore = [];
      for (const width of DSH_NARROW) {
        await fitOn(false); const plain = await at(width, `d${width}-nofit`); await fitOn(true);
        assert.ok(!plain.items.some((i) => i.startsWith('CP:')), `${width} px: no Composer Plus item in the header: ${plain.items.join(' | ')}`);
        if (plain.overlaps.length > 0 || plain.unreachable.length > 0) dshBefore.push(width);
        const m = await at(width, `d${width}`);
        assert.equal(m.styles, 1, 'only the Fit chat header style');
        ok(m, `dsh's own header, ${width} px`);
      }
      assert.ok(dshBefore.includes(400), `without the style dsh's own header overlaps at 400 px (it did at: ${dshBefore.join(', ')})`);
      console.log(`  dsh's own header: no overlap at ${DSH_NARROW.join(', ')} px (without the style it overlaps at ${dshBefore.join(', ')} px)`);
      await page.setViewportSize({ width: 1280, height: 900 }); await pause(400);
      await page.getByRole('button', { name: 'Open right sidebar' }).click(); await pause(1200);
      await fitOn(false); const asidePlain = await at(1280, 'd1280-sidebar-nofit'); await fitOn(true);
      const asideFit = await at(1280, 'd1280-sidebar'); ok(asideFit, "dsh's own header, 1280 px + right sidebar");
      console.log(`  dsh's own header, 1280 px + right sidebar: no overlap (without the style: ${JSON.stringify(asidePlain.overlaps)})`);
      await page.getByRole('button', { name: 'Collapse right sidebar' }).first().click(); await pause(600);
      if (process.env.SHOT) {
        // Before and after at 760 px, one image: dsh's own header (subagent + jobs) without and with the style.
        const shots = [];
        for (const on of [false, true]) {
          await fitOn(on); const m = await at(400, `shot-${on}`); const r = m.row;
          const png = join(home, `shot-${on}.png`); await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 400, height: r.bottom + 46 } }); shots.push(png);
        }
        await fitOn(true);
        const both = join(home, 'shot.png');
        // Two PNGs above each other with a 6 px line between them (PYTHON: a python3 with Pillow).
        execFileSync(process.env.PYTHON ?? 'python3', ['-c', 'import sys;from PIL import Image;a,b=[Image.open(p).convert("RGB") for p in sys.argv[1:3]];o=Image.new("RGB",(max(a.width,b.width),a.height+b.height+12),(90,90,96));o.paste(a,(0,0));o.paste(b,(0,a.height+12));o.save(sys.argv[3])', shots[0], shots[1], both]);
        execFileSync('cwebp', ['-quiet', '-q', '70', '-resize', '600', '0', both, '-o', join(repo, 'assets/features/headerFit.webp')]);
      }
      // 3b. All three off: no fit style, dsh's own header as dsh draws it.
      await setSwitches({ [FIT]: false });
      const off = await at(400, 'd400-off');
      assert.equal(off.styles, 0, 'switches off: no fit style');
      assert.ok(off.overlaps.length > 0, `switches off: dsh's own header overlaps at 400 px again (${off.items.join(' | ')})`);
      console.log(`  all three off: no fit style, dsh's own header (${off.items.length} items, overlaps again)`);
      // 3c. All three on again.
      await setSwitches({ [FIT]: true, [BRANCH]: true, [GRANTS]: true });
      cpItems = true;
      await page.locator('[data-composer-plus-branch-status]').waitFor({ timeout: 20000 });
      await page.locator('[data-composer-plus-grants]').waitFor({ timeout: 20000 });
      const again = await at(760, 'w760-again');
      assert.equal(again.styles, 3, 'switches on again: the three styles are back');
      ok(again, '760 px after on again');
      assert.deepEqual(errors, [], 'no browser exceptions');
      passed = true;
      results.push(`PASS ${bin}: wide header unchanged (${WIDE.join(', ')} px) · no overlap at ${NARROW.join(', ')} px and 1440 px + right sidebar · dsh's own header fixed at ${DSH_NARROW.join(', ')} px and 1280 px + right sidebar · switches off/on`);
    } catch (error) {
      const page = context?.pages().at(-1);
      if (page) await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
      results.push(`FAIL ${bin}: ${error?.stack ?? error}\n  kept for inspection: ${home}; page errors: ${JSON.stringify(errors)}`);
    } finally {
      await context?.close().catch(() => {});
      await writeFile(join(home, 'server.log'), log);
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
      if (passed && !process.env.KEEP) await rm(home, { recursive: true, force: true });
      else console.log(`home: ${home}`);
    }
  }
} finally { for (const r of held) r.destroy(); await browser.close(); fake.close(); }
for (const r of results) console.log(r);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
