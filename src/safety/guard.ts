import type { Judge } from '../engine/actions'
import { riskCategory } from '../engine/safety'
import type { SiteStore } from '../sites/store'
import { ExfilWatch } from './exfil'
import { SecretFog, siteKey } from './fog'
import { leakReason } from './netgate'
import { judgeStep, RateBook, stepKey } from './policy'

/**
 * All the daemon's safety in one place: secret fog, what was read where
 * (exfiltration), the user's per-site rules and limits, and which sites
 * agents have been on (strict navigation).
 */
export class Guard {
  readonly fog = new SecretFog()
  readonly exfil = new ExfilWatch()
  readonly rates = new RateBook()
  private readonly visited = new Set<string>()

  constructor(readonly sites: SiteStore) {}

  /** Page text for the agent: secrets fogged and remembered for this site, what was read noted. */
  shown(text: string, site: string, remember = true): string {
    const out = this.fog.redact(text, site)
    if (remember && site) this.exfil.remember(out, site)
    return out
  }

  /** Text for storage (timeline): secrets out, nothing remembered. */
  scrub(text: string): string { return this.fog.scrub(text) }

  visit(site: string): void { if (site) this.visited.add(siteKey(site)) }

  /** The engine hook for a site: the user's block / ask / allow rules for each step. */
  judge(site: string): Judge {
    const p = this.sites.policy(site)
    if (!p.block.length && !p.ask.length && !p.allow.length) return () => null
    return (req, target) => judgeStep(p, stepKey(req.action, target))?.verdict ?? null
  }

  /** Counts one approved risky step against the site's limits; the limit's text when it is reached. */
  limit(site: string, targetName: string | undefined): string | null {
    return this.rates.take(siteKey(site), riskCategory(targetName ?? ''), this.sites.policy(site))
  }

  /**
   * Whether an agent may open this url: block (never), ask (the user decides) or
   * go. `fromSite` is the site of the tab it navigates away from.
   */
  navigation(url: string, fromSite: string | undefined, strict: boolean): { block: string } | { ask: string } | null {
    if (/\{\{\s*secret:/i.test(url)) return { block: 'a {{secret:N}} cannot go into an address; type it into the page it belongs to' }
    let host = ''
    try { host = new URL(url).host } catch { return null }
    const rule = host ? judgeStep(this.sites.policy(host), `navigate:${url}`) : null
    if (rule?.verdict === 'block') return { block: `the user's rules for ${host} block this address (${rule.rule})` }
    if (rule?.verdict === 'ask') return { ask: `the user's rules for ${host} ask before opening this address` }
    const leak = leakReason({ site: fromSite ?? '', outbound: [], fog: this.fog, exfil: this.exfil }, url)
    if (leak) return { ask: `this address ${leak.replace(/^it /, '')}` }
    if (strict && host && !this.visited.has(siteKey(host))) return { ask: `no agent has been on ${siteKey(host)} yet (strict navigation is on)` }
    return null
  }
}
