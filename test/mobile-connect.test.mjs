// Mobile connect (Tether): the Host keeps the switch (off by default) and runs one gateway while it is on; the client
// installs the sidebar-foot button only while the Host says on and shows why the gateway does not run.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, MOBILE_PATH, mobileGateway, mobileSwitch } from '../index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const root = mkdtempSync(join(tmpdir(), 'cp-mobile-'));
// No real network side: the gateway looks for an interface that does not exist, so it never opens a LAN port, makes a
// certificate or announces itself with Bonjour. Its pairing page (loopback) still runs and reports why.
process.env.DSH_MOBILE_IFACE = 'cp-test-none';

// Switch file: off when missing or broken, owner-only when written.
{
  const file = join(root, 'switch', 'mobile.json');
  const saved = mobileSwitch(file);
  assert.equal(await saved.read(), false, 'missing file: off');
  await saved.write(true);
  assert.equal(await saved.read(), true);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'owner-only');
  writeFileSync(file, '{broken');
  assert.equal(await saved.read(), false, 'broken file: off');
}

// Gateway lifecycle with a fake createGateway: one gateway at a time, ordered start/stop, errors kept.
const gateways = [];
function fakeMake(log, { startError } = {}) {
  return (opts) => {
    const g = { opts, running: false, closed: false,
      listenAdmin: async () => { log.push('admin'); return 19391; },
      start: async () => { log.push('start'); if (startError) throw new Error(startError); g.running = true; },
      close: async () => { log.push('close'); g.closed = true; g.running = false; },
      state: () => ({ running: g.running }) };
    gateways.push(g);
    return g;
  };
}
{
  const log = []; gateways.length = 0;
  const upstreamUrl = () => 'http://127.0.0.1:1/?token=t';
  const m = mobileGateway({ dir: '/x', upstreamUrl, make: fakeMake(log) });
  await Promise.all([m.start(), m.start()]);
  assert.equal(gateways.length, 1, 'a second start reuses the gateway');
  assert.equal(gateways[0].opts.upstreamUrl, upstreamUrl, 'the gateway asks the Host for the dsh URL');
  assert.deepEqual(m.state(), { running: true, admin: 'http://127.0.0.1:19391/' });
  await Promise.all([m.stop(), m.start(), m.stop()]);
  assert.deepEqual(log, ['admin', 'start', 'close', 'admin', 'start', 'close'], 'fast toggles run in order');
  assert.equal(m.state().running, false);
  assert.equal(m.state().admin, undefined);
  // Plugin unload while a switch-on request still waits: nothing starts after the unload.
  log.length = 0;
  await Promise.all([m.close(), m.start()]);
  assert.deepEqual(log, [], 'no gateway after unload');
  assert.equal(m.state().running, false);
}
{
  const log = []; gateways.length = 0;
  const m = mobileGateway({ dir: '/x', upstreamUrl: () => '', make: fakeMake(log, { startError: 'no IPv4 address on en0 (Wi-Fi off?)' }) });
  await m.start();
  assert.deepEqual(m.state(), { running: false, admin: 'http://127.0.0.1:19391/', error: 'no IPv4 address on en0 (Wi-Fi off?)' },
    'no Wi-Fi: the admin page stays and the reason shows');
  gateways[0].running = true;
  assert.equal(m.state().error, undefined, 'the gateway retried by itself: no stale error');
}
{
  const log = []; gateways.length = 0;
  const inUse = () => Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:19391'), { code: 'EADDRINUSE' });
  let busyFor = Infinity;
  const make = (opts) => { const g = fakeMake(log)(opts); const listen = g.listenAdmin; g.listenAdmin = async () => { if (busyFor-- > 0) throw inUse(); return listen(); }; return g; };
  const m = mobileGateway({ dir: '/x', upstreamUrl: () => '', make, retryMs: 1 });
  await m.start();
  assert.equal(gateways[0].closed, true, 'a gateway without its admin page is closed again');
  assert.deepEqual(m.state(), { running: false, admin: undefined, error: 'listen EADDRINUSE: address already in use 127.0.0.1:19391' });
  busyFor = 2; // the old gateway of a reloaded plugin frees the port a moment later
  await m.start();
  assert.deepEqual(m.state(), { running: true, admin: 'http://127.0.0.1:19391/' }, 'a port that frees soon is waited for');
  await m.stop();
  const broken = mobileGateway({ dir: '/x', upstreamUrl: () => '', make: () => { throw new Error('EACCES: permission denied, mkdir'); } });
  await broken.start();
  assert.deepEqual(broken.state(), { running: false, admin: undefined, error: 'EACCES: permission denied, mkdir' }, 'a gateway that cannot be made reports why');
  await broken.stop();
}

