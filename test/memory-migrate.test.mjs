// Project memory: one memory per repository and main files named after the project (2026-11-12).
// - A chat in a git worktree (a branch chat's folder) uses the memory of the repository's main working tree; a plain
//   repository and a folder outside git keep their own memory.
// - The main file is `<folder name> <word>.md` (`hafıza` for a Turkish UI, else `memory`); that name is never a topic. An
//   old MEMORY.md is still read until the migration renames it.
// - migrateMemory (run by installMemory at each start): renames each main file, merges each worktree memory into its
//   repository's memory (entries, topics, Index links; an exact duplicate is left out; source and date stay), writes each
//   move to the journal and removes the worktree folder only after the merge. A worktree whose repository cannot be found
//   stays. A failed save puts every file back. A second run changes nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, cleanTopic, importMemory, installMemory, mainWorktreeOf, memorySection, memoryStore, memoryWord, mergeMemory, migrateMemory, parseMemory, worktreeRepoOf } from '../index.js';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
/** Every entry line of a memory folder tree: `{folder: [line, ...]}` (the lines of all .md files, sorted). */
const linesOf = async (root) => {
  const out = {};
  for (const top of ['Genel', ...(await readdir(join(root, 'Projeler')).catch(() => [])).map((d) => join('Projeler', d))]) {
    const names = await readdir(join(root, top)).catch(() => []);
    const all = [];
    for (const f of names.filter((n) => n.endsWith('.md'))) all.push(...parseMemory(await readFile(join(root, top, f), 'utf8')).entries.map((e) => e.text));
    if (names.length > 0) out[top] = all.sort();
  }
  return out;
};

