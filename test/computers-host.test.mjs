// Remote computers, the Host half (`computersService` and the `/api/composer-plus.computers` route): two Macs in one process.
// B accepts (its front door is a real computer-mode gateway on loopback), A adds B with B's link, B approves, A opens B
// through its relay. Run: node --test test/computers-host.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createConnection } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computersService, apply, COMPUTERS_PATH } from '../index.js'
import { createGateway } from '../tether/gateway/server.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('timed out'); await sleep(10) } }
const listening = (port) => new Promise((ok) => { const s = createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); ok(true) }); s.on('error', () => ok(false)) })

async function mockDsh(page) {
  const http = createServer((req, res) => {
    if (req.url === '/?token=t') { res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-b=1' }); return res.end() }
    if (!(req.headers.cookie ?? '').includes('dsh-auth-b=1')) { res.writeHead(401); return res.end() }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
  })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${http.address().port}/?token=t`, close: () => { http.closeAllConnections(); http.close() } }
}
// B's front door on loopback (the test's "tailnet").
const loopbackDoor = (o) => createGateway({ ...o, notify: false, tailnetOnly: false, tailscale: { installed: true, online: true, ip: '127.0.0.1', name: null }, netInfo: () => ({ address: '127.0.0.1', netmask: '255.0.0.0', bind: '127.0.0.1' }), port: 0, macName: 'Studio Mac' })
function mac(name, dsh, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cp-host-'))
  const file = join(home, 'computers.json')
  const made = []
  const s = computersService({ file, dir: join(home, 'door'), upstreamUrl: () => dsh?.url, macName: name, make: (o) => { const g = loopbackDoor(o); made.push(g); return g }, ...extra })
  return { s, file, home, made }
}
const get = (port, path, cookie) => new Promise((ok, bad) => {
  request({ host: '127.0.0.1', port, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (d) => { b += d }).on('end', () => ok({ status: res.statusCode, headers: res.headers, body: b }))
  }).on('error', bad).end()
})
async function openInBrowser(url) {
  const u = new URL(url)
  const first = await get(Number(u.port), u.pathname + u.search)
  assert.equal(first.status, 303)
  const cookie = String(first.headers['set-cookie']).split(';')[0]
  return get(Number(u.port), '/', cookie)
}

test('off by default; everything else waits for the switch; a bad body is refused', async () => {
  const a = mac('Office Mac')
  try {
    const v = await a.s.view()
    assert.equal(v.on, false)
    assert.deepEqual(v.computers, [])
    assert.equal(v.accept.on, false)
    assert.equal((await a.s.handle({ action: 'add', link: 'x' })).status, 409)
    assert.equal((await a.s.handle({ accept: true })).status, 409)
    assert.equal((await a.s.handle({ on: 'yes' })).status, 400)
    assert.equal((await a.s.handle({ on: true })).status, 200)
    assert.equal((await a.s.handle({ action: 'nope' })).status, 400)
    assert.equal((await a.s.handle(null)).status, 400)
    assert.equal((await a.s.handle({ accept: 1 })).status, 400)
    assert.equal(a.made.length, 0, 'no front door without "Let other computers open this Mac"')
    assert.equal((statSync(a.file).mode & 0o777), 0o600, 'owner-only file')
  } finally { await a.s.close() }
})

test('add → Approve on B → open: A shows B\'s dsh; a pasted link with a wrong address or a Tether link is refused', async () => {
  const dsh = await mockDsh('<html>dsh of Studio Mac</html>')
  const b = mac('Studio Mac', dsh)
  const a = mac('Office Mac')
  try {
    await b.s.handle({ on: true })
    const accepted = (await b.s.handle({ accept: true })).body
    assert.equal(accepted.accept.running, true)
    const link = (await b.s.handle({ action: 'code' })).body.accept.code.payload
    assert.match(link, /^dsh-computer:\/\/pair\?/)
    await a.s.handle({ on: true })
    assert.deepEqual((await a.s.handle({ action: 'add', link: 'tether://pair?v=1&host=192.168.1.2' })).body, { error: 'tether-link' })
    assert.deepEqual((await a.s.handle({ action: 'add', link: link.replace('127.0.0.1', '192.168.1.9') })).body, { error: 'bad-link' })
    const adding = a.s.handle({ action: 'add', link, name: 'Studio Mac' })
    const pend = await waitFor(async () => (await b.s.view()).accept.pending[0])
    assert.equal(pend.name, 'Office Mac')
    assert.deepEqual((await a.s.view()).adding, { name: 'Studio Mac' })
    assert.equal((await a.s.handle({ action: 'add', link, name: 'Studio Mac' })).status, 409, 'one pairing at a time')
    assert.equal((await b.s.handle({ action: 'approve', id: pend.id })).status, 200)
    const added = await adding
    assert.equal(added.status, 200)
    const c = added.body.computers[0]
    assert.equal(c.name, 'Studio Mac'); assert.equal(c.state, 'ok')
    assert.equal(JSON.stringify(added.body).includes('"token"'), false, 'the token never goes to the browser')
    assert.equal((await b.s.view()).accept.devices[0].name, 'Office Mac')
    const opened = await a.s.handle({ action: 'open', id: c.id })
    assert.match(opened.body.url, /^http:\/\/127\.0\.0\.1:\d+\/\?cp-ticket=/)
    const page = await openInBrowser(opened.body.url)
    assert.equal(page.status, 200)
    assert.equal(page.body, '<html>dsh of Studio Mac</html>')
    // Rename, then the same Mac pairs again: one entry, the name stays.
    await a.s.handle({ action: 'rename', id: c.id, name: '  Studio\n ' })
    assert.equal((await a.s.view()).computers[0].name, 'Studio')
    const link2 = (await b.s.handle({ action: 'code' })).body.accept.code.payload
    const again = a.s.handle({ action: 'add', link: link2, name: 'Studio' })
    const pend2 = await waitFor(async () => (await b.s.view()).accept.pending[0])
    await b.s.handle({ action: 'approve', id: pend2.id })
    const list = (await again).body.computers
    assert.equal(list.length, 1); assert.equal(list[0].name, 'Studio')
    assert.deepEqual((await a.s.handle({ action: 'rename', id: c.id, name: ' \n ' })).body, { error: 'name-missing' }, 'a computer always has a name')
    assert.deepEqual((await a.s.handle({ action: 'rename', id: c.id, name: 'office mac' })).body, { error: 'name-taken' }, 'not the name of This Mac')
    assert.equal((await a.s.handle({ action: 'rename', id: c.id, name: 'STUDIO' })).status, 200, 'its own name in other letters is fine')
    // B removes A: A's next request shows that it must pair again.
    for (const d of (await b.s.view()).accept.devices) await b.s.handle({ action: 'revoke', id: d.id })
    const after = await openInBrowser((await a.s.handle({ action: 'open', id: c.id })).body.url).catch(() => null)
    assert.equal(after?.status, 401)
    assert.equal((await a.s.view()).computers[0].state, 'unpaired')
    assert.deepEqual((await a.s.handle({ action: 'open', id: c.id })).body, { error: 'unpaired' })
    await a.s.handle({ action: 'remove', id: c.id })
    assert.deepEqual((await a.s.view()).computers, [])
    assert.deepEqual(JSON.parse(readFileSync(a.file, 'utf8')).list, [])
  } finally { await a.s.close(); await b.s.close(); dsh.close() }
})

test('Deny, Cancel and the switch going off end a waiting pairing', async () => {
  const dsh = await mockDsh('x')
  const b = mac('Studio Mac', dsh)
  const a = mac('Office Mac')
  try {
    await b.s.handle({ on: true }); await b.s.handle({ accept: true })
    await a.s.handle({ on: true })
    const link = async () => (await b.s.handle({ action: 'code' })).body.accept.code.payload
    const denied = a.s.handle({ action: 'add', link: await link(), name: 'Studio Mac' })
    await b.s.handle({ action: 'deny', id: (await waitFor(async () => (await b.s.view()).accept.pending[0])).id })
    assert.deepEqual((await denied).body, { error: 'denied' })
    const cancelled = a.s.handle({ action: 'add', link: await link(), name: 'Studio Mac' })
    await waitFor(async () => (await b.s.view()).accept.pending[0])
    await a.s.handle({ action: 'cancel-add' })
    assert.deepEqual((await cancelled).body, { error: 'cancelled' })
    await waitFor(async () => (await b.s.view()).accept.pending.length === 0, 4000)
    const off = a.s.handle({ action: 'add', link: await link(), name: 'Studio Mac' })
    await waitFor(async () => (await b.s.view()).accept.pending[0])
    await a.s.handle({ on: false })
    assert.deepEqual((await off).body, { error: 'cancelled' })
    assert.equal((await a.s.view()).adding, null)
    assert.deepEqual((await a.s.view()).computers, [])
  } finally { await a.s.close(); await b.s.close(); dsh.close() }
})

test('a pinned certificate that does not match: the code never goes out', async () => {
  const dsh = await mockDsh('x')
  const b = mac('Studio Mac', dsh)
  const a = mac('Office Mac')
  try {
    await b.s.handle({ on: true }); await b.s.handle({ accept: true })
    await a.s.handle({ on: true })
    const link = (await b.s.handle({ action: 'code' })).body.accept.code.payload
    const forged = link.replace(/fp=[0-9a-f]+/, 'fp=' + 'cd'.repeat(32))
    assert.deepEqual((await a.s.handle({ action: 'add', link: forged, name: 'Studio Mac' })).body, { error: 'pin' })
    await sleep(50)
    assert.equal((await b.s.view()).accept.pending.length, 0, 'B saw no pairing request')
    assert.equal((await b.s.view()).accept.code !== null, true, 'and its code is still unused')
  } finally { await a.s.close(); await b.s.close(); dsh.close() }
})

test('switching off closes the front door and every relay; a failed save changes nothing', async () => {
  const dsh = await mockDsh('x')
  const b = mac('Studio Mac', dsh)
  const a = mac('Office Mac')
  try {
    await b.s.handle({ on: true }); await b.s.handle({ accept: true })
    const doorPort = (await b.s.view()).accept.port
    assert.ok(await listening(doorPort))
    await a.s.handle({ on: true })
    const adding = a.s.handle({ action: 'add', link: (await b.s.handle({ action: 'code' })).body.accept.code.payload, name: 'Studio Mac' })
    await b.s.handle({ action: 'approve', id: (await waitFor(async () => (await b.s.view()).accept.pending[0])).id })
    const id = (await adding).body.computers[0].id
    const relayPort = Number(new URL((await a.s.handle({ action: 'open', id })).body.url).port)
    assert.ok(await listening(relayPort))
    await a.s.handle({ on: false })
    assert.equal(await listening(relayPort), false, 'the relay is closed')
    assert.equal((await a.s.view()).computers.length, 1, 'the list stays for the next time')
    await b.s.handle({ accept: false })
    assert.equal(await listening(doorPort), false, 'the front door is closed')
    // A folder in the file's place: the save fails, the switch stays as it was.
    rmSync(b.file); mkdirSync(b.file)
    const failed = await b.s.handle({ accept: true })
    assert.equal(failed.status, 500)
    assert.equal((await b.s.view()).accept.on, false)
    assert.equal(b.made.filter((g) => g.state().running).length, 0)
  } finally { await a.s.close(); await b.s.close(); dsh.close() }
})

test('saved on: the front door starts again at load; unload closes it', async () => {
  const dsh = await mockDsh('x')
  const home = mkdtempSync(join(tmpdir(), 'cp-host-'))
  const file = join(home, 'computers.json')
  writeFileSync(file, JSON.stringify({ on: true, accept: true, list: [{ fp: 'ab'.repeat(32), host: '100.90.0.7', port: 19392, token: 't'.repeat(43), mac: 'Old Mac' }, { fp: 'bad' },
    { fp: 'cd'.repeat(32), host: '8.8.8.8', port: 443, token: 't'.repeat(43), mac: 'Internet' }, { fp: 'ef'.repeat(32), host: '100.90.0.8', port: 0, token: 't'.repeat(43) }] }))
  const made = []
  const s = computersService({ file, dir: join(home, 'door'), upstreamUrl: () => dsh.url, macName: 'Studio Mac', make: (o) => { const g = loopbackDoor(o); made.push(g); return g } })
  try {
    await s.ready
    const v = await s.view()
    assert.equal(v.accept.running, true)
    assert.deepEqual(v.computers.map((c) => c.name), ['Old Mac'], 'a broken entry is dropped')
    const port = v.accept.port
    await s.close()
    assert.equal(await listening(port), false)
    assert.equal((await s.handle({ accept: true })).status, 200)
    assert.equal(made.length, 1, 'nothing starts after unload')
  } finally { dsh.close() }
})

test('route: a page that another Mac opened reads but changes nothing; headless has no computers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-route-'))
  process.env.DSH_HOME = home; process.env.DSH_MOBILE_DIR = join(home, 'mobile'); process.env.DSH_MOBILE_ADMIN_PORT = '0'
  process.env.DSH_COMPUTERS_DIR = join(home, 'computers')
  const routes = new Map(); const disposers = []
  let web
  apply({ on() {}, sessionController: {}, sessionQuery: {}, subprocess: {},
    connection: { fetch: { register: (r) => routes.set(r.path, r) }, authenticatedUrl: (base) => `${base}/?token=t` },
    inject: (deps, setup) => { if (deps.includes('tools')) return { dispose() {} }; web = setup } })
  const call = async (body, headers = {}) => {
    const r = await routes.get(COMPUTERS_PATH).fetch(new Request(`http://h${COMPUTERS_PATH}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) }))
    return { status: r.status, json: await r.json() }
  }
  assert.deepEqual((await call()).json, { on: false, available: false, via: false, computers: [] }, 'no web server yet: nothing runs')
  web({ webServer: { port: 1 }, effect: (f) => { disposers.push(f()) } })
  const first = (await call()).json
  assert.equal(first.on, false); assert.equal(first.available, true); assert.equal(first.via, false)
  assert.equal((await call(undefined, { 'x-composer-plus-via': 'computer' })).json.via, true)
  assert.equal((await call({ on: true }, { 'x-composer-plus-via': 'computer' })).status, 403, 'another Mac cannot switch it on')
  assert.equal((await call({ on: true })).json.on, true)
  assert.equal((await call('{')).status, 400)
  disposers.forEach((f) => f?.())
  await sleep(20)
  assert.equal((await call()).json.available, false)
})

