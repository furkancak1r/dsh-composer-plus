// Tether's tab bar (2026-11-09): the Assistant took the slot of the Agents tab, the Agents screen is gone, and Tether opens
// on the Assistant. CI has no Swift, so this checks the contract in the source; the behavior has XCTests
// (tether/ios/Tests: testTabs, testOpenFromOtherTab, testAdoptKeepsNotify, testAssistantStatusAndMark).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { RPC, PLUS } from '../tether/gateway/server.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
const body = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, `source has ${head}`); return src.slice(i, src.indexOf('\n    }\n', i)); };

// The tab bar: Sessions, Assistant (the slot of the old Agents tab), Settings, in this order. No Agents tab or screen.
const root = body(ui, 'TabView(selection: $c.tab)');
const order = [...root.matchAll(/(\w+)\(\)\.tabItem \{ Label\("(\w+)"[^\n]*\.tag\(Client\.Tab\.(\w+)\)/g)].map((m) => m.slice(1));
assert.deepEqual(order, [['SessionsView', 'Sessions', 'sessions'], ['AssistantTab', 'Assistant', 'assistant'], ['SettingsView', 'Settings', 'settings']]);
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
