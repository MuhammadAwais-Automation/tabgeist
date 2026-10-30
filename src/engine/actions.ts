import { whileAwake, type CdpListener, type PageTarget } from './target'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import { catchData } from './data'
import { downloadsSince } from './downloads'
import { attachChildFrames, frameOrigin, liveFrames, pageSignature, snapshotPage, stateFor, withDebugger, type Send } from './capture'
import { summarizeRequests, type SeenRequest } from './routes'
import { fillVars, refind, stableAttrs, StepRecorder, type Fingerprint, type RefindLevel, type Routine, type RoutineStep } from './routines'
import { confirmReason, type SafetyContext } from './safety'

import { diffMaps, maskValue, roleOf, type AXNode } from './serialize'
import type { ActionKind, ActionReceipt, PageMap, RefEntry, SocketTraffic } from './types'

/**
 * Acts on an element by ref, the way a person would (real mouse and key events
 * through CDP), then waits for the page to settle and returns a receipt with
 * what changed. A ref that no longer points at the same element fails closed.
 */

export interface ActRequest {
  action: ActionKind
  ref?: string
  text?: string
  value?: string
  key?: string
  direction?: 'up' | 'down'
  /** type: replace what the field holds instead of adding to it. */
  clear?: boolean
  /** The user said yes to this exact action in chat. */
  confirm?: boolean
  /** upload / drop: absolute paths of local files. */
  files?: string[]
  /** drag: the element to drop onto. */
  toRef?: string
  /** click / dblclick / rightclick / hover at a point of the screenshot instead of a ref (canvas, maps, unlisted areas). */
  at?: { x: number; y: number }
  /** drag by points: where to drop (viewport px), when there is no toRef. */
  toAt?: { x: number; y: number }
  /** wait: text that must appear on the page. */
  waitText?: string
  /** wait: text that must go away (a spinner, "Loading…", "Uploading 40%"). */
  waitGone?: string
  /** wait: how long at most (or exactly, without text), in ms. */
  ms?: number
}

const ACTIONS: readonly ActionKind[] = ['click', 'dblclick', 'rightclick', 'drag', 'drop', 'type', 'paste', 'select', 'scroll', 'key', 'hover', 'upload', 'wait']
const NEEDS_REF: readonly ActionKind[] = ['click', 'dblclick', 'rightclick', 'drag', 'drop', 'type', 'paste', 'select', 'hover', 'upload']
export const MAX_WAIT_MS = 15_000
const MAX_FILES = 10
/** Pasted files travel into the page as base64, so they stay small. */
const MAX_PASTE_BYTES = 10 * 1024 * 1024
/** Actions that can aim at a screen point when nothing on the page has a ref. */
const POINTABLE: readonly ActionKind[] = ['click', 'dblclick', 'rightclick', 'hover', 'drop', 'drag']

/** Validates gateway params; returns the request or an error message. */
export function parseActRequest(p: Record<string, unknown>): ActRequest | string {
  const action = p.action as ActionKind
  if (!ACTIONS.includes(action)) return `action must be one of ${ACTIONS.join(', ')}`
  const req: ActRequest = { action, clear: p.clear === true, confirm: p.confirm === true }
  if (p.ref != null) {
    if (typeof p.ref !== 'string' || !/^@?e\d+$/.test(p.ref.trim())) return 'ref must look like e12 (from browser_snapshot)'
    req.ref = p.ref.trim().replace(/^@/, '')
  }
  if (!req.ref && POINTABLE.includes(action) && typeof p.x === 'number' && typeof p.y === 'number' && p.x >= 0 && p.y >= 0) req.at = { x: p.x, y: p.y }
  if (NEEDS_REF.includes(action) && !req.ref && !req.at) return `${action} needs a ref${POINTABLE.includes(action) ? ' (or x and y from chrome_screenshot)' : ''}`
  if (action === 'type') {
    if (typeof p.text !== 'string') return 'type needs text'
    if (p.text.length > 10_000) return 'text is longer than 10000 characters'
    req.text = p.text
  }
  if (action === 'select') {
    if (typeof p.value !== 'string' || !p.value) return 'select needs value (the option text or value)'
    req.value = p.value
  }
  if (action === 'key') {
    if (typeof p.key !== 'string' || !keyDef(p.key)) return `key must be one character or one of ${Object.keys(KEYS).join(', ')}`
    req.key = p.key
  }
  if (action === 'scroll') req.direction = p.direction === 'up' ? 'up' : 'down'
  if (action === 'drag') {
    if (typeof p.toRef === 'string' && /^@?e\d+$/.test(p.toRef.trim())) req.toRef = p.toRef.trim().replace(/^@/, '')
    else if (typeof p.toX === 'number' && typeof p.toY === 'number' && p.toX >= 0 && p.toY >= 0) req.toAt = { x: p.toX, y: p.toY }
    else return 'drag needs toRef (the element to drop onto) or toX and toY'
    if (req.at && !req.toAt) return 'drag from a point needs toX and toY'
  }
  if (action === 'paste') {
    if (p.text != null && typeof p.text !== 'string') return 'paste text must be a string'
    if (typeof p.text === 'string') req.text = p.text
  }
  if (action === 'upload' || action === 'drop' || (action === 'paste' && p.files != null)) {
    const files = Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
    if (!files.length) return `${action} needs files: absolute paths of local files`
    if (action === 'paste' && files.some(f => existsSync(f) && statSync(f).size > MAX_PASTE_BYTES)) return `paste takes files up to ${MAX_PASTE_BYTES / 1024 / 1024} MB; use upload for bigger ones`
    if (files.length > MAX_FILES) return `at most ${MAX_FILES} files per upload`
    const bad = files.find(f => !isAbsolute(f) || !existsSync(f) || !statSync(f).isFile())
    if (bad) return `not a local file: ${bad}`
    req.files = files
  }
  if (action === 'paste' && req.text == null && !req.files) return 'paste needs text or files'
  if (action === 'wait') {
    if (p.text != null && (typeof p.text !== 'string' || !p.text.trim())) return 'wait text must be non-empty'
    if (p.gone != null && (typeof p.gone !== 'string' || !p.gone.trim())) return 'wait gone must be non-empty'
    if (typeof p.text === 'string') req.waitText = p.text.trim()
    if (typeof p.gone === 'string') req.waitGone = p.gone.trim()
    const ms = typeof p.ms === 'number' && p.ms > 0 ? Math.min(p.ms, MAX_WAIT_MS) : undefined
    if (!req.waitText && !req.waitGone && !ms) return 'wait needs text (to appear), gone (to disappear) or ms'
    req.ms = ms ?? 10_000
  }
  return req
}

