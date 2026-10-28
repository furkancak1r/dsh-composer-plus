// Gateway tests: run with  npm test  (node --test). Uses a mock DSH host on loopback and a real TLS gateway.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { connect } from 'node:tls'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway, acceptWs, wsConnect, inSubnet, isTailnet, allowed, normFp, macName, tailscaleInfo, RPC, STREAMS, PLUS, LOG_MAX } from '../tether/gateway/server.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(10) }
}

// ---- Mock DSH host: cookie login, unary RPC, remote.mux with $events and an echo stream ----
async function mockDsh() {
  const m = { results: [], rpcs: [], plus: [], muxes: new Set(), events: null }
  const authed = req => (req.headers.cookie ?? '').includes('dsh-auth-test=1')
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/?token=x') { res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-test=1; HttpOnly' }); return res.end() }
    if (!authed(req)) { res.writeHead(401); return res.end() }
    let b = ''
    req.on('data', d => b += d).on('end', () => {
      if (req.url.startsWith('/api/composer-plus.')) {
        m.plus.push({ method: req.method, url: req.url, body: b, type: req.headers['content-type'] ?? null })
        // A slow route (`m.hang` = its name): no answer yet; `m.hung` resolves when the gateway closes this request, and
        // `m.hungRes` answers it later.
        if (m.hang && req.url.startsWith('/api/composer-plus.' + m.hang)) { m.hungRes = res; m.hung = new Promise((r) => res.on('close', r)); return }
        const known = req.url.startsWith('/api/composer-plus.later') ? { ideas: [] } : req.url.startsWith('/api/composer-plus.grants') && m.grants ? m.grants : undefined
        res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(known ?? { error: 'not found' }))
      }
      const body = JSON.parse(b)
      if (body.method === '$events/result') m.results.push(body.payload.args); else m.rpcs.push(body.method)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { echo: body.method } } }))
    })
  })
  http.on('upgrade', (req, sock, head) => {
    if (!authed(req)) return sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    if (m.refuseMux) return sock.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    const ws = acceptWs(req, sock, head)
    m.muxes.add(ws); ws.onClose = () => m.muxes.delete(ws)
    ws.onText = t => {
      const f = JSON.parse(t)
      if (f.type === 'open' && f.endpoint === '$events') {
        m.events = { ws, streamId: f.streamId }
        ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'ready', clientId: 'up-1', host: { home: '/Users/secret' } } }))
      } else if (f.type === 'open') ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: { echo: f.endpoint } }))
    }
  })
  await new Promise(r => http.listen(0, '127.0.0.1', r))
  m.url = 'http://127.0.0.1:' + http.address().port + '/?token=x'
  m.push = value => m.events.ws.send(JSON.stringify({ type: 'item', streamId: m.events.streamId, value }))
  m.close = () => { for (const w of m.muxes) w.socket.destroy(); http.close() }
  return m
}

async function setup(extra = {}) {
  const dsh = await mockDsh()
  const dir = extra.dir ?? mkdtempSync(join(tmpdir(), 'dshm-'))
  const gw = createGateway({ dir, upstreamUrl: () => dsh.url, port: 0, qr: false, bonjour: false, notify: false, tailscale: { installed: false, online: false, ip: null, name: null }, netInfo: () => ({ address: '127.0.0.1', netmask: '255.0.0.0' }), ...extra })
  await gw.start()
  return { gw, dsh, dir, done: async () => { await gw.close(); dsh.close() } }
}

// HTTPS client that, like the iOS app, accepts the self-signed cert only if its SHA-256 matches the pinned fingerprint.
function call(gw, method, path, body, headers = {}, pin = gw.fingerprint, signal) {
  return new Promise((ok, bad) => {
    const req = request({ host: '127.0.0.1', port: gw.port, method, path, rejectUnauthorized: false, agent: false, signal, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let b = ''
      res.on('data', d => b += d).on('end', () => { try { ok({ status: res.statusCode, json: JSON.parse(b) }) } catch { ok({ status: res.statusCode, json: null }) } })
    })
    req.on('socket', s => s.on('secureConnect', () => {
      if (normFp(s.getPeerCertificate().fingerprint256) !== normFp(pin)) req.destroy(new Error('certificate pin mismatch'))
      else req.end(body === undefined ? undefined : JSON.stringify(body))
    }))
    req.on('error', bad)
  })
}
/** The phone's view of the QR text: tether://pair?… query fields. */
const invite = s => { const u = new URL(s); assert.equal(u.protocol + u.host, 'tether:pair'); return Object.fromEntries(u.searchParams) }
const rpc = (gw, token, method, args = {}) => call(gw, 'POST', '/api/' + method, { type: 'client-request', rpcId: 'r' + Math.random(), method, payload: { args } }, { authorization: 'Bearer ' + token })

async function pairDevice(gw, name = 'Test iPhone') {
  const code = gw.newCode().value
  const p = call(gw, 'POST', '/pair', { code, name })
  const pend = await waitFor(() => gw.state().pending[0])
  assert.equal(pend.name, name)
  gw.settle(pend.id, true)
  const r = await p
  assert.equal(r.status, 200)
  return r.json
}
async function phoneWs(gw, token) {
  const ws = await wsConnect('wss://127.0.0.1:' + gw.port + '/api/remote.mux', { authorization: 'Bearer ' + token }, { rejectUnauthorized: false })
  ws.frames = []; ws.closed = false
  ws.onText = t => ws.frames.push(JSON.parse(t)); ws.onClose = () => { ws.closed = true }
  ws.json = f => ws.send(JSON.stringify(f))
  return ws
}

test('subnet check', () => {
  assert.ok(inSubnet('192.168.1.20', '192.168.1.44', '255.255.255.0'))
  assert.ok(inSubnet('::ffff:192.168.1.20', '192.168.1.44', '255.255.255.0'))
  assert.ok(!inSubnet('192.168.2.20', '192.168.1.44', '255.255.255.0'))
  assert.ok(!inSubnet('10.0.0.5', '192.168.1.44', '255.255.255.0'))
  assert.ok(!inSubnet('fe80::1', '192.168.1.44', '255.255.255.0'))
  assert.equal(normFp('AB:cd:01'), 'abcd01')
})

