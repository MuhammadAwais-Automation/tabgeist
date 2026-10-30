import { withDebugger, type Send } from './capture'
import { readPage } from './read'
import type { CdpListener, PageTarget } from './target'

/**
 * The site's own data instead of its screen text: the JSON its fetch/XHR
 * calls brought back. Caught while Tabgeist works in the tab (every act, and a
 * data read that scrolls or reloads), kept per tab, handed to the agent raw.
 * Sites that talk over an encrypted socket (WhatsApp) bring nothing here.
 */

export interface DataResponse {
  method: string
  url: string
  status?: number
  /** Host of the page that made the call: answers of a site the tab left are not shown. */
  page: string
  /** When it arrived (ms since epoch). */
  at: number
  /** The body as JSON text, any XSSI guard removed. */
  body: string
}

const KEEP = 30
const MAX_BODY = 2_000_000
const logs = new Map<number, DataResponse[]>()

/** Recent data answers of a tab, oldest first. */
export function dataLog(tabId: number): DataResponse[] { return logs.get(tabId) ?? [] }

function remember(tabId: number, r: DataResponse): void {
  logs.set(tabId, [...dataLog(tabId), r].slice(-KEEP))
}

// Tracking and error pings carry no page data.
const NOISE = /\b(analytics|telemetry|beacon|metrics|tracking|sentry|collect|pixel|log_event|logging)\b/i