test('a name for each computer: asked before the pairing, never the name of This Mac or another computer', async () => {
  const dsh = await mockDsh('x')
  const b = mac('Furkan MacBook Pro', dsh)
  const a = mac('Furkan MacBook Pro')
  try {
    await b.s.handle({ on: true }); await b.s.handle({ accept: true })
    await a.s.handle({ on: true })
    const link = (await b.s.handle({ action: 'code' })).body.accept.code.payload
    // Refused before anything goes to B: B sees no request and its code stays unused.
    assert.deepEqual((await a.s.handle({ action: 'add', link })).body, { error: 'name-missing' })
    assert.deepEqual((await a.s.handle({ action: 'add', link, name: ' \u0007 ' })).body, { error: 'name-missing' })
    assert.deepEqual((await a.s.handle({ action: 'add', link, name: ' furkan macbook PRO ' })).body, { error: 'name-taken' }, 'This Mac has it (any letter case)')
    await sleep(30)
    assert.equal((await b.s.view()).accept.pending.length, 0, 'B saw no pairing request')
    // A good name: saved as the label; the Mac's own name stays as `mac`.
    const adding = a.s.handle({ action: 'add', link, name: '  Ev Mac\n' })
    await b.s.handle({ action: 'approve', id: (await waitFor(async () => (await b.s.view()).accept.pending[0])).id })
    const c = (await adding).body.computers[0]
    assert.equal(c.name, 'Ev Mac'); assert.equal(c.mac, 'Studio Mac', 'the Mac name that B sent stays'); assert.equal(c.duplicate, false)
    assert.equal(JSON.parse(readFileSync(a.file, 'utf8')).list[0].label, 'Ev Mac')
  } finally { await a.s.close(); await b.s.close(); dsh.close() }
})

