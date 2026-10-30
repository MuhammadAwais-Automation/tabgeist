import type { CdpListener, PageTarget } from './target'
import { RefTable } from './refs'
import { buildPageMap, domFacts, POPUP_ROLES, type AXNode, type CapturedFrame, type DomFacts, type DOMSnapshotResult } from './serialize'
import type { PageItem, PageMap } from './types'

/**
 * Reads a page through the DevTools protocol in a few bulk calls: the AX tree
 * per frame, one DOM snapshot (rects, click listeners, shadow roots) and the
 * layout metrics. `Runtime.enable` is never sent — anti-bot scripts detect it.
 */

export type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

const holds = new WeakMap<PageTarget, { n: number; own: boolean }>()

/**
 * Runs `fn` with the debugger attached. Other Tabgeist code (keepAwake, capture
 * recorders) may already hold it: then it is borrowed and left attached.
 * Calls that overlap (a timeline picture still being taken while the next
 * step starts) share one attachment; the last one out detaches.
 */
export async function withDebugger<T>(wc: PageTarget, fn: (send: Send) => Promise<T>): Promise<T> {
  let h = holds.get(wc)
  if (!h || h.n === 0) {
    h = { n: 0, own: !wc.debugger.isAttached() }
    if (h.own) wc.debugger.attach('1.3')
    holds.set(wc, h)
  }
  h.n++
  const send: Send = (method, params) => wc.debugger.sendCommand(method, params)
  try { return await fn(send) } finally {
    h.n--
    if (h.n === 0 && h.own && !wc.isDestroyed()) { try { wc.debugger.detach() } catch { /* already gone */ } }
  }
}

interface FrameTreeNode { frame: { id: string; loaderId: string }; childFrames?: FrameTreeNode[] }

export async function liveFrames(send: Send): Promise<{ id: string; loaderId: string }[]> {
  const { frameTree } = await send('Page.getFrameTree') as { frameTree: FrameTreeNode }
  const out: { id: string; loaderId: string }[] = []
  const walk = (n: FrameTreeNode) => { out.push({ id: n.frame.id, loaderId: n.frame.loaderId }); n.childFrames?.forEach(walk) }
  walk(frameTree)
  return out
}

interface PageState { refs: RefTable; last: PageMap | null; dom?: DomFacts }
const states = new Map<number, PageState>()

/** Refs and the last map the agent saw, one per page; dropped with the page. */
export function stateFor(wc: PageTarget): PageState {
  let s = states.get(wc.id)
  if (!s) {
    s = { refs: new RefTable(), last: null }
    states.set(wc.id, s)
    const id = wc.id
    wc.once('destroyed', () => states.delete(id))
  }
  return s
}

interface LayoutMetrics {
  cssVisualViewport?: { pageX?: number; pageY: number; clientHeight: number }
  cssContentSize?: { height: number }
}

/** An out-of-process iframe (another site inside the page) reached through its own CDP session. */
export interface ChildFrame {
  frameId: string
  loaderId: string
  /** backendNodeId of the <iframe> element in the parent page. */
  ownerId: number
  send: Send
}

/**
 * Cross-site iframes run in their own process: they are missing from the
 * page's frame tree and answer only on their own target session (probe:
 * perception-research/bench/oopif-probe.mjs). Found via Target.getTargets by
 * parentFrameId; one level deep. Sessions are detached by `release`.
 */
export async function attachChildFrames(wc: PageTarget, send: Send, parentIds: Set<string>): Promise<{ frames: ChildFrame[]; release: () => Promise<void> }> {
  const sessions: string[] = []
  const frames: ChildFrame[] = []
  type Info = { targetId: string; type: string; parentFrameId?: string }
  const listed = await send('Target.getTargets').catch(() => null) as { targetInfos: Info[] } | null
  // chrome.debugger (the extension) refuses Target.getTargets; there the frames come from auto-attach.
  const auto = listed ? null : await autoAttached(wc, send)
  const targets: (Info & { sessionId?: string })[] = listed?.targetInfos ?? auto ?? []
  for (const t of targets) {
    if (t.type !== 'iframe' || !t.parentFrameId || !parentIds.has(t.parentFrameId)) continue
    try {
      const { sessionId } = t.sessionId ? { sessionId: t.sessionId } : await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }) as { sessionId: string }
      if (!t.sessionId) sessions.push(sessionId)
      const childSend: Send = (method, params) => wc.debugger.sendCommand(method, params, sessionId)
      const { frameTree } = await childSend('Page.getFrameTree') as { frameTree: FrameTreeNode }
      const { backendNodeId } = await send('DOM.getFrameOwner', { frameId: frameTree.frame.id }) as { backendNodeId: number }
      frames.push({ frameId: frameTree.frame.id, loaderId: frameTree.frame.loaderId, ownerId: backendNodeId, send: childSend })
    } catch { /* the iframe went away while attaching */ }
  }
  const release = async () => {
    await Promise.all(sessions.map(sessionId => send('Target.detachFromTarget', { sessionId }).catch(() => {})))
    if (auto) await send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
  }
  return { frames, release }
}

