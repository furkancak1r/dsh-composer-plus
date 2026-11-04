// Runs the real client.js "Reject with note" logic with fake React, DOM and dsh services.
// - createRejectNote: the note goes first as a steer, then the request gets `rejected`; one rejection per request at a
//   time from every entry point (rule 7); a failed steer rejects nothing; a failed reject after a sent note does not send
//   the note twice on a retry; an empty note does nothing; the note is cut to REJECT_NOTE_MAX.
// - RejectNote: the button goes into dsh's approval card row (`data-approval-key`), only for an answerable approval of
//   this chat; the field, Enter (Shift+Enter is a new line), Esc, IME, Cancel; the error lines.
// - The feature through plugin.apply: on by default; the steer uses the chat's client session (`prompt(…, 'steer')`);
//   switched off, the slot goes.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__rn = { createRejectNote, RejectNote, REJECT_NOTE_MAX };\n    ${ANCHOR}`));
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {}; globalThis.CSS = { escape: (s) => s };
let row = { id: 'row' };
globalThis.document = { querySelector: (q) => (q.includes('approval:') ? { querySelectorAll: () => [{ parentElement: row }] } : null) };

// Fake React: per-component hook state; an effect runs again when its dependencies change.
let cur;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }),
  useState: (v) => { const i = cur.si++; const s = cur.state; if (!(i in s)) s[i] = v; return [s[i], (x) => { s[i] = typeof x === 'function' ? x(s[i]) : x; }]; },
  useSyncExternalStore: (sub, get) => get(),
  useEffect: (f, deps) => {
    const i = cur.ei++; const old = cur.deps[i];
    if (old !== undefined && deps !== undefined && deps.length === old.length && deps.every((d, k) => Object.is(d, old[k]))) return;
    cur.cleanups[i]?.(); cur.deps[i] = deps ?? []; cur.cleanups[i] = f();
  } };
const mount = (C, props) => {
  const inst = { state: [], cleanups: [], deps: [] };
  const render = (more = {}) => { Object.assign(props, more); cur = inst; inst.si = 0; inst.ei = 0; return C(props); };
  return { render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host, key) => ({ portal: el, host, key }) } : { Button: 'Button' }));
const { createRejectNote, RejectNote, REJECT_NOTE_MAX } = globalThis.__rn;
const flush = () => new Promise((r) => setTimeout(r, 0));
const t = (k, p) => (p === undefined ? k : `${k}:${JSON.stringify(p)}`);
let n = 0;
const ask = (sessionId = 'S', { kind = 'approval' } = {}) => {
  n += 1; const answers = [];
  const a = { kind, key: `approval:${n}`, sessionId, toolName: 'bash', reason: 'needs approval', answers, ok: true, fail: null,
    get answerable() { return this.ok; },
    answer(o) { if (this.fail) { const e = this.fail; this.fail = null; return Promise.reject(e); } if (!this.ok) return Promise.reject(new Error('settled')); this.ok = false; answers.push(o); return Promise.resolve(); } };
  return a;
};

