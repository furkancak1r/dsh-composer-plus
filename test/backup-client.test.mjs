// Backup (client half), real client.js with fake React: the four Settings rows (Backup and Session log check on, Automatic
// backup off by default, Rescue console a Host switch); the backup store (one action at a time from every button, cancel
// goes while one runs, polling while busy and only while a panel shows, a newer answer wins, 409/404/failure notices);
// the panels (archive rows with Check, For another computer, Delete with a confirm; the doctor's damaged list and Repair
// only when a closed chat can be repaired; the automatic backup menus and next time); switching the Host switches.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const fetches = [];
let reply = async () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init) => {
  fetches.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
  const r = await reply(url, init);
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const ANCHOR = '/** Feature switches, in Settings order.';
assert.ok(SRC.includes(ANCHOR));
eval(SRC.replace(ANCHOR, `globalThis.__bk = { createBackups, BackupPanel, DoctorPanel, AutoBackupSettings, RescueFiles, backupStatus };\n    ${ANCHOR}`));
let opened = null;
const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }),
  useState: (v) => [opened ?? v, (x) => { opened = x; }], useEffect: (f) => { f(); }, useSyncExternalStore: (s, g) => g() };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Menu: 'Menu', Input: 'Input' } : {}));
const { createBackups, BackupPanel, DoctorPanel, AutoBackupSettings, RescueFiles } = globalThis.__bk;
const tick = () => new Promise((r) => setTimeout(r, 0));
const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
const find = (node, pred, out = []) => { if (node && typeof node === 'object') { if (pred(node)) out.push(node); for (const c of node.c ?? []) find(c, pred, out); } return out; };
const by = (tree, attr, value) => find(tree, (n) => n.p?.[attr] !== undefined && (value === undefined || n.p[attr] === value));
const text = (node) => (node === null || node === undefined ? '' : typeof node !== 'object' ? String(node) : (node.c ?? []).map(text).join(''));
const posts = () => fetches.filter((f) => f.init?.method === 'POST').map((f) => [f.url, f.body]);
const archive = (name, extra = {}) => ({ name, kind: 'backup', at: '2026-10-28T10:00:00.000Z', size: 1.2e9, checksum: true, masked: 3, ours: true, ...extra });

// Settings rows: the four features with their screenshot; Automatic backup off, the others on.
{
  const rows = new Map(); let comp;
  const slots = { inject: (n, f) => f(), register: (o, C) => { if (o.id === 'composer-plus') { comp = C; rows.set('section', o); } return () => {}; } };
  plugin.apply({ slots, effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k } });
  const inject = rows.get('section').inject();
  assert.ok(inject.backups && inject.autoBackup && inject.rescueSwitch);
  const tree = comp({ ...inject, useComposerPlusToggles: (f) => f(inject.hooks.composerPlusToggles.getSnapshot()), t: (k) => k });
  const keys = tree.c.slice(5).map((r) => r.p.key);
  assert.deepEqual(keys.slice(-4), ['backup', 'autoBackup', 'sessionDoctor', 'rescueConsole']);
  const sw = (id) => tree.c.slice(5).find((r) => r.p.key === id).c[2].p;
  assert.deepEqual(['backup', 'autoBackup', 'sessionDoctor', 'rescueConsole'].map((id) => sw(id).checked), [true, false, true, true]);
  for (const id of ['backup', 'autoBackup', 'sessionDoctor', 'rescueConsole']) assert.equal(tree.c.slice(5).find((r) => r.p.key === id).c[0].p.id, id, `${id} has its screenshot`);
  // The Host switches post `{on}` to their own routes; Backup and Session log check are browser switches.
  fetches.length = 0; reply = async () => ({ status: 200, body: { on: true } });
  inject.setFeature('autoBackup', true); inject.setFeature('rescueConsole', false); inject.setFeature('backup', false);
  await tick();
  assert.deepEqual(posts(), [['/api/composer-plus.auto-backup', { on: true }], ['/api/composer-plus.rescue-console', { on: false }]]);
  assert.equal(inject.hooks.composerPlusToggles.getSnapshot().backup, false);
  inject.setFeature('backup', true);
}

