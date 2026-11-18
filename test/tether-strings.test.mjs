// Tether's one string table (tether/ios/Resources/Localizable.xcstrings): every word of Tether, in English and Turkish.
// - Every key has an en and a tr value, with the same format specifiers (a missing or extra %@ would crash or lie).
// - Every String(localized:) / Text("…") key of the Swift source is in the table (CI has no Xcode to extract them: this
//   reads the literals that the table must hold; the iOS build fails on nothing, it shows English instead).
// - The words of a feature that the Composer Plus web UI also has are the web UI's own words (locales/tr.json).
// - The language: Tether follows the Mac's Composer Plus language (`/me` `lang`), as the Approve button does.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const table = JSON.parse(read('tether/ios/Resources/Localizable.xcstrings'));
const core = read('tether/ios/Sources/Core.swift'), ui = read('tether/ios/Sources/UI.swift');
const trMac = JSON.parse(read('locales/tr.json'))['dsh-composer-plus'];
assert.equal(table.sourceLanguage, 'en');

const spec = (s) => [...s.matchAll(/%(?:(\d+)\$)?(?:lld|ld|d|@|f|\.\d+f)/g)].map((m, i) => `${m[1] ?? i + 1}:${m[0].replace(/^%\d+\$/, '%')}`).sort();
const value = (entry, lang) => entry?.localizations?.[lang]?.stringUnit?.value;
const keys = Object.keys(table.strings);
assert.ok(keys.length > 600, `the table has Tether's words (${keys.length})`);
for (const key of keys) {
  const e = table.strings[key];
  if (e.shouldTranslate === false) continue;
  const en = value(e, 'en') ?? key, tr = value(e, 'tr');
  assert.ok(typeof tr === 'string' && tr.trim() !== '', `"${key}" has a Turkish value`);
  assert.equal(e.localizations?.tr?.stringUnit?.state, 'translated', `"${key}" tr is translated`);
  assert.deepEqual(spec(tr), spec(en), `"${key}": the same placeholders in en and tr (${en} / ${tr})`);
  // Words that Turkish keeps as they are (the web UI too: "Issue #{number}", "Model", "Port").
  if (key.trim() !== '' && /[a-z]{3}/.test(en) && !/^(Tether|Damon|DSH|Mac|Tailscale|Composer Plus|Git|Face ID|Touch ID|Bonjour|Model|Model: %@|Port|Issue #%lld)$/.test(en)) {
    assert.notEqual(tr, en, `"${key}" is translated (not English)`);
  }
}

// Each literal key of the source is in the table (Text("…"), Label("…"), Button("…"), String(localized: "…"), …).
// ponytail: a light regex of the literal forms that the code uses; interpolated keys are left to the build's extractor
// (the iOS test testStringTable reads the compiled table).
const literal = /(?<!\w)(?:String\(localized: |Text\(|Label\(|Button\(|Toggle\(|TextField\(|navigationTitle\(|ProgressView\(|Section\(|alert\(|confirmationDialog\(|accessibilityLabel\(|LabeledContent\(|Picker\()"((?:[^"\\]|\\.)*)"/g;
const missing = [];
for (const src of [core, ui]) {
  for (const m of src.matchAll(literal)) {
    const k = m[1];
    if (k.includes('\\(') || k === '' || !/[A-Za-z]/.test(k)) continue;
    if (!(k.replace(/\\"/g, '"').replace(/\\n/g, '\n') in table.strings)) missing.push(k);
  }
}
assert.deepEqual([...new Set(missing)], [], 'every literal key is in Localizable.xcstrings');

// The web UI's words where the feature is the same.
const same = {
  'status.title': 'status.title', 'status.tasks': 'status.tasks', 'status.history': 'status.history', 'status.projects': 'status.projects',
  'status.task.running': 'status.task.running', 'status.task.waiting': 'status.task.waiting', 'status.task.done': 'status.task.done',
  'status.task.failed': 'status.task.failed', 'status.task.stopped': 'status.task.stopped', 'todos.title': 'todos.title',
  'todos.groupUser': 'todos.groupUser', 'todos.overdue': 'todos.overdue', 'todos.waiting': 'todos.waiting', 'status.summary': 'status.summary',
  Approve: 'approve.button', 'Approval sentences of this answer': 'approve.group',
  Result: 'callouts.result', Problem: 'callouts.problem', 'Approval needed': 'callouts.approval', 'Open questions': 'callouts.questions',
  Important: 'callouts.important', 'Still running': 'callouts.running', Details: 'callouts.details',
};
const mac = (k) => trMac[k].replace(/\{\w+\}/g, '%@');
for (const [key, macKey] of Object.entries(same)) assert.equal(value(table.strings[key], 'tr'), mac(macKey), `${key} = the web UI's ${macKey}`);
assert.equal(value(table.strings['status.outageRow'], 'tr'), trMac['status.outageRow'].replace('{time}', '%@'), 'Kesintiden sonra devam etti');
assert.equal(value(table.strings['todos.groupAgent'], 'tr'), trMac['todos.groupAgent'].replace('{name}', '%@'));
// The Mac's feature names, where Tether names the same feature.
for (const [en, macKey] of [['Task board', 'feature.taskBoard'], ['Project memory', 'feature.projectMemory'], ['Feature ideas', 'feature.featureIdeas'], ['Side chat', 'feature.sideChat']]) {
  if (table.strings[en] !== undefined && trMac[macKey] !== undefined) assert.equal(value(table.strings[en], 'tr'), trMac[macKey], `${en} = the web UI's ${macKey}`);
}

// The language: the Mac's lang (Turkish or English), one table for every view and for String(localized:).
assert.match(core, /func uiLanguage\(macLang: String\?, phone: String\? = Locale\.preferredLanguages\.first\) -> String \{ isTurkish\(macLang: macLang, phone: phone\) \? "tr" : "en" \}/);
assert.match(core, /init\(localized key: String\.LocalizationValue\) \{ self\.init\(localized: key, bundle: uiStrings\) \}/, 'String(localized:) reads the Mac\'s language');
assert.match(core, /didSet \{ UserDefaults\.standard\.set\(macLang, forKey: "macLang"\); uiStrings = uiBundle\(uiLanguage\(macLang: macLang\)\) \}/, 'a new lang changes the table');
assert.match(ui, /Root\(\)\.environmentObject\(client\)\.environmentObject\(lock\)\.environment\(\\\.locale, client\.uiLocale\)/, 'the views get the Mac\'s language');
assert.doesNotMatch(core + ui, /tr \? "[^"]*" : "/, 'no second word list outside the table');
console.log(`tether strings: ${keys.length} keys, each with en and tr, the web UI's words, the Mac's language`);
