import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteRoutine, fillVars, loadRoutines, MAX_RECORDED, refind, routineVars, saveRoutine, stableAttrs, StepRecorder, type Routine } from './routines'
import type { PageItem } from './types'

const item = (ref: string, role: string, name: string, x = 0, y = 0): PageItem => ({ ref, role, name, states: [], inViewport: true, frameId: 'F', x, y, w: 50, h: 20 })

describe('refind', () => {
  const fp = (role: string, name: string, x?: number, y?: number) => ({ role, name, attrs: {}, x, y })

  it('prefers an exact role+name match', () => {
    const items = [item('e1', 'button', 'Search'), item('e2', 'link', 'Search')]
    expect(refind(items, fp('button', 'Search'))).toEqual({ item: items[0], level: 'role+name' })
  })

  it('matches a name whose counter changed', () => {
    const items = [item('e7', 'link', 'Messaging (3)')]
    expect(refind(items, fp('link', 'Messaging (12)'))?.level).toBe('role+similar-name')
  })

  it('falls back to the nearest element of the same role at the recorded spot', () => {
    const items = [item('e1', 'button', 'Post', 100, 400), item('e2', 'button', 'Share', 600, 400)]
    expect(refind(items, fp('button', 'Publish', 110, 390))).toEqual({ item: items[0], level: 'position' })
  })

  it('refuses to guess between two equal candidates', () => {
    const items = [item('e1', 'button', 'Like', 0, 100), item('e2', 'button', 'Like', 0, 900)]
    expect(refind(items, fp('button', 'Like'))).toBeNull()
  })

  it('misses when nothing fits', () => {
    expect(refind([item('e1', 'link', 'Home')], fp('button', 'Send', 500, 500))).toBeNull()
  })
})

describe('stableAttrs', () => {
  it('keeps meaningful attributes and drops generated ids and query strings', () => {
    expect(stableAttrs({ id: 'search-box', 'data-testid': 'nav-search', placeholder: 'Search', class: 'x y' })).toEqual({ id: 'search-box', 'data-testid': 'nav-search', placeholder: 'Search' })
    expect(stableAttrs({ id: 'ember1234', 'data-testid': 'a1b2c3d4e5f6' })).toEqual({})
    expect(stableAttrs({ id: ':r4:' })).toEqual({})
    expect(stableAttrs({ href: 'https://www.linkedin.com/jobs/?trk=abc' })).toEqual({ href: '/jobs/' })
  })
})

describe('fillVars', () => {
  it('fills placeholders and reports the first missing one', () => {
    expect(fillVars('jobs in {{ city }}', { city: 'Lahore' })).toBe('jobs in Lahore')
    expect(fillVars('{{a}} and {{b}}', { a: '1' })).toEqual({ missing: 'b' })
    expect(fillVars('plain', {})).toBe('plain')
  })

  it('lists the variables a routine needs', () => {
    const r: Routine = { name: 'r', host: 'h', created: '', steps: [{ action: 'type', text: '{{query}}' }, { action: 'type', text: '{{secret}} {{query}}' }, { action: 'click' }] }
    expect(routineVars(r)).toEqual(['query', 'secret'])
  })
})

describe('StepRecorder', () => {
  it('keeps steps per page and site, newest last, capped', () => {
    const rec = new StepRecorder()
    rec.add(1, 'a.com', { action: 'click' })
    rec.add(1, 'b.com', { action: 'scroll' })
    rec.add(2, 'a.com', { action: 'key', key: 'Escape' })
    expect(rec.recent(1, 'a.com')).toEqual([{ action: 'click' }])
    for (let i = 0; i < MAX_RECORDED + 5; i++) rec.add(3, 'c.com', { action: 'key', key: String(i % 10) })
    expect(rec.recent(3, 'c.com')).toHaveLength(MAX_RECORDED)
    expect(rec.recent(3, 'c.com', 2)).toHaveLength(2)
  })
})

describe('routine storage', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('saves, lists and deletes routines in one JSON file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'routines-'))
    const file = join(dir, 'perception', 'routines.json')
    expect(await loadRoutines(file)).toEqual({})
    const r: Routine = { name: 'li-search', host: 'www.linkedin.com', created: '2026-10-27T00:00:00.000Z', steps: [{ action: 'type', text: '{{query}}' }] }
    await saveRoutine(file, r)
    expect(await loadRoutines(file)).toEqual({ 'li-search': r })
    expect(await deleteRoutine(file, 'li-search')).toBe(true)
    expect(await deleteRoutine(file, 'li-search')).toBe(false)
  })
})
