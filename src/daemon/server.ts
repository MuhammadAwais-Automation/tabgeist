import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { BRAND, DEFAULT_PORT, envVar } from '../brand'
import { answerApproval, approvePairing, bridgeEvents, handleExtensionUpgrade, pendingApprovals, pendingPairings, pickBrowser, usePairing, type Connection } from '../bridge/bridge'
import { bearerOk, COOKIE, hostOk, originOk } from './auth'
import { daemonToken, paths, writeJson } from './home'
import { addMethods, dispatch } from './rpc'
import { createState, type DaemonState } from './state'
import type { Method } from './browser'

/**
 * The always-on local daemon: the extension's WebSocket, the agents' /rpc, and
 * the control room (a local web page with live events). Listens on 127.0.0.1 only.
 */

export interface DaemonOptions {
  port?: number
  /** e2e: test.* methods on. */
  test?: boolean
  /** e2e: pair every browser without asking. */
  autoPair?: boolean
  /** Folder with the built control room (index.html, app.js, app.css). */
  uiDir?: string
  /** Secret fog for everything shown or stored; installed by the safety module. */
  redact?: (s: string) => string
  /** Called once the state exists, before listening: other modules add methods here. */
  setup?: (d: DaemonState) => void | Promise<void>
}

export interface RunningDaemon { port: number; state: DaemonState; close(): Promise<void> }

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json' }
const MAX_BODY = 8 * 1024 * 1024

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new Error('request too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as Record<string, unknown> : {}
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Opens a URL with the system's default handler (no shell string building). */
export function openSystem(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try { spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref() } catch { /* nothing to open with */ }
}

export async function startDaemon(o: DaemonOptions = {}): Promise<RunningDaemon> {
  const port = o.port ?? (Number(envVar('PORT')) || DEFAULT_PORT)
  const token = daemonToken()
  const d = createState({ port, token, test: o.test })
  usePairing(d.pairing, { auto: o.autoPair })
  const uiDir = o.uiDir

  /** A one-time login link for the control room, opened in the paired browser (or the system's). */
  async function openRoom(c?: Connection): Promise<'browser' | 'system'> {
    const url = `http://127.0.0.1:${port}/login?once=${d.room.link()}`
    const target = c ?? (typeof pickBrowser() === 'string' ? undefined : pickBrowser() as Connection)
    if (target) {
      try { await target.request('tabs.open', { url, active: true, room: true }); return 'browser' } catch { /* fall back */ }
    }
    openSystem(url)
    return 'system'
  }
  bridgeEvents.on('openRoom', (e: { c?: Connection }) => { void openRoom(e.c) })

  const agentExtra: Record<string, Method> = {
    'room.open': async () => ({ ok: true, opened: await openRoom() }),
  }
  addMethods('agent', agentExtra)

  if (d.test) {
    const { testMethods } = await import('./testing')
    addMethods('room', testMethods({ answerApproval, pendingApprovals, pendingPairings, approvePairing, link: () => `http://127.0.0.1:${port}/login?once=${d.room.link()}` }))
  }
  await o.setup?.(d)

  const server = createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host, port)) { res.writeHead(403); res.end('wrong host'); return }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const path = url.pathname

      if (path === '/health') return json(res, 200, { ok: true, name: BRAND.name, version: BRAND.version, pid: process.pid, port })

      if (path === '/rpc' && req.method === 'POST') {
        if (!bearerOk(req.headers.authorization, token)) return json(res, 401, { ok: false, error: 'missing or wrong token' })
        const b = await body(req)
        // The e2e suite (TABGEIST_TEST=1 only) acts as the user too; real agents never can.
        const from = b.from === 'cli' ? 'cli' : d.test && b.from === 'test' ? 'test' : 'agent'
        const agent = typeof b.agent === 'string' && b.agent.trim() ? b.agent.trim().slice(0, 60) : from
        const session = typeof b.session === 'string' && b.session ? b.session.slice(0, 40) : `${agent}-${process.pid}`
        const test = d.test && typeof b.method === 'string' && b.method.startsWith('test.')
        return json(res, 200, await dispatch(d, String(b.method ?? ''), (b.params ?? {}) as Record<string, unknown>, { from: test ? 'test' : from, agent, session }))
      }

      if (path === '/login') {
        const session = d.room.redeem(url.searchParams.get('once'))
        if (!session) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`This link was used or expired. Run "${BRAND.slug} open" or use "Open control room" in the side panel.`); return }
        res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' })
        res.end()
        return
      }

      if (path.startsWith('/api/')) {
        if (!d.room.ok(req.headers.cookie)) return json(res, 401, { ok: false, error: 'signed out', signin: `${BRAND.slug} open` })
        if (path === '/api/events') return events(req, res, d)
        if (path === '/api/rpc' && req.method === 'POST') {
          if (!originOk(req.headers.origin, port)) return json(res, 403, { ok: false, error: 'wrong origin' })
          const b = await body(req)
          return json(res, 200, await dispatch(d, String(b.method ?? ''), (b.params ?? {}) as Record<string, unknown>, { from: 'room', agent: 'you', session: 'control-room' }))
        }
        return json(res, 404, { ok: false, error: 'no such api' })
      }

      if (path.startsWith('/shots/')) {
        if (!d.room.ok(req.headers.cookie)) { res.writeHead(401); res.end(); return }
        const name = path.slice(7)
        if (!/^[\w-]+\.jpg$/.test(name)) { res.writeHead(404); res.end(); return }
        const file = join(paths.shots(), name)
        if (!existsSync(file)) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
        res.end(readFileSync(file))
        return
      }

      // The control room's own files. They hold no data: every read goes through /api with the cookie.
      if (req.method === 'GET' && uiDir) {
        const rel = path === '/' ? 'index.html' : normalize(path.slice(1))
        const file = join(uiDir, rel)
        if (!rel.startsWith('..') && file.startsWith(uiDir) && existsSync(file) && statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" })
          res.end(readFileSync(file))
          return
        }
      }
      res.writeHead(404); res.end('not found')
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      else res.end()
    }
  })
  server.on('upgrade', (req, socket, head) => {
    if (!hostOk(req.headers.host, port) || !handleExtensionUpgrade(req, socket, head)) socket.destroy()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is taken (is ${BRAND.slug} already running? "${BRAND.slug} status")`) : e))
    server.listen(port, '127.0.0.1', () => resolve())
  })
  writeJson(paths.daemon(), { pid: process.pid, port, startedAt: Date.now(), version: BRAND.version })

  return {
    port,
    state: d,
    close: () => new Promise<void>(resolve => {
      try { rmSync(paths.daemon(), { force: true }) } catch { /* fine */ }
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/** Server-sent events for the control room: everything the bridge and the timeline announce. */
function events(req: IncomingMessage, res: ServerResponse, d: DaemonState): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const names = ['activity', 'approval', 'approvalDone', 'ask', 'askDone', 'pairing', 'pairingDone', 'connections', 'busy', 'routine', 'heal', 'health']
  const handlers = names.map(n => [n, (data: unknown) => send(n, data)] as const)
  for (const [n, h] of handlers) bridgeEvents.on(n, h)
  const onEntry = (e: unknown) => send('timeline', e)
  d.timeline.on('entry', onEntry)
  send('hello', { at: Date.now() })
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    for (const [n, h] of handlers) bridgeEvents.off(n, h)
    d.timeline.off('entry', onEntry)
  })
}
