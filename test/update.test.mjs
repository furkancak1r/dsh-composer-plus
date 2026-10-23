// Update check (Host) and Settings updater / start-up auto-update (Client), without network.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { checkUpdate, parseVersion, newer, releaseNotes, NOTES_MAX, apply, UPDATE_PATH } from '../index.js';
assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]); assert.equal(parseVersion('1.2.0-beta.1'), undefined); assert.equal(parseVersion('latest'), undefined);
assert.ok(newer([1, 10, 0], [1, 9, 9]) && !newer([1, 1, 1], [1, 1, 1]) && !newer([1, 0, 9], [1, 1, 0]));
const fake = (tag, npmOk = true, gh = 200) => async (url) => url.includes('api.github.com')
  ? new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/x/releases/tag/${tag}` }), { status: gh })
  : new Response('{}', { status: npmOk ? 200 : 404 });
const pkg = { name: 'dsh-composer-plus', version: '1.1.1' };
assert.deepEqual(await checkUpdate(fake('v1.2.0'), pkg), { name: 'dsh-composer-plus', current: '1.1.1', latest: '1.2.0', managed: true, newer: true, url: 'https://github.com/x/releases/tag/v1.2.0' });
assert.equal((await checkUpdate(fake('v1.2.0', false), pkg)).newer, false, 'released on GitHub but not yet on npm: not offered');
assert.equal((await checkUpdate(fake('v1.1.1'), pkg)).newer, false); assert.equal((await checkUpdate(fake('v1.0.9'), pkg)).newer, false, 'never downgrade');
assert.equal((await checkUpdate(fake('v1.2.0'), { name: '@local/x', version: '1.0.0' })).managed, false, 'renamed local copy is not pnpm-managed');
await assert.rejects(checkUpdate(fake('nightly'), pkg)); await assert.rejects(checkUpdate(fake('v1.2.0', true, 403), pkg));
assert.equal((await checkUpdate(async (u) => u.includes('github') ? new Response(JSON.stringify({ tag_name: 'v2.0.0', html_url: 'javascript:alert(1)' })) : new Response('{}'), pkg)).url, undefined, 'only github.com links');
// What's new: the release body is the notes, without the install section; nothing else is fetched for it.
const withBody = (body) => async (u) => (u.includes('github') ? new Response(JSON.stringify({ tag_name: 'v1.2.0', html_url: 'https://github.com/x/releases/tag/v1.2.0', body })) : new Response('{}'));
assert.equal((await checkUpdate(withBody('## Tether\r\n\r\n- **New:** a thing.\r\n\r\n## Install\r\n\r\n```sh\ndsh plugin add x\n```\n'), pkg)).notes, '## Tether\n\n- **New:** a thing.', 'install section cut, CRLF made LF');
assert.equal((await checkUpdate(withBody('Only notes, no install heading.'), pkg)).notes, 'Only notes, no install heading.');
assert.ok(!('notes' in await checkUpdate(withBody('## Install\n\nonly install'), pkg)), 'nothing but the install section: no notes');
assert.ok(!('notes' in await checkUpdate(withBody(null), pkg)) && !('notes' in await checkUpdate(withBody({ x: 1 }), pkg)) && !('notes' in await checkUpdate(withBody('  '), pkg)), 'no text body: no notes');
assert.equal(releaseNotes('a'.repeat(NOTES_MAX + 50)).length, NOTES_MAX, 'long notes are cut');
assert.equal(releaseNotes('Fixes.\n### Install notes\nkeep'), 'Fixes.\n### Install notes\nkeep', 'only a "## Install" heading cuts');
{ // `?current=1`: the running version, with no network call.
  const routes = new Map(); const realFetch = globalThis.fetch; let fetched = 0; globalThis.fetch = async () => { fetched++; return new Response('{}'); };
  const home = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'cp-update-')); process.env.DSH_HOME = home;
  apply({ on() {}, effect() {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } }, sessionController: {}, sessionQuery: {}, subprocess: {} });
  const answer = await routes.get(UPDATE_PATH).fetch(new Request(`http://h${UPDATE_PATH}?current=1`));
  assert.deepEqual(await answer.json(), { current: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version }); assert.equal(fetched, 0, 'no network call');
  globalThis.fetch = realFetch; delete process.env.DSH_HOME; await new Promise((r) => setTimeout(r, 50)); (await import('node:fs')).rmSync(home, { recursive: true, force: true }); }

