// Damon card stack demo and real-app check: a throwaway dsh (its own DSH_HOME and HOME under the system temp folder, a
// fake model on 127.0.0.1, made-up projects and items), never the user's dsh home, profile or live copy.
// - `node scripts/demo-card-stack.mjs <dsh/lib/bin.js> [port]`: starts the demo dsh on 127.0.0.1 and prints its URL; it
//   runs until you stop it (SIGTERM or Ctrl+C), then it removes its temp folder. No browser opens.
// - `seed(...)` and `startDemo(...)` are also used by test/browser-card-stack.mjs.
// The seed: 2 "Onay:" items and an `onay` block in Damon's last answer (one Onay card with one Approve), 1 Sorun, 2 Senden,
// 3 Sürüyor (2 tasks and 1 item of Damon), 2 Bugün bitti, 2 notes of yours. The tasks are subagents of the Damon chat
// that the fake model starts; their children end or keep running by their prompt words.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
export const APPROVAL = "Onaylıyorum (canlı değil): montaj testi dalı main'e alınsın ve servis betiği test servisinde denensin.";
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const now = () => Date.now();

/** The fake OpenAI-compatible model. `calls` keeps the newest user text of each chat request. */
export async function fakeModel(calls = []) {
  // `background`: dsh's subagent tool has run_in_background (dsh 0.2.2). Older dsh waits for each subagent in the turn,
  // so a child that keeps running would hold Damon's turn (no answer, no `onay` block): its children end at once there.
  const state = { background: undefined };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
      const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`);
      const say = (t) => { send({ role: 'assistant', content: t }); send({}, 'stop'); res.end('data: [DONE]\n\n'); };
      const tools = (list) => { send({ role: 'assistant', tool_calls: list.map(([name, args], index) => ({ index, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }); send({}, 'tool_calls'); res.end('data: [DONE]\n\n'); };
      const all = msgs.map((m) => textOf(m.content)).join('\n');
      if (/session title/i.test(textOf(msgs.at(-1)?.content))) return say('Demo chat');
      if (/You predict the next message|You complete the message that the user is typing|label a coding task|next message that the user will type/.test(all)) return say('');
      // dsh's notice of a finished subagent is a user message that is not yours; it can come into a running turn.
      const NOTICE = /^Background subagent .* (finished|failed|was stopped|ran out|declined|ended)|^\[Composer Plus → Assistant news\]/;
      const isOwn = (m) => m.role === 'user' && !/^<|^Current runtime context|^Time sampled|^\[Composer Plus/.test(textOf(m.content).trim()) && !NOTICE.test(textOf(m.content).trim());
      const own = msgs.findLastIndex(isOwn);
      const newest = textOf(msgs[own]?.content ?? '');
      const after = msgs.slice(own + 1);
      const step = after.filter((m) => m.role === 'tool').length;
      const lastNotice = msgs.at(-1)?.role === 'user' && NOTICE.test(textOf(msgs.at(-1).content).trim());
      calls.push({ newest, step, mine: own === msgs.length - 1 });
      // Subagent children: "DEMO-DONE" ends at once, "DEMO-FAIL" fails, "DEMO-RUN" keeps running (a long wait).
      if (/^DEMO-DONE/.test(newest)) return say(newest.includes('Gerekli Tarih') ? 'Testler geçti, main\'e alındı.' : 'Rapor üretildi ve paylaşıldı.');
      if (/^DEMO-RUN/.test(newest)) {
        if (state.background === false) return say('Güncelleme bitti.');
        const t = setTimeout(() => say('Bitti.'), 6 * 3600 * 1000); req.on('close', () => clearTimeout(t)); return undefined;
      }
      // The Damon chat: "Örnek verileri yükle" adds the items, starts the tasks, then answers with the `onay` block.
      const bg = (parsed.tools ?? []).find((t) => t.function?.name === 'subagent')?.function?.parameters?.properties?.run_in_background !== undefined ? { run_in_background: true } : {};
      // Only the Damon chat's own steps (they have the to-do tools): a side request of another plugin (a memory review, a
      // title) can carry the same message without tools.
      const damonStep = (parsed.tools ?? []).some((t) => t.function?.name === 'todo_list_add');
      if (/^Örnek verileri yükle$/.test(newest.trim()) && !damonStep) return say('');
      if (/^Örnek verileri yükle$/.test(newest.trim())) {
        state.background = bg.run_in_background === true;
        const plan = [
          [['todo_list_add', { text: "Onay: montaj testi dalı main'e alınır", owner: 'user' }], ['todo_list_add', { text: 'Onay: servis betiği test servisinde denenir', owner: 'user' }]],
          [['todo_list_add', { text: 'Sorun: Gece denetimi hata verdi (acme-web)', owner: 'agent' }], ['todo_list_add', { text: "Senden: Test sunucusunda Gerekli Tarih alanını aç", owner: 'user' }]],
          [['todo_list_add', { text: 'Rapor hizası için karar', owner: 'agent', waiting: 'TR ve ENG raporlarından hangisi örnek alınsın?' }], ['todo_list_add', { text: 'Fatura şablonunu gözden geçir', owner: 'agent' }]],
          [['todo_list_add', { text: 'Kırtasiye siparişini ver', owner: 'user' }], ['todo_list_add', { text: 'Toplantı notlarını oku', owner: 'user' }]],
          [['subagent', { description: 'Satınalma Gerekli Tarih sorguları', prompt: 'DEMO-DONE Gerekli Tarih: check the queries.', ...bg }], ['subagent', { description: 'Haftalık stok raporu', prompt: 'DEMO-DONE weekly stock report.', ...bg }]],
          [['subagent', { description: 'Montaj testi dalı', prompt: 'DEMO-RUN assembly test branch.', ...bg }], ['subagent', { description: 'Hava durumu CLI güncellemesi', prompt: 'DEMO-RUN weather cli update.', ...bg }]],
        ];
        if (step < plan.length * 2) return tools(plan[Math.floor(step / 2)]);
        // A notice after the answer (a later turn): the cards show it.
        if (after.some((m) => m.role === 'assistant' && textOf(m.content).includes('```onay'))) return say('[quiet]');
        return say(`**Örnek veriler hazır.** Kartlar sohbetin üstünde.\n\nİki iş onay bekliyor:\n\n\`\`\`onay\n${APPROVAL}\n\`\`\`\n`);
      }
      // A background note (a finished subagent, Assistant news): the cards show it, so the reply is only [quiet].
      if (lastNotice) return say('[quiet]');
      if (newest.trim() === APPROVAL) return say('**Onay alındı.** Montaj testi dalı main\'e alınıyor (örnek: gerçek bir iş yapılmaz).');
      return say('Tamam. (Bu bir demo modelidir; gerçek bir iş yapmaz.)');
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  server.state = state;
  return server;
}

