// No test may use the user's real dsh home. dsh exports DSH_HOME=~/.dsh to its shells, and a test that called apply()
// without its own DSH_HOME changed the real memory setting. `npm test` gives the whole run an empty DSH_HOME and HOME
// (scripts/test.mjs), and apply() stops a script in test/ that gets the real ~/.dsh (refuseRealHome).
import assert from 'node:assert/strict';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseRealHome } from '../index.js';

const real = join(userInfo().homedir, '.dsh');
const self = fileURLToPath(import.meta.url);
// 1. A script in test/ cannot use the real home or a folder in it.
for (const home of [real, `${real}/`, join(real, 'storages'), join(real, '..', '.dsh')]) {
  assert.throws(() => refuseRealHome(home, self), /must not use the real dsh home/, home);
}
assert.throws(() => refuseRealHome(real), /must not use the real dsh home/, 'the default main script is this test');
// 2. Other folders pass: a temporary home, and a name that only starts like the real one.
refuseRealHome(join(tmpdir(), 'cp-home'), self);
refuseRealHome(`${real}-copy`, self);
// 3. dsh itself keeps the real home: its main script is not in test/ (or is not a file on disk, in app.asar).
for (const main of [join(resolve(self, '..', '..'), 'index.js'), '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/main.js']) {
  refuseRealHome(real, main);
}
// 4. `npm test` runs every test with an empty home: never the user's dsh home or home folder.
if (process.env.npm_lifecycle_event === 'test:all') {
  assert.ok(process.env.DSH_HOME?.startsWith(tmpdir()) && process.env.HOME?.startsWith(tmpdir()), `npm test runs in a temporary DSH_HOME and HOME (DSH_HOME=${process.env.DSH_HOME})`);
}
console.log('real home checks passed');
