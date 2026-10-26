// Changes panel, branch tree (client half): the lane layout of the real client.js, the branch chips, and the page flow
// with a small hook runtime: branch chip → tree; branch chip in the tree → its row is marked and scrolled to the middle;
// a row → that commit's files (commit mode); back → the tree at once, marked on that commit; the commit id in the URLs.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
const hook = 'const CHANGES_KIND = ';
assert.ok(src.includes(hook));
eval(src.replace(hook, 'globalThis.__ct = () => ({ graphRows, treeBranches, ChangesTab, CommitTree, FileList });\n    ' + hook));

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
const { graphRows, treeBranches, ChangesTab, CommitTree, FileList } = globalThis.__ct();

// 1. Lanes. Linear history: one lane.
const c = (sha, parents = [], refs = []) => ({ sha, parents, refs, author: 'Demo', time: 1700000000, subject: `s-${sha}` });
assert.deepEqual(graphRows([c('A', ['B']), c('B', ['C']), c('C')]).map((r) => [r.col, r.top, r.bottom, r.width]), [
  [0, [], [[0, 0, 0]], 1], [0, [[0, 0]], [[0, 0, 0]], 1], [0, [[0, 0]], [], 1]]);
// A merge: M (W first, S second) → S on a new lane; at W the side lane curves back into lane 0 in its own color.
{
  const rows = graphRows([c('M', ['W', 'S']), c('S', ['B']), c('W', ['B']), c('B', ['I']), c('I')]);
  assert.deepEqual(rows[0], { col: 0, top: [], bottom: [[0, 0, 0], [0, 1, 1]], width: 2 });
  assert.deepEqual(rows[1], { col: 1, top: [[0, 0], [1, 1]], bottom: [[0, 0, 0], [1, 1, 1]], width: 2 });
  assert.deepEqual(rows[2], { col: 0, top: [[0, 0], [1, 1]], bottom: [[1, 0, 1], [0, 0, 0]], width: 2 }, 'the fork point joins the lanes');
  assert.deepEqual(rows[3], { col: 0, top: [[0, 0]], bottom: [[0, 0, 0]], width: 1 }, 'the free lane goes away');
  assert.deepEqual(rows[4].bottom, []);
}
// Two branch tips on one parent: the second tip opens lane 1 and joins lane 0 at once.
assert.deepEqual(graphRows([c('T1', ['B']), c('T2', ['B']), c('B')])[1], { col: 1, top: [[0, 0]], bottom: [[0, 0, 0], [1, 0, 1]], width: 2 });
// A freed lane is used again; two roots; a parent outside the list keeps its lane open to the last row.
{
  const rows = graphRows([c('M', ['A', 'X']), c('X', ['Y']), c('A', ['Y']), c('N', ['Z']), c('Y'), c('R')]);
  assert.equal(rows[3].col, 1, 'N takes the free lane 1');
  assert.deepEqual(rows[4].bottom, [[1, 1, 1]], 'the lane to Z stays open under Y');
  assert.deepEqual(rows[5], { col: 0, top: [[1, 1]], bottom: [[1, 1, 1]], width: 2 }, 'a second root uses lane 0');
}

// 2. Branch chips: the current branch first, then local, a detached HEAD, remote; no tags.
assert.deepEqual(treeBranches([
  c('1', [], [{ name: 'origin/main', kind: 'remote' }, { name: 'v1', kind: 'tag' }]),
  c('2', [], [{ name: 'zeta', kind: 'local' }, { name: 'main', kind: 'local', current: true }]),
  c('3', [], [{ name: 'HEAD', kind: 'head' }, { name: 'alpha', kind: 'local' }]),
]).map((r) => `${r.name}@${r.sha}`), ['main@2', 'alpha@3', 'zeta@2', 'HEAD@3', 'origin/main@1']);

// 3. The page.
const H = 'a'.repeat(40); const S = 'b'.repeat(40); const I = 'c'.repeat(40);
const GRAPH = { repo: true, root: '/demo', branch: 'main', upstream: 'origin/main', head: H, more: true, lastTurn: { seq: 4, turn: 1 }, commits: [
  { sha: H, parents: [I, S], refs: [{ name: 'main', kind: 'local', current: true }], author: 'Demo', time: 1700000000, subject: 'Merge side' },
  { sha: S, parents: [I], refs: [{ name: 'side', kind: 'local' }], author: 'Demo', time: 1700000000, subject: 'Side work' },
  { sha: I, parents: [], refs: [{ name: 'origin/main', kind: 'remote' }], author: 'Demo', time: 1690000000, subject: 'Init' }] };