/** The JSON text of a body, or null when it is not JSON. Strips the guards sites put in front of it. */
export function jsonBody(raw: string): string | null {
  const s = raw.replace(/^\s*(\)\]\}'|for\s*\(;;\);|while\s*\(1\);)\s*/, '').trim()
  if (!/^[[{]/.test(s)) return null
  // Re-written without spaces: pretty-printed answers cost the agent a third more for nothing.
  try { return JSON.stringify(JSON.parse(s)) } catch { /* maybe newline-delimited JSON, as some streams send it */ }
  const lines = s.split('\n').filter(l => l.trim())
  try { return '[' + lines.map(l => JSON.stringify(JSON.parse(l))).join(',') + ']' } catch { return null }
}

// Keys that only steer the site's own UI and logging, never the data a person reads.
const NOISE_KEY = /^(trackingParams|clickTrackingParams|loggingDirectives|loggingContext|serviceTrackingParams|responseContext|mainAppWebResponseContext|webCommandMetadata|commandMetadata|accessibility|accessibilityData|thumbnailOverlays|frameworkUpdates|adSignalsInfo|style|styles|icon|clientMetrics|menu|__typename)$/
// Opaque tokens (cursors, signatures, hashes): long and without a space or a dot.
const TOKEN = /^[A-Za-z0-9_\-+/=%]{60,}$/

/**
 * The data without the site's UI plumbing: drops tracking and layout keys and
 * opaque tokens, and turns text pieces ({runs:[{text}]}, {simpleText}) into
 * plain strings. Empty leftovers go too. Ids and short values stay.
 */
export function slim(v: unknown): unknown {
  if (typeof v === 'string') return TOKEN.test(v) ? undefined : v
  if (Array.isArray(v)) {
    // One picture in several sizes: the biggest one's address is enough.
    if (v.length > 1 && v.every(x => typeof (x as { url?: unknown })?.url === 'string' && typeof (x as { width?: unknown }).width === 'number')) {
      return (v as { url: string; width: number }[]).reduce((a, b) => (b.width > a.width ? b : a)).url
    }
    const out = v.map(slim).filter(x => x !== undefined)
    return out.length ? out : undefined
  }
  if (!v || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  if (typeof o.simpleText === 'string') return o.simpleText
  if (Array.isArray(o.runs) && o.runs.every(r => typeof (r as { text?: unknown })?.text === 'string')) return o.runs.map(r => (r as { text: string }).text).join('')
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) {
    if (NOISE_KEY.test(k) || /[a-z](Config|Params)$/.test(k)) continue
    const x = slim(o[k])
    if (x !== undefined) out[k] = x
  }
  return Object.keys(out).length ? out : undefined
}

interface Pending { method: string; url: string; status?: number; mime?: string }

/**
 * Listens to the tab's network while `fn` runs and keeps each JSON answer of
 * a fetch/XHR call. Bodies are fetched as calls finish (Chrome drops them
 * soon after). `fn` gets `quiet`: waits until the network has been still.
 * Network is left on, as other Tabgeist code expects.
 */
export async function catchData<T>(wc: PageTarget, send: Send, fn: (quiet: () => Promise<void>) => Promise<T>): Promise<{ out: T; caught: number; refused?: string }> {
  const pending = new Map<string, Pending>()
  const bodies: Promise<void>[] = []
  let caught = 0
  let refused: string | undefined
  let lastAt = Date.now()
  const onMessage: CdpListener = (_e, method, params, sessionId) => {
    if (sessionId || !method.startsWith('Network.')) return
    lastAt = Date.now()
    if (method === 'Network.requestWillBeSent' && params.request) {
      if (params.type === 'XHR' || params.type === 'Fetch') pending.set(params.requestId, { method: params.request.method, url: params.request.url })
    } else if (method === 'Network.responseReceived') {
      const r = pending.get(params.requestId)
      if (r) { r.status = params.response?.status; r.mime = params.response?.mimeType }
    } else if (method === 'Network.loadingFailed') {
      pending.delete(params.requestId)
    } else if (method === 'Network.loadingFinished') {
      const r = pending.get(params.requestId)
      pending.delete(params.requestId)
      if (!r || NOISE.test(r.url) || /^(image|font|video|audio)\//.test(r.mime ?? '') || (params.encodedDataLength ?? 0) > MAX_BODY * 4) return
      bodies.push((async () => {
        const got = await send('Network.getResponseBody', { requestId: params.requestId }).catch((e: Error) => {
          // An extension older than this feature refuses the call; a dropped body is just skipped.
          if (/not allowed/.test(e.message)) refused = e.message
          return null
        }) as { body: string; base64Encoded: boolean } | null
        if (!got) return
        const body = jsonBody(got.base64Encoded ? Buffer.from(got.body, 'base64').toString('utf8') : got.body)
        if (!body || body === '{}' || body === '[]') return
        remember(wc.id, { method: r.method, url: r.url, status: r.status, page: hostOf(wc.getURL()), at: Date.now(), body: body.slice(0, MAX_BODY) })
        caught++
      })())
    }
  }
  const quiet = async (still = 800, max = 10_000) => {
    const end = Date.now() + max
    while (Date.now() < end && Date.now() - lastAt < still) await sleep(100)
  }
  wc.debugger.on('message', onMessage)
  try {
    await send('Network.enable').catch(() => {})
    const out = await fn(quiet)
    // Answers still on their way when `fn` ended.
    await Promise.race([Promise.allSettled(bodies), sleep(1500)])
    return { out, caught, refused }
  } finally {
    wc.debugger.removeListener('message', onMessage)
  }
}

export interface DataRequest {
  /** Scroll first, so the site fetches more: older = up, more = down. */
  load?: 'older' | 'more'
  pages?: number
  /** Reload the page and keep what it fetches as it starts. */
  reload?: boolean
  /** Keep only answers whose address or body has this text. */
  match?: string
  /** The bodies as the site sent them, without slim(). */
  raw?: boolean
  maxChars?: number
}

export interface DataResult {
  ok: boolean
  error?: string
  url?: string
  /** One block per answer, newest last: "GET <url> (200)" then the JSON. */
  text?: string
  responses?: number
  /** Caught during this call (the rest came from earlier work in the tab). */
  fresh?: number
  chars?: number
  truncated?: boolean
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hostOf = (url: string) => { try { return new URL(url).host } catch { return '' } }

/**
 * Newest answers matter most: whole blocks are kept from the newest back
 * until `max`; the newest alone is cut when it is bigger than that.
 */
export function packBlocks(blocks: string[], max: number): { text: string; truncated: boolean } {
  let text = ''
  for (let i = blocks.length - 1; i >= 0; i--) {
    const next = text ? blocks[i] + '\n\n' + text : blocks[i]
    if (next.length > max) return { text: text || blocks[i].slice(0, max), truncated: true }
    text = next
  }
  return { text, truncated: false }
}

export async function readData(wc: PageTarget, req: DataRequest): Promise<DataResult> {
  const { caught, refused } = await withDebugger(wc, send => catchData(wc, send, async quiet => {
    if (req.reload) {
      const done = new Promise<void>(r => wc.once('did-stop-loading', () => r()))
      // From the page itself: the extension allows Runtime.evaluate, not Page.reload.
      await send('Runtime.evaluate', { expression: 'location.reload()' })
      await Promise.race([done, sleep(15_000)])
    } else if (req.load) {
      // readPage borrows this debugger session; only the calls its scrolling causes are wanted.
      await readPage(wc, { load: req.load, pages: req.pages ?? 5, maxChars: 200 })
    }
    await quiet()
  }))
  if (refused && !caught) return { ok: false, url: wc.getURL(), error: `${refused} — the Tabgeist extension is older than this feature: reload it on the browser extensions page` }
  const needle = req.match?.toLowerCase()
  const page = hostOf(wc.getURL())
  const list = dataLog(wc.id).filter(r => r.page === page).filter(r => !needle || r.url.toLowerCase().includes(needle) || r.body.toLowerCase().includes(needle))
  if (!list.length) {
    return {
      ok: false,
      url: wc.getURL(),
      error: needle
        ? `no data answer has "${req.match}" — try without match, or load / reload so the site fetches it`
        : 'no JSON came from this site yet — try load: "more"/"older" or reload: true; if still nothing, the site sends its data another way (an encrypted socket, or HTML): read the text instead',
    }
  }
  const blocks = list.map(r => `${r.method} ${r.url}${r.status ? ` (${r.status})` : ''}\n${req.raw ? r.body : JSON.stringify(slim(JSON.parse(r.body)) ?? null)}`)
  const { text, truncated } = packBlocks(blocks, req.maxChars ?? 20_000)
  return { ok: true, url: wc.getURL(), text, responses: list.length, fresh: caught, chars: blocks.reduce((n, b) => n + b.length, 0), truncated }
}
