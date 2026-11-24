// Side chat (Host and client).
// Host:
// - sideForkSeq: the newest seq at which no queued (next-turn) or steering (next-step) message waits; a message that waits
//   at the end moves the cut back to before it; a removed (sent or discarded) message lets the cut go on; no events → none.
// - POST: bad bodies are 400; a subagent chat, a chat with nothing to copy and a dsh without a read-only mode are 409; the
//   fork is at sideForkSeq, gets the read-only preset, the chat's model and no goal; the first message is the lead and the
//   question (queue); a failed send archives the fork (all or none); one start per chat at a time, other chats go on.
// - GET: a side chat's own messages after the copied part (rule 10), rollback-withdrawn messages left out (both marker kinds,
//   rule 9), the lead taken off, only the last reply of each question (not the agent's notes between tool calls); another
//   chat (no lead, or no parent) is 404.
// Client:
// - sideBackText: questions as `> ` quotes, then the answers; cut at SIDE_BACK_MAX with …
// - sideBlock: plain text only; empty and too long.
// - createSideChats: one start per chat at a time (a second call does nothing), the Bring back text waits once per chat.
// - SideChatButton: a click starts with the trimmed draft, clears it with the span captured at the click, opens the side
//   chat; a failure shows the reason and keeps the draft; the parent's composer takes a waiting Bring back text once, at
//   the caret, after the composer's draft revision is published.
// - SideChatBar: shows only in a side chat; Bring back is off while it runs or before an answer; a click reads again, keeps
//   the text for the parent and opens it; Back to the chat opens the parent.
// - The feature through plugin.apply: on by default, two slots; switched off, both go.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIDE_CHAT_PATH, SIDE_LEAD, SIDE_PARENTS_MAX, SIDE_TEXT_MAX, installSideChat, sideChatOf, sideForkSeq, sideParentsStore, sideTitle } from '../index.js';
const tmpHome = mkdtempSync(join(tmpdir(), 'cp-side-chat-'));
process.on('exit', () => rmSync(tmpHome, { recursive: true, force: true }));

// --- sideTitle ---
assert.equal(sideTitle('  Why is the cart slow?\nmore'), '↳ Why is the cart slow?');
assert.equal([...sideTitle('😀'.repeat(70))].length, 62); assert.ok(sideTitle('x'.repeat(70)).endsWith('…'));
assert.equal(sideTitle('x'.repeat(60)), `↳ ${'x'.repeat(60)}`, '60 is not cut');

// --- sideForkSeq ---
const splice = (seq, target, inserted, removedCount = 0) => ({ seq, type: 'agent/inbox/spliced', data: { target, start: 0, inserted: Array.from({ length: inserted }, (_, i) => ({ id: `m${seq}-${i}` })), removedCount } });
const e = (seq, type = 'assistant/message') => ({ seq, type });
assert.equal(sideForkSeq([]), undefined);
assert.equal(sideForkSeq([e(0, 'session/start'), e(1, 'user/message'), e(2)]), 2, 'nothing waits: the newest seq');
assert.equal(sideForkSeq([e(0), e(1), splice(2, 'next-turn', 1), e(3)]), 1, 'a queued message waits: before it');
assert.equal(sideForkSeq([e(0), splice(1, 'next-step', 1), e(2), splice(3, 'next-step', 0, 1), e(4)]), 4, 'a steer that was taken: on to the end');
assert.equal(sideForkSeq([e(0), splice(1, 'next-turn', 2), splice(2, 'next-turn', 0, 1), e(3), splice(4, 'next-turn', 0, 1), e(5)]), 5, 'two queued, both taken');
assert.equal(sideForkSeq([e(0), splice(1, 'next-turn', 2), splice(2, 'next-turn', 0, 1), e(3)]), 0, 'one of two still waits');
assert.equal(sideForkSeq([e(0), splice(1, 'other', 3), e(2)]), 2, 'another target does not count');
assert.equal(sideForkSeq([e(0), e(1), splice(2, 'next-step', 1), e(3)]), 1, 'a waiting steer: before it');

