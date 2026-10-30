import { randomBytes } from 'node:crypto'

/**
 * Scoped yeses. "Allow on this site for 15 minutes" turns one approval into a
 * grant: the same kind of step (e.g. click button "Send") on the same site in
 * the same browser passes without a card until it expires or runs out of uses.
 * Grants live in memory only: a daemon restart forgets them, on purpose.
 */

export interface GrantScope { browser: string; site: string; kind: string }

export interface GrantEntry extends GrantScope {
  id: string
  at: number
  until: number
  left: number
}

export const GRANT_MS = 15 * 60_000
export const GRANT_USES = 10

const keyOf = (s: GrantScope) => `${s.browser}\u0000${s.site}\u0000${s.kind}`

export class Grants {
  private readonly items = new Map<string, GrantEntry>()

  constructor(private readonly now: () => number = Date.now) {}

  allow(scope: GrantScope, ms = GRANT_MS, uses = GRANT_USES): GrantEntry {
    const entry: GrantEntry = { ...scope, id: randomBytes(4).toString('hex'), at: this.now(), until: this.now() + ms, left: uses }
    this.items.set(keyOf(scope), entry)
    return entry
  }

  /** True (and one use spent) when a live grant covers this step. */
  use(scope: GrantScope): boolean {
    const g = this.items.get(keyOf(scope))
    if (!g) return false
    if (g.until <= this.now() || g.left <= 0) { this.items.delete(keyOf(scope)); return false }
    g.left--
    return true
  }

  list(): GrantEntry[] {
    const t = this.now()
    for (const [k, g] of this.items) if (g.until <= t || g.left <= 0) this.items.delete(k)
    return [...this.items.values()]
  }

  revoke(id: string): boolean {
    for (const [k, g] of this.items) if (g.id === id) { this.items.delete(k); return true }
    return false
  }

  clear(): void { this.items.clear() }
}

/**
 * The kind of a risky step for grants: the action and the element's normalized
 * name, so "Send" on one site covers that button only, not every risky click.
 */
export function kindOf(action: string, target?: string): string {
  const name = (target ?? '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80)
  return `${action}:${name}`
}
