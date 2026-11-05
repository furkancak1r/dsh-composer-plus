// Project memory: the shared parts of the memory features.
// - One save path: every add/replace/remove is one batch; `beforeSave` runs once per scope of a save, before its first
//   write, with the files as they were, and not for a save that changes nothing or for a scope that had no file yet. When
//   the last change of a save fails, every file goes back, the new files go, the undo of `beforeSave` runs and the journal
//   gets no row. A batch cannot change a scope that it did not name. `write` sets whole files (a restore).
// - memoryDiff: a unified diff with 3 lines of context.
// - formatSource / parseSource / lastUserSeq: the note's source chat and message (a fork's copy and withdrawn messages out).
// - projectFile / replaceProjectFile (Export to AGENTS.md): only a regular file inside the chat folder (realpath); a symlink
//   out of the folder, a dangling one, a FIFO (the test ends, it does not hang) and a large file are refused; a change
//   after the preview is refused; a failed write leaves the old file and no temp file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStore, memoryDiff, formatSource, parseSource, lastUserSeq, projectFile, replaceProjectFile, ROLLBACK_SOURCE } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memory-base-')); // macOS: /var/… is a symlink to /private/var/…
try {
  const project = join(root, 'acme-web'); await mkdir(project);
  const other = join(root, 'acme-blog'); await mkdir(other);

  // One save path with a copy first.
  {
    const seen = [];
    let fail = false; const undone = [];
    const store = memoryStore(join(root, 'mem'), { today: () => '2026-11-04', beforeSave: ({ scope, files, actor }) => {
      if (fail) throw new Error('no room for the copy');
      seen.push({ scope: scope.key, files, actor });
      return () => undone.push(scope.key);
    } });
    const p = store.project(project); const b = store.project(other);
    await store.add({ scope: p, text: 'The user deploys with make release', actor: 'agent' });
    assert.equal(seen.length, 0, 'a scope without a file has nothing to keep');
    await store.add({ scope: p, text: 'The user uses pnpm', actor: 'agent' });
    assert.equal(seen.length, 1); assert.equal(seen[0].actor, 'agent');
    assert.match(seen[0].files['MEMORY.md'], /make release/); assert.doesNotMatch(seen[0].files['MEMORY.md'], /pnpm/, 'the files as they were');
    assert.equal((await store.add({ scope: p, text: 'The user uses pnpm', actor: 'agent' })).changed, false);
    assert.equal(seen.length, 1, 'a save that changes nothing keeps no copy');
    // One batch with two changes in one scope and one in another: one copy per scope.
    await store.add({ scope: store.GLOBAL, text: 'The user writes in Turkish', actor: 'agent' });
    seen.length = 0;
    await store.batch([p, store.GLOBAL], async (now) => {
      await now.add({ scope: p, text: 'Releases need a tag', actor: 'editor' });
      await now.add({ scope: p, topic: 'api', text: 'The API runs on port 8080', actor: 'editor' });
      await now.replace({ scope: store.GLOBAL, match: 'Turkish', text: 'The user writes in English', actor: 'editor' });
    });
    assert.deepEqual(seen.map((s) => s.scope).sort(), [p.key, 'global'].sort(), 'once per scope');
    // A batch cannot change a scope that it did not name.
    await assert.rejects(store.batch([p], (now) => now.add({ scope: b, text: 'x', actor: 'editor' })), /not part of this change/);
    // The last change fails (the global MEMORY.md is full): every file back, no journal row, the copies' undo runs.
    for (let i = 0; ; i++) { try { await store.add({ scope: store.GLOBAL, text: `Global fact ${i} ${'x'.repeat(200)}`, actor: 'agent' }); } catch { break; } }
    const journal = join(root, 'mem', 'journal.jsonl');
    const files = async () => Promise.all([join(p.dir, 'MEMORY.md'), join(p.dir, 'api.md'), join(p.dir, 'deploy.md'), join(store.GLOBAL.dir, 'MEMORY.md'), journal].map((f) => readFile(f, 'utf8').catch(() => null)));
    const was = await files();
    undone.length = 0;
    await assert.rejects(store.batch([p, store.GLOBAL], async (now) => {
      await now.remove({ scope: p, topic: 'api', match: 'port 8080', actor: 'editor' });
      await now.add({ scope: p, topic: 'deploy', text: 'Deploys need a tag', actor: 'editor' });
      await now.add({ scope: store.GLOBAL, text: `One more global fact ${'y'.repeat(250)}`, actor: 'editor' });
    }), /would have \d+ of its 8000/);
    assert.deepEqual(await files(), was, 'the last change failed: every file as it was, no new topic, no journal row');
    assert.deepEqual(undone, [p.key], 'the copy of a failed save is undone (the global scope was refused before its first write: no copy)');
    // A copy that cannot be kept: nothing is saved.
    fail = true;
    await assert.rejects(store.add({ scope: p, text: 'Not saved', actor: 'agent' }), /no room for the copy/);
    assert.doesNotMatch(await readFile(join(p.dir, 'MEMORY.md'), 'utf8'), /Not saved/);
    fail = false;
    // write: whole files; a topic that the version does not have goes; a bad name is refused.
    const main = await readFile(join(p.dir, 'MEMORY.md'), 'utf8');
    await store.batch([p], (now) => now.write(p, { 'MEMORY.md': '# Memory\n\n- Only this note\n' }, 'restore'));
    assert.deepEqual((await readdir(p.dir)).filter((f) => f.endsWith('.md')), ['MEMORY.md'], 'api.md went');
    assert.equal(await readFile(join(p.dir, 'project.json'), 'utf8').then(() => true), true, 'project.json stays');
    await assert.rejects(store.batch([p], (now) => now.write(p, { '../x.md': 'x' }, 'restore')), /not a memory file/);
    await store.batch([p], (now) => now.write(p, { 'MEMORY.md': main }, 'restore'));
  }

  // memoryDiff.
  {
    const d = memoryDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj\nk\n', 'AGENTS.md');
    assert.equal(d.patch, '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -2,9 +2,10 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n i\n j\n+k\n');
    assert.equal(d.added, 2); assert.equal(d.removed, 1);
    assert.equal(memoryDiff('x\n', 'x\n').patch, '', 'no change: no patch');
    assert.equal(memoryDiff('', 'one\ntwo\n').patch, '--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -0,0 +1,2 @@\n+one\n+two\n');
    assert.equal(memoryDiff('one\n', '').patch, '--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1,1 +0,0 @@\n-one\n');
    const far = memoryDiff(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 2 || i === 25 ? `L${i}` : `l${i}`)).join('\n'));
    assert.equal(far.patch.match(/^@@/gm).length, 2, 'two hunks far apart');
    const big = memoryDiff('', Array.from({ length: 5000 }, (_, i) => `n${i}`).join('\n'));
    assert.equal(big.truncated, true); assert.ok(big.patch.split('\n').length <= 4001);
  }

  // The source of a note.
  {
    assert.equal(formatSource('session-1a', 12), 'session-1a #12'); assert.equal(formatSource('session-1a'), 'session-1a');
    assert.deepEqual(parseSource('session-6f8f5842-3f17 #12'), { sessionId: 'session-6f8f5842-3f17', seq: 12 });
    assert.deepEqual(parseSource('session-6f8f5842'), { sessionId: 'session-6f8f5842' });
    for (const bad of ['editor', 'agent-1', 'session-x #-1', 'session-x #1 #2', 'session-a/../b', '', undefined]) assert.equal(parseSource(bad), undefined, String(bad));
    let seq = 0;
    const ev = (type, data, extra = {}) => ({ seq: seq++, type, data, ...extra });
    const user = (text) => ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
    const parent = [user('parent asks'), ev('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })];
    assert.equal(lastUserSeq(parent, parent.length), undefined, 'a fork with no message of its own');
    const own = [user('mine'), user('withdrawn'), ev('user/message', { source: { kind: ROLLBACK_SOURCE }, content: [] }, { sourceEventSeqs: [3] })];
    assert.equal(lastUserSeq([...parent, ...own], parent.length), 2, 'the newest own message that was not withdrawn');
  }

  // A project file for the export.
  {
    const max = 1024;
    assert.deepEqual(await projectFile(project, 'AGENTS.md', max), { real: join(await import('node:fs/promises').then((f) => f.realpath(project)), 'AGENTS.md'), text: null }, 'missing: the path to make');
    await writeFile(join(project, 'AGENTS.md'), '# Rules\n');
    assert.equal((await projectFile(project, 'AGENTS.md', max)).text, '# Rules\n', 'read through the symlinked temp path');
    await replaceProjectFile(project, 'AGENTS.md', '# Rules\n', '# Rules\n\nmore\n', max);
    assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), '# Rules\n\nmore\n');
    await assert.rejects(replaceProjectFile(project, 'AGENTS.md', '# Rules\n', 'x', max), /changed after the preview/);
    // A symlink out of the folder: refused; the outside file is not read and does not change.
    const outside = join(root, 'outside.md'); await writeFile(outside, 'SECRET\n');
    const linked = join(root, 'linked'); await mkdir(linked); await symlink(outside, join(linked, 'AGENTS.md'));
    await assert.rejects(projectFile(linked, 'AGENTS.md', max), /outside the project folder/);
    await assert.rejects(replaceProjectFile(linked, 'AGENTS.md', 'SECRET\n', 'x', max), /outside the project folder/);
    assert.equal(await readFile(outside, 'utf8'), 'SECRET\n');
    // A symlink inside the folder: its target is the file.
    const inside = join(root, 'inside'); await mkdir(join(inside, 'docs'), { recursive: true });
    await writeFile(join(inside, 'docs', 'AGENTS.md'), 'shared\n'); await symlink('docs/AGENTS.md', join(inside, 'AGENTS.md'));
    await replaceProjectFile(inside, 'AGENTS.md', 'shared\n', 'shared\nnew\n', max);
    assert.equal(await readFile(join(inside, 'docs', 'AGENTS.md'), 'utf8'), 'shared\nnew\n', 'the target changes');
    assert.ok((await import('node:fs/promises').then((f) => f.lstat(join(inside, 'AGENTS.md')))).isSymbolicLink(), 'the link stays a link');
    // A dangling symlink: refused, nothing made.
    const dangling = join(root, 'dangling'); await mkdir(dangling); await symlink(join(root, 'nowhere.md'), join(dangling, 'AGENTS.md'));
    await assert.rejects(replaceProjectFile(dangling, 'AGENTS.md', null, 'x', max), /points nowhere/);
    await assert.rejects(stat(join(root, 'nowhere.md')), /ENOENT/);
    // Too large; not UTF-8.
    await writeFile(join(project, 'AGENTS.md'), 'x'.repeat(max + 1));
    await assert.rejects(projectFile(project, 'AGENTS.md', max), (e) => e.status === 413);
    await writeFile(join(project, 'AGENTS.md'), Buffer.from([0xff, 0xfe, 0x00]));
    await assert.rejects(projectFile(project, 'AGENTS.md', max), /UTF-8/);
    // A FIFO: refused at once (a red test ends: a writer opens it after 3 s).
    if (process.platform !== 'win32') {
      const fifoDir = join(root, 'fifo'); await mkdir(fifoDir); const fifo = join(fifoDir, 'AGENTS.md'); execFileSync('mkfifo', [fifo]);
      const timer = setTimeout(() => { execFileSync('sh', ['-c', `echo x > "${fifo}"`]); }, 3000);
      const t0 = Date.now();
      await assert.rejects(projectFile(fifoDir, 'AGENTS.md', max), /not a regular file/);
      clearTimeout(timer); assert.ok(Date.now() - t0 < 1000, 'a FIFO does not block');
    }
    // A failed write (a read-only folder): the old file stays, no temp file.
    if (process.getuid?.() !== 0) {
      await writeFile(join(project, 'AGENTS.md'), 'old\n');
      await chmod(project, 0o500);
      try { await assert.rejects(replaceProjectFile(project, 'AGENTS.md', 'old\n', 'new\n', max), /AGENTS\.md was not changed/); } finally { await chmod(project, 0o700); }
      assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), 'old\n');
      assert.deepEqual((await readdir(project)).filter((f) => f.includes('tmp')), [], 'no temp file');
    }
    // The last change (the rename) fails: the old file stays, the temp file goes.
    await assert.rejects(replaceProjectFile(project, 'AGENTS.md', 'old\n', 'new\n', max, { swap: async () => { throw Object.assign(new Error('EXDEV: no rename'), { code: 'EXDEV' }); } }), /AGENTS\.md was not changed: EXDEV/);
    assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), 'old\n');
    assert.deepEqual((await readdir(project)).filter((f) => f.includes('tmp')), [], 'no temp file after a failed rename');
    // A temp file of an earlier crash goes first.
    await writeFile(join(project, '.AGENTS.md.composer-plus.tmp'), 'stale');
    await replaceProjectFile(project, 'AGENTS.md', 'old\n', 'newer\n', max);
    assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), 'newer\n');
    assert.deepEqual((await readdir(project)).filter((f) => f.includes('tmp')), []);
  }
  console.log('memory base checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
