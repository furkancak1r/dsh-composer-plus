// Narrow store selectors (client.js): the session status store changes with every status change of every chat and its
// subagents. Branch pills and Mark all as read select only one text (the running chats, the unread dots), so a change that
// does not touch that value gives an equal string (dsh's selector hook compares with Object.is: no render).
// Project name selects only its chat's folder.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pick = (name) => { const m = src.match(new RegExp(`const ${name} = (\\(statuses\\) => [^\\n]+);`)); assert.ok(m, name); return new Function(`return ${m[1]}`)(); };
const runningIdsKey = pick('runningIdsKey'); const unreadIdsKey = pick('unreadIdsKey');
const a = new Map([['s1', { running: true }], ['s2', { completionUnread: true }], ['s3', { pendingInteraction: { kind: 'question' } }]]);
// A subagent of s1 starts and a question card comes in s3: neither key changes.
const b = new Map([...a, ['sub-1', { running: false }], ['s3', { pendingInteraction: { kind: 'approval' } }]]);
assert.ok(Object.is(runningIdsKey(a), runningIdsKey(b)), 'unrelated status change: the same running key');
assert.ok(Object.is(unreadIdsKey(a), unreadIdsKey(b)), 'unrelated status change: the same unread key');
assert.equal(runningIdsKey(a), 's1'); assert.equal(unreadIdsKey(a), 's2');
// A chat that stops running, or a new dot: the key changes.
assert.notEqual(runningIdsKey(new Map([...a, ['s1', { running: false }]])), runningIdsKey(a));
assert.notEqual(unreadIdsKey(new Map([...a, ['s4', { completionUnread: true }]])), unreadIdsKey(a));
assert.equal(runningIdsKey(undefined), ''); assert.equal(unreadIdsKey(undefined), '');
// The components use them (no whole-store subscription left in these three).
const body = (fn) => src.slice(src.indexOf(`    function ${fn}(`), src.indexOf('\n    }\n', src.indexOf(`    function ${fn}(`)));
assert.match(body('SessionBranchBadges'), /useSessionStatus\?\.\(runningIdsKey\)/);
assert.match(body('MarkProjectRead'), /useSessionStatus\(unreadIdsKey\)/);
assert.match(body('ProjectNamePill'), /useSessions\(\(state\) => state\?\.byId\?\.\[sessionId\]\?\.cwd\)/);
for (const fn of ['SessionBranchBadges', 'MarkProjectRead', 'ProjectNamePill']) assert.doesNotMatch(body(fn), /use(Sessions|SessionStatus)\??\.?\(\((s|state)\) => (s|state)\)/, `${fn}: no whole-store subscription`);
console.log('narrow-selectors: ok');
