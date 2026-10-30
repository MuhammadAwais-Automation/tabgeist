import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { approvePairing, bridgeEvents, pendingPairings, PINNED_IDS } from '../bridge/bridge'
import type { RunningDaemon } from './server'

// A real daemon on a spare port with its own home folder: the HTTP and WebSocket
// doors exactly as the extension, agents and the control room meet them.
process.env.TABGEIST_HOME = mkdtempSync(join(tmpdir(), 'tabgeist-daemon-'))
const port = 47_000 + Math.floor(Math.random() * 800)
let d: RunningDaemon

function http(path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, unknown>, body }))
    })
    req.on('error', reject)
    if (o.body) req.write(o.body)
    req.end()
  })
}

beforeAll(async () => {
  const { createDaemon } = await import('../main')
  d = await createDaemon({ port, canaryCheckMs: 3_600_000 })
})
afterAll(async () => { await d?.close() })

describe('the daemon doors', () => {
  it('answers health, refuses other hosts (DNS rebinding)', async () => {
    expect(JSON.parse((await http('/health')).body)).toMatchObject({ ok: true, port })
    expect((await http('/health', { headers: { Host: 'evil.com' } })).status).toBe(403)
  })

  it('agents need the token, and can never reach the user\'s methods', async () => {
    const call = (method: string, auth?: string) => http('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ method, params: {} }) })
    expect((await call('browser.status')).status).toBe(401)
    expect((await call('browser.status', 'Bearer nope')).status).toBe(401)
    const ok = await call('browser.status', `Bearer ${d.state.token}`)
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, connected: false })
    for (const m of ['approval.answer', 'pairing.approve', 'grants.clear', 'heal.apply', 'policy.save', 'room.state']) {
      expect(JSON.parse((await call(m, `Bearer ${d.state.token}`)).body).error, m).toMatch(/only be done by the user in the control room/)
    }
  })

  it('the control room: a one-time link gives a cookie; writes need its own origin', async () => {
    expect((await http('/api/rpc', { method: 'POST', body: '{"method":"room.state"}' })).status).toBe(401)
    const once = d.state.room.link()
    const login = await http(`/login?once=${once}`)
    expect(login.status).toBe(302)
    const cookie = String((login.headers['set-cookie'] as string[])[0]).split(';')[0]
    expect(cookie).toMatch(/^tabgeist_room=/)
    expect((await http(`/login?once=${once}`)).status).toBe(403)
    const body = '{"method":"room.state"}'
    expect((await http('/api/rpc', { method: 'POST', headers: { Cookie: cookie }, body })).status).toBe(403)
    expect((await http('/api/rpc', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.com' }, body })).status).toBe(403)
    const state = await http('/api/rpc', { method: 'POST', headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` }, body })
    expect(JSON.parse(state.body)).toMatchObject({ ok: true, approvals: [], pairings: [] })
  })
})

describe('pairing a browser', () => {
  const connect = (origin: string) => new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers: { Origin: origin } })
  const next = (ws: WebSocket, event: string) => new Promise<Record<string, unknown>>(resolve => {
    const on = (raw: WebSocket.RawData) => { const m = JSON.parse(raw.toString()); if (m.event === event) { ws.off('message', on); resolve(m) } }
    ws.on('message', on)
  })

  it('refuses anything but the pinned extension', async () => {
    const ws = connect('https://evil.com')
    await expect(new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })).rejects.toThrow(/403/)
  })

  it('a new browser waits with a code; once approved it keeps a token and comes back without asking', async () => {
    const origin = `chrome-extension://${PINNED_IDS[0]}`
    const ws = connect(origin)
    await new Promise(r => ws.on('open', r))
    const pairing = next(ws, 'pairing')
    ws.send(JSON.stringify({ type: 'hello', profile: 'Test profile', browser: 'Chrome', version: '0.1.0' }))
    const { code } = await pairing as { code: string }
    expect(code).toMatch(/^\d{6}$/)
    expect(pendingPairings().map(p => p.code)).toContain(code)
    // Before approval nothing it says is listened to.
    ws.send(JSON.stringify({ event: 'approval', approvalId: 'x', allow: true }))
    const paired = next(ws, 'paired')
    const welcome = next(ws, 'welcome')
    expect(approvePairing(code)).toMatchObject({ ok: true, label: 'Test profile' })
    const { pairToken } = await paired as { pairToken: string }
    await welcome
    ws.close()

    const again = connect(origin)
    await new Promise(r => again.on('open', r))
    const back = next(again, 'welcome')
    again.send(JSON.stringify({ type: 'hello', profile: 'Test profile', browser: 'Chrome', version: '0.1.0', pairToken }))
    await back
    expect(d.state.pairing.list().map(p => p.label)).toContain('Test profile')
    again.close()
  })

  it('a browser waiting for its code can ask for the control room, not much more often than every few seconds', async () => {
    // The daemon's own listener would open a real browser; count the asks instead.
    bridgeEvents.removeAllListeners('openRoom')
    let asks = 0
    bridgeEvents.on('openRoom', (e: { c?: unknown }) => { asks++; expect(e.c).toBeUndefined() })
    const ws = connect(`chrome-extension://${PINNED_IDS[0]}`)
    await new Promise(r => ws.on('open', r))
    const pairing = next(ws, 'pairing')
    ws.send(JSON.stringify({ type: 'hello', profile: 'Waiting profile', browser: 'Edge', version: '0.1.0' }))
    await pairing
    ws.send(JSON.stringify({ event: 'openRoom' }))
    ws.send(JSON.stringify({ event: 'openRoom' }))
    await new Promise(r => setTimeout(r, 200))
    expect(asks).toBe(1)
    ws.close()
  })
})
