#!/usr/bin/env node
// DSH Mobile gateway: LAN-only HTTPS/WSS front door for the DeepSeek Harness host running on this Mac.
// Phones talk to this process; it talks to DSH on 127.0.0.1 with the host's own auth cookie.
import { createServer as createHttps, request as httpsRequest } from 'node:https'
import { createServer as createHttp, request as httpRequest } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN_TTL = 30 * 864e5
const MAX_BODY = 16 << 20

// Allowlisted DSH remote methods. Everything else is 403.
export const RPC = new Set([
  'session/list', 'session/page', 'session/create', 'session/rename', 'session/prompt', 'session/cancel',
  'session/fork', 'session/search', 'session/selectModel', 'session/updateQueue', 'session/attachment',
  'session/projections', 'session/modelCatalog',
  'workspace/archiveSession', 'workspace/unarchiveSession', 'workspace/pinSession', 'workspace/unpinSession',
  'goals/get', 'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear',
  'subagents/prompt', 'subagents/interruptByParent', 'userQuestions/answer',
  'agentPresets/list', 'agentPresets/select', 'permissionPresets/catalog', 'fileUploads/upload',
  'skills/list', 'commands/list', 'commands/execute',
])
export const STREAMS = new Set(['session/follow', 'session/control', 'workspace/follow', 'userQuestions/attachWait'])
export const EVENTS = new Set([
  'agent-preset/selected', 'approval/request', 'api-session/activity', 'api-session/added', 'api-session/error',
  'api-session/removed', 'api-session/status', 'commands/change', 'goal/activation-changed',
  'permission-presets/catalog-changed', 'user-questions/request',
])

const sha = s => createHash('sha256').update(s).digest('hex')
const safeEq = (a, b) => timingSafeEqual(Buffer.from(sha(a), 'hex'), Buffer.from(sha(b), 'hex'))
const ip4 = s => s.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0
export const inSubnet = (ip, address, netmask) => {
  ip = String(ip).replace(/^::ffff:/, '')
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false
  const m = ip4(netmask)
  return ((ip4(ip) & m) >>> 0) === ((ip4(address) & m) >>> 0)
}
export const normFp = s => String(s).replace(/[^0-9a-f]/gi, '').toLowerCase()

function reply(res, status, obj) {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}
function readBody(req, max) {
  return new Promise((ok, bad) => {
    const parts = []; let n = 0
    req.on('data', d => { n += d.length; if (n > max) { bad(new Error('body too large')); req.destroy() } else parts.push(d) })
    req.on('end', () => ok(Buffer.concat(parts).toString()))
    req.on('error', bad)
  })
}

