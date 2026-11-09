// Memory folder (Project memory): the notes live in a folder that the user picks (an Obsidian vault), with readable folder
// names: Genel/ for the global memory, Projeler/<project folder name>/ per project (project.json names the project). The
// journal and the review cursor stay under the dsh home. The first start with a folder copies every old note there, all or
// none; until the copy is done the memory stays off, so no note is written to either place and lost.
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, installMemory, importMemory, memoryFolderOf, memoryFolderProblem, memorySection, memoryStore, memoryView } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memfolder-'));
try {
  const dir = join(root, 'home', 'storages', 'dsh-composer-plus', 'memory');
  const vault = join(root, 'vault', 'Hafıza');
  const web = join(root, 'code', 'web'); const web2 = join(root, 'other', 'web'); const api = join(root, 'code', 'api');
  for (const p of [web, web2, api]) await mkdir(p, { recursive: true });

  // Setting: only an absolute path; a symlink or a file is refused.
  assert.equal(memoryFolderOf({ folder: 'relative/x' }), undefined); assert.equal(memoryFolderOf({}), undefined); assert.equal(memoryFolderOf({ folder: '/a/../b' }), '/b');
  assert.equal(memoryFolderProblem(join(root, 'missing')), undefined, 'a missing folder is made at the first save');
  await symlink(root, join(root, 'link')); assert.match(memoryFolderProblem(join(root, 'link')), /symbolic link/);
  await writeFile(join(root, 'file'), 'x'); assert.match(memoryFolderProblem(join(root, 'file')), /not a folder/);

  // Old layout with notes: global, two projects named "web" and one "api", a topic.
  const old = memoryStore(dir, { today: () => '2026-11-09' });
  await old.add({ scope: old.GLOBAL, text: 'The user writes in Turkish', actor: 'agent' });
  await old.add({ scope: old.project(web), text: 'Web deploys with make', actor: 'agent' });
  await old.add({ scope: old.project(web), topic: 'deploy', text: 'Staging first', actor: 'agent' });
  await old.add({ scope: old.project(web2), text: 'The second web uses pnpm', actor: 'agent' });
  await old.add({ scope: old.project(api), text: 'The API runs on port 8080', actor: 'agent' });
  const oldCount = () => [old.GLOBAL, ...old.projects()].reduce((n, s) => n + old.entriesOf(old.load(s)).length, 0);
  assert.equal(oldCount(), 5);

  // Import: a failure (the vault folder is read-only) writes nothing; then it copies all, once.
  await mkdir(vault, { recursive: true });
  if (process.getuid?.() !== 0) {
    await chmod(vault, 0o500);
    try { await assert.rejects(importMemory(dir, vault)); } finally { await chmod(vault, 0o700); }
    assert.deepEqual(await readdir(vault), [], 'a failed copy leaves nothing');
  }
  const count = await importMemory(dir, vault);
  assert.deepEqual(count, { scopes: 4, files: 5, entries: 5 });
  assert.deepEqual((await readdir(vault)).sort(), ['Genel', 'Projeler'], 'no work folder left');
  const names = (await readdir(join(vault, 'Projeler'))).sort();
  assert.equal(names.length, 3); assert.ok(names.includes('api'));
  assert.ok(names.includes('web') && names.some((n) => /^web-[0-9a-f]{6}$/.test(n)), `two "web" projects get two folders: ${names}`);
  assert.equal(await importMemory(dir, vault), undefined, 'a folder with notes is never copied over');
  assert.equal(oldCount(), 5, 'the old layout stays');

  // The folder store reads the same notes by the same project ids; a new note goes into the vault file.
  const s = memoryStore(dir, { folder: vault, today: () => '2026-11-09' });
  const view = memoryView(s);
  assert.equal(view.projects.length, 3); assert.equal(view.global.files[0].entries[0].text, 'The user writes in Turkish');
  assert.equal(s.project(web).id, old.project(web).id, 'same id in both layouts');
  assert.equal(s.projectById(old.project(api).id).path, s.project(api).path);
  const webDir = s.project(web).dir;
  assert.match(await readFile(join(webDir, 'deploy.md'), 'utf8'), /Staging first/);
  await s.add({ scope: s.project(web), text: 'Web uses Hugo', actor: 'agent' });
  assert.match(await readFile(join(webDir, 'MEMORY.md'), 'utf8'), /Web uses Hugo/);
  assert.doesNotMatch(await readFile(join(old.project(web).dir, 'MEMORY.md'), 'utf8'), /Hugo/, 'nothing goes to the old layout');
  const journal = (await readFile(join(dir, 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(journal.slice(-2).map((r) => r.op), ['import', 'add'], 'the journal stays under the dsh home');
  assert.equal((await readdir(vault)).includes('journal.jsonl'), false);

  // The user renames a project folder in Obsidian: the notes go with it; an edit by hand shows in the next section.
  await rename(webDir, join(vault, 'Projeler', 'Web sitesi'));
  const renamed = s.project(web);
  assert.equal(renamed.dir, join(vault, 'Projeler', 'Web sitesi'));
  const main = join(renamed.dir, 'MEMORY.md');
  await writeFile(main, (await readFile(main, 'utf8')).replace('Web uses Hugo', 'Web uses Astro'));
  assert.match(memorySection(s, renamed), /Web uses Astro/, 'a hand edit shows in the next chat');
  // A batch finds the folder again: a scope named before the rename still writes into the renamed folder.
  const before = s.project(api);
  await rename(before.dir, join(vault, 'Projeler', 'Servis'));
  await s.add({ scope: before, text: 'The API has a health route', actor: 'agent' });
  assert.match(await readFile(join(vault, 'Projeler', 'Servis', 'MEMORY.md'), 'utf8'), /health route/);
  assert.equal(await lstat(before.dir).then(() => true, () => false), false, 'no second folder for the old name');
  // A new project gets a folder named after it.
  const blog = join(root, 'blog'); await mkdir(blog);
  await s.add({ scope: s.project(blog), text: 'The blog is new', actor: 'agent' });
  assert.deepEqual(JSON.parse(await readFile(join(vault, 'Projeler', 'blog', 'project.json'), 'utf8')), { path: s.project(blog).path });

  // installMemory: the setting file picks the folder at start; the route saves a new folder for the next start.
  const routes = new Map();
  const ctx = (home) => ({ on: () => {}, effect: () => {}, get: () => undefined, logger: { warn: () => {} },
    connection: { fetch: { register: (r) => routes.set(r.path, r) } }, sessionQuery: { observeSession: async () => ({ events: [] }) },
    inject: (_d, setup) => { setup({ tools: { register: () => {} }, systemPrompt: { section: () => {} } }); return { dispose: () => {} }; } });
  const call = async (body) => { const r = await routes.get(MEMORY_PATH).fetch(new Request(`http://h${MEMORY_PATH}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  const home2 = join(root, 'home2'); const store2 = join(home2, 'storages', 'dsh-composer-plus');
  await mkdir(store2, { recursive: true });
  await memoryStore(join(store2, 'memory')).add({ scope: memoryStore(join(store2, 'memory')).GLOBAL, text: 'An old global note', actor: 'agent' });
  await writeFile(join(store2, 'memory.json'), JSON.stringify({ on: true }));
  const vault2 = join(root, 'vault2', 'Hafıza');
  await writeFile(join(store2, 'memory-folder.json'), JSON.stringify({ folder: vault2 }));
  const m = installMemory(ctx(home2), home2); await m.ready;
  assert.deepEqual((await call()).body, { on: true, folder: vault2, folderActive: vault2 });
  assert.match(await readFile(join(vault2, 'Genel', 'MEMORY.md'), 'utf8'), /An old global note/, 'the first start copied the notes');
  assert.equal(m.store.GLOBAL.dir, join(vault2, 'Genel'));
  assert.deepEqual(JSON.parse(await readFile(join(store2, 'memory-folder.json'), 'utf8')), { folder: vault2, imported: vault2 }, 'the copy is marked done');
  // The user deletes Genel and Projeler later: the next start does not copy the old notes back.
  await rm(join(vault2, 'Genel'), { recursive: true });
  const again = installMemory(ctx(home2), home2); await again.ready;
  assert.equal(await lstat(join(vault2, 'Genel')).then(() => true, () => false), false, 'no second copy');
  assert.equal((await call({ folder: 'not/absolute' })).status, 400);
  assert.equal((await call({ folder: join(root, 'file') })).status, 409);
  assert.deepEqual((await call({ folder: '~/Notes' })).body.folder, join((await import('node:os')).homedir(), 'Notes'), '~ is the home folder');
  assert.equal((await call()).body.folderActive, vault2, 'the new folder waits for the next start');
  assert.deepEqual(JSON.parse(await readFile(join(store2, 'memory-folder.json'), 'utf8')), { folder: join((await import('node:os')).homedir(), 'Notes'), imported: vault2 });
  assert.deepEqual((await call({ folder: '' })).body.folder, '', 'empty: the default again');
  assert.deepEqual(JSON.parse(await readFile(join(store2, 'memory-folder.json'), 'utf8')), { imported: vault2 });

  // A copy that fails at start: the memory stays off for this run (no tools, no review), and switching on is refused.
  if (process.getuid?.() !== 0) {
    const home3 = join(root, 'home3'); const store3 = join(home3, 'storages', 'dsh-composer-plus');
    await mkdir(store3, { recursive: true });
    await memoryStore(join(store3, 'memory')).add({ scope: memoryStore(join(store3, 'memory')).GLOBAL, text: 'Keep me', actor: 'agent' });
    await writeFile(join(store3, 'memory.json'), JSON.stringify({ on: true }));
    const locked = join(root, 'locked'); await mkdir(locked); await chmod(locked, 0o500);
    await writeFile(join(store3, 'memory-folder.json'), JSON.stringify({ folder: locked }));
    try {
      const m3 = installMemory(ctx(home3), home3); await m3.ready;
      assert.equal((await call()).body.on, false, 'the memory is off while the notes are not copied');
      assert.match((await call()).body.folderProblem, /not copied/, 'Settings shows why');
      const refusedOn = await call({ on: true });
      assert.equal(refusedOn.status, 409); assert.match(refusedOn.body.error, /restart dsh to copy them/);
    } finally { await chmod(locked, 0o700); }
  }
  console.log('memory folder checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
