// Assistant status panel (Host half): the tasks of the assistant chat (its direct subagents from `subagent/catalog`, with
// state, times and the first line of the result; a fork's copy of its parent is left out; older than today: left out),
// the projects that changed in the last 24 hours (no assistant, subagent, blank or archived chat), one project's git
// details (a real temporary repository; read-only), the status_summary_set tool (only the assistant chat, limits, saved
// in a file that a new Host reads again, a broken file is kept aside) and the GET guards (another chat gets no status; an unknown or unregistered
// project gets 404; off: nothing), and the delegated chats that ended today (done, failed or stopped after the open tasks;
// gone the next day). A task that dsh's quit or an AIProxy outage keeps runs only while its chat runs (issue #5).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_TODOS_PATH, STATUS_LIMITS, TODO_TOOLS, installAssistant, installAssistantBot, installAssistantTodos, statusGit, statusProjects, statusTasks } from '../index.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const ev = (seq, type, data, time = NOW - 1000) => ({ seq, type, data, time });
const reply = (seq, text, time) => ev(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } }, time);
const children = {
  'c-run': { status: 'running', log: [ev(0, 'turn/start', {})] },
  'c-wait': { status: 'running', log: [ev(0, 'turn/start', {}), ev(1, 'approval/asked', { id: 'a' })] },
  'c-done': { status: 'idle', log: [ev(0, 'turn/start', {}), reply(1, '\n  Flights found: 3 options\nmore'), ev(2, 'turn/end', { reason: { kind: 'completed' } }, NOW - 5000)] },
  'c-fail': { status: 'idle', log: [ev(0, 'turn/start', {}), ev(1, 'turn/end', { reason: { kind: 'error', error: { message: 'HTTP 500\nstack' } } }, NOW - 4000)] },
  'c-stop': { status: 'idle', log: [ev(0, 'turn/start', {}), ev(1, 'turn/end', { reason: { kind: 'aborted' } }, NOW - 3000)] },
  'c-old': { status: 'idle', log: [ev(0, 'turn/start', {}), reply(1, 'old'), ev(2, 'turn/end', { reason: { kind: 'completed' } }, NOW - 2 * 86400000)] },
};
// c-done is gone from dsh's live agents (dsh disposes a one-shot child when it ends): its saved log is read.
const agentOf = (id) => (children[id] === undefined || id === 'c-done' || id === 'c-lost' ? undefined : { status: children[id].status, session: { snapshotEvents: () => children[id].log } });
const logOf = async (id) => { if (id === 'c-lost') throw new Error('no log'); return children[id]?.log ?? []; };
children['c-lost'] = { status: 'idle', log: [] };
const cat = (seq, childId, label, extra = {}) => ev(seq, 'subagent/catalog', { version: 0, childId, childCreatedAt: NOW - 60000 + seq, mode: 'one-shot', label, ...extra });
const events = [cat(0, 'c-inherited', 'from the parent'), cat(1, 'c-run', 'Research Rome'), cat(2, 'c-wait', 'Deploy'), cat(3, 'c-done', 'Flights'), cat(4, 'c-fail', 'Build'),
  cat(5, 'c-stop', 'Stopped one'), cat(6, 'c-old', 'Yesterday'), cat(7, 'c-run', 'Research Rome again'), cat(8, 'x-ext', 'External', { mode: 'external' }), cat(9, 'c-lost', 'Lost log')];