// The store: one action at a time from every entry; cancel goes while one runs; a newer answer wins.
{
  fetches.length = 0;
  const store = createBackups({ pollMs: 5 });
  const g = gate();
  reply = async (url, init) => (init?.method === 'POST' ? (await g.p, { status: 200, body: { archives: [], busy: { op: 'backup', files: 3, bytes: 2e6 } } }) : { status: 200, body: { archives: [archive('dsh-20261028-100000000.tar.gz')], busy: null } });
  const stop = store.watch();
  await tick();
  assert.equal(store.getSnapshot().archives.length, 1);
  const first = store.act({ action: 'backup' });
  assert.equal(store.busy(), true, 'busy while the request is out');
  // Not awaited: with a missing guard they would wait on the same gate; the list of sent requests tells.
  store.act({ action: 'verify', name: 'x' }); store.act({ action: 'scan' }); store.act({ action: 'delete', name: 'x' });
  await tick();
  assert.deepEqual(posts().map(([, b]) => b.action), ['backup'], 'one action at a time');
  g.go(); await first;
  assert.equal(store.busy(), true, 'busy while the Host runs it');
  assert.equal(store.getSnapshot().busy.files, 3);
  const g2 = gate();
  reply = async (url, init) => (init?.method === 'POST' ? { status: 200, body: { archives: [], busy: null, last: { op: 'backup', ok: false, error: 'cancelled' } } } : (await g2.p, { status: 200, body: { archives: [], busy: { op: 'backup', files: 1 } } }));
  await tick(); await new Promise((r) => setTimeout(r, 20)); // a poll is now waiting on g2
  await store.act({ action: 'cancel' });
  assert.deepEqual(posts().map(([, b]) => b.action), ['backup', 'cancel'], 'cancel goes while an action runs');
  g2.go(); await tick(); await tick();
  assert.equal(store.getSnapshot().busy, null, 'an older poll answer does not bring the busy state back');
  assert.equal(store.busy(), false);
  // Polling stops when no panel shows.
  stop();
  const before = fetches.length;
  reply = async () => ({ status: 200, body: { archives: [], busy: { op: 'scan' } } });
  await store.refresh();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetches.length, before + 1, 'no polling without a panel');
  // 409 shows why; 404 asks for a restart; a failure shows the error.
  reply = async () => ({ status: 409, body: { error: 'another backup action is running (restore, process 42)' } });
  await createBackups().act({ action: 'scan' }).then((s) => assert.match(s.notice.busy, /restore, process 42/));
  reply = async () => ({ status: 404, body: { error: 'not found' } });
  assert.equal((await createBackups().refresh()).restart, true);
  reply = async () => { throw new Error('offline'); };
  assert.equal((await createBackups().act({ action: 'backup' })).notice.failed, 'offline');
  store.stop();
}

// Backup panel: rows, buttons disabled while busy, Delete asks first, status texts, restart note.
{
  fetches.length = 0; opened = null;
  const name = 'dsh-20261028-100000000.tar.gz';
  let body = { folder: '/Users/demo/Desktop/dsh-backups', archives: [archive(name), archive('dsh-pre-upgrade-20261027-100000000.tar.gz', { kind: 'pre-upgrade', checksum: false, masked: null })], busy: null,
    last: { op: 'backup', ok: true, result: { name, size: 1.2e9, masked: 3 } } };
  reply = async () => ({ status: 200, body });
  const store = createBackups({ pollMs: 1e6 });
  await store.refresh();
  let tree = BackupPanel({ store, t });
  assert.equal(by(tree, 'data-composer-plus-backup-archive').length, 2);
  assert.match(text(by(tree, 'data-composer-plus-backup-archive', name)[0]), /backup\.masked:\{"count":3\}/);
  assert.match(text(by(tree, 'data-composer-plus-backup-archive')[1]), /backup\.kind\.pre-upgrade.*backup\.noChecksum/);
  assert.match(text(by(tree, 'data-composer-plus-backup-status')[0]), /backup\.done\.backup/);
  assert.ok(text(tree).includes('backup.restoreHow'), 'how to restore');
  by(tree, 'data-composer-plus-backup-verify', name)[0].p.onClick();
  await tick();
  assert.deepEqual(posts().at(-1), ['/api/composer-plus.backup', { action: 'verify', name }]);
  by(tree, 'data-composer-plus-backup-transfer', name)[0].p.onClick();
  await tick();
  assert.deepEqual(posts().at(-1)[1], { action: 'transfer', name });
  by(tree, 'data-composer-plus-backup-delete', name)[0].p.onClick();
  assert.equal(opened, name, 'Delete asks first');
  tree = BackupPanel({ store, t });
  assert.equal(by(tree, 'data-composer-plus-backup-delete-yes').length, 1);
  const count = posts().length;
  by(tree, 'data-composer-plus-backup-delete-yes')[0].p.onClick();
  await tick();
  assert.deepEqual(posts().slice(count), [['/api/composer-plus.backup', { action: 'delete', name }]]);
  opened = null;
  body = { ...body, busy: { op: 'backup', files: 10, bytes: 5e6 } };
  await store.refresh();
  tree = BackupPanel({ store, t });
  assert.ok(by(tree, 'data-composer-plus-backup-now')[0].p.disabled && by(tree, 'data-composer-plus-backup-verify', name)[0].p.disabled, 'buttons are off while busy');
  assert.equal(by(tree, 'data-composer-plus-backup-cancel').length, 1);
  assert.match(text(by(tree, 'data-composer-plus-backup-status')[0]), /backup\.running\.backup:\{"files":10,"size":"5\.0 MB"\}/);
  by(tree, 'data-composer-plus-backup-now')[0].p.onClick(); await tick();
  assert.notDeepEqual(posts().at(-1)[1], { action: 'backup' }, 'a click while busy sends nothing');
  reply = async () => ({ status: 404, body: {} });
  await store.refresh();
  assert.match(text(BackupPanel({ store, t })), /backup\.restart/);
  store.stop();
}