const FILES = { repo: true, root: '/demo', branch: 'main', mode: 'commit', commit: S, files: [{ path: 'side.txt', added: 2, deleted: 0, binary: false }], total: 1, added: 2, deleted: 0 };
const UNCOMMITTED = { repo: true, root: '/demo', branch: 'main', upstream: 'origin/main', mode: 'uncommitted', files: [], total: 0, added: 0, deleted: 0 };
const urls = [];
globalThis.fetch = async (url) => {
  urls.push(url); const q = new URL(url, 'http://h').searchParams;
  const body = url.includes('.graph') ? GRAPH : q.get('mode') === 'commit' ? FILES : UNCOMMITTED;
  return { ok: true, json: async () => structuredClone(body) }; // each answer is a new object, as from the network
};
const timers = []; globalThis.setInterval = (fn, ms) => { timers.push(ms); return timers.length; }; globalThis.clearInterval = () => {};
const box = { scrollTop: 0, clientHeight: 100, querySelector: (q) => { const m = /"([0-9a-f]+)"/.exec(q); const i = GRAPH.commits.findIndex((x) => x.sha === m?.[1]); return i === -1 ? null : { offsetTop: i * 26 }; } };
const t = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k);
let out;
const render = async () => {
  for (let round = 0; round < 5; round++) {
    at = 0; effects = []; out = ChangesTab({ sessionId: 'chat-1', t, openLastTurn: () => {} });
    const ref = find(out, (e) => e.p?.ref !== undefined); if (ref) ref.p.ref.current = box;
    const run = effects; for (const f of run) f();
    await new Promise((r) => setTimeout(r, 0));
    if (run.length === 0) break;
  }
};
function find(e, test) { if (e === null || typeof e !== 'object') return undefined; if (test(e)) return e; for (const x of e.c ?? []) { const f = find(x, test); if (f) return f; } return undefined; }
const findAll = (e, test, acc = []) => { if (e && typeof e === 'object') { if (test(e)) acc.push(e); for (const x of e.c ?? []) findAll(x, test, acc); } return acc; };
const treeOf = () => { const el = find(out, (e) => e.t === CommitTree); return el === undefined ? undefined : CommitTree(el.p); };

