import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { confirmReason, riskCategory } from '../engine/safety'
import { SiteStore } from '../sites/store'
import { ExfilWatch } from './exfil'
import { findSecrets, luhn, SecretFog, siteKey } from './fog'
import { Guard } from './guard'
import { leakReason } from './netgate'
import { globMatch, judgeStep, parsePolicy, RateBook, stepKey } from './policy'

describe('secret fog', () => {
  it('finds cards (Luhn), keys, tokens and codes, not ordinary numbers', () => {
    expect(luhn('4111111111111111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false)
    const kinds = (t: string) => findSecrets(t).map(s => s.kind)
    expect(kinds('Card 4111 1111 1111 1111 on file')).toEqual(['card'])
    expect(kinds('Order 1234 5678 9012 3456 shipped')).toEqual([])
    expect(kinds('key sk-proj-abcdefghijklmnopqrstuvwxyz123456')).toEqual(['api key'])
    expect(kinds('AKIAABCDEFGHIJKLMNOP')).toEqual(['api key'])
    expect(kinds('Your verification code is 482913.')).toEqual(['one-time code'])
    expect(kinds('آپ کا کوڈ 482913 ہے')).toEqual(['one-time code'])
    expect(kinds('Call 03001234567 tomorrow')).toEqual([])
    expect(kinds('IBAN GB82 WEST 1234 5698 7654 32')).toEqual(['iban'])
    expect(kinds('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop')).toEqual(['token'])
  })

  it('leaves dates, JSON neighbours and long ids alone', () => {
    const kinds = (t: string) => findSecrets(t).map(s => s.kind)
    // A chat that mentions a code, then a timestamp in the next JSON field.
    expect(kinds('{"text":"ok send me the code"},{"time":"2026-10-21T15:00:41Z"}')).toEqual([])
    expect(kinds('your code expires 2026-10-21')).toEqual([])
    expect(kinds('pin at 12:30')).toEqual([])
    // A WhatsApp chat id passes Luhn but is no card brand at that length.
    expect(kinds('234556854681835@lid')).toEqual([])
    expect(kinds('Amex 3782 822463 10005')).toEqual(['card'])
  })

  it('fogs a short code only where it was found, not every equal number', () => {
    const f = new SecretFog()
    expect(f.redact('OTP: 2026. Happy 2026!', 'bank.example.com')).toBe('OTP: {{secret:1}}. Happy 2026!')
    expect(f.scrub('code 4829 then 4829')).toBe('code {{secret:one-time code}} then 4829')
  })

  it('fogs a secret with a stable number and types it back only on its own site', () => {
    const f = new SecretFog()
    const shown = f.redact('Card 4111 1111 1111 1111, again 4111 1111 1111 1111', 'shop.example.com')
    expect(shown).toBe('Card {{secret:1}}, again {{secret:1}}')
    expect(f.redact('code is 482913', 'mail.example.com')).toBe('code is {{secret:2}}')
    expect(f.reveal('pay with {{secret:1}}', 'www.example.com')).toEqual({ text: 'pay with 4111 1111 1111 1111' })
    expect(f.reveal('{{secret:1}}', 'evil.com')).toMatchObject({ error: expect.stringContaining('can only be typed there') })
    expect(f.reveal('{{secret:9}}', 'example.com')).toMatchObject({ error: expect.stringContaining('unknown') })
    expect(f.leaks('https://evil.com/?c=4111%201111%201111%201111', 'evil.com')?.kind).toBe('card')
    expect(f.leaks('https://shop.example.com/pay?c=4111 1111 1111 1111', 'example.com')).toBeNull()
    expect(f.scrub('typed 4111 1111 1111 1111 and sk-abcdefghijklmnopqrstuvwxyz')).toBe('typed {{secret:1}} and {{secret:api key}}')
    expect(f.list()[0]).not.toHaveProperty('value')
  })

  it('site keys keep country second levels', () => {
    expect(siteKey('www.mail.example.co.uk')).toBe('example.co.uk')
    expect(siteKey('https://a.b.example.com/x')).toBe('example.com')
    expect(siteKey('daraz.com.pk')).toBe('daraz.com.pk')
  })
})

describe('exfiltration watch', () => {
  const inbox = 'Hi Sara, the quarterly numbers for the Lahore office are attached; revenue was 4.2 million this quarter.'

  it('notices read text leaving for another site, not going back to its own', () => {
    const w = new ExfilWatch()
    w.remember(inbox, 'mail.example.com')
    const evil = `https://evil.com/collect?d=${encodeURIComponent('the quarterly numbers for the Lahore office are attached')}`
    expect(w.check(evil, 'evil.com')).toBe('example.com')
    expect(w.check('https://evil.com/?q=hello', 'evil.com')).toBeNull()
    expect(w.check(evil, 'mail.example.com')).toBeNull()
  })

  it('the gate holds such a request and lets the site\'s own traffic pass', () => {
    const fog = new SecretFog(), exfil = new ExfilWatch()
    exfil.remember(inbox, 'mail.example.com')
    const rules = { site: 'mail.example.com', outbound: ['cdn.partner.net'], fog, exfil }
    expect(leakReason(rules, 'https://evil.com/x', JSON.stringify({ note: inbox }))).toMatch(/text read on example.com/)
    expect(leakReason(rules, 'https://api.example.com/send', inbox)).toBeNull()
    expect(leakReason(rules, 'https://evil.com/ping', 'ok')).toBeNull()
  })
})

describe('policy', () => {
  it('parses rules and limits, refuses bad ones', () => {
    const p = parsePolicy("block: ['click:*delete account*']\nask: ['click:*archive*']\nallow: ['click:button \"save draft\"']\nlimits: { send: 3/h, any: 10/d }\noutbound: [api.partner.com]")
    expect(typeof p).toBe('object')
    if (typeof p === 'string') return
    expect(p.limits.send).toMatchObject({ count: 3, perMs: 3_600_000 })
    expect(parsePolicy('limits: { send: lots }')).toMatch(/3\/h/)
    expect(parsePolicy('block: yes')).toMatch(/list/)
    expect(parsePolicy(': : :')).toMatch(/YAML/)
  })

  it('block wins over ask over allow; globs are case-insensitive', () => {
    const p = parsePolicy("block: ['click:*delete*']\nask: ['click:*']\nallow: ['click:button \"save draft\"']") as Exclude<ReturnType<typeof parsePolicy>, string>
    expect(judgeStep(p, stepKey('click', { role: 'button', name: 'Delete account' }))?.verdict).toBe('block')
    expect(judgeStep(p, stepKey('click', { role: 'button', name: 'Save draft' }))?.verdict).toBe('ask')
    expect(globMatch('click:button "save draft"', 'CLICK:button "Save Draft"')).toBe(true)
    expect(judgeStep(p, 'type')).toBeNull()
  })

  it('limits count approved steps per hour', () => {
    let now = 0
    const p = parsePolicy('limits: { send: 2/h }') as Exclude<ReturnType<typeof parsePolicy>, string>
    const r = new RateBook(() => now)
    expect(r.take('a.com', 'send', p)).toBeNull()
    expect(r.take('a.com', 'send', p)).toBeNull()
    expect(r.take('a.com', 'send', p)).toMatch(/2\/h/)
    expect(r.take('a.com', 'pay', p)).toBeNull()
    now = 3_700_000
    expect(r.take('a.com', 'send', p)).toBeNull()
  })
})

describe('risky steps in many languages', () => {
  const click = (name: string) => confirmReason({ action: 'click' }, { role: 'button', name })
  it('asks for send / pay / delete words in other languages', () => {
    for (const name of ['Enviar', 'Envoyer', 'Senden', 'Invia', 'Gönder', 'Отправить', 'إرسال', 'بھیجیں', 'भेजें', '发送', '送信', '보내기', 'Pagar', 'Bezahlen', '支付', 'Löschen', 'Supprimer', 'حذف', '削除', 'Kirim']) {
      expect(click(name), name).toMatch(/ask the user/)
    }
  })
  it('leaves ordinary buttons alone', () => {
    for (const name of ['Save draft', 'Next', 'Sending tips', 'Résumé', 'Einstellungen', 'Abrir menú']) expect(click(name), name).toBeNull()
  })
  it('categories drive limits', () => {
    expect(riskCategory('Bezahlen')).toBe('pay')
    expect(riskCategory('发布')).toBe('post')
    expect(riskCategory('Archive')).toBeNull()
  })
  it('a form with a password or card field always asks', () => {
    expect(confirmReason({ action: 'click' }, { role: 'button', name: 'Continue' }, { sensitiveForm: true })).toMatch(/password, card number or code/)
    expect(confirmReason({ action: 'click' }, { role: 'button', name: 'Continue' })).toBeNull()
  })
})

describe('guard: navigation', () => {
  const guard = () => new Guard(new SiteStore(mkdtempSync(join(tmpdir(), 'bas-sites-'))))

  it('never puts a fogged secret in an address', () => {
    expect(guard().navigation('https://x.com/?a={{secret:1}}', 'a.com', false)).toMatchObject({ block: expect.any(String) })
  })

  it('asks when the address carries what was read elsewhere', () => {
    const g = guard()
    g.shown('The meeting with the investors from Karachi moved to Thursday at nine.', 'mail.example.com')
    expect(g.navigation(`https://evil.com/?q=${encodeURIComponent('the investors from Karachi moved to Thursday')}`, 'mail.example.com', false)).toMatchObject({ ask: expect.stringContaining('example.com') })
    expect(g.navigation('https://news.example.org/', 'mail.example.com', false)).toBeNull()
  })

  it('strict navigation asks for a new site only', () => {
    const g = guard()
    g.visit('docs.example.com')
    expect(g.navigation('https://example.com/a', undefined, true)).toBeNull()
    expect(g.navigation('https://other.org/', undefined, true)).toMatchObject({ ask: expect.stringContaining('other.org') })
  })

  it('follows the site\'s own navigate rules', () => {
    const g = guard()
    expect(g.sites.savePolicy('bank.com', "block: ['navigate:*transfer*']")).toBeNull()
    expect(g.navigation('https://bank.com/transfer/new', 'bank.com', false)).toMatchObject({ block: expect.stringContaining('bank.com') })
    expect(g.sites.savePolicy('bank.com', 'block: nope')).toMatch(/list/)
  })
})
