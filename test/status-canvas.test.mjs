// Damon canvas view (tuval; like the "Sonsuz tuval" HTML mockup since 2026-11-25): the pure parts of client.js StatusCanvas.
// - canvasLayout: the islands around the Damon hub at (0, 0): your groups at the left, the work at the right, the reply
//   cards above the hub, the summary below it; no two islands overlap and none covers the hub, for many random heights.
// - canvasEdge: the line from the hub meets the island's near side (top island: its bottom, bottom island: its top).
// - canvasZoom: the point under the pointer stays; the zoom stays in 25%–160% (the mockup's range).
// - canvasHome / canvasCenter: "Damon'a dön" puts the hub in the middle at 75%, smaller (at least 50%) when the island
//   columns do not fit beside the zoom buttons, 40% in a narrow window.
// - canvasMode: far (<50%: counts only), near, close (>=95%: every line of a card).
// - readCanvas / writeCanvas: localStorage `dsh-composer-plus.status-canvas`, only the view; junk and an old `pos` read as
//   nothing.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
const src = read('client.js');
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__cv = { canvasLayout, canvasEdge, canvasBounds, canvasZoom, canvasCenter, canvasHome, canvasMode, readCanvas, writeCanvas, CANVAS_KEY };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const { canvasLayout, canvasEdge, canvasBounds, canvasZoom, canvasCenter, canvasHome, canvasMode, readCanvas, writeCanvas, CANVAS_KEY } = globalThis.__cv;
assert.equal(CANVAS_KEY, 'dsh-composer-plus.status-canvas');