const today = new Date(NOW); today.setHours(0, 0, 0, 0);
const tasks = await statusTasks(events, 1, agentOf, { logOf, since: today.getTime(), now: NOW });
const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
assert.equal(byId['c-inherited'], undefined, 'a fork\'s copy of its parent is left out');
assert.equal(byId['x-ext'], undefined, 'an external execution has no chat');
assert.equal(byId['c-old'], undefined, 'a task that ended before today is left out');
assert.equal(tasks.filter((t) => t.id === 'c-run').length, 1, 'one row per child');
assert.equal(byId['c-run'].state, 'running'); assert.equal(byId['c-run'].title, 'Research Rome'); assert.equal(byId['c-run'].ended, undefined);
assert.equal(byId['c-wait'].state, 'waiting', 'an open approval: waits for the user');
assert.equal(byId['c-done'].state, 'done'); assert.equal(byId['c-done'].result, 'Flights found: 3 options', 'the first line of its last reply');
assert.equal(byId['c-done'].ended, NOW - 5000);
assert.equal(byId['c-fail'].state, 'failed'); assert.equal(byId['c-fail'].result, 'HTTP 500');
assert.equal(byId['c-stop'].state, 'stopped');
assert.equal(byId['c-lost'].state, 'stopped', 'a gone child without a saved log does not show as working');
assert.deepEqual(tasks.slice(0, 2).map((t) => t.state).sort(), ['running', 'waiting'], 'running tasks first');
assert.equal(byId['c-done'].ended, NOW - 5000, 'the ended time from the saved log');
assert.equal((await statusTasks([...Array(30)].map((_, i) => cat(i, `c-${i}`, `t${i}`)), 0, () => undefined, { now: NOW })).length, STATUS_LIMITS.tasks, 'a limit');
assert.equal(byId['c-done'].result.length <= STATUS_LIMITS.result + 1, true);
// A disposed child that ended before today: its saved log is read once, not at each read (the panel reads every 5 s).
{
  let reads = 0; let log = children['c-old'].log; let live; const kept = new Map();
  const old = [cat(0, 'c-old', 'Yesterday', { childCreatedAt: NOW - 2 * 86400000 - 60000 })];
  const read = () => statusTasks(old, 0, () => live, { logOf: async () => { reads += 1; return log; }, since: today.getTime(), now: NOW, ended: kept });
  for (let i = 0; i < 3; i++) assert.deepEqual(await read(), [], 'a task that ended before today is left out');
  assert.equal(reads, 1, 'the saved log of an old ended child is read once');
  // dsh resumes it (a continuable child gets a new message; its parent gets no new catalog event): it is read again.
  log = [...log, ev(3, 'turn/start', {})]; live = { status: 'running', session: { snapshotEvents: () => log } };
  assert.equal((await read())[0]?.state, 'running', 'a resumed child shows as running');
  log = [...log, reply(4, 'new answer'), ev(5, 'turn/end', { reason: { kind: 'completed' } }, NOW - 500)]; live = undefined;
  assert.equal((await read())[0]?.result, 'new answer', 'disposed again: its new saved log is read');
}
// dsh crashed or was killed while a child ran: the child is gone and its saved log ends with turn/start. When dsh opens
// such a child again, it closes the turn as `interrupted`. Neither runs or is done: both show as stopped, their saved log
// is read once, and they leave the next day.
{
  const logs = { 'c-crash': [ev(0, 'turn/start', {}), reply(1, 'Half of the answer', NOW - 7000)],
    'c-intr': [ev(0, 'turn/start', {}), reply(1, 'Half of the answer'), ev(2, 'turn/end', { reason: { kind: 'interrupted' } }, NOW - 2000)],
    // A continuable child: its first turn was done, dsh crashed in its second turn.
    'c-again': [ev(0, 'turn/start', {}), reply(1, 'First answer'), ev(2, 'turn/end', { reason: { kind: 'completed' } }, NOW - 9000), ev(3, 'turn/start', {}, NOW - 8000)] };
  const reads = { 'c-crash': 0, 'c-intr': 0, 'c-again': 0 }; const kept = new Map();
  const list = [cat(0, 'c-crash', 'Crashed'), cat(1, 'c-intr', 'Interrupted'), cat(2, 'c-again', 'Crashed again')];
  const read = (since, now) => statusTasks(list, 0, () => undefined, { logOf: async (id) => { reads[id] += 1; return logs[id]; }, since, now, ended: kept });
  for (let i = 0; i < 3; i++) {
    const rows = Object.fromEntries((await read(today.getTime(), NOW)).map((t) => [t.id, t]));
    assert.equal(rows['c-crash']?.state, 'stopped', 'a gone child with an open turn (dsh crashed) does not run');
    assert.equal(rows['c-crash'].ended, NOW - 7000, 'it stopped at its last saved event: its time does not grow');
    assert.equal(rows['c-crash'].result, 'Half of the answer');
    assert.equal(rows['c-intr']?.state, 'stopped', 'a crashed turn that dsh closed as interrupted is not done');
    assert.equal(rows['c-again']?.state, 'stopped', 'an open turn after a done turn: not done');
    assert.equal(rows['c-again'].ended, NOW - 8000);
  }
  assert.deepEqual(reads, { 'c-crash': 1, 'c-intr': 1, 'c-again': 1 }, 'the saved log of a gone child is read once');
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const fresh = (since, now) => statusTasks(list, 0, () => undefined, { logOf: async (id) => logs[id], since, now });
  assert.deepEqual((await read(tomorrow.getTime(), tomorrow.getTime() + 3600000)).map((t) => t.id), [], 'the next day: left out (kept rows)');
  assert.deepEqual((await fresh(tomorrow.getTime(), tomorrow.getTime() + 3600000)).map((t) => t.id), [], 'the next day: left out');
}

// Projects.
const ws = [{ id: 'w-web', title: 'acme-web', path: '/demo/acme-web', sessionIds: ['s-web', 's-web2', 's-old'] }, { id: 'w-cli', title: 'weather-cli', path: '/demo/weather-cli', sessionIds: ['s-cli', 's-arch'] },
  { id: 'w-as', title: 'Assistant', path: '/demo/Assistant', sessionIds: ['s-a'] }];
const items = [
  { sessionId: 's-a', updatedAt: NOW - 10, cwd: '/demo/Assistant', projections: { values: { title: 'Assistant' } } },
  { sessionId: 's-web', updatedAt: NOW - 1000, running: true, cwd: '/demo/acme-web', projections: { values: { title: 'Login page' } } },
  { sessionId: 's-web2', updatedAt: NOW - 3000, cwd: '/demo/acme-web', projections: { values: {} } },
  { sessionId: 's-old', updatedAt: NOW - 2 * 86400000, cwd: '/demo/acme-web' },
  { sessionId: 's-cli', updatedAt: NOW - 2000, cwd: '/demo/weather-cli', projections: { values: { title: 'Weather' } } },
  { sessionId: 's-arch', updatedAt: NOW - 100, cwd: '/demo/weather-cli' },
  { sessionId: 's-sub', updatedAt: NOW - 100, cwd: '/demo/weather-cli', origin: 'subagent' },
  { sessionId: 's-blank', updatedAt: NOW - 100, cwd: '/demo/weather-cli', blank: true },
  { sessionId: 's-branch', updatedAt: NOW - 1500, cwd: '/demo/acme-web/.worktrees/fix-login', projections: { values: { title: 'Fix login' } } },
];
const projects = statusProjects(items, ws, { since: NOW - STATUS_LIMITS.recentMs, skip: new Set(['s-a']), archived: new Set(['s-arch']) });
assert.deepEqual(projects.map((p) => p.title), ['acme-web', 'weather-cli'], 'newest first; the assistant\'s own project is left out');
assert.deepEqual(projects[0].chats.map((c) => [c.title, c.running]), [['Login page', true], ['Fix login', false], ['(untitled)', false]], 'no chat older than 24 hours; F-09: a branch folder chat counts for its project');
assert.equal(projects[0].count, 3); assert.deepEqual(projects[1].chats.map((c) => c.id), ['s-cli'], 'archived, subagent and blank chats are left out');

