// DSH plugin: publishes the host's authenticated loopback URL for the mobile gateway.
// Insert via ~/.dsh/profiles/desktop/cordis.patch.yml (see README).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-mobile-bridge'
export const inject = ['connection', 'webServer']

export async function apply(ctx) {
  const dir = process.env.DSH_MOBILE_DIR || join(homedir(), '.dsh-mobile')
  const file = join(dir, 'upstream.url')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const url = await ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port)
  writeFileSync(file, String(url) + '\n', { mode: 0o600 })
  ctx.effect(() => () => rmSync(file, { force: true }), 'dsh-mobile-bridge')
}
