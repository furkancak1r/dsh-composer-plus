// Remote computers, the network half: B's front door (`createGateway({mode: 'computer'})`) and A's relay (`createRelay`).
// A mock dsh on loopback stands in for B's dsh. Run: node --test test/computers.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer as createTls } from 'node:tls'
import { createConnection } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway, createRelay, acceptWs, wsConnect, normFp, parseComputerLink, computerLink, hopHeaders, relativeLocation } from '../tether/gateway/server.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('timed out'); await sleep(10) } }

// ---- Mock dsh: token login → cookie; every request is recorded with its headers. ----
async function mockDsh() {
  const m = { seen: [], cookie: 'dsh-auth-x=1', logins: 0 }
  const authed = (req) => (req.headers.cookie ?? '').includes(m.cookie)
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/?token=t') { m.logins++; res.writeHead(303, { location: './', 'set-cookie': m.cookie + '; HttpOnly' }); return res.end() }
    const parts = []
    req.on('data', (d) => parts.push(d)).on('end', () => {
      const body = Buffer.concat(parts)
      m.seen.push({ method: req.method, url: req.url, headers: req.headers, bytes: body.length })
      if (!authed(req)) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('dsh web authentication required') }
      if (req.url === '/redirect') { res.writeHead(303, { location: `http://127.0.0.1:${http.address().port}/next?a=1`, 'set-cookie': 'leak=1' }); return res.end() }
      if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(body) }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'dsh-auth-x=2' })
      res.end(`<html>dsh ${req.url}</html>`)
    })
  })
  http.on('upgrade', (req, sock, head) => {
    m.seen.push({ method: 'UPGRADE', url: req.url, headers: req.headers })
    if (!authed(req)) return sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    const ws = acceptWs(req, sock, head)
    ws.onText = (t) => ws.send('echo:' + t)
  })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  m.url = `http://127.0.0.1:${http.address().port}/?token=t`
  m.port = http.address().port
  m.close = () => { http.closeAllConnections(); http.close() }
  return m
}

/** B's front door on loopback: the test makes 127.0.0.1 its "tailnet" (`tailnetOnly: false` and a loopback network). */
async function frontDoor(dsh, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-computers-'))
  const gw = createGateway({ mode: 'computer', dir, upstreamUrl: () => dsh.url, port: 0, notify: false, tailnetOnly: false,
    tailscale: { installed: true, online: true, ip: '127.0.0.1', name: null }, netInfo: () => ({ address: '127.0.0.1', netmask: '255.0.0.0', bind: '127.0.0.1' }), macName: 'Studio Mac', ...extra })
  await gw.start()
  return gw
}
// A Composer Plus pairing: `POST /pair` over pinned TLS, approved on B.
function postPair(gw, body, pin = gw.fingerprint) {
  return new Promise((ok, bad) => {
    const req = httpsRequest({ host: '127.0.0.1', port: gw.port, method: 'POST', path: '/pair', rejectUnauthorized: false, agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d }).on('end', () => ok({ status: res.statusCode, json: b ? JSON.parse(b) : null }))
    })
    req.on('socket', (s) => s.on('secureConnect', () => {
      if (normFp(s.getPeerCertificate().fingerprint256) !== normFp(pin)) req.destroy(Error('pin'))
      else req.end(JSON.stringify(body))
    }))
    req.on('error', bad)
  })
}
async function pairComputer(gw, name = 'Office Mac') {
  const link = parseComputerLink(gw.newCode().payload)
  assert.ok(link, 'the front door makes a dsh-computer:// link')
  const p = postPair(gw, { code: link.code, name, kind: 'computer' })
  const pend = await waitFor(() => gw.state().pending[0])
  gw.settle(pend.id, true)
  const r = await p
  assert.equal(r.status, 200)
  return { ...link, token: r.json.token }
}
/** A browser on A: plain HTTP to the relay with the headers that a page sends. Keeps cookies. */
function browserGet(port, path, { cookie, headers = {}, method = 'GET', body } = {}) {
  return new Promise((ok, bad) => {
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      const parts = []; res.on('data', (d) => parts.push(d)).on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
    })
    req.on('error', bad)
    req.end(body)
  })
}
const cookieOf = (res) => [res.headers['set-cookie'] ?? []].flat().map((c) => c.split(';')[0]).join('; ')
async function openRelay(relay) {
  const url = new URL(relay.ticketUrl())
  const r = await browserGet(relay.port, url.pathname + url.search)
  assert.equal(r.status, 303)
  assert.equal(r.headers.location, './')
  assert.match(String(r.headers['set-cookie']), /HttpOnly; SameSite=Strict/)
  return cookieOf(r)
}

