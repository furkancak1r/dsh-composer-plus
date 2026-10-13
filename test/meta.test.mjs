// Plugins page metadata: dsh reads package.json `icon` and `locale/<id>.json` meta through the package exports.
import assert from 'node:assert/strict'; import { readFileSync, readdirSync } from 'node:fs';
import { LANGUAGES } from '../scripts/build-locales.mjs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));
assert.equal(pkg.icon, './assets/icon.svg'); assert.ok(read('../assets/icon.svg').startsWith('<svg') && read('../assets/icon.svg').length < 256 * 1024);
assert.equal(pkg.exports['./locale/*.json'], './locale/*.json'); assert.equal(pkg.exports['./package.json'], './package.json');
assert.ok(pkg.files.includes('locale/*.json') && pkg.files.includes('assets/icon.svg'));
const ids = readdirSync(new URL('../locale/', import.meta.url)).map((f) => f.slice(0, -5)).sort();
const expected = ['en', 'zh', ...LANGUAGES.map(([id]) => id)].sort();
assert.deepEqual(ids, expected, 'one meta file per UI language');
for (const id of ids) {
  const { meta } = JSON.parse(read(`../locale/${id}.json`));
  assert.equal(meta.title, 'Composer Plus', id); assert.ok(meta.description.trim().length > 20, id);
}
console.log(`meta checks passed (${ids.length} languages, icon)`);
