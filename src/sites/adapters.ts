import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SiteStore } from './store'

/** The adapter for a site: the user's own sites/<site>/adapter.js first, then the site's pack (packs/<name>/adapter.js). */
export function adapterFor(sites: SiteStore, host: string): { source: string; from: 'user' | 'pack'; pack?: string } | null {
  let dir: string
  try { dir = sites.dir(host) } catch { return null }
  const own = join(dir, 'adapter.js')
  if (existsSync(own)) return { source: readFileSync(own, 'utf8'), from: 'user' }
  const p = sites.packs?.adapter(host)
  return p ? { source: p.source, from: 'pack', pack: `${p.pack.name} ${p.pack.version}` } : null
}