/** Most steps one browser_act call may carry. */
export const MAX_STEPS = 20

/**
 * One action, or `steps: [...]` run in order in a single call — one receipt
 * instead of a model round-trip per step (Comet's ComputerBatch; UFO2 saw
 * ~50% less inference with batched actions).
 */
export function parseActRequests(p: Record<string, unknown>): ActRequest[] | string {
  if (p.steps == null) {
    const one = parseActRequest(p)
    return typeof one === 'string' ? one : [one]
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) return 'steps must be a non-empty list'
  if (p.steps.length > MAX_STEPS) return `at most ${MAX_STEPS} steps per call`
  const out: ActRequest[] = []
  for (const [i, s] of p.steps.entries()) {
    if (!s || typeof s !== 'object') return `step ${i + 1}: must be an object`
    // confirm on the call applies to every step: the user said yes to the whole list.
    const one = parseActRequest({ ...(s as Record<string, unknown>), confirm: p.confirm === true || (s as Record<string, unknown>).confirm === true })
    if (typeof one === 'string') return `step ${i + 1}: ${one}`
    out.push(one)
  }
  return out
}

const ANNOUNCE_ROLES = new Set(['alert', 'alertdialog', 'dialog', 'status'])

/** Alert, toast, status and dialog lines that are new since `before` — what a screen reader would speak. */
export function announcements(before: PageMap, after: PageMap): string[] {
  const seen = new Set(before.items.filter(i => ANNOUNCE_ROLES.has(i.role)).map(i => `${i.role}|${i.name}`))
  return after.items
    .filter(i => ANNOUNCE_ROLES.has(i.role) && !seen.has(`${i.role}|${i.name}`))
    .map(i => `${i.role}: ${i.name}`)
}

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Space: { code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
}

/** The CDP key event fields for a named key or a single character. */
export function keyDef(key: string): { key: string; code: string; vk: number; text?: string } | null {
  const named = KEYS[key]
  if (named) return { key: key === 'Space' ? ' ' : key, ...named }
  if ([...key].length !== 1) return null
  const upper = key.toUpperCase()
  const letter = /[A-Z]/.test(upper)
  const digit = /[0-9]/.test(key)
  return { key, code: letter ? `Key${upper}` : digit ? `Digit${key}` : '', vk: letter || digit ? upper.charCodeAt(0) : 0, text: key }
}

/**
 * Null when the element now in place is still the one the agent saw, else why
 * not. An empty live name is accepted: inputs named from their shadow host
 * have no AX name of their own.
 */
export function targetMismatch(entry: Pick<RefEntry, 'role' | 'name'>, now: { role: string; name: string } | null): string | null {
  if (!now) return 'the element is gone; take a new browser_snapshot'
  if (now.role !== entry.role) return `the element changed (was ${entry.role} "${entry.name}", now ${now.role} "${now.name}"); take a new browser_snapshot`
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const was = norm(entry.name).replace(/…$/, ''), is = norm(now.name)
  // Live labels grow and shrink ("Sara Khan click here for contact info" ↔ "Sara Khan", "3 unread · Ali" ↔ "Ali"):
  // the same element still passes while one name holds the other.
  const holds = (long: string, short: string) => short.length >= 3 && long.includes(short)
  if (is && was && !is.startsWith(was) && !holds(is, was) && !holds(was, is)) {
    return `the element changed (was ${entry.role} "${entry.name}", now "${now.name}"); take a new browser_snapshot`
  }
  return null
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Reads until two reads in a row agree (the page went quiet), at most `capMs`.
 * No fixed long sleep: a page that is already done answers in ~2 reads.
 */
export async function settle<T>(read: () => Promise<T>, same: (a: T, b: T) => boolean, opts = { firstMs: 100, quietMs: 150, capMs: 750 }): Promise<T> {
  const start = Date.now()
  await sleep(opts.firstMs)
  let prev = await read()
  while (Date.now() - start < opts.capMs) {
    await sleep(opts.quietMs)
    const next = await read()
    if (same(prev, next)) return next
    prev = next
  }
  return prev
}

function waitLoaded(wc: PageTarget, ms = 5000): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); wc.removeListener('did-stop-loading', done); resolve() }
    const t = setTimeout(done, ms)
    wc.once('did-stop-loading', done)
  })
}

