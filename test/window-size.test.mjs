// Runs the real client.js apply() with a fake desktop window: "Remember window size" (windowSize).
// - Only the desktop app page (dsh-app:) is changed; a browser tab is not.
// - A size is saved when two reads 1 s apart agree; a hidden or full-screen window is not saved.
// - At the page start the saved bounds come back (move, size, move); bad stored data is ignored.
// - Switched off: the timer goes. Switched on again later: it saves, but does not move the window.
// The real window move is checked by hand in Electron 44 (the shell of DSH 0.2.2): test/electron-window-size.cjs.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const KEY = 'dsh-composer-plus.windowSize';
const mem = new Map();
const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.localStorage = storage;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ on: true }) });

function makeWindow(protocol) {
  const w = { calls: [], timers: new Map(), next: 1, screenX: 0, screenY: 30, outerWidth: 1280, outerHeight: 820,
    location: { protocol }, localStorage: storage, addEventListener() {}, removeEventListener() {},
    document: { visibilityState: 'visible', documentElement: { dataset: {} }, createElement: () => ({ setAttribute() {}, remove() {} }), head: { append() {} }, addEventListener() {}, removeEventListener() {} },
    moveTo(x, y) { w.calls.push(['moveTo', x, y]); }, resizeTo(a, b) { w.calls.push(['resizeTo', a, b]); },
    setInterval(f, ms) { const id = w.next++; w.timers.set(id, { f, ms }); return id; }, clearInterval(id) { w.timers.delete(id); },
    tick() { for (const t of w.timers.values()) t.f(); } };
  return w;
}
let mod;
function boot(protocol = 'dsh-app:') {
  const win = makeWindow(protocol);
  win.__ModuleLoader__ = { load: (m) => { mod = m; } };
  globalThis.window = win; globalThis.document = win.document;
  eval(src);
  const plugin = mod.factory((n) => (n === 'react' ? { createElement: (t, p, ...c) => ({ t, p, c }) } : {}));
  const effects = []; let settings;
  plugin.apply({ effect: (f) => { effects.push(f()); }, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (n, f) => f(), register: (o) => { if (o.id === 'composer-plus') settings = o; return () => {}; } } });
  return { win, setFeature: settings.inject().setFeature, unload: () => effects.forEach((f) => typeof f === 'function' && f()) };
}
const ownTimers = (win) => [...win.timers.values()].filter((t) => t.ms === 1000 && String(t.f).includes('fullscreen'));

assert.ok(/'headerFit', 'windowSize',/.test(src), 'windowSize is in FEATURES after headerFit');

// A browser tab: nothing moves, nothing is read on a timer.
{ const { win } = boot('http:'); assert.equal(ownTimers(win).length, 0, 'no timer in a browser tab'); assert.deepEqual(win.calls, []); }

// First desktop start: no saved size, so the window is not moved; a new size is saved after two equal reads.
let app = boot();
assert.deepEqual(app.win.calls, [], 'nothing saved: dsh keeps its own size');
assert.equal(ownTimers(app.win).length, 1, 'one 1 s timer');
Object.assign(app.win, { screenX: 182, screenY: 53, outerWidth: 1673, outerHeight: 985 });
app.win.tick(); assert.equal(mem.get(KEY), undefined, 'one read is not enough (a resize can be running)');
app.win.tick(); assert.deepEqual(JSON.parse(mem.get(KEY)), { x: 182, y: 53, w: 1673, h: 985 }, 'two equal reads save the bounds');
// Full screen and hidden windows are not saved.
app.win.document.documentElement.dataset.fullscreen = 'true'; Object.assign(app.win, { screenX: 0, screenY: 0, outerWidth: 1920, outerHeight: 1080 });
app.win.tick(); app.win.tick(); assert.equal(JSON.parse(mem.get(KEY)).w, 1673, 'full screen is not saved');
delete app.win.document.documentElement.dataset.fullscreen; app.win.document.visibilityState = 'hidden';
app.win.tick(); app.win.tick(); assert.equal(JSON.parse(mem.get(KEY)).w, 1673, 'a hidden window is not saved');
app.win.document.visibilityState = 'visible'; Object.assign(app.win, { screenX: 182, screenY: 53, outerWidth: 1673, outerHeight: 985 });
app.win.tick(); app.win.tick();
app.unload(); assert.equal(ownTimers(app.win).length, 0, 'unload removes the timer');

// Next start: the saved bounds come back, move first so the new size stays on the screen.
app = boot();
assert.deepEqual(app.win.calls, [['moveTo', 182, 53], ['resizeTo', 1673, 985], ['moveTo', 182, 53]], 'restored at start');
// Switch off: the timer goes and nothing more is saved. On again: it saves, but does not move the window.
app.setFeature('windowSize', false);
assert.equal(ownTimers(app.win).length, 0, 'off removes the timer');
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { windowSize: false }, 'the off switch is stored in the browser');
app.win.calls.length = 0; app.setFeature('windowSize', true);
assert.equal(ownTimers(app.win).length, 1, 'on again: the timer is back'); assert.deepEqual(app.win.calls, [], 'on again: no move');
app.setFeature('windowSize', false); app.unload();
// Off at start: no move.
app = boot(); assert.deepEqual(app.win.calls, [], 'switched off: the saved size is not used'); app.setFeature('windowSize', true); app.unload();

// Bad stored data is ignored.
for (const bad of ['not json', '{"x":1,"y":2,"w":0,"h":600}', '{"x":"1","y":2,"w":800,"h":600}', 'null']) {
  mem.set(KEY, bad); app = boot(); assert.deepEqual(app.win.calls, [], `ignored: ${bad}`); app.unload();
}
console.log('window size: ok');
