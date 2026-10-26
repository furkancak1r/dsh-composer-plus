// The bold button and menu names in each translated README.<id>.md are the app's own label texts: each one is a text of
// locales/<id>.json (dsh's texts and Composer Plus's). A label that the app does not have, or no longer has, fails.
// Skipped: a bold lead-in or FAQ question (it ends with ":" or "?"), and parts with no letter (✓, ▶, ↶).
// `A → B → C` is a menu path: each part must be a label. `node test/readme-labels.test.mjs tr de` checks only those.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { LANGUAGES } from '../scripts/build-locales.mjs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** English-only labels of Tether and its Mac pairing page (no language pack). Each one must still be in their source. */
const TETHER = ['Open in Tether', 'Scan code', 'Connect', 'Approve', 'Remove', 'Tailscale only', 'Privacy', 'Lock with Face ID'];
const tetherSource = read('tether/ios/Sources/UI.swift') + read('tether/gateway/admin.html');
for (const label of TETHER) assert.ok(tetherSource.includes(`"${label}"`) || tetherSource.includes(`>${label}<`) || tetherSource.includes(`**${label}**`), `Tether label "${label}" is still in Tether`);
/** One form for a label and a README text: placeholders and counts out, no leading symbol, no closing "…", ":" or ".". */
const norm = (s) => s.replace(/\{\w+\}/g, 'N').replace(/\s*\((?:N|\d+)\)$/, '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/[\s…:.]+$/u, '').trim().toLocaleLowerCase();
const texts = (dict, out = []) => { for (const v of Object.values(dict)) { if (typeof v === 'string') out.push(v); else texts(v, out); } return out; };
const names = ['English', '中文', ...LANGUAGES.map(([, label]) => label), ...TETHER];
const only = process.argv.slice(2);
const ids = only.length ? only : LANGUAGES.map(([id]) => id);
const problems = [];
let checked = 0;
for (const id of ids) {
  const file = `README.${id}.md`;
  const labels = new Set([...texts(JSON.parse(read(`locales/${id}.json`))), ...names].map(norm));
  const text = read(file).replace(/^```[\s\S]*?^```/gm, '');
  for (const [, bold] of text.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
    if (/[:：?？]\s*$/u.test(bold)) continue;
    for (const part of bold.split(' → ')) {
      if (!/\p{L}/u.test(part)) continue;
      checked++;
      if (!labels.has(norm(part))) problems.push(`${file}: "${part}" is not a label in locales/${id}.json`);
    }
  }
}
assert.deepEqual(problems, [], `README labels that the app does not have (use the label text of the language pack, or remove the bold):\n${[...new Set(problems)].join('\n')}`);
console.log(`readme labels: ${checked} bold labels in ${ids.length} translations match their language pack`);
