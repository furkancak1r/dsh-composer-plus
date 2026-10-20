// Update check (Host) and Settings updater / start-up auto-update (Client), without network.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { checkUpdate, parseVersion, newer } from '../index.js';
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
console.log('update checks passed');
