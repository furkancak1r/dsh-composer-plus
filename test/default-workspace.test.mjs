// Default workspace (Host half): the saved switch and choice, the target of the global New session (the chosen project
// while dsh has it, else dsh's general folder, made and registered on first use; two calls at once register one
// project), the body checks of both routes and 409 while the switch is off. Fake dsh registry, real files.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, DEFAULT_WORKSPACE_PATH, defaultWorkspaceTarget, ensureDefaultWorkspace, generalWorkspace, NEW_SESSION_WORKSPACE_PATH } from '../index.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-default-ws-')));
/** Like dsh's WorkspaceRegistry: `get`, `list` (registry order), `create(path)` idempotent per real path, one at a time. */
function registry(rows = []) {
  const entities = new Map(rows.map((r) => [r.id, { ...r }]));
  let queue = Promise.resolve(); let made = 0;
  return {
    entities, created: () => made,
    get: (id) => entities.get(id),
    list: () => [...entities.values()],
    create(path, title) {
      const done = queue.then(async () => {
        await new Promise((r) => setTimeout(r, 5));
        if (!statSync(path).isDirectory()) throw new Error('not a directory');
        const real = realpathSync(path);
        for (const e of entities.values()) if (e.path === real) return e;
        made += 1;
        const e = { id: `w${entities.size + 1}`, path: real, title: title ?? real.split('/').at(-1) };
        entities.set(e.id, e); return e;
      });
      queue = done.catch(() => {});
      return done;
    },
  };
}

