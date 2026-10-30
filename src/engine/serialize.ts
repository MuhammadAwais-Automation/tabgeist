import type { RefTable } from './refs'
import type { PageItem, PageMap, SnapshotDiff } from './types'

/**
 * Turns Chrome's accessibility tree and DOM snapshot into the small page map an
 * agent reads, the summary-first text it is shown, and the diff after an action.
 * Pure: capture.ts fetches the raw data, everything here is testable without a page.
 */

/** The parts of a CDP `Accessibility.AXNode` this file reads. */
export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  properties?: { name: string; value?: { value?: unknown } }[]
  backendDOMNodeId?: number
}

interface RareStrings { index: number[]; value: number[] }

/** The parts of a CDP `DOMSnapshot.captureSnapshot` result this file reads. */
export interface DOMSnapshotResult {
  strings: string[]
  documents: {
    nodes: {
      parentIndex?: number[]
      nodeType?: number[]
      nodeName?: number[]
      nodeValue?: number[]
      backendNodeId?: number[]
      attributes?: number[][]
      shadowRootType?: RareStrings
      isClickable?: { index: number[] }
    }
    layout: { nodeIndex: number[]; bounds: number[][] }
  }[]
}

export interface Rect { x: number; y: number; w: number; h: number }

/** What the DOM knows about an element that the AX tree does not, by backendNodeId. */
export interface DomFacts {
  rect(id: number): Rect | undefined
  /** Has a click listener (clickable `div`s, chat rows). */
  clickable(id: number): boolean
  /** Password, card or one-time-code input. */
  sensitive(id: number): boolean
  /** aria-label / placeholder / title of the nearest labelled shadow host, for unnamed inputs inside web components. */
  hostLabel(id: number): string
  /** Visible text inside the element, cut short — a name for clickable rows that have none. */
  text(id: number): string
  /** backendNodeIds of the element's ancestors in its document, nearest first. */
  ancestors(id: number): number[]
  /** An attribute of the element ('' when absent). */
  attr(id: number, name: string): string
}

const SENSITIVE_AUTOCOMPLETE = /one-time-code|cc-number|cc-csc|cc-exp|current-password|new-password/i