// canvasLayout: the mockup's places.
{
  const p = canvasLayout({ onay: 100, senden: 200, sorun: 80, suruyor: 150, bitti: 120, kararlar: 60, updates: 300, ozet: 90 });
  for (const k of ['onay', 'senden', 'sorun']) assert.equal(p[k].x, -720, `${k}: the left column`);
  for (const k of ['suruyor', 'bitti', 'kararlar']) assert.equal(p[k].x, 320, `${k}: the right column`);
  assert.ok(p.onay.y < p.senden.y && p.senden.y < p.sorun.y, 'left: Onay, Senden, Sorun from the top');
  assert.ok(p.suruyor.y < p.bitti.y && p.bitti.y < p.kararlar.y, 'right: Sürüyor, Bugün bitti, Kararlar from the top');
  assert.deepEqual(p.updates, { x: -200, y: -460, w: 400, h: 300, side: 't' }, 'the reply cards above the hub, growing up');
  assert.deepEqual(p.ozet, { x: -200, y: 160, w: 400, h: 90, side: 'b' }, 'the summary below the hub');
  const mid = (k1, k2) => (p[k1].y + p[k2].y + p[k2].h) / 2;
  assert.equal(mid('onay', 'sorun'), 0, 'the left column is centered at the hub');
  assert.equal(mid('suruyor', 'kararlar'), 0, 'the right column is centered at the hub');
  assert.deepEqual(Object.keys(canvasLayout({ onay: 100 })), ['onay'], 'an island without a height has no place');
  assert.deepEqual(canvasLayout({ onay: 100, sorun: 50 }).sorun.y, -(100 + 48 + 50) / 2 + 100 + 48, 'a missing island leaves no gap');
}
// Random heights: no overlap, the hub (a 208 px circle) stays free.
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (let run = 0; run < 300; run++) {
  const heights = {};
  for (const k of ['onay', 'senden', 'sorun', 'suruyor', 'bitti', 'kararlar', 'updates', 'ozet']) if (rnd() < 0.8) heights[k] = 60 + Math.floor(rnd() * 1400);
  const p = canvasLayout(heights); const list = Object.entries(p);
  assert.deepEqual(Object.keys(p).sort(), Object.keys(heights).sort(), 'every island with a height has a place');
  for (const [i, [ka, a]] of list.entries()) {
    assert.ok(a.x + a.w <= -104 || a.x >= 104 || a.y + a.h <= -104 || a.y >= 104, `run ${run}: ${ka} covers the hub`);
    for (const [kb, b] of list.slice(i + 1)) {
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `run ${run}: ${ka} ${JSON.stringify(a)} overlaps ${kb} ${JSON.stringify(b)}`);
    }
  }
  const b = canvasBounds(p);
  for (const o of [...Object.values(p), { x: -104, y: -104, w: 208, h: 208 }]) assert.ok(o.x >= b.x && o.y >= b.y && o.x + o.w <= b.x + b.w && o.y + o.h <= b.y + b.h, 'the bounds hold every island and the hub');
}
// canvasEdge: the near side, at the asked height inside the island (28 px from its corners).
{
  const left = { x: -720, y: -100, w: 400, h: 200, side: 'l' }; const right = { x: 320, y: 0, w: 400, h: 100, side: 'r' };
  assert.deepEqual(canvasEdge(left), [-320, 0], 'left: its right side, its middle');
  assert.deepEqual(canvasEdge(right, 1000), [320, 72], 'right: its left side, at most 28 px from the bottom');
  assert.deepEqual(canvasEdge({ x: -200, y: -500, w: 400, h: 340, side: 't' }), [0, -160], 'top: its bottom');
  assert.deepEqual(canvasEdge({ x: -200, y: 160, w: 400, h: 90, side: 'b' }), [0, 160], 'bottom: its top');
}
// canvasZoom: the point under the pointer stays where it was; 25%–160%.
{
  const v = { x: 120, y: -40, k: 1 };
  const z = canvasZoom(v, 1.5, 300, 200);
  const world = (view, px, py) => [(px - view.x) / view.k, (py - view.y) / view.k];
  assert.deepEqual(world(z, 300, 200).map((n) => Math.round(n * 1e6)), world(v, 300, 200).map((n) => Math.round(n * 1e6)), 'the point stays');
  assert.equal(z.k, 1.5);
  assert.equal(canvasZoom(v, 100, 0, 0).k, 1.6, 'at most 160%'); assert.equal(canvasZoom(v, 0.001, 0, 0).k, 0.25, 'at least 25%');
}
// canvasHome / canvasCenter: the hub in the middle.
{
  assert.deepEqual(canvasHome(1200, 800), { x: 600, y: 400, k: 0.75 }, 'the hub in the middle at 75%');
  assert.deepEqual(canvasHome(500, 800), { x: 250, y: 400, k: 0.4 }, 'a narrow window: 40%');
  // The columns do not fit at 75%: a smaller zoom keeps the left column 58 px from the edge (clear of the zoom buttons).
  for (const w of [1000, 1080, 1160]) { const v = canvasHome(w, 700); assert.ok(v.k < 0.75 && Math.abs(v.x - 720 * v.k - 58) < 1e-9, `${w} px: the left column 58 px from the edge (${v.k})`); }
  assert.equal(canvasHome(700, 700).k, 0.5, 'at least 50%: the cards stay');
  const c = canvasCenter(320, 100, 1, 1000, 600); assert.deepEqual([(500 - c.x) / c.k, (300 - c.y) / c.k], [320, 100], 'the asked point in the middle');
  assert.equal(canvasCenter(0, 0, 9, 1000, 600).k, 1.6, 'center keeps the zoom range');
}
// canvasMode: the mockup's three levels.
assert.deepEqual([0.25, 0.49, 0.5, 0.94, 0.95, 1.6].map(canvasMode), ['far', 'far', 'near', 'near', 'close', 'close']);
// readCanvas / writeCanvas: only the view.
{
  assert.deepEqual(readCanvas(), { view: null }, 'nothing saved');
  for (const junk of ['{', '42', 'null', '[]', '{"view":{"x":1,"y":2,"k":9}}', '{"view":{"x":1,"y":null,"k":1}}', '{"view":{"x":1,"y":2,"k":0.1}}']) {
    mem.set(CANVAS_KEY, junk);
    assert.deepEqual(readCanvas(), { view: null }, `junk reads as empty: ${junk}`);
  }
  mem.set(CANVAS_KEY, '{"view":{"x":1,"y":2,"k":0.5},"pos":{"a":{"x":3,"y":4}}}');
  assert.deepEqual(readCanvas(), { view: { x: 1, y: 2, k: 0.5 } }, 'an old saved view stays; its card places are left out');
  writeCanvas({ x: 5, y: 6, k: 1.2 });
  assert.deepEqual(JSON.parse(mem.get(CANVAS_KEY)), { view: { x: 5, y: 6, k: 1.2 } }, 'only the view is written');
  const blocked = globalThis.localStorage.setItem; globalThis.localStorage.setItem = () => { throw Error('quota'); };
  writeCanvas({ x: 1, y: 1, k: 1 }); globalThis.localStorage.setItem = blocked; // no throw
}
console.log('status-canvas: ok');
