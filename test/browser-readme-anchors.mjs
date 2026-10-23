// Real-browser check of the README feature anchors (the Settings "?" links open them). For each of the 13 READMEs,
// GitHub's Markdown API renders the working-tree file, the check puts the result into GitHub's own blob page, and every
// #feature-<id> link must scroll the start of that feature's "How to use it" text into view, with the feature name.
// Headless Chrome: no window and no focus change, so it does not disturb the desktop. Needs github.com and
// api.github.com (13 Markdown API calls; set GITHUB_TOKEN when the 60 calls/hour anonymous limit is reached).
// PLAYWRIGHT=/path/to/playwright node test/browser-readme-anchors.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { DOC_LANGUAGES, anchorOf, readmeOf } from '../scripts/build-docs.mjs';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT) throw Error('Set PLAYWRIGHT');
const { chromium } = require(process.env.PLAYWRIGHT);
const REPO = 'furkancak1r/dsh-composer-plus';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const anchors = JSON.parse(read('docs/features.json')).features.map((f) => anchorOf(f.id));
const render = async (file) => {
  const res = await fetch('https://api.github.com/markdown', { method: 'POST', body: JSON.stringify({ text: read(file), mode: 'gfm', context: REPO }),
    headers: { accept: 'text/html', 'content-type': 'application/json', 'user-agent': 'dsh-composer-plus-check',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  assert.ok(res.ok, `GitHub Markdown API answered ${res.status} for ${file}`);
  // Relative image paths resolve against the blob page; point them at the files, so the rows get their real height.
  return (await res.text()).replaceAll('src="assets/', `src="/${REPO}/raw/main/assets/`);
};
const browser = await chromium.launch({ channel: 'chrome' });
const failed = [];
try {
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1280, height: 841 } });
  for (const lang of DOC_LANGUAGES) {
    const file = readmeOf(lang);
    const html = await render(file);
    await page.goto(`https://github.com/${REPO}/blob/main/${file}`);
    await page.locator('article.markdown-body').waitFor();
    await page.evaluate((html) => { document.querySelector('article.markdown-body').innerHTML = html; }, html);
    await page.waitForFunction(() => [...document.querySelectorAll('article.markdown-body img')].every((img) => img.complete), null, { timeout: 20000 });
    for (const anchor of anchors) {
      await page.evaluate((anchor) => { history.replaceState(null, '', location.pathname); scrollTo(0, 0); location.hash = anchor; }, anchor);
      await page.waitForFunction((anchor) => { const top = document.getElementById(`user-content-${anchor}`)?.getBoundingClientRect().top;
        return top >= 0 && top < innerHeight / 2; }, anchor, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(150);
      const r = await page.evaluate((anchor) => {
        const el = document.getElementById(`user-content-${anchor}`);
        if (!el) return { error: 'no anchor' };
        const row = el.closest('tr');
        const how = row.cells[1];
        const range = document.createRange(); range.selectNodeContents(how);
        const first = [...range.getClientRects()].find((rect) => rect.height > 0);
        const name = row.cells[0].querySelector('strong').getBoundingClientRect();
        const hit = document.elementFromPoint(how.getBoundingClientRect().left + 20, first.top + first.height / 2);
        return { inHow: how.contains(el), howTop: Math.round(first.top), howShown: how.contains(hit), nameShown: name.top >= 0 && name.bottom <= innerHeight };
      }, anchor);
      if (r.error || !r.inHow || !r.howShown || !r.nameShown || r.howTop >= 300) failed.push(`${file}#${anchor}: ${JSON.stringify(r)}`);
    }
  }
} finally { await browser.close(); }
assert.deepEqual(failed, [], `README anchors that do not show the start of their row:\n${failed.join('\n')}`);
console.log(`PASS: ${anchors.length} feature anchors in ${DOC_LANGUAGES.length} READMEs show the start of their "How to use it" text and the name`);
