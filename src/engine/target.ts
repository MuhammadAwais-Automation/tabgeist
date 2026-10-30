/**
 * The page the perception engine reads and acts on. An Electron WebContents
 * fits as is; a tab in the user's Chrome fits through the extension relay
 * (electron/chrome/chromeTab.ts). Only what the engine calls is listed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CdpListener = (event: unknown, method: string, params: any, sessionId?: string) => void

export interface CdpDebugger {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendCommand(method: string, params?: any, sessionId?: string): Promise<any>
  on(event: 'message', listener: CdpListener): unknown
  removeListener(event: 'message', listener: CdpListener): unknown
}

/** The parts of an Electron DownloadItem the engine uses. */
export interface DownloadItemLike {
  getFilename(): string
  getURL(): string
  getReceivedBytes(): number
  setSavePath(path: string): void
  on(event: 'updated', listener: () => void): unknown
  once(event: 'done', listener: (event: unknown, state: string) => void): unknown
}

/** The part of an Electron Session the engine uses (an Electron Session fits as is). */
export interface DownloadSession {
  on(event: 'will-download', listener: (event: unknown, item: DownloadItemLike) => void): unknown
}

export interface PageTarget {
  readonly id: number
  readonly debugger: CdpDebugger
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  once(event: 'did-stop-loading', listener: () => void): unknown
  removeListener(event: 'did-stop-loading', listener: () => void): unknown
  /** Electron views only: where the page's downloads are tracked. */
  readonly session?: DownloadSession
}

/** An Electron view (kept awake and painted by keepAwake), as opposed to a Chrome tab. */
export function isElectronView(t: PageTarget): boolean {
  return 'setBackgroundThrottling' in t
}

type Awake = <T>(t: PageTarget, fn: () => Promise<T>) => Promise<T>
let viewAwake: Awake = (_t, fn) => fn()

/**
 * The Tabgeist app keeps its own hidden views painted while the engine acts
 * (keepAwake.ts) and registers that here at start. The engine itself imports
 * nothing from the app, so it also runs with no Electron at all (Chrome tabs,
 * the e2e suite).
 */
export function setViewAwake(fn: Awake): void { viewAwake = fn }

export const whileAwake: Awake = (t, fn) => (isElectronView(t) ? viewAwake(t, fn) : fn())