test('a name taken while the pairing waited gets a number; an old entry with the name of This Mac is marked', async () => {
  const dsh = await mockDsh('x')
  const b = mac('Studio Mac', dsh)
  const home = mkdtempSync(join(tmpdir(), 'cp-host-'))
  const file = join(home, 'computers.json')
  // The owner's case: an entry saved before names were asked, with the same Mac name as This Mac.
  writeFileSync(file, JSON.stringify({ on: true, accept: false, list: [{ fp: 'ab'.repeat(32), host: '100.90.0.7', port: 19392, token: 't'.repeat(43), mac: 'Office Mac' }] }))
  const s = computersService({ file, dir: join(home, 'door'), upstreamUrl: () => undefined, macName: 'Office Mac' })
  try {
    const old = (await s.view()).computers[0]
    assert.equal(old.duplicate, true, 'the same name as This Mac is marked')
    await b.s.handle({ on: true }); await b.s.handle({ accept: true })
    const link = (await b.s.handle({ action: 'code' })).body.accept.code.payload
    const adding = s.handle({ action: 'add', link, name: 'Studio' })
    const pend = await waitFor(async () => (await b.s.view()).accept.pending[0])
    // The old entry takes "Studio" while B waits for the click.
    assert.equal((await s.handle({ action: 'rename', id: old.id, name: 'Studio' })).status, 200)
    assert.equal((await s.view()).computers[0].duplicate, false)
    await b.s.handle({ action: 'approve', id: pend.id })
    const list = (await adding).body.computers
    assert.deepEqual(list.map((c) => c.name), ['Studio', 'Studio (2)'], 'the new token is kept, with a number')
    assert.deepEqual((await s.handle({ action: 'rename', id: list[1].id, name: 'studio' })).body, { error: 'name-taken' })
  } finally { await s.close(); await b.s.close(); dsh.close() }
})

