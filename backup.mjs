#!/usr/bin/env node
/**
 * Composer Plus backup and rescue (dsh-composer-plus). Node standard library only, so one file works in two places:
 * - The Host half imports it: back up the dsh home, check an archive, check and repair session logs.
 * - Each backup copies it into the backup folder as `composer-plus-rescue.mjs`, next to a double-click launcher. Run there,
 *   it is a terminal menu that works while dsh is closed or cannot start: list and check backups, restore one, check and
 *   repair session logs. It opens no port.
 * Archive format (the same as dsh-backup 0.13): `dsh-<stamp>.tar.gz`, a gzip tar with one top folder (the dsh home's name),
 * and next to it `<archive>.sha256`, `.meta.json` and `.redacted.json` (the masked files; their real copies stay on this
 * computer in `composer-plus-vault/<archive>/`). `cache/`, `dsh-runtimes/` and every `node_modules` are not archived: a restore moves them
 * over from the current dsh home.
 */
import { constants, createReadStream, createWriteStream, realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { chmod, copyFile, link, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Open flags: a symlink or a FIFO put in place of a file can neither redirect nor block the open. */
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const BLOCK = 512;
const CHUNK = 1 << 20;
const MB = 1 << 20;
/** Session logs bigger than this are not checked (read into memory). */
const LOG_MAX = 512 * MB;
/** dsh's session log name: `session[.v<N>].jsonl[.zstd]`. */
const LOG_RE = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/;

/** Archive names in the backup folder: ours and dsh-backup's full backups and snapshots (`dsh-t-` typed parts are not). */
export const ARCHIVE_RE = /^dsh-(?:(pre-upgrade|pre-restore)-)?(\d{8})-(\d{9})\.tar\.gz$/;
/** Top-level folders of the dsh home that are not archived (a cache and the app's runtime payload). */
export const NOT_ARCHIVED = ['cache', 'dsh-runtimes'];
/** Folder names that are never archived, at any depth (pnpm installs them again). */
const NEVER = new Set(['node_modules', '.system']);
const SIDECARS = ['.sha256', '.meta.json', '.redacted.json'];
export const LOCK_FILE = '.composer-plus.lock';
export const RESCUE_FILE = 'composer-plus-rescue.mjs';
export const LAUNCHERS = { darwin: 'Composer Plus Rescue.command', linux: 'composer-plus-rescue.sh', win32: 'Composer Plus Rescue.cmd' };
/** While dsh runs with Composer Plus, each dsh process keeps `host-<pid>.json` in this folder (two dsh processes, such as
 * the desktop app and `dsh web`, can share one dsh home). The rescue console refuses a restore or repair while one lives. */
export const HOST_DIR = ['storages', 'dsh-composer-plus', 'running'];
export const hostFile = (home, pid = process.pid) => join(home, ...HOST_DIR, `host-${pid}.json`);
export const BY = 'dsh-composer-plus';
/** Masked files of archive X are in `<folder>/composer-plus-vault/X/`. Not dsh-backup's `vault/`: its backups empty that
 * folder (all but `preserved/`) each time. Its own archives' secrets are read from its `vault/` mirror. */
export const VAULT = 'composer-plus-vault';

/** A refused or damaged archive (the message is for the user). */
export class ArchiveError extends Error {}
/** Another backup action holds the backup folder. */
export class BusyError extends Error {
  constructor(held) { super(held?.op ? `another backup action is running (${held.op}, process ${held.pid})` : 'another backup action is running'); this.held = held; }
}

const pad2 = (n, w = 2) => String(n).padStart(w, '0');
/** Local time `YYYYMMDD-HHMMSSmmm` (dsh-backup's archive stamp). */
export const stamp = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${pad2(d.getMilliseconds(), 3)}`;
const stampDate = (day, time) => new Date(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6), +time.slice(6, 9));
const exists = (p) => lstat(p).then(() => true, () => false);
const isDir = (p) => lstat(p).then((s) => s.isDirectory(), () => false);
const yieldNow = () => new Promise((r) => setImmediate(r));

/** The bytes of one regular file (at most `max`), or undefined: a missing file, a symlink, a FIFO, a device or a bigger
 * file is never read. */
export async function readRegular(path, max = MB) {
  let file;
  try {
    file = await open(path, READ);
    const info = await file.stat();
    if (!info.isFile() || info.size > max) return undefined;
    const buffer = Buffer.alloc(info.size);
    let done = 0;
    while (done < info.size) { const { bytesRead } = await file.read(buffer, done, info.size - done, done); if (bytesRead === 0) break; done += bytesRead; }
    return buffer.subarray(0, done);
  } catch { return undefined; } finally { await file?.close().catch(() => {}); }
}
const readJson = async (path) => { try { return JSON.parse((await readRegular(path)).toString('utf8')); } catch { return undefined; } };

// ---------- Masking ----------

const SECRET_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'credentials', 'authorization',
  'apikey', 'accesskey', 'secretkey', 'privatekey', 'clientsecret', 'authkey', 'authtoken']);
/** A config key that holds a secret: its last word (or last two words) is token, secret, password, apiKey, … `maxTokens`
 * and `apiKeyEnv` (a variable name) are not. */
export function secretKey(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return SECRET_WORDS.has(words.at(-1)) || SECRET_WORDS.has(words.slice(-2).join(''));
}
/** Files that stay out of the archive as a whole (their copy goes to the vault). */
export function wholeSecret(rel) {
  const name = rel.split('/').at(-1);
  return name === '.credentials.yaml' || name === '.env' || name.startsWith('.env.') || /\.(pem|key|p12|pfx)$/i.test(name) || rel === 'qq-bridge/config.json';
}
/** YAML files (also `cordis.patch.yml.bak-…`): their secret values are masked. */
export const yamlFile = (rel) => /\.ya?ml(\.|$)/i.test(rel.split('/').at(-1));
export const MASK = '"[masked by Composer Plus]"';
/** Replaces the value of each secret key (a plain or quoted scalar, or a `|`/`>` block) with MASK. Tags (`!!js …`), empty
 * values and nested maps stay. Line-based: a value in a flow map (`{token: x}`) is not found. */
export function maskYaml(text) {
  const out = [];
  let changed = 0;
  let block = -1;
  for (const line of text.split('\n')) {
    if (block >= 0) {
      if (line.trim() === '' || line.match(/^ */)[0].length > block) continue;
      block = -1;
    }
    const m = /^(\s*(?:-\s+)?)(["']?)([A-Za-z0-9_.-]+)\2(\s*:)\s+(\S.*)$/.exec(line);
    if (m !== null && secretKey(m[3]) && !/^(!|#|&|\*|""|''|~$|null$)/.test(m[5])) {
      if (/^[|>]/.test(m[5])) block = m[1].length;
      out.push(`${m[1]}${m[2]}${m[3]}${m[2]}${m[4]} ${MASK}`);
      changed += 1;
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), changed };
}

// ---------- Tar writer ----------

function octal(buf, off, len, value) { buf.write(`${Math.max(0, Math.floor(value)).toString(8).padStart(len - 1, '0').slice(-(len - 1))}\0`, off, len, 'latin1'); }
function headerBlock({ name, type, size = 0, mode = 0o644, mtime = 0, linkname = '' }) {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'utf8');
  octal(b, 100, 8, mode & 0o7777); octal(b, 108, 8, 0); octal(b, 116, 8, 0); octal(b, 124, 12, size); octal(b, 136, 12, mtime);
  b.fill(0x20, 148, 156);
  b.write(type, 156, 1, 'latin1');
  b.write(linkname, 157, 100, 'utf8');
  b.write('ustar\x0000', 257, 8, 'latin1');
  let sum = 0;
  for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return b;
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  while (n + String(len).length !== len) len = n + String(len).length;
  return `${len}${body}`;
}
const padding = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);
const plainName = (s) => Buffer.byteLength(s) <= 100 && /^[\x20-\x7e]*$/.test(s);
const MAX_OCTAL = 0o77777777777;
/** One tar header (ustar), with a pax header before it for a long or non-ASCII name or link and a size over 8 GB. */
export function tarHeader(entry) {
  const pax = [];
  if (!plainName(entry.name)) pax.push(paxRecord('path', entry.name));
  if (entry.linkname && !plainName(entry.linkname)) pax.push(paxRecord('linkpath', entry.linkname));
  if ((entry.size ?? 0) > MAX_OCTAL) pax.push(paxRecord('size', String(entry.size)));
  const ascii = (s) => s.replace(/[^\x20-\x7e]/g, '_').slice(-100);
  const main = headerBlock({ ...entry, name: plainName(entry.name) ? entry.name : ascii(entry.name), linkname: entry.linkname && plainName(entry.linkname) ? entry.linkname : '',
    size: (entry.size ?? 0) > MAX_OCTAL ? 0 : entry.size });
  if (pax.length === 0) return main;
  const data = Buffer.from(pax.join(''));
  return Buffer.concat([headerBlock({ name: 'PaxHeader', type: 'x', size: data.length, mtime: entry.mtime }), data, padding(data.length), main]);
}

// ---------- Backup ----------

/** `rel` paths under `root` (sorted, a folder before its contents), with their lstat. `skip(rel, name)` prunes. */
async function* walk(root, rel, skip, signal) {
  let names;
  try { names = (await readdir(rel === '' ? root : join(root, rel))).sort(); } catch { return; }
  for (const name of names) {
    signal?.throwIfAborted();
    const r = rel === '' ? name : `${rel}/${name}`;
    if (skip(r, name)) continue;
    let st;
    try { st = await lstat(join(root, r)); } catch { continue; }
    yield { rel: r, st };
    if (st.isDirectory()) yield* walk(root, r, skip, signal);
  }
}

/** Real path of `p` relative to `root` (both real), or undefined when it is not inside. */
const inside = (root, p) => (p.startsWith(`${root}/`) || p.startsWith(`${root}\\`) ? p.slice(root.length + 1).split('\\').join('/') : undefined);

/** Back up the dsh home `home` into `dest` as `dsh-[<kind>-]<stamp>.tar.gz` and its sidecars. With `keep`, then only the
 * newest `keep` archives of that kind that Composer Plus made stay (other archives, such as dsh-backup's, are never
 * removed). `progress` gets `files` and `bytes` as they go. On a failure nothing new stays in `dest`. */
export async function backup({ home, dest, kind = 'backup', keep, signal, progress = {}, now = new Date() }) {
  const realHome = await realpath(home);
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const realDest = await realpath(dest);
  const name = `dsh-${kind === 'backup' ? '' : `${kind}-`}${stamp(now)}.tar.gz`;
  const file = join(realDest, name);
  const vaultDir = join(realDest, VAULT, name);
  const top = basename(realHome);
  const destRel = inside(realHome, realDest);
  const masked = [];
  const skipped = [];
  const changed = [];
  const seen = new Map();
  progress.files = 0; progress.bytes = 0;
  const vaultPut = async (rel, data) => {
    await mkdir(join(realDest, VAULT), { recursive: true, mode: 0o700 });
    const target = join(vaultDir, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    masked.push(rel);
  };
  // A backup folder inside the dsh home is not archived into itself; the running dsh's marker is not restored.
  const hostRel = HOST_DIR.join('/');
  const skip = (rel, n) => NEVER.has(n) || (!rel.includes('/') && NOT_ARCHIVED.includes(n)) || rel === destRel || rel === hostRel;
  // ponytail: a hard link to a masked file under a name that is not masked goes into the archive as it is (the walk does
  // not know the other names of an inode). dsh makes no such links; its attachment store links only attachments.
  async function* fileEntry(rel, entryName) {
    let fh;
    try { fh = await open(join(realHome, rel), READ); } catch { skipped.push(rel); return; }
    try {
      const info = await fh.stat();
      if (!info.isFile()) { skipped.push(rel); return; }
      const key = `${info.dev}:${info.ino}`;
      if (info.nlink > 1 && seen.has(key)) { yield tarHeader({ name: entryName, type: '1', mode: info.mode, mtime: info.mtimeMs / 1000, linkname: seen.get(key) }); return; }
      yield tarHeader({ name: entryName, type: '0', size: info.size, mode: info.mode, mtime: info.mtimeMs / 1000 });
      let done = 0;
      while (done < info.size) {
        const want = Math.min(CHUNK, info.size - done);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, done);
        // A file that shrinks while it is read keeps its size at open: the rest is zeros (the tar entry needs that size;
        // session logs are read whole before, so this is never one of them).
        if (bytesRead === 0) { changed.push(rel); yield Buffer.alloc(info.size - done); break; }
        done += bytesRead; progress.bytes += bytesRead;
        yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
      }
      yield padding(info.size);
      progress.files += 1;
      if (info.nlink > 1) seen.set(key, entryName);
    } finally { await fh.close().catch(() => {}); }
  }
  async function* entries() {
    const rootInfo = await lstat(realHome);
    yield tarHeader({ name: `${top}/`, type: '5', mode: rootInfo.mode, mtime: rootInfo.mtimeMs / 1000 });
    for await (const { rel, st } of walk(realHome, '', skip, signal)) {
      const entryName = `${top}/${rel}`;
      const mtime = st.mtimeMs / 1000;
      if (st.isDirectory()) { yield tarHeader({ name: `${entryName}/`, type: '5', mode: st.mode, mtime }); continue; }
      if (st.isSymbolicLink()) {
        let target;
        try { target = await readlink(join(realHome, rel)); } catch { skipped.push(rel); continue; }
        yield tarHeader({ name: entryName, type: '2', mode: st.mode, mtime, linkname: target });
        continue;
      }
      if (!st.isFile()) { skipped.push(rel); continue; }
      if (wholeSecret(rel)) {
        const data = await readRegular(join(realHome, rel), 16 * MB);
        if (data === undefined) skipped.push(rel); else await vaultPut(rel, data);
        continue;
      }
      // A session log is read whole first: dsh can cut its torn tail while the backup runs, and a zstd log must not get
      // a zero-filled end (dsh cannot read that). Its header then has the size that was read.
      if (LOG_RE.test(rel.split('/').at(-1)) && st.size <= LOG_MAX) {
        const data = await readRegular(join(realHome, rel), LOG_MAX);
        if (data === undefined) { skipped.push(rel); continue; }
        yield tarHeader({ name: entryName, type: '0', size: data.length, mode: st.mode, mtime });
        yield data; yield padding(data.length);
        progress.files += 1; progress.bytes += data.length;
        continue;
      }
      if (yamlFile(rel)) {
        const data = await readRegular(join(realHome, rel), 16 * MB);
        if (data === undefined) { skipped.push(rel); continue; }
        const { text, changed: n } = maskYaml(data.toString('utf8'));
        const body = n > 0 ? Buffer.from(text) : data;
        if (n > 0) await vaultPut(rel, data);
        yield tarHeader({ name: entryName, type: '0', size: body.length, mode: st.mode, mtime });
        yield body; yield padding(body.length);
        progress.files += 1; progress.bytes += body.length;
        continue;
      }
      yield* fileEntry(rel, entryName);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  const hash = createHash('sha256');
  const tap = async function* (source) { for await (const chunk of source) { hash.update(chunk); yield chunk; } };
  let sha;
  try {
    await pipeline(entries, zlib.createGzip({ level: 6 }), tap, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    sha = hash.digest('hex');
    await writeFile(`${file}.sha256`, `${sha}  ${file}\n`, { mode: 0o600 });
    await writeFile(`${file}.meta.json`, `${JSON.stringify({ host: hostname(), home: homedir(), dshHome: realHome, createdAt: now.toISOString(), redacted: masked.length,
      by: BY, files: progress.files, bytes: progress.bytes, skipped: skipped.length })}\n`, { mode: 0o600 });
    await writeFile(`${file}.redacted.json`, `${JSON.stringify({ files: masked })}\n`, { mode: 0o600 });
  } catch (error) {
    await removeArchive(realDest, name).catch(() => {});
    throw error;
  }
  const size = (await stat(file)).size;
  // The new archive is complete: a failure to remove older ones keeps it.
  const rotated = keep === undefined ? [] : await rotate(realDest, kind, keep).catch(() => []);
  return { name, file, sha, size, files: progress.files, bytes: progress.bytes, masked, skipped, changed, rotated };
}

/** Removes one archive, its sidecars and its vault copies. `name` must be an archive name (never a path). */
export async function removeArchive(dest, name) {
  if (!ARCHIVE_RE.test(name)) throw new ArchiveError('not a backup archive name');
  for (const suffix of ['', ...SIDECARS]) await rm(join(dest, `${name}${suffix}`), { force: true });
  await rm(join(dest, VAULT, name), { recursive: true, force: true });
}
/** Keeps the newest `keep` Composer Plus archives of one kind; returns the removed names. */
async function rotate(dest, kind, keep) {
  const old = (await listArchives(dest)).filter((a) => a.kind === kind && a.meta?.by === BY).slice(Math.max(1, keep));
  for (const a of old) await removeArchive(dest, a.name);
  return old.map((a) => a.name);
}

/** The archives in `dest`, newest first: `{name, kind, at, size, checksum, meta, masked}` (`masked` null when the archive
 * has no `.redacted.json`). */
export async function listArchives(dest) {
  let names;
  try { names = await readdir(dest); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = ARCHIVE_RE.exec(name);
    if (m === null) continue;
    let info;
    try { info = await lstat(join(dest, name)); } catch { continue; }
    if (!info.isFile()) continue;
    const meta = await readJson(join(dest, `${name}.meta.json`));
    const files = (await readJson(join(dest, `${name}.redacted.json`)))?.files;
    out.push({ name, kind: m[1] ?? 'backup', at: stampDate(m[2], m[3]).toISOString(), key: `${m[2]}${m[3]}`, size: info.size, checksum: await exists(join(dest, `${name}.sha256`)),
      meta: meta && typeof meta === 'object' ? { host: str(meta.host), home: str(meta.home), dshHome: str(meta.dshHome), by: str(meta.by), files: num(meta.files), bytes: num(meta.bytes) } : null,
      masked: Array.isArray(files) ? files.filter((f) => typeof f === 'string') : null });
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)).map(({ key, ...a }) => a);
}
const str = (v) => (typeof v === 'string' ? v : undefined);
const num = (v) => (Number.isSafeInteger(v) ? v : undefined);

// ---------- Tar reader ----------

const cstr = (b, off, len) => { const s = b.subarray(off, off + len); const end = s.indexOf(0); return (end < 0 ? s : s.subarray(0, end)).toString('utf8'); };
function parseOctal(b, off, len) {
  if (b[off] & 0x80) { let n = 0; for (let i = off + 1; i < off + len; i++) n = n * 256 + b[i]; return n; }
  const text = cstr(b, off, len).trim();
  return text === '' ? 0 : parseInt(text, 8);
}
function parseHeader(h, next) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  if (parseOctal(h, 148, 8) !== sum) throw new ArchiveError('the archive is damaged (a header checksum does not match)');
  let name = cstr(h, 0, 100);
  if (h.toString('latin1', 257, 263) === 'ustar\0') { const prefix = cstr(h, 345, 155); if (prefix !== '') name = `${prefix}/${name}`; }
  const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
  return { name: next.path ?? name, type, size: next.size ?? parseOctal(h, 124, 12), mode: parseOctal(h, 100, 8), mtime: parseOctal(h, 136, 12), linkname: next.linkpath ?? cstr(h, 157, 100) };
}
function applyMeta(type, data, next) {
  if (type === 'L') { next.path = cstr(data, 0, data.length); return; }
  if (type === 'K') { next.linkpath = cstr(data, 0, data.length); return; }
  if (type !== 'x') return; // 'g': global pax records are not used
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const len = Number(data.toString('latin1', off, space));
    if (!Number.isSafeInteger(len) || len <= 0 || off + len > data.length) throw new ArchiveError('the archive is damaged (a pax record)');
    const record = data.toString('utf8', space + 1, off + len - 1);
    const eq = record.indexOf('=');
    const key = record.slice(0, eq); const value = record.slice(eq + 1);
    if (key === 'path') next.path = value;
    else if (key === 'linkpath') next.linkpath = value;
    else if (key === 'size') next.size = Number(value);
    off += len;
  }
}

/** Reads a `.tar.gz` once: `onEntry(entry)` for each entry (`{name, type, size, mode, mtime, linkname}`) may return a sink
 * `{write(chunk), end()}` for a file's data. Answers `{sha256}` of the compressed bytes. `progress.read` counts them. */
export async function readArchive(file, { signal, onEntry = () => undefined, progress = {} } = {}) {
  const hash = createHash('sha256');
  progress.read = 0;
  const tap = async function* (source) { for await (const chunk of source) { hash.update(chunk); progress.read += chunk.length; yield chunk; } };
  let ended = false;
  let any = false;
  const parse = async (source) => {
    let buf = Buffer.alloc(0);
    let next = {};
    let cur = null;
    let zeros = 0;
    for await (const chunk of source) {
      if (ended) continue;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        if (cur !== null) {
          if (cur.left > 0) {
            if (buf.length === 0) break;
            const take = Math.min(cur.left, buf.length);
            const part = buf.subarray(0, take);
            buf = buf.subarray(take);
            cur.left -= take;
            if (cur.collect !== undefined) cur.collect.push(Buffer.from(part));
            else if (cur.sink !== undefined) await cur.sink.write(part);
            if (cur.left > 0) break;
          }
          if (buf.length < cur.pad) break;
          buf = buf.subarray(cur.pad);
          const done = cur;
          cur = null;
          if (done.meta !== undefined) applyMeta(done.meta, Buffer.concat(done.collect), next);
          else await done.sink?.end?.();
          continue;
        }
        if (buf.length < BLOCK) break;
        const h = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (h.every((x) => x === 0)) { zeros += 1; if (zeros === 2) { ended = true; break; } continue; }
        zeros = 0;
        const entry = parseHeader(h, next);
        next = {};
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new ArchiveError('the archive is damaged (an entry size)');
        const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
        if ('xgLK'.includes(entry.type)) {
          if (entry.size > MB) throw new ArchiveError('the archive is damaged (an extended header is too large)');
          cur = { left: entry.size, pad, meta: entry.type, collect: [] };
          continue;
        }
        any = true;
        const sink = await onEntry(entry);
        cur = { left: entry.size, pad, sink: entry.type === '0' || entry.type === '7' ? sink : undefined };
      }
    }
    if (cur !== null || (!ended && !any)) throw new ArchiveError('the archive is cut off or is not a tar archive');
  };
  try {
    await pipeline(createReadStream(file), tap, zlib.createGunzip(), parse, { signal });
  } catch (error) {
    if (error instanceof ArchiveError || error?.name === 'AbortError') throw error;
    if (error?.code?.startsWith?.('Z_') || /unexpected end|incorrect header|invalid/i.test(String(error?.message))) throw new ArchiveError(`the archive is damaged (${error.message})`);
    throw error;
  }
  return { sha256: hash.digest('hex') };
}

/** The parts of a safe entry name: no absolute path, drive, `.` or `..` part, empty part or NUL. */
export function entryParts(name) {
  const clean = String(name).replace(/\/+$/, '');
  if (clean === '' || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.includes('\0')) throw new ArchiveError(`unsafe entry in the archive: ${JSON.stringify(name)}`);
  const parts = clean.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || (process.platform === 'win32' && /[\\:]/.test(p)))) throw new ArchiveError(`unsafe entry in the archive: ${JSON.stringify(name)}`);
  return parts;
}
const KINDS = { '0': 'file', '7': 'file', '5': 'dir', '2': 'symlink', '1': 'hardlink' };
/** macOS tar (bsdtar) stores extended attributes as a `._<name>` file in AppleDouble format next to the entry. */
const APPLE_DOUBLE = 0x00051607;
const mayBeAppleDouble = (e) => (e.type === '0' || e.type === '7') && e.size <= MB && /(^|\/)\._[^/]+$/.test(e.name.replace(/\/+$/, ''));
/** Runs `accept(e)` now, or for a possible AppleDouble entry after its first bytes: those are skipped (`onSkip`). */
function unlessAppleDouble(e, accept, onSkip = () => {}) {
  if (!mayBeAppleDouble(e)) return accept(e);
  const head = [];
  let sink;
  let decided = false;
  const decide = async () => {
    if (decided) return;
    decided = true;
    const first = Buffer.concat(head);
    if (first.length >= 4 && first.readUInt32BE(0) === APPLE_DOUBLE) { onSkip(e); return; }
    sink = await accept(e);
    if (first.length > 0) await sink?.write(first);
  };
  return {
    write: async (chunk) => {
      if (!decided) { head.push(Buffer.from(chunk)); if (Buffer.concat(head).length < 4) return; await decide(); return; }
      await sink?.write(chunk);
    },
    end: async () => { await decide(); await sink?.end?.(); },
  };
}

/** Reads the whole archive and refuses what a restore must not write: unsafe names, more than one top folder, devices and
 * FIFOs, a duplicate, a hard link to a file that is not before it, an entry below a symbolic link. macOS metadata entries
 * (AppleDouble `._` files of dsh-backup archives) are skipped. */
export async function checkArchive(file, { signal, progress } = {}) {
  const kinds = new Map();
  const symlinks = [];
  let top;
  let bytes = 0;
  const { sha256 } = await readArchive(file, { signal, progress, onEntry: (entry) => unlessAppleDouble(entry, (e) => {
    const kind = KINDS[e.type];
    if (kind === undefined) throw new ArchiveError(`the archive has an entry of a type that a restore does not write: ${JSON.stringify(e.name)}`);
    const parts = entryParts(e.name);
    if (top === undefined) top = parts[0];
    if (parts[0] !== top) throw new ArchiveError('the archive has more than one top folder');
    const name = parts.join('/');
    const before = kinds.get(name);
    if (before !== undefined && !(before === 'dir' && kind === 'dir')) throw new ArchiveError(`the archive has two entries for ${name}`);
    if (kind === 'hardlink') {
      const target = entryParts(e.linkname).join('/');
      if (kinds.get(target) !== 'file') throw new ArchiveError(`the archive has a hard link to a file that is not in it: ${name}`);
    }
    if (kind === 'symlink') symlinks.push(name);
    if (kind === 'file') bytes += e.size;
    kinds.set(name, kind);
    return undefined;
  }) });
  if (top === undefined) throw new ArchiveError('the archive is empty');
  const links = new Set(symlinks);
  for (const name of kinds.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (links.has(parts.slice(0, i).join('/'))) throw new ArchiveError(`the archive has an entry below a symbolic link: ${name}`);
  }
  let files = 0, dirs = 0, hardlinks = 0;
  for (const kind of kinds.values()) { if (kind === 'file') files += 1; else if (kind === 'dir') dirs += 1; else if (kind === 'hardlink') hardlinks += 1; }
  return { sha256, top, entries: kinds.size, files, dirs, symlinks: symlinks.length, hardlinks, bytes };
}

/** The vault copy of one masked file: `composer-plus-vault/<archive>/<rel>`, or for a dsh-backup archive its one shared
 * mirror `vault/<rel>`. */
async function vaultCopy(dest, archive, rel, by) {
  const parts = entryParts(`x/${rel}`).slice(1);
  const own = await readRegular(join(dest, VAULT, archive.name, ...parts), 16 * MB);
  if (own !== undefined || by === BY) return own;
  return readRegular(join(dest, 'vault', ...parts), 16 * MB);
}

/** Checks one archive of `dest` (its checksum file and a full read, see checkArchive) and tells what a restore would do.
 * Never throws for a damaged archive: `{ok: false, reason}`. */
export async function verifyArchive(dest, name, { home, signal, progress } = {}) {
  const archive = (await listArchives(dest)).find((a) => a.name === name);
  if (archive === undefined) return { ok: false, name, reason: 'this backup is not in the folder' };
  const expected = (await readRegular(join(dest, `${name}.sha256`)))?.toString('utf8').trim().split(/\s+/)[0];
  let info;
  try { info = await checkArchive(join(dest, name), { signal, progress }); } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { ok: false, name, reason: String(error?.message ?? error) };
  }
  if (expected !== undefined && /^[0-9a-f]{64}$/.test(expected) && expected !== info.sha256) return { ok: false, name, reason: 'the checksum does not match (the archive or its .sha256 file changed)' };
  const masked = [];
  for (const rel of archive.masked ?? []) {
    let vault = false;
    try { vault = (await vaultCopy(dest, archive, rel, archive.meta?.by)) !== undefined; } catch { vault = false; }
    masked.push({ path: rel, vault });
  }
  const otherHome = archive.meta?.dshHome !== undefined && home !== undefined && resolve(archive.meta.dshHome) !== resolve(home);
  return { ok: true, name, checksum: expected !== undefined, ...info, masked, from: { host: archive.meta?.host, dshHome: archive.meta?.dshHome }, otherHome };
}

// ---------- Restore ----------

async function writeAll(fh, chunk) {
  let off = 0;
  while (off < chunk.length) { const { bytesWritten } = await fh.write(chunk, off, chunk.length - off); off += bytesWritten; }
}
/** Writes a checked archive into the empty folder `root` (its top folder becomes `root`): files with O_EXCL | O_NOFOLLOW,
 * hard links to files written before, symbolic links last (their targets are never followed), folder modes at the end. */
async function extract(file, root, { signal, progress }) {
  const dirs = [];
  const links = [];
  const unlinked = [];
  let openFile;
  try {
    await readArchive(file, { signal, progress, onEntry: (entry) => unlessAppleDouble(entry, async (e) => {
      // checkArchive read this file before; a file swapped in after it still writes nothing but these kinds.
      if (KINDS[e.type] === undefined) throw new ArchiveError(`the archive has an entry of a type that a restore does not write: ${JSON.stringify(e.name)}`);
      const rest = entryParts(e.name).slice(1);
      if (rest.length === 0) return undefined;
      const path = join(root, ...rest);
      if (e.type === '5') { await mkdir(path, { recursive: true, mode: 0o700 }); dirs.push([path, e.mode, e.mtime]); return undefined; }
      if (e.type === '2') { links.push([path, e.linkname]); return undefined; }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (e.type === '1') { await link(join(root, ...entryParts(e.linkname).slice(1)), path); return undefined; }
      const fh = await open(path, CREATE, (e.mode & 0o777) | 0o600);
      openFile = fh;
      return { write: (chunk) => writeAll(fh, chunk), end: async () => { await fh.utimes(e.mtime, e.mtime).catch(() => {}); await fh.close(); openFile = undefined; } };
    }) });
  } finally { await openFile?.close().catch(() => {}); }
  for (const [path, target] of links) {
    try { await symlink(target, path); } catch { unlinked.push(path.slice(root.length + 1)); }
  }
  for (const [path, mode, mtime] of dirs.reverse()) { await chmod(path, (mode & 0o777) | 0o700).catch(() => {}); await utimes(path, mtime, mtime).catch(() => {}); }
  return { unlinked };
}

/** `root/<parts>` when every folder on the way is a real folder (missing ones are made), else undefined. */
async function plainTarget(root, parts, make = true) {
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const info = await lstat(dir).catch(() => undefined);
    if (info === undefined && make) await mkdir(dir, { mode: 0o700 });
    else if (info === undefined || !info.isDirectory()) return undefined;
  }
  const info = await lstat(join(dir, parts.at(-1))).catch(() => undefined);
  return info === undefined || info.isFile() || info.isSymbolicLink() ? join(dir, parts.at(-1)) : undefined;
}

/** What a restore moves over from the current dsh home: the folders that are never archived. */
async function carryList(home, signal) {
  const out = [];
  for await (const { rel, st } of walk(home, '', (rel, name) => {
    if (NEVER.has(name) || (!rel.includes('/') && NOT_ARCHIVED.includes(name))) { out.push(rel); return true; }
    return rel.split('/').length > 8;
  }, signal)) void st;
  return out;
}

/** Profiles whose plugin packages must be installed again: no `node_modules`, or a `pnpm-lock.yaml` that is not the
 * one that the current home had. */
async function profilesToInstall(home, before) {
  const out = [];
  let names;
  try { names = await readdir(join(home, 'profiles')); } catch { return out; }
  for (const name of names.sort()) {
    const dir = join(home, 'profiles', name);
    if (!(await isDir(dir)) || (await readRegular(join(dir, 'package.json'))) === undefined) continue;
    const lock = await readRegular(join(dir, 'pnpm-lock.yaml'), 64 * MB);
    const old = before === undefined ? undefined : await readRegular(join(before, 'profiles', name, 'pnpm-lock.yaml'), 64 * MB);
    if (!(await isDir(join(dir, 'node_modules'))) || (lock !== undefined && (old === undefined || !lock.equals(old)))) out.push(name);
  }
  return out;
}

/** Restores archive `name` of `dest` as the dsh home `home`: check, write it into a new folder next to the home, put the
 * vault copies of the masked files in, then swap the folders. The old home stays as `<home>.pre-restore-<stamp>`; the
 * folders that are not archived (`cache/`, `dsh-runtimes/`, `node_modules`) move over from it. dsh must be closed. */
export async function restore({ home, dest, name, signal, progress = {} }) {
  const check = await verifyArchive(dest, name, { home, signal, progress });
  if (!check.ok) throw new ArchiveError(check.reason);
  const archive = (await listArchives(dest)).find((a) => a.name === name);
  const target = resolve(home);
  const real = await realpath(target).catch(() => undefined);
  const base = real ?? target;
  const parent = dirname(base);
  await mkdir(parent, { recursive: true });
  // statfs: Node 18.15 and later (the console can run on an older Node; then the space is not checked).
  const space = typeof fsp.statfs === 'function' ? await fsp.statfs(parent).catch(() => undefined) : undefined;
  if (space !== undefined && space.bavail * space.bsize < check.bytes + 256 * MB) {
    throw new ArchiveError(`not enough free disk space: the restore needs about ${Math.ceil((check.bytes + 256 * MB) / MB)} MB`);
  }
  const staging = join(parent, `.${basename(base)}.restore-${stamp()}`);
  await mkdir(staging, { mode: 0o700 });
  const vaultMissing = [];
  let unlinked;
  try {
    ({ unlinked } = await extract(join(dest, name), staging, { signal, progress }));
    for (const rel of archive.masked ?? []) {
      const data = await vaultCopy(dest, archive, rel, archive.meta?.by).catch(() => undefined);
      if (data === undefined) { vaultMissing.push(rel); continue; }
      // The archive made the folders and links of `staging`: a masked file is written only below real folders.
      const path = await plainTarget(staging, entryParts(`x/${rel}`).slice(1));
      if (path === undefined) { vaultMissing.push(rel); continue; }
      await rm(path, { force: true });
      const fh = await open(path, CREATE, 0o600);
      try { await writeAll(fh, data); } finally { await fh.close(); }
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const carry = real === undefined ? [] : await carryList(real, signal);
  let aside;
  if (real !== undefined) {
    aside = `${base}.pre-restore-${stamp()}`;
    await rename(base, aside);
    try { await rename(staging, base); } catch (error) {
      await rename(aside, base);
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  } else await rename(staging, base);
  const moved = [];
  const left = [];
  for (const rel of carry) {
    // Only below real folders of the restored home: a folder that the archive has as a symbolic link is not entered.
    const to = await plainTarget(base, rel.split('/'), false);
    if (to === undefined || (await exists(to))) continue;
    try { await rename(join(aside, ...rel.split('/')), to); moved.push(rel); } catch { left.push(rel); }
  }
  return { name, home: base, aside, entries: check.entries, moved, left, vaultMissing, unlinked, otherHome: check.otherHome, from: check.from,
    install: await profilesToInstall(base, aside) };
}

// ---------- One action at a time ----------

const alive = (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
/** Takes the backup folder's lock for `op` (one backup action at a time, for the Host and the rescue console). A lock of
 * a process that is gone is taken over. Answers the release function; throws BusyError. */
export async function takeLock(dest, op) {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const file = join(dest, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify({ pid: process.pid, op, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      return async () => { if ((await readJson(file))?.pid === process.pid) await rm(file, { force: true }); };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const held = await readJson(file);
      const fresh = held === undefined && Date.now() - ((await stat(file).catch(() => undefined))?.mtimeMs ?? 0) < 10000;
      if (fresh || (held !== undefined && alive(held.pid))) throw new BusyError(held);
      await rm(file, { force: true });
    }
  }
  throw new BusyError();
}
/** The pid of a running dsh (other than this process) that loaded Composer Plus for this home, or undefined. A marker of
 * a process that is gone is ignored. */
export async function runningDsh(home) {
  let names;
  try { names = await readdir(join(home, ...HOST_DIR)); } catch { return undefined; }
  for (const name of names) {
    const m = /^host-(\d+)\.json$/.exec(name);
    const pid = m === null ? undefined : Number(m[1]);
    if (pid !== undefined && pid !== process.pid && alive(pid)) return pid;
  }
  return undefined;
}

// ---------- Session logs ----------

const ZSTD_MAGIC = 0xfd2fb528;
const zstdDecompress = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : undefined;
/** The complete zstd frames of a session log (dsh's own rules): an incomplete last frame is a torn tail that dsh repairs at
 * its next write; a wrong magic, a reserved bit or a reserved block type is damage. */
export function zstdFrames(b) {
  const frames = [];
  let off = 0;
  while (off < b.length) {
    const start = off;
    if (b.length - off < 4) return { frames, tornStart: start };
    if (b.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`no zstd frame at byte ${off}`);
    off += 4;
    if (off === b.length) return { frames, tornStart: start };
    const d = b[off++];
    if (d & 24) throw new Error(`reserved frame header bit at byte ${off - 1}`);
    const single = (d & 32) !== 0;
    const sizeFlag = d >>> 6;
    const dict = (d & 3) === 3 ? 4 : d & 3;
    off += (single ? 0 : 1) + dict + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag);
    if (off > b.length) return { frames, tornStart: start };
    for (;;) {
      if (b.length - off < 3) return { frames, tornStart: start };
      const h = b.readUIntLE(off, 3);
      off += 3;
      const type = (h >>> 1) & 3;
      if (type === 3) throw new Error(`reserved block type at byte ${off - 3}`);
      off += type === 1 ? 1 : h >>> 3;
      if (off > b.length) return { frames, tornStart: start };
      if (h & 1) break;
    }
    if (d & 4) { off += 4; if (off > b.length) return { frames, tornStart: start }; }
    frames.push([start, off]);
  }
  return { frames, tornStart: undefined };
}

/** Checks one session log (its bytes): `{state: 'ok' | 'torn' | 'bad' | 'skipped', reason?}`. A torn tail is not damage
 * (dsh cuts it at its next write); nor is a bad row (not JSON, or in a v4 log a `seq` that is not its place) with no
 * turn/end after it (dsh opens the chat without the rows from there). Bad: a broken frame, a first frame that is not
 * exactly the header line, a record cut inside a complete frame, and a bad row with a turn/end after it. */
export async function checkLog(data, compressed) {
  const bad = (reason) => ({ state: 'bad', reason });
  let text;
  let torn = false;
  if (compressed) {
    if (zstdDecompress === undefined) return { state: 'skipped', reason: 'this Node.js has no zstd decoder (Node.js 22.15 or later has it)' };
    let scan;
    try { scan = zstdFrames(data); } catch (error) { return bad(error.message); }
    if (scan.frames.length === 0) return bad('the log has no complete frame');
    const parts = [];
    for (const [s, e] of scan.frames) {
      try { parts.push(await zstdDecompress(data.subarray(s, e))); } catch { return bad(`the frame at byte ${s} does not decode`); }
    }
    if (parts[0].length === 0 || parts[0].indexOf(10) !== parts[0].length - 1) return bad('the first frame is not exactly one header line');
    text = Buffer.concat(parts).toString('utf8');
    if (!text.endsWith('\n')) return bad('a complete frame ends inside a record');
    torn = scan.tornStart !== undefined;
  } else {
    text = data.toString('utf8');
    const cut = text.lastIndexOf('\n') + 1;
    torn = cut < text.length;
    text = text.slice(0, cut);
  }
  const lines = text.split('\n');
  lines.pop();
  if (lines.length === 0) return bad('the log has no header line');
  let header;
  try { header = JSON.parse(lines[0]); } catch { return bad('the header line is not JSON'); }
  if (header?.type !== 'session' || typeof header.version !== 'number' || typeof header.id !== 'string') return bad('the first line is not a session header');
  // dsh's own rule when it opens a chat (SessionLogScanner, recovery "recoverable"): after the first bad row, dsh keeps
  // the rows before it and drops the rest, unless a later row is a turn/end: then the log does not open.
  let issue;
  for (let i = 1; i < lines.length; i++) {
    if (i % 5000 === 0) await yieldNow();
    let row;
    try { row = JSON.parse(lines[i]); } catch { issue ??= `line ${i + 1} is not JSON`; continue; }
    if (issue !== undefined) { if (row?.type === 'turn/end') return bad(issue); continue; }
    if (header.version === 4 && row?.seq !== i - 1) issue = `line ${i + 1} has seq ${row?.seq}, expected ${i - 1}`;
  }
  return { state: torn || issue !== undefined ? 'torn' : 'ok', id: header.id, ...(issue === undefined ? {} : { dropped: issue }) };
}

/** dsh's session folder name decoded back to the chat id (`~XXXX` is one UTF-16 code unit). */
const decodeId = (name) => name.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
/** The newest log of each chat folder under `<home>/sessions`: `{rel, id}`. */
export async function sessionLogs(home, signal) {
  const best = new Map();
  for await (const { rel, st } of walk(home, 'sessions', (rel) => rel.split('/').length > 5, signal)) {
    const m = LOG_RE.exec(rel.split('/').at(-1));
    if (m === null || !st.isFile()) continue;
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    const version = Number(m[1] ?? 0);
    if ((best.get(dir)?.version ?? -1) < version) best.set(dir, { rel, id: decodeId(dir.split('/').at(-1)), version });
  }
  return [...best.values()].map(({ rel, id }) => ({ rel, id }));
}

/** Checks every chat's newest log. `{scanned, bad: [{rel, id, reason}], torn, skipped}`. */
export async function scanSessions(home, { signal, progress = {} } = {}) {
  const logs = await sessionLogs(home, signal);
  progress.total = logs.length; progress.done = 0;
  const out = { scanned: logs.length, bad: [], torn: 0, skipped: 0 };
  for (const log of logs) {
    signal?.throwIfAborted();
    const data = await readRegular(join(home, ...log.rel.split('/')), LOG_MAX);
    const verdict = data === undefined ? { state: 'skipped' } : await checkLog(data, log.rel.endsWith('.zstd'));
    if (verdict.state === 'bad') out.bad.push({ ...log, reason: verdict.reason });
    else if (verdict.state === 'torn') out.torn += 1;
    else if (verdict.state === 'skipped') out.skipped += 1;
    progress.done += 1;
    await yieldNow();
  }
  return out;
}

/** Puts back each damaged log (`bad` from scanSessions) from the newest archive that has a healthy copy of it. The damaged
 * file stays next to it as `<name>.corrupt-<stamp>`; messages written after that backup are not in the copy. Chats that
 * `live(id)` says are open are left alone. */
export async function repairSessions({ home, dest, bad, live = () => false, signal, progress = {} }) {
  const busy = bad.filter((b) => live(b.id));
  const todo = new Map(bad.filter((b) => !live(b.id)).map((b) => [b.rel, b]));
  const fixed = [];
  for (const archive of await listArchives(dest)) {
    if (todo.size === 0) break;
    const found = new Map();
    try {
      await readArchive(join(dest, archive.name), { signal, progress, onEntry: (e) => {
        if (e.type !== '0' && e.type !== '7') return undefined;
        const rel = entryParts(e.name).slice(1).join('/');
        if (!LOG_RE.test(rel.split('/').at(-1))) return undefined;
        if (!todo.has(rel) || found.has(rel) || e.size > LOG_MAX) return undefined;
        const chunks = [];
        found.set(rel, chunks);
        return { write: (c) => { chunks.push(Buffer.from(c)); } };
      } });
    } catch (error) { if (error?.name === 'AbortError') throw error; continue; }
    for (const [rel, chunks] of found) {
      const data = Buffer.concat(chunks);
      const verdict = await checkLog(data, rel.endsWith('.zstd'));
      if (verdict.state !== 'ok' && verdict.state !== 'torn') continue;
      // Only a regular file below real folders of the dsh home is replaced (no symbolic link on the way).
      const path = await plainTarget(home, rel.split('/'), false);
      if (path === undefined || !(await lstat(path).then((s) => s.isFile(), () => false))) continue;
      const kept = `${path}.corrupt-${stamp()}`;
      const tmp = `${path}.repair-${process.pid}`;
      await writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
      await rename(path, kept);
      await rename(tmp, path);
      fixed.push({ ...todo.get(rel), from: archive.name, kept: basename(kept) });
      todo.delete(rel);
    }
  }
  return { fixed, missing: [...todo.values()], busy };
}

// ---------- Rescue console files ----------

const SELF = fileURLToPath(import.meta.url);
const LAUNCHER_TEXT = {
  darwin: `#!/bin/sh
# Composer Plus rescue console: a menu in this window. It works while dsh is closed or cannot start.
cd "$(dirname "$0")" || exit 1
# Node.js 18 or later; an older one is skipped.
for node in "$(command -v node)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"; do
  if [ -n "$node" ] && [ -x "$node" ] && "$node" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then exec "$node" ${RESCUE_FILE} "$@"; fi
done
app="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
if [ -x "$app" ]; then ELECTRON_RUN_AS_NODE=1 exec "$app" ${RESCUE_FILE} "$@"; fi
echo "Node.js was not found. Install it from https://nodejs.org, then open this file again."
printf "Press Return to close. "; read -r _
`,
  linux: `#!/bin/sh
# Composer Plus rescue console: a menu in this terminal. It works while dsh is closed or cannot start.
cd "$(dirname "$0")" || exit 1
for node in "$(command -v node)" /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"; do
  if [ -n "$node" ] && [ -x "$node" ] && "$node" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then exec "$node" ${RESCUE_FILE} "$@"; fi
done
echo "Node.js was not found. Install it from https://nodejs.org, then run this file again."
`,
  win32: `@echo off\r\nrem Composer Plus rescue console: a menu in this window. It works while dsh is closed or cannot start.\r\ncd /d "%~dp0"\r\nnode ${RESCUE_FILE} %*\r\npause\r\n`,
};
/** The rescue console files of this platform in `dest`. */
export const rescueFiles = (platform = process.platform) => [RESCUE_FILE, ...(LAUNCHERS[platform] === undefined ? [] : [LAUNCHERS[platform]])];
/** Writes (or replaces) the rescue console and its launcher in `dest`. */
export async function writeRescue(dest, platform = process.platform) {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const put = async (name, data, mode) => {
    const tmp = join(dest, `.${name}.${process.pid}.tmp`);
    await writeFile(tmp, data, { mode });
    await chmod(tmp, mode);
    await rename(tmp, join(dest, name));
  };
  const self = await readRegular(SELF, 16 * MB);
  if (self === undefined) throw new Error('cannot read the rescue console source');
  await put(RESCUE_FILE, self, 0o644);
  if (LAUNCHERS[platform] !== undefined) await put(LAUNCHERS[platform], LAUNCHER_TEXT[platform], 0o755);
  return rescueFiles(platform);
}
/** For another computer: a new folder `transfer-<stamp>` in `dest` with archive `name`, its sidecars and the rescue console.
 * The vault is not copied (secrets stay on this computer): the console on the other computer lists what to enter again.
 * On APFS and Btrfs the copy is a clone (no extra disk space). */
export async function prepareTransfer(dest, name, now = new Date()) {
  if (!ARCHIVE_RE.test(name) || !(await exists(join(dest, name)))) throw new ArchiveError('this backup is not in the folder');
  const dir = join(dest, `transfer-${stamp(now)}`);
  await mkdir(dir, { mode: 0o700 });
  try {
    for (const suffix of ['', ...SIDECARS]) {
      if (await exists(join(dest, `${name}${suffix}`))) await copyFile(join(dest, `${name}${suffix}`), join(dir, `${name}${suffix}`), constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    }
    await writeRescue(dir);
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return { dir, name: basename(dir) };
}

/** Removes the rescue console files from `dest`. */
export async function removeRescue(dest, platform = process.platform) {
  for (const name of rescueFiles(platform)) await rm(join(dest, name), { force: true });
}

// ---------- Terminal console ----------

const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const when = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/** The rescue console: a numbered menu on `input`/`output`. `folder` is the backup folder, `home` the dsh home. */
export async function rescueConsole({ folder, home, input = process.stdin, output = process.stdout }) {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const say = (text = '') => output.write(`${text}\n`);
  const ask = async (question) => { output.write(question); const { value, done } = await lines.next(); return done ? null : value.trim(); };
  const pick = async (archives) => {
    if (archives.length === 0) { say('There is no backup in this folder.'); return undefined; }
    archives.forEach((a, i) => say(`  ${i + 1}) ${when(a.at)}  ${a.kind === 'backup' ? '' : `(${a.kind}) `}${size(a.size)}  ${a.name}`));
    const answer = await ask('Backup number (Return = cancel): ');
    const n = Number(answer);
    return Number.isInteger(n) && n >= 1 && n <= archives.length ? archives[n - 1] : undefined;
  };
  const closedDsh = async () => {
    const pid = await runningDsh(home);
    if (pid === undefined) return true;
    say(`dsh is running (process ${pid}). Quit dsh, then try again.`);
    say(`If dsh is not running, remove ${hostFile(home, pid)} and try again.`);
    return false;
  };
  const locked = async (op, fn) => {
    let release;
    try { release = await takeLock(folder, op); } catch (error) { say(String(error.message)); return; }
    try { await fn(); } catch (error) { say(`Failed: ${error?.message ?? error}`); } finally { await release(); }
  };
  say('Composer Plus rescue console');
  say(`Backup folder: ${folder}`);
  say(`dsh home:      ${home}`);
  for (;;) {
    say('');
    say('1) List backups');
    say('2) Check a backup');
    say('3) Restore a backup (quit dsh first)');
    say('4) Check session logs');
    say('5) Repair session logs (quit dsh first)');
    say('0) Quit');
    const choice = await ask('Choose: ');
    if (choice === null || choice === '0' || choice === 'q') break;
    if (choice === '1') {
      const archives = await listArchives(folder);
      if (archives.length === 0) say('There is no backup in this folder.');
      for (const a of archives) say(`  ${when(a.at)}  ${a.kind === 'backup' ? '' : `(${a.kind}) `}${size(a.size)}  ${a.name}${a.masked?.length ? `  ${a.masked.length} masked` : ''}`);
    } else if (choice === '2') {
      const a = await pick(await listArchives(folder));
      if (a === undefined) continue;
      await locked('check', async () => {
        say('Reading the backup…');
        const r = await verifyArchive(folder, a.name, { home });
        say(r.ok ? `OK: ${r.entries} entries, ${size(r.bytes)}${r.checksum ? ', checksum matches' : ', no checksum file'}.` : `Not usable: ${r.reason}`);
      });
    } else if (choice === '3') {
      if (!(await closedDsh())) continue;
      const a = await pick(await listArchives(folder));
      if (a === undefined) continue;
      await locked('restore', async () => {
        say('Reading the backup…');
        const r = await verifyArchive(folder, a.name, { home });
        if (!r.ok) { say(`Not usable: ${r.reason}`); return; }
        say(`The backup has ${r.entries} entries, ${size(r.bytes)}.`);
        if (r.otherHome) say(`It comes from another computer or folder (${r.from.host ?? '?'}, ${r.from.dshHome}). Chats keep their old project paths.`);
        const missing = r.masked.filter((m) => !m.vault).map((m) => m.path);
        if (r.masked.length > 0) say(`${r.masked.length} masked file(s) come back from the vault on this computer${missing.length ? `; not in the vault (enter these again after the restore): ${missing.join(', ')}` : ''}.`);
        say(`Your current dsh home stays as ${home}.pre-restore-<time>. cache/, dsh-runtimes/ and node_modules move over from it.`);
        if (await ask('Type RESTORE to continue: ') !== 'RESTORE') { say('Cancelled. Nothing changed.'); return; }
        if (!(await closedDsh())) return;
        say('Restoring…');
        const done = await restore({ home, dest: folder, name: a.name });
        say(`Restored ${done.entries} entries into ${done.home}.`);
        if (done.aside) say(`The old dsh home is ${done.aside}. Remove it when dsh works.`);
        if (done.vaultMissing.length) say(`Enter these again (not in the vault): ${done.vaultMissing.join(', ')}`);
        if (done.unlinked.length) say(`These symbolic links could not be made: ${done.unlinked.join(', ')}`);
        if (done.install.length) {
          say(`These profiles need their plugin packages installed again: ${done.install.join(', ')}`);
          const pnpm = findPnpm(done.home);
          if (pnpm === undefined) say('pnpm was not found. In each profile folder, run: pnpm install');
          else if ((await ask('Install them now? (y/N): '))?.toLowerCase() === 'y') {
            for (const p of done.install) {
              const r2 = spawnSync(pnpm[0], [...pnpm.slice(1), 'install'], { cwd: join(done.home, 'profiles', p), stdio: 'inherit' });
              say(r2.status === 0 ? `Installed: ${p}` : `Install failed: ${p}. Run "pnpm install" in ${join(done.home, 'profiles', p)}.`);
            }
          }
        }
        say('Start dsh now.');
      });
    } else if (choice === '4' || choice === '5') {
      if (choice === '5' && !(await closedDsh())) continue;
      await locked(choice === '4' ? 'doctor' : 'repair', async () => {
        say('Checking session logs…');
        const scan = await scanSessions(home);
        say(`${scan.scanned} chat logs: ${scan.bad.length} damaged${scan.torn ? `, ${scan.torn} with a torn tail (dsh repairs these itself)` : ''}${scan.skipped ? `, ${scan.skipped} not checked` : ''}.`);
        for (const b of scan.bad) say(`  ${b.id}: ${b.reason}`);
        if (choice === '4' || scan.bad.length === 0) return;
        say('A repair puts back the copy from the newest backup that has a healthy one. Messages after that backup are not in it; the damaged file stays next to it.');
        if (await ask('Type REPAIR to continue: ') !== 'REPAIR') { say('Cancelled. Nothing changed.'); return; }
        const r = await repairSessions({ home, dest: folder, bad: scan.bad });
        for (const f of r.fixed) say(`  Repaired ${f.id} from ${f.from} (damaged copy: ${f.kept})`);
        for (const m of r.missing) say(`  No healthy copy of ${m.id} in the backups.`);
      });
    } else say('Type a number from the menu.');
  }
  rl.close();
}

/** pnpm: on PATH, else the copy in dsh's runtime folder (run with this Node.js). No shell: on Windows `pnpm.cmd`
 *  does not start without one, so Windows uses the runtime copy (the install call below has no shell either). */
function findPnpm(home) {
  if (spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status === 0) return ['pnpm'];
  const own = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs');
  return spawnSync(process.execPath, [own, '--version'], { stdio: 'ignore' }).status === 0 ? [process.execPath, own] : undefined;
}

/** `node composer-plus-rescue.mjs [--folder <backup folder>] [--home <dsh home>]` */
async function main(argv) {
  const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Composer Plus rescue console\nUsage: node composer-plus-rescue.mjs [--folder <backup folder>] [--home <dsh home>]\n'
      + 'Default folder: the folder of this file. Default dsh home: $DSH_HOME, else ~/.dsh.\n');
    return;
  }
  await rescueConsole({ folder: resolve(value('--folder') ?? dirname(SELF)), home: resolve(value('--home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')) });
}
let direct = false;
try { direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(SELF); } catch { direct = false; }
if (direct) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