// --- sideChatOf ---
const msg = (seq, text, kind = 'user', more = {}) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } }, ...more });
const ans = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const parentEvents = [msg(0, 'PARENT task'), ans(1, 'PARENT answer')];
const own = [msg(2, `${SIDE_LEAD}Why is the cart slow?`), ans(3, 'Because of N+1 queries.'), msg(4, 'WITHDRAWN q'), ans(5, 'WITHDRAWN a'),
  { seq: 6, type: 'user/message', data: { content: [], source: { kind: 'composer-plus-rollback' } }, sourceEventSeqs: [4, 5] },
  msg(7, 'REWOUND q'), { seq: 8, type: 'user/message', data: { content: [], source: { kind: 'dsh-rewind' } }, sourceEventSeqs: [7] },
  msg(9, 'And the fix?'), ans(10, 'NOTE I will look.'), { seq: 11, type: 'tool/result', data: {} }, ans(12, 'Batch the loads.')];
assert.deepEqual(sideChatOf({ parentSession: 'P' }, [...parentEvents, ...own], 2), {
  parent: 'P', truncated: false,
  messages: [{ role: 'user', text: 'Why is the cart slow?' }, { role: 'assistant', text: 'Because of N+1 queries.' }, { role: 'user', text: 'And the fix?' }, { role: 'assistant', text: 'Batch the loads.' }],
}, 'own messages, withdrawn ones out, lead off, only the last reply of each question');
assert.equal(sideChatOf({ parentSession: 'P' }, [...parentEvents, msg(2, 'a plain fork')], 2), undefined, 'a fork without the lead');
assert.equal(sideChatOf({}, own, 0), undefined, 'no parent');
// No parent: the answer comes from the header alone; the messages are not read (each chat open and turn asks).
assert.equal(sideChatOf({}, new Proxy([], { get: (t, k) => { if (k === 'filter' || k === Symbol.iterator) throw new Error('read the events'); return t[k]; } }), 0), undefined, 'no parent: the events are not read');
assert.equal(sideChatOf({ parentSession: 'P' }, [msg(0, `${SIDE_LEAD}old`), ...own.slice(1)], 1), undefined, 'the lead in the copied part does not count');
// dsh 0.2.2 and later: a fork's header has no parentSession; the parent that the Host saved counts. A header parent wins.
assert.equal(sideChatOf({}, [...parentEvents, ...own], 2, 'P').parent, 'P', 'dsh 0.2.2: the saved parent');
assert.equal(sideChatOf({ parentSession: 'H' }, [...parentEvents, ...own], 2, 'P').parent, 'H', 'the header parent wins');
assert.equal(sideChatOf({}, [...parentEvents, msg(2, 'a plain fork')], 2, 'P'), undefined, 'a saved parent without the lead');
// The store: newest SIDE_PARENTS_MAX kept, a broken file reads as empty, a reload reads the file.
{
  const file = join(tmpHome, 'store', 'side-chats.json');
  const a1 = sideParentsStore(file); await a1.ready;
  for (let i = 0; i <= SIDE_PARENTS_MAX; i++) await a1.add(`s${i}`, `p${i}`);
  assert.equal(a1.get('s0'), undefined, 'the oldest goes'); assert.equal(a1.get(`s${SIDE_PARENTS_MAX}`), `p${SIDE_PARENTS_MAX}`);
  const a2 = sideParentsStore(file); await a2.ready;
  assert.equal(a2.get('s1'), 'p1', 'read again from the file'); assert.equal(a2.get('s0'), undefined);
  const { writeFileSync } = await import('node:fs'); writeFileSync(file, '[1,2');
  const a3 = sideParentsStore(file); await a3.ready; assert.equal(a3.get('s1'), undefined, 'a broken file reads as empty');
}