test('tailnet range and connection filter', () => {
  assert.ok(!isTailnet('100.63.255.255')); assert.ok(isTailnet('100.64.0.1')); assert.ok(isTailnet('100.127.255.254')); assert.ok(!isTailnet('100.128.0.1'))
  assert.ok(isTailnet('::ffff:100.100.1.2')); assert.ok(isTailnet('fd7a:115c:a1e0::1')); assert.ok(!isTailnet('fd7a:115c:a1e1::1')); assert.ok(!isTailnet('8.8.8.8'))
  const net = { address: '192.168.1.44', netmask: '255.255.255.0' }
  assert.ok(allowed('192.168.1.20', '::ffff:192.168.1.44', net)) // LAN -> LAN
  assert.ok(allowed('100.101.1.2', '100.90.0.7', net)) // tailnet -> tailnet
  assert.ok(allowed('fd7a:115c:a1e0::2', 'fd7a:115c:a1e0::7', net))
  assert.ok(!allowed('100.101.1.2', '192.168.1.44', net)) // tailnet peer on the LAN address
  assert.ok(!allowed('192.168.1.20', '100.90.0.7', net)) // LAN peer arriving on a non-LAN local address
  assert.ok(!allowed('8.8.8.8', '192.168.1.44', net)); assert.ok(!allowed('8.8.8.8', '100.90.0.7', net)) // public
})

test('tailscaleInfo reads the Mac app binary also without TERM (dsh opened from the Dock)', async () => {
  // Like Tailscale.app/Contents/MacOS/Tailscale: without TERM or TAILSCALE_BE_CLI it prints a GUI error and exits 0.
  // printenv, not $TERM: macOS /bin/sh sets its own TERM=dumb when the environment has none.
  const bin = join(mkdtempSync(join(tmpdir(), 'ts-bin-')), 'Tailscale')
  writeFileSync(bin, `#!/bin/sh
if [ -z "$(printenv TERM)" ] && [ -z "$(printenv TAILSCALE_BE_CLI)" ]; then echo 'The Tailscale GUI failed to start'; exit 0; fi
echo '{"BackendState":"Running","Self":{"DNSName":"mac.tail1.ts.net.","TailscaleIPs":["100.90.0.7","fd7a:115c:a1e0::7"]}}'
`, { mode: 0o755 })
  const term = process.env.TERM
  delete process.env.TERM
  try {
    assert.deepEqual(await tailscaleInfo([join(tmpdir(), 'no-such-tailscale'), bin]), { installed: true, online: true, ip: '100.90.0.7', name: 'mac.tail1.ts.net' })
  } finally { if (term !== undefined) process.env.TERM = term }
})

test('tailscale address goes into the QR and /me', async () => {
  const t = await setup({ tailscale: { installed: true, online: true, ip: '100.90.0.7', name: 'mac.tail1.ts.net' } })
  try {
    assert.equal(invite(t.gw.newCode().payload).ts, '100.90.0.7')
    assert.equal(t.gw.state().tailscale.name, 'mac.tail1.ts.net')
    const { token } = await pairDevice(t.gw)
    assert.equal((await call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + token })).json.tailscale, '100.90.0.7')
  } finally { await t.done() }
  const off = await setup()
  try { assert.equal(invite(off.gw.newCode().payload).ts, undefined) } finally { await off.done() }
})

test('the Mac name goes into the QR, /pair and /me, so the phone can tell Macs apart', async () => {
  assert.equal(macName(() => 'Studio\n'), 'Studio')
  assert.equal(macName(() => 'A\u0007B'.padEnd(80, 'x')).length, 64, 'control characters out, bounded')
  assert.ok(macName(() => { throw new Error('no scutil') }).length > 0, 'falls back to the host name')
  const t = await setup({ macName: 'Office Mac' })
  try {
    assert.equal(invite(t.gw.newCode().payload).mac, 'Office Mac')
    const d = await pairDevice(t.gw)
    assert.equal(d.mac, 'Office Mac')
    assert.equal((await call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + d.token })).json.mac, 'Office Mac')
    assert.equal(t.gw.state().mac, 'Office Mac')
  } finally { await t.done() }
})

test('pairing gives a token; only its hash is stored; auth works', async () => {
  const t = await setup()
  try {
    const d = await pairDevice(t.gw)
    assert.match(d.token, /^[A-Za-z0-9_-]{43}$/) // 256-bit
    const stored = readFileSync(join(t.dir, 'devices.json'), 'utf8')
    assert.ok(!stored.includes(d.token))
    const me = await call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + d.token })
    assert.equal(me.status, 200); assert.equal(me.json.deviceId, d.deviceId)
    await waitFor(() => t.gw.state().upstream === 'connected')
    const r = await rpc(t.gw, d.token, 'session/list')
    assert.equal(r.status, 200); assert.deepEqual(r.json.result, { ok: true, value: { echo: 'session/list' } })
  } finally { await t.done() }
})

test('unauthorized: no token, wrong token, malformed token, WS without token', async () => {
  const t = await setup()
  try {
    assert.equal((await rpc(t.gw, '', 'session/list')).status, 401)
    assert.equal((await rpc(t.gw, 'A'.repeat(43), 'session/list')).status, 401)
    assert.equal((await call(t.gw, 'GET', '/me', undefined, { authorization: 'Basic x' })).status, 401)
    await assert.rejects(wsConnect('wss://127.0.0.1:' + t.gw.port + '/api/remote.mux', {}, { rejectUnauthorized: false }), e => e.status === 401)
    assert.equal(t.dsh.rpcs.length, 0)
  } finally { await t.done() }
})

test('pairing code: wrong, replayed, expired, denied', async () => {
  const t = await setup()
  try {
    const code = t.gw.newCode().value
    assert.equal((await call(t.gw, 'POST', '/pair', { code: 'nope', name: 'x' })).status, 403)
    const first = call(t.gw, 'POST', '/pair', { code, name: 'a' })
    const p = await waitFor(() => t.gw.state().pending[0])
    assert.equal((await call(t.gw, 'POST', '/pair', { code, name: 'replay' })).status, 403) // one-time
    t.gw.settle(p.id, false)
    assert.equal((await first).status, 403) // denied on the Mac
    assert.equal(t.gw.state().devices.length, 0)
  } finally { await t.done() }
  const e = await setup({ codeTtlMs: 1 })
  try {
    const code = e.gw.newCode().value
    await sleep(5)
    assert.equal((await call(e.gw, 'POST', '/pair', { code, name: 'late' })).status, 403)
  } finally { await e.done() }
})

