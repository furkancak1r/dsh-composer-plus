// Browser check for composer history (↑/↓). Needs a dsh web instance whose profile includes this plugin.
// Usage: node check.mjs '<dsh web URL with ?token=...>'
// Sends test messages to the current session, so use a throwaway instance (DSH_HOME=/tmp/...).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? `${process.env.HOME}/.dsh/local/playwright-mcp/node_modules/playwright`);

const url = process.argv[2];
if (!url) throw new Error('usage: node check.mjs <dsh web URL with ?token=...>');

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  // A fresh 0.2 home shows a preview notice, then asks for an API key; dismiss both if they appear.
  const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true });
  if (await notice.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await notice.click();
    await notice.waitFor({ state: 'detached' });
  }
  const later = page.getByRole('button', { name: 'Configure later' });
  if (await later.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await later.click();
    await later.waitFor({ state: 'detached' });
  }


  const input = page.locator('[data-composer-input]');
  const draft = async () => (await input.innerText()).replace(/\n$/, '');
  const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(150); return draft(); };
  const send = async (...lines) => {
    await input.click();
    for (const [i, line] of lines.entries()) {
      if (i > 0) await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(line);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction((t) => document.querySelector('[data-conversation-content]')?.innerText.includes(t), lines.at(-1));
    await page.waitForTimeout(500);
  };

  await send('h1');
  await send('h2');
  await send('l1', 'l2');
  await input.click();

  assert.equal(await press('ArrowUp'), 'l1\n\nl2', 'newest entry first');
  assert.equal(await press('ArrowUp'), 'l1\n\nl2', 'multi-line: caret walks to line 1 first');
  assert.equal(await press('ArrowUp'), 'h2');
  assert.equal(await press('ArrowUp'), 'h1');
  assert.equal(await press('ArrowUp'), 'h1', 'stays on the oldest entry');
  assert.equal(await press('ArrowDown'), 'h2');
  assert.equal(await press('ArrowDown'), 'l1\n\nl2');
  assert.equal(await press('ArrowDown'), '', 'past the newest entry: empty prompt');

  await press('ArrowUp');
  await press('ArrowUp');
  assert.equal(await press('ArrowUp'), 'h2');
  await page.keyboard.type('!');
  assert.equal(await press('ArrowUp'), 'h2!', 'an edited draft keeps normal caret keys');

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('/');
  await page.locator('[data-trigger-menu]').waitFor();
  assert.equal(await press('ArrowUp'), '/', 'an open slash menu owns the arrows');

  assert.deepEqual(errors, []);
  console.log('composer history: OK');
} finally {
  await browser.close();
}
