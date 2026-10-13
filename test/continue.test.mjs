// Real client: no draft/prompt writes, visibility, duplicate clicks and request failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let mod;
globalThis.window = { __ModuleLoader__: { load: m => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const row = {};
const send = { tagName: 'BUTTON', className: 'uV2eYG_primary', style: { display: '' }, parentElement: row };
const anchor = { closest: () => ({ querySelectorAll: () => [send] }) };
let state = [], si = 0, layout = [];
const React = {
  useState: v => { const i = si++; if (!(i in state)) state[i] = v; return [state[i], x => { state[i] = x; }]; },
  useRef: v => { const i = si++; return state[i] ??= { current: v }; },
  useLayoutEffect: f => layout.push(f),
  createElement: (t, p, ...c) => { if (p?.ref) p.ref.current = anchor; return { t, p, c }; },
  Fragment: 'F',
};
const plugin = mod.factory(n => n === 'react' ? React : { createPortal: (el, host) => ({ el, host }) });
const regs = [];
plugin.apply({ slots: { inject: (_, f) => f(), register: (o, C) => { regs.push([o, C]); return () => {}; } } });
const [opt, C] = regs.find(([o]) => o.id === 'composer-continue');
assert.equal(opt.name, 'conversation.input.right');
const calls = [], notices = [];
const sess = (o = {}) => sel => sel({ blank: false, running: false, subagent: null, removed: false, ...o });
const inp = (o = {}) => sel => sel({ phase: 'plain', draft: '', attachmentIds: [], ...o });
const win = reason => sel => sel({ entries: [
  { event: { type: 'turn/start', seq: 1 } },
  ...(reason === undefined ? [] : [{ event: { type: 'turn/end', seq: 2, data: { reason: { kind: reason } } } }]),
] });
let props;
const reset = (overrides = {}) => {
  state = []; send.style.display = '';
  props = { useSession: sess(), useInput: inp(), useTurnEnd: win('aborted'),
    resume: async seq => calls.push(seq), notify: (...args) => notices.push(args),
    inputActions: { setDraft: () => assert.fail('must not edit draft'), submit: () => assert.fail('must not send prompt') },
    t: k => ({ 'continue.label': 'Continue', 'continue.failed': 'localized failure' })[k], ...overrides };
};
const render = () => { si = 0; layout = []; return C(props); };
const button = () => render().c[1].el;
reset(); render(); const cleanup = layout[0]();
assert.equal(send.style.display, 'none');
let b = button(); assert.equal(b.p['aria-label'], 'Continue');
await b.p.onClick(); assert.deepEqual(calls, [2]);
cleanup(); assert.equal(send.style.display, '');
for (const [key, value] of Object.entries({ blank: true, running: true, removed: true, subagent: {} })) {
  reset({ useSession: sess({ [key]: value }) }); render(); layout[0](); assert.notEqual(render().t, 'F', key);
}
for (const value of [{ draft: 'typed' }, { attachmentIds: ['image'] }, { phase: 'submitting' }]) {
  reset({ useInput: inp(value) }); render(); layout[0](); assert.notEqual(render().t, 'F');
}
for (const [reason, want] of [['completed', false], ['aborted', true], ['error', true], ['max-tokens', true], [undefined, true]]) {
  reset({ useTurnEnd: win(reason) }); render(); layout[0](); assert.equal(render().t === 'F', want, String(reason));
}
for (const overrides of [
  { useTurnEnd: undefined }, { resume: undefined },
  { useTurnEnd: win('completed'), useSession: sess({ lastAgentError: 'old error', promptError: {} }) },
]) {
  reset(overrides); render(); layout[0](); assert.notEqual(render().t, 'F', 'stale errors must not reopen completed turns');
}
reset({ useInput: inp({ draft: '  ' }) }); render(); layout[0](); assert.equal(render().t, 'F');
let release;
reset({ resume: seq => { calls.push(seq); return new Promise(resolve => { release = resolve; }); } });
render(); layout[0](); b = button(); const pending = b.p.onClick();
await b.p.onClick(); assert.deepEqual(calls, [2, 2], 'double click makes one additional request');
assert.equal(button().p.disabled, true); release(); await pending; assert.equal(button().p.disabled, false);
reset({ resume: async () => { throw new Error('offline'); } }); render(); layout[0]();
await button().p.onClick(); assert.deepEqual(notices, [['error', 'localized failure']]);
assert.equal(button().p.disabled, false, 'failure permits retry');
const requests = [];
globalThis.fetch = async (url, init) => { requests.push([url, init]); return { ok: true }; };
await opt.inject('chat-a').resume(17);
await opt.inject('chat-b').resume(23);
assert.deepEqual(requests.map(([url, init]) => [url, init.method, JSON.parse(init.body)]), [
  ['/api/composer-plus.continue', 'POST', { sessionId: 'chat-a', afterSeq: 17 }],
  ['/api/composer-plus.continue', 'POST', { sessionId: 'chat-b', afterSeq: 23 }],
]);
globalThis.fetch = async () => ({ ok: false });
await assert.rejects(opt.inject('chat-a').resume(17));
const source = { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} };
const wired = [];
plugin.apply({ sessions: { binding: () => ({ eventSource: source }) }, slots: {
  inject: (_, f) => f(), register: (o, C) => { wired.push([o, C]); return () => {}; },
} });
assert.equal(wired.find(([o]) => o.id === 'composer-continue')[0].inject('chat-a').hooks.turnEnd, source);
console.log('message-free continue client checks passed');
