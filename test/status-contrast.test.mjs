// WCAG AA in the Damon status panel (Furkan, 2026-11-25: "renk zıtlık sorunu var düzelt"): the real panel CSS of
// client.js (TODOS_CSS, Codex dark theme) with dsh's own theme colors. Text needs 4.5:1, the header icons 3:1.
// The Kararlar count pill was white on dsh's blue: 4.2:1 in the light theme, 2.3:1 in the dark theme, 1.2:1 with Codex
// dark theme. The look in a real dsh: the measure script of the 2026-11-25 report (computed colors, all three themes).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';

globalThis.localStorage = { getItem: () => null, setItem() {} };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__css = { TODOS_CSS, CODEX_THEME_CSS, DECIDE_CSS };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const { TODOS_CSS, CODEX_THEME_CSS, DECIDE_CSS } = globalThis.__css;

// dsh's theme colors, copied from dsh-client-ui-theme design-platform.css (the same in 0.2.0-rc.2, 0.2.1-rc.2 and
// 0.2.2-rc.5; checked 2026-11-25: copy them again when dsh changes a token). dsh
// has no success-label and no error-label token: the panel's fallback colors apply there.
const common = { '--dsw-static-deepseek-600': '#4868b2', '--dsw-alias-state-warn-primary': '#f59e0b', '--dsw-alias-state-warn-label': '#dd8629', '--dsw-alias-state-success-primary': '#22c55e' };
const DSH = {
  light: { ...common, '--dsw-alias-bg-base': '#ffffff', '--dsw-alias-label-primary': '#0f1115', '--dsw-alias-label-secondary': '#61666b', '--dsw-alias-label-tertiary': '#81858c',
    '--dsw-alias-label-primary-foreground': '#ffffff', '--dsw-alias-state-business-primary': '#4176e6', '--dsw-alias-state-error-primary': '#ec1313' },
  dark: { ...common, '--dsw-alias-bg-base': '#151517', '--dsw-alias-label-primary': '#f9fafb', '--dsw-alias-label-secondary': '#cfd3d6', '--dsw-alias-label-tertiary': '#adb2b8',
    '--dsw-alias-label-primary-foreground': '#0f1115', '--dsw-alias-state-business-primary': '#7aaaff', '--dsw-alias-state-error-primary': '#f25a5a' },
};
// The rules of a CSS text, in order; a rule in @media counts as a plain rule (no color rule of the panel is in one).
const rules = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sels: sel.split(/,(?![^()]*\))/).map((s) => s.trim()),
  decls: Object.fromEntries([...body.matchAll(/(--[\w-]+|[a-z-]+)\s*:([^;]+)/g)].map(([, p, v]) => [p, v.replace(/!important/, '').trim()])) }));
