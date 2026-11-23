// Damon card stack: client.js statusCards against the one table of both apps (test/fixtures/status-cards.json; Tether's
// XCTest testStatusCardsMatchTheMac reads the same file). The `want` of each case is written by hand.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
const src = read('client.js');
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__sc = { statusCards, statusQueue, cardMark, liveApproval };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const { statusCards, statusQueue, cardMark, liveApproval } = globalThis.__sc;

const { cases } = JSON.parse(read('test/fixtures/status-cards.json'));
const card = (c) => ({ key: c.key, title: c.title, item: c.item?.id ?? null, task: c.task?.id ?? null, since: c.since, overdue: c.overdue, fresh: c.fresh });
for (const c of cases) {
  const o = c.opts ?? {};
  const p = statusCards(c.data, c.now, { approvals: o.approvals ?? 0, seen: new Set(o.seen ?? []), newSince: o.newSince ?? 0 });
  const got = { approval: p.approval === null ? null : { items: p.approval.items.map((i) => i.id), since: p.approval.since },
    groups: Object.fromEntries(Object.entries(p.groups).map(([g, list]) => [g, list.map(card)])), notes: p.notes.map((i) => i.id), counts: p.counts };
  assert.deepEqual(got, c.want, c.name);
}
assert.ok(cases.length >= 6, 'the table covers every group, the marks, merging, seen and the day end');

// The marks: only at the start, any case, with text after them.
assert.deepEqual(cardMark('Onay: main push'), { kind: 'onay', title: 'main push' });
assert.deepEqual(cardMark('Bu bir onay: değil'), { kind: null, title: 'Bu bir onay: değil' });
assert.deepEqual(cardMark('SORUN:  canlı'), { kind: 'sorun', title: 'canlı' });
// The CANLI label: a live word without a not-live phrase.
assert.equal(liveApproval('Onaylıyorum: canlı sunucuya deploy et.'), true);
assert.equal(liveApproval('Onaylıyorum (canlı değil): dal main\'e alınsın.'), false);
assert.equal(liveApproval('Onaylıyorum: yalnız yerel test.'), false);
// 2026-11-23: "canlı değil" in any form is never live, also when the text names a deploy or "(CANLI)" (the four Onay items
// of that morning all said "canlı değil"; the deploy item and the ASCII form got the label).
for (const text of ["Onay: hata incelemesinin ProsoLocal deploy paketi test dalı main'e alınıp push edilsin (canlı değil)",
  "Onay: deploy paketi test dalı main'e alınsın (canli degil)", 'Onay: yayın notu, CANLI DEĞİL', 'Onay: X (Canlı Değil), deploy ayrıca',
  'Onay: canlı\ndeğil, deploy belgesi', 'Onay: canlıya değil, deploy dalına'])
  assert.equal(liveApproval(text), false, text);
for (const text of ["Onay: 2.19'da (CANLI) görev yeniden kurulsun", 'Onay: deploy et', 'Onay: canli sunucu', 'Onay: canlıda değişiklik yap', 'Onay: yayına al'])
  assert.equal(liveApproval(text), true, text);
// The decision queue (phase 2): client.js statusQueue against its table (Tether's testStatusQueueMatchesTheMac reads it too).
const queueCases = JSON.parse(read('test/fixtures/status-queue.json')).cases;
for (const c of queueCases) {
  const cards = statusCards(c.data, c.now, { approvals: c.approvals });
  const got = statusQueue(cards, { sentences: c.sentences, options: c.options, later: c.later }).map((e) => ({ kind: e.kind, key: e.key, live: e.live }));
  assert.deepEqual(got, c.want, `queue: ${c.name}`);
}
assert.ok(queueCases.length >= 5, 'the queue table covers empty, order, live first, Sonra and a choice alone');
console.log(`status cards: ${cases.length} shared cases, marks, CANLI label; queue: ${queueCases.length} shared cases`);
