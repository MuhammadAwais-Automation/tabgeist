import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PairingStore, pairingCode, type PairingFile } from '../bridge/pairing'
import { bearerOk, cookieValue, hostOk, originOk, RoomAuth } from './auth'
import { Grants, kindOf } from './grants'
import { sha256 } from './home'
import { Leases } from './leases'
import { Timeline } from './timeline'

describe('pairing store', () => {
  const memory = () => {
    let saved: PairingFile = { browsers: {} }
    return { io: { load: () => structuredClone(saved), save: (f: PairingFile) => { saved = structuredClone(f) }, hash: sha256 }, get: () => saved }
  }

  it('trusts only the token it handed out, and keeps only its hash', () => {
    const m = memory()
    const s = new PairingStore(m.io)
    const { token, entry } = s.add('Work', 'Chrome')
    expect(s.check(token)?.label).toBe('Work')
    expect(s.check(token.replace(/.$/, c => (c === 'a' ? 'b' : 'a')))).toBeNull()
    expect(s.check('short')).toBeNull()
    expect(JSON.stringify(m.get())).not.toContain(token)
    expect(new PairingStore(m.io).check(token)?.id).toBe(entry.id)
  })

  it('forgets a removed browser', () => {
    const s = new PairingStore(memory().io)
    const { token, entry } = s.add('Home', 'Edge')
    expect(s.remove(entry.id)).toBe(true)
    expect(s.check(token)).toBeNull()
    expect(s.remove(entry.id)).toBe(false)
  })

  it('codes are six digits and never repeat one that waits', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = pairingCode(taken)
      expect(c).toMatch(/^\d{6}$/)
      expect(taken.has(c)).toBe(false)
      taken.add(c)
    }
  })
})

describe('auth', () => {
  it('accepts only loopback hosts on our port (DNS rebinding sends its own host)', () => {
    expect(hostOk('127.0.0.1:47900', 47900)).toBe(true)
    expect(hostOk('localhost:47900', 47900)).toBe(true)
    expect(hostOk('evil.com:47900', 47900)).toBe(false)
    expect(hostOk('127.0.0.1:1', 47900)).toBe(false)
    expect(hostOk(undefined, 47900)).toBe(false)
  })

  it('writes from the control room must come from its own origin', () => {
    expect(originOk('http://127.0.0.1:47900', 47900)).toBe(true)
    expect(originOk('https://evil.com', 47900)).toBe(false)
    expect(originOk(undefined, 47900)).toBe(false)
  })

  it('checks the bearer token', () => {
    const t = 'a'.repeat(64)
    expect(bearerOk(`Bearer ${t}`, t)).toBe(true)
    expect(bearerOk(`Bearer ${'b'.repeat(64)}`, t)).toBe(false)
    expect(bearerOk(undefined, t)).toBe(false)
  })

  it('a login link works once and expires', () => {
    let now = 1000
    const a = new RoomAuth(() => now)
    const once = a.link()
    const session = a.redeem(once)
    expect(session).toBeTruthy()
    expect(a.redeem(once)).toBeNull()
    expect(a.ok(`x=1; tabgeist_room=${session}`)).toBe(true)
    expect(a.ok('tabgeist_room=forged')).toBe(false)
    const late = a.link()
    now += 3 * 60_000
    expect(a.redeem(late)).toBeNull()
  })

  it('reads one cookie among many', () => {
    expect(cookieValue('a=1; tabgeist_room=xyz; b=2')).toBe('xyz')
    expect(cookieValue('a=1')).toBeNull()
  })
})

describe('grants', () => {
  const scope = { browser: 'Work', site: 'mail.example.com', kind: kindOf('click', 'button "Send"') }

  it('covers the same kind of step on the same site until it runs out', () => {
    const g = new Grants()
    expect(g.use(scope)).toBe(false)
    g.allow(scope, 60_000, 2)
    expect(g.use(scope)).toBe(true)
    expect(g.use({ ...scope, site: 'other.com' })).toBe(false)
    expect(g.use({ ...scope, kind: kindOf('click', 'button "Delete"') })).toBe(false)
    expect(g.use(scope)).toBe(true)
    expect(g.use(scope)).toBe(false)
  })

  it('expires and can be revoked', () => {
    let now = 0
    const g = new Grants(() => now)
    const e = g.allow(scope, 1000)
    now = 2000
    expect(g.use(scope)).toBe(false)
    const e2 = g.allow(scope)
    expect(g.list().map(x => x.id)).toEqual([e2.id])
    expect(g.revoke(e2.id)).toBe(true)
    expect(g.revoke(e.id)).toBe(false)
    expect(g.use(scope)).toBe(false)
  })

  it('kinds ignore digits and spacing', () => {
    expect(kindOf('click', 'button "Reply (3)"')).toBe(kindOf('click', 'button  "Reply (12)"'))
  })
})

describe('leases', () => {
  it('one agent per tab: the other waits, then gives up with the holder named', async () => {
    let now = 0
    const l = new Leases({ holdMs: 1000, waitMs: 300, pollMs: 10 }, () => now)
    expect(await l.acquire('t1', 'claude')).toBeNull()
    const waiting = l.acquire('t1', 'codex')
    now = 400
    expect(await waiting).toMatch(/in use by claude/)
    expect(await l.acquire('t1', 'claude')).toBeNull()
  })

  it('a released lease is held a while, then free for others', async () => {
    let now = 0
    const l = new Leases({ holdMs: 1000, waitMs: 0, pollMs: 10 }, () => now)
    await l.acquire('t1', 'claude')
    l.release('t1', 'claude')
    expect(await l.acquire('t1', 'codex')).toMatch(/claude/)
    now = 1500
    expect(await l.acquire('t1', 'codex')).toBeNull()
    expect(l.list()[0]).toMatchObject({ key: 't1', client: 'codex', busy: true })
    l.releaseAll('codex')
    expect(l.list()).toEqual([])
  })
})

describe('timeline', () => {
  it('appends, reads back newest first, groups sessions and redacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bas-tl-'))
    const t = new Timeline(dir, s => s.replace(/4111 1111 1111 1111/g, '{{secret:1}}'))
    const base = Date.UTC(2026, 9, 29, 10)
    t.add({ at: base, session: 's1', agent: 'claude', method: 'chrome.read', ok: true, ms: 10, summary: 'read 100 chars', site: 'a.com' })
    t.add({ at: base + 1000, session: 's1', agent: 'claude', method: 'chrome.act', ok: false, ms: 20, summary: 'typed 4111 1111 1111 1111', input: 'type 4111 1111 1111 1111', error: 'x', site: 'b.com' })
    t.add({ at: base + 2000, session: 's2', agent: 'codex', method: 'chrome.tabs', ok: true, ms: 5, summary: 'tabs' })
    const recent = t.recent()
    expect(recent.map(e => e.method)).toEqual(['chrome.tabs', 'chrome.act', 'chrome.read'])
    expect(recent[1].summary).toBe('typed {{secret:1}}')
    expect(recent[1].input).toBe('type {{secret:1}}')
    const s = t.sessions()
    expect(s.map(x => [x.session, x.steps, x.failed])).toEqual([['s2', 1, 0], ['s1', 2, 1]])
    expect(s[1].sites.sort()).toEqual(['a.com', 'b.com'])
    expect(t.session('s1').map(e => e.method)).toEqual(['chrome.read', 'chrome.act'])
    expect(t.recent({ site: 'a.com' })).toHaveLength(1)
  })
})