test('pairing link: only a Tailscale or loopback IPv4 address, a full fingerprint and a code', () => {
  const fp = 'ab'.repeat(32)
  const ok = computerLink({ host: '100.90.0.7', port: 19392, fp, code: 'c0de', mac: 'Studio Mac' })
  assert.deepEqual(parseComputerLink(ok), { host: '100.90.0.7', port: 19392, fp, code: 'c0de', mac: 'Studio Mac' })
  assert.deepEqual(parseComputerLink('  ' + ok.replace('Studio%20Mac', 'A%0AB') + '\n').mac, 'AB')
  for (const bad of [
    ok.replace('100.90.0.7', '192.168.1.5'), ok.replace('100.90.0.7', '8.8.8.8'), ok.replace('100.90.0.7', 'example.com'),
    ok.replace('v=1', 'v=2'), ok.replace('port=19392', 'port=0'), ok.replace('port=19392', 'port=70000'), ok.replace(fp, 'ab'.repeat(20)),
    ok.replace('code=c0de', 'code='), ok.replace('dsh-computer:', 'tether:'), ok.replace('//pair', '//other'), 'not a link', '',
  ]) assert.equal(parseComputerLink(bad), null, bad)
  assert.equal(parseComputerLink(ok.replace('100.90.0.7', '127.0.0.1')).host, '127.0.0.1')
})

test('hop headers: the caller\'s cookie, token, site and hop headers never go on; a redirect becomes a path', () => {
  const h = hopHeaders({ host: 'a', origin: 'o', cookie: 'c', authorization: 'Bearer x', 'sec-fetch-site': 'cross-site', 'x-composer-plus-via': 'fake', connection: 'keep-alive', accept: 'text/html', 'accept-language': 'tr' }, { host: 'b' })
  assert.deepEqual(h, { accept: 'text/html', 'accept-language': 'tr', host: 'b' })
  assert.equal(relativeLocation('http://127.0.0.1:5/a/b?c=1#d'), '/a/b?c=1#d')
  assert.equal(relativeLocation('./'), './')
  assert.equal(relativeLocation(undefined), undefined)
})

test('front door: pairs only a Composer Plus, and a phone-style pairing is refused', async () => {
  const dsh = await mockDsh(); const gw = await frontDoor(dsh)
  try {
    assert.match(gw.newCode().payload, /^dsh-computer:\/\/pair\?/)
    const code = parseComputerLink(gw.state().code.payload).code
    const phone = await postPair(gw, { code, name: 'iPhone' })
    assert.equal(phone.status, 403, 'no kind: refused')
    assert.equal(gw.state().pending.length, 0)
    // The refused try did not use the code: a Composer Plus with it waits for Approve, and Deny refuses it.
    const again = postPair(gw, { code, name: 'Office Mac', kind: 'computer' })
    const pend = await waitFor(() => gw.state().pending[0])
    assert.equal(pend.name, 'Office Mac')
    gw.settle(pend.id, false)
    assert.deepEqual((await again).json, { error: 'pairing denied' })
    assert.equal(gw.state().devices.length, 0)
  } finally { await gw.close(); dsh.close() }
})