test('the QR is a tether://pair link with every field the phone needs (the Camera app offers "Open in Tether")', async () => {
  const t = await setup({ macName: 'Ofis Mac’i & co', tailscale: { installed: true, online: true, ip: '100.90.0.7', name: null } })
  try {
    const c = t.gw.newCode(), q = invite(c.payload)
    assert.match(c.payload, /^tether:\/\/pair\?/)
    assert.ok(!c.payload.includes('+') && c.payload.includes('mac=Ofis%20Mac'), 'a space is %20, not + (iOS reads + as +)')
    assert.deepEqual(q, { v: '1', host: '127.0.0.1', port: String(t.gw.port), fp: t.gw.fingerprint, code: c.value, mac: 'Ofis Mac’i & co', ts: '100.90.0.7' })
  } finally { await t.done() }
})

test('the Mac page learns what happened: approved, denied, phone stopped waiting, timed out; a gone request is 409', async () => {
  const t = await setup({ approveTtlMs: 300 })
  const admin = (path, body) => fetch('http://127.0.0.1:' + t.port + path, body === undefined ? {} : { method: 'POST', headers: { 'x-dsh-admin': '1' }, body: JSON.stringify(body) })
  try {
    t.port = await t.gw.listenAdmin(0)
    assert.equal(t.gw.state().last, null)
    await pairDevice(t.gw, 'Ayşe iPhone')
    assert.equal(t.gw.state().last.result, 'approved'); assert.equal(t.gw.state().last.name, 'Ayşe iPhone')

    // The phone gives up (Cancel / app closed): the card goes away and the page says why.
    const code = t.gw.newCode().value
    const ac = new AbortController()
    const req = request({ host: '127.0.0.1', port: t.gw.port, method: 'POST', path: '/pair', rejectUnauthorized: false, agent: false, signal: ac.signal, headers: { 'content-type': 'application/json' } })
    req.on('error', () => {}); req.end(JSON.stringify({ code, name: 'Quitter' }))
    const p = await waitFor(() => t.gw.state().pending[0])
    assert.ok(Date.parse(p.expiresAt) > Date.now(), 'the card shows a countdown')
    ac.abort()
    await waitFor(() => t.gw.state().pending.length === 0)
    assert.deepEqual([t.gw.state().last.name, t.gw.state().last.result], ['Quitter', 'cancelled'])
    const late = await admin('/approve', { id: p.id })
    assert.equal(late.status, 409, 'Approve on a request that is gone says so')
    assert.match((await late.json()).error, /no longer waiting/)
    assert.equal(t.gw.state().devices.length, 1, 'nothing was paired')

    // Nobody clicks: the request times out and the phone hears "expired", not "denied".
    const slow = call(t.gw, 'POST', '/pair', { code: t.gw.newCode().value, name: 'Slow' })
    await waitFor(() => t.gw.state().pending[0])
    const r = await slow
    assert.equal(r.status, 403); assert.equal(r.json.error, 'pairing expired')
    assert.equal(t.gw.state().last.result, 'expired')

    // Deny on the Mac.
    const d = call(t.gw, 'POST', '/pair', { code: t.gw.newCode().value, name: 'No' })
    const q = await waitFor(() => t.gw.state().pending[0])
    assert.equal((await admin('/deny', { id: q.id })).status, 200)
    assert.equal((await d).json.error, 'pairing denied')
    assert.equal(t.gw.state().last.result, 'denied')
  } finally { await t.done() }
})

test('MITM: a different certificate fails the pin check before any request is sent', async () => {
  const a = await setup(), b = await setup()
  try {
    assert.notEqual(a.gw.fingerprint, b.gw.fingerprint)
    await assert.rejects(call(b.gw, 'POST', '/pair', { code: 'x', name: 'x' }, {}, a.gw.fingerprint), /pin mismatch/)
    assert.equal(b.gw.state().pending.length, 0)
    // Same check for the raw TLS handshake the iOS pinning delegate performs.
    const fp = await new Promise((ok, bad) => { const s = connect({ host: '127.0.0.1', port: b.gw.port, rejectUnauthorized: false }, () => { ok(normFp(s.getPeerCertificate().fingerprint256)); s.destroy() }).on('error', bad) })
    assert.equal(fp, b.gw.fingerprint)
  } finally { await a.done(); await b.done() }
})

test('allowlist: disallowed RPC and stream are refused, bad frames close the socket', async () => {
  const t = await setup()
  try {
    const { token } = await pairDevice(t.gw)
    for (const m of ['settings/set', 'credentials/get', 'host/shutdown']) {
      assert.ok(!RPC.has(m)); assert.equal((await rpc(t.gw, token, m)).status, 403)
    }
    const r = await call(t.gw, 'POST', '/api/session/list', { type: 'client-request', rpcId: '1', method: 'settings/set', payload: {} }, { authorization: 'Bearer ' + token })
    assert.equal(r.status, 400) // method must match the path
    assert.equal(t.dsh.rpcs.length, 0)
    const ws = await phoneWs(t.gw, token)
    ws.json({ type: 'open', streamId: 's1', endpoint: 'terminal/attach', payload: {} })
    await waitFor(() => ws.frames.length)
    assert.equal(ws.frames[0].type, 'error'); assert.equal(ws.frames[0].error.code, 'mobile/forbidden')
    assert.ok(STREAMS.has('session/follow'))
    ws.json({ type: 'open', streamId: 's2', endpoint: 'session/follow', payload: {} })
    await waitFor(() => ws.frames.length === 2)
    assert.deepEqual(ws.frames[1], { type: 'item', streamId: 's2', value: { echo: 'session/follow' } })
    ws.json({ type: 'open', streamId: 's3', endpoint: 'session/follow', payload: {}, extra: 1 })
    await waitFor(() => ws.closed)
  } finally { await t.done() }
})

