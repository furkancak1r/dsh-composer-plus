// What's new: the GitHub star line below the release notes. It shows at most once in 30 days, never again after its link
// or "Do not ask again", comes after the notes, and makes no network call (only this dsh's own Host routes). The real client.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mem = new Map(); let failKey = null, failWrite = false;
globalThis.localStorage = {
  getItem: (k) => { if (k === failKey) throw Error('storage'); return mem.get(k) ?? null; },
  setItem: (k, v) => { if (k === failKey || (failWrite && k === STAR)) throw Error('storage'); mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } }; eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const SEEN = 'dsh-composer-plus.update.seen', STAR = 'dsh-composer-plus.whatsNew.star', REPO = 'https://github.com/furkancak1r/dsh-composer-plus';
const DAY = 864e5; let now = Date.UTC(2026, 10, 6); Date.now = () => now;
let running = '1.0.0'; const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  if (url === '/api/composer-plus.update?current=1') return new Response(JSON.stringify({ current: running, notes: { en: 'Notes.' } }));
  throw Error(`unexpected fetch ${url}`);
};
globalThis.setTimeout = (f, ms) => ({ f, ms }); globalThis.clearTimeout = () => {}; // no update check at start
const R = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useSyncExternalStore: (_, get) => get(), useEffect: () => {}, useState: (v) => [v, () => {}] };
const plugin = mod.factory((n) => (n === 'react' ? R : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: 'Modal', Button: 'Button', Input: 'Input', Switch: 'Switch' } : {}));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const start = async () => {
  const regs = new Map();
  plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k, subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
    slots: { inject: (_, f) => f(), register: (o, C) => { regs.set(o.id, { o, C }); return () => { regs.delete(o.id); }; } },
    inject: () => ({ dispose() {} }) });
  await settle();
  const seat = regs.get('whats-new');
  return { store: seat.o.inject().whatsNew, dialog: () => seat.C({ ...seat.o.inject(), t: (k) => k }) };
};
/** A start that runs `version` after `seen`: the What's new dialog opens by itself. */
const update = async (version) => { mem.set(SEEN, '0.0.1'); running = version; const s = await start(); assert.ok(s.dialog(), `${version}: the notes show`); return s; };
const line = (tree) => tree.c[1];
const part = (tree, attr) => line(tree).c.find((x) => x?.p?.[attr] !== undefined);
const link = (tree) => part(tree, 'data-composer-plus-whats-new-star-link');
const dismiss = (tree) => part(tree, 'data-composer-plus-whats-new-star-dismiss');

// 1. A fresh install opens no dialog, so no star line either.
let s = await start(); assert.equal(s.dialog(), null); assert.ok(!mem.has(STAR), 'a fresh install: nothing about the star');
// 2. The first update: the line shows after the notes, quieter, with one link to the repository.
s = await update('1.1.0'); let tree = s.dialog();
assert.ok(tree.c[0].p['data-composer-plus-whats-new'] !== undefined, 'the notes come first');
assert.equal(line(tree).p['data-composer-plus-whats-new-star'], '', 'the star line comes after the notes');
assert.equal(line(tree).c[0], 'whatsNew.star');
assert.equal(link(tree).t, 'a'); assert.equal(link(tree).p.href, REPO); assert.equal(link(tree).p.target, '_blank'); assert.equal(link(tree).p.rel, 'noopener noreferrer');
assert.equal(link(tree).c[1], 'whatsNew.starLink'); assert.equal(link(tree).c[0].p['aria-hidden'], true, 'the ★ is not read out');
assert.equal(dismiss(tree).t, 'button'); assert.equal(dismiss(tree).p.type, 'button'); assert.equal(dismiss(tree).c[0], 'whatsNew.starDismiss');
assert.equal(mem.get(STAR), String(now), 'the time it showed');
now += DAY; assert.ok(line(s.dialog()), 'a new render (a language change) keeps the line'); assert.equal(mem.get(STAR), String(now - DAY));
tree.p.onClose(); now -= DAY;
// 3. 29 days later, another update: notes without the line.
const first = now; now = first + 29 * DAY; s = await update('1.2.0'); assert.equal(line(s.dialog()), null, 'not within 30 days'); assert.equal(mem.get(STAR), String(first));
// 4. 30 days after it showed: the line comes back.
now = first + 30 * DAY; s = await update('1.3.0'); tree = s.dialog(); assert.ok(line(tree), 'again after 30 days'); assert.equal(mem.get(STAR), String(now));
// 5. The link: never again; the line stays until the dialog closes, so the browser still opens the link.
link(tree).p.onClick(); assert.equal(mem.get(STAR), 'done'); assert.ok(line(s.dialog()), 'the clicked link stays');
s.dialog().p.onClose(); now += 100 * DAY; s = await update('1.4.0'); assert.equal(line(s.dialog()), null, 'never after the link');
// 6. "Do not ask again": never again, the line goes at once, the notes stay.
mem.delete(STAR); s = await update('1.5.0'); tree = s.dialog(); dismiss(tree).p.onClick();
assert.equal(mem.get(STAR), 'done'); tree = s.dialog(); assert.equal(tree.t, 'Modal', 'the notes stay open'); assert.equal(line(tree), null, 'the line goes');
tree.p.onClose(); now += 365 * DAY; s = await update('1.6.0'); assert.equal(line(s.dialog()), null, 'never after Do not ask again');
// 7. A broken value or one more than 30 days ahead (a clock that went back) shows the line; one within 30 days waits.
for (const [value, shows] of [['x', true], ['', true], [String(now + 31 * DAY), true], [String(now + 10 * DAY), false], [String(now - 30 * DAY), true]]) {
  mem.set(STAR, value); s = await update('1.7.0'); assert.equal(Boolean(line(s.dialog())), shows, `stored ${JSON.stringify(value)}`);
}
// 8. Storage fails: the notes show, the line does not (it could not remember a "no").
failKey = STAR; s = await update('1.8.0'); tree = s.dialog(); assert.equal(tree.t, 'Modal'); assert.equal(line(tree), null, 'unreadable storage'); failKey = null;
mem.delete(STAR); failWrite = true; s = await update('1.9.0'); assert.equal(line(s.dialog()), null, 'unwritable storage'); failWrite = false;
// 9. Settings → What's new in this version follows the same rule: once in 30 days.
mem.delete(STAR); mem.set(SEEN, '2.0.0'); running = '2.0.0'; s = await start(); assert.equal(s.dialog(), null);
s.store.show(); tree = s.dialog(); assert.ok(line(tree), 'the Settings button: the line shows'); tree.p.onClose();
s.store.show(); assert.equal(line(s.dialog()), null, 'opened again the same day: no line'); s.store.close();
s.store.stopStar(true); assert.equal(s.dialog(), null, 'Do not ask again with no dialog open opens none');
// 10. No network call for the star: the page calls only this dsh's own Host routes, and the line's actions call nothing.
assert.ok(asked.includes('/api/composer-plus.update?current=1'));
assert.deepEqual(asked.filter((u) => !u.startsWith('/api/composer-plus.')), [], 'no call to GitHub or another host');
{ mem.delete(STAR); s = await update('2.1.0'); const before = asked.length; tree = s.dialog();
  link(tree).p.onClick(); mem.delete(STAR); s.store.show(); dismiss(s.dialog()).p.onClick(); await settle();
  assert.equal(asked.length, before, 'the link and Do not ask again make no call'); }
console.log('whats-new star checks passed');