// Session log check: the damaged list; Repair only when a closed chat is damaged; the repair result.
{
  fetches.length = 0;
  let body = { archives: [], busy: null, scan: { scanned: 12, torn: 1, skipped: 0, bad: [{ id: 'chat-a', reason: 'line 3 is not JSON', open: true }] } };
  reply = async () => ({ status: 200, body });
  const store = createBackups({ pollMs: 1e6 });
  await store.refresh();
  let tree = DoctorPanel({ store, t });
  assert.match(text(by(tree, 'data-composer-plus-doctor-result')[0]), /doctor\.bad:\{"scanned":12,"count":1\}/);
  assert.match(text(tree), /chat-a: line 3 is not JSON \(doctor\.open\)/);
  assert.equal(by(tree, 'data-composer-plus-doctor-repair').length, 0, 'only an open chat is damaged: no Repair');
  body = { ...body, scan: { ...body.scan, bad: [...body.scan.bad, { id: 'chat-b', reason: 'x', open: false }] } };
  await store.refresh();
  tree = DoctorPanel({ store, t });
  by(tree, 'data-composer-plus-doctor-repair')[0].p.onClick(); await tick();
  assert.deepEqual(posts().at(-1)[1], { action: 'repair' });
  body = { archives: [], busy: null, scan: { scanned: 12, bad: [] }, last: { op: 'repair', ok: true, result: { fixed: [{ id: 'chat-b' }], missing: [], open: [] } } };
  await store.refresh();
  tree = DoctorPanel({ store, t });
  assert.match(text(tree), /doctor\.ok.*doctor\.repaired:\{"fixed":1,"missing":0\}/);
  // A backup's status does not show in the doctor, and a check's status does not show in the Backup panel.
  body = { archives: [], busy: { op: 'scan', done: 3, total: 12 } };
  await store.refresh();
  assert.match(text(DoctorPanel({ store, t })), /backup\.running\.scan:\{"done":3,"total":12\}/);
  assert.equal(by(BackupPanel({ store, t }), 'data-composer-plus-backup-status').length, 0);
  store.stop();
}

// Automatic backup settings: two menus (interval, keep) post one value; the next time; the last failure; one at a time.
{
  fetches.length = 0; opened = null;
  let state = { on: true, hours: 24, keep: 7, next: '2026-10-29T10:00:00.000Z' };
  const store = { getSnapshot: () => state, subscribe: () => () => {}, refresh() {}, post: (body, pending) => { fetches.push({ init: { method: 'POST' }, url: 'auto', body }); state = { ...state, ...pending }; } };
  let tree = AutoBackupSettings({ store, t });
  const menus = find(tree, (n) => n.t === 'Menu');
  assert.deepEqual(menus.map((m) => m.p.items.map((i) => i.id)), [['6', '12', '24', '72', '168'], ['3', '5', '7', '14']]);
  assert.ok(by(tree, 'data-composer-plus-auto-backup-next').length === 1);
  menus[0].p.onSelect('12');
  menus[1].p.onSelect('3');
  assert.deepEqual(posts(), [['auto', { hours: 12 }]], 'one setting at a time');
  state = { ...state, busy: undefined, failed: { at: 'x', message: 'disk full' } };
  tree = AutoBackupSettings({ store, t });
  assert.match(text(tree), /autoBackup\.failedAt:\{"error":"disk full"\}/);
  state = { restart: true };
  assert.equal(AutoBackupSettings({ store, t }), null);
}

// Rescue console: the files in the folder, or that they come with the next backup.
{
  const store = (s) => ({ getSnapshot: () => s, subscribe: () => () => {} });
  assert.match(text(RescueFiles({ store: store({ on: true, files: ['composer-plus-rescue.mjs', 'Composer Plus Rescue.command'] }), t })), /rescueConsole\.files/);
  assert.match(text(RescueFiles({ store: store({ on: true, files: [] }), t })), /rescueConsole\.none/);
  assert.equal(RescueFiles({ store: store({ on: false, files: [] }), t }), null);
}
console.log('backup client checks passed');
