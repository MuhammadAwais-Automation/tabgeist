/**
 * One agent per tab at a time. A lease is taken for every call on a tab and
 * kept for a short while after it, so a second agent cannot click in the middle
 * of another agent's multi-call task. The other agent waits, then gets a clear
 * "in use by X" instead of a tangle of interleaved clicks.
 */

interface Lease { client: string; busy: number; until: number }

export interface LeaseOptions { holdMs: number; waitMs: number; pollMs: number }

export class Leases {
  private readonly items = new Map<string, Lease>()
  private readonly opts: LeaseOptions

  constructor(opts: Partial<LeaseOptions> = {}, private readonly now: () => number = Date.now) {
    this.opts = { holdMs: 60_000, waitMs: 30_000, pollMs: 150, ...opts }
  }

  private free(l: Lease | undefined, client: string): boolean {
    return !l || l.client === client || (l.busy === 0 && l.until <= this.now())
  }

  /** Null when the lease is held, or why not after waiting. */
  async acquire(key: string, client: string): Promise<string | null> {
    const end = this.now() + this.opts.waitMs
    for (;;) {
      const l = this.items.get(key)
      if (this.free(l, client)) {
        const mine = l && l.client === client ? l : { client, busy: 0, until: 0 }
        mine.busy++
        this.items.set(key, mine)
        return null
      }
      if (this.now() >= end) return `this tab is in use by ${l!.client}; wait for it to finish, or open your own tab`
      await new Promise(r => setTimeout(r, this.opts.pollMs))
    }
  }

  release(key: string, client: string): void {
    const l = this.items.get(key)
    if (!l || l.client !== client) return
    l.busy = Math.max(0, l.busy - 1)
    if (l.busy === 0) l.until = this.now() + this.opts.holdMs
  }

  /** Lets go of every lease of a client (it disconnected). */
  releaseAll(client: string): void {
    for (const [k, l] of this.items) if (l.client === client) this.items.delete(k)
  }

  list(): { key: string; client: string; busy: boolean; until: number }[] {
    const t = this.now()
    return [...this.items.entries()]
      .filter(([, l]) => l.busy > 0 || l.until > t)
      .map(([key, l]) => ({ key, client: l.client, busy: l.busy > 0, until: l.until }))
  }
}