/** A throwaway dsh home with Composer Plus (this repo, linked), the fake model, made-up projects and Damon on. */
export async function demoHome(modelPort) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-card-stack-')));
  const dshHome = join(home, '.dsh'); const profile = join(dshHome, 'profiles/web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'card-stack-demo', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  config:
    providers:
      demo:
        displayName: Demo
        api: openai-completions
        baseURL: http://127.0.0.1:${modelPort}/v1
        apiKeyEnv: DEMO_KEY
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
          - { id: demo, name: Demo model, contextWindow: 100000, maxTokens: 1000, input: [ text ], reasoningEfforts: false }
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: demo, model: demo }
`);
  // Made-up projects (git repositories with one commit each).
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };
  const tables = {}; const ids = [];
  for (const name of ['acme-web', 'weather-cli']) {
    const dir = join(home, 'projects', name); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'README.md'), `# ${name}\n`);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: gitEnv }); execFileSync('git', ['add', '.'], { cwd: dir, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', `Start ${name}`], { cwd: dir, env: gitEnv });
    const wid = randomUUID(); ids.push(wid); const at = new Date().toISOString();
    tables[wid] = { path: dir, title: name, sessionIds: [], createdAt: at, updatedAt: at };
  }
  await mkdir(join(dshHome, 'storages/dsh-composer-plus'), { recursive: true });
  await writeFile(join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ids, archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: ids[0] }, tables: { workspaces: tables } }));
  // Damon (Assistant) on, and its folder in the throwaway HOME (never ~/Assistant or ~/Damon).
  await writeFile(join(dshHome, 'storages/dsh-composer-plus/assistant-switch.json'), JSON.stringify({ on: true }));
  await mkdir(join(home, 'Assistant'), { recursive: true });
  return { home, dshHome };
}