export function domFacts(snap: DOMSnapshotResult): DomFacts {
  const s = (i: number | undefined) => (i == null || i < 0 ? '' : snap.strings[i] ?? '')
  const where = new Map<number, { doc: number; node: number }>()
  const rects = new Map<number, Rect>()
  const clickable = new Set<number>()
  const children: number[][][] = []

  snap.documents.forEach((d, doc) => {
    const ids = d.nodes.backendNodeId ?? []
    ids.forEach((id, node) => where.set(id, { doc, node }))
    for (const node of d.nodes.isClickable?.index ?? []) clickable.add(ids[node])
    d.layout.nodeIndex.forEach((node, i) => {
      const [x, y, w, h] = d.layout.bounds[i] ?? []
      if (!rects.has(ids[node]) && w != null) rects.set(ids[node], { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })
    })
    const kids: number[][] = ids.map(() => [])
    ;(d.nodes.parentIndex ?? []).forEach((p, node) => { if (p >= 0) kids[p].push(node) })
    children[doc] = kids
  })

  const attrs = (doc: number, node: number): Record<string, string> => {
    const flat = snap.documents[doc].nodes.attributes?.[node] ?? []
    const out: Record<string, string> = {}
    for (let i = 0; i + 1 < flat.length; i += 2) out[s(flat[i]).toLowerCase()] = s(flat[i + 1])
    return out
  }
  const shadowType = (doc: number, node: number): string => {
    const rare = snap.documents[doc].nodes.shadowRootType
    const at = rare?.index.indexOf(node) ?? -1
    return at < 0 ? '' : s(rare!.value[at])
  }

  return {
    rect: id => rects.get(id),
    clickable: id => clickable.has(id),
    sensitive(id) {
      const at = where.get(id)
      if (!at) return false
      const a = attrs(at.doc, at.node)
      return a.type?.toLowerCase() === 'password' || SENSITIVE_AUTOCOMPLETE.test(a.autocomplete ?? '')
    },
    hostLabel(id) {
      const at = where.get(id)
      if (!at) return ''
      const nodes = snap.documents[at.doc].nodes
      const parents = nodes.parentIndex ?? []
      const author = (n: number) => { const t = shadowType(at.doc, n); return t === 'open' || t === 'closed' }
      if (!author(at.node)) return ''
      // DOMSnapshot has no shadow-root node: elements inside one carry its type and their
      // parent is the host. Hosts are where the type stops, or custom elements (they nest).
      for (let child = at.node, n = parents[at.node]; n != null && n >= 0; child = n, n = parents[n]) {
        const host = (author(child) && !author(n)) || s(nodes.nodeName?.[n]).includes('-')
        if (!host) continue
        const a = attrs(at.doc, n)
        const label = (a['aria-label'] || a.placeholder || a.title || '').trim()
        if (label) return label
        if (!author(n)) break
      }
      return ''
    },
    attr(id, name) {
      const at = where.get(id)
      return at ? (attrs(at.doc, at.node)[name] ?? '') : ''
    },
    ancestors(id) {
      const at = where.get(id)
      if (!at) return []
      const nodes = snap.documents[at.doc].nodes
      const out: number[] = []
      for (let n = nodes.parentIndex?.[at.node] ?? -1; n >= 0; n = nodes.parentIndex?.[n] ?? -1) out.push(nodes.backendNodeId?.[n] ?? -1)
      return out
    },
    text(id) {
      const at = where.get(id)
      if (!at) return ''
      const nodes = snap.documents[at.doc].nodes
      let out = ''
      const walk = (n: number) => {
        if (out.length > 80) return
        if (nodes.nodeType?.[n] === 3) {
          const t = s(nodes.nodeValue?.[n]).replace(/\s+/g, ' ').trim()
          if (t) out += (out ? ' ' : '') + t
        }
        const name = s(nodes.nodeName?.[n])
        if (name === 'SCRIPT' || name === 'STYLE') return
        // A photo or video tile says what it is through its picture.
        if (name === 'IMG') { const alt = (attrs(at.doc, n).alt ?? '').trim(); if (alt) out += (out ? ' ' : '') + alt }
        for (const c of children[at.doc][n]) walk(c)
      }
      walk(at.node)
      return out
    },
  }
}

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
])
/** Only items when the page made them clickable or focusable (WhatsApp chat rows). */
const ROWS = new Set(['row', 'gridcell', 'cell', 'listitem', 'article'])
/** Read, not acted on: what an agent must notice after an action. */
const ANNOUNCE = new Set(['alert', 'alertdialog', 'dialog', 'status'])
/** Layers drawn over the page: pickers, menus, modals. Snapshots can be narrowed to one. */
export const POPUP_ROLES = new Set(['dialog', 'alertdialog', 'menu', 'listbox'])
const LANDMARKS = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region'])
const NOT_ITEMS = new Set(['RootWebArea', 'WebArea', 'Iframe', 'StaticText', 'InlineTextBox', 'LineBreak', ...LANDMARKS])
const TEXT_INPUT = new Set(['textbox', 'searchbox', 'combobox'])
const SECRET_NAME = /password|passcode|\botp\b|one.?time|verification code|security code|\bpin\b|cvv|cvc|card number/i
const MASK = '••••'

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
const prop = (n: AXNode, name: string) => n.properties?.find(p => p.name === name)?.value?.value

function statesOf(n: AXNode): string[] {
  const out: string[] = []
  for (const name of ['focused', 'disabled', 'required', 'readonly', 'expanded', 'selected', 'modal']) {
    const v = prop(n, name)
    if (v === true) out.push(name)
    else if (name === 'expanded' && v === false) out.push('collapsed')
  }
  const checked = prop(n, 'checked') ?? prop(n, 'pressed')
  if (checked === 'true' || checked === true) out.push('checked')
  else if (checked === 'mixed') out.push('mixed')
  return out
}

