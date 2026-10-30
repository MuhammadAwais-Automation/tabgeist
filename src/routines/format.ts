import { parse, stringify } from 'yaml'
import type { Fingerprint, RoutineStep } from '../engine/routines'
import { confirmReason } from '../engine/safety'
import type { ActionKind } from '../engine/types'

/**
 * A routine as the user sees it on disk (sites/<site>/routines/<name>.yaml):
 *
 *   name: invoices.unpaid
 *   site: example.com
 *   version: 3
 *   description: Unpaid invoices over a minimum
 *   start: https://example.com/invoices
 *   params:
 *     min: { default: "500" }
 *   api:                       # tried first; when every call answers, the UI steps are skipped
 *     - { url: "https://example.com/api/invoices?status=open", as: invoices }
 *   steps:                     # the UI way, step by step
 *     - { act: click, target: { role: button, name: Unpaid } }
 *     - { act: type, target: { role: textbox, name: Minimum }, text: "{{min}}" }
 *     - { read: { region: main, as: table } }
 *     - { wait: { text: Saved } }
 *     - { goto: https://example.com/done }
 *   expect:
 *     - { text: "Invoice sent" }
 *   canary: { every: 6h }      # read-only routines can be checked on a schedule
 *
 * {{name}} is a param; {{ask:password}} is asked from the user (hidden) at run time.
 */

export interface ActStep { act: ActionKind; target?: Fingerprint; text?: string; value?: string; key?: string; direction?: 'up' | 'down'; clear?: boolean; ms?: number }
export type Step =
  | ActStep
  | { goto: string }
  | { wait: { text?: string; gone?: string; ms?: number } }
  | { read: { region?: string; as: string; maxChars?: number } }

export interface ApiCall { url: string; as: string }
export interface Expect { text?: string; url?: string; gone?: string }

export interface Routine {
  name: string
  site: string
  version: number
  description?: string
  start?: string
  params: Record<string, { default?: string; description?: string }>
  api: ApiCall[]
  steps: Step[]
  expect: Expect[]
  canary?: { every: string }
  created: string
  updated: string
}

const ACTIONS: ActionKind[] = ['click', 'dblclick', 'rightclick', 'drag', 'drop', 'type', 'paste', 'select', 'scroll', 'key', 'hover', 'upload', 'wait']
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

export function everyMs(every: string): number | null {
  const m = /^\s*(\d+)\s*([mhd])\s*$/.exec(every)
  if (!m) return null
  const ms = Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[m[2]]
  return ms >= 5 * 60_000 ? ms : null
}

function fingerprint(v: unknown, at: string): Fingerprint | string {
  if (!isObj(v)) return `${at}: target must be a mapping with role and name`
  if (typeof v.role !== 'string' || !v.role) return `${at}: target.role is required`
  const attrs: Record<string, string> = {}
  if (v.attrs != null) {
    if (!isObj(v.attrs)) return `${at}: target.attrs must be a mapping`
    for (const [k, x] of Object.entries(v.attrs)) if (typeof x === 'string') attrs[k] = x
  }
  return { role: v.role, name: typeof v.name === 'string' ? v.name : '', attrs, ...(typeof v.x === 'number' ? { x: v.x } : {}), ...(typeof v.y === 'number' ? { y: v.y } : {}) }
}

function step(v: unknown, i: number): Step | string {
  const at = `step ${i + 1}`
  if (!isObj(v)) return `${at} must be a mapping`
  if (typeof v.goto === 'string') return /^https?:\/\//.test(v.goto) ? { goto: v.goto } : `${at}: goto needs a full http(s) address`
  if (isObj(v.wait)) {
    const w = v.wait
    if (!str(w.text) && !str(w.gone) && typeof w.ms !== 'number') return `${at}: wait needs text, gone or ms`
    return { wait: { ...(str(w.text) ? { text: w.text as string } : {}), ...(str(w.gone) ? { gone: w.gone as string } : {}), ...(typeof w.ms === 'number' ? { ms: Math.min(w.ms, 15_000) } : {}) } }
  }
  if (isObj(v.read)) {
    const r = v.read
    if (!str(r.as)) return `${at}: read needs as (the name its text is returned under)`
    return { read: { as: r.as as string, ...(str(r.region) ? { region: r.region as string } : {}), ...(typeof r.maxChars === 'number' ? { maxChars: r.maxChars } : {}) } }
  }
  if (typeof v.act === 'string') {
    if (!ACTIONS.includes(v.act as ActionKind)) return `${at}: act must be one of ${ACTIONS.join(', ')}`
    const s: ActStep = { act: v.act as ActionKind }
    if (v.target != null) { const fp = fingerprint(v.target, at); if (typeof fp === 'string') return fp; s.target = fp }
    for (const k of ['text', 'value', 'key'] as const) if (typeof v[k] === 'string') s[k] = v[k] as string
    if (v.direction === 'up' || v.direction === 'down') s.direction = v.direction
    if (v.clear === true) s.clear = true
    if (typeof v.ms === 'number') s.ms = v.ms
    const needsTarget = !['scroll', 'key', 'wait'].includes(s.act)
    if (needsTarget && !s.target) return `${at}: ${s.act} needs a target`
    if (s.act === 'type' && s.text == null) return `${at}: type needs text`
    return s
  }
  return `${at}: each step is one of act, goto, wait, read`
}

