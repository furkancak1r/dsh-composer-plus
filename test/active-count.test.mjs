// Anonymous daily active count: one request per UTC day for this version's release file, with no data; no request from a
// renamed copy, a pre-release, a git checkout or the second call of a day. The owner's report counts the change per version.
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
  // 1. No request from a renamed copy, a pre-release or a git checkout.
  for (const [opts, why] of [[{ pkg: { name: '@local/dsh-composer-history', version: '1.2.3' } }, 'renamed live copy'],
    [{ pkg: { name: 'dsh-composer-plus', version: '1.2.3-trust.4' } }, 'pre-release'], [{ dev: true }, 'git checkout']]) {
    const f = fake();
    assert.equal(await activeCounter({ file: join(root, 'skip.json'), pkg, fetchImpl: f.fetchImpl, ...opts })(), 'skip', why);
    assert.equal(f.calls.length, 0, `${why}: no request`);
  }

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
    for (const off of effects) off?.();
    globalThis.fetch = realFetch; delete process.env.DSH_HOME;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // 6. The owner's report: counts per version, the change since the last run, active copies per day.
  const releases = (counts) => Object.entries(counts).map(([v, n]) => ({ tag_name: `v${v}`, assets: n === undefined ? [] : [{ name: 'x.tgz', download_count: 999 }, { name: 'active.txt', download_count: n }] }));
  const first = report(releases({ '1.22.0': 40, '1.21.0': 100, '1.20.0': undefined }), undefined, t0);
  assert.deepEqual(first.run, { at: t0, counts: { '1.22.0': 40, '1.21.0': 100 } }, 'only releases with active.txt');
  assert.equal(first.total, 140); assert.equal(first.change, undefined); assert.equal(first.perDay, undefined, 'first run: no change yet');
  const second = report(releases({ '1.23.0': 5, '1.22.0': 90, '1.21.0': 110 }), first.run, t0 + DAY);
  assert.deepEqual(second.rows.map((r) => [r.version, r.change]), [['1.23.0', 5], ['1.22.0', 50], ['1.21.0', 10]], 'a new version counts from 0');
  assert.equal(second.change, 65); assert.equal(second.perDay, 65); assert.equal(second.hours, 24);
  assert.equal(report(releases({ '1.22.0': 60 }), first.run, t0 + 2 * DAY).perDay, 10, 'two days: the change per day');
  assert.equal(report(releases({ '1.22.0': 60 }), first.run, t0 + 3600000).perDay, undefined, 'an hour says nothing about a day');
  assert.deepEqual(report([{ tag_name: 'v1.0.0', assets: [{ name: 'active.txt', download_count: 'x' }] }, null], undefined, t0).rows, [], 'odd data is skipped');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('active count checks passed');
