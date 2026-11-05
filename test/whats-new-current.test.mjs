// What's new for the running version, and the restart notice: a copy updated without a dsh restart (a linked or hand copy,
// Settings → Plugins) still runs the old Host. Host: the notes are read once at start, and `installedUpdate` reports a
// newer version on disk. Client: the Settings row says "restart" for it, offers the running version's notes, and the first
// start of a new version shows its notes once, whatever installed it. No network.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedUpdate, shippedNotes, apply, UPDATE_PATH } from '../index.js';

// Host: installedUpdate reads package.json and gives its version only when it is newer than the running one.
{ const dir = mkdtempSync(join(tmpdir(), 'cp-installed-'));
  const file = (text) => { const f = join(dir, `${Math.random()}.json`); writeFileSync(f, text); return f; };
  const pkg = (version) => file(JSON.stringify({ name: 'x', version }));
  assert.equal(installedUpdate(pkg('1.21.0'), '1.19.1'), '1.21.0', 'newer on disk');
  assert.equal(installedUpdate(pkg('1.19.1'), '1.19.1'), undefined, 'same version');
  assert.equal(installedUpdate(pkg('1.19.0'), '1.19.1'), undefined, 'older on disk');
  assert.equal(installedUpdate(pkg('1.20.0-beta.1'), '1.19.1'), undefined, 'a pre-release is no x.y.z');
  assert.equal(installedUpdate(pkg('1.21.0'), 'dev'), undefined, 'the running version is no x.y.z');
  assert.equal(installedUpdate(file('{broken'), '1.19.1'), undefined, 'broken JSON');
  assert.equal(installedUpdate(file('null'), '1.19.1'), undefined, 'no object');
  assert.equal(installedUpdate(join(dir, 'missing.json'), '1.19.1'), undefined, 'missing file');
  assert.equal(installedUpdate(), undefined, 'this repo: the file on disk is the running version');
  rmSync(dir, { recursive: true, force: true }); }

// Host route: the plain check has no `installed` in this repo; `?current=1` gives the notes that ship with this copy.
{ const routes = new Map(); const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('api.github.com')
    ? new Response(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/x/releases/tag/v99.0.0' })) : new Response('{}'));
  const home = mkdtempSync(join(tmpdir(), 'cp-installed-home-')); process.env.DSH_HOME = home;
  apply({ on() {}, effect() {}, connection: { fetch: { register: (r) => routes.set(r.path, r) } }, sessionController: {}, sessionQuery: {}, subprocess: {} });
  const plain = await (await routes.get(UPDATE_PATH).fetch(new Request(`http://h${UPDATE_PATH}`))).json();
  assert.equal(plain.latest, '99.0.0'); assert.ok(!('installed' in plain), 'no newer copy on disk: no installed field');
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const current = await (await routes.get(UPDATE_PATH).fetch(new Request(`http://h${UPDATE_PATH}?current=1`))).json();
  assert.deepEqual(current, { current: version, notes: shippedNotes(readFileSync(new URL('../release-notes.json', import.meta.url), 'utf8'), version) });
  globalThis.fetch = realFetch; delete process.env.DSH_HOME; await new Promise((r) => setTimeout(r, 50)); rmSync(home, { recursive: true, force: true }); }

// Client: the real client.js.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } }; eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
const SEEN = 'dsh-composer-plus.update.seen', RECORD = 'dsh-composer-plus.update.whatsNew';
let check = {}, running = '1.21.0', shipped = { en: '## Fixes\n\n- **New:** English.', tr: 'Türkçe notlar.' }; const asked = [];
let hold = null; // a promise that `?current=1` waits for (two windows at the same time)
globalThis.fetch = async (url) => {
  if (url === '/api/composer-plus.update?current=1') { asked.push(url); if (hold) await hold;
    return running === null ? new Response('not found', { status: 404 }) : new Response(JSON.stringify(shipped === null ? { current: running } : { current: running, notes: shipped })); }
  if (url === '/api/composer-plus.update') return new Response(JSON.stringify(check));
  throw Error(`unexpected fetch ${url}`);
};
globalThis.setTimeout = (f, ms) => ({ f, ms }); globalThis.clearTimeout = () => {};
let effects = [];
const R = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useSyncExternalStore: (_, get) => get(), useEffect: (f) => { effects.push(f); }, useState: (v) => [v, () => {}] };
const plugin = mod.factory((n) => (n === 'react' ? R : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: 'Modal', Button: 'Button', Input: 'Input', Switch: 'Switch' } : {}));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const start = async () => {
  const regs = new Map();
  plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k, subscribe: () => () => {}, getSnapshot: () => ({ active: 'tr' }) },
    slots: { inject: (_, f) => f(), register: (o, C) => { regs.set(o.id, { o, C }); return () => { regs.delete(o.id); }; } },
    inject: () => ({ dispose() {} }) });
  await settle();
  const seat = regs.get('whats-new'); const section = regs.get('composer-plus');
  const dialog = () => (seat === undefined ? null : seat.C({ ...seat.o.inject(), t: (k, v) => (v?.version ? `${k}:${v.version}` : k) }));
  const t = (k, v) => (v?.version ? `${k}:${v.version}` : k);
  /** The Settings update row (UpdateSettings), rendered with the section's inject; effects run (check, refresh). */
  const row = async (features = {}) => {
    const inj = section.o.inject(); effects = [];
    const tree = section.C({ ...inj, useComposerPlusToggles: (f) => f(features), setFeature: () => {}, t });
    const el = tree.c[3]; const out = () => el.t({ ...el.p });
    out(); for (const f of effects) f(); await settle(); effects = [];
    return { el, out };
  };
  return { dialog, row, inject: section.o.inject() };
};
const status = (tree) => tree.c[1].c[1];
const notesButton = (tree) => status(tree).c.find((x) => x?.t === 'F' && x.c[1]?.p?.['data-composer-plus-whats-new-open'] !== undefined)?.c[1];
const body = (tree) => [tree.c[0].p.lang, tree.c[0].c[0]];