// --- The route ---
const routes = new Map();
let observed;
const forks = []; const renames = []; const prompts = []; const presetsSet = []; const models = []; const cleared = []; const archived = [];
let promptGate = () => Promise.resolve(); let names = ['read-only', 'workspace-write']; let goal;
const services = {
  permissionPresets: { get names() { return names; }, set: (session, name) => presetsSet.push([session.id, name]) },
  goals: { get: () => goal, clear: (agent, ref) => cleared.push([agent.id, ref]) },
  workspaceRegistry: { archiveSession: async (id, o) => { archived.push([id, o]); } },
};
installSideChat({
  get: (name) => services[name],
  connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  sessionQuery: { observeSession: async (id) => ({ ...(typeof observed === 'function' ? observed(id) : observed), [Symbol.dispose]() {} }) },
  sessionController: {
    resolveAgent: async (id) => ({ agent: { id, session: { id } } }),
    agents: { selectionFor: (agent) => ({ current: agent.id === 'P' ? { provider: 'chat', model: 'big' } : undefined }) },
    fork: async (o) => { forks.push(o); return { sessionId: `side${forks.length}` }; },
    selectModel: async (o) => { models.push(o); },
    rename: async (o) => { renames.push(o); },
    prompt: async (p, signal) => { await promptGate(p); assert.ok(signal); prompts.push(p); },
  },
}, tmpHome);
const route = routes.get(SIDE_CHAT_PATH);
const post = async (body) => {
  const r = await route.fetch(new Request(`http://h${SIDE_CHAT_PATH}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: r.status, data: await r.json() };
};
const getSide = async (id) => { const r = await route.fetch(new Request(`http://h${SIDE_CHAT_PATH}?sessionId=${id}`)); return { status: r.status, data: await r.json() }; };
observed = { header: { id: 'P' }, events: [e(0, 'session/start'), msg(1, 'Build the cart'), e(2, 'turn/start'), ans(3, 'Working'), splice(4, 'next-turn', 1), e(5)] };
for (const body of ['nope', 'null', '[]', {}, { sessionId: 'P' }, { sessionId: 'P', text: '   ' }, { sessionId: 'P', text: 'x'.repeat(SIDE_TEXT_MAX + 1) }, { sessionId: '', text: 'x' }, { sessionId: 'P', text: 'x', extra: 1 }, { sessionId: 'P', text: 7 }]) {
  assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 60));
}
assert.equal(forks.length, 0, 'nothing for a bad request');
// The fork: the cut before the queued message, read-only, the chat's model, no goal, the lead and the question.
goal = { id: 'g1', revision: 3 };
let r = await post({ sessionId: 'P', text: '  Why is the cart slow?  ' });
assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data, { sessionId: 'side1' });
assert.deepEqual(forks, [{ sessionId: 'P', atSeq: 3 }], 'the cut is before the waiting message');
assert.deepEqual(presetsSet, [['side1', 'read-only']]);
assert.deepEqual(renames, [{ sessionId: 'side1', title: '↳ Why is the cart slow?' }], 'named after the question');
assert.deepEqual(models, [{ sessionId: 'side1', provider: 'chat', model: 'big' }], 'the chat\'s model');
assert.deepEqual(cleared, [['side1', { id: 'g1', revision: 3 }]], 'the copied goal goes');
assert.equal(prompts.length, 1); assert.equal(prompts[0].sessionId, 'side1'); assert.equal(prompts[0].mode, 'queue');
assert.deepEqual(prompts[0].content, [{ type: 'text', text: `${SIDE_LEAD}Why is the cart slow?` }]);
assert.equal(archived.length, 0);
goal = undefined;
// Refusals.
names = ['workspace-write']; assert.equal((await post({ sessionId: 'P', text: 'q' })).status, 409, 'no read-only mode'); names = ['read-only'];
const keep = observed;
observed = { header: { id: 'C', origin: 'subagent' }, events: keep.events }; assert.equal((await post({ sessionId: 'C', text: 'q' })).status, 409, 'a subagent chat');
observed = { header: { id: 'D', delegationDepth: 1 }, events: keep.events }; assert.equal((await post({ sessionId: 'D', text: 'q' })).status, 409, 'a delegated chat');
observed = { header: { id: 'E' }, events: [] }; assert.equal((await post({ sessionId: 'E', text: 'q' })).status, 409, 'nothing to copy');
observed = keep;
assert.equal(forks.length, 1, 'no fork for a refusal');
// All or none: a failed send archives the side chat; the error says so.
promptGate = () => Promise.reject(new Error('queue refused'));
r = await post({ sessionId: 'P', text: 'q' });
assert.equal(r.status, 502); assert.match(r.data.error, /queue refused; the side chat was archived/);
assert.deepEqual(archived, [['side2', { stopActivity: true }]]);
// One start per chat at a time; another chat goes on.
let release; promptGate = (p) => (p.sessionId === 'side3' ? new Promise((res) => { release = res; }) : Promise.resolve());
const slow = post({ sessionId: 'P', text: 'q1' });
await new Promise((res) => setTimeout(res, 10));
assert.equal((await post({ sessionId: 'P', text: 'q2' })).status, 409, 'a second start of the same chat');
observed = (id) => ({ ...keep, header: { id } });
assert.equal((await post({ sessionId: 'Q', text: 'q3' })).status, 200, 'another chat');
release(); assert.equal((await slow).status, 200);
assert.equal((await post({ sessionId: 'P', text: 'q4' })).status, 200, 'free again after the start');
promptGate = () => Promise.resolve();
// GET.
observed = { header: { id: 'side1', parentSession: 'P' }, inheritedEventCount: 2, events: [...parentEvents, ...own] };
r = await getSide('side1');
assert.equal(r.status, 200); assert.equal(r.data.parent, 'P'); assert.equal(r.data.messages.length, 4);
observed = { header: { id: 'P' }, events: parentEvents };
assert.deepEqual(await getSide('P'), { status: 404, data: { error: 'not a side chat', fork: false } }, 'not a side chat: no parent, never one');
observed = { header: { id: 'side9', parentSession: 'P' }, inheritedEventCount: 2, events: parentEvents };
assert.deepEqual(await getSide('side9'), { status: 404, data: { error: 'not a side chat' } }, 'a fork without its question yet: may become one');
// dsh 0.2.2 and later: the fork's header has no parentSession; the Host saved side1's parent when it started it.
observed = { header: { id: 'side1' }, inheritedEventCount: 2, events: [...parentEvents, ...own] };
r = await getSide('side1');
assert.equal(r.status, 200, 'dsh 0.2.2: a side chat by its saved parent'); assert.equal(r.data.parent, 'P');
observed = { header: { id: 'other' }, inheritedEventCount: 2, events: [...parentEvents, ...own] };
assert.deepEqual(await getSide('other'), { status: 404, data: { error: 'not a side chat', fork: false } }, 'dsh 0.2.2: a fork that this Host did not start');
assert.equal(JSON.parse(readFileSync(join(tmpHome, 'storages', 'dsh-composer-plus', 'side-chats.json'), 'utf8')).side1, 'P', 'saved on disk');
assert.equal((await getSide('')).status, 400);

