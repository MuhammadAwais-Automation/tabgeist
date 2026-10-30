import { describe, expect, it } from 'vitest'

import { announcements, keyDef, MAX_STEPS, parseActRequest, parseActRequests, settle, targetMismatch } from './actions'
import type { PageMap } from './types'

describe('parseActRequest', () => {
  it('accepts a valid click and normalises the ref', () => {
    expect(parseActRequest({ action: 'click', ref: ' @e12 ' })).toEqual({ action: 'click', ref: 'e12', clear: false, confirm: false })
  })

  it('waits for text to go away, alone or with text to appear', () => {
    expect(parseActRequest({ action: 'wait', gone: ' Loading ' })).toMatchObject({ waitGone: 'Loading', ms: 10_000 })
    expect(parseActRequest({ action: 'wait', text: 'Done', gone: 'Loading', ms: 3000 })).toMatchObject({ waitText: 'Done', waitGone: 'Loading', ms: 3000 })
    expect(parseActRequest({ action: 'wait', gone: ' ' })).toMatch(/gone/)
  })

  it('drags between refs or between two points', () => {
    expect(parseActRequest({ action: 'drag', ref: 'e1', toRef: 'e2' })).toMatchObject({ ref: 'e1', toRef: 'e2' })
    expect(parseActRequest({ action: 'drag', x: 10, y: 20, toX: 300, toY: 40 })).toMatchObject({ at: { x: 10, y: 20 }, toAt: { x: 300, y: 40 } })
    expect(parseActRequest({ action: 'drag', ref: 'e1' })).toMatch(/toRef/)
    expect(parseActRequest({ action: 'drag', x: 10, y: 20, toRef: 'e2' })).toMatch(/toX/)
  })

  it('pastes text or files into a box', () => {
    expect(parseActRequest({ action: 'paste', ref: 'e3', text: 'hi' })).toMatchObject({ action: 'paste', ref: 'e3', text: 'hi' })
    expect(parseActRequest({ action: 'paste', ref: 'e3' })).toMatch(/text or files/)
    expect(parseActRequest({ action: 'paste', text: 'hi' })).toMatch(/ref/)
    expect(parseActRequest({ action: 'paste', ref: 'e3', files: ['C:/no/such/file.png'] })).toMatch(/not a local file/)
  })

  it('rejects unknown actions, bad refs and missing fields', () => {
    expect(parseActRequest({ action: 'pinch' })).toMatch(/action must be/)
    expect(parseActRequest({ action: 'click', ref: 'button' })).toMatch(/ref must look like/)
    expect(parseActRequest({ action: 'click' })).toMatch(/needs a ref/)
    expect(parseActRequest({ action: 'type', ref: 'e1' })).toMatch(/needs text/)
    expect(parseActRequest({ action: 'type', ref: 'e1', text: 'x'.repeat(10_001) })).toMatch(/longer/)
    expect(parseActRequest({ action: 'select', ref: 'e1' })).toMatch(/needs value/)
    expect(parseActRequest({ action: 'key', key: 'Hyper' })).toMatch(/key must be/)
  })

  it('needs no ref for scroll and key, and only takes confirm when it is exactly true', () => {
    expect(parseActRequest({ action: 'scroll', direction: 'up' })).toMatchObject({ direction: 'up' })
    expect(parseActRequest({ action: 'scroll' })).toMatchObject({ direction: 'down' })
    expect(parseActRequest({ action: 'key', key: 'Escape', confirm: 'yes' })).toMatchObject({ key: 'Escape', confirm: false })
  })
})

