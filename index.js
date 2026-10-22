/**
 * Host half of dsh-composer-plus.
 * - Message-free Continue: authenticated resume through public agent lifecycle hooks.
 * - Changes panel: read-only git status/diff for a session's working directory, served on the authenticated `/api` channel.
 * - Persistent Auto Review grants: per-session tool names saved under the dsh home, so "Allow for this chat" survives a restart.
 * - Update check: the latest GitHub release, offered only once npm serves that exact version (the client installs it
 *   through dsh's own plugin manager).
 * - Mobile connect (Tether): runs the iPhone gateway (tether/gateway/server.mjs) in this process while the user switches it
 *   on; the switch is saved under the dsh home and is off by default.
 * - Resume after restart: remembers the chats that were running when dsh quit and continues them at the next start; off by
 *   default (it starts model turns without a click).
 * - Feature ideas: on a click, one model call (the chat's own model) reads a short brief of the chat's project and returns
 *   feature ideas as cards. Read-only: no chat message, nothing written to the project. Ideas saved for later are kept
 *   per project folder under the dsh home.
 */
import { constants, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { createGateway } from './tether/gateway/server.mjs';

export const name = 'dsh-composer-plus';
export const inject = ['connection', 'subprocess', 'sessionQuery', 'sessionController'];

export const CHANGES_PATH = '/api/composer-plus.changes';
export const DIFF_PATH = '/api/composer-plus.diff';
export const GRANTS_PATH = '/api/composer-plus.grants';
export const CONTINUE_PATH = '/api/composer-plus.continue';
export const UPDATE_PATH = '/api/composer-plus.update';
export const SHOT_PATH = '/api/composer-plus.shot';
export const MOBILE_PATH = '/api/composer-plus.mobile';
export const RESUME_PATH = '/api/composer-plus.resume';
export const IDEAS_PATH = '/api/composer-plus.ideas';
export const LATER_PATH = '/api/composer-plus.later';
export const HISTORY_PATH = '/api/composer-plus.idea-history';
export const CONTENT_SEARCH_PATH = '/api/composer-plus.content-search';
export const ROLLBACK_PATH = '/api/composer-plus.rollback';
export const DELETE_CHAT_PATH = '/api/composer-plus.delete-chat';
export const QUEUE_MOVE_PATH = '/api/composer-plus.queue-move';
export const PREDICT_PATH = '/api/composer-plus.predict';
/** Feature screenshots shipped in assets/features/<id>.webp; only these ids are served (no path input). */
export const SHOTS = ['changesPanel', 'featureIdeas', 'projectStatus', 'recentProjects', 'collapseProjects', 'statusOrder', 'notifications', 'allowForChat', 'continueButton', 'resumeAfterRestart', 'inputHistory', 'planToggle', 'keepFocus',
  'queueReorder', 'mobileConnect', 'copyDeeplink', 'copyProjectPath', 'projectPicker', 'nextPrediction', 'language', 'autoUpdate', 'contentSearch', 'turnRollback', 'deleteChat', 'projectName'];
const PACKAGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const NPM_NAME = 'dsh-composer-plus';
const RELEASES_URL = 'https://api.github.com/repos/furkancak1r/dsh-composer-plus/releases/latest';
const CONTINUE_SOURCE = 'composer-plus-continue';
const CONTINUE_TEXT = 'The previous turn stopped before it finished (it was interrupted or failed). Continue the task from where it stopped. Do not repeat completed work.';
const continueMessage = () => Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: CONTINUE_TEXT })]),
  source: Object.freeze({ kind: 'composer-plus-resume', form: 'snapshot' }) });
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

/** Run read-only `git <args>` in cwd: argv only (never a shell), scrubbed config, no prompts, no optional locks.
 * `env` adds variables (Turn rollback points git at its own store); `stdin` is sent as the child's input. */
export async function runGit(subprocess, cwd, args, signal, { env = {}, stdin, timeoutMs = TIMEOUT_MS } = {}) {
  const git = await gitPath(subprocess);
  if (git === null) return { code: 127, stdout: '', truncated: false, stderr: 'git is not installed' };
  const timeout = AbortSignal.timeout(timeoutMs);
  const handle = subprocess.spawn({
    argv: [git, ...args],
    cwd,
    stdio: { stdin: stdin === undefined ? 'ignore' : { data: stdin }, stdout: { maxBytes: MAX_OUTPUT }, stderr: { maxBytes: 16384 } },
    graceMs: 1000,
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env },
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

/** `1.2.3` / `v1.2.3` -> [1, 2, 3]; anything else (pre-releases, ranges) is not an update target. */
export const parseVersion = (text) => {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(text ?? '').trim());
  return m === null ? undefined : m.slice(1).map(Number);
};
export const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
/** Latest GitHub release vs this copy. `managed` is false for a renamed or linked local copy, which pnpm can't upgrade. */
export async function checkUpdate(fetchImpl = fetch, pkg = PACKAGE, signal) {
  const current = parseVersion(pkg.version);
  const managed = pkg.name === NPM_NAME && current !== undefined;
  const timeout = AbortSignal.timeout(10000);
  const opts = { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) };
  const response = await fetchImpl(RELEASES_URL, { ...opts, headers: { accept: 'application/vnd.github+json', 'user-agent': NPM_NAME } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = await response.json();
  const latest = parseVersion(release?.tag_name);
  if (latest === undefined) throw new Error('latest release has no x.y.z tag');
  const info = { name: NPM_NAME, current: pkg.version, latest: latest.join('.'), managed, newer: false,
    url: typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : undefined };
  if (current === undefined || !newer(latest, current)) return info;
  // A release can go out before `npm publish`; offer only what pnpm can install.
  const npm = await fetchImpl(`https://registry.npmjs.org/${NPM_NAME}/${info.latest}`, opts);
  return { ...info, newer: npm.ok };
}

/** A Host switch (Mobile connect, Content search): `{ on }` in an owner-only JSON file. A missing or unreadable file, or
 * any value other than the opposite of `fallback`, reads as `fallback`. */
export function mobileSwitch(file, fallback = false) {
  return {
    read: async () => { try { const on = JSON.parse(await readFile(file, 'utf8'))?.on; return fallback ? on !== false : on === true; } catch { return fallback; } },
    write: async (on) => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ on }), { mode: 0o600 });
      await rename(tmp, file);
    },
  };
}

/** Mobile connect: one gateway at a time. Start and stop calls run in order, so a fast toggle never leaves two gateways or a
 * half-closed one. `upstreamUrl` gives dsh's authenticated loopback URL; it is asked again at each DSH login. */
export function mobileGateway({ upstreamUrl, dir, make = createGateway, retryMs = 300 }) {
  let gateway, admin, error, closed = false, queue = Promise.resolve();
  const run = (fn) => (queue = queue.then(fn, fn));
  // A plugin reload starts the new gateway while the old one still closes its pairing page: wait for the port (about 3 s).
  const listenAdmin = async (g) => {
    for (let attempt = 1; ; attempt++) {
      try { return await g.listenAdmin(); } catch (e) {
        if (e?.code !== 'EADDRINUSE' || attempt >= 10) throw e;
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
  };
  const stop = async () => {
    const g = gateway;
    gateway = undefined; admin = undefined;
    if (g !== undefined) await g.close().catch(() => {});
  };
  return {
    start: () => run(async () => {
      if (gateway !== undefined || closed) return;
      error = undefined;
      try {
        gateway = make({ dir, upstreamUrl });
        admin = `http://127.0.0.1:${await listenAdmin(gateway)}/`;
        await gateway.start();
      } catch (e) { error = String(e?.message ?? e); if (admin === undefined) await stop(); }
    }),
    stop: () => run(stop),
    /** Plugin unload: stop, and ignore any start that comes later. */
    close: () => { closed = true; return run(stop); },
    state: () => {
      const running = gateway?.state().running === true;
      // The gateway retries by itself (for example when Wi-Fi comes back): a running gateway has no error to show.
      return { running, admin, ...(error === undefined || running ? {} : { error }) };
    },
  };
}

/** Resume after restart: `{ on, sessions: [{ id, at }] }` in one owner-only JSON file. A missing or broken file is off. */
export function resumeStore(file) {
  let queue = Promise.resolve();
  return {
    async read() {
      try {
        const data = JSON.parse(await readFile(file, 'utf8'));
        const sessions = Array.isArray(data?.sessions) ? data.sessions.filter((s) => isText(s?.id) && Number.isFinite(s?.at)) : [];
        return { on: data?.on === true, sessions };
      } catch { return { on: false, sessions: [] }; }
    },
    /** Writes run in order, each replacing the file atomically, so a quit in the middle never leaves a half-written file. */
    write(data) {
      const done = queue.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
        await rename(tmp, file);
      });
      queue = done.catch(() => {});
      return done;
    },
    flush: () => queue,
  };
}

/** At most this many chats continue at one start (newest first): a safety cap, not a queue. */
export const RESUME_MAX = 20;
/** A turn end that dsh caused, not the user: a quit (`aborted`, cause `disposed`; the goal driver's own shutdown cancels a
 * goal round with cause `parent`) or a crash (`interrupted`, written when dsh opens the chat again). */
export const stoppedByDsh = (end) => end?.kind === 'interrupted' || (end?.kind === 'aborted' && ['disposed', 'parent'].includes(end.reason?.kind));

/** Resume after restart. `status()` and `turnEnd()` follow the top-level chats; `wake()` continues, once per start, the chats
 * that were running when dsh stopped. A chat stays listed while it runs and when dsh stops its turn; any other turn end
 * (done, failed, stopped by you) removes it. The list is saved at each change, so a crash keeps it too. */
