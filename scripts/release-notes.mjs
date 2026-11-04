// The release notes of this version in every UI language (release-notes.json), for What's new after an update.
// `npm test` (test/release-notes.test.mjs) checks the file; release.yml runs this script before it publishes:
// TAG=vX.Y.Z node scripts/release-notes.mjs (in a release event it also compares the GitHub release body).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LANGUAGES } from './build-locales.mjs';
import { NOTES_MAX, releaseNotes } from '../index.js';

/** dsh's own two languages and the 11 of locales/. */
export const NOTES_LANGUAGES = ['en', 'zh', ...LANGUAGES.map(([id]) => id)];

/** The problems of a release-notes.json (`data`); an empty list when it is complete. `body` is the GitHub release body:
 * older copies show it after they install this version, so it must be the English notes. */
export function checkReleaseNotes(data, { version, tag, body } = {}) {
  const problems = [];
  if (data?.version !== version) problems.push(`release-notes.json: version ${JSON.stringify(data?.version)} is not package.json's ${version}`);
  if (tag !== undefined && tag !== `v${version}`) problems.push(`tag ${tag} does not match package.json version ${version}`);
  const notes = data?.notes !== null && typeof data?.notes === 'object' ? data.notes : {};
  const missing = NOTES_LANGUAGES.filter((id) => !Object.hasOwn(notes, id));
  if (missing.length > 0) problems.push(`release-notes.json: no notes for ${missing.join(', ')}`);
  const unknown = Object.keys(notes).filter((id) => !NOTES_LANGUAGES.includes(id));
  if (unknown.length > 0) problems.push(`release-notes.json: unknown languages ${unknown.join(', ')} (use ${NOTES_LANGUAGES.join(', ')})`);
  const english = releaseNotes(notes.en);
  for (const id of NOTES_LANGUAGES.filter((x) => Object.hasOwn(notes, x))) {
    const text = notes[id];
    if (releaseNotes(text) === undefined) problems.push(`release-notes.json: the ${id} notes are empty`);
    else if (text.replace(/\r\n?/g, '\n').trim().length > NOTES_MAX) problems.push(`release-notes.json: the ${id} notes are longer than ${NOTES_MAX} characters`);
    else if (id !== 'en' && releaseNotes(text) === english) problems.push(`release-notes.json: the ${id} notes are the English text (not translated)`);
  }
  if (body !== undefined && releaseNotes(body) !== english) problems.push('the GitHub release body is not the English notes of release-notes.json (use notes.en as the body)');
  return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const { version } = JSON.parse(read('package.json'));
  let data;
  try { data = JSON.parse(read('release-notes.json')); } catch (error) { data = undefined; console.log(`release-notes.json: ${error.message}`); }
  const event = process.env.GITHUB_EVENT_NAME === 'release' ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : undefined;
  const problems = checkReleaseNotes(data, { version, tag: process.env.TAG || undefined, body: event === undefined ? undefined : event.release?.body ?? '' });
  for (const problem of problems) console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${problem}` : problem);
  if (problems.length > 0) process.exit(1);
  console.log(`release notes: ${NOTES_LANGUAGES.length} languages for ${version}`);
}