// --- Client ---
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, innerWidth: 1280, addEventListener() {}, removeEventListener() {} };
globalThis.document = { body: {}, addEventListener() {}, removeEventListener() {}, querySelector: () => null };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__s = { sideBackText, sideBlock, createSideChats, SideChatButton, SideChatBar, SIDE_BACK_MAX };\n    ${ANCHOR}`));
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useRef: (v) => { const i = cur.ri++; if (!(i in cur.refs)) cur.refs[i] = { current: v }; return cur.refs[i]; },
  useCallback: (f) => f,
  useSyncExternalStore: (sub, get) => get(),
  useEffect: (f, deps) => {
    const i = cur.ei++; const old = cur.deps[i];
    if (old !== undefined && deps !== undefined && deps.length === old.length && deps.every((d, k) => Object.is(d, old[k]))) return;
    cur.cleanups[i]?.(); cur.deps[i] = deps ?? []; cur.cleanups[i] = f();
  } };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) } : { Button: 'Button' }));
const { sideBackText, sideBlock, createSideChats, SideChatButton, SideChatBar, SIDE_BACK_MAX } = globalThis.__s;
const mount = (C, props) => {
  const inst = { state: [], refs: [], cbs: [], cleanups: [], deps: [] };
  const render = (more = {}) => { Object.assign(props, more); cur = inst; inst.si = 0; inst.ri = 0; inst.ei = 0; return C(props); };
  return { render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const flush = () => new Promise((res) => setTimeout(res, 5));
const find = (tree, pred) => { if (tree === null || typeof tree !== 'object') return undefined; if (pred(tree)) return tree; for (const c of tree.c ?? []) { const f = find(c, pred); if (f) return f; } return undefined; };
const t = (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`);