// --- createRejectNote ---
{
  const log = []; let gate; let steerFail = null;
  const store = createRejectNote(async (id, text) => { log.push(['steer', id, text]); if (gate) await gate; if (steerFail) { const e = steerFail; steerFail = null; throw e; } });
  const a = ask();
  // The note first, then the rejection.
  const order = [];
  const real = a.answer.bind(a); a.answer = (o) => { order.push('answer'); return real(o); };
  const store2 = createRejectNote(async () => { order.push('steer'); });
  assert.equal(await store2.reject(a, '  Move it instead.  '), true);
  assert.deepEqual(order, ['steer', 'answer'], 'the note goes before the rejection');
  assert.deepEqual(a.answers, ['rejected']);

  // Rule 7: a second click, Enter or a second caller during a rejection does nothing.
  const b = ask(); let open; gate = new Promise((r) => { open = r; });
  store.open(b.key);
  const first = store.reject(b, 'Use the staging database.');
  assert.equal(store.of(b.key).busy, true);
  assert.equal(await store.reject(b, 'Use the staging database.'), false, 'second click refused while busy');
  assert.equal(await store.reject(b, 'another text'), false, 'second caller refused while busy');
  store.close(b.key); assert.equal(store.of(b.key).busy, true, 'close does nothing while busy');
  open(); assert.equal(await first, true); gate = undefined;
  assert.deepEqual(log.filter((x) => x[1] === 'S').map((x) => x[2]), ['Use the staging database.'], 'one steer');
  assert.deepEqual(b.answers, ['rejected'], 'one rejection');
  assert.equal(store.of(b.key).open, false, 'the state goes after the rejection');

  // A failed steer rejects nothing and keeps the field with the reason.
  const c = ask(); store.open(c.key); steerFail = new Error('busy');
  assert.equal(await store.reject(c, 'Ask me first.'), false);
  assert.deepEqual(c.answers, [], 'no rejection without the note');
  assert.equal(c.answerable, true);
  assert.deepEqual([store.of(c.key).open, store.of(c.key).busy, store.of(c.key).error, store.of(c.key).noteSent], [true, false, 'busy', false]);
  // The retry sends the note and rejects.
  log.length = 0;
  assert.equal(await store.reject(c, 'Ask me first.'), true);
  assert.deepEqual(log.map((x) => x[2]), ['Ask me first.']); assert.deepEqual(c.answers, ['rejected']);

  // A failed reject after a sent note: the reason shows (noteSent), and the retry does not send the note again.
  const d = ask(); store.open(d.key); d.fail = new Error('request withdrawn'); log.length = 0;
  assert.equal(await store.reject(d, 'Not on main.'), false);
  assert.deepEqual([store.of(d.key).noteSent, store.of(d.key).error, store.of(d.key).busy], [true, 'request withdrawn', false]);
  assert.equal(await store.reject(d, 'Not on main.'), true);
  assert.deepEqual(log.map((x) => x[2]), ['Not on main.'], 'the note is sent once over the retry');
  assert.deepEqual(d.answers, ['rejected']);

  // No note: nothing (Enter in an empty field must not reject; dsh's own Reject is there for that). An answered
  // request: nothing.
  const e = ask(); log.length = 0;
  assert.equal(await store.reject(e, '   '), false, 'an empty note does nothing'); assert.deepEqual(log, []); assert.deepEqual(e.answers, []);
  assert.equal(await store.reject(e, 'ok'), true); assert.deepEqual(e.answers, ['rejected']); log.length = 0;
  assert.equal(await store.reject(e, 'late'), false, 'an answered request is refused'); assert.deepEqual(log, []);
  assert.equal(await store.reject(null, 'x'), false);

  // The note is cut to the limit.
  const f = ask(); log.length = 0;
  await store.reject(f, 'x'.repeat(REJECT_NOTE_MAX + 50));
  assert.equal(log[0][2].length, REJECT_NOTE_MAX);

  // Requests are independent; frozen states; listeners.
  let calls = 0; const off = store.subscribe(() => { calls += 1; });
  const g = ask(); const h = ask(); store.open(g.key);
  assert.equal(store.of(h.key).open, false); assert.ok(Object.isFrozen(store.of(g.key)));
  assert.ok(calls >= 1); off(); const before = calls; store.close(g.key); assert.equal(calls, before, 'unsubscribed');
}