/**
 * The role the agent sees. A contenteditable box with no role (editors, chat
 * composers) is still where text goes: the focusable root of it is a textbox.
 * Used by the snapshot and by the check before an action, so both agree.
 */
export function roleOf(n: Pick<AXNode, 'role' | 'properties'>): string {
  const role = str(n.role?.value)
  const editable = str(prop(n as AXNode, 'editable'))
  if ((editable === 'richtext' || editable === 'plaintext') && prop(n as AXNode, 'focusable') === true && !INTERACTIVE.has(role)) return 'textbox'
  return role
}

/** Masks values a screen should never echo back: passwords, card numbers, one-time codes. */
export function maskValue(value: string, name: string, sensitiveDom: boolean): string {
  return value && (sensitiveDom || SECRET_NAME.test(name)) ? MASK : value
}

export interface CapturedFrame { frameId: string; loaderId: string; nodes: AXNode[] }

export interface CaptureInput {
  url: string
  title: string
  frames: CapturedFrame[]
  dom: DomFacts
  scrollY: number
  viewportHeight: number
  pageHeight: number
}

export function buildPageMap(input: CaptureInput, refs: RefTable): PageMap {
  const { dom } = input
  const items: PageItem[] = []
  const landmarks: string[] = []

  for (const frame of input.frames) {
    for (const n of frame.nodes) {
      const id = n.backendDOMNodeId
      if (id == null) continue
      if (n.ignored) {
        // Hover toolbars and custom menus are often inside aria-hidden yet on screen and clickable
        // (Messenger's React / Reply / More): list them, marked, when they carry a label.
        const label = (dom.attr(id, 'aria-label') || dom.attr(id, 'title')).replace(/\s+/g, ' ').trim()
        const rect = dom.rect(id)
        if (!label || !rect || rect.w < 4 || rect.h < 4 || !(dom.clickable(id) || dom.attr(id, 'role') === 'button')) continue
        if (rect.y + rect.h <= input.scrollY || rect.y >= input.scrollY + input.viewportHeight) continue
        const role = dom.attr(id, 'role') || 'button'
        items.push({
          ref: refs.refFor(frame.frameId, frame.loaderId, id, role, label),
          role, name: label.length > 80 ? `${label.slice(0, 79)}…` : label,
          states: ['aria-hidden'], inViewport: true, frameId: frame.frameId, ...rect,
        })
        continue
      }
      let role = roleOf(n)
      let name = str(n.name?.value).replace(/\s+/g, ' ').trim()

      if (LANDMARKS.has(role)) {
        if (role !== 'region' || name) landmarks.push(name ? `${role} "${name}"` : role)
        continue
      }
      if (NOT_ITEMS.has(role)) continue
      const focusable = prop(n, 'focusable') === true
      // Gallery tiles and list rows whose click is caught by a wrapper a few levels up.
      const viaParent = ROWS.has(role) && !dom.clickable(id) && !focusable && dom.ancestors(id).slice(0, 3).some(a => dom.clickable(a))
      // A toast or inline error is often a plain div marked aria-live: read it as a status line.
      const live = str(prop(n, 'live'))
      if ((live === 'polite' || live === 'assertive') && !ANNOUNCE.has(role) && !INTERACTIVE.has(role)) role = live === 'assertive' ? 'alert' : 'status'
      const keep = INTERACTIVE.has(role) || role === 'heading'
        || (ROWS.has(role) && (dom.clickable(id) || focusable || viaParent))
        || ANNOUNCE.has(role)
        // Menus and other layers are items too, so a snapshot can be narrowed to the one on top.
        || POPUP_ROLES.has(role)
        // Clickable divs with no role: only worth listing when they say something.
        || (dom.clickable(id) && (role === 'generic' || role === 'image' || role === 'none'))
      if (!keep) continue

      if (!name && TEXT_INPUT.has(role)) name = dom.hostLabel(id)
      // Avatar and picture links often have no name at all: say where they go.
      if (!name && role === 'link') { const href = dom.attr(id, 'href'); if (href && !href.startsWith('javascript:')) name = `→ ${href.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70)}` }
      if (!name && !INTERACTIVE.has(role)) name = dom.text(id)
      if (!name && (role === 'generic' || role === 'alert' || role === 'status' || ROWS.has(role))) continue

      const rect = dom.rect(id)
      if (rect && rect.w === 0 && rect.h === 0) continue
      const item: PageItem = {
        ref: refs.refFor(frame.frameId, frame.loaderId, id, role, name),
        role,
        name: name.length > 80 ? `${name.slice(0, 79)}…` : name,
        states: viaParent ? [...statesOf(n), 'click via parent'] : statesOf(n),
        inViewport: !!rect && rect.y + rect.h > input.scrollY && rect.y < input.scrollY + input.viewportHeight,
        frameId: frame.frameId,
      }
      const raw = n.value?.value
      if (raw != null && (TEXT_INPUT.has(role) || role === 'slider' || role === 'spinbutton')) {
        const v = maskValue(str(raw), name, dom.sensitive(id))
        item.value = v.length > 120 ? `${v.slice(0, 119)}…` : v
      }
      const level = prop(n, 'level')
      if (role === 'heading' && typeof level === 'number') item.level = level
      // chisle: rects of same-process iframes are frame-relative; actions use live box models, so only inViewport is off there.
      if (rect) Object.assign(item, rect)
      items.push(item)
    }
  }

  return { url: input.url, title: input.title, scrollY: input.scrollY, viewportHeight: input.viewportHeight, pageHeight: input.pageHeight, landmarks, items }
}