/** Reads a routine from YAML; returns what is wrong when it does not hold together. */
export function parseRoutine(text: string): Routine | string {
  let raw: unknown
  try { raw = parse(text) } catch (e) { return `not valid YAML: ${e instanceof Error ? e.message : String(e)}` }
  if (!isObj(raw)) return 'a routine is a mapping (name, site, steps, …)'
  if (typeof raw.name !== 'string' || !/^[\w.-]{1,60}$/.test(raw.name) || raw.name.startsWith('.')) return 'name: letters, digits, dot, dash, underscore (max 60)'
  if (typeof raw.site !== 'string' || !raw.site) return 'site is required (example.com)'
  const steps: Step[] = []
  if (raw.steps != null && !Array.isArray(raw.steps)) return 'steps must be a list'
  for (const [i, s] of ((raw.steps as unknown[]) ?? []).entries()) {
    const out = step(s, i)
    if (typeof out === 'string') return out
    steps.push(out)
  }
  const api: ApiCall[] = []
  if (raw.api != null) {
    if (!Array.isArray(raw.api)) return 'api must be a list of { url, as }'
    for (const [i, a] of (raw.api as unknown[]).entries()) {
      if (!isObj(a) || typeof a.url !== 'string' || !/^https?:\/\//.test(a.url) || typeof a.as !== 'string') return `api ${i + 1}: needs url (http or https) and as`
      api.push({ url: a.url, as: a.as })
    }
  }
  if (!steps.length && !api.length) return 'a routine needs steps (or api calls)'
  const expect: Expect[] = []
  if (raw.expect != null) {
    if (!Array.isArray(raw.expect)) return 'expect must be a list of { text | url | gone }'
    for (const [i, e] of (raw.expect as unknown[]).entries()) {
      if (!isObj(e) || !(str(e.text) || str(e.url) || str(e.gone))) return `expect ${i + 1}: give text, url or gone`
      expect.push({ ...(str(e.text) ? { text: e.text as string } : {}), ...(str(e.url) ? { url: e.url as string } : {}), ...(str(e.gone) ? { gone: e.gone as string } : {}) })
    }
  }
  const params: Routine['params'] = {}
  if (raw.params != null) {
    if (!isObj(raw.params)) return 'params must be a mapping of name: { default, description }'
    for (const [k, v] of Object.entries(raw.params)) {
      if (!/^[\w-]+$/.test(k)) return `param ${k}: letters, digits, dash, underscore`
      params[k] = isObj(v) ? { ...(v.default != null ? { default: String(v.default) } : {}), ...(str(v.description) ? { description: v.description as string } : {}) } : { default: v == null ? undefined : String(v) }
    }
  }
  let canary: Routine['canary']
  if (raw.canary != null) {
    if (!isObj(raw.canary) || typeof raw.canary.every !== 'string' || !everyMs(raw.canary.every)) return 'canary: { every: 6h } (at least 5m; m, h or d)'
    if (!readOnly({ steps } as Routine)) return 'only read-only routines (no typing that submits, no risky clicks) can be canaries'
    canary = { every: raw.canary.every }
  }
  const now = new Date().toISOString()
  return {
    name: raw.name,
    site: raw.site,
    version: typeof raw.version === 'number' && raw.version >= 1 ? Math.floor(raw.version) : 1,
    ...(str(raw.description) ? { description: raw.description as string } : {}),
    ...(typeof raw.start === 'string' && /^https?:\/\//.test(raw.start) ? { start: raw.start } : {}),
    params, api, steps, expect,
    ...(canary ? { canary } : {}),
    created: str(raw.created) ?? now,
    updated: str(raw.updated) ?? now,
  }
}

export function dumpRoutine(r: Routine): string {
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)))
  return stringify(clean({
    name: r.name, site: r.site, version: r.version, description: r.description, start: r.start,
    params: r.params, api: r.api, steps: r.steps, expect: r.expect, canary: r.canary,
    created: r.created, updated: r.updated,
  }), { lineWidth: 0 })
}

