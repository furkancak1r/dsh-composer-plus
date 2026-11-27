// Kararlar (Furkan, 2026-11-24): the decision dialog of the Damon status panel (client.js DecisionDialog, decisionQueue,
// isDecision, decisionOption, createOptionPicks' `say`), with a small hook runtime and a fake native <dialog>.
// - A decision is a note with options, or a text that starts with "Karar ver" / "Decide" or has "karar ver:".
// - The dialog opens as a modal (showModal), shows one card: the question, when it was added, "i / N", one button per
//   option (the "(Önerilen)" mark is a tag, not in the text), Atla, Sonra, "Başka bir cevap" + Gönder.
// - One click sends "Karar: <item> → <option>" (the Turkish pack) on Option picks' send path and shows the next card at
//   once; the item stays (the client removes nothing); a failed send brings the card back with the reason.
// - Keys (after 0.8 s): 1–9 pick and send, Enter sends; ← → move (no answer); not in the text field; an option that
//   names a live system only by click.
// - Furkan, 2026-11-26: ‹ › in the header; Gönder never off (the recommended option preselected); "✓ Gönderildi"; a
//   double send of one item sends once; the "Başka bir cevap" text belongs to its card; an answered item stays hidden
//   until Damon removes it (no 60 s return); DecidePeek opens the dialog by itself for a new decision (canPeek).
// - No options: no option button, "Damon seçenek eklemedi", Atla/Sonra/the field still work.
// - After the decisions: the other notes with Yaptım ("Not tamam: <item>") and Atla; at the end "Hepsi bitti" + Kapat.
// - Esc (the dialog's cancel event), × and a click on the backdrop close it (the pointer down and up on it, not a text
//   selection that ends outside); the dialog's keys do not leave it.
// - Sil (Damon, 2026-11-24): removes a note at once through the panel's remove; a failure brings it back.
// - An answered or removed note stays hidden while the dialog's `answered` has it (the panel drops an id when the item
//   leaves the list).
// - The focus stays in the dialog when a note row goes; Sonra has the 0.4 s click guard too; a send waits while another
//   send of the chat (Onayla, an option button) runs, and a failed send keeps its reason in the panel's state.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
const src = read('client.js');
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__dc = { decisionQueue, isDecision, decisionOption, DecisionDialog, DecidePeek, canPeek, decideSeen, createOptionPicks, DECIDE_CSS, DECIDE_PEEK_QUIET_MS, suggestionMessage, suggestBlocked };\n    ${ANCHOR}`));

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
const { decisionQueue, isDecision, decisionOption, DecisionDialog, DecidePeek, canPeek, decideSeen, createOptionPicks, DECIDE_CSS, DECIDE_PEEK_QUIET_MS } = globalThis.__dc;

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
  const q = decisionQueue(notes, { answered: new Map([['c', 1000]]), later: ['a'] });
  assert.deepEqual(q.decisions.map((i) => i.id), ['b', 'a']); assert.deepEqual(q.notes.map((i) => i.id), ['n']);
  // Furkan, 2026-11-26: an answered card came back after 60 s while Damon's turn still ran. It stays hidden now, also
  // long after the answer, until the panel drops its id (the item left the list).
  const t0 = Date.now(); const real = Date.now; Date.now = () => t0 + 3600000;
  assert.deepEqual(decisionQueue(notes, { answered: new Map([['c', t0]]), later: [] }).decisions.map((i) => i.id), ['a', 'b'], 'an hour later it is still hidden');
  Date.now = real;
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
let decide = { answered: new Map(), drafts: new Map(), later: [], error: null }; const setDecide = (f) => { decide = typeof f === 'function' ? f(decide) : f; };
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
  const saved = [hooks, decide]; hooks = []; decide = { answered: new Map(), drafts: new Map(), later: [], error: null };
  const draw = () => { hi = 0; pending = []; const tr = DecisionDialog({ sessionId: 's-b', notes: notes2, decide, setDecide, picks, remove, t, lang: 'tr', onClose: () => {} }); tr.p.ref.current = { ...dialog, open: true, addEventListener() {}, removeEventListener() {} }; for (const f of pending) f(); return tr; };
  clock += 1000; let tr = draw(); let hold; gate = new Promise((r) => { hold = r; });
  find(tr, (n) => n.t === 'button' && n.p['data-option'] === '1')[0].p.onClick(); tr = draw(); clock += 500;
  find(tr, (n) => n.t === 'button' && n.p['data-option'] === '2')[0].p.onClick();
  hold(); gate = null; await flush(); await flush();
  assert.deepEqual(sent.slice(-2), [['s-b', 'Karar: Karar ver: Q1 → A'], ['s-b', 'Karar: Karar ver: Q2 → D']], 'both quick clicks, in order');
  // A click while Onayla's send of the chat runs: it waits for it and then goes (no "Gönderilemedi: busy").
  for (const h of hooks) h?.off?.(); decide = { answered: new Map(), drafts: new Map(), later: [], error: null }; hooks = []; clock += 1000; tr = draw();
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
assert.equal(decide.answered.get('d1'), NOW, 'with the time of the answer');
assert.equal(text(find(tree, (n) => n.p?.['data-dc-progress'] !== undefined)[0]), '2 / 3', 'progress after one');
// No options: the note, no option button; Atla, Sonra and the field work.
assert.equal(optionBtns().length, 0); assert.match(text(tree), /Damon seçenek eklemedi/);
// ← → move between the decisions at once (no answer, no key guard); a digit in the first 0.8 s does nothing.
hooks = []; decide = { ...decide }; focused.length = 0; render(); clock += 100;
const moved0 = sent.length;
let ev = press('ArrowRight'); render(); assert.equal(current(), 'd3', '→: the next decision'); assert.equal(ev.stopped, true, 'the dialog keeps its keys (dsh and the panel do not get them)');
assert.equal(ev.prevented, true);
press('ArrowLeft'); render(); assert.equal(current(), 'd2', '←: the previous one'); press('ArrowLeft'); render(); assert.equal(current(), 'd2', 'the first: ← stays');
press('ArrowRight'); render(); press('ArrowRight'); render(); assert.equal(current(), 'd3', 'the last: → stays');
const nav = (dir) => find(tree, (n) => n.t === 'button' && n.p['data-dc-nav'] === dir)[0];
assert.equal(nav('prev').p['aria-label'], 'Önceki karar'); assert.equal(nav('next').p['aria-label'], 'Sonraki karar');
assert.equal(nav('next').p['aria-disabled'], true, '› is off on the last card'); assert.equal(nav('prev').p['aria-disabled'], false);
nav('prev').p.onClick(); render(); assert.equal(current(), 'd2', '‹ goes back'); nav('next').p.onClick(); render(); assert.equal(current(), 'd3', '› goes on');
assert.equal(sent.length, moved0, 'moving sends nothing');
assert.equal(text(find(tree, (n) => n.p?.className === 'cp-dc-keys')[0]), '1–9 seç ve gönder · Enter gönder · ← → önceki/sonraki · Esc kapat', 'the hint line');
const before0 = sent.length; press('2'); await flush(); assert.equal(sent.length, before0, 'a digit in the first 0.8 s does nothing');
clock += 900;
// d3: option 1 names a live system: its digit does nothing (a click is needed); digit 2 picks.
const base = sent.length;
press('1'); await flush(); render(); assert.equal(current(), 'd3', 'a live option goes only with a click'); assert.equal(sent.length, base);
press('2', { closest: (sel) => (/input/.test(sel) ? {} : null) }); await flush(); assert.equal(sent.length, base, 'not in the text field');
press('2'); await flush(); render();
assert.deepEqual(sent.at(-1), ['s-a', 'Karar: Karar ver: hangi sunucu? → Test sunucusu'], 'digit 2 sends option 2');
assert.equal(current(), 'd2', 'then the next open decision (after the last: the first)');
clock += 900; btn('skip').p.onClick(); render();
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
assert.equal(btn('send').p.disabled, undefined, 'Gönder is never disabled'); assert.equal(btn('send').p['aria-label'], 'Gönder: Hafta sonu alınsın', 'its name says what it sends');
press('Enter', { closest: (sel) => (sel === '.cp-dc-other input' ? {} : null) }); await flush(); render(); clock += 500;
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
assert.deepEqual(removed, ['n2', 'n2'], 'Sil calls the panel\'s remove'); assert.ok(decide.answered.has('n2'), 'and hides it');
assert.equal(sent.at(-1)[1], 'Not tamam: Kırtasiye siparişini ver', 'Sil sends no message');
assert.equal(noteRows().length, 0); assert.match(text(tree), /Hepsi bitti/);
assert.equal(focused.at(-1), 'rest', 'the end line gets the focus');
// Furkan, 2026-11-26: an answered card did come back after 60 s. Now it stays hidden while Damon has not removed it.
clock += 3600000; render();
assert.equal(current(), undefined, 'an hour later no answered decision is back'); assert.equal(noteRows().length, 0, 'and no done or removed note');
btn('close').p.onClick(); assert.equal(closed, 1, 'Kapat closes it');
// A decision card has Sil too; the "Başka bir cevap" text belongs to its card (the next card's field is empty).
{
  decide = { answered: new Map(), drafts: new Map(), later: [], error: null }; hooks = []; render(); clock += 900;
  field().p.onChange({ target: { value: 'yarım kalan cevap' } }); render();
  optionBtns()[1].p.onClick(); await flush(); render(); clock += 500;
  assert.equal(current(), 'd2'); assert.equal(field().p.value, '', 'the next card\'s field is empty');
  assert.equal(sent.at(-1)[1], 'Karar: Karar ver: haftalık rapor hangi şablonla gitsin? → Uzun şablon', 'the click sent the option, not the typed text');
  const r0 = removed.length; assert.equal(btn('remove').p['aria-label'], 'Sil: Karar ver: yedek gece mi alınsın?');
  btn('remove').p.onClick(); await flush(); render(); clock += 500;
  assert.deepEqual(removed.slice(r0), ['d2'], 'Sil on a decision card removes it'); assert.equal(current(), 'd3', 'the next card');
  assert.equal(text(find(tree, (n) => n.p?.['data-dc-progress'] !== undefined)[0]), '3 / 3', 'the removed decision counts as done');
}
// A failed send: the card comes back with the reason; nothing is lost.
{
  decide = { answered: new Map(), drafts: new Map(), later: [], error: null }; hooks = []; render(); clock += 900;
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
// (The browser fires `close` after `open` is false.) The close of the switch from a peek to a modal one does not end it.
{
  const c0 = closed; listeners.get('close')(); assert.equal(closed, c0, 'still open: not the end');
  dialog.open = false; listeners.get('close')(); assert.equal(closed, c0 + 1, 'the native close ends it'); dialog.open = true;
}
// Unmount: the dialog closes and its listeners go.
for (const h of hooks) h?.off?.(); assert.equal(dialog.open, false); assert.equal(listeners.size, 0);

// 3. Furkan, 2026-11-26. A second dialog of its own chat (own hooks, own sends).
{
  const mine = []; let hold = null;
  const p2 = createOptionPicks(async (id, text) => { if (hold) await hold; mine.push(text); });
  let list = [
    { id: 'k1', text: 'Karar ver (Promes): parola sıfırlama', owner: 'user', created: NOW, options: ['Hayır, yalnız admin (Önerilen)', 'Evet'] },
    { id: 'k2', text: 'Karar ver (Promes): proje araması', owner: 'user', created: NOW, options: ['Tam eşleşme (Önerilen)', 'Kısmi'] },
    { id: 'k3', text: 'Karar ver: kişisel notlar taşınsın mı', owner: 'user', created: NOW, options: ['Taşınsın', 'Kalsın'] },
  ];
  let st = { answered: new Map(), drafts: new Map(), later: [], error: null }; const setSt = (f) => { st = typeof f === 'function' ? f(st) : f; };
  const saved = hooks; hooks = []; let tr; const ls = new Map();
  const d2 = { open: false, showModal() { this.open = true; }, close() { this.open = false; }, setAttribute(k) { if (k === 'open') this.open = true; }, contains: () => false,
    matches: () => true, addEventListener: (k, f) => ls.set(k, f), removeEventListener: (k) => ls.delete(k), querySelector: () => ({ focus() {} }) };
  const draw = () => { hi = 0; pending = []; tr = DecisionDialog({ sessionId: 's-c', notes: list, decide: st, setDecide: setSt, picks: p2, remove, t, lang: 'tr', onClose: () => {} }); tr.p.ref.current = d2; for (const f of pending) f(); return tr; };
  const cur = () => find(tr, (n) => n.p?.['data-decision'] !== undefined)[0]?.p['data-decision'];
  const b = (dc) => find(tr, (n) => n.t === 'button' && n.p['data-dc'] === dc)[0];
  const opt = (n) => find(tr, (x) => x.t === 'button' && x.p['data-option'] === String(n))[0];
  const inp = () => find(tr, (n) => n.t === 'input')[0];
  const key = (k, target = { closest: () => null }) => ls.get('keydown')({ key: k, target, stopPropagation() {}, preventDefault() {} });
  clock += 5000; draw();
  // Gönder is on with the recommended option preselected; Gönder sends it and opens the next decision.
  assert.equal(b('send').p.disabled, undefined, 'Gönder is never disabled');
  assert.equal(opt(1).p['data-selected'], '', 'the recommended option is preselected'); assert.equal(opt(2).p['data-selected'], undefined);
  assert.equal(b('send').p['aria-label'], 'Gönder: Hayır, yalnız admin', 'Gönder names what it sends');
  b('send').p.onClick(); draw(); await flush(); draw();
  assert.deepEqual(mine, ['Karar: Karar ver (Promes): parola sıfırlama → Hayır, yalnız admin'], 'Gönder sent the preselected option');
  assert.equal(cur(), 'k2', 'then the next decision');
  assert.equal(text(find(tr, (n) => n.p?.['data-dc-sent'] !== undefined)[0]), '✓ Gönderildi: Hayır, yalnız admin', 'a short "sent" line after dsh took it');
  assert.equal(find(tr, (n) => n.p?.['data-dc-sent'] !== undefined)[0].p.role, 'status', 'a live region');
  // A typed text on k2 changes what Gönder sends; the option is no longer marked.
  clock += 500; inp().p.onChange({ target: { value: 'kullanıcı seçsin' } }); draw();
  assert.equal(opt(1).p['data-selected'], undefined, 'a typed text: no option is preselected'); assert.equal(b('send').p['aria-label'], 'Gönder: kullanıcı seçsin');
  // Furkan's bug: a decision comes in front of the card while you type (an answered card came back, a new item): the
  // card on screen stays, and its text goes only with it.
  list = [{ id: 'k0', text: 'Karar ver: yeni gelen', owner: 'user', created: NOW, options: ['A', 'B'] }, ...list]; draw();
  assert.equal(cur(), 'k2', 'the card on screen stays'); assert.equal(inp().p.value, 'kullanıcı seçsin', 'with its text');
  let hold1; hold = new Promise((r) => { hold1 = r; });
  key('Enter', { closest: (sel) => (sel === '.cp-dc-other input' ? {} : null) }); draw();
  // No double send: Enter and a click on Gönder again while the first send waits.
  clock += 500; key('Enter', { closest: (sel) => (sel === '.cp-dc-other input' ? {} : null) }); clock += 500; b('send').p.onClick(); draw();
  hold1(); hold = null; await flush(); await flush(); draw();
  assert.deepEqual(mine.slice(1), ['Karar: Karar ver (Promes): proje araması → kullanıcı seçsin'], 'the text went once, with its own card');
  assert.ok(!mine.some((m) => m.startsWith('Karar: Karar ver (Promes): parola') && m.endsWith('kullanıcı seçsin')), 'never with another card');
  // The answered decisions stay hidden (an hour later too) while Damon has not removed them.
  clock += 3600000; draw();
  assert.ok(!['k1', 'k2'].includes(cur()), 'no answered card is back'); assert.deepEqual(decisionQueue(list, st).decisions.map((i) => i.id), ['k0', 'k3']);
  // Each card keeps its own text: type on one, move with ›, the other field is empty; back with ‹, the text is there.
  clock += 500; const a = cur(); inp().p.onChange({ target: { value: 'yalnız bu karta' } }); draw();
  assert.equal(a, 'k3', 'the card at the answered one\'s place'); key('ArrowLeft'); draw(); assert.equal(cur(), 'k0'); assert.equal(inp().p.value, '', 'another card: an empty field');
  key('ArrowRight'); draw(); assert.equal(cur(), a); assert.equal(inp().p.value, 'yalnız bu karta', 'back: its text');
  // A click on an option sends at once (send on select), also when a text is typed: the click wins, the text stays.
  clock += 500; const n0 = mine.length; opt(2).p.onClick(); draw(); await flush(); draw();
  assert.equal(mine.length, n0 + 1, 'one click: one message'); assert.equal(mine.at(-1), 'Karar: Karar ver: kişisel notlar taşınsın mı → Kalsın', 'the clicked option of the card on screen');
  // Double click on an option: one message (the 0.4 s guard), the next card is not answered.
  clock += 500; const left = cur(); opt(1).p.onClick(); clock += 100; opt(1).p.onClick(); draw(); await flush(); draw();
  assert.equal(mine.length, n0 + 2, 'a double click sends once'); assert.equal(cur() !== left, true);
  // A failed send: the card comes back on screen with its typed text.
  list = [...list, { id: 'k4', text: 'Karar ver: son karar', owner: 'user', created: NOW, options: ['X', 'Y'] }]; draw();
  clock += 900; inp().p.onChange({ target: { value: 'geri gelsin' } }); draw(); const back = cur();
  const p3fail = p2.say; p2.say = async () => ({ ok: false, error: 'kapalı' });
  b('send').p.onClick(); draw(); await flush(); draw(); p2.say = p3fail;
  assert.equal(cur(), back, 'the failed card is back on screen'); assert.equal(inp().p.value, 'geri gelsin', 'with its text');
  // Enter does not send an option that names a live system; a card without a recommended option: Gönder focuses the field.
  for (const h of hooks) h?.off?.();
  list = [{ id: 'l1', text: 'Karar ver: nereye', owner: 'user', created: NOW, options: ['Canlı sunucuya deploy (Önerilen)', 'Test'] }, { id: 'l2', text: 'Karar ver: renk', owner: 'user', created: NOW, options: ['Mavi', 'Yeşil'] }];
  st = { answered: new Map(), drafts: new Map(), later: [], error: null }; hooks = []; clock += 5000; draw(); clock += 900;
  const n1 = mine.length; key('Enter'); await flush(); assert.equal(mine.length, n1, 'Enter: no live option');
  b('send').p.onClick(); draw(); await flush(); draw(); assert.match(mine.at(-1), /→ Canlı sunucuya deploy$/, 'a click on Gönder sends it');
  let fieldFocus = 0; d2.querySelector = (sel) => (sel === '.cp-dc-other input' ? { focus: () => { fieldFocus += 1; } } : { focus() {} });
  clock += 900; const n2 = mine.length; b('send').p.onClick(); draw(); await flush();
  assert.equal(mine.length, n2, 'no text and no recommended option: nothing sent'); assert.equal(fieldFocus, 1, 'the field gets the focus');
  for (const h of hooks) h?.off?.(); hooks = saved;
}

// 3b. The peek: opened with the `open` attribute (no showModal: no backdrop, no focus move); Esc closes it from anywhere
// (a document listener; not while another menu or dialog shows; preventDefault: no half of dsh's Esc Esc stop); a click
// on the Kararlar button (peek false) makes it modal, with the focus in it.
{
  const saved = hooks; hooks = []; const ls = new Map(); const calls = []; let focusQ = 0;
  const pd = { open: false, attrs: new Set(), showModal() { calls.push('showModal'); this.open = true; this.modal = true; }, close() { calls.push('close'); this.open = false; this.modal = false; },
    show() { calls.push('show'); this.open = true; }, setAttribute(k) { calls.push(`attr:${k}`); if (k === 'open') this.open = true; }, matches(sel) { return sel === ':modal' ? this.modal === true : false; },
    contains: () => false, addEventListener: (k, f) => ls.set(k, f), removeEventListener: (k) => ls.delete(k),
    querySelector: (sel) => (sel === '[data-dc-focus]' ? { focus: () => { focusQ += 1; } } : null) };
  const realDoc = globalThis.document; const docLs = new Map(); let popups = [];
  globalThis.document = { activeElement: null, addEventListener: (k, f) => docLs.set(k, f), removeEventListener: (k) => docLs.delete(k), querySelectorAll: () => popups };
  const realEffect = React.useEffect; const effs = [];
  React.useEffect = (f, deps) => { const i = hi++; const old = hooks[i]; if (old === undefined || changed(old.deps, deps)) effs.push(() => { old?.off?.(); hooks[i] = { deps, off: f() }; }); };
  let closedP = 0; let peekOn = true;
  const list = [{ id: 'p1', text: 'Karar ver: peek', owner: 'user', created: NOW, options: ['A (Önerilen)', 'B'] }];
  let st = { answered: new Map(), drafts: new Map(), later: [], error: null };
  const draw = () => { hi = 0; pending = []; effs.length = 0; const tr = DecisionDialog({ sessionId: 's-p', notes: list, decide: st, setDecide: (f) => { st = typeof f === 'function' ? f(st) : f; }, picks, remove, t, lang: 'tr', peek: peekOn, onClose: () => { closedP += 1; } });
    tr.p.ref.current = pd; for (const f of pending) f(); for (const f of effs.splice(0)) f(); return tr; };
  let tr = draw();
  assert.deepEqual(calls, ['attr:open'], 'a peek opens with the open attribute (no show(), no showModal())'); assert.equal(focusQ, 0, 'it takes no focus');
  assert.equal(tr.p['data-peek'], '', 'marked as a peek (the modal checks of other features skip it)'); assert.equal(tr.p['aria-modal'], 'false');
  // Esc from the message box closes it; not while another menu shows; not a key that another listener took.
  const esc = (over = {}) => { const ev = { key: 'Escape', isComposing: false, repeat: false, defaultPrevented: false, prevented: false, preventDefault() { this.prevented = true; }, ...over }; docLs.get('keydown')(ev); return ev; };
  popups = [{ isConnected: true, checkVisibility: () => true }]; esc(); assert.equal(closedP, 0, 'a menu of the message box takes its Esc first'); popups = [];
  esc({ defaultPrevented: true }); assert.equal(closedP, 0, 'an Esc that another listener took');
  const e1 = esc(); assert.equal(closedP, 1, 'Esc closes the peek from anywhere'); assert.equal(e1.prevented, true, 'no half of dsh\'s Esc Esc stop');
  // The Kararlar button while the peek is open: the same dialog becomes modal and takes the focus.
  peekOn = false; calls.length = 0; tr = draw();
  assert.deepEqual(calls, ['close', 'showModal'], 'peek → modal'); assert.equal(pd.modal, true); assert.equal(focusQ, 1, 'the focus goes into it');
  assert.equal(closedP, 1, 'the switch does not end it (its close event comes while it is open again)');
  assert.equal(docLs.has('keydown'), false, 'a modal dialog has no document Esc listener (its cancel event)');
  for (const h of hooks) h?.off?.(); assert.equal(ls.size, 0); assert.equal(docLs.size, 0, 'every listener goes');
  React.useEffect = realEffect; globalThis.document = realDoc; hooks = saved;
}

// 4. DecidePeek and canPeek (Furkan, 2026-11-26: "yeni karar istediğinde input alanı boşsa otomatik olarak pop up
// çıkartabilirsin damonda isem").
{
  const shownEl = { isConnected: true, checkVisibility: () => true };
  const hiddenEl = { isConnected: true, checkVisibility: () => false };
  const docOf = (over = {}) => ({ visibilityState: 'visible', querySelectorAll: () => [], ...over });
  const ok = { doc: docOf(), host: shownEl, empty: true, asked: '', lastInput: 0, now: 100000 };
  assert.equal(canPeek(ok), true, 'opens: all conditions');
  assert.equal(canPeek({ ...ok, empty: false }), false, 'not with a draft or an attachment');
  assert.equal(canPeek({ ...ok, host: hiddenEl }), false, 'not while another chat is on screen (the Damon chat body is hidden)');
  assert.equal(canPeek({ ...ok, host: null }), false, 'not without the Damon chat');
  assert.equal(canPeek({ ...ok, doc: docOf({ visibilityState: 'hidden' }) }), false, 'not with a hidden window');
  assert.equal(canPeek({ ...ok, asked: 'approval' }), false, 'not while dsh asks something');
  assert.equal(canPeek({ ...ok, lastInput: ok.now - DECIDE_PEEK_QUIET_MS + 1 }), false, 'not while you type');
  assert.equal(canPeek({ ...ok, lastInput: ok.now - DECIDE_PEEK_QUIET_MS }), true, 'after 3 s without a key');
  assert.equal(canPeek({ ...ok, doc: docOf({ querySelectorAll: () => [shownEl] }) }), false, 'not while another dialog or menu is open');
  assert.equal(canPeek({ ...ok, doc: docOf({ querySelectorAll: () => [hiddenEl] }) }), true, 'a hidden one does not count');
  // DecidePeek: effects by hand (a small runtime: refs and effects by call order).
  const effects = []; let hk = []; let k = 0;
  const realEffect = React.useEffect; const realRef = React.useRef;
  React.useEffect = (f, deps) => { const i = k++; const old = hk[i]; if (old === undefined || changed(old.deps, deps)) effects.push(() => { old?.off?.(); hk[i] = { deps, off: f() }; }); };
  React.useRef = (v) => { const i = k++; return hk[i] ??= { current: v }; };
  const timers = []; const realSet = globalThis.setInterval; const realClear = globalThis.clearInterval;
  globalThis.setInterval = (f) => { timers.push(f); return timers.length; }; globalThis.clearInterval = (n) => { timers[n - 1] = null; };
  const realDoc = globalThis.document; let vis = 'visible'; const docListeners = new Map();
  globalThis.document = { get visibilityState() { return vis; }, querySelectorAll: () => [], addEventListener: (k2, f) => docListeners.set(k2, f), removeEventListener: (k2) => docListeners.delete(k2) };
  let peeks = 0; let empty = true; let host = shownEl; let open = false;
  const run = (ids) => { k = 0; effects.length = 0; DecidePeek({ sessionId: 's-p', ids, open, host, asked: '', empty: () => empty, onPeek: () => { peeks += 1; open = true; } }); for (const f of effects.splice(0)) f(); };
  const tickAll = () => { for (const f of timers) f?.(); };
  run(null); assert.equal(decideSeen.has('s-p'), false, 'before the first good read: nothing');
  run('a b'); assert.equal(peeks, 0, 'the decisions of the first read are not new');
  run('a b c'); assert.equal(peeks, 1, 'a new decision opens the dialog'); assert.ok(decideSeen.get('s-p').has('c'));
  // Closed (Esc, ×, Sonra): it does not open again for the same items.
  open = false; run('a b c'); assert.equal(peeks, 1, 'closed: not again for the same items'); tickAll(); assert.equal(peeks, 1);
  open = false; run('b c'); assert.equal(peeks, 1, 'an answered one left: nothing new');
  // A draft: it waits; when the message box is empty again, it opens (once).
  empty = false; run('b c d'); assert.equal(peeks, 1, 'not with a draft'); empty = true; tickAll(); assert.equal(peeks, 2, 'the box is empty again: it opens'); tickAll(); assert.equal(peeks, 2, 'once');
  // Another chat on screen, a hidden window, typing: it waits.
  open = false; host = hiddenEl; run('b c d e'); assert.equal(peeks, 2, 'not while another chat is on screen'); tickAll(); assert.equal(peeks, 2);
  host = shownEl; run('b c d e'); // the Damon chat is back on screen (a new draw, the same effect)
  vis = 'hidden'; tickAll(); assert.equal(peeks, 2, 'not with a hidden window'); vis = 'visible';
  docListeners.get('keydown')(); tickAll(); assert.equal(peeks, 2, 'not right after a key'); clock += DECIDE_PEEK_QUIET_MS; tickAll(); assert.equal(peeks, 3, '3 s after the last key');
  // A decision that an open dialog showed is seen: no peek for it after the close.
  open = true; run('b c d e f'); open = false; run('b c d e f'); assert.equal(peeks, 3, 'shown in an open dialog: seen');
  for (const h of hk) h?.off?.(); assert.equal(docListeners.size, 0, 'its listeners go');
  React.useEffect = realEffect; React.useRef = realRef; globalThis.setInterval = realSet; globalThis.clearInterval = realClear; globalThis.document = realDoc;
}

// 5. Get suggestions (Furkan, 2026-11-27): the row under the cards (also at the end, with no decision), its waiting line,
// the cards, one click sends "Öneri: <title> — <text>" once, and a card that would send an approval or a decision never
// shows and never sends (suggestionMessage; the Host has the same rule: test/assistant-suggest.test.mjs).
{
  const { suggestionMessage, suggestBlocked } = globalThis.__dc;
  assert.equal(suggestionMessage({ title: 'Ortak test verisi', text: 'Testler aynı veriyi kullansın.' }, t), 'Öneri: Ortak test verisi — Testler aynı veriyi kullansın.');
  for (const bad of [{ title: 'Onaylıyorum: canlıya al', text: 'x' }, { title: 'x', text: 'ONAYLIYORUM' }, { title: 'CANLI DEPLOY PROMES abc1234 ŞİMDİ', text: 'x' },
    { title: 'Karar: rapor', text: 'x' }, { title: 'x', text: 'Bir.\nKarar: rapor → uzun' }, { title: 'x', text: 'y', why: 'İzin veriyorum' }, { title: 'x', text: 'y', source: 'Onay\u200Blıyorum' },
    { title: 'x', text: 'y', project: 'Decision: z' }, { title: '', text: 'y' }]) {
    assert.equal(suggestionMessage(bad, t), null, JSON.stringify(bad));
  }
  assert.equal(suggestBlocked('Canlı deploy\'u tek komuta indir'), false, 'a suggestion about deploys is fine');
  assert.equal(suggestBlocked('Kararlı bir test seti'), false);
  const saved = [hooks, decide, sent.length];
  hooks = []; decide = { answered: new Map(), drafts: new Map(), later: [], error: null, suggested: new Set() };
  let asks = 0; let sg = null; let sgAsk = null;
  const d5 = { ...dialog, open: true, addEventListener() {}, removeEventListener() {} };
  const draw = () => { hi = 0; pending = []; tree = DecisionDialog({ sessionId: 's-s', notes: [], decide, setDecide, picks, remove, t, lang: 'tr', onClose: () => {}, suggest: sg, sgAsk, askSuggest: () => { asks += 1; } }); tree.p.ref.current = d5; for (const f of pending) f(); return tree; };
  draw();
  const row = () => btn('suggest');
  assert.ok(find(tree, (n) => n.p?.className === 'cp-dc-empty').length === 1, 'nothing waits: "Hepsi bitti"');
  assert.match(text(row()), /Öneri getir/, 'the row shows under it'); assert.equal(row().p['aria-disabled'], false);
  row().p.onClick(); assert.equal(asks, 1, 'a click asks');
  sgAsk = { state: 'waiting', asked: 1 }; draw();
  assert.equal(row().p['aria-disabled'], true); assert.equal(row().p['aria-busy'], true);
  assert.match(text(find(tree, (n) => n.p?.['data-dc-suggest-state'] === 'loading')[0]), /Damon öneri hazırlıyor/, 'the loading line');
  row().p.onClick(); assert.equal(asks, 1, 'no second request while it waits');
  sgAsk = { state: 'late', asked: 1 }; draw(); assert.match(text(find(tree, (n) => n.p?.['data-dc-suggest-state'] === 'late')[0]), /gelmedi/);
  sgAsk = { state: 'error', error: 'HTTP 502' }; draw(); assert.match(text(find(tree, (n) => n.p?.['data-dc-suggest-state'] === 'error')[0]), /Öneri istenemedi: HTTP 502/);
  sgAsk = { state: 'done', asked: 1 };
  sg = { at: NOW, items: [
    { project: 'Promes', title: 'E2E testlerini CI\'a al', text: 'Testler her push\'ta koşsun.', why: 'Elle koşmak unutuluyor.', source: 'Hafıza: promes.md' },
    { title: 'Onaylıyorum: deploy', text: 'x', why: 'y', source: 'z' },
    { title: 'Yeni proje: ortak log görüntüleyici', text: 'Bütün sunucu loglarını tek sayfada göster.', why: 'Her sorunda üç sunucuya bağlanıyorsun.', source: 'sohbet', unverified: true }] };
  draw();
  const cards5 = () => find(tree, (n) => n.t === 'button' && n.p['data-suggestion'] !== undefined);
  assert.equal(cards5().length, 2, 'the approval card never shows');
  assert.match(text(row()), /Yeni öneri getir/, 'with cards, the row asks for new ones');
  assert.match(text(cards5()[0]), /Promes[\s\S]*E2E testlerini CI'a al[\s\S]*Testler her push'ta koşsun\.[\s\S]*Neden: Elle koşmak unutuluyor\.[\s\S]*Kaynak: Hafıza: promes\.md/);
  assert.equal(find(cards5()[0], (n) => n.p?.['data-unverified'] !== undefined).length, 0);
  assert.match(text(find(cards5()[1], (n) => n.p?.['data-unverified'] !== undefined)[0]), /doğrulanmadı/, 'the not verified tag');
  clock += 1000; cards5()[0].p.onClick(); await flush(); draw();
  assert.deepEqual(sent.at(-1), ['s-s', 'Öneri: E2E testlerini CI\'a al — Testler her push\'ta koşsun.'], 'one click sends the suggestion as the user\'s message');
  assert.match(text(cards5()[0]), /✓ Gönderildi/); assert.equal(cards5()[0].p['aria-disabled'], true);
  const n5 = sent.length; clock += 1000; cards5()[0].p.onClick(); await flush(); assert.equal(sent.length, n5, 'a sent card does not send again');
  // A failed send: the card can be sent again, and the reason shows.
  failSend = 'the chat is closed'; clock += 1000; cards5()[1].p.onClick(); await flush(); draw(); failSend = null;
  assert.equal(cards5()[1].p['aria-disabled'], false, 'a failed send: the card can go again'); assert.equal(decide.error, 'Gönderilemedi: the chat is closed');
  assert.ok(sent.slice(saved[2]).every(([, m]) => /^Öneri: /.test(m)), 'every sent text is a suggestion');
  // With a decision on screen, the row comes after the card area.
  {
    hooks = []; hi = 0; pending = [];
    const withCard = DecisionDialog({ sessionId: 's-s', notes: [{ id: 'q1', text: 'Karar ver: x', options: ['A', 'B'] }], decide, setDecide, picks, remove, t, lang: 'tr', onClose: () => {}, suggest: sg, sgAsk, askSuggest: () => {} });
    const order = find(withCard, (n) => n.p?.['data-decision'] !== undefined || n.p?.['data-dc-suggest'] !== undefined).map((n) => (n.p['data-decision'] !== undefined ? 'card' : 'row'));
    assert.deepEqual(order, ['card', 'row'], 'the row is under the decision card');
  }
  [hooks, decide] = saved;
}
console.log('decision-dialog: ok');
