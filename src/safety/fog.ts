/**
 * Secret fog: card numbers, API keys, tokens and one-time codes on a page are
 * replaced by {{secret:N}} before the agent (or the timeline) ever sees them.
 * The agent can still use one: typing {{secret:N}} puts the real value in,
 * but only on the site it came from, so a page cannot trick the agent into
 * carrying it elsewhere.
 */

export interface FogEntry { id: number; site: string; kind: string; value: string; at: number }

/** Luhn check: real card numbers pass it, most other long digit runs do not. */
export function luhn(digits: string): boolean {
  let sum = 0, alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

interface Pattern { kind: string; re: RegExp; group?: number; check?: (v: string) => boolean }

const PATTERNS: Pattern[] = [
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'token', re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g },
  { kind: 'api key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: 'api key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'api key', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'api key', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'api key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'api key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'card', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: v => { const d = v.replace(/\D/g, ''); return cardBrandOk(d) && luhn(d) } },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, check: ibanOk },
  // A code next to the words that announce one: "Your code is 482913", "OTP: 4829", "کوڈ 123456".
  // Not across JSON or markup (quotes, braces), and not a date or a time ("2026-10", "12:30").
  { kind: 'one-time code', re: /(?<![\p{L}\p{N}])(?:code|otp|passcode|verification|security code|pin|one-time|کوڈ|कोड|código|code de vérification|Bestätigungscode)(?![\p{L}])[^\d\n"{}[\]<>]{0,30}?(\d{4,8})(?!\d)(?![-/:.]\d)/giu, group: 1 },
]

/**
 * Card numbers have a brand prefix and a length that goes with it; Luhn alone
 * lets one long id in ten through (a WhatsApp chat id, an order number).
 */
export function cardBrandOk(d: string): boolean {
  const n = d.length
  const p2 = Number(d.slice(0, 2)), p4 = Number(d.slice(0, 4))
  if (d[0] === '4') return n === 13 || n === 16 || n === 19
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return n === 16
  if (p2 === 34 || p2 === 37) return n === 15
  if (p2 === 36 || p2 === 38 || p2 === 30) return n >= 14 && n <= 19
  if (p2 === 35 || p2 === 62 || d.startsWith('6011') || p2 === 65 || (Number(d.slice(0, 3)) >= 644 && Number(d.slice(0, 3)) <= 649)) return n >= 16 && n <= 19
  return false
}

function ibanOk(raw: string): boolean {
  const s = raw.replace(/ /g, '')
  if (s.length < 15 || s.length > 34) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97
  }
  return rem === 1
}

/** Every secret-looking value in a text, with its kind and where it stands (for tests and the timeline). */
export function findSecrets(text: string): { kind: string; value: string; at: number[] }[] {
  const out: { kind: string; value: string; at: number[] }[] = []
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const value = p.group ? m[p.group] : m[0]
      if (!value || (p.check && !p.check(value))) continue
      // The group ends the match (only lookaheads follow it).
      const at = m.index + (p.group ? m[0].length - value.length : 0)
      const known = out.find(o => o.value === value)
      if (known) known.at.push(at)
      else out.push({ kind: p.kind, value, at: [at] })
    }
  }
  return out
}

/**
 * Swaps spans of `text` for their placeholders in one pass. Only where a value
 * was found: a short code like 4829 must not take every "4829" on the page
 * (a year, a price) with it.
 */
function replaceSpans(text: string, spans: { at: number; len: number; with: string }[]): string {
  let out = ''
  let pos = 0
  for (const s of spans.sort((a, b) => a.at - b.at)) {
    if (s.at < pos) continue
    out += text.slice(pos, s.at) + s.with
    pos = s.at + s.len
  }
  return out + text.slice(pos)
}

/** "www.mail.example.co.uk" and "mail.example.co.uk" are one site; a fogged value stays on its site. */
export function siteKey(hostOrUrl: string): string {
  let host = hostOrUrl
  try { if (/^[a-z]+:\/\//i.test(hostOrUrl)) host = new URL(hostOrUrl).host } catch { /* a bare host */ }
  const bare = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  // An address or a single-label host (localhost) is its own site.
  if (/^\d+(\.\d+){3}$/.test(bare) || !bare.includes('.') || bare.includes(':')) return bare
  const parts = bare.split('.').filter(Boolean)
  // Two-letter country domains with a second level (co.uk, com.pk, com.au) keep three labels.
  const keep = parts.length >= 3 && parts[parts.length - 1].length === 2 && /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]) ? 3 : 2
  return parts.slice(-keep).join('.')
}

const MAX_KEEP = 500

export class SecretFog {
  private readonly byValue = new Map<string, FogEntry>()
  private readonly byId = new Map<number, FogEntry>()
  private next = 1

  /** Replaces every secret in `text` with {{secret:N}}; the same value always gets the same N. */
  redact(text: string, site: string): string {
    if (!text) return text
    let out = replaceSpans(text, findSecrets(text).flatMap(s => {
      const e = this.remember(s.value, s.kind, site)
      return s.at.map(at => ({ at, len: s.value.length, with: `{{secret:${e.id}}}` }))
    }))
    // Values fogged before (on any site) never show again, even where no pattern finds them.
    for (const e of this.byValue.values()) if (e.value.length >= 6 && out.includes(e.value)) out = out.split(e.value).join(`{{secret:${e.id}}}`)
    return out
  }

  /** For storage (the timeline): patterns and known values out, nothing remembered. */
  scrub(text: string): string {
    if (!text) return text
    let out = text
    for (const e of this.byValue.values()) if (e.value.length >= 6 && out.includes(e.value)) out = out.split(e.value).join(`{{secret:${e.id}}}`)
    return replaceSpans(out, findSecrets(out).flatMap(s => s.at.map(at => ({ at, len: s.value.length, with: `{{secret:${s.kind}}}` }))))
  }

  /**
   * Puts the real values back into text the agent wants to type. A placeholder
   * from another site is refused: that is how a page would make an agent leak it.
   */
  reveal(text: string, site: string): { text: string } | { error: string } {
    let error = ''
    const out = text.replace(/\{\{\s*secret:(\d+)\s*\}\}/g, (m, n: string) => {
      const e = this.byId.get(Number(n))
      if (!e) { error ||= `${m} is unknown (secrets are forgotten when the daemon restarts); read the page again`; return m }
      if (siteKey(e.site) !== siteKey(site)) { error ||= `${m} came from ${e.site} and can only be typed there, not on ${site}`; return m }
      return e.value
    })
    return error ? { error } : { text: out }
  }

  /** Whether a text (a url, a request body) carries a fogged value outside its own site. */
  leaks(text: string, toSite: string): FogEntry | null {
    for (const e of this.byValue.values()) {
      if (e.value.length < 6 || siteKey(e.site) === siteKey(toSite)) continue
      if (text.includes(e.value) || text.includes(encodeURIComponent(e.value))) return e
    }
    return null
  }

  list(): Omit<FogEntry, 'value'>[] {
    return [...this.byId.values()].map(({ value: _v, ...rest }) => rest)
  }

  private remember(value: string, kind: string, site: string): FogEntry {
    const known = this.byValue.get(value)
    if (known) return known
    const e: FogEntry = { id: this.next++, site, kind, value, at: Date.now() }
    this.byValue.set(value, e)
    this.byId.set(e.id, e)
    if (this.byValue.size > MAX_KEEP) {
      const oldest = this.byValue.values().next().value as FogEntry
      this.byValue.delete(oldest.value)
      this.byId.delete(oldest.id)
    }
    return e
  }
}
