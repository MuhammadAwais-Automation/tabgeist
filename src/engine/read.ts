import { stateFor, withDebugger } from './capture'
import type { PageTarget } from './target'

/**
 * Reads the text a page shows — chat messages, articles, prices, reviews,
 * tables — which the snapshot leaves out (it lists controls and headings).
 * Optionally scrolls the area first to load older messages or more items.
 */

export interface ReadRequest {
  /** An element ref from a snapshot: read that element. */
  ref?: string
  /** A region by its label ("Conversation with Ali", "Thread list") or "main". */
  region?: string
  /** A CSS selector, for when nothing else names the area. */
  selector?: string
  /** With ref: read the whole post, card, message or row the ref sits in. */
  item?: boolean
  /** Scroll first: older = up (chat history), more = down (feeds, lists). */
  load?: 'older' | 'more'
  /** How many screens to load at most. */
  pages?: number
  maxChars?: number
  /** The site's own JSON (its fetch/XHR answers) instead of the screen text: see data.ts. */
  data?: boolean
  /** With data: reload the page and keep what it fetches as it starts. */
  reload?: boolean
  /** With data: only answers whose address or body has this text. */
  match?: string
  /** With data: the JSON as sent, tracking and layout keys included. */
  raw?: boolean
  /** With data: run this op of the site's adapter (its in-page store) instead of reading the network. */
  op?: string
  /** With op: its inputs. */
  args?: Record<string, unknown>
}

export interface ReadResult {
  ok: boolean
  error?: string
  /** What to try next when the area read had no text. */
  hint?: string
  url?: string
  text?: string
  chars?: number
  truncated?: boolean
  /** Screens that loaded new content. */
  loaded?: number
  /** Scrolling stopped because nothing more loaded (start of the chat, end of the feed). */
  reachedEnd?: boolean
}

export const MAX_PAGES = 30
const DEFAULT_CHARS = 20_000
const MAX_CHARS = 100_000

export function parseReadRequest(p: Record<string, unknown>): ReadRequest | string {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const load = p.load === 'older' || p.load === 'more' ? p.load : undefined
  if (p.load != null && !load) return 'load: older (scroll up, e.g. chat history) or more (scroll down, e.g. feeds)'
  const pages = p.pages == null ? 5 : Number(p.pages)
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) return `pages: 1-${MAX_PAGES}`
  const maxChars = p.maxChars == null ? DEFAULT_CHARS : Number(p.maxChars)
  if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > MAX_CHARS) return `maxChars: 200-${MAX_CHARS}`
  if (p.data === true) {
    if (p.ref != null || p.region != null || p.selector != null) return 'data: true reads all data answers of the tab; narrow them with match, not ref/region/selector'
    const args = p.args == null ? {} : p.args
    if (typeof args !== 'object' || Array.isArray(args)) return 'args: an object, e.g. { "chat": "Ali", "limit": 50 }'
    if (p.args != null && !str(p.op)) return 'args go with op'
    return { data: true, load, pages, maxChars, reload: p.reload === true, match: str(p.match), raw: p.raw === true, op: str(p.op), args: args as Record<string, unknown> }
  }
  if (p.reload != null || p.match != null || p.raw != null || p.op != null || p.args != null) return 'reload, match, raw, op and args go with data: true'
  return { ref: str(p.ref), region: str(p.region), selector: str(p.selector), item: p.item === true, load, pages, maxChars }
}

/**
 * Drops invisible characters and blank-line runs; keeps line breaks. A line
 * the next line repeats with more ("hello", then the screen-reader copy
 * "Message sent 20:30 by You: hello") goes: the fuller line says who and when.
 */
export function cleanText(raw: string): string {
  const lines = raw
    .replace(/[​-‍﻿⁠‪-‮⁦-⁩]/g, '')
    .split('\n')
    .map(l => l.replace(/[ \t ]+/g, ' ').trim())
  const next = (i: number) => { for (let j = i + 1; j < lines.length; j++) if (lines[j]) return lines[j]; return '' }
  return lines
    .filter((l, i) => !l || !(next(i).length > l.length && next(i).endsWith(`: ${l}`)))
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim()
}