test('front door + relay: the page loads through both hops with the right headers, cookies stay on their side', async () => {
  const dsh = await mockDsh(); const gw = await frontDoor(dsh)
  const p = await pairComputer(gw)
  let unauthorized = 0
  const relay = createRelay({ host: p.host, port: p.port, fp: p.fp, token: p.token, onUnauthorized: () => { unauthorized++ }, frameAncestors: ['http://127.0.0.1:3080'] })
  await relay.start()
  try {
    const cookie = await openRelay(relay)
    const page = await browserGet(relay.port, '/', { cookie, headers: { 'sec-fetch-site': 'same-origin', accept: 'text/html' } })
    assert.equal(page.status, 200)
    assert.equal(String(page.body), '<html>dsh /</html>')
    assert.equal(page.headers['content-security-policy'], "frame-ancestors 'self' http://127.0.0.1:3080", 'only dsh\'s page may frame it')
    assert.equal(page.headers['set-cookie'], undefined, "dsh's cookie never reaches the browser")
    const seen = dsh.seen.at(-1)
    assert.equal(seen.headers.host, `127.0.0.1:${dsh.port}`)
    assert.equal(seen.headers['x-composer-plus-via'], 'computer')
    assert.equal(seen.headers.cookie, dsh.cookie, "only dsh's own cookie")
    assert.equal(seen.headers.authorization, undefined, 'the computer token stays at the front door')
    assert.equal(seen.headers['sec-fetch-site'], undefined)
    assert.equal(seen.headers.origin, undefined, 'no Origin when the browser sent none')
    assert.equal(seen.headers.accept, 'text/html')
    // A POST with an Origin of the relay: dsh sees its own origin.
    const post = await browserGet(relay.port, '/api/x', { cookie, method: 'POST', body: '{}', headers: { origin: `http://127.0.0.1:${relay.port}`, 'content-type': 'application/json' } })
    assert.equal(post.status, 200)
    assert.equal(dsh.seen.at(-1).headers.origin, `http://127.0.0.1:${dsh.port}`)
    // A redirect of dsh stays on the relay, and its cookie does not come through.
    const redirect = await browserGet(relay.port, '/redirect', { cookie })
    assert.equal(redirect.status, 303)
    assert.equal(redirect.headers.location, '/next?a=1')
    assert.equal(redirect.headers['set-cookie'], undefined)
    // 20 MB goes through as a stream and comes back whole.
    const big = Buffer.alloc(20 << 20, 7)
    const echo = await browserGet(relay.port, '/big', { cookie, method: 'POST', body: big, headers: { 'content-type': 'application/octet-stream' } })
    assert.equal(echo.status, 200)
    assert.equal(echo.body.length, big.length)
    assert.equal(unauthorized, 0)
  } finally { await relay.close(); await gw.close(); dsh.close() }
})