// Host route: default off; POST saves and answers; a headless profile (no web server) never starts a gateway.
async function host({ withWeb = true } = {}) {
  const home = mkdtempSync(join(root, 'home-'));
  process.env.DSH_HOME = home;
  process.env.DSH_MOBILE_DIR = join(home, 'mobile');
  process.env.DSH_MOBILE_ADMIN_PORT = '0';
  const routes = new Map();
  const disposers = [];
  let webSetup;
  apply({ on() {}, sessionController: {}, sessionQuery: {}, subprocess: {},
    connection: { fetch: { register: (r) => routes.set(r.path, r) }, authenticatedUrl: (base) => `${base}/?token=t` },
    inject: (deps, setup) => { assert.deepEqual(deps, ['webServer']); webSetup = setup; } });
  if (withWeb) webSetup({ webServer: { port: 1 }, effect: (f) => { disposers.push(f()); } });
  const call = async (body) => {
    const response = await routes.get(MOBILE_PATH).fetch(new Request(`http://h${MOBILE_PATH}`, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: response.status, json: await response.json() };
  };
  return { home, call, unload: () => disposers.forEach((f) => f?.()) };
}
{
  const h = await host();
  assert.deepEqual((await h.call()).json, { on: false, available: true, running: false }, 'off by default');
  assert.equal((await h.call('{bad')).status, 400);
  assert.equal((await h.call({ on: 'yes' })).status, 400);
  // A failed save answers its own request with the reason, changes nothing, and does not fail the next requests.
  const dir = join(h.home, 'storages/dsh-composer-plus');
  mkdirSync(join(dir, 'mobile.json'), { recursive: true }); // a folder in the file's place: the save fails
  const failed = await h.call({ on: true });
  assert.equal(failed.status, 500); assert.match(failed.json.error, /EISDIR|EPERM|ENOTEMPTY|EEXIST|directory/);
  assert.deepEqual((await h.call()).json, { on: false, available: true, running: false }, 'still off, and the next request answers normally');
  rmSync(join(dir, 'mobile.json'), { recursive: true });
  // Switching on saves the choice and starts the real gateway: its pairing page binds to 127.0.0.1 on a free port, and
  // the missing interface is reported.
  const on = (await h.call({ on: true })).json;
  assert.equal(on.on, true);
  assert.match(on.admin, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'admin page on loopback');
  assert.deepEqual([on.running, on.error], [false, 'no IPv4 address on cp-test-none (Wi-Fi off?)'], 'the reason is reported');
  const page = await fetch(on.admin);
  assert.equal(page.status, 200, 'the Tether admin page answers');
  assert.match(await page.text(), /<title>Tether<\/title>/);
  assert.deepEqual(JSON.parse(readFileSync(join(h.home, 'storages/dsh-composer-plus/mobile.json'), 'utf8')), { on: true });
  const off = (await h.call({ on: false })).json;
  assert.deepEqual(off, { on: false, available: true, running: false });
  await assert.rejects(fetch(on.admin), 'switching off closes the admin page');
  h.unload();
}
{
  // Saved on before the Host loads (a dsh restart): the gateway starts without a click; unloading the plugin stops it.
  const home = mkdtempSync(join(root, 'home-'));
  mkdirSync(join(home, 'storages/dsh-composer-plus'), { recursive: true });
  writeFileSync(join(home, 'storages/dsh-composer-plus/mobile.json'), '{"on":true}');
  process.env.DSH_HOME = home; process.env.DSH_MOBILE_DIR = join(home, 'mobile'); process.env.DSH_MOBILE_ADMIN_PORT = '0';
  const routes = new Map(); const disposers = [];
  apply({ on() {}, sessionController: {}, sessionQuery: {}, subprocess: {},
    connection: { fetch: { register: (r) => routes.set(r.path, r) }, authenticatedUrl: (base) => `${base}/?token=t` },
    inject: (deps, setup) => setup({ webServer: { port: 1 }, effect: (f) => { disposers.push(f()); } }) });
  let state;
  for (let i = 0; i < 100; i++) { state = await (await routes.get(MOBILE_PATH).fetch(new Request(`http://h${MOBILE_PATH}`))).json(); if (state.admin) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(state.on, true); assert.match(state.admin, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'saved on: started at load');
  disposers.forEach((f) => f?.());
  await tick();
  await assert.rejects(fetch(state.admin), 'unload closes the gateway');
}
{
  const h = await host({ withWeb: false });
  assert.deepEqual((await h.call({ on: true })).json, { on: true, available: false, running: false }, 'headless: saved, nothing started');
}

// Client: the Settings row reads the Host switch; the sidebar button follows it; an old Host half asks for a restart.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
let hostState = { on: false, available: true, running: false };
const posts = [];
globalThis.fetch = async (url, init) => {
  if (url !== '/api/composer-plus.mobile') return new Response('{}', { status: 404 });
  if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); if (hostState === 404) return new Response('', { status: 404 }); hostState = { ...hostState, ...JSON.parse(init.body) }; }
  return hostState === 404 ? new Response('', { status: 404 }) : new Response(JSON.stringify(hostState), { status: 200 });
};
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }),
  useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
