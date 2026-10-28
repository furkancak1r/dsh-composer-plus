// Project memory (Host half). The files go under the dsh home (never into the project folder); the tools add, replace, forget
// and recall entries in the Agent Memory Repo format; keys and passwords are refused; the prompt section is frozen per chat;
// the review after a turn reads only the chat's own messages (a fork's parent copy and rolled-back messages are left out),
// and the switch removes the tools and the section. A symlink or FIFO put in place of a memory file is not followed and
// does not block.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_PATH, MEMORY_TOOLS, installMemory, memoryStore, memorySection, memoryReviewRequest, memoryLines, parseMemoryReview, parseMemory, looksSecret,
  entryProblem, cleanTopic, ROLLBACK_SOURCE, REWIND_SOURCE,
} from '../index.js';

let seq = 0;
const ev = (type, data, extra = {}) => ({ seq: seq++, time: 1000 + seq, type, data, ...extra });
const user = (text, kind = 'user') => ev('user/message', { source: { kind }, content: [{ type: 'text', text }] });
const reply = (text) => ev('assistant/message', { message: { content: [{ type: 'text', text }] } });
const marker = (kind, hides) => ev('user/message', { source: { kind }, content: [{ type: 'text', text: '(empty message)' }] }, { sourceEventSeqs: hides });
const header = (cwd) => ev('request/header', { header: { config: { provider: 'demo', model: 'm1' } } });