test('composer-plus routes: allowlisted methods pass with the query or body; switches and other routes are refused', async () => {
  const t = await setup()
  try {
    const { token } = await pairDevice(t.gw)
    const auth = { authorization: 'Bearer ' + token }
    assert.deepEqual((await call(t.gw, 'GET', '/me', undefined, auth)).json.plus, [...PLUS.keys()])
    let r = await call(t.gw, 'GET', '/plus/later?sessionId=s%201', undefined, auth)
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ideas: [] })
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'GET', url: '/api/composer-plus.later?sessionId=s%201', body: '', type: null })
    r = await call(t.gw, 'POST', '/plus/later', { sessionId: 's', remove: 'i1' }, auth)
    assert.equal(r.status, 200); assert.deepEqual(JSON.parse(t.dsh.plus.at(-1).body), { sessionId: 's', remove: 'i1' })
    // Open GitHub issue (Later list) and Chats that changed this file: the phone may ask; the query passes as it is.
    r = await call(t.gw, 'POST', '/plus/later', { sessionId: 's', issue: 'i2' }, auth)
    assert.equal(r.status, 200); assert.deepEqual(JSON.parse(t.dsh.plus.at(-1).body), { sessionId: 's', issue: 'i2' })
    r = await call(t.gw, 'GET', '/plus/file-chats?sessionId=s&path=src%2Fapp.js', undefined, auth)
    assert.equal(t.dsh.plus.at(-1).method, 'GET'); assert.equal(t.dsh.plus.at(-1).url, '/api/composer-plus.file-chats?sessionId=s&path=src%2Fapp.js')
    assert.equal((await call(t.gw, 'POST', '/plus/file-chats', { sessionId: 's' }, auth)).status, 403, 'file-chats is GET only')
    // Branch badges: the phone may read them; the switch stays on the Mac (POST is not allowed at all).
    r = await call(t.gw, 'GET', '/plus/branches', undefined, auth)
    assert.equal(t.dsh.plus.at(-1).url, '/api/composer-plus.branches')
    const n = t.dsh.plus.length
    assert.equal((await call(t.gw, 'POST', '/plus/branches', { on: false }, auth)).status, 403, 'the branch switch is the Mac\'s')
    assert.equal(t.dsh.plus.length, n, 'refused before it reaches dsh')
    // Next message prediction: the phone may ask for a prediction; the switch, the model choice and the catalog stay on the Mac.
    r = await call(t.gw, 'POST', '/plus/predict', { sessionId: 's', afterSeq: 9 }, auth)
    assert.deepEqual(JSON.parse(t.dsh.plus.at(-1).body), { sessionId: 's', afterSeq: 9 })
    // Complete while typing: the phone may ask for a completion; the switch stays on the Mac.
    r = await call(t.gw, 'POST', '/plus/complete', { sessionId: 's', text: 'Run the' }, auth)
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'POST', url: '/api/composer-plus.complete', body: JSON.stringify({ sessionId: 's', text: 'Run the' }), type: 'application/json' })
    // Improve prompt: the phone may ask to improve a draft; the model choice and the catalog stay on the Mac.
    r = await call(t.gw, 'POST', '/plus/improve', { sessionId: 's', text: 'fix login' }, auth)
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'POST', url: '/api/composer-plus.improve', body: JSON.stringify({ sessionId: 's', text: 'fix login' }), type: 'application/json' })
    // The phone gives up (time-out, Cancel): the gateway closes dsh's request, so the model call on the Mac stops and frees
    // its chat (else the next try gets 409 "still running").
    t.dsh.hang = 'improve'
    const phoneLeaves = new AbortController()
    const leaving = call(t.gw, 'POST', '/plus/improve', { sessionId: 's', text: 'slow' }, auth, undefined, phoneLeaves.signal).catch(() => 'gone')
    await waitFor(() => t.dsh.hung !== undefined) // not the promise itself: waitFor would wait for it to settle
    phoneLeaves.abort()
    assert.equal(await leaving, 'gone')
    assert.equal(await Promise.race([t.dsh.hung.then(() => 'closed'), sleep(2000).then(() => 'still open')]), 'closed', 'dsh\'s request closes with the phone\'s')
    // A route that changes the chat runs to its end on the Mac: the phone's first address gives up after 5 s, and a
    // rollback stopped there would stop the turn but never write its marker or the files.
    t.dsh.hang = 'rollback'; t.dsh.hung = undefined
    const writer = new AbortController()
    const writing = call(t.gw, 'POST', '/plus/rollback', { sessionId: 's', seq: 3, files: true }, auth, undefined, writer.signal).catch(() => 'gone')
    await waitFor(() => t.dsh.hung !== undefined)
    writer.abort()
    assert.equal(await writing, 'gone')
    assert.equal(await Promise.race([t.dsh.hung.then(() => 'closed'), sleep(500).then(() => 'still open')]), 'still open', 'a write route is not stopped with the phone\'s request')
    t.dsh.hungRes.writeHead(200, { 'content-type': 'application/json' }); t.dsh.hungRes.end('{}') // its late answer finds no phone
    await t.dsh.hung
    t.dsh.hang = false
    assert.equal((await call(t.gw, 'GET', '/plus/later?sessionId=s', undefined, auth)).status, 200, 'the gateway still answers')
    // Green dots: the phone reads the Mac's unread list and marks a chat read; the switch stays on the Mac.
    await call(t.gw, 'GET', '/plus/unread', undefined, auth)
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'GET', url: '/api/composer-plus.unread', body: '', type: null })
    await call(t.gw, 'POST', '/plus/unread', { sessionIds: ['s'] }, auth)
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'POST', url: '/api/composer-plus.unread', body: JSON.stringify({ sessionIds: ['s'] }), type: 'application/json' })
    // Changes panel branch tree: the phone reads the tree and one commit's files (the query goes to dsh as it is).
    await call(t.gw, 'GET', '/plus/graph?sessionId=s', undefined, auth)
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'GET', url: '/api/composer-plus.graph?sessionId=s', body: '', type: null })
    await call(t.gw, 'GET', `/plus/changes?commit=${'a'.repeat(40)}&mode=commit&sessionId=s`, undefined, auth)
    assert.equal(t.dsh.plus.at(-1).url, `/api/composer-plus.changes?commit=${'a'.repeat(40)}&mode=commit&sessionId=s`)
    // Branch per chat: the phone reads the chat's branch and starts a chat on a new branch (the Mac names it).
    await call(t.gw, 'GET', '/plus/worktrees?sessionId=s', undefined, auth)
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'GET', url: '/api/composer-plus.worktrees?sessionId=s', body: '', type: null })
    await call(t.gw, 'POST', '/plus/worktrees', { action: 'start', sessionId: 's', text: 'Add login' }, auth)
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'POST', url: '/api/composer-plus.worktrees', body: JSON.stringify({ action: 'start', sessionId: 's', text: 'Add login' }), type: 'application/json' })
    // Default workspace: Quick chat asks the Mac where the global New session opens (the Mac's setting, read-only here).
    await call(t.gw, 'POST', '/plus/new-session-workspace', {}, auth)
    assert.deepEqual(t.dsh.plus.at(-1), { method: 'POST', url: '/api/composer-plus.new-session-workspace', body: '{}', type: 'application/json' })
    // An older plugin without the route: its 404 reaches the phone, which hides the feature.
    assert.equal((await call(t.gw, 'GET', '/plus/changes?sessionId=s', undefined, auth)).status, 404)
    const seen = t.dsh.plus.length
    for (const [m, p, b] of [['POST', '/plus/rollback', { on: false }], ['POST', '/plus/mobile', { on: false }], ['GET', '/plus/update'],
      ['POST', '/plus/grants', { ttlMs: null }], // the grant time limit is the Mac's setting
      ['POST', '/plus/grants', { action: 'grant', sessionId: 's', tool: 't', ttlMs: 1 }],
      ['POST', '/plus/predict', { on: true }], ['POST', '/plus/predict', { model: null }], ['GET', '/plus/predict?catalog=1'],
      ['POST', '/plus/complete', { on: true }], ['GET', '/plus/complete'],
      ['POST', '/plus/improve', { model: { provider: 'x', model: 'y' } }], ['GET', '/plus/improve?catalog=1'], ['POST', '/plus/unread', { on: false }],
      ['GET', '/plus/default-workspace'], ['POST', '/plus/default-workspace', { workspaceId: 'w' }], ['POST', '/plus/new-session-workspace', { on: false }], ['GET', '/plus/new-session-workspace'],
      ['GET', '/plus/shot?id=x'], ['POST', '/plus/changes', {}], ['POST', '/plus/graph', {}], ['GET', '/plus/../mobile'], ['POST', '/plus/continue', 'not json']]) {
      assert.equal((await call(t.gw, m, p, b, auth)).status, p.endsWith('continue') ? 400 : p.includes('..') ? 404 : 403, p)
    }
    assert.equal(t.dsh.plus.length, seen, 'nothing refused reaches dsh')
    assert.equal((await call(t.gw, 'GET', '/plus/later?sessionId=s')).status, 401, 'a token is required')
  } finally { await t.done() }
})

