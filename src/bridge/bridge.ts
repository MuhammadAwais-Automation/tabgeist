import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import { BRAND, envVar } from '../brand'
import { ChromeTab, type TabInfo } from './chromeTab'
import { pairingCode, type PairingStore } from './pairing'

/**
 * The link between the daemon and the extension in the user's Chrome or Edge.
 * The extension connects to ws://127.0.0.1:<port>/extension; only our pinned
 * extension id may (web pages cannot set a chrome-extension:// Origin), and
 * with pairing on, only a browser the user approved (see pairing.ts).
 * One connection per browser profile, named by the profile's label.
 */

// manifest.json `key` pins this id, in Chrome and Edge alike.
export const PINNED_IDS = ['ihdiobmpbpecigcaoaijgnebdhkdfbne']

export function originAllowed(origin: string | undefined, extra = envVar('EXTENSION_IDS') ?? ''): boolean {
  if (typeof origin !== 'string') return false
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)
  if (!m) return false
  const ids = [...PINNED_IDS, ...extra.split(/[\s,]+/).filter(Boolean)]
  return ids.includes(m[1])
}

const REQUEST_TIMEOUT_MS = 30_000
const APPROVAL_TIMEOUT_MS = 120_000
const PAIRING_TIMEOUT_MS = 10 * 60_000
const LOG_MAX = 200

export interface ActivityLine { at: number; browser: string; tabId?: number; kind: string; text: string; ok: boolean; agent?: string }

/**
 * Everything the control room needs to follow live: activity, approvals,
 * questions, pairing requests and connection changes.
 */
export const bridgeEvents = new EventEmitter()
bridgeEvents.setMaxListeners(100)

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class Connection {
  label = 'default'
  browser = 'Chrome'
  extVersion = ''
  readonly tabs = new Map<number, ChromeTab>()
  private readonly pending = new Map<number, Pending>()
  private next = 1

  constructor(private readonly ws: Pick<WebSocket, 'send' | 'close'>) {}

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`the browser did not answer ${method} in ${timeoutMs / 1000} s`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  emit(event: string, data: Record<string, unknown> = {}): void {
    try { this.ws.send(JSON.stringify({ event, ...data })) } catch { /* closing */ }
  }

  /** One message from the extension: a reply to a request, or an event. */
  receive(msg: Record<string, unknown>): void {
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok === false) p.reject(new Error(String(msg.error ?? 'the browser refused')))
      else p.resolve(msg.result)
      return
    }
    const tabId = typeof msg.tabId === 'number' ? msg.tabId : -1
    switch (msg.event) {
      case 'cdp': this.tabs.get(tabId)?.deliver(String(msg.method), msg.params, typeof msg.sessionId === 'string' ? msg.sessionId : undefined); break
      case 'cdpDetached': this.tabs.get(tabId)?.detached(); break
      case 'tab': { const t = msg.tab as TabInfo | undefined; if (t) this.tabs.get(t.id)?.update(t); break }
      case 'tabRemoved': { const t = this.tabs.get(tabId); if (t) { t.destroy(); this.tabs.delete(tabId) } break }
      case 'approval': answerApproval(String(msg.approvalId), { allow: msg.allow === true, grant: grantOf(msg.grant) }, this); break
      case 'openRoom': bridgeEvents.emit('openRoom', { c: this }); break
      case 'answer': answerQuestion(String(msg.askId), { text: typeof msg.text === 'string' ? msg.text : undefined, done: msg.done === true, skipped: msg.skipped === true }, this); break
    }
  }

  /** The tab as an engine page; `ref` is a tab id or part of its url/title. */
  async tab(ref: unknown): Promise<ChromeTab | string> {
    const list = await this.request('tabs.list') as TabInfo[]
    const asId = typeof ref === 'number' ? ref : typeof ref === 'string' && /^\d+$/.test(ref.trim()) ? Number(ref) : null
    let info: TabInfo | undefined
    if (asId != null) info = list.find(t => t.id === asId)
    else if (typeof ref === 'string' && ref.trim()) {
      const q = ref.trim().toLowerCase()
      const hits = list.filter(t => t.url.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
      if (hits.length > 1) return `"${ref}" matches ${hits.length} tabs (${hits.slice(0, 5).map(t => t.id).join(', ')}) — pass the tab id`
      info = hits[0]
    } else return 'tab is required — chrome_tabs lists them'
    if (!info) return `no tab "${String(ref)}" in ${this.label} — chrome_tabs lists them`
    let t = this.tabs.get(info.id)
    if (!t || t.isDestroyed()) {
      t = new ChromeTab(info.id, info, (m, p) => this.request(m, p))
      this.tabs.set(info.id, t)
    } else t.update(info)
    return t
  }

  /** Replaced by a newer socket of the same profile: fail its waiting requests and hang up. */
  drop(): void {
    this.closed()
    try { this.ws.close() } catch { /* already closed */ }
  }

  closed(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the browser disconnected')) }
    this.pending.clear()
    for (const t of this.tabs.values()) t.destroy()
    this.tabs.clear()
  }
}

