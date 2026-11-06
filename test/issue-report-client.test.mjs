// Report an issue, client half: the store (one action at a time from every entry point, a closed panel drops a later
// draft, a running open keeps the panel, a repeat shows the earlier issue, a failure offers GitHub's own page), the panel
// (type chips, keys, which copy shows it), the Settings button and the feature switch (menu item and overlay go).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
eval(src.replace('function IssueReportButton({ report, t })', 'globalThis.__issue = { createIssueReport, IssueReportDialog, IssueReportItem, issueNewUrl, ISSUE_KINDS };\n    function IssueReportButton({ report, t })'));
const React = { createElement: (t, p, ...c) => ({ t, p: p ?? {}, c }), Fragment: 'F', useSyncExternalStore: (sub, get) => get(), useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect() {} };
mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', Modal: 'Modal', Button: 'Button', MenuItemButton: 'MenuItemButton' } : {}));
const { createIssueReport, IssueReportDialog, IssueReportItem, issueNewUrl, ISSUE_KINDS } = globalThis.__issue;
const t = (k, v) => (v === undefined ? k : `${k}:${JSON.stringify(v)}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake Host: each request waits until the test answers it.
const sent = [];
const host = (body) => new Promise((resolve) => { sent.push({ body, answer: (status, data) => resolve(new Response(JSON.stringify(data), { status })) }); });
let r = createIssueReport(host);
assert.deepEqual(ISSUE_KINDS, ['bug', 'feature', 'improvement', 'translation', 'question']);
assert.equal(r.getSnapshot().where, null);

// Nothing runs while the panel is closed or the report is empty.
await r.draft(); r.show('settings'); await r.draft(); await r.submit(); assert.equal(sent.length, 0);
r.setType('feature'); r.setType('nope'); assert.equal(r.getSnapshot().type, 'feature', 'only a known type');
r.setText('x'.repeat(5000)); assert.equal(r.getSnapshot().text.length, 4000, 'the Host\'s limit');
r.setText('  Ayarlar araması çalışmıyor  ');
// Draft: one request; every entry point waits while it runs (button, Cmd+Enter, a type chip, an edit, Open issue).
let p = r.draft(); await tick();
assert.equal(sent.length, 1); assert.deepEqual(sent[0].body, { type: 'feature', text: 'Ayarlar araması çalışmıyor' });
assert.equal(r.getSnapshot().busy, 'draft');
r.draft(); r.submit(); r.setType('bug'); r.setText('other'); r.edit({ title: 'x' }); await tick();
assert.equal(sent.length, 1, 'no second request while one runs');
assert.equal(r.getSnapshot().type, 'feature'); assert.equal(r.getSnapshot().text, '  Ayarlar araması çalışmıyor  ', 'nothing changed meanwhile');
sent[0].answer(200, { title: '[Feature request] Search', body: '### Problem\nNo hits.', model: 'm' }); await p;
assert.deepEqual([r.getSnapshot().busy, r.getSnapshot().title, r.getSnapshot().body, r.getSnapshot().model], [null, '[Feature request] Search', '### Problem\nNo hits.', 'm']);
// The user edits the draft; Open issue sends what they see.
r.edit({ title: '[Feature request] Search in Settings' });
p = r.submit(); await tick();
assert.deepEqual(sent[1].body, { title: '[Feature request] Search in Settings', body: '### Problem\nNo hits.', open: true });
assert.equal(r.getSnapshot().busy, 'open');
r.close(); assert.equal(r.getSnapshot().where, 'settings', 'a running open keeps the panel (it must end and show its link)');
r.submit(); r.draft(); await tick(); assert.equal(sent.length, 2);
sent[1].answer(200, { issue: { url: 'https://github.com/furkancak1r/dsh-composer-plus/issues/12', number: 12 } }); await p;
let s = r.getSnapshot();
assert.deepEqual([s.issue.number, s.text, s.title, s.body, s.type, s.where], [12, '', '', '', 'feature', 'settings'], 'done: the link stays, the report clears');

// A closed panel drops a draft that comes later; the next panel starts clean.
r.setText('second'); p = r.draft(); await tick(); r.close(); sent[2].answer(200, { title: 'late', body: 'late' }); await p;
s = r.getSnapshot(); assert.equal(s.where, null); assert.equal(s.title, ''); assert.equal(s.busy, null);
r.show('menu'); assert.equal(r.getSnapshot().where, 'menu'); assert.equal(r.getSnapshot().text, '');

// A failure keeps the draft, names the reason and offers GitHub's page; an edit drops the old link.
r.setText('crash'); p = r.draft(); await tick(); sent[3].answer(200, { title: '[Bug] Crash', body: 'Body' }); await p;
p = r.submit(); await tick(); sent[4].answer(409, { error: 'gh could not open the issue: To get started with GitHub CLI, please run:  gh auth login' }); await p;
s = r.getSnapshot(); assert.match(s.error, /gh auth login/); assert.equal(s.title, '[Bug] Crash');
const url = new URL(s.fallback); assert.equal(url.origin + url.pathname, 'https://github.com/furkancak1r/dsh-composer-plus/issues/new');
assert.equal(url.searchParams.get('title'), '[Bug] Crash'); assert.equal(url.searchParams.get('body'), 'Body');
r.edit({ body: 'Body 2' }); assert.equal(r.getSnapshot().fallback, null, 'the link would show the old text');
// The same text was opened already (another window, a retry): the earlier issue shows, not a failure.
p = r.submit(); await tick(); sent[5].answer(409, { error: 'this issue is already open: #12', issue: { url: 'https://github.com/furkancak1r/dsh-composer-plus/issues/12', number: 12 } }); await p;
s = r.getSnapshot(); assert.equal(s.error, null); assert.equal(s.issue.number, 12); assert.equal(s.title, '');
// An old Host (404 with no error): restart.
r.setText('x'); p = r.draft(); await tick(); sent[6].answer(404, {}); await p; assert.match(r.getSnapshot().error, /restart dsh/);

// GitHub's page: a long body is cut under the limit, with "…".
const long = issueNewUrl('T', 'é'.repeat(20000));
assert.ok(long.length <= 7000, long.length); assert.ok(new URL(long).searchParams.get('body').endsWith('…'));
assert.equal(new URL(issueNewUrl('T', 'short')).searchParams.get('body'), 'short');

// The panel: only the copy that the user opened shows; chips, keys and buttons call the store.
r = createIssueReport(host);
assert.equal(IssueReportDialog({ report: r, where: 'menu', t }), null);
r.show('menu');
assert.equal(IssueReportDialog({ report: r, where: 'settings', t }), null, 'the Settings copy stays closed');
let tree = IssueReportDialog({ report: r, where: 'menu', t });
assert.equal(tree.t, 'Modal'); assert.equal(tree.p.title, 'issue.title');
const flat = (n) => (n === null || typeof n !== 'object' ? [] : [n, ...(n.c ?? []).flatMap(flat)]);
const find = (tr, attr) => flat(tr).find((n) => n.p?.[attr] !== undefined);
const chips = flat(tree).filter((n) => n.p?.['data-composer-plus-issue-type'] !== undefined);
assert.deepEqual(chips.map((c) => c.p['data-composer-plus-issue-type']), ISSUE_KINDS); assert.equal(chips[0].p['aria-pressed'], true);
chips[3].p.onClick(); assert.equal(r.getSnapshot().type, 'translation');
const write = () => find(IssueReportDialog({ report: r, where: 'menu', t }).p.footer, 'data-composer-plus-issue-write');
assert.equal(write().p.disabled, true, 'no draft without a report');
find(tree, 'data-composer-plus-issue-text').p.onChange({ target: { value: 'Türkçe metin yanlış' } });
assert.equal(write().p.disabled, false);
const before = sent.length;
find(IssueReportDialog({ report: r, where: 'menu', t }), 'data-composer-plus-issue-text').p.onKeyDown({ key: 'Enter', metaKey: true, preventDefault() {}, nativeEvent: {} });
find(IssueReportDialog({ report: r, where: 'menu', t }), 'data-composer-plus-issue-text').p.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {}, nativeEvent: {} });
await tick(); assert.equal(sent.length, before + 1, 'Cmd/Ctrl+Enter writes the draft once');
tree = IssueReportDialog({ report: r, where: 'menu', t });
assert.equal(find(tree.p.footer, 'data-composer-plus-issue-write').p.disabled, true, 'busy');
sent.at(-1).answer(200, { title: '[Translation] Wrong text', body: 'B' }); await tick(); await tick();
tree = IssueReportDialog({ report: r, where: 'menu', t });
assert.equal(find(tree, 'data-composer-plus-issue-title').p.value, '[Translation] Wrong text');
assert.equal(find(tree.p.footer, 'data-composer-plus-issue-write').c[0], 'issue.again');
assert.equal(find(tree.p.footer, 'data-composer-plus-issue-submit').p.disabled, false);
// The menu item opens the menu copy and closes dsh's menu.
let menuOpen = true;
const item = IssueReportItem({ useMenuOpenState: () => [menuOpen, (v) => { menuOpen = v; }], report: r, t });
r.close(); item.p.onSelect(); assert.equal(menuOpen, false); assert.equal(r.getSnapshot().where, 'menu');

// Feature switch: the Settings button follows it; the menu item and the overlay go when it is off.
const live = new Map(); let next = 0;
const slots = { inject: (name, f) => { const off = f(); return () => off(); }, register: (o, C) => { const k = `${o.name}#${o.id ?? o.key}#${next++}`; live.set(k, { o, C }); return () => live.delete(k); } };
const ctx = { slots, configForms: { get: () => ({}) }, effect: () => {}, locale: { register: () => () => {}, bind: () => (k) => k },
  inject: (deps, setup) => { setup({ effect() {}, uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } }, sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
    uiWorkspace: {}, workspaces: { list: { getSnapshot: () => undefined, subscribe: () => () => {} } }, sidebarRight: {}, sidebarRightTabs: { register: () => () => {} } }); return { dispose() {} }; } };
