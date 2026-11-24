// Kararlar (Furkan, 2026-11-24): the decision dialog of the Damon status panel (client.js DecisionDialog, decisionQueue,
// isDecision, decisionOption, createOptionPicks' `say`), with a small hook runtime and a fake native <dialog>.
// - A decision is a note with options, or a text that starts with "Karar ver" / "Decide" or has "karar ver:".
// - The dialog opens as a modal (showModal), shows one card: the question, when it was added, "i / N", one button per
//   option (the "(Önerilen)" mark is a tag, not in the text), Atla, Sonra, "Başka bir cevap" + Gönder.
// - One click sends "Karar: <item> → <option>" (the Turkish pack) on Option picks' send path and shows the next card at
//   once; the item stays (the client removes nothing); a failed send brings the card back with the reason.
// - Keys (after 0.8 s): 1–9 pick, → skips; not in the text field; an option that names a live system only by click.
// - No options: no option button, "Damon seçenek eklemedi", Atla/Sonra/the field still work.
// - After the decisions: the other notes with Yaptım ("Not tamam: <item>") and Atla; at the end "Hepsi bitti" + Kapat.
// - Esc (the dialog's cancel event), × and a click on the backdrop close it (the pointer down and up on it, not a text
//   selection that ends outside); the dialog's keys do not leave it.
// - Sil (Damon, 2026-11-24): removes a note at once through the panel's remove; a failure brings it back.
// - An answered or removed note stays hidden for 60 s (DECIDE_HIDE_MS); still on the list after that, it shows again.
// - The focus stays in the dialog when a note row goes; Sonra has the 0.4 s click guard too; a send waits while another
//   send of the chat (Onayla, an option button) runs, and a failed send keeps its reason in the panel's state.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
const src = read('client.js');
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__dc = { decisionQueue, isDecision, decisionOption, DecisionDialog, createOptionPicks, DECIDE_CSS, DECIDE_HIDE_MS };\n    ${ANCHOR}`));

// A hook runtime: state, refs and layout effects (with deps) by call order.
let hooks = []; let hi = 0; let pending = [];
const changed = (a, b) => a === undefined || b === undefined || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
const React = {
  createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
  useState: (v) => { const i = hi++; if (!(i in hooks)) hooks[i] = typeof v === 'function' ? v() : v; return [hooks[i], (x) => { hooks[i] = typeof x === 'function' ? x(hooks[i]) : x; }]; },
  useRef: (v) => { const i = hi++; return hooks[i] ??= { current: v }; },
  useSyncExternalStore: (_s, get) => get(),
  useLayoutEffect: (f, deps) => { const i = hi++; const old = hooks[i]; if (old === undefined || changed(old.deps, deps)) pending.push(() => { old?.off?.(); hooks[i] = { deps, off: f() }; }); },
  useEffect: () => {},
};
mod.factory((n) => (n === 'react' ? React : {}));
const { decisionQueue, isDecision, decisionOption, DecisionDialog, createOptionPicks, DECIDE_CSS, DECIDE_HIDE_MS } = globalThis.__dc;

// The words: the shipped Turkish pack (the exact message), with {name} interpolation.
const tr = JSON.parse(read('locales/tr.json'))['dsh-composer-plus'];
const t = (k, v = {}) => { const s = tr[k]; assert.equal(typeof s, 'string', `tr has ${k}`); return s.replace(/\{(\w+)\}/g, (_, n) => String(v[n])); };

// 1. What a decision is.
assert.equal(isDecision({ text: 'Karar ver: rapor şablonu' }), true);
assert.equal(isDecision({ text: 'KARAR VER hangi sunucu' }), true, 'any case');
assert.equal(isDecision({ text: 'Decide: which server' }), true, 'English');
assert.equal(isDecision({ text: 'Yedek için karar ver: gece mi gündüz mü' }), true, '"karar ver:" inside the text');
assert.equal(isDecision({ text: 'Süt al' }), false);
assert.equal(isDecision({ text: 'Karar verildi, rapor gönder' }), false, 'not "karar ver" as a word');
assert.equal(isDecision({ text: 'Hangi şablon?', options: ['Kısa', 'Uzun'] }), true, 'a note with options');
// The recommended mark becomes a tag.
assert.deepEqual(decisionOption('Kısa şablon (Önerilen)'), { label: 'Kısa şablon', recommended: true });
assert.deepEqual(decisionOption('Long one (Recommended)'), { label: 'Long one', recommended: true });
assert.deepEqual(decisionOption('Gece 02:00 (yerel saat)'), { label: 'Gece 02:00 (yerel saat)', recommended: false }, 'another parenthesis stays');
// The queue: decisions in list order, Sonra ids at the end; the other notes; answered ones leave.
{
  const notes = [{ id: 'a', text: 'Karar ver: A' }, { id: 'n', text: 'Süt al' }, { id: 'b', text: 'Karar ver: B' }, { id: 'c', text: 'Karar ver: C' }];
  const q = decisionQueue(notes, { answered: new Map([['c', 1000]]), later: ['a'] }, 1000 + 59000);
  assert.deepEqual(q.decisions.map((i) => i.id), ['b', 'a']); assert.deepEqual(q.notes.map((i) => i.id), ['n']);
  // Damon did not remove "c" in 60 s (a rollback, a failed turn): it shows again.
  assert.equal(DECIDE_HIDE_MS, 60000);
  assert.deepEqual(decisionQueue(notes, { answered: new Map([['c', 1000]]), later: [] }, 1000 + DECIDE_HIDE_MS).decisions.map((i) => i.id), ['a', 'b', 'c'], 'after 60 s it is back');
}

// 2. The dialog.
const NOW = Date.now(); let clock = NOW; Date.now = () => clock;
const sent = []; let failSend = null; let gate = null;
const picks = createOptionPicks(async (id, text) => { if (gate) await gate; if (failSend) throw new Error(failSend); sent.push([id, text]); });
const notes = [
  { id: 'd1', text: 'Karar ver: haftalık rapor hangi şablonla gitsin?', owner: 'user', created: NOW - 3 * 3600000, options: ['Kısa şablon (Önerilen)', 'Uzun şablon', 'Bu hafta gönderme'] },
  { id: 'n1', text: 'Kırtasiye siparişini ver', owner: 'user', created: NOW - 60000 },
  { id: 'd2', text: 'Karar ver: yedek gece mi alınsın?', owner: 'user', created: NOW - 7200000 },
  { id: 'd3', text: 'Karar ver: hangi sunucu?', owner: 'user', created: NOW - 600000, options: ['Canlı sunucuya deploy', 'Test sunucusu'] },
  { id: 'n2', text: 'Toplantı notlarını oku', owner: 'user', created: NOW - 30000 },
];
let decide = { answered: new Map(), later: [], error: null }; const setDecide = (f) => { decide = typeof f === 'function' ? f(decide) : f; };
let closed = 0;
const focused = []; const listeners = new Map();
const dialog = { open: false, modal: 0, showModal() { this.open = true; this.modal += 1; }, close() { this.open = false; },
  addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  querySelector: (sel) => (sel === '[data-dc-focus]' ? { focus: () => focused.push(current() ?? 'rest') } : null) };
const removed = []; let failRemove = false; let busy = false;
const remove = async (id) => { removed.push(id); return !failRemove; };
let tree;
const find = (n, pred) => { if (n === null || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap((c) => find(c, pred)); return [...(pred(n) ? [n] : []), ...(n.c ?? []).flat(Infinity).flatMap((c) => find(c, pred))]; };
const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join(' ') : n?.c ? text(n.c) : '');
const render = () => {
  hi = 0; pending = [];
  tree = DecisionDialog({ sessionId: 's-a', notes, decide, setDecide, picks, remove, busy, t, lang: 'tr', onClose: () => { closed += 1; } });
  tree.p.ref.current = dialog; for (const f of pending) f();
  return tree;
};
const current = () => find(tree, (n) => n.p?.['data-decision'] !== undefined)[0]?.p['data-decision'];
const optionBtns = () => find(tree, (n) => n.t === 'button' && n.p['data-option'] !== undefined);
const btn = (dc) => find(tree, (n) => n.t === 'button' && n.p['data-dc'] === dc)[0];
const press = (key, target = { closest: () => null }) => { const ev = { key, target, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } }; listeners.get('keydown')(ev); return ev; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

render();
assert.equal(tree.t, 'dialog'); assert.equal(dialog.open, true); assert.equal(dialog.modal, 1, 'a modal dialog (showModal): over the whole page, the rest inert');
assert.equal(tree.p['aria-modal'], 'true'); const title = find(tree, (n) => n.p?.id === tree.p['aria-labelledby'])[0];
assert.equal(text(title), 'Kararlar', 'aria-labelledby names the title');
assert.match(DECIDE_CSS, /::backdrop\{[^}]*backdrop-filter:blur\(\d+px\)/, 'the backdrop is blurred'); assert.match(DECIDE_CSS, /::backdrop\{[^}]*background:rgba\(0,0,0,\.\d+\)/, 'and dimmed');
assert.match(DECIDE_CSS, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.cp-dc-card\{animation:none\}/, 'no slide with reduced motion');
// The first card: the question, when, progress, the options, the tag, the actions.
assert.equal(current(), 'd1'); assert.deepEqual(focused, ['d1'], 'the focus goes to the question');
const card = find(tree, (n) => n.p?.['data-decision'] === 'd1')[0];
assert.match(text(card), /haftalık rapor hangi şablonla gitsin/); assert.match(text(card), /Eklendi/);
assert.equal(text(find(tree, (n) => n.p?.['data-dc-progress'] !== undefined)[0]), '1 / 3', 'progress');
assert.deepEqual(optionBtns().map((b) => text(b).replace(/\s+/g, ' ').trim()), ['1 Kısa şablon Önerilen', '2 Uzun şablon', '3 Bu hafta gönderme'], 'one button per option, the mark as a tag');
assert.equal(optionBtns()[0].p['data-recommended'], '', 'the recommended one is marked');
assert.ok(btn('skip') && btn('later'), 'Atla and Sonra'); assert.equal(text(btn('skip')), 'Atla'); assert.equal(text(btn('later')), 'Sonra');
const field = () => find(tree, (n) => n.t === 'input')[0];
assert.equal(field().p['aria-label'], 'Başka bir cevap');
// One click: the exact message on the send path, the next card at once (before the send ends), the item stays.
let release; gate = new Promise((r) => { release = r; });
optionBtns()[1].p.onClick(); render();
assert.equal(current(), 'd2', 'the next card at once');
await flush(); assert.equal(picks.of('s-a').busy, true, 'one send at a time (Option picks\' guard: Onayla and the option buttons wait)');
assert.deepEqual(await picks.say('s-a', 'x'), { ok: false, busy: true }, 'another send (Onayla, an option button) is refused meanwhile');
assert.equal(await picks.pick('s-a', { seq: 1, latest: 1, options: [{ n: 1, text: 'A' }] }, 1), false, 'an option pick waits too');
release(); gate = null; await flush(); render();
assert.deepEqual(sent, [['s-a', 'Karar: Karar ver: haftalık rapor hangi şablonla gitsin? → Uzun şablon']], 'the exact message, once');
// A double click does not answer the next card (it shows at the same place): a click in the next 0.4 s does nothing.
clock += 100; btn('skip').p.onClick(); render(); assert.equal(current(), 'd2', 'a click 0.1 s after an answer does nothing');
btn('later').p.onClick(); render(); assert.deepEqual(decide.later, [], 'Sonra 0.1 s after an answer does nothing too');
// Quick clicks (0.5 s apart, while the first send runs): both are sent, in order (the second waits for the first).
{
  const notes2 = [{ id: 'q1', text: 'Karar ver: Q1', owner: 'user', created: NOW, options: ['A', 'B'] }, { id: 'q2', text: 'Karar ver: Q2', owner: 'user', created: NOW, options: ['C', 'D'] }];
  const saved = [hooks, decide]; hooks = []; decide = { answered: new Map(), later: [], error: null };
  const draw = () => { hi = 0; pending = []; const tr = DecisionDialog({ sessionId: 's-b', notes: notes2, decide, setDecide, picks, remove, t, lang: 'tr', onClose: () => {} }); tr.p.ref.current = { ...dialog, open: true, addEventListener() {}, removeEventListener() {} }; for (const f of pending) f(); return tr; };
  clock += 1000; let tr = draw(); let hold; gate = new Promise((r) => { hold = r; });
  find(tr, (n) => n.t === 'button' && n.p['data-option'] === '1')[0].p.onClick(); tr = draw(); clock += 500;
  find(tr, (n) => n.t === 'button' && n.p['data-option'] === '2')[0].p.onClick();
  hold(); gate = null; await flush(); await flush();
  assert.deepEqual(sent.slice(-2), [['s-b', 'Karar: Karar ver: Q1 → A'], ['s-b', 'Karar: Karar ver: Q2 → D']], 'both quick clicks, in order');
  // A click while Onayla's send of the chat runs: it waits for it and then goes (no "Gönderilemedi: busy").
  for (const h of hooks) h?.off?.(); decide = { answered: new Map(), later: [], error: null }; hooks = []; clock += 1000; tr = draw();
  let hold2; gate = new Promise((r) => { hold2 = r; });
  const approved = picks.say('s-b', 'Onaylıyorum: test'); await flush();
  find(tr, (n) => n.t === 'button' && n.p['data-option'] === '2')[0].p.onClick(); await flush();
  assert.equal(decide.error, null, 'no error while it waits');
  hold2(); gate = null; await approved; await flush(); await flush();
  assert.deepEqual(sent.slice(-2), [['s-b', 'Onaylıyorum: test'], ['s-b', 'Karar: Karar ver: Q1 → B']], 'it went after the other send');
  assert.equal(decide.error, null);
  for (const h of hooks) h?.off?.(); [hooks, decide] = saved;
}
assert.ok(notes.some((i) => i.id === 'd1'), 'the client removes nothing'); assert.ok(decide.answered.has('d1'), 'the panel knows it (its badge counts it out)');
assert.equal(decide.answered.get('d1'), NOW, 'with the time of the answer (it shows again 60 s later)');
assert.equal(text(find(tree, (n) => n.p?.['data-dc-progress'] !== undefined)[0]), '2 / 3', 'progress after one');
// No options: the note, no option button; Atla, Sonra and the field work.
assert.equal(optionBtns().length, 0); assert.match(text(tree), /Damon seçenek eklemedi/);
// A key in the first 0.8 s does nothing; then → skips (the next card), a digit picks.
// (A new card shows: d2 again after hooks of the quick-click block; restart its clock with a skip and a come-back.)
hooks = []; decide = { ...decide }; focused.length = 0; render(); clock += 100;
let ev = press('ArrowRight'); render(); assert.equal(current(), 'd2', 'not in the first 0.8 s'); assert.equal(ev.stopped, true, 'the dialog keeps its keys (dsh and the panel do not get them)');
clock += 900; press('ArrowRight'); render(); assert.equal(current(), 'd3', '→ skips');
clock += 900;
// d3: option 1 names a live system: its digit does nothing (a click is needed); digit 2 picks.
const base = sent.length;
press('1'); await flush(); render(); assert.equal(current(), 'd3', 'a live option goes only with a click'); assert.equal(sent.length, base);
press('2', { closest: (sel) => (/input/.test(sel) ? {} : null) }); await flush(); assert.equal(sent.length, base, 'not in the text field');
press('2'); await flush(); render();
assert.deepEqual(sent.at(-1), ['s-a', 'Karar: Karar ver: hangi sunucu? → Test sunucusu'], 'digit 2 picks option 2');
// All decisions answered or skipped: the notes, with "back to the skipped" (d2).
assert.equal(current(), undefined);
const noteRows = () => find(tree, (n) => n.t === 'li' && n.p['data-note'] !== undefined);
assert.deepEqual(noteRows().map((n) => n.p['data-note']), ['n1', 'n2'], 'the other notes after the decisions');
assert.equal(focused.at(-1), 'rest', 'after the last card the focus goes to the notes title (it stays in the dialog)');
assert.match(text(btn('back')), /Atlananlara dön \(1\)/);
btn('back').p.onClick(); render(); assert.equal(current(), 'd2', 'the skipped card comes back');
clock += 500;
// Sonra: d2 moves to the end of the queue (here the only one: it stays); the free text sends "Karar: … → <text>".
btn('later').p.onClick(); render(); assert.deepEqual(decide.later, ['d2']);
clock += 500;
field().p.onChange({ target: { value: '  Hafta sonu alınsın  ' } }); render();
find(tree, (n) => n.t === 'form')[0].p.onSubmit({ preventDefault() {} }); await flush(); render(); clock += 500;
assert.deepEqual(sent.at(-1), ['s-a', 'Karar: Karar ver: yedek gece mi alınsın? → Hafta sonu alınsın'], 'another answer');
// The notes: Yaptım sends "Not tamam: <item>", Atla hides it here, Sil removes it (the old ×); then "Hepsi bitti" and Kapat.
const rowBtns = (id) => find(noteRows().find((n) => n.p['data-note'] === id), (n) => n.t === 'button');
assert.deepEqual(rowBtns('n1').map(text), ['Yaptım', 'Atla', 'Sil'], 'Yaptım, Atla and Sil on each note');
assert.equal(rowBtns('n1')[2].p['aria-label'], 'Sil: Kırtasiye siparişini ver');
const focus0 = focused.length;
rowBtns('n1')[0].p.onClick(); await flush(); render(); clock += 500;
assert.deepEqual(sent.at(-1), ['s-a', 'Not tamam: Kırtasiye siparişini ver']);
assert.equal(focused.length, focus0 + 1, 'a row went: the focus goes to the notes title again (not to the page)');
// Sil: a failed remove brings the note back; busy (another change of the list runs): nothing.
failRemove = true; rowBtns('n2')[2].p.onClick(); render();
assert.deepEqual(noteRows().map((n) => n.p['data-note']), [], 'it leaves at once'); await flush(); render();
assert.deepEqual(removed, ['n2']); assert.deepEqual(noteRows().map((n) => n.p['data-note']), ['n2'], 'a failed remove brings it back');
failRemove = false; clock += 500; busy = true; render();
assert.equal(rowBtns('n2')[2].p['aria-disabled'], true); rowBtns('n2')[2].p.onClick(); await flush(); render();
assert.deepEqual(removed, ['n2'], 'nothing while another change runs');
busy = false; clock += 500; render();
rowBtns('n2')[2].p.onClick(); await flush(); render();
assert.deepEqual(removed, ['n2', 'n2'], 'Sil calls the panel\'s remove'); assert.ok(decide.answered.has('n2'), 'and hides it for 60 s');
assert.equal(sent.at(-1)[1], 'Not tamam: Kırtasiye siparişini ver', 'Sil sends no message');
assert.equal(noteRows().length, 0); assert.match(text(tree), /Hepsi bitti/);
assert.equal(focused.at(-1), 'rest', 'the end line gets the focus');
// 60 s later the answered notes are back when Damon did not remove them.
clock = decide.answered.get('n2') + DECIDE_HIDE_MS; render();
assert.equal(current(), 'd1', 'an answered decision still on the list after 60 s shows again (first in list order)');
assert.deepEqual(decisionQueue(notes, decide).notes.map((i) => i.id), ['n1', 'n2'], 'and the done and removed notes');
clock += 1000; decide = { ...decide, answered: new Map([...decide.answered].map(([id]) => [id, clock])) }; render();
assert.equal(current(), undefined); assert.equal(noteRows().length, 0);
btn('close').p.onClick(); assert.equal(closed, 1, 'Kapat closes it');
// A failed send: the card comes back with the reason; nothing is lost.
{
  decide = { answered: new Map(), later: [], error: null }; hooks = []; render(); clock += 900;
  failSend = 'the chat is closed';
  optionBtns()[0].p.onClick(); await flush(); render(); failSend = null;
  assert.equal(current(), 'd1', 'the card is back'); assert.equal(decide.answered.has('d1'), false);
  assert.match(text(find(tree, (n) => n.p?.role === 'alert')[0]), /Gönderilemedi: the chat is closed/);
  assert.equal(decide.error, 'Gönderilemedi: the chat is closed', 'in the panel\'s state: the panel shows it after the dialog closed');
  assert.equal(picks.of('s-a').error, null, 'the option buttons under a reply keep their own state');
}
// Esc (the native cancel event), × and a click on the backdrop close it; a click inside does not.
{
  const c0 = closed; let prevented = false;
  listeners.get('cancel')({ preventDefault: () => { prevented = true; } }); assert.equal(closed, c0 + 1, 'Esc closes'); assert.equal(prevented, true, 'the panel closes it (its state)');
  find(tree, (n) => n.t === 'button' && n.p['aria-label'] === 'Kapat' && n.p.className === 'cp-dc-x')[0].p.onClick(); assert.equal(closed, c0 + 2, '× closes');
  tree.p.onPointerDown({ target: dialog }); tree.p.onClick({ target: dialog }); assert.equal(closed, c0 + 3, 'a click on the backdrop closes');
  tree.p.onPointerDown({ target: {} }); tree.p.onClick({ target: {} }); assert.equal(closed, c0 + 3, 'a click inside does not');
  tree.p.onPointerDown({ target: {} }); tree.p.onClick({ target: dialog }); assert.equal(closed, c0 + 3, 'a text selection from the field to the backdrop does not');
}
// Chrome closes a modal dialog without `cancel` after a second Esc: its `close` event ends it too.
{ const c0 = closed; listeners.get('close')(); assert.equal(closed, c0 + 1, 'the native close ends it'); }
// Unmount: the dialog closes and its listeners go.
for (const h of hooks) h?.off?.(); assert.equal(dialog.open, false); assert.equal(listeners.size, 0);
console.log('decision-dialog: ok');