export function resumeTracker({ store, isRoot, running = () => [], wakeOne, log = () => {}, now = Date.now }) {
  let on = false;
  let closed = false;
  let carried = []; // the previous run's chats, until wake() takes them
  const live = new Map(); // id → time it started running
  const ends = new Map(); // id → newest turn end of this run; null while a turn is open
  const list = () => [...carried.filter((s) => !live.has(s.id)), ...[...live].map(([id, at]) => ({ id, at }))];
  const save = () => { if (!closed) store.write({ on, sessions: list() }).catch((error) => log(`resume list not saved: ${error?.message ?? error}`)); };
  // Chats already running (switched on mid-turn, or a plugin reload) are tracked from now on.
  const adopt = () => {
    try { for (const id of running()) if (!live.has(id)) { live.set(id, now()); ends.set(id, null); } } catch { /* services gone */ }
  };
  const ready = store.read().then((data) => { on = data.on; carried = data.on ? data.sessions : []; if (on) adopt(); });
  return {
    ready,
    isOn: () => on,
    /** Save the switch; a failed save changes nothing. Switching off forgets the list. */
    async setOn(next) {
      await ready;
      const before = { on, carried, live: [...live] };
      on = next;
      if (next) adopt(); else { carried = []; live.clear(); }
      try { await store.write({ on, sessions: list() }); } catch (error) {
        on = before.on; carried = before.carried; live.clear(); for (const [id, at] of before.live) live.set(id, at);
        throw error;
      }
    },
    status(agent, status) {
      const end = ends.get(agent.id);
      if (status !== 'running') ends.delete(agent.id);
      if (!on || closed || !isRoot(agent)) return;
      if (status === 'running') { if (!live.has(agent.id)) { live.set(agent.id, now()); save(); } }
      // An open turn without an end: the shutdown could not write it (dsh 0.2.0-rc.2 closes it as `interrupted` at the next
      // start). Keep the chat; wakeSession() reads the saved log before it continues anything.
      else if (end !== null && !stoppedByDsh(end) && live.delete(agent.id)) save();
    },
    turnStart(id) { ends.set(id, null); },
    turnEnd(id, reason) { ends.set(id, reason); },
    /** Plugin unload: no more writes (dsh's shutdown makes every chat idle); waits for the last write. */
    close() { closed = true; return store.flush(); },
    async wake() {
      await ready;
      const queue = [...carried].sort((a, b) => b.at - a.at).slice(0, RESUME_MAX);
      if (queue.length === 0) return [];
      carried = [];
      save(); // forget them first: a crash while waking never continues the same chats twice
      const results = [];
      for (const { id } of queue) {
        if (closed || !on) break;
        try { results.push({ id, result: await wakeOne(id) }); } catch (error) { results.push({ id, result: 'failed' }); log(`resume ${id} failed: ${error?.message ?? error}`); }
      }
      return results;
    },
  };
}

/** Continue one chat after a restart, if dsh (not the user) stopped its last turn: the chat gets the same hidden "continue"
 * step as One-click Continue. When the stopped turn was a goal round, the goal is armed again instead (dsh disarms goals at
 * every start and waits for `/goal resume`), and dsh's goal driver starts the next round, so the model can still mark the
 * goal complete. A goal is never armed for an ordinary turn: dsh does not keep whether it was armed before the quit. */
export async function wakeSession({ sessionController, sessionQuery, goals, archived = () => false }, id) {
  if (archived(id)) return 'archived';
  const found = await sessionController.resolveAgent(id); // opens the chat; a crashed turn is closed as `interrupted` here
  if ('error' in found) return 'unavailable';
  const { agent } = found;
  if (agent.status !== 'idle') return 'busy';
  const observation = await sessionQuery.observeSession(id, { projectionMode: 'none' });
  let start, end, goalRound;
  try {
    const events = observation.events;
    end = events.findLast((e) => e.type === 'turn/start' || e.type === 'turn/end');
    start = events.findLast((e) => e.type === 'turn/start');
    goalRound = start !== undefined && events.some((e) => e.seq > start.seq && e.type === 'user/message' && e.data?.source?.kind === 'goal');
  } finally { observation[Symbol.dispose]?.(); }
  if (end?.type !== 'turn/end' || !stoppedByDsh(end.data?.reason)) return 'skipped';
  let goal;
  try { goal = goalRound ? goals?.get(agent) : undefined; } catch { goal = undefined; }
  // A pause during the stopped turn would have ended it as stopped by the user; so a goal paused after that turn started was
  // paused by dsh's shutdown (its goal driver pauses a round it cancels).
  if (goal !== undefined && ((goal.phase === 'active' && goal.activation !== 'armed') || (goal.phase === 'paused' && goal.updatedAt >= start.time))) {
    try { goals.resume(agent, { id: goal.id, revision: goal.revision }); return 'goal'; } catch { /* no goal rounds left: continue the turn */ }
  }
  agent.steer({ id: randomUUID(), role: 'user', content: [], source: { kind: CONTINUE_SOURCE } });
  return 'continued';
}

/** Feature ideas: at most this many cards per call; the brief and the answer are bounded too. */
export const IDEAS_MAX = 8;
const BRIEF_FILE_BYTES = 6000;
const BRIEF_MAX = 16000;
// A reasoning model counts its thinking in the output cap. A route that forces a high effort (AIProxy's aiproxy-max used
// about 7.7k tokens and 72 s for 8 ideas) was cut at 4000 tokens with `output_limit`; this cap leaves room for the thinking.
const IDEAS_TIMEOUT_MS = 180000;
const IDEAS_MAX_TOKENS = 32000;
/** Top-level names that never go into the brief: secrets and bulky generated folders. */
const BRIEF_SKIP = /^(\.env.*|.*\.(pem|key|p12|pfx)|id_[a-z0-9]+|\.git|node_modules|dist|build|coverage|\.next|\.venv|venv|__pycache__|\.DS_Store)$/i;
const BRIEF_FILES = ['README.md', 'readme.md', 'README', 'AGENTS.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json', 'pom.xml'];

/** The first `max` bytes of one regular file whose real path starts with `prefix` (the chat folder's real path and a
 * separator), or undefined. A symlink counts only when it ends inside the folder. A FIFO or device is never opened;
 * O_NOFOLLOW and O_NONBLOCK keep a file swapped in after the check from escaping or blocking. */
async function head(path, max, prefix) {
  let file;
  try {
    const real = await realpath(path);
    if (!real.startsWith(prefix) || !(await stat(real)).isFile()) return undefined;
    file = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await file.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await file.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return undefined; } finally { await file?.close().catch(() => {}); }
}

/** A short, read-only picture of a project for the idea prompt: top-level entries, the main docs and manifests (heads
 * only), and the latest commits. Secrets files and generated folders are skipped; the whole brief is bounded. */
export async function projectBrief(cwd, { subprocess, signal } = {}) {
  const parts = [];
  try {
    const entries = (await readdir(cwd, { withFileTypes: true })).filter((e) => !BRIEF_SKIP.test(e.name)).slice(0, 80);
    parts.push(`Top-level entries:\n${entries.map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n')}`);
  } catch { /* unreadable folder: the brief says less */ }
  const seen = new Set();
  const prefix = await realpath(cwd).then((real) => (real.endsWith(sep) ? real : real + sep), () => undefined);
  for (const name of prefix === undefined ? [] : BRIEF_FILES) {
    const text = await head(join(cwd, name), BRIEF_FILE_BYTES, prefix);
    // Case-insensitive file systems answer README.md and readme.md with the same file.
    if (text === undefined || text.trim() === '' || seen.has(text)) continue;
    seen.add(text);
    parts.push(`--- ${name} (first ${BRIEF_FILE_BYTES} bytes) ---\n${text}`);
  }
  if (subprocess !== undefined) {
    try {
      const log = await runGit(subprocess, cwd, ['log', '--oneline', '--no-color', '-15'], signal);
      if (log.code === 0 && log.stdout.trim() !== '') parts.push(`Latest commits:\n${log.stdout.trim()}`);
    } catch { /* not a repository, or git is missing */ }
  }
  return parts.join('\n\n').slice(0, BRIEF_MAX);
}

const IDEAS_SYSTEM = `You suggest new features for a software project. Read the project brief and suggest ${IDEAS_MAX} specific features that fit this project and its users. Prefer small, useful, concrete features over rewrites. Do not suggest a feature that the brief shows the project already has.
Answer with one JSON array only, with no other text. Each element is an object with these keys:
- "title": the feature name, at most 8 words.
- "summary": what the feature does, 1 or 2 sentences.
- "why": the benefit for the users, 1 sentence.
- "effort": one of "small", "medium", "large". Always write this value in English.`;
/** A locale id such as "tr" or "pt-BR"; anything else is ignored, so the prompt never takes free text from the browser. */
const LOCALE_ID = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/i;
/** The language line of the idea prompt: the user's UI language when the client sends one, else the brief's language. */
export function ideasLanguage(locale) {
  if (typeof locale !== 'string' || !LOCALE_ID.test(locale)) return 'Write "title", "summary" and "why" in the language of the project brief.';
  let name;
  try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(locale); } catch { name = undefined; }
  return `Write "title", "summary" and "why" in ${name && name !== locale ? `${name} (${locale})` : locale}, also when the project brief uses another language.`;
}

const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** One idea, cleaned and bounded (from the model or the browser), or undefined without a title and a summary. */
const ideaFrom = (item) => {
  const title = clip(item?.title, 120);
  const summary = clip(item?.summary, 600);
  if (title === '' || summary === '') return undefined;
  const why = clip(item?.why, 300);
  const effort = ['small', 'medium', 'large'].includes(item?.effort) ? item.effort : undefined;
  return { title, summary, ...(why === '' ? {} : { why }), ...(effort === undefined ? {} : { effort }) };
};
/** Ideas from the model's answer: the first JSON array in it (a code fence is fine), each idea cleaned and bounded. Throws
 * when the answer holds no usable idea. */
export function parseIdeas(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  let list;
  try { list = start === -1 || end <= start ? undefined : JSON.parse(raw.slice(start, end + 1)); } catch { list = undefined; }
  if (!Array.isArray(list)) throw new Error('the model did not answer with a list of ideas');
  const ideas = [];
  for (const item of list) {
    const idea = ideaFrom(item);
    if (idea === undefined) continue;
    ideas.push({ id: randomUUID(), ...idea });
    if (ideas.length === IDEAS_MAX) break;
  }
  if (ideas.length === 0) throw new Error('the model answered without a usable idea');
  return ideas;
}

/** The chat's own model: the newest logged request header, else dsh's default model. */
function ideasRoute(events, defaultModel) {
  const header = events.findLast((e) => e.type === 'request/header')?.data?.header?.config;
  if (isText(header?.provider) && isText(header?.model)) return { provider: header.provider, model: header.model };
  const selection = defaultModel?.currentSelection?.();
  if (isText(selection?.provider) && isText(selection?.model)) return { provider: selection.provider, model: selection.model };
  return undefined;
}

/** Same idea title: case and spaces do not count. */
const titleKey = (title) => String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
/** Earlier ideas per project, newest first: everything the model suggested there, `started` once a chat started for it.
 * At most this many; the oldest leave first. The model is told not to suggest them again. */
