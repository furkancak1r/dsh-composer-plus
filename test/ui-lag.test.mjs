// UI lag (owner, 2026-11-13): a streamed reply changes the chat many times a second.
// (a) The callout and Approve button observers read the whole chat at most once per CHAT_ROWS_MS (250 ms), as the other
//     chat observers do; a quote or a code block that dsh draws in the burst is still marked at once (before the paint).
// (b) The status panel's read (every 5 s while the assistant runs) does not read the unchanged part of the assistant
//     chat's log again; its result stays the same as a full read (a new event, a reloaded log, a fork's offset).
import './temp-home.mjs';
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { statusTasks } from '../index.js';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
globalThis.localStorage = { getItem: () => null, setItem() {} };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__lag = { decorateCallouts, markOnayBlocks };\n    ${ANCHOR}`));
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_s, get) => get(), useLayoutEffect: () => {}, useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f };
mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el) => el } : {}));
const { decorateCallouts, markOnayBlocks } = globalThis.__lag;

// A fake clock: timers, frames and Date.now.
let now = 1000; let nextId = 1; const timers = new Map(); const frames = new Map();
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
globalThis.setTimeout = (fn, ms = 0) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.requestAnimationFrame = (fn) => { const id = nextId++; frames.set(id, fn); return id; };
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
Date.now = () => now;
const frame = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
const advance = (ms) => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
let observe; globalThis.MutationObserver = class { constructor(fn) { observe = fn; } observe() {} disconnect() { observe = undefined; } };

// A small fake DOM: elements with attributes, children and the selectors that the two features use.
const el = (tag, attrs = {}, kids = []) => {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), attrs: { ...attrs }, kids: [], parentElement: null, isConnected: true,
    classList: { contains: (c) => (node.attrs.class ?? '').split(' ').includes(c) },
    get children() { return node.kids.filter((k) => k.nodeType === 1); },
    get firstChild() { return node.kids[0] ?? null; },
    get textContent() { return node.kids.map((k) => (k.nodeType === 3 ? k.nodeValue : k.textContent)).join(''); },
    getAttribute: (n) => node.attrs[n] ?? null, setAttribute: (n, v) => { node.attrs[n] = String(v); }, removeAttribute: (n) => { delete node.attrs[n]; },
    toggleAttribute: (n, on) => { if (on) node.attrs[n] = ''; else delete node.attrs[n]; },
    append: (...k) => { for (const c of k) { c.parentElement = node; node.kids.push(c); } },
    prepend: (c) => { c.parentElement = node; node.kids.unshift(c); },
    all: () => node.kids.filter((k) => k.nodeType === 1).flatMap((k) => [k, ...k.all()]),
    up: (pred) => { for (let at = node; at; at = at.parentElement) if (pred(at)) return at; return null; },
    is: (sel) => {
      if (sel === 'blockquote') return node.tagName === 'BLOCKQUOTE';
      if (sel === '.md-code-block') return node.classList.contains('md-code-block');
      const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (attr) return attr[1] in node.attrs && (attr[2] === undefined || node.attrs[attr[1]] === attr[2]);
      if (sel === '[data-chat-flow-kind="assistant-step"] blockquote') return node.tagName === 'BLOCKQUOTE' && node.parentElement?.closest('[data-chat-flow-kind="assistant-step"]') != null;
      if (sel === '[data-chat-node-key] .md-code-block') return node.classList.contains('md-code-block') && node.parentElement?.closest('[data-chat-node-key]') != null;
      throw new Error(`selector ${sel}`);
    },
    matches: (sel) => node.is(sel), closest: (sel) => node.up((n) => n.is(sel)),
    querySelectorAll: (sel) => { node.scans = (node.scans ?? 0) + 1; return node.all().filter((n) => n.is(sel)); },
    querySelector: (sel) => node.all().find((n) => n.is(sel)) ?? null };
  node.append(...kids);
  return node;
};
const text = (value) => { const t = { nodeType: 3, nodeValue: value, parentElement: null }; return t; };
const changed = (node) => ({ type: 'characterData', target: node, addedNodes: [], removedNodes: [] });
const added = (parent, node) => ({ type: 'childList', target: parent, addedNodes: [node], removedNodes: [] });

// --- (a) Assistant callouts ---
{
  const words = text('[!PROBLEM] The build fails.');
  const step = el('div', { 'data-chat-flow-kind': 'assistant-step' }, [el('blockquote', {}, [el('p', {}, [words])])]);
  const root = el('div', {}, [step]);
  globalThis.document = { createElement: (tag) => el(tag) };
  const off = decorateCallouts(root, { problem: 'Problem', details: 'Details' });
  const scans = () => root.scans;
  assert.equal(root.scans, 1, 'one read of the chat on mount');
  advance(300); // a quiet time after the mount
  const quote = step.kids[0];
  assert.equal(quote.getAttribute('data-cp-callout'), 'problem', 'a box on mount');
  // A streamed reply: 100 text changes in one frame read the chat once (on the next frame), not 100 times.
  for (let i = 0; i < 100; i++) { words.nodeValue = `The build fails${'.'.repeat(i)}`; observe([changed(words)]); }
  frame();
  assert.equal(scans(), 2, `a burst reads the chat once, on the next frame (read ${scans() - 1} times)`);
  // Then at most once per 250 ms while it goes on: 2 s of changes every 20 ms read it at most 2000 / 250 + 1 times.
  for (let t = 0; t < 2000; t += 20) { observe([changed(words)]); frame(); advance(20); }
  advance(250); frame();
  const reads = scans() - 2;
  assert.ok(reads >= 1 && reads <= 9, `at most one read per 250 ms (${reads} reads in 2 s)`);
  // A new answer's quote that dsh draws in the burst: marked in the same callback (no marker shows, no wait).
  const fresh = el('blockquote', {}, [el('p', {}, [text('[!RESULT] Done.')])]);
  const next = el('div', { 'data-chat-flow-kind': 'assistant-step' }, [fresh]);
  root.append(next);
  const before = root.scans;
  observe([added(root, next)]);
  assert.equal(fresh.getAttribute('data-cp-callout'), 'result', 'a new answer\'s box is marked at once');
  assert.equal(fresh.kids[0].kids[0].nodeValue, 'Done.', 'its marker is gone at once');
  assert.equal(root.scans, before, 'without a read of the whole chat');
  // dsh writes the text of a box again (a streamed answer): the marker goes at once too.
  fresh.kids[0].kids[0].nodeValue = '[!RESULT] Done, 3 files.';
  observe([changed(fresh.kids[0].kids[0])]);
  assert.equal(fresh.kids[0].kids[0].nodeValue, 'Done, 3 files.', 'a rewritten text loses its marker at once');
  off();
  assert.equal(quote.getAttribute('data-cp-callout'), null, 'off: the quote is back');
  assert.equal(frames.size + timers.size, 0, 'off: no read stays queued');
}

// --- (a) Approve button: dsh's code blocks of the `onay` sentences ---
{
  const SENTENCE = 'Onaylıyorum: demo dalını push et.';
  const code = (value) => el('div', { class: 'md-code-block' }, [el('div', { 'data-code-block-content': '' }, [text(`${value}\n`)])]);
  const first = code(SENTENCE);
  const row = el('div', { 'data-chat-node-key': 's1' }, [first]);
  const root = el('div', {}, [row]);
  const off = markOnayBlocks(root, [['s1', SENTENCE, 'button'], ['s2', SENTENCE, 'text']]);
  assert.equal(root.scans, 1, 'one read of the chat on mount');
  assert.equal(first.getAttribute('data-composer-plus-onay'), 'button', 'the block of the button sentence');
  advance(300); // a quiet time after the mount
  // dsh draws rows again and again (a streamed reply adds elements): one read on the next frame for the burst.
  for (let i = 0; i < 100; i++) { const p = el('p'); row.append(p); observe([added(row, p)]); }
  frame();
  assert.equal(root.scans, 2, `a burst reads the chat once, on the next frame (read ${root.scans - 1} times)`);
  for (let t = 0; t < 2000; t += 20) { const p = el('p'); row.append(p); observe([added(row, p)]); frame(); advance(20); }
  advance(250); frame();
  const reads = root.scans - 2;
  assert.ok(reads >= 1 && reads <= 9, `at most one read per 250 ms (${reads} reads in 2 s)`);
  // The answer with the sentence that dsh draws: its code block is marked in the same callback, before the paint.
  const block = code(SENTENCE);
  const answer = el('div', { 'data-chat-node-key': 's2' }, [el('div', {}, [block])]);
  root.append(answer);
  const before = root.scans;
  observe([added(root, answer)]);
  assert.equal(block.getAttribute('data-composer-plus-onay'), 'text', 'a new code block is marked at once');
  assert.equal(root.scans, before, 'without a read of the whole chat');
  off();
  assert.deepEqual([first, block].map((b) => b.getAttribute('data-composer-plus-onay')), [null, null], 'off: dsh\'s blocks come back');
  assert.equal(frames.size + timers.size, 0, 'off: no read stays queued');
}
Object.assign(globalThis, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout }); Date.now = real.now;

// --- (b) The status read: only the new part of the assistant chat's log ---
{
  const T = Date.UTC(2026, 10, 13, 9, 0, 0);
  const ev = (seq, type, data) => Object.freeze({ seq, type, data, time: T - 60000 + seq });
  const log = [];
  for (let i = 0; i < 5000; i++) log.push(i % 1000 === 0 ? ev(i, 'subagent/catalog', { childId: `c-${i}`, label: `Task ${i}`, mode: 'one-shot', childCreatedAt: T - 60000 }) : ev(i, 'assistant/message', { message: { content: [] } }));
  const child = [ev(0, 'turn/start', {}), ev(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'Done.' }] } }), ev(2, 'turn/end', { reason: { kind: 'completed' } })];
  let touched = 0;
  // dsh's snapshot: a new frozen array of the same event objects after each append.
  const snapshot = (events) => new Proxy(Object.freeze([...events]), { get: (target, key, receiver) => { if (typeof key === 'string' && /^\d+$/.test(key)) touched += 1; return Reflect.get(target, key, receiver); } });
  const opts = (scan) => ({ logOf: async () => child, since: T - 86400000, now: T, ended: new Map(), ...(scan === undefined ? {} : { scan }) });
  const scan = {};
  const full = await statusTasks(snapshot(log), 0, () => undefined, opts());
  touched = 0;
  assert.deepEqual(await statusTasks(snapshot(log), 0, () => undefined, opts(scan)), full, 'the first read: the same tasks');
  assert.ok(touched >= log.length, 'the first read reads the whole log');
  touched = 0;
  assert.deepEqual(await statusTasks(snapshot(log), 0, () => undefined, opts(scan)), full, 'an unchanged log: the same tasks');
  assert.ok(touched <= 2, `an unchanged log is not read again (${touched} events read)`);
  // A new task: only the new events are read; the result is the same as a full read.
  log.push(ev(5000, 'subagent/catalog', { childId: 'c-new', label: 'New task', mode: 'one-shot', childCreatedAt: T - 1000 }), ev(5001, 'assistant/message', { message: { content: [] } }));
  touched = 0;
  const grown = await statusTasks(snapshot(log), 0, () => undefined, opts(scan));
  assert.ok(touched <= 4, `only the new events are read (${touched})`);
  assert.deepEqual(grown, await statusTasks(snapshot(log), 0, () => undefined, opts()), 'the same tasks as a full read');
  assert.ok(grown.some((t) => t.id === 'c-new'), 'the new task shows');
  // dsh loaded the chat again (new event objects), or a fork's offset changed: a full read again.
  const reloaded = log.map((e) => Object.freeze({ ...e }));
  touched = 0;
  assert.deepEqual(await statusTasks(snapshot(reloaded), 0, () => undefined, opts(scan)), grown, 'a reloaded log: the same tasks');
  assert.ok(touched >= reloaded.length, 'a reloaded log is read again');
  assert.deepEqual(await statusTasks(snapshot(reloaded), 1001, () => undefined, opts(scan)), await statusTasks(snapshot(reloaded), 1001, () => undefined, opts()), 'another offset: the same as a full read');
  assert.deepEqual(await statusTasks(snapshot(reloaded.slice(0, 3000)), 0, () => undefined, opts(scan)), await statusTasks(snapshot(reloaded.slice(0, 3000)), 0, () => undefined, opts()), 'a shorter log: the same as a full read');
}
console.log('ui-lag: ok');
