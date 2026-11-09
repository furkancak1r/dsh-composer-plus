// Chat row watch (useChatRows in client.js, used by Turn rollback and Copy message link): a streamed reply in a long chat
// changes the rows many times a second, and each run reads every row. Text-only changes run nothing; element changes run
// `onRows` on the next frame and then at most once per CHAT_ROWS_MS; unmount cancels a queued run.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = src.indexOf('    const CHAT_ROWS_MS = ');
const end = src.indexOf('    /** The action row of a chat row');
assert.ok(start > 0 && end > start, 'useChatRows is in client.js');

let now = 1000; const timers = new Map(); let nextId = 1; const frames = new Map();
const clock = { now: () => now };
const setT = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
const clearT = (id) => { timers.delete(id); };
const raf = (fn) => { const id = nextId++; frames.set(id, fn); return id; };
const caf = (id) => { frames.delete(id); };
const advance = (ms) => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
const frame = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
let observer;
class MO { constructor(fn) { this.fn = fn; observer = this; } observe() {} disconnect() { this.off = true; } }
const effects = [];
const React = { useRef: (v) => ({ current: v }), useEffect: (fn) => { effects.push(fn); } };
const document = { querySelector: () => ({}), body: {} };
const { useChatRows, CHAT_ROWS_MS } = new Function('React', 'createPortal', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
  `${src.slice(start, end)}; return { useChatRows, CHAT_ROWS_MS };`)(React, () => {}, document, MO, raf, caf, setT, clearT, () => 0, () => {}, clock);

let runs = 0; let cleaned = 0;
useChatRows('chat-a', () => ({ nodes: new Map() }), () => { runs += 1; }, () => { cleaned += 1; });
const unmount = effects[0]();
assert.equal(runs, 1, 'a run on mount');
const textOnly = [{ addedNodes: [{ nodeType: 3 }], removedNodes: [{ nodeType: 3 }] }];
const element = [{ addedNodes: [{ nodeType: 1 }], removedNodes: [] }];

// A streamed reply that only changes text: nothing runs, nothing is queued.
for (let i = 0; i < 100; i++) observer.fn(textOnly);
advance(1000); frame();
assert.equal(runs, 1, 'text-only changes run nothing');

// Element changes after a quiet time: the next frame, once for a burst.
for (let i = 0; i < 30; i++) observer.fn(element);
frame(); assert.equal(runs, 2, 'one run on the next frame for a burst');
// Element changes right after a run: at most one more run per CHAT_ROWS_MS.
for (let i = 0; i < 30; i++) { observer.fn(element); advance(10); frame(); }
assert.equal(runs, 3, `30 changes in 300 ms: one more run (CHAT_ROWS_MS ${CHAT_ROWS_MS} ms)`);
// Many changes over two seconds at 60 changes a second: about 2000 / CHAT_ROWS_MS runs, not 120.
const before = runs;
for (let i = 0; i < 120; i++) { observer.fn(element); advance(16); frame(); }
assert.ok(runs - before <= Math.ceil(2000 / CHAT_ROWS_MS) + 1 && runs - before >= 4, `throttled: ${runs - before} runs for 120 changes`);

// Unmount: a queued run is cancelled and the caller's cleanup runs.
observer.fn(element);
unmount();
advance(1000); frame();
const after = runs;
assert.equal(observer.off, true); assert.equal(cleaned, 1);
observer.fn(element); advance(1000); frame();
assert.equal(runs, after, 'nothing runs after unmount');
console.log('chat-rows: ok');
