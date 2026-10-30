import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeName, siteName } from './store'

/**
 * A pack is everything one site needs, in one folder that can be shared and
 * updated as a whole:
 *   pack.json          { name, version, site, about }
 *   adapter.js         reads the site's own data in the page (optional)
 *   notes.md           what an agent should know there (optional)
 *   routines/*.yaml    ready routines (optional)
 *
 * Packs that ship with Tabgeist live in <install>/packs; ones the user added
 * live in ~/.tabgeist/packs and win over a shipped pack of the same name. The
 * user's own files in sites/<site>/ win over both: a pack is never edited in
 * place, so an update cannot overwrite what the user changed.
 */

export interface PackInfo {
  name: string
  version: string
  site: string
  about: string
  from: 'built-in' | 'installed'
  dir: string
}

const VERSION = /^\d+\.\d+\.\d+$/

/** Reads and checks a pack folder; returns what is wrong with it as a string. */
export function readPack(dir: string, from: PackInfo['from']): PackInfo | string {
  const f = join(dir, 'pack.json')
  if (!existsSync(f)) return `${dir} has no pack.json`
  let j: Record<string, unknown>
  try { j = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown> } catch (e) { return `pack.json does not parse: ${(e as Error).message}` }
  const name = typeof j.name === 'string' ? j.name : ''
  try { safeName(name) } catch { return 'pack.json: name must be letters, digits, dot, dash or underscore' }
  if (typeof j.version !== 'string' || !VERSION.test(j.version)) return 'pack.json: version must look like 1.2.3'
  let site: string
  try { site = siteName(String(j.site ?? '')) } catch { return 'pack.json: site must be a domain, like whatsapp.com' }
  return { name, version: j.version, site, about: typeof j.about === 'string' ? j.about : '', from, dir }
}

/** 1.10.0 > 1.9.3 */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** <install>/packs, from the bundle (dist/cli.mjs) or from the sources (src/sites/packs.ts). */
export function builtInPacksDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, '..', 'packs'), join(here, '..', '..', 'packs')].find(d => existsSync(d)) ?? join(here, '..', 'packs')
}

/** A working adapter to start from: one harmless op, replaced by the real ones. */
const STARTER_ADAPTER = (site: string) => `// What this pack reads on ${site} and where it comes from, in one or two lines.
// Rules: only read, fetch only ${site}'s own paths, return small plain data, give every op a limit.
// The tabgeist-pack skill walks an agent through writing the real ops.
(() => {
  return {
    ops: {
      page: {
        about: 'the open page: { limit=20 } → { title, url, headings }',
        run: async ({ limit = 20 } = {}) => {
          if (!/(^|\\.)${site.replace(/\./g, '\\.')}$/.test(location.hostname)) throw new Error('open ${site} first')
          const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => h.textContent.trim()).filter(Boolean).slice(0, Math.min(Number(limit) || 20, 100))
          return { title: document.title, url: location.href, headings }
        },
      },
    },
  }
})()
`

/**
 * Starts a pack folder for a site: pack.json, a starter adapter, notes, and the
 * user's own routines for that site (their notes stay out: they can be personal).
 */
export function newPack(site: string, dest: string, sitesRoot: string): { ok: true; dir: string; routines: string[] } | { ok: false; error: string } {
  let s: string
  try { s = siteName(site) } catch { return { ok: false, error: 'site must be a domain, like linkedin.com' } }
  const dir = resolve(dest)
  if (existsSync(dir) && readdirSync(dir).length) return { ok: false, error: `${dir} is not empty` }
  const name = s.split('.')[0]
  mkdirSync(join(dir, 'routines'), { recursive: true })
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name, version: '0.1.0', site: s, about: `Reads ${s} as clean data.` }, null, 2) + '\n')
  writeFileSync(join(dir, 'adapter.js'), STARTER_ADAPTER(s))
  writeFileSync(join(dir, 'notes.md'), `# ${name} pack\n\n- Which op answers which question, ids to pass, what the pack does not do (three to six lines).\n`)
  const own = join(sitesRoot, s, 'routines')
  const routines = existsSync(own) ? readdirSync(own).filter(f => f.endsWith('.yaml') && !f.startsWith('.')) : []
  for (const f of routines) cpSync(join(own, f), join(dir, 'routines', f))
  return { ok: true, dir, routines: routines.map(f => f.slice(0, -5)) }
}

