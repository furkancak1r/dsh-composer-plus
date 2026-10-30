// Goal check (Host half). When the model calls update_goal with action complete in an automatic goal round, the call waits
// for the project's test (detected; the agent's own passing run is used when nothing changed after it) and one verifier
// model call with no tools. A failure denies the call with the reason. A human turn, other tools and other actions pass.
// Project files are read only as regular files inside the folder (no symlink out, no FIFO wait); the test runs under the
// chat's sandbox mode; rolled-back steps are left out; a fork keeps its parent's goal; the budget blocks a goal once.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, open as openFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GOAL_CHECK_PATH, installGoalCheck, detectTestCommand, passingTestRun, goalTranscript, parseVerdict, goalOf, humanTurn, denyReason,
  runGoalTest, checkGoal, parseGoalCheck, goalUsage, GOAL_CHECK_MAX, subagentIds, subagentUsage,
} from '../index.js';

const spawned = [];
const subprocess = {
  resolveExecutable: async (name) => execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(),
  spawn({ argv, cwd, env, signal }) {
    spawned.push({ argv, cwd });
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
    signal?.addEventListener('abort', () => child.kill());
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    return {
      done: new Promise((resolve) => child.on('close', (code) => resolve({ exitCode: code, signal: null }))),
      collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err }) } },
    };
  },
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

// Event builders, in dsh's log shapes (checked against a real 0.2.1-rc.2 log).
let seq = 0;
const ev = (type, data, extra = {}) => ({ seq: ++seq, time: 1000 + seq, type, data, ...extra });
const user = (text, kind = 'user', more = {}) => ev('user/message', { source: { kind, ...more }, content: [{ type: 'text', text }] });
const reply = (text, usage) => ev('assistant/message', { message: { content: [{ type: 'text', text }] }, ...(usage ? { usage } : {}) });
const call = (name, args, id = `c${seq + 1}`) => ev('tool/call', { callId: id, name, arguments: JSON.stringify(args) });
const result = (id, text, isError = false) => ev('tool/result', { message: { source: { kind: 'tool', callId: id }, content: [{ type: 'text', text }], isError } });
const tool = (name, args, text, isError) => { const c = call(name, args); return [c, result(c.data.callId, text, isError)]; };
const goalChange = (operation, goal, extra = {}) => ev('goal/change', { kind: 'goal/change', version: 1, operation, goal, roundsStarted: 0, createdAt: 1, updatedAt: 1, ...extra });
const turnStart = () => ev('turn/start', { turn: seq });