// 1. A fresh install (no seen version): no dialog; the running version is remembered.
let s = await start(); assert.equal(s.dialog(), null, 'a fresh install shows nothing'); assert.equal(mem.get(SEEN), '1.21.0');
// 2. The same version again: nothing.
s = await start(); assert.equal(s.dialog(), null);
// 3. A new version runs (any install path; here 1.19.1 seen, 1.22.0 runs): its notes show once, in the UI language.
mem.set(SEEN, '1.19.1'); running = '1.22.0'; s = await start(); let tree = s.dialog();
assert.equal(tree.t, 'Modal'); assert.equal(tree.p.title, 'whatsNew.title:1.22.0'); assert.deepEqual(body(tree), ['tr', 'Türkçe notlar.']);
assert.equal(tree.p.footer.c[0].p.href, 'https://github.com/furkancak1r/dsh-composer-plus/releases/tag/v1.22.0');
assert.equal(mem.get(SEEN), '1.22.0'); tree.p.onClose(); assert.equal(s.dialog(), null);
s = await start(); assert.equal(s.dialog(), null, 'shown once');
// 4. The Host does not answer: the seen version stays, and the next start shows it.
mem.set(SEEN, '1.21.0'); running = null; s = await start(); assert.equal(s.dialog(), null); assert.equal(mem.get(SEEN), '1.21.0', 'no answer: the seen version stays');
running = '1.22.0'; s = await start(); assert.ok(s.dialog(), 'the next start that gets an answer shows it');
// 5. A copy that ships no notes: no dialog, the seen version moves on.
mem.set(SEEN, '1.21.0'); shipped = null; s = await start(); assert.equal(s.dialog(), null); assert.equal(mem.get(SEEN), '1.22.0');
shipped = { en: 'English.', tr: 'Türkçe notlar.' };
// 6. An older version runs than the seen one (a downgrade): nothing, the seen version stays.
mem.set(SEEN, '1.30.0'); s = await start(); assert.equal(s.dialog(), null); assert.equal(mem.get(SEEN), '1.30.0');
// 7. Two windows start at the same time: only one shows it.
{ mem.set(SEEN, '1.21.0'); let release; hold = new Promise((r) => { release = r; });
  const both = Promise.all([start(), start()]); await settle(); release(); hold = null; await settle();
  const [w1, w2] = await both; assert.equal([w1.dialog(), w2.dialog()].filter(Boolean).length, 1, 'one window shows it'); }
