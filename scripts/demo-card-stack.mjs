// Damon card stack demo and real-app check: a throwaway dsh (its own DSH_HOME and HOME under the system temp folder, a
// fake model on 127.0.0.1, made-up projects and items), never the user's dsh home, profile or live copy.
// - `node scripts/demo-card-stack.mjs <dsh/lib/bin.js> [port]`: starts the demo dsh on 127.0.0.1 and prints its URL; it
//   runs until you stop it (SIGTERM or Ctrl+C), then it removes its temp folder. No browser opens.
// - `seed(...)` and `startDemo(...)` are also used by test/browser-card-stack.mjs.
// The answer to the approval ends with an option list (the decision queue's choice, phase 2).
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
/** The sample texts: Turkish for the owner's demo, English for the Settings screenshot (AGENTS.md rule 2). All made up. */
const SAMPLES = {
  tr: { seed: 'Örnek verileri yükle', approval: APPROVAL, ready: '**Örnek veriler hazır.** Durum paneli sohbetin sağında.\n\nİki iş onay bekliyor:', approved: "**Onay alındı.** Montaj testi dalı main'e alınıyor (örnek: gerçek bir iş yapılmaz).\n\nServis betiği ne zaman denensin?\n\n**Seçenekler:**\n1. Hemen denensin\n2. Yarın sabah denensin",
    other: 'Tamam. (Bu bir demo modelidir; gerçek bir iş yapmaz.)', done: ["Testler geçti, main'e alındı.", 'Rapor üretildi ve paylaşıldı.'], ran: 'Güncelleme bitti.',
    items: ["Onay: montaj testi dalı main'e alınır", 'Onay: servis betiği test servisinde denenir', 'Sorun: Gece denetimi hata verdi (acme-web)', 'Senden: Test sunucusunda Gerekli Tarih alanını aç',
      'Rapor hizası için karar', 'TR ve ENG raporlarından hangisi örnek alınsın?', 'Fatura şablonunu gözden geçir', 'Kırtasiye siparişini ver', 'Toplantı notlarını oku'],
    tasks: ['Satınalma Gerekli Tarih sorguları', 'Haftalık stok raporu', 'Montaj testi dalı', 'Hava durumu CLI güncellemesi'],
    extra: ['Damon paneli: sade görünüm, simge butonlar, otomasyonlar panelde görünmesin', "Onay: deploy paketi test dalı main'e alınsın (canli degil)"],
    card: `**Montaj testi dalı hazır.** Testler geçti; main'e alınmayı ve servis betiğinin denenmesini bekliyor.\n\nSenden: test sunucusunda Gerekli Tarih alanını aç.\n\n> [!DETAILS] Test çıktısı\n> 412 test geçti, 0 hata.\n\n\`\`\`onay\n${APPROVAL}\n\`\`\`\n\nServis betiği ne zaman denensin?\n\n**Seçenekler:**\n1. Hemen denensin (Önerilen)\n2. Yarın sabah denensin` },
  en: { seed: 'Load the sample data', approval: 'Approve: merge the login-fix branch of acme-web into main and run the build script on the test server.',
    ready: '**Sample data is ready.** The status panel is at the right of the chat.\n\nTwo tasks wait for your approval:', approved: '**Approved.** The login-fix branch goes into main (a demo: nothing real runs).\n\nWhen does the build script run?\n\n**Options:**\n1. Run it now\n2. Run it tomorrow morning',
    other: 'OK. (This is a demo model; it does no real work.)', done: ['Tests pass, merged into main.', 'The report is ready and shared.'], ran: 'The update is done.',
    items: ['Onay: merge the login-fix branch of acme-web', 'Onay: run the build script on the test server', 'Sorun: Nightly check of acme-web failed', 'Senden: Turn on the due-date field on the test server',
      'Choose the report layout', 'Which report is the template: the short or the long one?', 'Review the invoice template', 'Order office supplies', 'Read the meeting notes'],
    tasks: ['Due-date queries of acme-web', 'Weekly stock report', 'Login-fix branch', 'weather-cli update'],
    extra: ['Status panel: a plain look, icon buttons, no automations in the panel', 'Approval: merge the deploy package test branch (not live)'],
    card: '**The login-fix branch is ready.** Tests pass; it waits to go into main.\n\nFor you: turn on the due-date field on the test server.\n\n> [!DETAILS] Test output\n> 412 tests passed, 0 failed.\n\n```onay\nApprove: merge the login-fix branch of acme-web into main and run the build script on the test server.\n```\n\nWhen does the build script run?\n\n**Options:**\n1. Run it now (Recommended)\n2. Run it tomorrow morning' },
};
/** Kararlar demo: decision notes (made up), with the options that Damon gives (the recommended one first). */
export const DECISIONS = [
  ['Karar ver: haftalık stok raporu hangi şablonla gitsin?', ['Kısa şablon (Önerilen)', 'Uzun şablon', 'Bu hafta gönderme']],
  ['Karar ver: acme-web gece yedeği hangi saatte alınsın?', ['02:00 (Önerilen)', '05:00', 'Hafta sonu tek sefer']],
  ['Karar ver: test sunucusundaki eski loglar silinsin mi?', ['30 günden eskiler silinsin (Önerilen)', 'Arşive taşınsın']],
  ['Karar ver: hava durumu CLI sürüm notu Türkçe mi İngilizce mi?', null],
];
/** A long summary (made up) for Get summary: more than the default height of the summary card shows. */
export const SUMMARY = [
  { project: 'acme-web', text: 'Ürün filtresi düzeltmesi bu sabah canlıya alındı. Tasarım dalının review\'ı sürüyor; temiz çıkınca main\'e alınacak, dallar silinecek, sonra canlı deploy için onay istenecek.' },
  { project: 'weather-cli', text: 'Hava durumu CLI güncellemesi testte. Yeni şehir listesi eklendi; eski önbellek dosyaları temizlenecek ve sürüm notu yazılacak.' },
  { project: 'acme-web', text: 'Gece denetimi hatası incelendi: zaman aşımı test sunucusunun yavaşlığından. Süre 60 saniyeye çıkarıldı, yarın sabah yeniden denenecek.' },
];
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
const now = () => Date.now();

