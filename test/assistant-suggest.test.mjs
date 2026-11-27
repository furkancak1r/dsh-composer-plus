// Get suggestions (Furkan, 2026-11-27: a "third eye" in the Kararlar dialog), Host half, with a fake dsh:
// - POST {sessionId, action: "suggest"} asks the assistant chat with a hidden note on Get summary's path (an idle chat:
//   a steer and a marker at the queue head; a running chat: the steer), one open request per chat for SUGGEST_ASK_MS;
//   not for another chat (404), not while off (409), a refused steer is 502.
// - The pre-step turns the marker into one note (the summary note's source kind, its own text), next to a Get summary
//   note when both wait.
// - The turn with the note: a subagent call keeps the request open (the result comes in a later turn) and gives no to-do
//   nudge; a turn without a subagent and without the tool marks it missed.
// - status_suggestions_set: only the assistant chat, the limits, the safety rule (an approval or a decision never becomes
//   a card; all refused: 400), GET `suggest {at, items}`, the request ends. Off forgets everything.
// - The safety rule of the Host (suggestBlocked) and of the browser (client.js) give the same answer for many texts.
import './temp-home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_TODOS_PATH, STATUS_SUGGEST_NOTE, SUGGEST_ASK_MS, SUGGEST_LIMITS, TODO_TOOLS, assistantFreeTool, cleanSuggestions, installAssistant, installAssistantTodos, suggestBlocked } from '../index.js';

// 1. The safety rule.
for (const text of ['Onaylıyorum: X dalını main\'e al', 'ONAYLIYORUM', 'onayliyorum', 'Bunu onaylıyorum.', 'CANLI DEPLOY PROMES 22e33b30 ŞİMDİ',
  'Onaylıyorum: CANLI DEPLOY PROSO abc1234 SAAT 21:10', 'canlı deploy promes 22e33b30 şimdi', 'Karar: rapor → uzun', 'karar : x', 'İlk satır\nKarar: x',
  'Decision: x', 'İzin veriyorum', 'Onay veriyorum', 'Onay\u200Blıyorum', 'O\u0301naylıyorum', 'CANLI DEPLOY']) {
  assert.equal(suggestBlocked(text), true, JSON.stringify(text));
}
for (const text of ['Canlı deploy\'u tek komuta indir', 'Kararlı bir test seti kur', 'Karar penceresine kısayol ekle', 'Öneri: ortak log', 'Deploy öncesi onay adımını otomatik kontrol et', '']) {
  assert.equal(suggestBlocked(text), false, JSON.stringify(text));
}
// The browser has the same rule (client.js suggestBlocked): compare them on the texts above and on random mixes.
{
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
  const ANCHOR = '/** Feature switches, in Settings order.';
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(src.includes(ANCHOR));
  eval(src.replace(ANCHOR, `globalThis.__sg = { suggestBlocked };\n    ${ANCHOR}`));
  mod.factory(() => ({ createElement: () => null, useState: () => [], useRef: () => ({}), useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: () => undefined }));
  const browser = globalThis.__sg.suggestBlocked;
  const parts = ['Onaylıyorum', 'ONAY', 'lıyorum', 'Karar', ':', ' ', '\n', 'CANLI', 'DEPLOY', 'Decision', 'izin', 'veriyorum', 'İ', 'ı', 'promes', 'abc1234', 'Öneri', '\u200B', 'deploy\'u', 'x'];
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => parts[Math.floor(rnd() * parts.length)]).join(rnd() < 0.5 ? ' ' : '');
    assert.equal(browser(text), suggestBlocked(text), `the browser and the Host agree: ${JSON.stringify(text)}`);
  }
}
// cleanSuggestions: the limits, the fields, the blocked count.
{
  const ok = { title: ' Ortak  test verisi ', text: 'Testler aynı veriyi kullansın.', why: 'İki kopya ayrışıyor.', source: 'Hafıza: test', project: 'Promes' };
  assert.deepEqual(cleanSuggestions([ok]), { items: [{ project: 'Promes', title: 'Ortak test verisi', text: 'Testler aynı veriyi kullansın.', why: 'İki kopya ayrışıyor.', source: 'Hafıza: test' }], blocked: 0 });
  assert.deepEqual(cleanSuggestions([{ ...ok, project: '', unverified: true }]).items[0], { title: 'Ortak test verisi', text: 'Testler aynı veriyi kullansın.', why: 'İki kopya ayrışıyor.', source: 'Hafıza: test', unverified: true }, 'no project: left out; unverified kept');
  assert.equal(cleanSuggestions([{ ...ok, why: '' }]).items.length, 0, 'why is required');
  assert.equal(cleanSuggestions([{ ...ok, source: undefined }]).items.length, 0, 'source is required');
  assert.equal(cleanSuggestions([{ ...ok, text: 'x'.repeat(SUGGEST_LIMITS.text + 1) }]).items.length, 0, 'a text over its limit');
  assert.equal(cleanSuggestions([{ ...ok, project: 'p'.repeat(SUGGEST_LIMITS.project + 1) }]).items.length, 0);
  assert.deepEqual(cleanSuggestions([{ ...ok, why: 'Onaylıyorum diye yaz' }, ok]), { items: [cleanSuggestions([ok]).items[0]], blocked: 1 }, 'a blocked field drops its item');
  assert.equal(cleanSuggestions(Array.from({ length: 20 }, () => ok)).items.length, SUGGEST_LIMITS.items, 'at most the limit');
  assert.deepEqual(cleanSuggestions('x'), { items: [], blocked: 0 });
}