const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-memory-migrate-')));
try {
  // Pure parts: the word, cleanTopic refuses a main file's name.
  assert.equal(memoryWord('tr'), 'hafıza'); assert.equal(memoryWord('tr-TR'), 'hafıza'); assert.equal(memoryWord('en'), 'memory'); assert.equal(memoryWord(undefined), 'memory');
  for (const name of ['acme hafıza', 'acme hafıza.md', 'Acme Web memory.md', 'Genel hafıza', 'memory', 'MEMORY']) assert.equal(cleanTopic(name), undefined, name);
  assert.equal(cleanTopic('hafıza'), 'hafıza', 'one word is still a topic'); assert.equal(cleanTopic('deploy notes'), 'deploy-notes');

  // A repository with a worktree in .worktrees and one outside; a plain folder.
  const repo = join(root, 'code', 'acme'); await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); await writeFile(join(repo, 'a.txt'), 'a'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'one');
  await mkdir(join(repo, 'src'));
  git(repo, 'worktree', 'add', '-q', '.worktrees/feat-x', '-b', 'feat/x');
  const far = join(root, 'elsewhere', 'feat-y'); git(repo, 'worktree', 'add', '-q', far, '-b', 'feat/y');
  const wt = join(repo, '.worktrees', 'feat-x'); await mkdir(join(wt, 'src'));
  const plain = join(root, 'plain'); await mkdir(plain);
  assert.equal(mainWorktreeOf(wt), repo); assert.equal(mainWorktreeOf(far), repo); assert.equal(mainWorktreeOf(join(wt, 'src')), join(repo, 'src'), 'a folder below a worktree maps below the main tree');
  assert.equal(mainWorktreeOf(repo), undefined, 'a plain repository keeps its own memory'); assert.equal(mainWorktreeOf(plain), undefined, 'outside git: its own memory');
  assert.equal(mainWorktreeOf(join(repo, 'src')), undefined);
  // A `.git` file that a downloaded folder brings (git's worktree list does not name it) cannot borrow the repo's memory.
  const forged = join(root, 'forged'); await mkdir(forged);
  await writeFile(join(forged, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feat-x')}\n`);
  assert.equal(mainWorktreeOf(forged), undefined, 'a forged .git file is not a worktree');

  // The mapping in the store: the same scope for the worktree and the repository.
  const vault = join(root, 'vault');
  const dir = join(root, 'dsh', 'memory');
  const store = memoryStore(dir, { folder: vault, word: () => 'hafıza', today: () => '2026-11-12' });
  assert.equal(store.project(wt).key, store.project(repo).key); assert.equal(store.project(far).key, store.project(repo).key);
  assert.equal(store.project(wt).path, repo); assert.notEqual(store.project(plain).key, store.project(repo).key);
  await store.add({ scope: store.project(wt), text: 'Saved from the branch chat', actor: 'agent' });
  const acme = store.project(repo);
  assert.deepEqual((await readdir(acme.dir)).sort(), ['acme hafıza.md', 'project.json'], 'the main file is named after the project');
  assert.deepEqual(JSON.parse(await readFile(join(acme.dir, 'project.json'), 'utf8')), { path: repo });
  assert.match(memorySection(store, store.project(wt)), /Saved from the branch chat/, 'the worktree chat reads the repository memory');
  await store.add({ scope: acme, topic: 'deploy', text: 'Deploy with make', actor: 'agent' });
  assert.equal(store.load(acme).length, 2, 'the main file is not read as a topic');
  assert.deepEqual(store.topicNames(acme), ['deploy']);

  // The tools of a worktree chat (installMemory) use the repository memory too: remember, recall, forget, the section.
  { const routes = new Map(); const tools = new Map(); const sections = new Map();
    const home = join(root, 'home-tools');
    await mkdir(join(home, 'storages', 'dsh-composer-plus'), { recursive: true });
    await writeFile(join(home, 'storages', 'dsh-composer-plus', 'memory.json'), JSON.stringify({ on: true }));
    await writeFile(join(home, 'storages', 'dsh-composer-plus', 'memory-folder.json'), JSON.stringify({ folder: join(root, 'vault-tools'), imported: join(root, 'vault-tools') }));
    const ctx = { on: () => {}, effect: () => {}, get: () => undefined, logger: { warn: () => {} }, connection: { fetch: { register: (r) => routes.set(r.path, r) } },
      sessionQuery: { observeSession: async () => ({ events: [] }) },
      inject: (_d, setup) => { setup({ tools: { register: (t) => tools.set(t.name, t) }, systemPrompt: { section: (s) => sections.set(s.name, s) } }); return { dispose: () => {} }; } };
    const m = installMemory(ctx, home); await m.ready;
    const exec = { agent: { id: 'chat-wt', session: { header: { cwd: wt } } } };
    assert.match(await tools.get('memory_remember').execute({ text: 'A branch chat fact' }, exec), /in acme memory\.md/);
    assert.match(await tools.get('memory_recall').execute({ query: 'branch' }, { agent: { id: 'chat-main', session: { header: { cwd: repo } } } }), /A branch chat fact/, 'the main repository chat finds it');
    assert.match(sections.get('composer-plus:memory').text({ agent: { id: 'chat-far', session: { header: { cwd: far } } } }), /A branch chat fact/);
    assert.match(await tools.get('memory_forget').execute({ entry: 'branch chat fact' }, exec), /^Removed/);
    // The UI language is saved for the next start's word.
    const post = async (body) => { const r = await routes.get(MEMORY_PATH).fetch(new Request(`http://h${MEMORY_PATH}`, { method: 'POST', body: JSON.stringify(body) })); return r.status; };
    assert.equal(await post({ lang: 'tr' }), 200); assert.equal(await post({ lang: 'not a language!' }), 400);
    assert.deepEqual(JSON.parse(await readFile(join(home, 'storages', 'dsh-composer-plus', 'memory-language.json'), 'utf8')), { lang: 'tr' });
    const m2 = installMemory(ctx, home); await m2.ready;
    assert.equal(m2.store.wantedMain(m2.store.project(repo)), 'acme hafıza.md', 'the next start uses the reported language'); }

  // mergeMemory: entries keep their tags; exact duplicates go; links are kept; untouched files keep their text.
  { const main = { topic: undefined, file: 'x hafıza.md', ...((c) => ({ content: c, ...parseMemory(c) }))('# Memory\n\n- Kept [added: 2026-01-01]\n\n## Index\n- [[api]]\n') };
    const api = { topic: 'api', file: 'api.md', ...((c) => ({ content: c, ...parseMemory(c) }))('# api\n\n- Port 80\n') };
    const src = (topic, file, c) => ({ topic, file, content: c, ...parseMemory(c) });
    const r = mergeMemory([main, api], [src(undefined, 'MEMORY.md', '# Memory\n\n- Kept [added: 2026-02-02]\n- New one [source: s1; added: 2026-03-03]\n\n## Index\n- [[ci]]\n- [[gone]]\n'),
      src('ci', 'ci.md', '# ci\n\n- CI runs on push [added: 2026-04-04]\n')]);
    assert.deepEqual(Object.keys(r.files).sort(), ['api.md', 'ci.md', 'x hafıza.md']);
    assert.equal(r.files['api.md'], api.content, 'a topic without a change keeps its text');
    assert.equal(r.files['x hafıza.md'], '# Memory\n\n- Kept [added: 2026-01-01]\n- New one [source: s1; added: 2026-03-03]\n\n## Index\n- [[api]]\n- [[ci]]\n');
    assert.equal(r.files['ci.md'], '# ci\n\n- CI runs on push [added: 2026-04-04]\n');
    assert.deepEqual(r.dropped, [{ file: 'MEMORY.md', line: '- Kept [added: 2026-02-02]' }]); assert.equal(r.moved.length, 2);
    assert.throws(() => mergeMemory([main], [src(undefined, 'MEMORY.md', '# Memory\n\nA paragraph by hand\n')]), /not entries/);
    // Hand lines: a paragraph, a bullet with only tags, an Index bullet without a link; titles, entries, links and blanks are not.
    assert.equal(parseMemory('# Memory\n\n- Fact\n- [added: 2026-01-01]\nBy hand\n\n## Index\n- [[api]]\n- no link\n').stray, 3); }

  // The migration on a copy of an old vault layout (MEMORY.md everywhere, branch folders as their own projects).
  const old = join(root, 'old-vault');
  const put = async (folder, files, path) => {
    await mkdir(join(old, folder), { recursive: true });
    for (const [f, t] of Object.entries(files)) await writeFile(join(old, folder, f), t);
    if (path !== undefined) await writeFile(join(old, folder, 'project.json'), JSON.stringify({ path }));
  };
  await put('Genel', { 'MEMORY.md': '# Memory\n\n- Global one [added: 2026-11-01]\n\n## Index\n- [[sunucular]]\n', 'sunucular.md': '# sunucular\n\n- Server A\n' });
  await put('Projeler/acme', { 'MEMORY.md': '# Memory\n\n- Repo fact [source: s0; added: 2026-11-01]\n\n## Index\n- [[deploy]]\n', 'deploy.md': '# deploy\n\n- Deploy with make\n' }, repo);
  await put('Projeler/feat-x', { 'MEMORY.md': '# Memory\n\n- Repo fact [source: s9; added: 2026-11-05]\n- Branch fact [source: s1; added: 2026-11-06]\n\n## Index\n- [[deploy]]\n- [[ci]]\n',
    'deploy.md': '# deploy\n\n- Deploy with make\n- Staging first [added: 2026-11-06]\n', 'ci.md': '# ci\n\n- CI on push\n' }, wt);
  await put('Projeler/feat-y', { 'MEMORY.md': '# Memory\n\n- Far fact\n' }, far);
  // A worktree folder that is gone: its repository is found from `<repo>/.worktrees/<name>`.
  await put('Projeler/feat-gone', { 'MEMORY.md': '# Memory\n\n- Gone branch fact\n\n## Index\n' }, join(repo, '.worktrees', 'feat-gone'));
  // A worktree of a repository that is gone: it stays.
  await put('Projeler/feat-lost', { 'MEMORY.md': '# Memory\n\n- Lost repo fact\n' }, join(root, 'nowhere', 'repo', '.worktrees', 'feat-lost'));
  // A worktree memory with a paragraph written by hand: it stays (nothing of it is lost).
  git(repo, 'worktree', 'add', '-q', '.worktrees/feat-hand', '-b', 'feat/hand');
  await put('Projeler/feat-hand', { 'MEMORY.md': '# Memory\n\nA note by hand, not an entry.\n\n- Hand fact\n' }, join(repo, '.worktrees', 'feat-hand'));
  await put('Projeler/plain', { 'MEMORY.md': '# Memory\n\n- Plain fact\n' }, plain);
  const before = await linesOf(old);
  const total = (o) => Object.values(o).reduce((n, l) => n + l.length, 0);
  assert.equal(total(before), 14);

  const journal = join(root, 'dsh-m', 'journal.jsonl');
  const m = memoryStore(join(root, 'dsh-m'), { folder: old, word: () => 'hafıza' });
  // Until the migration, the old MEMORY.md is read.
  assert.equal(m.load(m.project(plain))[0].file, 'MEMORY.md'); assert.match(memorySection(m, m.project(plain)), /Plain fact/);
  const logs = [];
  const c = await migrateMemory(m, { log: (t) => logs.push(t) });
  assert.equal(c.merged, 3, 'feat-x, feat-y and feat-gone'); assert.equal(c.duplicates, 2, 'Repo fact and Deploy with make');
  assert.deepEqual(c.skipped.map((d) => d.split('/').at(-1)).sort(), ['feat-hand', 'feat-lost']);
  assert.deepEqual((await readdir(join(old, 'Projeler'))).sort(), ['acme', 'feat-hand', 'feat-lost', 'plain'], 'merged worktree folders went');
  assert.deepEqual((await readdir(join(old, 'Projeler', 'acme'))).sort(), ['acme hafıza.md', 'ci.md', 'deploy.md', 'project.json']);
  assert.deepEqual((await readdir(join(old, 'Genel'))).sort(), ['Genel hafıza.md', 'sunucular.md']);
  assert.deepEqual(await readdir(join(old, 'Projeler', 'feat-lost')), ['MEMORY.md', 'project.json'], 'an unresolvable folder stays as it is');
  assert.equal(await readFile(join(old, 'Projeler', 'feat-lost', 'MEMORY.md'), 'utf8'), '# Memory\n\n- Lost repo fact\n');
  assert.ok(logs.some((l) => /feat-lost stays as it is: the repository/.test(l)), logs.join('\n'));
  const main = await readFile(join(old, 'Projeler', 'acme', 'acme hafıza.md'), 'utf8');
  // The repository's entries first; the worktrees' entries after them, in the order of their folders.
  const mainLines = main.split('\n');
  assert.deepEqual(mainLines.slice(0, 3), ['# Memory', '', '- Repo fact [source: s0; added: 2026-11-01]']);
  assert.deepEqual(mainLines.slice(3, 6).sort(), ['- Branch fact [source: s1; added: 2026-11-06]', '- Far fact', '- Gone branch fact']);
  assert.deepEqual(mainLines.slice(6), ['', '## Index', '- [[deploy]]', '- [[ci]]', '']);
  assert.equal(await readFile(join(old, 'Projeler', 'acme', 'deploy.md'), 'utf8'), '# deploy\n\n- Deploy with make\n- Staging first [added: 2026-11-06]\n');
  // 0 lost: every entry text of before is in the vault after (the two exact duplicates are there once).
  const after = await linesOf(old);
  const flat = (o) => new Set(Object.values(o).flat());
  for (const t of flat(before)) assert.ok(flat(after).has(t), `lost: ${t}`);
  assert.equal(total(after), total(before) - 2);
  // The journal has each move with its lines.
  const rows = (await readFile(journal, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.op === 'migrate');
  const fx = rows.find((r) => /feat-x$/.test(r.from ?? ''));
  assert.deepEqual(fx.moved.map((x) => x.line).sort(), ['- Branch fact [source: s1; added: 2026-11-06]', '- CI on push', '- Staging first [added: 2026-11-06]']);
  assert.deepEqual(fx.dropped.map((x) => x.line).sort(), ['- Deploy with make', '- Repo fact [source: s9; added: 2026-11-05]']);
  assert.ok(rows.some((r) => r.renamed === 'MEMORY.md' && /Genel hafıza\.md$/.test(r.file)));
  // A second run changes nothing.
  const snap = async () => JSON.stringify([await linesOf(old), (await readdir(join(old, 'Projeler'))).sort(), await readFile(join(old, 'Projeler', 'acme', 'acme hafıza.md'), 'utf8'), await readFile(journal, 'utf8')]);
  const once = await snap();
  const again = await migrateMemory(m, { log: () => {} });
  assert.deepEqual({ ...again, skipped: again.skipped.length }, { renamed: 0, merged: 0, moved: 0, duplicates: 0, skipped: 2 });
  assert.equal(await snap(), once, 'the second run wrote nothing');

  // A failure in the last write: every file goes back, the worktree folder stays, and the migration throws.
  if (process.getuid?.() !== 0) {
    const v = join(root, 'fail-vault');
    await mkdir(join(v, 'Projeler', 'acme'), { recursive: true }); await mkdir(join(v, 'Projeler', 'feat-x'), { recursive: true });
    await writeFile(join(v, 'Projeler', 'acme', 'MEMORY.md'), '# Memory\n\n- A\n'); await writeFile(join(v, 'Projeler', 'acme', 'project.json'), JSON.stringify({ path: repo }));
    await writeFile(join(v, 'Projeler', 'feat-x', 'MEMORY.md'), '# Memory\n\n- B\n'); await writeFile(join(v, 'Projeler', 'feat-x', 'project.json'), JSON.stringify({ path: wt }));
    const was = await linesOf(v);
    await chmod(join(v, 'Projeler', 'acme'), 0o500);
    try {
      const f = memoryStore(join(root, 'dsh-f'), { folder: v, word: () => 'memory' });
      await assert.rejects(migrateMemory(f));
    } finally { await chmod(join(v, 'Projeler', 'acme'), 0o700); }
    assert.deepEqual(await linesOf(v), was, 'nothing changed');
    assert.deepEqual(await readdir(join(v, 'Projeler', 'acme')), ['MEMORY.md', 'project.json']);
    assert.deepEqual((await readdir(join(v, 'Projeler', 'feat-x'))).sort(), ['MEMORY.md', 'project.json'], 'the worktree memory stays');
    // installMemory: a migration that stops keeps the memory off for this run.
    const home = join(root, 'home-fail'); const sd = join(home, 'storages', 'dsh-composer-plus');
    await mkdir(sd, { recursive: true });
    await writeFile(join(sd, 'memory.json'), JSON.stringify({ on: true }));
    await writeFile(join(sd, 'memory-folder.json'), JSON.stringify({ folder: v, imported: v }));
    await chmod(join(v, 'Projeler', 'acme'), 0o500);
    try {
      const routes = new Map();
      const ctx = { on: () => {}, effect: () => {}, get: () => undefined, logger: { warn: () => {} }, connection: { fetch: { register: (r) => routes.set(r.path, r) } },
        sessionQuery: { observeSession: async () => ({ events: [] }) }, inject: (_d, setup) => { setup({ tools: { register: () => {} }, systemPrompt: { section: () => {} } }); return { dispose: () => {} }; } };
      const im = installMemory(ctx, home); await im.ready;
      const body = await (await routes.get(MEMORY_PATH).fetch(new Request(`http://h${MEMORY_PATH}`))).json();
      assert.equal(body.on, false); assert.match(body.folderProblem, /migration stopped/);
      const on = await routes.get(MEMORY_PATH).fetch(new Request(`http://h${MEMORY_PATH}`, { method: 'POST', body: JSON.stringify({ on: true }) }));
      assert.equal(on.status, 409); assert.match((await on.json()).error, /migration stopped/, 'switching on gives the real reason');
    } finally { await chmod(join(v, 'Projeler', 'acme'), 0o700); }
  }

  // A note of the user's named `<x> memory.md` is not a main file: it stays in the project, and a worktree folder that has
  // one keeps it (its memory files are merged). A folder renamed only in case keeps its main file's name (a file system
  // that folds case sees one file): no rename, no loss, the memory stays on.
  { const v = join(root, 'user-vault');
    const put2 = async (folder, files, path) => { await mkdir(join(v, folder), { recursive: true }); for (const [f, t] of Object.entries(files)) await writeFile(join(v, folder, f), t); await writeFile(join(v, folder, 'project.json'), JSON.stringify({ path })); };
    await put2('Projeler/Acme', { 'acme memory.md': '# Memory\n\n- Main fact\n', 'Team memory.md': '# Team\n\nWho does what, by hand.\n- Ali: backend\n' }, repo);
    await put2('Projeler/feat-x', { 'MEMORY.md': '# Memory\n\n- Worktree fact\n', 'Team memory.md': '# Team\n\n- Veli: frontend\n' }, wt);
    const u = memoryStore(join(root, 'dsh-u'), { folder: v, word: () => 'memory' });
    const ua = u.project(repo);
    assert.deepEqual(u.mainNames(ua), ['acme memory.md'], 'Team memory.md is not a main file');
    assert.equal(u.load(ua)[0].file, 'acme memory.md');
    const r = await migrateMemory(u, { log: () => {} });
    assert.equal(r.merged, 1); assert.equal(r.renamed, 0, 'a case-only difference is not renamed');
    assert.deepEqual((await readdir(join(v, 'Projeler', 'Acme'))).sort(), ['Team memory.md', 'acme memory.md', 'project.json']);
    assert.equal(await readFile(join(v, 'Projeler', 'Acme', 'Team memory.md'), 'utf8'), '# Team\n\nWho does what, by hand.\n- Ali: backend\n', 'the user note is untouched');
    assert.match(await readFile(join(v, 'Projeler', 'Acme', 'acme memory.md'), 'utf8'), /- Main fact\n- Worktree fact\n/);
    assert.deepEqual((await readdir(join(v, 'Projeler', 'feat-x'))).sort(), ['Team memory.md', 'project.json'], 'the worktree folder keeps the user note');
    const again2 = await migrateMemory(u, { log: () => {} });
    assert.deepEqual([again2.merged, again2.renamed, again2.moved], [0, 0, 0], 'the second run changes nothing');
    await u.add({ scope: u.project(wt), text: 'After the migration', actor: 'agent' });
    assert.match(await readFile(join(v, 'Projeler', 'Acme', 'acme memory.md'), 'utf8'), /After the migration/); }

  // The default layout (folders named by id) gets the project folder's name too.
  { const d = memoryStore(join(root, 'dsh-default'), { word: () => 'memory' });
    await d.add({ scope: d.project(plain), text: 'Default layout fact', actor: 'agent' });
    assert.ok((await readdir(d.project(plain).dir)).includes('plain memory.md'));
    await d.add({ scope: d.GLOBAL, text: 'Default global fact', actor: 'agent' });
    assert.ok((await readdir(d.GLOBAL.dir)).includes('global memory.md')); }

  // importMemory of a folder with two main files (a scope that the migration left as it is): each one is copied, none is
  // written over the other, the new folder reads both, and the next migration merges them. The new folder is named after
  // the project (`plain`): (1) the second main file has the new name of the first (`plain hafıza.md`); (2) the second main
  // file's old name (`proj memory.md`, no `# Memory` title) means nothing in the new folder.
  for (const [i, second] of [['plain hafıza.md', '# Memory\n\n- B\n'], ['proj memory.md', '# Notes\n\n- B\n']].entries()) {
    const from = join(root, `two-mains-${i}`); const to = join(root, `two-mains-new-${i}`);
    await mkdir(join(from, 'Projeler', 'proj'), { recursive: true }); await mkdir(to);
    await writeFile(join(from, 'Projeler', 'proj', 'project.json'), JSON.stringify({ path: plain }));
    await writeFile(join(from, 'Projeler', 'proj', 'proj hafıza.md'), '# Memory\n\n- A\n');
    await writeFile(join(from, 'Projeler', 'proj', second[0]), second[1]);
    const c = await importMemory(join(root, `dsh-two-${i}`), to, from, undefined, undefined, () => 'hafıza');
    assert.equal(c.entries, 2, second[0]);
    const copied = await linesOf(to); assert.deepEqual(Object.values(copied).flat().sort(), ['A', 'B'], `no main file is written over: ${second[0]}`);
    const s = memoryStore(join(root, `dsh-two-${i}`), { folder: to, word: () => 'hafıza' });
    await migrateMemory(s, { log: () => {} });
    assert.deepEqual(s.load(s.project(plain))[0].entries.map((e) => e.text).sort(), ['A', 'B'], `the migration merges them: ${second[0]}`);
  }
  // Three main files in one folder: the copy stops (nothing is written), the reason names the files.
  { const from = join(root, 'three-mains'); const to = join(root, 'three-mains-new');
    await mkdir(join(from, 'Projeler', 'proj'), { recursive: true }); await mkdir(to);
    await writeFile(join(from, 'Projeler', 'proj', 'project.json'), JSON.stringify({ path: plain }));
    for (const f of ['proj hafıza.md', 'proj memory.md', 'MEMORY.md']) await writeFile(join(from, 'Projeler', 'proj', f), `# Memory\n\n- ${f}\n`);
    await assert.rejects(importMemory(join(root, 'dsh-three'), to, from, undefined, undefined, () => 'hafıza'), /3 main files/);
    assert.deepEqual(await readdir(to), [], 'nothing is copied'); }

  // worktreeRepoOf: a path that is not a worktree, one that is, one that is gone.
  assert.equal(worktreeRepoOf(repo), undefined); assert.equal(worktreeRepoOf(wt), repo);
  assert.equal(worktreeRepoOf(join(repo, '.worktrees', 'gone')), repo); assert.equal(worktreeRepoOf(join(root, 'x', '.worktrees', 'y')), null);
} finally { await rm(root, { recursive: true, force: true }); }

// The browser reports its UI language to the memory route at start and after a switch, once per language, and stops
// when Project memory is switched off.
{
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
  const posts = [];
  const server = { on: true };
  globalThis.fetch = async (url, init) => {
    if (init?.body) { const body = JSON.parse(init.body); posts.push([url, body]); if (url === MEMORY_PATH && 'on' in body) server.on = body.on; }
    return Response.json(url === MEMORY_PATH ? { ...server } : { on: true });
  };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useSyncExternalStore: (_, get) => get() };
  const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
  let active = 'tr'; const subs = new Set(); let section;
  const locale = { register: () => () => {}, bind: () => (k) => k, getSnapshot: () => ({ active, locales: [] }), subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
  plugin.apply({ effect: (fn) => fn(), configForms: { get: () => ({}) }, locale, sessions: {},
    slots: { inject: (n, f) => f(), register: (o) => { if (o.id === 'composer-plus') section = o; return () => {}; } } });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const langs = () => posts.filter(([u, b]) => u === MEMORY_PATH && 'lang' in b).map(([, b]) => b.lang);
  const notify = async () => { for (const fn of [...subs]) fn(); await flush(); };
  await flush();
  assert.deepEqual(langs(), ['tr'], 'reports the UI language at start');
  await notify(); assert.deepEqual(langs(), ['tr'], 'the same language is not sent twice');
  active = 'en'; await notify(); assert.deepEqual(langs(), ['tr', 'en'], 'reports a language switch');
  section.inject().setFeature('projectMemory', false); await flush();
  active = 'de'; await notify(); assert.deepEqual(langs(), ['tr', 'en'], 'switched off: the language is not reported');
}
console.log('memory migrate checks passed');
