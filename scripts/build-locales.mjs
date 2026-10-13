// Data-only language packs (locales/<id>.json) are embedded in dsh's single client entry (no runtime fetch/import).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
// Order = order in the language menu. Labels are each language's own name.
export const LANGUAGES = [
  ['tr', 'Türkçe'], ['es', 'Español'], ['pt-BR', 'Português (Brasil)'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['ru', 'Русский'], ['ja', '日本語'], ['ko', '한국어'], ['id', 'Bahasa Indonesia'], ['vi', 'Tiếng Việt'], ['hi', 'हिन्दी'],
];
const source = new URL('../client.js', import.meta.url);
const packs = {};
for (const [id] of LANGUAGES) {
  const file = new URL(`../locales/${id}.json`, import.meta.url);
  if (!existsSync(file)) throw new Error(`Missing language file: locales/${id}.json`);
  const namespaces = JSON.parse(readFileSync(file, 'utf8'));
  for (const [ns, dict] of Object.entries(namespaces)) {
    if (!dict || typeof dict !== 'object' || Array.isArray(dict) || Object.values(dict).some((text) => typeof text !== 'string')) throw new Error(`Invalid dictionary: ${id}/${ns}`);
  }
  packs[id] = namespaces;
}
const before = readFileSync(source, 'utf8');
const region = /(    \/\/ BEGIN GENERATED LANGUAGES[^\n]*\n)[\s\S]*?(    \/\/ END GENERATED LANGUAGES)/;
if (!region.test(before)) throw new Error('Missing generated language block');
const block = `    const LANGUAGES = ${JSON.stringify(LANGUAGES.map(([id, label]) => ({ id, label })))};\n`
  + `    const LANGUAGE_PACKS = ${JSON.stringify(packs)};\n`;
const after = before.replace(region, (_, start, end) => start + block + end);
if (process.argv.includes('--check')) {
  if (before !== after) throw new Error('Language bundle is stale; run npm run build:locales');
} else if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(source, after);