/** Keeps the end when loading older history (newest last), the start otherwise. */
export function clip(text: string, max: number, keepEnd: boolean): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: keepEnd ? text.slice(-max) : text.slice(0, max), truncated: true }
}

// Runs in the page. `this` is the element of a ref, or undefined.
const IN_PAGE = `async function (region, selector, load, pages, item) {
  const low = s => (s || '').toLowerCase().trim()
  let el = this && this.nodeType === 1 ? this : null
  if (el && item) el = el.closest('article,[role=article],li,[role=listitem],[role=row],[data-urn],[data-id]') || el
  if (!el && selector) { el = document.querySelector(selector); if (!el) return { error: 'no element matches selector ' + selector } }
  if (!el && region) {
    const q = low(region)
    // Many sites have no main landmark: then the whole page is the main area.
    if (q === 'main') el = document.querySelector('main,[role=main]') || document.body
    if (!el) {
      const all = [...document.querySelectorAll('[aria-label]')]
      const hits = [...all.filter(n => low(n.getAttribute('aria-label')) === q), ...all.filter(n => low(n.getAttribute('aria-label')).includes(q))]
      // A link or button often carries the same label as the area it opens: take one with text in it.
      el = hits.find(n => (n.innerText || '').trim()) || hits[0]
    }
    if (!el) return { error: 'no region "' + region + '" on the page; use a ref from the snapshot, or omit region to read the main area' }
  }
  if (!el) el = document.querySelector('main,[role=main]') || document.body
  // innerText skips pictures, and a sticker, GIF or 👍 often is the message: walk the page in order instead.
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|flow-root)$/
  let out = '', seen = 0
  const walk = n => {
    if (++seen > 60000) return
    if (n.nodeType === 3) { out += n.nodeValue; return }
    if (n.nodeType !== 1) return
    const tag = n.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return
    const cs = getComputedStyle(n)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    // Screen-reader-only copies ("Enter, Message sent … by You: hi") repeat every line: a 1px clipped box.
    if (cs.position === 'absolute' && n.offsetWidth <= 1 && n.offsetHeight <= 1) return
    // Text a person cannot see is where pages hide instructions for agents: see-through,
    // microscopic, pushed off screen or marked hidden from people with assistive tech too.
    if (n.getAttribute('aria-hidden') === 'true' && !n.querySelector('img,[role=img]')) return
    if (Number(cs.opacity) === 0 || parseFloat(cs.fontSize) < 2) return
    if (parseFloat(cs.textIndent) < -999) return
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      const r = n.getBoundingClientRect()
      if (r.right < -500 || r.bottom < -500 || r.left > innerWidth + 5000) return
    }
    const label = n.getAttribute('aria-label')
    if (tag === 'IMG' || tag === 'svg' || tag === 'SVG' || n.getAttribute('role') === 'img') {
      const alt = ((tag === 'IMG' ? (n.getAttribute('alt') || label) : label) || '').trim()
      // An emoji drawn as a picture is still just that emoji in the text.
      if (alt) out += /^[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u200d\\ufe0f]+$/u.test(alt) ? alt : ' [image: ' + alt + '] '
      return
    }
    if (tag === 'BR') { out += '\\n'; return }
    const block = BLOCK.test(cs.display)
    if (block) out += '\\n'
    if (n.shadowRoot) for (const c of n.shadowRoot.childNodes) walk(c)
    for (const c of n.childNodes) walk(c)
    if (block) out += '\\n'
  }
  const textOf = () => { out = ''; seen = 0; walk(el); return out }
  if (!load) return { text: textOf() }
  // One screen at a time, keeping each screen's text: long chats and feeds draw only
  // the rows on screen (virtual lists), so text read at the end alone would miss the middle.
  const scrolls = n => n.scrollHeight > n.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)
  let box = [el, ...el.querySelectorAll('*')].filter(scrolls).sort((a, b) => b.clientHeight - a.clientHeight)[0]
  for (let p = el.parentElement; !box && p; p = p.parentElement) if (scrolls(p)) box = p
  box = box || document.scrollingElement
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const chunks = [textOf()]
  let loaded = 0, reachedEnd = false
  // null until the first step shows whether the rows on screen get redrawn on scroll.
  let virtual = null
  for (let i = 0; i < pages; i++) {
    const h = box.scrollHeight, top = box.scrollTop, before = chunks[chunks.length - 1]
    // Negative tops are fine: column-reverse chat lists scroll that way.
    box.scrollTop = top + (load === 'older' ? -1 : 1) * Math.max(100, box.clientHeight * 0.8)
    // A background tab gets no frames, so the page's own scroll handler may not run for a
    // second or more: fire it now, then wait for the redrawn rows rather than a fixed time.
    ;(box === document.scrollingElement ? window : box).dispatchEvent(new Event('scroll'))
    let moved = false, text = before
    for (let w = 0; w < 20; w++) {
      await sleep(150)
      moved = moved || box.scrollHeight !== h || box.scrollTop !== top
      text = textOf()
      if (moved && (text !== before || virtual === false || w >= 10)) break
    }
    if (!moved) { reachedEnd = true; break }
    if (virtual === null) virtual = text !== before
    loaded++
    chunks.push(text)
  }
  return { chunks, loaded, reachedEnd }
}`