// --- RejectNote component ---
{
  const steers = []; const store = createRejectNote(async (id, text) => { steers.push([id, text]); });
  let snap = new Map();
  const useSessionStatus = (sel) => sel(snap);
  const a = ask('S');
  snap = new Map([['S', { pendingInteraction: a }]]);
  const view = mount(RejectNote, { sessionId: 'S', useSessionStatus, store, t });
  view.render();
  let out = view.render();
  assert.equal(out.host, row, 'portaled into the card row');
  assert.equal(out.portal.t, 'Button'); assert.equal(out.portal.c[0], 'rejectNote.button'); assert.equal(out.portal.p.title, 'rejectNote.title');
  assert.equal(out.portal.p.style.order, -1, 'next to Reject, after Allow for this chat');
  out.portal.p.onClick();
  out = view.render();
  const field = out.portal.c.find((x) => x?.t === 'textarea');
  assert.ok(field, 'the field shows'); assert.equal(field.p.autoFocus, true); assert.equal(field.p.maxLength, REJECT_NOTE_MAX);
  assert.equal(out.portal.p['data-composer-plus-reject-note'], '');
  const buttons = () => out.portal.c.at(-1).c;
  assert.equal(buttons()[1].p.disabled, true, 'Reject is off for an empty note');
  field.p.onChange({ currentTarget: { value: 'Do not delete it; move it.' } });
  out = view.render();
  assert.equal(buttons()[1].p.disabled, false);
  const fieldNow = () => out.portal.c.find((x) => x?.t === 'textarea');
  // Shift+Enter and IME do not send; Enter sends once.
  let prevented = 0; const ev = (key, more = {}) => ({ key, shiftKey: false, nativeEvent: {}, keyCode: 0, preventDefault: () => { prevented += 1; }, stopPropagation: () => {}, ...more });
  fieldNow().p.onKeyDown(ev('Enter', { shiftKey: true }));
  fieldNow().p.onKeyDown(ev('Enter', { nativeEvent: { isComposing: true } }));
  fieldNow().p.onKeyDown(ev('Enter', { keyCode: 229 }));
  assert.deepEqual(steers, [], 'no send on Shift+Enter or during IME composition');
  fieldNow().p.onKeyDown(ev('Enter')); fieldNow().p.onKeyDown(ev('Enter'));
  await flush();
  assert.deepEqual(steers, [['S', 'Do not delete it; move it.']], 'Enter sends once');
  assert.deepEqual(a.answers, ['rejected']);
  assert.ok(prevented >= 2, 'Enter does not reach dsh’s card (Allow once)');

  // Esc and Cancel close the field without a rejection.
  const b = ask('S'); snap = new Map([['S', { pendingInteraction: b }]]);
  out = view.render(); out = view.render();
  out.portal.p.onClick(); out = view.render();
  fieldNow().p.onChange({ currentTarget: { value: 'x' } }); out = view.render();
  fieldNow().p.onKeyDown(ev('Escape'));
  out = view.render(); assert.equal(out.portal.t, 'Button', 'Esc closes the field');
  assert.deepEqual(b.answers, [], 'Esc rejects nothing');
  out.portal.p.onClick(); out = view.render();
  buttons()[0].p.onClick(); out = view.render();
  assert.equal(out.portal.t, 'Button', 'Cancel closes the field'); assert.deepEqual(b.answers, []);

  // Error lines: a failed steer, and a failed reject after the note.
  const failing = createRejectNote(async () => { throw new Error('busy'); });
  const c = ask('S'); snap = new Map([['S', { pendingInteraction: c }]]);
  const v2 = mount(RejectNote, { sessionId: 'S', useSessionStatus, store: failing, t });
  v2.render(); out = v2.render(); out.portal.p.onClick(); out = v2.render();
  out.portal.c.find((x) => x?.t === 'textarea').p.onChange({ currentTarget: { value: 'note' } }); out = v2.render();
  out.portal.c.at(-1).c[1].p.onClick(); await flush(); out = v2.render();
  const err = out.portal.c.find((x) => x?.t === 'p');
  assert.equal(err.c[0], 'rejectNote.failed:{"error":"busy"}'); assert.equal(err.p.role, 'alert');
  const ok = createRejectNote(async () => {});
  const d = ask('S'); d.fail = new Error('gone'); snap = new Map([['S', { pendingInteraction: d }]]);
  const v3 = mount(RejectNote, { sessionId: 'S', useSessionStatus, store: ok, t });
  v3.render(); out = v3.render(); out.portal.p.onClick(); out = v3.render();
  out.portal.c.find((x) => x?.t === 'textarea').p.onChange({ currentTarget: { value: 'note' } }); out = v3.render();
  out.portal.c.at(-1).c[1].p.onClick(); await flush(); out = v3.render();
  assert.equal(out.portal.c.find((x) => x?.t === 'p').c[0], 'rejectNote.rejectFailed:{"error":"gone"}');

  // No button: another chat's request, a question, an answered request, no card in the DOM.
  // A request of another chat (a subagent's) in this chat's status: its card may be on screen, the note would go to the
  // wrong chat. The first render finds the host, the second would show the button.
  const other = ask('T'); snap = new Map([['S', { pendingInteraction: other }]]);
  const vo = mount(RejectNote, { sessionId: 'S', useSessionStatus, store, t }); vo.render();
  assert.equal(vo.render(), null, 'another chat');
  snap = new Map([['S', { pendingInteraction: ask('S', { kind: 'question' }) }]]);
  assert.equal(mount(RejectNote, { sessionId: 'S', useSessionStatus, store, t }).render(), null, 'a question');
  const done = ask('S'); done.ok = false; snap = new Map([['S', { pendingInteraction: done }]]);
  assert.equal(mount(RejectNote, { sessionId: 'S', useSessionStatus, store, t }).render(), null, 'answered');
  const saved = globalThis.document; globalThis.document = { querySelector: () => null };
  snap = new Map([['S', { pendingInteraction: ask('S') }]]);
  const v4 = mount(RejectNote, { sessionId: 'S', useSessionStatus, store, t }); v4.render();
  assert.equal(v4.render(), null, 'no card in the DOM'); globalThis.document = saved;

  // The typed note stays when dsh rebuilds the request object with the same key.
  const e = ask('S'); snap = new Map([['S', { pendingInteraction: e }]]);
  const v5 = mount(RejectNote, { sessionId: 'S', useSessionStatus, store, t });
  v5.render(); out = v5.render(); out.portal.p.onClick(); out = v5.render();
  out.portal.c.find((x) => x?.t === 'textarea').p.onChange({ currentTarget: { value: 'kept' } });
  snap = new Map([['S', { pendingInteraction: { ...e, answer: e.answer, get answerable() { return true; } } }]]);
  v5.render(); out = v5.render(); // the effect (if it reran) cleared the note and closed the field: the second render shows it
  assert.equal(out.portal.t, 'div', 'same key: the field stays open');
  assert.equal(out.portal.c.find((x) => x?.t === 'textarea').p.value, 'kept', 'same key: the note stays');
  v5.unmount(); assert.equal(store.of(e.key).open, false, 'unmount closes the field');
}