await render();
assert.equal(urls.at(-1), '/api/composer-plus.changes?sessionId=chat-1&mode=uncommitted');
assert.deepEqual(timers, [4000]);
const menu = find(out, (e) => e.t === 'Menu');
assert.deepEqual(menu.p.items.map((x) => x.id), ['last-turn', 'sep1', 'uncommitted', 'unstaged', 'staged', 'sep2', 'branch', 'tree']);
// The branch chip opens the tree, marked on HEAD and scrolled to it.
const chip = find(out, (e) => 'data-composer-plus-branch-chip' in e.p);
assert.equal(chip.t, 'button'); assert.equal(chip.p['aria-label'], 'main · changes.tree.open');
chip.p.onClick(); await render();
assert.equal(urls.at(-1), '/api/composer-plus.graph?sessionId=chat-1');
let tree = treeOf();
assert.deepEqual(tree.c.map((row) => row.p['data-composer-plus-commit']), [H, S, I]);
assert.equal(tree.c[0].p['aria-current'], 'true', 'HEAD is marked');
const svg = tree.c[0].c.find((x) => x.t === 'svg');
assert.deepEqual(svg.c.filter(Boolean).map((x) => x.t), ['path', 'path', 'circle', 'circle'], 'two lines down, a ring for HEAD and the dot');
assert.match(svg.c[1].p.d, /^M8 13C8 19.5 20 19.5 20 26$/, 'the second parent curves to lane 1');
assert.equal(find(out, (e) => e.p?.['aria-label'] === 'changes.tree.branches') !== undefined, true);
assert.ok(find(out, (e) => e.c?.includes?.('changes.tree.more:{"count":"3"}')), 'the cut-off note');
assert.equal(timers.at(-1), 15000, 'the tree refreshes less often');
// The user scrolls down; the agent commits (a new HEAD) and the tree refreshes: the HEAD mark moves, the scroll does not.
{
  box.scrollTop = 40;
  const N = 'd'.repeat(40);
  GRAPH.commits.unshift({ sha: N, parents: [H], refs: [{ name: 'main', kind: 'local', current: true }], author: 'Demo', time: 1700000100, subject: 'New work' });
  GRAPH.head = N; GRAPH.commits[1].refs = [];
  find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
  assert.equal(treeOf().c[0].p['data-composer-plus-commit'], N); assert.equal(treeOf().c[0].p['aria-current'], 'true', 'the new HEAD is marked');
  assert.equal(box.scrollTop, 40, 'a refresh keeps the scroll');
  GRAPH.commits.shift(); GRAPH.head = H; GRAPH.commits[0].refs = [{ name: 'main', kind: 'local', current: true }];
  find(out, (e) => e.p?.['aria-label'] === 'changes.refresh').p.onClick(); await render();
}
// A branch chip in the tree marks its commit and scrolls it to the middle of the page.
const side = find(out, (e) => e.p?.['data-composer-plus-branch'] === 'side');
side.p.onClick(); await render();
tree = treeOf();
assert.equal(tree.c[1].p['aria-current'], 'true'); assert.equal(tree.c[0].p['aria-current'], undefined);
assert.equal(box.scrollTop, 26 - 50 + 13 > 0 ? 26 - 50 + 13 : 0);
// The mark is a box shadow, so the browser keeps its own keyboard focus ring (no outline in the style).
{
  const chips = findAll(out, (e) => e.p?.['data-composer-plus-branch'] !== undefined);
  assert.ok(chips.length >= 2);
  for (const c of chips) {
    assert.equal('outline' in c.p.style, false, `${c.p['data-composer-plus-branch']}: no inline outline`);
    assert.equal(c.p.style.boxShadow, c.p['data-composer-plus-branch'] === 'side' ? '0 0 0 2px rgba(59,130,246,.6)' : undefined);
  }
}
const origin = find(out, (e) => e.p?.['data-composer-plus-branch'] === 'origin/main');
origin.p.onClick(); await render(); assert.equal(box.scrollTop, 52 - 50 + 13, 'scrolled to the third row');
// A row opens that commit's files (commit mode, the full id); no timer for a commit.
const before = timers.length;
treeOf().c[1].p.onClick(); await render();
assert.equal(urls.at(-1), `/api/composer-plus.changes?sessionId=chat-1&mode=commit&commit=${S}`);
const list = find(out, (e) => e.t === FileList);
assert.equal(list.p.commit, S); assert.equal(list.p.mode, 'commit'); assert.deepEqual(list.p.value.files.map((f) => f.path), ['side.txt']);
assert.equal(timers.length, before, 'a commit never changes: no refresh');
assert.ok(find(out, (e) => e.c?.includes?.('Side work')), 'the commit subject is shown');
// The file list (its own hook slots) opens the diff with the commit id.
{
  const keep = slots; slots = []; at = 0;
  let fl = FileList(list.p); find(fl, (e) => e.p?.['aria-expanded'] === false).p.onClick();
  at = 0; fl = FileList(list.p); const diff = find(fl, (e) => typeof e.t === 'function' && e.p?.file?.path === 'side.txt');
  assert.equal(diff.p.commit, S); assert.equal(diff.p.mode, 'commit');
  slots = []; at = 0; effects = []; diff.t(diff.p); for (const f of effects) f();
  assert.equal(urls.at(-1), `/api/composer-plus.diff?sessionId=chat-1&mode=commit&path=side.txt&commit=${S}`);
  slots = keep;
}
// Back: the tree shows at once (the last tree), marked on the commit that was open.
const n = urls.length;
find(out, (e) => 'data-composer-plus-tree-back' in e.p).p.onClick();
at = 0; effects = []; out = ChangesTab({ sessionId: 'chat-1', t, openLastTurn: () => {} });
assert.ok(treeOf() !== undefined, 'no loading text between the commit and the tree');
assert.equal(treeOf().c[1].p['aria-current'], 'true');
await render(); assert.equal(urls[n], '/api/composer-plus.graph?sessionId=chat-1');
// Another chat never sees this chat's tree.
at = 0; effects = []; out = ChangesTab({ sessionId: 'chat-2', t, openLastTurn: () => {} });
assert.equal(treeOf(), undefined, 'a new chat waits for its own tree');
// A commit open in chat 1, then dsh shows chat 2 in the same tab: chat 2 gets its own tree, never chat 1's commit.
const renderAs = async (sessionId) => { for (let round = 0; round < 5; round++) { at = 0; effects = []; out = ChangesTab({ sessionId, t, openLastTurn: () => {} }); const run = effects; for (const f of run) f(); await new Promise((r) => setTimeout(r, 0)); if (run.length === 0) break; } };
await renderAs('chat-1'); await renderAs('chat-1'); assert.ok(treeOf(), 'chat 1 has its tree again');
treeOf().c[1].p.onClick(); await renderAs('chat-1');
assert.ok(find(out, (e) => e.t === FileList), 'chat 1 shows the commit');
await renderAs('chat-2');
assert.equal(find(out, (e) => e.t === FileList), undefined, 'chat 2 does not show chat 1\'s commit');
assert.ok(!urls.some((u) => u.includes('sessionId=chat-2') && u.includes('mode=commit')), 'no commit request for chat 2');
assert.equal(urls.at(-1), '/api/composer-plus.graph?sessionId=chat-2');
assert.equal(treeOf().c.find((row) => row.p['aria-current'] === 'true'), undefined, 'chat 1\'s mark is not chat 2\'s');
// Menu → Uncommitted leaves the tree.
await render(); find(out, (e) => e.t === 'Menu').p.onSelect('uncommitted'); await render();
assert.equal(treeOf(), undefined); assert.match(urls.at(-1), /mode=uncommitted$/);
console.log('changes tree checks passed');
