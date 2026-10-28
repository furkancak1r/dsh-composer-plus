// Worktree chats (Host half): the `.worktreeinclude` matcher, the copy of included ignored files into a new worktree (never
// a file outside either tree, never a FIFO, never an over-copied folder), the branch name, "New branch" (worktree, workspace,
// chat, message) and the route. Real git in temporary repositories; fake dsh services.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, branchName, branchStatus, copyIncluded, fallbackBranch, includeMatcher, listWorktrees, repoOf, startOnBranch, uniqueBranch, WORKTREES_PATH } from '../index.js';

const subprocess = {
  resolveExecutable: async () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
  spawn({ argv, cwd, env }) {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    return {
      done: new Promise((resolve) => child.on('close', (code) => resolve({ exitCode: code, signal: null }))),
      collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err }) } },
    };
  },
};
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const repo = (path, files) => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) write(join(path, name), text);
  git(path, 'add', '-A'); git(path, 'commit', '-q', '-m', 'init');
  return path;
};
/** A red run that opens a FIFO for reading blocks; this writer side lets it end (a green run never has a reader). */
const releaseFifos = (paths) => {
  const timer = setInterval(() => { for (const p of paths) { try { closeSync(openSync(p, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* no reader */ } } }, 1500);
  return () => clearInterval(timer);
};
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };

// Matcher: gitignore syntax, last match wins, folder-only, anchored vs any depth, `**`.
{
  const m = includeMatcher('# comment\n\n.env*\n!.env.production\n\\#hash\n\\!bang\nspaced   \nnode_modules/\n/top.txt\ndeep/x.txt\n**/cache\nlogs/**\na/**/z\n*.lo?\n[ab]x.cfg\n/q*c\n');
  assert.equal(m('.env', false), true); assert.equal(m('.env.local', false), true);
  assert.equal(m('.env.production', false), false, 'negated');
  assert.equal(m('sub/.env', false), true, 'a pattern without a slash matches at any depth'); assert.equal(m('sub/.env.production', false), false);
  assert.equal(m('#hash', false), true); assert.equal(m('!bang', false), true); assert.equal(m('spaced', false), true, 'trailing spaces go');
  assert.equal(m('# comment', false), false);
  assert.equal(m('node_modules', true), true); assert.equal(m('node_modules', false), false, 'folder only');
  assert.equal(m('app/node_modules', true), true); assert.equal(m('node_modules/p/i.js', false), true, 'a parent folder matches');
  assert.equal(m('top.txt', false), true); assert.equal(m('sub/top.txt', false), false, 'a leading slash anchors');
  assert.equal(m('deep/x.txt', false), true); assert.equal(m('other/deep/x.txt', false), false, 'a middle slash anchors');
  assert.equal(m('cache', true), true); assert.equal(m('a/b/cache', false), true, 'leading **/');
  assert.equal(m('logs/a/b.txt', false), true); assert.equal(m('logs', true), false, 'trailing /** is the content only');
  assert.equal(m('a/z', false), true); assert.equal(m('a/b/c/z', false), true); assert.equal(m('b/a/z', false), false, 'middle /**/');
  assert.equal(m('x.log', false), true); assert.equal(m('ax.cfg', false), true); assert.equal(m('cx.cfg', false), false);
  assert.equal(m('qbc', false), true); assert.equal(m('q/c', false), false, '* never matches /');
  assert.equal(includeMatcher('!keep.env\n*.env')('keep.env', false), true, 'last match wins (include after negation)');
  assert.equal(includeMatcher('*.env\n!keep.env')('keep.env', false), false, 'last match wins (negation after include)');
  assert.equal(includeMatcher('build/out.txt').reaches('build'), true);
  assert.equal(includeMatcher('out.txt').reaches('build'), false, 'only an anchored pattern names a path inside a folder');
  assert.equal(includeMatcher('!build/out.txt').reaches('build'), false);
  assert.equal(includeMatcher('').reaches('x'), false); assert.equal(includeMatcher('')('x', false), false);
  assert.equal(includeMatcher('[a-c]x.cfg')('bx.cfg', false), true); assert.equal(includeMatcher('[!a-c]x.cfg')('bx.cfg', false), false);
  assert.equal(includeMatcher('[z-a]x')('zx', false), false, 'a broken range matches nothing');
  assert.equal(includeMatcher('**')('a/b', false), true); assert.equal(includeMatcher('a\\*')('a*', false), true); assert.equal(includeMatcher('a\\*')('ab', false), false);
  // A pattern that made the old RegExp backtrack for minutes on a long name (ReDoS) ends at once.
  const start = Date.now();
  assert.equal(includeMatcher(`${'*a'.repeat(20)}b\n${'**/a/'.repeat(8)}b`)(`${'a/'.repeat(100)}${'a'.repeat(5000)}`, false), false);
  assert.ok(Date.now() - start < 1000, `slow pattern took ${Date.now() - start} ms`);
}

// Branch name fallback: Turkish letters and other accents fold; no word gives the time.
assert.equal(fallbackBranch('Giriş sayfasına şifre sıfırlama bağlantısı ekle, lütfen'), 'feat/giris-sayfasina-sifre-sifirlama-baglantisi');
assert.equal(fallbackBranch('İÇERİK ÖĞÜ'), 'feat/icerik-ogu');
assert.equal(fallbackBranch('Crème brûlée naïve'), 'feat/creme-brulee-naive');
assert.equal(fallbackBranch('!!! ???', new Date(2026, 9, 27, 9, 5)), 'feat/chat-20261027-0905');
assert.ok(fallbackBranch(`${'a'.repeat(40)} ${'b'.repeat(40)}`).length <= 60);

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cp-worktrees-')));
try {
  // A model that answers `answer` (after `gate`), with a model default output cap below ours.
  const prepared = [];
  const llmSaying = (answer, gate = Promise.resolve()) => ({
    prepareCall: async (route, signal, configure) => {
      const controls = configure({}, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }, defaultMaxTokens: 1000 });
      prepared.push(controls);
      return { config: { ...route, ...controls }, async *stream() { await gate; yield { type: 'text-delta', text: answer }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
    },
  });
  const route = { provider: 'demo', model: 'demo' };
  assert.deepEqual(await branchName({ llm: llmSaying('feat/dark-mode-toggle'), route }, 'x'), { name: 'feat/dark-mode-toggle', fromModel: true });
  assert.deepEqual(prepared.at(-1), { maxTokens: 1000, reasoningEffort: 'low' }, 'lowest effort; the cap respects the model default');
  assert.deepEqual(await branchName({ llm: llmSaying('"fix/login-loop"\n'), route }, 'x'), { name: 'fix/login-loop', fromModel: true }, 'quotes go');
  for (const bad of ['Feature/Dark Mode', 'feat/', 'wip/dark-mode', `feat/${'a-'.repeat(30)}b`, 'feat/a..b', 'feat/dark_mode']) {
    assert.deepEqual(await branchName({ llm: llmSaying(bad), route }, 'Add dark mode'), { name: 'feat/add-dark-mode', fromModel: false }, bad);
  }
  const failing = { prepareCall: async () => { throw new Error('no key'); } };
  assert.deepEqual(await branchName({ llm: failing, route }, 'Add dark mode'), { name: 'feat/add-dark-mode', fromModel: false }, 'a failed call');
  assert.deepEqual(await branchName({ llm: undefined, route: undefined }, 'Add dark mode'), { name: 'feat/add-dark-mode', fromModel: false }, 'no model');

  // Copy: one repository with every hard case, copied into a real linked worktree (it has the tracked symlinks).
  const outside = join(base, 'outside'); write(join(outside, 'secret.txt'), 'secret'); chmodSync(join(outside, 'secret.txt'), 0o000);
  const outsideDir = join(base, 'outside-dir'); mkdirSync(outsideDir);
  const nowhere = join(base, 'nowhere-target');
  const C = join(base, 'C'); mkdirSync(C);
  symlinkSync('../outside-dir', join(C, 'ext')); symlinkSync(nowhere, join(C, 'dang'));
  // A sibling whose name starts with the worktree's name (`wt-c-evil` next to `wt-c`) is still outside.
  const evil = join(base, 'wt-c-evil'); mkdirSync(evil); symlinkSync('../wt-c-evil', join(C, 'sib'));
  repo(C, { '.gitignore': '.env*\nnode_modules/\nbuild/\n*.local\nlink-out\n', 'a.txt': 'a\n',
    '.worktreeinclude': '# shared files\n.env*\n!.env.production\nnode_modules/\nbuild/out.txt\nbuild/pipe\nlink-out\n*.local\next/deep/x.local\n' });
  // The tracked links become real folders in this tree only (the new worktree gets the links).
  rmSync(join(C, 'ext')); write(join(C, 'ext', 'cfg.local'), 'cfg'); write(join(C, 'ext', 'deep', 'x.local'), 'x'); rmSync(join(C, 'dang')); write(join(C, 'dang', 'd.local'), 'd'); rmSync(join(C, 'sib')); write(join(C, 'sib', 's.local'), 's');
  write(join(C, '.env'), 'e'); write(join(C, '.env.production'), 'prod');
  write(join(C, 'node_modules', 'p', 'i.js'), 'i'); write(join(C, 'node_modules', 'p', '.git', 'HEAD'), 'nested repo'); symlinkSync('../p/i.js', join(C, 'node_modules', 'p', 'tool'));
    write(join(C, 'app', 'node_modules', 'q', 'i.js'), 'q'); write(join(C, 'app', '.env.production'), 'app prod');
  write(join(C, 'build', 'out.txt'), 'out'); write(join(C, 'build', 'other.txt'), 'other');
  // git never lists a FIFO: one inside a copied folder, and one that an anchored pattern names inside a collapsed folder.
  execFileSync('mkfifo', [join(C, 'node_modules', 'p', 'fifo'), join(C, 'build', 'pipe')]);
  symlinkSync(join(outside, 'secret.txt'), join(C, 'link-out'));
  const listedC = git(C, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory').split('\0');
  assert.ok(listedC.includes('app/') && listedC.includes('build/'), 'git lists app/ and build/ as whole folders (the over-copy trap)');
  const W = join(base, 'wt-c'); git(C, 'worktree', 'add', '-q', '--detach', W, 'HEAD');
  assert.ok(isLink(join(W, 'ext')) && isLink(join(W, 'dang')), 'the new worktree has the tracked links');
  let stop = releaseFifos([join(C, 'build', 'pipe'), join(C, 'node_modules', 'p', 'fifo')]);
  let r;
  try { r = await copyIncluded(subprocess, C, W); } finally { stop(); }
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
  assert.equal(r.include, true);
  assert.equal(readFileSync(join(W, '.env'), 'utf8'), 'e');
  assert.ok(!existsSync(join(W, '.env.production')), '.env.production is never copied');
  assert.equal(readFileSync(join(W, 'node_modules', 'p', 'i.js'), 'utf8'), 'i', 'the folder pattern copies the folder');
  assert.equal(readlinkSync(join(W, 'node_modules', 'p', 'tool')), '../p/i.js', 'a link inside stays a link');
  assert.ok(!existsSync(join(W, 'node_modules', 'p', 'fifo')), 'a FIFO inside a copied folder is skipped');
  assert.ok(!existsSync(join(W, 'node_modules', 'p', '.git')), 'a nested .git is never copied');
  assert.equal(readFileSync(join(W, 'app', 'node_modules', 'q', 'i.js'), 'utf8'), 'q');
  assert.ok(!existsSync(join(W, 'app', '.env.production')), 'app/ is not copied for app/node_modules/ (no over-copy)');
  assert.equal(readFileSync(join(W, 'build', 'out.txt'), 'utf8'), 'out', 'an anchored file inside a collapsed folder');
  assert.ok(!existsSync(join(W, 'build', 'other.txt')), 'its sibling stays');
  assert.equal(readlinkSync(join(W, 'link-out')), join(outside, 'secret.txt'), 'a link to outside is copied as a link (its target is unreadable: never read)');
  assert.ok(!existsSync(join(W, 'build', 'pipe')), 'a FIFO is skipped'); assert.match(reasons['build/pipe'], /not a file/);
  assert.ok(!existsSync(join(outsideDir, 'cfg.local')), 'nothing goes through a tracked link to outside'); assert.match(reasons['ext/cfg.local'], /out of the worktree/);
  assert.ok(!existsSync(join(outsideDir, 'deep')), 'no folder is made through a tracked link to outside'); assert.match(reasons['ext/deep/x.local'], /out of the worktree/);
  assert.ok(!existsSync(join(evil, 's.local')), 'a same-prefix sibling folder is outside'); assert.match(reasons['sib/s.local'], /out of the worktree/);
  assert.ok(!existsSync(nowhere), 'nothing is made through a dangling link'); assert.ok('dang/d.local' in reasons);
  assert.equal(r.copied, 5, JSON.stringify(r));
  // Again: nothing is overwritten.
  writeFileSync(join(W, '.env'), 'changed');
  stop = releaseFifos([join(C, 'build', 'pipe'), join(C, 'node_modules', 'p', 'fifo')]);
  try { r = await copyIncluded(subprocess, C, W); } finally { stop(); }
  assert.equal(r.copied, 0); assert.equal(readFileSync(join(W, '.env'), 'utf8'), 'changed', 'an existing target stays');
  assert.equal(r.skipped.find((s) => s.path === '.env')?.reason, 'exists');

  // A source folder that leads out (a listing that names a path below a link, as after a swap) is never read.
  const outside2 = join(base, 'outside2'); write(join(outside2, 'plain.txt'), 'outside text');
  const L = repo(join(base, 'L'), { '.worktreeinclude': '*.txt\n' });
  symlinkSync(outside2, join(L, 'lnk'));
  const crafted = { ...subprocess, spawn: (spec) => {
    if (!spec.argv.includes('ls-files')) return subprocess.spawn(spec);
    return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: 'lnk/plain.txt\0', lossy: false }) }, stderr: { readFrom: () => ({ text: '' }) } } };
  } };
  const LW = join(base, 'lw'); mkdirSync(LW);
  r = await copyIncluded(crafted, L, LW);
  assert.ok(!existsSync(join(LW, 'lnk', 'plain.txt')), 'no copy from outside the repository'); assert.match(r.skipped[0].reason, /out of the repository/);

  // No include file → nothing; an include that is a link to outside or a FIFO counts as none (and does not hang).
  const N = repo(join(base, 'N'), { '.gitignore': '.env\n' }); write(join(N, '.env'), 'n');
  const NW = join(base, 'nw'); mkdirSync(NW);
  assert.deepEqual(await copyIncluded(subprocess, N, NW), { copied: 0, skipped: [], include: false });
  write(join(outside, 'include'), '.env\n'); symlinkSync(join(outside, 'include'), join(N, '.worktreeinclude'));
  assert.deepEqual(await copyIncluded(subprocess, N, NW), { copied: 0, skipped: [], include: false }, 'a linked include from outside is not read');
  rmSync(join(N, '.worktreeinclude')); execFileSync('mkfifo', [join(N, '.worktreeinclude')]);
  stop = releaseFifos([join(N, '.worktreeinclude')]);
  try { assert.deepEqual(await copyIncluded(subprocess, N, NW), { copied: 0, skipped: [], include: false }, 'a FIFO include is not opened'); } finally { stop(); }
  assert.ok(!existsSync(join(NW, '.env')));

  // New branch.
  // `.*` also matches the ignored `.worktrees/` folder: it must never be copied into a new worktree.
  const S = repo(join(base, 'S'), { '.gitignore': '.env\nnode_modules/\n', '.worktreeinclude': '.*\nnode_modules/\n', 'a.txt': 'a\n' });
  write(join(S, '.env'), 's'); write(join(S, 'node_modules', 'm', 'i.js'), 'm');
  writeFileSync(join(S, '.git', 'info', 'exclude'), '# local');
  const made = { workspaces: [], sessions: [], models: [], prompts: [] };
  let registryFails = false;
  const registry = { create: async (path, title) => {
    if (registryFails) throw new Error('registry is down');
    const real = realpathSync(path); made.workspaces.push({ path: real, title }); return { id: `ws-${made.workspaces.length}`, path: real };
  } };
  const sessionController = {
    create: async (input) => { made.sessions.push(input); return { sessionId: `new-${made.sessions.length}` }; },
    selectModel: async (input) => { made.models.push(input); if (input.model === 'gone') throw new Error('unknown model'); },
    // Like dsh (0.2.0-rc.2 and 0.2.1-rc.2): `prompt(request, signal)` calls `signal.throwIfAborted()` first.
    prompt: async (input, signal) => { signal.throwIfAborted(); made.prompts.push(input); },
  };
  const chats = {
    main: { cwd: S, values: { agentPreset: 'ptc', modelSelection: { lastUsed: { provider: 'old', model: 'old' }, next: { provider: 'demo', model: 'big', reasoningEffort: 'high' } } } },
    plainModel: { cwd: join(S, 'node_modules'), values: { modelSelection: { lastUsed: { provider: 'demo', model: 'small' }, next: null } } },
    sub: { cwd: S, origin: 'subagent', values: {} },
    none: { cwd: undefined },
  };
  let opened = 0, disposed = 0;
  const sessionQuery = { observeSession: async (id, opts) => {
    const chat = chats[id];
    if (chat === undefined) throw new Error('no such chat');
    opened++;
    return { header: { cwd: chat.cwd, ...(chat.origin ? { origin: chat.origin } : {}) }, events: [], ...(opts?.projectionMode === 'none' ? {} : { projections: { values: chat.values ?? {} } }), [Symbol.dispose]() { disposed++; } };
  } };
  const deps = (llm) => ({ subprocess, sessionController, sessionQuery, registry, llm, route: llm === undefined ? undefined : route });
  const head = (cwd) => git(cwd, 'rev-parse', 'HEAD').trim();
  const branchOf = (cwd) => git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

  const r1 = await startOnBranch(deps(llmSaying('feat/dark-mode-toggle')), 'main', 'Add a dark mode toggle');
  assert.deepEqual(r1, { sessionId: 'new-1', branch: 'feat/dark-mode-toggle', path: join(S, '.worktrees', 'feat-dark-mode-toggle'), workspaceId: 'ws-1', copied: 2, skipped: [], named: true });
  assert.equal(branchOf(r1.path), 'feat/dark-mode-toggle'); assert.equal(head(r1.path), head(S), 'from the chat\'s HEAD');
  assert.equal(readFileSync(join(r1.path, '.env'), 'utf8'), 's'); assert.ok(existsSync(join(r1.path, 'node_modules', 'm', 'i.js')));
  assert.deepEqual(made.workspaces[0], { path: r1.path, title: 'feat/dark-mode-toggle' }, 'the worktree is its own workspace');
  assert.deepEqual(made.sessions[0], { workspaceId: 'ws-1', agentPreset: 'ptc' }, 'the source chat\'s preset');
  assert.deepEqual(made.models[0], { sessionId: 'new-1', provider: 'demo', model: 'big', reasoningEffort: 'high' }, 'the source chat\'s next model');
  assert.equal(made.prompts[0].sessionId, 'new-1'); assert.equal(made.prompts[0].mode, 'queue');
  assert.deepEqual(made.prompts[0].content, [{ type: 'text', text: 'Add a dark mode toggle' }], 'the message reaches the new chat');
  assert.equal(readFileSync(join(S, '.git', 'info', 'exclude'), 'utf8'), '# local\n.worktrees/\n', '.worktrees/ is excluded locally');
  assert.equal(git(S, 'status', '--porcelain'), '', 'the main tree stays clean');

  const r2 = await startOnBranch(deps(llmSaying('feat/dark-mode-toggle')), 'main', 'Add a dark mode toggle again');
  assert.equal(r2.branch, 'feat/dark-mode-toggle-2', 'a taken name gets -2');
  assert.ok(!existsSync(join(r2.path, '.worktrees')), 'the .worktrees/ folder is never copied'); assert.equal(r2.copied, 2); assert.equal(r2.path, join(S, '.worktrees', 'feat-dark-mode-toggle-2'));
  assert.equal(readFileSync(join(S, '.git', 'info', 'exclude'), 'utf8'), '# local\n.worktrees/\n', 'excluded once');

  const r3 = await startOnBranch(deps(llmSaying('Here is a name: Feature/Login Loop')), 'main', 'Fix the login redirect loop!');
  assert.equal(r3.branch, 'feat/fix-the-login-redirect-loop'); assert.equal(r3.named, false, 'bad answer: the message slug');

  const r4 = await startOnBranch(deps(undefined), 'plainModel', 'Giriş sayfasına şifre sıfırlama ekle');
  assert.equal(r4.branch, 'feat/giris-sayfasina-sifre-sifirlama-ekle');
  assert.deepEqual(made.sessions.at(-1), { workspaceId: `ws-${made.workspaces.length}` }, 'no preset: dsh\'s default');
  assert.deepEqual(made.models.at(-1), { sessionId: r4.sessionId, provider: 'demo', model: 'small' }, 'no next model: the last used one');
  assert.equal(head(r4.path), head(S), 'a chat in a subfolder starts from its repository');

  // From inside a linked worktree: the new one goes under the MAIN root, from that worktree's HEAD, with its files.
  writeFileSync(join(r1.path, 'wt.txt'), 'w'); git(r1.path, 'add', 'wt.txt'); git(r1.path, 'commit', '-q', '-m', 'wt work');
  writeFileSync(join(r1.path, '.env'), 'from wt');
  chats.wt = { cwd: r1.path, values: {} };
  const r5 = await startOnBranch(deps(llmSaying('fix/header-color')), 'wt', 'Fix the header color');
  assert.equal(r5.path, join(S, '.worktrees', 'fix-header-color'), 'under the main root');
  assert.equal(head(r5.path), head(r1.path)); assert.equal(readFileSync(join(r5.path, '.env'), 'utf8'), 'from wt', 'copied from the chat\'s own tree');

  // A folder that exists without a branch also counts as taken; a model that the new chat refuses does not stop it.
  mkdirSync(join(S, '.worktrees', 'feat-taken-dir'));
  chats.main.values.modelSelection.next = { provider: 'demo', model: 'gone' };
  const r6 = await startOnBranch(deps(llmSaying('feat/taken-dir')), 'main', 'x');
  assert.equal(r6.branch, 'feat/taken-dir-2'); assert.equal(made.prompts.at(-1).sessionId, r6.sessionId);
  await assert.rejects(uniqueBranch(subprocess, S, S, 'feat/bad..name'), /not a valid branch name/);

  // Attachments: an image goes as it is; a file of the source chat (its upload receipt) is stored again for the new chat,
  // in dsh's order (attachments first, then the text). A message of files only gets the dated name. A file that is not
  // uploaded any more is refused before git starts.
  {
    const uploads = []; const reads = [];
    const ref = { attachmentId: 'att-1', name: 'spec.pdf', bytes: 3 };
    const agents = { get: (id) => (id === 'main' ? { id: 'main' } : undefined) };
    const fileUploads = { resolve: (agent, receipt) => (agent?.id === 'main' && receipt === 'rc-1' ? ref : undefined),
      uploadStream: async (req) => { const chunks = []; for await (const c of req.data) chunks.push(...c); uploads.push({ sessionId: req.sessionId, name: req.name, bytes: chunks }); return { receiptId: `new-rc-${uploads.length}` }; } };
    const store = { readFileStream: (r) => { reads.push(r); return (async function* () { yield new Uint8Array([1, 2, 3]); })(); } };
    const withFiles = (llm) => ({ ...deps(llm), agents, fileUploads, store });
    const image = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'shot.png' };
    const ra = await startOnBranch(withFiles(llmSaying('feat/add-the-spec')), 'main', 'Build this spec', undefined, [image, { type: 'file', receiptId: 'rc-1' }]);
    assert.equal(ra.branch, 'feat/add-the-spec');
    assert.deepEqual(reads, [ref]); assert.deepEqual(uploads, [{ sessionId: ra.sessionId, name: 'spec.pdf', bytes: [1, 2, 3] }], 'the file is stored for the new chat');
    assert.deepEqual(made.prompts.at(-1).content, [image, { type: 'file', receiptId: 'new-rc-1' }, { type: 'text', text: 'Build this spec' }]);
    const rb = await startOnBranch(withFiles(llmSaying('feat/never-asked')), 'main', '', undefined, [image]);
    assert.match(rb.branch, /^feat\/chat-\d{8}-\d{4}$/, 'files only: the dated name, no model call'); assert.equal(rb.named, false);
    assert.deepEqual(made.prompts.at(-1).content, [image], 'no empty text part');
    const trees = git(S, 'worktree', 'list').split('\n').filter(Boolean).length;
    await assert.rejects(startOnBranch(withFiles(undefined), 'main', 'x', undefined, [{ type: 'file', receiptId: 'gone' }]), (e) => e.status === 409 && /not uploaded any more/.test(e.message));
    await assert.rejects(startOnBranch(deps(undefined), 'main', 'x', undefined, [{ type: 'file', receiptId: 'rc-1' }]), (e) => e.status === 409 && /cannot give files/.test(e.message), 'an older dsh without the upload services');
    assert.equal(git(S, 'worktree', 'list').split('\n').filter(Boolean).length, trees, 'a refused file makes no worktree');
  }

  // One start per repository at a time (also from its other worktree).
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const first = startOnBranch(deps(llmSaying('feat/slow-one', gate)), 'main', 'slow');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(startOnBranch(deps(llmSaying('feat/second')), 'wt', 'second'), (e) => e.status === 409 && /already starting/.test(e.message));
  open();
  assert.equal((await first).branch, 'feat/slow-one');
  assert.equal((await startOnBranch(deps(llmSaying('feat/after-it')), 'main', 'after')).branch, 'feat/after-it', 'the lock is released');

  // Refusals.
  await assert.rejects(startOnBranch(deps(undefined), 'sub', 'x'), (e) => e.status === 409 && /subagent/.test(e.message));
  await assert.rejects(startOnBranch(deps(undefined), 'none', 'x'), (e) => e.status === 409);
  const E = join(base, 'E'); mkdirSync(E); git(E, 'init', '-q', '-b', 'main'); chats.empty = { cwd: E };
  await assert.rejects(startOnBranch(deps(undefined), 'empty', 'x'), (e) => e.status === 409 && /no commit/.test(e.message));
  const plain = join(base, 'plain'); mkdirSync(plain); chats.plain = { cwd: plain };
  await assert.rejects(startOnBranch(deps(undefined), 'plain', 'x'), (e) => e.status === 409 && /not in a git repository/.test(e.message));
  assert.equal(git(S, 'worktree', 'list').split('\n').filter(Boolean).length, 11, 'no refused start made a worktree (main + 10 starts)');

  // A failure after the worktree exists keeps it and names it.
  registryFails = true;
  await assert.rejects(startOnBranch(deps(llmSaying('feat/kept-tree')), 'main', 'x'), (e) => e.message.includes(join(S, '.worktrees', 'feat-kept-tree')) && /registry is down/.test(e.message));
  registryFails = false;
  assert.equal(branchOf(join(S, '.worktrees', 'feat-kept-tree')), 'feat/kept-tree', 'the worktree stays on disk');

  // .worktrees/ already ignored by .gitignore: info/exclude is not touched.
  const G = repo(join(base, 'G'), { '.gitignore': '.worktrees/\n' });
  const excludeBefore = readFileSync(join(G, '.git', 'info', 'exclude'), 'utf8');
  chats.g = { cwd: G };
  const rg = await startOnBranch(deps(llmSaying('docs/readme-intro')), 'g', 'x');
  assert.equal(rg.path, join(G, '.worktrees', 'docs-readme-intro'));
  assert.equal(readFileSync(join(G, '.git', 'info', 'exclude'), 'utf8'), excludeBefore);

  // Review P1: a committed `.worktrees` symlink must not put the checkout and the copied secrets outside the repository.
  const away = join(base, 'away'); mkdirSync(away);
  const LK = join(base, 'LK'); mkdirSync(LK); symlinkSync(away, join(LK, '.worktrees'));
  repo(LK, { '.gitignore': '.env\n', '.worktreeinclude': '.env\n' }); write(join(LK, '.env'), 'SECRET');
  chats.link = { cwd: LK };
  await assert.rejects(startOnBranch(deps(llmSaying('feat/add-login')), 'link', 'x'), (e) => e.status === 409 && /not a folder/.test(e.message));
  assert.deepEqual(execFileSync('ls', ['-A', away], { encoding: 'utf8' }), '', 'nothing was made outside');
  assert.equal(git(LK, 'worktree', 'list').split('\n').filter(Boolean).length, 1, 'no worktree');

  // Review P2: a `!` rule for a path inside an included folder keeps that path out (git itself would copy it).
  const FX = repo(join(base, 'FX'), { '.gitignore': 'config/\n', '.worktreeinclude': 'config/\n!config/.env.production\n!*.pem\n' });
  write(join(FX, 'config', '.env'), 'dev'); write(join(FX, 'config', '.env.production'), 'PROD'); write(join(FX, 'config', 'deep', 'k.pem'), 'KEY');
  const FXW = join(base, 'FXW'); mkdirSync(FXW);
  const fxc = await copyIncluded(subprocess, FX, FXW);
  assert.equal(readFileSync(join(FXW, 'config', '.env'), 'utf8'), 'dev');
  assert.ok(!existsSync(join(FXW, 'config', '.env.production')), 'a negated file inside an included folder is not copied');
  assert.ok(!existsSync(join(FXW, 'config', 'deep', 'k.pem')), 'a negated basename pattern inside it is not copied either');
  assert.deepEqual(fxc.skipped.map((s) => s.path).sort(), ['config/.env.production', 'config/deep/k.pem']);
  assert.equal(opened, disposed, 'every observation is disposed');

  // Status and list.
  assert.equal(await repoOf(subprocess, plain), undefined);
  assert.deepEqual(await repoOf(subprocess, join(r1.path)), { top: r1.path, common: join(S, '.git'), root: S, hasCommit: true });
  writeFileSync(join(S, 'notes.txt'), 'n'); writeFileSync(join(S, 'a.txt'), 'changed\n');
  assert.deepEqual(await branchStatus(subprocess, S), { branch: 'main', upstream: null, ahead: 0, behind: 0, changes: 2 });
  git(r2.path, 'checkout', '-q', '--detach');
  assert.deepEqual(await branchStatus(subprocess, r2.path), { branch: `(${head(r2.path).slice(0, 7)})`, upstream: null, ahead: 0, behind: 0, changes: 0 }, 'detached');
  const remote = join(base, 'remote.git'); git(base, 'init', '-q', '--bare', remote);
  git(S, 'remote', 'add', 'origin', remote); git(S, 'push', '-q', '-u', 'origin', 'main');
  git(r1.path, 'push', '-q', '-u', 'origin', 'feat/dark-mode-toggle');
  writeFileSync(join(r1.path, 'more.txt'), 'm'); git(r1.path, 'add', 'more.txt'); git(r1.path, 'commit', '-q', '-m', 'more');
  assert.deepEqual(await branchStatus(subprocess, r1.path), { branch: 'feat/dark-mode-toggle', upstream: 'origin/feat/dark-mode-toggle', ahead: 1, behind: 0, changes: 0 });
  const list = await listWorktrees(subprocess, r1.path);
  assert.deepEqual(list[0], { path: S, branch: 'main', main: true, current: false, upstream: 'origin/main', ahead: 0, behind: 0, changes: 2 });
  assert.deepEqual(list.filter((w) => w.current).map((w) => w.path), [r1.path]);
  assert.equal(list.find((w) => w.path === r2.path).branch, `(${head(r2.path).slice(0, 7)})`, 'a detached worktree shows its commit');

  // Route.
  process.env.DSH_HOME = join(base, 'home');
  const routes = new Map();
  const services = { workspaceRegistry: registry };
  apply({ on() {}, effect() {}, get: (name) => services[name], connection: { fetch: { register: (x) => routes.set(x.path, x) } }, sessionQuery, sessionController, subprocess });
  const wt = routes.get(WORKTREES_PATH);
  assert.deepEqual(wt.methods, ['GET', 'POST']);
  const call = async (method, body, query = '') => {
    const response = await wt.fetch(new Request(`http://h${WORKTREES_PATH}${query}`, method === 'GET' ? {} : { method, body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: response.status, data: await response.json() };
  };
  let g = await call('GET', undefined, '?sessionId=main&list=1');
  assert.equal(g.status, 200);
  const { worktrees, ...status } = g.data;
  assert.deepEqual(status, { repo: true, root: S, top: S, worktree: false, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 2 });
  assert.ok(Array.isArray(worktrees) && worktrees.length === 12 && worktrees[0].current && worktrees[0].main);
  assert.deepEqual(Object.keys(worktrees[1]).sort(), ['ahead', 'behind', 'branch', 'changes', 'current', 'main', 'path', 'upstream']);
  g = await call('GET', undefined, '?sessionId=wt');
  assert.deepEqual(g.data, { repo: true, root: S, top: r1.path, worktree: true, branch: 'feat/dark-mode-toggle', upstream: 'origin/feat/dark-mode-toggle', ahead: 1, behind: 0, changes: 0 }, 'no list without list=1');
  assert.deepEqual((await call('GET', undefined, '?sessionId=plain')).data, { repo: false });
  assert.deepEqual((await call('GET', undefined, '?sessionId=none')).data, { repo: false });
  assert.deepEqual((await call('GET', undefined, '')).data, { on: true }, 'no query: the switch');
  assert.equal((await call('GET', undefined, '?list=1')).status, 400);
  assert.equal((await call('GET', undefined, '?sessionId=main&list=2')).status, 400);
  for (const body of ['not json', 'null', '[]', {}, { sessionId: 'main' }, { sessionId: 'main', action: 'start' }, { sessionId: 'main', action: 'start', text: '' },
    { sessionId: 'main', action: 'start', text: '   ' }, { sessionId: 'main', action: 'start', text: 'x'.repeat(100001) }, { sessionId: 'main', action: 'open' },
    { sessionId: 'main', action: 'other', text: 'x' }, { action: 'start', text: 'x' },
    // Attachments are dsh's prompt parts only: no empty message, no other part kinds or keys, no path.
    { sessionId: 'main', action: 'start', text: '', attachments: [] }, { sessionId: 'main', action: 'start', text: 'x', attachments: 'a' },
    { sessionId: 'main', action: 'start', text: 'x', attachments: [{ type: 'text', text: 'x' }] }, { sessionId: 'main', action: 'start', text: 'x', attachments: [{ type: 'file', receiptId: '' }] },
    { sessionId: 'main', action: 'start', text: 'x', attachments: [{ type: 'file', receiptId: 'r', path: '/etc/passwd' }] },
    { sessionId: 'main', action: 'start', text: 'x', attachments: [{ type: 'image', mediaType: 'image/png' }] },
    { sessionId: 'main', action: 'start', text: 'x', attachments: Array.from({ length: 51 }, () => ({ type: 'file', receiptId: 'r' })) }]) {
    assert.equal((await call('POST', body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  for (const path of [join(S, 'node_modules'), base, `${r1.path}/`, '/tmp', 'relative/path']) {
    assert.equal((await call('POST', { sessionId: 'main', action: 'open', path })).status, 403, path);
  }
  const before = made.workspaces.length;
  const o = await call('POST', { sessionId: 'main', action: 'open', path: r5.path });
  assert.equal(o.status, 200); assert.deepEqual(o.data, { workspaceId: `ws-${before + 1}` });
  assert.deepEqual(made.workspaces.at(-1), { path: r5.path, title: 'fix/header-color' });
  const s = await call('POST', { sessionId: 'main', action: 'start', text: 'Add a footer link' });
  assert.equal(s.status, 200); assert.equal(s.data.branch, 'feat/add-a-footer-link', 'no model in dsh: the message slug'); assert.equal(s.data.named, false);
  const img = await call('POST', { sessionId: 'main', action: 'start', text: '', attachments: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] });
  assert.equal(img.status, 200, 'an image without text'); assert.deepEqual(made.prompts.at(-1).content, [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
  assert.equal((await call('POST', { sessionId: 'main', action: 'start', text: 'x', attachments: [{ type: 'file', receiptId: 'r' }] })).status, 409, 'no upload services: a file is refused');
  assert.equal((await call('POST', { sessionId: 'sub', action: 'start', text: 'x' })).status, 409);
  assert.equal((await call('POST', { sessionId: 'empty', action: 'start', text: 'x' })).status, 409);
  services.workspaceRegistry = undefined;
  assert.equal((await call('POST', { sessionId: 'main', action: 'start', text: 'x' })).status, 409, 'a dsh without a workspace registry');
  // The branch of a chat is deleted (its worktree folder goes): at the chat's next step the Host removes the folder's
  // workspace (dsh lists its chats under Ungrouped) and moves the chat to the main folder before dsh's own check of the
  // folder (dsh 0.2.1 ends the turn with "working-directory: directory does not exist" otherwise). Real git; fake dsh.
  {
    const home = join(base, 'home-gone'); process.env.DSH_HOME = home;
    const M = repo(join(base, 'M'), { 'a.txt': 'a\n' });
    const gone = join(M, '.worktrees', 'feat-gone'); git(M, 'worktree', 'add', '-q', '-b', 'feat/gone', gone);
    const kept = join(M, '.worktrees', 'feat-kept'); git(M, 'worktree', 'add', '-q', '-b', 'feat/kept', kept);
    const other = join(base, 'other-wt'); git(M, 'worktree', 'add', '-q', '-b', 'feat/other', other); // not a Branch per chat folder
    const loose = join(base, 'loose', '.worktrees', 'x'); mkdirSync(join(base, 'loose'), { recursive: true }); // no repository around
    // dsh: the workspace registry (list/delete), the working-directory service (get/set), the listeners of `ctx.on`.
    const spaces = [{ id: 'w-main', path: M }, { id: 'w-gone', path: gone }, { id: 'w-kept', path: kept }, { id: 'w-other', path: other }, { id: 'w-loose', path: loose }];
    const deleted = []; let deleteGate = Promise.resolve();
    const registry2 = { list: () => spaces.filter((w) => !deleted.includes(w.id)), delete: async (id) => { await deleteGate; deleted.push(id); return true; } };
    const cwds = new Map(); const sets = [];
    const wd = { get: (session) => cwds.get(session.id) ?? session.header.cwd, set: async (agent, path, signal) => { signal?.throwIfAborted(); sets.push([agent.session.id, path]); cwds.set(agent.session.id, path); return path; } };
    const hooks = [];
    const on = (name, fn, options) => { const entry = { name, fn, options }; hooks.push(entry); return () => { hooks.splice(hooks.indexOf(entry), 1); }; };
    const services2 = { workspaceRegistry: registry2, workingDirectory: wd };
    const routes2 = new Map();
    apply({ on, effect() {}, get: (name) => services2[name], connection: { fetch: { register: (x) => routes2.set(x.path, x) } }, sessionQuery, sessionController, subprocess });
    const wt2 = routes2.get(WORKTREES_PATH);
    const call2 = async (method, body, query = '') => {
      const response = await wt2.fetch(new Request(`http://h${WORKTREES_PATH}${query}`, method === 'GET' ? {} : { method, body: JSON.stringify(body) }));
      return { status: response.status, data: await response.json() };
    };
    assert.deepEqual((await call2('GET')).data, { on: true }, 'on by default (no file)');
    const assembles = () => hooks.filter((h) => h.name === 'system-prompt/assemble');
    assert.equal(assembles().length, 1); assert.equal(assembles()[0].options?.prepend, true, 'before dsh\'s own folder check');
    // dsh's working-directory listener (added earlier, also prepend) runs after ours and fails on a gone folder.
    const step = async (agent, signal) => {
      const dshCheck = async (_a, _c, next) => { if (!existsSync(wd.get(agent.session))) throw new Error(`working-directory: directory does not exist: "${wd.get(agent.session)}"`); return next(); };
      const chain = [...assembles().map((h) => h.fn), dshCheck];
      const run = (i) => (i === chain.length ? Promise.resolve('assembled') : chain[i]({}, { agent, signal }, () => run(i + 1)));
      return run(0);
    };
    const agent = (id, cwd) => ({ session: { id, header: { cwd } } });
    // A folder that is there: nothing changes.
    assert.equal(await step(agent('c-kept', kept)), 'assembled'); assert.deepEqual([deleted, sets], [[], []]);
    // The branch is deleted while two chats of it are open: one move of the workspace, each chat goes on in the main folder.
    git(M, 'worktree', 'remove', gone); git(M, 'branch', '-D', 'feat/gone');
    let release; deleteGate = new Promise((r) => { release = r; });
    const a = step(agent('c-1', gone)); const b = step(agent('c-2', gone));
    await new Promise((r) => setTimeout(r, 300)); release();
    assert.deepEqual(await Promise.all([a, b]), ['assembled', 'assembled'], 'no "directory does not exist" for either chat');
    assert.deepEqual(deleted, ['w-gone'], 'the workspace of the gone folder goes, once (its chats show under Ungrouped)');
    assert.deepEqual(sets.sort(), [['c-1', M], ['c-2', M]], 'each chat goes on in the main folder');
    assert.equal(await step(agent('c-1', gone)), 'assembled'); assert.equal(sets.length, 2, 'once moved, nothing more');
    // dsh 0.2.0 (no working-directory service): the workspace goes; the chat keeps its folder (0.2.0 never checks it).
    delete services2.workingDirectory;
    const gone2 = join(M, '.worktrees', 'feat-gone-2'); git(M, 'worktree', 'add', '-q', '-b', 'feat/gone-2', gone2); spaces.push({ id: 'w-gone-2', path: gone2 });
    git(M, 'worktree', 'remove', gone2);
    let stepped = false;
    await assembles()[0].fn({}, { agent: agent('c-020', gone2) }, async () => { stepped = true; });
    assert.ok(stepped && deleted.includes('w-gone-2'), 'dsh 0.2.0: the workspace goes and the step goes on');
    services2.workingDirectory = wd;
    // Only a gone `<repo>/.worktrees/<name>` of a repository moves: not a folder outside `.worktrees`, not one without a repository.
    git(M, 'worktree', 'remove', other);
    assert.equal(await step(agent('c-other', other)).catch((e) => e.message), `working-directory: directory does not exist: "${other}"`, 'not a Branch per chat folder: dsh decides');
    assert.equal(await step(agent('c-loose', loose)).catch((e) => e.message), `working-directory: directory does not exist: "${loose}"`, 'no repository: dsh decides');
    assert.ok(!deleted.includes('w-other') && !deleted.includes('w-loose'));
    // A step without an agent (a preview of the prompt) is not touched; a failing registry does not stop the step.
    assert.equal(await assembles()[0].fn({}, {}, async () => 'x'), 'x');
    const gone3 = join(M, '.worktrees', 'feat-gone-3'); git(M, 'worktree', 'add', '-q', '-b', 'feat/gone-3', gone3); git(M, 'worktree', 'remove', gone3);
    services2.workspaceRegistry = { list: () => [{ id: 'w-gone-3', path: gone3 }], delete: async () => { throw new Error('disk full'); } };
    assert.equal(await step(agent('c-3', gone3)).catch((e) => e.message), `working-directory: directory does not exist: "${gone3}"`, 'a failed move leaves dsh\'s own answer');
    services2.workspaceRegistry = registry2;
    // The switch: off removes the listener and the route answers no branch and starts nothing; on adds it back. Saved.
    assert.deepEqual((await call2('POST', { on: false })).data, { on: false });
    assert.equal(assembles().length, 0, 'switched off: no listener');
    assert.equal((await call2('GET', undefined, '?sessionId=main')).data.branch, 'main', 'off: the read-only status still answers (the browser hides it)');
    assert.equal((await call2('POST', { sessionId: 'main', action: 'start', text: 'x' })).status, 409, 'off: no new branch');
    assert.equal((await call2('POST', { sessionId: 'main', action: 'open', path: kept })).status, 409, 'off: no worktree opens');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'storages', 'dsh-composer-plus', 'worktrees.json'), 'utf8')), { on: false });
    assert.equal((await call2('POST', { on: 'yes' })).status, 400);
    // A second Host start reads the saved switch: no listener.
    const hooksBefore = hooks.length; const routes3 = new Map();
    apply({ on, effect() {}, get: (name) => services2[name], connection: { fetch: { register: (x) => routes3.set(x.path, x) } }, sessionQuery, sessionController, subprocess });
    assert.deepEqual(await (await routes3.get(WORKTREES_PATH).fetch(new Request(`http://h${WORKTREES_PATH}`))).json(), { on: false });
    assert.equal(hooks.slice(hooksBefore).filter((h) => h.name === 'system-prompt/assemble').length, 0, 'a saved off: no listener after a restart');
    // Two quick changes: the last one wins and there is one listener.
    await Promise.all([call2('POST', { on: true }), call2('POST', { on: false }), call2('POST', { on: true })]);
    assert.equal(assembles().length, 1, 'on again: one listener');
    assert.deepEqual((await call2('GET')).data, { on: true });
    process.env.DSH_HOME = join(base, 'home');
  }
  // Review P3: an upstream that was deleted on the remote (and pruned) is not pushed any more.
  git(r1.path, 'push', '-q', 'origin', '--delete', 'feat/dark-mode-toggle'); git(r1.path, 'fetch', '-q', '--prune');
  assert.equal((await branchStatus(subprocess, r1.path)).upstream, null, 'a gone upstream counts as not pushed');
  console.log('worktree-chats ok');
} finally {
  try { chmodSync(join(base, 'outside', 'secret.txt'), 0o600); } catch { /* not made */ }
  rmSync(base, { recursive: true, force: true });
}
