// Anonymous usage count: one request per UTC day for this version's active.txt, and one request in a copy's life for its
// installed.txt (`once`), with no data; no request from a renamed copy, a pre-release, a git checkout or the second call of
// a day. The owner's report counts the change per version and the unique copies.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeCounter, apply } from '../index.js';
import { report } from '../scripts/active-count.mjs';

const root = mkdtempSync(join(tmpdir(), 'cp-active-'));
const pkg = { name: 'dsh-composer-plus', version: '1.2.3' };
const DAY = 86400000;
const t0 = Date.parse('2026-11-04T23:59:00Z');
const fake = (answer = () => new Response(null, { status: 302, headers: { location: 'https://cdn.example/x' } })) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return answer(); };
  return { calls, fetchImpl };
};

try {
  // 1. No request from a renamed copy, a pre-release or a git checkout, for the daily and for the one-time count.
  for (const kind of [{}, { asset: 'installed.txt', once: true }]) {
    for (const [opts, why] of [[{ pkg: { name: '@local/dsh-composer-history', version: '1.2.3' } }, 'renamed live copy'],
      [{ pkg: { name: 'dsh-composer-plus', version: '1.2.3-trust.4' } }, 'pre-release'], [{ dev: true }, 'git checkout']]) {
      const f = fake();
      assert.equal(await activeCounter({ file: join(root, 'skip.json'), pkg, fetchImpl: f.fetchImpl, ...kind, ...opts })(), 'skip', `${why} ${kind.asset ?? ''}`);
      assert.equal(f.calls.length, 0, `${why} ${kind.asset ?? ''}: no request`);
    }
  }
  assert.throws(() => statSync(join(root, 'skip.json')), 'a skipped copy writes no file');

  // 2. The first call of a day: one request with no data, the day saved owner-only.
  let now = t0;
  const file = join(root, 'a', 'active.json');
  const f = fake();
  const count = activeCounter({ file, pkg, fetchImpl: f.fetchImpl, now: () => now });
  assert.equal(await count(), 'sent');
  assert.equal(f.calls.length, 1);
  const [{ url, init }] = f.calls;
  assert.equal(url, 'https://github.com/furkancak1r/dsh-composer-plus/releases/download/v1.2.3/active.txt', 'this version\'s file, no query');
  assert.equal(init.redirect, 'manual', 'GitHub counts the redirect; the file itself is not fetched');
  assert.deepEqual(Object.keys(init).sort(), ['headers', 'redirect', 'signal']);
  assert.deepEqual(init.headers, { 'user-agent': 'dsh-composer-plus' }, 'no other header');
  assert.equal(init.method, undefined, 'GET, no body');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { day: '2026-11-04' }, 'UTC day');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'owner-only');

  // 3. Same day: no request; a call while one runs shares it; the next UTC day: one request.
  assert.equal(await count(), 'done'); assert.equal(f.calls.length, 1, 'once a day');
  now = t0 + 2 * 60000; // 00:01 UTC on the next day
  const [a, b] = await Promise.all([count(), count()]);
  assert.deepEqual([a, b], ['sent', 'sent'], 'two calls at once share one request');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { day: '2026-11-05' });

  // A new start reads the saved day: no second request that day.
  const again = fake();
  assert.equal(await activeCounter({ file, pkg, fetchImpl: again.fetchImpl, now: () => now })(), 'done');
  assert.equal(again.calls.length, 0, 'the saved day survives a restart');
  // A broken file is no day.
  writeFileSync(file, '{oops');
  const broken = fake();
  assert.equal(await activeCounter({ file, pkg, fetchImpl: broken.fetchImpl, now: () => now })(), 'sent');

  // A failed save: the day stays in memory, so no second request that day.
  const ro = join(root, 'ro'); mkdirSync(ro); chmodSync(ro, 0o500);
  const noSave = fake();
  const countRo = activeCounter({ file: join(ro, 'x', 'active.json'), pkg, fetchImpl: noSave.fetchImpl, now: () => now });
  assert.equal(await countRo(), 'sent'); assert.equal(await countRo(), 'done'); assert.equal(noSave.calls.length, 1, 'a failed save sends no second request');
  chmodSync(ro, 0o700);

  // 4. 404 (the release has no file): done. Network error, 403, 429, 503: try again later.
  const missing = fake(() => new Response('Not Found', { status: 404 }));
  const countMissing = activeCounter({ file: join(root, 'm.json'), pkg, fetchImpl: missing.fetchImpl, now: () => now });
  assert.equal(await countMissing(), 'sent'); assert.equal(await countMissing(), 'done'); assert.equal(missing.calls.length, 1);
  for (const answer of [() => { throw new TypeError('fetch failed'); }, () => new Response('', { status: 403 }), () => new Response('', { status: 429 }), () => new Response('', { status: 503 })]) {
    const down = fake(answer);
    const countDown = activeCounter({ file: join(root, 'd.json'), pkg, fetchImpl: down.fetchImpl, now: () => now });
    assert.equal(await countDown(), 'retry'); assert.equal(await countDown(), 'retry'); assert.equal(down.calls.length, 2, 'no day saved: tries again');
  }
  assert.throws(() => statSync(join(root, 'd.json')), 'no file after failed requests');

  // 4b. Unique count (`once`): one request in the copy's life for installed.txt; the mark survives a restart and a new day.
  {
    let at = t0;
    const ifile = join(root, 'u', 'installed.json');
    const u = fake();
    const unique = activeCounter({ file: ifile, pkg, fetchImpl: u.fetchImpl, now: () => at, asset: 'installed.txt', once: true });
    assert.equal(await unique(), 'sent');
    assert.equal(u.calls.length, 1);
    assert.equal(u.calls[0].url, 'https://github.com/furkancak1r/dsh-composer-plus/releases/download/v1.2.3/installed.txt', 'this version\'s installed.txt, no query');
    assert.deepEqual(u.calls[0].init.headers, { 'user-agent': 'dsh-composer-plus' }, 'no other header');
    assert.equal(u.calls[0].init.redirect, 'manual');
    assert.deepEqual(JSON.parse(readFileSync(ifile, 'utf8')), { day: '2026-11-04', done: true }, 'the lifetime mark');
    assert.equal(statSync(ifile).mode & 0o777, 0o600, 'owner-only');
    at = t0 + 30 * DAY;
    assert.equal(await unique(), 'done'); assert.equal(u.calls.length, 1, 'never again, also on a later day');
    const restart = fake();
    assert.equal(await activeCounter({ file: ifile, pkg, fetchImpl: restart.fetchImpl, now: () => at, asset: 'installed.txt', once: true })(), 'done');
    assert.equal(restart.calls.length, 0, 'a second start sends no request');
    // A newer version of the same copy is not counted again.
    assert.equal(await activeCounter({ file: ifile, pkg: { ...pkg, version: '1.3.0' }, fetchImpl: restart.fetchImpl, now: () => at, asset: 'installed.txt', once: true })(), 'done');
    assert.equal(restart.calls.length, 0, 'an update is the same copy');
    // The daily count keeps its own file and format: a lifetime mark there does not stop it on another day.
    const daily = fake();
    assert.equal(await activeCounter({ file: ifile, pkg, fetchImpl: daily.fetchImpl, now: () => at })(), 'sent', 'the daily count ignores done');
    assert.deepEqual(JSON.parse(readFileSync(ifile, 'utf8')), { day: '2026-12-04' }, 'the daily count writes only the day');

    // 404 (this release has no installed.txt): no lifetime mark, no second request that day, a new request the next day.
    at = t0;
    const nfile = join(root, 'n', 'installed.json');
    let status = 404;
    const nf = fake(() => new Response(status === 404 ? 'Not Found' : null, { status }));
    const countNf = activeCounter({ file: nfile, pkg, fetchImpl: nf.fetchImpl, now: () => at, asset: 'installed.txt', once: true });
    assert.equal(await countNf(), 'sent'); assert.equal(nf.calls.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(nfile, 'utf8')), { day: '2026-11-04' }, '404: only the day, no lifetime mark');
    assert.equal(await countNf(), 'done'); assert.equal(nf.calls.length, 1, '404: no second request the same day');
    const nfRestart = fake();
    assert.equal(await activeCounter({ file: nfile, pkg, fetchImpl: nfRestart.fetchImpl, now: () => at, asset: 'installed.txt', once: true })(), 'done');
    assert.equal(nfRestart.calls.length, 0, '404: a restart the same day sends nothing');
    at = t0 + 2 * 60000; // the next UTC day
    status = 302;
    assert.equal(await countNf(), 'sent'); assert.equal(nf.calls.length, 2, '404: tried again the next day');
    assert.deepEqual(JSON.parse(readFileSync(nfile, 'utf8')), { day: '2026-11-05', done: true }, 'counted on the next day');
    at = t0 + 5 * DAY;
    assert.equal(await countNf(), 'done'); assert.equal(nf.calls.length, 2);

    // Network error, 403, 429, 5xx: no mark, tried again on the next call (each hour).
    for (const answer of [() => { throw new TypeError('fetch failed'); }, () => new Response('', { status: 403 }), () => new Response('', { status: 429 }), () => new Response('', { status: 500 }), () => new Response('', { status: 503 })]) {
      const down = fake(answer);
      const dfile = join(root, 'ud.json');
      const countDown = activeCounter({ file: dfile, pkg, fetchImpl: down.fetchImpl, now: () => at, asset: 'installed.txt', once: true });
      assert.equal(await countDown(), 'retry'); assert.equal(await countDown(), 'retry'); assert.equal(down.calls.length, 2, 'no mark: tries again');
      assert.throws(() => statSync(dfile), 'no file after a failed request');
    }

    // A failed save: the mark stays in memory, so the same session sends no second request.
    const uro = join(root, 'uro'); mkdirSync(uro); chmodSync(uro, 0o500);
    const noSave = fake();
    const countRo = activeCounter({ file: join(uro, 'x', 'installed.json'), pkg, fetchImpl: noSave.fetchImpl, now: () => at, asset: 'installed.txt', once: true });
    assert.equal(await countRo(), 'sent');
    at += 3 * DAY;
    assert.equal(await countRo(), 'done'); assert.equal(noSave.calls.length, 1, 'a failed save sends no second request, also on a later day');
    chmodSync(uro, 0o700);
  }

  // 5. This repo is a git checkout: apply() never sends the request, also after dsh is ready.
  {
    const realFetch = globalThis.fetch; let fetched = 0; globalThis.fetch = async () => { fetched++; return new Response(null, { status: 302 }); };
    process.env.DSH_HOME = join(root, 'home');
    const effects = []; const ready = [];
    apply({ on() {}, effect: (fn) => { effects.push(fn()); }, get: (name) => (name === 'appReady' ? { onReady: (fn) => { ready.push(fn); return () => {}; } } : undefined),
      connection: { fetch: { register() {} } }, sessionController: {}, sessionQuery: {}, subprocess: {} });
    assert.ok(ready.length > 0, 'waits for dsh to be ready');
    for (const fn of ready) fn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fetched, 0, 'a git checkout is not counted');
    assert.throws(() => statSync(join(root, 'home', 'storages', 'dsh-composer-plus', 'active.json')));
    assert.throws(() => statSync(join(root, 'home', 'storages', 'dsh-composer-plus', 'installed.json')), 'no unique count from a git checkout');
    for (const off of effects) off?.();
    globalThis.fetch = realFetch; delete process.env.DSH_HOME;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // 6. The owner's report: counts per version, the change since the last run, active copies per day.
  const releases = (counts) => Object.entries(counts).map(([v, n]) => ({ tag_name: `v${v}`, assets: n === undefined ? [] : [{ name: 'x.tgz', download_count: 999 }, { name: 'active.txt', download_count: n }] }));
  const first = report(releases({ '1.22.0': 40, '1.21.0': 100, '1.20.0': undefined }), undefined, t0);
  assert.deepEqual(first.run, { at: t0, counts: { '1.22.0': 40, '1.21.0': 100 }, installed: {} }, 'only releases with active.txt');
  assert.equal(first.total, 140); assert.equal(first.change, undefined); assert.equal(first.perDay, undefined, 'first run: no change yet');
  const second = report(releases({ '1.23.0': 5, '1.22.0': 90, '1.21.0': 110 }), first.run, t0 + DAY);
  assert.deepEqual(second.rows.map((r) => [r.version, r.change]), [['1.23.0', 5], ['1.22.0', 50], ['1.21.0', 10]], 'a new version counts from 0');
  assert.equal(second.change, 65); assert.equal(second.perDay, 65); assert.equal(second.hours, 24);
  assert.equal(report(releases({ '1.22.0': 60 }), first.run, t0 + 2 * DAY).perDay, 10, 'two days: the change per day');
  assert.equal(report(releases({ '1.22.0': 60 }), first.run, t0 + 3600000).perDay, undefined, 'an hour says nothing about a day');
  assert.deepEqual(report([{ tag_name: 'v1.0.0', assets: [{ name: 'active.txt', download_count: 'x' }] }, null], undefined, t0).rows, [], 'odd data is skipped');

  // 7. Unique copies: installed.txt per version, the total over all releases, the new copies since the last run.
  const both = (list) => list.map(([v, active, installed]) => ({ tag_name: `v${v}`, assets: [{ name: 'x.tgz', download_count: 999 }, { name: 'active.txt', download_count: active },
    ...(installed === undefined ? [] : [{ name: 'installed.txt', download_count: installed }])] }));
  // The cache of an older version of this script has only `{ at, counts }`: no error, the unique change is unknown.
  const old = { at: t0, counts: { '1.22.0': 40, '1.21.0': 100 } };
  const fromOld = report(both([['1.23.0', 30, 12], ['1.22.0', 90, undefined]]), old, t0 + DAY);
  assert.deepEqual(fromOld.unique.rows.map((r) => [r.version, r.count, r.change]), [['1.23.0', 12, undefined]], 'only releases with installed.txt');
  assert.equal(fromOld.unique.total, 12); assert.equal(fromOld.unique.change, undefined, 'an old cache has no installed counts');
  assert.equal(fromOld.change, 30 + 50, 'the daily part still reads the old cache');
  assert.deepEqual(fromOld.run, { at: t0 + DAY, counts: { '1.23.0': 30, '1.22.0': 90 }, installed: { '1.23.0': 12 } }, 'the new cache keeps both');
  const firstUnique = report(both([['1.23.0', 30, 12]]), undefined, t0);
  assert.equal(firstUnique.unique.total, 12); assert.equal(firstUnique.unique.change, undefined, 'first run: no change yet');
  const later = report(both([['1.24.0', 20, 7], ['1.23.0', 50, 15], ['1.22.0', 90, undefined]]), fromOld.run, t0 + 3 * DAY);
  assert.deepEqual(later.unique.rows.map((r) => [r.version, r.count, r.change]), [['1.24.0', 7, 7], ['1.23.0', 15, 3]], 'a new version counts from 0');
  assert.equal(later.unique.total, 22, 'unique copies: the sum over all releases'); assert.equal(later.unique.change, 10, 'new copies since the last run');
  assert.equal(later.total, 160, 'the daily total is separate');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('active count checks passed');