interface InPageResult { error?: string; text?: string; chunks?: string[]; loaded?: number; reachedEnd?: boolean }

const sameLines = (a: string[], at: number, b: string[], k: number) => { for (let i = 0; i < k; i++) if (a[at + i] !== b[i]) return false; return true }

/** a then b, with the lines b repeats from the end of a written once. Fewer than 3 shared lines is not an overlap ("ok" twice is two messages). */
function joinOverlap(a: string[], b: string[]): string[] {
  for (let k = Math.min(a.length, b.length); k > 0; k--) {
    if (k < 3 && k < b.length) break
    if (sameLines(a, a.length - k, b, k)) return [...a, ...b.slice(k)]
  }
  return [...a, ...b]
}

/**
 * The screens read while scrolling, as one text in page order. `older` screens
 * come from further up, so each goes in front of what is already there.
 */
export function stitch(chunks: string[], older: boolean): string {
  let acc: string[] = []
  for (const c of chunks) {
    const lines = cleanText(c).split('\n')
    acc = older ? joinOverlap(lines, acc) : joinOverlap(acc, lines)
  }
  return acc.join('\n')
}

export async function readPage(t: PageTarget, req: ReadRequest): Promise<ReadResult> {
  const args = [req.region ?? null, req.selector ?? null, req.load ?? null, req.pages ?? 5, req.item ?? false].map(value => ({ value }))
  const out = await withDebugger(t, async send => {
    let objectId: string | undefined
    if (req.ref) {
      const entry = stateFor(t).refs.get(req.ref)
      if (!entry) return { error: `unknown ref ${req.ref}; take a new snapshot` } as InPageResult
      const resolved = await send('DOM.resolveNode', { backendNodeId: entry.backendNodeId }).catch(() => null) as { object?: { objectId?: string } } | null
      objectId = resolved?.object?.objectId
      if (!objectId) return { error: `ref ${req.ref} is gone or inside a cross-site frame; take a new snapshot, or read a region instead` } as InPageResult
    }
    const r = objectId
      ? await send('Runtime.callFunctionOn', { objectId, functionDeclaration: IN_PAGE, arguments: args, awaitPromise: true, returnByValue: true })
      : await send('Runtime.evaluate', { expression: `(${IN_PAGE}).apply(undefined, ${JSON.stringify(args.map(a => a.value))})`, awaitPromise: true, returnByValue: true })
    const res = r as { result?: { value?: InPageResult }; exceptionDetails?: { text?: string } }
    if (res.exceptionDetails) return { error: `the page threw: ${res.exceptionDetails.text ?? 'error'}` } as InPageResult
    return res.result?.value ?? { error: 'the page returned nothing' }
  })
  if (out.error) return { ok: false, error: out.error, url: t.getURL() }
  const full = out.chunks ? stitch(out.chunks, req.load === 'older') : cleanText(out.text ?? '')
  const { text, truncated } = clip(full, req.maxChars ?? DEFAULT_CHARS, req.load === 'older')
  const hint = full.trim() ? {} : { hint: 'that area has no text; take a snapshot and read by ref, or omit region to read the main area' }
  return { ok: true, url: t.getURL(), text, chars: full.length, truncated, ...(req.load ? { loaded: out.loaded ?? 0, reachedEnd: !!out.reachedEnd } : {}), ...hint }
}
