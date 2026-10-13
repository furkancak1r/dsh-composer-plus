// Manual live check against a REAL running DSH + gateway (not part of npm test).
// Usage: start DSH with the plugin and node server.mjs, then:  node e2e.mjs
// Pairs a fake phone via the admin API, then drives allowlisted RPCs and a session/follow stream over pinned HTTPS/WSS.
import { request } from 'node:https'
import assert from 'node:assert/strict'
import { wsConnect, normFp } from './server.mjs'

const ADMIN = 'http://127.0.0.1:' + (process.env.DSH_MOBILE_ADMIN_PORT ?? 19391)
const admin = async (path, body) => (await fetch(ADMIN + path, body === undefined ? {} : { method: 'POST', headers: { 'x-dsh-admin': '1' }, body: JSON.stringify(body) })).json()
const sleep = ms => new Promise(r => setTimeout(r, ms))

const inv = JSON.parse((await admin('/pair', {})).code.payload)
const call = (method, path, body, token, pin = inv.fp, host = inv.host) => new Promise((ok, bad) => {
  const req = request({ host, port: inv.port, method, path, rejectUnauthorized: false, agent: false, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) } }, res => {
    let b = ''; res.on('data', d => b += d).on('end', () => ok({ status: res.statusCode, json: b ? JSON.parse(b) : null }))
  })
  req.on('socket', s => s.on('secureConnect', () => {
    if (normFp(s.getPeerCertificate().fingerprint256) !== normFp(pin)) req.destroy(new Error('certificate pin mismatch'))
    else req.end(body === undefined ? undefined : JSON.stringify(body))
  }))
  req.on('error', bad)
  req.setTimeout(10000, () => req.destroy(new Error('timeout ' + method + ' ' + path + ' @' + host)))
})
const results = []
// print as we go: a slow live step (the model turn) otherwise looks like a hang
const check = async (name, fn) => { try { const v = await fn(); results.push(['PASS', name, v ?? '']) } catch (e) { results.push(['FAIL', name, e.message]) } console.log(results.at(-1).join('  ')) }

// MITM: a wrong pin must abort before the request body is sent.
await check('wrong pin rejected', async () => { await assert.rejects(call('GET', '/me', undefined, undefined, '00'.repeat(32)), /pin mismatch/) })

const pairing = call('POST', '/pair', { code: inv.code, name: 'E2E iPhone' })
let pend
for (let i = 0; i < 50 && !pend; i++) { pend = (await admin('/state')).pending[0]; if (!pend) await sleep(100) }
await admin('/approve', { id: pend.id })
const { json: dev } = await pairing
const token = dev.token
await check('pairing approved, 256-bit token', () => { assert.match(token, /^[A-Za-z0-9_-]{43}$/) })
await check('replayed pairing code rejected', async () => { assert.equal((await call('POST', '/pair', { code: inv.code })).status, 403) })

let me
for (let i = 0; i < 50; i++) { me = (await call('GET', '/me', undefined, token)).json; if (me.upstream === 'connected') break; await sleep(200) }
await check('upstream connected to real DSH', () => { assert.equal(me.upstream, 'connected'); return me.upstream })
if (inv.ts) await check('/me over Tailscale', async () => { assert.equal((await call('GET', '/me', undefined, token, inv.fp, inv.ts)).status, 200); return inv.ts })
else results.push(['SKIP', '/me over Tailscale', 'Tailscale offline on this Mac'])
if (inv.ts) await check('WSS over Tailscale', async () => { (await wsConnect('wss://' + inv.ts + ':' + inv.port + '/api/remote.mux', { authorization: 'Bearer ' + token }, { rejectUnauthorized: false })).close() })

