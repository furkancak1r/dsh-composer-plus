// Shared body observer (watchBody in client.js): the features that watch the sidebar and composer markup share one
// MutationObserver on the page body. A change inside dsh's chat rows ([data-chat-flow]: a streamed reply changes them many
// times a second) runs no subscriber; other changes run each subscriber once per frame; the last unsubscribe stops it.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = src.indexOf('    const bodyWatchers = new WeakMap();');
const end = src.indexOf('    function useRowHosts(');
assert.ok(start > 0 && end > start, 'watchBody is in client.js');
// No feature observes the whole body subtree on its own any more (it was seven observers on every streamed change).
assert.equal(src.match(/\.observe\((document|doc)\.body, \{ childList: true, subtree: true/g)?.length, 1, 'only watchBody observes the body subtree');
const observers = [];
globalThis.MutationObserver = class {
  constructor(fn) { this.fn = fn; this.on = false; observers.push(this); }
  observe(target, opts) { this.target = target; this.opts = opts; this.on = true; }
  disconnect() { this.on = false; }
};
const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
const flush = () => { for (const fn of frames.splice(0)) fn(); };
const { watchBody } = new Function(`${src.slice(start, end)}; return { watchBody };`)();

// A fake page: elements know their [data-chat-flow] ancestor through closest().
const el = (inFlow) => ({ nodeType: 1, closest: (s) => (s === '[data-chat-flow]' && inFlow ? {} : null) });
const text = (parent) => ({ nodeType: 3, parentElement: parent });
const doc = { body: el(false) };
const runs = { a: 0, b: 0, c: 0 };
const offA = watchBody(() => { runs.a += 1; }, doc);
const offB = watchBody(() => { runs.b += 1; }, doc);
const offC = watchBody(() => { runs.c += 1; }, doc);
assert.equal(observers.length, 1, 'one observer for every subscriber');
const [mo] = observers;
assert.equal(mo.target, doc.body); assert.ok(mo.opts.childList && mo.opts.subtree);
assert.deepEqual(mo.opts.attributeFilter, ['aria-expanded', 'aria-labelledby'], 'project open/close and the next question');

// A streamed reply: 200 changes inside the chat rows (elements and text nodes) run nothing.
for (let i = 0; i < 200; i++) mo.fn([{ target: i % 2 ? el(true) : text(el(true)) }]);
assert.equal(frames.length, 0, 'chat row changes queue no frame'); flush();
assert.deepEqual(runs, { a: 0, b: 0, c: 0 }, 'chat row changes run no subscriber');

// Sidebar changes: many in one frame run each subscriber once.
for (let i = 0; i < 50; i++) mo.fn([{ target: el(false) }, { target: el(true) }]);
assert.equal(frames.length, 1, 'one frame for a burst'); flush();
assert.deepEqual(runs, { a: 1, b: 1, c: 1 }, 'each subscriber once per frame');

// Unsubscribe: the others keep running; the last one stops the observer, and a new subscriber makes a new one.
offB(); mo.fn([{ target: el(false) }]); flush();
assert.deepEqual(runs, { a: 2, b: 1, c: 2 });
offA(); offC();
assert.equal(mo.on, false, 'the last unsubscribe stops the observer');
const offD = watchBody(() => {}, doc);
assert.equal(observers.length, 2); assert.equal(observers[1].on, true, 'a new subscriber observes again');
offD();

// Without requestAnimationFrame (unit tests of other features) the subscribers run at once.
delete globalThis.requestAnimationFrame;
let now = 0; const offE = watchBody(() => { now += 1; }, doc);
observers.at(-1).fn([{ target: el(false) }]);
assert.equal(now, 1, 'no frame API: at once'); offE();
console.log('body-watch: ok');
