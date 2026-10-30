import { askUser, busy, pickBrowser, type Connection } from '../bridge/bridge'
import type { ChromeTab, TabInfo } from '../bridge/chromeTab'
import { actOnPage, attrsForRef, locate, parseActRequest, type ActRequest } from '../engine/actions'
import { snapshotPage, withDebugger } from '../engine/capture'
import { parseReadRequest, readPage } from '../engine/read'
import { FETCH_IN_PAGE } from '../engine/routes'
import type { Fingerprint } from '../engine/routines'
import { formatSummary } from '../engine/serialize'
import { dice, relocate } from '../engine/similar'
import { hostLabel } from '../engine/url'
import { approve, isRoom, navigationOk, ROOM_ONLY, stepShot, type CallCtx } from '../daemon/browser'
import { siteKey } from '../safety/fog'
import { withNetGate } from '../safety/netgate'
import { askNames, dumpRoutine, paramNames, readOnly, type Expect, type Routine, type Step } from './format'
import type { HealStore, HealTicket } from './heal'

/**
 * Runs a routine in the user's browser: API-first when it has data calls and
 * changes nothing, else step by step on the page. Each element is found again
 * exactly (stable attribute, role and name), then by similarity; a step that
 * cannot be found opens a heal ticket. Risky steps still ask the user. In
 * shadow mode nothing is sent: writes are blocked and the first risky step ends
 * the run with a report of what would have happened.
 */

export interface RunOptions { tab?: unknown; browser?: unknown; vars?: Record<string, string>; shadow?: boolean; by: string; tickets?: boolean; closeAfter?: boolean }

export interface StepReport { step: number; kind: string; ok: boolean; found?: string; score?: number; note?: string; ms: number }

export interface RunResult {
  ok: boolean
  routine: string
  site: string
  version: number
  via: 'api' | 'ui'
  tab?: number
  steps: StepReport[]
  data: Record<string, unknown>
  expect: (Expect & { ok: boolean })[]
  shadow?: { wouldSend: { method: string; url: string }[]; stoppedAt?: string }
  healed: { step: number; from: string; to: string; score: number }[]
  heal?: string
  error?: string
  ms: number
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, k: string) => vars[k] ?? m).replace(/\{\{\s*ask:([\w -]+)\s*\}\}/g, (m, k: string) => vars[`ask:${k.trim()}`] ?? m)
const label = (fp?: Fingerprint) => (fp ? `${fp.role} "${fp.name}"` : 'the page')
const sameSite = (a: string, b: string) => !!a && !!b && siteKey(a) === siteKey(b)

/** Checks the routine's expectations on the page, waiting up to 5 s for text to appear. */
async function checkExpect(t: ChromeTab, list: Expect[]): Promise<(Expect & { ok: boolean })[]> {
  if (!list.length) return []
  const body = async () => withDebugger(t, async send => {
    const r = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }).catch(() => null) as { result?: { value?: string } } | null
    return r?.result?.value ?? ''
  })
  const judge = (text: string) => list.map(e => ({ ...e, ok: (!e.text || text.includes(e.text)) && (!e.gone || !text.includes(e.gone)) && (!e.url || t.getURL().includes(e.url)) }))
  let out = judge(await body())
  for (let i = 0; i < 20 && out.some(e => !e.ok); i++) {
    await new Promise(r => setTimeout(r, 250))
    out = judge(await body())
  }
  return out
}

async function fetchInPage(t: ChromeTab, url: string): Promise<{ status: number; mime: string; body: string }> {
  return withDebugger(t, async send => {
    const r = await send('Runtime.evaluate', { expression: `(${FETCH_IN_PAGE})(${JSON.stringify(url)}, 400000)`, awaitPromise: true, returnByValue: true }) as { result?: { value?: { status: number; mime: string; body: string } } }
    if (!r.result?.value) throw new Error('the page could not fetch it')
    return r.result.value
  })
}

