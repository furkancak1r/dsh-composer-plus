// Feature screenshots: Host serves only whitelisted, shipped files; the Settings thumbnail previews on hover and opens a lightbox.
import assert from 'node:assert/strict'; import { readFileSync, readdirSync } from 'node:fs';
import { apply, SHOT_PATH, SHOTS } from '../index.js';
const files = readdirSync(new URL('../assets/features/', import.meta.url)).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -5)).sort();
assert.deepEqual([...SHOTS].sort(), files, 'every listed shot ships, every shipped shot is listed');
for (const f of files) { const b = readFileSync(new URL(`../assets/features/${f}.webp`, import.meta.url)); assert.equal(b.subarray(8, 12).toString(), 'WEBP', f); assert.ok(b.length < 80 * 1024, `${f} stays small`); }
assert.ok(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).files.includes('assets/features/*.webp'), 'published with the package');
// Rule: every Settings feature row has a screenshot, and every row's image ships. Add the image with the feature.
{ const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const list = (name) => [...src.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]|\\{[^}]*\\})`))[1].matchAll(/(\w+)(?=['":])|'(\w+)'/g)];
  const features = [...src.match(/const FEATURES = \[([^\]]*)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const shotOf = Object.fromEntries([...src.match(/const SHOT_OF = \{([^}]*)\}/)[1].matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
  for (const id of features) { assert.ok(shotOf[id], `feature "${id}" has a Settings screenshot (SHOT_OF)`); assert.ok(SHOTS.includes(shotOf[id]) && files.includes(shotOf[id]), `${shotOf[id]}.webp ships and is served`); }
  void list; }
const routes = new Map();
apply({ on() {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } }, sessionController: {}, sessionQuery: {}, subprocess: {} });
const get = (q) => routes.get(SHOT_PATH).fetch(new Request(`http://h${SHOT_PATH}?${q}`));
const ok = await get('id=changesPanel'); assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/webp');
for (const q of ['id=../../package', 'id=%2E%2E%2Findex', 'id=', '', 'id=constructor', 'id=changesPanel.webp']) assert.equal((await get(q)).status, 404, q);

// Client thumbnail.
let mod; const listeners = {};
globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, innerWidth: 1280, innerHeight: 800,
  addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } };
globalThis.document = { body: 'BODY' };
eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
let state = [], refs = [], effects = [], si = 0, ri = 0;
const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F',
  useState: (v) => { const i = si++; if (!(i in state)) state[i] = v; return [state[i], (x) => { state[i] = typeof x === 'function' ? x(state[i]) : x; }]; },
  useRef: (v) => { const i = ri++; return refs[i] ??= { current: v }; }, useEffect: (f) => { effects.push(f); } };
const plugin = mod.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (el, host) => ({ portal: el, host }) } : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
let C; plugin.apply({ effect() {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k }, slots: { inject: (n, f) => f(), register: (o, Comp) => { if (o.id === 'composer-plus') C = Comp; return () => {}; } } });
si = ri = 0; const Shot = C({ useComposerPlusToggles: (f) => f({}), setFeature() {}, t: (k) => k }).c.slice(5)[0].c[0].t;
const t = (k, p) => (p?.feature ? `${k}:${p.feature}` : k);
const render = (id = 'changesPanel', ...rest) => { if (rest[0] === 'none') id = undefined; si = ri = 0; effects = []; const out = Shot({ id, title: 'Changes panel', t }); for (const f of effects) f(); return out; };
let timers = []; globalThis.setTimeout = (f) => { timers.push(f); return timers.length; }; globalThis.clearTimeout = () => { timers = []; };
let tree = render();
const thumb = tree.c[0]; assert.equal(thumb.t, 'button'); assert.equal(thumb.p['aria-label'], 'shot.openFeature:Changes panel'); assert.equal(thumb.c[0].p.alt, '', 'decorative: the button names it');
assert.equal(tree.c[1], null, 'nothing open');
let focused = 0; refs[0].current = { getBoundingClientRect: () => ({ left: 600, top: 300, bottom: 340 }), focus: () => { focused++; } };
// Hover → preview below, inside the viewport, portaled to body, not interactive.
thumb.p.onMouseEnter(); timers.shift()(); tree = render();
assert.equal(tree.c[1].host, 'BODY'); const prev = tree.c[1].portal; assert.equal(prev.p['data-composer-plus-shot-preview'], 'changesPanel');
assert.equal(prev.p.style.top, 348); assert.ok(prev.p.style.left + prev.p.style.width <= 1280 - 16); assert.equal(prev.p.style.pointerEvents, 'none');
tree.c[0].p.onMouseLeave(); tree = render(); assert.equal(tree.c[1], null, 'leaving hides the preview');
// Near the bottom the preview opens above.
refs[0].current.getBoundingClientRect = () => ({ left: 10, top: 700, bottom: 740 }); thumb.p.onFocus(); timers.shift()(); tree = render();
assert.ok(tree.c[1].portal.p.style.bottom > 0 && tree.c[1].portal.p.style.top === undefined, 'flips above near the bottom edge');
// Click → dialog; Esc closes it (captured, so Settings stays open) and returns focus.
tree.c[0].p.onClick(); tree = render(); const dlg = tree.c[1].portal;
assert.equal(dlg.p.role, 'dialog'); assert.equal(dlg.p['aria-modal'], true); assert.equal(tree.c[0].p['aria-expanded'], true);
let stopped = 0; listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped++; } }); tree = render();
assert.equal(tree.c[1], null); assert.equal(stopped, 1, 'Esc does not reach the Settings dialog'); assert.equal(focused, 1, 'focus returns to the thumbnail');
// Backdrop click closes; a click on the picture itself closes too.
tree.c[0].p.onClick(); tree = render(); const back = tree.c[1].portal; back.p.onMouseDown({ target: back, currentTarget: back }); tree = render(); assert.equal(tree.c[1], null);
tree.c[0].p.onClick(); tree = render(); tree.c[1].portal.c[0].p.onClick(); tree = render(); assert.equal(tree.c[1], null);
// Broken image or no id: no thumbnail.
state = []; refs = []; tree = render(); tree.c[0].c[0].p.onError(); assert.equal(render(), null);
state = []; refs = []; assert.equal(render(undefined, 'none'), null);
console.log(`shots checks passed (${files.length} images)`);
