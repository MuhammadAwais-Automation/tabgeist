import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { siteKey } from '../safety/fog'
import { EMPTY_POLICY, parsePolicy, type SitePolicy } from '../safety/policy'
import type { PackStore } from './packs'

/**
 * Everything learned about a site, in plain files the user can read, edit,
 * diff and share: sites/<site>/
 *   policy.yaml        the user's rules (block / ask / allow / limits / outbound)
 *   memory.md          lessons agents left for the next agent
 *   routines/<name>.yaml, routines/.history/<name>.v<N>.yaml, routines/.retired/
 *   health.json        last runs of each routine, canary results
 * A site's pack (packs.ts) adds routines, notes and an adapter underneath:
 * the user's own file of the same name always wins.
 */

export interface RunRecord { at: number; ok: boolean; ms: number; shadow?: boolean; healed?: number; error?: string; by: string }
export interface Health { routines: Record<string, { runs: RunRecord[]; broken?: string; brokenAt?: number }> }

/** A site's folder name: its registrable domain, lowercased, nothing that could escape the folder. */
export function siteName(hostOrUrl: string): string {
  const k = siteKey(hostOrUrl.trim()).replace(/[^a-z0-9.-]/g, '')
  if (!k || k.startsWith('.') || k.includes('..')) throw new Error(`not a site: ${hostOrUrl}`)
  return k
}

export function safeName(name: string): string {
  const n = name.trim()
  if (!/^[\w.-]{1,60}$/.test(n) || n.startsWith('.')) throw new Error(`routine names are letters, digits, dot, dash or underscore: ${name}`)
  return n
}

export class SiteStore {
  private readonly policyCache = new Map<string, { mtime: number; policy: SitePolicy }>()

  constructor(readonly root: string, readonly packs: PackStore | null = null) {}

  dir(site: string): string { return join(this.root, siteName(site)) }

  sites(): string[] {
    const own = existsSync(this.root) ? readdirSync(this.root).filter(n => statSync(join(this.root, n)).isDirectory()) : []
    return [...new Set([...own, ...(this.packs?.list().map(p => p.site) ?? [])])].sort()
  }

  // ── policy ──

  policyText(site: string): string {
    const f = join(this.dir(site), 'policy.yaml')
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  policy(site: string): SitePolicy {
    let f: string
    try { f = join(this.dir(site), 'policy.yaml') } catch { return EMPTY_POLICY }
    if (!existsSync(f)) return EMPTY_POLICY
    const mtime = statSync(f).mtimeMs
    const hit = this.policyCache.get(f)
    if (hit && hit.mtime === mtime) return hit.policy
    const p = parsePolicy(readFileSync(f, 'utf8'))
    const policy = typeof p === 'string' ? EMPTY_POLICY : p
    this.policyCache.set(f, { mtime, policy })
    return policy
  }

  /** Saves the user's rules after checking them; returns the error when they do not parse. */
  savePolicy(site: string, text: string): string | null {
    const p = parsePolicy(text)
    if (typeof p === 'string') return p
    mkdirSync(this.dir(site), { recursive: true })
    writeFileSync(join(this.dir(site), 'policy.yaml'), text, 'utf8')
    return null
  }

  // ── memory ──

  notes(site: string): string {
    const f = join(this.dir(site), 'memory.md')
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  addNote(site: string, note: string, by: string): void {
    mkdirSync(this.dir(site), { recursive: true })
    const f = join(this.dir(site), 'memory.md')
    const head = existsSync(f) ? '' : `# ${siteName(site)}\n\nLessons agents left for the next agent. Edit freely.\n\n`
    const line = note.replace(/\s+/g, ' ').trim().slice(0, 500)
    appendFileSync(f, `${head}- ${line} _(${by}, ${new Date().toISOString().slice(0, 10)})_\n`, 'utf8')
  }

  saveNotes(site: string, text: string): void {
    mkdirSync(this.dir(site), { recursive: true })
    writeFileSync(join(this.dir(site), 'memory.md'), text, 'utf8')
  }

  // ── routines (YAML text; parsing lives in routines/format.ts) ──

  routineNames(site: string): string[] {
    const d = join(this.dir(site), 'routines')
    const own = existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.yaml')).map(f => f.slice(0, -5)) : []
    return [...new Set([...own, ...(this.packs?.routineNames(site) ?? [])])].sort()
  }

  routineText(site: string, name: string): string | null {
    const f = join(this.dir(site), 'routines', `${safeName(name)}.yaml`)
    return existsSync(f) ? readFileSync(f, 'utf8') : this.packs?.routineText(site, name) ?? null
  }

  /** Whose copy of a routine runs: the user's own file, or the site's pack. */
  routineFrom(site: string, name: string): 'user' | 'pack' | null {
    if (existsSync(join(this.dir(site), 'routines', `${safeName(name)}.yaml`))) return 'user'
    return this.packs?.routineText(site, name) != null ? 'pack' : null
  }

  /** Writes a routine; the previous version goes to routines/.history. */
  saveRoutine(site: string, name: string, text: string, version: number): void {
    const d = join(this.dir(site), 'routines')
    mkdirSync(join(d, '.history'), { recursive: true })
    const f = join(d, `${safeName(name)}.yaml`)
    if (existsSync(f)) writeFileSync(join(d, '.history', `${safeName(name)}.v${version - 1}.yaml`), readFileSync(f, 'utf8'), 'utf8')
    writeFileSync(f, text, 'utf8')
  }

  /** Earlier versions, newest first. */
  history(site: string, name: string): { version: number; text: string }[] {
    const d = join(this.dir(site), 'routines', '.history')
    if (!existsSync(d)) return []
    const prefix = `${safeName(name)}.v`
    return readdirSync(d).filter(f => f.startsWith(prefix) && f.endsWith('.yaml'))
      .map(f => ({ version: Number(f.slice(prefix.length, -5)), text: readFileSync(join(d, f), 'utf8') }))
      .filter(h => Number.isFinite(h.version)).sort((a, b) => b.version - a.version)
  }

  /** Moves a routine out of use into routines/.retired (nothing is deleted from disk). */
  retireRoutine(site: string, name: string): boolean {
    const d = join(this.dir(site), 'routines')
    const f = join(d, `${safeName(name)}.yaml`)
    if (!existsSync(f)) return false
    mkdirSync(join(d, '.retired'), { recursive: true })
    renameSync(f, join(d, '.retired', `${safeName(name)}.${Date.now()}.yaml`))
    return true
  }

  // ── health ──

  health(site: string): Health {
    try { return JSON.parse(readFileSync(join(this.dir(site), 'health.json'), 'utf8')) as Health } catch { return { routines: {} } }
  }

  recordRun(site: string, name: string, run: RunRecord, broken?: string | null): Health {
    const h = this.health(site)
    const r = h.routines[name] ?? { runs: [] }
    r.runs = [...r.runs, run].slice(-30)
    if (broken) { r.broken = broken; r.brokenAt = run.at } else if (broken === null) { delete r.broken; delete r.brokenAt }
    h.routines[name] = r
    mkdirSync(this.dir(site), { recursive: true })
    writeFileSync(join(this.dir(site), 'health.json'), JSON.stringify(h, null, 2), 'utf8')
    return h
  }
}
