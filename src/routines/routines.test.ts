import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dice, relocate, scoreItems } from '../engine/similar'
import type { PageItem } from '../engine/types'
import type { RoutineStep } from '../engine/routines'
import { SiteStore, siteName } from '../sites/store'
import { askNames, dumpRoutine, everyMs, fromRecorded, paramNames, parseRoutine, readOnly } from './format'
import { HealStore } from './heal'

const item = (ref: string, role: string, name: string, x = 0, y = 0): PageItem => ({ ref, role, name, states: [], inViewport: true, frameId: 'f', x, y })

describe('similarity relocation (no model)', () => {
  it('dice scores shared bigrams', () => {
    expect(dice('Send message', 'Send message')).toBe(1)
    expect(dice('Send message', 'Send a message')).toBeGreaterThan(0.8)
    expect(dice('Send', 'Delete')).toBeLessThan(0.2)
  })
  it('finds a renamed button near where it was', async () => {
    const items = [item('e1', 'button', 'Cancel', 100, 400), item('e2', 'button', 'Send invoice now', 300, 400), item('e3', 'link', 'Help', 900, 20)]
    expect((await relocate(items, { role: 'button', name: 'Send invoice', attrs: {}, x: 310, y: 395 }))?.item.ref).toBe('e2')
  })
  it('a link restyled as a button still matches, an unrelated page does not', async () => {
    expect((await relocate([item('e1', 'button', 'Export CSV', 50, 50), item('e2', 'button', 'Settings', 500, 50)], { role: 'link', name: 'Export CSV', attrs: {}, x: 60, y: 50 }))?.item.ref).toBe('e1')
    expect(await relocate([item('e1', 'heading', 'Welcome', 0, 0), item('e2', 'link', 'About us', 10, 10)], { role: 'button', name: 'Pay invoice', attrs: {} })).toBeNull()
  })
  it('refuses to guess between two equally close candidates', async () => {
    expect(await relocate([item('e1', 'button', 'Reply', 100, 100), item('e2', 'button', 'Reply', 100, 100)], { role: 'button', name: 'Reply', attrs: {} })).toBeNull()
  })
  it('stable attributes break ties', async () => {
    const items = [item('e1', 'button', 'Save', 100, 100), item('e2', 'button', 'Save', 120, 100)]
    const attrs: Record<string, Record<string, string>> = { e1: { 'data-testid': 'save-draft' }, e2: { 'data-testid': 'save-and-send' } }
    expect((await relocate(items, { role: 'button', name: 'Save', attrs: { 'data-testid': 'save-and-send' } }, async ref => attrs[ref]))?.item.ref).toBe('e2')
    expect(scoreItems(items, { role: 'button', name: 'Save', attrs: {} })).toHaveLength(2)
  })
})

