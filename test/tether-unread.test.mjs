// Tether's Sessions count (the green dots) is the Mac's count. The bug (2026-11-09): with a Mac whose gateway had no
// `unread` route, Tether guessed dots from two chat lists (`justFinished`). A chat read in dsh kept its dot on the phone,
// so Tether showed 8 while dsh showed 0. CI has no Swift, so this checks the contract in the source; the behavior has
// XCTests (tether/ios/Tests: testListDots, testProjectStatus, testForkIsARootChat).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { PLUS } from '../tether/gateway/server.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
const body = (head) => { const i = core.indexOf(head); assert.ok(i >= 0, `Core.swift has ${head}`); return core.slice(i, core.indexOf('\n    }\n', i)); };

// The route the phone calls is in the gateway's allowlist, GET and POST (no new route).
assert.deepEqual(PLUS.get('unread'), ['GET', 'POST']);
// The Sessions badge counts `finished`.
assert.match(ui, /\.badge\(c\.finished\.count\)/, 'the Sessions tab shows the count of the green dots');

// No guess: the list load gets its dots only from the Mac's list.
assert.doesNotMatch(core, /justFinished|seenSessions"\)\)|Self\.snapshot\(/, 'no dots guessed from two chat lists');
const load = body('func loadSessions()');
assert.match(load, /listDots\(host: host, route: plusKnown \? plus\.contains\("unread"\) : nil, kept: finished, sessions: fresh, archived: Set\(archived\), open: onScreen\)/,
  'loadSessions takes its dots from listDots (no route: none; no answer: the last list)');
assert.match(load, /if plus\.contains\("unread"\) \{[\s\S]*plusCall\("unread"\)/, 'the Mac\'s list is asked only when the route is there');
// listDots: no route gives no dot; otherwise the Mac's list (or the last one), filtered by shownUnread.
const dots = core.slice(core.indexOf('func listDots('), core.indexOf('\n}\n', core.indexOf('func listDots(')));
assert.match(dots, /if route == false \{ return \[\] \}/);
assert.match(dots, /shownUnread\(host: host \?\? Array\(kept\), sessions: sessions, archived: archived, open: open\)/);
// DSH shows no dot on an archived chat: neither does the phone.
assert.match(core, /func shownUnread\(host: \[String\], sessions: \[Sess\], archived: Set<String> = \[\], open: String\?\)/);
assert.match(core, /!archived\.contains\(\$0\.id\)/);
assert.match(body('private func applyUnread('), /archived: Set\(archived\)/, 'a pushed list is filtered too');
assert.match(body('func onWorkspace('), /finished\.subtract\(a\)/, 'archiving a chat takes its dot away');
// `plusKnown` is the answer of the Mac on screen: set by /me, reset when another Mac goes on screen.
assert.match(body('func refreshMe()'), /plus = Set\(me\["plus"\] as\? \[String\] \?\? \[\]\); plusKnown = true/);
assert.match(core, /var activeFp: String\? \{ didSet \{[^\n]*if activeFp != oldValue \{ plusKnown = false \}/);
console.log('tether-unread: the phone counts only the Mac\'s dots ok');
