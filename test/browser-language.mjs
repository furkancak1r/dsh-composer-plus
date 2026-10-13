// Isolated real-app check; never uses the normal DSH_HOME or sends a model request.
// PLAYWRIGHT=/path/to/playwright node test/browser-language.mjs /path/to/dsh/lib/bin.js [...]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT || process.argv.length < 3) throw Error('Set PLAYWRIGHT and pass one or more dsh CLI entry paths');
const { chromium } = require(process.env.PLAYWRIGHT);
const repo = fileURLToPath(new URL('..', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (const bin of process.argv.slice(2)) {
    const home = await mkdtemp(join(tmpdir(), 'dsh-language-'));
    const profile = join(home, 'profiles/web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await symlink(repo, join(profile, 'node_modules/dsh-composer-plus'));
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'locale-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-composer-plus'] } } }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
    const child = spawn(process.execPath, [bin, '--profile', 'web', '--port', '3195', '--no-open'], { cwd: home, env: { ...process.env, DSH_HOME: home, npm_config_cache: join(tmpdir(), 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const errors = []; const contexts = [];
    try {
      for (let i = 0; i < 120 && !log.match(/http:\/\/[^\s]*token=[^\s]*/); i++) { if (child.exitCode !== null) throw Error(`test dsh exited (${child.exitCode})`); await pause(250); }
      const url = log.match(/http:\/\/[^\s]*token=[^\s]*/)?.[0]; assert.ok(url, 'test server URL available');
      const dismissSetup = async (page) => {
        for (const name of [/^(Continue|Devam et|继续)$/, /^(Configure later|Daha sonra yapılandır|稍后配置)$/]) { // only used for en/tr/zh pages
          const button = page.getByRole('button', { name, exact: true });
          if (await button.waitFor({ timeout: 1500 }).then(() => true, () => false)) { await button.click(); await button.waitFor({ state: 'hidden' }); }
        }
      };
      const open = async (locale, nativeLanguages) => {
        const context = await browser.newContext({ locale, viewport: { width: 1500, height: 1000 } }); contexts.push(context);
        if (nativeLanguages) await context.addInitScript((languages) => { globalThis.__DSH_LOCALE__ = { read: async () => ({ languages, preference: null }), onChange: () => {} }; }, nativeLanguages);
        const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url);
        await dismissSetup(page);
        return page;
      };
      const languageIs = async (page, id) => { await page.waitForFunction((lang) => document.documentElement.lang === lang, id); };
      const settings = async (page) => {
        await dismissSetup(page);
        await page.getByRole('button', { name: /^(Settings|Ayarlar|设置)$/, exact: true }).click();
        await page.getByText('Composer Plus', { exact: true }).click();
        await page.locator('[data-composer-plus-language]').waitFor();
      };
      const choose = async (page, label) => {
        await page.locator('[data-composer-plus-language] button[aria-haspopup=menu]').click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
      };
      const tr = await open('tr-TR'); await languageIs(tr, 'tr'); await settings(tr);
      assert.ok((await tr.locator('[data-composer-plus-settings]').innerText()).includes('Uygulama dili'));
      assert.ok(await tr.getByText('Genel', { exact: true }).isVisible(), 'native General tab translated');
      assert.ok(await tr.getByText('Modeller', { exact: true }).isVisible(), 'native Models tab translated');
      assert.ok((await tr.locator('[data-composer-plus-language] button[aria-haspopup=menu]').innerText()).includes('Sistem dili'));
      await choose(tr, 'English'); await languageIs(tr, 'en');
      assert.ok((await tr.locator('[data-composer-plus-settings]').innerText()).includes('Application language'));
      await tr.reload(); await languageIs(tr, 'en'); await settings(tr);
      assert.ok((await tr.locator('[data-composer-plus-language] button[aria-haspopup=menu]').innerText()).includes('English'));
      const other = await open('zh-CN'); await languageIs(other, 'en'); await other.close();
      await choose(tr, 'System language'); await languageIs(tr, 'tr');
      await tr.reload(); await languageIs(tr, 'tr');
      await tr.screenshot({ path: join(home, 'turkish.png') }); await tr.close();
      for (const [system, expected] of [['en-US', 'en'], ['th-TH', 'en'], ['fr-FR', 'fr'], ['ja-JP', 'ja'], ['pt-BR', 'pt-BR'], ['zh-CN', 'zh-CN']]) {
        const page = await open(system); await languageIs(page, expected); await page.close();
      }
      const native = await open('en-US', ['tr-TR']); await languageIs(native, 'tr'); await settings(native);
      await choose(native, '中文'); await languageIs(native, 'zh-CN');
      await choose(native, 'Türkçe'); await languageIs(native, 'tr');
      assert.ok((await native.locator('[data-composer-plus-settings]').innerText()).includes('Tek tıkla devam'));
      const box = await native.locator('[data-composer-plus-language] button[aria-haspopup=menu]').boundingBox();
      assert.ok(box.height <= 32, `language selector stays compact (${box.height}px)`);
      await native.screenshot({ path: join(home, 'turkish-settings.png') });
      assert.deepEqual(errors, [], 'no browser exceptions');
      console.log('PASS: system tr/en/zh/fr/ja/pt-BR/unsupported(th), native OS precedence, explicit override, persistence, clear override, live UI switching;', home);
    } catch (error) {
      const page = contexts.at(-1)?.pages().at(-1);
      if (page) {
        await page.screenshot({ path: join(home, 'failed.png') }).catch(() => {});
        console.error((await page.locator('body').innerText()).slice(0, 2200));
      }
      throw error;
    } finally {
      for (const context of contexts) await context.close();
      await writeFile(join(home, 'server.log'), log); // token stays inside the temporary test home, never stdout.
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    }
  }
} finally { await browser.close(); }
