import { afterEach, describe, expect, it, vi } from 'vitest'
import { askApproval, askUser, Connection, originAllowed, pendingApprovals, pendingQuestions } from './bridge'
import { ChromeTab, type TabInfo } from './chromeTab'

function fakeSocket() {
  const sent: Record<string, unknown>[] = []
  return { sent, ws: { send: (s: string) => { sent.push(JSON.parse(s)) }, close: () => {} } }
}

const tabInfo = (over: Partial<TabInfo> = {}): TabInfo => ({ id: 7, windowId: 1, url: 'https://example.com/', title: 'Example', status: 'complete', ...over })

afterEach(() => { vi.useRealTimers() })

describe('originAllowed', () => {
  it('accepts only the pinned extension id', () => {
    expect(originAllowed('chrome-extension://ihdiobmpbpecigcaoaijgnebdhkdfbne', '')).toBe(true)
    expect(originAllowed('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '')).toBe(false)
    expect(originAllowed('https://evil.example', '')).toBe(false)
    expect(originAllowed('http://localhost:3000', '')).toBe(false)
    expect(originAllowed(undefined, '')).toBe(false)
  })

  it('takes extra ids for development', () => {
    expect(originAllowed('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true)
  })
})

describe('approvals', () => {
  it('only the browser profile that was asked can answer', async () => {
    const mine = new Connection(fakeSocket().ws), other = new Connection(fakeSocket().ws)
    mine.label = 'me@example.com'
    other.label = 'someone-else'
    const asked = askApproval(mine, 7, 'click button "Send"', 'may send')
    const card = pendingApprovals().at(-1)!
    other.receive({ event: 'approval', approvalId: card.approvalId, allow: true })
    expect(pendingApprovals().some(a => a.approvalId === card.approvalId)).toBe(true)
    mine.receive({ event: 'approval', approvalId: card.approvalId, allow: false })
    await expect(asked).resolves.toMatchObject({ allow: false })
  })

  it('a question is answered only from its own profile', async () => {
    const mine = new Connection(fakeSocket().ws), other = new Connection(fakeSocket().ws)
    mine.label = 'me'
    other.label = 'them'
    const asked = askUser(mine, 'Code from SMS?', { secret: true })
    const card = pendingQuestions().at(-1)!
    other.receive({ event: 'answer', askId: card.askId, text: '000000' })
    mine.receive({ event: 'answer', askId: card.askId, text: '123456' })
    await expect(asked).resolves.toMatchObject({ text: '123456' })
  })
})

describe('Connection', () => {
  it('matches replies to requests by id', async () => {
    const { sent, ws } = fakeSocket()
    const c = new Connection(ws)
    const a = c.request('tabs.list')
    const b = c.request('cdp.send', { tabId: 1 })
    c.receive({ id: sent[1].id, ok: false, error: 'nope' })
    c.receive({ id: sent[0].id, ok: true, result: [1, 2] })
    await expect(a).resolves.toEqual([1, 2])
    await expect(b).rejects.toThrow('nope')
  })

  it('times out a request the browser never answers', async () => {
    vi.useFakeTimers()
    const c = new Connection(fakeSocket().ws)
    const p = c.request('tabs.list', {}, 1000)
    vi.advanceTimersByTime(1001)
    await expect(p).rejects.toThrow('did not answer tabs.list')
  })

  it('finds a tab by id or by part of its url, and refuses an ambiguous match', async () => {
    const { sent, ws } = fakeSocket()
    const c = new Connection(ws)
    const list = [tabInfo(), tabInfo({ id: 8, url: 'https://web.whatsapp.com/', title: 'WhatsApp' }), tabInfo({ id: 9, url: 'https://example.com/b', title: 'B' })]
    const reply = () => c.receive({ id: sent[sent.length - 1].id, ok: true, result: list })

    let p = c.tab('8'); reply()
    expect((await p as ChromeTab).tabId).toBe(8)
    p = c.tab('whatsapp'); reply()
    expect((await p as ChromeTab).getURL()).toBe('https://web.whatsapp.com/')
    p = c.tab('example.com'); reply()
    expect(await p).toMatch(/matches 2 tabs/)
    p = c.tab(99); reply()
    expect(await p).toMatch(/no tab "99"/)
  })

  it('routes CDP events and tab updates to the tab, and drops it when closed', async () => {
    const { sent, ws } = fakeSocket()
    const c = new Connection(ws)
    const p = c.tab(7)
    c.receive({ id: sent[0].id, ok: true, result: [tabInfo({ status: 'loading' })] })
    const t = await p as ChromeTab
    const seen: string[] = []
    t.debugger.on('message', (_e, method) => seen.push(method))
    const stopped = vi.fn()
    t.once('did-stop-loading', stopped)
    c.receive({ event: 'cdp', tabId: 7, method: 'Page.loadEventFired', params: {} })
    c.receive({ event: 'tab', tab: tabInfo({ status: 'complete', title: 'Done' }) })
    expect(seen).toEqual(['Page.loadEventFired'])
    expect(stopped).toHaveBeenCalledOnce()
    expect(t.getTitle()).toBe('Done')
    c.receive({ event: 'tabRemoved', tabId: 7 })
    expect(t.isDestroyed()).toBe(true)
    expect(c.tabs.has(7)).toBe(false)
  })

  it('fails pending requests when the browser disconnects', async () => {
    const c = new Connection(fakeSocket().ws)
    const p = c.request('tabs.list')
    c.closed()
    await expect(p).rejects.toThrow('disconnected')
  })
})

describe('ChromeTab debugger', () => {
  it('attaches once, sends after attach, and detaches only after a quiet spell', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const t = new ChromeTab(7, tabInfo(), async (m, p) => { calls.push(m === 'cdp.send' ? `send ${String(p.method)}` : m); return {} })
    t.debugger.attach()
    expect(t.debugger.isAttached()).toBe(true)
    await t.debugger.sendCommand('DOM.getDocument')
    t.debugger.detach()
    expect(t.debugger.isAttached()).toBe(false)
    // Attached again within the quiet spell: no second attach, no detach.
    t.debugger.attach()
    await t.debugger.sendCommand('Page.getFrameTree')
    t.debugger.detach()
    await vi.advanceTimersByTimeAsync(8001)
    expect(calls).toEqual(['cdp.attach', 'send DOM.getDocument', 'send Page.getFrameTree', 'cdp.detach'])
  })

  it('reports the attach error on the next command', async () => {
    const t = new ChromeTab(7, tabInfo(), async (m) => { if (m === 'cdp.attach') throw new Error('Another debugger is already attached'); return {} })
    t.debugger.attach()
    await expect(t.debugger.sendCommand('DOM.getDocument')).rejects.toThrow('Another debugger')
    expect(t.debugger.isAttached()).toBe(false)
  })
})
