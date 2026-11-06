// Settings → Composer Plus → On/off filter (featureFilter): All, On and Off next to Search features show every feature
// row, only the rows whose switch is on, or only the rows whose switch is off. The state of a row is its own switch value
// (isOn of the merged toggles, Host switches included). Runs the real client.js Settings component.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } }; eval(src);
const list = (name) => [...src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
const FEATURES = list('FEATURES'); const OFF_BY_DEFAULT = list('OFF_BY_DEFAULT');
assert.ok(FEATURES.includes('featureFilter'), 'featureFilter is a FEATURES id');
assert.ok(!OFF_BY_DEFAULT.includes('featureFilter'), 'on by default: no port, no server, no model call');
let state = [], si = 0;
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F',
  useState: (v) => { const i = si++; if (!(i in state)) state[i] = v; return [state[i], (x) => { state[i] = typeof x === 'function' ? x(state[i]) : x; }]; },
  useRef: (v) => ({ current: v }), useEffect: () => {}, useSyncExternalStore: (_, get) => get() };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
let C, section;
plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => f(), register: (o, Comp) => { if (o.id === 'composer-plus') { C = Comp; section = o; } return () => {}; } } });
const updater = { subscribe: () => () => {}, getSnapshot: () => ({ status: 'current' }), check() {} };
const calls = [];
const render = (enabled = {}) => { si = 0; return C({ useComposerPlusToggles: (f) => f(enabled), setFeature: (id, on) => calls.push([id, on]), updater, t: (k) => k }); };
const ids = (tree) => tree.c.slice(5).map((r) => r.p.key);
const switchOf = (tree, id) => tree.c.slice(5).find((r) => r.p.key === id).c[2];
const group = (tree) => tree.c[1].c[1];
const press = (tree, value) => group(tree).c.find((b) => b.p['data-composer-plus-filter'] === value).p.onClick();
const pressed = (tree) => group(tree).c.filter((b) => b.p['aria-pressed'] === true).map((b) => b.p['data-composer-plus-filter']);
const offIds = (extra) => FEATURES.filter((id) => OFF_BY_DEFAULT.includes(id) || extra.includes(id));

// Default: the group sits next to the search box, All is pressed, every feature row shows.
let tree = render();
assert.equal(tree.c[1].p['data-composer-plus-search'], '', 'the search row holds the filter');
assert.equal(tree.c[1].c[0].p.type, 'search', 'the search box stays first');
assert.equal(group(tree).p.role, 'group'); assert.equal(group(tree).p['aria-label'], 'settings.filter');
assert.deepEqual(group(tree).c.map((b) => [b.t, b.p.type, b.p['data-composer-plus-filter'], b.c[0]]),
  [['button', 'button', 'all', 'settings.filterAll'], ['button', 'button', 'on', 'settings.filterOn'], ['button', 'button', 'off', 'settings.filterOff']]);
assert.deepEqual(pressed(tree), ['all']);
assert.deepEqual(ids(tree), FEATURES, 'All shows every feature row');
assert.ok(tree.c[2] !== null && tree.c[3] !== null, 'All shows the language and update rows');

// Off: only the rows whose switch is off (the off-by-default features and a switched-off one).
const enabled = { planToggle: false };
press(render(enabled), 'off'); tree = render(enabled);
assert.deepEqual(pressed(tree), ['off']);
assert.deepEqual(ids(tree), offIds(['planToggle']), 'Off shows the switched-off rows only');
assert.ok(ids(tree).every((id) => switchOf(tree, id).p.checked === false), 'each shown switch is off');
assert.equal(tree.c[2], null, 'no language row: it has no switch'); assert.equal(tree.c[3], null, 'no update row: it has no switch');
assert.equal(tree.c[4], null, 'no empty notice while rows show');

// On: the other rows; together On and Off are every row.
press(tree, 'on'); tree = render(enabled);
assert.deepEqual(pressed(tree), ['on']);
assert.deepEqual(ids(tree), FEATURES.filter((id) => !offIds(['planToggle']).includes(id)), 'On shows the switched-on rows only');
assert.ok(ids(tree).every((id) => switchOf(tree, id).p.checked === true), 'each shown switch is on');
assert.ok(ids(tree).includes('featureFilter'), 'the filter row itself is on');

// The state is the switch's own value: an off-by-default feature that the Host switch turned on shows under On.
tree = render({ mobileConnect: true });
assert.ok(ids(tree).includes('mobileConnect'), 'a Host switch that is on: On');
press(tree, 'off'); tree = render({ mobileConnect: true });
assert.ok(!ids(tree).includes('mobileConnect'), 'and not Off');

// Search and filter both apply; no row gives the empty notice.
tree.c[1].c[0].p.onChange({ target: { value: 'memory' } }); tree = render();
assert.deepEqual(ids(tree), ['projectMemory'], 'search "memory" + Off: Project memory only');
tree = render({ projectMemory: true });
assert.deepEqual(ids(tree), [], 'no off row matches'); assert.equal(tree.c[4].p.role, 'status'); assert.equal(tree.c[4].c[0], 'settings.searchEmpty');
tree.c[1].c[0].p.onChange({ target: { value: '' } });

// A row that you switch while a filter is on stays (the focus stays on its switch) until you pick a filter again.
calls.length = 0; tree = render(enabled);
assert.ok(ids(tree).includes('planToggle'));
switchOf(tree, 'planToggle').p.onChange(true);
assert.deepEqual(calls, [['planToggle', true]], 'the switch still writes its feature');
tree = render({});
assert.ok(ids(tree).includes('planToggle'), 'the switched row stays under Off');
assert.equal(switchOf(tree, 'planToggle').p.checked, true, 'and shows its new state');
press(tree, 'off'); tree = render({});
assert.ok(!ids(tree).includes('planToggle'), 'picking Off again hides it');
// With All, a switch keeps nothing: a later filter shows the true state.
press(tree, 'all'); tree = render({});
switchOf(tree, 'planToggle').p.onChange(false);
press(render({ planToggle: false }), 'on'); tree = render({ planToggle: false });
assert.ok(!ids(tree).includes('planToggle'), 'On after a switch under All: hidden');

// The filter's own switch: off removes the group and shows every row, whatever was picked.
press(tree, 'off'); tree = render({ featureFilter: false });
assert.equal(group(tree), null, 'no filter group while its switch is off');
assert.deepEqual(ids(tree), FEATURES, 'every row shows');
assert.ok(tree.c[2] !== null && tree.c[3] !== null, 'the language and update rows show');
assert.equal(switchOf(tree, 'featureFilter').p.checked, false);

// The switch is a browser setting: on by default, stored only when off, and it installs nothing to remove.
const { setFeature, hooks } = section.inject();
assert.equal(hooks.composerPlusToggles.getSnapshot().featureFilter, undefined, 'on by default (nothing stored)');
setFeature('featureFilter', false);
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { featureFilter: false });
setFeature('featureFilter', true);
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), {});
console.log(`feature filter checks passed (${FEATURES.length} rows, ${offIds([]).length} off by default)`);