/** One line per item: `[e12] button "Send" (disabled)`. */
export function itemLine(i: PageItem): string {
  const states = [...(i.level ? [`h${i.level}`] : []), ...i.states]
  return `[${i.ref}] ${i.role} "${i.name}"${i.value !== undefined ? ` = "${i.value}"` : ''}${states.length ? ` (${states.join(', ')})` : ''}`
}

const header = (m: PageMap) => `${m.title || '(no title)'} — ${m.url}`
const scrollLine = (m: PageMap) => `scroll ${Math.round(m.scrollY)} of ${Math.round(m.pageHeight)}px, viewport ${Math.round(m.viewportHeight)}px`

function counts(items: PageItem[]): string {
  const by = new Map<string, number>()
  for (const i of items) by.set(i.role, (by.get(i.role) ?? 0) + 1)
  return [...by].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} ${r}`).join(', ')
}

export interface SummaryOptions {
  /** `viewport` (default) lists what is on screen; `all` lists the whole page. */
  scope?: 'viewport' | 'all'
  limit?: number
  /** The map before the last step: what appeared since goes first when not everything fits. */
  prev?: PageMap | null
}

const inside = (i: PageItem, box: PageItem) =>
  i.x != null && i.y != null && i.w != null && i.h != null && box.x != null && box.y != null && box.w != null && box.h != null &&
  i.x >= box.x - 1 && i.y >= box.y - 1 && i.x + i.w <= box.x + box.w + 1 && i.y + i.h <= box.y + box.h + 1

/**
 * Which items fit in `limit`. Busy pages (a chat list, a feed) hold hundreds
 * of controls, and what the agent needs next is usually what just opened: the
 * open dialog or menu, then whatever appeared since the last step, then the
 * end of the page, where sites mount their overlays (a media preview with its
 * Send button sat past the first 150 items on WhatsApp). The rest fills up in
 * page order; the list keeps page order.
 */
export function pickItems(items: PageItem[], limit: number, prev?: PageMap | null): PageItem[] {
  if (items.length <= limit) return items
  const popup = items.filter(i => POPUP_ROLES.has(i.role) && i.inViewport && i.w && i.h).at(-1)
  const seen = prev ? new Set(prev.items.map(i => i.ref)) : null
  const first = new Set<PageItem>()
  if (popup) for (const i of items) if (i === popup || inside(i, popup)) first.add(i)
  if (seen) for (const i of items) if (!seen.has(i.ref)) first.add(i)
  const chosen = new Set([...first].slice(0, limit))
  const rest = items.filter(i => !chosen.has(i))
  const room = limit - chosen.size
  const head = Math.ceil(room * 2 / 3)
  for (const i of rest.slice(0, head)) chosen.add(i)
  if (room > head) for (const i of rest.slice(head).slice(-(room - head))) chosen.add(i)
  return items.filter(i => chosen.has(i))
}

/** Summary first (page, landmarks, headings, counts), then the item lines in scope. */
export function formatSummary(m: PageMap, opts: SummaryOptions = {}): string {
  const scope = opts.scope ?? 'viewport'
  const limit = opts.limit ?? (scope === 'all' ? 400 : 150)
  const listed = pickItems(scope === 'all' ? m.items : m.items.filter(i => i.inViewport), limit, opts.prev)
  const shown = new Set(listed)
  const rest = m.items.filter(i => !shown.has(i))
  const headings = m.items.filter(i => i.role === 'heading').slice(0, 10).map(i => `h${i.level ?? '?'} "${i.name}"`)
  const lines = [
    header(m),
    `${scrollLine(m)} · ${m.items.length} items, ${m.items.filter(i => i.inViewport).length} in view`,
  ]
  if (m.landmarks.length) lines.push(`landmarks: ${m.landmarks.slice(0, 12).join(', ')}`)
  if (headings.length) lines.push(`headings: ${headings.join(' · ')}`)
  const popups = m.items.filter(i => POPUP_ROLES.has(i.role) && i.inViewport && i.w && i.h)
  if (popups.length) lines.push(`open over the page: ${popups.slice(-3).map(i => `[${i.ref}] ${i.role} "${i.name}"`).join(', ')} — snapshot with within: "popup" (or a ref) to list only what is inside`)
  lines.push(scope === 'all' ? 'page:' : 'in view:', ...listed.map(itemLine))
  const cut = (scope === 'all' ? m.items : m.items.filter(i => i.inViewport)).length > listed.length
  if (rest.length) lines.push(`… ${rest.length} more not listed (${counts(rest)}) — scope "all" or scroll to see them${cut ? '; this list put what just opened first (a dialog, new items, the end of the page)' : ''}`)
  return lines.join('\n')
}

/** Share of the full text a delta may reach before the full text is sent instead. */
export const FULL_RATIO = 0.7

/** `[e3] button "Send" (disabled)` → `[e3] button "Send"`: enough to say what went away. */
const shortLine = (line: string) => line.slice(0, line.indexOf('"', line.indexOf('"') + 1) + 1)

/**
 * What changed on screen between two maps: `unchanged`, a `delta` of lines
 * (`+` appeared, `-` gone, `~` changed), or the `full` summary when the page is
 * new or the delta would be ≥70% of it anyway.
 */
export function diffMaps(prev: PageMap | null, next: PageMap): SnapshotDiff {
  const full = formatSummary(next, { prev: prev?.url === next.url ? prev : null })
  if (!prev || prev.url !== next.url) return { mode: 'full', text: full }

  const before = new Map(prev.items.filter(i => i.inViewport).map(i => [i.ref, itemLine(i)]))
  const after = new Map(next.items.filter(i => i.inViewport).map(i => [i.ref, itemLine(i)]))
  const lines: string[] = []
  if (prev.title !== next.title) lines.push(`title: "${next.title}"`)
  if (Math.round(prev.scrollY) !== Math.round(next.scrollY) || Math.round(prev.pageHeight) !== Math.round(next.pageHeight)) lines.push(scrollLine(next))
  for (const [ref, line] of after) {
    const old = before.get(ref)
    if (old === undefined) lines.push(`+ ${line}`)
    else if (old !== line) lines.push(`~ ${line}`)
  }
  for (const [ref, line] of before) if (!after.has(ref)) lines.push(`- ${shortLine(line)}`)

  if (!lines.length) return { mode: 'unchanged', text: 'no visible change' }
  const text = lines.join('\n')
  return text.length >= full.length * FULL_RATIO ? { mode: 'full', text: full } : { mode: 'delta', text }
}
