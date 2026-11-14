// Typing lag in Settings → Project memory → Open memory (and in every text field): a style rule with `:has()` on the
// page root (`body:has(…) x`) makes the browser compute the style of the whole page again at each DOM change, so each key
// press cost about 33 ms of style work with 22 projects open (test/browser-memory-typing.mjs). Collapse all projects had
// such a rule. This check reads every style rule in the real client.js (with its `${…}` parts filled in by the real values)
// and fails on a `:has()` that hangs on `html`, `body` or `:root`. A `:has()` on a small element (a header row) is fine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
/** The `:has()` rules on the page root in a text. */
const rootHas = (text) => [...text.matchAll(/(?:^|[\s,{}>+~(])(?:html|body|:root)(?:[.#[:][^\s,{]*)?:has\(/g)].map((m) => m[0].trim());

// The matcher finds the old Collapse all projects rule and the other forms, and leaves the narrow ones.
assert.deepEqual(rootHas('body:has([data-row-key^="workspace:"][aria-expanded="true"]) [x] { display: inline-flex; }').length, 1);
for (const bad of ['html:has(.a) .b{}', ':root:has(.a){}', 'body.dark:has(.a) .b{}', '.x{} body:has(.a){}', 'a,body:has(.b){}']) assert.equal(rootHas(bad).length, 1, bad);
for (const ok of ['[class*="_headerActions"]:has(> [x]) { max-width: 92px; }', '.tbody:has(.a){}', '[data-body]:has(.a){}', 'tbody:has(tr){}', 'nobody:has(x){}']) assert.deepEqual(rootHas(ok), [], ok);

// Every rule in client.js: template literals and string literals, with each `${NAME}` replaced by the constant's value.
const consts = new Map([...source.matchAll(/const ([A-Z_][A-Z0-9_]*) = '([^'\n]*)';/g)].map((m) => [m[1], m[2]]));
const filled = source.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (all, name) => consts.get(name) ?? all);
const found = rootHas(filled);
assert.deepEqual(found, [], `style rules with :has() on the page root: ${found.join(', ')}`);

// A `:has()` with no element before it (`:has(> x) > y`, or after `*`) is the same as `*:has(…)`: it hangs on every
// element of the page, `html` and `body` too. dsh 0.2.2 (seen on 0.2.2-rc.1, 2026-11-12) runs this check with each key
// press in Open memory: one bare `:has()` rule cost about 55 ms of style work per key at CPU ×4. dsh 0.2.2-rc.1's own
// FilesBody rule `:has(>.k-1LKG_navigator.k-1LKG_fill)>…` was such a rule (dsh 0.2.2-rc.2 scoped it), and so was Reject
// with note's `:has(>[data-composer-plus-reject-note])` (65 ms per key with it on 0.2.2-rc.3).
const STOP = '{}`\'"';
const bareHas = (text) => [...text.matchAll(/:has\(/g)].filter(({ index }) => {
  if (text[index + 5] === ')') return false; // "`:has()`" in a comment
  let j = index - 1; while (j >= 0 && /\s/.test(text[j])) j--;
  if (text[j] === '*') { j--; while (j >= 0 && /\s/.test(text[j])) j--; }
  if (j < 0 || STOP.includes(text[j])) return true; // the start of a rule or a string
  if (text[j] !== ',') return false; // after an element: `x :has(…)`, `x > :has(…)`, `:is(:hover, :has(…))` …
  // After a comma: bare unless the comma is inside parentheses (`:is(:empty, :has(…))`).
  for (let k = j - 1, depth = 0; k >= 0 && !STOP.includes(text[k]); k--) { if (text[k] === ')') depth++; else if (text[k] === '(') { if (depth === 0) return false; depth--; } }
  return true;
}).map(({ index }) => text.slice(index, index + 50));
for (const bad of [':has(>.k-1LKG_navigator.k-1LKG_fill)>:not(.k-1LKG_navigator){visibility:hidden}', '@media (width<768px){:has(> .a) > b{}}', '.x{} * :has(.a){}', 'a, :has(.b){}', '`:has(>[x]){flex-wrap:wrap}\n:has(>[x])>y{}`']) assert.ok(bareHas(bad).length > 0, bad);
for (const ok of ['[x]:is(:hover,:has(:focus-visible)) y{}', '[data-approval-key] :has(> [y]) > button{}', '.a:has(.b){}', 'one `:has()` rule per chat', 'x > :has(.a){}', '.f:is(:empty, :has(> [d]:empty)){}']) assert.deepEqual(bareHas(ok), [], ok);
const bare = bareHas(filled);
assert.deepEqual(bare, [], `style rules with a bare :has() (no element before it): ${bare.join(', ')}`);

// The Collapse all projects style still hides the empty host and gives the header room only while the host is there.
const collapse = /const COLLAPSE_CSS = `([^`]*)`/.exec(filled)?.[1];
assert.ok(collapse !== undefined, 'COLLAPSE_CSS is in client.js');
assert.ok(collapse.includes('[data-composer-plus-collapse-projects]:empty { display: none; }'), 'an empty host takes no room');
assert.ok(collapse.includes('[class*="_headerActions"]:has(> [data-composer-plus-collapse-projects]):not([class*="_headerActionsHidden"]) { max-width: 92px; }'), 'room for a third button');
console.log('has-selectors checks passed');