// 8. The install-time record shows its version once and sets the seen version, so the seen path does not show it again,
// also in a second window that starts at the same time.
{ mem.set(SEEN, '1.21.0'); mem.set(RECORD, JSON.stringify({ version: '1.22.0', notes: 'GitHub English.', url: 'https://github.com/x/releases/tag/v1.22.0' }));
  let release; hold = new Promise((r) => { release = r; });
  const both = Promise.all([start(), start()]); await settle(); release(); hold = null; await settle();
  const shown = (await both).map((w) => w.dialog()).filter(Boolean); assert.equal(shown.length, 1, 'record + seen: one dialog');
  assert.equal(shown[0].p.footer.c[0].p.href, 'https://github.com/x/releases/tag/v1.22.0', 'the record\'s link');
  assert.equal(mem.get(SEEN), '1.22.0'); assert.ok(!mem.has(RECORD));
  s = await start(); assert.equal(s.dialog(), null, 'not again'); }
// 9. A record for a newer version (restart pending) stays; nothing shows; the seen version still moves to the running one.
mem.set(SEEN, '1.22.0'); mem.set(RECORD, JSON.stringify({ version: '1.23.0', notes: 'Later.' })); s = await start();
assert.equal(s.dialog(), null); assert.equal(JSON.parse(mem.get(RECORD)).version, '1.23.0');
mem.delete(RECORD);

// Settings row: "What's new in this version" opens the running version's notes; a newer copy on disk asks for a restart.
mem.set(SEEN, '1.22.0'); s = await start();
check = { name: 'dsh-composer-plus', current: '1.19.1', latest: '1.21.0', managed: false, newer: true, url: 'https://github.com/x/releases/tag/v1.21.0', installed: '1.21.0' };
let r = await s.row(); tree = r.out();
assert.equal(status(tree).c[1], 'update.restart:1.21.0', 'a newer copy on disk: restart, with its version');
const button = notesButton(tree); assert.ok(button, 'the notes button'); assert.equal(button.c[0], 'update.whatsNew'); assert.equal(button.p['data-composer-plus-whats-new-open'], '1.22.0');
assert.equal(s.dialog(), null); button.p.onClick(); tree = s.dialog();
assert.equal(tree.p.title, 'whatsNew.title:1.22.0'); assert.deepEqual(body(tree), ['tr', 'Türkçe notlar.']);
assert.equal(tree.p.footer.c[0].p.href, 'https://github.com/furkancak1r/dsh-composer-plus/releases/tag/v1.22.0'); tree.p.onClose();
// Without `installed` (a linked copy that is not newer on disk): "manual" as before.
check = { ...check, installed: undefined }; await s.inject.updater.check(); r = await s.row(); assert.equal(status(r.out()).c[1], 'update.manual:1.21.0');
// An `installed` that is not newer than the running copy, or not x.y.z: no restart.
for (const installed of ['1.19.1', '1.0.0', 'x', 5]) { check = { ...check, installed }; await s.inject.updater.check(); r = await s.row(); assert.equal(status(r.out()).c[1], 'update.manual:1.21.0', `installed ${installed}`); }
// No notes for the running copy: no button.
shipped = null; r = await s.row(); assert.equal(notesButton(r.out()), undefined, 'no shipped notes: no button'); shipped = { en: 'English.' };
// Automatic updates off: no button and no Host call from the row.
r = await s.row(); assert.ok(notesButton(r.out()));
const before = asked.length; r = await s.row({ autoUpdate: false }); assert.equal(notesButton(r.out()), undefined, 'switched off: no button'); assert.equal(asked.length, before, 'switched off: no Host call');
// A slow older answer does not overwrite a newer one.
{ let release; hold = new Promise((x) => { release = x; }); running = '1.40.0'; s.inject.whatsNew.refresh();
  hold = null; running = '1.41.0'; s.inject.whatsNew.refresh(); await settle(); release(); await settle();
  assert.equal(s.inject.whatsNew.getRunning().version, '1.41.0', 'the newest answer wins'); }
console.log('whats-new current checks passed');