const conns = new Map<string, Connection>()
const log: ActivityLine[] = []
let lastRoomAsk = 0

export function connections(): Connection[] { return [...conns.values()] }

/** The browser to use: by label (or part of it), or the only/first one. */
export function pickBrowser(label?: unknown): Connection | string {
  const all = connections()
  if (!all.length) {
    return pairings.size
      ? `a browser is waiting to be paired (code ${[...pairings.keys()][0]}) — ask the user to approve it in the ${BRAND.name} control room (${BRAND.slug} open)`
      : `Chrome is not connected — open Chrome with the ${BRAND.name} extension (chrome://extensions → Load unpacked → extension/)`
  }
  if (typeof label !== 'string' || !label.trim()) return all[0]
  const q = label.trim().toLowerCase()
  return all.find(c => c.label.toLowerCase() === q) ?? all.find(c => c.label.toLowerCase().includes(q)) ?? `no connected browser "${label}" — connected: ${all.map(c => c.label).join(', ')}`
}

function broadcast(event: string, data: Record<string, unknown>): void {
  for (const c of conns.values()) c.emit(event, data)
  bridgeEvents.emit(event, data)
}

/** A line in the side panel's and the control room's live log. */
export function note(c: Connection, tabId: number | undefined, kind: string, text: string, ok = true, agent?: string): void {
  const line: ActivityLine = { at: Date.now(), browser: c.label, tabId, kind, text, ok, ...(agent ? { agent } : {}) }
  log.push(line)
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX)
  broadcast('activity', { line })
}

export function recentActivity(): ActivityLine[] { return [...log] }

/** Marks the tab as worked on (side panel + tab group) while `fn` runs. */
export async function busy<T>(c: Connection, tabId: number, fn: () => Promise<T>): Promise<T> {
  c.emit('busy', { tabId, busy: true })
  bridgeEvents.emit('busy', { browser: c.label, tabId, busy: true })
  try { return await fn() } finally {
    c.emit('busy', { tabId, busy: false })
    bridgeEvents.emit('busy', { browser: c.label, tabId, busy: false })
  }
}

// ── Approvals ──────────────────────────────────────────────────────────────────

/**
 * How long a yes lasts. `once` covers this step only; `site` covers the same
 * kind of step on the same site for a while (see daemon/grants.ts).
 */
export type Grant = 'once' | 'site'
const grantOf = (g: unknown): Grant | undefined => (g === 'site' || g === 'once' ? g : undefined)

export interface Decision { allow: boolean; grant?: Grant; by?: 'browser' | 'control-room' | 'timeout' | 'test'; /** Set when a site limit, not the user, said no. */ limit?: string }

/** What the approval card shows; everything beyond title/detail is optional. */
export interface ApprovalCard {
  title: string
  detail: string
  /** The site the step happens on (example.com). */
  site?: string
  /** What kind of step: send, pay, delete, upload, navigate, exfiltrate, … */
  kind?: string
  /** The element, the form values about to be submitted, or the request leaving. */
  preview?: { label: string; value: string }[]
  /** Whether "allow on this site for 15 minutes" may be offered. */
  grantable?: boolean
  /** Which agent asked. */
  agent?: string
}

interface Approval { resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout>; card: Record<string, unknown> }
const approvals = new Map<string, Approval>()