// Git details of one project (a real temporary repository; read-only commands).
const subprocess = {
  resolveExecutable: async () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
  spawn({ argv, cwd, env }) {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    return { done: new Promise((resolve) => { child.on('error', () => resolve({ exitCode: 127, signal: null })); child.on('close', (code) => resolve({ exitCode: code, signal: null })); }),
      collected: { stdout: { readFrom: () => ({ text: out, lossy: false }) }, stderr: { readFrom: () => ({ text: err }) } } };
  },
};
const root = await mkdtemp(join(tmpdir(), 'cp-status-'));
try {
  const repo = join(root, 'repo'); await mkdir(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  for (let i = 1; i <= 7; i++) { await writeFile(join(repo, 'f.txt'), String(i)); git('add', '.'); git('commit', '-q', '-m', `commit ${i}`); }
  git('switch', '-q', '-c', 'feature/x');
  const before = git('status', '--porcelain');
  const g = await statusGit(subprocess, repo);
  assert.equal(g.branch, 'feature/x');
  assert.deepEqual(g.commits.map((c) => c.subject), ['commit 7', 'commit 6', 'commit 5', 'commit 4', 'commit 3'], 'the newest commits');
  assert.match(g.commits[0].hash, /^[0-9a-f]{7,}$/); assert.ok(g.commits[0].at > 1e12, 'ms');
  assert.equal(git('status', '--porcelain'), before, 'nothing changed in the repository');
  assert.deepEqual(await statusGit(subprocess, root), {}, 'not a git repository: nothing');

  // The route with a fake dsh and the real installAssistant.
  const home = join(root, 'home'); const dir = join(home, 'storages', 'dsh-composer-plus');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'assistant.json'), JSON.stringify({ sessionId: 's-a' }));
  const agents = new Map(); const routes = new Map(); const sections = new Map(); let observed = 0; let listed = 0; const listeners = new Map();
  const newAgent = (id, header = { cwd: home }, log = []) => {
    const registered = new Map();
    const agent = { id, status: 'idle', session: { id, header, inheritedEventCount: 0, snapshotEvents: () => log },
      ctx: { tools: { register: (t) => { registered.set(t.name, t); return () => registered.delete(t.name); }, restrict: () => () => {} } }, registered };
    agents.set(id, agent); return agent;
  };
  const assistantAgent = newAgent('s-a', { cwd: home }, events.slice(1));
  for (const [id, c] of Object.entries(children)) { if (id === 'c-done' || id === 'c-lost') continue; const a = newAgent(id, { cwd: home, origin: 'subagent', parentSession: 's-a' }, c.log); a.status = c.status; }
  const otherAgent = newAgent('s-web');
  const wsReal = [...ws, { id: 'w-repo', title: 'repo', path: repo, sessionIds: [] }];
  const archivedIds = ['s-arch'];
  const ctx = {
    logger: { warn: () => {} }, subprocess,
    get: (name) => ({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] }, workspaceRegistry: { list: () => wsReal, archivedSessionIds: archivedIds }, sessionPersistence: { list: async () => [...agents.keys()].map((id) => ({ header: { id } })) } })[name],
    on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }, effect: () => {},
    inject: (deps, setup) => { setup({ systemPrompt: { section: (x) => { sections.set(x.name, x); }, context: () => {} } }); return { dispose: () => {} }; },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    sessionQuery: { observeSession: async (id) => { if (id === 'c-done') observed += 1; if (children[id] === undefined || id === 'c-lost') throw new Error('unknown'); return { header: {}, events: children[id].log, inheritedEventCount: 0, [Symbol.dispose]() {} }; }, readTitle: async () => ({ title: 'x' }) },
    sessionController: { list: async () => { listed += 1; return { items }; }, resolveAgent: async (id) => ({ agent: agents.get(id) }), prompt: async () => {} },
  };
  const assistant = installAssistant(ctx, home, { folder: join(home, 'Assistant'), zone: 'UTC' }); await assistant.ready;
  // A delegated chat (chat_new with branch) that runs: a task too.
  await assistant.tasks.add('s-deleg', { title: 'Fix the login form', project: 'acme-web', branch: 'assistant/fix-login' });
  newAgent('s-deleg', { cwd: '/demo/acme-web' }, [ev(0, 'turn/start', {}), ev(1, 'approval/asked', { id: 'q' })]).status = 'running';
  let clock = NOW;
  const todos = installAssistantTodos(ctx, home, assistant, { now: () => clock }); await todos.ready;
  const call = async (query) => { const res = await routes.get(ASSISTANT_TODOS_PATH).fetch(new Request(`http://x${ASSISTANT_TODOS_PATH}${query}`)); return { status: res.status, body: await res.json() }; };
  assert.ok(TODO_TOOLS.includes('status_summary_set')); assert.ok(assistantAgent.registered.has('status_summary_set'), 'the assistant has the tool');

  // GET: the status of the assistant chat.
  let r = await call('?sessionId=s-a');
  assert.equal(r.status, 200); assert.deepEqual(r.body.items, []); assert.equal(r.body.at, NOW);
  assert.deepEqual(r.body.tasks.map((t) => t.id).sort(), ['c-done', 'c-fail', 'c-lost', 'c-run', 'c-stop', 'c-wait', 's-deleg']);
  assert.deepEqual(r.body.tasks[0], { id: 's-deleg', title: 'Fix the login form', state: 'waiting', started: r.body.tasks[0].started, chat: true, result: 'acme-web · assistant/fix-login' }, 'a delegated chat is a task, first');
  assert.equal(r.body.tasks.find((t) => t.id === 'c-done').result, 'Flights found: 3 options', 'a disposed child: its saved log');
  // F-08: the next read does not read the ended child's log or all chats again; Refresh (`&refresh=1`) does.
  const [o1, l1] = [observed, listed];
  r = await call('?sessionId=s-a'); assert.equal(r.body.tasks.find((t) => t.id === 'c-done').result, 'Flights found: 3 options');
  assert.equal(observed, o1, 'an ended task is not read again (a log that could not be read is tried again)'); assert.equal(listed, l1, 'the chat list is not read again within 30 s');
  r = await call('?sessionId=s-a&refresh=1'); assert.equal(listed, l1 + 1, 'Refresh reads the chat list again');
  // A root chat's turn edge drops the cache (a new chat shows at once); a subagent's does not.
  const onEvent = listeners.get('session/event');
  for (const fn of onEvent) fn({ id: 'c-run', header: { origin: 'subagent' } }, { type: 'turn/end' });
  await call('?sessionId=s-a'); assert.equal(listed, l1 + 1, 'a subagent turn does not drop the cache');
  for (const fn of onEvent) fn({ id: 's-web', header: {} }, { type: 'turn/start' });
  await call('?sessionId=s-a'); assert.equal(listed, l1 + 2, 'a root chat turn drops the cache');
  // The assistant chat's own turns do not drop it (the panel leaves the assistant chat out of the projects), so a busy
  // assistant does not read all chats at each panel read. Another root chat's turn and Refresh still read them.
  for (const fn of onEvent) for (const type of ['turn/start', 'turn/end']) fn(assistantAgent.session, { type });
  await call('?sessionId=s-a'); assert.equal(listed, l1 + 2, 'the assistant chat\'s own turn does not drop the cache');
  // A chat that the assistant archives (chat_archive, in its own turn) leaves the projects at the next read, from the kept list.
  archivedIds.push('s-web2');
  for (const fn of onEvent) fn(assistantAgent.session, { type: 'turn/end' });
  r = await call('?sessionId=s-a'); assert.equal(listed, l1 + 2);
  assert.deepEqual(r.body.projects[0].chats.map((c) => c.id), ['s-web', 's-branch'], 'an archived chat leaves at once');
  archivedIds.pop();
  for (const fn of onEvent) fn({ id: 's-web', header: {} }, { type: 'turn/end' });
  await call('?sessionId=s-a'); assert.equal(listed, l1 + 3, 'another root chat\'s turn end drops the cache');
  await call('?sessionId=s-a&refresh=1'); assert.equal(listed, l1 + 4, 'Refresh still reads the chat list');
  // dsh resumes a disposed continuable child and disposes it again between two reads (no read saw it live, for example
  // while the panel was closed): its new events drop the kept task, so its new saved log is read.
  children['c-done'].log = [...children['c-done'].log, ev(3, 'turn/start', {}), reply(4, 'Flights booked'), ev(5, 'turn/end', { reason: { kind: 'completed' } }, NOW - 100)];
  for (const fn of onEvent) for (const type of ['turn/start', 'turn/end']) fn({ id: 'c-done', header: { origin: 'subagent' } }, { type });
  assert.equal((await call('?sessionId=s-a')).body.tasks.find((t) => t.id === 'c-done').result, 'Flights booked', 'a child that ran again unseen shows its new result');
  assert.deepEqual(r.body.projects.map((p) => p.id), ['w-web', 'w-cli']); assert.equal(r.body.summary, undefined);
  // Another chat: no status (its subagents are not the assistant's).
  r = await call('?sessionId=s-web'); assert.equal(r.body.tasks, undefined); assert.equal(r.body.projects, undefined);
  assert.equal((await call('?sessionId=')).status, 400);

  // The summary tool.
  const tool = assistantAgent.registered.get('status_summary_set');
  await assert.rejects(tool.execute({ projects: [{ project: 'acme-web', text: 'x' }] }, { agent: otherAgent }), (e) => e.status === 403);
  for (const bad of [{}, { projects: [] }, { projects: [{ project: '', text: 'x' }] }, { projects: [{ project: 'p', text: 'x'.repeat(STATUS_LIMITS.text + 1) }] },
    { projects: Array.from({ length: STATUS_LIMITS.projects + 1 }, (_, i) => ({ project: `p${i}`, text: 't' })) }]) {
    await assert.rejects(tool.execute(bad, { agent: assistantAgent }), (e) => e.status === 400, JSON.stringify(bad).slice(0, 50));
  }
  // No request and no typed or scheduled turn in the log: stored only (the tool result says so; see the morning summary below).
  assert.match(await tool.execute({ projects: [{ project: 'acme-web', text: '  Login page   done. ' }, { project: 'weather-cli', text: 'Tests fail.' }] }, { agent: assistantAgent }), /^The summary is stored\./);
  r = await call('?sessionId=s-a');
  assert.deepEqual(r.body.summary, { at: NOW, projects: [{ project: 'acme-web', text: 'Login page done.' }, { project: 'weather-cli', text: 'Tests fail.' }] });
  const file = join(dir, 'assistant-summary.json');
  assert.equal(((await stat(file)).mode & 0o777).toString(8), '600');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8')).chats), ['s-a']);
  // A new Host (a dsh restart) reads it again.
  const routes2 = new Map(); const ctx2 = { ...ctx, connection: { fetch: { register: (route) => { routes2.set(route.path, route); return () => {}; } } } };
  // (it reads the file; its tools are not mounted, so the first Host stays the only one with tools)
  const again = installAssistantTodos(ctx2, home, { ...assistant, addTools: () => ({ remount() {}, off() {} }) }, { now: () => clock }); await again.ready;
  r = await routes2.get(ASSISTANT_TODOS_PATH).fetch(new Request(`http://x${ASSISTANT_TODOS_PATH}?sessionId=s-a`));
  assert.equal((await r.json()).summary.projects.length, 2, 'the summary survives a restart');
  // A broken summary file is kept aside before the next write (a missing to-do file is not).
  {
    const brokenDir = join(root, 'broken'); await mkdir(brokenDir);
    await writeFile(join(brokenDir, 'assistant-summary.json'), '{not json');
    let toolsOf;
    const host = installAssistantTodos(ctx2, home, { ...assistant, addTools: (fn) => { toolsOf = fn; return { remount() {}, off() {} }; } }, { dir: brokenDir, now: () => clock }); await host.ready;
    await toolsOf().find((t) => t.name === 'status_summary_set').execute({ projects: [{ project: 'p', text: 't' }] }, { agent: assistantAgent });
    const names = (await readdir(brokenDir)).sort();
    assert.deepEqual(names.map((n) => n.replace(/\d+$/, 'N')), ['assistant-summary.json', 'assistant-summary.json.broken-N'], 'kept as assistant-summary.json.broken-<time>');
    assert.equal(await readFile(join(brokenDir, names[1]), 'utf8'), '{not json', 'with its old bytes');
  }

  // Get summary asks the assistant for a new summary (POST {sessionId, action: "summary"}): an idle chat gets a turn with one
  // hidden note (dsh's steer plus a marker at the queue head, as Assistant news), a running chat gets it at its next step.
  // One open request per chat; status_summary_set ends it; a turn that took the note and ended without a summary is
  // `missed`; after STATUS_LIMITS.askMs the Host forgets it. Not for another chat, not while off, a failed steer is 502.
  {
    const post = async (body) => { const res = await routes.get(ASSISTANT_TODOS_PATH).fetch(new Request(`http://x${ASSISTANT_TODOS_PATH}`, { method: 'POST', body: JSON.stringify(body) })); return { status: res.status, body: await res.json() }; };
    const steers = []; const heads = [];
    Object.assign(assistantAgent, { status: 'idle', steer: (m) => { steers.push(m); }, inbox: { prepend: (target, m) => heads.push([target, m]), remove: () => {}, nextStep: [] } });
    clock = NOW + 10;
    r = await post({ sessionId: 's-a', action: 'summary' });
    assert.deepEqual(r, { status: 200, body: { asked: NOW + 10 } });
    assert.equal(steers.length, 1); assert.equal(heads.length, 1, 'idle: a marker at the queue head too (the user\'s queued message waits)');
    assert.equal(steers[0].source.kind, 'composer-plus-status-summary');
    // dsh's pre-step: the markers become one note with the request text (a hidden message, not the user's).
    const preStep = listeners.get('agent/pre-step');
    const step = async (messages) => { let out = { kind: 'enter', messages }; for (const fn of [...preStep].reverse()) { const inner = out; out = await fn({ agent: assistantAgent }, async () => inner); } return out; };
    const typed = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId: 'r1' } };
    const entered = await step([heads[0][1], steers[0], typed]);
    const notes = entered.messages.filter((m) => m.source?.kind === 'composer-plus-status-summary');
    assert.equal(notes.length, 1, 'one note'); assert.match(notes[0].content[0].text, /clicked "Get summary" in the status panel\. Call status_summary_set now/);
    assert.equal(notes[0].source.form, 'snapshot'); assert.ok(entered.messages.includes(typed), 'the user\'s message stays');
    r = await call('?sessionId=s-a'); assert.equal(r.body.asked, NOW + 10); assert.equal(r.body.missed, undefined);
    // A second click (another window) while it is open: the same request, no second note.
    clock = NOW + 20; r = await post({ sessionId: 's-a', action: 'summary' });
    assert.equal(r.body.asked, NOW + 10); assert.equal(steers.length, 1, 'no second note');
    // The turn ends without a summary: missed; the next click asks again.
    for (const fn of onEvent) fn(assistantAgent.session, { type: 'turn/start' });
    for (const fn of onEvent) fn(assistantAgent.session, { type: 'turn/end' });
    r = await call('?sessionId=s-a'); assert.equal(r.body.missed, true, 'the turn with the note ended without a summary');
    clock = NOW + 30; r = await post({ sessionId: 's-a', action: 'summary' });
    assert.equal(r.body.asked, NOW + 30); assert.equal(steers.length, 2, 'after a missed turn, Get summary asks again');
    // A running chat: only the steer (the turn takes it at its next step).
    assistantAgent.status = 'running';
    await tool.execute({ projects: [{ project: 'acme-web', text: 'New.' }] }, { agent: assistantAgent });
    r = await call('?sessionId=s-a'); assert.equal(r.body.asked, undefined, 'status_summary_set ends the request'); assert.equal(r.body.summary.at, NOW + 30);
    assert.equal(r.body.summary.show, true, 'the answer to Get summary opens the card');
    clock = NOW + 40; r = await post({ sessionId: 's-a', action: 'summary' });
    assert.equal(steers.length, 3); assert.equal(heads.length, 2, 'running: no queue marker');
    // The time limit: the Host forgets it.
    clock = NOW + 40 + STATUS_LIMITS.askMs; r = await call('?sessionId=s-a'); assert.equal(r.body.asked, undefined, 'forgotten after askMs');
    // A steer that dsh refuses: 502 with the reason, and no request stays open.
    assistantAgent.status = 'idle'; assistantAgent.steer = () => { throw new Error('inbox closed'); };
    r = await post({ sessionId: 's-a', action: 'summary' }); assert.equal(r.status, 502); assert.match(r.body.error, /inbox closed/);
    assert.equal((await call('?sessionId=s-a')).body.asked, undefined);
    assert.equal((await post({ sessionId: 's-web', action: 'summary' })).status, 404, 'not for another chat');
    assert.equal((await post({ sessionId: 's-a', action: 'summary', extra: 1 })).status, 400);
    // A steer that came after the turn's last inbox check: the chat is woken for it when the turn completed. After your Stop
    // (or an error), no new turn starts: the marker goes and the request is missed.
    {
      const wakes = []; const removed = []; const left = { id: 'm-left', role: 'user', content: [], source: { kind: 'composer-plus-status-summary' } };
      Object.assign(assistantAgent, { status: 'idle', steer: (m) => { wakes.push(m); }, inbox: { prepend: () => {}, remove: (id) => { removed.push(id); return true; }, nextStep: [left] } });
      const settle = async (reason) => {
        clock += 1; await post({ sessionId: 's-a', action: 'summary' }); wakes.length = 0;
        for (const fn of onEvent) fn(assistantAgent.session, { type: 'turn/end', data: { reason: { kind: reason } } });
        for (const fn of listeners.get('agent/status')) fn({ agent: assistantAgent, status: 'idle' });
        await new Promise((res) => setImmediate(res));
      };
      await settle('completed'); assert.equal(wakes.length, 1, 'a completed turn: the chat wakes for the waiting note'); assert.deepEqual(removed, []);
      clock += STATUS_LIMITS.askMs; await settle('aborted');
      assert.equal(wakes.length, 0, 'after Stop: no new turn'); assert.deepEqual(removed, ['m-left'], 'the marker goes');
      assert.equal((await call('?sessionId=s-a')).body.missed, true, 'the request is missed');
      clock += STATUS_LIMITS.askMs; removed.length = 0; await settle('error');
      assert.equal(wakes.length, 0, 'after an error: no new turn'); assert.deepEqual(removed, ['m-left']);
      clock += STATUS_LIMITS.askMs; await call('?sessionId=s-a');
    }
    // Switched off while the note waits: the markers go without a note (the tool is gone) and the request is forgotten.
    {
      Object.assign(assistantAgent, { status: 'idle', steer: () => {}, inbox: { prepend: () => {}, remove: () => true, nextStep: [] } });
      clock += 1; await post({ sessionId: 's-a', action: 'summary' });
      const sw = (on) => routes.get(ASSISTANT_TODOS_PATH).fetch(new Request(`http://x${ASSISTANT_TODOS_PATH}`, { method: 'POST', body: JSON.stringify({ on }) }));
      await sw(false);
      const marker = { id: 'm-off', role: 'user', content: [], source: { kind: 'composer-plus-status-summary' } };
      const preStep = listeners.get('agent/pre-step'); let out = { kind: 'enter', messages: [marker] };
      for (const fn of [...preStep].reverse()) { const inner = out; out = await fn({ agent: assistantAgent }, async () => inner); }
      assert.deepEqual(out.messages, [], 'off: no note');
      await sw(true); assert.equal((await call('?sessionId=s-a')).body.asked, undefined, 'off forgets the request');
    }
    // The morning summary: status_summary_set in a turn that a scheduled task started opens the card (`show`) like a Get
    // summary answer, and so does a summary in a typed turn (the user asks in the chat). A summary in a turn of Assistant
    // news (background news) is stored only, and its tool result says so.
    {
      const log = assistantAgent.session.snapshotEvents(); const base = log.length;
      const add = (type, data) => log.push({ seq: log.length, type, data, time: clock });
      add('turn/start', {}); add('user/message', { source: { kind: 'schedule' } });
      clock += 1; await tool.execute({ projects: [{ project: 'acme-web', text: 'Morning.' }] }, { agent: assistantAgent });
      r = await call('?sessionId=s-a'); assert.equal(r.body.summary.show, true, 'the morning summary opens the card');
      add('tool/result', {}); add('subagent/settled', {}); // the same turn goes on: still the morning summary
      clock += 1; await tool.execute({ projects: [{ project: 'acme-web', text: 'Morning, with details.' }] }, { agent: assistantAgent });
      assert.equal((await call('?sessionId=s-a')).body.summary.show, true, 'its update in the same turn too');
      add('turn/end', {}); add('turn/start', {}); add('user/message', { source: { kind: 'user', rpcId: 'r9' } });
      clock += 1; await tool.execute({ projects: [{ project: 'acme-web', text: 'Typed.' }] }, { agent: assistantAgent });
      r = await call('?sessionId=s-a'); assert.equal(r.body.summary.show, true, 'the user asks in the chat: it opens the card');
      add('turn/end', {}); add('turn/start', {}); add('user/message', { source: { kind: 'schedule' } }); add('turn/end', {});
      add('turn/start', {}); add('user/message', { source: { kind: 'composer-plus-assistant-news' } });
      clock += 1; assert.match(await tool.execute({ projects: [{ project: 'acme-web', text: 'News.' }] }, { agent: assistantAgent }), /^The summary is stored\. .*do not write it in the chat/);
      assert.equal((await call('?sessionId=s-a')).body.summary.show, undefined, 'a news turn after the morning summary: stored only');
      log.splice(base);
    }
    delete assistantAgent.steer; delete assistantAgent.inbox; assistantAgent.status = 'idle';
  }

  // One project's git details: only a registered project and only for the assistant chat.
  r = await call('?sessionId=s-a&project=w-repo');
  assert.equal(r.status, 200); assert.equal(r.body.branch, 'feature/x'); assert.equal(r.body.commits.length, STATUS_LIMITS.commits);
  assert.equal((await call(`?sessionId=s-a&project=${encodeURIComponent(repo)}`)).status, 404, 'a path is not a project id');
  assert.equal((await call('?sessionId=s-a&project=w-none')).status, 404);
  assert.equal((await call('?sessionId=s-web&project=w-repo')).status, 404, 'not for another chat');
  r = await call('?sessionId=s-a&project=w-web'); assert.equal(r.status, 200); assert.equal(r.body.branch, undefined, 'a folder that is not there: no git details');
  clock = NOW + 1;

  // A delegated chat whose task the bot ends at its turn end stays under Tasks after the open tasks, with its final state,
  // until the day ends. A turn end that dsh's quit or an AIProxy outage stopped keeps the task (no ended row in the bot's
  // map), and the row is stopped while its chat does not run.
  let outageLeft; const outage = { takes: (session, reason) => reason?.error?.message === 'outage', onLeft: (fn) => { outageLeft = fn; } };
  const bot = installAssistantBot(ctx, home, assistant, { now: () => clock, outage }); await bot.ready;
  const turnEnd = (id, reason, ...before) => {
    const log = agents.get(id).session.snapshotEvents();
    for (const e of [...before, ev(0, 'turn/end', { reason }, clock)]) log.push({ ...e, seq: log.length });
    for (const fn of listeners.get('session/event')) fn(agents.get(id).session, log.at(-1));
  };
  const rowsOf = async (id) => (await call('?sessionId=s-a')).body.tasks.filter((t) => t.id === id);
  const open = (t) => t.state === 'running' || t.state === 'waiting';
  let started = assistant.tasks.get('s-deleg').at;
  turnEnd('s-deleg', { kind: 'completed' }, reply(0, 'PR ready\nmore'));
  assert.deepEqual(await rowsOf('s-deleg'), [{ id: 's-deleg', title: 'Fix the login form', state: 'done', started, ended: clock, chat: true, result: 'PR ready' }], 'an ended delegated chat stays with its final state');
  r = await call('?sessionId=s-a');
  assert.ok(r.body.tasks.findLastIndex(open) < r.body.tasks.findIndex((t) => t.id === 's-deleg'), 'after the open tasks');
  // The same chat gets a task again (chat_send): one open row; its next end replaces the ended row.
  await assistant.tasks.add('s-deleg', { title: 'Fix the login form', project: 'acme-web' }); started = assistant.tasks.get('s-deleg').at;
  assert.deepEqual((await rowsOf('s-deleg')).map((t) => t.state), ['running'], 'an open task again: no ended row');
  turnEnd('s-deleg', { kind: 'error', error: { message: 'HTTP 500\nstack' } }, ev(0, 'turn/start', {}));
  assert.deepEqual(await rowsOf('s-deleg'), [{ id: 's-deleg', title: 'Fix the login form', state: 'failed', started, ended: clock, chat: true, result: 'HTTP 500' }]);
  // A chat_send whose message does not go drops its new task: the ended row shows again (also when the panel read the
  // open task while the send waited).
  {
    const failed = await rowsOf('s-deleg');
    const { observeSession } = ctx.sessionQuery; const { prompt } = ctx.sessionController;
    ctx.sessionQuery.observeSession = async (id, o) => (id === 's-deleg' ? { header: { cwd: '/demo/acme-web' }, events: [], [Symbol.dispose]() {} } : observeSession(id, o));
    ctx.sessionController.prompt = async () => { assert.deepEqual((await rowsOf('s-deleg')).map((t) => t.state), ['running']); throw new Error('queue full'); };
    try { await assert.rejects(assistantAgent.registered.get('chat_send').execute({ chat_id: 's-deleg', text: 'again' }, { agent: assistantAgent }), /queue full/); } finally { Object.assign(ctx.sessionQuery, { observeSession }); Object.assign(ctx.sessionController, { prompt }); }
    assert.equal(assistant.tasks.has('s-deleg'), false);
    assert.deepEqual(await rowsOf('s-deleg'), failed, 'a message that did not go keeps the ended row');
  }
  // Issue #5: a delegated chat that dsh's quit stopped yesterday and that nothing continued. The bot keeps its task (the
  // chat's next turn end is still news), but the chat does not run: today the panel shows no running row with a time of
  // 23 hours, also when dsh does not have the chat live.
  {
    // Yesterday in the local time zone (the panel's day starts at local midnight), in every zone (TZ=Australia/Sydney too).
    const midnight = new Date(clock); midnight.setHours(0, 0, 0, 0);
    const at = midnight.getTime() - 86400000;
    await assistant.tasks.add('s-stale', { title: 'Update prices', project: 'acme-web', at });
    const log = [ev(0, 'turn/start', {}, at), ev(1, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, midnight.getTime() - 3600000)];
    const a = newAgent('s-stale', { cwd: '/demo/acme-web' }, log);
    for (const fn of listeners.get('session/event')) fn(a.session, log[1]);
    assert.equal(assistant.tasks.has('s-stale'), true, 'stopped by dsh: the task is kept');
    assert.deepEqual(await rowsOf('s-stale'), [], 'not running since yesterday: no row today');
    agents.delete('s-stale');
    assert.deepEqual(await rowsOf('s-stale'), [], 'not live: no row either');
    // Not live, but dsh's chat list shows activity today (for example after a restart). Without a saved log: dsh's list
    // time (its last prompt) for both ends, not the time from the task's first start yesterday.
    items.push({ sessionId: 's-stale', updatedAt: clock - 400, cwd: '/demo/acme-web' });
    assert.deepEqual((await rowsOf('s-stale')).map((t) => [t.state, t.started, t.ended]), [['stopped', clock - 400, clock - 400]], 'no saved log: its last prompt');
    // With its saved log (a log that could not be read is tried again): the time of its last turn. A saved log is read
    // once (until the chat's next turn).
    children['s-stale'] = { status: 'idle', log: [...log, ev(2, 'turn/start', {}, clock - 3000), ev(3, 'turn/end', { reason: { kind: 'interrupted' } }, clock - 500)] };
    assert.deepEqual((await rowsOf('s-stale')).map((t) => [t.state, t.started, t.ended]), [['stopped', clock - 3000, clock - 500]], 'stopped: the time of its last turn');
    children['s-stale'].log = [];
    assert.deepEqual((await rowsOf('s-stale')).map((t) => [t.state, t.started, t.ended]), [['stopped', clock - 3000, clock - 500]], 'the saved log is read once');
    // A saved log whose last turn failed (an AIProxy 429/503): failed, not stopped.
    for (const fn of listeners.get('session/event')) fn({ id: 's-stale' }, { type: 'turn/start' }); // its next turn: read again
    children['s-stale'].log = [...log, ev(2, 'turn/start', {}, clock - 3000), ev(3, 'turn/end', { reason: { kind: 'error', error: { message: 'aiproxy API error (429)' } } }, clock - 500)];
    assert.deepEqual((await rowsOf('s-stale')).map((t) => [t.state, t.ended]), [['failed', clock - 500]], 'its last turn failed: failed');
    delete children['s-stale']; items.pop();
    // It runs again (Resume after restart): running, and its time starts at the new turn, not yesterday.
    const again = newAgent('s-stale', { cwd: '/demo/acme-web' }, [...log, ev(2, 'turn/start', {}, clock - 2000)]); again.status = 'running';
    assert.deepEqual((await rowsOf('s-stale')).map((t) => [t.state, t.started]), [['running', clock - 2000]], 'running again: the time of its new turn');
    agents.delete('s-stale');
    await assistant.tasks.drop('s-stale');
    // A new task whose message is on its way (the chat does not run yet) is not stopped.
    await assistant.tasks.add('s-new', { title: 'New one', project: 'acme-web', at: clock - 1000 });
    assert.deepEqual((await rowsOf('s-new')).map((t) => t.state), ['running'], 'a new task: running while its message goes');
    await assistant.tasks.drop('s-new');
  }
  // dsh's quit and an AIProxy outage keep the task, but the chat does not run: the row is stopped at the chat's last
  // event (its time does not grow). The outage feature lets the chat go: failed.
  await assistant.tasks.add('s-kept', { title: 'Deploy', project: 'acme-web', at: clock - 60000 }); newAgent('s-kept', { cwd: '/demo/acme-web' }, [ev(0, 'turn/start', {})]);
  turnEnd('s-kept', { kind: 'aborted', reason: { kind: 'disposed' } });
  assert.equal(assistant.tasks.has('s-kept'), true, 'stopped by dsh: the task is kept');
  // Its time is the time of its last turn (from that turn's start, NOW - 1000), not from the task's start.
  assert.deepEqual((await rowsOf('s-kept')).map((t) => [t.state, t.started, t.ended, t.chat]), [['stopped', NOW - 1000, clock, true]], 'stopped by dsh: not running');
  turnEnd('s-kept', { kind: 'error', error: { message: 'outage' } }, ev(0, 'turn/start', {}));
  // Its last turn ended with an error (an AIProxy outage, 429 or 503) while the outage feature waits: failed, not stopped.
  assert.deepEqual((await rowsOf('s-kept')).map((t) => [t.state, t.chat]), [['failed', true]], 'kept for the outage: its last turn failed');
  assert.equal(assistant.tasks.has('s-kept'), true);
  assert.equal(assistant.endedTasks.has('s-kept'), false);
  outageLeft('s-kept', 'gone');
  assert.deepEqual((await rowsOf('s-kept')).map((t) => [t.state, t.started, t.result]), [['failed', NOW - 1000, 'outage']], 'the outage feature did not continue it: failed, with the time of its last turn');
  // The next day: the ended rows go.
  clock = NOW + 86400000;
  r = await call('?sessionId=s-a');
  assert.deepEqual(r.body.tasks.filter((t) => t.chat && !open(t)), [], 'an ended delegated chat of yesterday is left out');
  assert.equal(assistant.endedTasks.size, 0, 'and taken out of the map');

  // Off: no status, no git.
  const sw = await routes.get(ASSISTANT_TODOS_PATH).fetch(new Request(`http://x${ASSISTANT_TODOS_PATH}`, { method: 'POST', body: JSON.stringify({ on: false }) }));
  assert.deepEqual(await sw.json(), { on: false });
  r = await call('?sessionId=s-a'); assert.equal(r.body.tasks, undefined); assert.equal(r.body.summary, undefined);
  assert.equal((await call('?sessionId=s-a&project=w-repo')).status, 404);
  assert.equal(assistantAgent.registered.has('status_summary_set'), false, 'the tool leaves with the switch');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('assistant-status: ok');