// sideBackText
assert.equal(sideBackText([{ role: 'user', text: 'Why?\n\nReally' }, { role: 'assistant', text: ' Because. ' }, { role: 'user', text: ' ' }]), '> Why?\n>\n> Really\n\nBecause.');
assert.equal(sideBackText([]), '');
const longBack = sideBackText([{ role: 'assistant', text: '😀'.repeat(SIDE_BACK_MAX + 3) }]);
assert.equal([...longBack].length, SIDE_BACK_MAX); assert.ok(longBack.endsWith('…'));
assert.equal(sideBackText([{ role: 'assistant', text: 'a'.repeat(SIDE_BACK_MAX) }]).length, SIDE_BACK_MAX, 'the limit itself is not cut');
// sideBlock
const plain = (draft, more = {}) => ({ draft, phase: 'plain', occurrences: [], attachmentIds: [], draftRev: 1, ...more });
assert.equal(sideBlock(plain('Why?')), null);
assert.equal(sideBlock(plain('  ')), 'side.empty');
assert.equal(sideBlock(plain('x'.repeat(8001))), 'side.tooLong');
for (const s of [undefined, plain('/plan x'), plain('x', { phase: 'claimed' }), plain('x', { occurrences: [{}] }), plain('x', { attachmentIds: ['a'] })]) assert.equal(sideBlock(s), 'side.unsupported');

