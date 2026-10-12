/**
 * Host half of dsh-composer-plus.
 * - Changes panel: read-only git status/diff for a session's working directory, served on the authenticated `/api` channel.
 * - Persistent Auto Review grants: per-session tool names saved under the dsh home, so "Allow for this chat" survives a restart.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-composer-plus';
export const inject = ['connection', 'subprocess', 'sessionQuery'];

export const CHANGES_PATH = '/api/composer-plus.changes';
export const DIFF_PATH = '/api/composer-plus.diff';
export const GRANTS_PATH = '/api/composer-plus.grants';
export const MODES = ['uncommitted', 'unstaged', 'staged', 'branch'];
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_FILES = 500;
const TIMEOUT_MS = 15000;

/** The git executable, resolved once per subprocess provider; the macOS Xcode stub counts as absent (it opens an installer). */
const gitPaths = new WeakMap();
async function gitPath(subprocess) {
  if (!gitPaths.has(subprocess)) gitPaths.set(subprocess, (async () => {
    const exe = await subprocess.resolveExecutable('git');
    if (process.platform !== 'darwin' || exe !== '/usr/bin/git') return exe;
    const probe = subprocess.spawn({ argv: ['/usr/bin/xcode-select', '-p'], cwd: homedir(), stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1000 });
    return (await probe.done).exitCode === 0 ? exe : null;
  })().catch(() => null));
  return gitPaths.get(subprocess);
}

/** Run read-only `git <args>` in cwd: argv only (never a shell), scrubbed config, no prompts, no optional locks. */
export async function runGit(subprocess, cwd, args, signal) {
  const git = await gitPath(subprocess);
  if (git === null) return { code: 127, stdout: '', truncated: false, stderr: 'git is not installed' };
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const handle = subprocess.spawn({
    argv: [git, ...args],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT }, stderr: { maxBytes: 16384 } },
    graceMs: 1000,
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  });
  const outcome = await handle.done;
  const out = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false };
  return { code: outcome.exitCode, stdout: out.text, truncated: out.lossy, stderr: handle.collected.stderr?.readFrom(0).text ?? '' };
}

/** `git diff` arguments for a mode, relative to `base` for branch mode. */
export function diffArgs(mode, base) {
  if (mode === 'staged') return ['diff', '--cached'];
  if (mode === 'unstaged') return ['diff'];
  if (mode === 'branch') return ['diff', base];
  return ['diff', 'HEAD'];
}

/** Parse `--numstat -z` (renames carry an empty path then old\0new). */
export function parseNumstat(text) {
  const files = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (head === '') continue;
    const [added, deleted, path] = head.split('\t');
    let file = path;
    let from;
    if (path === '') { from = parts[++i]; file = parts[++i]; }
    const binary = added === '-' && deleted === '-';
    files.push({ path: file, ...(from === undefined ? {} : { from }), added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary });
  }
  return files;
}

/** Repository facts and the changed files for one mode. Untracked files count as additions outside the staged view. */
export async function changes(subprocess, cwd, mode, signal) {
  const top = await runGit(subprocess, cwd, ['rev-parse', '--show-toplevel'], signal);
  if (top.code !== 0) return { repo: false };
  const root = top.stdout.trim();
  const branch = (await runGit(subprocess, root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)).stdout.trim();
  const up = await runGit(subprocess, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], signal);
  const upstream = up.code === 0 ? up.stdout.trim() : undefined;
  const hasHead = (await runGit(subprocess, root, ['rev-parse', '--verify', '-q', 'HEAD'], signal)).code === 0;
  let base;
  if (mode === 'branch') {
    if (upstream === undefined) return { repo: true, root, branch, mode, files: [], total: 0, noUpstream: true };
    const mb = await runGit(subprocess, root, ['merge-base', 'HEAD', upstream], signal);
    if (mb.code !== 0) return { repo: true, root, branch, upstream, mode, files: [], total: 0, noUpstream: true };
    base = mb.stdout.trim();
  }
  // A repository without commits has no HEAD: compare against the empty tree.
  const args = mode === 'uncommitted' && !hasHead ? ['diff', '--cached'] : diffArgs(mode, base);
  const stat = await runGit(subprocess, root, [...args, '--numstat', '-z', '-M', '--no-color', '--no-ext-diff'], signal);
  if (stat.code !== 0) throw new Error(`git diff failed: ${stat.stderr.trim()}`);
  const files = parseNumstat(stat.stdout);
  if (mode !== 'staged') {
    const untracked = await runGit(subprocess, root, ['ls-files', '--others', '--exclude-standard', '-z'], signal);
    for (const path of untracked.stdout.split('\0')) if (path !== '' && !files.some((f) => f.path === path)) files.push({ path, added: 0, deleted: 0, binary: false, untracked: true });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    repo: true, root, branch, ...(upstream === undefined ? {} : { upstream }), mode,
    files: files.slice(0, MAX_FILES), total: files.length,
    added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0),
  };
}