async function centerOf(send: Send, backendNodeId: number): Promise<{ x: number; y: number }> {
  await send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
  const read = async () => {
    const { model } = await send('DOM.getBoxModel', { backendNodeId }) as { model: { content: number[] } }
    const q = model.content
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
  }
  // Images still loading push things around after the scroll: aim once the element stops moving.
  let at = await read()
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 80))
    const now = await read()
    if (Math.abs(now.x - at.x) < 1 && Math.abs(now.y - at.y) < 1) return now
    at = now
  }
  return at
}

async function pressKey(send: Send, key: string, modifiers = 0, commands?: string[]): Promise<void> {
  const d = keyDef(key)!
  const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, modifiers }
  const withText = !!d.text && !modifiers
  await send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', ...base, ...(withText ? { text: d.text } : {}), ...(commands ? { commands } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

const SELECT_OPTION = `function (want) {
  if (!(this instanceof HTMLSelectElement)) return 'not-select'
  const o = Array.from(this.options).find(o => o.value === want || o.label.trim() === want || o.text.trim() === want)
  if (!o) return 'no-option'
  this.value = o.value
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
}`

/** The element lives in a cross-site iframe: DOM calls go to its session, input to the page at an offset. */
interface InFrame { send: Send; ownerId: number }

/**
 * Runs the action; returns an error message when the page refused it. `send`
 * is the page session (mouse and keys always go there); `dom` is the session
 * of the frame that owns the element.
 */
/** The element's centre in page coordinates (a cross-site iframe's origin added), or null when its frame is gone. */
async function pointOf(send: Send, id: number, frame?: InFrame): Promise<{ x: number; y: number } | null> {
  if (!frame) return centerOf(send, id)
  await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: frame.ownerId }).catch(() => {})
  const local = await centerOf(frame.send, id)
  const origin = await frameOrigin(send, frame.ownerId)
  return origin ? { x: local.x + origin.x, y: local.y + origin.y } : null
}

/** Mouse down at one element, a few moves, up at another: sliders, reordering, drag-and-drop boards. */
async function dragBetween(wc: PageTarget, send: Send, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  // A native draggable element starts an HTML5 drag that synthetic mouse moves never finish:
  // catch it, then play it out as drag events at the target (boards, sortable lists, file trees).
  let data: unknown = null
  const onMessage: CdpListener = (_e, method, params) => { if (method === 'Input.dragIntercepted') data = params?.data }
  wc.debugger.on('message', onMessage)
  const intercept = await send('Input.setInterceptDrags', { enabled: true }).then(() => true, () => false)
  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 8; i++) {
      const x = from.x + ((to.x - from.x) * i) / 8, y = from.y + ((to.y - from.y) * i) / 8
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
      await new Promise(r => setTimeout(r, 30))
      if (data) break
    }
    if (data) {
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await send('Input.dispatchDragEvent', { type, ...to, data })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 })
  } finally {
    wc.debugger.removeListener('message', onMessage)
    if (intercept) await send('Input.setInterceptDrags', { enabled: false }).catch(() => {})
  }
}

const PASTE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain' }

// Runs on the box: a paste event carrying the text and files, the way chat boxes and
// editors read a real paste. Plain text goes in by itself when the page ignores the event.
const PASTE = `function (text, files) {
  this.focus()
  const dt = new DataTransfer()
  if (text != null) dt.setData('text/plain', text)
  for (const f of files) {
    const bin = atob(f.b64), bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    dt.items.add(new File([bytes], f.name, { type: f.type }))
  }
  const unhandled = this.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  if (unhandled && text != null && !files.length) document.execCommand('insertText', false, text)
  return unhandled ? 'inserted' : 'handled'
}`

