// Settings → Composer Plus → Category filter (categoryFilter): the Category menu next to Search features shows every row
// (All, the default) or only the rows of one category. It only hides rows: no switch value changes and nothing is stored.
// Runs the real client.js Settings component.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); const writes = [];
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { writes.push(k); mem.set(k, String(v)); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } }; eval(src);
const list = (name) => [...src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
const FEATURES = list('FEATURES'); const OFF_BY_DEFAULT = list('OFF_BY_DEFAULT');
const CATEGORIES = Object.fromEntries([...src.match(/const CATEGORIES = \{([\s\S]*?)\n {4}\};/)[1].matchAll(/(\w+): \[([^\]]*)\]/g)]
  .map(([, key, ids]) => [key, [...ids.matchAll(/'(\w+)'/g)].map((m) => m[1])]));
const KEYS = ['sidebar', 'composer', 'chat', 'safety', 'agent', 'assistant', 'memory', 'app'];
assert.deepEqual(Object.keys(CATEGORIES), KEYS, 'the eight categories, in menu order');
assert.ok(FEATURES.includes('categoryFilter') && !OFF_BY_DEFAULT.includes('categoryFilter'), 'own switch, on by default');
// Each feature is in exactly one category: a new feature without a category fails here.
const all = Object.values(CATEGORIES).flat();
assert.deepEqual([...all].sort(), [...FEATURES].sort(), 'every FEATURES id is in a category, and no other id');
assert.equal(new Set(all).size, all.length, 'no feature is in two categories');

let state = [], si = 0;
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
  useState: (v) => { const i = si++; if (!(i in state)) state[i] = v; return [state[i], (x) => { state[i] = typeof x === 'function' ? x(state[i]) : x; }]; },
  useRef: (v) => ({ current: v }), useEffect: () => {}, useSyncExternalStore: (_, get) => get() };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', Menu: 'Menu' } : {}));
let C, section;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => f(), register: (o, Comp) => { if (o.id === 'composer-plus') { C = Comp; section = o; } return () => {}; } } });
const updater = { subscribe: () => () => {}, getSnapshot: () => ({ status: 'current' }), check() {} };
const calls = [];
const render = (enabled = {}) => { si = 0; return C({ useComposerPlusToggles: (f) => f(enabled), setFeature: (id, on) => calls.push([id, on]), updater, t: (k) => k }); };
const rows = (tree) => tree.c.slice(5);
const ids = (tree) => rows(tree).map((r) => r.p.key);
const checked = (tree) => Object.fromEntries(rows(tree).map((r) => [r.p.key, r.c[2].p.checked]));
const menu = (tree) => tree.c[1].c[2];
const pick = (tree, id) => menu(tree).p.onSelect(id);

// Default: the menu sits in the search row after the On/off group, All is picked, every row shows.
const enabled = { planToggle: false, mobileConnect: true };
let tree = render(enabled);
const before = checked(tree);
assert.equal(menu(tree).t, 'Menu'); assert.equal(menu(tree).p.selectedId, 'all');
assert.deepEqual(menu(tree).p.items.map((i) => [i.id, i.label]), [['all', 'settings.filterAll'], ...KEYS.map((k) => [k, `settings.category.${k}`])]);
// Keyboard and screen reader: a real button that opens dsh's menu; its visible text ("Category" + the picked name) is its name.
const anchor = menu(tree).p.anchor;
assert.equal(anchor.t, 'button'); assert.equal(anchor.p.type, 'button'); assert.equal(anchor.p['aria-haspopup'], 'menu'); assert.equal(anchor.p['aria-expanded'], false);
assert.equal(anchor.p['aria-label'], undefined, 'no aria-label that hides the picked category');
assert.deepEqual([anchor.c[0].c[0], anchor.c[2].c[0]], ['settings.category', 'settings.filterAll']);
anchor.p.onClick(); assert.equal(menu(render(enabled)).p.open, true, 'the button opens the menu');
menu(render(enabled)).p.onClose(); assert.equal(menu(render(enabled)).p.open, false, 'Esc or a click outside closes it');
tree = render(enabled);
assert.deepEqual(ids(tree), FEATURES, 'All shows every feature row, in Settings order');
assert.ok(tree.c[2] !== null && tree.c[3] !== null, 'All shows the language and update rows');

