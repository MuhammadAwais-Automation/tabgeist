import type { RefEntry } from './types'

/**
 * Hands out short refs (`e1`, `e2`, …) for page elements, one table per page.
 *
 * A ref is bound to the exact element in the exact document that produced it
 * (frame + loaderId + backendNodeId). The same element keeps its ref across
 * snapshots, and a number is never handed out twice: after a navigation the
 * old refs stop resolving instead of silently pointing at whatever now sits in
 * that place — a wrong click is worse than an error.
 */
export class RefTable {
  private next = 1
  private byKey = new Map<string, string>()
  private byRef = new Map<string, RefEntry>()

  private static key(frameId: string, loaderId: string, backendNodeId: number): string {
    return `${frameId}|${loaderId}|${backendNodeId}`
  }

  /** The element's ref, creating one the first time it is seen. */
  refFor(frameId: string, loaderId: string, backendNodeId: number, role: string, name: string): string {
    const key = RefTable.key(frameId, loaderId, backendNodeId)
    const known = this.byKey.get(key)
    if (known) {
      const entry = this.byRef.get(known)!
      entry.role = role
      // An input loses its placeholder name once it holds text; keep the name the agent knows.
      if (name) entry.name = name
      return known
    }
    const ref = `e${this.next++}`
    this.byKey.set(key, ref)
    this.byRef.set(ref, { ref, frameId, loaderId, backendNodeId, role, name })
    return ref
  }

  get(ref: string): RefEntry | undefined {
    return this.byRef.get(ref.trim().replace(/^@/, ''))
  }

  /** Drops entries of documents that are gone; their numbers stay retired. */
  forgetDocumentsExcept(liveLoaderIds: Set<string>): void {
    for (const [ref, entry] of this.byRef) {
      if (liveLoaderIds.has(entry.loaderId)) continue
      this.byRef.delete(ref)
      this.byKey.delete(RefTable.key(entry.frameId, entry.loaderId, entry.backendNodeId))
    }
  }
}
