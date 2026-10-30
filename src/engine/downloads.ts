import type { DownloadSession as Session } from './target'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/**
 * Files a workspace tab downloads: saved without a dialog into the workspace's
 * own folder, and remembered so the receipt of the action that started them can
 * name them. Only sessions handed to trackDownloads are touched — other
 * Tabgeist views keep their own download handling.
 */

export interface DownloadEntry { file: string; url: string; state: string; bytes: number; at: number }

const MAX_KEPT = 50
const tracked = new WeakMap<Session, DownloadEntry[]>()

/** A file name safe on Windows, never a path. */
export function safeFileName(name: string): string {
  const base = basename(name || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 150)
  return base || 'download'
}

/** `dir/name`, or `dir/name (2).ext` when that file already exists. */
export function uniquePath(dir: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let path = join(dir, name)
  for (let n = 2; exists(path); n++) path = join(dir, `${stem} (${n})${ext}`)
  return path
}

export function trackDownloads(ses: Session, dir: () => string): void {
  if (tracked.has(ses)) return
  const list: DownloadEntry[] = []
  tracked.set(ses, list)
  ses.on('will-download', (_e, item) => {
    const folder = dir()
    try { mkdirSync(folder, { recursive: true }) } catch { /* setSavePath reports it */ }
    const file = uniquePath(folder, safeFileName(item.getFilename()))
    item.setSavePath(file)
    const entry: DownloadEntry = { file, url: item.getURL(), state: 'progressing', bytes: 0, at: Date.now() }
    list.push(entry)
    if (list.length > MAX_KEPT) list.shift()
    item.on('updated', () => { entry.bytes = item.getReceivedBytes() })
    item.once('done', (_ev, state) => { entry.state = state; entry.bytes = item.getReceivedBytes() })
  })
}

export function downloadsSince(ses: Session, since: number): DownloadEntry[] {
  return (tracked.get(ses) ?? []).filter(d => d.at >= since)
}

export function recentDownloads(ses: Session): DownloadEntry[] {
  return [...(tracked.get(ses) ?? [])]
}
