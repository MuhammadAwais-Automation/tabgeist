import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Routes: a page's own read requests (GET) noticed while acting, saved by name
 * and fetched again later from inside the page — the data without the clicks
 * (research: "Beyond Browsing", API calls beat UI steps when the API exists).
 *
 * Deliberately read-only and same-site: only GET over https to the page's own
 * site is ever replayed, with the page's cookies and nothing else — auth
 * headers are not copied, so a site that needs more simply answers 401/403.
 */

export interface SeenRequest { method: string; url: string; type: string; status?: number; mime?: string; bytes?: number }

export interface Route { name: string; host: string; url: string; created: string }

const SECRET_PARAM = /token|auth|sig|signature|key|session|csrf|xsrf|password|secret|code|nonce/i

/** URL for showing to an agent: secret-looking query values replaced by "…". */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw)
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, '…')
    return u.toString()
  } catch { return '' }
}

/** "www.linkedin.com" → "linkedin.com"; good enough for same-site checks on the sites Tabgeist drives. */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean)
  return parts.slice(-2).join('.')
}

/** Why a URL may not be replayed from a page, or null when it may. */
export function replayRefusal(url: string, pageUrl: string): string | null {
  let u: URL, page: URL
  try { u = new URL(url); page = new URL(pageUrl) } catch { return 'not a valid url' }
  if (u.protocol !== 'https:') return 'only https urls are replayed'
  if (siteOf(u.host) !== siteOf(page.host)) return `${u.host} is not part of ${page.host}'s site`
  if (decodeURIComponent(u.search).includes('…')) return 'the url still has a redacted (…) value; secret parameters are not replayed'
  return null
}

/** Requests worth showing after an action: the page's data calls, GET first, de-duplicated, capped. */
export function summarizeRequests(seen: SeenRequest[], limit = 15): { method: string; url: string; status?: number; mime?: string; bytes?: number }[] {
  const data = seen.filter(r => r.type === 'XHR' || r.type === 'Fetch')
  const unique = new Map<string, SeenRequest>()
  for (const r of data) unique.set(`${r.method} ${r.url}`, r)
  return [...unique.values()]
    .sort((a, b) => Number(b.method === 'GET') - Number(a.method === 'GET'))
    .slice(0, limit)
    .map(r => ({ method: r.method, url: redactUrl(r.url), status: r.status, mime: r.mime, bytes: r.bytes }))
}

/** Fills {{name}} in a route url, URL-encoded; `missing` names the first absent variable. */
export function fillRoute(url: string, vars: Record<string, string>): { url: string } | { missing: string } {
  let missing = ''
  const out = url.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, k: string) => {
    if (vars[k] == null) { missing ||= k; return '' }
    return encodeURIComponent(vars[k])
  })
  return missing ? { missing } : { url: out }
}

/** Runs inside the page: same cookies as the page, no extra headers, body cut short. */
export const FETCH_IN_PAGE = `async function (url, max) {
  const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } })
  const text = await r.text()
  return { status: r.status, mime: r.headers.get('content-type') || '', bytes: text.length, body: text.slice(0, max) }
}`

export async function loadRoutes(file: string): Promise<Record<string, Route>> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, Route> } catch { return {} }
}

export async function saveRoute(file: string, route: Route): Promise<void> {
  const all = await loadRoutes(file)
  all[route.name] = route
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(all, null, 2), 'utf8')
}
