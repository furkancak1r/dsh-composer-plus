// Tether's tab bar (2026-11-09): the Assistant took the slot of the Agents tab, the Agents screen is gone, and Tether opens
// on the Assistant. CI has no Swift, so this checks the contract in the source; the behavior has XCTests
// (tether/ios/Tests: testTabs, testOpenFromOtherTab, testAdoptKeepsNotify, testAssistantStatusAndMark).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { RPC, PLUS } from '../tether/gateway/server.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
const body = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, `source has ${head}`); return src.slice(i, src.indexOf('\n    }\n', i)); };

// The tab bar: Sessions, Damon (the assistant, in the slot of the old Agents tab), Settings, in this order. No Agents tab
// or screen. The assistant's tab has its fixed name (`assistantName`, the Host's ASSISTANT_NAME: test/tether-approve.test.mjs).
const root = body(ui, 'TabView(selection: $c.tab)');
const order = [...root.matchAll(/(\w+)\(\)\.tabItem \{ Label\(("\w+"|assistantName)[^\n]*\.tag\(Client\.Tab\.(\w+)\)/g)].map((m) => m.slice(1));
assert.deepEqual(order, [['SessionsView', '"Sessions"', 'sessions'], ['AssistantTab', 'assistantName', 'assistant'], ['SettingsView', '"Settings"', 'settings']]);
assert.doesNotMatch(ui, /AgentsView|Label\("Agents"|navigationTitle\("Agents"\)/, 'no Agents tab or screen');
// Tether opens on the Assistant: at each start and after each pairing. The tab is not saved, so no old saved value (the
// Agents tab) can open a removed screen.
assert.ok(core.includes('enum Tab: CaseIterable { case sessions, assistant, settings }'), 'the tab order: Sessions, Assistant, Settings');
assert.ok(core.includes('@Published var tab = Tab.assistant\n'), 'Tether starts on the Assistant');
assert.match(body(core, 'func adopt('), /tab = \.assistant/);
assert.match(body(core, 'func open(_ sid: String)'), /path = \[sid\]; tab = \.sessions/, 'a chat opens on the Sessions stack');
assert.doesNotMatch(core + ui, /forKey: "(tab|lastTab|selectedTab)"|AppStorage\("(tab|lastTab|selectedTab)"\)|SceneStorage/, 'the tab is not saved');
// The Assistant tab opens the Mac's assistant chat with the old path (GET /plus/assistant), only when the Mac's gateway has
// the route (an older gateway answers 403 to each call).
const at = ui.indexOf('struct AssistantTab: View'); assert.ok(at >= 0, 'UI.swift has AssistantTab');
const tab = ui.slice(at, ui.indexOf('\n}\n', at));
assert.match(tab, /\.task\(id: ready && c\.plus\.contains\("assistant"\)\)/);
assert.match(tab, /guard c\.tab == \.assistant, c\.state == \.connected, c\.plus\.contains\("assistant"\) else \{ return \}/);
assert.match(tab, /try await c\.openAssistant\(\)/);
assert.match(tab, /\.task\(id: c\.state == \.connected && !c\.plusKnown\) \{[\s\S]*await c\.refreshMe\(\)/, 'a failed /me is asked again, not an endless spinner');
assert.match(body(core, 'func openAssistant()'), /plusCall\("assistant"\)/);
assert.deepEqual(PLUS.get('assistant'), ['GET']);
// The Sessions toolbar has no Assistant button now: the tab is the way in.
assert.doesNotMatch(body(ui, 'struct SessionsView: View'), /openAssistant/);

// Damon's chat has no Back (2026-11-18): Main menu (☰) goes to Sessions, and the Mac switch next to it opens the
// other Mac's Damon chat (`openDamon`: switchMac, then the Damon tab). The other chats keep Back. XCTest: testOpenDamonOnOtherMac.
const conv = ui.slice(ui.indexOf('struct ConversationView: View'), ui.indexOf('\n}\n', ui.indexOf('struct ConversationView: View')));
assert.match(conv, /private var damon: Bool \{ c\.current != nil && c\.current == c\.assistantId \}/);
assert.match(conv, /\.navigationBarBackButtonHidden\(damon\)/);
assert.match(conv, /if damon \{\s*ToolbarItemGroup\(placement: \.topBarLeading\) \{\s*Button \{ c\.path = \[\] \} label: \{ Image\(systemName: "line\.3\.horizontal"\) \}\.accessibilityLabel\("Main menu"\)\s*MacPicker\(damon: true\)/);
assert.match(tab, /MacPicker\(damon: true\)/, 'the Damon tab (Not connected, Assistant off) switches Macs the same way');
assert.match(ui, /private func pick\(_ fp: String\) \{ if damon \{ c\.openDamon\(on: fp\) \} else \{ c\.switchMac\(fp\) \} \}/);
assert.match(body(core, 'func openDamon('), /guard fp != activeFp, pairings\.contains\(where: \{ \$0\.fp == fp \}\) else \{ return \}\s*switchMac\(fp\)\s*tab = \.assistant/);

// Improve prompt shows its text before Send: every async write of the message field (the improvement, its Undo, a sheet's
// text, a send) goes through `put`, which makes a new field (`.id(field)`). A focused field can keep the old text on screen
// (pending autocorrection or input method text), and Send then sends a text that was not shown. XCTest: testPutShowsNewText.
assert.match(conv, /private func put\(_ t: String, focus: Bool = false\) \{\s*let keep = focused \|\| focus\s*text = t; field \+= 1\s*if keep \{ DispatchQueue\.main\.async \{ focused = true \} \}/);
assert.match(conv, /TextField\([^\n]*text: \$text, axis: \.vertical\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*\.id\(field\)/);
const wand = conv.slice(conv.indexOf('@ViewBuilder private var improveButton'), conv.indexOf('/// ↶ on your own messages'));
assert.match(wand, /put\(better\); improved = \(draft, better\)/);
assert.match(wand, /put\(u\.before\); improved = nil/);
assert.doesNotMatch(wand, /\btext = /, 'the wand writes the field only through put');
assert.match(conv, /\.onChange\(of: c\.draftPushed\) \{ put\(c\.draft\(c\.current\), focus: true\) \}/);
assert.match(conv, /func send\(\) \{[^]*?put\(""\); images = \[\]/);
// The prediction row (Furkan's screenshot, 2026-11-18: the improved-looking text stayed in the row above an empty field)
// and every other app write go through put too; only the first read of the draft writes `text` itself.
assert.match(conv, /Button \{ put\(p\.text, focus: true\); c\.prediction = nil \}/);
assert.deepEqual([...conv.matchAll(/(?:\{ |; |^\s*)text (?:=|\+=) /gm)].length, 2, 'text is written only in onAppear and in put');
// Damon's words: the empty field says Ask Damon and the line under the composer says Damon, not the folder (~/Assistant).
assert.match(conv, /damon \? "Ask \\\(assistantName\)" : "Ask DeepSeek"/);
assert.match(conv, /let folder = damon \? assistantName : c\.currentSess\.map/);

// The RPCs that only the Agents screen used are not allowed now; the chat's goal, preset, permission and command RPCs
// stay. Each RPC that Tether calls by name is in the allowlist.
for (const m of ['subagents/prompt', 'subagents/interruptByParent', 'skills/list']) {
  assert.ok(!RPC.has(m), `${m} is not allowed (only the Agents screen used it)`);
  assert.ok(!core.includes(`"${m}"`), `Tether does not call ${m}`);
}
for (const m of ['goals/get', 'goals/create', 'goals/edit', 'goals/clear', 'agentPresets/list', 'agentPresets/select', 'permissionPresets/catalog', 'commands/list', 'commands/execute']) assert.ok(RPC.has(m), `${m} stays`);
const called = [...new Set([...core.matchAll(/rpc\("([^"]+)"\s*[,)]/g)].map((m) => m[1]))].filter((m) => !m.startsWith('$'));
assert.ok(called.length >= 20, `found ${called.length} RPC calls`);
for (const m of called) assert.ok(RPC.has(m), `Tether calls ${m}: it is in RPC`);
console.log('tether-assistant-tab: Assistant in the Agents slot, Tether opens on it, Agents removed ok');
