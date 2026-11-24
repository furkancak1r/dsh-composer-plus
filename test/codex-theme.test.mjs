// Runs the real client.js apply() with a fake DOM: "Codex dark theme" (codexTheme) is off by default. Switched on, it adds
// one style element to <head>; switched off or on unload, the style goes and nothing else of the page changes. The CSS
// changes only colors, only under dsh's dark palette (body[data-ds-dark-theme]), and its text colors keep WCAG AA (4.5:1)
// on every surface of the theme. The look itself is checked in a real dsh by test/browser-codex-theme.mjs.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
// Old data: a Host-kept switch (Mobile connect) in this browser's store. The next save drops it; Codex dark theme stays.
mem.set('dsh-composer-plus.features', '{"mobileConnect":true}');
const head = [];
const el = (tag) => {
  const attrs = new Map();
  return { tag, textContent: '', setAttribute: (k, v) => attrs.set(k, v), hasAttribute: (k) => attrs.has(k), remove() { const i = head.indexOf(this); if (i >= 0) head.splice(i, 1); } };
};
globalThis.document = { createElement: el, head: { append: (node) => head.push(node) } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
eval(src);
const plugin = mod.factory((n) => (n === 'react' ? { createElement: (t, p, ...c) => ({ t, p, c }) } : {}));
const effects = []; let settings;
plugin.apply({ effect: (f) => { effects.push(f()); }, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => f(), register: (o) => { if (o.id === 'composer-plus') settings = o; return () => {}; } } });
const styles = () => head.filter((n) => n.tag === 'style' && n.hasAttribute('data-composer-plus-codex-theme'));

const list = (name) => [...src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
assert.ok(list('FEATURES').includes('codexTheme') && list('OFF_BY_DEFAULT').includes('codexTheme'), 'its own switch, off by default');
assert.equal(styles().length, 0, 'off by default: no style');
const others = head.length;

const { setFeature } = settings.inject();
setFeature('codexTheme', true);
assert.equal(styles().length, 1, 'switch on adds one style');
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { codexTheme: true }, 'the on choice is kept in this browser; a Host-kept switch is not');
setFeature('codexTheme', true);
assert.equal(styles().length, 1, 'a second on adds no second style');

