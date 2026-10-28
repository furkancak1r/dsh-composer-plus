// Backup core (backup.mjs): the archive (system tar reads it; cache/, dsh-runtimes/ and node_modules stay out; symlinks are
// kept as links and never followed; FIFOs are skipped without a hang; masked files go to the vault), the archive check
// (unsafe names, two top folders, an entry below a symlink, devices, a damaged gzip, a wrong checksum), restore (the old
// home stays aside, the never-archived folders move over, masked files come back from the vault, dsh-backup archives
// with AppleDouble entries and the shared vault), one action at a time, session log check and repair, the rescue
// console. Real files under a temporary folder.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync, openSync, closeSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as zlib from 'node:zlib';
import * as b from '../backup.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-backup-')));
const posix = process.platform !== 'win32';
const write = (path, text, mode) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text, mode === undefined ? {} : { mode }); };
/** A FIFO that a hanging open would wait on: after `ms` the test opens it for writing, so a red run ends. */
function fifo(path, ms = 3000) {
  execFileSync('mkfifo', [path]);
  const timer = setTimeout(() => { try { closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* no reader: nothing hangs */ } }, ms);
  timer.unref();
  return timer;
}
const gz = (blocks) => zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
const tarFile = (name, body) => { const data = Buffer.from(body); return [b.tarHeader({ name, type: '0', size: data.length, mode: 0o644 }), data, Buffer.alloc((512 - (data.length % 512)) % 512)]; };
const tarDir = (name) => [b.tarHeader({ name, type: '5', mode: 0o755 })];
/** Writes `dsh-<stamp>.tar.gz` (+ .sha256) from tar blocks into `dest`; answers its name. */
let fake = 0;
function archive(dest, blocks, { sum = true } = {}) {
  mkdirSync(dest, { recursive: true });
  const name = `dsh-20260101-0000${String(fake++).padStart(5, '0')}.tar.gz`;
  const data = gz(blocks);
  writeFileSync(join(dest, name), data);
  if (sum) writeFileSync(join(dest, `${name}.sha256`), `${execFileSync('shasum', ['-a', '256', join(dest, name)]).toString().split(' ')[0]}  x\n`);
  return name;
}