const root = await mkdtemp(join(tmpdir(), 'cp-goal-check-'));
try {
  // detectTestCommand: each manifest, npm's placeholder, the lock file picks the runner.
  const dir = async (name, files) => { const d = join(root, name); await mkdir(d, { recursive: true }); for (const [f, t] of Object.entries(files)) await writeFile(join(d, f), t); return d; };
  assert.equal(await detectTestCommand(await dir('npm', { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })), 'npm test');
  assert.equal(await detectTestCommand(await dir('pnpm', { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'pnpm-lock.yaml': '' })), 'pnpm test');
  assert.equal(await detectTestCommand(await dir('yarn', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'yarn.lock': '' })), 'yarn test');
  assert.equal(await detectTestCommand(await dir('bun', { 'package.json': JSON.stringify({ scripts: { test: 'bun test' } }), 'bun.lockb': '' })), 'bun run test');
  assert.equal(await detectTestCommand(await dir('placeholder', { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), undefined, 'npm init placeholder');
  assert.equal(await detectTestCommand(await dir('make', { Makefile: 'build:\n\tcc x.c\ntest: build\n\t./t\n' })), 'make test');
  assert.equal(await detectTestCommand(await dir('make-no-test', { Makefile: 'build:\n\tcc x.c\n' })), undefined);
  assert.equal(await detectTestCommand(await dir('cargo', { 'Cargo.toml': '[package]\nname="x"\n' })), 'cargo test');
  assert.equal(await detectTestCommand(await dir('go', { 'go.mod': 'module x\n' })), 'go test ./...');
  assert.equal(await detectTestCommand(await dir('py', { 'pyproject.toml': '[tool.pytest.ini_options]\n' })), 'python3 -m pytest -q');
  assert.equal(await detectTestCommand(await dir('py2', { 'pytest.ini': '[pytest]\n' })), 'python3 -m pytest -q');
  assert.equal(await detectTestCommand(await dir('none', { 'README.md': 'x' })), undefined);
  assert.equal(await detectTestCommand(join(root, 'missing')), undefined);
  // Rule 6: a package.json symlink out of the folder is not read; a FIFO does not block.
  const outsidePkg = join(root, 'outside-package.json'); await writeFile(outsidePkg, JSON.stringify({ scripts: { test: 'rm -rf /' } }));
  const linked = await dir('linked', {}); await symlink(outsidePkg, join(linked, 'package.json'));
  assert.equal(await detectTestCommand(linked), undefined, 'no symlink out of the folder');
  const inner = await dir('inner-link', { 'real.json': JSON.stringify({ scripts: { test: 'node t.js' } }) }); await symlink(join(inner, 'real.json'), join(inner, 'package.json'));
  assert.equal(await detectTestCommand(inner), 'npm test', 'a symlink that stays inside counts');
  if (process.platform !== 'win32') {
    const fifo = await dir('fifo', {}); execFileSync('mkfifo', [join(fifo, 'package.json')]);
    const pending = detectTestCommand(fifo);
    // A red run must end: after 2 s open the FIFO for writing, so a blocked read returns.
    const unblock = setTimeout(() => { openFile(join(fifo, 'package.json'), constants.O_WRONLY | constants.O_NONBLOCK).then((f) => f.close(), () => {}); }, 2000);
    const done = await Promise.race([pending.then(() => 'done'), new Promise((r) => setTimeout(() => r('blocked'), 1500))]);
    clearTimeout(unblock);
    assert.equal(done, 'done', 'a FIFO does not block the detection');
    await pending;
  }

  // passingTestRun: the agent's newest change-capable step must be its own passing run of the same test in the same folder.
  const cwd = '/work/acme';
  const G = { id: 'goal-1', revision: 1, objective: 'Add a logout button and keep the tests green', phase: 'active', maxGoalRounds: 10 };
  seq = 0;
  const base = [goalChange('create', G), user('round', 'goal', { goalId: 'goal-1', revision: 1, round: 1 })];
  const pass = 'ok 1\n# pass 1';
  const run = (command, text = pass, extra = {}) => tool('bash', { command, ...extra }, text);
  assert.equal(passingTestRun([...base, ...run('npm test')], cwd, 'npm test'), pass, 'the newest step is a passing run');
  assert.equal(passingTestRun([...base, ...run('npm run test  2>&1')], cwd, 'npm test'), pass, 'npm run test 2>&1 is the same command');
  assert.equal(passingTestRun([...base, ...run('npm test'), ...tool('read', { file_path: 'a.js' }, 'x'), ...tool('update_goal', { action: 'complete' }, 'x')], cwd, 'npm test'), pass, 'a read after it changes nothing');
  assert.equal(passingTestRun([...base, ...run('npm test'), ...tool('edit', { file_path: 'a.js' }, 'ok')], cwd, 'npm test'), undefined, 'an edit after the run');
  assert.equal(passingTestRun([...base, ...run('npm test'), ...tool('bash', { command: 'echo hi > a.js' }, '')], cwd, 'npm test'), undefined, 'another shell step after the run');
  assert.equal(passingTestRun([...base, ...run('npm test'), ...tool('edit', { file_path: 'a.js' }, 'no match', true)], cwd, 'npm test'), undefined, 'a failed edit can still change files: unknown counts as a change');
  assert.equal(passingTestRun([...base, ...run('npm test', 'not ok 1\n[exit code: 1]')], cwd, 'npm test'), undefined, 'a failed run');
  assert.equal(passingTestRun([...base, ...run('npm test', 'x\n[timed out after 120000ms]')], cwd, 'npm test'), undefined, 'a timed-out run');
  assert.equal(passingTestRun([...base, ...run('npm test', 'x\n[still running after 600000ms; moved to background job j1]\nThe command keeps running')], cwd, 'npm test'), undefined, 'a backgrounded run');
  assert.equal(passingTestRun([...base, ...run('npm test | tail -5')], cwd, 'npm test'), undefined, 'a pipe hides the exit code');
  assert.equal(passingTestRun([...base, ...run('npm test && echo ok')], cwd, 'npm test'), undefined);
  assert.equal(passingTestRun([...base, ...run('npm test', pass, { run_in_background: true })], cwd, 'npm test'), undefined, 'a background run');
  assert.equal(passingTestRun([...base, ...run('npm test', pass, { workdir: 'packages/web' })], cwd, 'npm test'), undefined, 'another folder');
  assert.equal(passingTestRun([...base, ...run('npm test', pass, { workdir: '/work/acme' })], cwd, 'npm test'), pass, 'the same folder by an absolute workdir');
  assert.equal(passingTestRun([...base, ...run('pnpm test')], cwd, 'npm test'), undefined, 'another command');
  { const [c, r] = run('npm test'); assert.equal(passingTestRun([...base, c, { ...r, data: { ...r.data, message: { ...r.data.message, isError: true } } }], cwd, 'npm test'), undefined, 'an error result'); }
  // A run before the goal started does not count.
  { seq = 100; const early = run('npm test'); const evs = [...early, goalChange('create', G)]; assert.equal(passingTestRun(evs, cwd, 'npm test', 2), undefined); }
  // A withdrawn edit (Turn rollback or dsh-rewind) is out; a withdrawn run is out too.
  for (const kind of ['composer-plus-rollback', 'dsh-rewind']) {
    seq = 200;
    const r1 = run('npm test'); const e1 = tool('edit', { file_path: 'a.js' }, 'ok');
    const marker = ev('user/message', { source: { kind }, content: [{ type: 'text', text: '(empty message)' }] }, { sourceEventSeqs: [e1[0].seq, e1[1].seq] });
    assert.equal(passingTestRun([...base, ...r1, ...e1, marker], cwd, 'npm test'), pass, `${kind}: a withdrawn edit does not count`);
    const r2 = run('npm test');
    const m2 = ev('user/message', { source: { kind }, content: [{ type: 'text', text: '(empty message)' }] }, { sourceEventSeqs: [r2[0].seq, r2[1].seq] });
    assert.equal(passingTestRun([...base, ...r2, m2], cwd, 'npm test'), undefined, `${kind}: a withdrawn run does not count`);
  }
  // dsh's /compact marker is not a withdraw: the edit it covers still counts.
  { seq = 300; const r1 = run('npm test'); const e1 = tool('edit', { file_path: 'a.js' }, 'ok');
    const compact = ev('user/message', { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }] }, { sourceEventSeqs: [e1[0].seq, e1[1].seq] });
    assert.equal(passingTestRun([...base, ...r1, ...e1, compact], cwd, 'npm test'), undefined, '/compact keeps the edit'); }
  // The chat moved to another folder after the run.
  { seq = 400; const evs = [...base, ...run('npm test'), ev('working-directory/change', { cwd: '/work/other' })]; assert.equal(passingTestRun(evs, cwd, 'npm test'), undefined); }

  // goalOf and a fork (rule 10): a fork inherits its parent's events, its goal included.
  seq = 0;
  const parent = [user('Build it'), goalChange('create', G), user('r1', 'goal', { round: 1 }), reply('Working')];
  const fork = [...parent, goalChange('resume', { ...G, revision: 2 }), user('r2', 'goal', { round: 2 })];
  assert.equal(goalOf(fork).goal.id, 'goal-1'); assert.equal(goalOf(fork).from, 1, 'from the inherited create');
  assert.equal(goalOf(fork).since.seq, fork[4].seq, 'the budget starts at the resume');
  assert.equal(goalOf([...fork, goalChange('clear', undefined, { cleared: { id: 'goal-1', revision: 3 } })]), undefined, 'cleared');
  assert.equal(goalOf([user('x')]), undefined);
  assert.match(goalTranscript(fork, goalOf(fork).from), /^\[automatic goal round 1\]\n\nAgent: Working\n\n\[automatic goal round 2\]$/, 'the transcript starts at the goal, also in a fork');

  // humanTurn: the user's own message in the open turn.
  seq = 0;
  assert.equal(humanTurn([turnStart(), user('round', 'goal')]), false);
  assert.equal(humanTurn([turnStart(), user('Mark it done')]), true);
  assert.equal(humanTurn([user('earlier'), turnStart(), user('round', 'goal')]), false, 'an earlier turn does not count');

  // goalTranscript: messages, replies, tool calls and results; withdrawn steps out, /compact kept; the newest kept.
  seq = 0;
  const tr = [goalChange('create', G), user('round', 'goal', { round: 1 }), reply('I will add it.'), ...tool('edit', { file_path: 'src/Header.tsx' }, 'edited'),
    user('withdrawn ask'), reply('withdrawn reply'), ev('user/message', { source: { kind: 'composer-plus-rollback' }, content: [] }, { sourceEventSeqs: [seq - 1, seq] }),
    user('rewound ask'), ev('user/message', { source: { kind: 'dsh-rewind' }, content: [] }, { sourceEventSeqs: [seq] }),
    ev('user/message', { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }] }, { sourceEventSeqs: [3, 4] }),
    ...tool('bash', { command: 'npm test' }, 'not ok\n[exit code: 1]')];
  const text = goalTranscript(tr, 0);
  assert.match(text, /Agent: I will add it\.\n\nTool call edit: \{"file_path":"src\/Header\.tsx"\}\n\nTool result: edited/);
  assert.match(text, /Tool result: not ok\n\[exit code: 1\]$/);
  for (const gone of ['withdrawn', 'rewound']) assert.ok(!text.includes(gone), `no ${gone}`);
  assert.ok(text.includes('Tool result: edited'), '/compact keeps its steps');
  const long = goalTranscript([reply('OLDEST'), ...Array.from({ length: 50 }, (_, i) => reply(`${i} ${'x'.repeat(2000)}`)), reply('NEWEST')], 0, 10000);
  assert.ok(long.length <= 10100 && long.endsWith('Agent: NEWEST') && !long.includes('OLDEST') && long.startsWith('[the earlier part'));

  // parseVerdict.
  assert.deepEqual(parseVerdict('<think>hmm {"pass":true}</think>```json\n{"pass": false, "missing": ["no logout test", "", 3], "reason": "Half done"}\n```'), { pass: false, missing: ['no logout test'], reason: 'Half done' });
  assert.deepEqual(parseVerdict('{"pass": true, "missing": ["x"]}'), { pass: true, missing: [], reason: '' });
  for (const bad of ['', 'yes', '{"pass":"yes"}', '{broken', '[1]', '{"items": []}', '{"items": ["x"]}']) assert.equal(parseVerdict(bad), undefined, bad);
  // The evidence table decides, not its "pass": every part verified → pass; an unknown verdict is unresolved; empty or
  // nameless rows go; the open parts become `missing` (with their fix).
  {
    const table = (items, extra = {}) => JSON.stringify({ items, reason: 'Checked', ...extra });
    const done = parseVerdict(table([{ item: 'logout.js exists', verdict: 'verified', evidence: 'write logout.js', fix: '' }, { item: 'tests pass', verdict: 'verified', evidence: 'npm test exit 0' }], { pass: false }));
    assert.equal(done.pass, true, 'all verified'); assert.deepEqual(done.missing, []); assert.equal(done.items.length, 2); assert.equal(done.items[1].fix, '');
    const open = parseVerdict(`<think>x</think>${table([{ item: 'README updated', verdict: 'incorrect', evidence: 'README.md has no Logout section', fix: 'add the section' },
      { item: 'tests pass', verdict: 'maybe', evidence: '' }, { item: 'docs', verdict: 'unresolved', evidence: 'no docs/ folder' }, { item: '', verdict: 'verified' }, 'x', { verdict: 'verified' }], { pass: true })}`);
    assert.equal(open.pass, false, 'a table with an open part never passes');
    assert.deepEqual(open.items.map((i) => i.verdict), ['incorrect', 'unresolved', 'unresolved', 'verified', 'verified'], 'unknown verdict → unresolved; nameless rows count; a non-object row goes');
    assert.equal(open.items[3].item, '(unnamed part)');
    assert.deepEqual(open.missing, ['README updated: add the section', 'tests pass', 'docs']);
    // Review finding P2-2: a nameless open row or an open row after the 20th never lets the goal pass.
    assert.equal(parseVerdict(table([{ item: 'A', verdict: 'verified' }, { item: '', verdict: 'incorrect' }])).pass, false);
    { const many = parseVerdict(table([...Array.from({ length: 20 }, (_, i) => ({ item: `p${i}`, verdict: 'verified' })), { item: 'p20', verdict: 'incorrect', fix: 'fix it' }]));
      assert.equal(many.pass, false); assert.deepEqual(many.missing, ['p20: fix it']); assert.equal(many.items[0].item, 'p20', 'open parts are shown first'); assert.equal(many.items.length, 20); }
    { const opens = parseVerdict(table(Array.from({ length: 25 }, (_, i) => ({ item: `o${i}`, verdict: 'unresolved' }))));
      assert.equal(opens.missing.length, 21); assert.equal(opens.missing.at(-1), '5 more open part(s)');
      // Review finding F-02 (2026-10-30): the counts are of the whole table, and the deny text names the parts it leaves out.
      assert.deepEqual([opens.verified, opens.total], [0, 25]);
      assert.match(denyReason({ stage: 'verifier', ...opens }), /\(0 of 25 verified\)[\s\S]*\n- 5 more open part\(s\), not listed here\n/); }
    { const late = parseVerdict(table([...Array.from({ length: 24 }, (_, i) => ({ item: `p${i}`, verdict: 'verified' })), { item: 'p24', verdict: 'incorrect' }]));
      assert.deepEqual([late.pass, late.items.length, late.verified, late.total], [false, 20, 24, 25]);
      const text = denyReason({ stage: 'verifier', ...late });
      assert.match(text, /\(24 of 25 verified\)/); assert.ok(!text.includes('more open part'), 'every open part is listed'); }
    assert.equal(parseVerdict(table(Array.from({ length: 30 }, (_, i) => ({ item: `p${i}`, verdict: 'verified' })))).items.length, 20, 'at most 20 rows shown');
    assert.equal(parseVerdict(table([{ item: 'x'.repeat(400), verdict: 'verified', evidence: 'e'.repeat(900) }])).items[0].evidence.length, 501);
  }

  // subagentIds: any depth, only subagent origins; subagentUsage: since a time, a fork's inherited calls not counted again,
  // an unreadable chat counts 0.
  {
    const headers = [{ id: 's1' }, { id: 'k1', origin: 'subagent', parentSession: 's1' }, { id: 'k2', origin: 'subagent', parentSession: 'k1' },
      { id: 'f1', origin: 'user', parentSession: 's1' }, { id: 'o1', origin: 'subagent', parentSession: 'other' }, { id: 'k3', origin: 'subagent', parentSession: 'k2' }, null];
    assert.deepEqual(subagentIds(headers, 's1'), ['k1', 'k2', 'k3']);
    assert.deepEqual(subagentIds(headers, 'none'), []);
    const logs = {
      k1: { events: [{ seq: 1, time: 100, type: 'assistant/message', data: { usage: { inputTokens: 1000 } } }, { seq: 2, time: 500, type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5 } } }] },
      k2: { inheritedEventCount: 1, events: [{ seq: 1, time: 600, type: 'assistant/message', data: { usage: { inputTokens: 7777 } } }, { seq: 2, time: 700, type: 'assistant/attempt', data: { usage: { outputTokens: 3 } } }] },
    };
    const deps = { persistence: { list: async () => headers.filter(Boolean).map((header) => ({ header })) }, sessionQuery: { observeSession: async (id) => { if (logs[id] === undefined) throw new Error('gone'); return { ...logs[id], [Symbol.dispose]() {} }; } } };
    assert.equal(await subagentUsage(deps, 's1', 200), 18, 'since 200: 15 + 3, not the inherited call');
    assert.equal(await subagentUsage(deps, 's1', undefined), 1018);
    assert.equal(await subagentUsage({ ...deps, persistence: undefined }, 's1', 0), 0, 'no persistence service');
    assert.equal(await subagentUsage({ ...deps, persistence: { list: async () => { throw new Error('x'); } } }, 's1', 0), 0);
  }

  // goalUsage.
  seq = 0;
  assert.equal(goalUsage([reply('a', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, totalTokens: 999 }), reply('b', { inputTokens: 1, outputTokens: 1 })]), 117);
  { const [a, b] = [reply('a', { inputTokens: 10 }), reply('b', { inputTokens: 1 })]; assert.equal(goalUsage([a, b], 0, a.seq), 1, 'since a seq'); }

  // parseGoalCheck.
  assert.deepEqual(parseGoalCheck({ command: '  npm run test:unit ', minutes: 30, tokens: 500000 }), { command: 'npm run test:unit', minutes: 30, tokens: 500000 });
  assert.deepEqual(parseGoalCheck({ command: '' }), {}); assert.equal(parseGoalCheck(null), null);
  for (const bad of [{ command: 'a\0b' }, { command: 'x'.repeat(2001) }, { minutes: 0 }, { minutes: 1.5 }, { tokens: -1 }, { minutes: 10081 }, { other: 1 }, [], 'x']) assert.equal(parseGoalCheck(bad), undefined, JSON.stringify(bad));

  // denyReason.
  assert.match(denyReason({ stage: 'test', command: 'npm test', code: 1, tail: 'not ok 2' }), /^Goal check failed: the goal stays active[\s\S]*`npm test` exited with code 1\.\nOutput \(end\):\nnot ok 2\nFix the cause/);
  assert.match(denyReason({ stage: 'verifier', missing: ['README not updated'], reason: 'Docs missing' }), /gaps:\n- README not updated\nReason: Docs missing\nDo the missing work/);
  assert.match(denyReason({ stage: 'error', reason: 'the verifier could not answer (boom)' }), /^Goal check could not finish: the verifier could not answer \(boom\)/);
  {
    const items = [{ item: 'tests pass', verdict: 'verified', evidence: 'npm test exit 0', fix: '' }, { item: 'README updated', verdict: 'incorrect', evidence: 'no Logout section', fix: 'add it' }, { item: 'docs', verdict: 'unresolved', evidence: '', fix: '' }];
    const text = denyReason({ stage: 'verifier', items, missing: ['README updated: add it', 'docs'], reason: 'Half done' });
    assert.match(text, /\(1 of 3 verified\)/); assert.match(text, /- \[incorrect\] README updated\n  Evidence: no Logout section\n  Fix: add it\n- \[unresolved\] docs\nReason: Half done/);
    assert.ok(!text.includes('[verified]'), 'only the open parts'); assert.match(text, /mark a part that cannot be done as unresolved/);
  }

  // runGoalTest: real bash, the chat's sandbox mode, fail closed.
  const proj = await dir('proj', { 'package.json': JSON.stringify({ scripts: { test: 'node t.js' } }), 't.js': 'console.log("ok 1"); process.exit(Number(process.env.FAIL ?? 0))' });
  const ok = await runGoalTest({ subprocess }, undefined, proj, 'echo ok 1; echo warn >&2');
  assert.deepEqual(ok, { ok: true, code: 0, tail: 'ok 1\nwarn' });
  const bad = await runGoalTest({ subprocess }, undefined, proj, 'echo not ok; exit 3');
  assert.equal(bad.ok, false); assert.equal(bad.code, 3); assert.equal(bad.tail, 'not ok');
  assert.equal((await runGoalTest({ subprocess }, undefined, proj, 'yes | head -c 20000')).tail.length, 4001, 'the end of a long output');
  const confined = [];
  const sandbox = { confine: async (argv, policy) => { confined.push({ argv, policy }); return { argv: ['/usr/bin/env', ...argv] }; } };
  const session = { id: 's' };
  const policyOf = (mode) => ({ resolve: (req) => { assert.equal(req.session, session); return { mode, workspaceRoot: proj }; } });
  assert.equal((await runGoalTest({ subprocess, sandbox, sandboxPolicy: policyOf('workspace-write') }, session, proj, 'exit 0')).ok, true);
  assert.equal(confined.length, 1); assert.equal(confined[0].policy.mode, 'workspace-write'); assert.match(confined[0].argv[0], /bash$/); assert.deepEqual(confined[0].argv.slice(1), ['-c', 'exit 0']);
  assert.equal(spawned.at(-1).argv[0], '/usr/bin/env', 'the confined argv runs');
  assert.equal((await runGoalTest({ subprocess, sandbox, sandboxPolicy: policyOf('danger-full-access') }, session, proj, 'exit 0')).ok, true);
  assert.equal(confined.length, 1, 'full access is not wrapped');
  const unavailable = await runGoalTest({ subprocess, sandbox: { confine: async () => { throw new Error('SANDBOX_UNAVAILABLE: no runner'); } }, sandboxPolicy: policyOf('read-only') }, session, proj, 'exit 0');
  assert.equal(unavailable.ok, false); assert.match(unavailable.tail, /sandbox \(read-only\) could not start/);
  { const none = await runGoalTest({ subprocess, sandboxPolicy: policyOf('read-only') }, session, proj, 'exit 0');
    assert.equal(none.ok, false, 'a policy without a sandbox service: no run'); assert.match(none.tail, /sandbox \(read-only\) is not available/); }
  { const stop = new AbortController(); const p = runGoalTest({ subprocess }, undefined, proj, 'sleep 5'); setTimeout(() => stop.abort(), 100);
    await assert.rejects(runGoalTest({ subprocess }, undefined, proj, 'sleep 5', stop.signal)); await p.catch(() => {}); }

  // checkGoal: test first (no model call when it fails), the reuse, then the verifier.
  git(proj, 'init', '-q', '-b', 'main'); git(proj, 'add', '.'); git(proj, 'commit', '-q', '-m', 'init');
  await writeFile(join(proj, 'Header.tsx'), 'logout');
  const asked = [];
  let answer = '{"pass": true, "missing": [], "reason": "Done"}';
  const llm = {
    prepareCall: async (route, signal, configure) => ({
      config: { ...route, ...configure({}, { defaultMaxTokens: 8000 }) },
      async *stream(request) { asked.push(request); yield { type: 'text-delta', text: answer }; yield { type: 'finish', reason: { kind: 'stop' } }; },
    }),
  };
  const deps = { subprocess, llm, pickRoute: async (chat) => chat ?? { provider: 'p', model: 'm' }, now: () => 42 };
  seq = 0;
  const chatEvents = [ev('request/header', { header: { config: { provider: 'chat', model: 'big' } } }), goalChange('create', G), user('round', 'goal', { round: 1 }), reply('Added the button.')];
  process.env.FAIL = '1';
  let r = await checkGoal(deps, { events: chatEvents, cwd: proj }, undefined);
  assert.deepEqual({ ok: r.ok, stage: r.stage, command: r.command, code: r.code }, { ok: false, stage: 'test', command: 'npm test', code: 1 });
  assert.equal(asked.length, 0, 'a failing test: no model call');
  process.env.FAIL = '0';
  r = await checkGoal(deps, { events: chatEvents, cwd: proj }, undefined);
  assert.equal(r.ok, true); assert.equal(r.stage, 'verifier'); assert.equal(r.model, 'big', "the chat's own model"); assert.equal(r.at, 42);
  const req = asked.at(-1);
  assert.match(req.system, /independent verifier/); assert.match(req.system, /data/); assert.equal(req.maxTokens, 8000); assert.equal(req.tools, undefined, 'no tools');
  const input = req.messages[0].content[0].text;
  assert.match(input, /^Goal:\n"Add a logout button and keep the tests green"\n\nTest result:\n`npm test` passed \(exit code 0\)\. Output \(end\):\n[\s\S]*ok 1/);
  assert.match(input, /git status --short[^\n]*:\n\?\? Header\.tsx/);
  assert.match(input, /Chat log since the goal started[\s\S]*Agent: Added the button\./);
  // The agent's own passing run is used: no second run.
  const before = spawned.length;
  const reused = [...chatEvents, ...tool('bash', { command: 'npm test' }, 'ok 1 (agent run)')];
  r = await checkGoal(deps, { events: reused, cwd: proj }, undefined);
  assert.equal(r.reused, true); assert.equal(r.tail, 'ok 1 (agent run)');
  assert.ok(spawned.slice(before).every((s) => s.argv.some((a) => /git$/.test(a))), 'only git status ran, not the test');
  assert.match(asked.at(-1).messages[0].content[0].text, /The agent's own newest run of `npm test` passed/);
  // The saved command wins over the detected one; a project without a test still gets the verifier.
  r = await checkGoal(deps, { events: chatEvents, cwd: proj, command: 'exit 7' }, undefined);
  assert.equal(r.code, 7); assert.equal(r.command, 'exit 7');
  const noTest = await dir('no-test', { 'README.md': 'x' });
  r = await checkGoal(deps, { events: chatEvents, cwd: noTest }, undefined);
  assert.equal(r.ok, true); assert.equal(r.command, undefined); assert.match(asked.at(-1).messages[0].content[0].text, /No test command was found/);
  // The verifier says no; a broken answer; a model error.
  answer = '{"pass": false, "missing": ["No test for the logout button"], "reason": "Untested"}';
  r = await checkGoal(deps, { events: chatEvents, cwd: proj }, undefined);
  assert.deepEqual({ ok: r.ok, stage: r.stage, missing: r.missing }, { ok: false, stage: 'verifier', missing: ['No test for the logout button'] });
  // The evidence table: the system asks for it; an open part fails the check with its items kept for the row and the deny.
  assert.match(asked.at(-1).system, /"verdict": "verified" or "incorrect" or "unresolved"/); assert.match(asked.at(-1).system, /Name the evidence/);
  answer = JSON.stringify({ items: [{ item: 'Logout button', verdict: 'verified', evidence: 'Header.tsx in git status' }, { item: 'Tests green', verdict: 'unresolved', evidence: 'no test for logout', fix: 'add a test' }], reason: 'One part open' });
  r = await checkGoal(deps, { events: chatEvents, cwd: proj }, undefined);
  assert.equal(r.ok, false); assert.equal(r.stage, 'verifier'); assert.equal(r.items.length, 2); assert.deepEqual(r.missing, ['Tests green: add a test']);
  assert.deepEqual([r.verified, r.total], [1, 2], 'F-02: the counts go with the result (row and deny)');
  assert.match(denyReason(r), /\(1 of 2 verified\)[\s\S]*\[unresolved\] Tests green/);
  answer = 'Looks good to me!';
  r = await checkGoal(deps, { events: chatEvents, cwd: proj }, undefined);
  assert.equal(r.ok, false); assert.equal(r.stage, 'error'); assert.match(r.reason, /not the expected JSON/);
  r = await checkGoal({ ...deps, llm: { prepareCall: async () => { throw new Error('rate limited'); } } }, { events: chatEvents, cwd: proj }, undefined);
  assert.equal(r.ok, false); assert.match(r.reason, /rate limited/);
  r = await checkGoal({ ...deps, pickRoute: async () => undefined }, { events: chatEvents, cwd: proj }, undefined);
  assert.equal(r.ok, false); assert.match(r.reason, /no model/);
  await assert.rejects(checkGoal(deps, { events: [user('x')], cwd: proj }, undefined), /no goal/);
  answer = '{"pass": true, "missing": [], "reason": "Done"}';

  // The gate, the budget and the route, with fake dsh services.
  const home = join(root, 'home');
  const file = join(home, 'storages/dsh-composer-plus/goal-check.json');
  const listeners = {};
  const routes = new Map();
  let effectStop;
  let blocked = [];
  let goalView = { ...G, roundsStarted: 1, activation: 'armed' };
  const services = {
    llm, sandbox: undefined, sandboxPolicy: undefined, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    goals: { get: () => goalView, block: (agent, ref, reason) => { blocked.push({ ref, reason }); goalView = { ...goalView, phase: 'blocked' }; } },
  };
  services.llm.listProviders = () => [{ id: 'p', name: 'P' }, { id: 'chat', name: 'Chat' }];
  services.llm.listModels = async (id) => (id === 'p' ? [{ id: 'm', name: 'M' }] : [{ id: 'big', name: 'Big' }]);
  let agentEvents = [...chatEvents, turnStart(), user('round 2', 'goal', { round: 2 })];
  const agent = { id: 's1', status: 'running', session: { id: 's1', header: { cwd: proj }, snapshotEvents: () => agentEvents } };
  const subAgent = { id: 'sub', status: 'running', session: { id: 'sub', header: { cwd: proj, origin: 'subagent' }, snapshotEvents: () => agentEvents } };
  const installed = {
    on: (name, fn) => { listeners[name] = fn; }, effect: (fn) => { effectStop = fn(); }, get: (name) => services[name], logger: { warn() {} },
    connection: { fetch: { register: (route) => routes.set(route.path, route) } }, subprocess,
    sessionQuery: { observeSession: async (id) => ({ header: id === 'sub' ? { cwd: proj, origin: 'subagent' } : { cwd: proj }, events: agentEvents, [Symbol.dispose]() {} }) },
    sessionController: { resolveAgent: async (id) => (id === 's1' ? { agent } : id === 'sub' ? { agent: subAgent } : { error: 'unknown' }) },
  };
  installGoalCheck(installed, home, file);
  const gate = (name, args, a = agent, downstream = { kind: 'allow' }) => listeners['tools/pre-execute']({ name, arguments: JSON.stringify(args), agent: a, signal: new AbortController().signal }, async () => downstream);
  const complete = { goal_id: 'goal-1', revision: 1, action: 'complete' };
  process.env.FAIL = '1';
  let d = await gate('update_goal', complete);
  assert.equal(d.kind, 'deny'); assert.match(d.reason, /`npm test` exited with code 1/);
  for (const [name, args] of [['update_goal', { ...complete, action: 'blocked' }], ['update_goal', { ...complete, action: 'pause' }], ['bash', { command: 'x' }], ['get_goal', {}]]) {
    assert.deepEqual(await gate(name, args), { kind: 'allow' }, `${name} ${args.action ?? ''}`);
  }
  assert.deepEqual(await gate('update_goal', complete, agent, { kind: 'deny', reason: 'approval' }), { kind: 'deny', reason: 'approval' }, 'another gate decides first');
  assert.deepEqual(await gate('update_goal', complete, subAgent), { kind: 'allow' }, 'not for a subagent');
  agentEvents = [...chatEvents, turnStart(), user('Mark the goal complete, I checked it')];
  assert.deepEqual(await gate('update_goal', complete), { kind: 'allow' }, 'the user decides in a human turn');
  agentEvents = [...chatEvents, turnStart(), user('round 2', 'goal', { round: 2 })];
  { const stop = new AbortController(); const p = listeners['tools/pre-execute']({ name: 'update_goal', arguments: complete, agent, signal: stop.signal }, async () => ({ kind: 'allow' }));
    stop.abort(); assert.deepEqual(await p, { kind: 'cancel' }, 'a cancelled call'); }
  // The last result is saved for the row; a running check is shared by two callers.
  let row = await (await routes.get(GOAL_CHECK_PATH).fetch(new Request(`http://h${GOAL_CHECK_PATH}?sessionId=s1`))).json();
  assert.equal(row.on, true); assert.equal(row.detected, 'npm test'); assert.equal(row.check, null); assert.equal(row.last.stage, 'test'); assert.equal(row.goal.id, 'goal-1');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  process.env.FAIL = '0';
  const runsBefore = spawned.filter((s) => s.argv.includes('npm test')).length;
  const [a1, a2] = await Promise.all([gate('update_goal', complete), gate('update_goal', complete)]);
  assert.deepEqual(a1, { kind: 'allow' }); assert.deepEqual(a2, { kind: 'allow' });
  assert.equal(spawned.filter((s) => s.argv.includes('npm test')).length - runsBefore, 1, 'one run for two calls');
  // A check that started before the log moved is not shared: Run now runs, the agent changes a file, then completes.
  { const counter = join(root, 'runs.txt');
    const runs = async () => (await readFile(counter, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
    // Wait for the run to start (not a fixed delay: a slow spawn made the count flaky).
    const until = async (n) => { for (let i = 0; i < 250 && await runs() < n; i++) await new Promise((res) => setTimeout(res, 20)); assert.equal(await runs(), n, `run ${n} started`); };
    await routes.get(GOAL_CHECK_PATH).fetch(new Request(`http://h${GOAL_CHECK_PATH}`, { method: 'POST', body: JSON.stringify({ sessionId: 's1', check: { command: `echo x >> ${counter}; sleep 0.3` } }) }));
    const runNow = routes.get(GOAL_CHECK_PATH).fetch(new Request(`http://h${GOAL_CHECK_PATH}`, { method: 'POST', body: JSON.stringify({ sessionId: 's1', run: true }) }));
    await until(1);
    agentEvents = [...agentEvents, ...tool('edit', { file_path: 'Header.tsx' }, 'edited')];
    const joined = await gate('update_goal', complete);
    await runNow;
    assert.deepEqual(joined, { kind: 'allow' });
    assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 2, 'the completion after a change runs its own check');
    const same = Promise.all([gate('update_goal', complete), gate('update_goal', complete)]);
    await same;
    assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 3, 'two calls on the same log state share one run');
    // The first caller cancels a shared check: the second caller is not denied by that cancel, it checks on its own.
    const stop = new AbortController();
    const first = listeners['tools/pre-execute']({ name: 'update_goal', arguments: complete, agent, signal: stop.signal }, async () => ({ kind: 'allow' }));
    await until(4); // the first caller owns the run (when both start together, either one can own it)
    const second = gate('update_goal', complete);
    await new Promise((res) => setTimeout(res, 100)); stop.abort();
    assert.deepEqual(await first, { kind: 'cancel' });
    assert.deepEqual(await second, { kind: 'allow' }, 'the other caller is not denied by a cancel that is not its own');
    assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 5, 'the cancelled run and the second caller\'s own run');
    await routes.get(GOAL_CHECK_PATH).fetch(new Request(`http://h${GOAL_CHECK_PATH}`, { method: 'POST', body: JSON.stringify({ sessionId: 's1', check: null }) })); }

  // The route.
  const post = async (body) => { const res = await routes.get(GOAL_CHECK_PATH).fetch(new Request(`http://h${GOAL_CHECK_PATH}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })); return { status: res.status, data: await res.json() }; };
  for (const body of ['nope', 'null', '[]', {}, { on: 'yes' }, { sessionId: 's1' }, { sessionId: 's1', check: { minutes: 0 } }, { sessionId: 's1', run: 'yes' }, { sessionId: 's1', check: {}, run: true }, { on: true, sessionId: 's1' }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post({ sessionId: 'sub', check: { command: 'x' } })).status, 409, 'not for a subagent chat');
  assert.equal((await post({ sessionId: 'nobody', run: true })).status, 409);
  r = await post({ sessionId: 's1', check: { command: 'exit 4', tokens: 50 } });
  assert.equal(r.status, 200); assert.deepEqual(r.data.check, { command: 'exit 4', tokens: 50 });
  r = await post({ sessionId: 's1', run: true });
  assert.equal(r.data.last.code, 4); assert.equal(r.data.last.command, 'exit 4');
  r = await post({ sessionId: 's1', check: null });
  assert.equal(r.data.check, null); assert.equal(r.data.last.code, 4, 'the last result stays');
  assert.deepEqual((await post({ on: false })).data, { on: false });
  assert.deepEqual(await gate('update_goal', complete), { kind: 'allow' }, 'switched off: no check');
  assert.deepEqual((await post({ on: true })).data, { on: true });
  assert.equal((await post({ model: { provider: 'p', model: 'gone' } })).status, 409);
  assert.deepEqual((await post({ model: { provider: 'p', model: 'm' } })).data, { on: true, model: { provider: 'p', model: 'm' } });
  const catalog = await (await routes.get(GOAL_CHECK_PATH).fetch(new Request(`http://h${GOAL_CHECK_PATH}?catalog=1`))).json();
  assert.equal(catalog.catalog.groups.length, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).on, true);

  // The budget: over the token limit at an idle edge → dsh's blocked state, once; a new limit counts from now.
  seq = 1000;
  agentEvents = [goalChange('create', G), user('round', 'goal', { round: 1 }), reply('a', { inputTokens: 40, outputTokens: 20 })];
  await post({ sessionId: 's1', check: { tokens: 100 } });
  agent.status = 'idle';
  listeners['agent/status']({ agent, status: 'idle' }); await new Promise((res) => setTimeout(res, 50));
  assert.equal(blocked.length, 0, '60 tokens counted from the save: under the limit');
  agentEvents = [...agentEvents, reply('b', { inputTokens: 80, outputTokens: 30 })];
  listeners['agent/status']({ agent, status: 'idle' }); await new Promise((res) => setTimeout(res, 50));
  assert.equal(blocked.length, 1); assert.equal(blocked[0].reason.code, 'budget-limit'); assert.match(blocked[0].reason.message, /used 110 tokens \(limit 100\)/);
  listeners['agent/status']({ agent, status: 'idle' }); await new Promise((res) => setTimeout(res, 50));
  assert.equal(blocked.length, 1, 'a blocked goal is not blocked again');
  // Resuming starts a new budget.
  goalView = { ...goalView, phase: 'active', revision: 3 };
  agentEvents = [...agentEvents, goalChange('resume', { ...G, revision: 3 }), reply('c', { inputTokens: 50 })];
  listeners['agent/status']({ agent, status: 'idle' }); await new Promise((res) => setTimeout(res, 50));
  assert.equal(blocked.length, 1, '50 tokens after the resume');
  agent.status = 'running';
  agentEvents = [...agentEvents, reply('d', { inputTokens: 100 })];
  listeners['agent/status']({ agent, status: 'idle' }); await new Promise((res) => setTimeout(res, 50));
  assert.equal(blocked.length, 1, 'a turn that started meanwhile: the next idle edge decides');
  // The chat's subagents count too: 50 own tokens + 70 of a subagent after the resume are over 100 (its older call is not).
  agent.status = 'idle';
  agentEvents = agentEvents.slice(0, -1);
  const resumedAt = agentEvents.at(-2).time;
  services.sessionPersistence = { list: async () => [{ header: { id: 's1' } }, { header: { id: 'k1', origin: 'subagent', parentSession: 's1' } }] };
  const subLog = [{ seq: 1, time: resumedAt - 5, type: 'assistant/message', data: { usage: { inputTokens: 900 } } }, { seq: 2, time: resumedAt + 1, type: 'assistant/message', data: { usage: { inputTokens: 70 } } }];
  const observe = installed.sessionQuery.observeSession;
  installed.sessionQuery.observeSession = async (id, o) => (id === 'k1' ? { events: subLog, [Symbol.dispose]() {} } : observe(id, o));
  row = await (await routes.get(GOAL_CHECK_PATH).fetch(new Request(`http://h${GOAL_CHECK_PATH}?sessionId=s1`))).json();
  assert.equal(row.goal.tokens, 120, 'the row counts the subagent');
  listeners['agent/status']({ agent, status: 'idle' }); await new Promise((res) => setTimeout(res, 50));
  assert.equal(blocked.length, 2, 'over the limit with the subagent'); assert.match(blocked[1].reason.message, /used 120 tokens \(limit 100\)/);
  delete services.sessionPersistence; installed.sessionQuery.observeSession = observe;

  // At most GOAL_CHECK_MAX chats are kept, the newest change first.
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.sessions = Object.fromEntries(Array.from({ length: GOAL_CHECK_MAX + 5 }, (_, i) => [`old${i}`, { command: 'x', at: i }]));
  await writeFile(file, JSON.stringify(saved));
  await post({ sessionId: 's1', check: { command: 'npm test' } });
  const kept = JSON.parse(await readFile(file, 'utf8')).sessions;
  assert.equal(Object.keys(kept).length, GOAL_CHECK_MAX); assert.ok(kept.s1 !== undefined && kept.old0 === undefined && kept[`old${GOAL_CHECK_MAX + 4}`] !== undefined);

  effectStop?.();
  console.log('goal check: host ok');
} finally {
  delete process.env.FAIL;
  await rm(root, { recursive: true, force: true });
}