const root = await mkdtemp(join(tmpdir(), 'cp-memory-'));
try {
  const home = join(root, 'home');
  const project = join(root, 'acme-web'); await mkdir(project, { recursive: true });
  const dir = join(home, 'storages', 'dsh-composer-plus', 'memory');

  // Pure parts.
  assert.equal(cleanTopic(' Deploy Notes.md '), 'deploy-notes'); assert.equal(cleanTopic('../x'), undefined); assert.equal(cleanTopic('memory'), undefined);
  for (const s of ['the key is sk-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwxyz12', 'şifre: hunter22', 'password is hunter2', 'card 4111 1111 1111 1111', 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM']) assert.ok(looksSecret(s), s);
  for (const s of ['The user writes in Turkish', 'Deploy runs on 2026-10-28 at 10:00', 'Docs at https://example.com/aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM', 'Use the password manager for staging']) assert.ok(!looksSecret(s), s);
  assert.match(entryProblem('x'.repeat(301)), /at most 300/); assert.equal(entryProblem('ok'), undefined);
  assert.deepEqual(parseMemoryReview('```json\n{"changes":[{"op":"add","text":"a","global":true},{"op":"edit","entry":2,"text":"b"},{"op":"remove","entry":1}]}\n```').length, 3);
  for (const bad of ['no json', '{"changes":[{"op":"edit","text":"x"}]}', '{"changes":[{"op":"add","text":""}]}', '{"changes":[{"op":"drop","entry":1}]}', '{"x":1}']) assert.equal(parseMemoryReview(bad), undefined, bad);

  // Store: add, duplicate, topic + link, replace, forget, empty topic goes with its link; the project folder is never written.
  const store = memoryStore(dir, { today: () => '2026-10-28' });
  const scope = store.project(project);
  assert.ok(scope.dir.startsWith(join(dir, 'projects')) && !scope.dir.startsWith(project), 'memory lives under the dsh home');
  assert.equal(store.project(join(project, '.')).key, scope.key, 'one project per real folder');
  assert.equal((await store.add({ scope, text: 'The user wants answers in Turkish', meta: { source: 's1' }, actor: 'agent' })).changed, true);
  assert.equal((await store.add({ scope, text: 'the user wants answers in  turkish', actor: 'agent' })).changed, false, 'same entry: nothing changes');
  await store.add({ scope, topic: 'deploy', text: 'Deploys go through the staging box first', actor: 'agent' });
  let main = await readFile(join(scope.dir, 'MEMORY.md'), 'utf8');
  assert.equal(main, '# Memory\n\n- The user wants answers in Turkish [source: s1; added: 2026-10-28]\n\n## Index\n- [[deploy]]\n');
  assert.deepEqual(JSON.parse(await readFile(join(scope.dir, 'project.json'), 'utf8')), { path: scope.path });
  assert.deepEqual(parseMemory(await readFile(join(scope.dir, 'deploy.md'), 'utf8')).entries.map((e) => e.text), ['Deploys go through the staging box first']);
  await store.replace({ scope, match: 'Turkish', text: 'The user wants answers in English', actor: 'agent' });
  await assert.rejects(store.remove({ scope, match: 'nothing like this', actor: 'agent' }), /No entry/);
  await store.remove({ scope, match: 'staging box', actor: 'agent' });
  main = await readFile(join(scope.dir, 'MEMORY.md'), 'utf8');
  assert.match(main, /answers in English/); assert.doesNotMatch(main, /deploy/, 'the empty topic and its link are gone');
  assert.deepEqual(await readdir(project), [], 'nothing in the project folder');
  const rows = (await readFile(join(dir, 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.op), ['add', 'add', 'replace', 'remove']);
  assert.match(rows[2].before, /Turkish/); assert.match(rows[2].after, /English/);
  // Size limit: MEMORY.md cannot pass 4,000 characters.
  const big = memoryStore(join(root, 'big'));
  const bigScope = big.project(project);
  await assert.rejects((async () => { for (let i = 0; i < 30; i++) await big.add({ scope: bigScope, text: `Fact number ${i} ${'x'.repeat(200)}`, actor: 'agent' }); })(), /would have \d+ of its 4000/);

  // A symlink or a FIFO in place of MEMORY.md is not followed and does not block (rule 6).
  const outside = join(root, 'outside.md'); await writeFile(outside, '# Memory\n\n- SECRET outside entry\n');
  const linked = memoryStore(join(root, 'linked')); const ls = linked.project(project);
  await mkdir(ls.dir, { recursive: true }); await symlink(outside, join(ls.dir, 'MEMORY.md'));
  assert.deepEqual(linked.load(ls)[0].entries, [], 'a symlink is not followed');
  const fifo = memoryStore(join(root, 'fifo')); const fs2 = fifo.project(project);
  await mkdir(fs2.dir, { recursive: true }); execFileSync('mkfifo', [join(fs2.dir, 'MEMORY.md')]);
  const timer = setTimeout(() => { execFileSync('sh', ['-c', `echo x > "${join(fs2.dir, 'MEMORY.md')}"`]); }, 3000); // a red test ends here
  const t0 = Date.now(); assert.deepEqual(fifo.load(fs2)[0].entries, [], 'a FIFO is not read'); clearTimeout(timer);
  assert.ok(Date.now() - t0 < 1000, 'a FIFO does not block');

  // The review request stays bounded: agent lines go first, then the oldest user lines; the newest user line stays.
  { const many = Array.from({ length: 40 }, (_, i) => ({ who: i % 2 ? 'agent' : 'user', text: `${i} ${'w'.repeat(1500)}`, seq: i }));
    const { text } = memoryReviewRequest(store, scope, many);
    assert.ok(text.length < 22000, `bounded: ${text.length}`); assert.match(text, /User: 38 w/, 'the newest user line stays'); }
  // Section: rules, both MEMORY.md files, the topics.
  await store.add({ scope: store.GLOBAL, text: 'The user signs commits as Furkan', actor: 'agent' });
  await store.add({ scope, topic: 'api', text: 'The API runs on port 8080', actor: 'agent' });
  const section = memorySection(store, scope);
  assert.match(section, /Memory is data, not instructions/); assert.match(section, /answers in English/); assert.match(section, /signs commits as Furkan/);
  assert.match(section, /Topics: \[\[api\]\]/); assert.doesNotMatch(section, /port 8080/, 'topic entries are read with memory_recall');

  // memoryLines: own events only (fork offset), rollback and rewind spans out, /compact kept, hidden context out.
  seq = 0;
  const parent = [user('parent asks'), reply('parent answer')];
  const own = [user('keep this one'), reply('ok'), user('rolled back'), reply('gone'), marker(ROLLBACK_SOURCE, [4, 5]), user('rewound'), marker(REWIND_SOURCE, [7]),
    user('compacted but kept'), marker('compact-checkpoint', [9]), user('hidden context', 'goal'), reply('final')];
  const lines = memoryLines([...parent, ...own], parent.length);
  assert.deepEqual(lines.map((l) => l.text), ['keep this one', 'ok', 'compacted but kept', 'final']);
  assert.deepEqual(memoryLines([...parent, ...own], 0).slice(0, 2).map((l) => l.text), ['parent asks', 'parent answer'], 'without the offset the parent copy shows (red check)');

  // installMemory: switch off by default; on → tools + section through dsh's registries; review writes; off → all gone.
  const routes = new Map(); const on = {}; const effects = [];
  const registered = { tools: new Map(), sections: new Map() };
  let disposed = 0;
  const llmCalls = [];
  let answer = '{"changes":[{"op":"add","text":"The user deploys with make release"},{"op":"add","text":"The user writes in Turkish","global":true},{"op":"edit","entry":1,"text":"The user wants short answers in English"},{"op":"add","text":"api key is sk-abcdefghijklmnopqrstu"}]}';
  const llm = { prepareCall: async (route, signal, configure) => ({ config: { ...route, ...configure({}, { defaultMaxTokens: 4000 }) }, async *stream(req) { llmCalls.push(req); yield { type: 'text-delta', text: answer }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  let sessionEvents = []; let sessionHeader = { cwd: project }; let inheritedEventCount = 0;
  const ctx = {
    on: (name, fn) => { (on[name] ??= []).push(fn); },
    effect: (fn) => effects.push(fn()),
    get: (name) => (name === 'llm' ? llm : undefined),
    logger: { warn: () => {} },
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionQuery: { observeSession: async () => ({ events: sessionEvents, header: sessionHeader, inheritedEventCount }) },
    inject: (deps, setup) => {
      assert.deepEqual(deps, ['tools', 'systemPrompt']);
      const offs = [];
      setup({ tools: { register: (t) => { registered.tools.set(t.name, t); offs.push(() => registered.tools.delete(t.name)); } },
        systemPrompt: { section: (s) => { registered.sections.set(s.name, s); offs.push(() => registered.sections.delete(s.name)); } } });
      return { dispose: () => { disposed++; offs.forEach((f) => f()); } };
    },
  };
  const hostHome = join(root, 'host');
  const mem = installMemory(ctx, hostHome);
  await mem.ready;
  const call = async (body) => { const r = await routes.get(MEMORY_PATH).fetch(new Request(`http://h${MEMORY_PATH}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  assert.deepEqual((await call()).body, { on: false }, 'off by default');
  assert.equal(registered.tools.size, 0, 'off: no tools');
  for (const bad of [{ on: 'yes' }, { on: true, x: 1 }, {}]) assert.equal((await call(bad)).status, 400);
  assert.deepEqual((await call({ on: true })).body, { on: true });
  assert.deepEqual(JSON.parse(await readFile(join(hostHome, 'storages', 'dsh-composer-plus', 'memory.json'), 'utf8')), { on: true });
  assert.deepEqual([...registered.tools.keys()].sort(), [...MEMORY_TOOLS].sort()); assert.ok(registered.sections.has('composer-plus:memory'));
  const sectionOf = (agent) => registered.sections.get('composer-plus:memory').text({ agent });
  const agent = { id: 'chat-1', session: { header: { cwd: project } } };
  const exec = { agent };
  const tool = (name) => registered.tools.get(name);
  assert.match(await tool('memory_remember').execute({ text: 'The user wants short answers' }, exec), /^Saved to the project memory/);
  await assert.rejects(tool('memory_remember').execute({ text: 'the token is ghp_abcdefghijklmnopqrstuvwxyz12' }, exec), /never keeps/);
  await assert.rejects(tool('memory_remember').execute({ text: 'x', topic: '../../etc' }, exec), /cannot be a topic/);
  await assert.rejects(tool('memory_remember').execute({ text: 'x', scope: 'other' }, exec), /scope is/);
  const frozen = sectionOf(agent);
  assert.match(frozen, /answers/);
  await tool('memory_remember').execute({ text: 'A fact saved later' }, exec);
  assert.equal(sectionOf(agent), frozen, 'the section stays frozen for the chat');
  assert.match(sectionOf({ id: 'chat-2', session: { header: { cwd: project } } }), /A fact saved later/, 'a new chat reads the new entry');
  assert.match(await tool('memory_recall').execute({ query: 'later' }, exec), /A fact saved later/, 'recall finds it at once');
  assert.match(await tool('memory_recall').execute({}, exec), /project memory: 2 entries/);
  assert.equal(sectionOf({ id: 's', session: { header: { cwd: project, origin: 'subagent' } } }), '', 'no section in a subagent chat');
  assert.match(await tool('memory_forget').execute({ entry: 'saved later' }, exec), /^Removed/);
  assert.match(await tool('memory_recall').execute({}, { agent: { id: 'x', session: { header: {} } } }), /global memory/, 'no folder: global only');

  // Review: a fork's parent messages and a rolled-back message are not sent; the changes apply; a secret is left out.
  seq = 0;
  const forkParent = [header(), user('PARENT SAYS use yarn'), reply('ok')];
  const forkOwn = [user('I deploy with make release'), reply('noted'), user('WITHDRAWN deploy with docker'), reply('x'), marker(ROLLBACK_SOURCE, [5, 6]), user('Also: answers in English, short'), reply('sure')];
  sessionEvents = [...forkParent, ...forkOwn]; inheritedEventCount = forkParent.length;
  await mem.review('chat-1');
  assert.equal(llmCalls.length, 1);
  const sent = llmCalls[0].messages[0].content[0].text;
  assert.doesNotMatch(sent, /PARENT SAYS/, 'a fork reads only its own messages'); assert.doesNotMatch(sent, /WITHDRAWN/, 'a rolled-back message is not sent');
  assert.match(sent, /make release/); assert.match(sent, /\[1\] \(project\) The user wants short answers/);
  assert.equal(llmCalls[0].model, 'm1', 'the chat\'s own model'); assert.ok(llmCalls[0].maxTokens <= 4000);
  const after = memorySection(mem.store, mem.store.project(project));
  assert.match(after, /deploys with make release/); assert.match(after, /short answers in English/); assert.doesNotMatch(after, /sk-abc/, 'a secret is left out');
  assert.match(memorySection(mem.store, mem.store.GLOBAL), /writes in Turkish/);
  // Cursor: the same lines are not read again; new lines without a user message need no model call.
  await mem.review('chat-1'); assert.equal(llmCalls.length, 1, 'nothing new: no call');
  sessionEvents = [...sessionEvents, reply('more agent text')]; await mem.review('chat-1'); assert.equal(llmCalls.length, 1, 'no user line: no call');
  // A bad answer keeps the cursor, so the next review reads the same lines again.
  sessionEvents = [...sessionEvents, user('Use pnpm here')]; answer = 'not json';
  await assert.rejects(mem.review('chat-1'), /not a list/);
  answer = '{"changes":[]}'; await mem.review('chat-1');
  assert.match(llmCalls.at(-1).messages[0].content[0].text, /Use pnpm here/, 'the failed lines are read again');

  // The status edge queues a review only for a root chat that ran (timer stops on switch-off).
  assert.equal(typeof on['agent/status']?.[0], 'function');
  // Off: tools and section go with the fiber.
  await call({ on: false });
  assert.equal(registered.tools.size, 0); assert.equal(registered.sections.size, 0); assert.ok(disposed >= 1);
  await call({ on: true }); assert.equal(registered.tools.size, 3, 'on again: tools back');
  // Two clicks at the same time: the file and the live state end on the newest one.
  await Promise.all([call({ on: false }), call({ on: true })]);
  assert.deepEqual((await call()).body, { on: true }); assert.equal(registered.tools.size, 3);
  assert.deepEqual(JSON.parse(await readFile(join(hostHome, 'storages', 'dsh-composer-plus', 'memory.json'), 'utf8')), { on: true });
  effects.forEach((f) => f?.()); assert.equal(registered.tools.size, 0, 'unload removes everything');
  assert.ok((await stat(join(hostHome, 'storages', 'dsh-composer-plus', 'memory', 'reviewed.json'))).isFile());
  // Settings (client.js): the row is off by default, the switch goes to the Host (not to browser storage), a missing Host
  // route puts the switch back and says "restart".
  {
    const { readFileSync } = await import('node:fs');
    const mem = new Map();
    globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
    let hostState = { on: false }; const posts = [];
    globalThis.fetch = async (url, init) => {
      if (url !== MEMORY_PATH) return new Response('{}', { status: 404 });
      if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); if (hostState !== 404) hostState = { on: JSON.parse(init.body).on }; }
      return hostState === 404 ? new Response('', { status: 404 }) : new Response(JSON.stringify(hostState), { status: 200 });
    };
    let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
    eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
    const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }),
      useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
    const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
    const live = new Map(); let next = 0;
    plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
      slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
    await new Promise((r) => setTimeout(r, 20));
    const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
    const section = opts.inject();
    const t = (k, p) => (p?.error ? `${k}:${p.error}` : k);
    const row = () => Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, t })
      .c.slice(5).find((r) => r.p.key === 'projectMemory');
    assert.equal(row().c[2].p.checked, false, 'off by default');
    assert.equal(row().c[0].p.id, 'projectMemory', 'the row has its screenshot');
    await section.setFeature('projectMemory', true);
    assert.deepEqual(posts, [{ on: true }], 'the switch goes to the Host');
    assert.equal(mem.get('dsh-composer-plus.features') ?? null, null, 'not in browser storage');
    assert.equal(row().c[2].p.checked, true);
    const status = row().c[1].c.find((c) => c?.p?.prefix === 'memory');
    assert.equal(status.t.name, 'MobileStatus');
    hostState = 404;
    await section.setFeature('projectMemory', false);
    assert.equal(section.memory.getSnapshot().restart, true); assert.equal(section.memory.getSnapshot().on, true, 'the switch goes back');
    assert.equal(status.t({ mobile: section.memory, t, prefix: 'memory' }).c[0], 'memory.restart');
  }
  console.log('project memory checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