// Client: real client.js with a fake /api/composer-plus.update, plugin manager and Notification.
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } }; eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const shown = []; globalThis.Notification = class { static permission = 'granted'; constructor(title, o) { shown.push(o.body); } };
let answer; globalThis.fetch = async (url) => { assert.equal(url, '/api/composer-plus.update'); return new Response(answer.raw ?? JSON.stringify(answer.body), { status: answer.status ?? 200 }); };
let timers = []; globalThis.setTimeout = (f, ms) => { const t = { f, ms, live: true }; timers.push(t); return t; }; globalThis.clearTimeout = (t) => { if (t) t.live = false; };
const plugin = mod.factory((n) => (n === 'react' ? { createElement: (t, p, ...c) => ({ t, p, c }) } : {}));
function boot(manager) {
  let section; const installs = []; const effects = [];
  const mgr = manager === null ? undefined : { installBundle: async (spec, o) => { installs.push([spec, o.requestId]); return manager?.(spec) ?? { ok: true, value: { application: 'restart-required' } }; } };
  plugin.apply({ effect: (f) => effects.push(f()), configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k, p = {}) => `${k}${p.version ? ':' + p.version : ''}` },
    slots: { inject: (_, f) => f(), register: (o) => { if (o.id === 'composer-plus') section = o; return () => {}; } },
    inject: (deps, setup) => { if (deps[0] === 'remote.pluginManager') { if (mgr) setup({ remote: { pluginManager: mgr }, effect: () => {} }); } return { dispose() {} }; } });
  return { updater: section.inject().updater, installs, unload: () => effects.forEach((f) => typeof f === 'function' && f()) };
}
const info = (latest, extra = {}) => ({ body: { name: 'dsh-composer-plus', current: '1.1.1', latest, managed: true, newer: true, ...extra } });
// Start-up: one delayed check that installs the exact version, remembers it and notifies.
answer = info('1.2.0'); let app = boot();
const startup = timers.find((t) => t.ms === 15000 && t.live); assert.ok(startup, 'auto-update scheduled at start');
await startup.f();
assert.deepEqual(app.installs.map((x) => x[0]), ['dsh-composer-plus@1.2.0'], 'the registry spec first (the user\'s registry, no URL dependency)'); assert.equal(app.updater.getSnapshot().status, 'restart');
assert.equal(mem.get('dsh-composer-plus.update.installed'), '1.2.0'); assert.deepEqual(shown, ['notify.updated:1.2.0']);
await app.updater.install(); assert.equal(app.installs.length, 1, 'no second install while waiting for restart');
// Next start, still the old copy loaded: remembered version is not reinstalled.
timers = []; app = boot(); await app.updater.check(); assert.equal(app.updater.getSnapshot().status, 'restart'); assert.equal(app.installs.length, 0);
// dsh 0.2.1 refuses `name@version` for an installed plugin (before pnpm runs): then the exact npm tarball.
mem.clear(); shown.length = 0; timers = []; app = boot((spec) => (spec.startsWith('https:') ? { ok: true, value: { application: 'restart-required' } } : { ok: true, value: { application: 'failed', error: { code: 'already-installed' } } }));
answer = info('1.2.0'); await app.updater.check(); await app.updater.install();
assert.deepEqual(app.installs.map((x) => x[0]), ['dsh-composer-plus@1.2.0', 'https://registry.npmjs.org/dsh-composer-plus/-/dsh-composer-plus-1.2.0.tgz']);
assert.equal(app.updater.getSnapshot().status, 'restart');
// dsh loaded the new version at once (HMR): up to date, no restart asked.
mem.clear(); shown.length = 0; timers = []; app = boot(() => ({ ok: true, value: { application: 'applied', version: '1.2.0' } }));
answer = info('1.2.0'); await app.updater.check(); await app.updater.install();
assert.equal(app.updater.getSnapshot().status, 'current'); assert.equal(app.updater.getSnapshot().info.current, '1.2.0'); assert.deepEqual(shown, ['notify.applied:1.2.0']);
assert.equal(mem.get('dsh-composer-plus.update.installed'), '1.2.0');
// pnpm installed it, then the live start failed (a changed bundle patch): the files are in place, a restart loads it.
mem.clear(); shown.length = 0; timers = []; app = boot(() => ({ ok: true, value: { application: 'failed', version: '1.2.0', error: { code: 'operation-error', diagnostic: 'dsh: warning: 2 entries did not activate' } } }));
const warned = []; const realWarn = console.warn; console.warn = (m) => warned.push(m);
await app.updater.check(); await app.updater.install(); console.warn = realWarn;
assert.equal(app.updater.getSnapshot().status, 'restart'); assert.deepEqual(shown, ['notify.updated:1.2.0']);
assert.match(warned.join('\n'), /1\.2\.0 is installed; dsh could not start it before a restart: dsh: warning: 2 entries did not activate/, 'dsh\'s error is kept');
// Until the restart dsh can unload the old Host half: its route answers 404 "not found" (not JSON). Keep "restart".
answer = { status: 404, raw: 'not found' }; await app.updater.check(); assert.equal(app.updater.getSnapshot().status, 'restart');
mem.clear(); timers = []; app = boot(); await app.updater.check(); assert.equal(app.updater.getSnapshot().error, 'HTTP 404', 'a missing route without an install is an error, not a JSON parse message');
answer = info('1.2.0');
// Manual check + Update now; failures are reported, not hidden.
mem.clear(); shown.length = 0; timers = []; app = boot(() => ({ ok: true, value: { application: 'failed', error: { code: 'operation-error', diagnostic: '\n[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location\nmore' } } }));
await app.updater.check(); assert.equal(app.updater.getSnapshot().status, 'available');
await app.updater.install(); assert.equal(app.updater.getSnapshot().status, 'error'); assert.equal(app.updater.getSnapshot().error, '[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location', 'first diagnostic line shown');
assert.equal(mem.size, 0, 'a failed install is not remembered');
// A transport failure (Remote answered ok:false) is a failure too, never "installed".
mem.clear(); shown.length = 0; timers = []; app = boot(() => ({ ok: false, error: { message: 'connection reset' } }));
await app.updater.check(); await app.updater.install(); assert.equal(app.updater.getSnapshot().error, 'connection reset'); assert.equal(mem.size, 0); assert.deepEqual(shown, []);
// Up to date, unmanaged copy, Host error, no plugin manager.
timers = []; app = boot(); answer = { body: { current: '1.1.1', latest: '1.1.1', managed: true, newer: false } }; await app.updater.check(); assert.equal(app.updater.getSnapshot().status, 'current');
answer = info('1.2.0', { managed: false }); await app.updater.check(); assert.equal(app.updater.getSnapshot().status, 'manual'); await app.updater.install(); assert.equal(app.installs.length, 0);
answer = { status: 502, body: { error: 'GitHub answered 403' } }; await app.updater.check(); assert.equal(app.updater.getSnapshot().error, 'GitHub answered 403');
timers = []; app = boot(null); answer = info('1.2.0'); await timers.find((t) => t.ms === 15000).f(); assert.equal(app.updater.getSnapshot().status, 'available', 'without a plugin manager it only reports');
// Switched off: no start-up check.
mem.set('dsh-composer-plus.features', JSON.stringify({ autoUpdate: false })); timers = []; app = boot(); assert.ok(!timers.some((t) => t.ms === 15000 && t.live));

