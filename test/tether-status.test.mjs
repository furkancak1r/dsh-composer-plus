// Damon's Durum (status) panel in Tether, the same as the Mac (CI has no Swift: this checks the shared table and the
// contract in the Swift source; the behavior has XCTests in tether/ios/Tests, testStatusPanelMatchesTheMac).
// - test/fixtures/status-panel.json is client.js statusParts: one table for the web panel and Tether's statusView.
// - The phone reads the web panel's own route (GET /plus/assistant-todos, read only: PLUS has no POST for it), only
//   behind plus.contains("assistant-todos"), with the Mac's Composer Plus language (lang) for the tasks' result lines.
// - The to-do texts, reasons, results and summary lines are data: the phone shows them with Text(verbatim:) only.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { PLUS } from '../tether/gateway/server.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const src = read('client.js'), core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
eval(src.replace(ANCHOR, `globalThis.__ts = { statusParts, TODO_OVERDUE_MS };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const { statusParts, TODO_OVERDUE_MS } = globalThis.__ts;

// One table for both apps: the web panel's grouping.
const { cases } = JSON.parse(read('test/fixtures/status-panel.json'));
for (const c of cases) {
  const p = statusParts(c.data, c.now);
  const got = {
    groups: p.groups.map((g) => ({ owner: g.owner, ids: g.items.map((i) => i.id), waiting: g.waiting })),
    overdue: [...p.overdue].sort(), live: p.live.map((t) => t.id), ended: p.ended.map((t) => t.id),
    outage: p.outage === null ? null : { at: p.outage.at, resumed: [...p.outage.resumed].sort(), others: p.outage.others },
    summaryAt: p.summary?.at ?? null, lines: p.lines,
  };
  assert.deepEqual(got, c.want, c.name);
}
assert.ok(cases.length >= 8, 'the table covers groups, overdue, tasks, outage and summary');

// The same limit in Tether.
assert.ok(core.includes(`let todoOverdue: TimeInterval = ${TODO_OVERDUE_MS / 1000}\n`), 'the same overdue limit as TODO_OVERDUE_MS');

// The route: read only, on the allowlist, behind its gate, with the Mac's language.
assert.deepEqual(PLUS.get('assistant-todos'), ['GET'], 'the phone only reads the panel');
assert.match(core, /plusCall\("assistant-todos", query: q\)/, 'the phone reads the web panel\'s route');
assert.match(core, /guard plus\.contains\("assistant-todos"\)/, 'only when the Mac\'s gateway has the route');
assert.match(core, /if let l = macLang \{ q\["lang"\] = l \}/, 'the tasks\' result lines in the Mac\'s language');
assert.match(ui, /private var damon: Bool \{ c\.current != nil && c\.current == c\.assistantId \}/);
// Furkan (2026-11-24): the cards covered the Damon chat. The chat screen shows no card deck; the Approve button is under
// the reply as in every chat (ApproveButtons, test/tether-approve.test.mjs), and the Status sheet opens from the title menu.
const conv = ui.slice(ui.indexOf('struct ConversationView: View'), ui.indexOf('struct ApproveButtons: View'));
assert.doesNotMatch(conv, /CardDeck\(/, 'no card deck on the chat screen');
assert.doesNotMatch(conv, /damonChat/, 'the Damon chat keeps the Approve button under the reply');
assert.match(conv, /default: lineRow\(row, findIndex, hits\.count, approval: approval, read: read\)/, 'every chat passes the approval to its rows');
assert.match(conv, /if damon, c\.plus\.contains\("assistant-todos"\) \{ Button \{ showStatus = true \} label: \{ Label\(String\(localized: "status\.title"/, 'the Status sheet: Damon chat title menu');
assert.match(conv, /\.sheet\(isPresented: \$showStatus\) \{ if let id = c\.current \{ StatusSheet\(sessionId: id\) \} \}/);

// Data stays data: the sheet shows the Mac's texts verbatim (no Markdown, no localization lookup).
const sheet = ui.slice(ui.indexOf('struct StatusSheet: View'), ui.indexOf('// END StatusSheet'));
assert.ok(sheet.length > 500, 'StatusSheet is in UI.swift');
for (const field of ['i.text', 'w.reason', 't.title', 'r', 'p.title', 'line', 'ch.title', 'cm.subject']) {
  assert.ok(sheet.includes(`Text(verbatim: ${field})`), `${field} is shown verbatim`);
}
assert.doesNotMatch(sheet, /Markdown\(|LocalizedStringKey\((i|t|p|w)\./, 'no Markdown or localization of the Mac\'s texts');
console.log(`tether status: ${cases.length} shared cases, read-only route, data shown verbatim`);
