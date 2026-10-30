import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Everything agents did, one JSON line per call, one file per day. Text that
 * could hold secrets is fogged before it is written (the caller passes
 * `redact`), screenshots are files next to it, and nothing leaves the machine.
 */

export interface TimelineEntry {
  id: string
  at: number
  /** One agent connection (an MCP session); replays and exports are per session. */
  session: string
  agent: string
  browser?: string
  tab?: number
  site?: string
  method: string
  /** What was asked, short and redacted: `click button "Send"`, `read main`. */
  input?: string
  ok: boolean
  ms: number
  /** What happened, short: the receipt in one line. */
  summary: string
  error?: string
  /** File name in ~/.tabgeist/shots of the page after the step. */
  shot?: string
  approvals?: { title: string; allow: boolean; by?: string }[]
  /** Routine runs and heals link here. */
  routine?: string
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

export class Timeline extends EventEmitter {
  constructor(private readonly dir: string, private readonly redact: (s: string) => string = s => s) {
    super()
  }

  add(e: Omit<TimelineEntry, 'id' | 'at'> & { at?: number }): TimelineEntry {
    const entry: TimelineEntry = {
      ...e,
      id: randomBytes(6).toString('hex'),
      at: e.at ?? Date.now(),
      ...(e.input != null ? { input: this.redact(e.input).slice(0, 400) } : {}),
      summary: this.redact(e.summary).slice(0, 600),
      ...(e.error ? { error: this.redact(e.error).slice(0, 600) } : {}),
    }
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(join(this.dir, `${day(entry.at)}.jsonl`), JSON.stringify(entry) + '\n', 'utf8')
    this.emit('entry', entry)
    return entry
  }

  /** Days that have entries, newest first. */
  days(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map(f => f.slice(0, 10)).sort().reverse()
  }

  read(d: string): TimelineEntry[] {
    const file = join(this.dir, `${d}.jsonl`)
    if (!existsSync(file)) return []
    const out: TimelineEntry[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line) as TimelineEntry) } catch { /* a torn last line after a crash */ }
    }
    return out
  }

  /** Newest entries first, across days, filtered. */
  recent(opts: { limit?: number; session?: string; site?: string; agent?: string; days?: number } = {}): TimelineEntry[] {
    const limit = opts.limit ?? 200
    const out: TimelineEntry[] = []
    for (const d of this.days().slice(0, opts.days ?? 7)) {
      const rows = this.read(d).reverse().filter(e => (!opts.session || e.session === opts.session) && (!opts.site || e.site === opts.site) && (!opts.agent || e.agent === opts.agent))
      out.push(...rows)
      if (out.length >= limit) break
    }
    return out.slice(0, limit)
  }

  /** Sessions of the last days with their agent, first/last time and step count, newest first. */
  sessions(days = 7): { session: string; agent: string; from: number; to: number; steps: number; failed: number; sites: string[] }[] {
    const by = new Map<string, { session: string; agent: string; from: number; to: number; steps: number; failed: number; sites: Set<string> }>()
    for (const d of this.days().slice(0, days)) {
      for (const e of this.read(d)) {
        const s = by.get(e.session) ?? { session: e.session, agent: e.agent, from: e.at, to: e.at, steps: 0, failed: 0, sites: new Set<string>() }
        s.from = Math.min(s.from, e.at)
        s.to = Math.max(s.to, e.at)
        s.steps++
        if (!e.ok) s.failed++
        if (e.site) s.sites.add(e.site)
        by.set(e.session, s)
      }
    }
    return [...by.values()].map(s => ({ ...s, sites: [...s.sites] })).sort((a, b) => b.to - a.to)
  }

  session(id: string, days = 30): TimelineEntry[] {
    const out: TimelineEntry[] = []
    for (const d of this.days().slice(0, days).reverse()) out.push(...this.read(d).filter(e => e.session === id))
    return out
  }
}
