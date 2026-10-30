import { BRAND, envVar } from '../brand'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { stateFor, withDebugger } from './capture'
import type { PageTarget } from './target'

/**
 * Saves what an element shows or links to (an image, a video, a PDF, any link)
 * or a URL, fetched inside the page so the user's sign-in comes along. Files
 * go to Downloads/Tabgeist/<site>.
 */

export const MAX_FILE_BYTES = 100 * 1024 * 1024

export interface Fetched { file: string; url: string; mime: string; bytes: number }

// Runs in the page: the element's media or link address, then its bytes as base64.
const IN_PAGE = `async function (url, max) {
  const el = this && this.nodeType === 1 ? this : null
  if (el) {
    // The picture itself before any link around it: "Open photo" links go to a viewer page, not the file.
    const media = n => n && (n.currentSrc || n.src || n.getAttribute('data-src') || n.getAttribute('poster') || '')
    const own = /^(IMG|VIDEO|AUDIO|SOURCE)$/.test(el.tagName) ? media(el) : ''
    url = own || media(el.querySelector('img,video,audio,source')) || el.href || (el.closest('a[href]') || {}).href || ''
    if (!url) { const bg = /url\\("?(.*?)"?\\)/.exec(getComputedStyle(el).backgroundImage); if (bg) url = bg[1] }
    if (!url) return { error: 'the element has no image, video or link to save' }
  }
  url = new URL(url, location.href).href
  let res
  try { res = await fetch(url, { credentials: 'include' }) } catch (e) { return { error: 'the page could not fetch it (' + e.message + ')', url } }
  if (!res.ok) return { error: 'the site answered ' + res.status, url }
  const blob = await res.blob()
  if (blob.size > max) return { error: 'bigger than 100 MB', url }
  const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(blob) })
  return { url, mime: blob.type || res.headers.get('content-type') || '', data }
}`

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4', 'application/pdf': '.pdf', 'audio/mpeg': '.mp3', 'text/plain': '.txt' }

/** `photo-2026-10-27T15-40-01.jpg`: the url's own name when it has one, a timestamp so nothing is overwritten. */
export function fileNameFor(url: string, mime: string, now = new Date()): string {
  let base = ''
  try { base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') } catch { /* blob: or data: */ }
  base = base.replace(/[^\w.-]+/g, '_').slice(-80)
  const own = extname(base)
  const ext = own || EXT[mime.split(';')[0].trim()] || ''
  const stem = (own ? base.slice(0, -own.length) : base) || 'file'
  return `${stem}-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}${ext}`
}

interface InPage { error?: string; url?: string; mime?: string; data?: string }

/** Loads a url the way DevTools does: the page's cookies, no CORS. Null when the browser refuses. */
async function loadThroughBrowser(t: PageTarget, url: string): Promise<{ data: string; mime: string } | null> {
  return withDebugger(t, async send => {
    const { frameTree } = await send('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
    const r = await send('Network.loadNetworkResource', { frameId: frameTree.frame.id, url, options: { disableCache: false, includeCredentials: true } }).catch(() => null) as
      { resource?: { success: boolean; stream?: string; headers?: Record<string, string> } } | null
    const res = r?.resource
    if (!res?.success || !res.stream) return null
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const part = await send('IO.read', { handle: res.stream, size: 1 << 20 }) as { data: string; eof: boolean; base64Encoded?: boolean }
      const buf = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8')
      total += buf.length
      if (total > MAX_FILE_BYTES) { await send('IO.close', { handle: res.stream }).catch(() => {}); return null }
      chunks.push(buf)
      if (part.eof) break
    }
    await send('IO.close', { handle: res.stream }).catch(() => {})
    const type = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
    return { data: Buffer.concat(chunks).toString('base64'), mime: type }
  })
}

export async function saveFromPage(t: PageTarget, req: { ref?: string; url?: string }, dir?: string): Promise<Fetched | string> {
  const args = [{ value: req.url ?? null }, { value: MAX_FILE_BYTES }]
  const out = await withDebugger(t, async send => {
    if (req.ref) {
      const entry = stateFor(t).refs.get(req.ref)
      if (!entry) return { error: `unknown ref ${req.ref}; take a new snapshot` } as InPage
      const r = await send('DOM.resolveNode', { backendNodeId: entry.backendNodeId }).catch(() => null) as { object?: { objectId?: string } } | null
      if (!r?.object?.objectId) return { error: `ref ${req.ref} is gone; take a new snapshot` } as InPage
      const v = await send('Runtime.callFunctionOn', { objectId: r.object.objectId, functionDeclaration: IN_PAGE, arguments: args, awaitPromise: true, returnByValue: true }) as { result?: { value?: InPage } }
      return v.result?.value ?? { error: 'the page returned nothing' }
    }
    const v = await send('Runtime.evaluate', { expression: `(${IN_PAGE}).call(undefined, ${JSON.stringify(req.url ?? '')}, ${MAX_FILE_BYTES})`, awaitPromise: true, returnByValue: true }) as { result?: { value?: InPage } }
    return v.result?.value ?? { error: 'the page returned nothing' }
  })
  // A picture on another domain (a CDN) without CORS: the page may not fetch it, the browser's own loader may.
  if (out.error && out.url && /could not fetch/.test(out.error)) {
    const viaBrowser = await loadThroughBrowser(t, out.url)
    if (viaBrowser) Object.assign(out, { error: undefined, ...viaBrowser })
  }
  if (out.error || !out.data || !out.url) return out.error ?? 'nothing to save'
  let host = 'page'
  try { host = new URL(t.getURL()).hostname.replace(/^www\./, '') || host } catch { /* keep */ }
  const folder = dir ?? join(envVar('DOWNLOADS') || join(homedir(), 'Downloads', BRAND.name), host)
  await mkdir(folder, { recursive: true })
  const file = join(folder, fileNameFor(out.url, out.mime ?? ''))
  const buf = Buffer.from(out.data, 'base64')
  await writeFile(file, buf)
  // CDN links carry signed tokens in the query: the file is saved, the agent only needs where it came from.
  let shown = 'data: URL'
  try { if (!out.url.startsWith('data:')) { const u = new URL(out.url); shown = u.origin + u.pathname } } catch { /* keep */ }
  return { file, url: shown, mime: out.mime ?? '', bytes: buf.length }
}
