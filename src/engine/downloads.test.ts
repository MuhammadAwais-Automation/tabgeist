import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { safeFileName, uniquePath } from './downloads'

describe('download names', () => {
  it('keeps only a safe file name', () => {
    expect(safeFileName('..\..\evil:name?.pdf')).toBe('evil_name_.pdf')
    expect(safeFileName('')).toBe('download')
  })

  it('numbers a name that is taken', () => {
    const taken = new Set([join('D', 'a.pdf'), join('D', 'a (2).pdf')])
    expect(uniquePath('D', 'a.pdf', p => taken.has(p))).toBe(join('D', 'a (3).pdf'))
    expect(uniquePath('D', 'b.pdf', () => false)).toBe(join('D', 'b.pdf'))
  })
})
