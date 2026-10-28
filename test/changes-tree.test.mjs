// Changes panel, Tree (client half): the page flow of the real client.js with a small hook runtime. The page opens on
// the branch map (counts that filter it, a box per branch colored by its state, rows by level, Merged / Waiting labels);
// a box → its commits (`ref` in the URL); a commit → its files (commit mode); Merged → the merge commit's files; Waiting →
// the files that the branch brings into its target (pending mode); ← goes back one step at once and marks the box or row
// that was open; a branch that is gone; the state is kept per chat.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
const storage = new Map(); globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
const hook = 'const CHANGES_KIND = ';
assert.ok(src.includes(hook));
eval(src.replace(hook, 'globalThis.__ct = () => ({ ChangesTab, BranchMap, BranchCommits, FileList, mapRows, mapColor, MAP_COLORS });\n    ' + hook));

// A small hook runtime: one component, state slots by call order, effects after the render when their deps change.
let slots = []; let at = 0; let effects = [];
const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const React = {
  createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }), Fragment: 'F',
  // A setter writes into the slots of the component that made it (a late fetch of another component never leaks in).
  useState: (v) => { const own = slots; const k = at++; if (!(k in own)) own[k] = typeof v === 'function' ? v() : v; return [own[k], (x) => { own[k] = typeof x === 'function' ? x(own[k]) : x; }]; },
  useRef: (v) => { const k = at++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
  useMemo: (f, deps) => { const k = at++; if (slots[k] && same(slots[k].deps, deps)) return slots[k].v; slots[k] = { deps, v: f() }; return slots[k].v; },
  useEffect: (f, deps) => { const k = at++; const old = slots[k]; if (old && same(old.deps, deps)) return; effects.push(() => { slots[k]?.cleanup?.(); slots[k] = { deps, cleanup: f() }; }); },
};
mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'Menu' } : {}));
const { ChangesTab, BranchMap: BranchList, BranchCommits, FileList, mapRows, mapColor, MAP_COLORS } = globalThis.__ct();

const H = 'a'.repeat(40); const S = 'b'.repeat(40); const I = 'c'.repeat(40);
const c = (sha, refs, subject, time = 1700000000) => ({ sha, refs, author: 'Demo', time, subject });
const M = 'd'.repeat(40);
const LIST = { repo: true, root: '/demo', branch: 'main', upstream: 'origin/main', head: H, main: 'refs/heads/main', partial: false, more: false, lastTurn: { seq: 4, turn: 1 }, branches: [
  { ref: 'refs/heads/main', name: 'main', kind: 'local', current: true, sha: H, time: 1700000000, author: 'Demo', subject: 'Merge side', state: 'main', reached: true, level: 0 },
  { ref: 'refs/heads/side', name: 'side', kind: 'local', sha: S, time: 1699000000, author: 'Demo', subject: 'Side work', state: 'merged', reached: true, target: 'refs/heads/main', merge: M, level: 1 },
  { ref: 'refs/remotes/origin/spike', name: 'origin/spike', kind: 'remote', sha: I, time: 1690000000, author: 'Demo', subject: 'Spike', state: 'waiting', reached: false, target: 'refs/heads/side', level: 2 }] };
const MAIN = { repo: true, root: '/demo', branch: 'main', head: H, ref: 'refs/heads/main', more: true, commits: [
  c(H, [{ name: 'main', kind: 'local', current: true }, { name: 'v1', kind: 'tag' }], 'Merge side'),
  c(I, [{ name: 'origin/main', kind: 'remote' }], 'Init', 1690000000)] };
const SIDE = { repo: true, root: '/demo', branch: 'main', head: H, ref: 'refs/heads/side', more: false, commits: [
  c(S, [{ name: 'side', kind: 'local' }], 'Side work', 1699000000), c(I, [{ name: 'origin/main', kind: 'remote' }], 'Init', 1690000000)] };
