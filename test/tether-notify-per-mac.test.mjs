// Tether keeps its notification settings (Send notifications, Only between these hours) on the phone, one set per paired
// Mac: the Mac on screen uses its own set, a new Mac starts with notifications off, and the one set of older builds goes
// to every paired Mac once. CI has no Swift, so this checks the contract in the source; the behavior has XCTests
// (tether/ios/Tests: testNotificationsPerMac, testNotifySplit, testNotifyAskWhileSwitching, testAdoptKeepsNotify).
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { PLUS } from '../tether/gateway/server.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
const body = (head) => { const i = core.indexOf(head); assert.ok(i >= 0, `Core.swift has ${head}`); return core.slice(i, core.indexOf('\n    }\n', i)); };

// The keys keep their old names: the split reads the one set of older builds from them.
const names = Object.fromEntries([...core.matchAll(/\b(notifyKey|hoursKey|fromKey|toKey|damonOnlyKey) = "(\w+)"/g)].map((m) => [m[1], m[2]]));
assert.deepEqual(names, { notifyKey: 'notifications', hoursKey: 'notifyHours', fromKey: 'notifyFrom', toKey: 'notifyTo', damonOnlyKey: 'notifyDamonOnly' }, 'the old key names');
assert.match(core, /static let notifyKeys = \[notifyKey, hoursKey, fromKey, toKey, damonOnlyKey\]/, 'notifyKeys lists the five settings');
// Notifications only from Damon (2026-11-24): on by default for each Mac, sent to the Mac, and the local alert keeps it.
assert.match(body('private func loadNotify()'), /notifyDamonOnly = \(mac \? d\.object\(forKey: key\(Client\.damonOnlyKey\)\) as\? Bool : nil\) \?\? true/, 'Damon only: on by default');
assert.match(body('private func notify('), /guard shouldNotify\(\), damonAllows\(sid\),/, 'the local alert keeps Damon only');
assert.match(ui, /if c\.botId != nil \{ Toggle\("Notifications only from Damon", isOn: \$c\.notifyDamonOnly\) \}/, 'the switch shows on a Mac with a Damon chat');

