// docs/ROUTES.md documents every Host route: each (route, method) that index.js registers has a row in docs/features.json
// (`routes`), each documented one still exists, each names a feature, and the Tether column follows PLUS.
// Add a new route to `routes` in docs/features.json, then run `npm run build:readme`.
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { hostRoutes, source } from '../scripts/build-docs.mjs';
import { PLUS } from '../tether/gateway/server.mjs';
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const features = [...src.match(/const FEATURES = \[([^\]]*)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
const PREFIX = '/api/composer-plus.';
const registered = (await hostRoutes()).flatMap((r) => r.methods.map((m) => `${m} ${r.path}`)).sort();
assert.ok(registered.length > 20, 'the Host routes were read');
const { routes } = source();
const documented = routes.flatMap((r) => Object.keys(r.request).map((m) => `${m} ${PREFIX}${r.name}`)).sort();
const undocumented = registered.filter((r) => !documented.includes(r));
const gone = documented.filter((r) => !registered.includes(r));
assert.deepEqual(undocumented, [], `Host routes without a row in docs/ROUTES.md (add them to "routes" in docs/features.json, then run npm run build:readme):\n${undocumented.join('\n')}`);
assert.deepEqual(gone, [], `docs/ROUTES.md lists routes that index.js no longer registers:\n${gone.join('\n')}`);
for (const r of routes) {
  assert.ok(features.includes(r.feature) || r.feature === 'Settings', `route "${r.name}" names a FEATURES id (or Settings), not "${r.feature}"`);
  for (const [method, text] of Object.entries(r.request)) assert.ok(typeof text === 'string' && text.length >= 10, `route "${r.name}" ${method} says what it takes`);
}
// The Tether column is PLUS itself: a phone route never documents a switch as callable.
const doc = readFileSync(new URL('../docs/ROUTES.md', import.meta.url), 'utf8');
for (const r of routes) for (const method of Object.keys(r.request)) {
  const row = doc.split('\n').find((line) => line.startsWith(`| \`${PREFIX}${r.name}\` | ${method} |`));
  assert.ok(row?.endsWith(PLUS.get(r.name)?.includes(method) ? '| yes |' : '| no |'), `docs/ROUTES.md: ${method} ${r.name} shows the PLUS state`);
}
console.log(`routes doc: ${registered.length} Host route methods documented`);