/** The fake OpenAI-compatible model. `calls` keeps the newest user text of each chat request. */
export async function fakeModel(calls = [], lang = 'tr') {
  const S = SAMPLES[lang] ?? SAMPLES.tr;
  // `background`: dsh's subagent tool has run_in_background (dsh 0.2.2). Older dsh waits for each subagent in the turn,
  // so a child that keeps running would hold Damon's turn (no answer, no `onay` block): its children end at once there.
  const state = { background: undefined };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"demo"}]}'); return; }
      const parsed = JSON.parse(body); const msgs = parsed.messages ?? [];
      // A subagent child whose prompt starts with "DEMO-FAIL:" gets a provider error (HTTP 400): its task fails.
      if (msgs.some((m) => m.role === 'user' && /^DEMO-FAIL:/.test(textOf(m.content).trim()))) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Provider rejected the request (HTTP 400)', type: 'invalid_request_error' } })); return;
      }
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
      if (/^DEMO-DONE/.test(newest)) return say(newest.includes('DEMO-DONE first') ? S.done[0] : S.done[1]);
      if (/^DEMO-RUN/.test(newest)) {
        if (state.background === false) return say(S.ran);
        const t = setTimeout(() => say('Bitti.'), 6 * 3600 * 1000); req.on('close', () => clearTimeout(t)); return undefined;
      }
      // The Damon chat: "Örnek verileri yükle" adds the items, starts the tasks, then answers with the `onay` block.
      const bg = (parsed.tools ?? []).find((t) => t.function?.name === 'subagent')?.function?.parameters?.properties?.run_in_background !== undefined ? { run_in_background: true } : {};
      // Only the Damon chat's own steps (they have the to-do tools): a side request of another plugin (a memory review, a
      // title) can carry the same message without tools.
      const damonStep = (parsed.tools ?? []).some((t) => t.function?.name === 'todo_list_add');
      // Get summary's hidden note (test/browser-summary-resize.mjs): a long made-up summary, then [quiet].
      const asked = msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content).includes('The user clicked "Get summary"'));
      if (damonStep && asked > own) return msgs.slice(asked).some((m) => m.role === 'tool') ? say('[quiet]') : tools([['status_summary_set', { projects: SUMMARY }]]);
      if (newest.trim() === S.seed && !damonStep) return say('');
      if (newest.trim() === S.seed) {
        const [a1, a2, p1, f1, w1, why, r1, n1, n2] = S.items; const [d1, d2, l1, l2] = S.tasks;
        state.background = bg.run_in_background === true;
        const plan = [
          [['todo_list_add', { text: a1, owner: 'user' }], ['todo_list_add', { text: a2, owner: 'user' }]],
          [['todo_list_add', { text: p1, owner: 'agent' }], ['todo_list_add', { text: f1, owner: 'user' }]],
          [['todo_list_add', { text: w1, owner: 'agent', waiting: why }], ['todo_list_add', { text: r1, owner: 'agent' }]],
          [['todo_list_add', { text: n1, owner: 'user' }], ['todo_list_add', { text: n2, owner: 'user' }]],
          [['subagent', { description: d1, prompt: 'DEMO-DONE first: check the queries.', ...bg }], ['subagent', { description: d2, prompt: 'DEMO-DONE second: weekly stock report.', ...bg }]],
          [['subagent', { description: l1, prompt: 'DEMO-RUN assembly test branch.', ...bg }], ['subagent', { description: l2, prompt: 'DEMO-RUN weather cli update.', ...bg }]],
        ];
        if (step < plan.length * 2) return tools(plan[Math.floor(step / 2)]);
        // A notice after the answer (a later turn): the cards show it.
        if (after.some((m) => m.role === 'assistant' && textOf(m.content).includes('```onay'))) return say('[quiet]');
        return say(`${S.ready}\n\n\`\`\`onay\n${S.approval}\n\`\`\`\n`);
      }
      // test/browser-panel-shots.mjs: "DEMO-EXTRA" adds a long agent item and a not-live Onay item that names a deploy;
      // "DEMO-AUTO-SETUP" makes a one-time scheduled task whose delivery opens a new chat in the Damon chat's folder (an
      // automation chat; its answer is the plain demo reply).
      if (damonStep && newest.trim() === 'DEMO-EXTRA') return step === 0 ? tools(S.extra.map((text, i) => ['todo_list_add', { text, owner: i === 0 ? 'agent' : 'user' }])) : say('[quiet]');
      // Kararlar (test/browser-card-stack.mjs step 10, the screenshots): "DEMO-DECISIONS" adds decision notes of the
      // user, three with options and one without. A message that starts with "Karar:" or "Not tamam:" is the dialog's.
      if (damonStep && newest.trim() === 'DEMO-DECISIONS') return step === 0 ? tools(DECISIONS.map(([text, options]) => ['todo_list_add', { text, owner: 'user', ...(options ? { options } : {}) }])) : say('[quiet]');
      // "DEMO-DECISION-NEW <text>" adds one more decision (the dialog opens by itself for it: browser-card-stack step 11).
      const fresh = damonStep ? /^DEMO-DECISION-NEW (.+)$/.exec(newest.trim()) : null;
      if (fresh !== null) return step === 0 ? tools([['todo_list_add', { text: fresh[1], owner: 'user', options: ['Evet (Önerilen)', 'Hayır'] }]]) : say('[quiet]');
      if (/^(Karar|Not tamam|Decision|Note done):/.test(newest.trim())) return say('[quiet]');
      // Damon reply cards (test/browser-status-canvas.mjs): "DEMO-REPLY-CARD" gets one answer with a bold title, a Senden
      // line, a closed details section, an `onay` block and an option list (one card with Onayla and option buttons).
      if (damonStep && newest.trim() === 'DEMO-REPLY-CARD') return say(S.card);
      if (damonStep && newest.trim() === 'DEMO-AUTO-SETUP') {
        const at = new Date(Date.now() + 8000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        // The answer repeats the `onay` block: a block counts only after your newest message.
        return step === 0 ? tools([['schedule_create', { title: 'Demo automation', prompt: 'DEMO-AUTO run', target: 'new', rrule: `DTSTART:${at}\nRRULE:FREQ=DAILY;COUNT=1` }]]) : say(`${S.ready}\n\n\`\`\`onay\n${S.approval}\n\`\`\`\n`);
      }
      // test/browser-dismiss-task.mjs: "DEMO-FAILED-TASKS" starts two subagents that fail (HTTP 400). The failed card that the
      // user sends ("Görev: <title>" / "Task: <title>" on its first line) starts a replacement and dismisses that card in
      // the same turn (todo_list_remove with task), as the prompt rule asks.
      if (damonStep && newest.trim() === 'DEMO-FAILED-TASKS') {
        return step === 0 ? tools(['Derleme kontrolü', 'Rapor dışa aktarma'].map((d) => ['subagent', { description: d, prompt: `DEMO-FAIL: ${d}`, ...bg }])) : say('[quiet]');
      }
      // A background note (a finished subagent, Assistant news): the cards show it, so the reply is only [quiet].
      if (lastNotice) return say('[quiet]');
      const card = damonStep ? /^(?:Görev|Task): (.+)$/m.exec(newest) : null;
      if (card !== null && step === 0) return tools([['subagent', { description: `${card[1]} (yeniden)`, prompt: 'DEMO-DONE second: retry.', ...bg }], ['todo_list_remove', { task: card[1], reason: 'yedek ajan başlatıldı' }]]);
      if (card !== null) return say('Yeni ajanı başlattım ve hatalı kartı kaldırdım.');
      if (newest.trim() === S.approval) return say(S.approved);
      return say(S.other);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  server.state = state; server.lang = lang;
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

/** Seeds the sample data: makes the Damon chat, sends the seed message of the model's language and waits until the cards'
 * data is there. */
export async function seed(url, { timeoutMs = 90000, model } = {}) {
  const { rpc, get } = await rpcOf(url);
  const start = now();
  let sessionId;
  while (sessionId === undefined) {
    const a = await get('/api/composer-plus.assistant').catch(() => ({}));
    if (typeof a.sessionId === 'string') sessionId = a.sessionId; else if (now() - start > timeoutMs) throw Error(`no Damon chat: ${JSON.stringify(a)}`); else await new Promise((r) => setTimeout(r, 500));
  }
  const text = (SAMPLES[model?.lang] ?? SAMPLES.tr).seed;
  await rpc('session/prompt', { request: { requestId: `seed-${randomUUID()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] } });
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
