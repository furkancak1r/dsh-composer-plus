// `npm test`: runs `npm run test:all` with a new, empty DSH_HOME and HOME, so that no test can read or change the user's
// dsh home, ~/Assistant or ~/Desktop/dsh-backups. dsh exports DSH_HOME=~/.dsh to its shells: a test that did not set its
// own DSH_HOME changed the real memory setting. git keeps the global config of the real HOME: CI writes the commit name
// there, and no test changes it. The folder is removed at the end.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cp-npm-test-'));
const gitConfig = process.env.GIT_CONFIG_GLOBAL ?? join(homedir(), '.gitconfig');
const env = { ...process.env, DSH_HOME: join(root, 'dsh'), HOME: join(root, 'home'), ...(existsSync(gitConfig) ? { GIT_CONFIG_GLOBAL: gitConfig } : {}) };
mkdirSync(env.HOME);
let run;
try { run = spawnSync('npm', ['run', 'test:all'], { stdio: 'inherit', env }); } finally { rmSync(root, { recursive: true, force: true }); }
if (run.error) console.error(run.error);
process.exit(run.status ?? 1);
