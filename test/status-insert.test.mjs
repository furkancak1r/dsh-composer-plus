// → (Write in the message box) of the Durum (status) panel: the text that a row puts into the composer.
// - test/fixtures/status-insert.json is one table for client.js statusInsert and Tether's Core.swift statusInsert (its
//   XCTest reads the same table): an item of the user gives the hand-over sentence, an item of the assistant, a task and
//   a project give their data, one field per line, in the UI language, never an id.
// - Append: draftTodo puts the text after the draft that is there, on a new line, with no empty line, and focuses the
//   composer; it sends nothing.
// - Tether has the same words (Localizable.xcstrings = locales/tr.json) and fills its own message field (no new route).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { PLUS } from '../tether/gateway/server.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
const ANCHOR = '/** Feature switches, in Settings order.';
eval(read('client.js').replace(ANCHOR, `globalThis.__si = { statusInsert, draftTodo };\n    ${ANCHOR}`));
const plugin = mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
let en;
plugin.apply({ effect: (f) => { try { f(); } catch { /* a feature that needs dsh */ } }, configForms: { get: () => ({}) },
  locale: { register: (ns, packs) => { if (ns === 'dsh-composer-plus' && packs.en) en = packs.en; return () => {}; }, bind: () => (k) => k, getSnapshot: () => ({ active: 'en' }) },
  sessions: { binding: () => ({}), scope: () => undefined, list: { getSnapshot: () => ({ byId: {} }) } },
  slots: { inject: () => () => {}, register: () => () => {} } });
const { statusInsert, draftTodo } = globalThis.__si;
const tr = JSON.parse(read('locales/tr.json'))['dsh-composer-plus'];
// dsh's own translate: {name} → params[name].
const words = (dict) => (key, params) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? String(params[name]) : m));
const span = (ms) => `${Math.round(ms / 1000)}s`;

const { now, cases, append } = JSON.parse(read('test/fixtures/status-insert.json'));
for (const c of cases) {
  for (const [lang, dict] of [['en', en], ['tr', tr]]) {
    const got = statusInsert(c.row, now, words(dict), span);
    assert.equal(got, c.want[lang], `${c.name} (${lang})`);
    const ids = [c.row.item?.id, c.row.task?.id, c.row.project?.id].filter(Boolean);
    for (const id of ids) assert.ok(!got.includes(id), `${c.name}: no id (${id}) in the text`);
  }
}
assert.ok(cases.length >= 8, 'the table covers both owners, a wait, tasks and projects');

// Append: the end of the draft, a new line before the text only when the draft has text and no line break at its end.
for (const a of append) {
  let draft = a.draft; let focused = 0; const inserts = [];
  const shell = { get snapshot() { return { draft, occurrences: [], draftRev: 7 }; }, focus: () => { focused += 1; },
    actions: { insertText: (text, at) => { inserts.push(at); draft = draft.slice(0, at.start) + text + draft.slice(at.end); return true; }, submit: () => assert.fail('nothing is sent') } };
  assert.equal(draftTodo(shell, a.text), true, a.name);
  assert.equal(draft, a.want, a.name); assert.equal(focused, 1, `${a.name}: the composer gets the focus`);
  assert.deepEqual(inserts, [{ start: a.draft.length, end: a.draft.length, draftRev: 7 }], `${a.name}: at the end, of this revision`);
}
assert.equal(draftTodo(undefined, 'x'), false, 'no composer: false (the panel shows a notice)');

// The panel: → on each to-do item, task and project row, with its own name; an item of the user keeps "Give to the
// assistant" (its text gives the item to the assistant when sent).
const src = read('client.js');
assert.match(src, /writeButton\(\{ item, overdue: parts\.overdue\.has\(item\.id\) \}, \.\.\.\(item\.owner === 'agent' \? writeLabel\(item\.text\) : \[t\('todos\.handover'/);
assert.match(src, /writeButton\(\{ task, outage: resumed\.has\(task\.id\) \? outageTime : undefined \}, \.\.\.writeLabel\(task\.title\)\)/);
assert.match(src, /writeButton\(\{ project: p, line: lineOf\(p\) \}, \.\.\.writeLabel\(p\.title\)\)/);
assert.equal(tr['status.insertShort'], 'Mesaj kutusuna yaz');

// Tether: the same words and rule, and its own message field (no new gateway route).
const core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
const table = JSON.parse(read('tether/ios/Resources/Localizable.xcstrings')).strings;
const keys = ['status.insert', 'status.insertShort', 'status.insert.item', 'status.insert.owner', 'status.insert.state', 'status.insert.reason', 'status.insert.task',
  'status.insert.result', 'status.insert.project', 'status.insert.summary', 'todos.handover', 'todos.handoverShort', 'todos.handoverMessage'];
for (const k of keys) {
  for (const [lang, dict] of [['en', en], ['tr', tr]]) {
    assert.equal(table[k]?.localizations?.[lang]?.stringUnit?.value, dict[k].replace(/\{\w+\}/g, '%@'), `Tether ${k} (${lang}) = the web UI's`);
  }
}
assert.match(core, /func statusInsert\(/, 'Tether ports statusInsert'); assert.match(core, /func appendLine\(/, 'and the append rule');
assert.match(ui, /c\.writeDraft\(statusInsert\(/, 'the sheet fills the message field');
assert.deepEqual(PLUS.get('assistant-todos'), ['GET'], 'no new gateway write route');
console.log(`status insert: ${cases.length} rows × 2 languages, ${append.length} append cases, Tether words`);