const rpc = async (method, args = {}) => {
  const r = await call('POST', '/api/' + method, { type: 'client-request', rpcId: 'e2e-' + Math.random(), method, payload: { args } }, token)
  assert.equal(r.status, 200, method + ' HTTP ' + r.status + ' ' + JSON.stringify(r.json))
  assert.equal(r.json.result?.ok, true, method + ' ' + JSON.stringify(r.json.result?.error))
  return r.json.result.value
}
const short = v => String(JSON.stringify(v) ?? 'none').slice(0, 100)
let sid, receipt
// the phone reads only the first page; flag the day DSH starts paging this list
await check('session/list', async () => { const l = await rpc('session/list', { _request: {} }); assert.ok(!l.cursor && !l.nextCursor, 'session/list now pages: follow the cursor in Client.loadSessions'); return l.items.length + ' sessions' })
// Client.loadSessions reads late questions from projections.values.userQuestions
await check('session/list userQuestions projection', async () => { const s = (await rpc('session/list', { _request: {} })).items[0]; const q = s.projections.values.userQuestions; assert.ok(Array.isArray((q?.val ?? q)?.active), 'parseQuestions shape changed: ' + short(q)); return short(q) })
await check('session/create', async () => { sid = (await rpc('session/create', { request: { cwd: '/tmp' } })).sessionId; assert.ok(sid); return sid })
await check('session/rename', async () => { await rpc('session/rename', { request: { sessionId: sid, title: 'E2E mobile' } }) })
await check('rename visible in list', async () => { const s = (await rpc('session/list', { _request: {} })).items.find(s => s.sessionId === sid); assert.ok(JSON.stringify(s).includes('E2E mobile')) })
await check('goals/get', async () => short(await rpc('goals/get', { agentId: sid })))
// Client.prompt's file path: upload first, then the receipt rides in the prompt as {type:'file', receiptId}
await check('fileUploads/upload', async () => {
  const r = await rpc('fileUploads/upload', { agentId: sid, request: { data: Buffer.from('hello').toString('base64'), name: 'e2e.txt' } })
  assert.ok(r.receiptId); assert.equal(r.file.bytes, 5); receipt = r.receiptId; return r.file.name
})
// the phone's goal flow on the temp session: create -> edit objective (same shapes as Client.createGoal/editGoal) -> clear
await check('goals create/edit/clear', async () => {
  await rpc('goals/create', { agentId: sid, request: { objective: 'e2e A' } })
  const g = await rpc('goals/get', { agentId: sid })
  const e = await rpc('goals/edit', { agentId: sid, ref: { id: g.id, revision: g.revision }, request: { objective: 'e2e B' } })
  assert.equal(e.objective, 'e2e B')
  // Sess.goal reads projections.values.goal ({val:}?{goal:{id,revision,phase}, roundsStarted}); the row badge depends on it
  let pv
  for (let i = 0; i < 20 && !pv; i++) { const s = (await rpc('session/list', { _request: {} })).items.find(s => s.sessionId === sid); const v = s?.projections?.values?.goal; pv = (v?.val ?? v)?.goal; if (!pv) await sleep(150) }
  assert.ok(pv?.id && typeof pv.phase === 'string', 'goal projection shape changed: ' + short(pv))
  await rpc('goals/clear', { agentId: sid, ref: { id: e.id, revision: e.revision } })
  return 'projection phase=' + pv.phase
})
// Client.loadAgents reads presets[].{id,isDefault} (name is optional, falls back to id)
await check('agentPresets/list', async () => { const p = (await rpc('agentPresets/list')).presets; assert.ok(Array.isArray(p) && p.every(x => x.id) && p.filter(x => x.isDefault).length === 1, 'preset shape changed: ' + short(p)); return p.map(x => x.id + (x.isDefault ? '*' : '')).join(', ') })
// Client.image's thumbnail fetch: allowlisted (200, not 403) and DSH answers with a structured error for an unknown id
await check('session/attachment reachable', async () => {
  const r = await call('POST', '/api/session/attachment', { type: 'client-request', rpcId: 'e2e-att', method: 'session/attachment', payload: { args: { request: { sessionId: sid, attachmentId: 'nope' } } } }, token)
  assert.equal(r.status, 200); assert.equal(r.json.result?.ok, false); return short(r.json.result?.error)
})
await check('session/modelCatalog', async () => short(await rpc('session/modelCatalog')))
await check('non-allowlisted method -> 403', async () => { assert.equal((await call('POST', '/api/host/shutdown', { type: 'client-request', rpcId: 'x', method: 'host/shutdown', payload: { args: {} } }, token)).status, 403) })