export const HISTORY_MAX = 200;
const AVOID_SHOWN = 120;
export function ideaHistory(store) {
  const entry = (i, extra = {}) => ({ id: randomUUID(), title: i.title, summary: i.summary, ...(i.why ? { why: i.why } : {}), ...(i.effort ? { effort: i.effort } : {}), at: Date.now(), ...extra });
  return {
    list: store.list,
    remove: store.remove,
    clear: (cwd) => store.change(cwd, () => []),
    /** New ideas go on top; a title that is already there stays where it is. */
    record: (cwd, ideas) => store.change(cwd, (list) => {
      const known = new Set(list.map((i) => titleKey(i.title)));
      const fresh = ideas.filter((i) => !known.has(titleKey(i.title)) && known.add(titleKey(i.title))).map((i) => entry(i));
      return [...fresh, ...list].slice(0, HISTORY_MAX);
    }),
    /** A chat started for these ideas (also ideas saved for later before the history existed). */
    started: (cwd, ideas) => store.change(cwd, (list) => {
      const keys = new Set(ideas.map((i) => titleKey(i.title)));
      const known = new Set(list.map((i) => titleKey(i.title)));
      const missing = ideas.filter((i) => !known.has(titleKey(i.title))).map((i) => entry(i, { started: true }));
      return [...missing, ...list.map((i) => (keys.has(titleKey(i.title)) ? { ...i, started: true } : i))].slice(0, HISTORY_MAX);
    }),
  };
}

/** One model call for feature ideas about the chat's project, written in `locale` (the dsh UI language) when given.
 * `avoid(cwd)` names the earlier ideas (history and the Later list): the model is told to skip them, and a repeated title
 * is dropped. `record(cwd, ideas)` keeps the new ones. Read-only for the project: no chat message, nothing written there. */