test('a failed upstream connect is retried on the next stream open', async () => {
  const t = await setup()
  try {
    const { token } = await pairDevice(t.gw)
    await waitFor(() => t.gw.state().upstream === 'connected')
    const ws = await phoneWs(t.gw, token)
    t.dsh.refuseMux = true
    ws.json({ type: 'open', streamId: 'a', endpoint: 'session/follow', payload: {} })
    await waitFor(() => ws.frames.length)
    assert.equal(ws.frames[0].error.message, 'DSH host unavailable')
    t.dsh.refuseMux = false
    ws.json({ type: 'open', streamId: 'b', endpoint: 'session/follow', payload: {} })
    await waitFor(() => ws.frames.length === 2)
    assert.deepEqual(ws.frames[1], { type: 'item', streamId: 'b', value: { echo: 'session/follow' } })
    ws.close()
  } finally { await t.done() }
})

test('revocation closes live sockets and the token stops working (replay)', async () => {
  const t = await setup()
  try {
    const d = await pairDevice(t.gw)
    const ws = await phoneWs(t.gw, d.token)
    await waitFor(() => t.gw.state().devices[0].connections > 0)
    assert.ok(t.gw.revoke(d.deviceId))
    await waitFor(() => ws.closed)
    assert.equal((await rpc(t.gw, d.token, 'session/list')).status, 401)
    await assert.rejects(phoneWs(t.gw, d.token), e => e.status === 401)
  } finally { await t.done() }
})

const adminCall = (port, path, body) => fetch('http://127.0.0.1:' + port + path, body === undefined ? {} : { method: 'POST', headers: { 'x-dsh-admin': '1' }, body: JSON.stringify(body) })
const quietGateway = dir => createGateway({ dir, upstreamUrl: () => 'http://127.0.0.1:1/', port: 0, qr: false, bonjour: false, notify: false, tailscale: {}, netInfo: () => null })

test('paired iPhones: name, paired and last connection; Remove on the Mac page revokes at once, pairing again works', async () => {
  const t = await setup()
  try {
    const port = await t.gw.listenAdmin(0)
    const d = await pairDevice(t.gw, 'Lost iPhone')
    let dev = t.gw.state().devices[0]
    assert.equal(dev.name, 'Lost iPhone'); assert.ok(Date.parse(dev.createdAt)); assert.equal(dev.lastSeenAt, undefined, 'never connected yet')
    assert.equal(dev.tokenHash, undefined, 'the token hash never leaves the gateway')
    const before = Date.now()
    const ws = await phoneWs(t.gw, d.token)
    dev = t.gw.state().devices[0]
    assert.ok(Date.parse(dev.lastSeenAt) >= before - 5, 'a connection sets the last connection time'); assert.equal(dev.connections, 1)
    const r = await adminCall(port, '/revoke', { id: d.deviceId })
    assert.equal(r.status, 200); assert.deepEqual((await r.json()).devices, [])
    await waitFor(() => ws.closed)
    assert.equal((await call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + d.token })).status, 401, 'the old key no longer works')
    assert.ok(!readFileSync(join(t.dir, 'devices.json'), 'utf8').includes(d.deviceId), 'gone from the file too')
    const again = await pairDevice(t.gw, 'Lost iPhone')
    assert.equal((await call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + again.token })).status, 200, 'it connects again only after a new pairing')
  } finally { await t.done() }
})

