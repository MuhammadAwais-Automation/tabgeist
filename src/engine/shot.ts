import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { homeDir } from '../brand'
import { join } from 'node:path'
import { stateFor, withDebugger } from './capture'
import type { PageTarget } from './target'

/**
 * A picture of the page itself (never the user's screen): the viewport, one
 * element by ref (a GIF in a picker, a chart), or the whole page. For what the
 * text map cannot say — images without labels, canvases, layout, colours.
 */

export interface ShotRequest { ref?: string; full?: boolean }
export interface Shot { file: string; mime: string; width: number; height: number; bytes: number }

const KEEP = 40
export const shotsDir = () => join(homeDir(), 'screenshots')

interface Metrics { cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number }; cssContentSize?: { width: number; height: number } }

/** Oldest pictures go once there are more than KEEP; they are only for a look now. */
async function prune(dir: string): Promise<void> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.jpg')).sort()
  await Promise.all(files.slice(0, Math.max(0, files.length - KEEP)).map(f => rm(join(dir, f), { force: true })))
}

export async function screenshot(t: PageTarget, req: ShotRequest): Promise<Shot | string> {
  const shot = await withDebugger(t, async send => {
    const m = await send('Page.getLayoutMetrics') as Metrics
    const vx = m.cssVisualViewport?.pageX ?? 0, vy = m.cssVisualViewport?.pageY ?? 0
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
    if (req.ref) {
      const entry = stateFor(t).refs.get(req.ref)
      if (!entry) return `unknown ref ${req.ref}; take a new snapshot`
      await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }).catch(() => {})
      const box = await send('DOM.getBoxModel', { backendNodeId: entry.backendNodeId }).catch(() => null) as { model: { border: number[] } } | null
      if (!box) return `ref ${req.ref} has no box (hidden or gone); take a new snapshot`
      const q = box.model.border
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
      const after = await send('Page.getLayoutMetrics') as Metrics
      const ox = after.cssVisualViewport?.pageX ?? vx, oy = after.cssVisualViewport?.pageY ?? vy
      clip = { x: Math.min(...xs) + ox, y: Math.min(...ys) + oy, width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)), scale: 1 }
    } else if (req.full) {
      clip = { x: 0, y: 0, width: m.cssContentSize?.width ?? 1280, height: Math.min(m.cssContentSize?.height ?? 800, 12_000), scale: 1 }
    }
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80, ...(clip ? { clip, captureBeyondViewport: !!req.full } : {}) }) as { data: string }
    const width = Math.round(clip?.width ?? m.cssVisualViewport?.clientWidth ?? 0)
    const height = Math.round(clip?.height ?? m.cssVisualViewport?.clientHeight ?? 0)
    return { data: r.data, width, height }
  })
  if (typeof shot === 'string') return shot
  const dir = shotsDir()
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`)
  const buf = Buffer.from(shot.data, 'base64')
  await writeFile(file, buf)
  void prune(dir)
  return { file, mime: 'image/jpeg', width: shot.width, height: shot.height, bytes: buf.length }
}