async function paste(dom: Send, id: number, text: string | undefined, files: string[]): Promise<string | null> {
  const { object } = await dom('DOM.resolveNode', { backendNodeId: id }) as { object: { objectId: string } }
  const payload = files.map(f => ({ name: basename(f), type: PASTE_TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream', b64: readFileSync(f).toString('base64') }))
  await dom('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: PASTE, arguments: [{ value: text ?? null }, { value: payload }], returnByValue: true })
  return null
}

/** Local files dragged from the desktop onto a drop zone ("Drag photos here"). */
async function dropFiles(send: Send, at: { x: number; y: number }, files: string[]): Promise<void> {
  const data = { items: [], files, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await send('Input.dispatchDragEvent', { type, ...at, data })
  }
}

async function clickAt(send: Send, at: { x: number; y: number }): Promise<void> {
  const base = { ...at, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

const FRAME_GONE = 'the iframe holding this element is gone; take a new browser_snapshot'

/**
 * Puts files into a file input: directly when the ref is the input, otherwise
 * by clicking the ref (an "Add photo" button) with the file chooser intercepted
 * — the OS dialog never opens and the chosen input gets the files.
 */
async function upload(wc: PageTarget, send: Send, dom: Send, id: number, files: string[], frame?: InFrame): Promise<string | null> {
  const desc = await dom('DOM.describeNode', { backendNodeId: id }).catch(() => null) as { node?: { nodeName?: string; attributes?: string[] } } | null
  const attrs = desc?.node?.attributes ?? []
  const isFileInput = desc?.node?.nodeName === 'INPUT' && attrs.some((a, i) => i % 2 === 0 && a === 'type' && attrs[i + 1]?.toLowerCase() === 'file')
  if (isFileInput) { await dom('DOM.setFileInputFiles', { files, backendNodeId: id }); return null }

  await send('Page.enable').catch(() => {})
  await send('Page.setInterceptFileChooserDialog', { enabled: true })
  try {
    const opened = new Promise<{ backendNodeId: number; sessionId?: string } | null>(resolve => {
      const t = setTimeout(() => { wc.debugger.removeListener('message', on); resolve(null) }, 4000)
      function on(_e: unknown, method: string, params: { backendNodeId?: number }, sessionId?: string) {
        if (method !== 'Page.fileChooserOpened' || params.backendNodeId == null) return
        clearTimeout(t)
        wc.debugger.removeListener('message', on)
        resolve({ backendNodeId: params.backendNodeId, sessionId })
      }
      wc.debugger.on('message', on)
    })
    const at = await pointOf(send, id, frame)
    if (!at) return FRAME_GONE
    await clickAt(send, at)
    const chooser = await opened
    if (!chooser) return 'no file chooser opened: snapshot again and use the file input itself (or the button that opens it)'
    const target = chooser.sessionId && frame ? dom : send
    await target('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId })
    return null
  } finally {
    await send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
  }
}

/** Polls the page text (one cheap evaluate, no Runtime.enable) until `text` shows up or time runs out. */
async function waitFor(send: Send, text: string | undefined, ms: number, gone?: string): Promise<string | null> {
  if (!text && !gone) { await new Promise(r => setTimeout(r, ms)); return null }
  const end = Date.now() + ms
  const has = (t: string) => `(document.body ? document.body.innerText : '').includes(${JSON.stringify(t)})`
  // Both given: the new text is there and the old one has gone.
  const expression = [text ? has(text) : 'true', gone ? `!${has(gone)}` : 'true'].join(' && ')
  while (Date.now() < end) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => null) as { result?: { value?: boolean } } | null
    if (r?.result?.value) return null
    await new Promise(res => setTimeout(res, 250))
  }
  const secs = Math.round(ms / 1000)
  return text ? `"${text}" did not appear within ${secs} s` : `"${gone}" was still there after ${secs} s`
}

/** The element under a viewport point, as a target the safety rules can judge. */
async function elementAt(send: Send, at: { x: number; y: number }): Promise<{ role: string; name: string }> {
  const js = `(() => { const t = document.elementFromPoint(${at.x}, ${at.y}); if (!t) return null
    const c = t.closest('button,a,[role],input,select,textarea,[aria-label]') || t
    const role = c.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' })[c.tagName] || 'generic'
    const name = (c.getAttribute('aria-label') || c.getAttribute('title') || c.getAttribute('alt') || c.innerText || c.value || '').trim().slice(0, 80)
    return { role, name } })()`
  const r = await send('Runtime.evaluate', { expression: js, returnByValue: true }).catch(() => null) as { result?: { value?: { role: string; name: string } | null } } | null
  return r?.result?.value ?? { role: 'generic', name: '' }
}

async function dispatch(wc: PageTarget, send: Send, req: ActRequest, entry: RefEntry | undefined, frame?: InFrame): Promise<string | null> {
  const id = entry?.backendNodeId
  const dom = frame?.send ?? send
  const aim = async () => req.at ?? pointOf(send, id!, frame)
  switch (req.action) {
    case 'click': {
      const at = await aim()
      if (!at) return FRAME_GONE
      await clickAt(send, at)
      return null
    }
    case 'dblclick':
    case 'rightclick': {
      const at = await aim()
      if (!at) return FRAME_GONE
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
      const button = req.action === 'rightclick' ? 'right' : 'left'
      for (let n = 1; n <= (req.action === 'dblclick' ? 2 : 1); n++) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button, clickCount: n })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button, clickCount: n })
      }
      return null
    }
    case 'drag': {
      if (req.at && req.toAt) { await dragBetween(wc, send, req.at, req.toAt); return null }
      const target = stateFor(wc).refs.get(req.toRef ?? '')
      if (!target) return `unknown toRef ${req.toRef}; take a new snapshot`
      if (target.frameId !== entry?.frameId) return 'drag works within one frame: ref and toRef must be on the same page part'
      const from = await pointOf(send, id!, frame)
      const to = await pointOf(send, target.backendNodeId, frame)
      if (!from || !to) return FRAME_GONE
      await dragBetween(wc, send, from, to)
      return null
    }
    case 'drop': {
      const at = await aim()
      if (!at) return FRAME_GONE
      await dropFiles(send, at, req.files ?? [])
      return null
    }
    case 'hover': {
      const at = await aim()
      if (!at) return FRAME_GONE
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
      hovering.set(wc.id, await underPointer(dom, at))
      return null
    }
    case 'upload':
      return upload(wc, send, dom, id!, req.files ?? [], frame)
    case 'wait':
      return waitFor(send, req.waitText, req.ms ?? 10_000, req.waitGone)
    case 'paste':
      if (frame) await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: frame.ownerId }).catch(() => {})
      return paste(dom, id!, req.text, req.files ?? [])
    case 'type': {
      if (frame) await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: frame.ownerId }).catch(() => {})
      await dom('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }).catch(() => {})
      await dom('DOM.focus', { backendNodeId: id })
      if (req.clear) {
        await pressKey(send, 'a', process.platform === 'darwin' ? 4 : 2, ['selectAll'])
        await pressKey(send, 'Backspace')
      }
      await send('Input.insertText', { text: req.text })
      return null
    }
    case 'select': {
      const { object } = await dom('DOM.resolveNode', { backendNodeId: id }) as { object: { objectId: string } }
      // callFunctionOn needs no Runtime.enable.
      const { result } = await dom('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: SELECT_OPTION, arguments: [{ value: req.value }], returnByValue: true }) as { result: { value?: string } }
      if (result.value === 'not-select') return 'not a native select: click it, then click the option ref'
      if (result.value === 'no-option') return `no option "${req.value}"`
      return null
    }
    case 'scroll': {
      if (id != null) { await dom('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }); return null }
      const m = await send('Page.getLayoutMetrics') as { cssLayoutViewport?: { clientWidth: number; clientHeight: number } }
      const w = m.cssLayoutViewport?.clientWidth ?? 800, h = m.cssLayoutViewport?.clientHeight ?? 600
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: w / 2, y: h / 2, deltaX: 0, deltaY: (req.direction === 'up' ? -0.8 : 0.8) * h })
      return null
    }
    case 'key': {
      if (id != null) await dom('DOM.focus', { backendNodeId: id })
      await pressKey(send, req.key!)
      return null
    }
  }
}

