import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ActionKind, PageItem } from './types'

/**
 * Routines: a sequence of browser_act steps that worked once, saved so the
 * same task replays without a model deciding each click again (research:
 * Stagehand/Skyvern action caches — a cache hit costs no tokens).
 *
 * Steps keep a fingerprint of their element, never its ref: refs die with the
 * page. On replay the element is found again by `refind`, which only answers
 * when exactly one element matches — a routine stops rather than guess.
 */

export interface Fingerprint {
  role: string
  name: string
  /** Stable attributes only (see stableAttrs). */
  attrs: Record<string, string>
  x?: number
  y?: number
}

export interface RoutineStep {
  action: ActionKind
  target?: Fingerprint
  text?: string
  value?: string
  key?: string
  direction?: 'up' | 'down'
  clear?: boolean
}

export interface Routine {
  name: string
  /** Host the routine was recorded on; it only runs there. */
  host: string
  steps: RoutineStep[]
  created: string
}

const KEEP_ATTRS = ['id', 'data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder', 'type', 'href']
/** Generated ids (react-123, :r4:, long hex) change per load and would mislead the re-finder. */
const VOLATILE = /\d{3,}|[a-f0-9]{8,}|^:r|^ember|^react|^radix-|^headlessui-/i

/** Attributes worth matching on later; volatile ids and long values are dropped. */
export function stableAttrs(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of KEEP_ATTRS) {
    let v = raw[k]
    if (!v || v.length > 200) continue
    if ((k === 'id' || k.startsWith('data-')) && VOLATILE.test(v)) continue
    if (k === 'href') { try { v = new URL(v, 'https://x.invalid').pathname } catch { continue } }
    out[k] = v
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/\(\d+\)|\d+/g, '#').replace(/\s+/g, ' ').trim()

export type RefindLevel = 'role+name' | 'role+similar-name' | 'name' | 'position'

/**
 * Finds the element a fingerprint describes on a fresh page map, trying
 * stricter rules first. Each level must produce exactly one match; two
 * candidates are ambiguous and fall through, none at the end is a miss.
 * (The stable-attribute level runs against the live DOM in the engine.)
 */
export function refind(items: PageItem[], fp: Fingerprint): { item: PageItem; level: RefindLevel } | null {
  const one = (list: PageItem[]) => (list.length === 1 ? list[0] : null)
  const levels: [RefindLevel, (i: PageItem) => boolean][] = [
    ['role+name', i => i.role === fp.role && i.name === fp.name],
    ['role+similar-name', i => i.role === fp.role && !!fp.name && norm(i.name) === norm(fp.name)],
    ['name', i => !!fp.name && i.name === fp.name],
  ]
  for (const [level, test] of levels) {
    const hit = one(items.filter(test))
    if (hit) return { item: hit, level }
  }
  if (fp.x != null && fp.y != null) {
    const near = items.filter(i => i.role === fp.role && i.x != null && i.y != null && Math.abs(i.x - fp.x!) <= 40 && Math.abs(i.y - fp.y!) <= 40)
    const hit = one(near)
    if (hit) return { item: hit, level: 'position' }
  }
  return null
}

/** Fills {{name}} placeholders; an unfilled placeholder is an error, not an empty string. */
export function fillVars(text: string, vars: Record<string, string>): string | { missing: string } {
  let missing = ''
  const out = text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, k: string) => {
    if (vars[k] == null) { missing ||= k; return '' }
    return vars[k]
  })
  return missing ? { missing } : out
}

/** Placeholder names a routine expects, for routine lists. */
export function routineVars(r: Routine): string[] {
  const names = new Set<string>()
  for (const s of r.steps) for (const m of (s.text ?? '').matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) names.add(m[1])
  return [...names]
}

export const MAX_RECORDED = 50

/** Recent successful steps per page, newest last; routines are saved from here. */
export class StepRecorder {
  private byPage = new Map<number, { host: string; step: RoutineStep }[]>()

  add(pageId: number, host: string, step: RoutineStep): void {
    const list = this.byPage.get(pageId) ?? []
    list.push({ host, step })
    if (list.length > MAX_RECORDED) list.shift()
    this.byPage.set(pageId, list)
  }

  /** The last `count` steps (all when omitted) recorded on `host`. */
  recent(pageId: number, host: string, count?: number): RoutineStep[] {
    const list = (this.byPage.get(pageId) ?? []).filter(s => s.host === host).map(s => s.step)
    return count ? list.slice(-count) : list
  }

  forget(pageId: number): void {
    this.byPage.delete(pageId)
  }
}

// ── Storage: one JSON file, routines keyed by name ──────────────────────────

export async function loadRoutines(file: string): Promise<Record<string, Routine>> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, Routine> } catch { return {} }
}

export async function saveRoutine(file: string, routine: Routine): Promise<void> {
  const all = await loadRoutines(file)
  all[routine.name] = routine
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(all, null, 2), 'utf8')
}

export async function deleteRoutine(file: string, name: string): Promise<boolean> {
  const all = await loadRoutines(file)
  if (!all[name]) return false
  delete all[name]
  await writeFile(file, JSON.stringify(all, null, 2), 'utf8')
  return true
}
