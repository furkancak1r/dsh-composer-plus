// Screenshots of the Damon status panel at the right of the chat (Furkan, 2026-11-23: a plain panel; no automations in it).
// A throwaway dsh (scripts/demo-card-stack.mjs: its own DSH_HOME and HOME, a fake model on 127.0.0.1, made-up data),
// headless Chromium with its sandbox, never the user's dsh home. The demo also gets:
// - a long agent item (a card title that must not wrap into many short lines) and a not-live Onay item that names a
//   deploy ("canli degil": no CANLI label);
// - a scheduled task with a `new` target: dsh opens a new chat for it in the Damon project folder (an automation chat).
// It writes <SHOTS>/<PREFIX>.png (the panel) and <SHOTS>/<PREFIX>-projeler.png (Projeler open), each about 368 px wide.
// It checks that the panel shows no automation chat (CHECK=1, after the change) and no page errors.
// PLAYWRIGHT=/path/to/playwright SHOTS=<folder> PREFIX=panel-sonra-koyu SCHEME=dark node test/browser-panel-shots.mjs <dsh/lib/bin.js>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeModel, demoHome, startDemo, seed, rpcOf } from '../scripts/demo-card-stack.mjs';
const require = createRequire(import.meta.url);
const { PLAYWRIGHT, SHOTS, PREFIX = 'panel', SCHEME = 'dark', VIEW, CHECK } = process.env;
if (!PLAYWRIGHT || !SHOTS || process.argv.length < 3) throw Error('Set PLAYWRIGHT and SHOTS and pass one dsh CLI entry path');
const { chromium } = require(PLAYWRIGHT);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error(`timed out: ${what}`); await pause(300); }
};
const calls = [];
const model = await fakeModel(calls);
const where = await demoHome(model.address().port);
// The Damon chat's folder is a project too (as ~/Damon on the owner's Mac), so a chat that a schedule opens there is listed.
const wsFile = join(where.dshHome, 'storages/workspace.json');
const ws = JSON.parse(await readFile(wsFile, 'utf8')); const damonId = 'f0000000-0000-4000-8000-00000000da00'; const at = new Date().toISOString();
ws.tables.workspaces[damonId] = { path: join(where.home, 'Assistant'), title: 'Damon', sessionIds: [], createdAt: at, updatedAt: at };
ws.global.workspaceIds.push(damonId); await writeFile(wsFile, JSON.stringify(ws));
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
let demo; let passed = false;
try {
  demo = await startDemo(process.argv[2], where, 3380);
  const { sessionId } = await seed(demo.url, { model });
  const { rpc, get } = await rpcOf(demo.url);
  const say = (text) => rpc('session/prompt', { request: { requestId: `shot-${Date.now()}-${text}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] } });
  await say('DEMO-EXTRA');
  await until(async () => ((await get(`/api/composer-plus.assistant-todos?sessionId=${sessionId}`)).items ?? []).length >= 10, 'the extra items');
  await say('DEMO-AUTO-SETUP');
  // dsh delivers the task into a new chat; the fake model answers it.
  await until(() => calls.some((c) => c.newest.includes('DEMO-AUTO run')), 'the scheduled delivery', 90000);
  await pause(3000);
  const context = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1280, height: 1500 }, deviceScaleFactor: 2, colorScheme: SCHEME === 'light' ? 'light' : 'dark' });
  await context.addInitScript((view) => {
    localStorage.setItem('dsh-composer-plus.features', '{"autoUpdate":false,"worktreeChats":false,"nextPrediction":false}');
    if (view) localStorage.setItem('dsh-composer-plus.status-view', view);
  }, VIEW ?? '');
  const page = await context.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(demo.url);
  for (const name of [/^(Continue|Devam)$/, /^(Configure later|Daha sonra yapılandır)$/]) {
    const b = page.getByRole('button', { name });
    if (await b.waitFor({ timeout: 2000 }).then(() => true, () => false)) { await b.click(); await b.waitFor({ state: 'hidden' }).catch(() => {}); }
  }
  await page.keyboard.press('Escape');
  await page.locator('button[aria-label="Damon"]').click();
  const panel = page.locator('[data-composer-plus-todos]');
  await panel.waitFor({ timeout: 30000 });
  for (let n = 0; n < 3; n++) { const hide = page.getByRole('button', { name: 'Gizle', exact: true }).first(); if (!(await hide.waitFor({ timeout: 2000 }).then(() => true, () => false))) break; await hide.click(); await pause(400); }
  await until(async () => (await panel.locator('[data-composer-plus-approve="card"]').count()) > 0, 'Onayla in the panel', 20000);
  await page.mouse.move(5, 5); await pause(1200);
  // The panel and 34 px around it at the left and the right (368 px for the 300 px panel).
  const shot = async (name) => {
    const b = await panel.boundingBox();
    await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: b.x - 34, y: Math.max(0, b.y - 12), width: b.width + 68, height: b.height + 24 } });
    console.log(`  ${join(SHOTS, `${name}.png`)}`);
  };
  assert.equal(await panel.getAttribute('data-place'), 'side', 'the panel is at the right of the chat');
  await shot(PREFIX);
  await page.locator('[id$="-projects"]').first().click();
  await panel.locator('section[aria-labelledby$="-projects-h"]').waitFor({ timeout: 10000 });
  await pause(800);
  const projects = await panel.locator('section[aria-labelledby$="-projects-h"]').innerText();
  console.log(`  Projeler: ${projects.replace(/\s+/g, ' ').slice(0, 300)}`);
  await shot(`${PREFIX}-projeler`);
  if (CHECK) {
    assert.doesNotMatch(projects, /Demo automation/, 'no chat that a schedule opened');
    assert.doesNotMatch(await panel.innerText(), /CANLI/, 'no CANLI label for "canli degil"');
  }
  assert.deepEqual(errors, [], 'no page errors');
  await context.close();
  passed = true; console.log('PASS');
} finally {
  if (demo) { demo.child.kill('SIGTERM'); await new Promise((r) => { if (demo.child.exitCode !== null) r(); else demo.child.once('exit', r); }); }
  await browser.close(); model.close();
  if (passed) await rm(where.home, { recursive: true, force: true }); else console.log(`  home kept: ${where.home}\n${(demo?.log ?? '').split('\n').filter((l) => /error|warn/i.test(l)).slice(-15).join('\n')}`);
}