// ---- Minimal RFC 6455 framing: text, ping/pong, close. Binary frames close with 1003. Clients mask. ----
export function wsWrap(socket, client, head = Buffer.alloc(0), maxBytes = MAX_BODY) {
  let buf = head, frags = [], fragBytes = 0, closed = false
  const w = { socket, onText() {}, onClose() {}, lastSeen: Date.now() }
  const frame = (op, data = Buffer.alloc(0)) => {
    if (socket.destroyed) return
    const len = data.length, m = client ? 0x80 : 0, parts = []
    if (len < 126) parts.push(Buffer.from([0x80 | op, m | len]))
    else if (len < 65536) parts.push(Buffer.from([0x80 | op, m | 126, len >> 8, len & 255]))
    else { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = m | 127; h.writeBigUInt64BE(BigInt(len), 2); parts.push(h) }
    if (client) {
      const key = randomBytes(4); data = Buffer.from(data)
      for (let i = 0; i < len; i++) data[i] ^= key[i & 3]
      parts.push(key)
    }
    parts.push(data)
    socket.write(Buffer.concat(parts))
  }
  w.send = text => { if (!closed) frame(1, Buffer.from(text)) }
  w.ping = () => { if (!closed) frame(9) }
  w.close = (code = 1000) => {
    if (closed) return
    closed = true
    const b = Buffer.alloc(2); b.writeUInt16BE(code); frame(8, b)
    socket.end()
    setTimeout(() => socket.destroy(), 1000).unref()
  }
  const parse = () => {
    while (buf.length >= 2 && !closed) {
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80
      let len = buf[1] & 127, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(maxBytes)) return w.close(1009)
        len = Number(big); off = 10
      }
      if (len > maxBytes) return w.close(1009)
      if (!masked === !client) return w.close(1002) // server frames unmasked, client frames masked
      const keyOff = off
      if (masked) off += 4
      if (buf.length < off + len) return
      let data = buf.subarray(off, off + len)
      if (masked) { data = Buffer.from(data); for (let i = 0; i < len; i++) data[i] ^= buf[keyOff + (i & 3)] }
      buf = buf.subarray(off + len)
      if (op === 8) return w.close()
      if (op === 9) { frame(10, data); continue }
      if (op === 10) continue
      if (op !== 1 && op !== 0) return w.close(1003)
      if (op === 0 && !frags.length) return w.close(1002)
      frags.push(data); fragBytes += len
      if (fragBytes > maxBytes) return w.close(1009)
      if (fin) { const text = Buffer.concat(frags).toString(); frags = []; fragBytes = 0; w.onText(text) }
    }
  }
  socket.on('data', d => { w.lastSeen = Date.now(); buf = buf.length ? Buffer.concat([buf, d]) : d; parse() })
  socket.on('close', () => { closed = true; w.onClose() })
  socket.on('error', () => {})
  if (buf.length) queueMicrotask(parse)
  return w
}
export function acceptWs(req, socket, head) {
  const key = req.headers['sec-websocket-key']
  if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) { socket.destroy(); return }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  return wsWrap(socket, false, head)
}
export function wsConnect(url, headers = {}, tls = {}) {
  return new Promise((ok, bad) => {
    const u = new URL(url), secure = u.protocol === 'wss:'
    u.protocol = secure ? 'https:' : 'http:'
    const req = (secure ? httpsRequest : httpRequest)(u, {
      ...tls, agent: false,
      headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') },
    })
    req.on('upgrade', (res, socket, head) => ok(wsWrap(socket, true, head)))
    req.on('response', res => { res.resume(); bad(Object.assign(new Error('websocket upgrade failed: ' + res.statusCode), { status: res.statusCode })) })
    req.on('error', bad)
    req.end()
  })
}

// ---- Upstream: the DSH host on loopback, authenticated with the URL the dsh-mobile-bridge plugin writes. ----
function send(method, url, body, headers = {}) {
  return new Promise((ok, bad) => {
    const r = httpRequest(url, { method, headers, agent: false }, res => {
      const parts = []
      res.on('data', d => parts.push(d))
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
      res.on('error', bad)
    })
    r.on('error', bad)
    r.end(body)
  })
}
function makeUpstream(file) {
  let base, cookie
  async function login() {
    const raw = readFileSync(file, 'utf8').trim()
    const u = new URL(raw)
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('upstream must be loopback http')
    const res = await send('GET', raw) // 303 + cookie; never follow the redirect
    const c = [res.headers['set-cookie'] ?? []].flat().map(s => s.split(';')[0]).filter(s => s.startsWith('dsh-auth'))
    if (!c.length) throw new Error('DSH login failed (' + res.status + ')')
    base = u.origin; cookie = c.join('; ')
  }
  async function retry(fn) {
    if (!cookie) await login()
    try { return await fn() } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e
      await login(); return fn()
    }
  }
  return {
    rpc: (path, body) => retry(async () => {
      const r = await send('POST', base + path, body, { 'content-type': 'application/json', cookie })
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('upstream auth'), { status: r.status })
      return r
    }),
    mux: () => retry(() => wsConnect(base.replace(/^http/, 'ws') + '/api/remote.mux', { cookie })),
  }
}

