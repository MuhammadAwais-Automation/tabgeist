import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Fingerprint } from '../engine/routines'

/**
 * Heal tickets: what happens when a routine meets a changed site.
 * - drift: the run found its element again by similarity and passed; the ticket
 *   carries the routine with the new fingerprints, ready for the user to accept.
 * - broken: a step's element could not be found; the ticket carries the
 *   evidence (the page as it is now, a picture, the requests) for an agent to
 *   propose a fix, which is dry-run before the user sees it.
 * Nothing replaces a routine without the user's click in the control room.
 */

export type HealStatus = 'open' | 'testing' | 'ready' | 'failed' | 'applied' | 'dismissed'

export interface HealTicket {
  id: string
  site: string
  routine: string
  /** The routine version the ticket is about. */
  version: number
  kind: 'broken' | 'drift'
  status: HealStatus
  at: number
  step?: number
  error: string
  evidence: { url: string; snapshot: string; shot?: string; requests?: string[] }
  drift?: { step: number; from: Fingerprint; to: Fingerprint; score: number }[]
  proposal?: { yaml: string; note?: string; by: string; at: number; test?: { ok: boolean; summary: string } }
  closedAt?: number
}

export class HealStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!/^[a-f0-9]{8,16}$/.test(id)) throw new Error(`not a heal ticket id: ${id}`)
    return join(this.dir, `${id}.json`)
  }

  get(id: string): HealTicket | null {
    try { return JSON.parse(readFileSync(this.file(id), 'utf8')) as HealTicket } catch { return null }
  }

  save(t: HealTicket): HealTicket {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file(t.id), JSON.stringify(t, null, 2), 'utf8')
    return t
  }

  list(filter: { site?: string; routine?: string; open?: boolean } = {}): HealTicket[] {
    if (!existsSync(this.dir)) return []
    const out: HealTicket[] = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const t = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as HealTicket
        if (filter.site && t.site !== filter.site) continue
        if (filter.routine && t.routine !== filter.routine) continue
        if (filter.open && !['open', 'testing', 'ready', 'failed'].includes(t.status)) continue
        out.push(t)
      } catch { /* a torn file */ }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /**
   * Opens a ticket, or refreshes the one already open for the same routine and
   * kind, so a routine that keeps failing does not pile up tickets.
   */
  open(t: Omit<HealTicket, 'id' | 'at' | 'status'> & { status?: HealStatus }): HealTicket {
    const same = this.list({ site: t.site, routine: t.routine, open: true }).find(x => x.kind === t.kind)
    const ticket: HealTicket = { ...t, id: same?.id ?? randomBytes(5).toString('hex'), at: Date.now(), status: t.status ?? 'open', ...(same?.proposal && t.kind === 'broken' ? { proposal: same.proposal } : {}) }
    return this.save(ticket)
  }

  close(id: string, status: 'applied' | 'dismissed'): HealTicket | null {
    const t = this.get(id)
    if (!t) return null
    t.status = status
    t.closedAt = Date.now()
    return this.save(t)
  }
}