test('relay: one-time ticket, its own Host and Origin only, no cross-site request', async () => {
  const dsh = await mockDsh(); const gw = await frontDoor(dsh)
  const p = await pairComputer(gw)
  const relay = createRelay({ host: p.host, port: p.port, fp: p.fp, token: p.token, ticketTtlMs: 50 })
  await relay.start()
  try {
    const url = new URL(relay.ticketUrl())
    assert.equal((await browserGet(relay.port, url.pathname + url.search)).status, 303)
    assert.equal((await browserGet(relay.port, url.pathname + url.search)).status, 403, 'a ticket works once')
    const old = new URL(relay.ticketUrl()); await sleep(80)
    assert.equal((await browserGet(relay.port, old.pathname + old.search)).status, 403, 'a ticket gets old')
    const cookie = await (async () => { const u = new URL(relay.ticketUrl()); return cookieOf(await browserGet(relay.port, u.pathname + u.search)) })()
    assert.equal((await browserGet(relay.port, '/')).status, 401, 'no cookie')
    assert.equal((await browserGet(relay.port, '/', { cookie: 'cp-computer-1=forged' })).status, 401, 'a made-up cookie')
    assert.equal((await browserGet(relay.port, '/', { cookie, headers: { host: `localhost:${relay.port}` } })).status, 403, 'DNS rebinding: another Host')
    assert.equal((await browserGet(relay.port, '/', { cookie, headers: { origin: 'http://evil.example' } })).status, 403, 'another Origin')
    assert.equal((await browserGet(relay.port, '/', { cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    assert.equal((await browserGet(relay.port, '/', { cookie, headers: { 'sec-fetch-site': 'same-site' } })).status, 403)
    assert.equal((await browserGet(relay.port, '/', { cookie, headers: { 'sec-fetch-site': 'none' } })).status, 200)
    // dsh's page (another loopback port: same-site) opens `/` in its Browser tab: a navigation only.
    const nav = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }
    assert.equal((await browserGet(relay.port, '/', { cookie, headers: nav })).status, 200)
    assert.equal((await browserGet(relay.port, '/api/x', { cookie, headers: nav })).status, 403, 'not another path')
    assert.equal((await browserGet(relay.port, '/', { cookie, method: 'POST', body: '{}', headers: nav })).status, 403, 'not a POST')
    assert.equal((await browserGet(relay.port, '/', { cookie, headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' } })).status, 403, 'not a fetch')
    const t2 = new URL(relay.ticketUrl())
    const viaTab = await browserGet(relay.port, t2.pathname + t2.search, { headers: nav })
    assert.equal(viaTab.status, 303, 'the ticket works from dsh\'s tab')
    assert.match(viaTab.headers['content-security-policy'], /^frame-ancestors 'self'/)
  } finally { await relay.close(); await gw.close(); dsh.close() }
})

test('relay: a certificate that is not the pinned one gets no byte', async () => {
  const dsh = await mockDsh(); const gw = await frontDoor(dsh)
  const p = await pairComputer(gw)
  // A TLS server with another certificate at the computer's address: it records what arrives after the handshake.
  const { readFileSync } = await import('node:fs')
  const otherDir = mkdtempSync(join(tmpdir(), 'cp-other-'))
  const other = await frontDoor(dsh, { dir: otherDir }) // only to make a second certificate
  let bytes = 0
  const fake = createTls({ key: readFileSync(join(otherDir, 'key.pem')), cert: readFileSync(join(otherDir, 'cert.pem')) }, (s) => { s.on('data', (d) => { bytes += d.length }) })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const relay = createRelay({ host: '127.0.0.1', port: fake.address().port, fp: p.fp, token: p.token })
  await relay.start()
  try {
    const cookie = await openRelay(relay)
    const r = await browserGet(relay.port, '/', { cookie })
    assert.equal(r.status, 502)
    assert.match(String(r.body), /another certificate/)
    assert.match(r.headers['content-type'], /^text\/plain/, 'a fetch gets plain text')
    await sleep(50)
    assert.equal(bytes, 0, 'not one byte after the handshake: no token, no request')
    assert.equal(relay.fail, 'pin')
  } finally { await relay.close(); fake.close(); await other.close(); await gw.close(); dsh.close() }
})

test('relay: a computer that does not answer → a page in the middle of the window for the browser, plain text for a fetch', async () => {
  const dead = createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r))
  const port = dead.address().port; await new Promise((r) => dead.close(r)) // a port with nobody on it
  const relay = createRelay({ host: '127.0.0.1', port, fp: 'ab'.repeat(32), token: 'x'.repeat(43), frameAncestors: ['http://127.0.0.1:1'] })
  await relay.start()
  try {
    const cookie = await openRelay(relay)
    const page = await browserGet(relay.port, '/', { cookie, headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } })
    assert.equal(page.status, 502)
    assert.match(page.headers['content-type'], /^text\/html/)
    const csp = [page.headers['content-security-policy']].flat().join(', ')
    assert.match(csp, /default-src 'none'/, 'no script, no outside resource')
    assert.match(csp, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:1/, 'only dsh may frame it')
    const html = String(page.body)
    assert.match(html, /<h1>This computer does not answer over Tailscale\.<\/h1>/)
    assert.match(html, /<p>Make sure that it is awake and that Tailscale is on\.<\/p>/)
    assert.match(html, /place-items:center/, 'in the middle of the window')
    assert.match(html, /<a href="">Try again<\/a>/)
    assert.doesNotMatch(html, /<script/i)
    assert.equal(relay.fail, 'unreachable')
    const api = await browserGet(relay.port, '/api/x', { cookie, headers: { accept: '*/*' } })
    assert.equal(api.status, 502)
    assert.match(api.headers['content-type'], /^text\/plain/)
    assert.equal(String(api.body), 'This computer does not answer over Tailscale. Make sure that it is awake and that Tailscale is on.')
  } finally { await relay.close() }
})

test('front door: a phone token or no token is refused, and a removed computer stops at once', async () => {
  const dsh = await mockDsh(); const gw = await frontDoor(dsh)
  const p = await pairComputer(gw)
  let unauthorized = 0
  const relay = createRelay({ host: p.host, port: p.port, fp: p.fp, token: p.token, onUnauthorized: () => { unauthorized++ } })
  await relay.start()
  const wrong = createRelay({ host: p.host, port: p.port, fp: p.fp, token: 'x'.repeat(43) })
  await wrong.start()
  try {
    const before = dsh.seen.length
    const wc = await openRelay(wrong)
    assert.equal((await browserGet(wrong.port, '/', { cookie: wc })).status, 401)
    assert.equal(dsh.seen.length, before, 'a wrong token never reaches dsh')
    const cookie = await openRelay(relay)
    assert.equal((await browserGet(relay.port, '/', { cookie })).status, 200)
    gw.revoke(gw.state().devices[0].id)
    const gone = await browserGet(relay.port, '/', { cookie })
    assert.equal(gone.status, 401)
    assert.match(String(gone.body), /removed this one.*pair again/, 'a readable reason, not the front door\'s JSON')
    assert.equal(unauthorized, 1, 'the relay reports that the computer must pair again')
  } finally { await relay.close(); await wrong.close(); await gw.close(); dsh.close() }
})

test('front door: dsh restarted (its cookie changed) → a GET logs in again and goes through', async () => {
  const dsh = await mockDsh(); const gw = await frontDoor(dsh)
  const p = await pairComputer(gw)
  const relay = createRelay({ host: p.host, port: p.port, fp: p.fp, token: p.token })
  await relay.start()
  try {
    const cookie = await openRelay(relay)
    assert.equal((await browserGet(relay.port, '/', { cookie })).status, 200)
    const logins = dsh.logins
    dsh.cookie = 'dsh-auth-x=new'
    const r = await browserGet(relay.port, '/page', { cookie })
    assert.equal(r.status, 200)
    assert.equal(String(r.body), '<html>dsh /page</html>')
    assert.equal(dsh.logins, logins + 1)
  } finally { await relay.close(); await gw.close(); dsh.close() }
})

test('WebSocket goes through both hops, both ways', async () => {
  const dsh = await mockDsh(); const gw = await frontDoor(dsh)
  const p = await pairComputer(gw)
  const relay = createRelay({ host: p.host, port: p.port, fp: p.fp, token: p.token })
  await relay.start()
  try {
    const cookie = await openRelay(relay)
    await assert.rejects(wsConnect(`ws://127.0.0.1:${relay.port}/api/remote.mux`, { host: `127.0.0.1:${relay.port}` }), /403/, 'no cookie, no socket')
    const ws = await wsConnect(`ws://127.0.0.1:${relay.port}/api/remote.mux`, { host: `127.0.0.1:${relay.port}`, cookie, origin: `http://127.0.0.1:${relay.port}` })
    const got = []
    ws.onText = (t) => got.push(t)
    ws.send('hello'); ws.send('x'.repeat(100000))
    await waitFor(() => got.length === 2)
    assert.equal(got[0], 'echo:hello')
    assert.equal(got[1].length, 100005)
    const up = dsh.seen.findLast((s) => s.method === 'UPGRADE')
    assert.equal(up.headers.cookie, dsh.cookie)
    assert.equal(up.headers.origin, `http://127.0.0.1:${dsh.port}`)
    assert.equal(up.headers['x-composer-plus-via'], 'computer')
    ws.close()
  } finally { await relay.close(); await gw.close(); dsh.close() }
})

test('front door: only tailnet peers when tailnet-only (the default), and nothing is announced', async () => {
  const dsh = await mockDsh()
  const spawned = []
  const gw = await frontDoor(dsh, { tailnetOnly: undefined, bonjour: true, spawn: (...a) => { spawned.push(a); return { on() {}, kill() {} } } })
  try {
    const refused = await new Promise((ok) => {
      const s = createConnection({ host: '127.0.0.1', port: gw.port })
      s.on('close', () => ok(true)); s.on('error', () => ok(true))
    })
    assert.ok(refused, 'a loopback peer is not on the tailnet: the socket closes')
    assert.equal(gw.state().log[0].reason, 'tailnet-only')
    assert.equal(spawned.length, 0, 'no Bonjour')
  } finally { await gw.close(); dsh.close() }
})

test('front door: Tailscale off → it does not start and says why', async () => {
  const dsh = await mockDsh()
  const dir = mkdtempSync(join(tmpdir(), 'cp-computers-'))
  const gw = createGateway({ mode: 'computer', dir, upstreamUrl: () => dsh.url, port: 0, notify: false, tailscale: { installed: true, online: false, ip: null, name: null } })
  try {
    await assert.rejects(gw.start(), /Tailscale is off/)
    assert.equal(gw.state().running, false)
  } finally { await gw.close(); dsh.close() }
})

test('relay: its own paths stay on this Mac; the other Mac never sees them', async () => {
  const dsh = await mockDsh(); const gw = await frontDoor(dsh)
  const p = await pairComputer(gw)
  const signals = []
  const relay = createRelay({ host: p.host, port: p.port, fp: p.fp, token: p.token, peer: { opener: () => ({ self: { name: 'Office Mac' } }), signal: (e) => signals.push(e) } })
  const bare = createRelay({ host: p.host, port: p.port, fp: p.fp, token: p.token })
  await relay.start(); await bare.start()
  try {
    const cookie = await openRelay(relay)
    const before = dsh.seen.length
    const o = await browserGet(relay.port, '/__composer-plus/opener', { cookie })
    assert.equal(o.status, 200); assert.deepEqual(JSON.parse(o.body), { self: { name: 'Office Mac' } })
    assert.match(o.headers['content-security-policy'], /frame-ancestors/)
    const sw = await browserGet(relay.port, '/__composer-plus/switch', { cookie, method: 'POST', body: '{"to":"add"}', headers: { origin: `http://127.0.0.1:${relay.port}` } })
    assert.equal(sw.status, 200)
    assert.equal((await browserGet(relay.port, '/__composer-plus/switch', { cookie, method: 'POST', body: '{"to":"add"}', headers: { origin: 'http://evil.example' } })).status, 403, 'another Origin')
    assert.equal((await browserGet(relay.port, '/__composer-plus/switch', { cookie })).status, 404, 'a GET does not switch')
    assert.equal((await browserGet(relay.port, '/__composer-plus/other', { cookie })).status, 404)
    assert.equal((await browserGet(relay.port, '/__composer-plus/opener')).status, 401, 'no cookie')
    assert.deepEqual(signals, [{ hello: true }, { switch: 'add' }])
    assert.equal(dsh.seen.length, before, 'nothing went to the other Mac')
    // A relay without a peer answers 404 (an older page asks, and gets no picker).
    assert.equal((await browserGet(bare.port, '/__composer-plus/opener', { cookie: await openRelay(bare) })).status, 404)
  } finally { await relay.close(); await bare.close(); await gw.close(); dsh.close() }
})