/** Asks the user in the browser (side panel + notification) and the control room; no answer in 2 minutes is a no. */
export function askApproval(c: Connection, tabId: number, card: ApprovalCard | string, detail = ''): Promise<Decision> {
  const approvalId = randomBytes(6).toString('hex')
  const body = typeof card === 'string' ? { title: card, detail } : card
  const full = { approvalId, browser: c.label, tabId, at: Date.now(), ...body }
  return new Promise(resolve => {
    const timer = setTimeout(() => answerApproval(approvalId, { allow: false, by: 'timeout' }), APPROVAL_TIMEOUT_MS)
    approvals.set(approvalId, { resolve, timer, card: full })
    c.emit('approval', full)
    bridgeEvents.emit('approval', full)
  })
}

/** Questions waiting for the user, oldest first. */
export function pendingApprovals(): Record<string, unknown>[] {
  return [...approvals.values()].map(a => a.card)
}

/**
 * Settles an approval. From a browser, only the profile it was asked in may answer:
 * another connection (another profile, or anything else that reached the socket)
 * cannot allow it. Without `from` (the control room, tests, the timeout) it always settles.
 */
export function answerApproval(approvalId: string, d: Decision | boolean, from?: Connection): boolean {
  const a = approvals.get(approvalId)
  if (!a || (from && a.card.browser !== from.label)) return false
  const decision: Decision = typeof d === 'boolean' ? { allow: d } : d
  if (from) decision.by = 'browser'
  approvals.delete(approvalId)
  clearTimeout(a.timer)
  broadcast('approvalDone', { approvalId, allow: decision.allow })
  a.resolve(decision)
  return true
}

// ── Questions ──────────────────────────────────────────────────────────────────

export interface UserAnswer { text?: string; done?: boolean; skipped?: boolean }
interface Question { resolve: (a: UserAnswer) => void; timer: ReturnType<typeof setTimeout>; card: Record<string, unknown> }
const questions = new Map<string, Question>()
const QUESTION_TIMEOUT_MS = 300_000

/**
 * Asks the user something only they can give (a one-time code, a PIN, a choice)
 * in the side panel; they can type it, say they did it themselves, or skip.
 * A secret answer is never written to the log.
 */
export function askUser(c: Connection, question: string, opts: { tabId?: number; secret?: boolean; choices?: string[] } = {}): Promise<UserAnswer> {
  const askId = randomBytes(6).toString('hex')
  const card = { askId, browser: c.label, question, secret: !!opts.secret, choices: opts.choices ?? [], tabId: opts.tabId, at: Date.now() }
  return new Promise(resolve => {
    const timer = setTimeout(() => answerQuestion(askId, { skipped: true }), QUESTION_TIMEOUT_MS)
    questions.set(askId, { resolve, timer, card })
    c.emit('ask', card)
    bridgeEvents.emit('ask', card)
  })
}

export function answerQuestion(askId: string, a: UserAnswer, from?: Connection): boolean {
  const q = questions.get(askId)
  if (!q || (from && q.card.browser !== from.label)) return false
  questions.delete(askId)
  clearTimeout(q.timer)
  broadcast('askDone', { askId })
  q.resolve(a)
  return true
}

export function pendingQuestions(): Record<string, unknown>[] {
  return [...questions.values()].map(q => q.card)
}

// ── Pairing ────────────────────────────────────────────────────────────────────

interface PairingRequest { code: string; c: Connection; label: string; browser: string; at: number; timer: ReturnType<typeof setTimeout> }
const pairings = new Map<string, PairingRequest>()
let store: PairingStore | null = null
let autoPair = false

/**
 * Turns pairing on (the daemon does; unit tests and older setups run without it).
 * `auto` approves every request: only for the e2e suite's throwaway browser.
 */
export function usePairing(s: PairingStore | null, opts: { auto?: boolean } = {}): void {
  store = s
  autoPair = !!opts.auto
}

export function pendingPairings(): { code: string; label: string; browser: string; at: number }[] {
  return [...pairings.values()].map(({ code, label, browser, at }) => ({ code, label, browser, at }))
}

