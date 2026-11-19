// Copy buttons in the other Mac's page (Remote computers on dsh desktop). Headless, no real dsh run, and no real clipboard:
// the Chromium headless shell keeps its own clipboard in memory. dsh's desktop app shows that page in a <webview> whose
// session refuses every permission (desktop lib/main.js `DesktopBrowserGuests.configureSession`), so
// `navigator.clipboard.writeText` fails there and dsh's `writeClipboard` reports a failure. This check serves a page from a
// loopback port as the relay does (`http://127.0.0.1:<port>`, a secure context, a top-level document), refuses the
// clipboard-write permission as that session does, and clicks a Copy button that runs dsh's own `writeClipboard` (taken
// from the web bundle of each dsh given):
// 1. Without the fallback: the button reports a failure and the clipboard keeps its old text (Furkan's report).
// 2. With client.js `COMPUTER_PAGE_COPY` run in the page (as the webview's dom-ready runs it): the text is on the
//    clipboard, the helper reports success, the focus and the selection of a text field stay, and the page's own copy
//    listener sees no event.
// 3. The permission allowed (dsh's own window): the real call copies, and the copy command does not run.
// PLAYWRIGHT=/path/to/playwright node test/browser-remote-copy.mjs /path/to/dsh/lib/bin.js [...]
// An argument that ends with `.js` and is not `bin.js` is read as dsh's web bundle itself (for an unpacked desktop app).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const fallback = JSON.parse(client.match(/const COMPUTER_PAGE_COPY = ("(?:[^"\\]|\\.)*");/)[1]);
const HELPER = /async function ([\w$]+)\(([\w$]+)\)\{if\(navigator\.clipboard\?\.writeText\)try\{[\s\S]*?finally\{[\w$]+\.remove\(\)\}\}/;
/** dsh's `writeClipboard` (primitives), as its web bundle has it, renamed to `writeClipboard`. */
function dshHelper(arg) {
  const files = arg.endsWith('.js') && !arg.endsWith('bin.js') ? [arg]
    : (() => { const dir = join(dirname(arg), '../../dsh-web-frontend/dist/assets'); return readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f)).map((f) => join(dir, f)); })();
  for (const f of files) { const m = readFileSync(f, 'utf8').match(HELPER); if (m) return { file: f, code: m[0].replace(`async function ${m[1]}(`, 'async function writeClipboard(') }; }
  throw Error(`no writeClipboard in ${arg}`);
}

const TEXT = 'npm test -- remote-copy';
const page = (helper) => `<!doctype html><meta charset=utf-8><body>
<textarea id=field>keep this selection</textarea><button id=copy>Copy</button>
<script>
${helper}
window.pageCopyEvents = 0; document.addEventListener('copy', () => { window.pageCopyEvents++; });
window.commands = 0; const exec = document.execCommand.bind(document); document.execCommand = (...a) => { window.commands++; return exec(...a); };
const field = document.getElementById('field'); field.focus(); field.setSelectionRange(5, 9);
// As dsh's icon button: the click runs writeClipboard and keeps the result. The button takes no focus here, so the
// check sees whether the copy itself moves the focus or the selection.
document.getElementById('copy').addEventListener('mousedown', (e) => e.preventDefault());
document.getElementById('copy').addEventListener('click', async () => {
  const before = [document.activeElement, field.selectionStart, field.selectionEnd];
  const ok = await writeClipboard(${JSON.stringify(TEXT)});
  window.result = { ok, focus: document.activeElement === before[0], selection: field.selectionStart === before[1] && field.selectionEnd === before[2] };
});
</script></body>`;

const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  for (const arg of process.argv.slice(2)) {
    const helper = dshHelper(arg);
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page(helper.code)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext();
    try {
      const tab = await context.newPage();
      const errors = []; tab.on('pageerror', (e) => errors.push(String(e)));
      const { targetInfo } = await (await context.newCDPSession(tab)).send('Target.getTargetInfo');
      const cdp = await browser.newBrowserCDPSession();
      const permission = (name, setting) => cdp.send('Browser.setPermission', { origin, browserContextId: targetInfo.browserContextId, setting,
        permission: name === 'clipboard-write' ? { name, allowWithoutSanitization: false } : { name } });
      await permission('clipboard-read', 'granted'); // only the check reads the clipboard back
      await tab.goto(origin);
      const clip = () => tab.evaluate(() => navigator.clipboard.readText());
      const facts = await tab.evaluate(() => ({ secure: isSecureContext, top: window === top, api: typeof navigator.clipboard?.writeText }));
      assert.deepEqual(facts, { secure: true, top: true, api: 'function' }, 'a secure top-level page with the clipboard API, as the relay page');
      await permission('clipboard-write', 'granted'); await tab.evaluate(() => navigator.clipboard.writeText('old text'));
      assert.equal(await clip(), 'old text');

      // 1. The permission refused (the webview's session), no fallback: Copy fails.
      await permission('clipboard-write', 'denied');
      const refused = await tab.evaluate(() => navigator.clipboard.writeText('x').then(() => 'ok', (e) => `${e.name}: ${e.message}`));
      assert.match(refused, /NotAllowedError/, `the clipboard API is refused: ${refused}`);
      await tab.click('#copy'); await tab.waitForFunction(() => window.result !== undefined);
      assert.equal((await tab.evaluate(() => window.result)).ok, false, 'without the fallback: dsh reports a failure');
      assert.equal(await clip(), 'old text', 'without the fallback: nothing copied');
      console.log(`  1: ${origin}, permission refused → ${refused}; dsh's Copy reports a failure, the clipboard keeps its old text`);

      // 2. The fallback in the page (the webview's dom-ready): the same click copies.
      await tab.evaluate(fallback); await tab.evaluate(() => { window.result = undefined; });
      await tab.click('#copy'); await tab.waitForFunction(() => window.result !== undefined);
      assert.deepEqual(await tab.evaluate(() => window.result), { ok: true, focus: true, selection: true }, 'Copy works; the focus and the selection stay');
      assert.equal(await clip(), TEXT, 'the clipboard holds the text');
      assert.equal(await tab.evaluate(() => window.pageCopyEvents), 0, 'the page\'s copy listener sees no event');
      console.log(`  2: COMPUTER_PAGE_COPY → Copy reports success, clipboard = ${JSON.stringify(TEXT)}, focus and selection kept, no page copy event`);

      // 3. The permission allowed (dsh's own window): the real call, no copy command.
      await permission('clipboard-write', 'granted');
      await tab.reload(); await tab.evaluate(fallback);
      await tab.evaluate(() => navigator.clipboard.writeText('old text'));
      await tab.click('#copy'); await tab.waitForFunction(() => window.result !== undefined);
      assert.equal((await tab.evaluate(() => window.result)).ok, true);
      assert.equal(await clip(), TEXT);
      assert.equal(await tab.evaluate(() => window.commands), 0, 'a permission that works: no copy command');
      console.log('  3: permission allowed → the real clipboard call copies, no copy command');
      assert.deepEqual(errors, [], 'no page errors');
      console.log(`PASS ${helper.file}`);
    } finally { await context.close(); server.close(); }
  }
} finally { await browser.close(); }
