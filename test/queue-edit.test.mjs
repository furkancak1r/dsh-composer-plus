// Queue: double-click a queued message to edit it in place. Runs the real client.js QueueEdit with a fake DOM: a
// double-click on the row's text clicks dsh's own Edit button (dsh's editor then saves on Enter, cancels on Esc and keeps
// the message id, so the order stays). Nothing happens on a button or grip, in the open editor, during a drag, on a row
// that dsh cannot edit, or on a "sending" echo row. Switching the feature off removes the listener.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hook = '    function QueueEdit() {';
assert.ok(src.includes(hook));
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, getSelection: () => ({ removeAllRanges() { cleared += 1; } }) };
let cleared = 0;
globalThis.Element = class Element {};
// A tiny DOM: elements with a tag, attributes, children and a parent; `closest`/`querySelector` for the few selectors used.
class El extends Element {
  constructor(tag, attrs = {}, children = []) {
    super(); this.tag = tag; this.attrs = attrs; this.children = []; this.parent = null; this.disabled = attrs.disabled === true; this.clicks = 0;
    for (const c of children) { c.parent = this; this.children.push(c); }
  }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get tagName() { return this.tag.toUpperCase(); }
  hasAttribute(k) { return k in this.attrs; }
  click() { this.clicks += 1; }
  matches(sel) {
    return sel.split(',').map((x) => x.trim()).some((one) => {
      if (one === '[data-queue-dock] li') return this.tag === 'li' && this.ancestors().some((a) => a.hasAttribute('data-queue-dock'));
      if (one === '[data-composer-seat]') return this.hasAttribute('data-composer-seat');
      if (one === '[data-queue-grip]') return this.hasAttribute('data-queue-grip');
      if (one === '[contenteditable="true"]') return this.attrs.contenteditable === 'true';
      return one === this.tag;
    });
  }
  ancestors() { const out = []; for (let p = this.parent; p; p = p.parent) out.push(p); return out; }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
const listeners = new Map();
const button = (label, opts = {}) => new El('button', { 'aria-label': label, ...(opts.disabled ? { disabled: true } : {}) });
const rowOf = ({ edit = button('Edit queued message'), echo = false, lead = false } = {}) => {
  const text = new El('span', { class: 'preview' }, [new El('span', { class: 'word' })]);
  const grip = new El('span', { 'data-queue-grip': '' }, [button('Reorder queued message')]);
  const actions = new El('div', { class: 'actions' }, [edit, button('Remove'), button('Send now')]);
  return new El('li', echo ? { 'data-submission-echo': '' } : {}, [grip, ...(lead ? [new El('span', { class: 'lead' })] : []), text, actions]);
};
const rows = [rowOf(), rowOf({ lead: true }), rowOf({ edit: button('Edit queued message', { disabled: true }) }), rowOf({ echo: true })];
const dock = new El('div', { 'data-queue-dock': '' }, [new El('ul', {}, rows)]);
const anchor = new El('span');
const seat = new El('div', { 'data-composer-seat': '' }, [dock, anchor]);
seat.addEventListener = (type, fn) => { listeners.set(type, fn); };
seat.removeEventListener = (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); };
eval(src.replace(hook, '    globalThis.__qe = (e, d) => queueEditTarget(e, d);\n' + hook));

let effects = [];
const React = { createElement: (t, p, ...c) => ({ t, p, c }), useRef: () => ({ current: anchor }), useEffect: (f) => { effects.push(f); }, useState: (v) => [v, () => {}], useMemo: (f) => f(), useLayoutEffect: () => {}, Fragment: 'F' };
const plugin = mod.factory((n) => (n === 'react' ? React : {}));
const regs = []; const offs = [];
plugin.apply({ sessions: { scope: () => undefined }, slots: { inject: (n, f) => f(), register: (o, C) => { regs.push([o, C]); const off = () => { offs.push(o.id); }; return off; } } });
const [opt, QueueEdit] = regs.find(([o]) => o.id === 'queue-edit');
assert.equal(opt.name, 'conversation.input.dock');
effects = []; QueueEdit({}); const cleanup = effects[0]();
const dbl = (target, extra = {}) => { let prevented = false; listeners.get('dblclick')({ target, button: 0, preventDefault: () => { prevented = true; }, ...extra }); return prevented; };
const editOf = (li) => li.children.at(-1).children[0];
const word = (li) => li.querySelector('span').parent.tag === 'li' ? li.children.find((c) => c.attrs.class === 'preview').children[0] : null;

// 1. A double-click on a row's text opens dsh's own editor for that row (its Edit button), and clears the word selection.
assert.equal(dbl(word(rows[0])), true); assert.equal(editOf(rows[0]).clicks, 1); assert.equal(cleared, 1);
assert.equal(editOf(rows[1]).clicks, 0, 'only that row');
// With dsh's lead icon (one queued message) the action group is still the last child.
dbl(word(rows[1])); assert.equal(editOf(rows[1]).clicks, 1);
// 2. Not on: a disabled Edit (images/files, or busy), a "sending" echo row, a button or grip, the open editor, a drag,
// another mouse button, a target outside the dock.
assert.equal(dbl(word(rows[2])), false); assert.equal(editOf(rows[2]).clicks, 0, 'dsh cannot edit this row');
assert.equal(dbl(word(rows[3])), false, 'a sending echo row');
assert.equal(dbl(rows[0].children[0].children[0]), false, 'the grip button'); assert.equal(dbl(editOf(rows[0])), false, 'a button itself');
const editing = rowOf(); editing.children.splice(2, 0, new El('textarea')); editing.children[2].parent = editing; dock.children[0].children.push(editing); editing.parent = dock.children[0];
assert.equal(dbl(editing.children[2]), false, 'inside the open editor'); assert.equal(dbl(word(editing)), false, 'a row that is open already');
assert.equal(dbl(word(rows[0]), { button: 1 }), false, 'another mouse button');
assert.equal(dbl(new El('span')), false, 'outside the dock');
// A queue that dsh does not let you change has no action group: the last child is the preview. A button in it (a message
// link chip) is never clicked by a double-click on the text.
{
  const chip = button('Open message');
  const locked = new El('li', {}, [new El('span', { class: 'preview' }, [new El('span', { class: 'word' }), chip])]);
  dock.children[0].children.push(locked); locked.parent = dock.children[0];
  assert.equal(dbl(locked.children[0].children[0]), false, 'no action group: nothing'); assert.equal(chip.clicks, 0);
}
assert.equal(editOf(rows[0]).clicks, 1, 'still one click on row 0');
// 3. While a drag runs (QueueReorder's one drag at a time), a double-click does nothing.
assert.equal(globalThis.__qe({ target: word(rows[0]), button: 0 }, true), null, 'no edit while a drag runs');
assert.equal(globalThis.__qe({ target: word(rows[0]), button: 0 }, false), editOf(rows[0]));
assert.match(src, /queueEditTarget\(event, queueDrag !== null\)/, 'the listener passes the running drag');
// 4. The feature off: the listener goes away.
cleanup(); assert.equal(listeners.has('dblclick'), false);
// 5. The feature has its own switch (FEATURES) and screenshot.
assert.match(src, /'queueReorder', 'queueEdit', 'copyDeeplink'/);
console.log('queue edit checks passed');
