// Untangle codebase (Host half): the shipped SKILL.md is the pinned upstream copy with its license; the provider gives dsh's
// skill catalog one user-only skill (no model sees it in its catalog) at the bundled rank; the switch is on by default,
// is kept in a file, ends on the newest click, and switching off or unloading removes the provider.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNTANGLE_DIR, UNTANGLE_PATH, UNTANGLE_RANK, installUntangle, parseSkillFile } from '../index.js';

// The shipped copy: caldoai/skills commit f3cf47774975, unchanged, with its MIT license; the npm package ships it.
const raw = await readFile(join(UNTANGLE_DIR, 'SKILL.md'), 'utf8');
assert.equal(createHash('sha256').update(raw).digest('hex'), 'b4eb6b5130c38ca04532601e99d2d174cf4faa4df520b5b7ba609e8707e55761', 'SKILL.md is the pinned upstream copy');
assert.match(await readFile(join(UNTANGLE_DIR, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Copyright \(c\) 2026 Maze/);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.ok(pkg.files.includes('assets/skills/'), 'the npm package ships the skill and its license');

// The parser: the frontmatter gives the name and description, the body has no frontmatter.
const skill = parseSkillFile(raw);
assert.equal(skill.name, 'untangle-codebase');
assert.equal(skill.description, 'Untangle a whole codebase in one pass, so agents working in it read less per change, break less without noticing, and debug faster.');
assert.match(skill.content, /^Start a thorough refactor of this codebase/);
assert.doesNotMatch(skill.content, /disable-model-invocation|^---/m);
assert.deepEqual(parseSkillFile('---\nname: "a-b"\ndescription: \'Say: hi\'\n---\n\nBody\n'), { name: 'a-b', description: 'Say: hi', content: 'Body' });
for (const bad of ['no frontmatter', '---\nname: Bad Name\ndescription: x\n---\nB', '---\nname: a\n---\nB', '---\ndescription: x\n---\nB']) assert.throws(() => parseSkillFile(bad), JSON.stringify(bad));

const root = await mkdtemp(join(tmpdir(), 'cp-untangle-'));
try {
  const routes = new Map(); const live = new Map(); const effects = [];
  let disposed = 0;
  const ctx = {
    effect: (fn) => effects.push(fn()),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    inject: (deps, setup) => {
      assert.deepEqual(deps, ['skills']);
      const offs = [];
      setup({ skills: { registerProvider: (create) => { const p = create({ signal: new AbortController().signal, invalidate() {} }); live.set(p.name, p); offs.push(() => live.delete(p.name)); } } });
      return { dispose: () => { disposed++; offs.forEach((f) => f()); } };
    },
  };
  const home = join(root, 'home');
  const file = join(home, 'storages', 'dsh-composer-plus', 'untangle-codebase.json');
  const host = installUntangle(ctx, home);
  await host.ready;
  const req = async (body) => { const r = await routes.get(UNTANGLE_PATH).fetch(new Request(`http://h${UNTANGLE_PATH}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  assert.deepEqual((await req()).body, { on: true }, 'on by default');
  assert.deepEqual([...live.keys()], ['composer-plus'], 'on: the provider is registered');

  // What dsh's registry reads: one candidate, user-only, bundled rank, the provider's own name, the folder as resource base.
  const provider = live.get('composer-plus');
  const [candidate, ...more] = await provider.list();
  assert.equal(more.length, 0);
  assert.deepEqual(candidate, { name: 'untangle-codebase', description: skill.description, invocation: { modelInvocable: false, userInvocable: true },
    provider: 'composer-plus', source: 'bundled', resourceBase: { kind: 'directory', path: UNTANGLE_DIR }, rank: UNTANGLE_RANK });
  assert.equal(UNTANGLE_RANK, 600, "dsh's BUNDLED_SKILL_RANK: project and user skills come first");
  const loaded = await provider.get(candidate);
  assert.equal(loaded.content, skill.content);
  assert.equal(loaded.invocation.modelInvocable, false, 'never in the model catalog');
  assert.equal(loaded.name, candidate.name); assert.equal(loaded.provider, candidate.provider);

  for (const bad of [{ on: 'yes' }, { on: true, x: 1 }, {}, []]) assert.equal((await req(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await routes.get(UNTANGLE_PATH).fetch(new Request(`http://h${UNTANGLE_PATH}`, { method: 'POST', body: '{' }))).status, 400);

  // Off removes the provider and is kept; three clicks in a row end on the newest one.
  assert.deepEqual((await req({ on: false })).body, { on: false });
  assert.equal(live.size, 0, 'off removes the provider'); assert.ok(disposed >= 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { on: false });
  await Promise.all([req({ on: true }), req({ on: false }), req({ on: true }), req({ on: false })]);
  assert.deepEqual((await req()).body, { on: false }); assert.equal(live.size, 0);
  await req({ on: true }); assert.equal(live.size, 1);

  // A restart reads the saved switch: off stays off.
  await req({ on: false });
  const again = installUntangle({ ...ctx, connection: { fetch: { register: () => {} } } }, home);
  await again.ready; assert.equal(live.size, 0, 'the saved "off" comes back after a restart');
  await req({ on: true });

  // Plugin unload disposes the fiber.
  const before = disposed; effects.forEach((f) => typeof f === 'function' && f());
  assert.ok(disposed > before, 'unload disposes'); assert.equal(live.size, 0);

  // A broken copy fails the list (dsh's registry then skips this provider and logs it), it does not throw at install.
  const brokenDir = join(root, 'broken'); await mkdir(brokenDir); await writeFile(join(brokenDir, 'SKILL.md'), 'no frontmatter');
  const broken = installUntangle({ ...ctx, connection: { fetch: { register: () => {} } } }, join(root, 'home2'), undefined, brokenDir);
  await broken.ready; await assert.rejects(broken.provider.list(), /frontmatter/);
} finally { await rm(root, { recursive: true, force: true }); }

// Client half: the real client.js. The Settings row's switch is the Host's (on by default; a click posts {on} to the
// route; another browser sees the same state); an old Host without the route shows the restart text; the client adds no
// slot for this feature.
{
  const src = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
  const host = { on: true, posts: [], missing: false };
  globalThis.fetch = async (url, init) => {
    if (String(url) !== UNTANGLE_PATH) return { ok: false, status: 404, json: async () => ({}) };
    if (host.missing) return { ok: false, status: 404, json: async () => ({}) };
    if (init?.method === 'POST') { host.posts.push(JSON.parse(init.body)); host.on = JSON.parse(init.body).on; }
    return { ok: true, status: 200, json: async () => ({ on: host.on }) };
  };
  eval(src);
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
  const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }),
    useSyncExternalStore: (sub, get) => get(), useMemo: (f) => f(), useCallback: (f) => f };
  const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el) => el } : { Switch: 'Switch', Button: 'Button' }));
  const boot = () => {
    const regs = new Set();
    plugin.apply({ effect: (f) => { f(); }, locale: { register: () => () => {}, bind: () => (k) => k }, inject: () => ({ dispose() {} }), configForms: { get: () => ({}) },
      slots: { inject: (name, f) => f(), register: (o) => { regs.add(o); return () => { regs.delete(o); }; } }, get: () => undefined });
    return regs;
  };
  let regs = boot(); await flush();
  let settings = [...regs].find((o) => o.name === 'settings.section').inject();
  assert.deepEqual(settings.untangleSwitch.getSnapshot(), { on: true }, 'the Host switch, on by default');
  assert.equal(settings.hooks.composerPlusToggles.getSnapshot().untangleCodebase, true);
  const before = [...regs].length;
  await settings.setFeature('untangleCodebase', false); await flush();
  assert.deepEqual(host.posts, [{ on: false }], 'a click posts {on} to the Host route');
  assert.equal(settings.hooks.composerPlusToggles.getSnapshot().untangleCodebase, false);
  assert.equal([...regs].length, before, 'the client adds and removes no slot for this feature');
  assert.equal(mem.get('dsh-composer-plus.features') ?? null, null, 'not kept in this browser: the Host keeps it');
  regs = boot(); await flush(); settings = [...regs].find((o) => o.name === 'settings.section').inject();
  assert.equal(settings.hooks.composerPlusToggles.getSnapshot().untangleCodebase, false, 'another window reads the Host');
  host.missing = true; await settings.untangleSwitch.refresh();
  assert.equal(settings.untangleSwitch.getSnapshot().restart, true, 'an older Host: the row says to restart dsh');
}
console.log('untangle codebase checks passed');
