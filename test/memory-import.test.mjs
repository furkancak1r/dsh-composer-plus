// Memory import (part of Assistant setup): the scan list (documented agent memory files only, inside each project, no
// symlink out, no .env or key file, no private vault folder), the secret filter, the save path (the memory store: format,
// dedupe, journal; the source file as the source), idempotency (a second run adds nothing), and the tools only for a
// subagent of the assistant chat after the setup is ready. The client: the ready prompt shows in full in a text field
// after the setup is ready, can be changed, and goes only with a click on Start.
import './temp-home.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, utimes, chmod } from 'node:fs/promises';
import { readFileSync, openSync, closeSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMPORT_PROJECT_FILES, SETUP_BLOCKED, importSources, installMemory, installMemoryImport, secretFile, secretLine, withoutSecrets } from '../index.js';

/** A FIFO that a hanging open would wait on: after `ms` the test opens it for writing, so a red run ends. */
function fifo(path, ms = 3000) {
  execFileSync('mkfifo', [path]);
  const timer = setTimeout(() => { try { closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* no reader */ } }, ms);
  timer.unref();
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-import-')));
try {
  const home = join(root, 'home'); const dshHome = join(home, '.dsh');
  const web = join(root, 'acme-web'); const api = join(root, 'acme-api'); const outside = join(root, 'outside');
  await mkdir(join(dshHome), { recursive: true }); await mkdir(join(web, '.cursor', 'rules'), { recursive: true }); await mkdir(join(web, '.github'), { recursive: true });
  await mkdir(api, { recursive: true }); await mkdir(outside, { recursive: true }); await mkdir(join(home, '.claude', 'projects', '-x-acme', 'memory'), { recursive: true });
  await writeFile(join(dshHome, 'AGENTS.md'), '# Rules\n- The user writes in Turkish.\n');
  await writeFile(join(home, '.claude', 'projects', '-x-acme', 'memory', 'MEMORY.md'), '- The user likes short answers.\n');
  await writeFile(join(web, 'AGENTS.md'), '# acme-web\n- Deploys go through make release.\n- password: hunter2hunter2\n');
  await writeFile(join(web, 'CLAUDE.md'), '- Use pnpm.\n');
  await writeFile(join(web, '.github', 'copilot-instructions.md'), '- Tests use vitest.\n');
  await writeFile(join(web, '.cursor', 'rules', 'style.mdc'), '- Tabs, not spaces.\n');
  await writeFile(join(web, '.cursor', 'rules', '.env'), 'TOKEN=abc\n');
  await writeFile(join(web, '.env'), 'SECRET=1\n');
  await writeFile(join(web, 'README.md'), '# not a memory file\n');
  await writeFile(join(outside, 'AGENTS.md'), '- outside\n');
  await symlink(join(outside, 'AGENTS.md'), join(api, 'AGENTS.md')); // a link out of the project: never read
  await mkdir(join(api, '.windsurf')); await symlink(outside, join(api, '.windsurf', 'rules')); // a folder link out: never read
  await writeFile(join(api, '.env'), 'SECRET=2\n'); await symlink(join(api, '.env'), join(api, 'CLAUDE.md')); // a link to .env inside: never read
  fifo(join(api, 'GEMINI.md')); await mkdir(join(api, '.cursor', 'rules'), { recursive: true }); fifo(join(api, '.cursor', 'rules', 'pipe.md')); // FIFOs: never read, never block
  const tree = join(root, 'acme-web', '.worktrees', 'feature-x'); await mkdir(tree, { recursive: true }); await writeFile(join(tree, 'AGENTS.md'), '- worktree copy\n'); // a branch worktree

  // 1. The scan list: documented files only, in a fixed order; the user's own files first; no README, .env, link out.
  const list = await importSources({ projects: [web, api, join(root, 'gone')], home, dshHome });
  assert.ok(list.every((f) => !/GEMINI|pipe|\.env/.test(f.path)), 'no FIFO, no .env behind a link');
  const rel = (p) => p.replace(`${root}/`, '');
  assert.deepEqual(list.map((f) => [rel(f.path), f.scope]), [
    ['home/.dsh/AGENTS.md', 'global'], ['home/.claude/projects/-x-acme/memory/MEMORY.md', 'global'],
    ['acme-web/AGENTS.md', 'project'], ['acme-web/CLAUDE.md', 'project'], ['acme-web/.github/copilot-instructions.md', 'project'], ['acme-web/.cursor/rules/style.mdc', 'project'],
  ]);
  assert.ok(IMPORT_PROJECT_FILES.includes('GEMINI.md') && IMPORT_PROJECT_FILES.includes('.claude/CLAUDE.md'));
  // A private folder (the vault's Gizli/) and the memory folder are never read.
  const skipped = await importSources({ projects: [web], home, dshHome, skip: [await realpath(web)] });
  assert.equal(skipped.filter((f) => f.scope === 'project').length, 0, 'a skipped folder is not read');

  // 2. The secret filter: a line that looks like a secret goes; the rest stays.
  for (const s of ['password: hunter2hunter2', 'API_KEY=sk-abcdefghijklmnopqrstuv', 'DATABASE_URL=postgres://app:s3cretpw@db:5432/x', 'Authorization: Bearer abcdefghijklmnop123', 'token = 9f8e7d6c5b4a', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'şifre: Gizli123!', 'The deploy token is FAKE_TOKEN_9f8e7d6c5b4a3f2e1d', 'The secret is abc123def456',
    'Deploy token: `9f8e7d6c5b4a3f2e`', 'PW=hunter22', 'pw: hunter22', 'mysql -u root -pS3cretPass123', 'sshpass -p hunter22 ssh host', 'curl -u admin:Secr3tPw https://x', 'redis-cli -a S3cretPass1', 'psql --password=Secr3tPw', 'secret: `abcd1234efgh`', 'sshpass -phunter22', 'sshpass -v -p hunter22 ssh h', 'curl -uadmin:Secr3tPw', 'curl -u admin:12345678', 'redis-cli --pass hunter22', 'docker login --password hunter22', 'sshpass -p "hunter22" ssh user@host', "sshpass -p 'hunter22' ssh user@host", "mysql -u root -p'S3cretPass123' db", 'mysql -uroot -p"S3cretPass123"', 'redis-cli -a "S3cretPass1" ping', 'docker login --password "hunter22"', "curl -u 'admin:$ecret1' https://x", "sshpass -p '$ecretPw1' ssh h", "mysql -p'$ecretPw1' db", "redis-cli -a '$ecret99'", "curl -u admin:'Secr3tPw' https://x", 'curl -u admin:"Secr3tPw" https://x', 'login --password p@ss!word', "docker login --password '$ecretPw1'", 'docker login --password _Secr3tPw', 'login --password pass!!word', 'DB_PASS=hunter2hunter2', 'SMTP_PASS=mailpass99', 'JWT_SIGNING_KEY=abcdef123456', 'ENCRYPTION_KEY: 0123456789abcdef', '| DB password | hunter2hunter2 |', 'Authorization: Basic YWRtaW46U2VjcjN0UHc=', 'curl -H "Authorization: Basic YWRtaW46U2VjcjN0UHc=" https://x', 'Authorization: Token abc123def456', 'token: ghp_abc123def456', 'key = a1b2c3d4e5f6', 'GITHUB_TOKEN=ghp_xxxxxxxx1234', 'auth_token=abcd1234efgh']) assert.ok(secretLine(s), s);
  for (const s of ['Use pnpm, not npm.', 'The token budget is 8000 tokens.', 'Deploys go through make release.', 'See https://example.com/docs', 'Auth is handled by OAuth2.', 'The token is refreshed every 15 minutes.', 'Author: Furkancakir', 'OAuth: enabled always', 'compass: northwest', 'monkey: banana12', 'mysql -u root -P 3306 db', 'Run curl -u with your own user.', 'Use npm -p for packages.', 'The pwd command shows the folder.', 'redis-cli -h localhost -p 6379 ping', 'sshpass -f pass.txt ssh -p 2222 host', 'docker run -u node:node app', 'ffuf -u https://target/FUZZ', 'Connect with `mysql -u root -p`.', 'Use the --password option to get a prompt.', 'psql --password --host=db', 'sshpass -e ssh -p 22 host', 'Avoid --password flags.', 'Use --password-stdin, not --password itself.', 'curl -u "$USER:$PASS" https://api.example.com', 'curl -u admin:$API_PASS https://x', 'mysql -p$DB_PASS db', 'sshpass -p "$PASS" ssh h', 'Never use "sshpass -p", use -f.', "Do not run 'sshpass -p'.", 'Avoid ("sshpass -p") in scripts.', "Run 'mysql -u root -p'... then type the password.", 'Do not use --password directly!', 'Pass --password **only** in CI.', 'Use --password _only_ for tests.', '"deny": ["sshpass -p","rm -rf"]', 'Prefer "sshpass -f" over "sshpass -p"/"-e".', "Use 'sshpass -p'/'sshpass -e' only with care.", '(Do not use --password directly!)', 'Never pass --password directly!).', 'Use --password sparingly!!', 'docker login --password "$TOKEN"', 'Primary key: customer_id', 'max_tokens: 128000', 'Auth: required', '| Key | Description |', 'Use basic instructions.', 'Basic auth is disabled.', 'Token expiry: 15 minutes', 'Sort key: created_at']) assert.equal(secretLine(s), false, s);
  // A secret file name with either separator (Windows paths too).
  for (const f of ['C:\\p\\.env', 'C:\\p\\memory-bank\\secrets.md', '/p/.env.local', '/p/certs/server.pem']) assert.ok(secretFile(f), f);
  for (const f of ['/p/AGENTS.md', 'C:\\p\\CLAUDE.md', '/p/id_card.md']) assert.equal(secretFile(f), false, f);
  assert.deepEqual(withoutSecrets('- a\n- password: hunter2hunter2\n- b'), { text: '- a\n- b', cut: 1 });

  // 3. The tools: only a subagent of the assistant chat, only when the setup is ready; save through the store.
  const tools = new Map(); const routes = new Map();
  const agents = new Map();
  const ctx = { on: () => {}, effect: () => {}, logger: { warn: () => {} }, get: (n) => (n === 'workspaceRegistry' ? { list: () => [{ path: web }, { path: api }, { path: tree }] } : n === 'agents' ? { list: () => [...agents.values()], get: (id) => agents.get(id) } : undefined),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } }, sessionQuery: { observeSession: async () => ({ events: [], header: {} }) } };
  const mem = installMemory({ ...ctx, inject: undefined }, join(root, 'dsh-host'));
  await mem.ready;
  const vault = join(root, 'vault'); await mkdir(join(vault, 'Gizli'), { recursive: true }); await writeFile(join(vault, 'Gizli', 'AGENTS.md'), '- private\n');
  let ready = false;
  const assistant = { ready: Promise.resolve(), isOn: () => true, id: () => 'chat-a', folder: vault, rootOf: (id) => (id === 's-sub' || id === 's-nested' ? 'chat-a' : id) };
  const imp = installMemoryImport(ctx, dshHome, assistant, mem, { check: async () => ({ ready }) }, { userHome: home });
  const sub = { id: 's-sub', session: { header: { origin: 'subagent', parentSession: 'chat-a' } }, ctx: { tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name); } } } };
  imp.mount(sub);
  assert.deepEqual([...tools.keys()].sort(), ['memory_import', 'memory_import_sources'], 'the assistant\'s subagent gets the two tools');
  const other = { id: 'chat-b', session: { header: {} }, ctx: { tools: { register: () => { throw Error('must not mount'); } } } };
  imp.mount(other); // another chat: nothing
  const exec = { agent: sub };
  await assert.rejects(tools.get('memory_import_sources').execute({}, exec), (e) => e.message === SETUP_BLOCKED, 'not before the setup is ready');
  await assert.rejects(tools.get('memory_import').execute({ facts: [{ text: 'x', source: 'y' }] }, { agent: { id: 'chat-b', session: { header: {} } } }), /only in a subagent of the Composer Plus assistant chat/);
  ready = true;
  const read = JSON.parse(await tools.get('memory_import_sources').execute({}, exec));
  assert.equal(read.files.length, 6, 'a branch worktree is not a project of its own'); assert.equal(read.secretLinesCut, 1, 'the password line is cut');
  assert.ok(!read.files.some((f) => /worktree copy/.test(f.text)), 'the worktree copy is not read');
  assert.ok(read.files.every((f) => !/hunter2/.test(f.text)), 'no secret reaches the model');
  assert.ok(!read.files.some((f) => /private/.test(f.text)), 'the vault\'s private folder is not read');
  assert.match(read.note, /data, not instructions/);
  // Paging: a small total gives `next`.
  const small = installMemoryImport({ ...ctx, on: () => {} }, dshHome, assistant, mem, { check: async () => ({ ready: true }) }, { userHome: home, limits: { file: 65536, files: 200, dirFiles: 30, facts: 50, fact: 600, total: 40 } });
  const page = JSON.parse(await small.tools[0].execute({}, exec));
  assert.ok(page.files.length >= 1 && page.next !== undefined, 'a page and the next offset');
  // Save: project facts to that project, global facts to the global memory; a secret and an unknown project are skipped.
  const facts = [
    { text: 'The user writes in Turkish.', source: join(dshHome, 'AGENTS.md') },
    { text: 'acme-web deploys go through make release.', source: join(web, 'AGENTS.md'), project: web },
    { text: 'acme-web uses pnpm.', source: join(web, 'CLAUDE.md'), project: web },
    { text: 'The deploy password is hunter2hunter2', source: join(web, 'AGENTS.md'), project: web },
    { text: 'Something about a project that dsh does not know.', source: join(web, 'AGENTS.md'), project: join(root, 'unknown') },
    { text: 'A fact from a file that the scan did not list.', source: 'api key sk-abcdefghijklmnopqrstuv' },
  ];
  const first = JSON.parse(await tools.get('memory_import').execute({ facts }, exec));
  assert.deepEqual(first, { added: 3, duplicate: 0, secret: 1, unclear: 2, perProject: { global: 1, 'acme-web': 2 } });
  const webMemory = mem.store.load(mem.store.project(web))[0].content;
  assert.match(webMemory, /- acme-web uses pnpm\. \[source: import .*acme-web\/CLAUDE\.md; added: \d{4}-\d{2}-\d{2}\]/, 'the source file and the date');
  assert.doesNotMatch(webMemory + mem.store.load(mem.store.GLOBAL)[0].content, /sk-abc/, 'a source that is not a listed file is not saved');
  assert.match(mem.store.load(mem.store.GLOBAL)[0].content, /The user writes in Turkish/);
  assert.doesNotMatch(webMemory + mem.store.load(mem.store.GLOBAL)[0].content, /hunter2/, 'the secret is not saved');
  const journal = await readFile(join(root, 'dsh-host', 'storages', 'dsh-composer-plus', 'memory', 'journal.jsonl'), 'utf8');
  assert.equal((journal.match(/"actor":"import"/g) ?? []).length, 3, 'the journal has each change');
  // 4. Idempotent: the same facts again (another case and spacing too) add nothing; nothing is overwritten or removed.
  const before = webMemory;
  const second = JSON.parse(await tools.get('memory_import').execute({ facts: [...facts, { text: '  ACME-web uses   PNPM. ', source: join(web, 'CLAUDE.md'), project: web }] }, exec));
  assert.equal(second.added, 0); assert.equal(second.duplicate, 4);
  assert.equal(mem.store.load(mem.store.project(web))[0].content, before, 'nothing changed');
  // A fact that the user saved by hand stays as it is.
  await mem.store.add({ scope: mem.store.project(web), text: 'The user reviews every release.', actor: 'agent' });
  JSON.parse(await tools.get('memory_import').execute({ facts: [{ text: 'The user reviews every release.', source: join(web, 'AGENTS.md'), project: web }] }, exec));
  assert.equal((mem.store.load(mem.store.project(web))[0].content.match(/reviews every release/g) ?? []).length, 1);
  // A file is done only when the subagent says so (review 2026-11-12): saved facts alone leave it open, so a run that
  // stopped half way reads it again. Only a listed file can be marked.
  const open1 = JSON.parse(await tools.get('memory_import_sources').execute({}, exec));
  assert.ok(open1.files.some((f) => f.path === join(web, 'AGENTS.md')) && !open1.alreadyImported, 'saved facts alone do not mark a file');
  assert.equal(JSON.parse(await tools.get('memory_import').execute({ facts: [], done: [join(web, 'AGENTS.md'), join(dshHome, 'AGENTS.md'), join(web, 'CLAUDE.md'), '/etc/passwd'] }, exec)).done, 3);
  await assert.rejects(tools.get('memory_import').execute({ facts: [] }, exec), /facts .* or done/);
  // A file that an import finished and that did not change since is not read again; a changed file is.
  const again = JSON.parse(await tools.get('memory_import_sources').execute({}, exec));
  assert.ok(!again.alreadyImported.includes('/etc/passwd'), 'a path that the scan does not list is not marked');
  assert.ok(again.alreadyImported.includes(join(web, 'AGENTS.md')) && again.alreadyImported.includes(join(dshHome, 'AGENTS.md')), 'imported files are listed as done');
  assert.ok(!again.files.some((f) => f.path === join(web, 'CLAUDE.md')), 'its text is not given again');
  const later = new Date(Date.now() + 2 * 86400000); await utimes(join(web, 'CLAUDE.md'), later, later);
  assert.ok(JSON.parse(await tools.get('memory_import_sources').execute({}, exec)).files.some((f) => f.path === join(web, 'CLAUDE.md')), 'a changed file is read again');
  // All or none: a write that fails at the last fact saves none of the call's facts.
  const globalBefore = mem.store.load(mem.store.GLOBAL)[0].content;
  const apiScope = mem.store.project(api);
  await mkdir(apiScope.dir, { recursive: true }); await chmod(apiScope.dir, 0o500);
  await assert.rejects(tools.get('memory_import').execute({ facts: [{ text: 'A new global fact.', source: join(dshHome, 'AGENTS.md') }, { text: 'acme-api fact.', source: join(web, 'AGENTS.md'), project: api }] }, exec));
  await chmod(apiScope.dir, 0o700);
  assert.equal(mem.store.load(mem.store.GLOBAL)[0].content, globalBefore, 'the global fact went back too');
  // Project memory switched off for the assistant chat: the import saves nothing either.
  const offMem = { ...mem, refusal: async () => 'The project memory is switched off for this chat. Do not use the memory tools here.' };
  const offImp = installMemoryImport({ ...ctx, on: () => {} }, dshHome, assistant, offMem, { check: async () => ({ ready: true }) }, { userHome: home });
  await assert.rejects(offImp.tools[1].execute({ facts: [{ text: 'x', source: join(dshHome, 'AGENTS.md') }] }, exec), /switched off for this chat/);
  // A source path with [ ] or ; (the note's metadata changes them): the scan still finds it as imported.
  const odd = join(root, 'odd [old]; x'); await mkdir(join(odd, '.dsh'), { recursive: true }); await writeFile(join(odd, '.dsh', 'AGENTS.md'), '- Odd path note.\n');
  const oddImp = installMemoryImport({ ...ctx, on: () => {} }, join(odd, '.dsh'), assistant, mem, { check: async () => ({ ready: true }) }, { userHome: odd });
  const oddSrc = join(odd, '.dsh', 'AGENTS.md');
  assert.equal(JSON.parse(await oddImp.tools[1].execute({ facts: [{ text: 'An odd path fact.', source: oddSrc }], done: [oddSrc] }, exec)).added, 1);
  assert.ok(JSON.parse(await oddImp.tools[0].execute({}, exec)).alreadyImported?.includes(oddSrc), 'a path with [ ] ; is found as imported');
  // A failed save does not mark its files as done.
  await chmod(apiScope.dir, 0o500);
  await assert.rejects(tools.get('memory_import').execute({ facts: [{ text: 'acme-api fact two.', source: join(web, 'AGENTS.md'), project: api }], done: [join(api, 'AGENTS.md')] }, exec));
  await chmod(apiScope.dir, 0o700);
  assert.ok(!(JSON.parse(await tools.get('memory_import_sources').execute({}, exec)).alreadyImported ?? []).includes(join(api, 'AGENTS.md')), 'a failed save leaves its files open');
  // The source files did not change.
  assert.equal(await readFile(join(web, 'AGENTS.md'), 'utf8'), '# acme-web\n- Deploys go through make release.\n- password: hunter2hunter2\n');

  // 5. Client: the ready prompt after the setup is ready; editable; sent only on Start.
  const memLs = new Map();
  globalThis.localStorage = { getItem: (k) => (memLs.has(k) ? memLs.get(k) : null), setItem: (k, v) => memLs.set(k, String(v)) };
  globalThis.document = { visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = async (url) => (String(url) === '/api/composer-plus.assistant-switch' ? Response.json({ on: true }) : String(url) === '/api/composer-plus.assistant' ? Response.json({ sessionId: 's-assistant' })
    : String(url) === '/api/composer-plus.assistant-setup' ? Response.json({ ready: true, steps: { obsidian: true, vault: true, memory: 'done', rules: true } }) : new Response('{}', { status: 404 }));
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  const states = []; let stateAt = 0;
  const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useRef: (v) => ({ current: v }), useEffect: (f) => f(), useSyncExternalStore: (_s, g) => g(), useMemo: (f) => f(), useCallback: (f) => f, useLayoutEffect: () => {},
    useState: (v) => { const i = stateAt++; if (states.length <= i) states.push(typeof v === 'function' ? v() : v); return [states[i], (n) => { states[i] = typeof n === 'function' ? n(states[i]) : n; }]; } };
  const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input', Button: 'Button' } : {}));
  const live = new Map(); let n = 0;
  plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, get: () => ({ openSession: () => {} }), locale: { register: () => () => {}, bind: (ns) => (k) => `${ns}:${k}`, resolveText: (x) => x },
    slots: { inject: (_, f) => { const off = f(); return () => off(); }, register: (o, C) => { const k = n++; live.set(k, [o, C]); return () => live.delete(k); } } });
  const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  await tick();
  const [entry, Welcome] = [...live.values()].find(([o]) => o.name === 'conversation.input.dock' && o.id === 'assistant-welcome');
  const injected = entry.inject('x');
  await injected.assistant.open(() => {}); await injected.setup.check();
  const sent = [];
  const props = { ...injected, send: async (id, text) => { sent.push([id, text]); } };
  const t = (k) => (k === 'assistant.import.prompt' ? 'PROMPT TEXT' : k);
  const find = (node, pred, out = []) => { if (node && typeof node === 'object' && !Array.isArray(node)) { if (pred(node)) out.push(node); (node.c ?? []).forEach((c) => find(c, pred, out)); } else if (Array.isArray(node)) node.forEach((c) => find(c, pred, out)); return out; };
  const render = () => { stateAt = 0; const card = Welcome({ sessionId: 's-assistant', useSession: (sel) => sel({ blank: true, promptAttempted: false, running: false }), t, ...props });
    return find(card, (x) => typeof x.t === 'function').map((x) => x.t(x.p))[0]; };
  let block = render();
  const area = find(block, (x) => x.t === 'textarea')[0];
  assert.equal(area.p.value, 'PROMPT TEXT', 'the full prompt shows in the text field');
  assert.deepEqual(sent, [], 'nothing is sent before the click');
  area.p.onChange({ target: { value: 'PROMPT TEXT, but only acme-web' } });
  block = render();
  find(block, (x) => x.t === 'Button')[0].p.onClick(); await tick();
  assert.deepEqual(sent, [['s-assistant', 'PROMPT TEXT, but only acme-web']], 'Start sends the edited text once, to the assistant chat');
  console.log('memory import checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
