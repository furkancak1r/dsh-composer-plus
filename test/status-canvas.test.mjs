// Damon canvas view (tuval, 2026-11-24): the pure parts of client.js StatusCanvas.
// - canvasPlace: a card without a place goes into its group's column, at the first height where it touches no other
//   card (saved places, measured sizes); many random layouts give no overlap.
// - canvasZoom: the point under the pointer stays; the zoom stays in 10%–200%.
// - canvasFit: every card is inside the viewport, at most 100%.
// - readCanvas / writeCanvas: localStorage `dsh-composer-plus.status-canvas`, checked on read (junk reads as empty),
//   merged on write (another window's places stay), `drop` forgets places.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
const ANCHOR = '/** Feature switches, in Settings order.';
const src = read('client.js');
assert.ok(src.includes(ANCHOR));
eval(src.replace(ANCHOR, `globalThis.__cv = { canvasPlace, canvasZoom, canvasFit, readCanvas, writeCanvas, CANVAS_KEY, CANVAS_W, CANVAS_GAP };\n    ${ANCHOR}`));
mod.factory((n) => (n === 'react' ? { createElement: () => null } : {}));
const { canvasPlace, canvasZoom, canvasFit, readCanvas, writeCanvas, CANVAS_KEY, CANVAS_W, CANVAS_GAP } = globalThis.__cv;
assert.equal(CANVAS_KEY, 'dsh-composer-plus.status-canvas');

// canvasPlace: columns, under the cards that are there, nothing for a card that has a place.
const col = (n) => n * (CANVAS_W + CANVAS_GAP);
assert.deepEqual(canvasPlace([{ key: 'a', col: 0 }, { key: 'b', col: 0 }, { key: 'c', col: 2 }], {}, { a: { w: CANVAS_W, h: 100 }, b: { w: CANVAS_W, h: 50 } }),
  { a: { x: 0, y: 0 }, b: { x: 0, y: 100 + CANVAS_GAP }, c: { x: col(2), y: 0 } }, 'a column per group, one card under the other');
assert.deepEqual(canvasPlace([{ key: 'a', col: 0 }, { key: 'b', col: 0 }], { a: { x: 0, y: 500 } }, { a: { w: CANVAS_W, h: 80 }, b: { w: CANVAS_W, h: 60 } }),
  { b: { x: 0, y: 0 } }, 'a place that is free above a moved card is used');
assert.deepEqual(canvasPlace([{ key: 'a', col: 1 }, { key: 'b', col: 1 }], { a: { x: col(1) + 40, y: 10 } }, { a: { w: CANVAS_W, h: 90 }, b: { w: CANVAS_W, h: 60 } }),
  { b: { x: col(1), y: 10 + 90 + CANVAS_GAP } }, 'a card that you moved into the column: the new one goes under it');
assert.deepEqual(canvasPlace([{ key: 'a', col: 0 }], { a: { x: 3, y: 4 } }, {}), {}, 'a card with a place keeps it');
assert.deepEqual(canvasPlace([{ key: 'b', col: 0 }], { a: { x: 0, y: 0 } }, { a: { w: CANVAS_W, h: 100 }, b: { w: CANVAS_W, h: 50 } }),
  { b: { x: 0, y: 100 + CANVAS_GAP } }, 'the saved place of a card that is away stays free');
// Random layouts: no two cards overlap (with the gap), and a saved place never moves.
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (let run = 0; run < 300; run++) {
  const items = Array.from({ length: 2 + Math.floor(rnd() * 14) }, (_, i) => ({ key: `k${i}`, col: Math.floor(rnd() * 6) }));
  const size = Object.fromEntries(items.map((i) => [i.key, { w: CANVAS_W, h: 30 + Math.floor(rnd() * 300) }]));
  const pos = {};
  for (const i of items) if (rnd() < 0.4) pos[i.key] = { x: Math.floor(rnd() * 1800) - 200, y: Math.floor(rnd() * 1200) - 200 };
  // Saved places can overlap each other (you put them so); only the new ones must be free.
  const placed = canvasPlace(items, pos, size);
  for (const key of Object.keys(pos)) assert.equal(placed[key], undefined, 'a saved place stays');
  const all = { ...pos, ...placed };
  for (const i of items) assert.ok(Number.isFinite(all[i.key]?.x) && Number.isFinite(all[i.key]?.y), 'every card has a place');
  for (const key of Object.keys(placed)) {
    const a = { ...all[key], ...size[key] };
    for (const other of items) {
      if (other.key === key) continue;
      const b = { ...all[other.key], ...size[other.key] };
      const apart = a.x + a.w + CANVAS_GAP <= b.x || b.x + b.w + CANVAS_GAP <= a.x || a.y + a.h + CANVAS_GAP <= b.y || b.y + b.h + CANVAS_GAP <= a.y;
      assert.ok(apart, `run ${run}: ${key} ${JSON.stringify(a)} touches ${other.key} ${JSON.stringify(b)}`);
    }
  }
}