// createSideChats: one start per chat; the Bring back text waits once.
{
  const calls = []; let gate;
  const store = createSideChats(async (url, init) => { calls.push([url, init]); await gate?.(); return { ok: true, status: 200, json: async () => ({ sessionId: 'side9' }) }; });
  let wait; gate = () => new Promise((res) => { wait = res; });
  const first = store.start('P', 'q');
  assert.equal(store.starting('P'), true);
  assert.equal(await store.start('P', 'again'), undefined, 'a second start of the same chat does nothing');
  assert.equal(calls.length, 1);
  wait(); assert.equal(await first, 'side9'); assert.equal(store.starting('P'), false);
  assert.deepEqual(JSON.parse(calls[0][1].body), { sessionId: 'P', text: 'q' });
  store.bringBack('P', 'text'); assert.equal(store.pending('P'), 'text');
  assert.equal(store.take('P'), 'text'); assert.equal(store.take('P'), undefined, 'once');
  const failing = createSideChats(async () => ({ ok: false, status: 409, json: async () => ({ error: 'no read-only mode' }) }));
  await assert.rejects(failing.start('P', 'q'), /no read-only mode/); assert.equal(failing.starting('P'), false, 'free after a failure');
  const old = createSideChats(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  await assert.rejects(old.start('P', 'q'), /restart dsh/);
  await assert.rejects(old.info('X'), /restart dsh/, 'an older Host: an error (the bar hides)');
  let asked = 0;
  const notSide = createSideChats(async () => { asked++; return { ok: false, status: 404, json: async () => ({ error: 'not a side chat', fork: false }) }; });
  assert.equal(await notSide.info('X'), null, 'GET 404 from the route: not a side chat');
  assert.equal(await notSide.info('X'), null); assert.equal(asked, 1, 'a chat without a parent is not asked again (its parent never changes)');
  assert.equal(await notSide.info('Y'), null); assert.equal(asked, 2, 'another chat is asked');
  // A fork whose first message is not in its log yet (a side chat that just started), and a chat that is not found: the
  // next open or turn asks again, so the bar shows once the side chat has its question.
  for (const body of [{ error: 'not a side chat' }, { error: 'session not found' }]) {
    let n = 0;
    const later = createSideChats(async () => { n++; return { ok: false, status: 404, json: async () => body }; });
    await later.info('Z'); await later.info('Z'); assert.equal(n, 2, `not remembered: ${body.error}`);
  }
}

// SideChatButton
{
  let input = plain('  Why is it slow?  ', { draftRev: 5 });
  const inserts = []; const opened = []; const notes = []; let accept = true; let span = { start: 3, end: 3, draftRev: 5 };
  const inputActions = { captureInsertion: () => span, insertText: (text, s) => { inserts.push([text, s]); return accept; } };
  let answer = { ok: true, status: 200, json: async () => ({ sessionId: 'side1' }) };
  const sides = createSideChats(async () => answer);
  const props = { sessionId: 'P', useSession: (f) => f({ subagent: null, removed: false }), useInput: (f) => f(input), inputActions, sides, openSession: (id) => opened.push(id), notify: (l, x) => notes.push([l, x]), t };
  const v = mount(SideChatButton, props);
  let out = v.render();
  const btn = () => find(v.render(), (n) => n.p?.['data-composer-plus-side'] === '');
  assert.equal(btn().p.disabled, false);
  assert.equal(btn().p['data-composer-plus-improve'], undefined, 'not the wand\'s attribute');
  const css = find(v.render(), (n) => n.t === 'style').c[0];
  assert.ok(css.includes('[data-composer-plus-side]{') && !css.includes('[data-composer-plus-improve]'), 'its own CSS');
  btn().p.onClick(); await flush();
  assert.deepEqual(inserts, [['', { start: 0, end: input.draft.length, draftRev: 5 }]], 'the draft goes with the span of the click');
  assert.deepEqual(opened, ['side1']);
  // A failure: the reason, the draft stays.
  answer = { ok: false, status: 409, json: async () => ({ error: 'this chat has nothing to copy yet' }) };
  btn().p.onClick(); await flush();
  assert.deepEqual(notes.at(-1), ['error', 'side.failed:{"error":"this chat has nothing to copy yet"}']); assert.equal(inserts.length, 1, 'no clear after a failure');
  // Blocked drafts: disabled, and a click does nothing.
  input = plain('/goal x'); assert.equal(btn().p.disabled, true); btn().p.onClick(); await flush(); assert.equal(opened.length, 1);
  // A subagent chat: no button.
  assert.equal(mount(SideChatButton, { ...props, useSession: (f) => f({ subagent: {}, removed: false }) }).render(), null);
  // The parent's composer takes a Bring back text once, after its draft revision is published.
  input = plain('My note', { draftRev: 7 }); span = { start: 7, end: 7, draftRev: 8 };
  sides.bringBack('P', '> Why?\n\nBecause.');
  v.render(); assert.equal(inserts.length, 1, 'waits for the published revision'); assert.equal(sides.pending('P'), '> Why?\n\nBecause.');
  input = plain('My note', { draftRev: 8 }); v.render();
  assert.deepEqual(inserts.at(-1), ['\n\n> Why?\n\nBecause.\n\n', { start: 7, end: 7, draftRev: 8 }], 'at the caret, after an empty line');
  assert.equal(sides.pending('P'), undefined, 'taken once');
  // A refused insert: the notice.
  accept = false; sides.bringBack('P', 'again'); input = plain('', { draftRev: 9 }); span = { start: 0, end: 0, draftRev: 9 }; v.render();
  assert.deepEqual(inserts.at(-1), ['again\n\n', span]); assert.deepEqual(notes.at(-1), ['info', 'side.changed']);
  // Another chat's composer does not take P's text.
  accept = true; sides.bringBack('P', 'for P'); const other = mount(SideChatButton, { ...props, sessionId: 'Q' }); other.render();
  assert.equal(sides.pending('P'), 'for P', 'Q does not take it');
}

// SideChatBar
{
  let running = false; let info = { parent: 'P', messages: [{ role: 'user', text: 'Why?' }] }; let reads = 0;
  const kept = []; const opened = []; const notes = [];
  const sides = { info: async () => { reads += 1; return info; }, bringBack: (p, x) => kept.push([p, x]) };
  const props = { sessionId: 'side1', useSession: (f) => f({ running }), sides, openSession: (id) => opened.push(id), titleOf: (id) => (id === 'P' ? 'Cart work' : undefined), notify: (l, x) => notes.push([l, x]), t };
  const v = mount(SideChatBar, props);
  assert.equal(v.render(), null, 'nothing before the read'); await flush();
  let out = v.render();
  assert.equal(out.p['data-composer-plus-side-bar'], '');
  assert.ok(find(out, (n) => n === 'side.bar:{"title":"Cart work"}' || n?.c?.includes?.('side.bar:{"title":"Cart work"}')), 'the parent title');
  const back = () => find(v.render(), (n) => n.p?.['data-composer-plus-side-back'] === '');
  assert.equal(back().p.disabled, true, 'no answer yet');
  info = { parent: 'P', messages: [{ role: 'user', text: 'Why?' }, { role: 'assistant', text: 'Because.' }] };
  running = true; v.render(); await flush(); assert.equal(back().p.disabled, true, 'off while it runs');
  running = false; v.render(); await flush(); assert.equal(back().p.disabled, false);
  const readsBefore = reads;
  back().p.onClick(); await flush();
  assert.equal(reads, readsBefore + 1, 'reads again on the click');
  assert.deepEqual(kept, [['P', '> Why?\n\nBecause.']]); assert.deepEqual(opened, ['P']);
  find(v.render(), (n) => n.p?.['data-composer-plus-side-parent'] === '').p.onClick(); assert.deepEqual(opened, ['P', 'P']);
  // Not a side chat: nothing.
  const plainChat = mount(SideChatBar, { ...props, sessionId: 'P', sides: { info: async () => null } }); plainChat.render(); await flush();
  assert.equal(plainChat.render(), null);
  const noParent = mount(SideChatBar, { ...props, sessionId: 'P', sides: { info: async () => ({ messages: [] }) } }); noParent.render(); await flush();
  assert.equal(noParent.render(), null, 'an answer without a parent: nothing');
}

// The feature through plugin.apply: on by default, two slots; off, both go.
{
  const regs = new Set();
  const ctx = {
    effect: (f) => { f(); }, locale: { register: () => () => {}, bind: () => (k) => k }, inject: () => ({ dispose() {} }), configForms: { get: () => ({}) },
    sessions: { scope: () => ({ get: () => ({ input: { for: () => ({ focus() {}, notify() {} }) } }) }), sessionOf: () => undefined, list: { getSnapshot: () => ({ byId: { P: { displayTitle: 'Cart work' } } }) } },
    slots: { inject: (name, f) => f(), register: (o, C) => { const reg = [o, C]; regs.add(reg); return () => { regs.delete(reg); }; } },
    get: () => undefined,
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ on: true }) });
  const rows = () => [...regs].filter(([o]) => o.id === 'side-chat' || o.id === 'side-chat-bar');
  plugin.apply(ctx);
  assert.deepEqual(rows().map(([o, C]) => [o.name, C]).sort(), [['conversation.input.dock', SideChatBar], ['conversation.input.right', SideChatButton]], 'on by default');
  const bar = rows().find(([o]) => o.id === 'side-chat-bar')[0].inject('side1');
  assert.equal(bar.titleOf('P'), 'Cart work'); assert.equal(typeof bar.openSession, 'function');
  const toggles = JSON.parse(mem.get('dsh-composer-plus.features') ?? '{}');
  mem.set('dsh-composer-plus.features', JSON.stringify({ ...toggles, sideChat: false }));
  regs.clear(); plugin.apply(ctx);
  assert.equal(rows().length, 0, 'off: no slot');
}
console.log('side-chat: ok');
