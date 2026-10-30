import { describe, expect, it } from 'vitest'
import { RefTable } from './refs'

describe('RefTable', () => {
  it('gives the same element the same ref and keeps its latest role and name', () => {
    const t = new RefTable()
    expect(t.refFor('F', 'L1', 7, 'button', 'Send')).toBe('e1')
    expect(t.refFor('F', 'L1', 8, 'link', 'Home')).toBe('e2')
    expect(t.refFor('F', 'L1', 7, 'button', 'Send now')).toBe('e1')
    expect(t.get('@e1')).toMatchObject({ backendNodeId: 7, name: 'Send now' })
    t.refFor('F', 'L1', 7, 'button', '')
    expect(t.get('e1')?.name).toBe('Send now')
  })

  it('stops resolving refs of a replaced document and never reuses their numbers', () => {
    const t = new RefTable()
    t.refFor('F', 'L1', 7, 'button', 'Send')
    t.forgetDocumentsExcept(new Set(['L2']))
    expect(t.get('e1')).toBeUndefined()
    // Same backend id in the new document is a different element.
    expect(t.refFor('F', 'L2', 7, 'button', 'Delete')).toBe('e2')
  })
})
