// Assistant callouts: the real client.js marker parser and style, and the Host's prompt rule and switch.
// - calloutOf: the seven markers, in any case, at the start of a quote's first text; the summary of [!DETAILS]; nothing
//   for an unknown marker, a marker after other text or a marker glued to a word.
// - CALLOUTS_CSS: only marked quotes change, and a closed details section hides all but its button.
// - Host (installAssistantBot): the section only in the assistant chat, on by default; the switch route takes it out and
//   puts it back, keeps the choice in assistant-callouts.json and refuses a bad body.
// - The section names the boxes in the owner's order, keeps the Approve button rule (one `onay` block, outside a box)
//   and has no em dash.
import './temp-home.mjs';
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { ASSISTANT_CALLOUTS_PATH, ASSISTANT_CALLOUTS_SECTION, installAssistantBot } from '../index.js';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
globalThis.localStorage = { getItem: () => null, setItem() {} };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__co = { calloutOf, CALLOUT_KINDS, CALLOUTS_CSS };\n    ${ANCHOR}`));
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_s, get) => get(), useLayoutEffect: () => {}, useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f };
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el) => el } : {}));
const { calloutOf, CALLOUT_KINDS, CALLOUTS_CSS } = globalThis.__co;

// --- calloutOf ---
assert.deepEqual(CALLOUT_KINDS, ['result', 'problem', 'approval', 'questions', 'important', 'running', 'details']);
assert.deepEqual(calloutOf('[!PROBLEM]\nThe test fails.'), { kind: 'problem', title: '', rest: 'The test fails.' });
assert.deepEqual(calloutOf('[!problem] The test fails.'), { kind: 'problem', title: '', rest: 'The test fails.' });
assert.deepEqual(calloutOf('[!Questions]'), { kind: 'questions', title: '', rest: '' });
assert.deepEqual(calloutOf('[!DETAILS] Test output (3 files)\n- a\n- b'), { kind: 'details', title: 'Test output (3 files)', rest: '- a\n- b' });
assert.deepEqual(calloutOf('[!DETAILS]'), { kind: 'details', title: '', rest: '' });
assert.deepEqual(calloutOf('[!details]   Summary  '), { kind: 'details', title: 'Summary', rest: '' });
assert.deepEqual(calloutOf('[!DETAILS]\nOnly a body'), { kind: 'details', title: '', rest: 'Only a body' });
for (const kind of CALLOUT_KINDS) assert.equal(calloutOf(`[!${kind.toUpperCase()}]\nx`)?.kind, kind, kind);
for (const no of ['[!NOTE]\nx', '[!WARNING]', 'Text [!PROBLEM]', ' [!PROBLEM]', '[!PROBLEMS]', '[!PROBLEM]x', '[PROBLEM]', '[!PROB', '', undefined, null]) {
  assert.equal(calloutOf(no), undefined, String(no));
}

// --- CALLOUTS_CSS: only quotes that the feature marked, and its own button ---
for (const rule of CALLOUTS_CSS.split('}').map((r) => r.trim()).filter(Boolean)) assert.match(rule.split('{')[0], /data-cp-|cp-co-toggle/, `only marked quotes: ${rule}`);
assert.ok(CALLOUTS_CSS.includes('blockquote[data-cp-callout="details"][data-cp-open="false"]>:not(.cp-co-toggle){display:none}'), 'a closed section shows only its button');
for (const kind of CALLOUT_KINDS) assert.ok(CALLOUTS_CSS.includes(`[data-cp-callout="${kind}"]`), `a style for ${kind}`);

// --- The prompt section ---
const order = ['[!PROBLEM]', '[!APPROVAL]', '[!QUESTIONS]', '[!IMPORTANT]', '[!RUNNING]'].map((m) => ASSISTANT_CALLOUTS_SECTION.indexOf(m));
assert.ok(order.every((i) => i > 0), 'each box is named');
assert.deepEqual([...order].sort((a, b) => a - b), order, 'the boxes in the owner\'s order');
for (const m of ['[!RESULT]', '[!DETAILS]']) assert.ok(ASSISTANT_CALLOUTS_SECTION.includes(m), m);
assert.match(ASSISTANT_CALLOUTS_SECTION, /Never put an `onay` block inside a box/);
assert.match(ASSISTANT_CALLOUTS_SECTION, /at most one `onay` block per answer/);
assert.match(ASSISTANT_CALLOUTS_SECTION, /\(this is the collapsed details block\)/, 'the Assistant reply form names the same section');
assert.match(ASSISTANT_CALLOUTS_SECTION, /at most 5 list items/);
assert.match(ASSISTANT_CALLOUTS_SECTION, /first line of the answer, outside a box/);
// The owner's box limit (2026-11-12, after GitHub's alerts guidance): few boxes, never two in a row.
assert.ok(ASSISTANT_CALLOUTS_SECTION.includes('Use at most 1 or 2 callouts and 1 details block in each reply.'), 'the box limit');
assert.ok(ASSISTANT_CALLOUTS_SECTION.includes('Do not put callouts directly after one another'), 'no boxes in a row');
assert.equal(ASSISTANT_CALLOUTS_SECTION.match(/^> \[!(?!DETAILS)/gm)?.length, 1, 'the example shows one box, not a row of boxes');
assert.ok(!ASSISTANT_CALLOUTS_SECTION.includes('—'), 'no em dash');
// The examples of the section are boxes for the client's parser.
for (const example of ASSISTANT_CALLOUTS_SECTION.split('\n').filter((l) => /^> \[!/.test(l))) assert.ok(calloutOf(example.slice(2)), example);

// --- Host: the section only in the assistant chat, and its switch ---
const home = await mkdtemp(join(tmpdir(), 'cp-callouts-'));
try {
  const routes = new Map(); const sections = new Map();
  const ctx = {
    on() {}, effect() {}, logger: { warn() {} }, get: () => undefined,
    inject: (_deps, fn) => {
      const mine = [];
      fn({ systemPrompt: { section: (s) => { sections.set(s.name, s); mine.push(s.name); }, context() {} } });
      return { dispose: () => { for (const n of mine) sections.delete(n); } };
    },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); } } },
  };
  const assistant = { ready: Promise.resolve(), isOn: () => true, id: () => 's-assistant', isAssistant: (agent) => agent?.id === 's-assistant' };
  const bot = installAssistantBot(ctx, home, assistant);
  await bot.ready;
  const call = async (method = 'GET', body) => {
    const init = method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) } : undefined;
    const response = await routes.get(ASSISTANT_CALLOUTS_PATH).fetch(new Request(`http://127.0.0.1${ASSISTANT_CALLOUTS_PATH}`, init));
    return { status: response.status, body: await response.json() };
  };
  const text = (id) => sections.get('composer-plus:assistant-callouts')?.text({ agent: { id } }) ?? '';
  assert.deepEqual(await call(), { status: 200, body: { on: true } }, 'on by default');
  assert.equal(text('s-assistant'), ASSISTANT_CALLOUTS_SECTION);
  assert.equal(text('s-other'), '', 'another chat gets no rule');
  assert.equal(sections.get('composer-plus:assistant-callouts').interpolate, false);
  assert.deepEqual(await call('POST', { on: false }), { status: 200, body: { on: false } });
  assert.equal(sections.has('composer-plus:assistant-callouts'), false, 'switched off: no section');
  assert.equal(JSON.parse(await readFile(join(home, 'storages/dsh-composer-plus/assistant-callouts.json'), 'utf8')).on, false, 'the choice is kept');
  for (const bad of [{ on: 'no' }, { on: true, more: 1 }, '{']) assert.equal((await call('POST', bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual(await call(), { status: 200, body: { on: false } }, 'a bad body changes nothing');
  assert.deepEqual(await call('POST', { on: true }), { status: 200, body: { on: true } });
  assert.equal(text('s-assistant'), ASSISTANT_CALLOUTS_SECTION, 'on again: the section is back');
  // A new Host half (a dsh restart) reads the saved choice.
  await call('POST', { on: false });
  const again = new Map();
  const bot2 = installAssistantBot({ ...ctx, connection: { fetch: { register: (route) => { again.set(route.path, route); } } } }, home, assistant);
  await bot2.ready;
  assert.deepEqual(await (await again.get(ASSISTANT_CALLOUTS_PATH).fetch(new Request(`http://127.0.0.1${ASSISTANT_CALLOUTS_PATH}`))).json(), { on: false });
} finally { await rm(home, { recursive: true, force: true }); }
console.log('assistant callouts checks passed');