export async function runRoutine(ctx: CallCtx, r: Routine, o: RunOptions, heal: HealStore | null): Promise<RunResult> {
  const started = Date.now()
  const res: RunResult = { ok: false, routine: r.name, site: r.site, version: r.version, via: 'ui', steps: [], data: {}, expect: [], healed: [], ms: 0 }
  const fail = (error: string) => { res.error = error; res.ms = Date.now() - started; return res }
  ctx.meta.routine = `${r.site}/${r.name}`

  const c = pickBrowser(o.browser)
  if (typeof c === 'string') return fail(c)

  // Params: given, else the default; {{ask:x}} is asked from the user (not in a dry run).
  const vars: Record<string, string> = {}
  for (const k of paramNames(r)) {
    const v = o.vars?.[k] ?? r.params[k]?.default
    if (v == null) return fail(`${r.name} needs ${k} (vars: { "${k}": "…" })`)
    vars[k] = v
  }
  if (!o.shadow) {
    for (const k of askNames(r)) {
      const a = await askUser(c, `${r.name} on ${r.site} needs your ${k}`, { secret: true })
      if (a.skipped || a.text == null) return fail(`the user did not give ${k}`)
      vars[`ask:${k}`] = a.text
    }
  }

  // The tab: the one given, or a new agent tab at the routine's start.
  let t: ChromeTab
  let opened = false
  if (o.tab != null) {
    const got = await c.tab(o.tab)
    if (typeof got === 'string') return fail(got)
    t = got
  } else {
    const url = r.start ?? `https://${r.site}/`
    const refused = await navigationOk(ctx, c, -1, url)
    if (refused) return fail(refused)
    const info = await c.request('tabs.open', { url }) as TabInfo
    const got = await c.tab(info.id)
    if (typeof got === 'string') return fail(got)
    t = got
    opened = true
  }
  res.tab = t.tabId
  if (isRoom(t.getURL(), ctx.d.port)) return fail(ROOM_ONLY)
  const key = `${c.label}#${t.tabId}`
  const busyErr = await ctx.d.leases.acquire(key, ctx.agent)
  if (busyErr) return fail(busyErr)
  ctx.meta.browser = c.label
  ctx.meta.tab = t.tabId

  try {
    await busy(c, t.tabId, () => runOn(ctx, c, t, r, o, vars, res, heal))
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e)
  } finally {
    ctx.d.leases.release(key, ctx.agent)
  }
  ctx.meta.site = hostLabel(t.getURL())
  if (ctx.d.settings.shots) ctx.meta.shot = await stepShot(t)
  if (opened && o.closeAfter) await c.request('tabs.close', { tabId: t.tabId }).catch(() => {})
  res.ok = !res.error && res.expect.every(e => e.ok)
  if (!res.error && !res.ok) res.error = `expectations did not hold: ${res.expect.filter(e => !e.ok).map(e => e.text ?? e.url ?? `gone ${e.gone}`).join('; ')}`
  res.ms = Date.now() - started
  const broken = res.ok ? null : res.heal ? res.error : undefined
  ctx.d.sites.recordRun(r.site, r.name, { at: Date.now(), ok: res.ok, ms: res.ms, by: o.by, ...(o.shadow ? { shadow: true } : {}), ...(res.healed.length ? { healed: res.healed.length } : {}), ...(res.error ? { error: res.error.slice(0, 200) } : {}) }, broken)
  return res
}