const props = (css, sel) => Object.assign({}, ...rules(css).filter((r) => r.sels.includes(sel)).map((r) => r.decls));
const resolve = (value, vars) => {
  let v = String(value).trim();
  for (let n = 0; n < 20 && v.includes('var('); n++) {
    v = v.replace(/var\((--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/, (_, name, fallback) => vars[name] ?? (fallback === undefined ? 'MISSING' : fallback.trim()));
  }
  if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  assert.match(v, /^#[0-9a-f]{6}$/i, `a color: ${value} → ${v}`);
  return v;
};
const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const P = '[data-composer-plus-todos]';
const DARK = 'body[data-ds-dark-theme]:not(#cp-codex)';
const themes = {
  light: { ...DSH.light, ...props(TODOS_CSS, `body:not([data-ds-dark-theme]) ${P}`) },
  dark: { ...DSH.dark, ...props(TODOS_CSS, `body[data-ds-dark-theme] ${P}`) },
  codex: { ...DSH.dark, ...props(CODEX_THEME_CSS, DARK), ...props(TODOS_CSS, `body[data-ds-dark-theme] ${P}`) },
};
const panelBg = (theme) => (theme === 'codex' ? props(CODEX_THEME_CSS, `${DARK} ${P}`)['background-color'] : resolve(props(TODOS_CSS, P).background, themes[theme]));
assert.equal(panelBg('codex'), '#181818', 'Codex dark theme: the panel background');

// A selector's color as the theme sets it: Codex dark theme's own rule for it (DARK + the panel) comes after the panel's.
const style = (theme, sel) => ({ ...props(TODOS_CSS, `${P} ${sel}`), ...(theme === 'codex' ? props(CODEX_THEME_CSS, `${DARK} ${P} ${sel}`) : {}) });
const results = [];
for (const theme of Object.keys(themes)) {
  const vars = themes[theme]; const bg = panelBg(theme);
  const check = (what, fg, back, need) => { const r = ratio(fg, back); results.push(`${theme} ${what} ${r.toFixed(2)}`); assert.ok(r >= need, `${theme}: ${what} ${fg} on ${back} is ${r.toFixed(2)}:1, needs ${need}:1`); };
  // The Kararlar count pill (the first fix): its number on its own fill.
  const pill = style(theme, '.cp-dc-badge');
  check('Kararlar count pill', resolve(pill.color, vars), resolve(pill.background, vars), 4.5);
  // CANLI and Onayla: text on a filled accent.
  const tag = style(theme, '.cp-cs-tag');
  check('CANLI tag', resolve(tag.color, vars), resolve(tag.background, vars), 4.5);
  const onayFill = resolve(style(theme, '.cp-cs-card[data-card="onay"]')['--cp-co'], vars);
  check('Onayla', resolve(style(theme, '.cp-cs-act[data-primary]').color, vars), onayFill, 4.5);
  // Text on the panel: the list time, counts, time lines, the Kararlar row, states, errors, links.
  for (const sel of ['.cp-st-time', '.cp-td-count', '.cp-st-sub', '.cp-dc-open', '.cp-dc-open>span[aria-hidden]', '.cp-td-group', '.cp-cs-count', '.cp-cs-new', '[data-state="overdue"]', '[data-state="done"]',
    '[data-state="waiting"]', '[data-state="running"]', '.cp-td-err', '.cp-td-empty', '.cp-st-link', '.cp-st-note', '.cp-st-time[data-refreshing="true"]',
    '.cp-st-old[data-old="true"]', '.cp-st-old[data-old="true"] .cp-st-link']) {
    check(sel, resolve(style(theme, sel).color, vars), bg, 4.5);
  }
  // The previous summary waits dimmed by its color, not by opacity (up to 5 min: opacity .4 gave 1.8–3.7:1).
  assert.equal(style(theme, '.cp-st-old[data-old="true"]').opacity, undefined, `${theme}: the waiting summary has no opacity`);
  // The header icons (Get summary, Projects, Refresh, canvas, place): 3:1 for a graphic.
  check('icon buttons', resolve(style(theme, '.cp-td-btn').color, vars), bg, 3);
  // The Kararlar dialog (its own colors: it is portaled out of the panel). Its background is the page's bg-base.
  const D = 'dialog[data-composer-plus-decide]'; const A = '[data-composer-plus-decide]';
  const dvars = { ...vars, ...props(DECIDE_CSS, `${theme === 'light' ? 'body:not([data-ds-dark-theme])' : 'body[data-ds-dark-theme]'} ${D}`) };
  const dbg = resolve(props(DECIDE_CSS, D).background, dvars);
  for (const sel of ['.cp-dc-progress', '.cp-dc-x', '.cp-dc-tag', 'h3', '.cp-dc-err', '.cp-dc-btn[data-danger]']) check(`dialog ${sel}`, resolve(props(DECIDE_CSS, `${A} ${sel}`).color, dvars), dbg, 4.5);
  const send = props(DECIDE_CSS, `${A} .cp-dc-btn[data-primary]`);
  check('dialog primary button', resolve(send.color, dvars), resolve(send.background, dvars), 4.5);
}
// The old white text on dsh's blue fails in the light theme: the check would see the old pill.
assert.ok(ratio('#ffffff', DSH.light['--dsw-alias-state-business-primary']) < 4.5, 'the old pill: white on dsh blue is under 4.5:1');

// The five header icons have one size and one stroke (the canvas and place icons were text glyphs).
const head = src.slice(src.indexOf("className: 'cp-st-top'"), src.indexOf('spokenSpan),', src.indexOf("className: 'cp-st-top'")));
assert.doesNotMatch(head, /'⊞'|'⤒'|'⇥'/, 'no text glyph in the header icon row');
assert.match(src, /const lineIcon = \(d\) => React\.createElement\('svg', \{ width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1,/, 'line icons: 14 px, 1 px stroke as dsh icons');
console.log(`status-contrast: ok (${results.filter((r) => r.includes('pill')).join(', ')})`);