const live = new Map(); let next = 0;
const ctx = { effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k, p) => (p?.error ? `${k}:${p.error}` : k) },
  slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } };
plugin.apply(ctx);
const find = (id) => [...live.values()].find(([o]) => o.id === id);
await tick(); await tick();
assert.equal(find('mobile-connect'), undefined, 'off by default: no sidebar button');
const [settingsOpts, Settings] = find('composer-plus');
const section = settingsOpts.inject();
const t = (k, p) => (p?.error ? `${k}:${p.error}` : k);
const rowOf = (id) => {
  const tree = Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, mobile: section.mobile, t });
  return tree.c.slice(5).find((r) => r.p.key === id);
};
assert.equal(rowOf('mobileConnect').c[2].p.checked, false, 'Settings shows off');
assert.equal(rowOf('mobileConnect').c[0].p.id, 'mobileConnect', 'the row has its screenshot');
await section.setFeature('mobileConnect', true);
assert.deepEqual(posts, [{ on: true }], 'the switch goes to the Host, not to browser storage');
assert.equal(mem.get('dsh-composer-plus.features') ?? null, null);
assert.equal(rowOf('mobileConnect').c[2].p.checked, true);
const [buttonOpts, MobileConnect] = find('mobile-connect');
assert.equal(buttonOpts.name, 'sidebar.footer.action');
hostState = { ...hostState, admin: 'http://127.0.0.1:19391/' };
await section.mobile.refresh();
const button = MobileConnect({ wide: true, ...buttonOpts.inject(), t: (k) => k });
assert.equal(button.p['data-composer-plus-mobile'], '');
assert.equal(button.c[0].t, 'style', 'its CSS lives in the component, so switching off removes it');
assert.equal(button.c[2].p['aria-label'], 'mobile.label');
// A refused change puts the switch back and shows the reason.
hostState = { on: true, available: true, running: false, error: 'no IPv4 address on en0 (Wi-Fi off?)' };
await section.mobile.refresh();
const status = rowOf('mobileConnect').c[1].c[2];
assert.equal(status.t.name, 'MobileStatus');
assert.equal(status.t(status.p).c[0], 'mobile.down:no IPv4 address on en0 (Wi-Fi off?)', 'the reason shows under the switch');
await section.setFeature('mobileConnect', false);
await tick();
assert.equal(find('mobile-connect'), undefined, 'switching off removes the button');
// Host half older than this client (route missing until dsh restarts).
hostState = 404;
await section.setFeature('mobileConnect', true);
assert.equal(section.mobile.getSnapshot().restart, true);
assert.equal(section.mobile.getSnapshot().on, false, 'the switch goes back');
assert.equal(status.t({ mobile: section.mobile, t }).c[0], 'mobile.restart');
console.log('mobile-connect checks passed');
