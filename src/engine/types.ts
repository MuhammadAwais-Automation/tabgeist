/**
 * Shared shapes of the perception engine: the page map an agent reads instead
 * of a screenshot, and the receipts actions return.
 */

/** One thing on the page an agent can act on or needs to read. */
export interface PageItem {
  /** Stable ref (`e12`) — valid until the document it came from is replaced. */
  ref: string
  role: string
  name: string
  /** Current value of an input; masked for passwords, card numbers and one-time codes. */
  value?: string
  states: string[]
  /** Heading level, when role is heading. */
  level?: number
  /** Top-left and size in page CSS pixels, when the element has layout. */
  x?: number
  y?: number
  w?: number
  h?: number
  inViewport: boolean
  frameId: string
}

export interface PageMap {
  url: string
  title: string
  /** Scroll position and viewport size in CSS pixels. */
  scrollY: number
  viewportHeight: number
  pageHeight: number
  landmarks: string[]
  items: PageItem[]
  /** How long the capture took. */
  ms?: number
  /** Cross-site iframes read through their own session. */
  iframes?: number
}

/** What changed since the map the agent last saw. */
export interface SnapshotDiff {
  mode: 'unchanged' | 'delta' | 'full'
  text: string
}

export type ActionKind = 'click' | 'dblclick' | 'rightclick' | 'drag' | 'drop' | 'type' | 'paste' | 'select' | 'scroll' | 'key' | 'hover' | 'upload' | 'wait'

/** What an action did, checked on the page afterwards — never just "sent". */
export interface ActionReceipt {
  ok: boolean
  action: ActionKind
  /** `button "Send"` — the element acted on, as the agent saw it. */
  target?: string
  error?: string
  /** True when the action was refused until the user confirms it. */
  needsConfirm?: boolean
  url?: string
  navigated?: boolean
  diff?: SnapshotDiff
  /** Alerts, toasts, status and error messages that appeared — read these first. */
  announce?: string[]
  /** Batch: how many steps ran successfully. */
  steps?: number
  /** Batch: 1-based number of the step that failed or needs confirm. */
  failedStep?: number
  /** With network: true — the page's data requests during the action (secret query values redacted). */
  requests?: { method: string; url: string; status?: number; mime?: string; bytes?: number }[]
  /** Browser dialogs (alert / confirm / prompt) the page opened, and what was answered. */
  dialogs?: string[]
  /** With network: true — WebSocket traffic during the action (chat apps send this way). */
  sockets?: SocketTraffic[]
  /** After a hover: the labelled element the mouse is really over. */
  pointerOver?: string
  /** Files the page downloaded during the action (workspace tabs only). */
  downloads?: { file: string; url: string; state: string; bytes: number }[]
  /** Something the agent should check before going on (e.g. a Download click that started nothing yet). */
  warning?: string
}

/** Where a ref points, kept by the engine; never sent to the agent. */
export interface RefEntry {
  ref: string
  frameId: string
  loaderId: string
  backendNodeId: number
  role: string
  name: string
}

export interface SocketTraffic { url: string; sent: number; received: number }
