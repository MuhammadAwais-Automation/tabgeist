import type { Fingerprint } from './routines'
import type { PageItem } from './types'

/**
 * Finds a routine's element again after the site changed, without a model
 * (the idea behind Scrapling's adaptive selectors): every element on the fresh
 * map gets a similarity score against the saved fingerprint — role, name,
 * stable attributes, position — and the best one wins only when it is clearly
 * better than the runner-up. Exact matching (actions.ts `locate`) runs first;
 * this is the fallback before a heal ticket.
 */

/** Dice coefficient over character bigrams: 1 for equal strings, 0 for nothing shared. */
export function dice(a: string, b: string): number {
  const x = a.toLowerCase().replace(/\s+/g, ' ').trim(), y = b.toLowerCase().replace(/\s+/g, ' ').trim()
  if (x === y) return x ? 1 : 0
  if (x.length < 2 || y.length < 2) return 0
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1) } return m }
  const gx = grams(x), gy = grams(y)
  let both = 0
  for (const [g, n] of gx) both += Math.min(n, gy.get(g) ?? 0)
  return (2 * both) / (x.length - 1 + y.length - 1)
}

/** Roles that can stand in for each other after a redesign (a link restyled as a button). */
const ACTIONABLE = new Set(['button', 'link', 'menuitem', 'tab', 'option', 'generic', 'listitem', 'cell', 'gridcell', 'row'])
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])

function roleScore(want: string, got: string): number {
  if (want === got) return 1
  if ((ACTIONABLE.has(want) && ACTIONABLE.has(got)) || (FIELDS.has(want) && FIELDS.has(got))) return 0.5
  return 0
}

function posScore(fp: Fingerprint, i: PageItem): number | null {
  if (fp.x == null || fp.y == null || i.x == null || i.y == null) return null
  return Math.max(0, 1 - Math.hypot(fp.x - i.x, fp.y - i.y) / 600)
}

export function attrScore(want: Record<string, string>, got: Record<string, string>): number | null {
  const keys = Object.keys(want).filter(k => k !== 'type')
  if (!keys.length) return null
  let s = 0
  for (const k of keys) s += got[k] == null ? 0 : got[k] === want[k] ? 1 : dice(want[k], got[k])
  return s / keys.length
}

export interface Scored { item: PageItem; score: number }

/**
 * Scores every item against the fingerprint (role 30 %, name 45 %, position 25 %;
 * attributes join in when `attrsOf` gives them). Highest first.
 */
export function scoreItems(items: PageItem[], fp: Fingerprint, attrs?: Map<string, Record<string, string>>): Scored[] {
  const out: Scored[] = []
  for (const item of items) {
    const parts: [number, number][] = [[roleScore(fp.role, item.role), 0.3], [fp.name ? dice(fp.name, item.name) : item.name ? 0 : 1, 0.45]]
    const pos = posScore(fp, item)
    if (pos != null) parts.push([pos, 0.25])
    const a = attrs?.get(item.ref)
    const as = a ? attrScore(fp.attrs, a) : null
    if (as != null) parts.push([as, 0.3])
    const weight = parts.reduce((s, [, w]) => s + w, 0)
    const score = parts.reduce((s, [v, w]) => s + v * w, 0) / weight
    if (score > 0) out.push({ item, score })
  }
  return out.sort((a, b) => b.score - a.score)
}

export const ACCEPT = 0.62
export const MARGIN = 0.08

/**
 * The element the fingerprint most likely became, or null when nothing is
 * close enough or two candidates are too close to tell apart.
 */
export async function relocate(items: PageItem[], fp: Fingerprint, attrsOf?: (ref: string) => Promise<Record<string, string>>): Promise<{ item: PageItem; score: number; runnerUp?: number } | null> {
  let ranked = scoreItems(items, fp)
  if (attrsOf && Object.keys(fp.attrs).length) {
    const top = ranked.slice(0, 12)
    const attrs = new Map<string, Record<string, string>>()
    for (const s of top) attrs.set(s.item.ref, await attrsOf(s.item.ref).catch(() => ({})))
    ranked = scoreItems(top.map(s => s.item), fp, attrs)
  }
  const [best, second] = ranked
  if (!best || best.score < ACCEPT) return null
  if (second && best.score - second.score < MARGIN) return null
  return { item: best.item, score: Math.round(best.score * 100) / 100, ...(second ? { runnerUp: Math.round(second.score * 100) / 100 } : {}) }
}