export async function suggestIdeas({ llm, sessionQuery, subprocess, defaultModel, avoid, record }, sessionId, signal, locale) {
  const observation = await sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
  let cwd, route;
  try { cwd = observation.header?.cwd; route = ideasRoute(observation.events ?? [], defaultModel); } finally { observation[Symbol.dispose]?.(); }
  if (!isText(cwd, 4096)) throw Object.assign(new Error('this chat has no project folder'), { status: 409 });
  if (route === undefined) throw Object.assign(new Error('no model is selected'), { status: 409 });
  const brief = await projectBrief(cwd, { subprocess, signal });
  const earlier = [...new Set((await avoid?.(cwd) ?? []).map((title) => clip(title, 120)).filter(Boolean))];
  const seen = new Set(earlier.map(titleKey));
  // The model sees the newest titles only (about 15 kB at most, like the brief); the filter below checks all of them.
  const shown = earlier.slice(0, AVOID_SHOWN);
  const asked = shown.length === 0 ? '' : `\n\nEarlier ideas for this project. Do not suggest any of them again, also not under another name:\n${shown.map((title) => `- ${title}`).join('\n')}`;
  const timeout = AbortSignal.timeout(IDEAS_TIMEOUT_MS);
  const callSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const call = await llm.prepareCall(route, callSignal, (controls, model) => {
    // The lowest reasoning effort keeps the answer fast; the model only reads a short brief. The output cap never goes
    // above the model's own default.
    const first = model?.reasoning?.efforts?.[0];
    const cap = Number.isSafeInteger(model?.defaultMaxTokens) && model.defaultMaxTokens > 0 ? Math.min(IDEAS_MAX_TOKENS, model.defaultMaxTokens) : IDEAS_MAX_TOKENS;
    return { ...controls, maxTokens: cap, ...(first === undefined ? {} : { reasoningEffort: first.id }) };
  });
  let text = '';
  let finish;
  for await (const chunk of call.stream({ ...call.config, system: `${IDEAS_SYSTEM}\n${ideasLanguage(locale)}`, signal: callSignal,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Project folder name: ${cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ''}\n\n${brief}${asked}` }] }] })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message || `the model call ended: ${finish.kind}`);
  const ideas = parseIdeas(text).filter((i) => !seen.has(titleKey(i.title)) && seen.add(titleKey(i.title)));
  if (ideas.length === 0) throw new Error('the model suggested only earlier ideas; try again');
  // ponytail: a failed history write does not hide the new cards; they can come again next time.
  try { await record?.(cwd, ideas); } catch { /* best-effort */ }
  return { ideas, model: route.model };
}

/** The first message of the chat that works on an accepted idea. With `plan` (the default) it starts in plan mode, so
 * nothing changes before the user approves the plan; without it the model builds the feature at once. */
export function ideaPrompt(idea, plan = true) {
  // Plan all (Later list): several ideas in one plan-mode chat, so shared code changes once and in a working order.
  if (Array.isArray(idea)) {
    if (idea.length === 1) return ideaPrompt(idea[0], plan);
    return [`Implement these ${idea.length} features in this project, as one plan:`, '',
      ...idea.flatMap((i, n) => [`${n + 1}. ${i.title}`, i.summary, ...(i.why ? [`Why: ${i.why}`] : []), '']),
      'First read the related code. Then plan one set of changes that delivers all of them: make shared parts once, use an order that keeps the project working after each step, and name the checks that prove each feature works.'].join('\n');
  }
  return [`Implement this feature in this project: ${idea.title}`, '', idea.summary, ...(idea.why ? ['', `Why: ${idea.why}`] : []), '',
    plan ? 'First read the related code. Then plan the smallest change that delivers this feature, with the checks that prove it works.'
      : 'First read the related code. Then make the smallest change that delivers this feature, and run the checks that prove it works.'].join('\n');
}

/** The chat's own project folder, from its session header (the browser never sends a path). */
async function chatFolder(sessionQuery, sessionId, signal) {
  const observation = await sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
  let cwd;
  try { cwd = observation.header?.cwd; } finally { observation[Symbol.dispose]?.(); }
  if (!isText(cwd, 4096) || !isAbsolute(cwd)) throw Object.assign(new Error('this chat has no project folder'), { status: 409 });
  return cwd;
}

/** Start a new chat in the same project (the same sidebar group as the source chat) for one accepted idea, and enter plan
 * mode with the idea as the request. When the profile has no /plan command, or /plan fails, the idea goes as an ordinary
 * message. `{ plan: false }` (Build now) skips plan mode: the idea goes as an ordinary message that asks for the change.
 * `idea` can be a list (Plan all): one chat plans all of them. Returns the new chat, whether it plans, and the project folder. */
export async function startIdeaChat({ sessionController, sessionQuery, commands, workspaces }, sessionId, idea, signal = new AbortController().signal, { plan: wantPlan = true } = {}) {
  const cwd = await chatFolder(sessionQuery, sessionId, signal);
  let workspace;
  try { workspace = workspaces?.list?.().find((w) => w.sessionIds.includes(sessionId)); } catch { workspace = undefined; }
  const { sessionId: created } = await sessionController.create(workspace === undefined ? { cwd } : { workspaceId: workspace.id });
  const found = await sessionController.resolveAgent(created);
  if ('error' in found) throw new Error('the new chat could not start');
  const text = ideaPrompt(idea, wantPlan);
  let planned;
  try { planned = !wantPlan || commands?.find?.(found.agent, 'plan') === undefined ? undefined : await commands.execute(found.agent, `/plan ${text}`, [], signal); } catch { planned = undefined; }
  const plan = planned?.result?.kind === 'success';
  if (!plan) await sessionController.prompt({ requestId: randomUUID(), sessionId: created, mode: 'queue', content: [{ type: 'text', text }] }, signal);
  return { sessionId: created, plan, cwd };
}

/** Ideas saved for later: at most this many per project. A full list refuses a new idea; it never drops an old one. */
export const LATER_MAX = 50;
/** Ideas saved for later, per project folder: `{ [cwd]: [{ id, title, summary, why?, effort?, at }] }` (newest first) in
 * one owner-only JSON file. A missing file is an empty list. A broken file throws, so no write replaces it (no data loss).
 * Reads and writes run in order; each write replaces the file atomically. */
export function laterStore(file) {
  let queue = Promise.resolve();
  const run = (fn) => { const done = queue.then(fn); queue = done.catch(() => {}); return done; };
  const read = async () => {
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('the saved ideas file is not a JSON object');
    return data;
  };
  const clean = (list) => (Array.isArray(list) ? list.filter((i) => isText(i?.id) && isText(i?.title, 120) && isText(i?.summary, 600)) : []);
  // Keys are absolute folder paths only, so a key such as `__proto__` never reaches the object.
  const folder = (cwd) => { if (!isText(cwd, 4096) || !isAbsolute(cwd)) throw Object.assign(new Error('this chat has no project folder'), { status: 409 }); return cwd; };
  const update = (cwd, fn) => run(async () => {
    const data = await read();
    const list = fn(clean(data[folder(cwd)]));
    if (list.length === 0) delete data[cwd]; else data[cwd] = list;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await rename(tmp, file);
    return list;
  });
  return {
    list: (cwd) => run(async () => clean((await read())[folder(cwd)])),
    /** Add a cleaned idea at the top; the same title (any case) is not added twice. */
    add: (cwd, idea) => update(cwd, (list) => {
      if (list.some((i) => i.title.toLowerCase() === idea.title.toLowerCase())) return list;
      if (list.length >= LATER_MAX) throw Object.assign(new Error(`a project keeps at most ${LATER_MAX} ideas for later`), { status: 409 });
      return [{ id: randomUUID(), ...idea, at: Date.now() }, ...list];
    }),
    /** One id, or a list of ids in one write. */
    remove: (cwd, id) => update(cwd, (list) => list.filter((i) => (Array.isArray(id) ? !id.includes(i.id) : i.id !== id))),
    /** Any change to one project's list, in order with the others (the idea history uses it). */
    change: update,
  };
}

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const isText = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;
const refused = (message, status = 409) => Object.assign(new Error(message), { status });

/* Turn rollback. The idea of one appended marker message that hides a span of the chat from the model (dsh's own
 * `surfaceOp: replace`, as `/compact` uses) comes from dsh-rewind-plugin (MIT, SiriLee); the code here is new. */
export const ROLLBACK_SOURCE = 'composer-plus-rollback';
const ROLLBACK_TEXT = '(empty message)';
/** Snapshots kept per chat: the newest user messages that a rollback can still bring the files back to. */
export const SNAPSHOT_MAX = 50;
const SNAPSHOT_TIMEOUT_MS = 30000;
/** A tool call waits at most this long for its chat's snapshot (a FIFO named .gitignore makes git wait until its time-out). */
const TOOL_WAIT_MS = 10000;
/** Every store command: the system and global git config are never read and these keys are fixed, so no filter, fsmonitor
 * or line-ending rule runs; with the store's info/attributes ("-text -filter") files go in and come out byte for byte. */
const STORE_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=true', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null'];
const storeEnv = (store, workTree, index) => ({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_DIR: store, GIT_WORK_TREE: workTree, GIT_INDEX_FILE: index });
const safeSegment = (id) => encodeURIComponent(id).replace(/[.%*]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);

/** The marker append that withdraws `surface` from `seq` on: dsh checks that `sourceEventSeqs` holds every shadowed node. */
export function rollbackPlan(surface, seq) {
  const at = surface.indexOf(seq);
  if (at < 0) throw refused('this message is no longer in the model context');
  const shadowed = surface.slice(at);
  return { shadowed, options: { surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) }, sourceEventSeqs: shadowed } };
}
export const rollbackMarker = () => Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: ROLLBACK_TEXT })]),
  source: Object.freeze({ kind: ROLLBACK_SOURCE }) });
/** The spans a chat's markers hide in the view, as `[first withdrawn seq, marker seq]`. */
export const rollbackSpans = (events) => events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === ROLLBACK_SOURCE && Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.length > 0)
  .map((e) => [Math.min(...e.sourceEventSeqs), e.seq]);

/** `path` relative to `root` ('' for root itself, '/' separators), or undefined when it is outside. Both are real paths. */
function relativeInside(root, path) {
  if (path === root) return '';
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix) ? path.slice(prefix.length).split(sep).join('/') : undefined;
}
async function nearestExisting(path) {
  for (let p = path; ; p = dirname(p)) {
    const real = await realpath(p).catch(() => undefined);
    if (real !== undefined || dirname(p) === p) return real;
  }
}

/** The bytes of one regular file (at most `max`), or an empty buffer when it is missing, a symlink, a FIFO or a device:
 * O_NOFOLLOW | O_NONBLOCK, so nothing put in its place can block the read or point elsewhere. */
async function readRegular(path, max = 1024 * 1024) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await file.stat();
    if (!info.isFile()) return Buffer.alloc(0);
    const buffer = Buffer.alloc(Math.min(info.size, max));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch { return Buffer.alloc(0); } finally { await file?.close().catch(() => {}); }
}

/** Git snapshots of one chat's folder, in a private store `<dir>/<chat>.git` whose objects/info/alternates names the
 * repository's objects: blobs that git already has are not copied. A snapshot is `git add --all -- <chat folder>` into the
 * store's own index plus `write-tree`, kept as ref `refs/s/<seq>` (the user message it was taken before), with the list
 * of paths that were ignored at that time (`ignored/<seq>.json`): a file that is not in the snapshot is deleted by a
 * restore only when it was neither in the snapshot nor ignored then, so a later change of an ignore rule never deletes a
 * file that was already there. The user's repository is only read: its index, HEAD, refs, stash and config are never
 * written (git does refresh the time stamp of an object file it reuses). One task at a time per chat. */
export function snapshotStore({ subprocess, dir, timeoutMs = SNAPSHOT_TIMEOUT_MS }) {
  const queues = new Map(); // chat id → promise of its last queued task
  const enqueue = (id, task) => {
    const next = (queues.get(id) ?? Promise.resolve()).then(task);
    const settled = next.then(() => {}, () => {});
    queues.set(id, settled);
    settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return next;
  };
  const storeOf = (id) => join(dir, `${safeSegment(id)}.git`);
  const ok = (r, what) => { if (r.code !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`); return r; };
  /** The repository around cwd: its top folder, objects, info/exclude, the user's global excludes file and the chat
   * folder relative to the top (`inside`); undefined outside a repository. */
  const repository = async (cwd, signal) => {
    const r = await runGit(subprocess, cwd, ['rev-parse', '--show-toplevel', '--git-path', 'objects', '--git-path', 'info/exclude'], signal);
    if (r.code !== 0) return undefined;
    const [top, objects, exclude] = r.stdout.split('\n').map((line) => (isAbsolute(line) ? line : join(cwd, line)));
    const inside = relativeInside(await realpath(top), await realpath(cwd));
    if (inside === undefined) return undefined;
    const global = (await runGit(subprocess, cwd, ['config', '--path', '--get', 'core.excludesFile'], signal)).stdout.trim()
      || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'ignore');
    return { top, objects, exclude, global, inside, pathspec: inside === '' ? '.' : `:(literal)${inside}` };
  };
  /** The store for this chat, created on first use. Each time: the alternates, the attributes, and copies of the two
   * exclude files (read as regular files only), so git itself never opens a file of the user's for its rules. */
  const prepare = async (id, repo, signal) => {
    const store = storeOf(id);
    if (!(await stat(join(store, 'HEAD')).then(() => true, () => false))) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      ok(await runGit(subprocess, dir, ['init', '-q', '--bare', '--template=', store], signal, { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }), 'git init');
    }
    await mkdir(join(store, 'info'), { recursive: true });
    await mkdir(join(store, 'objects', 'info'), { recursive: true });
    await mkdir(join(store, 'ignored'), { recursive: true });
    await writeFile(join(store, 'info', 'attributes'), '* -text -filter -ident -diff\n');
    await writeFile(join(store, 'objects', 'info', 'alternates'), `${repo.objects}\n`);
    await writeFile(join(store, 'info', 'exclude'), await readRegular(repo.exclude));
    await writeFile(join(store, 'info', 'global-exclude'), await readRegular(repo.global));
    const config = ['-c', `core.excludesFile=${join(store, 'info', 'global-exclude')}`];
    const run = (args, extra = {}) => runGit(subprocess, extra.cwd ?? repo.top, [...STORE_CONFIG, ...config, ...args], signal,
      { env: storeEnv(store, extra.workTree ?? repo.top, extra.index ?? join(store, 'index')), stdin: extra.stdin, timeoutMs });
    return { store, run };
  };
  /** The chat folder now as a tree id (the store's index follows it). An index entry whose object the repository lost
   * (gc after a rebase) makes write-tree fail once: the index is then made again from the files. */
  const treeNow = async ({ store, run }, repo) => {
    const add = async () => {
      const added = await run(['add', '--all', '--ignore-errors', '--', repo.pathspec]);
      if (added.code !== 0 && added.code !== 1) ok(added, 'git add');
      return added.code === 0; // 1: a file could not be read and is not in the snapshot
    };
    let complete = await add();
    let tree = await run(['write-tree']);
    if (tree.code !== 0) { await rm(join(store, 'index'), { force: true }); complete = await add(); tree = ok(await run(['write-tree']), 'git write-tree'); }
    return { tree: tree.stdout.trim(), complete };
  };
  const take = async (id, cwd, seq, signal) => {
    const repo = await repository(cwd, signal);
    if (repo === undefined) return undefined;
    const prepared = await prepare(id, repo, signal);
    const { store, run } = prepared;
    const { tree, complete } = await treeNow(prepared, repo);
    // ponytail: a list that git cuts at the output limit counts as unknown: that snapshot then deletes no file.
    const ignored = await run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', repo.pathspec]);
    const known = complete && ignored.code === 0 && !ignored.truncated;
    await writeFile(join(store, 'ignored', `${seq}.json`), JSON.stringify({ known, paths: known ? ignored.stdout.split('\0').filter(Boolean) : [] }));
    ok(await run(['update-ref', `refs/s/${seq}`, tree]), 'git update-ref');
    const refs = ok(await run(['for-each-ref', '--format=%(refname)', 'refs/s/']), 'git for-each-ref').stdout.split('\n').filter(Boolean)
      .sort((a, b) => Number(a.split('/').at(-1)) - Number(b.split('/').at(-1)));
    if (refs.length > SNAPSHOT_MAX) {
      for (const old of refs.slice(0, refs.length - SNAPSHOT_MAX)) {
        await run(['update-ref', '-d', old]);
        await rm(join(store, 'ignored', `${old.split('/').at(-1)}.json`), { force: true });
      }
      await run(['prune', '--expire=now']);
    }
    return tree;
  };
  /** What a restore to the snapshot before message `seq` changes inside `cwd`: `files: [{ path (from cwd), top (from the
   * repository top), action: restore | create | delete }]`. */
  const plan = async (id, cwd, seq, signal) => {
    const repo = await repository(cwd, signal);
    if (repo === undefined) return { git: false };
    const prepared = await prepare(id, repo, signal);
    const old = await prepared.run(['rev-parse', '-q', '--verify', `refs/s/${seq}^{tree}`]);
    if (old.code !== 0) return { git: true, snapshot: false };
    const tree = old.stdout.trim();
    const then = await readFile(join(prepared.store, 'ignored', `${seq}.json`), 'utf8').then(JSON.parse, () => ({ known: false, paths: [] }));
    const wasIgnored = (path) => !then.known || then.paths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
    const { tree: now } = await treeNow(prepared, repo);
    const out = ok(await prepared.run(['diff-tree', '-r', '-z', '--no-renames', tree, now]), 'git diff-tree').stdout.split('\0');
    const files = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const status = out[i].split(' ').at(-1); const top = out[i + 1];
      if (repo.inside !== '' && !top.startsWith(`${repo.inside}/`)) continue;
      if (status === 'A' && wasIgnored(top)) continue; // it may have been there, ignored: keep it
      files.push({ path: repo.inside === '' ? top : top.slice(repo.inside.length + 1), top, action: status === 'A' ? 'delete' : status === 'D' ? 'create' : 'restore' });
    }
    return { git: true, snapshot: true, prepared, tree, files };
  };
  return {
    /** Queue a snapshot before the user message `seq`; resolves to the tree id, or undefined outside a repository. */
    snapshot: (id, cwd, seq) => enqueue(id, () => take(id, cwd, seq)),
    /** Resolves once every queued task of this chat has settled. */
    settled: (id) => queues.get(id) ?? Promise.resolve(),
    preview: (id, cwd, seq, signal) => enqueue(id, async () => {
      const { prepared, tree, ...rest } = await plan(id, cwd, seq, signal);
      return { ...rest, ...(rest.files === undefined ? {} : { files: rest.files.map(({ path, action }) => ({ path, action })) }) };
    }),
    /** Put the files back. Every git step runs first (into a private folder); then `beforeWrite` runs (the caller withdraws
     * the messages there), then the files are written. A failure before `beforeWrite` changes nothing. */
    restore: (id, cwd, seq, signal, beforeWrite = () => {}) => enqueue(id, async () => {
      const p = await plan(id, cwd, seq, signal);
      if (!p.git || !p.snapshot) { await beforeWrite(); return { git: p.git, snapshot: p.snapshot ?? false, restored: [], deleted: [], skipped: [] }; }
      const scratch = await mkdtemp(join(dir, 'restore-'));
      try {
        const index = join(scratch, 'index');
        const local = { cwd: scratch, workTree: scratch, index };
        ok(await p.prepared.run(['read-tree', p.tree], local), 'git read-tree');
        const wanted = p.files.filter((f) => f.action !== 'delete');
        const modes = new Map();
        if (wanted.length > 0) {
          // A blob that the repository lost (gc) fails only its own file: writeBack lists it as skipped.
          await p.prepared.run(['checkout-index', `--prefix=${join(scratch, 'files')}${sep}`, '-z', '--stdin'], { ...local, stdin: `${wanted.map((f) => f.top).join('\0')}\0` });
          const listed = await p.prepared.run(['ls-files', '-s', '-z', '--', ...wanted.map((f) => `:(literal)${f.top}`)], local);
          for (const entry of listed.stdout.split('\0')) { const m = /^(\d+) \w+ \d\t([\s\S]*)$/.exec(entry); if (m) modes.set(m[2], m[1]); }
        }
        await beforeWrite();
        return { git: true, snapshot: true, ...(await writeBack(cwd, p.files, (f) => ({ source: join(scratch, 'files', ...f.top.split('/')), mode: modes.get(f.top) }))) };
      } finally { await rm(scratch, { recursive: true, force: true }); }
    }),
    forget: (id) => enqueue(id, () => rm(storeOf(id), { recursive: true, force: true })),
  };
}

