// Tether parity: every Composer Plus feature has a row in tether/FEATURES.md ("yes" with a place, or "no" with a reason),
// and the gateway forwards only chat-level Composer Plus routes. Add the row in the same change as the feature.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { PLUS } from '../tether/gateway/server.mjs';
import * as host from '../index.js';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const features = [...src.match(/const FEATURES = \[([^\]]*)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
const rows = new Map([...readFileSync(new URL('../tether/FEATURES.md', import.meta.url), 'utf8').matchAll(/^\| (\w+) \| (yes|no) \| (.+) \|$/gm)]
  .map((m) => [m[1], { status: m[2], text: m[3].trim() }]));
for (const id of features) {
  const r = rows.get(id);
  assert.ok(r, `Composer Plus feature "${id}" has no row in tether/FEATURES.md: add it to Tether, or write why a phone does not need it`);
  assert.ok(r.text.length >= 10, `tether/FEATURES.md row "${id}" says where or why`);
}
for (const id of rows.keys()) assert.ok(features.includes(id), `tether/FEATURES.md row "${id}" is not in FEATURES`);

// Every PLUS route exists on the Host, and none of them is a switch, the updater, the screenshots or Mobile connect.
const routes = Object.entries(host).filter(([k, v]) => k.endsWith('_PATH') && typeof v === 'string').map(([, v]) => v);
for (const name of PLUS.keys()) assert.ok(routes.includes(`/api/composer-plus.${name}`), `PLUS "${name}" is a Host route`);
for (const name of ['mobile', 'resume', 'content-search', 'update', 'shot']) assert.ok(!PLUS.has(name), `PLUS never has "${name}"`);
console.log(`tether parity: ${features.length} features, ${[...rows.values()].filter((r) => r.status === 'yes').length} in Tether`);
