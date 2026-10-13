// Check shipped coverage and exercise the real plugin/Settings component without a dsh server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANGUAGES } from '../scripts/build-locales.mjs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const english = JSON.parse(read('./fixtures/locale-en.json'));
const packs = Object.fromEntries(LANGUAGES.map(([id]) => [id, JSON.parse(read(`../locales/${id}.json`))]));
const ids = LANGUAGES.map(([id]) => id);
let definition; globalThis.window = { __ModuleLoader__: { load: (m) => { definition = m; } } };
eval(read('../client.js'));
let state = [], refs = [], si = 0, ri = 0;
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useSyncExternalStore: (_, get) => get(),
  useState: (value) => { const i = si++; if (!(i in state)) state[i] = value; return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }]; },
  useRef: (value) => { const i = ri++; return refs[i] ??= { current: value }; },
};
const plugin = definition.factory((name) => name === 'react' ? React : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu' } : {});
const signature = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const makeLocale = (existingTr = false, failAt, warn = []) => {
  const dicts = new Map(); let catalog = [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文' }];
  if (existingTr) catalog.push({ id: 'tr', label: 'Other Turkish pack', fallback: 'en' });
  return { dicts,
    getLocale: () => ({ active: 'en', locales: catalog }),
    getSnapshot: () => ({ active: 'en', locales: catalog }), subscribe: () => () => {},
    addLanguage: (lang) => { assert.ok(!catalog.some((l) => l.id === lang.id)); catalog.push(lang); return () => { catalog = catalog.filter((l) => l !== lang); }; },
    register: (ns, language, dict) => {
      if (ns + ':' + language === failAt) throw Error('namespace collision');
      const pairs = typeof language === 'string' ? { [language]: dict } : language;
      for (const [id, entries] of Object.entries(pairs)) { assert.ok(!dicts.has(ns + ':' + id)); dicts.set(ns + ':' + id, entries); }
      return () => { for (const id of Object.keys(pairs)) dicts.delete(ns + ':' + id); };
    },
    bind: (ns) => (key) => dicts.get(ns + ':en')[key],
  };
};
function boot(locale = makeLocale()) {
  const entries = [], effects = [], writes = []; let preference = { status: 'ready', value: {} }; let nextWrite = () => true;
  const form = { getSnapshot: () => preference, subscribe: () => () => {},
    async set(field, value) { writes.push(['set', field, value]); const ok = await nextWrite(); if (ok) preference = { ...preference, value: { [field]: value } }; return ok; },
    async unset(field) { writes.push(['unset', field]); const ok = await nextWrite(); if (ok) preference = { ...preference, value: {} }; return ok; },
  };
  plugin.apply({ locale, configForms: { get: (id) => { assert.equal(id, 'locale'); return form; } },
    effect: (fn) => { effects.push(fn()); },
    slots: { inject: (_, fn) => fn(), register: (opts, Component) => { entries.push({ ...opts, Component }); return () => {}; } },
  });
  const section = entries.find((entry) => entry.id === 'composer-plus');
  const tree = section.Component({ ...section.inject(), useComposerPlusToggles: (select) => select({}), t: (key) => key });
  const language = tree.children[1];
  return { locale, form, writes, changeWrite: (fn) => { nextWrite = fn; },
    render: () => { si = ri = 0; return language.type(language.props); },
    unload: () => effects.reverse().forEach((fn) => fn?.()),
  };
}
const warnings = []; console.warn = (...args) => warnings.push(args.join(' '));
let app = boot();
// Include this plugin's own source dictionary rather than a second copied fixture.
english['dsh-composer-plus'] = app.locale.dicts.get('dsh-composer-plus:en');
const englishCount = Object.values(english).reduce((n, d) => n + Object.keys(d).length, 0);
for (const id of ids) {
  const pack = packs[id];
  assert.deepEqual(Object.keys(pack).sort(), Object.keys(english).sort(), id + ': namespace coverage');
  for (const [ns, entries] of Object.entries(english)) {
    assert.deepEqual(Object.keys(pack[ns]).sort(), Object.keys(entries).sort(), id + '/' + ns + ': all supported-version keys');
    assert.deepEqual(app.locale.dicts.get(ns + ':' + id), pack[ns], id + '/' + ns + ': embedded dictionary matches source');
    for (const [key, value] of Object.entries(entries)) {
      const translated = pack[ns][key];
      assert.equal(typeof translated, 'string'); assert.ok(translated.length > 0 || value.length === 0, id + '/' + ns + '.' + key);
      assert.deepEqual(signature(translated), signature(value), id + '/' + ns + '.' + key + ': placeholders');
      assert.equal(translated.split('\n').length, value.split('\n').length, id + '/' + ns + '.' + key + ': line breaks');
    }
  }
}
assert.equal(app.writes.length, 0, 'loading a language pack never overwrites a preference');
const menu = () => app.render().children[0].children[1];
assert.deepEqual(menu().props.items.map((x) => x.id), ['system', 'en', 'zh', ...ids]);
assert.equal(menu().props.selectedId, 'system');
assert.equal(menu().props.anchor.type, 'button', 'native Menu renders its anchor prop, not its children');
menu().props.anchor.props.onClick(); assert.equal(menu().props.open, true);
menu().props.onClose(); assert.equal(menu().props.open, false);
await menu().props.onSelect('tr'); assert.deepEqual(app.writes.at(-1), ['set', 'preference', 'tr']); assert.equal(menu().props.selectedId, 'tr');
await menu().props.onSelect('en'); assert.equal(menu().props.selectedId, 'en');
await menu().props.onSelect('zh'); assert.equal(menu().props.selectedId, 'zh');
await menu().props.onSelect('system'); assert.deepEqual(app.writes.at(-1), ['unset', 'preference']); assert.equal(menu().props.selectedId, 'system');
const before = app.writes.length; await menu().props.onSelect('missing'); assert.equal(app.writes.length, before);
let finish; app.changeWrite(() => new Promise((resolve) => { finish = resolve; }));
const first = menu().props.onSelect('tr'); await menu().props.onSelect('en'); assert.equal(app.writes.length, before + 1, 'ignore simultaneous selections');
assert.equal(menu().props.anchor.props.disabled, true); finish(true); await first;
app.changeWrite(() => false); await menu().props.onSelect('en'); assert.equal(app.render().children[1].props.role, 'alert'); assert.equal(menu().props.selectedId, 'tr', 'failed write retains accepted preference');
app.changeWrite(() => { throw Error('offline'); }); await menu().props.onSelect('en'); assert.equal(app.render().children[1].props.role, 'alert');
app.unload(); assert.equal(app.locale.dicts.size, 0); assert.deepEqual(app.locale.getLocale().locales.map((l) => l.id), ['en', 'zh']);
assert.deepEqual(warnings, []);
assert.equal(app.form.getSnapshot().value.preference, 'tr', 'unload does not erase user preference');
state = []; refs = []; app = boot(makeLocale(true));
assert.equal(app.locale.getLocale().locales.find((l) => l.id === 'tr').label, 'Other Turkish pack');
assert.ok([...app.locale.dicts.keys()].filter((key) => key.endsWith(':tr')).every((key) => key.startsWith('dsh-composer-plus:')), 'do not compete with another Turkish pack');
assert.ok(app.locale.dicts.has('conversation:es'), 'other languages still install'); app.unload();
const broken = makeLocale(false, 'conversation:fr'); state = []; refs = []; app = boot(broken);
assert.ok(![...broken.dicts.keys()].some((key) => key.endsWith(':fr')), 'a failing language is rolled back completely');
assert.ok(!broken.getLocale().locales.some((l) => l.id === 'fr') && broken.getLocale().locales.some((l) => l.id === 'de'), 'other languages are unaffected');
assert.equal(warnings.length, 1); app.unload(); assert.equal(broken.dicts.size, 0);
console.log(`locale checks passed (${ids.length} languages × ${englishCount} strings; system/override, async failure, unload, collision, placeholders)`);
