// Tether's green dots on the Host: while Mobile connect is on, a root chat whose turn ends gets a dot, a new turn or a read
// (any device) takes it away, and every change goes to the phones. Off: nothing is kept. Real index.js apply() wiring.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, mobileGateway, UNREAD_MAX, UNREAD_PATH, MOBILE_PATH, unreadStore } from '../index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const root = mkdtempSync(join(tmpdir(), 'cp-unread-'));
process.env.DSH_MOBILE_IFACE = 'cp-test-none'; // never a LAN port, a certificate or Bonjour

// The store: missing or broken file = empty, owner-only, ordered saves, a cap that drops the oldest.
{
  const file = join(root, 'store', 'unread.json');
  const s = unreadStore(file);
  await s.ready;
  assert.deepEqual(s.list(), [], 'missing file: empty');
  assert.equal(s.update(['a', 'b']), true);
  assert.equal(s.update(['a']), false, 'no change, no save');
  assert.equal(s.update([], ['a']), true);
  await s.flush();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ids: ['b'] });
  assert.equal(statSync(file).mode & 0o777, 0o600, 'owner-only');
  const again = unreadStore(file); await again.ready;
  assert.deepEqual(again.list(), ['b'], 'kept across a restart');
  writeFileSync(file, '{broken');
  const broken = unreadStore(file); await broken.ready;
  assert.deepEqual(broken.list(), [], 'broken file: empty');
  const many = unreadStore(join(root, 'store', 'many.json')); await many.ready;
  many.update(Array.from({ length: UNREAD_MAX + 5 }, (_, i) => `s${i}`));
  assert.equal(many.list().length, UNREAD_MAX);
  assert.equal(many.list()[0], 's5', 'the oldest ids go first');
}

// mobileGateway.emit: to the running gateway only.
{
  const sent = [];
  const g = mobileGateway({ dir: join(root, 'gw'), upstreamUrl: () => '', make: () => ({ listenAdmin: async () => 1, start: async () => {}, close: async () => {}, state: () => ({ running: true }), emit: (e, a) => sent.push([e, a]) }) });
  g.emit('x', [1]);
  assert.deepEqual(sent, [], 'no gateway yet');
  await g.start(); g.emit('x', [1]);
  assert.deepEqual(sent, [['x', [1]]]);
  await g.stop(); g.emit('x', [2]);
  assert.equal(sent.length, 1, 'stopped: nothing');
}

/** One Host with fake dsh events; `on` writes the Mobile connect switch file first. */
async function host(on) {
  const home = mkdtempSync(join(root, 'home-'));
  process.env.DSH_HOME = home;
  process.env.DSH_MOBILE_DIR = join(home, 'mobile');
  process.env.DSH_MOBILE_ADMIN_PORT = '0';
  if (on !== undefined) { mkdirSync(join(home, 'storages', 'dsh-composer-plus'), { recursive: true }); writeFileSync(join(home, 'storages', 'dsh-composer-plus', 'mobile.json'), JSON.stringify({ on })); }
  return start(home);
}
function start(home) {
  process.env.DSH_HOME = home;
  const routes = new Map(), handlers = new Map(), emitted = [];
  let webSetup;
  apply({ on: (name, f) => { handlers.set(name, [...(handlers.get(name) ?? []), f]); }, sessionController: {}, sessionQuery: {}, subprocess: {},
    connection: { fetch: { register: (r) => routes.set(r.path, r) }, authenticatedUrl: (base) => `${base}/?token=t` },
    inject: (deps, setup) => { if (deps.includes('webServer')) webSetup = setup; } });
  const disposers = [];
  webSetup?.({ webServer: { port: 1 }, effect: (f) => { disposers.push(f()); } });
  const status = (id, s, origin) => { for (const f of handlers.get('agent/status') ?? []) f({ agent: { id, status: s, session: { header: { origin } } }, status: s }); };
  const fetchRoute = async (path, body) => {
    const r = await routes.get(path).fetch(new Request(`http://h${path}`, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, json: await r.json() };
  };
  const unread = async () => (await fetchRoute(UNREAD_PATH)).json.unread;
  return { home, status, fetchRoute, unread, emitted, unload: () => disposers.forEach((f) => f?.()) };
}

// On: running → idle gives a dot; a chat that only got created (idle, never ran) does not; subagents never do.
{
  const h = await host(true);
  await h.unread();
  h.status('a', 'idle'); // a new chat is created idle
  assert.deepEqual(await h.unread(), [], 'created idle: no dot');
  h.status('a', 'running'); h.status('a', 'idle');
  assert.deepEqual(await h.unread(), ['a'], 'a finished turn gives a dot');
  h.status('k', 'running', 'subagent'); h.status('k', 'idle', 'subagent');
  assert.deepEqual(await h.unread(), ['a'], 'a subagent never gets a dot');
  h.status('a', 'running');
  assert.deepEqual(await h.unread(), [], 'a new turn takes the dot away');
  h.status('a', 'idle'); h.status('b', 'running'); h.status('b', 'idle');
  assert.deepEqual(await h.unread(), ['a', 'b']);
  // A read from any device: the dot goes, the answer is the new list.
  assert.deepEqual((await h.fetchRoute(UNREAD_PATH, { sessionIds: ['a', 'gone'] })).json, { unread: ['b'] });
  // Bad bodies change nothing.
  for (const bad of ['{x', {}, { sessionIds: 'b' }, { sessionIds: [] }, { sessionIds: [1] }, { sessionIds: [''] }, { sessionIds: ['x'.repeat(129)] },
    { sessionIds: Array.from({ length: UNREAD_MAX + 1 }, (_, i) => `s${i}`) }, { on: false }]) {
    assert.equal((await h.fetchRoute(UNREAD_PATH, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.deepEqual(await h.unread(), ['b']);
  // Kept across a Host restart (same dsh home).
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = start(h.home);
  assert.deepEqual(await again.unread(), ['b'], 'the list survives a restart');
  // Switching Mobile connect off clears the list; while off nothing is collected and GET says nothing.
  assert.equal((await again.fetchRoute(MOBILE_PATH, { on: false })).status, 200);
  assert.deepEqual(await again.unread(), []);
  again.status('c', 'running'); again.status('c', 'idle');
  assert.deepEqual(await again.unread(), [], 'off: no dots');
  again.unload(); h.unload();
}

// Off by default: no dot is kept.
{
  const h = await host();
  h.status('a', 'running'); h.status('a', 'idle');
  await tick();
  assert.deepEqual(await h.unread(), [], 'off by default');
  h.unload();
}

rmSync(root, { recursive: true, force: true });
console.log('unread: Host green dots ok');
