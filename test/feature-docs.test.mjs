// AGENTS.md rule 4, enforced: every id in FEATURES (client.js) has a row in the feature table of README.md and of each
// translated README.<id>.md (anchor `feature-<id>`, with the feature's Settings screenshot), and an entry in llms.txt.
// Add the feature to docs/features.json, then run `npm run build:readme`.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { DOC_LANGUAGES, anchorOf, pluginTexts, readmeOf } from '../scripts/build-docs.mjs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const src = read('client.js');
const features = [...src.match(/const FEATURES = \[([^\]]*)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
const shotOf = Object.fromEntries([...src.match(/const SHOT_OF = \{([^}]*)\}/)[1].matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
const en = pluginTexts().en;
assert.ok(features.length > 20, 'FEATURES was read');
const missing = [];
for (const lang of DOC_LANGUAGES) {
  const file = readmeOf(lang);
  const rows = read(file).split('\n').filter((line) => line.startsWith('| '));
  for (const id of features) {
    const row = rows.find((line) => line.includes(`<a id="${anchorOf(id)}"></a>`));
    if (row === undefined) missing.push(`${file}: no feature table row for "${id}"`);
    else if (!row.includes(`assets/features/${shotOf[id]}.webp`)) missing.push(`${file}: the row of "${id}" does not show ${shotOf[id]}.webp`);
  }
}
const llms = read('llms.txt').split('\n');
for (const id of features) if (!llms.some((line) => line.startsWith(`- ${en[`feature.${id}`]}: `))) missing.push(`llms.txt: no entry "- ${en[`feature.${id}`]}: …" for "${id}"`);
assert.deepEqual(missing, [], `undocumented features (add them to docs/features.json, then run npm run build:readme):\n${missing.join('\n')}`);
console.log(`feature docs: ${features.length} features documented in ${DOC_LANGUAGES.length} READMEs and llms.txt`);