/** Write snapshot bytes back into the chat folder. A target counts only when its real parent folder is inside the folder's
 * real path and the target is a regular file or missing (lstat); the bytes go to a new file in that real folder (O_EXCL |
 * O_NOFOLLOW) that then replaces the target by rename, so a symlink or FIFO swapped in meanwhile is replaced, never
 * followed or opened. Symlinks and submodules in the snapshot, and every failure, are listed as skipped; one failure never
 * stops the others. */
export async function writeBack(cwd, files, sourceOf) {
  const root = await realpath(cwd);
  const restored = []; const deleted = []; const skipped = [];
  for (const file of files) {
    const skip = (reason) => { skipped.push({ path: file.path, reason }); };
    let temp;
    try {
      const parts = file.path.split('/');
      if (parts.some((part) => part === '' || part === '.' || part === '..')) { skip('unsafe path'); continue; }
      const name = parts.at(-1);
      let folder = await realpath(join(root, ...parts.slice(0, -1))).catch(() => undefined);
      const inside = folder !== undefined && relativeInside(root, folder) !== undefined;
      const info = inside ? await lstat(join(folder, name)).catch(() => undefined) : undefined;
      if (info !== undefined && !info.isFile()) { skip(info.isSymbolicLink() ? 'symlink' : 'not a regular file'); continue; }
      if (file.action === 'delete') {
        if (folder !== undefined && !inside) { skip('outside the project folder'); continue; }
        if (info !== undefined) await unlink(join(folder, name));
        deleted.push(file.path);
        continue;
      }
      const { source, mode } = sourceOf(file);
      if (mode !== '100644' && mode !== '100755') { skip(mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : 'not in the snapshot'); continue; }
      if (folder === undefined) {
        const nearest = await nearestExisting(join(root, ...parts.slice(0, -1)));
        if (nearest === undefined || relativeInside(root, nearest) === undefined) { skip('outside the project folder'); continue; }
        await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
        folder = await realpath(join(root, ...parts.slice(0, -1)));
      }
      if (relativeInside(root, folder) === undefined) { skip('outside the project folder'); continue; }
      const bytes = await readFile(source);
      temp = join(folder, `.${name}.cp-rollback-${randomUUID().slice(0, 8)}`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode === '100755' ? 0o755 : 0o644);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, join(folder, name));
      temp = undefined;
      restored.push(file.path);
    } catch (error) {
      skip(error?.code === 'ELOOP' ? 'symlink' : error?.code === 'ENOENT' ? 'not in the snapshot' : String(error?.code ?? error?.message ?? error));
    } finally { if (temp !== undefined) await unlink(temp).catch(() => {}); }
  }
  return { restored, deleted, skipped };
}

/** Whether `rename` can move the folders into `<home>/trash` (same disk); the macOS Trash moves across disks itself. */
async function canMove(folders, home, platform) {
  if (platform === 'darwin') return true;
  const target = await stat(home).catch(() => undefined);
  for (const f of folders) { const s = await stat(f).catch(() => undefined); if (s !== undefined && target !== undefined && s.dev !== target.dev) return false; }
  return true;
}

/** Delete chat: move the chat's log folders to a trash: the macOS Trash (`/usr/bin/trash`, macOS 15 and later), else
 * `<home>/trash/<project folder name>/<chat folder name>-<time>`. */
export async function moveToTrash(folders, { home, subprocess, platform = process.platform, signal } = {}) {
  const existing = [];
  for (const f of folders) if (await lstat(f).then((s) => s.isDirectory(), () => false)) existing.push(f);
  if (existing.length === 0) return { to: 'none', moved: [] };
  if (platform === 'darwin' && subprocess !== undefined && (await stat('/usr/bin/trash').then((s) => s.isFile(), () => false))) {
    try {
      const handle = subprocess.spawn({ argv: ['/usr/bin/trash', ...existing], cwd: dirname(existing[0]), stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1000, signal });
      if ((await handle.done).exitCode === 0) return { to: 'trash', moved: existing };
    } catch { /* fall back to the folder below */ }
  }
  const moved = [];
  for (const f of existing) {
    if (!(await lstat(f).then((s) => s.isDirectory(), () => false))) continue; // the Trash took it before failing
    const target = join(home, 'trash', f.split(sep).at(-2), `${f.split(sep).at(-1)}-${Date.now()}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(f, target);
    moved.push(target);
  }
  return { to: 'folder', moved };
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  // The empty wake marker opens the step; it is then replaced by a fresh context message. Only messages
  // claimed from the inbox render as a chat bubble, so the replacement stays out of Chat, but it gives the
  // model a final user turn: providers such as Claude reject a request that ends on an assistant message.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || !decision.messages.some((m) => m.source?.kind === CONTINUE_SOURCE)) return decision;
    return { ...decision, messages: decision.messages.map((m) => (m.source?.kind === CONTINUE_SOURCE ? continueMessage() : m)) };
  }, true);
  ctx.connection.fetch.register({
    path: CONTINUE_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (!isText(body?.sessionId) || !Number.isSafeInteger(body?.afterSeq) || body.afterSeq < 0) return json({ error: 'bad request' }, 400);
      try {
        const found = await ctx.sessionController.resolveAgent(body.sessionId);
        if ('error' in found) return json({ error: 'session unavailable' }, 409);
        const { agent } = found;
        const observation = await ctx.sessionQuery.observeSession(body.sessionId, { signal: request.signal, projectionMode: 'none' });
        try {
          const last = observation.events.findLast((e) => e.type === 'turn/start' || e.type === 'turn/end');
          if (agent.status !== 'idle' || last?.seq !== body.afterSeq || (last.type === 'turn/end' && last.data?.reason?.kind === 'completed')) {
            return json({ error: 'session no longer needs continuation' }, 409);
          }
          request.signal.throwIfAborted();
          agent.steer({ id: randomUUID(), role: 'user', content: [], source: { kind: CONTINUE_SOURCE } });
          return json({ accepted: true });
        } finally { observation[Symbol.dispose]?.(); }
      } catch { return json({ error: 'continuation failed' }, 500); }
    },
  });
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
  ctx.connection.fetch.register({
    path: SHOT_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      const id = new URL(request.url).searchParams.get('id');
      if (!SHOTS.includes(id)) return json({ error: 'not found' }, 404);
      try {
        const bytes = await readFile(new URL(`./assets/features/${id}.webp`, import.meta.url));
        return new Response(bytes, { headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400' } });
      } catch { return json({ error: 'not found' }, 404); }
    },
  });
  ctx.connection.fetch.register({
    path: UPDATE_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      try { return json(await checkUpdate(fetch, PACKAGE, request.signal)); } catch (error) { return json({ error: String(error?.message ?? error) }, 502); }
    },
  });
  const store = grantsStore(join(home, 'storages', 'dsh-composer-plus', 'grants.json'));
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
  // Mobile connect (Tether). The phone gateway needs dsh's web server for its loopback URL; a profile without one
  // (headless) never starts it. Off until the user switches it on in Settings.
  const mobileSaved = mobileSwitch(join(home, 'storages', 'dsh-composer-plus', 'mobile.json'));
  let mobile;
  let mobileOn; // the user's choice; the saved value applies only until the user changes it
  const mobileRead = mobileSaved.read().then((on) => { mobileOn ??= on; });
  let mobileQueue = Promise.resolve(); // one switch change at a time: save, then start or stop
  ctx.inject?.(['webServer'], (webCtx) => {
    const gateway = mobileGateway({
      dir: process.env.DSH_MOBILE_DIR || join(home, 'storages', 'dsh-composer-plus', 'mobile'),
      upstreamUrl: () => ctx.connection.authenticatedUrl(`http://127.0.0.1:${webCtx.webServer.port}`),
    });
    mobile = gateway;
    webCtx.effect(() => {
      mobileRead.then(() => { if (mobileOn && mobile === gateway) gateway.start(); });
      return () => { if (mobile === gateway) mobile = undefined; gateway.close(); };
    }, 'dsh-composer-plus: mobile connect');
  });
  ctx.connection.fetch.register({
    path: MOBILE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
        if (typeof body?.on !== 'boolean') return json({ error: 'bad request' }, 400);
        const change = async () => {
          await mobileRead;
          await mobileSaved.write(body.on); // a failed save changes nothing
          mobileOn = body.on;
          if (mobile !== undefined) await (body.on ? mobile.start() : mobile.stop());
        };
        const done = mobileQueue.then(change);
        mobileQueue = done.catch(() => {}); // a failed save answers only its own request
        try { await done; } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
      }
      await mobileRead;
      const on = mobileOn === true;
      return json({ on, available: mobile !== undefined, ...(on && mobile !== undefined ? mobile.state() : { running: false }) });
    },
  });
  installResume(ctx, home);
  installIdeas(ctx, home);
  installContentSearch(ctx, home);
  const snapshots = snapshotStore({ subprocess: ctx.subprocess, dir: join(home, 'cache', 'composer-plus', 'rollback') });
  installRollback(ctx, home, snapshots);
  installDeleteChat(ctx, home, snapshots);
  installQueueMove(ctx);
  installPredict(ctx, home);
}

/** Queue drag-and-drop (Host half): `POST {sessionId, itemId, to, before}` moves one queued next-turn message to index `to`
 * of `before`, with its images and files, in dsh's own inbox (the message keeps its id). dsh's queue `edit`
 * takes text only, so moving text between rows cannot move a message with an attachment. `before` (the ids the user
 * saw, in order) must still be the queue: a message that started to send meanwhile makes it 409, and nothing moves. */
