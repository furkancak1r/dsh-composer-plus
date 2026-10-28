// Open GitHub issue (Later list): the Host runs the user's own `gh issue create` in the chat's folder with the stored idea
// (title as one `--title=` argument, body on stdin), passes a gh token by name past dsh's env scrub, keeps the issue link on
// the idea, refuses a second issue or an overlapping start of the same idea, and answers gh's own reason when gh is missing
// or refuses. No real gh and no network: a fake subprocess records each call.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, LATER_PATH, openIssue, issueBody, ISSUE_URL } from '../index.js';

const dir = await mkdtemp(join(tmpdir(), 'cp-issue-'));
const saved = process.env.DSH_HOME;
try {
  process.env.DSH_HOME = join(dir, 'dsh-home'); // never the real dsh home
  const project = join(dir, 'project');
  // A fake dsh subprocess: `resolveExecutable('gh')` and one spawn per call, answered by `reply(call)`.
  const calls = [];
  let reply = () => ({ code: 0, stdout: 'https://github.com/acme/web/issues/7\n', stderr: '' });
  let gate = Promise.resolve();
  let ghPath = '/opt/fake/bin/gh';
  const subprocess = {
    resolveExecutable: async (name) => { if (name !== 'gh' || ghPath === null) throw new Error(`${name} was not found on PATH`); return ghPath; },
    spawn(spec) {
      const call = { argv: spec.argv, cwd: spec.cwd, env: spec.env, stdin: spec.stdio.stdin?.data, signal: spec.signal };
      calls.push(call);
      const done = gate.then(() => reply(call));
      const handle = {
        done: done.then((r) => ({ exitCode: r.code })),
        collected: {
          stdout: { readFrom: () => ({ text: handle.result?.stdout ?? '', lossy: false }) },
          stderr: { readFrom: () => ({ text: handle.result?.stderr ?? '' }) },
        },
      };
      done.then((r) => { handle.result = r; });
      return handle;
    },
  };

  // 1. openIssue: argv, stdin, cwd, env (no token in argv; tokens only by name), the URL, gh's own reason.
  const idea = { title: '-Dark mode', summary: 'Add a dark theme.', why: 'Night use.' };
  let issue = await openIssue(subprocess, project, idea, { GH_TOKEN: 'tok', PATH: '/usr/bin', GITHUB_TOKEN: '' });
  assert.deepEqual(issue, { url: 'https://github.com/acme/web/issues/7', number: 7 });
  let c = calls.at(-1);
  assert.deepEqual(c.argv, ['/opt/fake/bin/gh', 'issue', 'create', '--title=-Dark mode', '--body-file', '-'], 'the title is one --title= argument');
  assert.equal(c.cwd, project, 'gh runs in the chat folder (its repository decides the GitHub repo)');
  assert.equal(c.stdin, 'Add a dark theme.\n\n**Why:** Night use.\n', 'the body goes on stdin');
  assert.equal(issueBody({ summary: 'Only.' }), 'Only.\n');
  assert.equal(c.env.GH_PROMPT_DISABLED, '1'); assert.equal(c.env.GH_TOKEN, 'tok', 'a gh token passes the scrub by name');
  assert.ok(!('GITHUB_TOKEN' in c.env), 'an empty token is not passed'); assert.ok(!('PATH' in c.env), 'other variables come from dsh\'s scrubbed env');
  assert.ok(c.signal instanceof AbortSignal && !c.signal.aborted, 'only the time-out can stop gh');
  reply = () => ({ code: 0, stdout: 'Creating issue in acme/web\n\nhttps://github.example.com/acme/web/issues/12\n', stderr: '' });
  assert.equal((await openIssue(subprocess, project, idea, {})).number, 12, 'the last URL line counts (GitHub Enterprise too)');
  reply = () => ({ code: 1, stdout: '', stderr: '\nTo get started with GitHub CLI, please run:  gh auth login\nmore\n' });
  await assert.rejects(openIssue(subprocess, project, idea, {}), (e) => e.status === 409 && /gh auth login/.test(e.message) && !/more/.test(e.message));
  reply = () => ({ code: 0, stdout: 'https://evil.example/x\n', stderr: '' });
  await assert.rejects(openIssue(subprocess, project, idea, {}), (e) => e.status === 409, 'output without an issue link is a failure');
  ghPath = null;
  await assert.rejects(openIssue(subprocess, project, idea, {}), (e) => e.status === 409 && /not installed/.test(e.message));
  ghPath = '/opt/fake/bin/gh';
  for (const bad of ['https://github.com/acme/web/pull/7', 'https://github.com/acme/web/issues/7 x', 'http://github.com/a/b/issues/1', 'https://github.com/a/issues/1']) assert.ok(!ISSUE_URL.test(bad), bad);

  // 2. The route: stored text only, the link kept on the idea, a second issue refused, one action per idea.
  const routes = new Map();
  const header = { cwd: project, origin: undefined };
  const ctx = { on() {}, effect() {}, get: () => undefined, connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionController: {}, subprocess,
    sessionQuery: { observeSession: async () => ({ header, events: [], [Symbol.dispose]() {} }) } };
  apply(ctx);
  const route = routes.get(LATER_PATH);
  const post = async (body) => { const r = await route.fetch(new Request(`http://h${LATER_PATH}`, { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  reply = () => ({ code: 0, stdout: 'https://github.com/acme/web/issues/41\n', stderr: '' });
  let res = await post({ sessionId: 's1', add: { title: 'Pantry tracker', summary: 'Track food at home.', why: 'Less waste.' } });
  const id = res.body.ideas[0].id;
  assert.equal((await post({ sessionId: 's1', issue: 7 })).status, 400, 'an id must be text');
  assert.equal((await post({ sessionId: 's1', issue: 'gone' })).status, 409, 'an unknown idea');
  const before = calls.length;
  res = await post({ sessionId: 's1', issue: id, title: 'from the browser' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.issue, { url: 'https://github.com/acme/web/issues/41', number: 41 });
  assert.deepEqual(res.body.ideas[0].issue, res.body.issue, 'the answer list shows the link');
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).argv[3], '--title=Pantry tracker', 'the stored title, not text from the browser');
  const file = JSON.parse(await readFile(join(process.env.DSH_HOME, 'storages', 'dsh-composer-plus', 'later.json'), 'utf8'));
  assert.deepEqual(file[project][0].issue.number, 41, 'the link is saved with the idea');
  res = await post({ sessionId: 's1', issue: id });
  assert.equal(res.status, 409); assert.match(res.body.error, /already has an issue/); assert.equal(calls.length, before + 1, 'no second issue');
  // A double click: the second request waits for none (409) and gh runs once.
  res = await post({ sessionId: 's1', add: { title: 'Timer', summary: 'Start a timer.' } });
  const timer = res.body.ideas[0].id;
  let open; gate = new Promise((r) => { open = r; });
  const first = post({ sessionId: 's1', issue: timer });
  await new Promise((r) => setTimeout(r, 20));
  // Without the guard the second request would wait for the same gh: a 1 s limit makes that a clear failure.
  const soon = (p, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: waited for the running issue`)), 1000))]);
  assert.equal((await soon(post({ sessionId: 's1', issue: timer }), 'second issue')).status, 409, 'a second issue of the same idea while one runs');
  assert.equal((await soon(post({ sessionId: 's1', start: timer }), 'start')).status, 409, 'a start of the same idea while its issue runs');
  open(); res = await first; gate = Promise.resolve();
  assert.equal(res.status, 200); assert.equal(calls.filter((x) => x.argv[3] === '--title=Timer').length, 1, 'gh ran once');
  // gh refuses: 409 with its reason, the idea stays without a link.
  reply = () => ({ code: 1, stdout: '', stderr: 'none of the git remotes configured for this repository point to a known GitHub host\n' });
  res = await post({ sessionId: 's1', add: { title: 'Search', summary: 'Find notes.' } });
  const search = res.body.ideas[0].id;
  res = await post({ sessionId: 's1', issue: search });
  assert.equal(res.status, 409); assert.match(res.body.error, /known GitHub host/);
  res = await post({ sessionId: 's1', add: { title: 'Search', summary: 'Find notes.' } });
  assert.equal(res.body.ideas.find((i) => i.id === search).issue, undefined, 'a failed issue leaves no link');
  console.log('github issue checks passed');
} finally {
  if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
  await rm(dir, { recursive: true, force: true });
}