// What's new: an update with notes keeps them; the first start that runs that version shows them once, closable.
{ const KEY = 'dsh-composer-plus.update.whatsNew';
  globalThis.localStorage.removeItem = (k) => { mem.delete(k); };
  let running = '1.1.1'; const asked = [];
  globalThis.fetch = async (url) => {
    if (url === '/api/composer-plus.update?current=1') { asked.push(url); return running === null ? new Response('not found', { status: 404 }) : new Response(JSON.stringify({ current: running })); }
    return url === '/api/composer-plus.update' ? new Response(JSON.stringify(answer.body)) : new Response('{}');
  };
  const R = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useSyncExternalStore: (_, get) => get() };
  const p2 = mod.factory((n) => (n === 'react' ? R : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: 'Modal', Button: 'Button' } : {}));
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const start = async () => {
    const regs = new Map(); timers = [];
    p2.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
      slots: { inject: (_, f) => f(), register: (o, C) => { regs.set(o.id, { o, C }); return () => { regs.delete(o.id); }; } },
      inject: (deps, setup) => { if (deps[0] === 'remote.pluginManager') setup({ remote: { pluginManager: { installBundle: async () => ({ ok: true, value: { application: 'restart-required' } }) } }, effect: () => {} }); return { dispose() {} }; } });
    await settle();
    const seat = regs.get('whats-new');
    return { regs, seat, render: () => seat.C({ ...seat.o.inject(), t: (k, v) => (v?.version ? `${k}:${v.version}` : k) }) };
  };
  mem.clear(); answer = info('1.2.0', { url: 'https://github.com/x/releases/tag/v1.2.0', notes: '## Tether\n\n- **New:** a thing.' });
  let s = await start(); assert.equal(s.seat.o.name, 'shell.overlay'); assert.equal(s.render(), null, 'nothing to show before an update');
  assert.deepEqual(asked, [], 'no record: no Host call');
  await timers.find((t) => t.ms === 15000 && t.live).f();
  assert.deepEqual(JSON.parse(mem.get(KEY)), { version: '1.2.0', notes: '## Tether\n\n- **New:** a thing.', url: 'https://github.com/x/releases/tag/v1.2.0' }, 'the install keeps the notes of its own check');
  // dsh still runs the old copy (no restart yet): nothing shows, the record stays.
  s = await start(); assert.equal(s.render(), null); assert.ok(mem.has(KEY)); assert.equal(asked.length, 1);
  // The Host does not answer: the record stays for the next start.
  running = null; s = await start(); assert.equal(s.render(), null); assert.ok(mem.has(KEY));
  // The first start that runs 1.2.0: the notes show once, as plain text, with the GitHub link.
  running = '1.2.0'; s = await start(); let tree = s.render();
  assert.equal(tree.t, 'Modal'); assert.equal(tree.p.title, 'whatsNew.title:1.2.0'); assert.equal(tree.c[0].c[0], 'Tether\n\n- New: a thing.');
  assert.equal(tree.p.footer.c[0].p.href, 'https://github.com/x/releases/tag/v1.2.0'); assert.equal(tree.p.footer.c[0].p.rel, 'noopener noreferrer');
  assert.ok(!mem.has(KEY), 'shown once: the record goes away');
  tree.p.footer.c[1].p.onClick(); assert.equal(s.render(), null, 'Close closes it');
  s = await start(); assert.equal(s.render(), null, 'the next start shows nothing'); const calls = asked.length;
  // Esc / ✕ (the Modal's onClose) close it too.
  mem.set(KEY, JSON.stringify({ version: '1.2.0', notes: 'Fixes.', url: 'javascript:alert(1)' })); s = await start(); tree = s.render();
  assert.equal(tree.p.footer.c[0], null, 'only github.com links'); tree.p.onClose(); assert.equal(s.render(), null);
  // A newer copy already runs: the old record goes without a dialog. A broken record goes too.
  mem.set(KEY, JSON.stringify({ version: '1.1.9', notes: 'Old.' })); s = await start(); assert.equal(s.render(), null); assert.ok(!mem.has(KEY));
  mem.set(KEY, '{broken'); s = await start(); assert.equal(s.render(), null); assert.ok(!mem.has(KEY)); assert.equal(asked.length, calls + 2, 'a broken record asks nothing');
  // Two windows start at the same time: only one shows it (the record leaves storage before the Host answers).
  { mem.set(KEY, JSON.stringify({ version: '1.2.0', notes: 'Once.' })); running = '1.2.0';
    const [w1, w2] = await Promise.all([start(), start()]);
    assert.equal([w1.render(), w2.render()].filter(Boolean).length, 1, 'one window shows it'); assert.ok(!mem.has(KEY)); }
  // While the Host does not answer, the record goes back for the next start, but never over a newer record.
  { mem.set(KEY, JSON.stringify({ version: '1.3.0', notes: 'Wait.' })); running = null; await start(); assert.equal(JSON.parse(mem.get(KEY)).version, '1.3.0', 'back for the next start');
    let release; const slow = globalThis.fetch; globalThis.fetch = (url) => new Promise((r) => { release = () => r(new Response(JSON.stringify({ current: '1.2.0' }))); });
    await start(); mem.set(KEY, JSON.stringify({ version: '1.4.0', notes: 'Newer.' })); release(); await settle(); globalThis.fetch = slow;
    assert.equal(JSON.parse(mem.get(KEY)).version, '1.4.0', 'a newer record that came meanwhile stays'); }
  // A release without notes keeps no record.
  mem.clear(); running = '1.1.1'; answer = info('1.2.0'); s = await start(); await timers.find((t) => t.ms === 15000 && t.live).f(); assert.ok(!mem.has(KEY));
  // Automatic updates switched off: no dialog seat and no Host call.
  mem.set(KEY, JSON.stringify({ version: '1.1.1', notes: 'x' })); mem.set('dsh-composer-plus.features', JSON.stringify({ autoUpdate: false })); const before = asked.length;
  s = await start(); assert.equal(s.seat, undefined); assert.equal(asked.length, before); assert.ok(mem.has(KEY)); }
console.log('update checks passed');