/** Starts the throwaway dsh on 127.0.0.1:`port`; resolves `{ child, url, log }` when its URL is printed. */
export async function startDemo(bin, { home, dshHome }, port) {
  const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', String(port), '--no-open'], { cwd: join(home, 'projects', 'acme-web'),
    env: { ...process.env, HOME: home, DSH_HOME: dshHome, DEMO_KEY: 'demo', npm_config_cache: join(tmpdir(), 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { child, log: '' };
  child.stdout.on('data', (d) => { out.log += d; }); child.stderr.on('data', (d) => { out.log += d; });
  for (let i = 0; i < 240 && !/http:\/\/127\.0\.0\.1:\d+[^\s]*token=[^\s]*/.test(out.log); i++) {
    if (child.exitCode !== null) throw Error(`the demo dsh stopped (${child.exitCode}):\n${out.log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  out.url = /http:\/\/127\.0\.0\.1:\d+[^\s]*token=[^\s]*/.exec(out.log)?.[0];
  if (out.url === undefined) throw Error(`no demo URL:\n${out.log.slice(-2000)}`);
  return out;
}

/** dsh's RPC with the login cookie of `url` (the token link): `rpc(method, args)` answers the value. */
export async function rpcOf(url) {
  const u = new URL(url);
  const login = await fetch(url, { redirect: 'manual' });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).filter((c) => c.startsWith('dsh-auth')).join('; ');
  if (cookie === '') throw Error(`dsh login failed (${login.status})`);
  const get = async (path) => (await fetch(`${u.origin}${path}`, { headers: { cookie } })).json();
  const rpc = async (method, args = {}) => {
    const r = await fetch(`${u.origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: `demo-${randomUUID()}`, method, payload: { args } }) });
    const j = await r.json();
    if (!r.ok || j.result?.ok !== true) throw Error(`${method}: HTTP ${r.status} ${JSON.stringify(j.result?.error ?? j).slice(0, 300)}`);
    return j.result.value;
  };
  return { rpc, get, origin: u.origin, cookie };
}

/** Seeds the sample data: makes the Damon chat, sends "Örnek verileri yükle" and waits until the cards' data is there. */
export async function seed(url, { timeoutMs = 90000, model } = {}) {
  const { rpc, get } = await rpcOf(url);
  const start = now();
  let sessionId;
  while (sessionId === undefined) {
    const a = await get('/api/composer-plus.assistant').catch(() => ({}));
    if (typeof a.sessionId === 'string') sessionId = a.sessionId; else if (now() - start > timeoutMs) throw Error(`no Damon chat: ${JSON.stringify(a)}`); else await new Promise((r) => setTimeout(r, 500));
  }
  await rpc('session/prompt', { request: { requestId: `seed-${randomUUID()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: 'Örnek verileri yükle' }] } });
  for (;;) {
    const s = await get(`/api/composer-plus.assistant-todos?sessionId=${encodeURIComponent(sessionId)}`).catch(() => ({}));
    const done = (s.tasks ?? []).filter((t) => t.state === 'done').length; const running = (s.tasks ?? []).filter((t) => t.state === 'running').length;
    // Without background subagents (dsh before 0.2.2) the two long tasks end at once: 4 done, none running.
    const ready = model?.state?.background === false ? done >= 4 : done >= 2 && running >= 2;
    if ((s.items ?? []).length >= 8 && ready) return { sessionId, status: s, background: model?.state?.background !== false };
    if (now() - start > timeoutMs) throw Error(`the sample data did not come: ${JSON.stringify({ items: s.items?.length, tasks: s.tasks })}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bin = process.argv[2]; const port = Number(process.argv[3] ?? 3290);
  if (!bin) throw Error('usage: node scripts/demo-card-stack.mjs <dsh/lib/bin.js> [port]');
  const model = await fakeModel();
  const where = await demoHome(model.address().port);
  const demo = await startDemo(bin, where, port);
  const stop = async () => { demo.child.kill('SIGTERM'); await new Promise((r) => { if (demo.child.exitCode !== null) r(); else demo.child.once('exit', r); }); model.close(); await rm(where.home, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const { sessionId } = await seed(demo.url, { model });
  console.log(`demo script pid ${process.pid} (SIGTERM stops all and removes the temp home), dsh pid ${demo.child.pid}, model on 127.0.0.1:${model.address().port}, temp home ${where.home}`);
  console.log(`Damon chat ${sessionId}`);
  console.log(`URL ${demo.url}`);
}