// canvasZoom: the point under the pointer stays where it was; 10%–200%.
{
  const v = { x: 120, y: -40, k: 1 };
  const z = canvasZoom(v, 1.5, 300, 200);
  const world = (view, px, py) => [(px - view.x) / view.k, (py - view.y) / view.k];
  assert.deepEqual(world(z, 300, 200).map((n) => Math.round(n * 1e6)), world(v, 300, 200).map((n) => Math.round(n * 1e6)), 'the point stays');
  assert.equal(z.k, 1.5);
  assert.equal(canvasZoom(v, 100, 0, 0).k, 2, 'at most 200%'); assert.equal(canvasZoom(v, 0.001, 0, 0).k, 0.1, 'at least 10%');
}

// canvasFit: every card inside the viewport, at most 100%, also a far card.
{
  const rects = [{ x: 0, y: 0, w: 280, h: 120 }, { x: 1600, y: 900, w: 280, h: 300 }, { x: -400, y: 50, w: 280, h: 80 }];
  for (const [W, H] of [[1280, 800], [600, 400], [3000, 2000]]) {
    const v = canvasFit(rects, W, H);
    assert.ok(v.k <= 1 && v.k >= 0.1, `zoom ${v.k}`);
    for (const r of rects) {
      const left = v.x + r.x * v.k; const top = v.y + r.y * v.k;
      assert.ok(left >= 0 && top >= 0 && left + r.w * v.k <= W + 0.001 && top + r.h * v.k <= H + 0.001, `${W}x${H}: ${JSON.stringify(r)} inside`);
    }
  }
  assert.equal(canvasFit([{ x: 0, y: 0, w: 280, h: 100 }], 1280, 800).k, 1, 'a small layout is not blown up');
  assert.deepEqual(canvasFit([], 1280, 800).k, 1, 'no card: 100%');
}

// readCanvas / writeCanvas.
{
  assert.deepEqual(readCanvas(), { view: null, pos: {} }, 'nothing saved');
  for (const junk of ['{', '42', 'null', '[]', '{"view":{"x":1,"y":2,"k":9},"pos":{"a":{"x":"1","y":2},"b":null}}', '{"view":{"x":1,"y":null,"k":1}}']) {
    mem.set(CANVAS_KEY, junk);
    assert.deepEqual(readCanvas(), { view: null, pos: {} }, `junk reads as empty: ${junk}`);
  }
  mem.delete(CANVAS_KEY);
  writeCanvas({ view: { x: 1, y: 2, k: 0.5 } });
  writeCanvas({ pos: { a: { x: 10, y: 20 } } });
  // Another window saves its card in between: a write of this window keeps it.
  const other = JSON.parse(mem.get(CANVAS_KEY)); other.pos.b = { x: 5, y: 6 }; mem.set(CANVAS_KEY, JSON.stringify(other));
  writeCanvas({ pos: { a: { x: 11, y: 21 } } });
  assert.deepEqual(readCanvas(), { view: { x: 1, y: 2, k: 0.5 }, pos: { a: { x: 11, y: 21 }, b: { x: 5, y: 6 } } }, 'merged');
  writeCanvas({ drop: ['b'] });
  assert.deepEqual(readCanvas().pos, { a: { x: 11, y: 21 } }, 'drop forgets a place');
  const blocked = globalThis.localStorage.setItem; globalThis.localStorage.setItem = () => { throw Error('quota'); };
  writeCanvas({ pos: { c: { x: 1, y: 1 } } }); globalThis.localStorage.setItem = blocked; // no throw
}
console.log('status-canvas: ok');
