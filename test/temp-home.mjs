// Import this first in a test that calls the Host's apply() and needs no files of its own: DSH_HOME becomes a new, empty
// folder (removed at exit), so the test also runs alone in a dsh shell, where DSH_HOME is the user's real ~/.dsh.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cp-test-home-'));
process.env.DSH_HOME = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
