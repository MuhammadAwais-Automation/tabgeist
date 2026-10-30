import { describe, expect, it } from 'vitest'
import { catchData, dataLog, jsonBody, packBlocks, slim } from './data'
import { parseReadRequest } from './read'
import type { CdpListener, PageTarget } from './target'

describe('jsonBody', () => {
  it('keeps JSON and drops the guards sites put in front of it', () => {
    expect(jsonBody('{"a":1}')).toBe('{"a":1}')
    expect(jsonBody(")]}'\n[1,2]")).toBe('[1,2]')
    expect(jsonBody('for (;;);{"x":true}')).toBe('{"x":true}')
    expect(jsonBody('{\n  "a": [1, 2]\n}')).toBe('{"a":[1,2]}')
  })

  it('turns newline-delimited JSON into one array', () => {
    expect(jsonBody('{"a":1}\n{"b":2}\n')).toBe('[{"a":1},{"b":2}]')
  })

  it('refuses HTML, scripts and broken JSON', () => {
    expect(jsonBody('<html></html>')).toBeNull()
    expect(jsonBody('window.x = 1')).toBeNull()
    expect(jsonBody('{"a":')).toBeNull()
  })
})

describe('slim', () => {
  it('drops tracking, layout and tokens, joins text pieces, keeps ids and values', () => {
    const token = 'CAESEgoGdGVzdC0xEgh0ZXN0LTEtMhoECAEQAQ' + 'x'.repeat(30)
    expect(slim({
      videoRenderer: {
        videoId: 'abc123',
        title: { runs: [{ text: 'CDP ' }, { text: 'basics' }] },
        viewCountText: { simpleText: '11K views' },
        trackingParams: token,
        navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/watch' } }, clickTrackingParams: 'x' },
        continuation: token,
        count: 0,
        live: false,
        thumbnails: [{ url: 'https://i.test/s.jpg', width: 120 }, { url: 'https://i.test/l.jpg', width: 720 }],
        playerParams: 'yg',
      },
    })).toEqual({ videoRenderer: { videoId: 'abc123', title: 'CDP basics', viewCountText: '11K views', count: 0, live: false, thumbnails: 'https://i.test/l.jpg' } })
  })
})

describe('packBlocks', () => {
  it('keeps the newest whole blocks within the limit', () => {
    expect(packBlocks(['aaaa', 'bbbb', 'cccc'], 10)).toEqual({ text: 'bbbb\n\ncccc', truncated: true })
    expect(packBlocks(['aa', 'bb'], 100)).toEqual({ text: 'aa\n\nbb', truncated: false })
  })

  it('cuts the newest block when it alone is too big', () => {
    expect(packBlocks(['x', 'abcdefghij'], 4)).toEqual({ text: 'abcd', truncated: true })
  })
})

describe('parseReadRequest with data', () => {
  it('takes data, reload and match', () => {
    expect(parseReadRequest({ data: true, reload: true, match: ' graphql ' })).toEqual({ data: true, load: undefined, pages: 5, maxChars: 20000, reload: true, match: 'graphql', raw: false, op: undefined, args: {} })
  })

  it('refuses data with a ref, and reload or match without data', () => {
    expect(parseReadRequest({ data: true, ref: 'e1' })).toMatch(/match/)
    expect(parseReadRequest({ reload: true })).toMatch(/data: true/)
    expect(parseReadRequest({ match: 'x' })).toMatch(/data: true/)
  })
})

/** A tab whose network is played from a script; bodies come from `bodies` by request id. */
function fakeTab(id: number, url: string, bodies: Record<string, { body: string; base64Encoded?: boolean }>) {
  const listeners = new Set<CdpListener>()
  const emit = (method: string, params: unknown) => { for (const l of listeners) l(null, method, params) }
  const wc = {
    id,
    getURL: () => url,
    debugger: {
      on: (_e: string, l: CdpListener) => listeners.add(l),
      removeListener: (_e: string, l: CdpListener) => listeners.delete(l),
    },
  } as unknown as PageTarget
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (method !== 'Network.getResponseBody') return {}
    const b = bodies[String(params?.requestId)]
    if (!b) throw new Error('No resource with given identifier found')
    return { body: b.body, base64Encoded: !!b.base64Encoded }
  }
  return { wc, send, emit }
}

function call(emit: (m: string, p: unknown) => void, requestId: string, url: string, type = 'Fetch', mimeType = 'application/json') {
  emit('Network.requestWillBeSent', { requestId, type, request: { method: 'GET', url } })
  emit('Network.responseReceived', { requestId, response: { status: 200, mimeType } })
  emit('Network.loadingFinished', { requestId, encodedDataLength: 100 })
}

describe('catchData', () => {
  it('keeps JSON answers of fetch/XHR calls and skips pages, pings and non-JSON', async () => {
    const { wc, send, emit } = fakeTab(901, 'https://shop.test/orders', {
      a: { body: '{"orders":[{"id":7}]}' },
      b: { body: Buffer.from('[{"sku":"x"}]').toString('base64'), base64Encoded: true },
      c: { body: '<html>' },
      d: { body: '{"event":"view"}' },
      e: { body: '{"doc":1}' },
      f: { body: '{}' },
    })
    const { out, caught } = await catchData(wc, send, async () => {
      call(emit, 'a', 'https://shop.test/api/orders')
      call(emit, 'b', 'https://shop.test/api/items', 'XHR')
      call(emit, 'c', 'https://shop.test/api/html')
      call(emit, 'd', 'https://shop.test/analytics/event')
      call(emit, 'e', 'https://shop.test/page', 'Document')
      call(emit, 'f', 'https://shop.test/api/empty')
      return 'done'
    })
    expect(out).toBe('done')
    expect(caught).toBe(2)
    expect(dataLog(901).map(r => [r.url, r.body, r.page])).toEqual([
      ['https://shop.test/api/orders', '{"orders":[{"id":7}]}', 'shop.test'],
      ['https://shop.test/api/items', '[{"sku":"x"}]', 'shop.test'],
    ])
  })

  it('a body Chrome already dropped is skipped, not an error', async () => {
    const { wc, send, emit } = fakeTab(902, 'https://a.test/', {})
    const { caught } = await catchData(wc, send, async () => { call(emit, 'gone', 'https://a.test/api/x') })
    expect(caught).toBe(0)
    expect(dataLog(902)).toEqual([])
  })
})

describe('forAgent', async () => {
  const { forAgent } = await import('./adapters')
  it('a list of flat records is a table; nested lists become named tables; other data stays JSON', () => {
    expect(forAgent([{ id: 1, title: 'a\tb', tags: ['x', 'y'] }, { id: 2, title: null, more: true }])).toBe('id\ttitle\ttags\tmore\n1\ta b\tx, y\t\n2\t\t\ttrue')
    expect(forAgent({ story: { id: 1 }, text: 'hi', comments: [{ by: 'a', text: 'yes' }] })).toBe('{"story":{"id":1},"text":"hi"}\n\ncomments:\nby\ttext\na\tyes')
    expect(forAgent({ a: 1 })).toBe('{"a":1}')
    expect(forAgent([])).toBe('[]')
  })
})