describe('routine format', () => {
  const yaml = [
    'name: invoices.unpaid',
    'site: example.com',
    'start: https://example.com/invoices',
    'params: { min: { default: "500" } }',
    'api: [{ url: "https://example.com/api/invoices?min={{min}}", as: invoices }]',
    'steps:',
    '  - { act: click, target: { role: button, name: Unpaid } }',
    '  - { act: type, target: { role: textbox, name: Minimum }, text: "{{min}}" }',
    '  - { read: { region: main, as: table } }',
    'expect: [{ text: Total }]',
    'canary: { every: 6h }',
  ].join('\n')
  it('parses, dumps and parses back the same routine', () => {
    const r = parseRoutine(yaml)
    if (typeof r === 'string') throw new Error(r)
    expect(r.steps).toHaveLength(3)
    expect(paramNames(r)).toEqual(['min'])
    expect(readOnly(r)).toBe(true)
    expect(parseRoutine(dumpRoutine(r))).toEqual(r)
  })
  it('says what is wrong', () => {
    expect(parseRoutine('name: x')).toMatch(/site/)
    expect(parseRoutine('name: x\nsite: a.com\nsteps: [{ act: fly }]')).toMatch(/act must be one of/)
    expect(parseRoutine('name: x\nsite: a.com\nsteps: [{ act: click }]')).toMatch(/needs a target/)
    expect(parseRoutine('name: x\nsite: a.com\nsteps: [{ goto: /relative }]')).toMatch(/full http/)
    expect(parseRoutine('name: x\nsite: a.com\nsteps: [{ act: click, target: { role: button, name: Send } }]\ncanary: { every: 1h }')).toMatch(/read-only/)
    expect(parseRoutine('name: ../evil\nsite: a.com')).toMatch(/name/)
  })
  it('canary intervals are at least 5 minutes', () => {
    expect(everyMs('6h')).toBe(21_600_000)
    expect(everyMs('1m')).toBeNull()
    expect(everyMs('soon')).toBeNull()
  })
  it('builds from recorded steps: params, secrets asked, API-first only when read-only', () => {
    const recorded: RoutineStep[] = [
      { action: 'type' as const, target: { role: 'textbox', name: 'Search', attrs: { name: 'q' }, x: 10.4, y: 20.6 }, text: 'Ali Raza' },
      { action: 'click' as const, target: { role: 'button', name: 'Go', attrs: {} } },
    ]
    const r = fromRecorded({ name: 'find', site: 'example.com', recorded, params: { 'Ali Raza': 'name' }, api: [{ url: 'https://example.com/api/find?q=Ali', mime: 'application/json', status: 200 }, { url: 'https://example.com/api/x?token=…', mime: 'application/json' }] })
    expect(r.steps[0]).toMatchObject({ act: 'type', text: '{{name}}', target: { x: 10, y: 21 } })
    expect(r.params.name.default).toBe('Ali Raza')
    expect(r.api).toEqual([{ url: 'https://example.com/api/find?q=Ali', as: 'data1' }])
    const login = fromRecorded({ name: 'login', site: 'example.com', recorded: [{ action: 'type', target: { role: 'textbox', name: 'Password', attrs: {} }, text: '{{secret}}' }, { action: 'click', target: { role: 'button', name: 'Send', attrs: {} } }], api: [{ url: 'https://example.com/api/me', mime: 'application/json' }] })
    expect(askNames(login)).toEqual(['password'])
    expect(login.api).toEqual([])
    expect(readOnly(login)).toBe(false)
  })
})

describe('site store and heal tickets', () => {
  it('keeps routine versions, retires without deleting, records health', () => {
    const s = new SiteStore(mkdtempSync(join(tmpdir(), 'bas-sites-')))
    s.saveRoutine('www.example.com', 'r1', 'v1', 1)
    s.saveRoutine('example.com', 'r1', 'v2', 2)
    expect(s.routineText('example.com', 'r1')).toBe('v2')
    expect(s.history('example.com', 'r1')).toEqual([{ version: 1, text: 'v1' }])
    s.recordRun('example.com', 'r1', { at: 1, ok: false, ms: 5, by: 'claude' }, 'step 2 broke')
    expect(s.health('example.com').routines.r1.broken).toBe('step 2 broke')
    s.recordRun('example.com', 'r1', { at: 2, ok: true, ms: 5, by: 'claude' }, null)
    expect(s.health('example.com').routines.r1.broken).toBeUndefined()
    expect(s.retireRoutine('example.com', 'r1')).toBe(true)
    expect(s.routineNames('example.com')).toEqual([])
    expect(() => siteName('../../etc')).toThrow()
    expect(() => s.routineText('example.com', '../x')).toThrow()
    s.addNote('example.com', 'The export button lives under More', 'claude')
    expect(s.notes('example.com')).toContain('- The export button lives under More _(claude')
  })
  it('one open ticket per routine and kind; closing keeps it on disk', () => {
    const h = new HealStore(mkdtempSync(join(tmpdir(), 'bas-heal-')))
    const a = h.open({ site: 'a.com', routine: 'r', version: 1, kind: 'broken', error: 'x', evidence: { url: 'u', snapshot: '' } })
    const b = h.open({ site: 'a.com', routine: 'r', version: 1, kind: 'broken', error: 'y', evidence: { url: 'u', snapshot: '' } })
    expect(b.id).toBe(a.id)
    expect(h.get(a.id)?.error).toBe('y')
    h.open({ site: 'a.com', routine: 'r', version: 1, kind: 'drift', status: 'ready', error: 'z', evidence: { url: 'u', snapshot: '' } })
    expect(h.list({ open: true })).toHaveLength(2)
    h.close(a.id, 'dismissed')
    expect(h.list({ open: true })).toHaveLength(1)
    expect(h.list()).toHaveLength(2)
    expect(h.get('../../x')).toBeNull()
  })
})
