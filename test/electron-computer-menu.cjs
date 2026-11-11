// Desktop check of the right-click menu of the other Mac's page, by hand (needs an Electron binary; not in npm test).
// Run: env -u ELECTRON_RUN_AS_NODE /path/to/Electron.app/Contents/MacOS/Electron test/electron-computer-menu.cjs "$PWD/client.js"
// The real createComputerViews from client.js in an Electron 44 window (the shell of DSH 0.2.2), never shown: a real
// <webview> shows a page with a text field. The views sit 100 px from the left and the page 48 px from the top (a title
// bar space), so a wrong coordinate space shows. A right-click sent to the window (as the OS does) must open the menu at
// the pointer with dsh's items, and an item must run in the page. No clipboard command runs (the check must not change
// the user's clipboard): Undo and Select All prove the path.
// Expect: PASS and a JSON line.
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
app.dock?.hide();
const src = readFileSync(process.argv.at(-1), 'utf8');
const code = src.match(/\n    const COMPUTER_HELLO_MS[\s\S]*?\n      return api;\n    }\n/)[0];
const guest = 'data:text/html,' + encodeURIComponent('<body style="margin:0"><textarea id=t style="position:absolute;left:0;top:0;width:300px;height:100px">hello world</textarea>'
  + '<p id=p style="position:absolute;left:0;top:150px">plain text</p><div id=own style="position:absolute;left:0;top:250px;width:300px;height:50px">own menu</div>'
  + '<script>document.getElementById("own").addEventListener("contextmenu", (e) => e.preventDefault())</script></body>');
const host = 'data:text/html,' + encodeURIComponent(`<!doctype html><body style="margin:0"><button id=b>menu</button><script>
document.documentElement.style.setProperty('--dsh-frame-top-clearance', '48px');
${code}
const bridge = { acquire: async () => ({ lease: 'L1', partition: 'composer-plus-menu-check' }), release: async () => {}, onOpenRequested: () => () => {} };
const computers = { getSnapshot: () => ({ computers: [{ id: 'studio', state: 'ok', name: 'Studio' }] }), open: async () => ({ url: ${JSON.stringify(guest)} }),
  events: (after) => (after === undefined ? Promise.resolve({ seq: 0, events: [] }) : new Promise(() => {})), refresh: () => {} };
window.__views = createComputerViews({ computers, desktop: () => bridge });
window.__views.select('studio');
</script></body>`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const out = {};
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const attached = new Promise((r) => win.webContents.on('did-attach-webview', (_e, g) => r(g)));
  await win.loadURL(host);
  const g = await attached;
  for (let i = 0; i < 50 && !g.getURL().startsWith('data:'); i++) await wait(100);
  await win.webContents.executeJavaScript("document.querySelector('[data-composer-plus-computer-views]').style.left = '100px'");
  await wait(500);
  const snap = () => win.webContents.executeJavaScript('window.__views.getSnapshot().menu');
  // CDP input goes through Chromium's input router, which sends it to the frame under the pointer (the webview's page),
  // as a real click does. `sendInputEvent` of the window does not: its page gets the click.
  win.webContents.debugger.attach('1.3');
  const mouse = (type, x, y, button = 'right') => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 });
  const right = async (x, y) => {
    await win.webContents.executeJavaScript('window.__views.closeMenu()');
    await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
    await wait(700);
    return snap();
  };
  const left = async (x, y) => { await mouse('mouseMoved', x, y, 'left'); await mouse('mousePressed', x, y, 'left'); await mouse('mouseReleased', x, y, 'left'); await wait(500); };
  const field = (js) => g.executeJavaScript(`{ const t = document.getElementById('t'); ${js} }`);
  // A text field: dsh's edit items at the pointer (140, 78 = the page at 100, 48 + 40, 30 in the page).
  await field('t.focus(); t.setSelectionRange(5, 5);');
  g.insertText('X'); await wait(200);
  let m = await right(140, 78);
  assert.ok(m, 'a right-click in the text field opens the menu');
  assert.deepEqual([m.x, m.y], [140, 78], 'at the pointer, in window coordinates');
  assert.deepEqual(m.items.map((x) => (x === null ? '-' : x[0])), ['undo', 'redo', '-', 'cut', 'copy', 'paste', '-', 'selectAll']);
  out.editable = m.items;
  // dsh's menu takes the focus; Undo then runs in the page.
  await win.webContents.executeJavaScript("document.getElementById('b').focus(); window.__views.edit('undo')"); await wait(300);
  assert.equal(await field('t.value'), 'hello world', 'Undo ran in the page');
  assert.equal(await snap(), null, 'the menu closed');
  await right(140, 78);
  await win.webContents.executeJavaScript("document.getElementById('b').focus(); window.__views.edit('selectAll')"); await wait(300);
  assert.deepEqual(await field('[t.selectionStart, t.selectionEnd, document.activeElement.id]'), [0, 11, 't'], 'Select All ran in the field');
  // Selected text outside a field: Copy only. A part that draws its own menu (dsh's chat menu): no menu from us.
  await g.executeJavaScript("{ const r = document.createRange(); r.selectNodeContents(document.getElementById('p')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }");
  m = await right(120, 48 + 175); // on the selected words (the paragraph is at 0..60, 166..184 in the page)
  assert.deepEqual(m?.items, [['copy', true]], 'selected text: Copy');
  await g.executeJavaScript('getSelection().removeAllRanges()');
  assert.equal(await right(120, 48 + 270), null, 'the page drew its own menu: none from us');
  assert.equal(await right(600, 48 + 400), null, 'no field and no selection: no menu');
  // A click in the page while the menu is open (dsh's menu has the focus in this page): the menu closes.
  assert.ok(await right(140, 78), 'the menu is open');
  await win.webContents.executeJavaScript("document.getElementById('b').focus()"); await wait(400);
  assert.ok(await snap(), 'still open while the focus is in this page');
  await left(160, 78);
  assert.equal(await snap(), null, 'a click in the page of the other Mac closes the menu');
  out.electron = process.versions.electron;
  console.log('PASS ' + JSON.stringify(out));
  app.exit(0);
}).catch((e) => { console.error('FAIL', e); app.exit(1); });
