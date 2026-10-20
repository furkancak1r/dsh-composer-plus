// Translated READMEs (README.<id>.md, one per UI language) stay in step with README.md: same pictures, same code blocks,
// same local links, the same version note, and a language bar that reaches every other README.
// `node test/readme.test.mjs tr de` checks only those translations; without arguments every translation must exist.
import assert from 'node:assert/strict'; import { existsSync, readFileSync } from 'node:fs';
import { LANGUAGES } from '../scripts/build-locales.mjs';
const url = (p) => new URL(`../${p}`, import.meta.url);
const ids = ['zh', ...LANGUAGES.map(([id]) => id)];
const only = process.argv.slice(2);
const version = JSON.parse(readFileSync(url('package.json'))).version;
const files = ['README.md', ...ids.map((id) => `README.${id}.md`)];
const pictures = (s) => [...s.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
const codeBlocks = (s) => s.match(/^```[\s\S]*?^```/gm) ?? [];
const localLinks = (s) => [...s.matchAll(/\]\(([^)\s]+)\)|href="([^"]+)"/g)].map((m) => m[1] ?? m[2]).filter((l) => !/^[a-z]+:/.test(l) && !l.startsWith('#'));
const source = readFileSync(url('README.md'), 'utf8');
for (const file of only.length ? only.map((id) => (id === 'en' ? 'README.md' : `README.${id}.md`)) : files) {
  assert.ok(existsSync(url(file)), `${file} exists`);
  const text = readFileSync(url(file), 'utf8');
  if (file !== 'README.md') {
    assert.deepEqual(pictures(text), pictures(source), `${file}: same pictures in the same order`);
    assert.deepEqual(codeBlocks(text), codeBlocks(source), `${file}: code blocks unchanged`);
  }
  // The language bar's README links are checked below; a full run also checks that every README exists.
  for (const link of localLinks(text).filter((l) => !/^README\.[\w-]+\.md$/.test(l))) assert.ok(existsSync(url(link.split('#')[0])), `${file}: link target ${link} exists`);
  for (const [, v] of text.matchAll(/dsh-composer-plus@(\d+\.\d+\.\d+)/g)) assert.equal(v, version, `${file}: version note matches package.json`);
  const bar = text.split('\n').find((line) => line.includes('README.') && line.includes(' · '));
  assert.ok(bar, `${file}: has the language bar`);
  for (const other of files) if (other !== file) assert.ok(bar.includes(`](${other})`), `${file}: language bar links ${other}`);
  assert.ok(!bar.includes(`](${file})`), `${file}: language bar does not link itself`);
}
console.log(`readme checks passed (${only.length || files.length} files)`);
