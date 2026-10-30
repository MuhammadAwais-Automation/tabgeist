import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newer, newPack, PackStore, readPack } from './packs'
import { SiteStore } from './store'

function pack(dir: string, json: Record<string, unknown>, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(json))
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), text) }
  return dir
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tabgeist-packs-'))
  const builtIn = join(root, 'shipped')
  pack(join(builtIn, 'shop'), { name: 'shop', version: '1.0.0', site: 'shop.example.com', about: 'shop' }, {
    'adapter.js': '({ ops: {} })', 'notes.md': '- use the orders op', 'routines/orders.yaml': 'name: orders',
  })
  const packs = new PackStore(join(root, 'packs'), builtIn)
  return { root, packs, sites: new SiteStore(join(root, 'sites'), packs) }
}

describe('packs', () => {
  it('checks pack.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabgeist-packs-'))
    expect(readPack(root, 'installed')).toMatch(/no pack.json/)
    expect(readPack(pack(join(root, 'a'), { name: '../x', version: '1.0.0', site: 'a.com' }), 'installed')).toMatch(/name/)
    expect(readPack(pack(join(root, 'b'), { name: 'b', version: '1.0', site: 'b.com' }), 'installed')).toMatch(/version/)
    expect(readPack(pack(join(root, 'c'), { name: 'c', version: '1.0.0', site: '' }), 'installed')).toMatch(/site/)
    expect(newer('1.10.0', '1.9.3')).toBe(true)
    expect(newer('1.0.0', '1.0.0')).toBe(false)
  })

  it('a site gets its pack: adapter, notes, routines; subdomains count', () => {
    const { packs, sites } = setup()
    expect(packs.forSite('www.example.com')?.name).toBe('shop')
    expect(packs.adapter('example.com')?.source).toBe('({ ops: {} })')
    expect(packs.notes('example.com')).toMatch(/orders op/)
    expect(sites.sites()).toEqual(['example.com'])
    expect(sites.routineNames('example.com')).toEqual(['orders'])
    expect(sites.routineFrom('example.com', 'orders')).toBe('pack')
  })

  it('the user\'s own routine wins over the pack\'s', () => {
    const { sites } = setup()
    sites.saveRoutine('example.com', 'orders', 'name: mine', 1)
    expect(sites.routineText('example.com', 'orders')).toBe('name: mine')
    expect(sites.routineFrom('example.com', 'orders')).toBe('user')
    expect(sites.routineNames('example.com')).toEqual(['orders'])
  })

  it('install: newer only, the old version kept in .history, one pack per site', () => {
    const { root, packs } = setup()
    const v1 = pack(join(root, 'dl', 'v1'), { name: 'shop', version: '1.0.0', site: 'example.com' })
    expect(packs.install(v1)).toMatchObject({ ok: false, error: expect.stringMatching(/not newer/) })
    expect(packs.install(v1, true)).toMatchObject({ ok: true })
    expect(packs.forSite('example.com')).toMatchObject({ from: 'installed', version: '1.0.0' })
    const v2 = pack(join(root, 'dl', 'v2'), { name: 'shop', version: '1.1.0', site: 'example.com' })
    expect(packs.install(v2)).toMatchObject({ ok: true, replaced: '1.0.0' })
    expect(packs.forSite('example.com')?.version).toBe('1.1.0')
    expect(readdirSync(join(root, 'packs', '.history'))[0]).toMatch(/^shop\.v1\.0\.0\./)
    const rival = pack(join(root, 'dl', 'rival'), { name: 'rival', version: '9.0.0', site: 'example.com' })
    expect(packs.install(rival)).toMatchObject({ ok: false, error: expect.stringMatching(/one pack per site/) })
  })

  it('a pack cannot reach outside its folder: links are not installed and not followed', () => {
    const { root, packs } = setup()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.yaml'), 'name: secret')
    const src = pack(join(root, 'dl', 'linky'), { name: 'linky', version: '1.0.0', site: 'linky.com' }, { '.git/HEAD': 'x', 'notes.md': 'hi' })
    symlinkSync(outside, join(src, 'routines'), 'junction')
    expect(packs.install(src)).toMatchObject({ ok: true })
    const dest = join(root, 'packs', 'linky')
    expect([existsSync(join(dest, 'notes.md')), existsSync(join(dest, '.git')), existsSync(join(dest, 'routines'))]).toEqual([true, false, false])
    // A link put in by hand afterwards is still not followed.
    symlinkSync(outside, join(dest, 'routines'), 'junction')
    expect(packs.routineNames('linky.com')).toEqual([])
    expect(packs.routineText('linky.com', 'secret')).toBeNull()
  })

  it('ships Hacker News and YouTube; WhatsApp is experimental and must be added', () => {
    const packs = new PackStore(mkdtempSync(join(tmpdir(), 'tabgeist-packs-')))
    expect(packs.list().map(p => [p.name, p.from])).toEqual([['hackernews', 'built-in'], ['youtube', 'built-in']])
    expect(packs.forSite('news.ycombinator.com')?.name).toBe('hackernews')
    expect(packs.forSite('web.whatsapp.com')).toBeNull()
    expect(packs.install(join(packs.builtInDir, 'experimental', 'whatsapp'))).toMatchObject({ ok: true })
    expect(packs.adapter('web.whatsapp.com')?.source).toMatch(/WAWebCollections/)
  })
})

describe('starting a pack', () => {
  it('writes a valid pack with a working starter op and the user\'s routines for the site, not their notes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tabgeist-newpack-'))
    pack(join(root, 'sites'), {}, { 'linkedin.com/routines/reply.yaml': 'name: reply', 'linkedin.com/routines/.history/reply.v1.yaml': 'old', 'linkedin.com/notes.md': 'private' })
    const r = newPack('www.linkedin.com', join(root, 'out'), join(root, 'sites'))
    expect(r).toMatchObject({ ok: true, routines: ['reply'] })
    expect(readPack(join(root, 'out'), 'installed')).toMatchObject({ name: 'linkedin', version: '0.1.0', site: 'linkedin.com' })
    expect(readdirSync(join(root, 'out', 'routines'))).toEqual(['reply.yaml'])
    expect(readFileSync(join(root, 'out', 'notes.md'), 'utf8')).not.toMatch(/private/)
    // The starter adapter evaluates and its op answers on the site, and refuses elsewhere.
    const src = readFileSync(join(root, 'out', 'adapter.js'), 'utf8')
    const run = (hostname: string) => new Function('location', 'document', `return (${src})`)(
      { hostname, href: `https://${hostname}/feed` }, { title: 'Feed', querySelectorAll: () => [{ textContent: ' Home ' }] },
    ).ops.page.run()
    expect(await run('www.linkedin.com')).toEqual({ title: 'Feed', url: 'https://www.linkedin.com/feed', headings: ['Home'] })
    await expect(run('linkedinxcom.evil.com')).rejects.toThrow(/open linkedin.com first/)
    expect(newPack('linkedin.com', join(root, 'out'), join(root, 'sites'))).toMatchObject({ ok: false, error: expect.stringMatching(/not empty/) })
  })
})