// ---- Gateway ----
export function createGateway(opts = {}) {
  const dir = opts.dir ?? process.env.DSH_MOBILE_DIR ?? join(homedir(), '.dsh-mobile')
  const iface = opts.iface ?? process.env.DSH_MOBILE_IFACE ?? 'en0'
  const netInfo = opts.netInfo ?? (() => {
    const a = (networkInterfaces()[iface] ?? []).find(i => i.family === 'IPv4' && !i.internal)
    return a && { address: a.address, netmask: a.netmask }
  })
  const codeTtl = opts.codeTtlMs ?? 5 * 60e3
  const waterfallTtl = opts.waterfallTimeoutMs ?? 10 * 60e3
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const upstream = makeUpstream(opts.upstreamFile ?? join(dir, 'upstream.url'))
  const devFile = join(dir, 'devices.json')
  let devices = existsSync(devFile) ? JSON.parse(readFileSync(devFile, 'utf8')) : []
  const saveDevices = () => writeFileSync(devFile, JSON.stringify(devices, null, 2), { mode: 0o600 })

  let server, bound, port = opts.port ?? Number(process.env.DSH_MOBILE_PORT ?? 19390), running = false, wanted = false
  let key, cert, fp, code = null, qrReady = false, bonjour, upState = 'disconnected', evTimer
  const conns = new Set(), devSockets = new Map(), pending = new Map()
  const reqHits = new Map(), fails = new Map()
  const evSubs = new Set(), pendingEv = new Map(), ev = { ws: null, clientId: null }

  // Rate limits. shortcut: fixed in-memory windows per IP, fine for one household LAN; persist/upgrade if exposed wider.
  const bump = (map, k, ms) => { const now = Date.now(), b = map.get(k); if (!b || now - b.t > ms) { map.set(k, { t: now, n: 1 }); return 1 } return ++b.n }
  const blocked = ip => { const b = fails.get(ip); return b && Date.now() - b.t < 60e3 && b.n >= 10 }
  const fail = ip => bump(fails, ip, 60e3)
  const allowReq = ip => !blocked(ip) && bump(reqHits, ip, 10e3) <= 300

  function ensureCert() {
    const k = join(dir, 'key.pem'), c = join(dir, 'cert.pem')
    if (!existsSync(k) || !existsSync(c)) {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', k, '-out', c, '-days', '825', '-subj', '/CN=DSH Mobile Gateway'], { stdio: 'ignore' })
      chmodSync(k, 0o600)
    }
    key = readFileSync(k); cert = readFileSync(c)
    fp = normFp(new X509Certificate(cert).fingerprint256)
  }

  function auth(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')
    const d = m && devices.find(d => d.tokenHash === sha(m[1]))
    return d && Date.parse(d.expiresAt) > Date.now() ? d : undefined
  }
  function track(id, socket) {
    let s = devSockets.get(id)
    if (!s) devSockets.set(id, s = new Set())
    if (s.has(socket)) return
    s.add(socket); socket.once('close', () => s.delete(socket))
  }
  function revoke(id) {
    const before = devices.length
    devices = devices.filter(d => d.id !== id)
    if (devices.length !== before) saveDevices()
    for (const s of devSockets.get(id) ?? []) s.destroy()
    devSockets.delete(id)
    return devices.length !== before
  }
  function notify(msg) {
    if (opts.notify === false) return
    const safe = msg.replace(/[^\w .:'-]/g, '')
    spawn('osascript', ['-e', 'display notification "' + safe + '" with title "DSH Mobile"'], { stdio: 'ignore' }).on('error', () => {})
  }

  // ---- Pairing: one-time code (5 min) shown as QR, then explicit approval on the Mac. ----
  function newCode() {
    const net = bound ?? netInfo()
    code = { value: randomBytes(16).toString('base64url'), expires: Date.now() + codeTtl }
    code.payload = JSON.stringify({ v: 1, host: net?.address, port, fp, code: code.value })
    qrReady = false
    if (opts.qr !== false) {
      const c = code
      const { SDKROOT, ...env } = process.env // a stale SDKROOT (e.g. Command Line Tools) breaks the swift script; let xcrun pick the SDK
      spawn('swift', [join(HERE, 'qr.swift'), c.payload, join(dir, 'qr.png')], { stdio: 'ignore', env })
        .on('exit', s => { if (s === 0 && code === c) qrReady = true }).on('error', () => {})
    }
    return code
  }
  async function pair(req, res, ip) {
    let b
    try { b = JSON.parse(await readBody(req, 4096)) } catch { return reply(res, 400, { error: 'bad request' }) }
    const ok = code && typeof b?.code === 'string' && Date.now() < code.expires && safeEq(b.code, code.value)
    if (!ok) { fail(ip); return reply(res, 403, { error: 'invalid or expired pairing code' }) }
    code = null // one-time: a replayed code is rejected
    const p = { id: randomUUID(), name: String(b.name ?? 'iPhone').replace(/[\u0000-\u001f]/g, '').slice(0, 64) || 'iPhone', ip, at: Date.now(), res }
    pending.set(p.id, p)
    notify('Pairing request from ' + p.name)
    const t = setTimeout(() => settle(p.id, false), 120e3)
    res.on('close', () => { clearTimeout(t); pending.delete(p.id) })
  }
  function settle(id, approve) {
    const p = pending.get(id)
    if (!p) return false
    pending.delete(id)
    if (!approve) { reply(p.res, 403, { error: 'pairing denied' }); return true }
    const token = randomBytes(32).toString('base64url') // 256-bit; only its hash is stored
    const d = { id: randomUUID(), name: p.name, tokenHash: sha(token), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TOKEN_TTL).toISOString() }
    devices.push(d); saveDevices()
    reply(p.res, 200, { token, deviceId: d.id, name: d.name, expiresAt: d.expiresAt })
    return true
  }

  // ---- Forwarded events: one upstream $events stream shared by all phones. ----
  const toPhones = frame => { for (const s of evSubs) s.ws.send(JSON.stringify({ type: 'item', streamId: s.streamId, value: frame })) }
  const answer = (eventId, outcome) => upstream.rpc('/api/$events/result', JSON.stringify({
    type: 'client-request', rpcId: randomUUID(), method: '$events/result',
    payload: { args: { clientId: ev.clientId, eventId, outcome } },
  }))
  const dropPending = (id, outcome) => {
    const p = pendingEv.get(id)
    if (!p) return false
    clearTimeout(p.timer); pendingEv.delete(id)
    if (outcome) answer(id, outcome).catch(() => {})
    return true
  }
  function onEventFrame(text) {
    let f
    try { f = JSON.parse(text) } catch { return }
    if (f.streamId !== 'events') return
    if (f.type !== 'item') { ev.ws?.close(); return }
    const v = f.value ?? {}
    if (v.type === 'ready') { ev.clientId = v.clientId; upState = 'connected'; return } // host.home is dropped here
    if (v.type === 'emit' && EVENTS.has(v.event)) return toPhones({ type: 'emit', event: v.event, args: v.args })
    if (v.type === 'cancel' && dropPending(v.eventId)) return toPhones({ type: 'cancel', eventId: v.eventId })
    if (v.type !== 'waterfall') return
    if (!EVENTS.has(v.event) || !evSubs.size) return answer(v.eventId, { kind: 'next' }).catch(() => {})
    const frame = { type: 'waterfall', event: v.event, eventId: v.eventId, agentId: v.agentId, request: v.request }
    // shortcut: unanswered phone prompts fall back to 'next' (DSH desktop still decides) after a fixed timeout; make it configurable per event if users want longer.
    const timer = setTimeout(() => { if (dropPending(v.eventId, { kind: 'next' })) toPhones({ type: 'cancel', eventId: v.eventId }) }, waterfallTtl)
    pendingEv.set(v.eventId, { frame, timer })
    toPhones(frame)
  }
  function connectEvents() {
    if (!running) return
    upstream.mux().then(u => {
      if (!running) return u.close()
      ev.ws = u
      u.onText = onEventFrame
      u.onClose = () => {
        ev.ws = null; ev.clientId = null; upState = 'disconnected'
        for (const id of [...pendingEv.keys()]) { dropPending(id); toPhones({ type: 'cancel', eventId: id }) }
        if (running) evTimer = setTimeout(connectEvents, 3000)
      }
      u.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
    }, e => {
      upState = e.code === 'ENOENT' ? 'waiting for dsh-mobile-bridge plugin' : 'unavailable: ' + e.message
      if (running) evTimer = setTimeout(connectEvents, 3000)
    })
  }
  async function eventResult(body, res) {
    const a = body.payload?.args, o = a?.outcome
    const outcome = o?.kind === 'next' ? { kind: 'next' }
      : o?.kind === 'result' ? (Object.hasOwn(o, 'value') ? { kind: 'result', value: o.value } : { kind: 'result' })
      : o?.kind === 'rejected' ? { kind: 'rejected', error: o.error } : null
    if (!outcome || typeof a?.eventId !== 'string' || !dropPending(a.eventId)) {
      return reply(res, 200, { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'mobile/event-not-pending', message: 'event is not pending' } } })
    }
    toPhones({ type: 'cancel', eventId: a.eventId }) // first answer wins; other phones drop the prompt
    try {
      const up = await answer(a.eventId, outcome)
      res.writeHead(up.status, { 'content-type': up.headers['content-type'] ?? 'application/json' }); res.end(up.body)
    } catch { reply(res, 502, { error: 'DSH host unavailable' }) }
  }

  // ---- Phone-facing HTTPS ----
  async function onRequest(req, res) {
    const ip = req.socket.remoteAddress
    if (!allowReq(ip)) return reply(res, 429, { error: 'rate limited' })
    const path = new URL(req.url, 'https://x').pathname
    if (req.method === 'POST' && path === '/pair') return pair(req, res, ip)
    const dev = auth(req)
    if (!dev) { fail(ip); return reply(res, 401, { error: 'unauthorized' }) }
    track(dev.id, req.socket)
    if (req.method === 'GET' && path === '/me') return reply(res, 200, { deviceId: dev.id, name: dev.name, expiresAt: dev.expiresAt, upstream: upState })
    if (req.method !== 'POST' || !path.startsWith('/api/')) return reply(res, 404, { error: 'not found' })
    const method = path.slice(5)
    let body
    try { body = JSON.parse(await readBody(req, MAX_BODY)) } catch { return reply(res, 400, { error: 'bad request' }) }
    if (body?.type !== 'client-request' || body.method !== method || typeof body.rpcId !== 'string') return reply(res, 400, { error: 'bad request' })
    if (method === '$events/result') return eventResult(body, res)
    if (!RPC.has(method)) return reply(res, 403, { error: 'endpoint not allowed' })
    try {
      const up = await upstream.rpc('/api/' + method, JSON.stringify(body))
      res.writeHead(up.status, { 'content-type': up.headers['content-type'] ?? 'application/json' }); res.end(up.body)
    } catch { reply(res, 502, { error: 'DSH host unavailable' }) }
  }
  function onUpgrade(req, socket, head) {
    const ip = socket.remoteAddress
    if (!allowReq(ip)) return socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
    if (new URL(req.url, 'https://x').pathname !== '/api/remote.mux') return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    const dev = auth(req)
    if (!dev) { fail(ip); return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n') }
    const ws = acceptWs(req, socket, head)
    if (!ws) return
    track(dev.id, socket)
    phoneMux(ws)
  }
  const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 128
  const keys = (f, ...k) => { const o = Object.keys(f); return o.length === k.length && k.every(x => Object.hasOwn(f, x)) }
  const validFrame = f => f && typeof f === 'object' && isId(f.streamId) && (
    (f.type === 'open' && keys(f, 'type', 'streamId', 'endpoint', 'payload') && typeof f.endpoint === 'string') ||
    (f.type === 'item' && (keys(f, 'type', 'streamId') || keys(f, 'type', 'streamId', 'value'))) ||
    ((f.type === 'end' || f.type === 'cancel') && keys(f, 'type', 'streamId')))
  function phoneMux(ws) {
    const mine = new Set(), subs = new Map()
    let upP, up
    const getUp = () => upP ??= upstream.mux().then(u => { up = u; u.onText = t => ws.send(t); u.onClose = () => ws.close(1011); return u })
    const err = (streamId, message) => ws.send(JSON.stringify({ type: 'error', streamId, error: { code: 'mobile/forbidden', message } }))
    const unsub = id => { const s = subs.get(id); if (!s) return; subs.delete(id); evSubs.delete(s); if (!evSubs.size) for (const e of [...pendingEv.keys()]) dropPending(e, { kind: 'next' }) }
    ws.onText = async text => {
      let f
      try { f = JSON.parse(text) } catch { return ws.close(1007) }
      if (!validFrame(f)) return ws.close(1008)
      if (f.type === 'open') {
        if (mine.has(f.streamId)) return ws.close(1008)
        if (mine.size >= 64) return err(f.streamId, 'too many streams')
        if (f.endpoint === '$events') {
          mine.add(f.streamId)
          const s = { ws, streamId: f.streamId }
          subs.set(f.streamId, s); evSubs.add(s)
          ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'ready', clientId: 'mobile' } }))
          for (const p of pendingEv.values()) ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: p.frame }))
          return
        }
        if (!STREAMS.has(f.endpoint)) return err(f.streamId, 'endpoint not allowed')
        mine.add(f.streamId)
      } else if (!mine.has(f.streamId)) return
      else if (subs.has(f.streamId)) { if (f.type !== 'item') { unsub(f.streamId); mine.delete(f.streamId) } return }
      try { (await getUp()).send(text) } catch { err(f.streamId, 'DSH host unavailable') }
    }
    ws.onClose = () => { for (const id of [...subs.keys()]) unsub(id); up?.close(); if (!up) upP?.then(u => u.close(), () => {}) }
  }

  async function start() {
    wanted = true
    if (running) return
    const net = netInfo()
    if (!net) throw new Error('no IPv4 address on ' + iface + ' (Wi-Fi off?)')
    ensureCert()
    const s = createHttps({ key, cert, minVersion: 'TLSv1.2' }, onRequest)
    s.on('connection', sock => {
      if (!inSubnet(sock.remoteAddress, net.address, net.netmask)) return sock.destroy() // LAN-only
      conns.add(sock); sock.once('close', () => conns.delete(sock))
    })
    s.on('upgrade', onUpgrade)
    s.on('tlsClientError', (_, sock) => sock.destroy())
    await new Promise((ok, bad) => { s.once('error', bad); s.listen(port, net.bind ?? net.address, ok) })
    server = s; bound = net; port = s.address().port; running = true
    if (opts.bonjour !== false) {
      bonjour = spawn('dns-sd', ['-R', 'DSH Mobile', '_dshmobile._tcp', 'local', String(port), 'fp=' + fp], { stdio: 'ignore' })
      bonjour.on('error', () => {})
    }
    connectEvents()
  }
  async function stop(keepWanted = false) {
    wanted = keepWanted
    if (!running) return
    running = false
    clearTimeout(evTimer)
    bonjour?.kill(); bonjour = null
    ev.ws?.close()
    for (const sock of conns) sock.destroy()
    await new Promise(ok => server.close(ok))
    server = null; bound = null; upState = 'disconnected'
  }
  // Network watch: rebind (and drop every connection) whenever the Wi-Fi address changes; also expire tokens.
  const watch = setInterval(async () => {
    for (const d of devices) if (Date.parse(d.expiresAt) <= Date.now()) revoke(d.id)
    const now = Date.now()
    for (const m of [reqHits, fails]) for (const [k, b] of m) if (now - b.t > 60e3) m.delete(k)
    for (const set of devSockets.values()) for (const s of set) if (s.destroyed) set.delete(s)
    const n = netInfo()
    if (running && (!n || n.address !== bound.address || n.netmask !== bound.netmask)) await stop(true).catch(() => {})
    if (wanted && !running && n) await start().catch(() => {})
  }, opts.watchMs ?? 5000)
  watch.unref()

  const state = () => ({
    running, address: bound?.address ?? netInfo()?.address ?? null, port, tls: running ? 'TLS 1.2+, self-signed' : 'off',
    fingerprint: fp ?? null, upstream: upState,
    code: code && Date.now() < code.expires ? { payload: code.payload, expiresAt: new Date(code.expires).toISOString(), qr: qrReady } : null,
    pending: [...pending.values()].map(({ id, name, ip, at }) => ({ id, name, ip, at })),
    devices: devices.map(({ tokenHash, ...d }) => ({ ...d, connections: devSockets.get(d.id)?.size ?? 0 })),
  })

  // ---- Mac admin page: loopback only, plain HTTP. ----
  let adminServer
  async function onAdmin(req, res) {
    const a = adminServer.address().port
    if (req.headers.host !== '127.0.0.1:' + a && req.headers.host !== 'localhost:' + a) return reply(res, 403, { error: 'bad host' }) // DNS-rebinding guard
    const path = new URL(req.url, 'http://x').pathname
    if (req.method === 'GET' && path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'admin.html'))) }
    if (req.method === 'GET' && path === '/state') return reply(res, 200, state())
    if (req.method === 'GET' && path === '/qr.png' && qrReady) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(readFileSync(join(dir, 'qr.png'))) }
    // Custom header forces a CORS preflight we never grant, so other web pages cannot drive these.
    if (req.method !== 'POST' || req.headers['x-dsh-admin'] !== '1') return reply(res, 404, { error: 'not found' })
    let b = {}
    try { b = JSON.parse((await readBody(req, 4096)) || '{}') } catch { return reply(res, 400, { error: 'bad request' }) }
    try {
      if (path === '/pair') { if (!running) await start(); newCode() }
      else if (path === '/approve') settle(b.id, true)
      else if (path === '/deny') settle(b.id, false)
      else if (path === '/revoke') revoke(b.id)
      else if (path === '/start') await start()
      else if (path === '/stop') await stop()
      else return reply(res, 404, { error: 'not found' })
      reply(res, 200, state())
    } catch (e) { reply(res, 500, { error: e.message }) }
  }
  function listenAdmin(p = opts.adminPort ?? 19391) {
    adminServer = createHttp(onAdmin)
    return new Promise((ok, bad) => { adminServer.once('error', bad); adminServer.listen(p, '127.0.0.1', () => ok(adminServer.address().port)) })
  }
  async function close() { clearInterval(watch); await stop(); for (const p of pending.values()) p.res.destroy(); adminServer?.close() }

  return { start, stop, close, state, newCode, settle, revoke, listenAdmin, get port() { return port }, get fingerprint() { return fp } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gw = createGateway()
  const adminPort = await gw.listenAdmin()
  console.log('DSH Mobile admin: http://127.0.0.1:' + adminPort + '/')
  try { await gw.start(); console.log('Gateway listening on https://' + gw.state().address + ':' + gw.port) } catch (e) { console.error('Gateway not started:', e.message) }
  const quit = () => gw.close().then(() => process.exit(0))
  process.on('SIGINT', quit); process.on('SIGTERM', quit)
}
