// Release notes in every UI language (release-notes.json): the check that npm test and release.yml run, the repository's
// own file, and the Host's reading of it (shippedNotes). The dialog side is in test/update.test.mjs.
import assert from 'node:assert/strict'; import { execFileSync } from 'node:child_process'; import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { checkReleaseNotes, NOTES_LANGUAGES } from '../scripts/release-notes.mjs';
import { shippedNotes, NOTES_MAX } from '../index.js';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;

assert.deepEqual(NOTES_LANGUAGES, ['en', 'zh', 'tr', 'es', 'pt-BR', 'fr', 'de', 'ru', 'ja', 'ko', 'id', 'vi', 'hi'], 'en, zh and the 11 languages of locales/');
// The repository's file: this version, all 13 languages, translated.
const file = JSON.parse(read('release-notes.json'));
assert.deepEqual(checkReleaseNotes(file, { version, tag: `v${version}` }), [], 'release-notes.json is complete for this version');
// Each translation keeps the Markdown shape and the code of the English notes.
const shape = (text) => text.split('\n').map((line) => (line.startsWith('## ') ? '#' : line.startsWith('- ') ? '-' : line.trim() === '' ? '' : 'p')).join('');
const code = (text) => [...text.matchAll(/`[^`\n]+`/g)].map((m) => m[0]).sort();
for (const id of NOTES_LANGUAGES) {
  assert.equal(shape(file.notes[id]), shape(file.notes.en), `${id}: the same headings, bullets and paragraphs as the English notes`);
  assert.deepEqual(code(file.notes[id]), code(file.notes.en), `${id}: the same code spans as the English notes`);
}

// The check: a complete file passes; each problem is named.
const notes = Object.fromEntries(NOTES_LANGUAGES.map((id) => [id, `## New\n\n- ${id} note.`]));
const ok = { version: '1.2.3', notes };
const check = (data, extra = {}) => checkReleaseNotes(data, { version: '1.2.3', ...extra });
assert.deepEqual(check(ok, { tag: 'v1.2.3', body: '## New\r\n\r\n- en note.\r\n' }), [], 'complete; a CRLF body is the same text');
const without = (id) => ({ ...ok, notes: Object.fromEntries(Object.entries(notes).filter(([x]) => x !== id)) });
assert.deepEqual(check(without('tr')), ['release-notes.json: no notes for tr'], 'a missing language is named');
assert.match(check({ ...ok, notes: { en: 'x' } })[0], /no notes for zh, tr, es, pt-BR, fr, de, ru, ja, ko, id, vi, hi$/);
assert.deepEqual(check({ ...ok, notes: { ...notes, it: 'Note.' } }), ['release-notes.json: unknown languages it (use en, zh, tr, es, pt-BR, fr, de, ru, ja, ko, id, vi, hi)']);
assert.deepEqual(check({ ...ok, notes: { ...notes, de: ' \n' } }), ['release-notes.json: the de notes are empty']);
assert.deepEqual(check({ ...ok, notes: { ...notes, de: 5 } }), ['release-notes.json: the de notes are empty'], 'not text');
assert.deepEqual(check({ ...ok, notes: { ...notes, ja: 'a'.repeat(NOTES_MAX + 1) } }), [`release-notes.json: the ja notes are longer than ${NOTES_MAX} characters`], 'never cut in silence');
assert.deepEqual(check({ ...ok, notes: { ...notes, ko: notes.en } }), ['release-notes.json: the ko notes are the English text (not translated)']);
assert.deepEqual(check({ ...ok, version: '1.2.2' }), ['release-notes.json: version "1.2.2" is not package.json\'s 1.2.3']);
assert.deepEqual(check(ok, { tag: 'v1.2.4' }), ['tag v1.2.4 does not match package.json version 1.2.3']);
assert.deepEqual(check(ok, { body: '' }), ['the GitHub release body is not the English notes of release-notes.json (use notes.en as the body)'], 'an empty body: older copies would show nothing');
assert.equal(check(ok, { body: '## New\n\n- other.' }).length, 1, 'another body');
assert.equal(check(undefined).length, 2, 'no file: wrong version and every language missing');
assert.equal(check({ version: '1.2.3', notes: null }).length, 1);

// The script as release.yml runs it: TAG, and in a release event the body from GITHUB_EVENT_PATH.
const dir = mkdtempSync(join(tmpdir(), 'cp-release-notes-'));
try {
  const run = (env) => { try { return { code: 0, out: execFileSync(process.execPath, ['scripts/release-notes.mjs'], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ release: { tag_name: `v${version}`, body: file.notes.en } }));
  assert.equal(run({ TAG: `v${version}`, GITHUB_EVENT_NAME: 'release', GITHUB_EVENT_PATH: event }).code, 0, 'the release event passes with the English body');
  writeFileSync(event, JSON.stringify({ release: { tag_name: `v${version}`, body: 'Other text.' } }));
  const bad = run({ TAG: `v${version}`, GITHUB_EVENT_NAME: 'release', GITHUB_EVENT_PATH: event, GITHUB_ACTIONS: 'true' });
  assert.equal(bad.code, 1); assert.match(bad.out, /^::error::the GitHub release body is not the English notes/m, 'an Actions error line');
  assert.equal(run({ TAG: 'v0.0.1' }).code, 1, 'a wrong tag fails');
  assert.equal(run({ TAG: `v${version}`, GITHUB_EVENT_NAME: 'workflow_dispatch' }).code, 0, 'a manual run checks no body');
} finally { rmSync(dir, { recursive: true, force: true }); }
// release.yml runs the check before it tests and publishes.
const workflow = read('.github/workflows/release.yml');
assert.ok(workflow.indexOf('run: node scripts/release-notes.mjs') > 0 && workflow.indexOf('run: node scripts/release-notes.mjs') < workflow.indexOf('npm publish'), 'release.yml checks the notes before npm publish');
assert.ok(JSON.parse(read('package.json')).files.includes('release-notes.json'), 'the npm package ships release-notes.json');

// The Host reads only its own version's notes, only language ids with a text.
const text = (data) => JSON.stringify(data);
assert.deepEqual(shippedNotes(text({ version: '1.2.3', notes: { en: '## New\r\n\r\n- a.\r\n\r\n## Install\n\nx', tr: 'Yeni.' } }), '1.2.3'), { en: '## New\n\n- a.', tr: 'Yeni.' }, 'the install section goes, CRLF becomes LF');
assert.equal(shippedNotes(text(ok), '1.2.4'), undefined, 'notes of another version');
assert.equal(shippedNotes('{broken', '1.2.3'), undefined); assert.equal(shippedNotes(text({ version: '1.2.3', notes: 'x' }), '1.2.3'), undefined);
assert.equal(shippedNotes(text({ version: '1.2.3', notes: { en: '  ', tr: 7 } }), '1.2.3'), undefined, 'no text at all');
const odd = shippedNotes('{"version":"1.2.3","notes":{"__proto__":"P.","EN_us":"B.","x":"C.","pt-BR":"Ok."}}', '1.2.3');
assert.deepEqual(Object.keys(odd), ['pt-BR'], 'only language ids'); assert.equal(Object.getPrototypeOf(odd), Object.prototype);
assert.equal(shippedNotes(text({ version: '1.2.3', notes: { en: 'a'.repeat(NOTES_MAX + 9) } }), '1.2.3').en.length, NOTES_MAX);
console.log(`release notes checks passed (${NOTES_LANGUAGES.length} languages)`);
