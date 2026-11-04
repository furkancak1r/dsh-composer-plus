// Secret input (client half): the real client.js with fake React, a fake Host and fake dsh services.
// - createSecrets: GET lists a chat's open asks (an older answer of the same chat does not overwrite a newer one; chats
//   are independent); one answer per ask at a time (rule 7: Save, Enter and Decline all go through `answer`); an empty
//   value sends nothing; the value goes only into the POST body and the store keeps no copy; a load sent before a saved
//   answer does not bring the ask back; a refused or failed answer keeps the ask with the reason.
// - SecretRow: preparing, waiting (it asks the Host again each second until the ask shows, then stops), the card (a
//   password field without autocomplete or spell check, Enter sends once, IME and an empty field send nothing, Decline),
//   the error line, the result lines ("Saved", "Declined", the tool's own result); another call's ask does not show.
// - The feature through plugin.apply: dsh's `tool.call.toolview` row keyed `request_secret` with the session id from
//   dsh's inject; the Host switch (`/api/composer-plus.secrets`) is on by default, and off removes the row.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__sec = { createSecrets, SecretRow };\n    ${ANCHOR}`));
const intervals = new Map(); let iid = 0;
globalThis.setInterval = (f, ms) => { iid += 1; intervals.set(iid, { f, ms }); return iid; };
globalThis.clearInterval = (id) => { intervals.delete(id); };
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const t = (k, p) => (p === undefined ? k : `${k}:${JSON.stringify(p)}`);
const dump = (x) => JSON.stringify(x, (k, v) => (v instanceof Map || v instanceof Set ? [...v] : v));
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

// A fake Host: the open asks per chat, the switch, a gate to hold an answer, a refusal.
const host = { asks: new Map(), gets: [], posts: [], on: true, hold: null, refuse: null };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === '/api/composer-plus.secrets') { if (init?.method === 'POST') host.on = JSON.parse(init.body).on; return reply(200, { on: host.on }); }
  if (u.startsWith('/api/composer-plus.secret-answer')) {
    if (init?.method !== 'POST') { const id = new URL(u, 'http://h').searchParams.get('sessionId'); host.gets.push(id); return reply(200, { on: host.on, asks: host.asks.get(id) ?? [] }); }
    const body = JSON.parse(init.body); host.posts.push(body);
    if (host.hold) await host.hold.promise;
    if (host.refuse) { const r = host.refuse; host.refuse = null; return reply(r.status, { error: r.error }); }
    host.asks.set(body.sessionId, (host.asks.get(body.sessionId) ?? []).filter((a) => a.askId !== body.askId));
    return reply(200, body.decline ? { declined: true } : { saved: true });
  }
  return reply(404, {});
};
const hold = () => { let open; host.hold = { promise: new Promise((r) => { open = r; }) }; return () => { host.hold = null; open(); }; };

// Fake React: per-component hook state; an effect runs again when its dependencies change.
let cur;
const React = { Fragment: 'F', createElement: (ty, p, ...c) => ({ t: ty, p: p ?? {}, c }),
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
  return { inst, render, unmount: () => { for (const c of inst.cleanups) c?.(); } };
};
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el) => el } : { Button: 'Button' }));
const { createSecrets, SecretRow } = globalThis.__sec;
const ev = (key, more = {}) => ({ key, nativeEvent: {}, keyCode: 0, prevented: 0, stopped: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; }, ...more });

