// Desktop check of "Remember window size", by hand (needs an Electron binary; not in npm test).
// Run: env -u ELECTRON_RUN_AS_NODE /path/to/Electron.app/Contents/MacOS/Electron test/electron-window-size.cjs "$PWD/client.js"
// Expect: first = 1280 x 820, saved = the set bounds, restored = the saved bounds, offscreen = on the main display.
// Real-shell check of "Remember window size": the real installWindowSize from client.js in an Electron 44 window with
// DSH 0.2.2's window options, never shown. Start 1 saves the bounds; start 2 (a new window that gets the saved value)
// restores them. data: page (other URLs fail to load in this sandboxed shell), so a Proxy gives the function the desktop
// app's dsh-app: protocol and a small storage object; visibilityState is forced to "visible" (the window is never shown).
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
app.dock?.hide();
const src = readFileSync(process.argv.at(-1), 'utf8');
const fn = src.match(/const WINDOW_SIZE_KEY = [\s\S]*?\n    }\n/)[0];
const page = (saved) => 'data:text/html,' + encodeURIComponent(`<!doctype html><script>
Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
window.__store = new Map(${JSON.stringify(saved === null ? [] : [['dsh-composer-plus.windowSize', saved]])});
const storage = { getItem: (k) => window.__store.get(k) ?? null, setItem: (k, v) => window.__store.set(k, String(v)) };
${fn}
const desk = new Proxy(window, { get: (t, k) => (k === 'location' ? { protocol: 'dsh-app:' } : k === 'localStorage' ? storage : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
window.__off = installWindowSize(desk, true);
</script><p>x</p>`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const make = () => new BrowserWindow({ width: 1280, height: 820, minWidth: 520, minHeight: 600, show: false, titleBarStyle: 'hiddenInset' });
app.whenReady().then(async () => {
  const out = {};
  let w = make(); await w.loadURL(page(null)); await wait(300);
  out.first = w.getBounds();
  w.setBounds({ x: 182, y: 53, width: 1673, height: 985 }); await wait(2600);
  out.saved = await w.webContents.executeJavaScript('window.__store.get("dsh-composer-plus.windowSize") ?? null');
  // A restart: dsh's window starts at 1280 x 820 again, then the page loads.
  const restart = async (saved) => { w.setBounds({ x: 320, y: 66, width: 1280, height: 820 }); await wait(200); await w.loadURL(page(saved)).catch((e) => { out.loadError = String(e).slice(0, 80); }); await wait(600); return w.getBounds(); };
  out.restored = await restart(out.saved);
  out.offscreen = await restart(JSON.stringify({ x: -9000, y: -9000, w: 20000, h: 20000 }));
  out.offscreen = w.getBounds();
  console.log(JSON.stringify(out));
  app.exit(0);
});