/** The user approved the code shown in their side panel: trust that browser from now on. */
export function approvePairing(code: string): { ok: boolean; error?: string; label?: string } {
  const p = pairings.get(code.trim())
  if (!p || !store) return { ok: false, error: 'no browser is waiting with that code' }
  clearTimeout(p.timer)
  pairings.delete(p.code)
  const { token, entry } = store.add(p.label, p.browser)
  p.c.emit('paired', { pairToken: token, id: entry.id })
  register(p.c)
  bridgeEvents.emit('pairingDone', { code: p.code, ok: true })
  return { ok: true, label: p.label }
}

export function denyPairing(code: string): boolean {
  const p = pairings.get(code.trim())
  if (!p) return false
  clearTimeout(p.timer)
  pairings.delete(p.code)
  p.c.emit('pairingDenied', {})
  p.c.drop()
  bridgeEvents.emit('pairingDone', { code: p.code, ok: false })
  return true
}

function register(c: Connection): void {
  // A reconnect from the same profile replaces the old socket.
  const old = conns.get(c.label)
  if (old && old !== c) old.drop()
  conns.set(c.label, c)
  // Each profile sees only its own log, approvals and questions.
  const mine = (card: Record<string, unknown>) => card.browser === c.label
  c.emit('welcome', { log: log.filter(l => l.browser === c.label).slice(-50), approvals: pendingApprovals().filter(mine), questions: pendingQuestions().filter(mine), brand: BRAND.name })
  bridgeEvents.emit('connections', { browsers: connections().map(x => x.label) })
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })

/** The daemon's `upgrade` hook; true when the request was the extension's (accepted or refused). */
export function handleExtensionUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (!req.url?.startsWith('/extension')) return false
  if (!originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return true
  }
  wss.handleUpgrade(req, socket, head, ws => attach(ws))
  return true
}

function attach(ws: WebSocket): void {
  const c = new Connection(ws)
  let waitingCode = ''
  ws.on('message', (raw: RawData) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw.toString()) as Record<string, unknown> } catch { return }
    if (msg.type === 'hello') {
      c.label = typeof msg.profile === 'string' && msg.profile.trim() ? msg.profile.trim().slice(0, 60) : 'default'
      c.browser = typeof msg.browser === 'string' ? msg.browser : 'Chrome'
      c.extVersion = typeof msg.version === 'string' ? msg.version : ''
      if (store && !store.check(msg.pairToken)) {
        if (autoPair) {
          const { token, entry } = store.add(c.label, c.browser)
          c.emit('paired', { pairToken: token, id: entry.id })
        } else {
          // Not trusted yet: show a code in the side panel and wait for the user's approval.
          const code = pairingCode(new Set(pairings.keys()))
          waitingCode = code
          const timer = setTimeout(() => denyPairing(code), PAIRING_TIMEOUT_MS)
          pairings.set(code, { code, c, label: c.label, browser: c.browser, at: Date.now(), timer })
          c.emit('pairing', { code })
          bridgeEvents.emit('pairing', { code, label: c.label, browser: c.browser, at: Date.now() })
          return
        }
      }
      register(c)
      return
    }
    // A browser waiting for its code may also ask for the control room (where the code is approved).
    // It opens in the system browser, not through this socket, and at most every few seconds.
    if (msg.event === 'openRoom' && waitingCode && conns.get(c.label) !== c) {
      if (Date.now() - lastRoomAsk > 3000) { lastRoomAsk = Date.now(); bridgeEvents.emit('openRoom', {}) }
      return
    }
    // Only the registered socket of this profile is listened to; an unpaired one may only say hello.
    if (conns.get(c.label) !== c) return
    c.receive(msg)
  })
  ws.on('close', () => {
    c.closed()
    const p = waitingCode ? pairings.get(waitingCode) : undefined
    if (p && p.c === c) {
      clearTimeout(p.timer)
      pairings.delete(waitingCode)
      bridgeEvents.emit('pairingDone', { code: waitingCode, ok: false })
    }
    if (conns.get(c.label) === c) {
      conns.delete(c.label)
      bridgeEvents.emit('connections', { browsers: connections().map(x => x.label) })
    }
  })
  ws.on('error', () => { /* close follows */ })
}
