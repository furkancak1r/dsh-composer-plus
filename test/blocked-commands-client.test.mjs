// Blocked commands and Protected files (client half, real client.js with a fake fetch): the rule store saves one list at a
// time; while a save runs, a second save (Add, Enter, a mode chip, ✕, Use the defaults), a switch change and a refresh do
// nothing, so no other answer can show over the saved list; a refused save puts the old list back with its reason; the
// Settings row shows the editor only while the feature is on; the editor uses `rule`/`block`/`ask` for Blocked commands
// and `pattern`/`all`/`write` for Protected files.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { documentElement: { lang: 'en' }, addEventListener() {}, removeEventListener() {} };
const ANCHOR = 'const isOn = (enabled, id) =>';
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__rules = { createRules, RuleList, BLOCKED_LIST, PROTECTED_LIST, BLOCKED_ROUTE, PROTECTED_ROUTE, FEATURES, OFF_BY_DEFAULT, SHOT_OF };\n    ${ANCHOR}`));
// Hooks are plain values: `draft` and `mode` are the editor's two states, in call order.
let states = []; let at = 0;
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'Fragment',
  useState: (v) => { const i = at++; if (!(i in states)) states[i] = v; return [states[i], (x) => { states[i] = x; }]; },
  useEffect() {}, useSyncExternalStore: (s, g) => g() };
mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu' } : {}));
const { createRules, RuleList, BLOCKED_LIST, PROTECTED_LIST, BLOCKED_ROUTE, PROTECTED_ROUTE, FEATURES, OFF_BY_DEFAULT, SHOT_OF } = globalThis.__rules;
const tick = () => new Promise((r) => setTimeout(r, 0));

assert.ok(FEATURES.includes('blockedCommands'), 'a FEATURES id');
assert.ok(!OFF_BY_DEFAULT.includes('blockedCommands'), 'on by default: no port, no server, no model call');
assert.equal(SHOT_OF.blockedCommands, 'blockedCommands');
assert.equal(FEATURES.indexOf('blockedCommands'), FEATURES.indexOf('protectedFiles') + 1, 'right after Protected files in Settings');

// A fake Host: a GET answers the saved state; a POST waits for `gate` (when set) and is refused when `refuse` is set.
let saved = { on: true, rules: [{ rule: 'npm publish', mode: 'block' }] };
const posts = []; const gets = []; let gate = null; let refuse = null;
globalThis.fetch = async (url, init) => {
  assert.equal(url, BLOCKED_ROUTE);
  if (init?.method !== 'POST') { gets.push(url); return Response.json(saved); }
  const body = JSON.parse(init.body); posts.push(body);
  if (gate) await gate;
  if (refuse) return Response.json({ error: refuse }, { status: 500 });
  saved = { ...saved, ...body };
  return Response.json(saved);
};
const store = createRules(BLOCKED_ROUTE, 'rules');
await store.refresh();
assert.deepEqual(store.getSnapshot(), saved);

const render = () => { at = 0; return RuleList({ store, t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k), ...BLOCKED_LIST }); };
const find = (node, test) => { if (!node || typeof node !== 'object') return undefined; if (test(node)) return node; for (const c of node.c ?? []) { const f = find(c, test); if (f) return f; } return undefined; };
const all = (node, test, out = []) => { if (!node || typeof node !== 'object') return out; if (test(node)) out.push(node); for (const c of node.c ?? []) all(c, test, out); return out; };
let tree = render();
assert.equal(tree.p['data-composer-plus-blocked'], '', 'its own marker');
assert.deepEqual(all(tree, (n) => n.t === 'code').map((n) => n.c[0]), ['npm publish']);
const input = () => find(render(), (n) => n.t === 'input');
const buttons = () => all(render(), (n) => n.t === 'button');
assert.equal(buttons().find((b) => b.c[0] === 'blocked.modeBlock' && b.p['aria-label'].startsWith('blocked.mode:')).c[0], 'blocked.modeBlock', 'a new rule starts as block');
assert.equal(all(tree, (n) => n.t === 'button' && n.c[0] === 'blocked.reset').length, 0, 'no defaults button: Blocked commands has no defaults');

// Add with the mode switched to ask first, from the Enter key.
input().p.onChange({ target: { value: '  git push --force ' } });
buttons().find((b) => b.p['aria-label']?.startsWith('blocked.mode:')).p.onClick();
let resolve; gate = new Promise((r) => { resolve = r; });
input().p.onKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: {} });
assert.deepEqual(posts.at(-1), { rules: [{ rule: 'npm publish', mode: 'block' }, { rule: 'git push --force', mode: 'ask' }] }, 'the new rule with ask first');
assert.equal(store.getSnapshot().busy, true, 'shown at once, marked busy');
// While the save runs: every entry point, the switch and a refresh do nothing.
const before = posts.length; const getsBefore = gets.length;
input().p.onChange({ target: { value: 'rm -rf' } });
input().p.onKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: {} });
for (const b of buttons()) b.p.onClick?.();
await store.save([]);
await store.setOn(false);
await store.refresh();
assert.equal(posts.length, before, 'no second save and no switch change while a save runs');
assert.equal(gets.length, getsBefore, 'no refresh over a running save');
assert.ok(buttons().every((b) => b.p.disabled === true), 'every button is disabled while it saves');
assert.equal(input().p.disabled, true);
resolve(); gate = null; await tick(); await tick();
assert.equal(store.getSnapshot().busy, undefined);
assert.deepEqual(store.getSnapshot().rules.map((r) => [r.rule, r.mode]), [['npm publish', 'block'], ['git push --force', 'ask']]);

// A mode chip and ✕ each save the whole list once.
const chips = () => all(render(), (n) => n.p?.role === 'listitem');
chips()[1].c[1].p.onClick(); await tick(); await tick();
assert.deepEqual(posts.at(-1).rules[1], { rule: 'git push --force', mode: 'block' }, 'the chip switches its mode');
chips()[0].c[2].p.onClick(); await tick(); await tick();
assert.deepEqual(posts.at(-1).rules, [{ rule: 'git push --force', mode: 'block' }], '✕ removes the rule');
assert.equal(chips()[0].c[2].p['aria-label'], 'blocked.remove:{"rule":"git push --force"}');

// A refused save puts the old list back and shows the reason; the next save works.
refuse = 'disk full';
input().p.onChange({ target: { value: 'npm publish' } });
find(render(), (n) => n.t === 'button' && n.c[0] === 'blocked.add').p.onClick(); await tick(); await tick();
assert.deepEqual(store.getSnapshot().rules, [{ rule: 'git push --force', mode: 'block' }], 'the old list');
assert.equal(store.getSnapshot().error, 'disk full');
assert.ok(find(render(), (n) => n.p?.role === 'alert').c[0].includes('blocked.failed'));
refuse = null;
await store.save([]); assert.deepEqual(store.getSnapshot().rules, []);
assert.ok(find(render(), (n) => n.t === 'span' && n.c[0] === 'blocked.none'), 'the empty note');
// A rule that is already there is not sent again.
await store.save([{ rule: 'npm publish', mode: 'block' }]);
const n = posts.length;
input().p.onChange({ target: { value: 'npm publish' } });
input().p.onKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: {} });
assert.equal(posts.length, n, 'a rule that is in the list is not saved again');
// The switch goes through when no save runs.
await store.setOn(false); assert.deepEqual(posts.at(-1), { on: false }); assert.equal(store.getSnapshot().on, false);
// No list while dsh must restart (an older Host answers 404).
globalThis.fetch = async () => new Response('', { status: 404 });
await store.refresh();
assert.equal(render(), null, 'nothing while the Host has no route');

// Protected files uses the same editor with its own fields, defaults and marker.
{
  let p = { on: true, patterns: [{ pattern: '.env*', mode: 'all' }], defaults: [{ pattern: '.env*', mode: 'all' }, { pattern: '*.pem', mode: 'all' }] };
  const sent = [];
  globalThis.fetch = async (url, init) => { assert.equal(url, PROTECTED_ROUTE); if (init?.method === 'POST') { sent.push(JSON.parse(init.body)); p = { ...p, ...JSON.parse(init.body) }; } return Response.json(p); };
  const ps = createRules(PROTECTED_ROUTE, 'patterns');
  await ps.refresh();
  states = [];
  const r = () => { at = 0; return RuleList({ store: ps, t: (k, x) => (x ? `${k}:${JSON.stringify(x)}` : k), ...PROTECTED_LIST }); };
  assert.equal(r().p['data-composer-plus-protected'], '');
  const reset = find(r(), (x) => x.t === 'button' && x.c[0] === 'protected.reset');
  reset.p.onClick(); await tick(); await tick();
  assert.deepEqual(sent.at(-1), { patterns: p.defaults }, 'Use the defaults saves the defaults');
  const chip = all(r(), (x) => x.p?.role === 'listitem')[1];
  assert.equal(chip.c[1].c[0], 'protected.modeAll'); assert.equal(chip.c[2].p['aria-label'], 'protected.remove:{"pattern":"*.pem"}');
  chip.c[1].p.onClick(); await tick(); await tick();
  assert.deepEqual(sent.at(-1).patterns[1], { pattern: '*.pem', mode: 'write' });
}
console.log('blocked commands client checks passed');