/**
 * The page's out-of-process iframes, attached by Target.setAutoAttach: it reports
 * each one as Target.attachedToTarget with a ready session. Switched off first, so
 * frames attached by an earlier call are reported again.
 */
async function autoAttached(wc: PageTarget, send: Send): Promise<{ targetId: string; type: string; parentFrameId?: string; sessionId: string }[]> {
  const got: { targetId: string; type: string; parentFrameId?: string; sessionId: string }[] = []
  const onMessage: CdpListener = (_e, method, params, sessionId) => {
    if (method === 'Target.attachedToTarget' && !sessionId && params?.targetInfo) got.push({ ...params.targetInfo, sessionId: params.sessionId })
  }
  wc.debugger.on('message', onMessage)
  try {
    await send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
    const ok = await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).then(() => true, () => false)
    // The events arrive with or just after the reply.
    if (ok) await new Promise(r => setTimeout(r, 120))
  } finally { wc.debugger.removeListener('message', onMessage) }
  return got
}

/** Top-left of an <iframe>'s content box in viewport coordinates; child-frame boxes are relative to it. */
export async function frameOrigin(send: Send, ownerId: number): Promise<{ x: number; y: number } | null> {
  const r = await send('DOM.getBoxModel', { backendNodeId: ownerId }).catch(() => null) as { model: { content: number[] } } | null
  return r ? { x: r.model.content[0], y: r.model.content[1] } : null
}

/** Items of the cross-site iframes, positioned on the parent page. */
async function childItems(wc: PageTarget, send: Send, parentIds: Set<string>, state: PageState, page: { scrollX: number; scrollY: number; viewportHeight: number; pageHeight: number; url: string }): Promise<{ items: PageMap['items']; loaderIds: string[] }> {
  const { frames, release } = await attachChildFrames(wc, send, parentIds)
  const items: PageMap['items'] = []
  try {
    await Promise.all(frames.map(async f => {
      await f.send('Accessibility.enable').catch(() => {})
      const [tree, dom, origin] = await Promise.all([
        f.send('Accessibility.getFullAXTree') as Promise<{ nodes: AXNode[] }>,
        f.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }) as Promise<DOMSnapshotResult>,
        frameOrigin(send, f.ownerId),
      ])
      if (!origin) return
      const top = origin.y + page.scrollY, left = origin.x + page.scrollX
      const sub = buildPageMap({
        url: page.url, title: '', frames: [{ frameId: f.frameId, loaderId: f.loaderId, nodes: tree.nodes }], dom: domFacts(dom),
        scrollY: page.scrollY - top, viewportHeight: page.viewportHeight, pageHeight: page.pageHeight,
      }, state.refs)
      for (const i of sub.items) {
        if (i.x != null) i.x += left
        if (i.y != null) i.y += top
        items.push(i)
      }
    }))
  } catch { /* an iframe that cannot be read leaves the parent map intact */ } finally {
    await release()
  }
  return { items, loaderIds: frames.map(f => f.loaderId) }
}

/**
 * A cheap "did the page move" fingerprint for settle loops: url, title, element
 * count and text length. ~1 ms, versus a full map per poll (60–300 ms) — the
 * MVP's settle re-captured the whole page every 150 ms.
 */
export async function pageSignature(send: Send): Promise<string> {
  const expression = `location.href + '|' + document.title + '|' + document.getElementsByTagName('*').length + '|' + (document.body ? document.body.textContent.length : 0)`
  const r = await send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => null) as { result?: { value?: string } } | null
  return r?.result?.value ?? ''
}

