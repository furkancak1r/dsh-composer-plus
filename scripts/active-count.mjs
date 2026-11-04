// Daily active count, for the owner: `node scripts/active-count.mjs`. Each installed copy asks for its release's
// active.txt at most once a UTC day (index.js activeCounter), and GitHub counts the requests per release file. This script
// reads the public counts (no token), prints them per version and the change since its last run, and saves this run in
// ~/.cache/dsh-composer-plus/active-counts.json (counts only). Run it on two days: the change is the daily active copies.
// The counts are copies (one per DSH_HOME), not people; GitHub updates them about 10 minutes after a request.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTIVE_ASSET } from '../index.js';

/** `releases`: GitHub's release list. `previous`: the last saved run (`{ at, counts }`) or undefined. Returns this run
 * (`{ at, counts }`, saved for the next run) and the rows to print, newest version first. */
export function report(releases, previous, now = Date.now()) {
  const counts = {};
  for (const r of releases) {
    const asset = (r?.assets ?? []).find((a) => a?.name === ACTIVE_ASSET);
    if (typeof r?.tag_name === 'string' && Number.isInteger(asset?.download_count)) counts[r.tag_name.replace(/^v/, '')] = asset.download_count;
  }
  const hours = previous?.at === undefined ? undefined : (now - previous.at) / 3600000;
  const rows = Object.entries(counts).map(([version, count]) => {
    const before = previous?.counts?.[version];
    return { version, count, change: hours === undefined ? undefined : count - (before ?? 0) };
  });
  const sum = (key) => rows.reduce((n, row) => n + (row[key] ?? 0), 0);
  const change = hours === undefined ? undefined : sum('change');
  return {
    run: { at: now, counts },
    rows,
    total: sum('count'),
    change,
    hours,
    // A copy counts once per UTC day, so less than about a day between runs says little about a whole day.
    perDay: change === undefined || hours < 20 ? undefined : Math.round((change * 24) / hours),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = join(homedir(), '.cache', 'dsh-composer-plus', 'active-counts.json');
  // ponytail: the newest 100 releases; older ones have no active.txt (the count started with a later release).
  const response = await fetch('https://api.github.com/repos/furkancak1r/dsh-composer-plus/releases?per_page=100',
    { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-composer-plus-active-count' } });
  if (!response.ok) { console.error(`GitHub answered ${response.status}`); process.exit(1); }
  const previous = await readFile(file, 'utf8').then(JSON.parse, () => undefined);
  const r = report(await response.json(), previous);
  if (r.rows.length === 0) console.log(`No release has ${ACTIVE_ASSET} yet: the count starts with the first release that has it.`);
  for (const row of r.rows) console.log(`v${row.version.padEnd(10)} ${String(row.count).padStart(7)}${row.change === undefined ? '' : `   +${row.change}`}`);
  console.log(`total       ${String(r.total).padStart(7)}${r.change === undefined ? '' : `   +${r.change} in ${r.hours.toFixed(1)} h`}`);
  if (r.perDay !== undefined) console.log(`≈ ${r.perDay} active copies per day`);
  else console.log('Run this again in a day or more: the change between two runs gives the active copies per day.');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(r.run), { mode: 0o600 });
}
