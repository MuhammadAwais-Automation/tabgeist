import { randomBytes, randomInt } from 'node:crypto'

/**
 * Which browser profiles may drive the daemon. The extension's origin is pinned,
 * but a manifest key is public, so any local program could pose as the extension:
 * a browser is trusted only after the user approved its 6-digit code in the
 * control room (or the CLI). The extension then keeps a pair token; only its
 * hash is stored here.
 */

export interface PairedBrowser {
  /** Short id for lists and removal (first 12 hex chars of the token hash). */
  id: string
  label: string
  browser: string
  at: number
  lastSeen?: number
}

export interface PairingFile { browsers: Record<string, PairedBrowser> }

export interface PairingIO {
  load(): PairingFile
  save(file: PairingFile): void
  hash(token: string): string
}

export class PairingStore {
  private data: PairingFile

  constructor(private readonly io: PairingIO) {
    this.data = io.load()
    this.data.browsers ??= {}
  }

  /** The paired browser this token belongs to, or null. */
  check(token: unknown): PairedBrowser | null {
    if (typeof token !== 'string' || token.length < 32) return null
    const hit = this.data.browsers[this.io.hash(token)]
    if (!hit) return null
    hit.lastSeen = Date.now()
    return hit
  }

  /** Trusts a new browser; returns the token the extension must keep. */
  add(label: string, browser: string): { token: string; entry: PairedBrowser } {
    const token = randomBytes(32).toString('hex')
    const h = this.io.hash(token)
    const entry: PairedBrowser = { id: h.slice(0, 12), label, browser, at: Date.now() }
    this.data.browsers[h] = entry
    this.io.save(this.data)
    return { token, entry }
  }

  remove(id: string): boolean {
    const key = Object.keys(this.data.browsers).find(k => this.data.browsers[k].id === id)
    if (!key) return false
    delete this.data.browsers[key]
    this.io.save(this.data)
    return true
  }

  list(): PairedBrowser[] {
    return Object.values(this.data.browsers)
  }
}

/** A six-digit code that is not already waiting. */
export function pairingCode(taken: Set<string>): string {
  for (;;) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    if (!taken.has(code)) return code
  }
}
