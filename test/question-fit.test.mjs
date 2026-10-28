// Runs the real client.js apply() with a fake DOM: "Fit question card to window" adds one style element to <head> and
// takes it away when the switch goes off or the plugin unloads; it comes back when the switch goes on. The style uses only
// dsh's markup (data-question-key, data-question-scroll, section, footer), never dsh's generated class names, and it
// leaves dsh's plan review card (data-plan-review-key) alone. The layout itself is checked in a real dsh by
// test/browser-question-fit.mjs (1280 × 820, the owner's window).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
const head = [];
const el = (tag) => {
  const attrs = new Map();
  return { tag, textContent: '', setAttribute: (k, v) => attrs.set(k, v), hasAttribute: (k) => attrs.has(k), remove() { const i = head.indexOf(this); if (i >= 0) head.splice(i, 1); } };
};
globalThis.document = { createElement: el, head: { append: (node) => head.push(node) } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const plugin = mod.factory((n) => (n === 'react' ? { createElement: (t, p, ...c) => ({ t, p, c }) } : {}));
const effects = []; let settings;
plugin.apply({ effect: (f) => { effects.push(f()); }, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => f(), register: (o) => { if (o.id === 'composer-plus') settings = o; return () => {}; } } });
const styles = () => head.filter((n) => n.tag === 'style' && n.hasAttribute('data-composer-plus-question-fit'));

assert.equal(styles().length, 1, 'on by default: one style element');
const css = styles()[0].textContent;
assert.match(css, /\[data-question-key\] > section \{[^}]*max-height: max\(200px, calc\(100vh - 200px\)\)/, 'the card height follows the window');
assert.match(css, /\[data-question-key\] > section \{[^}]*overflow-y: auto/, 'the card scrolls: the question and the answers together');
assert.match(css, /\[data-question-scroll\] \{[^}]*flex: none; overflow: visible/, 'the answers box no longer scrolls alone');
assert.match(css, /> footer \{[^}]*position: sticky; bottom: 0/, 'Skip and Submit stay in view');
assert.doesNotMatch(css, /_[A-Za-z0-9]+_|plan-review/, 'no generated class names, and the plan review card is not changed');

const { setFeature } = settings.inject();
setFeature('questionFit', false);
assert.equal(styles().length, 0, 'switch off removes the style');
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { questionFit: false }, 'the off switch is stored');
setFeature('questionFit', false);
assert.equal(head.length, 0, 'a second off changes nothing');
setFeature('questionFit', true);
assert.equal(styles().length, 1, 'switch on adds it back');
setFeature('questionFit', true);
assert.equal(styles().length, 1, 'a second on adds no second style');
for (const f of effects) if (typeof f === 'function') f();
assert.equal(styles().length, 0, 'unloading the plugin removes the style');

// Without a DOM (the Host-side test runs) the feature installs nothing and does not throw.
delete globalThis.document;
plugin.apply({ effect() {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k }, slots: { inject: (n, f) => f(), register: () => () => {} } });
console.log('question-fit checks passed');
