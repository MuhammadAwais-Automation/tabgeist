import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { adapterExpression } from '../engine/adapters'
import { adapterFor } from './adapters'
import { builtInPacksDir, PackStore } from './packs'
import { SiteStore } from './store'

const WHATSAPP = readFileSync(join(builtInPacksDir(), 'experimental', 'whatsapp', 'adapter.js'), 'utf8')

/** A Backbone-like collection, as WhatsApp's store uses. */
function coll<T extends { id: unknown }>(models: T[]) {
  return { getModelsArray: () => models, get: (id: string) => models.find(m => String(m.id) === id) }
}

/** WhatsApp's module registry with two chats; loadEarlierMsgs brings one older message once. */
function whatsapp() {
  const older = { id: { id: 'm0', fromMe: false }, t: 1_700_000_000, type: 'chat', body: 'first', from: 'ali@lid' }
  const aliMsgs = [
    { id: { id: 'm1', fromMe: false }, t: 1_700_000_100, type: 'chat', body: 'salam', from: 'ali@lid' },
    { id: { id: 'm2', fromMe: true }, t: 1_700_000_200, type: 'image', body: 'BASE64THUMB', caption: 'photo', from: 'me@lid' },
  ]
  const chats = [
    { id: 'ali@lid', t: 1_700_000_200, unreadCount: 2, msgs: coll(aliMsgs) },
    { id: 'team@g.us', t: 1_600_000_000, unreadCount: 0, name: 'Team Alpha', msgs: coll([{ id: { id: 'g1', fromMe: false }, t: 1_600_000_000, type: 'chat', body: 'hi all', from: 'team@g.us', author: 'sara@lid' }]) },
  ]
  const contacts = [{ id: 'ali@lid', name: 'Ali Khan' }, { id: 'sara@lid', pushname: 'Sara' }]
  let loaded = false
  const modules: Record<string, unknown> = {
    WAWebCollections: { Chat: coll(chats), Contact: coll(contacts) },
    WAWebChatLoadMessages: {
      loadRecentMsgs: async () => {},
      loadEarlierMsgs: async ({ chat }: { chat: { id: string } }) => { if (chat.id === 'ali@lid' && !loaded) { loaded = true; aliMsgs.unshift(older) } },
    },
  }
  return { require: (name: string) => modules[name] }
}

async function run(op: string | null, args: Record<string, unknown> = {}, window: unknown = whatsapp()) {
  return runInNewContext(adapterExpression(WHATSAPP, op, args), { window }) as Promise<{ error?: string; ops?: { name: string }[]; data?: any }>
}

describe('WhatsApp adapter', () => {
  it('lists its ops', async () => {
    expect((await run(null)).ops?.map(o => o.name)).toEqual(['chats', 'messages'])
  })

  it('chats: names from contacts, newest first, unread filter', async () => {
    const { data } = await run('chats')
    expect(data.map((c: any) => [c.name, c.group, c.unread])).toEqual([['Ali Khan', false, 2], ['Team Alpha', true, 0]])
    expect(data[0].last).toEqual({ from: 'You', type: 'image', text: 'photo', time: '2023-11-14T22:16:40.000Z' })
    expect((await run('chats', { unread: true })).data.map((c: any) => c.name)).toEqual(['Ali Khan'])
  })

  it('messages: by name, who sent what, media as type and caption, older history fetched to reach limit', async () => {
    const { data } = await run('messages', { chat: 'ali', limit: 3 })
    expect(data.chat).toEqual({ id: 'ali@lid', name: 'Ali Khan' })
    expect(data.messages.map((m: any) => [m.id, m.from, m.text, m.type, m.caption])).toEqual([
      ['m0', 'Ali Khan', 'first', 'chat', null],
      ['m1', 'Ali Khan', 'salam', 'chat', null],
      ['m2', 'You', null, 'image', 'photo'],
    ])
  })

  it('messages in a group name the person, not the group', async () => {
    const { data } = await run('messages', { chat: 'team@g.us', limit: 1 })
    expect(data.messages[0].from).toBe('Sara')
  })

  it('clear errors: unknown chat, unknown op, WhatsApp not loaded', async () => {
    expect((await run('messages', { chat: 'nobody' })).error).toMatch(/no chat named "nobody"/)
    expect((await run('send')).error).toMatch(/no op "send" — ops: chats, messages/)
    expect((await run('chats', {}, {})).error).toMatch(/still loading/)
  })
})

describe('adapterFor', () => {
  it('a user adapter in sites/<site>/adapter.js wins over the pack one; experimental packs need installing', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabgeist-adapters-'))
    const sites = new SiteStore(join(root, 'sites'), new PackStore(join(root, 'packs')))
    expect(adapterFor(sites, 'www.youtube.com')).toMatchObject({ from: 'pack', pack: expect.stringMatching(/^youtube \d/) })
    expect(adapterFor(sites, 'web.whatsapp.com')).toBeNull()
    expect(adapterFor(sites, 'example.com')).toBeNull()
    mkdirSync(sites.dir('example.com'), { recursive: true })
    writeFileSync(join(sites.dir('example.com'), 'adapter.js'), '({ ops: {} })')
    expect(adapterFor(sites, 'shop.example.com')).toEqual({ source: '({ ops: {} })', from: 'user' })
  })
})
