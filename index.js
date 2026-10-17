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
 *   feature ideas as cards. Read-only: no chat message, nothing written to the project.
 */
import { readFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
/** Feature screenshots shipped in assets/features/<id>.webp; only these ids are served (no path input). */
export const SHOTS = ['changesPanel', 'featureIdeas', 'projectStatus', 'recentProjects', 'collapseProjects', 'statusOrder', 'notifications', 'allowForChat', 'continueButton', 'resumeAfterRestart', 'inputHistory', 'planToggle', 'keepFocus',
  'queueReorder', 'mobileConnect', 'copyDeeplink', 'copyProjectPath', 'language', 'autoUpdate'];
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

/** Mobile connect switch: `{ on: true }` in a JSON file, off when the file is missing or unreadable. */
export function mobileSwitch(file) {
  return {
    read: async () => { try { return JSON.parse(await readFile(file, 'utf8'))?.on === true; } catch { return false; } },
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
const IDEAS_TIMEOUT_MS = 90000;
const IDEAS_MAX_TOKENS = 4000;
/** Top-level names that never go into the brief: secrets and bulky generated folders. */
const BRIEF_SKIP = /^(\.env.*|.*\.(pem|key|p12|pfx)|id_[a-z0-9]+|\.git|node_modules|dist|build|coverage|\.next|\.venv|venv|__pycache__|\.DS_Store)$/i;
const BRIEF_FILES = ['README.md', 'readme.md', 'README', 'AGENTS.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json', 'pom.xml'];

/** The first `max` bytes of one file, or undefined when it is missing or not a regular file. */
async function head(path, max) {
  let file;
  try {
    file = await open(path, 'r');
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
  for (const name of BRIEF_FILES) {
    const text = await head(join(cwd, name), BRIEF_FILE_BYTES);
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
- "effort": one of "small", "medium", "large".
Write the text values in the language of the project brief.`;

const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
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
    const title = clip(item?.title, 120);
    const summary = clip(item?.summary, 600);
    if (title === '' || summary === '') continue;
    const effort = ['small', 'medium', 'large'].includes(item?.effort) ? item.effort : undefined;
    ideas.push({ id: randomUUID(), title, summary, ...(clip(item?.why, 300) === '' ? {} : { why: clip(item.why, 300) }), ...(effort === undefined ? {} : { effort }) });
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

/** One model call for feature ideas about the chat's project. Read-only: no chat message, nothing written to the project. */
export async function suggestIdeas({ llm, sessionQuery, subprocess, defaultModel }, sessionId, signal) {
  const observation = await sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
  let cwd, route;
  try { cwd = observation.header?.cwd; route = ideasRoute(observation.events ?? [], defaultModel); } finally { observation[Symbol.dispose]?.(); }
  if (!isText(cwd, 4096)) throw Object.assign(new Error('this chat has no project folder'), { status: 409 });
  if (route === undefined) throw Object.assign(new Error('no model is selected'), { status: 409 });
  const brief = await projectBrief(cwd, { subprocess, signal });
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
  for await (const chunk of call.stream({ ...call.config, system: IDEAS_SYSTEM, signal: callSignal,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Project folder name: ${cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ''}\n\n${brief}` }] }] })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message || `the model call ended: ${finish.kind}`);
  return { ideas: parseIdeas(text), model: route.model };
}

/** The first message of the chat that works on an accepted idea. It starts in plan mode, so nothing changes before the user
 * approves the plan. */
export function ideaPrompt(idea) {
  return [`Implement this feature in this project: ${idea.title}`, '', idea.summary, ...(idea.why ? ['', `Why: ${idea.why}`] : []), '',
    'First read the related code. Then plan the smallest change that delivers this feature, with the checks that prove it works.'].join('\n');
}

/** Start a new chat in the same project (the same sidebar group as the source chat) for one accepted idea, and enter plan
 * mode with the idea as the request. When the profile has no /plan command, or /plan fails, the idea goes as an ordinary
 * message. */
export async function startIdeaChat({ sessionController, sessionQuery, commands, workspaces }, sessionId, idea, signal = new AbortController().signal) {
  const observation = await sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
  let cwd;
  try { cwd = observation.header?.cwd; } finally { observation[Symbol.dispose]?.(); }
  if (!isText(cwd, 4096)) throw Object.assign(new Error('this chat has no project folder'), { status: 409 });
  let workspace;
  try { workspace = workspaces?.list?.().find((w) => w.sessionIds.includes(sessionId)); } catch { workspace = undefined; }
  const { sessionId: created } = await sessionController.create(workspace === undefined ? { cwd } : { workspaceId: workspace.id });
  const found = await sessionController.resolveAgent(created);
  if ('error' in found) throw new Error('the new chat could not start');
  const text = ideaPrompt(idea);
  let planned;
  try { planned = commands?.find?.(found.agent, 'plan') === undefined ? undefined : await commands.execute(found.agent, `/plan ${text}`, [], signal); } catch { planned = undefined; }
  const plan = planned?.result?.kind === 'success';
  if (!plan) await sessionController.prompt({ requestId: randomUUID(), sessionId: created, mode: 'queue', content: [{ type: 'text', text }] }, signal);
  return { sessionId: created, plan };
}

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const isText = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;

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
  installIdeas(ctx);
}

/** Feature ideas: `POST {sessionId}` asks the chat's model for ideas; `POST {sessionId, idea}` starts a chat for one idea.
 * Both act only on the chat's own project folder; the browser never sends a path. */
function installIdeas(ctx) {
  const get = (name) => { try { return ctx.get?.(name); } catch { return undefined; } };
  const status = (error) => (Number.isInteger(error?.status) ? error.status : 502);
  ctx.connection.fetch.register({
    path: IDEAS_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (!isText(body?.sessionId)) return json({ error: 'bad request' }, 400);
      if (body.idea !== undefined) {
        const idea = { title: clip(body.idea?.title, 120), summary: clip(body.idea?.summary, 600), why: clip(body.idea?.why, 300) || undefined };
        if (idea.title === '' || idea.summary === '') return json({ error: 'bad request' }, 400);
        try {
          return json(await startIdeaChat({ sessionController: ctx.sessionController, sessionQuery: ctx.sessionQuery, commands: get('commands'), workspaces: get('workspaceRegistry') },
            body.sessionId, idea, request.signal));
        } catch (error) { return json({ error: String(error?.message ?? error) }, status(error)); }
      }
      const llm = get('llm');
      if (llm === undefined) return json({ error: 'this dsh profile cannot call a model' }, 409);
      try {
        return json(await suggestIdeas({ llm, sessionQuery: ctx.sessionQuery, subprocess: ctx.subprocess, defaultModel: get('agentDefaultModel') }, body.sessionId, request.signal));
      } catch (error) { return json({ error: String(error?.message ?? error) }, status(error)); }
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
