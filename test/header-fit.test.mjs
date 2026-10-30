// Runs the real client.js apply() with a fake DOM: the chat header's fit style.
// - "Branch per chat" (the ⑂ branch pill) and "Allow for this chat" (the grants chip) each add one style element to <head>,
//   keyed by the item's own marker attribute. It changes dsh's header row only while that item is in it (`:has([marker])`).
// - "Fit chat header to window" (headerFit) adds the same rules for every chat header row, also without our items.
// Each style goes when its switch goes off or the plugin unloads. The layout itself is checked in a real dsh, narrow and
// wide, by test/browser-header-fit.mjs.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const head = [];
const el = (tag) => {
  const attrs = new Map();
  return { tag, textContent: '', setAttribute: (k, v) => attrs.set(k, v), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), remove() { const i = head.indexOf(this); if (i >= 0) head.splice(i, 1); } };
};
globalThis.document = { createElement: el, head: { append: (node) => head.push(node) }, addEventListener() {}, removeEventListener() {} };
// The Host halves of the two features answer "on"; grants answer an empty list.
globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('grants') ? { grants: {}, ttlMs: 3600000 } : { on: true }) });
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
eval(src);
const plugin = mod.factory((n) => (n === 'react' ? { createElement: (t, p, ...c) => ({ t, p, c }) } : {}));
const effects = []; let settings;
const ctx = { effect: (f) => { effects.push(f()); }, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => f(), register: (o) => { if (o.id === 'composer-plus') settings = o; return () => {}; } } };
plugin.apply(ctx);
await new Promise((r) => setTimeout(r, 0)); // the Host switches answer

const fits = () => head.filter((n) => n.tag === 'style' && n.getAttribute('data-composer-plus-header-fit') !== null);
const fit = (id) => fits().find((n) => n.getAttribute('data-composer-plus-header-fit') === id);
const ids = () => fits().map((n) => n.getAttribute('data-composer-plus-header-fit')).sort();
assert.deepEqual(ids(), ['allowForChat', 'headerFit', 'worktreeChats'], 'on by default: one style per feature');
assert.ok(mod && /'questionFit', 'headerFit',/.test(src), 'headerFit is in FEATURES after questionFit');

// The rules: only dsh's header row that holds the feature's own item; title kept, options and utilities wrap.
for (const [id, marker] of [['worktreeChats', 'data-composer-plus-branch-status'], ['allowForChat', 'data-composer-plus-grants']]) {
  const css = fit(id).textContent;
  const rules = css.split('\n').filter(Boolean);
  for (const rule of rules) assert.ok(rule.startsWith(`[class*="_titleRow"]:has(> [class*="_headerUtilities"] [${marker}])`), `${id}: each rule needs the feature's own item in the header: ${rule}`);
  assert.equal(rules[0], `[class*="_titleRow"]:has(> [class*="_headerUtilities"] [${marker}]) { flex-wrap: wrap; justify-content: flex-end; row-gap: 4px; }`, `${id}: the row wraps, the next line is right-aligned`);
  assert.match(css, /> \[class\*="_crumbs"\] \{ width: 120px; flex-grow: 1; max-width: max-content; \}/, `${id}: the title keeps 120 px and grows to its own width`);
  assert.match(css, /> \[class\*="_headerActions"\] \{[^}]*flex-wrap: wrap;[^}]*min-width: 0;/, `${id}: dsh's options wrap instead of sliding over the utilities`);
  assert.match(css, /> \[class\*="_headerUtilities"\] \{ flex-shrink: 1; min-width: 0; \}/, `${id}: the utilities can get narrower (the pill shortens)`);
  assert.match(css, /\[data-composer-plus-grants\] \{ flex: none; white-space: nowrap; \}/, `${id}: the grants chip stays on one line`);
  assert.doesNotMatch(css, /position|z-index|display: none|overflow: hidden|_[A-Za-z0-9]{6}_/, `${id}: nothing hidden or covered, no full hashed class names`);
}
// headerFit: the same rules for dsh's own header row (the row that holds the title cluster), with no marker.
{
  const css = fit('headerFit').textContent;
  const rules = css.split('\n').filter(Boolean);
  const row = '[class*="_titleRow"]:has(> [class*="_titleCluster"])';
  for (const rule of rules) assert.ok(rule.startsWith(row), `headerFit: each rule is for dsh's chat header row: ${rule}`);
  assert.equal(rules[0], `${row} { flex-wrap: wrap; justify-content: flex-end; row-gap: 4px; }`, 'headerFit: the row wraps');
  assert.equal(css.replaceAll(row, 'R'), fit('worktreeChats').textContent.replaceAll('[class*="_titleRow"]:has(> [class*="_headerUtilities"] [data-composer-plus-branch-status])', 'R'), 'headerFit: the same rules as the item styles');
  assert.doesNotMatch(rules[0], /data-composer-plus/, 'headerFit: the row needs no item of ours');
  assert.doesNotMatch(css, /position|z-index|display: none|overflow: hidden/, 'headerFit: nothing hidden or covered');
}
// The markers really are on the items: the branch pill and the grants chip carry them.
assert.match(src, /'data-composer-plus-branch-status': info\.branch/, 'the branch pill has its marker');
assert.match(src, /variant: 'toolbar',\s*size: 'sm',\s*'data-composer-plus-grants': ''/, 'the grants chip has its marker');

// Each switch removes only its own style; on again adds it back once.
const { setFeature } = settings.inject();
setFeature('headerFit', false);
assert.deepEqual(ids(), ['allowForChat', 'worktreeChats'], 'Fit chat header off: its style goes, the item styles stay');
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { headerFit: false }, 'the off switch is stored in the browser');
setFeature('allowForChat', false);
assert.deepEqual(ids(), ['worktreeChats'], 'Allow for this chat off: its style goes, the branch one stays');
setFeature('allowForChat', true);
setFeature('headerFit', true);
assert.equal(fits().length, 3, 'on again');
setFeature('worktreeChats', false); // a Host switch: the client store moves at once
assert.deepEqual(ids(), ['allowForChat', 'headerFit'], 'Branch per chat off: its style goes');
setFeature('worktreeChats', true);
setFeature('worktreeChats', true);
setFeature('headerFit', true);
assert.equal(fits().length, 3, 'on again, and a second on adds no second style');
for (const f of effects) if (typeof f === 'function') f();
assert.equal(fits().length, 0, 'unloading the plugin removes every style');

// Without a DOM (the Host-side test runs) the features install no style and do not throw.
delete globalThis.document;
plugin.apply({ ...ctx, effect() {} });
console.log('header-fit checks passed');
