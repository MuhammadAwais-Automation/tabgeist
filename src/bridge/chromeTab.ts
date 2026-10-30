import { EventEmitter } from 'node:events'
import type { CdpDebugger, CdpListener, PageTarget } from '../engine/target'

/** What the extension reports about a tab. */
export interface TabInfo {
  id: number
  windowId: number
  url: string
  title: string
  status?: string
  active?: boolean
  pinned?: boolean
  audible?: boolean
  discarded?: boolean
  /** In the "Tabgeist" tab group: opened by the agent, and the only tabs it may close. */
  agent?: boolean
}

/** Sends one request to the extension that owns the tab. */
export type Relay = (method: string, params: Record<string, unknown>) => Promise<unknown>

// Chrome shows its "is debugging" bar while attached: stay attached through a burst
// of reads and acts, let go once the agent has been quiet this long.
const DETACH_AFTER_MS = 8000

let seq = 0

/**
 * A tab in the user's Chrome as a perception-engine page. CDP goes through the
 * extension's chrome.debugger; events come back through `deliver`.
 */
export class ChromeTab extends EventEmitter implements PageTarget {
  /** Negative, so it never meets an Electron webContents id in the engine's per-page state. */
  readonly id = -(++seq)
  readonly debugger: CdpDebugger
  private info: TabInfo
  private destroyed = false
  private attached = false
  private attaching: Promise<void> | null = null
  private attachError: unknown = null
  private detachTimer: ReturnType<typeof setTimeout> | null = null
  private readonly cdp = new EventEmitter()

  constructor(readonly tabId: number, info: TabInfo, private readonly relay: Relay) {
    super()
    this.info = info
    this.debugger = {
      isAttached: () => this.attached,
      attach: () => this.attach(),
      detach: () => this.detach(),
      sendCommand: (method, params, sessionId) => this.send(method, params, sessionId),
      on: (_e, fn: CdpListener) => this.cdp.on('message', fn),
      removeListener: (_e, fn: CdpListener) => this.cdp.removeListener('message', fn),
    }
  }

  get tab(): TabInfo { return this.info }
  getURL(): string { return this.info.url }
  getTitle(): string { return this.info.title }
  isLoading(): boolean { return this.info.status === 'loading' }
  isDestroyed(): boolean { return this.destroyed }

  private attach(): void {
    if (this.detachTimer) { clearTimeout(this.detachTimer); this.detachTimer = null }
    if (this.attached) return
    this.attached = true
    if (!this.attaching) {
      this.attaching = this.relay('cdp.attach', { tabId: this.tabId }).then(() => undefined, (e: unknown) => {
        this.attached = false
        this.attaching = null
        this.attachError = e
        throw e
      })
      this.attaching.catch(() => {})
    }
  }

  private detach(): void {
    if (!this.attached) return
    this.attached = false
    if (this.detachTimer) clearTimeout(this.detachTimer)
    this.detachTimer = setTimeout(() => {
      this.detachTimer = null
      if (this.attached || this.destroyed) return
      this.attaching = null
      void this.relay('cdp.detach', { tabId: this.tabId }).catch(() => {})
    }, DETACH_AFTER_MS)
  }

  private async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.destroyed) throw new Error('the tab was closed')
    if (!this.attaching) throw this.attachError ?? new Error('debugger is not attached')
    await this.attaching
    return this.relay('cdp.send', { tabId: this.tabId, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) })
  }

  /** A CDP event from the extension. */
  deliver(method: string, params: unknown, sessionId?: string): void {
    this.cdp.emit('message', null, method, params, sessionId)
  }

  /** chrome.debugger let go (user pressed Cancel on the bar, or the page went away). */
  detached(): void {
    this.attached = false
    this.attaching = null
  }

  update(info: Partial<TabInfo>): void {
    const wasLoading = this.isLoading()
    this.info = { ...this.info, ...info }
    if (wasLoading && !this.isLoading()) this.emit('did-stop-loading')
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.detachTimer) clearTimeout(this.detachTimer)
    this.emit('did-stop-loading')
    this.emit('destroyed')
    this.removeAllListeners()
    this.cdp.removeAllListeners()
  }
}