// A category: only its rows, in Settings order; the language and update rows only under App, devices and backup.
for (const key of KEYS) {
  pick(tree, key); tree = render(enabled);
  assert.equal(menu(tree).p.selectedId, key); assert.equal(menu(tree).p.open, false, 'picking closes the menu');
  assert.equal(menu(tree).p.anchor.c[2].c[0], `settings.category.${key}`, 'the button shows the picked category');
  assert.deepEqual(ids(tree), FEATURES.filter((id) => CATEGORIES[key].includes(id)), `${key}: only its rows`);
  assert.equal(tree.c[2] !== null && tree.c[3] !== null, key === 'app', `${key}: language and update rows`);
  // The filter does not change any value: each shown switch shows the same state as under All.
  for (const [id, on] of Object.entries(checked(tree))) assert.equal(on, before[id], `${key}/${id}: the switch keeps its value`);
}
pick(tree, 'not-a-category'); tree = render(enabled);
assert.equal(menu(tree).p.selectedId, 'app', 'an unknown id changes nothing');

// With the On/off filter and the search: all three apply together.
pick(tree, 'composer'); tree = render(enabled);
tree.c[1].c[1].c.find((b) => b.p['data-composer-plus-filter'] === 'off').p.onClick(); tree = render(enabled);
assert.deepEqual(ids(tree), FEATURES.filter((id) => CATEGORIES.composer.includes(id) && (OFF_BY_DEFAULT.includes(id) ? enabled[id] !== true : enabled[id] === false)),
  'Composer and queue + Off: the switched-off composer rows only');
tree.c[1].c[1].c.find((b) => b.p['data-composer-plus-filter'] === 'all').p.onClick();
tree.c[1].c[0].p.onChange({ target: { value: 'zzzz' } }); tree = render(enabled);
assert.deepEqual(ids(tree), []); assert.equal(tree.c[4].p.role, 'status', 'no match: the empty notice');
tree.c[1].c[0].p.onChange({ target: { value: '' } });
pick(render(enabled), 'all'); tree = render(enabled);
assert.deepEqual(ids(tree), FEATURES, 'All again shows every row');
assert.deepEqual(checked(tree), before, 'after all the filtering every switch has its first value');

// A switch under a category still writes only its own feature; picking a category writes nothing.
pick(tree, 'safety'); tree = render(enabled);
calls.length = 0;
rows(tree).find((r) => r.p.key === 'approveButton').c[2].p.onChange(false);
assert.deepEqual(calls, [['approveButton', false]], 'the switch writes its feature only');
calls.length = 0; writes.length = 0;
for (const key of [...KEYS, 'all']) { pick(render(enabled), key); render(enabled); }
assert.deepEqual(calls, [], 'picking a category switches no feature'); assert.deepEqual(writes, [], 'and stores nothing');

// The filter's own switch: off removes the menu and shows every row, whatever was picked.
pick(render(enabled), 'memory');
tree = render({ ...enabled, categoryFilter: false });
assert.equal(menu(tree), null, 'no menu while its switch is off');
assert.deepEqual(ids(tree), FEATURES, 'every row shows');
assert.ok(tree.c[2] !== null && tree.c[3] !== null);
// The switch is a browser setting: on by default, stored only when off, and it installs nothing to remove.
const { setFeature, hooks } = section.inject();
assert.equal(hooks.composerPlusToggles.getSnapshot().categoryFilter, undefined, 'on by default (nothing stored)');
setFeature('categoryFilter', false);
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { categoryFilter: false });
setFeature('categoryFilter', true);
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), {});
console.log(`category filter checks passed (${FEATURES.length} rows in ${KEYS.length} categories)`);