const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', Modal: 'Modal', Button: 'Button', MenuItemButton: 'MenuItemButton' } : {}));
plugin.apply(ctx);
const ours = () => [...live.values()].filter((x) => String(x.o.id).startsWith('issue-report')).map((x) => x.o.id).sort();
assert.deepEqual(ours(), ['issue-report', 'issue-report-dialog']);
const overlay = [...live.values()].find((x) => x.o.id === 'issue-report-dialog');
assert.equal(overlay.o.name, 'shell.overlay'); assert.equal(overlay.o.inject().where, 'menu');
const section = [...live.values()].find((x) => x.o.id === 'composer-plus');
const props = section.o.inject();
assert.ok(props.issueReport, 'Settings gets the store');
const settingsTree = (enabled) => section.C({ ...props, useComposerPlusToggles: (f) => f(enabled), setFeature() {}, t });
const button = (tr) => flat(tr).find((n) => n.t?.name === 'IssueReportButton');
assert.ok(button(settingsTree({})), 'on by default: Settings shows Report an issue…');
assert.equal(button(settingsTree({ issueReport: false })), undefined, 'switched off: no button');
props.setFeature('issueReport', false);
assert.deepEqual(ours(), [], 'switched off: the menu item and the overlay go');
props.setFeature('issueReport', true); assert.deepEqual(ours(), ['issue-report', 'issue-report-dialog']);
console.log('issue report client checks passed');