const FILES = { repo: true, root: '/demo', branch: 'main', mode: 'commit', commit: S, files: [{ path: 'side.txt', added: 2, deleted: 0, binary: false }], total: 1, added: 2, deleted: 0 };
const PENDING = { repo: true, root: '/demo', branch: 'main', mode: 'pending', files: [{ path: 'spike.txt', added: 3, deleted: 1, binary: false }], total: 1, added: 3, deleted: 1 };
const UNCOMMITTED = { repo: true, root: '/demo', branch: 'main', upstream: 'origin/main', mode: 'uncommitted', files: [], total: 0, added: 0, deleted: 0 };
const urls = []; let gone = false;
globalThis.fetch = async (url) => {
  urls.push(url); const q = new URL(url, 'http://h').searchParams;
  if (gone && ((url.includes('.graph') && q.get('ref')) || q.get('mode') === 'pending')) return { ok: false, status: 404, json: async () => ({ error: 'no such branch' }) };
  const body = url.includes('.graph') ? ({ null: LIST, 'refs/heads/main': MAIN, 'refs/heads/side': SIDE }[q.get('ref')]) : q.get('mode') === 'commit' ? FILES : q.get('mode') === 'pending' ? PENDING : UNCOMMITTED;
  return { ok: true, json: async () => structuredClone(body) }; // each answer is a new object, as from the network
};
const timers = []; globalThis.setInterval = (fn, ms) => { timers.push(ms); return timers.length; }; globalThis.clearInterval = () => {};
// The scroll box: rows are 40 px high, in the order of the rendered list.
let rowOrder = [];
const box = { scrollTop: 0, clientHeight: 100, querySelectorAll: () => rowOrder.map((k, i) => ({ offsetTop: i * 40, offsetHeight: 40, getAttribute: () => k })) };
const t = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k);
let out;
function find(e, test) { if (e === null || typeof e !== 'object') return undefined; if (test(e)) return e; for (const x of e.c ?? []) { const f = find(x, test); if (f) return f; } return undefined; }
const findAll = (e, test, acc = []) => { if (e && typeof e === 'object') { if (test(e)) acc.push(e); for (const x of e.c ?? []) findAll(x, test, acc); } return acc; };
const text = (e) => (e === null || e === undefined ? '' : typeof e !== 'object' ? String(e) : (e.c ?? []).map(text).join(''));
const sub = (C) => { const el = find(out, (e) => e.t === C); return el === undefined ? undefined : C(el.p); };
const rows = () => { const v = sub(BranchList) ?? sub(BranchCommits); return v === undefined ? [] : findAll(v, (e) => e.p?.['data-composer-plus-row'] !== undefined); };
const renderAs = async (sessionId) => {
  for (let round = 0; round < 5; round++) {
    at = 0; effects = []; out = ChangesTab({ sessionId, t, openLastTurn: () => {} });
    const ref = find(out, (e) => e.p?.ref !== undefined); if (ref) ref.p.ref.current = box;
    rowOrder = rows().map((r) => r.p['data-composer-plus-row']);
    const run = effects; for (const f of run) f();
    await new Promise((r) => setTimeout(r, 0));
    if (run.length === 0) break;
  }
};
const render = () => renderAs('chat-1');
const back = () => find(out, (e) => 'data-composer-plus-tree-back' in e.p);

