// Allow for this chat: a grant ends after the time set in Settings (default 1 hour); the Host answers only grants that
// still run, keeps the old answer shape for the phone gateway and older clients, and refuses an unknown time.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, grantsStore, GRANTS_PATH, GRANT_TTLS, GRANT_TTL_DEFAULT } from '../index.js';

const root = mkdtempSync(join(tmpdir(), 'cp-grant-ttl-'));
const MIN = 60e3;
try {
  assert.equal(GRANT_TTL_DEFAULT, 60 * MIN, 'default: 1 hour');
  assert.deepEqual(GRANT_TTLS, [15 * MIN, 60 * MIN, 240 * MIN, 480 * MIN, null]);

  // Store with a fake clock.
  let t = 1_000_000_000_000;
  const file = join(root, 'store', 'chat-grants.json');
  const g = grantsStore(file, () => t);
  assert.deepEqual(await g.read(), { ttlMs: GRANT_TTL_DEFAULT, grants: {} }, 'no file: default time, no grants');
  await g.grant('s1', 'mcp__db__execute_sql_prod');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'owner-only');
  t += 59 * MIN;
  assert.deepEqual(g.names(await g.read()), { s1: ['mcp__db__execute_sql_prod'] }, 'still allowed at 59 min');
  assert.deepEqual(g.detail(await g.read()), { ttlMs: 60 * MIN, grants: { s1: { mcp__db__execute_sql_prod: MIN } } }, 'one minute left');
  t += 2 * MIN;
  assert.deepEqual(g.names(await g.read()), {}, 'ended at 61 min: the agent asks again');
  await g.grant('s2', 'x'); // a write drops the ended grant from the file
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).grants), ['s2']);

  // A shorter time also ends older grants at once; a longer one gives them time again (time counts from the grant).
  t += 20 * MIN;
  assert.ok(g.names(await g.read()).s2, '20 min old, 1 h limit');
  await g.setTtl(15 * MIN);
  assert.deepEqual(g.names(await g.read()), {}, '15 min limit: the 20 min old grant ends');
  await g.setTtl(null);
  await g.grant('s3', 'y');
  t += 1000 * 24 * 60 * MIN;
  assert.deepEqual(g.detail(await g.read()), { ttlMs: null, grants: { s3: { y: null } } }, 'until revoked: never ends');
  await g.revoke('s3');
  assert.deepEqual(g.names(await g.read()), {});

  // Writes run in order; parallel grants all stay.
  await g.setTtl(GRANT_TTL_DEFAULT);
  await Promise.all([g.grant('p', 'a'), g.grant('p', 'b'), g.revoke('q'), g.grant('q', 'c'), g.setTtl(4 * 60 * MIN)]);
  assert.deepEqual(await g.read(), { ttlMs: 4 * 60 * MIN, grants: { p: { a: t, b: t }, q: { c: t } } });

  // A broken file or an unknown time reads as the default; a chat id like "__proto__" stays plain data.
  writeFileSync(file, '{broken');
  assert.deepEqual(await g.read(), { ttlMs: GRANT_TTL_DEFAULT, grants: {} });
  writeFileSync(file, JSON.stringify({ ttlMs: 123, grants: { s: { a: t, b: 'x' }, n: null } }));
  assert.deepEqual(g.detail(await g.read()), { ttlMs: GRANT_TTL_DEFAULT, grants: { s: { a: GRANT_TTL_DEFAULT } } });
  await g.grant('__proto__', 'z');
  assert.deepEqual(g.names(await g.read())['__proto__'], ['z']);
  assert.equal({}.z, undefined, 'no prototype change');

  // Route: the old shape for GET (gateway, older clients); ?detail=1 with the time left; {ttlMs} only with listed values.
  const home = join(root, 'home');
  process.env.DSH_HOME = home;
  // The old grants.json (1.12 and earlier) is not read: those grants ask once again. The file stays.
  const old = join(home, 'storages', 'dsh-composer-plus', 'grants.json');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(home, 'storages', 'dsh-composer-plus'), { recursive: true });
  writeFileSync(old, JSON.stringify({ sOld: ['tool'] }));
  const routes = new Map();
  apply({ on() {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } }, subprocess: {}, sessionQuery: {}, sessionController: {} });
  const call = async (query = '', body) => {
    const response = await routes.get(GRANTS_PATH).fetch(new Request(`http://h${GRANTS_PATH}${query}`, body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: response.status, json: await response.json() };
  };
  assert.deepEqual((await call()).json, {}, 'old grants are not used');
  assert.deepEqual(JSON.parse(readFileSync(old, 'utf8')), { sOld: ['tool'] }, 'old file kept');
  assert.deepEqual((await call('', { action: 'grant', sessionId: 'S', tool: 't' })).json, { S: ['t'] });
  const detail = (await call('?detail=1')).json;
  assert.equal(detail.ttlMs, GRANT_TTL_DEFAULT);
  assert.ok(detail.grants.S.t > GRANT_TTL_DEFAULT - 5000 && detail.grants.S.t <= GRANT_TTL_DEFAULT, 'about one hour left');
  assert.equal((await call('?detail=1', { ttlMs: 15 * MIN })).json.ttlMs, 15 * MIN);
  for (const bad of [{ ttlMs: 1 }, { ttlMs: '900000' }, { ttlMs: -1 }, { action: 'nuke' }, '{bad', { action: 'grant', sessionId: '', tool: 't' }]) {
    assert.equal((await call('', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('?detail=1')).json.ttlMs, 15 * MIN, 'refused bodies change nothing');
  assert.deepEqual((await call('?detail=1', { ttlMs: null })).json.grants.S, { t: null }, 'until revoked');
  assert.deepEqual((await call('', { action: 'revoke', sessionId: 'S' })).json, {});
  assert.equal(statSync(join(home, 'storages', 'dsh-composer-plus', 'chat-grants.json')).mode & 0o777, 0o600);
  console.log('grant time limit checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
