// Runs the real client.js KeepFocus with fake React/DOM: when dsh finishes a slash command (busy phase -> idle), the
// composer gets the focus back only if the focus fell to the page. A focused field, an open dialog, a new command,
// unmounting or a closed session leave the focus alone.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const frames = new Map(); let frameId = 0;
globalThis.requestAnimationFrame = (f) => { frames.set(++frameId, f); return frameId; };
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
const flush = () => { const due = [...frames.values()]; frames.clear(); for (const f of due) f(); };
const body = { tag: 'body' }; let dialog = null;
globalThis.document = { body, activeElement: body, querySelector: (q) => { assert.equal(q, '[aria-modal="true"], dialog[open]'); return dialog; } };
let refs = [], ri = 0, effects = [];
const React = { useRef: (v) => { const i = ri++; return refs[i] ??= { current: v }; }, useEffect: (f) => { effects.push(f); }, createElement: (t, p) => ({ t, p }) };
const plugin = mod.factory((n) => (n === 'react' ? React : {}));
const regs = []; const scopes = {};
plugin.apply({ sessions: { scope: (id) => scopes[id] }, slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
const [opt, KeepFocus] = regs.find(([o]) => o.id === 'composer-keep-focus');
assert.equal(opt.name, 'conversation.input.right');

// Minimal React: the effect runs on mount and again only when `phase` changes, after the previous cleanup.
let focused = 0;
function mount(state, focusComposer = () => { focused++; }) {
  refs = []; let seen = {}, cleanup;
  const render = () => {
    ri = 0; effects = [];
    assert.equal(KeepFocus({ useInput: (select) => select(state), focusComposer }), null);
    const phase = state?.phase;
    if (phase !== seen) { cleanup?.(); cleanup = effects[0](); seen = phase; }
  };
  render();
  return { set: (phase) => { state = { phase }; render(); }, unmount: () => cleanup?.() };
}
const run = (phases, start = 'plain') => { focused = 0; const c = mount({ phase: start }); for (const p of phases) c.set(p); flush(); return c; };

run(['adjudicating', 'plain']); assert.equal(focused, 1, 'a slash command that dropped the focus gives it back');
run(['adjudicating', 'submitting', 'plain']); assert.equal(focused, 1, 'once, after the claimed command settles');
run(['adjudicating', 'claimed']); assert.equal(focused, 1, 'a claimed command waits for its arguments in the composer');
run(['plain']); assert.equal(focused, 0, 'no command, no focus change');
run([], 'adjudicating'); assert.equal(focused, 0, 'mounted mid-command: nothing to restore yet');
document.activeElement = { tag: 'input' }; run(['adjudicating', 'plain']); assert.equal(focused, 0, 'another field holds the focus');
document.activeElement = null; run(['adjudicating', 'plain']); assert.equal(focused, 1, 'no focused element');
document.activeElement = body; dialog = {}; run(['adjudicating', 'plain']); assert.equal(focused, 0, 'an open dialog keeps the focus'); dialog = null;
focused = 0; let c = mount({ phase: 'plain' }); c.set('adjudicating'); c.set('plain'); c.set('adjudicating'); flush();
assert.equal(focused, 0, 'a new command cancels the pending restore');
c.set('plain'); flush(); assert.equal(focused, 1);
focused = 0; c = mount({ phase: 'plain' }); c.set('adjudicating'); c.set('plain'); c.unmount(); flush(); assert.equal(focused, 0, 'unmounting cancels it');
focused = 0; c = mount(undefined); c.set('adjudicating'); c.set('plain'); flush(); assert.equal(focused, 1, 'from the inert composer too');
c = mount({ phase: 'plain' }, null); c.set('adjudicating'); c.set('plain'); assert.equal(frames.size, 0, 'no focus handler: nothing scheduled');

// The slot focuses the session's own composer through dsh's public input face; a closed session is ignored.
const calls = [];
const actx = { get: (name) => { assert.equal(name, 'conversation'); return { input: { for: (x) => { assert.equal(x, actx); return { focus: () => calls.push('focus') }; } } }; } };
scopes.s1 = actx; opt.inject('s1').focusComposer(); assert.deepEqual(calls, ['focus']);
scopes.bad = { get: () => { throw Error('conversation.input.for requires a retained Session scope'); } };
opt.inject('gone').focusComposer(); opt.inject('bad').focusComposer();
assert.deepEqual(calls, ['focus'], 'closed sessions are ignored');
console.log('keep-focus checks passed');