await render();
// 1. The page opens on Tree, the branch map: no commits, counts, a box per branch in rows by level, the labels.
assert.equal(urls[0], '/api/composer-plus.graph?sessionId=chat-1', 'Tree is the first view');
assert.equal(timers.at(-1), 15000, 'the map refreshes every 15 s');
const menu = find(out, (e) => e.t === 'Menu');
assert.deepEqual(menu.p.items.map((x) => x.id), ['tree', 'sep0', 'last-turn', 'chat', 'sep1', 'uncommitted', 'unstaged', 'staged', 'sep2', 'branch']);
assert.equal(menu.p.selectedId, 'tree');
let list = sub(BranchList);
assert.equal(list.p['aria-label'], 'changes.map.label');
const cards = () => findAll(sub(BranchList), (e) => e.p?.['data-composer-plus-map-card'] !== undefined);
assert.deepEqual(cards().map((c) => [c.p['data-composer-plus-map-card'], text(c)]), [['all', '3changes.map.total'], ['merged', '1changes.map.merged'], ['waiting', '1changes.map.waitingCount']]);
assert.deepEqual(rows().map((r) => r.p['data-composer-plus-branch']), ['refs/heads/main', 'refs/heads/side', 'refs/remotes/origin/spike']);
assert.deepEqual(findAll(list, (e) => e.p?.['data-composer-plus-map-row'] !== undefined).map((r) => findAll(r, (e) => e.p?.['data-composer-plus-branch'] !== undefined).map((b) => b.p['data-composer-plus-state'])), [['main'], ['merged'], ['waiting']], 'one row per level');
assert.deepEqual(rows().map((r) => r.p.style.borderColor), [MAP_COLORS.main, MAP_COLORS.reached, MAP_COLORS.open], 'blue, green, orange');
assert.ok(text(rows()[0]).includes('changes.tree.current'), 'the current branch is marked'); assert.ok(!text(rows()[1]).includes('changes.tree.current'));
assert.ok(text(rows()[1]).includes('Side work'), 'each branch shows its last commit');
const pills = () => findAll(sub(BranchList), (e) => e.p?.['data-composer-plus-pill'] !== undefined);
assert.deepEqual(pills().map((p) => [p.p['data-composer-plus-pill'], text(p), p.p.disabled]), [['refs/heads/side', '✅ changes.map.merged', false], ['refs/remotes/origin/spike', '⏳ changes.map.waiting', false]], 'no label on main');
assert.equal(pills()[1].p.title, 'changes.map.waitingHint:{"branch":"origin/spike","target":"side"}');
assert.equal(pills()[0].p['aria-label'], 'changes.map.merged → main · changes.map.mergedHint', 'a screen reader hears the target');
assert.equal(rows()[1].p['aria-label'], 'side, changes.map.legendReached, Side work', 'and the state of the box');
assert.equal(rows()[0].p['aria-label'], 'main (changes.tree.current), changes.map.legendMain, Merge side');
assert.ok(text(list).includes('changes.map.legendReached') && text(list).includes('changes.map.legendOpen') && text(list).includes('changes.map.legendMain'), 'the legend');
assert.ok(!text(list).includes('changes.map.partial'));
assert.equal(find(out, (e) => e.p?.['data-composer-plus-commit'] !== undefined), undefined, 'no commits before a click');
assert.equal(find(out, (e) => 'data-composer-plus-ws' in e.p), undefined, 'no diff here, so no whitespace switch');
assert.equal(back(), undefined, 'the map is the first step');
// The cards filter the map: Waiting keeps spike and, dimmed, the boxes that its arrow goes through; again → all.
cards()[2].p.onClick(); await render();
assert.equal(cards()[2].p['aria-pressed'], true);
assert.deepEqual(rows().map((r) => [r.p['data-composer-plus-branch'], r.p.style.opacity]), [['refs/heads/main', 0.45], ['refs/heads/side', 0.45], ['refs/remotes/origin/spike', undefined]]);
cards()[1].p.onClick(); await render();
assert.deepEqual(rows().map((r) => r.p['data-composer-plus-branch']), ['refs/heads/main', 'refs/heads/side'], 'Merged: side and main');
cards()[1].p.onClick(); await render();
assert.equal(rows().length, 3, 'the same card again shows all'); assert.equal(cards()[0].p['aria-pressed'], true);
// Pure parts: rows by level (a branch under its target's place), colors, a long history note.
assert.deepEqual(mapRows([{ ref: 'm', level: 0 }, { ref: 'a', level: 1, target: 'm' }, { ref: 'c', level: 2, target: 'b' }, { ref: 'b', level: 1, target: 'm' }, { ref: 'd', level: 2, target: 'a' }]).map((r) => r.map((b) => b.ref)), [['m'], ['a', 'b'], ['d', 'c']]);
assert.equal(mapColor({ state: 'merged', reached: false }), MAP_COLORS.open, 'merged into a branch that is not in main yet: orange');
// The filter and an open label belong to their chat.
assert.equal(cards().some((x) => x.p.disabled), false, 'each card has branches');
cards()[2].p.onClick(); await render(); assert.equal(rows().filter((r) => r.p.style.opacity === 0.45).length, 2, 'chat 1: Waiting');
await renderAs('chat-2'); assert.equal(cards()[0].p['aria-pressed'], true, 'chat 2 shows all');
await renderAs('chat-1'); assert.equal(cards()[2].p['aria-pressed'], true, 'chat 1 keeps its filter');
cards()[2].p.onClick(); await render();
// 1b. The branch chip goes to the map too (from another mode).
find(out, (e) => e.t === 'Menu').p.onSelect('uncommitted'); await render();
assert.equal(urls.at(-1), '/api/composer-plus.changes?sessionId=chat-1&mode=uncommitted');
assert.deepEqual(timers.slice(-1), [4000]);
assert.equal(find(out, (e) => 'data-composer-plus-ws' in e.p).p['aria-pressed'], false, 'whitespace shows by default');
const chip = find(out, (e) => 'data-composer-plus-branch-chip' in e.p);
assert.equal(chip.t, 'button'); assert.equal(chip.p['aria-label'], 'main · changes.tree.open');
box.scrollTop = 70;
chip.p.onClick(); await render();
assert.equal(urls.at(-1), '/api/composer-plus.graph?sessionId=chat-1');
assert.equal(box.scrollTop, 0, 'the map starts at the top');
list = sub(BranchList);
assert.equal(timers.at(-1), 15000, 'the branches refresh less often');
// 2. A box → its commits (the full ref in the URL); the branch name and ← Branch map above them.
rows()[1].p.onClick(); await render();
assert.equal(urls.at(-1), '/api/composer-plus.graph?sessionId=chat-1&ref=refs%2Fheads%2Fside');
assert.deepEqual(rows().map((r) => r.p['data-composer-plus-commit']), [S, I]);
assert.equal(sub(BranchList), undefined);
assert.equal(text(back()), '← changes.map.label');
assert.ok(find(out, (e) => e.c?.includes?.('side')), 'the branch name is shown');
assert.ok(!text(rows()[0]).includes('side'), 'the open branch is not repeated as a tag on its commits');
assert.ok(text(rows()[1]).includes('origin/main'), 'other branches on a commit show as tags');
// 2b. Merged → the merge commit's files (commit mode with the merge id), Waiting → the files that origin/spike brings into
// side (pending mode); each ← goes back to the map and marks the box.
back().p.onClick(); await render();
pills()[0].p.onClick(); await render();
assert.equal(urls.at(-1), `/api/composer-plus.changes?sessionId=chat-1&mode=commit&commit=${M}`);
assert.equal(find(out, (e) => e.p?.['data-composer-plus-detail'] !== undefined).c[0], '✅ side → main');
{ const fl = find(out, (e) => e.t === FileList); assert.equal(fl.p.mode, 'commit'); assert.equal(fl.p.commit, M); }
assert.equal(text(back()), '← changes.map.label');
back().p.onClick(); await render();
assert.equal(rows()[1].p['aria-current'], 'true', 'back: the box is marked');
pills()[1].p.onClick(); await render();
assert.equal(urls.at(-1), '/api/composer-plus.changes?sessionId=chat-1&mode=pending&ref=refs%2Fremotes%2Forigin%2Fspike&target=refs%2Fheads%2Fside');
assert.equal(find(out, (e) => e.p?.['data-composer-plus-detail'] !== undefined).c[0], '⏳ origin/spike → side');
await renderAs('chat-2'); assert.equal(find(out, (e) => e.p?.['data-composer-plus-detail'] !== undefined), undefined, 'chat 2 does not see chat 1\'s open label');
await renderAs('chat-1'); assert.ok(find(out, (e) => e.p?.['data-composer-plus-detail'] !== undefined), 'chat 1 keeps it');
{
  const fl = find(out, (e) => e.t === FileList); assert.equal(fl.p.mode, 'pending'); assert.deepEqual(fl.p.pending, { ref: 'refs/remotes/origin/spike', target: 'refs/heads/side' });
  const keep = slots; slots = []; at = 0;
  let l = FileList(fl.p); find(l, (e) => e.p?.['aria-expanded'] === false).p.onClick();
  at = 0; l = FileList(fl.p); const diff = find(l, (e) => typeof e.t === 'function' && e.p?.file?.path === 'spike.txt');
  slots = []; at = 0; effects = []; diff.t(diff.p); for (const f of effects) f();
  assert.equal(urls.at(-1), '/api/composer-plus.diff?sessionId=chat-1&mode=pending&path=spike.txt&ref=refs%2Fremotes%2Forigin%2Fspike&target=refs%2Fheads%2Fside');
  slots = keep;
}
assert.equal(timers.at(-1), 15000, 'pending can change: it refreshes');
PENDING.files = []; PENDING.total = 0; find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
assert.ok(find(out, (e) => e.c?.includes?.('changes.map.noPending:{"target":"side"}')), 'nothing to bring in');
gone = true; find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
assert.ok(find(out, (e) => e.c?.includes?.('changes.tree.gone')), 'a branch that is gone');
gone = false;
back().p.onClick(); await render();
assert.equal(rows()[2].p['aria-current'], 'true');
// A merged branch without a merge commit (fast-forward): its label opens nothing.
delete LIST.branches[1].merge; find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
assert.equal(pills()[0].p.disabled, true); const before0 = urls.length; pills()[0].p.onClick(); await render();
assert.equal(find(out, (e) => e.p?.['data-composer-plus-detail'] !== undefined), undefined); assert.ok(urls.slice(before0).every((u) => u.includes('.graph')));
LIST.branches[1].merge = M;
// A long history says so.
LIST.partial = true; find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
assert.ok(text(sub(BranchList)).includes('changes.map.partial')); LIST.partial = false;
rows()[1].p.onClick(); await render();
// 3. A commit → its files (commit mode, the full id); no timer for a commit.
const before = timers.length;
rows()[0].p.onClick(); await render();
assert.equal(urls.at(-1), `/api/composer-plus.changes?sessionId=chat-1&mode=commit&commit=${S}`);
const files = find(out, (e) => e.t === FileList);
assert.equal(files.p.commit, S); assert.equal(files.p.mode, 'commit'); assert.deepEqual(files.p.value.files.map((f) => f.path), ['side.txt']);
assert.equal(timers.length, before, 'a commit never changes: no refresh');
assert.ok(find(out, (e) => e.c?.includes?.('Side work')), 'the commit subject is shown');
assert.equal(text(back()), '← side', 'back goes to the branch');
assert.equal(find(out, (e) => 'data-composer-plus-ws' in e.p).p['aria-pressed'], false, 'a commit has a diff: the whitespace switch shows');
// The file list (its own hook slots) opens the diff with the commit id.
{
  const keep = slots; slots = []; at = 0;
  let fl = FileList(files.p); find(fl, (e) => e.p?.['aria-expanded'] === false).p.onClick();
  at = 0; fl = FileList(files.p); const diff = find(fl, (e) => typeof e.t === 'function' && e.p?.file?.path === 'side.txt');
  assert.equal(diff.p.commit, S); assert.equal(diff.p.mode, 'commit');
  slots = []; at = 0; effects = []; diff.t(diff.p); for (const f of effects) f();
  assert.equal(urls.at(-1), `/api/composer-plus.diff?sessionId=chat-1&mode=commit&path=side.txt&commit=${S}`);
  slots = keep;
}
// 4. ← side: the commits show at once (no loading text), the commit that was open is marked and in the middle.
let n = urls.length;
back().p.onClick();
at = 0; effects = []; out = ChangesTab({ sessionId: 'chat-1', t, openLastTurn: () => {} });
assert.ok(sub(BranchCommits) !== undefined, 'no loading text between the commit and its branch');
await render();
assert.equal(urls[n], '/api/composer-plus.graph?sessionId=chat-1&ref=refs%2Fheads%2Fside');
assert.deepEqual(rows().map((r) => r.p['aria-current']), ['true', undefined]);
// ← Branch map: the map at once, the branch that was open marked.
back().p.onClick();
at = 0; effects = []; out = ChangesTab({ sessionId: 'chat-1', t, openLastTurn: () => {} });
assert.ok(sub(BranchList) !== undefined, 'no loading text between the branch and the map');
await render();
assert.deepEqual(rows().map((r) => r.p['aria-current']), [undefined, 'true', undefined]);
// The marked row scrolls to the middle (a low page, many branches).
for (let k = 0; k < 6; k++) LIST.branches.splice(2, 0, { ref: `refs/heads/f${k}`, name: `f${k}`, kind: 'local', sha: S, time: 1, author: 'Demo', subject: `f${k}`, state: 'waiting', reached: true, target: 'refs/heads/main', level: 1 });
LIST.branches.at(-1).level = 2 + 6; // a deep chain puts spike last
find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
rows().find((r) => r.p['data-composer-plus-branch'] === 'refs/remotes/origin/spike').p.onClick(); await render();
gone = false; back().p.onClick(); await render();
assert.equal(rows().at(-1).p['aria-current'], 'true');
assert.equal(box.scrollTop, 8 * 40 - 50 + 20, 'the last box is in the middle of the page');
// A refresh never moves the page.
box.scrollTop = 33; find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
assert.equal(box.scrollTop, 33, 'a refresh keeps the scroll');
LIST.branches.splice(2, 6); LIST.branches.at(-1).level = 2;
// 5. A branch that is deleted while it is open: a clear note, ← still goes back.
rows().find((r) => r.p['data-composer-plus-branch'] === 'refs/heads/main').p.onClick(); await render();
assert.deepEqual(rows().map((r) => r.p['data-composer-plus-commit']), [H, I]);
assert.ok(find(out, (e) => e.c?.includes?.('changes.tree.more:{"count":"2"}')), 'the cut-off note');
gone = true; find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
assert.ok(find(out, (e) => e.c?.includes?.('changes.tree.gone')), 'the branch is gone');
// The next refresh: while it loads, the note stays (the old commits never flash back).
find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick();
at = 0; effects = []; out = ChangesTab({ sessionId: 'chat-1', t, openLastTurn: () => {} }); for (const f of effects) f();
at = 0; effects = []; out = ChangesTab({ sessionId: 'chat-1', t, openLastTurn: () => {} });
assert.ok(find(out, (e) => e.c?.includes?.('changes.tree.gone')), 'the note stays while the refresh loads'); assert.equal(sub(BranchCommits), undefined);
await render();
gone = false; back().p.onClick(); await render();
assert.ok(sub(BranchList) !== undefined);
// 6. Per chat: another chat never sees this chat's list or its open branch.
at = 0; effects = []; out = ChangesTab({ sessionId: 'chat-2', t, openLastTurn: () => {} });
assert.equal(sub(BranchList), undefined, 'a new chat waits for its own list');
await renderAs('chat-1'); rows()[1].p.onClick(); await renderAs('chat-1');
assert.ok(sub(BranchCommits), 'chat 1 shows a branch');
await renderAs('chat-2');
assert.equal(sub(BranchCommits), undefined, 'chat 2 does not show chat 1\'s branch');
assert.ok(!urls.some((u) => u.includes('sessionId=chat-2') && u.includes('ref=')), 'no branch request for chat 2');
assert.equal(urls.at(-1), '/api/composer-plus.graph?sessionId=chat-2');
assert.equal(rows().find((r) => r.p['aria-current'] === 'true'), undefined, 'chat 1\'s mark is not chat 2\'s');
// The branch chip (and Menu → Tree) always starts at the map.
await renderAs('chat-1'); assert.ok(sub(BranchCommits));
find(out, (e) => 'data-composer-plus-branch-chip' in e.p).p.onClick(); await render();
assert.ok(sub(BranchList), 'the chip goes back to the map');
// Menu → Uncommitted leaves the tree.
await render(); find(out, (e) => e.t === 'Menu').p.onSelect('uncommitted'); await render();
assert.equal(sub(BranchList), undefined); assert.match(urls.at(-1), /mode=uncommitted$/);
// Hide whitespace: the switch asks again with ws=1, is kept on this device, and the file list passes it to each diff.
find(out, (e) => 'data-composer-plus-ws' in e.p).p.onClick(); await render();
assert.equal(urls.at(-1), '/api/composer-plus.changes?sessionId=chat-1&mode=uncommitted&ws=1');
assert.equal(storage.get('dsh-composer-plus.changes.hideWhitespace'), '1');
assert.equal(find(out, (e) => 'data-composer-plus-ws' in e.p).p['aria-pressed'], true);
// This chat: its own mode, refreshed every 15 s, with a note on what it compares against.
UNCOMMITTED.files = [{ path: 'x.js', added: 1, deleted: 0, binary: false }]; UNCOMMITTED.total = 1; UNCOMMITTED.added = 1;
UNCOMMITTED.base = 'head'; UNCOMMITTED.outside = 2;
find(out, (e) => e.t === 'Menu').p.onSelect('chat'); await render();
assert.equal(urls.at(-1), '/api/composer-plus.changes?sessionId=chat-1&mode=chat&ws=1', 'This chat with the switch on');
assert.equal(timers.at(-1), 15000);
const chatNote = find(out, (e) => e.p?.['data-composer-plus-chat-note'] !== undefined);
assert.equal(chatNote.p['data-composer-plus-chat-note'], 'head'); assert.equal(chatNote.c[0], 'changes.chat.head changes.chat.outside:{"count":"2"}');
const chatList = find(out, (e) => e.t === FileList);
assert.equal(chatList.p.mode, 'chat'); assert.equal(chatList.p.ws, true);
{
  const keep = slots; slots = []; at = 0;
  let fl = FileList(chatList.p); find(fl, (e) => e.p?.['aria-expanded'] === false).p.onClick();
  at = 0; fl = FileList(chatList.p); const diff = find(fl, (e) => typeof e.t === 'function' && e.p?.file?.path === 'x.js');
  slots = []; at = 0; effects = []; diff.t(diff.p); for (const f of effects) f();
  assert.equal(urls.at(-1), '/api/composer-plus.diff?sessionId=chat-1&mode=chat&path=x.js&ws=1', 'the diff asks with ws=1 too');
  slots = keep;
}
// Off again: a new page starts with the saved choice.
find(out, (e) => 'data-composer-plus-ws' in e.p).p.onClick(); await render();
assert.equal(urls.at(-1), '/api/composer-plus.changes?sessionId=chat-1&mode=chat');
assert.equal(storage.has('dsh-composer-plus.changes.hideWhitespace'), false);
console.log('changes Tree checks passed (opens on the branch map; cards filter; box → commits → files; Merged → merge commit; Waiting → pending files; back, marks, gone branch, per chat)');