// --- The feature through plugin.apply ---
{
  const regs = []; const disposed = []; const prompts = [];
  const session = { prompt: async (content, mode) => { prompts.push([content, mode]); return { ok: true, value: { accepted: true } }; } };
  const scopes = { S: { id: 'S' } };
  const ctx = {
    effect: (f) => { f(); }, locale: { register: () => () => {} },
    inject: () => ({ dispose() {} }),
    sessions: { scope: (id) => scopes[id], sessionOf: (scope) => (scope === scopes.S ? session : undefined), list: { getSnapshot: () => ({ byId: {} }) } },
    slots: { inject: (name, f) => f(), register: (o, C) => { const r = [o, C]; regs.push(r); return () => { disposed.push(o.id); regs.splice(regs.indexOf(r), 1); }; } },
    get: () => undefined,
  };
  plugin.apply(ctx);
  const reg = regs.find(([o]) => o.id === 'reject-note');
  assert.ok(reg, 'on by default');
  assert.equal(reg[0].name, 'conversation.session.header.utilities');
  const { store } = reg[0].inject();
  const a = ask('S');
  assert.equal(await store.reject(a, 'Use a branch.'), true);
  assert.deepEqual(prompts, [[[{ type: 'text', text: 'Use a branch.' }], 'steer']], 'the steer goes through the chat’s session');
  // A refused prompt (RemoteResult ok:false) is an error: no rejection.
  session.prompt = async () => ({ ok: false, error: { code: 'session/busy', message: 'not now' } });
  const b = ask('S');
  assert.equal(await store.reject(b, 'x'), false); assert.equal(store.of(b.key).error, 'not now'); assert.deepEqual(b.answers, []);
  const c = ask('X');
  assert.equal(await store.reject(c, 'x'), false); assert.equal(store.of(c.key).error, 'the chat is closed');
  // Switched off: the slot goes.
  const toggles = JSON.parse(mem.get('dsh-composer-plus.features') ?? '{}');
  mem.set('dsh-composer-plus.features', JSON.stringify({ ...toggles, rejectNote: false }));
  regs.length = 0; disposed.length = 0;
  plugin.apply(ctx);
  assert.equal(regs.find(([o]) => o.id === 'reject-note'), undefined, 'off: no slot');
}
console.log('reject-note: ok');
