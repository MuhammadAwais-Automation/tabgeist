import type { CdpListener, PageTarget } from '../engine/target'
import type { ExfilWatch } from './exfil'
import { siteKey, type SecretFog } from './fog'

/**
 * Holds the page's outgoing requests while an agent acts (Fetch interception):
 * - a request that carries a fogged secret, or text an agent read on another
 *   site, waits for the user's approval (exfiltration);
 * - in shadow mode every write (POST, PUT, PATCH, DELETE) is blocked and
 *   reported as "would have sent".
 * Plain reads and the site's own traffic pass untouched.
 */

export interface GateRules {
  /** The site the agent is acting on. */
  site: string
  shadow: boolean
  /** Other hosts this site may send data to (policy `outbound`). */
  outbound: string[]
  fog: SecretFog
  exfil: ExfilWatch
  /** Asks the user; true lets the request go. */
  ask(card: { title: string; detail: string; preview: { label: string; value: string }[]; kind: string }): Promise<boolean>
}

export interface GateLog {
  /** Writes blocked in shadow mode. */
  wouldSend: { method: string; url: string }[]
  /** Requests held for approval, and the answer. */
  held: { method: string; url: string; why: string; allowed: boolean }[]
}

interface Paused { requestId: string; request: { url: string; method: string; postData?: string }; resourceType?: string }

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Why this request must not leave without the user's yes, or null. */
export function leakReason(rules: Pick<GateRules, 'site' | 'outbound' | 'fog' | 'exfil'>, url: string, body = ''): string | null {
  let host = ''
  try { host = new URL(url).host } catch { return null }
  if (!/^https?:/i.test(url)) return null
  const to = siteKey(host)
  const payload = `${url}\n${body}`
  const secret = rules.fog.leaks(payload, to)
  if (secret) return `it carries a ${secret.kind} from ${secret.site} to ${host}`
  const own = to === siteKey(rules.site) || rules.outbound.some(o => host === o || host.endsWith(`.${o}`))
  if (own) return null
  const from = rules.exfil.check(payload, to)
  if (from) return `it carries text read on ${from} to ${host}`
  return null
}

const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s)

export async function withNetGate<T>(t: PageTarget, rules: GateRules, fn: () => Promise<T>): Promise<[T, GateLog]> {
  const log: GateLog = { wouldSend: [], held: [] }
  const send = (m: string, p?: Record<string, unknown>) => t.debugger.sendCommand(m, p)
  const attachedHere = !t.debugger.isAttached()
  if (attachedHere) t.debugger.attach('1.3')
  const decide = async (p: Paused) => {
    const { method, url, postData } = p.request
    try {
      if (rules.shadow && !READS.has(method.toUpperCase()) && /^https?:/i.test(url)) {
        log.wouldSend.push({ method, url: short(url, 200) })
        await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' })
        return
      }
      const why = leakReason(rules, url, postData)
      if (why) {
        const allowed = await rules.ask({
          title: `send data to ${new URL(url).host}`,
          detail: `The page is sending a request that ${why}.`,
          preview: [{ label: 'Request', value: `${method} ${short(rules.fog.scrub(url), 200)}` }, ...(postData ? [{ label: 'Body', value: short(rules.fog.scrub(postData)) }] : [])],
          kind: 'exfiltrate',
        })
        log.held.push({ method, url: short(rules.fog.scrub(url), 200), why, allowed })
        await send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' })
        return
      }
      await send('Fetch.continueRequest', { requestId: p.requestId })
    } catch { /* the request or page went away */ }
  }
  const onMessage: CdpListener = (_e, method, params, sessionId) => {
    if (method !== 'Fetch.requestPaused' || sessionId) return
    void decide(params as Paused)
  }
  t.debugger.on('message', onMessage)
  let enabled = false
  try {
    enabled = await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }).then(() => true, () => false)
    const out = await fn()
    return [out, log]
  } finally {
    if (enabled) await send('Fetch.disable').catch(() => {})
    t.debugger.removeListener('message', onMessage)
    if (attachedHere && !t.isDestroyed()) { try { t.debugger.detach() } catch { /* gone */ } }
  }
}