test('last connection time reaches devices.json (not at each request) and survives a new gateway', async () => {
  const slow = await setup({ watchMs: 20 }) // default: at most once a minute
  try {
    const d = await pairDevice(slow.gw)
    await call(slow.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + d.token })
    await sleep(150)
    assert.ok(slow.gw.state().devices[0].lastSeenAt, 'in memory at once')
    assert.equal(JSON.parse(readFileSync(join(slow.dir, 'devices.json'), 'utf8'))[0].lastSeenAt, undefined, 'not written at each connection')
  } finally { await slow.done() }
  assert.ok(JSON.parse(readFileSync(join(slow.dir, 'devices.json'), 'utf8'))[0].lastSeenAt, 'close() writes it')
  const t = await setup({ watchMs: 20, seenSaveMs: 0 })
  try {
    const d = await pairDevice(t.gw)
    await call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + d.token })
    const seen = await waitFor(() => JSON.parse(readFileSync(join(t.dir, 'devices.json'), 'utf8'))[0].lastSeenAt)
    assert.equal(seen, t.gw.state().devices[0].lastSeenAt)
    assert.equal(statSync(join(t.dir, 'devices.json')).mode & 0o777, 0o600)
  } finally { await t.done() }
  const g2 = quietGateway(t.dir)
  try { assert.ok(g2.state().devices[0].lastSeenAt) } finally { await g2.close() }
  // A failed write (here: devices.json is a folder for a moment) is tried again at the next tick.
  const r = await setup({ watchMs: 20, seenSaveMs: 0 })
  try {
    const d = await pairDevice(r.gw)
    const file = join(r.dir, 'devices.json'), saved = readFileSync(file, 'utf8')
    rmSync(file); mkdirSync(file)
    await call(r.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + d.token })
    await sleep(100) // some ticks fail
    rmSync(file, { recursive: true }); writeFileSync(file, saved)
    await waitFor(() => JSON.parse(readFileSync(file, 'utf8'))[0].lastSeenAt, 2000)
  } finally { await r.done() }
})

test('access log: allowed and refused attempts with time, IP, device and reason; repeats merge; owner-only file', async () => {
  const t = await setup()
  try {
    const port = await t.gw.listenAdmin(0)
    const d = await pairDevice(t.gw, 'Ayşe iPhone')
    let log = t.gw.state().log
    assert.deepEqual([log[0].result, log[0].reason, log[0].device, log[0].ip], ['allowed', 'paired', 'Ayşe iPhone', '127.0.0.1'])
    await call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + d.token })
    log = t.gw.state().log
    assert.deepEqual([log[0].result, log[0].reason, log[0].device], ['allowed', 'lan', 'Ayşe iPhone'], 'a new connection, newest first')
    for (let i = 0; i < 3; i++) await call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + 'A'.repeat(43) })
    log = t.gw.state().log
    assert.deepEqual([log[0].result, log[0].reason, log[0].device, log[0].n], ['refused', 'token', null, 3], 'three bad keys: one entry, counted')
    await call(t.gw, 'POST', '/pair', { code: 'wrong', name: 'x' })
    assert.deepEqual([t.gw.state().log[0].result, t.gw.state().log[0].reason], ['refused', 'code'])
    assert.ok(t.gw.state().log.every(e => Date.parse(e.at) > 0))
    // The Mac page gets the same list.
    assert.deepEqual((await (await adminCall(port, '/state')).json()).log, t.gw.state().log)
  } finally { await t.done() }
  const file = join(t.dir, 'access.json')
  assert.equal(statSync(file).mode & 0o777, 0o600, 'written on close, owner-only')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.at(-1).reason, 'code'); assert.ok(!JSON.stringify(saved).includes('A'.repeat(43)), 'never a token')
  // A new gateway reads it back; at most LOG_MAX entries are kept.
  writeFileSync(file, JSON.stringify(Array.from({ length: LOG_MAX + 50 }, (_, i) => ({ at: new Date(Date.now() - 1e9 + i).toISOString(), ip: '10.0.0.' + (i % 250), device: null, result: 'refused', reason: 'network', n: 1 }))))
  const g2 = quietGateway(t.dir)
  try { assert.equal(g2.state().log.length, 50, 'the page gets the newest 50'); assert.equal(g2.state().log[0].ip, '10.0.0.' + ((LOG_MAX + 49) % 250)) } finally { await g2.close() }
  writeFileSync(file, '{broken')
  const g3 = quietGateway(t.dir)
  try { assert.deepEqual(g3.state().log, [], 'a broken file is an empty log') } finally { await g3.close() }
})

test('access log keeps at most LOG_MAX entries', async () => {
  const t = await setup()
  try {
    for (let i = 0; i < 3; i++) await call(t.gw, 'POST', '/pair', { code: 'wrong', name: 'x' })
    assert.equal(t.gw.state().log.filter(e => e.reason === 'code').length, 1)
    assert.equal(t.gw.state().log[0].n, 3)
  } finally { await t.done() }
  const file = join(t.dir, 'access.json')
  writeFileSync(file, JSON.stringify(Array.from({ length: LOG_MAX }, (_, i) => ({ at: new Date(Date.now() - 1e9 + i).toISOString(), ip: '10.0.1.' + (i % 250), device: null, result: 'refused', reason: 'network', n: 1 }))))
  const t2 = await setup({ dir: t.dir })
  try { await call(t2.gw, 'POST', '/pair', { code: 'wrong', name: 'x' }) } finally { await t2.done() }
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.length, LOG_MAX, 'the oldest goes when a new one comes')
  assert.equal(saved.at(-1).reason, 'code'); assert.equal(saved[0].ip, '10.0.1.1')
})

