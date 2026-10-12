// Gateway tests: run with  npm test  (node --test). Uses a mock DSH host on loopback and a real TLS gateway.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { connect } from 'node:tls'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway, acceptWs, wsConnect, inSubnet, normFp, RPC, STREAMS } from './server.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(10) }
}

// ---- Mock DSH host: cookie login, unary RPC, remote.mux with $events and an echo stream ----
async function mockDsh() {
  const m = { results: [], rpcs: [], muxes: new Set(), events: null }
  const authed = req => (req.headers.cookie ?? '').includes('dsh-auth-test=1')
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/?token=x') { res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-test=1; HttpOnly' }); return res.end() }
    if (!authed(req)) { res.writeHead(401); return res.end() }
    let b = ''
    req.on('data', d => b += d).on('end', () => {
      const body = JSON.parse(b)
      if (body.method === '$events/result') m.results.push(body.payload.args); else m.rpcs.push(body.method)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { echo: body.method } } }))
    })
  })
  http.on('upgrade', (req, sock, head) => {
    if (!authed(req)) return sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
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
  const dir = mkdtempSync(join(tmpdir(), 'dshm-'))
  writeFileSync(join(dir, 'upstream.url'), dsh.url)
  const gw = createGateway({ dir, port: 0, qr: false, bonjour: false, notify: false, netInfo: () => ({ address: '127.0.0.1', netmask: '255.0.0.0' }), ...extra })
  await gw.start()
  return { gw, dsh, dir, done: async () => { await gw.close(); dsh.close() } }
}

// HTTPS client that, like the iOS app, accepts the self-signed cert only if its SHA-256 matches the pinned fingerprint.
function call(gw, method, path, body, headers = {}, pin = gw.fingerprint) {
  return new Promise((ok, bad) => {
    const req = request({ host: '127.0.0.1', port: gw.port, method, path, rejectUnauthorized: false, agent: false, headers: { 'content-type': 'application/json', ...headers } }, res => {
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