export class PackStore {
  constructor(readonly installedDir: string, readonly builtInDir: string = builtInPacksDir()) {}

  private scan(root: string, from: PackInfo['from']): PackInfo[] {
    if (!existsSync(root)) return []
    return readdirSync(root).filter(n => !n.startsWith('.') && statSync(join(root, n)).isDirectory())
      .map(n => readPack(join(root, n), from)).filter((p): p is PackInfo => typeof p !== 'string')
  }

  /** Every pack in use, one per name (an installed one hides the shipped one). */
  list(): PackInfo[] {
    const byName = new Map<string, PackInfo>()
    for (const p of this.scan(this.builtInDir, 'built-in')) byName.set(p.name, p)
    for (const p of this.scan(this.installedDir, 'installed')) byName.set(p.name, p)
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The pack for a site; subdomains count (web.whatsapp.com → whatsapp.com). */
  forSite(hostOrSite: string): PackInfo | null {
    let site: string
    try { site = siteName(hostOrSite) } catch { return null }
    return this.list().find(p => p.site === site) ?? null
  }

  /** A file inside a pack, never outside it (no '..', no other drive, no link out). */
  private file(p: PackInfo, ...parts: string[]): string | null {
    const f = resolve(p.dir, ...parts)
    if (!existsSync(f)) return null
    const rel = relative(realpathSync(p.dir), realpathSync(f))
    return rel.startsWith('..') || isAbsolute(rel) ? null : f
  }

  adapter(site: string): { source: string; pack: PackInfo } | null {
    const p = this.forSite(site)
    const f = p && this.file(p, 'adapter.js')
    return p && f ? { source: readFileSync(f, 'utf8'), pack: p } : null
  }

  notes(site: string): string {
    const p = this.forSite(site)
    const f = p && this.file(p, 'notes.md')
    return f ? readFileSync(f, 'utf8') : ''
  }

  routineNames(site: string): string[] {
    const p = this.forSite(site)
    const d = p && this.file(p, 'routines')
    if (!d) return []
    return readdirSync(d).filter(f => f.endsWith('.yaml')).map(f => f.slice(0, -5)).filter(n => /^[\w.-]{1,60}$/.test(n) && !n.startsWith('.')).sort()
  }

  routineText(site: string, name: string): string | null {
    const p = this.forSite(site)
    const f = p && this.file(p, 'routines', `${safeName(name)}.yaml`)
    return f ? readFileSync(f, 'utf8') : null
  }

  /**
   * Copies a pack folder into the installed packs. An older or equal version
   * is refused unless `force`; the version it replaces moves to .history/.
   */
  install(from: string, force = false): { ok: true; pack: PackInfo; replaced?: string } | { ok: false; error: string } {
    const src = readPack(resolve(from), 'installed')
    if (typeof src === 'string') return { ok: false, error: src }
    const dest = join(this.installedDir, src.name)
    if (resolve(from) === resolve(dest)) return { ok: false, error: 'that folder is the installed pack itself' }
    const other = this.list().find(p => p.site === src.site && p.name !== src.name)
    if (other) return { ok: false, error: `${src.site} already has the ${other.name} pack; one pack per site` }
    const cur = this.list().find(p => p.name === src.name)
    if (cur && !force && !newer(src.version, cur.version)) return { ok: false, error: `${src.name} ${cur.version} is in use; ${src.version} is not newer (--force installs it anyway)` }
    let replaced: string | undefined
    if (existsSync(dest)) {
      const old = readPack(dest, 'installed')
      replaced = typeof old === 'string' ? undefined : old.version
      const hist = join(this.installedDir, '.history')
      mkdirSync(hist, { recursive: true })
      renameSync(dest, join(hist, `${src.name}.v${replaced ?? 'unknown'}.${Date.now()}`))
    }
    mkdirSync(this.installedDir, { recursive: true })
    // Links are left out: an installed pack is only its own files.
    cpSync(resolve(from), dest, { recursive: true, filter: s => !lstatSync(s).isSymbolicLink() && !/[\\/](\.git|node_modules)([\\/]|$)/.test(s) })
    return { ok: true, pack: { ...src, dir: dest }, replaced }
  }
}
