// Content search: cordis.patch.yml turns on dsh's own SQLite message index for the sidebar search, with a durable file
// under the dsh home, unless the Host switch file says off. The Host keeps the switch (on by default); the client row
// moves it and says when a dsh restart is needed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, CONTENT_SEARCH_PATH, mobileSwitch } from '../index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const root = mkdtempSync(join(tmpdir(), 'cp-content-search-'));

// 1. The patch row: dsh's `session-query-sqlite` row, both values as `!!js` expressions. dsh's Loader evaluates them with
// `with (ctx) eval(expr)`, where `dshHomePath` is a root service (dsh-app-boot provides it on 0.2.0-rc.2 and 0.2.1-rc.2).
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
assert.match(patch, /^- id: session-query-sqlite\n {2}config:\n/m, 'patches dsh\'s own row by id, without a name');
assert.match(patch, /^ {4}journalMode: delete$/m, 'no write-ahead log next to a rebuildable index');
const expr = (key) => {
  const raw = patch.match(new RegExp(`^ {4}${key}: !!js (.+)$`, 'm'))?.[1];
  assert.ok(raw, `${key} is a !!js expression`);
  return raw.startsWith('"') ? JSON.parse(raw) : raw;
};
const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }');
const home = join(root, 'home');
const scope = { dshHomePath: (...segments) => join(home, ...segments) };
assert.equal(evaluate(scope, expr('path')), join(home, 'cache', 'composer-plus', 'session-search.db'), 'a durable index file under the dsh home');
const openAt = () => evaluate(scope, expr('openAt'));
assert.equal(openAt(), 'first-search', 'no switch file: on, and the index opens at the first search');
const file = join(home, 'storages', 'dsh-composer-plus', 'content-search.json');
mkdirSync(join(home, 'storages', 'dsh-composer-plus'), { recursive: true });
writeFileSync(file, '{"on":false}');
assert.equal(openAt(), 'never', 'switched off: dsh\'s default (titles only)');
writeFileSync(file, '{"on":true}');
assert.equal(openAt(), 'first-search');
writeFileSync(file, '{broken');
assert.equal(openAt(), 'first-search', 'a broken file does not stop dsh from starting');
writeFileSync(file, 'null');
assert.equal(openAt(), 'first-search');

// 2. The switch file: on when missing or broken, owner-only when written.
{
  const saved = mobileSwitch(join(root, 'switch', 'content-search.json'), true);
  assert.equal(await saved.read(), true, 'missing file: on');
  await saved.write(false);
  assert.equal(await saved.read(), false);
  assert.equal(statSync(join(root, 'switch', 'content-search.json')).mode & 0o777, 0o600, 'owner-only');
  writeFileSync(join(root, 'switch', 'content-search.json'), '{broken');
  assert.equal(await saved.read(), true, 'broken file: on');
  assert.equal(await mobileSwitch(join(root, 'switch', 'none.json')).read(), false, 'Mobile connect keeps its off default');
}

// 3. Host route: default on; POST saves; `active` tells whether the running index is open.
async function host(sessionQuery) {
  const dir = mkdtempSync(join(root, 'home-'));
  process.env.DSH_HOME = dir;
  const routes = new Map();
  apply({ on() {}, sessionController: {}, sessionQuery, subprocess: {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } } });
  const call = async (body) => {
    const response = await routes.get(CONTENT_SEARCH_PATH).fetch(new Request(`http://h${CONTENT_SEARCH_PATH}`, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: response.status, json: await response.json() };
  };
  return { dir, call };
}
{
  const h = await host({ config: { openAt: 'first-search' } });
  assert.deepEqual((await h.call()).json, { on: true, active: true }, 'on by default, index open');
  assert.equal((await h.call('{bad')).status, 400);
  assert.equal((await h.call({ on: 'no' })).status, 400);
  assert.deepEqual((await h.call({ on: false })).json, { on: false, active: true }, 'saved; dsh applies it after a restart');
  const saved = join(h.dir, 'storages/dsh-composer-plus/content-search.json');
  assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')), { on: false });
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  // Two quick changes: the last one wins, no half-written file.
  const [a, b] = await Promise.all([h.call({ on: true }), h.call({ on: false })]);
  assert.deepEqual([a.status, b.status, b.json.on], [200, 200, false]);
  assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')), { on: false });
  // A save that fails answers with the reason and changes nothing.
  rmSync(saved); mkdirSync(saved);
  const failed = await h.call({ on: true });
  assert.equal(failed.status, 500); assert.match(failed.json.error, /EISDIR|EPERM|ENOTEMPTY|EEXIST|directory/);
  rmSync(saved, { recursive: true });
}
assert.deepEqual((await (await host({ config: { openAt: 'never' } })).call()).json, { on: true, active: false }, 'switch on, index still off: restart needed');
assert.deepEqual((await (await host({})).call()).json, { on: true }, 'dsh does not say: no `active`');

// 4. Client: the Settings row is on by default, moves the Host switch, and shows when a restart applies the change.
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  let hostState = { on: true, active: true };
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (url !== CONTENT_SEARCH_PATH) return new Response('{}', { status: url === '/api/composer-plus.mobile' ? 200 : 404 });
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); if (hostState !== 404) hostState = { ...hostState, on: JSON.parse(init.body).on }; }
    return hostState === 404 ? new Response('', { status: 404 }) : new Response(JSON.stringify(hostState), { status: 200 });
  };
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }),
    useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
  const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
  const live = new Map(); let next = 0;
  plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
  await tick();
  const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
  const section = opts.inject();
  const t = (k, p) => (p?.error ? `${k}:${p.error}` : k);
  const row = () => Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature,
    mobile: section.mobile, resume: section.resume, contentSearch: section.contentSearch, t }).c.slice(5).find((r) => r.p.key === 'contentSearch');
  const status = () => row().c[1].c[4];
  const text = () => status().t({ mobile: section.contentSearch, t, prefix: 'contentSearch' })?.c[0] ?? null;
  assert.equal(row().c[2].p.checked, true, 'on by default');
  assert.equal(row().c[0].p.id, 'contentSearch', 'the row has its screenshot');
  assert.equal(status().t.name, 'MobileStatus'); assert.equal(status().p.prefix, 'contentSearch');
  assert.equal(text(), null, 'saved = running: nothing to say');
  await section.setFeature('contentSearch', false);
  assert.deepEqual(posts, [{ on: false }], 'the switch goes to the Host');
  assert.equal(mem.get('dsh-composer-plus.features') ?? null, null, 'not in browser storage');
  assert.equal(row().c[2].p.checked, false);
  assert.equal(text(), 'contentSearch.pending', 'the index is still open until dsh restarts');
  await section.setFeature('contentSearch', true);
  assert.equal(text(), null, 'back to the running state');
  hostState = 404; // an older Host half: no route until dsh restarts
  await section.setFeature('contentSearch', false);
  assert.equal(section.contentSearch.getSnapshot().on, true, 'the switch goes back');
  assert.equal(text(), 'contentSearch.restart');
}
rmSync(root, { recursive: true, force: true });
console.log('content-search checks passed');