const quote = (e: Pick<RefEntry, 'role' | 'name'>) => `${e.role} "${e.name}"`

const MARK = { borderColor: { r: 217, g: 119, b: 6, a: 0.95 }, contentColor: { r: 245, g: 158, b: 11, a: 0.22 }, showInfo: false }
export const MARK_MS = 350

/**
 * Outlines the element an agent is about to use, so a user watching sees where
 * it acts. Drawn by the browser's own overlay (like DevTools' inspect box): not
 * part of the page, invisible to its scripts and to the next snapshot.
 */
async function mark(dom: Send, backendNodeId: number): Promise<void> {
  try {
    await dom('DOM.enable')
    await dom('Overlay.enable')
    await dom('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
    await dom('Overlay.highlightNode', { highlightConfig: MARK, backendNodeId })
    await new Promise(r => setTimeout(r, MARK_MS))
  } catch { /* a missing outline must never stop the action */ }
}

const unmark = (dom: Send) => dom('Overlay.hideHighlight').catch(() => {})

interface StepResult { error?: string; needsConfirm?: boolean; target?: string; recorded?: RoutineStep }

/** What the mouse ended up over after the last hover on each page: a big row's centre can be another element. */
const hovering = new Map<number, string>()

/** The labelled element under a viewport point, as `button "React"`, read from the page. */
async function underPointer(send: Send, at: { x: number; y: number }): Promise<string> {
  const js = `(() => { const t = document.elementFromPoint(${at.x}, ${at.y}); let e = t;
    for (let i = 0; e && i < 8; i++, e = e.parentElement) { const l = e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('title'); if (l) return (e.getAttribute('role') || e.tagName.toLowerCase()) + ' "' + l.slice(0, 80) + '"' }
    return t ? (t.innerText || '').trim().slice(0, 80) : '' })()`
  const r = await send('Runtime.evaluate', { expression: js, returnByValue: true }).catch(() => null) as { result?: { value?: string } } | null
  return r?.result?.value ?? ''
}

/** Successful steps per page, for browser_routine_save. */
export const recorder = new StepRecorder()

const attrsOf = async (dom: Send, backendNodeId: number): Promise<Record<string, string>> => {
  const r = await dom('DOM.describeNode', { backendNodeId }).catch(() => null) as { node?: { attributes?: string[] } } | null
  const flat = r?.node?.attributes ?? []
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i].toLowerCase()] = flat[i + 1]
  return out
}

/** What a routine keeps of a step. Text typed into a secret field is never stored: it becomes {{secret}}. */
async function recordStep(dom: Send, req: ActRequest, entry: RefEntry | undefined, at: { x?: number; y?: number } | undefined): Promise<RoutineStep> {
  const step: RoutineStep = { action: req.action }
  if (req.key) step.key = req.key
  if (req.value) step.value = req.value
  if (req.direction) step.direction = req.direction
  if (req.clear) step.clear = true
  if (entry) {
    const raw = await attrsOf(dom, entry.backendNodeId)
    const secretDom = raw.type?.toLowerCase() === 'password' || /one-time-code|cc-|password/i.test(raw.autocomplete ?? '')
    step.target = { role: entry.role, name: entry.name, attrs: stableAttrs(raw), x: at?.x, y: at?.y }
    if (req.text != null) step.text = maskValue('x', entry.name, secretDom) === 'x' ? req.text : '{{secret}}'
  } else if (req.text != null) {
    step.text = req.text
  }
  return step
}

// Runs on the element: does it submit a form that holds a password, card number or one-time code?
const SENSITIVE_FORM = `function () {
  const el = this && this.nodeType === 1 ? this : null
  if (!el) return false
  const f = el.form || el.closest('form')
  if (!f) return false
  return !!f.querySelector('input[type=password],input[autocomplete*="cc-"],input[autocomplete="one-time-code"],input[name*="card" i],input[name*="cvv" i],input[name*="cvc" i],input[name*="iban" i]')
}`

async function sensitiveForm(dom: Send, backendNodeId: number): Promise<boolean> {
  const obj = await dom('DOM.resolveNode', { backendNodeId }).catch(() => null) as { object?: { objectId?: string } } | null
  if (!obj?.object?.objectId) return false
  const r = await dom('Runtime.callFunctionOn', { objectId: obj.object.objectId, functionDeclaration: SENSITIVE_FORM, returnByValue: true }).catch(() => null) as { result?: { value?: boolean } } | null
  return r?.result?.value === true
}

/**
 * The user's own rules for a site, asked before every step: block it, always
 * ask, or allow it without the built-in check. Null leaves it to the engine.
 */