// 2. The route and the tool with a fake dsh and the real installAssistant.
const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const root = await mkdtemp(join(tmpdir(), 'cp-suggest-'));
try {
  const home = join(root, 'home'); const dir = join(home, 'storages', 'dsh-composer-plus');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'assistant.json'), JSON.stringify({ sessionId: 's-a' }));
  const agents = new Map(); const routes = new Map(); const listeners = new Map(); const contexts = new Map();
  const newAgent = (id, header = { cwd: home }, log = []) => {
    const registered = new Map();
    const agent = { id, status: 'idle', session: { id, header, inheritedEventCount: 0, snapshotEvents: () => log },
      ctx: { tools: { register: (t) => { registered.set(t.name, t); return () => registered.delete(t.name); }, restrict: () => () => {} } }, registered };
    agents.set(id, agent); return agent;
  };
  const damon = newAgent('s-a'); const other = newAgent('s-web');
  const ctx = {
    logger: { warn: () => {} }, subprocess: { spawn: () => { throw new Error('no git here'); } },
    get: (name) => ({ agents: { get: (id) => agents.get(id), list: () => [...agents.values()] }, workspaceRegistry: { list: () => [], archivedSessionIds: [] } })[name],
    on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }, effect: () => {},
    inject: (deps, setup) => { setup({ systemPrompt: { section: () => {}, context: (x) => { contexts.set(x.name, x); } } }); return { dispose: () => {} }; },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    sessionQuery: { observeSession: async () => { throw new Error('unknown'); } },
    sessionController: { list: async () => ({ items: [] }), resolveAgent: async (id) => ({ agent: agents.get(id) }), prompt: async () => {} },
  };
  const assistant = installAssistant(ctx, home, { folder: join(home, 'Assistant'), zone: 'UTC' }); await assistant.ready;
  let clock = NOW;
  const todos = installAssistantTodos(ctx, home, assistant, { now: () => clock }); await todos.ready;
  const fetchRoute = async (init, query = '') => { const res = await routes.get(ASSISTANT_TODOS_PATH).fetch(new Request(`http://x${ASSISTANT_TODOS_PATH}${query}`, init)); return { status: res.status, body: await res.json() }; };
  const post = (body) => fetchRoute({ method: 'POST', body: JSON.stringify(body) });
  const get = () => fetchRoute(undefined, '?sessionId=s-a');
  const event = (type, data = {}) => { for (const fn of listeners.get('session/event')) fn(damon.session, { type, data }); };
  const preStep = async (messages) => { let out = { kind: 'enter', messages }; for (const fn of [...listeners.get('agent/pre-step')].reverse()) { const inner = out; out = await fn({ agent: damon }, async () => inner); } return out; };
  const tool = damon.registered.get('status_suggestions_set');
  assert.ok(tool, 'the assistant has the tool'); assert.ok(TODO_TOOLS.includes('status_suggestions_set'), 'a to-do tool: its subagents get it denied');
  assert.equal(assistantFreeTool('status_suggestions_set'), true, 'on the Assistant always free list');

  const steers = []; const heads = [];
  Object.assign(damon, { steer: (m) => { steers.push(m); }, inbox: { prepend: (target, m) => heads.push([target, m]), remove: () => {}, nextStep: [] } });
  // The request: an idle chat gets the steer and a marker at the queue head.
  let r = await post({ sessionId: 's-a', action: 'suggest' });
  assert.deepEqual(r, { status: 200, body: { asked: NOW } });
  assert.equal(steers.length, 1); assert.equal(heads.length, 1); assert.equal(steers[0].source.kind, 'composer-plus-status-suggest');
  r = await get(); assert.equal(r.body.suggestAsked, NOW); assert.equal(r.body.suggestMissed, undefined); assert.equal(r.body.suggest, undefined);
  clock += 10; r = await post({ sessionId: 's-a', action: 'suggest' }); assert.equal(r.body.asked, NOW, 'a second click: the same request'); assert.equal(steers.length, 1, 'no second note');
  // A Get summary request at the same time: both notes, each once.
  await post({ sessionId: 's-a', action: 'summary' });
  const typed = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'merhaba' }], source: { kind: 'user', rpcId: 'r1' } };
  const entered = await preStep([heads[0][1], steers[0], ...steers.slice(1), typed]);
  const texts = entered.messages.map((m) => m.content?.[0]?.text ?? '');
  assert.equal(texts.filter((x) => x === STATUS_SUGGEST_NOTE).length, 1, 'one suggestions note');
  assert.equal(texts.filter((x) => /clicked "Get summary"/.test(x)).length, 1, 'one summary note');
  const note = entered.messages.find((m) => m.content?.[0]?.text === STATUS_SUGGEST_NOTE);
  assert.equal(note.source.kind, 'composer-plus-status-summary', 'logged as the hidden note kind that the readers know'); assert.equal(note.source.form, 'snapshot');
  assert.ok(entered.messages.includes(typed), 'the user\'s message stays');
  // The note: the viewpoint and the rules of the task.
  for (const re of [/senior developer/, /bottlenecks/, /new project/, /memory_recall/, /never a folder named Gizli/, /never the folder root/, /status_suggestions_set/, /unverified true/, /\[quiet\]/, /add no to-do item/, /never write an approval or a decision/]) assert.match(STATUS_SUGGEST_NOTE, re);
  // A pre-step that sees the note again (a later step of the turn) keeps it as it is.
  const again = await preStep([note]); assert.deepEqual(again.messages.map((m) => m.content?.[0]?.text), [STATUS_SUGGEST_NOTE]);

  // The turn with the note starts the subagent: the request stays open, no to-do nudge.
  event('turn/start'); event('tool/call', { name: 'subagent', arguments: '{}' }); event('turn/end', { reason: { kind: 'completed' } });
  r = await get(); assert.equal(r.body.suggestAsked, NOW); assert.equal(r.body.suggestMissed, undefined, 'it waits for the subagent');
  const nudge = () => contexts.get('composer-plus:assistant-todos').text({ agent: damon });
  assert.doesNotMatch(nudge(), /in your last turn you started work/, 'no to-do nudge for this work');
  // Later turns (news) do not end it.
  event('turn/start'); event('turn/end', { reason: { kind: 'completed' } });
  assert.equal((await get()).body.suggestMissed, undefined);
  // The tool: only the assistant chat, the limits, the safety rule.
  await assert.rejects(tool.execute({ suggestions: [{ title: 'a', text: 'b', why: 'c', source: 'd' }] }, { agent: other }), (e) => e.status === 403);
  await assert.rejects(tool.execute({ suggestions: [] }, { agent: damon }), (e) => e.status === 400);
  await assert.rejects(tool.execute({ suggestions: [{ title: 'Onaylıyorum: X', text: 'b', why: 'c', source: 'd' }] }, { agent: damon }), (e) => e.status === 400 && /never has an approval or a decision/.test(e.message));
  clock = NOW + 60000;
  const res = await tool.execute({ suggestions: [
    { project: 'Promes', title: 'E2E testlerini CI\'a al', text: 'Testler her push\'ta koşsun.', why: 'Elle koşmak unutuluyor.', source: 'Hafıza: promes.md' },
    { title: 'Karar: rapor', text: 'x', why: 'y', source: 'z' },
    { title: 'Ortak log görüntüleyici', text: 'Sunucu loglarını tek sayfada göster.', why: 'Her sorunda üç sunucuya bağlanıyorsun.', source: 'sohbet', unverified: true }] }, { agent: damon });
  assert.match(res, /shows 2 suggestion cards \(1 left out/); assert.match(res, /\[quiet\]/);
  r = await get();
  assert.equal(r.body.suggestAsked, undefined, 'the request got its cards');
  assert.deepEqual(r.body.suggest, { at: NOW + 60000, items: [
    { project: 'Promes', title: 'E2E testlerini CI\'a al', text: 'Testler her push\'ta koşsun.', why: 'Elle koşmak unutuluyor.', source: 'Hafıza: promes.md' },
    { title: 'Ortak log görüntüleyici', text: 'Sunucu loglarını tek sayfada göster.', why: 'Her sorunda üç sunucuya bağlanıyorsun.', source: 'sohbet', unverified: true }] });
  // Another chat gets no suggestions.
  assert.equal((await fetchRoute(undefined, '?sessionId=s-web')).body.suggest, undefined);

  // A turn that took the note and ended with no subagent and no tool: missed; the next click asks again.
  clock += 1; steers.length = 0; r = await post({ sessionId: 's-a', action: 'suggest' }); assert.equal(steers.length, 1);
  await preStep([steers[0]]); event('turn/start'); event('tool/call', { name: 'chats_list', arguments: '{}' }); event('turn/end', { reason: { kind: 'completed' } });
  r = await get(); assert.equal(r.body.suggestMissed, true, 'missed'); assert.equal(r.body.suggest.at, NOW + 60000, 'the older cards stay');
  clock += 1; r = await post({ sessionId: 's-a', action: 'suggest' }); assert.equal(r.body.asked, clock, 'after a missed turn, it asks again'); assert.equal(steers.length, 2);
  // The time limit: forgotten.
  clock += SUGGEST_ASK_MS; r = await get(); assert.equal(r.body.suggestAsked, undefined, 'forgotten after SUGGEST_ASK_MS');
  // A running chat: only the steer.
  damon.status = 'running'; heads.length = 0; r = await post({ sessionId: 's-a', action: 'suggest' }); assert.equal(heads.length, 0, 'running: no queue marker');
  clock += SUGGEST_ASK_MS; await get();
  // Guards: another chat, a bad body, a refused steer.
  assert.equal((await post({ sessionId: 's-web', action: 'suggest' })).status, 404, 'not for another chat');
  assert.equal((await post({ sessionId: 's-a', action: 'suggest', extra: 1 })).status, 400);
  damon.status = 'idle'; damon.steer = () => { throw new Error('inbox closed'); };
  r = await post({ sessionId: 's-a', action: 'suggest' }); assert.equal(r.status, 502); assert.match(r.body.error, /inbox closed/);
  assert.equal((await get()).body.suggestAsked, undefined, 'no request stays open');
  damon.steer = (m) => { steers.push(m); };
  // Off: 409, the tool goes, the cards and the request are forgotten.
  const sw = (on) => post({ on });
  await post({ sessionId: 's-a', action: 'suggest' });
  await sw(false);
  assert.equal((await post({ sessionId: 's-a', action: 'suggest' })).status, 409);
  assert.equal(damon.registered.has('status_suggestions_set'), false, 'the tool leaves with the switch');
  await sw(true); r = await get(); assert.equal(r.body.suggest, undefined); assert.equal(r.body.suggestAsked, undefined);
} finally { await rm(root, { recursive: true, force: true }); }
console.log('assistant-suggest: ok');