// Masking: the value of a secret key goes; a token count, a variable name, a tag, an empty value and a map stay.
{
  for (const k of ['token', 'MY_TOKEN', 'PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'apiKey', 'api_key', 'clientSecret', 'password', 'Authorization', 'accessKey', 'githubToken']) assert.ok(b.secretKey(k), k);
  for (const k of ['maxTokens', 'apiKeyEnv', 'tokenLimit', 'key', 'secrets', 'name', 'passwordFile']) assert.ok(!b.secretKey(k), k);
  const yaml = ['a:', '  env:', '    GITHUB_TOKEN: ghp_x1', '    "apiKey": \'sk-2\'', '    maxTokens: 5', '    apiKeyEnv: OPENAI_KEY', '    token: !!js process.env.T',
    '    password: ""', '    secret:', '      nested: kept', '    - token: listed', '    privateKey: |', '      -----BEGIN-----', '      abc', '    after: kept', '# DEMO_API_TOKEN: commented-out', '    # note: kept'].join('\n');
  const { text, changed } = b.maskYaml(yaml);
  assert.equal(changed, 5);
  for (const leak of ['ghp_x1', 'sk-2', 'listed', 'BEGIN', 'abc', 'commented-out']) assert.ok(!text.includes(leak), leak);
  assert.ok(text.includes(`# DEMO_API_TOKEN: ${b.MASK}`) && text.includes('    # note: kept'), 'a commented-out secret is masked, the comment stays');
  for (const kept of ['maxTokens: 5', 'apiKeyEnv: OPENAI_KEY', 'token: !!js process.env.T', 'password: ""', 'nested: kept', 'after: kept']) assert.ok(text.includes(kept), kept);
  assert.ok(b.wholeSecret('.credentials.yaml') && b.wholeSecret('mobile-access/tls/server-key.pem') && b.wholeSecret('x/.env.local') && !b.wholeSecret('a/keys.json'));
}

// Backup: the archive, what stays out, symlinks as links, a FIFO skipped, masked files in the vault, 0600 files.
const home = join(root, 'home', '.dsh');
const dest = join(root, 'dest');
const outside = join(root, 'outside');
write(join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
write(join(home, 'sessions', 'note.txt'), 'hello');
write(join(home, '.credentials.yaml'), 'version: 1\nkey: CRED-VALUE\n');
write(join(home, 'mobile-access', 'tls', 'server-key.pem'), 'PEM-VALUE');
write(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'x:\n  env:\n    MY_TOKEN: TOKEN-VALUE\n    maxTokens: 9\n');
write(join(home, 'profiles', 'web', 'package.json'), '{"name":"p"}');
write(join(home, 'profiles', 'web', 'pnpm-lock.yaml'), 'lock: 1\n');
write(join(home, 'profiles', 'web', 'node_modules', 'pkg', 'index.js'), 'module');
write(join(home, 'cache', 'big.db'), 'CACHE');
write(join(home, 'dsh-runtimes', 'r', 'node'), 'RUNTIME');
write(join(home, 'skills', 'local', 'SKILL.md'), '# skill');
write(join(home, 'storages', 'ğüş çay', `${'long-name-'.repeat(12)}.json`), '{"tr":"çay"}');
write(join(home, 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 7, 7));
symlinkSync(join(outside, 'secret.txt'), join(home, 'skills', 'outside-link'));
symlinkSync('local', join(home, 'skills', 'inside-link'));
symlinkSync(join(outside, 'secret.txt'), join(home, '.env'));
if (posix) linkSync(join(home, 'sessions', 'note.txt'), join(home, 'sessions', 'note-link.txt'));
const timer = posix ? fifo(join(home, 'storages', 'pipe')) : undefined;
const first = await b.backup({ home, dest, now: new Date(2026, 9, 28, 10, 0, 0, 1) });
clearTimeout(timer);
assert.equal(first.name, 'dsh-20261028-100000001.tar.gz');
assert.deepEqual(first.masked.sort(), ['.credentials.yaml', 'mobile-access/tls/server-key.pem', 'profiles/web/cordis.patch.yml']);
if (posix) assert.deepEqual(first.skipped, ['storages/pipe'], 'the FIFO is skipped');
// macOS file names are NFD; compare in NFC.
const listing = execFileSync('tar', ['-tzf', join(dest, first.name)]).toString().normalize('NFC').trim().split('\n');
assert.ok(listing.includes('.dsh/sessions/note.txt') && listing.includes('.dsh/big.bin'), 'system tar reads the archive');
assert.ok(listing.some((l) => l.includes('ğüş çay/long-name-')), 'a long non-ASCII name (pax)');
for (const out of ['.dsh/cache/', '.dsh/dsh-runtimes/', '.dsh/profiles/web/node_modules/', '.dsh/.credentials.yaml', '.dsh/mobile-access/tls/server-key.pem']) assert.ok(!listing.some((l) => l.startsWith(out)), out);
const raw = zlib.gunzipSync(readFileSync(join(dest, first.name)));
for (const leak of ['OUTSIDE-SECRET', 'CRED-VALUE', 'PEM-VALUE', 'TOKEN-VALUE', 'CACHE', 'RUNTIME']) assert.ok(!raw.includes(leak), `${leak} is not in the archive`);
assert.ok(raw.includes('maxTokens: 9'), 'the rest of the yml stays');
const verbose = execFileSync('tar', ['-tvzf', join(dest, first.name)]).toString();
assert.match(verbose, /\.dsh\/skills\/outside-link -> .*outside\/secret\.txt/, 'a symlink is kept as a link');
assert.match(verbose, /\.dsh\/\.env -> /, 'a symlinked .env is a link, its target is not read');
assert.equal(readFileSync(join(dest, b.VAULT, first.name, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').includes('TOKEN-VALUE'), true, 'the real yml is in the vault');
if (posix) {
  for (const f of [first.name, `${first.name}.sha256`, `${first.name}.meta.json`, `${first.name}.redacted.json`]) assert.equal(statSync(join(dest, f)).mode & 0o777, 0o600, f);
  assert.equal(statSync(join(dest, b.VAULT, first.name, '.credentials.yaml')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dest, b.VAULT)).mode & 0o777, 0o700);
}
const sha = readFileSync(join(dest, `${first.name}.sha256`), 'utf8').split(' ')[0];
assert.equal(sha, execFileSync('shasum', ['-a', '256', join(dest, first.name)]).toString().split(' ')[0], 'the checksum file matches');

// List, check, keep count.
{
  const list = await b.listArchives(dest);
  assert.deepEqual(list.map((a) => [a.name, a.kind, a.checksum]), [[first.name, 'backup', true]]);
  assert.equal(list[0].meta.by, b.BY);
  const v = await b.verifyArchive(dest, first.name, { home });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.symlinks, 3);
  assert.equal(v.hardlinks, posix ? 1 : 0);
  assert.deepEqual(v.masked.map((m) => m.vault), [true, true, true]);
  writeFileSync(join(dest, 'dsh-t-20260101-000000000.tar.gz'), 'typed'); writeFileSync(join(dest, 'notes.txt'), 'x');
  assert.equal((await b.listArchives(dest)).length, 1, 'typed archives and other files are not listed');
  const keepDest = join(root, 'keep');
  // An archive that Composer Plus did not make (dsh-backup's: no `by` in its meta) is never removed by the keep count.
  archive(keepDest, [...tarDir('.dsh/'), ...tarFile('.dsh/a', 'x')]);
  const foreign = (await b.listArchives(keepDest))[0].name;
  for (let i = 0; i < 3; i++) await b.backup({ home: join(home, 'skills'), dest: keepDest, keep: 2, now: new Date(2026, 1, 1, 0, 0, i) });
  await b.backup({ home: join(home, 'skills'), dest: keepDest, kind: 'pre-upgrade', keep: 2, now: new Date(2026, 1, 2) });
  assert.deepEqual((await b.listArchives(keepDest)).map((a) => a.name), ['dsh-pre-upgrade-20260202-000000000.tar.gz', 'dsh-20260201-000002000.tar.gz', 'dsh-20260201-000001000.tar.gz', foreign]);
  assert.equal(existsSync(join(keepDest, b.VAULT, 'dsh-20260201-000000000.tar.gz')), false);
  // Without `keep` (a click), nothing is removed.
  const r = await b.backup({ home: join(home, 'skills'), dest: keepDest, now: new Date(2026, 1, 3) });
  assert.deepEqual(r.rotated, []);
  assert.equal((await b.listArchives(keepDest)).length, 5);
}

// The archive check refuses what a restore must not write; a damaged archive and a wrong checksum are not usable.
{
  const bad = join(root, 'bad');
  const refused = async (blocks, re) => {
    const name = archive(bad, blocks);
    const v = await b.verifyArchive(bad, name, {});
    assert.equal(v.ok, false, String(re)); assert.match(v.reason, re);
  };
  await refused([...tarDir('.dsh/'), ...tarFile('.dsh/../evil', 'x')], /unsafe entry/);
  await refused([...tarFile('/etc/evil', 'x')], /unsafe entry/);
  await refused([...tarFile('.dsh/a', 'x'), ...tarFile('other/b', 'x')], /more than one top folder/);
  await refused([...tarDir('.dsh/'), b.tarHeader({ name: '.dsh/link', type: '2', linkname: '/etc' }), ...tarFile('.dsh/link/passwd', 'x')], /below a symbolic link/);
  await refused([...tarDir('.dsh/'), b.tarHeader({ name: '.dsh/fifo', type: '6' })], /type that a restore does not write/);
  await refused([...tarDir('.dsh/'), b.tarHeader({ name: '.dsh/h', type: '1', linkname: '.dsh/missing' })], /hard link/);
  await refused([...tarFile('.dsh/a', 'x'), ...tarFile('.dsh/a', 'y')], /two entries/);
  const good = archive(bad, [...tarDir('.dsh/'), ...tarFile('.dsh/a', 'x'.repeat(5000))]);
  const data = readFileSync(join(bad, good));
  writeFileSync(join(bad, good), data.subarray(0, data.length - 30));
  assert.match((await b.verifyArchive(bad, good, {})).reason, /damaged|cut off/);
  const other = archive(bad, [...tarDir('.dsh/'), ...tarFile('.dsh/a', 'x')]);
  writeFileSync(join(bad, `${other}.sha256`), `${'0'.repeat(64)}  x\n`);
  assert.match((await b.verifyArchive(bad, other, {})).reason, /checksum does not match/);
  assert.equal((await b.verifyArchive(bad, 'dsh-20990101-000000000.tar.gz', {})).ok, false);
  await assert.rejects(b.removeArchive(bad, '../x'), /not a backup archive name/);
}

// Restore: the old home stays aside, never-archived folders move over, masked files come back, links stay links.
{
  write(join(home, 'sessions', 'note.txt'), 'changed after the backup');
  write(join(home, 'new-file.txt'), 'new');
  const done = await b.restore({ home, dest, name: first.name });
  assert.equal(done.home, home);
  assert.ok(done.aside.startsWith(`${home}.pre-restore-`) && existsSync(join(done.aside, 'new-file.txt')), 'the old home stays aside');
  assert.equal(readFileSync(join(home, 'sessions', 'note.txt'), 'utf8'), 'hello');
  assert.equal(existsSync(join(home, 'new-file.txt')), false);
  assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8'), 'version: 1\nkey: CRED-VALUE\n', 'credentials come back from the vault');
  assert.ok(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').includes('TOKEN-VALUE'), 'the real yml comes back');
  assert.equal(readFileSync(join(home, 'mobile-access', 'tls', 'server-key.pem'), 'utf8'), 'PEM-VALUE');
  assert.deepEqual(done.moved.sort(), ['cache', 'dsh-runtimes', 'profiles/web/node_modules']);
  assert.equal(readFileSync(join(home, 'cache', 'big.db'), 'utf8'), 'CACHE');
  assert.ok(lstatSync(join(home, 'skills', 'outside-link')).isSymbolicLink() && readlinkSync(join(home, 'skills', 'outside-link')) === join(outside, 'secret.txt'));
  assert.ok(lstatSync(join(home, '.env')).isSymbolicLink(), 'the .env link is a link again');
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE-SECRET', 'a link target is never written');
  assert.equal(readFileSync(join(home, 'big.bin')).length, 3 * 1024 * 1024 + 7);
  assert.equal(readFileSync(join(home, 'storages', 'ğüş çay', `${'long-name-'.repeat(12)}.json`), 'utf8'), '{"tr":"çay"}');
  if (posix) assert.equal(statSync(join(home, 'sessions', 'note-link.txt')).ino, statSync(join(home, 'sessions', 'note.txt')).ino, 'the hard link is a hard link');
  assert.deepEqual(done.install, [], 'node_modules moved over and the lock file is the same');
  assert.equal(existsSync(join(home, 'skills', 'inside-link', 'node_modules')), false);
  assert.deepEqual(done.vaultMissing, []);
  assert.equal(readdirSync(join(root, 'home')).filter((n) => n.includes('.restore-')).length, 0, 'no staging folder stays');
}
// A carried folder (node_modules) whose parent is a symbolic link in the archive is not moved through the link.
{
  const linkHome = join(root, 'link-home', '.dsh');
  const linkDest = join(root, 'link-dest');
  const target = join(root, 'link-target');
  write(join(target, 'keep.txt'), 'outside');
  write(join(linkHome, 'plugins', 'a', 'node_modules', 'x', 'i.js'), 'pkg');
  write(join(target, 'a', 'keep.txt'), 'outside');
  const arch = archive(linkDest, [...tarDir('.dsh/'), b.tarHeader({ name: '.dsh/plugins', type: '2', linkname: target })]);
  const done = await b.restore({ home: linkHome, dest: linkDest, name: arch });
  assert.deepEqual(done.moved, []);
  assert.deepEqual(readdirSync(join(target, 'a')), ['keep.txt'], 'nothing moved into the link target');
  assert.ok(existsSync(join(done.aside, 'plugins', 'a', 'node_modules', 'x', 'i.js')), 'it stays in the old home');
}
// A restore of a damaged archive changes nothing. A missing vault copy is reported. A home that does not exist is made.
{
  const bad = join(root, 'bad');
  const before = readdirSync(join(root, 'home')).sort();
  const name = (await b.listArchives(bad)).find((a) => a.size > 0).name;
  await assert.rejects(b.restore({ home, dest: bad, name }), b.ArchiveError);
  assert.deepEqual(readdirSync(join(root, 'home')).sort(), before, 'nothing changed');
  const moved = join(root, 'dest-copy');
  mkdirSync(moved);
  for (const f of readdirSync(dest)) if (f.startsWith(first.name)) writeFileSync(join(moved, f), readFileSync(join(dest, f)));
  const fresh = join(root, 'fresh', 'dsh-home');
  const done = await b.restore({ home: fresh, dest: moved, name: first.name });
  assert.equal(done.aside, undefined);
  assert.deepEqual(done.vaultMissing.sort(), ['.credentials.yaml', 'mobile-access/tls/server-key.pem', 'profiles/web/cordis.patch.yml'], 'a new computer has no vault');
  assert.ok(readFileSync(join(fresh, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').includes('[masked by Composer Plus]'), 'the masked yml stays masked');
  assert.deepEqual(done.install, ['web'], 'a profile without node_modules is installed again');
  assert.equal(done.otherHome, true);
}

// A dsh-backup archive (macOS tar with AppleDouble `._` entries, one shared vault mirror) checks and restores.
{
  const dshb = join(root, 'dshb');
  const src = join(root, 'dshb-src', '.dsh');
  write(join(src, 'settings.json'), '{"a":1}');
  write(join(src, '._real'), 'not apple double: kept');
  mkdirSync(dshb, { recursive: true });
  const apple = Buffer.alloc(64); apple.writeUInt32BE(0x00051607, 0);
  const name = archive(dshb, [...tarFile('._.dsh', apple), ...tarDir('.dsh/'), ...tarFile('.dsh/._settings.json', apple), ...tarFile('.dsh/settings.json', '{"a":1}'), ...tarFile('.dsh/._real', 'not apple double: kept')]);
  writeFileSync(join(dshb, `${name}.redacted.json`), '{"files":[".credentials.yaml"]}');
  writeFileSync(join(dshb, `${name}.meta.json`), '{"host":"old","home":"/h","dshHome":"/h/.dsh"}');
  write(join(dshb, 'vault', '.credentials.yaml'), 'version: 1\nshared: mirror\n');
  const v = await b.verifyArchive(dshb, name, {});
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.files, 2, 'AppleDouble entries are skipped');
  const target = join(root, 'dshb-home', '.dsh');
  const done = await b.restore({ home: target, dest: dshb, name });
  assert.deepEqual(readdirSync(target).sort(), ['._real', '.credentials.yaml', 'settings.json']);
  assert.equal(readFileSync(join(target, '.credentials.yaml'), 'utf8'), 'version: 1\nshared: mirror\n', 'dsh-backup\'s shared vault');
  assert.deepEqual(done.vaultMissing, []);
}

// One action at a time: a second lock is refused; a lock of a process that is gone is taken over.
{
  const lockDest = join(root, 'lock');
  const release = await b.takeLock(lockDest, 'backup');
  await assert.rejects(b.takeLock(lockDest, 'restore'), (e) => e instanceof b.BusyError && e.held.op === 'backup');
  await release();
  writeFileSync(join(lockDest, b.LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 12345, op: 'old' }));
  const again = await b.takeLock(lockDest, 'check');
  await again();
  assert.equal(existsSync(join(lockDest, b.LOCK_FILE)), false);
}

// Session logs: healthy, torn tail, bad seq, two lines in the header frame, garbage; repair from the newest healthy copy.
{
  const logHome = join(root, 'logs', '.dsh');
  const header = (id) => `${JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`;
  const row = (seq, type = 'turn/start') => `${JSON.stringify({ type, seq, time: 1, data: {} })}\n`;
  const frames = (...texts) => Buffer.concat(texts.map((t) => zlib.zstdCompressSync(Buffer.from(t))));
  const log = (id, data) => write(join(logHome, 'sessions', '--p--', id, 'session.v4.jsonl.zstd'), data);
  const good = (id) => frames(header(id), row(0) + row(1), row(2));
  log('ok', good('ok'));
  const torn = good('torn'); log('torn', Buffer.concat([torn, frames(row(3)).subarray(0, 9)]));
  // A wrong seq with a turn/end after it: dsh does not open it. The same without a turn/end after it: dsh opens the rows
  // before it (not damage, like a torn tail).
  log('seq', frames(header('seq'), row(0) + row(2) + row(3, 'turn/end')));
  log('dropped', frames(header('dropped'), row(0) + 'garbage\n' + row(2)));
  log('two', frames(header('two') + row(0)));
  log('junk', Buffer.from('not zstd at all'));
  write(join(logHome, 'sessions', '--p--', 'plain', 'session.jsonl'), header('plain') + row(0).replace('"seq":0', '"seq":9') + row(1, 'turn/end'));
  assert.deepEqual(b.zstdFrames(Buffer.concat([torn, Buffer.from([0x28, 0xb5])])).frames.length, 3);
  const scan = await b.scanSessions(logHome);
  assert.equal(scan.scanned, 7);
  assert.equal(scan.torn, 2, 'a torn tail and a bad last row without a turn/end after it are not damage');
  assert.equal((await b.checkLog(frames(header('x'), row(0) + 'garbage\n'), true)).state, 'torn');
  assert.equal((await b.checkLog(frames(header('x'), row(0) + 'garbage\n' + row(2, 'turn/end')), true)).state, 'bad');
  assert.deepEqual(scan.bad.map((x) => [x.id, x.reason.split(' ')[0]]).sort(), [['junk', 'no'], ['plain', 'line'], ['seq', 'line'], ['two', 'the']], 'an uncompressed log is checked too');
  // The backup has a healthy copy of `seq` (written before it broke) and none of `junk`.
  const logDest = join(root, 'logs-dest');
  log('seq', good('seq'));
  await b.backup({ home: logHome, dest: logDest, now: new Date(2026, 0, 1) });
  log('seq', frames(header('seq'), row(0) + row(2) + row(3, 'turn/end')));
  const again = await b.scanSessions(logHome);
  const r = await b.repairSessions({ home: logHome, dest: logDest, bad: again.bad, live: (id) => id === 'two' });
  assert.deepEqual(r.fixed.map((f) => f.id), ['seq']);
  assert.deepEqual(r.busy.map((f) => f.id), ['two'], 'an open chat is left alone');
  assert.deepEqual(r.missing.map((f) => f.id).sort(), ['junk', 'plain']);
  assert.ok(readdirSync(join(logHome, 'sessions', '--p--', 'seq')).some((n) => n.startsWith('session.v4.jsonl.zstd.corrupt-')), 'the damaged copy stays');
  assert.deepEqual((await b.scanSessions(logHome)).bad.map((x) => x.id).sort(), ['junk', 'plain', 'two']);
  // A chat folder that became a symbolic link to a folder outside the dsh home: the repair writes nothing there.
  const outsideLogs = join(root, 'outside-logs');
  write(join(outsideLogs, 'session.v4.jsonl.zstd'), 'outside damaged');
  rmSync(join(logHome, 'sessions', '--p--', 'seq'), { recursive: true });
  symlinkSync(outsideLogs, join(logHome, 'sessions', '--p--', 'seq'));
  const linked = await b.repairSessions({ home: logHome, dest: logDest, bad: [{ rel: 'sessions/--p--/seq/session.v4.jsonl.zstd', id: 'seq' }] });
  assert.deepEqual([linked.fixed, linked.missing.map((m) => m.id)], [[], ['seq']]);
  assert.deepEqual(readdirSync(outsideLogs), ['session.v4.jsonl.zstd'], 'nothing written through the link');
  assert.equal(readFileSync(join(outsideLogs, 'session.v4.jsonl.zstd'), 'utf8'), 'outside damaged');
}

// The rescue console files, and the console itself: list, check, a restore refused while dsh runs, then a restore.
{
  const consoleDest = join(root, 'console');
  mkdirSync(consoleDest);
  const files = await b.writeRescue(consoleDest, 'darwin');
  assert.deepEqual(files, [b.RESCUE_FILE, b.LAUNCHERS.darwin]);
  assert.equal(readFileSync(join(consoleDest, b.RESCUE_FILE), 'utf8'), readFileSync(new URL('../backup.mjs', import.meta.url), 'utf8'));
  if (posix) assert.equal(statSync(join(consoleDest, b.LAUNCHERS.darwin)).mode & 0o111, 0o111, 'the launcher can run');
  assert.ok(readFileSync(join(consoleDest, b.LAUNCHERS.darwin), 'utf8').includes('ELECTRON_RUN_AS_NODE=1'), 'falls back to the DeepSeek Harness app as Node.js');
  await b.removeRescue(consoleDest, 'darwin');
  assert.deepEqual(readdirSync(consoleDest), []);

  const run = async (answers, folder, dshHome) => {
    const input = new PassThrough(); const output = new PassThrough(); let text = '';
    output.on('data', (c) => { text += c; });
    input.end(`${answers.join('\n')}\n`);
    await b.rescueConsole({ folder, home: dshHome, input, output });
    return text;
  };
  const listed = await run(['1', '2', '1', '0'], dest, home);
  assert.match(listed, /dsh-20261028-100000001\.tar\.gz {2}3 masked/);
  assert.match(listed, /OK: \d+ entries/);
  const sleeper = spawn('sleep', ['30']);
  write(b.hostFile(home, sleeper.pid), JSON.stringify({ pid: sleeper.pid }));
  write(b.hostFile(home, 2 ** 22 + 4321), '{}'); // a marker of a process that is gone is ignored
  const refused = await run(['3', '0'], dest, home);
  assert.match(refused, new RegExp(`dsh is running \\(process ${sleeper.pid}\\)`));
  sleeper.kill();
  await new Promise((r) => sleeper.once('exit', r));
  write(join(home, 'after.txt'), 'x');
  const cancelled = await run(['3', '1', 'no', '0'], dest, home);
  assert.match(cancelled, /Cancelled\. Nothing changed\./);
  assert.ok(existsSync(join(home, 'after.txt')));
  const restored = await run(['3', '1', 'RESTORE', '0'], dest, home);
  assert.match(restored, /Restored \d+ entries/);
  assert.equal(existsSync(join(home, 'after.txt')), false);
  assert.equal(existsSync(join(dest, b.LOCK_FILE)), false, 'the lock is released');
  const held = await b.takeLock(dest, 'backup');
  assert.match(await run(['2', '1', '0'], dest, home), /another backup action is running \(backup/);
  await held();
}

rmSync(root, { recursive: true, force: true });
console.log('backup checks passed');