test('Tailscale only: the Mac page setting refuses LAN peers (also an open connection), is logged and is kept', async () => {
  const net = { address: '127.0.0.1', netmask: '255.0.0.0' }
  assert.ok(allowed('127.0.0.5', '127.0.0.1', net) && !allowed('127.0.0.5', '127.0.0.1', net, true), 'LAN refused when on')
  assert.ok(allowed('100.101.1.2', '100.90.0.7', net, true), 'tailnet still allowed')
  assert.ok(!allowed('8.8.8.8', '100.90.0.7', net, true))
  const t = await setup()
  try {
    const port = await t.gw.listenAdmin(0)
    const d = await pairDevice(t.gw)
    const ws = await phoneWs(t.gw, d.token)
    assert.equal(t.gw.state().tailnetOnly, false, 'off by default')
    assert.equal((await adminCall(port, '/settings', { tailnetOnly: 'yes' })).status, 400)
    assert.equal((await adminCall(port, '/settings', {})).status, 400)
    const r = await adminCall(port, '/settings', { tailnetOnly: true })
    assert.equal(r.status, 200); assert.equal((await r.json()).tailnetOnly, true)
    await waitFor(() => ws.closed) // the open LAN socket closes at once
    await assert.rejects(call(t.gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + d.token }), 'a new LAN connection is refused')
    const e = t.gw.state().log[0]
    assert.deepEqual([e.result, e.reason, e.device], ['refused', 'tailnet-only', null])
    assert.equal(statSync(join(t.dir, 'settings.json')).mode & 0o777, 0o600)
    // Without the header (another web page) nothing changes.
    assert.equal((await fetch('http://127.0.0.1:' + port + '/settings', { method: 'POST', body: '{"tailnetOnly":false}' })).status, 404)
    assert.equal(t.gw.state().tailnetOnly, true)
  } finally { await t.done() }
  // A new gateway (dsh restart) keeps it; switching it off lets the LAN phone in again.
  const t2 = await setup({ dir: t.dir })
  try {
    assert.equal(t2.gw.state().tailnetOnly, true)
    await assert.rejects(call(t2.gw, 'GET', '/me', undefined, {}), 'still refused after a restart')
    const port = await t2.gw.listenAdmin(0)
    await adminCall(port, '/settings', { tailnetOnly: false })
    assert.equal((await call(t2.gw, 'GET', '/me', undefined, {})).status, 401, 'LAN reaches the gateway again')
  } finally { await t2.done() }
})

test('Tailscale only also stops the Bonjour advertisement (Mac name, port, fingerprint) on the local network', async () => {
  const ads = [] // each fake dns-sd process: its arguments and whether it was killed
  const spawn = (cmd, args) => { const p = Object.assign(new EventEmitter(), { cmd, args, killed: false, kill() { p.killed = true } }); ads.push(p); return p }
  const live = () => ads.filter(p => !p.killed)
  let net = { address: '127.0.0.1', netmask: '255.0.0.0' }
  const t = await setup({ bonjour: true, spawn, macName: 'Test Mac', netInfo: () => net, watchMs: 20 })
  try {
    assert.equal(live().length, 1, 'advertised while the option is off')
    assert.deepEqual([ads[0].cmd, ...ads[0].args], ['dns-sd', '-R', 'Test Mac', '_dshmobile._tcp', 'local', String(t.gw.port), 'fp=' + t.gw.fingerprint])
    const port = await t.gw.listenAdmin(0)
    assert.equal((await adminCall(port, '/settings', { tailnetOnly: true })).status, 200)
    assert.equal(live().length, 0, 'switching it on stops the advertisement at once')
    await adminCall(port, '/settings', { tailnetOnly: true })
    assert.equal(ads.length, 1, 'the same value again starts nothing')
    assert.equal((await adminCall(port, '/settings', { tailnetOnly: 'yes' })).status, 400)
    assert.equal(ads.length, 1, 'a bad body changes nothing')
    await adminCall(port, '/settings', { tailnetOnly: false })
    assert.equal(ads.length, 2); assert.equal(live().length, 1, 'switching it off advertises again')
    // A network change rebinds: the old advertisement goes, one for the new port comes.
    net = { address: '127.0.0.3', netmask: '255.0.0.0', bind: '127.0.0.1' }
    await waitFor(() => t.gw.state().running && t.gw.state().address === '127.0.0.3' && ads.length === 3)
    assert.equal(live().length, 1); assert.equal(live()[0].args[4], String(t.gw.port))
    await t.gw.stop()
    assert.equal(live().length, 0, 'stop ends it')
  } finally { await t.done() }
  // A new gateway (dsh restart) with the option on never advertises.
  writeFileSync(join(t.dir, 'settings.json'), JSON.stringify({ tailnetOnly: true }))
  const before = ads.length
  const t2 = await setup({ dir: t.dir, bonjour: true, spawn })
  try {
    assert.equal(t2.gw.state().running, true)
    assert.equal(ads.length, before, 'no advertisement at start while Tailscale only is on')
  } finally { await t2.done() }
})

test('LAN-only: clients outside the subnet are dropped at connect', async () => {
  const t = await setup({ netInfo: () => ({ address: '127.0.0.2', netmask: '255.255.255.255', bind: '127.0.0.1' }) })
  try {
    await assert.rejects(call(t.gw, 'POST', '/pair', { code: 'x', name: 'x' }, {}, 'any'))
  } finally { await t.done() }
})

test('network change rebinds and drops existing connections', async () => {
  let net = { address: '127.0.0.1', netmask: '255.0.0.0' }
  const t = await setup({ netInfo: () => net, watchMs: 20 })
  try {
    const { token } = await pairDevice(t.gw)
    const ws = await phoneWs(t.gw, token)
    net = { address: '127.0.0.3', netmask: '255.0.0.0', bind: '127.0.0.1' }
    await waitFor(() => ws.closed)
    await waitFor(() => t.gw.state().running && t.gw.state().address === '127.0.0.3')
  } finally { await t.done() }
})