test('events: the other Mac\'s page says hello and switches this window, through its relay only', async () => {
  const dsh = await mockDsh('<html>B</html>')
  const b = mac('Studio Mac', dsh)
  const a = mac('Office Mac', undefined, { pollMs: 300 })
  try {
    await b.s.handle({ on: true }); await b.s.handle({ accept: true })
    await a.s.handle({ on: true })
    const adding = a.s.handle({ action: 'add', link: (await b.s.handle({ action: 'code' })).body.accept.code.payload, name: 'Studio' })
    await b.s.handle({ action: 'approve', id: (await waitFor(async () => (await b.s.view()).accept.pending[0])).id })
    const id = (await adding).body.computers[0].id
    // No event yet: the poll waits `pollMs`, then answers an empty list.
    const t0 = Date.now()
    assert.deepEqual((await a.s.handle({ action: 'events', after: 0 })).body, { seq: 0, events: [] })
    assert.ok(Date.now() - t0 >= 250, 'it waited')
    const u = new URL((await a.s.handle({ action: 'open', id })).body.url)
    const first = await get(Number(u.port), u.pathname + u.search)
    const cookie = String(first.headers['set-cookie']).split(';')[0]
    const port = Number(u.port)
    // A waiting poll ends when the page says hello.
    const poll = a.s.handle({ action: 'events', after: 0 })
    const opener = await get(port, '/__composer-plus/opener', cookie)
    assert.equal(opener.status, 200)
    const o = JSON.parse(opener.body)
    assert.deepEqual(o, { self: { name: 'Office Mac' }, current: id, computers: [{ id, name: 'Studio', state: 'ok' }] }, 'names and states only: no address, no token')
    assert.deepEqual((await poll).body.events, [{ seq: 1, hello: true, from: id }])
    // Switch: This Mac, Add, or a computer id; anything else is refused and makes no event.
    const post = (body) => new Promise((ok, bad) => {
      request({ host: '127.0.0.1', port, path: '/__composer-plus/switch', method: 'POST', agent: false, headers: { host: `127.0.0.1:${port}`, cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` } }, (res) => {
        let t = ''; res.on('data', (d) => { t += d }).on('end', () => ok({ status: res.statusCode, body: t }))
      }).on('error', () => ok({ status: 0 })).end(body)
    })
    assert.equal((await post('{"to":"self"}')).status, 200)
    assert.equal((await post('{"to":"../x"}')).status, 400)
    assert.equal((await post('not json')).status, 400)
    assert.notEqual((await post(JSON.stringify({ to: 'x'.repeat(2000) }))).status, 200, 'a large body is refused (the relay closes it)')
    assert.equal((await post(JSON.stringify({ to: 'ab'.repeat(32) }))).status, 200)
    assert.deepEqual((await a.s.handle({ action: 'events', after: 1 })).body.events.map((e) => e.switch), ['self', 'ab'.repeat(32)])
    // Without the relay's cookie: nothing.
    assert.equal((await get(port, '/__composer-plus/opener')).status, 401)
    assert.equal(dsh.seen?.length ?? 0, 0)
    // Unload: a waiting poll ends at once (not after its minute).
    const slow = mac('Office Mac', undefined, { pollMs: 60e3 })
    await slow.s.handle({ on: true })
    const late = slow.s.handle({ action: 'events', after: 0 })
    await sleep(20)
    const t1 = Date.now()
    await slow.s.close()
    assert.equal((await late).status, 200)
    assert.ok(Date.now() - t1 < 5000, 'the poll ended with the unload')
  } finally { await a.s.close(); await b.s.close(); dsh.close() }
})
