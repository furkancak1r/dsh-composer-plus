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

// The Assistant row (always drawn) and Assistant apart select only the assistant chat, its subagents and its project's
// chats, with only the fields that they read: a status change of another chat gives an equal text.
for (const fn of ['AssistantApartIcon', 'AssistantApart']) assert.doesNotMatch(body(fn), /use(Sessions|SessionStatus|Workspaces)\??\.?\(\((s|state)\) => (s|state)\)/, `${fn}: no whole-store subscription`);
assert.match(body('AssistantApartIcon'), /useSessions\?\.\(\(s\) => assistantListKey\(/); assert.match(body('AssistantApartIcon'), /useSessionStatus\?\.\(\(s\) => assistantStatusKey\(/);
assert.match(body('AssistantApart'), /useWorkspaces\(\(s\) => assistantWorkspacesKey\(/); assert.match(body('AssistantApart'), /useSessions\(\(s\) => assistantListKey\(/);
const pickAny = (name) => { const m = src.match(new RegExp(`const ${name} = (\\([^)]*\\) => [^\\n]+);`)); assert.ok(m, name); return new Function(`return ${m[1]}`)(); };
const [idsOf, listKey, statusKey, workspacesKey] = ['assistantIdsOf', 'assistantListKey', 'assistantStatusKey', 'assistantWorkspacesKey'].map(pickAny);
const ROW = ['blank', 'origin', 'running', 'retainedBy', 'mainView'];
const list = { byId: { 's-assistant': { blank: false, title: 'Assistant', updatedAt: 1 }, 's-sub': { origin: 'subagent' }, 's-web': { blank: false } },
  projectionsBySession: { 's-assistant': { values: { subagentCatalog: [{ id: 's-sub', title: 'Flights' }] } } } };
const ids = idsOf(list, 's-assistant');
assert.deepEqual(ids, ['s-assistant', 's-sub']);
const st = new Map([['s-assistant', { running: false }], ['s-web', { running: true }]]);
// Another chat stops and asks a question, or a new chat starts: the same status key.
assert.ok(Object.is(statusKey(st, ids), statusKey(new Map([...st, ['s-web', { running: false, pendingInteraction: { kind: 'question', text: 'x' } }], ['s-new', { running: true }]]), ids)), 'unrelated status change: the same assistant status key');
// The assistant's subagent starts, the assistant chat waits for you or has a new reply: a new key.
for (const [k, v] of [['s-sub', { running: true }], ['s-assistant', { pendingInteraction: { kind: 'approval' } }], ['s-assistant', { completionUnread: true }], ['s-assistant', { running: true }]]) {
  assert.ok(!Object.is(statusKey(st, ids), statusKey(new Map([...st, [k, v]]), ids)), `${k} ${JSON.stringify(v)}: a new status key`);
}
// The sessions list: another chat changes or comes, or an unshown field of the assistant chat changes: the same key.
const changed = { ...list, byId: { ...list.byId, 's-web': { blank: false, running: true }, 's-x': { blank: false }, 's-assistant': { ...list.byId['s-assistant'], updatedAt: 2 } } };
assert.ok(Object.is(listKey(list, ids, ROW), listKey(changed, idsOf(changed, 's-assistant'), ROW)), 'unrelated list change: the same assistant list key');
// The assistant chat opens (retainedBy), runs, or gets a new subagent: a new key.
const open = { ...list, byId: { ...list.byId, 's-assistant': { ...list.byId['s-assistant'], retainedBy: { mainView: 1 } } } };
assert.notEqual(listKey(open, ids, ROW), listKey(list, ids, ROW), 'open: a new key');
const sub = { ...list, byId: { ...list.byId, 's-sub': { origin: 'subagent', running: true } } };
assert.notEqual(listKey(sub, ids, ROW), listKey(list, ids, ROW), 'a subagent runs: a new key');
const more = { ...list, projectionsBySession: { 's-assistant': { values: { subagentCatalog: [{ id: 's-sub' }, { id: 's-sub2' }] } } } };
assert.notEqual(listKey(more, idsOf(more, 's-assistant'), ROW), listKey(list, ids, ROW), 'a new subagent: a new key');
assert.equal(listKey(undefined, ids, ROW), ''); assert.equal(statusKey(undefined, ids), '');
// Assistant apart reads only blank and origin: the assistant chat that runs gives the same key.
const running = { ...list, byId: { ...list.byId, 's-assistant': { blank: false, running: true } } };
assert.ok(Object.is(listKey(list, ['s-assistant'], ['blank', 'origin']), listKey(running, ['s-assistant'], ['blank', 'origin'])));
// The workspaces: only the projects that hold the assistant chat (and the archived ids).
const ws = { items: [{ workspaceId: 'w-asst', name: 'Assistant', sessionIds: ['s-assistant'] }, { workspaceId: 'w-web', sessionIds: ['s-web'] }], archivedSessionIds: [] };
const wsMore = { ...ws, items: [ws.items[0], { workspaceId: 'w-web', sessionIds: ['s-web', 's-x'], updatedAt: 3 }] };
assert.ok(Object.is(workspacesKey(ws, 's-assistant'), workspacesKey(wsMore, 's-assistant')), 'another project changes: the same workspaces key');
assert.notEqual(workspacesKey({ ...ws, items: [{ ...ws.items[0], sessionIds: ['s-assistant', 's-note'] }, ws.items[1]] }, 's-assistant'), workspacesKey(ws, 's-assistant'), 'a chat in the Assistant project: a new key');
console.log('narrow-selectors: ok');