function installQueueMove(ctx) {
  const busy = new Set();
  ctx.connection.fetch.register({
    path: QUEUE_MOVE_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      const { sessionId, itemId, to, before } = body ?? {};
      if (!isText(sessionId) || !isText(itemId) || !Number.isSafeInteger(to) || to < 0 || !Array.isArray(before) || !before.every((id) => isText(id))) return json({ error: 'bad request' }, 400);
      if (busy.has(sessionId)) return json({ error: 'a move in this chat is already running' }, 409);
      busy.add(sessionId);
      try {
        const found = await ctx.sessionController.resolveAgent(sessionId);
        if ('error' in found) return json({ error: 'this chat is not available' }, 409);
        const { agent } = found;
        const inbox = agent.inbox;
        if (inbox?.splice === undefined || !Array.isArray(inbox.nextTurn)) return json({ error: 'this dsh cannot move queued messages' }, 409);
        if (!isRootChat(agent.session)) {
          const sub = ctx.sessionProjections?.snapshot?.(agent.session, ['subagent'])?.values?.subagent;
          if (sub?.mode !== 'continuable') return json({ error: 'this chat cannot change its queue' }, 409);
        }
        const queue = inbox.nextTurn;
        const ids = queue.map((m) => m.id);
        // Only the rows the user saw may move: dsh hides the ones already echoed in the chat, so `before` can be a
        // part of the queue, in the same order.
        const seen = ids.filter((id) => before.includes(id));
        if (seen.length !== before.length || seen.some((id, i) => id !== before[i]) || !before.includes(itemId) || to >= before.length) {
          return json({ error: 'the queue changed; a message may have already started sending' }, 409);
        }
        const from = ids.indexOf(itemId);
        const target = ids.indexOf(before[to]);
        if (from === target) return json({ moved: false });
        // One splice over the rows between the two places, in their new order: one log event, the same ids. dsh logs
        // it as "canceled + inserted", which its chat view and its turn bookkeeping do not count as a claim. Only your
        // own messages move: a goal round or a question reply in that range has its own listeners on a removal.
        const lo = Math.min(from, target), hi = Math.max(from, target);
        const range = queue.slice(lo, hi + 1);
        if (!range.every((m) => m.source?.kind === 'user')) return json({ error: 'only your own queued messages can move' }, 409);
        const order = [...range];
        order.splice(target - lo, 0, order.splice(from - lo, 1)[0]);
        inbox.splice('next-turn', lo, range.length, order);
        return json({ moved: true, order: inbox.nextTurn.map((m) => m.id) });
      } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
      finally { busy.delete(sessionId); }
    },
  });
}

/** Wait until the agent is idle, at most `ms`; false on time-out. */
async function idleWithin(agent, ms) {
  if (agent.status === 'idle') return true;
  let timer;
  try { return await Promise.race([agent.whenIdle().then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); } finally { clearTimeout(timer); }
}
const STOP_WAIT_MS = 15000;
const isRootChat = (session) => session?.header?.origin !== 'subagent' && (session?.header?.delegationDepth ?? 0) === 0;

/** Turn rollback (Host half): a git snapshot of the chat's work tree before each user message, and `/api/composer-plus.rollback`:
 * `GET ?sessionId` → `{ on, spans, git }`; `POST {on}` moves the switch; `POST {sessionId, seq, preview: true}` → the files a
 * rollback with files would change; `POST {sessionId, seq, files}` stops a running turn, withdraws the message and everything
 * after it (one marker), and with `files` puts the project files back. When dsh-rewind-plugin is loaded it owns rollback:
 * no snapshots, and the route answers `rewind: true`. */
function installRollback(ctx, home, store) {
  const get = (name) => { try { return ctx.get?.(name); } catch { return undefined; } };
  const saved = mobileSwitch(join(home, 'storages', 'dsh-composer-plus', 'rollback.json'), true);
  let on = true;
  const read = saved.read().then((value) => { on = value; });
  let switchQueue = Promise.resolve();
  const rewindLoaded = (agent) => { try { return get('commands')?.find?.(agent, 'rewind-plugin') !== undefined; } catch { return false; } };
  const busy = new Set(); // chats with a rollback running now
  const log = (text) => ctx.logger?.warn?.(`dsh-composer-plus: ${text}`);
  ctx.on('session/event', (session, event) => {
    if (!on || event.type !== 'user/message' || event.data?.source?.kind !== 'user' || !isRootChat(session)) return;
    const cwd = session.header?.cwd;
    if (!isText(cwd, 4096) || busy.has(session.id)) return;
    const agent = get('agents')?.get?.(session.id);
    if (agent !== undefined && rewindLoaded(agent)) return;
    store.snapshot(session.id, cwd, event.seq).catch((error) => log(`turn rollback snapshot failed: ${error?.message ?? error}`));
  });
  // A tool of the chat waits for its queued snapshot, so the snapshot shows the files before this message's work; at most
  // TOOL_WAIT_MS, so a stuck git (a FIFO named .gitignore in the tree) never stops the chat.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const id = exec.agent?.session?.id;
    if (id !== undefined) {
      let timer;
      await Promise.race([store.settled(id), new Promise((resolve) => { timer = setTimeout(resolve, TOOL_WAIT_MS); })]);
      clearTimeout(timer);
    }
    return next();
  });
  ctx.connection.fetch.register({
    path: ROLLBACK_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      if (request.method === 'GET') body = { sessionId: new URL(request.url).searchParams.get('sessionId') ?? undefined };
      else try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (typeof body?.on === 'boolean') {
        const done = switchQueue.then(async () => { await read; await saved.write(body.on); on = body.on; });
        switchQueue = done.catch(() => {});
        try { await done; } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
        return json({ on });
      }
      await read;
      if (body?.sessionId === undefined && request.method === 'GET') return json({ on });
      if (!isText(body?.sessionId)) return json({ error: 'bad request' }, 400);
      try {
        const found = await ctx.sessionController.resolveAgent(body.sessionId);
        if ('error' in found) return json({ error: 'this chat is not available' }, 409);
        const { agent } = found;
        const session = agent.session;
        const rewind = rewindLoaded(agent);
        if (request.method === 'GET') return json({ on, rewind, spans: rollbackSpans(session.snapshotEvents()) });
        if (!on) return json({ error: 'Turn rollback is switched off' }, 409);
        if (!isRootChat(session)) return json({ error: 'a subagent chat cannot be rolled back' }, 409);
        if (!Number.isSafeInteger(body.seq)) return json({ error: 'bad request' }, 400);
        const target = session.snapshotEvents().find((e) => e.seq === body.seq);
        if (target?.type !== 'user/message' || target.data?.source?.kind !== 'user') return json({ error: 'not a message of yours' }, 400);
        const cwd = session.header?.cwd;
        if (body.preview === true) {
          rollbackPlan([...session.surface.nodes], body.seq);
          return json(isText(cwd, 4096) ? await store.preview(session.id, cwd, body.seq, request.signal) : { git: false });
        }
        if (busy.has(session.id)) return json({ error: 'a rollback of this chat is already running' }, 409);
        busy.add(session.id);
        try {
          if (agent.status !== 'idle') {
            agent.cancel({ kind: 'user' }, { keepInbox: true });
            if (!(await idleWithin(agent, STOP_WAIT_MS))) return json({ error: 'the running turn did not stop' }, 409);
          }
          for (const message of [...(agent.inbox?.nextStep ?? [])]) agent.inbox.remove(message.id); // unread steering goes with the turn
          let plan; let marker;
          const withdraw = () => { plan = rollbackPlan([...session.surface.nodes], body.seq); marker = session.append('user/message', rollbackMarker(), plan.options); };
          const text = (target.data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          const attachments = (target.data.content ?? []).filter((b) => b.type !== 'text').length;
          let files;
          // Every git step runs before the marker; the files are written after it. A git failure leaves the chat as it was.
          // ponytail: dsh's read-before-edit guard is not told about the restored files; the model reads them again.
          if (body.files === true && isText(cwd, 4096)) files = await store.restore(session.id, cwd, body.seq, request.signal, withdraw);
          else withdraw();
          return json({ markerSeq: marker.seq, span: [plan.shadowed[0], marker.seq], text, attachments, ...(files === undefined ? {} : { files }) });
        } finally { busy.delete(session.id); }
      } catch (error) { return json({ error: String(error?.message ?? error) }, Number.isInteger(error?.status) ? error.status : 500); }
    },
  });
}

/** Delete chat (Host half): `POST /api/composer-plus.delete-chat {sessionId}` archives the chat with dsh's own stop (turn,
 * jobs, subagents, schedules), waits for it to be idle, flushes its log, takes the log's write lock when no agent of this
 * dsh holds it, and moves its folder and its subagents' folders to the Trash. The id stays archived, so a folder that is
 * put back comes back as an archived chat at the next start. */
function installDeleteChat(ctx, home, snapshots) {
  const get = (name) => { try { return ctx.get?.(name); } catch { return undefined; } };
  const busy = new Set();
  ctx.connection.fetch.register({
    path: DELETE_CHAT_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (!isText(body?.sessionId)) return json({ error: 'bad request' }, 400);
      const id = body.sessionId;
      const registry = get('workspaceRegistry'); const persistence = get('sessionPersistence');
      if (registry?.archiveSession === undefined || persistence?.locate === undefined || persistence?.list === undefined) return json({ error: 'this dsh cannot delete chats' }, 409);
      if (busy.has(id)) return json({ error: 'this chat is already being deleted' }, 409);
      busy.add(id);
      const locks = [];
      try {
        const headers = (await persistence.list({ signal: request.signal })).map((s) => s.header);
        const header = headers.find((h) => h.id === id);
        if (header === undefined) return json({ error: 'this chat has no saved log' }, 404);
        if (!isRootChat({ header })) return json({ error: 'a subagent chat goes with its parent chat' }, 409);
        // The chat's subagents (any depth) go with it.
        const family = new Set([id]);
        for (let grew = true; grew;) { grew = false; for (const h of headers) if (!family.has(h.id) && h.origin === 'subagent' && family.has(h.parentSession)) { family.add(h.id); grew = true; } }
        const members = headers.filter((h) => family.has(h.id));
        const folders = members.map((h) => dirname(persistence.locate(h).path));
        // ponytail: COMPOSER_PLUS_TRASH=folder keeps test runs out of the user's macOS Trash; there is no setting for it.
        const platform = process.env.COMPOSER_PLUS_TRASH === 'folder' ? 'folder' : process.platform;
        if (!(await canMove(folders, home, platform))) return json({ error: 'the chat history is on another disk than the dsh home; nothing was changed' }, 409);
        await registry.archiveSession(id, { stopActivity: true });
        // Every log of the family must be quiet before it moves: an agent of this dsh is idle and flushed; any other log is
        // locked (another dsh that writes it makes this fail). One failure moves nothing; the chat stays archived.
        for (const h of members) {
          const agent = get('agents')?.get?.(h.id);
          if (agent !== undefined) {
            if (!(await idleWithin(agent, STOP_WAIT_MS))) return json({ error: 'the chat did not stop; it stays archived' }, 409);
            const live = get('sessions')?.get?.(h.id);
            if (live !== undefined) await get('sessions').flush(live);
          } else {
            try { locks.push(await persistence.open(h.id, 'write', { signal: request.signal })); }
            catch (error) { return json({ error: error?.name === 'SessionAlreadyOwnedError' ? 'another dsh has this chat open; it stays archived' : String(error?.message ?? error) }, 409); }
          }
        }
        // The lock descriptors stay open while their folders move (same disk) and close in `finally`.
        const result = await moveToTrash(folders, { home, subprocess: ctx.subprocess, signal: request.signal, platform });
        for (const h of members) snapshots?.forget(h.id).catch(() => {});
        return json({ deleted: true, to: result.to, chats: family.size });
      } catch (error) { return json({ error: String(error?.message ?? error) }, Number.isInteger(error?.status) ? error.status : 500); }
      finally { for (const lock of locks) await lock.close().catch(() => {}); busy.delete(id); }
    },
  });
}