// The general folder: dsh's own registered folder wins, wherever Documents is; else the home path, not registered.
{
  const osHome = join(root, 'home1');
  const r = registry([{ id: 'a', path: '/p/acme', title: 'acme' }, { id: 'g', path: '/Volumes/Docs/deepseek-harness/default-workspace', title: 'default-workspace' }]);
  assert.deepEqual(generalWorkspace(r, osHome), { workspaceId: 'g', path: '/Volumes/Docs/deepseek-harness/default-workspace', title: 'default-workspace' });
  assert.deepEqual(generalWorkspace(registry([{ id: 'x', path: '/p/default-workspace', title: 'x' }]), osHome),
    { path: join(osHome, 'Documents', 'deepseek-harness', 'default-workspace') }, 'only the deepseek-harness/default-workspace folder counts');
}
// The target: the chosen project while dsh has it; a removed one falls back to the general folder. Nothing is written.
{
  const osHome = join(root, 'home2');
  const r = registry([{ id: 'casual', path: '/p/casual', title: 'casual' }]);
  assert.deepEqual(defaultWorkspaceTarget(r, { on: true, workspaceId: 'casual' }, osHome), { workspaceId: 'casual', path: '/p/casual', title: 'casual', general: false });
  assert.deepEqual(defaultWorkspaceTarget(r, { on: true, workspaceId: 'gone' }, osHome), { path: join(osHome, 'Documents/deepseek-harness/default-workspace'), general: true });
  assert.deepEqual(defaultWorkspaceTarget(r, { on: true }, osHome).general, true);
  assert.equal(existsSync(join(osHome, 'Documents')), false, 'the target alone makes no folder');
}
// First use: the folder is made and registered once, also with two calls at the same time; then the same project.
{
  const osHome = join(root, 'home3');
  const r = registry([{ id: 'a', path: '/p/acme', title: 'acme' }]);
  const [one, two] = await Promise.all([ensureDefaultWorkspace(r, { on: true }, osHome), ensureDefaultWorkspace(r, { on: true }, osHome)]);
  const path = join(osHome, 'Documents/deepseek-harness/default-workspace');
  assert.ok(statSync(path).isDirectory());
  assert.deepEqual(one, { workspaceId: 'w2', path, title: 'default-workspace', general: true });
  assert.deepEqual(two, one, 'the same project');
  assert.equal(r.created(), 1, 'one project');
  assert.deepEqual(await ensureDefaultWorkspace(r, { on: true }, osHome), one, 'found by its path the next time');
  assert.deepEqual(await ensureDefaultWorkspace(r, { on: true, workspaceId: 'a' }, osHome), { workspaceId: 'a', path: '/p/acme', title: 'acme', general: false });
}
// The routes, with a real settings file under a temporary DSH_HOME.
{
  const home = join(root, 'dsh-home');
  process.env.DSH_HOME = home;
  const osHome = join(root, 'os-home');
  process.env.HOME = osHome; // os.homedir() reads HOME on macOS and Linux
  const r = registry([{ id: 'casual', path: '/p/casual', title: 'casual' }, { id: 'acme', path: '/p/acme', title: 'acme' }]);
  const routes = new Map();
  apply({ on() {}, effect() {}, get: (name) => (name === 'workspaceRegistry' ? r : undefined), connection: { fetch: { register: (x) => routes.set(x.path, x) } },
    subprocess: {}, sessionQuery: {}, sessionController: {} });
  const settings = routes.get(DEFAULT_WORKSPACE_PATH); const target = routes.get(NEW_SESSION_WORKSPACE_PATH);
  assert.deepEqual(settings.methods, ['GET', 'POST']); assert.deepEqual(target.methods, ['POST']);
  const call = async (route, path, method, body) => {
    const response = await route.fetch(new Request(`http://h${path}`, method === 'GET' ? {} : { method, body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: response.status, data: await response.json() };
  };
  const general = { path: join(osHome, 'Documents/deepseek-harness/default-workspace') };
  assert.deepEqual(await call(settings, DEFAULT_WORKSPACE_PATH, 'GET'), { status: 200, data: { on: true, available: true, general } }, 'no file: on, no choice');
  // Body checks: one known key with the right type.
  for (const bad of ['not json', [], null, {}, { on: 'yes' }, { workspaceId: 7 }, { workspaceId: '' }, { workspaceId: 'x'.repeat(129) }, { on: true, workspaceId: 'casual' }, { path: '/etc' }]) {
    assert.equal((await call(settings, DEFAULT_WORKSPACE_PATH, 'POST', bad)).status, 400, `400 for ${JSON.stringify(bad)}`);
  }
  assert.equal((await call(settings, DEFAULT_WORKSPACE_PATH, 'POST', { workspaceId: 'nope' })).status, 409, 'an unknown project is refused');
  let s = await call(settings, DEFAULT_WORKSPACE_PATH, 'POST', { workspaceId: 'casual' });
  assert.deepEqual(s, { status: 200, data: { on: true, workspaceId: 'casual', available: true, general } });
  assert.deepEqual((await call(target, NEW_SESSION_WORKSPACE_PATH, 'POST', {})).data, { workspaceId: 'casual', path: '/p/casual', title: 'casual', general: false }, 'New session opens casual');
  assert.equal(existsSync(general.path), false, 'no general folder while a project is chosen');
  // The project goes away in dsh: Settings says so, New session opens the general folder.
  r.entities.delete('casual');
  s = await call(settings, DEFAULT_WORKSPACE_PATH, 'GET');
  assert.equal(s.data.gone, true);
  const opened = await call(target, NEW_SESSION_WORKSPACE_PATH, 'POST', {});
  assert.equal(opened.status, 200); assert.equal(opened.data.general, true); assert.equal(opened.data.path, general.path);
  assert.ok(statSync(general.path).isDirectory(), 'made at the first use');
  s = await call(settings, DEFAULT_WORKSPACE_PATH, 'GET');
  assert.deepEqual(s.data.general, { workspaceId: opened.data.workspaceId, path: general.path, title: 'default-workspace' }, 'now registered');
  // null clears the choice; the switch is kept apart from it.
  s = await call(settings, DEFAULT_WORKSPACE_PATH, 'POST', { workspaceId: 'acme' });
  s = await call(settings, DEFAULT_WORKSPACE_PATH, 'POST', { on: false });
  assert.deepEqual([s.data.on, s.data.workspaceId], [false, 'acme'], 'the switch keeps the choice');
  assert.deepEqual(await call(target, NEW_SESSION_WORKSPACE_PATH, 'POST', {}), { status: 409, data: { error: 'off' } }, 'off: dsh picks');
  s = await call(settings, DEFAULT_WORKSPACE_PATH, 'POST', { on: true });
  s = await call(settings, DEFAULT_WORKSPACE_PATH, 'POST', { workspaceId: null });
  assert.equal(s.data.workspaceId, undefined); assert.equal(s.data.on, true);
  // The target route takes only an empty object: the browser never sends a path.
  for (const bad of ['not json', [], { path: '/etc' }, { workspaceId: 'acme' }]) assert.equal((await call(target, NEW_SESSION_WORKSPACE_PATH, 'POST', bad)).status, 400);
  // A broken file reads as on with no choice.
  mkdirSync(join(home, 'storages/dsh-composer-plus'), { recursive: true });
  writeFileSync(join(home, 'storages/dsh-composer-plus/default-workspace.json'), '{broken');
  assert.deepEqual((await call(settings, DEFAULT_WORKSPACE_PATH, 'GET')).data.on, true);
  assert.equal(statSync(join(home, 'storages/dsh-composer-plus')).isDirectory(), true);
}
// A dsh without the registry: Settings hides the picker, New session leaves dsh's choice.
{
  const routes = new Map();
  apply({ on() {}, effect() {}, get: () => undefined, connection: { fetch: { register: (x) => routes.set(x.path, x) } }, subprocess: {}, sessionQuery: {}, sessionController: {} });
  const res = await routes.get(DEFAULT_WORKSPACE_PATH).fetch(new Request(`http://h${DEFAULT_WORKSPACE_PATH}`));
  assert.equal((await res.json()).available, false);
  const t = await routes.get(NEW_SESSION_WORKSPACE_PATH).fetch(new Request(`http://h${NEW_SESSION_WORKSPACE_PATH}`, { method: 'POST', body: '{}' }));
  assert.equal(t.status, 503);
}
console.log('default workspace host checks passed');