// --- createSecrets ---
{
  const pending = [];
  const store = createSecrets((url, init) => new Promise((resolve) => pending.push({ url, init, resolve })));
  const A = { askId: 'a1', callId: 'c1', label: 'GitHub token', purpose: 'Push the release tag.' };
  // GET with the chat's id; an older answer of the same chat does not overwrite a newer one.
  const l1 = store.load('S 1');
  assert.equal(pending[0].url, '/api/composer-plus.secret-answer?sessionId=S%201'); assert.equal(pending[0].init, undefined);
  const l2 = store.load('S 1');
  pending[1].resolve(reply(200, { asks: [A] })); await l2;
  pending[0].resolve(reply(200, { asks: [] })); await l1;
  assert.deepEqual(store.of('S 1').asks, [A], 'an older answer does not overwrite a newer one');
  // Chats are independent: a load of another chat does not drop this chat's answer.
  pending.length = 0;
  const lS = store.load('S'); const lT = store.load('T');
  pending[1].resolve(reply(200, { asks: [] })); await lT;
  pending[0].resolve(reply(200, { asks: [A] })); await lS;
  assert.deepEqual(store.of('S').asks, [A], 'another chat’s load does not drop this one');
  // A failed or refused load keeps what the store has.
  pending.length = 0;
  const lf = store.load('S'); pending[0].resolve(Promise.reject(new Error('offline'))); await lf;
  const lr = store.load('S'); pending[1].resolve(reply(400, { error: 'bad request' })); await lr;
  assert.deepEqual(store.of('S').asks, [A]);

  // Nothing to send: an empty value, no value, no ask.
  pending.length = 0;
  assert.equal(await store.answer('S', A, { value: '' }), false, 'an empty value sends nothing');
  assert.equal(await store.answer('S', A, {}), false); assert.equal(await store.answer('S', undefined, { value: 'x' }), false);
  assert.equal(pending.length, 0);
  // One answer per ask at a time (rule 7): a second Save and a Decline while a Save runs do nothing.
  const p = store.answer('S', A, { value: 'tok-123' });
  assert.equal(store.of('S').busy.has('a1'), true);
  assert.equal(await store.answer('S', A, { value: 'tok-123' }), false, 'a second Save while one runs');
  assert.equal(await store.answer('S', A, { decline: true }), false, 'Decline while a Save runs');
  assert.equal(pending.length, 1, 'one request');
  assert.equal(pending[0].url, '/api/composer-plus.secret-answer'); assert.equal(pending[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(pending[0].init.body), { sessionId: 'S', askId: 'a1', value: 'tok-123' });
  // A load sent before the answer ends does not bring the answered ask back.
  const late = store.load('S');
  pending[0].resolve(reply(200, { saved: true })); assert.equal(await p, true);
  pending[1].resolve(reply(200, { asks: [A] })); await late;
  assert.deepEqual(store.of('S').asks, [], 'a load sent before the answer does not bring the ask back');
  assert.equal(store.of('S').done.get('c1'), 'saved'); assert.equal(store.of('S').busy.size, 0);
  assert.ok(!dump(store.of('S')).includes('tok-123'), 'the store keeps no copy of the value');
  // A later load works again.
  const B = { askId: 'b1', callId: 'c2', label: 'npm token' };
  pending.length = 0;
  const lb = store.load('S'); pending[0].resolve(reply(200, { asks: [B] })); await lb;
  assert.deepEqual(store.of('S').asks, [B]);

  // A refused answer keeps the ask with the Host's reason; HTTP status without a reason; a network failure.
  pending.length = 0;
  const pb = store.answer('S', B, { value: 'x' });
  pending[0].resolve(reply(404, { error: 'no such request' }));
  assert.equal(await pb, false);
  assert.equal(store.of('S').error.get('b1'), 'no such request'); assert.deepEqual(store.of('S').asks, [B], 'a refused answer keeps the ask');
  assert.equal(store.of('S').busy.size, 0);
  const pc = store.answer('S', B, { decline: true, value: 'leak' });
  assert.equal(store.of('S').error.has('b1'), false, 'a new try clears the old reason');
  assert.deepEqual(JSON.parse(pending[1].init.body), { sessionId: 'S', askId: 'b1', decline: true }, 'Decline sends no value');
  pending[1].resolve({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
  assert.equal(await pc, false); assert.equal(store.of('S').error.get('b1'), 'HTTP 500');
  const pd = store.answer('S', B, { decline: true });
  pending[2].resolve(Promise.reject(new Error('offline')));
  assert.equal(await pd, false); assert.equal(store.of('S').error.get('b1'), 'offline');
  const pe = store.answer('S', B, { decline: true });
  pending[3].resolve(reply(200, { declined: true }));
  assert.equal(await pe, true); assert.equal(store.of('S').done.get('c2'), 'declined'); assert.deepEqual(store.of('S').asks, []);
  assert.equal(store.of('S').error.has('b1'), false, 'a closed ask keeps no reason');

  // Frozen states, other chats untouched, listeners.
  assert.ok(Object.isFrozen(store.of('S'))); assert.deepEqual(store.of('T').asks, []); assert.equal(store.of('nobody').asks.length, 0);
  let calls = 0; const off = store.subscribe(() => { calls += 1; });
  pending.length = 0; const lx = store.load('T'); pending[0].resolve(reply(200, { asks: [] })); await lx;
  assert.equal(calls, 1); off();
  const ly = store.load('T'); pending[1].resolve(reply(200, { asks: [] })); await ly;
  assert.equal(calls, 1, 'unsubscribed');
}

// --- SecretRow ---
{
  const store = createSecrets();
  const block = { args: { text: (k) => (k === 'label' ? 'GitHub token' : undefined) }, isError: false }; // dsh 0.2.1: a lazy reader
  const v = mount(SecretRow, { sessionId: 'S', phase: 'preparing', block: { args: { text: () => undefined } }, callId: 'call_1', store, t });
  let out = v.render();
  assert.equal(out.c.at(-1), 'secret.preparing'); assert.equal(out.p['data-tool'], 'request_secret');
  assert.equal(host.gets.length, 0, 'no Host call while dsh prepares the call');
  // The call runs, but the Host does not keep the ask yet: the row waits and asks again each second.
  out = v.render({ phase: 'start', block });
  assert.deepEqual(host.gets, ['S']); assert.equal(intervals.size, 1); assert.equal([...intervals.values()][0].ms, 1000);
  await flush(); out = v.render();
  assert.equal(out.c.at(-1), 'secret.waiting'); assert.equal(out.c[1], 'GitHub token');
  host.asks.set('S', [{ askId: 'k1', callId: 'call_1', label: 'GitHub token', purpose: 'Push the release tag.' }, { askId: 'k9', callId: 'call_9', label: 'Other' }]);
  [...intervals.values()][0].f(); await flush(); out = v.render();
  assert.equal(host.gets.length, 2);
  assert.equal(out.p['data-composer-plus-secret'], 'k1', 'the card of this call');
  assert.equal(intervals.size, 0, 'the ask shows: no more polling');
  const field = () => out.c.find((x) => x?.t === 'input');
  const buttons = () => out.c.at(-1).c; // [Decline, Save]
  assert.equal(field().p.type, 'password'); assert.equal(field().p.autoComplete, 'off'); assert.equal(field().p.spellCheck, false);
  assert.equal(field().p.maxLength, 8192); assert.equal(field().p['aria-label'], 'secret.field:{"label":"GitHub token"}');
  assert.ok(out.c.some((x) => x?.t === 'p' && x.c[0] === 'Push the release tag.'), 'the purpose shows');
  assert.ok(out.c.some((x) => x?.t === 'p' && x.c[0] === 'secret.note'), 'the note says where the value goes');
  assert.equal(buttons()[1].c[0], 'secret.save'); assert.equal(buttons()[0].c[0], 'secret.decline');
  assert.equal(buttons()[1].p.disabled, true, 'Save is off for an empty field');
  // Enter in an empty field and during IME composition sends nothing.
  field().p.onKeyDown(ev('Enter')); await flush(); assert.equal(host.posts.length, 0, 'Enter in an empty field');
  field().p.onChange({ currentTarget: { value: 'ghp_demo' } }); out = v.render();
  assert.equal(buttons()[1].p.disabled, false);
  field().p.onKeyDown(ev('Enter', { nativeEvent: { isComposing: true } })); field().p.onKeyDown(ev('Enter', { keyCode: 229 }));
  await flush(); assert.equal(host.posts.length, 0, 'no send during IME composition');
  // Enter twice, Save and Decline while it saves: one answer (rule 7); the field is read-only and the buttons are off.
  const open = hold();
  const enter = ev('Enter'); field().p.onKeyDown(enter); field().p.onKeyDown(ev('Enter')); buttons()[1].p.onClick(); buttons()[0].p.onClick();
  assert.equal(enter.prevented, 1); assert.equal(enter.stopped, 1, 'Enter does not reach dsh');
  out = v.render();
  assert.equal(field().p.readOnly, true); assert.equal(buttons()[0].p.disabled, true); assert.equal(buttons()[1].p.disabled, true);
  open(); await flush();
  assert.deepEqual(host.posts, [{ sessionId: 'S', askId: 'k1', value: 'ghp_demo' }], 'one answer with the value');
  out = v.render();
  assert.equal(out.c.at(-1), 'secret.saved'); assert.equal(intervals.size, 0, 'a saved ask does not start the polling again');
  assert.ok(!dump(v.inst.state).includes('ghp_demo'), 'the field forgets the value after Save');
  out = v.render({ phase: 'result', block: { ...block, isError: false } });
  assert.equal(out.c.at(-1), 'secret.saved', 'the result keeps "Saved"');

  // Decline.
  host.asks.set('S', [{ askId: 'k2', callId: 'call_2', label: 'npm token' }]); host.posts.length = 0;
  const v2 = mount(SecretRow, { sessionId: 'S', phase: 'start', block: { argsRaw: '{"label":"npm token"}' }, callId: 'call_2', store, t });
  v2.render(); await flush(); out = v2.render();
  assert.equal(out.c.some((x) => x?.t === 'p' && x.p.className === 'cp-sec-p'), false, 'no purpose line without a purpose');
  buttons()[0].p.onClick(); await flush(); out = v2.render();
  assert.deepEqual(host.posts, [{ sessionId: 'S', askId: 'k2', decline: true }]);
  assert.equal(out.c.at(-1), 'secret.declined'); assert.equal(out.c[1], 'npm token', 'the label from dsh 0.2.0 argsRaw');

  // A refused Save: the error line, the field stays.
  host.asks.set('S', [{ askId: 'k3', callId: 'call_3', label: 'Key' }]); host.refuse = { status: 500, error: 'could not save the secret: ENOSPC' };
  const v3 = mount(SecretRow, { sessionId: 'S', phase: 'start', block: { args: { text: () => undefined } }, callId: 'call_3', store, t });
  v3.render(); await flush(); out = v3.render();
  field().p.onChange({ currentTarget: { value: 'x' } }); out = v3.render(); buttons()[1].p.onClick(); await flush(); out = v3.render();
  const err = out.c.find((x) => x?.t === 'p' && x.p.role === 'alert');
  assert.equal(err.c[0], 'secret.error:{"error":"could not save the secret: ENOSPC"}');
  assert.ok(field(), 'the field stays after a refused Save'); assert.equal(field().p.value, 'x', 'the typed value stays for a retry');

  // The tool's own result when this view did not answer (the phone did, or the turn stopped).
  const v4 = mount(SecretRow, { sessionId: 'S', phase: 'result', block: { call: { name: 'request_secret', argsRaw: '{"label":"Token"}' }, isError: false }, callId: 'call_7', store, t });
  assert.equal(v4.render().c.at(-1), 'secret.answered'); assert.equal(v4.render().c[1], 'Token', 'the label from dsh 0.2.0 call.argsRaw');
  assert.equal(v4.render({ block: { call: { name: 'request_secret', argsRaw: '{"label":"Token"}' }, isError: true } }).c.at(-1), 'secret.failed');
  assert.equal(intervals.size, 0, 'no polling for a finished call');
  // Another call's ask does not show; leaving the row or the end of the call stops the polling.
  const v5 = mount(SecretRow, { sessionId: 'S', phase: 'start', block: { args: { text: () => undefined } }, callId: 'call_8', store, t });
  v5.render(); await flush(); out = v5.render();
  assert.equal(out.c.at(-1), 'secret.waiting', 'the ask of call_3 is not this call’s'); assert.equal(intervals.size, 1);
  v5.unmount(); assert.equal(intervals.size, 0, 'unmount stops the polling');
  const v6 = mount(SecretRow, { sessionId: 'S', phase: 'start', block: { args: { text: () => undefined } }, callId: 'call_8', store, t });
  v6.render(); assert.equal(intervals.size, 1);
  v6.render({ phase: 'result' }); assert.equal(intervals.size, 0, 'the end of the call stops the polling');
  // A throwing args reader (dsh's partial arguments) falls back to the Host's label.
  const v7 = mount(SecretRow, { sessionId: 'S', phase: 'start', block: { args: { text: () => { throw new Error('partial'); } } }, callId: 'call_3', store, t });
  out = v7.render(); assert.equal(out.p['data-composer-plus-secret'], 'k3');
  v7.unmount();
}

// --- The feature through plugin.apply ---
{
  const regs = new Set();
  const ctx = {
    effect: (f) => { f(); }, locale: { register: () => () => {}, bind: () => (k) => k }, inject: () => ({ dispose() {} }), configForms: { get: () => ({}) },
    sessions: { scope: () => undefined, sessionOf: () => undefined, list: { getSnapshot: () => ({ byId: {} }) } },
    slots: { inject: (name, f) => f(), register: (o, C) => { const r = [o, C]; regs.add(r); return () => { regs.delete(r); }; } },
    get: () => undefined,
  };
  const row = () => [...regs].find(([o]) => o.name === 'tool.call.toolview' && o.key === 'request_secret');
  host.on = true;
  plugin.apply(ctx); await flush();
  assert.ok(row(), 'on by default');
  assert.equal(row()[1], SecretRow); assert.equal(row()[0].locale, 'dsh-composer-plus');
  const injected = row()[0].inject('S');
  assert.equal(injected.sessionId, 'S', 'the chat id from dsh’s inject'); assert.equal(typeof injected.store.answer, 'function');
  assert.equal(row()[0].inject('T').store, injected.store, 'one store for every row');
  const settings = [...regs].find(([o]) => o.name === 'settings.section')[0].inject();
  assert.equal(settings.secretSwitch.getSnapshot().on, true);
  await settings.setFeature('secretInput', false); await flush();
  assert.equal(host.on, false, 'the Host keeps the switch'); assert.equal(row(), undefined, 'off: no row');
  await settings.setFeature('secretInput', true); await flush();
  assert.ok(row(), 'on again');
  // A Host that says off at start: the row goes when its answer comes.
  host.on = false; regs.clear();
  plugin.apply(ctx); await flush();
  assert.equal(row(), undefined, 'the Host says off');
}
console.log('secret-input-client: ok');