/** Content search: dsh's own sidebar search also looks in message text. The work is dsh's (`cordis.patch.yml` opens its
 * SQLite index when this switch is on); the Host only keeps the switch, on by default. dsh reads it at start, so
 * `GET/POST {on}` also tells whether the running index is open (`active`; undefined when dsh does not say). */
function installContentSearch(ctx, home) {
  const saved = mobileSwitch(join(home, 'storages', 'dsh-composer-plus', 'content-search.json'), true);
  const active = () => { try { const openAt = ctx.sessionQuery?.config?.openAt; return typeof openAt === 'string' ? openAt !== 'never' : undefined; } catch { return undefined; } };
  let queue = Promise.resolve(); // one save at a time: they share a temp file name
  ctx.connection.fetch.register({
    path: CONTENT_SEARCH_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
        if (typeof body?.on !== 'boolean') return json({ error: 'bad request' }, 400);
        const done = queue.then(() => saved.write(body.on));
        queue = done.catch(() => {});
        try { await done; } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
      }
      return json({ on: await saved.read(), active: active() });
    },
  });
}

/** Feature ideas: `POST {sessionId, locale?}` asks the chat's model for ideas (never one from the project's history or
 * Later list); `POST {sessionId, idea}` starts a chat for one idea.
 * Ideas saved for later: `GET ?sessionId` lists the project's ideas; `POST {sessionId, add | remove | start | startAll}`
 * changes the list (`start` starts a chat for the stored idea and removes it once the chat runs).
 * Idea history: `GET ?sessionId` lists the project's earlier ideas; `POST {sessionId, remove | clear}` forgets one or all.
 * All act only on the chat's own project folder; the browser never sends a path. */
function installIdeas(ctx, home) {
  const get = (name) => { try { return ctx.get?.(name); } catch { return undefined; } };
  const status = (error) => (Number.isInteger(error?.status) ? error.status : 502);
  const services = () => ({ sessionController: ctx.sessionController, sessionQuery: ctx.sessionQuery, commands: get('commands'), workspaces: get('workspaceRegistry') });
  const later = laterStore(join(home, 'storages', 'dsh-composer-plus', 'later.json'));
  const history = ideaHistory(laterStore(join(home, 'storages', 'dsh-composer-plus', 'idea-history.json')));
  // ponytail: the history marks a start best-effort; the chat already runs, so a failed write only loses the mark.
  const markStarted = async (cwd, ideas) => { try { await history.started(cwd, ideas); } catch { /* best-effort */ } };
  // ponytail: a broken saved file never blocks Suggest; its titles are just not avoided (the file itself is kept as it is).
  const titles = async (store, cwd) => { try { return (await store.list(cwd)).map((i) => i.title); } catch { return []; } };
  ctx.connection.fetch.register({
    path: IDEAS_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (!isText(body?.sessionId)) return json({ error: 'bad request' }, 400);
      if (body.idea !== undefined) {
        const idea = ideaFrom(body.idea);
        if (idea === undefined) return json({ error: 'bad request' }, 400);
        try {
          const { cwd, ...started } = await startIdeaChat(services(), body.sessionId, { title: idea.title, summary: idea.summary, why: idea.why }, request.signal, { plan: body.plan !== false });
          await markStarted(cwd, [idea]);
          return json(started);
        } catch (error) { return json({ error: String(error?.message ?? error) }, status(error)); }
      }
      const llm = get('llm');
      if (llm === undefined) return json({ error: 'this dsh profile cannot call a model' }, 409);
      try {
        // Not again: every earlier suggestion of this project (skipped, started, saved) and the Later list.
        const avoid = async (cwd) => [...(await titles(history, cwd)), ...(await titles(later, cwd))];
        return json(await suggestIdeas({ llm, sessionQuery: ctx.sessionQuery, subprocess: ctx.subprocess, defaultModel: get('agentDefaultModel'), avoid, record: history.record },
          body.sessionId, request.signal, body.locale));
      } catch (error) { return json({ error: String(error?.message ?? error) }, status(error)); }
    },
  });
  ctx.connection.fetch.register({
    path: HISTORY_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      if (request.method === 'GET') body = { sessionId: new URL(request.url).searchParams.get('sessionId') };
      else try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      // POST: `remove` one entry (it may be suggested again) or `clear` the project's history.
      if (!isText(body?.sessionId) || (request.method === 'POST' && !isText(body.remove) && body.clear !== true)) return json({ error: 'bad request' }, 400);
      try {
        const cwd = await chatFolder(ctx.sessionQuery, body.sessionId, request.signal);
        if (request.method === 'GET') return json({ ideas: await history.list(cwd) });
        return json({ ideas: body.clear === true ? await history.clear(cwd) : await history.remove(cwd, body.remove) });
      } catch (error) { return json({ error: String(error?.message ?? error) }, Number.isInteger(error?.status) ? error.status : 500); }
    },
  });
  const starting = new Set(); // `${cwd}\0${id}` of the stored ideas whose chat is starting now
  ctx.connection.fetch.register({
    path: LATER_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      if (request.method === 'GET') body = { sessionId: new URL(request.url).searchParams.get('sessionId') };
      else try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (!isText(body?.sessionId)) return json({ error: 'bad request' }, 400);
      const add = body.add === undefined ? undefined : ideaFrom(body.add);
      // `startAll`: the ids the user saw (2 or more, no repeats), so an idea that another window added meanwhile stays.
      const all = Array.isArray(body.startAll) && body.startAll.length >= 2 && body.startAll.length <= LATER_MAX && body.startAll.every((id) => isText(id))
        && new Set(body.startAll).size === body.startAll.length ? body.startAll : undefined;
      const action = request.method === 'GET' ? 'list' : body.add !== undefined ? 'add' : isText(body.remove) ? 'remove' : isText(body.start) ? 'start'
        : body.startAll !== undefined ? 'startAll' : undefined;
      if (action === undefined || (action === 'add' && add === undefined) || (action === 'startAll' && all === undefined)) return json({ error: 'bad request' }, 400);
      try {
        const cwd = await chatFolder(ctx.sessionQuery, body.sessionId, request.signal);
        if (action === 'list') return json({ ideas: await later.list(cwd) });
        if (action === 'add') return json({ ideas: await later.add(cwd, add) });
        if (action === 'remove') return json({ ideas: await later.remove(cwd, body.remove) });
        const ids = action === 'start' ? [body.start] : all;
        const list = await later.list(cwd);
        const ideas = ids.map((id) => list.find((i) => i.id === id));
        const keys = ids.map((id) => `${cwd}\0${id}`);
        if (ideas.includes(undefined) || keys.some((key) => starting.has(key))) return json({ error: 'this idea is no longer in the list' }, 409);
        for (const key of keys) starting.add(key);
        try {
          const brief = ideas.map((i) => ({ title: i.title, summary: i.summary, why: i.why }));
          // Plan all always plans: many features at once without a plan would be a large unreviewed change.
          const { cwd: _, ...started } = await startIdeaChat(services(), body.sessionId, action === 'start' ? brief[0] : brief, request.signal, { plan: action === 'startAll' || body.plan !== false });
          await markStarted(cwd, brief);
          return json({ ...started, ideas: await later.remove(cwd, ids) });
        } finally { for (const key of keys) starting.delete(key); }
      } catch (error) { return json({ error: String(error?.message ?? error) }, Number.isInteger(error?.status) ? error.status : 500); }
    },
  });
}

/** Resume after restart: follow the top-level chats, and once dsh is ready, continue the ones its last shutdown stopped.
 * Services that a profile may not have (`agents`, `goals`, `workspaceRegistry`, `appReady`) are read with `ctx.get`. */
function installResume(ctx, home) {
  const get = (name) => { try { return ctx.get?.(name); } catch { return undefined; } };
  const isRoot = (agent) => {
    const agents = get('agents');
    return agents?.roots?.().includes(agent) === true && agent.session?.header?.origin !== 'subagent';
  };
  const tracker = resumeTracker({
    store: resumeStore(join(home, 'storages', 'dsh-composer-plus', 'resume.json')),
    isRoot,
    running: () => (get('agents')?.roots?.() ?? []).filter((a) => a.status === 'running' && isRoot(a)).map((a) => a.id),
    // ponytail: an unreadable archive list counts as "not archived"; dsh's own archived-session gate still blocks the step.
    wakeOne: (id) => wakeSession({ sessionController: ctx.sessionController, sessionQuery: ctx.sessionQuery, goals: get('goals'),
      archived: (sid) => { try { return get('workspaceRegistry')?.archivedSessionIds?.includes(sid) === true; } catch { return false; } } }, id),
    log: (text) => ctx.logger?.warn?.(`dsh-composer-plus: ${text}`),
  });
  ctx.on('agent/status', ({ agent, status }) => tracker.status(agent, status));
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') tracker.turnStart(session.id);
    else if (event.type === 'turn/end') tracker.turnEnd(session.id, event.data?.reason);
  });
  // Wake after dsh's own startup (web server, plugins) is done; a profile without the ready signal waits a moment instead.
  ctx.effect?.(() => {
    let done = false;
    const run = () => { if (!done) { done = true; tracker.wake().catch(() => {}); } };
    const ready = get('appReady');
    const cancel = ready?.onReady !== undefined ? ready.onReady(run) : (() => { const t = setTimeout(run, 3000); return () => clearTimeout(t); })();
    return () => { done = true; cancel?.(); tracker.close(); };
  }, 'dsh-composer-plus: resume after restart');
  ctx.connection.fetch.register({
    path: RESUME_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
        if (typeof body?.on !== 'boolean') return json({ error: 'bad request' }, 400);
        try { await tracker.setOn(body.on); } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
      }
      await tracker.ready;
      return json({ on: tracker.isOn() });
    },
  });
}