async function runOn(ctx: CallCtx, c: Connection, t: ChromeTab, r: Routine, o: RunOptions, vars: Record<string, string>, res: RunResult, heal: HealStore | null): Promise<void> {
  const site = () => hostLabel(t.getURL())
  const go = async (url: string): Promise<string | null> => {
    const refused = await navigationOk(ctx, c, t.tabId, url, site())
    if (refused) return refused
    t.update(await c.request('tabs.navigate', { tabId: t.tabId, url }) as TabInfo)
    return null
  }
  if (r.start && !sameSite(site(), r.site)) {
    const err = await go(r.start)
    if (err) { res.error = err; return }
  }

  // API first: a read-only routine whose data calls all answer needs no clicks at all.
  if (r.api.length && readOnly(r)) {
    const data: Record<string, unknown> = {}
    let why = ''
    for (const a of r.api) {
      const url = fill(a.url, vars)
      let u: URL
      try { u = new URL(url) } catch { why = `${url} is not an address`; break }
      if (!sameSite(u.host, site()) || u.protocol !== new URL(t.getURL()).protocol) { why = `${u.host} is not the page's own site`; break }
      const t0 = Date.now()
      try {
        const got = await fetchInPage(t, url)
        if (got.status !== 200) { why = `${a.as} answered ${got.status}`; break }
        data[a.as] = JSON.parse(ctx.d.guard.shown(got.body, site()))
        res.steps.push({ step: 0, kind: `api ${a.as}`, ok: true, ms: Date.now() - t0 })
      } catch (e) { why = `${a.as}: ${e instanceof Error ? e.message : String(e)}`; break }
    }
    if (!why) { res.via = 'api'; res.data = data; return }
    res.steps.push({ step: 0, kind: 'api', ok: false, note: `fell back to the page: ${why}`, ms: 0 })
  }

  const drift: NonNullable<HealTicket['drift']> = []
  const gate = {
    site: site(), shadow: !!o.shadow, outbound: ctx.d.sites.policy(site()).outbound, fog: ctx.d.guard.fog, exfil: ctx.d.guard.exfil,
    ask: async (card: { title: string; detail: string; preview: { label: string; value: string }[]; kind: string }) => (await approve(ctx, c, t, { action: 'send', target: card.title, reason: card.detail, preview: card.preview, kind: `exfiltrate:${card.title}` })).allow,
  }
  const wouldSend: { method: string; url: string }[] = []

  for (const [i, s] of (r.steps as Step[]).entries()) {
    const n = i + 1
    const t0 = Date.now()
    if ('goto' in s) {
      const err = await go(fill(s.goto, vars))
      res.steps.push({ step: n, kind: 'goto', ok: !err, ms: Date.now() - t0, ...(err ? { note: err } : {}) })
      if (err) { res.error = `step ${n}: ${err}`; return }
      continue
    }
    if ('read' in s) {
      const req = parseReadRequest({ ...(s.read.region ? { region: s.read.region } : {}), ...(s.read.maxChars ? { maxChars: s.read.maxChars } : {}) })
      if (typeof req === 'string') { res.error = `step ${n}: ${req}`; return }
      const out = await readPage(t, req)
      if (!out.ok) { res.error = `step ${n}: ${out.error}`; res.steps.push({ step: n, kind: 'read', ok: false, ms: Date.now() - t0 }); return }
      res.data[s.read.as] = ctx.d.guard.shown(out.text ?? '', site())
      res.steps.push({ step: n, kind: 'read', ok: true, ms: Date.now() - t0 })
      continue
    }
    if ('wait' in s) {
      const receipt = await actOnPage(t, { action: 'wait', waitText: s.wait.text, waitGone: s.wait.gone, ms: s.wait.ms ?? 10_000 })
      res.steps.push({ step: n, kind: 'wait', ok: receipt.ok, ms: Date.now() - t0, ...(receipt.ok ? {} : { note: receipt.error }) })
      if (!receipt.ok) { res.error = `step ${n}: ${receipt.error}`; return }
      continue
    }

    // An act: find the element again on a fresh map.
    if (s.text && /\{\{\s*ask:/.test(s.text) && o.shadow) {
      res.steps.push({ step: n, kind: s.act, ok: true, note: 'skipped in a dry run: it types something only the user gives', ms: 0 })
      continue
    }
    let ref: string | undefined
    let found: string | undefined
    let score: number | undefined
    if (s.target) {
      const map = await snapshotPage(t)
      const exact = await locate(t, map, s.target)
      if (exact) {
        ref = exact.ref
        found = exact.level
        // Found by position or a changed name: the run works, but the saved fingerprint is out of date.
        const live = map.items.find(i => i.ref === exact.ref)
        if (live && exact.level !== 'attribute' && (live.name !== s.target.name || live.role !== s.target.role)) {
          const to: Fingerprint = { role: live.role, name: live.name, attrs: await attrsForRef(t, live.ref).catch(() => ({})), ...(live.x != null ? { x: Math.round(live.x) } : {}), ...(live.y != null ? { y: Math.round(live.y) } : {}) }
          const score = Math.round(dice(s.target.name, live.name) * 100) / 100
          drift.push({ step: n, from: s.target, to, score })
          res.healed.push({ step: n, from: label(s.target), to: label(to), score })
        }
      } else {
        const sim = await relocate(map.items, s.target, x => attrsForRef(t, x))
        if (sim) {
          ref = sim.item.ref
          found = 'similar'
          score = sim.score
          const to: Fingerprint = { role: sim.item.role, name: sim.item.name, attrs: await attrsForRef(t, sim.item.ref).catch(() => ({})), ...(sim.item.x != null ? { x: Math.round(sim.item.x) } : {}), ...(sim.item.y != null ? { y: Math.round(sim.item.y) } : {}) }
          drift.push({ step: n, from: s.target, to, score: sim.score })
          res.healed.push({ step: n, from: label(s.target), to: label(to), score: sim.score })
        }
      }
      if (!ref) {
        res.steps.push({ step: n, kind: s.act, ok: false, note: `${label(s.target)} is not on the page any more`, ms: Date.now() - t0 })
        res.error = `step ${n}: ${label(s.target)} was not found (the site changed)`
        if (heal && o.tickets !== false && !o.shadow) {
          const shot = await stepShot(t)
          const ticket = heal.open({
            site: r.site, routine: r.name, version: r.version, kind: 'broken', step: n, error: res.error,
            evidence: { url: t.getURL(), snapshot: ctx.d.guard.shown(formatSummary(map, { scope: 'all' }), site(), false).slice(0, 12_000), ...(shot ? { shot } : {}) },
          })
          res.heal = ticket.id
        }
        return
      }
    }
    const raw = { action: s.act, ...(ref ? { ref } : {}), ...(s.text != null ? { text: fill(s.text, vars) } : {}), ...(s.value ? { value: fill(s.value, vars) } : {}), ...(s.key ? { key: s.key } : {}), ...(s.direction ? { direction: s.direction } : {}), ...(s.clear ? { clear: true } : {}), ...(s.ms ? { ms: s.ms } : {}) }
    const parsed = parseActRequest(raw)
    if (typeof parsed === 'string') { res.error = `step ${n}: ${parsed}`; return }
    const opts = { highlight: true, judge: ctx.d.guard.judge(site()) }
    const run = async (q: ActRequest) => { const [rec, log] = await withNetGate(t, gate, () => actOnPage(t, q, opts)); wouldSend.push(...log.wouldSend); return rec }
    let receipt = await run(parsed)
    if (receipt.needsConfirm) {
      if (o.shadow) {
        res.steps.push({ step: n, kind: s.act, ok: true, ...(found ? { found } : {}), ...(score ? { score } : {}), note: `would ${s.act} ${label(s.target)} here; a dry run stops before it`, ms: Date.now() - t0 })
        res.shadow = { wouldSend, stoppedAt: `step ${n}: ${s.act} ${label(s.target)}` }
        break
      }
      const d = await approve(ctx, c, t, { action: s.act, target: label(s.target), reason: receipt.error ?? '', preview: [{ label: 'Routine', value: `${r.site}/${r.name} step ${n}` }, ...(s.text && !/\{\{\s*ask:/.test(s.text) ? [{ label: 'Text', value: s.text }] : [])] })
      if (!d.allow) { res.steps.push({ step: n, kind: s.act, ok: false, note: 'the user did not allow it', ms: Date.now() - t0 }); res.error = `step ${n}: ${d.limit ?? 'the user did not allow it'}`; return }
      receipt = await run({ ...parsed, confirm: true })
    }
    res.steps.push({ step: n, kind: s.act, ok: receipt.ok, ...(found ? { found } : {}), ...(score ? { score } : {}), ms: Date.now() - t0, ...(receipt.ok ? {} : { note: receipt.error }) })
    if (!receipt.ok) { res.error = `step ${n}: ${receipt.error}`; return }
  }
  if (o.shadow) res.shadow ??= { wouldSend }
  res.expect = await checkExpect(t, r.expect)

  // The page moved on its own, the run still worked: offer the new fingerprints for the user to accept.
  if (drift.length && heal && !o.shadow && res.expect.every(e => e.ok)) {
    const next: Routine = { ...r, version: r.version + 1, updated: new Date().toISOString(), steps: r.steps.map((s, i) => { const d = drift.find(x => x.step === i + 1); return d && 'act' in s ? { ...s, target: d.to } : s }) }
    const ticket = heal.open({
      site: r.site, routine: r.name, version: r.version, kind: 'drift', status: 'ready', error: `${drift.length} element(s) changed on the page; the run found them by similarity`,
      evidence: { url: t.getURL(), snapshot: '' }, drift,
      proposal: { yaml: dumpRoutine(next), note: drift.map(d => `step ${d.step}: ${label(d.from)} → ${label(d.to)} (${Math.round(d.score * 100)} %)`).join('\n'), by: 'similarity', at: Date.now(), test: { ok: true, summary: 'the run that found them passed' } },
    })
    res.heal = ticket.id
  }
}