const css = styles()[0].textContent;
// Every rule is under dsh's dark palette: the light palette never changes.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').split('}').map((r) => r.trim()).filter(Boolean);
for (const r of rules) for (const sel of r.slice(0, r.indexOf('{')).split(/,(?![^()]*\))/)) assert.match(sel, /body\[data-ds-dark-theme\]:not\(#cp-codex\)/, `only in the dark palette: ${sel}`);
// Only colors: no property that moves or sizes anything (a focus-ring offset and a link underline are the exceptions).
const props = [...css.matchAll(/[{;]\s*([a-z-]+)\s*:/g)].map((m) => m[1]).filter((p) => !p.startsWith('--'));
const allowed = new Set(['background-color', 'background', 'color', 'box-shadow', 'stroke', 'fill', 'outline-color', 'outline-offset', 'text-decoration-line', 'text-decoration-color', 'text-underline-offset']);
assert.deepEqual([...new Set(props.filter((p) => !allowed.has(p)))], [], 'only color properties');
assert.doesNotMatch(css, /gradient|backdrop-filter|font-|width|height|margin|padding|radius|display|position/, 'no layout, font, gradient or glow');
// The palette of the reference, and no blue left in the accents.
const token = (name) => css.match(new RegExp(`${name}:([^;}]+)`))?.[1];
assert.equal(token('--dsw-alias-bg-base'), '#141414', 'chat background');
assert.equal(token('--dsw-specific-sidebar-fill'), '#1c1c1c', 'left sidebar');
assert.match(css, /\[data-rightbar-col\][^{]*\{background-color:#181818\}/, 'right panel');
assert.equal(token('--dsw-alias-border-l2'), '#2b2b2b', 'borders');
assert.equal(token('--dsw-alias-state-business-primary'), '#eae8e4', 'the blue accent is off-white');
assert.equal(token('--dsw-alias-button-info-fill'), '#eae8e4', 'the Stop circle is off-white');
assert.equal(token('--dsw-alias-link'), '#eae8e4', 'links are off-white');
assert.match(css, /a\[href\]\{text-decoration-line:underline/, 'links keep an underline, so they stay apart from the text');
assert.match(token('--dsw-specific-sidebar-tint'), /transparent/, 'the macOS sidebar stays semi-transparent');
assert.notEqual(token('--dsw-alias-state-warn-primary'), token('--dsw-alias-state-success-primary'), 'warnings and done differ');
assert.equal(token('--dsw-alias-state-error-primary'), undefined, 'errors keep dsh red');
// WCAG AA: each text color on each surface of the theme is 4.5:1 or more.
const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// The surfaces, and the hover fills on them (rgba(255,255,255,.06) on #1c1c1c is #2a2a2a, .1 is #333).
const surfaces = ['#141414', '#181818', '#1c1c1c', '#252525', token('--dsw-specific-bubble'), '#2a2a2a', '#303030', '#333333', token('--dsw-alias-interactive-bg-hover-solid')];
for (const name of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-label-caption', '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-label']) {
  for (const bg of surfaces) assert.ok(ratio(token(name), bg) >= 4.5, `${name} ${token(name)} on ${bg}: ${ratio(token(name), bg).toFixed(2)}:1`);
}
assert.ok(ratio(token('--dsw-alias-label-on-color'), token('--dsw-alias-button-info-fill')) >= 4.5, 'the dark square on the Stop circle');
for (const name of ['--dsw-alias-interactive-bg-hover-solid', '--dsw-specific-selector', '--dsw-alias-button-ghost-active-hover']) assert.ok(ratio('#a09f9b', token(name)) >= 4.5, `secondary text on ${name} ${token(name)}`);
assert.ok(ratio(token('--dsw-alias-state-business-primary'), '#141414') >= 3, 'focus rings: 3:1 or more');
// Off-white filled buttons get an off-white ring: it must sit outside them (outline-offset 2px).
assert.match(css, /button:is\(\[class\*="_primary"\][^)]*\):focus-visible\{outline-offset:2px\}/, "dsh's off-white buttons: the ring sits outside");
assert.match(css, /:is\(\.cpi-btn,\.cpi-chip,\.cp-mem-btn,\[data-composer-plus-issue-type\]\):focus-visible\{outline-offset:2px\}/, 'our off-white buttons: the ring sits outside');
assert.doesNotMatch(css, /#(3b82f6|3b6cf6|8250df|a371f7)/i, 'no blue or violet accent');
// The Onay card's Approve button in the Damon status panel is filled with the accent (now off-white): dark text and a
// dark focus ring inside it (review 2026-11-24: white on off-white).
const ruleOf = (sel, body) => rules.some((r) => r.slice(0, r.indexOf('{')).split(/,(?![^()]*\))/).some((x) => x.trim() === sel) && r.slice(r.indexOf('{') + 1).includes(body));
assert.ok(ruleOf('body[data-ds-dark-theme]:not(#cp-codex) [data-composer-plus-todos] .cp-cs-act[data-primary]', 'color:#141414'), 'the Approve button text is dark');
assert.ok(ruleOf('body[data-ds-dark-theme]:not(#cp-codex) [data-composer-plus-todos] .cp-cs-act[data-primary]:focus-visible', 'outline-color:#141414'), 'the Approve button focus ring is dark');

setFeature('codexTheme', false);
assert.equal(styles().length, 0, 'switch off removes the style');
assert.equal(head.length, others, 'off: the page is as before');
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')), { codexTheme: false }, 'the off choice is kept');
setFeature('codexTheme', true);
for (const f of effects) if (typeof f === 'function') f();
assert.equal(styles().length, 0, 'unloading the plugin removes the style');

// Without a DOM (the Host-side test runs) the feature installs nothing and does not throw.
delete globalThis.document;
mem.set('dsh-composer-plus.features', '{"codexTheme":true}');
plugin.apply({ effect() {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k }, slots: { inject: (n, f) => f(), register: () => () => {} } });
console.log('codex-theme checks passed');
