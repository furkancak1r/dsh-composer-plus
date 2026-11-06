// Usage count, for the owner: `node scripts/active-count.mjs`. GitHub counts the requests per release file (index.js
// activeCounter), and each release carries two files:
// - active.txt: each installed copy asks for it at most once a UTC day (daily active copies);
// - installed.txt: each installed copy asks for it once in its life (unique copies; the sum over all releases).
// This script reads the public counts (no token), prints them per version and the change since its last run, and saves
// this run in ~/.cache/dsh-composer-plus/active-counts.json (counts only). Run it on two days: the change of active.txt is
// the daily active copies. The counts are copies (one per DSH_HOME), not people; GitHub updates them about 10 minutes
// after a request.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTIVE_ASSET, INSTALLED_ASSET } from '../index.js';

/** The download count of the file `name` per version, for the releases that have it. */
const countsOf = (releases, name) => {
  const counts = {};
  for (const r of releases) {
    const asset = (r?.assets ?? []).find((a) => a?.name === name);
    if (typeof r?.tag_name === 'string' && Number.isInteger(asset?.download_count)) counts[r.tag_name.replace(/^v/, '')] = asset.download_count;
  }
  return counts;
};
/** One row per version; `change` only when there is an earlier run (`before`; a version that it does not have starts at 0). */
const rowsOf = (counts, before) => Object.entries(counts).map(([version, count]) => ({ version, count, change: before === undefined ? undefined : count - (before?.[version] ?? 0) }));
const sum = (rows, key) => rows.reduce((n, row) => n + (row[key] ?? 0), 0);

/** `releases`: GitHub's release list. `previous`: the last saved run (`{ at, counts, installed }`; runs of older versions
 * of this script have no `installed`) or undefined. Returns this run (saved for the next run), the daily active rows
 * (`rows`, `total`, `change`, `hours`, `perDay`) and the unique copies (`unique`: `rows`, `total`, `change`), newest
 * version first. */
export function report(releases, previous, now = Date.now()) {
  const counts = countsOf(releases, ACTIVE_ASSET);
  const installed = countsOf(releases, INSTALLED_ASSET);
  const hours = previous?.at === undefined ? undefined : (now - previous.at) / 3600000;
  const rows = rowsOf(counts, hours === undefined ? undefined : previous.counts ?? {});
  const change = hours === undefined ? undefined : sum(rows, 'change');
  // A run of an older version of this script has no installed counts: the new copies since then are not known.
  const installedBefore = hours === undefined ? undefined : previous.installed;
  const uniqueRows = rowsOf(installed, installedBefore);
  return {
    run: { at: now, counts, installed },
    rows,
    total: sum(rows, 'count'),
    change,
    hours,
    // A copy counts once per UTC day, so less than about a day between runs says little about a whole day.
    perDay: change === undefined || hours < 20 ? undefined : Math.round((change * 24) / hours),
    unique: { rows: uniqueRows, total: sum(uniqueRows, 'count'), change: installedBefore === undefined ? undefined : sum(uniqueRows, 'change') },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = join(homedir(), '.cache', 'dsh-composer-plus', 'active-counts.json');
  // ponytail: the newest 100 releases; older ones have no active.txt or installed.txt (the counts started later).
  const response = await fetch('https://api.github.com/repos/furkancak1r/dsh-composer-plus/releases?per_page=100',
    { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-composer-plus-active-count' } });
  if (!response.ok) { console.error(`GitHub answered ${response.status}`); process.exit(1); }
  const previous = await readFile(file, 'utf8').then(JSON.parse, () => undefined);
  const r = report(await response.json(), previous);
  const line = (version, count, change) => `${version.padEnd(11)} ${String(count).padStart(7)}${change === undefined ? '' : `   +${change}`}`;
  console.log(`Daily active copies (${ACTIVE_ASSET}):`);
  if (r.rows.length === 0) console.log(`No release has ${ACTIVE_ASSET} yet: the count starts with the first release that has it.`);
  for (const row of r.rows) console.log(line(`v${row.version}`, row.count, row.change));
  console.log(`${line('total', r.total)}${r.change === undefined ? '' : `   +${r.change} in ${r.hours.toFixed(1)} h`}`);
  if (r.perDay !== undefined) console.log(`≈ ${r.perDay} active copies per day`);
  else console.log('Run this again in a day or more: the change between two runs gives the active copies per day.');
  console.log(`\nUnique copies (${INSTALLED_ASSET}, each copy once):`);
  if (r.unique.rows.length === 0) console.log(`No release has ${INSTALLED_ASSET} yet: the count starts with the first release that has it.`);
  for (const row of r.unique.rows) console.log(line(`v${row.version}`, row.count, row.change));
  console.log(`${line('total', r.unique.total)}${r.unique.change === undefined ? '' : `   +${r.unique.change} new since the last run`}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(r.run), { mode: 0o600 });
}