test('events: no phone -> next; phone answers approval; first answer wins; host path hidden', async () => {
  const t = await setup()
  try {
    await waitFor(() => t.gw.state().upstream === 'connected')
    t.dsh.push({ type: 'waterfall', event: 'approval/request', eventId: 'e0', agentId: 'a', request: { toolName: 'bash' } })
    await waitFor(() => t.dsh.results.length === 1)
    assert.deepEqual(t.dsh.results[0], { clientId: 'up-1', eventId: 'e0', outcome: { kind: 'next' } })

    const { token } = await pairDevice(t.gw)
    const [p1, p2] = [await phoneWs(t.gw, token), await phoneWs(t.gw, token)]
    for (const p of [p1, p2]) { p.json({ type: 'open', streamId: 'ev', endpoint: '$events', payload: { args: {} } }); await waitFor(() => p.frames.length) }
    assert.deepEqual(p1.frames[0].value, { type: 'ready', clientId: 'mobile' })
    t.dsh.push({ type: 'emit', event: 'settings/secret', args: [1] }) // not allowlisted -> dropped
    t.dsh.push({ type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 'a', request: { toolName: 'bash', reason: 'rm' } })
    await waitFor(() => p1.frames.length === 2 && p2.frames.length === 2)
    assert.equal(p1.frames[1].value.eventId, 'e1')

    const answer = value => rpc(t.gw, token, '$events/result', { clientId: 'mobile', eventId: 'e1', outcome: { kind: 'result', value } })
    const [a, b] = await Promise.all([answer('allowed-once'), answer('rejected')]) // concurrent answers
    assert.deepEqual([a.json.result.ok, b.json.result.ok].sort(), [false, true])
    await waitFor(() => t.dsh.results.length === 2)
    assert.equal(t.dsh.results[1].clientId, 'up-1')
    assert.equal(t.dsh.results[1].eventId, 'e1')
    await waitFor(() => p2.frames.some(f => f.value?.type === 'cancel'))
    // dsh-composer-plus's own event (green dots) goes to every phone on $events, like a forwarded dsh event.
    t.gw.emit('composer-plus/unread', [['s1']])
    for (const p of [p1, p2]) await waitFor(() => p.frames.some(f => f.value?.event === 'composer-plus/unread'))
    assert.deepEqual(p1.frames.find(f => f.value?.event === 'composer-plus/unread').value, { type: 'emit', event: 'composer-plus/unread', args: [['s1']] })
  } finally { await t.done() }
})

test('allow for this chat: the gateway allows a granted Auto Review ask itself; other approvals go to the phones', async () => {
  const t = await setup()
  try {
    await waitFor(() => t.gw.state().upstream === 'connected')
    t.dsh.grants = { a: ['bash'] }
    const ask = (eventId, agentId, toolName, reason = 'Auto review denied tool "' + toolName + '": risky') =>
      t.dsh.push({ type: 'waterfall', event: 'approval/request', eventId, agentId, request: { toolName, reason } })
    ask('g1', 'a', 'bash') // granted, no phone: allowed by the gateway
    await waitFor(() => t.dsh.results.length === 1)
    assert.deepEqual(t.dsh.results[0], { clientId: 'up-1', eventId: 'g1', outcome: { kind: 'result', value: 'allowed-once' } })
    const { token } = await pairDevice(t.gw)
    const p = await phoneWs(t.gw, token)
    p.json({ type: 'open', streamId: 'ev', endpoint: '$events', payload: { args: {} } }); await waitFor(() => p.frames.length)
    ask('g2', 'b', 'bash') // another chat: not granted there
    ask('g3', 'a', 'write') // another tool
    t.dsh.push({ type: 'waterfall', event: 'approval/request', eventId: 'g4', agentId: 'a', request: { toolName: 'bash', reason: 'The permission preset asks' } }) // not an Auto Review ask
    await waitFor(() => p.frames.length === 4)
    assert.deepEqual(p.frames.slice(1).map(f => f.value.eventId).sort(), ['g2', 'g3', 'g4'])
    assert.equal(t.dsh.results.length, 1, 'the phone decides those')
    ask('g5', 'a', 'bash') // granted, with a phone: still no prompt on the phone
    await waitFor(() => t.dsh.results.length === 2)
    assert.equal(t.dsh.results[1].eventId, 'g5'); assert.equal(p.frames.length, 4)
    t.dsh.grants = undefined // an older plugin without grants: every approval goes to the phone
    ask('g6', 'a', 'bash')
    await waitFor(() => p.frames.length === 5)
  } finally { await t.done() }
})

test('concurrency: many parallel RPCs and sockets from one device', async () => {
  const t = await setup()
  try {
    const { token } = await pairDevice(t.gw)
    const rs = await Promise.all(Array.from({ length: 60 }, () => rpc(t.gw, token, 'session/list')))
    assert.ok(rs.every(r => r.status === 200 && r.json.result.ok))
    const socks = await Promise.all(Array.from({ length: 8 }, () => phoneWs(t.gw, token)))
    socks.forEach((s, i) => s.json({ type: 'open', streamId: 'f' + i, endpoint: 'workspace/follow', payload: { args: {} } }))
    await waitFor(() => socks.every(s => s.frames.length === 1))
    assert.equal(t.dsh.rpcs.length, 60)
  } finally { await t.done() }
})

test('brute force: repeated bad auth blocks the IP', async () => {
  const t = await setup()
  try {
    const { token } = await pairDevice(t.gw)
    for (let i = 0; i < 10; i++) await rpc(t.gw, 'B'.repeat(43), 'session/list')
    assert.equal((await rpc(t.gw, token, 'session/list')).status, 429)
  } finally { await t.done() }
})

test('token: renews when half-expired, rejects when expired', async () => {
  const t = await setup()
  const opts = { dir: t.dir, upstreamUrl: () => t.dsh.url, port: 0, qr: false, bonjour: false, notify: false, tailscale: { installed: false, online: false, ip: null, name: null }, netInfo: () => ({ address: '127.0.0.1', netmask: '255.0.0.0' }) }
  const { token, deviceId } = await pairDevice(t.gw)
  await t.gw.close()
  const file = join(t.dir, 'devices.json')
  const restart = async days => {
    const devs = JSON.parse(readFileSync(file, 'utf8'))
    devs.find(d => d.id === deviceId).expiresAt = new Date(Date.now() + days * 864e5).toISOString()
    writeFileSync(file, JSON.stringify(devs))
    const gw = createGateway(opts); await gw.start(); return gw
  }
  let gw = await restart(1)
  try {
    const me = await call(gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + token })
    assert.equal(me.status, 200)
    assert.ok(Date.parse(me.json.expiresAt) - Date.now() > 20 * 864e5)
    assert.ok(Date.parse(JSON.parse(readFileSync(file, 'utf8')).find(d => d.id === deviceId).expiresAt) - Date.now() > 20 * 864e5)
    await gw.close()
    gw = await restart(-1)
    assert.equal((await call(gw, 'GET', '/me', undefined, { authorization: 'Bearer ' + token })).status, 401)
  } finally { await gw.close(); t.dsh.close() }
})