// Every read and write goes through the Mac's own key (macKey), never the bare key of one shared setting.
const bare = [...core.matchAll(/forKey:\s*(?:Client\.|Self\.)?(?:notifyKey|hoursKey|fromKey|toKey)\b[^\n]*/g)].map((m) => m[0]);
assert.deepEqual(bare, [], 'no bare notification key: use key(...) or macKey(...)');
// Off by default for each Mac: a Mac with no saved value reads false, and nothing registers another default.
assert.match(body('private func loadNotify()'), /notifyOn = [^\n]*bool\(forKey: key\(Client\.notifyKey\)\)/, 'notifyOn reads the Mac on screen');
assert.doesNotMatch(core + ui, /register\(defaults:/, 'no registered default turns notifications on');
assert.match(core, /@Published private\(set\) var notifyOn = false\b/, 'off before a Mac loads');

// A Mac switch loads that Mac's set; init splits the old set first.
const init = body('    init() {');
assert.ok(init.includes('splitNotify(') && init.indexOf('splitNotify(') < init.indexOf('loadNotify()'), 'init splits the old set, then loads');
assert.match(body('func switchMac('), /activeFp = fp[\s\S]*loadNotify\(\)/, 'switchMac loads the new Mac\'s set');
assert.match(body('func forget('), /loadNotify\(\)/, 'forget loads the next Mac\'s set (or the off state)');
// The iOS permission ask can outlive a Mac switch: the answer goes to the Mac that asked, not to the Mac on screen now.
assert.match(body('@discardableResult func setNotify('), /let mac = activeFp[\s\S]*macKey\(Client\.notifyKey, mac[\s\S]*activeFp == mac/, 'setNotify writes the asking Mac');
// The split runs once, copies to every paired Mac, and keeps the bare keys only for the migrated Mac.
const split = body('static func splitNotify(');
assert.match(split, /notifyPerMac/, 'a flag makes the split run once');
assert.ok(split.indexOf('removeObject') > split.indexOf('macKey(') && split.lastIndexOf('notifyPerMac') > split.indexOf('removeObject'), 'copy, then remove, then set the flag');

// Unpair and re-pair remove the Mac's notification keys with its other per-Mac keys.
assert.match(core, /static let perMacKeys = \["seenSessions", "finished", "drafts"\] \+ notifyKeys/, 'perMacKeys has the notification keys');
assert.doesNotMatch(core, /for k in \["seenSessions"/, 'no second list of per-Mac keys');
assert.ok([...core.matchAll(/for k in (?:Client|Self)\.perMacKeys/g)].length >= 2, 'adopt and forget use perMacKeys');

// Settings names the Mac that the switch is for.
assert.match(ui, /Text\("These settings are for \\\(/, 'the Notifications footer names the Mac on screen');
assert.ok('These settings are for %@ only. Each Mac has its own; a new Mac starts with them off.' in JSON.parse(read('tether/ios/Resources/Localizable.xcstrings')).strings, 'the footer is in Localizable.xcstrings');

// The setting stays on the phone: no Host route, so no PLUS entry and no plus.contains gate.
assert.deepEqual([...PLUS.keys()].filter((k) => /notif|push/.test(k)), [], 'no notification route in PLUS');
assert.doesNotMatch(core + ui, /plusCall\("(notif|push)/, 'the phone calls no notification route');
assert.match(read('tether/FEATURES.md'), /^\| notifications \| yes \| .*each paired Mac.*off by default.*\|$/m, 'FEATURES.md says per Mac, off by default');

// The cause of "Tether shows no notifications": Tether made them itself, only while iOS kept its socket (seconds after it
// left the screen), so a closed Tether got none. Now the Mac sends them through APNs. The phone gives each Mac that Mac's
// own switch and hours (the per-Mac setting decides, not a shared one) with the device token, on each change.
assert.match(body('func syncPush('), /pushBody\(on: notifyOn, token: [\s\S]*damonOnly: notifyDamonOnly, mac: pairing\?\.label, hours: notifyHours, from: notifyFrom, to: notifyTo, tz: TimeZone\.current\.identifier, reason: tokenError\)[\s\S]*call\("\/push"/, 'syncPush sends this Mac\'s settings, your name for the Mac (and why there is no token) to its gateway');
assert.match(body('func renameMac('), /if fp == activeFp \{ syncPush\(\) \}/, 'a new name goes to the Mac on screen');
assert.match(body('private func saveNotify('), /syncPush\(\)/, 'a change of the hours goes to the Mac');
assert.match(body('@discardableResult func setNotify('), /registerPush\(\)[\s\S]*syncPush\(\)/, 'the switch asks iOS for a device token and tells the Mac');
assert.match(body('func refreshMe('), /let push = me\["push"\] as\? Bool == true\n\s*if push != macPush \{ macPush = push \}[^\n]*\n\s*registerPush\(\); syncPush\(\)/, 'each connection asks iOS for the token again and sends the Mac the settings (a failed first try heals)');
assert.match(ui, /didFailToRegisterForRemoteNotificationsWithError[\s\S]*onTokenError\?\(error\.localizedDescription\)/, 'iOS\'s token error is not swallowed');
assert.match(ui, /if c\.notifyOn, c\.macPush, !c\.pushOn, let e = c\.pushError \{/, 'Settings says why notifications while Tether is closed do not work');
assert.match(body('private func notify('), /guard shouldNotify\(\), damonAllows\(sid\), !pushOn,/, 'no local notification while the Mac pushes the same one');
assert.match(body('func forget('), /unpush\(p\)/, 'unpairing stops the Mac\'s pushes');
assert.match(ui, /@UIApplicationDelegateAdaptor\(AppDelegate\.self\)/, 'iOS gives the device token to an app delegate');
assert.match(ui, /didRegisterForRemoteNotificationsWithDeviceToken[\s\S]*onToken\?\(/, 'the token goes to the Client');

// The gateway pushes the same four alerts as the app: approval, question, error and Turn finished (from the Host half).
const gw = read('tether/gateway/server.mjs'), host = read('index.js');
assert.match(gw, /path === '\/push'\) return setPush\(req, res, dev\)/, 'POST /push stores the phone\'s settings with its pairing');
assert.match(gw, /pushAll\('Approval needed', v\.request\?\.toolName, v\.agentId\)/); assert.match(gw, /pushAll\('DSH has a question', [^\n]*, v\.agentId\)/); assert.match(gw, /pushAll\('DSH error', v\.args\[1\], v\.args\[0\]\)/);
assert.match(host, /mobile\?\.push\('Turn finished', words, agent\.id\)/, 'the Host half pushes Turn finished with the reply (pushWords) when a root chat stops');
// Each alert names its Mac and project (subtitle) and the chat (body), on the Mac's push and on the phone's own one.
assert.match(gw, /alert: \{ title: words\[title\] \?\? title, subtitle, body \}/, 'the push has a subtitle');
assert.match(host, /about: chatAbout,/, 'the Host half names the chat and its project for the gateway');
assert.match(body('private func notify('), /\(c\.subtitle, c\.body\) = alertWords\(detail, session: sid\)/, 'the local alert uses alertWords');
const words = body('func alertWords(');
assert.match(words, /\[pairing\?\.title, project\]/, 'the local alert: Mac (your name for it) · project');
assert.match(words, /pushText\(detail, approval:[\s\S]*\[s\?\.title == project \? nil : s\?\.title, text\]/, 'the local alert: the chat title (not the project name twice), then the plain text');
// The rules themselves: QuietReplyTests (iOS) on test/fixtures/quiet-replies.json; here only that the turn end uses them.
assert.match(core, /let kind = reason\?\["kind"\] as\? String\n(?:\s*\/\/.*\n)*\s*let bot = current != nil && current == botId\n\s*let words: String\? = bot \? damonWords\(events, reason: kind\) : kind == "error" \? nil : [^\n]*quietTurn\(reply: r, reason: kind\)[^\n]*\n\s*if let words \{ notify\(String\(localized: "Turn finished"\), words, session: current\) \}\n\s*if words != nil \{ UINotificationFeedbackGenerator\(\)\.notificationOccurred\(\.success\) \}/, 'the local Turn finished: Damon\'s words (damonWords), other chats their reply; a quiet Damon turn gives no alert and no buzz');
// A failed turn of the open chat (review 2026-11-24): it gives no Turn finished alert, so its DSH error alert must come
// (with the error buzz), as for another chat. One failure, one alert.
assert.match(body('func sessionError('), /if sid == current \{[\s\S]*?notificationOccurred\(\.error\)\n\s*\}\n(?:\s*\/\/.*\n)*\s*notify\(String\(localized: "DSH error"\), m, session: sid\)/, 'the open chat\'s failure alerts too');
assert.match(gw, /pushTo\(\)\.filter\(d => inHours\(d\.push\.hours\)\)/, 'the gateway keeps the phone\'s hours');
console.log('tether notify per Mac: keys per Mac, off by default, split once, no Host route, pushed by the Mac (APNs) with each Mac\'s own settings');
