// Assistant setup (Obsidian is required): the Host checks Obsidian, its vault, Project memory in that vault and the vault's
// AGENTS.md; Set up does the parts that Composer Plus may do (never installs Obsidian, never writes over an AGENTS.md); until
// it is ready, the memory tools and the review save no note of the assistant chat or its subagents (other chats keep their
// memory). The client shows the setup card in the assistant chat until ready, with Set up, Check again and the download link.
import './temp-home.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, realpath, rename, lstat, chmod } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_SETUP_PATH, OBSIDIAN_DOWNLOAD, SETUP_BLOCKED, assistantSetup, installAssistantSetup, installMemory, memoryNamesOf, obsidianApps, obsidianConfigs, vaultRules } from '../index.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-setup-')));
try {
  // The default places of Obsidian (app and settings file) on each system.
  assert.deepEqual(obsidianApps('darwin', '/Users/u'), ['/Applications/Obsidian.app', '/Users/u/Applications/Obsidian.app']);
  assert.deepEqual(obsidianConfigs('darwin', '/Users/u'), ['/Users/u/Library/Application Support/obsidian/obsidian.json']);
  assert.deepEqual(obsidianApps('win32', 'C:\\Users\\u', { LOCALAPPDATA: 'L', ProgramFiles: 'P' }).length, 2);
  assert.equal(obsidianConfigs('win32', 'C:\\Users\\u', {}).length, 0, 'no APPDATA: no file');
  assert.ok(obsidianConfigs('linux', '/home/u', { XDG_CONFIG_HOME: '/x' })[0] === '/x/obsidian/obsidian.json');
  assert.ok(obsidianApps('linux', '/home/u').includes('/var/lib/flatpak/exports/bin/md.obsidian.Obsidian'));

  const home = join(root, 'home'); const folder = join(home, 'Assistant');
  const app = join(root, 'Applications', 'Obsidian.app'); const config = join(root, 'obsidian.json');
  const vaults = (paths) => writeFile(config, JSON.stringify({ vaults: Object.fromEntries(paths.map((p, i) => [`v${i}`, { path: p, ts: 1, open: true }])) }));
  const memoryState = { on: false, folder: '', folderActive: '' };
  const memory = { state: () => ({ ...memoryState }) };
  const check = () => assistantSetup({ folder, memory, home, apps: [app], configs: [config] });

  // 1. Not installed: no app, no settings file.
  let s = await check();
  assert.equal(s.ready, false); assert.equal(s.steps.obsidian, false); assert.equal(s.steps.vault, false);
  assert.equal(s.download, OBSIDIAN_DOWNLOAD); assert.equal(s.folder, '~/Assistant', 'the folder as the user sees it');
  // 2. Installed (the app is there), the vault folder is missing.
  await mkdir(app, { recursive: true });
  s = await check();
  assert.equal(s.steps.obsidian, true); assert.equal(s.steps.vault, false); assert.equal(s.ready, false);
  // 3. The folder is there, but not in obsidian.json (another vault is).
  await mkdir(folder, { recursive: true }); await mkdir(join(root, 'other'));
  await vaults([join(root, 'other')]);
  s = await check();
  assert.equal(s.steps.vault, false, 'a folder that Obsidian does not know is no vault');
  await writeFile(config, '{broken'); s = await check(); assert.equal(s.steps.vault, false, 'a broken obsidian.json: no vault, no crash');
  // 4. Obsidian knows it: vault done; the memory and the rules are still missing.
  await vaults([join(root, 'other'), folder]);
  s = await check();
  assert.deepEqual(s.steps, { obsidian: true, vault: true, memory: 'missing', rules: false }); assert.equal(s.ready, false);
  // obsidian.json alone counts as installed (Windows or a portable app in another folder).
  assert.equal((await assistantSetup({ folder, memory, home, apps: [], configs: [config] })).steps.obsidian, true);
  // A vault above the folder counts too.
  await vaults([home]); assert.equal((await check()).steps.vault, true, 'a vault that holds the folder');
  await vaults([folder]);
  // 5. Memory saved into the vault but not active yet: restart; active: done. A memory folder outside the vault: missing.
  Object.assign(memoryState, { on: true, folder: join(folder, 'Hafıza'), folderActive: '' });
  assert.equal((await check()).steps.memory, 'restart');
  Object.assign(memoryState, { folderActive: join(folder, 'Hafıza') });
  assert.equal((await check()).steps.memory, 'done');
  Object.assign(memoryState, { folder: join(root, 'elsewhere'), folderActive: join(root, 'elsewhere') });
  assert.equal((await check()).steps.memory, 'missing', 'a memory folder outside the vault');
  Object.assign(memoryState, { on: false, folder: join(folder, 'Hafıza'), folderActive: join(folder, 'Hafıza') });
  assert.equal((await check()).steps.memory, 'missing', 'memory off');
  Object.assign(memoryState, { on: true, folderProblem: 'x is a symbolic link' });
  assert.equal((await check()).steps.memory, 'missing', 'a memory folder with a problem');
  delete memoryState.folderProblem;
  // 6. Ready: AGENTS.md is there.
  await writeFile(join(folder, 'AGENTS.md'), '# My rules\n');
  s = await check();
  assert.deepEqual(s.steps, { obsidian: true, vault: true, memory: 'done', rules: true }); assert.equal(s.ready, true);
  // 7. The owner's later rename: the folder moves to ~/Damon, ~/Assistant links to it, Obsidian knows ~/Damon. Still ready,
  //    and no folder name is fixed.
  const damon = join(home, 'Damon');
  await rename(folder, damon); await symlink(damon, folder);
  Object.assign(memoryState, { folder: join(damon, 'Hafıza'), folderActive: join(damon, 'Hafıza') });
  await vaults([damon]);
  assert.equal((await check()).ready, true, 'after the rename to ~/Damon');
  await rm(folder); await rename(damon, folder); await vaults([folder]);
  Object.assign(memoryState, { folder: join(folder, 'Hafıza'), folderActive: join(folder, 'Hafıza') });

  // installAssistantSetup with the real installMemory: the gate, the route, Set up.
  const dshHome = join(root, 'dsh');
  const routes = new Map(); const tools = new Map(); const on = {};
  const ctx = {
    on: (name, fn) => { (on[name] ??= []).push(fn); }, effect: () => {}, logger: { warn: () => {} },
    get: () => undefined,
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    // Saved chat headers: a gone subagent (s-gone) between a nested subagent and the assistant chat.
    sessionQuery: { observeSession: async (id) => ({ events: [], header: { cwd: folder, ...(id === 's-gone' ? { origin: 'subagent', parentSession: 'chat-a' } : {}) } }) },
    inject: (deps, setup) => { setup({ tools: { register: (t) => tools.set(t.name, t) }, systemPrompt: { section: () => {} } }); return { dispose: () => tools.clear() }; },
  };
  const mem = installMemory(ctx, dshHome); await mem.ready;
  const assistantIsOn = { on: true };
  const assistant = { ready: Promise.resolve(), isOn: () => assistantIsOn.on, id: () => 'chat-a', folder };
  const fresh = join(root, 'fresh'); await mkdir(fresh);
  const freshConfig = join(root, 'fresh.json');
  installAssistantSetup(ctx, { ...assistant, folder: fresh }, mem, { home, apps: [join(root, 'none.app')], configs: [freshConfig] });
  const call = async (body) => { const r = await routes.get(ASSISTANT_SETUP_PATH).fetch(new Request(`http://h${ASSISTANT_SETUP_PATH}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  let r = await call();
  assert.equal(r.status, 200); assert.equal(r.body.ready, false); assert.equal(r.body.steps.obsidian, false, 'a new user without Obsidian');
  // The gate: memory is on, but the assistant chat (and its subagents) save nothing; another chat saves.
  await routes.get('/api/composer-plus.memory').fetch(new Request('http://h/api/composer-plus.memory', { method: 'POST', body: JSON.stringify({ on: true }) }));
  const exec = (id, cwd, parent) => ({ agent: { id, session: { header: { cwd, ...(parent ? { origin: 'subagent', parentSession: parent } : {}) } } } });
  await assert.rejects(tools.get('memory_remember').execute({ text: 'The user likes tea' }, exec('chat-a', fresh)), (e) => e.message === SETUP_BLOCKED);
  await assert.rejects(tools.get('memory_forget').execute({ entry: 'tea' }, exec('chat-a', fresh)), (e) => e.message === SETUP_BLOCKED);
  await assert.rejects(tools.get('memory_remember').execute({ text: 'The user likes tea' }, exec('s-sub0', fresh, 'chat-a')), (e) => e.message === SETUP_BLOCKED, 'a subagent of the assistant chat too');
  await assert.rejects(tools.get('memory_remember').execute({ text: 'The user likes tea' }, exec('s-nested', fresh, 's-gone')), (e) => e.message === SETUP_BLOCKED, 'a nested subagent whose parent is gone: its saved header');
  assert.match(await tools.get('memory_recall').execute({}, exec('chat-a', fresh)), /0 entries/, 'recall still reads');
  const other = join(root, 'proj'); await mkdir(other);
  assert.match(await tools.get('memory_remember').execute({ text: 'The user deploys on Fridays' }, exec('chat-b', other)), /^Saved/, 'another chat keeps its memory');
  assert.deepEqual(await readdir(fresh), [], 'nothing written into the assistant folder');
  // The review of the blocked chat does not read it (its cursor stays).
  await mem.review('chat-a');
  assert.equal(JSON.parse(await readFile(join(dshHome, 'storages/dsh-composer-plus/memory/reviewed.json'), 'utf8').catch(() => '{}'))['chat-a'], undefined, 'no review cursor for the blocked chat');
  // Assistant off: the gate lets every chat save; the route says off.
  assistantIsOn.on = false;
  assert.equal((await call()).status, 409);
  assistantIsOn.on = true;
  // Bad bodies.
  for (const bad of [{}, { fix: {} }, { fix: { name: '../x' } }, { fix: { name: '.hidden' } }, { fix: { name: 'a/b' } }, { fix: { name: 'M' }, x: 1 },
    { fix: { name: 'M', dirs: { global: 'a/b', projects: 'P' } } }, { fix: { name: 'M', dirs: { global: 'Same', projects: 'same' } } }, { fix: { name: 'M', dirs: { global: 'G' } } }, { fix: { name: 'M', other: 1 } }]) assert.equal((await call(bad)).status, 400, JSON.stringify(bad));
  // Set up: memory folder inside the assistant folder (restart) with the UI language's subfolder names, AGENTS.md from the
  // template; it installs nothing.
  r = await call({ fix: { name: 'Memory', dirs: { global: 'General', projects: 'Projects' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.steps.memory, 'restart'); assert.equal(r.body.steps.rules, true); assert.equal(r.body.steps.obsidian, false, 'Obsidian is not installed for the user');
  assert.deepEqual(JSON.parse(await readFile(join(dshHome, 'storages/dsh-composer-plus/memory-folder.json'), 'utf8')), { folder: join(fresh, 'Memory'), names: { global: 'General', projects: 'Projects' } });
  assert.equal(await readFile(join(fresh, 'AGENTS.md'), 'utf8'), vaultRules('Memory', { global: 'General', projects: 'Projects' }));
  assert.match(vaultRules('Memory', { global: 'General', projects: 'Projects' }), /Memory\/: General\/ for every project, Projects\/<project>\//);
  // A second Set up never writes over a file that is there (the user's own AGENTS.md).
  await writeFile(join(fresh, 'AGENTS.md'), '# Mine\n');
  await call({ fix: { name: 'Memory' } });
  assert.equal(await readFile(join(fresh, 'AGENTS.md'), 'utf8'), '# Mine\n', 'the user\'s AGENTS.md stays');
  // An empty AGENTS.md (a write that failed half way) is written again.
  await writeFile(join(fresh, 'AGENTS.md'), '');
  r = await call({ fix: { name: 'Memory' } });
  assert.equal(r.body.steps.rules, true); assert.equal(await readFile(join(fresh, 'AGENTS.md'), 'utf8'), vaultRules('Memory', { global: 'General', projects: 'Projects' }), 'an empty file is repaired');
  // All or none: when writing AGENTS.md fails, the folder setting and the switch go back and no AGENTS.md stays.
  { const home4 = join(root, 'dsh4'); const mem4 = installMemory({ ...ctx, inject: undefined, connection: { fetch: { register: () => {} } } }, home4); await mem4.ready;
    const f4 = join(root, 'f4'); await mkdir(f4);
    const s4 = installAssistantSetup({ ...ctx, connection: { fetch: { register: () => {} } } }, { ...assistant, folder: f4 }, mem4, { home, apps: [], configs: [] });
    // AGENTS.md is the user's link to a missing file: Set up says why, changes nothing and keeps the link.
    await symlink(join(root, 'missing-dir', 'x'), join(f4, 'AGENTS.md'));
    await assert.rejects(s4.fix('Memory'), /AGENTS\.md is a link to a missing or empty file/);
    assert.equal(mem4.state().on, false, 'nothing saved'); assert.ok((await lstat(join(f4, 'AGENTS.md'))).isSymbolicLink(), 'the link stays');
    await rm(join(f4, 'AGENTS.md'));
    // A link to an empty file is the user's too: it is not removed.
    await writeFile(join(root, 'empty.md'), ''); await symlink(join(root, 'empty.md'), join(f4, 'AGENTS.md'));
    await assert.rejects(s4.fix('Memory'), /link to a missing or empty file/);
    assert.ok((await lstat(join(f4, 'AGENTS.md'))).isSymbolicLink(), 'a link to an empty file stays');
    await rm(join(f4, 'AGENTS.md'));
    await s4.fix('Memory'); assert.equal(mem4.state().on, true, 'without the link, Set up saves');
    const f5 = join(root, 'f5'); await mkdir(f5);
    const home5 = join(root, 'dsh5'); const mem5 = installMemory({ ...ctx, inject: undefined, connection: { fetch: { register: () => {} } } }, home5); await mem5.ready;
    const failing = { ...mem5, setup: (plan) => mem5.setup(async (m) => ({ ...(await plan(m)), rules: { path: join(root, 'no-such-dir', 'AGENTS.md'), text: 'x' } })) };
    const s5 = installAssistantSetup({ ...ctx, connection: { fetch: { register: () => {} } } }, { ...assistant, folder: f5 }, failing, { home, apps: [], configs: [] });
    await assert.rejects(s5.fix('Memory'));
    assert.deepEqual(mem5.state(), { on: false, folder: '', folderActive: '' }, 'the folder setting and the switch went back');
    assert.equal(await readFile(join(home5, 'storages/dsh-composer-plus/memory.json'), 'utf8').then((t) => JSON.parse(t).on, () => false), false);
    assert.equal(await readFile(join(home5, 'storages/dsh-composer-plus/memory-folder.json'), 'utf8').then((t) => JSON.parse(t).folder, () => undefined), undefined); }
  // A saved memory folder that is already in the vault is kept (the owner's Hafıza): Set up changes nothing.
  const ownerPlan = []; const owner = { state: () => ({ on: true, folder: join(folder, 'Hafıza'), folderActive: join(folder, 'Hafıza') }), setup: async (plan) => { ownerPlan.push(await plan({ ...owner.state(), names: (at, w) => memoryNamesOf(at, w) })); } };
  const keep = installAssistantSetup({ ...ctx, connection: { fetch: { register: () => {} } } }, assistant, owner, { home, apps: [app], configs: [config] });
  assert.equal((await keep.fix('Memory')).ready, true, 'the owner\'s setup passes without a change');
  assert.equal(ownerPlan[0].folder, undefined, 'the owner\'s memory folder stays');
  assert.equal(await readFile(join(folder, 'AGENTS.md'), 'utf8'), '# My rules\n');
  // A saved folder in the vault that cannot hold the notes (a symlink) is replaced by <vault>/<name>.
  { const linkPlan = []; await symlink(join(root, 'other'), join(folder, 'Linked'));
    const bad = { state: () => ({ on: true, folder: join(folder, 'Linked'), folderActive: '', folderProblem: 'is a symbolic link' }), setup: async (plan) => { linkPlan.push(await plan({ ...bad.state(), names: (at, w) => memoryNamesOf(at, w) })); } };
    await installAssistantSetup({ ...ctx, connection: { fetch: { register: () => {} } } }, assistant, bad, { home, apps: [app], configs: [config] }).fix('Memory');
    assert.equal(linkPlan[0].folder, join(await realpath(folder), 'Memory'), 'a symlinked memory folder is not kept');
    await rm(join(folder, 'Linked')); }
  // Folder names (owner, 2026-11-12): a new memory folder uses the saved (UI language) names; a folder that has its
  // subfolders keeps them, under either name pair; the owner's Genel/Projeler is never renamed.
  { const dshN = join(root, 'dshN'); const sN = join(dshN, 'storages/dsh-composer-plus'); await mkdir(sN, { recursive: true });
    const vN = join(root, 'vN', 'Memory');
    await writeFile(join(sN, 'memory.json'), JSON.stringify({ on: true }));
    await writeFile(join(sN, 'memory-folder.json'), JSON.stringify({ folder: vN, names: { global: 'General', projects: 'Projects' } }));
    const mN = installMemory({ ...ctx, inject: undefined, connection: { fetch: { register: () => {} } } }, dshN); await mN.ready;
    await mN.store.add({ scope: mN.store.GLOBAL, text: 'A note in English folders', actor: 'agent' });
    assert.equal(mN.store.GLOBAL.dir, join(vN, 'General'), 'a new folder: the UI language names');
    assert.deepEqual(JSON.parse(await readFile(join(sN, 'memory-folder.json'), 'utf8')), { folder: vN, imported: vN, names: { global: 'General', projects: 'Projects' }, importedNames: { global: 'General', projects: 'Projects' } }, 'the names stay in the setting');
    // An existing folder with Genel/Projeler keeps them, also when the saved names are others.
    const vO = join(root, 'vO'); await mkdir(join(vO, 'Genel'), { recursive: true }); await writeFile(join(vO, 'Genel', 'MEMORY.md'), '# Memory\n\n- Owner note\n\n## Index\n');
    assert.deepEqual(memoryNamesOf(vO, { global: 'General', projects: 'Projects' }), { global: 'Genel', projects: 'Projeler' });
    assert.deepEqual(memoryNamesOf(vN), { global: 'Genel', projects: 'Projeler' }, 'without the saved names, the first names (no folder of them there)');
    assert.deepEqual(memoryNamesOf(vN, { global: 'General', projects: 'Projects' }), { global: 'General', projects: 'Projects' });
    assert.deepEqual(memoryNamesOf(join(root, 'nothing'), { global: 'Allgemein', projects: 'Projekte' }), { global: 'Allgemein', projects: 'Projekte' });
    // The notes move with their own names: English Set up, a move to another folder by hand, then a German Set up. Each
    // restart copies every note (review 2026-11-12: the copy read the old folder with the new names and lost them).
    const mCtx = { ...ctx, inject: undefined, connection: { fetch: { register: () => {} } } };
    const restart = async () => { const m = installMemory(mCtx, dshN); await m.ready; return m; };
    const notes = join(root, 'vN-notes');
    const raw = JSON.parse(await readFile(join(sN, 'memory-folder.json'), 'utf8'));
    await writeFile(join(sN, 'memory-folder.json'), JSON.stringify({ ...raw, folder: notes })); // Settings → Memory folder
    let mm = await restart();
    assert.match(await readFile(join(notes, 'General', 'MEMORY.md'), 'utf8'), /A note in English folders/, 'the move copies the notes (English names)');
    assert.deepEqual(JSON.parse(await readFile(join(sN, 'memory-folder.json'), 'utf8')).importedNames, { global: 'General', projects: 'Projects' });
    const vG = join(root, 'vG', 'Gedächtnis');
    await mm.setup(async (st) => ({ folder: vG, names: { global: 'Allgemein', projects: 'Projekte' } }));
    mm = await restart();
    assert.match(await readFile(join(vG, 'Allgemein', 'MEMORY.md'), 'utf8'), /A note in English folders/, 'a German Set up still copies the notes from the English folders');
    assert.equal(mm.store.GLOBAL.dir, join(vG, 'Allgemein'));
    // The copy works but the setting file is not saved: the names of the notes stay with their folder (review 2026-11-12).
    const vF = join(root, 'vF', 'Mémoire');
    await writeFile(join(sN, 'memory-folder.json'), JSON.stringify({ ...JSON.parse(await readFile(join(sN, 'memory-folder.json'), 'utf8')), folder: vF, names: { global: 'Général', projects: 'Projets' } }));
    await chmod(sN, 0o500);
    try { mm = await restart(); } finally { await chmod(sN, 0o700); }
    assert.match(await readFile(join(vF, 'Général', 'MEMORY.md'), 'utf8'), /A note in English folders/);
    await mm.setup(async () => ({ folder: join(root, 'vF2') })); // a later save writes the names that it holds
    const saved = JSON.parse(await readFile(join(sN, 'memory-folder.json'), 'utf8'));
    assert.deepEqual([saved.imported, saved.importedNames], [vG, { global: 'Allgemein', projects: 'Projekte' }], 'a failed save keeps the old folder with its own names'); }
  // Ready (Obsidian knows the fresh folder, the memory is active): the gate opens.
  await vaults([fresh]);
  const readySetup = installAssistantSetup({ ...ctx, connection: { fetch: { register: () => {} } } }, { ...assistant, folder: fresh }, { ...mem, state: () => ({ on: true, folder: join(fresh, 'Memory'), folderActive: join(fresh, 'Memory') }) }, { home, apps: [app], configs: [config] });
  assert.equal((await readySetup.check()).ready, true);
  assert.match(await tools.get('memory_remember').execute({ text: 'The user likes tea' }, exec('s-sub', fresh, 'chat-a')), /^Saved/, 'ready: the assistant\'s subagent saves');

  // Client: the card shows in the assistant chat until ready (also after the first message), with the steps, the
  // download link, Set up and Check again; ready → the welcome card on a blank chat, nothing later.
  const mem2 = new Map();
  globalThis.localStorage = { getItem: (k) => (mem2.has(k) ? mem2.get(k) : null), setItem: (k, v) => mem2.set(k, String(v)) };
  globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  let hostState = { ready: false, folder: '~/Assistant', download: OBSIDIAN_DOWNLOAD, steps: { obsidian: false, vault: false, memory: 'missing', rules: false } };
  const posts = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/composer-plus.assistant-switch') return Response.json({ on: true });
    if (String(url) === '/api/composer-plus.assistant') return Response.json({ sessionId: 's-assistant' });
    if (String(url) === ASSISTANT_SETUP_PATH) { if (init?.method === 'POST') posts.push(JSON.parse(init.body)); return Response.json(hostState); }
    return new Response('{}', { status: 404 });
  };
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  const effects = [];
  const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }),
    useEffect: (f) => { effects.push(f); }, useSyncExternalStore: (_s, get) => get(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {} };
  const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
  const live = new Map(); let next = 0;
  plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: () => ({ openSession: () => {} }), locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x },
    slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
  const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res)); };
  await tick();
  const [entry, Welcome] = [...live.values()].find(([o]) => o.name === 'conversation.input.dock' && o.id === 'assistant-welcome');
  const { assistant: store, setup: setupStore } = entry.inject('x');
  await store.open(() => {});
  const t = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k);
  const text = (n) => (n == null || n === false ? '' : typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : `${text(n.c)}`);
  const find = (n, pred, out = []) => { if (n && typeof n === 'object' && !Array.isArray(n)) { if (pred(n)) out.push(n); (n.c ?? []).forEach((c) => find(c, pred, out)); } else if (Array.isArray(n)) n.forEach((c) => find(c, pred, out)); return out; };
  const draw = (blank) => { effects.length = 0; const out = Welcome({ sessionId: 's-assistant', useSession: (sel) => sel({ blank, promptAttempted: !blank, running: false }), assistant: store, setup: setupStore, t }); return out?.t === 'function' || typeof out?.t === 'function' ? out.t(out.p) : out; };
  // Not read yet: nothing shows (no card flashes on a Mac that is ready); the card asks the Host once (its effect).
  let card = draw(true); assert.equal(card, null, 'nothing before the first answer'); for (const f of effects) f(); await tick();
  card = draw(false);
  assert.equal(card.p['data-composer-plus-assistant-setup'], '', 'the setup card, also after the first message');
  const steps = find(card, (n) => n.p?.['data-step'] !== undefined);
  assert.deepEqual(steps.map((n) => [n.p['data-step'], n.p['data-state']]), [['obsidian', 'missing'], ['vault', 'missing'], ['memory', 'missing'], ['rules', 'missing']]);
  const link = find(card, (n) => n.t === 'a')[0];
  assert.equal(link.p.href, OBSIDIAN_DOWNLOAD); assert.equal(link.p.rel, 'noopener noreferrer'); assert.equal(text(link), 'assistant.setup.download');
  assert.match(text(card), /assistant\.setup\.vault:\{"folder":"~\/Assistant"\}/);
  const buttons = find(card, (n) => n.t === 'Button');
  assert.deepEqual(buttons.map(text), ['assistant.setup.fix', 'assistant.setup.check']);
  buttons[0].p.onClick(); await tick();
  assert.deepEqual(posts, [{ fix: { name: 'assistant.setup.memoryDir', dirs: { global: 'assistant.setup.globalDir', projects: 'assistant.setup.projectsDir' } } }], 'Set up sends the memory folder name and its subfolder names in the UI language');
  // Check again reads the Host; ready → the welcome card on a blank chat, nothing after the first message.
  hostState = { ...hostState, ready: true, steps: { obsidian: true, vault: true, memory: 'done', rules: true } };
  find(draw(false), (n) => n.t === 'Button').at(-1).p.onClick(); await tick();
  assert.equal(draw(true).p['aria-label'], 'assistant.welcome.title', 'ready: the welcome card');
  assert.equal(draw(false), null, 'ready and not blank: no card');
  // Only Obsidian and the vault missing: no Set up button (the user does those).
  hostState = { ready: false, folder: '~/Assistant', download: OBSIDIAN_DOWNLOAD, steps: { obsidian: false, vault: false, memory: 'done', rules: true } };
  setupStore.reset(); await setupStore.check();
  assert.deepEqual(find(draw(false), (n) => n.t === 'Button').map(text), ['assistant.setup.check']);
  // A failed read shows the reason, and the card stays.
  globalThis.fetch = async () => Response.json({ error: 'disk' }, { status: 500 });
  await setupStore.check();
  assert.match(text(draw(false)), /assistant\.setup\.failed:\{"error":"disk"\}/);
  // Switched off and on while a read runs: reset drops that read, and the next check reads again (no lost card).
  { let release; globalThis.fetch = () => new Promise((res) => { release = () => res(Response.json(hostState)); });
    const pending = setupStore.check(); setupStore.reset();
    globalThis.fetch = async () => Response.json({ ...hostState, ready: false });
    await setupStore.check(); release(); await pending;
    assert.equal(setupStore.getSnapshot()?.ready, false, 'the new read wins; the old one is dropped'); }
  // An older Host without the route (dsh not restarted after an update): no card, the chat works as before.
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  await setupStore.check();
  assert.equal(draw(false), null, 'no setup card with an older Host');
  console.log('assistant setup checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