export type Judge = (req: ActRequest, target?: { role: string; name: string }) => 'block' | 'ask' | 'allow' | null

/** Checks the ref still points at the element the agent saw, asks for confirm when needed, then acts. */
async function runStep(send: Send, wc: PageTarget, req: ActRequest, highlight = false, judge?: Judge): Promise<StepResult> {
  const state = stateFor(wc)
  let entry: RefEntry | undefined
  let liveName = ''
  let frame: InFrame | undefined
  let release: (() => Promise<void>) | undefined
  try {
    if (req.ref) {
      entry = state.refs.get(req.ref)
      if (!entry) return { error: `unknown ref ${req.ref}; take a new browser_snapshot` }
      const { frameId, loaderId, backendNodeId } = entry
      const frames = await liveFrames(send)
      if (!frames.some(f => f.id === frameId && f.loaderId === loaderId)) {
        // Not in the page's own frames: maybe a cross-site iframe, which has its own session.
        const kids = await attachChildFrames(wc, send, new Set(frames.map(f => f.id)))
        release = kids.release
        const kid = kids.frames.find(k => k.frameId === frameId && k.loaderId === loaderId)
        if (!kid) return { error: `ref ${req.ref} belongs to a page that is gone; take a new browser_snapshot` }
        frame = { send: kid.send, ownerId: kid.ownerId }
      }
      const dom = frame?.send ?? send
      await dom('Accessibility.enable').catch(() => {})
      const ax = await dom('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })
        .catch(() => ({ nodes: [] })) as { nodes: (Pick<AXNode, 'role' | 'properties'> & { name?: { value?: unknown }; backendDOMNodeId?: number; ignored?: boolean })[] }
      const node = ax.nodes.find(n => n.backendDOMNodeId === backendNodeId)
      let now = node ? { role: roleOf(node), name: String(node.name?.value ?? '') } : null
      // Listed from inside aria-hidden (hover toolbars): the AX tree has no name for it, its label attribute does.
      if (node?.ignored) {
        const d = await dom('DOM.describeNode', { backendNodeId }).catch(() => null) as { node?: { attributes?: string[] } } | null
        const a = d?.node?.attributes ?? []
        const get = (k: string) => { const i = a.findIndex((v, j) => j % 2 === 0 && v === k); return i >= 0 ? a[i + 1] ?? '' : '' }
        now = { role: entry.role, name: get('aria-label') || get('title') }
      }
      const mismatch = targetMismatch(entry, now)
      if (mismatch) return { error: mismatch, target: quote(entry) }
      liveName = now?.name ?? ''
    }
    // A point has no ref: judge what is drawn there, so a click on a "Send" button by coordinates still asks.
    const atPoint = !entry && req.at ? await elementAt(send, req.at) : undefined
    const target = entry ? quote(entry) : atPoint && req.at ? `point (${Math.round(req.at.x)}, ${Math.round(req.at.y)}) on ${atPoint.role} "${atPoint.name}"` : undefined

    const verdict = judge?.(req, entry ?? atPoint) ?? null
    if (verdict === 'block') return { error: 'the user\'s rules for this site block this step; do not try another way', target }
    // Submitting a form that holds a password or card number always asks, whatever the button says.
    const submits = req.action === 'click' || req.action === 'dblclick' || (req.action === 'key' && req.key === 'Enter')
    const sctx: SafetyContext = entry && submits ? { sensitiveForm: await sensitiveForm(frame?.send ?? send, entry.backendNodeId) } : {}
    // A label that changed since the snapshot is judged as it reads now, too.
    let reason = verdict === 'allow' ? null : confirmReason(req, entry ?? atPoint, sctx) ?? (entry && liveName && liveName !== entry.name ? confirmReason(req, { ...entry, name: liveName }, sctx) : null)
    if (!reason && verdict === 'ask') reason = 'the user\'s rules for this site ask before this step — ask the user first, then repeat with confirm: true'
    if (reason && !req.confirm) return { error: reason, needsConfirm: true, target }

    const dom = frame?.send ?? send
    if (highlight && entry) await mark(dom, entry.backendNodeId)
    try {
      const error = await dispatch(wc, send, req, entry, frame)
      if (error) return { error, target }
    } catch (e) {
      return { error: `could not ${req.action}: ${e instanceof Error ? e.message : String(e)}`, target }
    } finally {
      if (highlight && entry) await unmark(dom)
    }
    const seen = req.ref ? state.last?.items.find(i => i.ref === req.ref) : undefined
    const recorded = await recordStep(frame?.send ?? send, req, entry, seen).catch(() => undefined)
    return { target, recorded }
  } finally {
    await release?.()
  }
}

/**
 * Runs one action or a list of them, then reads the page once. Between steps
 * only a ~1 ms signature is polled; the full map is captured a single time at
 * the end. A failing or unconfirmed step stops the list there.
 */
/**
 * Collects the page's own requests while `fn` runs. Network is never disabled
 * afterwards: other Tabgeist code (Live Capture) may rely on it being on.
 */
async function watchNetwork<T>(wc: PageTarget, send: Send, fn: () => Promise<T>): Promise<[T, SeenRequest[], SocketTraffic[]]> {
  const seen = new Map<string, SeenRequest>()
  const sockets = new Map<string, SocketTraffic>()
  interface NetEvent {
    requestId: string
    type?: string
    request?: { method: string; url: string }
    response?: { status: number; mimeType: string }
    encodedDataLength?: number
    url?: string
  }
  const onMessage = (_e: unknown, method: string, params: NetEvent, sessionId?: string) => {
    if (sessionId) return
    if (method === 'Network.requestWillBeSent' && params.request) seen.set(params.requestId, { method: params.request.method, url: params.request.url, type: params.type ?? '' })
    else if (method === 'Network.responseReceived') { const r = seen.get(params.requestId); if (r) { r.status = params.response?.status; r.mime = params.response?.mimeType } }
    else if (method === 'Network.loadingFinished') { const r = seen.get(params.requestId); if (r) r.bytes = params.encodedDataLength }
    // Chat apps send over a WebSocket, not fetch: count its frames so a send still shows up.
    else if (method === 'Network.webSocketCreated') sockets.set(params.requestId, { url: params.url ?? '', sent: 0, received: 0 })
    else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const ws = sockets.get(params.requestId) ?? { url: '(opened before the action)', sent: 0, received: 0 }
      sockets.set(params.requestId, ws)
      if (method === 'Network.webSocketFrameSent') ws.sent++
      else ws.received++
    }
  }
  wc.debugger.on('message', onMessage)
  try {
    await send('Network.enable').catch(() => {})
    const out = await fn()
    return [out, [...seen.values()], [...sockets.values()].filter(w => w.sent || w.received)]
  } finally {
    wc.debugger.removeListener('message', onMessage)
  }
}

