// Live copy check (read only): does the live copy of the plugin match ONE commit of main?
// Usage: node scripts/live-copy-check.mjs [--live <folder>] [--commits <n>] [--repo <folder>]
// It compares the sha256 of client.js, index.js, backup.mjs (and release-notes.json when the live copy and main both have
// it) with `git show <commit>:<file>` for the newest n first-parent commits of main. The live client.js keeps its own
// line 12 (`id: '@local/dsh-composer-history'`): before the hash, line 12 of the live file becomes line 12 of the commit.
// Output: `MATCH <short sha> <subject>` and exit 0; else one line per file (newest matching commit or `none`), `MIXED`, exit 1.
// Exit 2: bad argument or git error. It never writes to the live folder.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// ponytail: line 12 is swapped as latin1 text so that the other bytes stay as they are; a file with fewer than 12 lines is not changed.
const withLine12 = (live, from) => {
  const a = live.toString('latin1').split('\n');
  const b = from.toString('latin1').split('\n');
  if (a.length >= 12 && b.length >= 12) a[11] = b[11];
  return Buffer.from(a.join('\n'), 'latin1');
};

export function check({ live, commits = 60, repo }) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  const show = (commit, file) => { try { return git('show', `${commit}:${file}`); } catch { return null; } };
  const log = git('log', '--first-parent', '-n', String(commits), '--format=%H%x09%h%x09%s', 'main').toString('utf8').split('\n').filter(Boolean)
    .map((l) => { const [full, short, ...s] = l.split('\t'); return { full, short, subject: s.join('\t') }; });
  if (!log.length) throw new Error('no commits on main');
  const files = ['client.js', 'index.js', 'backup.mjs'];
  if (existsSync(join(live, 'release-notes.json')) && show(log[0].full, 'release-notes.json')) files.push('release-notes.json');
  const rows = files.map((file) => {
    const path = join(live, file);
    const buf = existsSync(path) ? readFileSync(path) : null;
    let found = null;
    if (buf) {
      for (const c of log) {
        const repoBuf = show(c.full, file);
        if (!repoBuf) continue;
        if (sha(file === 'client.js' ? withLine12(buf, repoBuf) : buf) === sha(repoBuf)) { found = c; break; }
      }
    }
    return { file, found, missing: !buf };
  });
  // One commit for all files: the newest commit that equals every file.
  const all = log.find((c) => rows.every((r) => {
    const repoBuf = show(c.full, r.file);
    const buf = existsSync(join(live, r.file)) ? readFileSync(join(live, r.file)) : null;
    return repoBuf && buf && sha(r.file === 'client.js' ? withLine12(buf, repoBuf) : buf) === sha(repoBuf);
  }));
  return { match: all ?? null, rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = { live: join(homedir(), 'Documents/testdeepseekharness/dsh-composer-history'), commits: 60, repo: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!['--live', '--commits', '--repo'].includes(key) || value === undefined) { console.error('Usage: node scripts/live-copy-check.mjs [--live <folder>] [--commits <n>] [--repo <folder>]'); process.exit(2); }
    if (key === '--commits') { opts.commits = Number(value); if (!Number.isInteger(opts.commits) || opts.commits < 1) { console.error('--commits must be a positive integer'); process.exit(2); } } else opts[key.slice(2)] = resolve(value);
  }
  try {
    const { match, rows } = check(opts);
    if (match) { console.log(`MATCH ${match.short} ${match.subject}`); process.exit(0); }
    for (const r of rows) console.log(r.found ? `${r.file} ${r.found.short} ${r.found.subject}` : `${r.file} none${r.missing ? ' (missing in the live folder)' : ''}`);
    console.log('MIXED');
    process.exit(1);
  } catch (error) { console.error(`live-copy-check: ${error.message}`); process.exit(2); }
}