await check('WSS session/follow', async () => {
  const ws = await wsConnect('wss://' + inv.host + ':' + inv.port + '/api/remote.mux', { authorization: 'Bearer ' + token }, { rejectUnauthorized: false })
  const frames = []; ws.onText = t => frames.push(JSON.parse(t))
  ws.send(JSON.stringify({ type: 'open', streamId: 'f1', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: sid }, assistantStream: true } } } }))
  for (let i = 0; i < 50 && !frames.some(f => f.streamId === 'f1'); i++) await sleep(100)
  ws.close()
  const f = frames.find(f => f.streamId === 'f1')
  assert.equal(f?.type, 'item', JSON.stringify(f)); return f.value?.type
})

// Real model turn: this is what caught REQUEST_EXTENSION (plugin package.json without a version).
// Older history: snapshot is a window (hasMore); session/page with beforeSeq = first snapshot seq returns earlier events.
await check('session/page older history', async () => {
  const items = (await rpc('session/list', { _request: {} })).items
  const ws = await wsConnect('wss://' + inv.host + ':' + inv.port + '/api/remote.mux', { authorization: 'Bearer ' + token }, { rejectUnauthorized: false })
  let snap; ws.onText = t => { const f = JSON.parse(t); if (f.value?.type === 'snapshot') snap ??= f.value }
  let most = 0
  // shortcut: scans only the 10 newest sessions (each waits up to 5s), widen if no truncated snapshot shows up
  const scan = items.slice(0, 10)
  for (const s of scan) {
    snap = undefined
    ws.send(JSON.stringify({ type: 'open', streamId: 'p' + s.sessionId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: s.sessionId } } } } }))
    for (let i = 0; i < 50 && !snap; i++) await sleep(100)
    most = Math.max(most, snap?.records.length ?? 0)
    if (snap?.hasMore) break
  }
  ws.close()
  if (!snap?.hasMore) return 'no truncated snapshot in ' + scan.length + ' sessions (max ' + most + ' records)'
  const first = snap.records[0].event.seq, last = snap.records.at(-1).event.seq
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: snap.header?.sessionId }, throughSeq: last, beforeSeq: first, maxMessages: 40 } })
  assert.ok(page.records.length > 0 && page.records.at(-1).event.seq < first, short(page))
  return page.records.length + ' older records, hasMore=' + page.hasMore + ', header: ' + short(snap.header)
})

await check('prompt gets an assistant reply', async () => {
  const ws = await wsConnect('wss://' + inv.host + ':' + inv.port + '/api/remote.mux', { authorization: 'Bearer ' + token }, { rejectUnauthorized: false })
  let end
  ws.onText = t => { const e = JSON.parse(t).value?.event; if (e?.type === 'assistant/message' || e?.type === 'turn/end') end ??= e }
  ws.send(JSON.stringify({ type: 'open', streamId: 'f2', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: sid } } } } }))
  await sleep(500)
  const file = receipt ? [{ type: 'file', receiptId: receipt }] : []
  await rpc('session/prompt', { request: { requestId: 'e2e-' + Date.now(), sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Sadece "ok" yaz.' }, ...file] } })
  for (let i = 0; i < 600 && !end; i++) await sleep(100)
  ws.close()
  assert.equal(end?.type, 'assistant/message', JSON.stringify(end?.data ?? 'timeout'))
})

await check('revoke kills token', async () => {
  // keep the user's DSH session list clean: archive what session/create made (archived, not deleted)
  if (sid) await rpc('workspace/archiveSession', { request: { sessionId: sid, stopActivity: true } }).catch(() => {})
  await admin('/revoke', { id: dev.deviceId })
  assert.equal((await call('GET', '/me', undefined, token)).status, 401)
})

process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0)