describe('keyDef', () => {
  it('maps named keys and single characters to CDP fields', () => {
    expect(keyDef('Enter')).toEqual({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' })
    expect(keyDef('Space')).toMatchObject({ key: ' ', vk: 32 })
    expect(keyDef('a')).toEqual({ key: 'a', code: 'KeyA', vk: 65, text: 'a' })
    expect(keyDef('7')).toMatchObject({ code: 'Digit7', vk: 55 })
    expect(keyDef('ab')).toBeNull()
  })
})

describe('targetMismatch', () => {
  const entry = { role: 'button', name: 'Send' }

  it('passes the same element, also when its name grew or comes from a shadow host', () => {
    expect(targetMismatch(entry, { role: 'button', name: 'Send' })).toBeNull()
    expect(targetMismatch(entry, { role: 'button', name: 'send message' })).toBeNull()
    expect(targetMismatch({ role: 'textbox', name: 'Search' }, { role: 'textbox', name: '' })).toBeNull()
    expect(targetMismatch({ role: 'link', name: 'A very long title cut…' }, { role: 'link', name: 'A very long title cut here' })).toBeNull()
  })

  it('passes a live label that shrank or gained a counter, while one name holds the other', () => {
    expect(targetMismatch({ role: 'button', name: 'Sara Khan click here for contact info' }, { role: 'button', name: 'Sara Khan' })).toBeNull()
    expect(targetMismatch({ role: 'row', name: 'Ali' }, { role: 'row', name: '3 unread messages Ali' })).toBeNull()
    expect(targetMismatch({ role: 'button', name: 'Sara Khan' }, { role: 'button', name: 'Send' })).toMatch(/changed/)
    expect(targetMismatch({ role: 'button', name: 'OK' }, { role: 'button', name: 'Not OK at all' })).toMatch(/changed/)
  })

  it('fails closed when the element is gone or is something else', () => {
    expect(targetMismatch(entry, null)).toMatch(/gone/)
    expect(targetMismatch(entry, { role: 'link', name: 'Send' })).toMatch(/changed/)
    expect(targetMismatch(entry, { role: 'button', name: 'Delete' })).toMatch(/changed/)
  })
})

describe('settle', () => {
  const fast = { firstMs: 1, quietMs: 1, capMs: 200 }

  it('returns once two reads agree', async () => {
    const reads = ['a', 'b', 'c', 'c', 'd']
    let i = 0
    expect(await settle(async () => reads[i++], (x, y) => x === y, fast)).toBe('c')
    expect(i).toBe(4)
  })

  it('gives up at the cap with the latest read', async () => {
    let i = 0
    const out = await settle(async () => i++, (x, y) => x === y, { firstMs: 1, quietMs: 5, capMs: 20 })
    expect(out).toBeGreaterThan(0)
  })
})

describe('parseActRequests', () => {
  it('wraps a single action in a list', () => {
    expect(parseActRequests({ action: 'scroll' })).toEqual([{ action: 'scroll', direction: 'down', clear: false, confirm: false }])
  })

  it('parses steps in order and applies a call-level confirm to every step', () => {
    const steps = parseActRequests({ confirm: true, steps: [{ action: 'type', ref: 'e3', text: 'hi' }, { action: 'click', ref: 'e4' }] })
    expect(steps).toEqual([
      { action: 'type', ref: 'e3', text: 'hi', clear: false, confirm: true },
      { action: 'click', ref: 'e4', clear: false, confirm: true },
    ])
  })

  it('names the bad step and caps the list', () => {
    expect(parseActRequests({ steps: [{ action: 'click', ref: 'e1' }, { action: 'click' }] })).toBe('step 2: click needs a ref (or x and y from chrome_screenshot)')
    expect(parseActRequests({ steps: [] })).toMatch(/non-empty/)
    expect(parseActRequests({ steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'scroll' })) })).toMatch(/at most/)
  })
})

describe('announcements', () => {
  const map = (items: { role: string; name: string }[]): PageMap => ({
    url: 'https://x.com/', title: 'x', scrollY: 0, viewportHeight: 800, pageHeight: 800, landmarks: [],
    items: items.map((i, n) => ({ ref: `e${n + 1}`, states: [], inViewport: true, frameId: 'F', ...i })),
  })

  it('reports only alerts, toasts and dialogs that are new', () => {
    const before = map([{ role: 'status', name: 'Saved' }, { role: 'button', name: 'Send' }])
    const after = map([{ role: 'status', name: 'Saved' }, { role: 'alert', name: 'Upload failed' }, { role: 'button', name: 'Retry' }])
    expect(announcements(before, after)).toEqual(['alert: Upload failed'])
  })
})

describe('new actions', () => {
  it('parses hover, wait and upload and refuses bad input', () => {
    expect(parseActRequest({ action: 'hover', ref: 'e3' })).toMatchObject({ action: 'hover', ref: 'e3' })
    expect(parseActRequest({ action: 'hover' })).toBe('hover needs a ref (or x and y from chrome_screenshot)')
    expect(parseActRequest({ action: 'wait', text: 'Saved' })).toMatchObject({ action: 'wait', waitText: 'Saved', ms: 10_000 })
    expect(parseActRequest({ action: 'wait', ms: 99_000 })).toMatchObject({ ms: 15_000 })
    expect(parseActRequest({ action: 'wait' })).toBe('wait needs text (to appear), gone (to disappear) or ms')
    expect(parseActRequest({ action: 'upload', ref: 'e1' })).toBe('upload needs files: absolute paths of local files')
    expect(parseActRequest({ action: 'upload', ref: 'e1', files: ['relative.png'] })).toBe('not a local file: relative.png')
    expect(parseActRequest({ action: 'upload', ref: 'e1', files: [__filename] })).toMatchObject({ action: 'upload', files: [__filename] })
  })
})

describe('dblclick, rightclick, drag and drop', () => {
  it('needs a ref, drag needs toRef, drop needs real files', () => {
    expect(parseActRequest({ action: 'dblclick', ref: 'e3' })).toMatchObject({ action: 'dblclick', ref: 'e3' })
    expect(parseActRequest({ action: 'rightclick' })).toMatch(/needs a ref/)
    expect(parseActRequest({ action: 'drag', ref: 'e3' })).toMatch(/toRef/)
    expect(parseActRequest({ action: 'drag', ref: 'e3', toRef: '@e9' })).toMatchObject({ action: 'drag', ref: 'e3', toRef: 'e9' })
    expect(parseActRequest({ action: 'drop', ref: 'e3' })).toMatch(/drop needs files/)
    expect(parseActRequest({ action: 'drop', ref: 'e3', files: ['C:/no/such/file.png'] })).toMatch(/not a local file/)
  })
})

describe('acting at a point', () => {
  it('takes x and y for click-like actions without a ref, never for typing', () => {
    expect(parseActRequest({ action: 'rightclick', x: 120, y: 80 })).toMatchObject({ action: 'rightclick', at: { x: 120, y: 80 } })
    expect(parseActRequest({ action: 'click', ref: 'e2', x: 1, y: 1 })).not.toHaveProperty('at')
    expect(parseActRequest({ action: 'type', text: 'hi', x: 5, y: 5 })).toMatch(/type needs a ref/)
  })
})