/** A fresh map of the page; it becomes the map later diffs compare against. */
export async function snapshotPage(wc: PageTarget): Promise<PageMap> {
  const state = stateFor(wc)
  const started = Date.now()
  const map = await withDebugger(wc, async send => {
    const [frames] = await Promise.all([liveFrames(send), send('Accessibility.enable').catch(() => {})])
    // Every read in flight at once: the frames' AX trees no longer wait on each other or on the DOM snapshot.
    const [dom, metrics, ...trees] = await Promise.all([
      send('DOMSnapshot.captureSnapshot', { computedStyles: [] }) as Promise<DOMSnapshotResult>,
      send('Page.getLayoutMetrics') as Promise<LayoutMetrics>,
      ...frames.map(f => (send('Accessibility.getFullAXTree', { frameId: f.id }) as Promise<{ nodes: AXNode[] }>)
        // Out-of-process iframes answer only on their own target session.
        .catch(() => null)),
    ])
    const captured: CapturedFrame[] = []
    trees.forEach((t, i) => { if (t) captured.push({ frameId: frames[i].id, loaderId: frames[i].loaderId, nodes: t.nodes }) })
    const page = {
      url: wc.getURL(),
      scrollX: metrics.cssVisualViewport?.pageX ?? 0,
      scrollY: metrics.cssVisualViewport?.pageY ?? 0,
      viewportHeight: metrics.cssVisualViewport?.clientHeight ?? 0,
      pageHeight: metrics.cssContentSize?.height ?? 0,
    }
    const facts = domFacts(dom)
    state.dom = facts
    const main = buildPageMap({ ...page, title: wc.getTitle(), frames: captured, dom: facts }, state.refs)
    const kids = await childItems(wc, send, new Set(frames.map(f => f.id)), state, page)
    main.items.push(...kids.items)
    main.iframes = kids.loaderIds.length
    // Only after the iframes were read: their refs would otherwise be dropped and renumbered on every snapshot.
    state.refs.forgetDocumentsExcept(new Set([...frames.map(f => f.loaderId), ...kids.loaderIds]))
    return main
  })
  map.ms = Date.now() - started
  state.last = map
  return map
}

// Runs on the layer's element: is it what the page draws at its own centre (a toast or a second modal is not)?
const ON_TOP = `function () {
  const r = this.getBoundingClientRect()
  let n = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  while (n) { if (n === this) return true; n = n.parentNode || n.host }
  return false
}`

/**
 * Of several layers open at once (a menu inside a dialog, a dialog over a
 * listbox), the one the user sees on top: the last one in page order that the
 * page draws at its own centre; else the last one.
 */
async function topmost(wc: PageTarget, layers: PageItem[]): Promise<PageItem | undefined> {
  if (layers.length < 2) return layers[0]
  const refs = stateFor(wc).refs
  const hit = await withDebugger(wc, async send => {
    for (const l of [...layers].reverse()) {
      const e = refs.get(l.ref)
      const obj = e && await send('DOM.resolveNode', { backendNodeId: e.backendNodeId }).catch(() => null) as { object?: { objectId?: string } } | null
      if (!obj?.object?.objectId) continue
      const r = await send('Runtime.callFunctionOn', { objectId: obj.object.objectId, functionDeclaration: ON_TOP, returnByValue: true }).catch(() => null) as { result?: { value?: boolean } } | null
      if (r?.result?.value === true) return l
    }
    return undefined
  }).catch(() => undefined)
  return hit ?? layers[layers.length - 1]
}

/**
 * The map cut down to one element and what is inside it: `popup` picks the
 * layer on top (a picker, menu or modal), or give a ref. Everything inside
 * counts as in view, so a scrolled picker lists whole.
 */
export async function narrowMap(wc: PageTarget, map: PageMap, within: string): Promise<{ map: PageMap; container: PageItem } | string> {
  const state = stateFor(wc)
  const want = within.trim().replace(/^@/, '')
  const container = want === 'popup'
    ? await topmost(wc, map.items.filter(i => POPUP_ROLES.has(i.role) && i.w && i.h))
    : map.items.find(i => i.ref === want)
  if (!state.dom) return 'take a snapshot first'
  // No dialog/menu role (Messenger's reaction bar): the nearest element holding every visible menu item.
  if (!container && want === 'popup') {
    const opts = map.items.filter(i => /^(menuitem|menuitemradio|menuitemcheckbox|option)$/.test(i.role) && i.inViewport)
    const ids = opts.map(i => state.refs.get(i.ref)?.backendNodeId).filter((n): n is number => n != null)
    const chains = ids.map(id => state.dom!.ancestors(id))
    const common = chains.length ? chains[0].find(a => chains.every(c => c.includes(a))) : undefined
    if (common != null) {
      const frameId = state.refs.get(opts[0].ref)!.frameId
      const inside = map.items.filter(i => { const e = state.refs.get(i.ref); return !!e && e.frameId === frameId && state.dom!.ancestors(e.backendNodeId).includes(common) })
      const group: PageItem = { ref: 'popup', role: 'group', name: 'menu items shown over the page', states: [], inViewport: true, frameId }
      return { map: { ...map, items: [group, ...inside.map(i => ({ ...i, inViewport: true }))] }, container: group }
    }
  }
  if (!container) return want === 'popup' ? 'nothing is open over the page (no dialog, menu or list); take a normal snapshot' : `unknown ref ${want}; take a new snapshot`
  const box = state.refs.get(container.ref)
  if (!box) return 'take a snapshot first'
  const items = map.items.filter(i => {
    if (i === container) return true
    const e = state.refs.get(i.ref)
    return !!e && e.frameId === box.frameId && state.dom!.ancestors(e.backendNodeId).includes(box.backendNodeId)
  }).map(i => ({ ...i, inViewport: true }))
  return { map: { ...map, items }, container }
}