/** Next message prediction: after a turn ends, a guess of the user's next message in the same chat (Codex "composer
 * predictions"). On by default (the owner's choice): one short model call per finished turn, no chat turn and nothing in
 * the chat. The Host keeps the switch and the model choice in `predict.json`. The model is dsh's default unless the user picked another one from dsh's own
 * model catalog. Nothing goes into the chat: the browser shows the text and Tab puts it in the composer. */
export const PREDICT_TIMEOUT_MS = 45000;
export const PREDICT_MAX_TOKENS = 4000;
const PREDICT_MAX = 300; // characters of one prediction
const PREDICT_CONTEXT = 6000; // characters of chat the model reads
const PREDICT_SYSTEM = `You predict the next message that the user will type in a chat with an AI coding agent.
Read the recent conversation. Write the single most likely next message from the user, as the user would type it: short (one sentence, at most 25 words), in the user's own language and tone, and specific to this conversation. Typical next messages ask for the obvious next step, ask to check or test the result, or ask a follow-up question.
Answer with the message text only: no quotes, no label, no explanation. If no next message is likely, answer with nothing.`;

/** Saved settings: `{on, model?: {provider, model}}`. No file or a broken file reads as on with dsh's default model; only
 * a saved `on: false` (the user's switch) turns it off. */
export function predictStore(file) {
  const read = async () => {
    try {
      const v = JSON.parse(await readFile(file, 'utf8'));
      const model = isText(v?.model?.provider) && isText(v?.model?.model) ? { provider: v.model.provider, model: v.model.model } : undefined;
      return { on: v?.on !== false, ...(model === undefined ? {} : { model }) };
    } catch { return { on: true }; }
  };
  let queue = Promise.resolve(); // one write at a time: they share a temp file name and merge into the newest state
  const change = (mutate) => {
    const done = queue.then(async () => {
      const next = mutate(await read());
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, file);
      return next;
    });
    queue = done.catch(() => {});
    return done;
  };
  return { read, change };
}

/** Text blocks of a message content, joined. */
const textBlocks = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') : '');
/** The recent conversation for the prediction: the user's own messages and the agent's replies (no tools, no hidden
 * context), oldest first, the newest kept when it is long. `undefined` when the chat has no reply after its last message. */
export function predictTranscript(events) {
  const lines = [];
  for (const e of events) {
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
      const text = textBlocks(e.data.content).trim();
      if (text !== '') lines.push({ who: 'User', text });
    } else if (e.type === 'assistant/message') {
      const text = textBlocks(e.data?.message?.content).trim();
      if (text !== '') lines.push({ who: 'Agent', text });
    }
  }
  if (lines.at(-1)?.who !== 'Agent') return undefined;
  const out = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && size < PREDICT_CONTEXT; i--) {
    const room = PREDICT_CONTEXT - size;
    const text = lines[i].text.length > room ? `…${lines[i].text.slice(-room)}` : lines[i].text;
    out.unshift(`${lines[i].who}: ${text}`);
    size += text.length;
  }
  return out.join('\n\n');
}
/** The model's answer as one clean line: no quotes or label; empty when it has nothing useful. */
export function cleanPrediction(text) {
  let line = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  line = line.trim().replace(/^(user|next message|message)\s*:\s*/i, '').replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  return line.length > PREDICT_MAX ? `${line.slice(0, PREDICT_MAX - 1).trimEnd()}…` : line;
}

/** The newest `turn/end`, when it is the last turn event of the chat and the turn finished normally. */
export function finishedTurn(events) {
  const last = events.findLast((e) => e.type === 'turn/start' || e.type === 'turn/end');
  return last?.type === 'turn/end' && last.data?.reason?.kind === 'completed' ? last.seq : undefined;
}

/** dsh's model list with the deployment default, the same data as dsh's own model menu. */
async function modelCatalogOf(ctx, get) {
  const llm = get('llm');
  const fallback = get('agentDefaultModel')?.currentSelection?.();
  const out = { default: isText(fallback?.provider) && isText(fallback?.model) ? { provider: fallback.provider, model: fallback.model } : undefined, groups: [] };
  if (llm?.listProviders === undefined) return out;
  for (const provider of llm.listProviders()) {
    try {
      const models = (await llm.listModels(provider.id)).map((m) => ({ id: m.id, name: m.name }));
      if (models.length > 0) out.groups.push({ id: provider.id, name: provider.name ?? provider.id, models });
    } catch { /* a provider that cannot list its models is left out, as in dsh's own menu */ }
  }
  return out;
}

/** One model call: the next user message of this chat, after the turn that ended at `afterSeq`. */
export async function predictNext({ llm, sessionQuery, route }, sessionId, afterSeq, signal) {
  const observation = await sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
  let transcript, origin;
  try {
    const events = observation.events ?? [];
    origin = observation.header?.origin;
    if (finishedTurn(events) !== afterSeq) throw Object.assign(new Error('the chat moved on'), { status: 409 });
    transcript = predictTranscript(events);
  } finally { observation[Symbol.dispose]?.(); }
  if (origin === 'subagent') throw Object.assign(new Error('not for a subagent chat'), { status: 409 });
  if (transcript === undefined) return { text: '', afterSeq };
  const timeout = AbortSignal.timeout(PREDICT_TIMEOUT_MS);
  const callSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const call = await llm.prepareCall(route, callSignal, (controls, model) => {
    // The lowest reasoning effort keeps it fast; the output cap never goes above the model's own default.
    const first = model?.reasoning?.efforts?.[0];
    const cap = Number.isSafeInteger(model?.defaultMaxTokens) && model.defaultMaxTokens > 0 ? Math.min(PREDICT_MAX_TOKENS, model.defaultMaxTokens) : PREDICT_MAX_TOKENS;
    return { ...controls, maxTokens: cap, ...(first === undefined ? {} : { reasoningEffort: first.id }) };
  });
  let text = '';
  let finish;
  for await (const chunk of call.stream({ ...call.config, system: PREDICT_SYSTEM, signal: callSignal,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Recent conversation:\n\n${transcript}\n\nThe user's next message:` }] }] })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message || `the model call ended: ${finish.kind}`);
  return { text: cleanPrediction(text), afterSeq, model: route.model };
}

function installPredict(ctx, home) {
  const get = (name) => { try { return ctx.get?.(name); } catch { return undefined; } };
  const store = predictStore(join(home, 'storages', 'dsh-composer-plus', 'predict.json'));
  const running = new Map(); // sessionId → { afterSeq, promise }: one call per chat; the same turn shares it
  // sessionId → { key, result }: the last answer per chat, so a reopened chat, a second tab or the phone costs no new call.
  // A new turn or another model makes a new key. ponytail: at most PREDICT_CACHE chats, the oldest go first.
  const done = new Map();
  const PREDICT_CACHE = 200;
  /** The saved model when dsh still lists it, else dsh's default. */
  const routeFor = async (saved) => {
    const catalog = await modelCatalogOf(ctx, get);
    const listed = saved !== undefined && catalog.groups.some((g) => g.id === saved.provider && g.models.some((m) => m.id === saved.model));
    return listed ? saved : catalog.default;
  };
  ctx.connection.fetch.register({
    path: PREDICT_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        const settings = await store.read();
        if (new URL(request.url).searchParams.get('catalog') === '1') return json({ ...settings, catalog: await modelCatalogOf(ctx, get) });
        return json(settings);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad request' }, 400);
      if (typeof body.on === 'boolean' && body.sessionId === undefined && body.model === undefined) {
        try { return json(await store.change((v) => ({ ...v, on: body.on }))); } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
      }
      if (body.model !== undefined && body.sessionId === undefined && body.on === undefined) {
        // null: back to dsh's default. A model must be one that dsh lists now.
        let model;
        if (body.model !== null) {
          if (!isText(body.model?.provider) || !isText(body.model?.model)) return json({ error: 'bad request' }, 400);
          const catalog = await modelCatalogOf(ctx, get);
          if (!catalog.groups.some((g) => g.id === body.model.provider && g.models.some((m) => m.id === body.model.model))) return json({ error: 'dsh does not list this model' }, 409);
          model = { provider: body.model.provider, model: body.model.model };
        }
        try {
          return json(await store.change(({ model: _, ...v }) => (model === undefined ? v : { ...v, model })));
        } catch (error) { return json({ error: String(error?.message ?? error) }, 500); }
      }
      if (!isText(body.sessionId) || !Number.isSafeInteger(body.afterSeq) || body.afterSeq < 0 || body.on !== undefined || body.model !== undefined) return json({ error: 'bad request' }, 400);
      const settings = await store.read();
      if (!settings.on) return json({ error: 'next message prediction is off' }, 409);
      const llm = get('llm');
      if (llm?.prepareCall === undefined) return json({ error: 'this dsh profile cannot call a model' }, 409);
      const route = await routeFor(settings.model);
      if (route === undefined) return json({ error: 'no model is selected' }, 409);
      const key = JSON.stringify([body.afterSeq, route.provider, route.model]);
      const kept = done.get(body.sessionId);
      if (kept?.key === key) {
        // Only while that turn is still the chat's last one (a newer turn makes the guess stale).
        let fresh = false;
        try {
          const observation = await ctx.sessionQuery.observeSession(body.sessionId, { signal: request.signal, projectionMode: 'none' });
          try { fresh = observation.header?.origin !== 'subagent' && finishedTurn(observation.events ?? []) === body.afterSeq; } finally { observation[Symbol.dispose]?.(); }
        } catch { fresh = false; }
        if (!fresh) return json({ error: 'the chat moved on' }, 409);
        return json(kept.result);
      }
      const same = running.get(body.sessionId);
      if (same !== undefined && same.afterSeq === body.afterSeq) {
        try { return json(await same.promise); } catch (error) { return json({ error: String(error?.message ?? error) }, Number.isInteger(error?.status) ? error.status : 502); }
      }
      if (same !== undefined) return json({ error: 'a prediction for this chat is still running' }, 409);
      // Shared by every request for this turn (two tabs, the phone): no request's signal may cancel it. The call has its own
      // timeout, so it always ends.
      const promise = predictNext({ llm, sessionQuery: ctx.sessionQuery, route }, body.sessionId, body.afterSeq).then((result) => {
        done.delete(body.sessionId);
        done.set(body.sessionId, { key, result });
        if (done.size > PREDICT_CACHE) done.delete(done.keys().next().value);
        return result;
      });
      running.set(body.sessionId, { afterSeq: body.afterSeq, promise });
      try { return json(await promise); }
      catch (error) { return json({ error: String(error?.message ?? error) }, Number.isInteger(error?.status) ? error.status : 502); }
      finally { if (running.get(body.sessionId)?.promise === promise) running.delete(body.sessionId); }
    },
  });
}
