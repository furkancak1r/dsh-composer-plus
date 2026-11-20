// Live copy check (read only): does the live copy of the plugin match ONE commit of main?
// Usage: node scripts/live-copy-check.mjs [--live <folder>] [--commits <n>] [--repo <folder>]
// It compares client.js, index.js, backup.mjs, release-notes.json and tether/gateway/{server.mjs,admin.html,qr.swift}
// with `git show <commit>:<file>` for the newest n first-parent commits of the local main. A file that the live folder
// does not have is `none`, so the result is MIXED. The live client.js keeps
// its own line 12 (LIVE_ID): line 12 of the commit becomes LIVE_ID before the compare, so another line 12 matches nothing.
// Output: `MATCH <short sha> <subject> (newest main commit | n commits behind main)`, exit 0; else one line per file
// (newest matching commit or `none`), `MIXED`, exit 1. Exit 2: bad argument, no live folder or git error. No writes.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_ID = "  id: '@local/dsh-composer-history',";
const USAGE = 'Usage: node scripts/live-copy-check.mjs [--live <folder>] [--commits <n>] [--repo <folder>]';
const fail = (text) => { console.error(text); process.exit(2); };
// ponytail: line 12 is swapped as latin1 text so that the other bytes stay as they are; a file with fewer than 12 lines is not changed.
const asLive = (buf) => { const l = buf.toString('latin1').split('\n'); if (l.length >= 12) l[11] = LIVE_ID; return Buffer.from(l.join('\n'), 'latin1'); };

const opts = { live: join(homedir(), 'Documents/testdeepseekharness/dsh-composer-history'), commits: 60, repo: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]; const value = args[i + 1];
  if (!['--live', '--commits', '--repo'].includes(key) || value === undefined || value.startsWith('--')) fail(USAGE);
  if (key !== '--commits') opts[key.slice(2)] = resolve(value);
  else if (/^[1-9]\d*$/.test(value)) opts.commits = Number(value);
  else fail('--commits must be a positive integer');
}
if (!statSync(opts.live, { throwIfNoEntry: false })?.isDirectory()) fail(`live-copy-check: no live folder ${opts.live}`);

const git = (...a) => execFileSync('git', ['-C', opts.repo, ...a], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const show = (commit, file) => { try { return git('show', `${commit}:${file}`); } catch { return null; } };
let log = [];
try {
  log = git('log', '--first-parent', '-n', String(opts.commits), '--format=%H%x09%h%x09%s', 'main').toString('utf8').split('\n').filter(Boolean)
    .map((l) => { const [full, short, ...s] = l.split('\t'); return { full, short, subject: s.join('\t') }; });
} catch (error) { fail(`live-copy-check: ${error.message.trim()}`); }
if (!log.length) fail('live-copy-check: no commits on main');

const files = ['client.js', 'index.js', 'backup.mjs', 'release-notes.json', 'tether/gateway/server.mjs', 'tether/gateway/admin.html', 'tether/gateway/qr.swift'];
const rows = files.map((file) => {
  const path = join(opts.live, file);
  const buf = existsSync(path) ? readFileSync(path) : null;
  // equal[i]: the live file is equal to the file in commit log[i]. A file that the live folder does not have equals nothing.
  const equal = log.map((c) => { const repoBuf = buf && show(c.full, file); return !!repoBuf && buf.equals(file === 'client.js' ? asLive(repoBuf) : repoBuf); });
  return { file, equal, missing: !buf };
});
// One commit for all files: the newest commit where each file is equal.
const at = log.findIndex((_, i) => rows.every((r) => r.equal[i]));
if (at >= 0) console.log(`MATCH ${log[at].short} ${log[at].subject} (${at ? `${at} commit${at > 1 ? 's' : ''} behind main` : 'newest main commit'})`);
else {
  for (const r of rows) {
    if (r.missing && !r.equal.includes(false)) continue; // no checked commit has this file either
    const i = r.missing ? -1 : r.equal.indexOf(true);
    console.log(i >= 0 ? `${r.file} ${log[i].short} ${log[i].subject}` : `${r.file} none${r.missing ? ' (missing in the live folder)' : ''}`);
  }
  console.log('MIXED');
  process.exitCode = 1;
}