/**
 * Answers browser dialogs a page opens while an agent acts — left open, they
 * freeze the page and every later call. Alerts and "leave page?" are accepted;
 * a confirm or prompt is accepted only during a step the user said yes to,
 * otherwise dismissed and reported so the agent can ask.
 */
class DialogWatch {
  acceptConfirm = false
  readonly log: string[] = []
  private refused: string | null = null
  private readonly on = (_e: unknown, method: string, params: { type?: string; message?: string; defaultPrompt?: string }, sessionId?: string) => {
    if (method !== 'Page.javascriptDialogOpening' || sessionId) return
    const type = params.type ?? 'alert'
    const message = String(params.message ?? '').slice(0, 300)
    const accept = type === 'alert' || type === 'beforeunload' || this.acceptConfirm
    void this.send('Page.handleJavaScriptDialog', { accept, ...(type === 'prompt' && accept ? { promptText: params.defaultPrompt ?? '' } : {}) }).catch(() => {})
    this.log.push(`${type}: "${message}" — ${accept ? 'accepted' : 'dismissed'}`)
    if (!accept) this.refused = `the page asked "${message}" (${type}) and it was dismissed — if the user wants it, repeat this step with confirm: true to accept`
  }

  constructor(private readonly wc: PageTarget, private readonly send: Send) {}

  async start(): Promise<void> {
    this.wc.debugger.on('message', this.on)
    await this.send('Page.enable').catch(() => {})
  }

  stop(): void {
    this.wc.debugger.removeListener('message', this.on)
  }

  takeRefused(): string | null {
    const r = this.refused
    this.refused = null
    return r
  }
}

export async function actOnPage(wc: PageTarget, reqs: ActRequest | ActRequest[], opts: { network?: boolean; highlight?: boolean; judge?: Judge } = {}): Promise<ActionReceipt> {
  if (opts.network) {
    return whileAwake(wc, () => withDebugger(wc, async send => {
      // The JSON the site fetched because of the act is kept for browser_read with data: true.
      const [receipt, seen, sockets] = await watchNetwork(wc, send, async () => (await catchData(wc, send, () => actOnPage(wc, reqs, { highlight: opts.highlight, judge: opts.judge }))).out)
      return { ...receipt, requests: summarizeRequests(seen), ...(sockets.length ? { sockets } : {}) }
    }))
  }
  const list = Array.isArray(reqs) ? reqs : [reqs]
  const state = stateFor(wc)

  return whileAwake(wc, () => withDebugger(wc, async send => {
    const started = Date.now()
    const before: PageMap = state.last ?? await snapshotPage(wc)
    let done = 0
    let last: StepResult = {}
    const host = hostOf(before.url)
    const dialogs = new DialogWatch(wc, send)
    await dialogs.start()
    try {
      for (const req of list) {
        dialogs.acceptConfirm = req.confirm === true
        last = await runStep(send, wc, req, opts.highlight, opts.judge)
        if (last.error) break
        if (last.recorded) recorder.add(wc.id, host, last.recorded)
        await waitLoaded(wc)
        await settle(() => pageSignature(send), (a, b) => a === b)
        // A confirm/prompt dismissed because the user had not said yes: the step did not really happen.
        const refused = dialogs.takeRefused()
        if (refused) { last = { error: refused, needsConfirm: true, target: last.target }; break }
        done++
      }
    } finally {
      dialogs.stop()
    }
    const failed = !!last.error
    const at = failed ? list[done] : list[list.length - 1]
    const after = await snapshotPage(wc)
    const receipt: ActionReceipt = {
      ok: !failed,
      action: at.action,
      target: last.target,
      url: after.url,
      navigated: after.url !== before.url,
      diff: diffMaps(before, after),
    }
    if (failed) {
      receipt.error = last.error
      if (last.needsConfirm) receipt.needsConfirm = true
    }
    const news = announcements(before, after)
    if (news.length) receipt.announce = news
    if (dialogs.log.length) receipt.dialogs = dialogs.log
    const over = list.some(r => r.action === 'hover') ? hovering.get(wc.id) : undefined
    if (over) receipt.pointerOver = over
    const files = wc.session ? downloadsSince(wc.session, started) : []
    if (files.length) receipt.downloads = files.map(({ file, url, state, bytes }) => ({ file, url, state, bytes }))
    if (list.length > 1) {
      receipt.steps = done
      if (failed) receipt.failedStep = done + 1
    }
    return receipt
  }))
}