/** Params a routine uses: declared ones and every {{name}} in its steps and api urls. */
export function paramNames(r: Pick<Routine, 'steps' | 'api' | 'params'>): string[] {
  const names = new Set(Object.keys(r.params))
  const scan = (s?: string) => { for (const m of (s ?? '').matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) names.add(m[1]) }
  for (const s of r.steps) if ('act' in s) scan(s.text); else if ('goto' in s) scan(s.goto)
  for (const a of r.api) scan(a.url)
  return [...names]
}

/** Values the user is asked for at run time ({{ask:password}}). */
export function askNames(r: Pick<Routine, 'steps'>): string[] {
  const names = new Set<string>()
  for (const s of r.steps) if ('act' in s) for (const m of (s.text ?? '').matchAll(/\{\{\s*ask:([\w -]+)\s*\}\}/g)) names.add(m[1].trim())
  return [...names]
}

/** No step that sends, pays, deletes or submits text: safe to run unattended and API-first. */
export function readOnly(r: Pick<Routine, 'steps'>): boolean {
  return r.steps.every(s => {
    if (!('act' in s)) return true
    if (['upload', 'drop', 'paste', 'drag'].includes(s.act)) return false
    if (s.act === 'key' && s.key === 'Enter') return false
    if (s.act === 'type' && /[\r\n]/.test(s.text ?? '')) return false
    return !confirmReason({ action: s.act, key: s.key, text: s.text }, s.target)
  })
}

/**
 * Builds a routine from what the agent just did: recorded steps (their
 * elements as fingerprints), literal text turned into params, secrets turned
 * into questions for the user, and the site's own data calls as API-first steps.
 */
export function fromRecorded(o: {
  name: string
  site: string
  start?: string
  description?: string
  recorded: RoutineStep[]
  params?: Record<string, string>
  expect?: Expect[]
  /** Same-site GET data calls seen while recording (redacted urls are skipped). */
  api?: { url: string; mime?: string; status?: number }[]
  /** Text that must not be stored: fogged secrets the agent typed. */
  secret?: (text: string) => boolean
}): Routine {
  const declared: Routine['params'] = {}
  const steps: Step[] = o.recorded.map(r => {
    const s: ActStep = { act: r.action }
    if (r.target) s.target = { role: r.target.role, name: r.target.name, attrs: r.target.attrs, ...(r.target.x != null ? { x: Math.round(r.target.x) } : {}), ...(r.target.y != null ? { y: Math.round(r.target.y) } : {}) }
    if (r.value) s.value = r.value
    if (r.key) s.key = r.key
    if (r.direction) s.direction = r.direction
    // A routine types a fresh value each run, never after what the field already holds.
    if (r.clear || r.action === 'type') s.clear = true
    if (r.text != null) {
      let t = r.text
      if (t === '{{secret}}' || o.secret?.(t)) t = `{{ask:${(r.target?.name || 'secret').toLowerCase().replace(/[^\w -]/g, '').trim().slice(0, 30) || 'secret'}}}`
      for (const [literal, param] of Object.entries(o.params ?? {})) {
        if (!literal || !t.includes(literal)) continue
        t = t.split(literal).join(`{{${param}}}`)
        declared[param] = { default: literal }
      }
      s.text = t
    }
    return s
  })
  const now = new Date().toISOString()
  const draft: Routine = { name: o.name, site: o.site, version: 1, ...(o.description ? { description: o.description } : {}), ...(o.start ? { start: o.start } : {}), params: declared, api: [], steps, expect: o.expect ?? [], created: now, updated: now }
  if (readOnly(draft)) {
    const seen = new Set<string>()
    for (const a of o.api ?? []) {
      if (!/^https?:\/\//.test(a.url) || a.url.includes('…') || (a.status != null && a.status !== 200) || (a.mime && !/json/i.test(a.mime)) || seen.has(a.url)) continue
      seen.add(a.url)
      draft.api.push({ url: a.url, as: `data${draft.api.length + 1}` })
      if (draft.api.length >= 3) break
    }
  }
  return draft
}