/** Unified diff of one listed file; untracked files diff against /dev/null. */
export async function fileDiff(subprocess, cwd, mode, path, signal) {
  const summary = await changes(subprocess, cwd, mode, signal);
  if (!summary.repo) return undefined;
  const file = summary.files.find((f) => f.path === path);
  if (file === undefined) return undefined; // only paths git itself listed: no arbitrary file reads
  if (file.untracked) {
    const r = await runGit(subprocess, summary.root, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', path], signal);
    return { path, patch: r.stdout, truncated: r.truncated, binary: file.binary };
  }
  let base;
  if (mode === 'branch') base = (await runGit(subprocess, summary.root, ['merge-base', 'HEAD', summary.upstream], signal)).stdout.trim();
  const hasHead = (await runGit(subprocess, summary.root, ['rev-parse', '--verify', '-q', 'HEAD'], signal)).code === 0;
  const args = mode === 'uncommitted' && !hasHead ? ['diff', '--cached'] : diffArgs(mode, base);
  const paths = file.from === undefined ? [path] : [file.from, path];
  const r = await runGit(subprocess, summary.root, [...args, '-M', '--no-color', '--no-ext-diff', '--', ...paths], signal);
  return { path, patch: r.stdout, truncated: r.truncated, binary: file.binary };
}

/** Grants file: { [sessionId]: string[] } of exact tool names allowed without asking. */
export function grantsStore(file) {
  let queue = Promise.resolve();
  const read = async () => {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch { return {}; }
  };
  // Serialize writes and replace atomically so a crash never leaves a half-written file.
  const update = (fn) => (queue = queue.then(async () => {
    const data = await read();
    fn(data);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await rename(tmp, file);
    return data;
  }));
  return {
    read,
    grant: (sessionId, tool) => update((d) => { d[sessionId] = [...new Set([...(d[sessionId] ?? []), tool])]; }),
    revoke: (sessionId) => update((d) => { delete d[sessionId]; }),
  };
}

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const isText = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function apply(ctx) {
  /** The session's own working directory (the endpoint never takes a path from the browser) and its newest
   * `workspace/changes` event, which dsh's own review tab opens as "Last turn". */
  const sessionFacts = async (sessionId, signal) => {
    const observation = await ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
    try {
      let lastTurn;
      const events = observation.events;
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type === 'workspace/changes' && Number.isSafeInteger(e.data?.turn)) { lastTurn = { seq: e.seq, turn: e.data.turn }; break; }
      }
      return { cwd: observation.header.cwd, lastTurn };
    } finally { observation[Symbol.dispose]?.(); }
  };
  const cwdOf = async (sessionId, signal) => (await sessionFacts(sessionId, signal)).cwd;
  const params = (request) => {
    const q = new URL(request.url).searchParams;
    const sessionId = q.get('sessionId');
    const mode = q.get('mode') ?? 'uncommitted';
    return isText(sessionId) && MODES.includes(mode) ? { sessionId, mode, path: q.get('path') } : undefined;
  };
  ctx.connection.fetch.register({
    path: CHANGES_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      const p = params(request);
      if (p === undefined) return json({ error: 'bad request' }, 400);
      try {
        const { cwd, lastTurn } = await sessionFacts(p.sessionId, request.signal);
        const extra = lastTurn === undefined ? {} : { lastTurn };
        if (cwd === undefined) return json({ repo: false, ...extra });
        return json({ ...(await changes(ctx.subprocess, cwd, p.mode, request.signal)), ...extra });
      } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
    },
  });
  ctx.connection.fetch.register({
    path: DIFF_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      const p = params(request);
      if (p === undefined || !isText(p.path, 4096)) return json({ error: 'bad request' }, 400);
      try {
        const cwd = await cwdOf(p.sessionId, request.signal);
        const diff = cwd === undefined ? undefined : await fileDiff(ctx.subprocess, cwd, p.mode, p.path, request.signal);
        return diff === undefined ? json({ error: 'not found' }, 404) : json(diff);
      } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
    },
  });
  const store = grantsStore(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-composer-plus', 'grants.json'));
  ctx.connection.fetch.register({
    path: GRANTS_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(await store.read());
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (body?.action === 'grant' && isText(body.sessionId) && isText(body.tool)) return json(await store.grant(body.sessionId, body.tool));
      if (body?.action === 'revoke' && isText(body.sessionId)) return json(await store.revoke(body.sessionId));
      return json({ error: 'bad request' }, 400);
    },
  });
}
