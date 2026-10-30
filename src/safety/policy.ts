import { parse } from 'yaml'
import { riskCategory, type RiskCategory } from '../engine/safety'

/**
 * The user's own rules for a site, in sites/<site>/policy.yaml:
 *
 *   block: ['click:*delete account*', 'navigate:*billing*']   # never, whatever the agent says
 *   ask:   ['click:*archive*']                                  # always ask, even when it looks harmless
 *   allow: ['click:button "save draft"']                        # no card for this one
 *   limits: { send: 3/h, pay: 1/d }                            # at most this many approved steps
 *   outbound: [api.example.com]                                 # other domains this site may send data to
 *
 * Patterns match `<action>:<role> "<name>"` (or `navigate:<url>`), lowercased; * is any text.
 */

export interface SitePolicy {
  block: string[]
  ask: string[]
  allow: string[]
  limits: Partial<Record<RiskCategory | 'any', { count: number; perMs: number; text: string }>>
  outbound: string[]
}

export const EMPTY_POLICY: SitePolicy = { block: [], ask: [], allow: [], limits: {}, outbound: [] }

const PER: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

export function parsePolicy(text: string): SitePolicy | string {
  let raw: unknown
  try { raw = parse(text) ?? {} } catch (e) { return `policy is not valid YAML: ${e instanceof Error ? e.message : String(e)}` }
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'policy must be a mapping (block:, ask:, allow:, limits:, outbound:)'
  const r = raw as Record<string, unknown>
  const list = (k: string): string[] | string => {
    const v = r[k]
    if (v == null) return []
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return `${k} must be a list of patterns`
    return (v as string[]).map(x => x.trim().toLowerCase()).filter(Boolean)
  }
  const out: SitePolicy = { ...EMPTY_POLICY, limits: {} }
  for (const k of ['block', 'ask', 'allow', 'outbound'] as const) {
    const v = list(k)
    if (typeof v === 'string') return v
    out[k] = v
  }
  if (r.limits != null) {
    if (typeof r.limits !== 'object' || Array.isArray(r.limits)) return 'limits must be a mapping like { send: 3/h }'
    for (const [k, v] of Object.entries(r.limits as Record<string, unknown>)) {
      const m = /^\s*(\d+)\s*\/\s*([mhd])\s*$/.exec(String(v))
      if (!m) return `limit ${k} must look like 3/h (per minute m, hour h or day d)`
      out.limits[k as RiskCategory] = { count: Number(m[1]), perMs: PER[m[2]], text: `${m[1]}/${m[2]}` }
    }
  }
  return out
}

/** Glob with * only, case-insensitive. */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'is')
  return re.test(text)
}

/** What the rules say about one step: `click:button "send"`. */
export function judgeStep(p: SitePolicy, step: string): { verdict: 'block' | 'ask' | 'allow'; rule: string } | null {
  const s = step.toLowerCase()
  for (const verdict of ['block', 'ask', 'allow'] as const) {
    const rule = p[verdict].find(r => globMatch(r, s))
    if (rule) return { verdict, rule }
  }
  return null
}

export function stepKey(action: string, target?: { role: string; name: string }): string {
  return target ? `${action}:${target.role} "${target.name}"` : action
}

/** Approved risky steps per site and category, for limits. */
export class RateBook {
  private readonly log = new Map<string, number[]>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Null when one more is allowed (and counts it), else the limit that stops it. */
  take(site: string, category: RiskCategory | null, p: SitePolicy): string | null {
    const keys = [category, 'any'].filter((k): k is RiskCategory | 'any' => !!k && !!p.limits[k as RiskCategory])
    const t = this.now()
    for (const k of keys) {
      const lim = p.limits[k]!
      const list = (this.log.get(`${site}|${k}`) ?? []).filter(at => at > t - lim.perMs)
      if (list.length >= lim.count) return `your limit for ${k} on ${site} is ${lim.text}; it is reached`
      this.log.set(`${site}|${k}`, list)
    }
    for (const k of keys) this.log.get(`${site}|${k}`)!.push(t)
    return null
  }
}

export { riskCategory }