export const hostOf = (url: string): string => { try { return new URL(url).host } catch { return '' } }

/** CSS attribute selector for a stable attribute, quoted for the DOM. */
const attrSelector = (k: string, v: string) => `[${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`

/**
 * Level 0 of the re-finder: a stable attribute (id, data-testid, name, aria-label,
 * placeholder) that matches exactly one element in the live page.
 */
async function findByAttrs(send: Send, wc: PageTarget, map: PageMap, fp: Fingerprint): Promise<string | null> {
  const state = stateFor(wc)
  const { root } = await send('DOM.getDocument', { depth: 0 }).catch(() => ({ root: null })) as { root: { nodeId: number } | null }
  if (!root) return null
  for (const k of ['data-testid', 'data-test', 'data-qa', 'id', 'name', 'aria-label', 'placeholder']) {
    const v = fp.attrs[k]
    if (!v) continue
    const r = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: attrSelector(k, v) }).catch(() => null) as { nodeIds: number[] } | null
    if (r?.nodeIds.length !== 1) continue
    const d = await send('DOM.describeNode', { nodeId: r.nodeIds[0] }).catch(() => null) as { node?: { backendNodeId: number } } | null
    const item = d?.node && map.items.find(i => state.refs.get(i.ref)?.backendNodeId === d.node!.backendNodeId && i.role === fp.role)
    if (item) return item.ref
  }
  return null
}

export interface RoutineReceipt extends ActionReceipt {
  /** How each step's element was found again, in order. */
  found?: (RefindLevel | 'attribute' | 'no target')[]
}

/**
 * Replays a saved routine: per step a fresh map, the element found again
 * (stable attribute, then refind), then the same checks and confirm rules as
 * browser_act. Stops at the first step whose element is missing or ambiguous.
 */
export async function runRoutine(wc: PageTarget, routine: Routine, vars: Record<string, string>, confirm: boolean): Promise<RoutineReceipt> {
  const first = routine.steps[0]?.action ?? 'click'
  if (hostOf(wc.getURL()) !== routine.host) {
    return { ok: false, action: first, error: `routine "${routine.name}" was recorded on ${routine.host}; this view is on ${hostOf(wc.getURL()) || 'no page'}` }
  }
  return whileAwake(wc, () => withDebugger(wc, async send => {
    const before = await snapshotPage(wc)
    const found: NonNullable<RoutineReceipt['found']> = []
    let done = 0
    let error: string | undefined
    let needsConfirm = false
    let target: string | undefined
    for (const [n, step] of routine.steps.entries()) {
      const map = n === 0 ? before : await snapshotPage(wc)
      const req: ActRequest = { action: step.action, key: step.key, value: step.value, direction: step.direction, clear: step.clear === true, confirm }
      if (step.text != null) {
        const filled = fillVars(step.text, vars)
        if (typeof filled !== 'string') { error = `step ${n + 1} needs vars.${filled.missing}`; break }
        req.text = filled
      }
      if (step.target) {
        const byAttr = await findByAttrs(send, wc, map, step.target)
        const hit = byAttr ? null : refind(map.items, step.target)
        const ref = byAttr ?? hit?.item.ref
        if (!ref) { error = `step ${n + 1}: ${step.target.role} "${step.target.name}" not found (or not unique) on the page; do it by hand and save the routine again`; break }
        found.push(byAttr ? 'attribute' : hit!.level)
        req.ref = ref
      } else {
        found.push('no target')
      }
      const r = await runStep(send, wc, req)
      target = r.target
      if (r.error) { error = r.error; needsConfirm = !!r.needsConfirm; break }
      done++
      await waitLoaded(wc)
      await settle(() => pageSignature(send), (a, b) => a === b)
    }
    const after = await snapshotPage(wc)
    const receipt: RoutineReceipt = {
      ok: !error,
      action: routine.steps[Math.min(done, routine.steps.length - 1)]?.action ?? first,
      target,
      url: after.url,
      navigated: after.url !== before.url,
      diff: diffMaps(before, after),
      steps: done,
      found,
    }
    if (error) { receipt.error = error; receipt.failedStep = done + 1 }
    if (needsConfirm) receipt.needsConfirm = true
    const news = announcements(before, after)
    if (news.length) receipt.announce = news
    return receipt
  }))
}

/** Finds a fingerprint's element on a fresh map: a stable attribute first, then role and name (exact levels only). */
export async function locate(wc: PageTarget, map: PageMap, fp: Fingerprint): Promise<{ ref: string; level: RefindLevel | 'attribute' } | null> {
  return withDebugger(wc, async send => {
    const byAttr = await findByAttrs(send, wc, map, fp)
    if (byAttr) return { ref: byAttr, level: 'attribute' as const }
    const hit = refind(map.items, fp)
    return hit ? { ref: hit.item.ref, level: hit.level } : null
  })
}

/** Stable attributes of the element behind a ref, for similarity scoring. */
export async function attrsForRef(wc: PageTarget, ref: string): Promise<Record<string, string>> {
  const e = stateFor(wc).refs.get(ref)
  if (!e) return {}
  return stableAttrs(await withDebugger(wc, send => attrsOf(send, e.backendNodeId)))
}
