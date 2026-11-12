// Project memory for a new user (owner, 2026-11-12): the first start of Composer Plus in a dsh home switches the memory
// on (Assistant keeps its notes there) and saves that choice; a user who had Composer Plus before keeps the setting; a
// user who switches it off later keeps it off.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, installMemory } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memdefault-'));
try {
  const routes = new Map();
  const ctx = { on: () => {}, effect: () => {}, get: () => undefined, logger: { warn: () => {} }, connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionQuery: { observeSession: async () => ({ events: [] }) } };
  const call = async (body) => (await routes.get(MEMORY_PATH).fetch(new Request(`http://h${MEMORY_PATH}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }))).json();
  const saved = (home) => readFile(join(home, 'storages/dsh-composer-plus/memory.json'), 'utf8').then((t) => JSON.parse(t), () => undefined);

  // 1. A new user: on, and saved.
  const fresh = join(root, 'fresh');
  const m1 = installMemory(ctx, fresh, undefined, { firstStart: true }); await m1.ready;
  assert.equal((await call()).on, true, 'a new user starts with the memory on');
  assert.deepEqual(await saved(fresh), { on: true });
  // 2. The user switches it off: the next start keeps it off (it is no first start any more).
  await call({ on: false });
  const m2 = installMemory(ctx, fresh, undefined, { firstStart: false }); await m2.ready;
  assert.equal((await call()).on, false, 'off stays off');
  // 3. A user who had Composer Plus before (no memory.json: off) keeps it off; the owner's on stays on.
  const old = join(root, 'old'); await mkdir(join(old, 'storages/dsh-composer-plus'), { recursive: true });
  const m3 = installMemory(ctx, old, undefined, { firstStart: false }); await m3.ready;
  assert.equal((await call()).on, false, 'an old user keeps the old default');
  assert.equal(await saved(old), undefined, 'nothing written for an old user');
  const owner = join(root, 'owner'); await mkdir(join(owner, 'storages/dsh-composer-plus'), { recursive: true });
  await writeFile(join(owner, 'storages/dsh-composer-plus/memory.json'), JSON.stringify({ on: true }));
  const m4 = installMemory(ctx, owner, undefined, { firstStart: false }); await m4.ready;
  assert.equal((await call()).on, true, 'the owner keeps on');
  // 4. apply() decides "first start" from the storage folder: the check is the folder, before any feature writes it.
  const src = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const at = src.indexOf('const firstStart = !existsSync(join(home, \'storages\', \'dsh-composer-plus\'));');
  assert.ok(at > 0 && at < src.indexOf('installRollback(ctx, home'), 'the first-start check runs before the features install');
  console.log('memory default checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
