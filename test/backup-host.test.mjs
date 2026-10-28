// Backup (Host half): the routes (state, back up, check, delete, session log check and repair, cancel, one action at a
// time also against the rescue console's lock, bad bodies), the automatic backup (off by default, settings, due time from
// the newest backup, a snapshot when the dsh version changes, a failure waits), the rescue console switch (on by default,
// files written with a backup, off removes them) and the running-dsh marker. Real files under a temporary folder.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { AUTO_BACKUP_PATH, BACKUP_PATH, RESCUE_PATH, apply, installBackup, parseAutoBackup } from '../index.js';
import * as b from '../backup.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-backup-host-')));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await tick(10); } };
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

function boot({ home, folder, version, graceMs = 0, retryMs = 1000, agents = new Map() }) {
  const routes = new Map(); const effects = [];
  const ctx = { get: (n) => (n === 'agents' ? agents : undefined), effect: (f) => { effects.push(f()); }, logger: { warn() {} },
    connection: { fetch: { register: (r) => routes.set(r.path, r) } }, subprocess: {} };
  const host = installBackup(ctx, home, { graceMs, retryMs, folder, version });
  const call = async (path, body) => {
    const response = await routes.get(path).fetch(new Request(`http://h${path}`, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: response.status, data: await response.json() };
  };
  return { call, host, routes, unload: () => effects.forEach((f) => f?.()) };
}

// The real apply() registers the three routes.
{
  process.env.DSH_HOME = join(root, 'apply-home');
  process.env.COMPOSER_PLUS_BACKUP_DIR = join(root, 'apply-dest');
  const routes = new Map();
  apply({ on() {}, effect() {}, get: () => undefined, connection: { fetch: { register: (x) => routes.set(x.path, x) } }, subprocess: {}, sessionQuery: {}, sessionController: {} });
  assert.deepEqual([BACKUP_PATH, AUTO_BACKUP_PATH, RESCUE_PATH].map((p) => routes.get(p)?.methods), [['GET', 'POST'], ['GET', 'POST'], ['GET', 'POST']]);
}

const home = join(root, 'home', '.dsh');
const folder = join(root, 'dsh-backups');
write(join(home, 'sessions', '--p--', 's1', 'note.txt'), 'hello');
write(join(home, '.credentials.yaml'), 'key: SECRET\n');

// Settings parse: off by default, 24 hours, 7 kept; only listed values.
assert.deepEqual(parseAutoBackup(undefined), { on: false, hours: 24, keep: 7 });
assert.deepEqual(parseAutoBackup({ on: 'yes', hours: 5, keep: 100, version: '0.2.1' }), { on: false, hours: 24, keep: 7, version: '0.2.1' });

{
  const app = boot({ home, folder, version: '0.2.1-rc.2' });
  // The marker that tells the rescue console that dsh runs.
  await until(() => existsSync(b.hostFile(home)), 'host marker');
  assert.equal(JSON.parse(readFileSync(b.hostFile(home), 'utf8')).pid, process.pid);
  assert.equal(await b.runningDsh(home), undefined, 'this process does not count as another dsh');
  // Two dsh processes on one home: each has its own marker; one that quits leaves the other's.
  const { spawn } = await import('node:child_process');
  const other = spawn('sleep', ['30']);
  write(b.hostFile(home, other.pid), JSON.stringify({ pid: other.pid }));
  assert.equal(await b.runningDsh(home), other.pid);

  let r = await app.call(BACKUP_PATH);
  assert.deepEqual([r.status, r.data.folder, r.data.archives, r.data.busy], [200, folder, [], null]);
  for (const bad of ['{', { action: 'x' }, { action: 'verify', name: '../x' }, { action: 'backup', kind: 'pre-upgrade' }, { action: 'delete', name: 'dsh-1.tar.gz' }]) {
    assert.equal((await app.call(BACKUP_PATH, bad)).status, 400, JSON.stringify(bad));
  }
  // Back up: answers at once with busy; a second action while it runs is refused (409) at every entry.
  r = await app.call(BACKUP_PATH, { action: 'backup' });
  assert.equal(r.status, 200); assert.equal(r.data.busy.op, 'backup');
  for (const body of [{ action: 'backup' }, { action: 'scan' }, { action: 'verify', name: 'dsh-20260101-000000000.tar.gz' }]) {
    const second = await app.call(BACKUP_PATH, body);
    assert.equal(second.status, 409, JSON.stringify(body)); assert.match(second.data.error, /another backup action is running \(backup/);
  }
  await app.host.settled();
  r = await app.call(BACKUP_PATH);
  assert.equal(r.data.archives.length, 1); assert.equal(r.data.busy, null);
  assert.equal(r.data.last.result.rotated, 0, 'a click removes no backup');
  const made = r.data.archives[0];
  assert.deepEqual([made.kind, made.checksum, made.masked, made.ours], ['backup', true, 1, true]);
  assert.equal(r.data.last.ok, true); assert.equal(r.data.last.result.masked, 1);
  assert.equal(existsSync(join(folder, b.LOCK_FILE)), false, 'the lock is released');
  assert.deepEqual(readdirSync(folder).filter((n) => b.rescueFiles().includes(n)).sort(), b.rescueFiles().sort(), 'the rescue console comes with a backup');
  // Check.
  await app.call(BACKUP_PATH, { action: 'verify', name: made.name });
  await app.host.settled();
  r = await app.call(BACKUP_PATH);
  assert.equal(r.data.last.op, 'check'); assert.equal(r.data.last.result.ok, true); assert.equal(r.data.last.name, made.name);
  // The rescue console holds the folder: every action here is refused.
  const held = await b.takeLock(folder, 'restore');
  r = await app.call(BACKUP_PATH, { action: 'backup' });
  assert.equal(r.status, 409); assert.match(r.data.error, /restore/);
  assert.equal((await app.call(BACKUP_PATH)).data.busy, null, 'a refused action leaves no busy state');
  await held();
  // Cancel: the half-written archive goes away.
  write(join(home, 'big.bin'), Buffer.alloc(40 * 1024 * 1024, 1));
  await app.call(BACKUP_PATH, { action: 'backup' });
  await app.call(BACKUP_PATH, { action: 'cancel' });
  await app.host.settled();
  r = await app.call(BACKUP_PATH);
  assert.equal(r.data.last.ok, false); assert.equal(r.data.last.error, 'cancelled');
  assert.equal(r.data.archives.length, 1, 'no new archive');
  assert.deepEqual(readdirSync(folder).filter((n) => n.startsWith('dsh-') && n !== made.name && !n.startsWith(`${made.name}.`)), [], 'no file of the cancelled backup stays');
  rmSync(join(home, 'big.bin'));
  // Session logs: check, then repair from the backup; an open chat is left alone.
  const log = (id, data) => write(join(home, 'sessions', '--p--', id, 'session.v4.jsonl.zstd'), data);
  const header = (id) => `${JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`;
  const good = (id) => Buffer.concat([zlib.zstdCompressSync(Buffer.from(header(id))), zlib.zstdCompressSync(Buffer.from('{"type":"x","seq":0}\n'))]);
  log('fixme', good('fixme')); log('open', good('open'));
  await app.call(BACKUP_PATH, { action: 'backup' }); await app.host.settled();
  log('fixme', Buffer.from('broken')); log('open', Buffer.from('broken'));
  await app.call(BACKUP_PATH, { action: 'scan' }); await app.host.settled();
  r = await app.call(BACKUP_PATH);
  assert.deepEqual(r.data.scan.bad.map((x) => x.id).sort(), ['fixme', 'open']);
  const agents = new Map([['open', {}]]);
  const app2 = boot({ home, folder, agents });
  await app2.call(BACKUP_PATH, { action: 'repair' }); await app2.host.settled();
  r = await app2.call(BACKUP_PATH);
  assert.deepEqual(r.data.last.result, { fixed: [{ id: 'fixme', from: r.data.archives[0].name }], missing: [], open: ['open'] });
  assert.deepEqual(r.data.scan.bad.map((x) => [x.id, x.open]), [['open', true]]);
  app2.unload();
  // Prepare for another computer: a new folder with the archive, its sidecars and the console; no vault.
  r = await app.call(BACKUP_PATH, { action: 'transfer', name: made.name });
  assert.equal(r.status, 200); assert.equal(r.data.last.op, 'transfer');
  const moveDir = r.data.last.result.folder;
  assert.ok(moveDir.startsWith(join(folder, 'transfer-')));
  assert.deepEqual(readdirSync(moveDir).sort(), [made.name, ...['.meta.json', '.redacted.json', '.sha256'].map((x) => `${made.name}${x}`), ...b.rescueFiles()].sort());
  assert.equal((await b.verifyArchive(moveDir, made.name, {})).ok, true);
  assert.equal((await app.call(BACKUP_PATH, { action: 'transfer', name: 'dsh-20990101-000000000.tar.gz' })).status, 500);
  // Delete removes the archive, its sidecars and its vault copies.
  const del = r.data.archives.at(-1).name;
  r = await app.call(BACKUP_PATH, { action: 'delete', name: del });
  assert.equal(r.status, 200); assert.ok(!r.data.archives.some((a) => a.name === del));
  assert.ok(!readdirSync(folder).some((n) => n.startsWith(del)) && !existsSync(join(folder, b.VAULT, del)));
  // Rescue console switch: on by default; off removes the files; on writes them again.
  r = await app.call(RESCUE_PATH);
  assert.equal(r.data.on, true); assert.deepEqual(r.data.files.sort(), b.rescueFiles().sort());
  r = await app.call(RESCUE_PATH, { on: false });
  assert.deepEqual([r.data.on, r.data.files], [false, []]);
  assert.equal(statSync(join(home, 'storages', 'dsh-composer-plus', 'rescue-console.json')).mode & 0o777, 0o600);
  await app.call(BACKUP_PATH, { action: 'backup' }); await app.host.settled();
  assert.deepEqual((await app.call(RESCUE_PATH)).data.files, [], 'switched off: a backup writes no console');
  r = await app.call(RESCUE_PATH, { on: true });
  assert.deepEqual(r.data.files.sort(), b.rescueFiles().sort());
  assert.equal((await app.call(RESCUE_PATH, { on: true, x: 1 })).status, 400);
  // Automatic backup settings.
  r = await app.call(AUTO_BACKUP_PATH);
  assert.deepEqual([r.data.on, r.data.hours, r.data.keep, r.data.next], [false, 24, 7, undefined]);
  for (const bad of [{ on: 1 }, { hours: 5 }, { keep: 0 }, { on: true, hours: 6 }, { version: 'x' }]) assert.equal((await app.call(AUTO_BACKUP_PATH, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await app.call(AUTO_BACKUP_PATH, { hours: 12 })).data.hours, 12);
  assert.equal((await app.call(AUTO_BACKUP_PATH, { keep: 3 })).data.keep, 3);
  r = await app.call(AUTO_BACKUP_PATH, { on: true });
  assert.equal(r.data.on, true);
  const due = Date.parse(r.data.next) - Date.parse((await app.call(BACKUP_PATH)).data.archives[0].at);
  assert.ok(Math.abs(due - 12 * 3600000) < 2000, 'due 12 hours after the newest backup');
  assert.equal(statSync(join(home, 'storages', 'dsh-composer-plus', 'auto-backup.json')).mode & 0o777, 0o600);
  // Show folder: a missing tool or folder is not "another action is running" (422, not 409).
  assert.equal((await app.call(BACKUP_PATH, { action: 'reveal' })).status, 422);
  app.unload();
  assert.equal(existsSync(b.hostFile(home)), false, 'unload removes the marker');
  assert.equal(await b.runningDsh(home), other.pid, 'the other dsh still counts');
  other.kill(); await new Promise((r) => other.once('exit', r));
  assert.equal(await b.runningDsh(home), undefined);
}

// Automatic backup at start: due at once (no backup yet) after the grace time; keep count; a dsh version change takes a
// snapshot first; a failure is shown and waits.
{
  const autoHome = join(root, 'auto', '.dsh');
  const autoFolder = join(root, 'auto-backups');
  write(join(autoHome, 'a.txt'), 'a');
  write(join(autoHome, 'storages', 'dsh-composer-plus', 'auto-backup.json'), JSON.stringify({ on: true, hours: 6, keep: 3, version: '0.2.0' }));
  const app = boot({ home: autoHome, folder: autoFolder, version: '0.2.1', graceMs: 30 });
  await until(async () => (await b.listArchives(autoFolder)).filter((a) => a.kind === 'backup').length === 1, 'the automatic backup');
  await app.host.settled();
  const kinds = (await b.listArchives(autoFolder)).map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['backup', 'pre-upgrade'], 'a snapshot when the dsh version changed, then the backup');
  assert.equal(JSON.parse(readFileSync(join(autoHome, 'storages', 'dsh-composer-plus', 'auto-backup.json'), 'utf8')).version, '0.2.1');
  let r = await app.call(AUTO_BACKUP_PATH);
  assert.ok(Math.abs(Date.parse(r.data.next) - Date.now() - 6 * 3600000) < 5000, 'the next one in 6 hours');
  app.unload();
  // A failure: shown in the answer; the next try waits retryMs, not at once.
  const failFolder = join(root, 'not-a-folder');
  writeFileSync(failFolder, 'file in the way');
  const failHome = join(root, 'fail', '.dsh');
  write(join(failHome, 'a.txt'), 'a');
  write(join(failHome, 'storages', 'dsh-composer-plus', 'auto-backup.json'), JSON.stringify({ on: true }));
  const broken = boot({ home: failHome, folder: failFolder, version: '0.2.1', graceMs: 10, retryMs: 60000 });
  r = await until(async () => { const x = await broken.call(AUTO_BACKUP_PATH); return x.data.failed ? x : undefined; }, 'the failure');
  assert.equal(r.data.error, undefined, 'not the field of a refused request');
  assert.match(r.data.failed.message, /EEXIST|ENOTDIR|not a directory|file already exists/i);
  assert.ok(Date.parse(r.data.next) - Date.now() > 50000, 'the next try waits');
  broken.unload();
  // The first start with a version and an automatic backup that is off: the version is remembered, no snapshot.
  const offHome = join(root, 'off', '.dsh');
  write(join(offHome, 'a.txt'), 'a');
  const off = boot({ home: offHome, folder: join(root, 'off-backups'), version: '0.2.1', graceMs: 5 });
  await until(() => existsSync(join(offHome, 'storages', 'dsh-composer-plus', 'auto-backup.json')), 'version saved');
  assert.equal(JSON.parse(readFileSync(join(offHome, 'storages', 'dsh-composer-plus', 'auto-backup.json'), 'utf8')).version, '0.2.1');
  assert.equal(existsSync(join(root, 'off-backups')), false, 'off: no backup, no folder');
  off.unload();
}

rmSync(root, { recursive: true, force: true });
console.log('backup host checks passed');
