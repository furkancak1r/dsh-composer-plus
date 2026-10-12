// DSH plugin: publishes the host's authenticated loopback URL and runs the mobile gateway inside DSH,
// so it starts and stops with the app. Set DSH_MOBILE_STANDALONE=1 to run server.mjs yourself instead.
// Insert via ~/.dsh/profiles/desktop/cordis.patch.yml (see README).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../server.mjs'

export const name = 'dsh-mobile-bridge'
export const inject = ['connection', 'webServer']

export async function apply(ctx) {
  const dir = process.env.DSH_MOBILE_DIR || join(homedir(), '.dsh-mobile')
  const file = join(dir, 'upstream.url')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const url = await ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port)
  writeFileSync(file, String(url) + '\n', { mode: 0o600 })
  ctx.effect(() => () => rmSync(file, { force: true }), 'dsh-mobile-bridge')
  if (process.env.DSH_MOBILE_STANDALONE) return
  // shortcut: in-process, so a gateway crash could hit DSH; handlers catch their own errors. Move to a child process if that ever bites.
  const gw = createGateway({ dir })
  ctx.effect(() => () => { gw.close().catch(() => {}) }, 'dsh-mobile-gateway')
  try { await gw.listenAdmin(); await gw.start() } catch (e) { console.error('[dsh-mobile] gateway not started:', e.message) }
}
