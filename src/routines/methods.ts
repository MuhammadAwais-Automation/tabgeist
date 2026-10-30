import { pickBrowser, bridgeEvents, connections } from '../bridge/bridge'
import { recorder, hostOf } from '../engine/actions'
import type { CallCtx, Method } from '../daemon/browser'
import { recording } from '../daemon/recording'
import { findSecrets } from '../safety/fog'
import { siteName } from '../sites/store'
import { dumpRoutine, everyMs, fromRecorded, paramNames, parseRoutine, readOnly, type Expect, type Routine } from './format'
import type { HealStore } from './heal'
import { runRoutine } from './runner'

/**
 * The daemon methods for learning: saving and running routines, site notes,
 * heal tickets, and (for the control room only) replacing, retiring and
 * rolling back routines, editing rules and notes.
 */

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function load(ctx: CallCtx, site: string, name: string): Routine | string {
  const text = ctx.d.sites.routineText(site, name)
  if (text == null || !text.trim()) return `no routine ${name} on ${site} — routine_list shows what there is`
  const r = parseRoutine(text)
  return typeof r === 'string' ? `routine ${site}/${name} is broken on disk: ${r}` : r
}

/** "site/name" or a bare name looked up across sites (must be unique). */
function find(ctx: CallCtx, ref: string): { site: string; name: string } | string {
  const i = ref.lastIndexOf('/')
  if (i > 0) { try { return { site: siteName(ref.slice(0, i)), name: ref.slice(i + 1) } } catch (e) { return (e as Error).message } }
  const hits = ctx.d.sites.sites().filter(s => ctx.d.sites.routineNames(s).includes(ref))
  if (!hits.length) return `no routine named ${ref} — routine_list shows what there is`
  if (hits.length > 1) return `${ref} exists on ${hits.join(', ')} — say site/name`
  return { site: hits[0], name: ref }
}

function summary(ctx: CallCtx, site: string, name: string) {
  const r = load(ctx, site, name)
  const h = ctx.d.sites.health(site).routines[name]
  const last = h?.runs.at(-1)
  if (typeof r === 'string') return { site, name, error: r }
  return {
    site, name, from: ctx.d.sites.routineFrom(site, name), version: r.version, description: r.description, steps: r.steps.length, api: r.api.length, params: paramNames(r),
    readOnly: readOnly(r), canary: r.canary?.every, broken: h?.broken,
    lastRun: last ? { at: new Date(last.at).toISOString(), ok: last.ok, ms: last.ms, by: last.by, shadow: last.shadow } : undefined,
    runs: h?.runs.length ?? 0, okRate: h?.runs.length ? Math.round((h.runs.filter(x => x.ok).length / h.runs.length) * 100) : undefined,
  }
}

/** The site's pack, for agents and the control room: what it is and what it knows. */
function packOf(ctx: CallCtx, site: string) {
  const p = ctx.d.sites.packs?.forSite(site)
  if (!p) return {}
  return { pack: { name: p.name, version: p.version, about: p.about, from: p.from, adapter: !!ctx.d.sites.packs!.adapter(site), notes: ctx.d.sites.packs!.notes(site) } }
}

export function routineMethods(heal: HealStore): { agent: Record<string, Method>; room: Record<string, Method> } {
  const agent: Record<string, Method> = {
    'routine.save': async (p, ctx) => {
      const name = str(p.name)
      if (!name || !/^[\w.-]{1,60}$/.test(name) || name.startsWith('.')) return { ok: false, error: 'name: letters, digits, dot, dash, underscore' }
      const c = pickBrowser(p.browser)
      if (typeof c === 'string') return { ok: false, error: c }
      const t = await c.tab(p.tab)
      if (typeof t === 'string') return { ok: false, error: t }
      const tabKey = `${c.label}#${t.tabId}`
      const start = str(p.start) ? new URL(str(p.start)!, t.getURL()).toString() : recording.start(tabKey) ?? t.getURL()
      const host = hostOf(t.getURL())
      let steps = recorder.recent(t.id, host)
      if (typeof p.last === 'number') steps = steps.slice(-p.last)
      if (!steps.length) return { ok: false, error: `nothing to save: no browser_act step worked on ${host} in this tab yet` }
      const site = siteName(host)
      const exists = ctx.d.sites.routineText(site, name)
      if (exists && exists.trim()) return { ok: false, error: `${site}/${name} exists already — pick another name, or ask the user to replace it in the control room` }
      const r = fromRecorded({
        name, site, start, description: str(p.description), recorded: steps,
        params: (p.params && typeof p.params === 'object' ? p.params : {}) as Record<string, string>,
        expect: Array.isArray(p.expect) ? (p.expect as Expect[]).filter(e => e && (e.text || e.url || e.gone)) : [],
        api: recording.calls(tabKey).filter(x => { try { return siteName(new URL(x.url).host) === site } catch { return false } }),
        secret: s => findSecrets(s).length > 0 || /\{\{\s*secret:\d+\s*\}\}/.test(s),
      })
      ctx.d.sites.saveRoutine(site, name, dumpRoutine(r), 1)
      ctx.meta.site = site
      bridgeEvents.emit('routine', { site, name, change: 'saved' })
      return { ok: true, saved: `${site}/${name}`, steps: r.steps.length, apiFirst: r.api.length > 0, params: paramNames(r), yaml: dumpRoutine(r), summary: `saved ${site}/${name} (${r.steps.length} steps${r.api.length ? `, API-first with ${r.api.length} call(s)` : ''})` }
    },

    'routine.list': async (p, ctx) => {
      const sites = str(p.site) ? [siteName(str(p.site)!)] : ctx.d.sites.sites()
      const routines = sites.flatMap(s => ctx.d.sites.routineNames(s).map(n => summary(ctx, s, n)))
      return { ok: true, routines, summary: `${routines.length} routine(s)` }
    },

    'routine.get': async (p, ctx) => {
      const f = find(ctx, String(p.name ?? ''))
      if (typeof f === 'string') return { ok: false, error: f }
      const text = ctx.d.sites.routineText(f.site, f.name)
      return text ? { ok: true, ...f, yaml: text, health: ctx.d.sites.health(f.site).routines[f.name] } : { ok: false, error: `no routine ${f.name}` }
    },

    'routine.run': async (p, ctx) => {
      const f = find(ctx, String(p.name ?? ''))
      if (typeof f === 'string') return { ok: false, error: f }
      const r = load(ctx, f.site, f.name)
      if (typeof r === 'string') return { ok: false, error: r }
      const vars = p.vars && typeof p.vars === 'object' ? Object.fromEntries(Object.entries(p.vars as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {}
      const out = await runRoutine(ctx, r, { tab: p.tab, browser: p.browser, vars, shadow: p.shadow === true, by: ctx.agent }, heal)
      bridgeEvents.emit('routine', { site: f.site, name: f.name, change: 'ran', ok: out.ok })
      if (out.heal) bridgeEvents.emit('heal', { id: out.heal })
      return { ...out, summary: `${out.ok ? 'ran' : 'failed'} ${f.site}/${f.name}${out.via === 'api' ? ' via API' : ''}${out.shadow ? ' (dry run)' : ''}${out.healed.length ? `, ${out.healed.length} healed` : ''}` }
    },

    'site.notes': async (p, ctx) => {
      const raw = str(p.site)
      if (!raw) return { ok: false, error: 'site is required' }
      const site = siteName(raw)
      return {
        ok: true, site,
        notes: ctx.d.sites.notes(site) || '(no notes yet — add one with site_note when you learn something)',
        ...packOf(ctx, site),
        routines: ctx.d.sites.routineNames(site).map(n => summary(ctx, site, n)),
        rules: ctx.d.sites.policyText(site) || '(no rules: the built-in checks apply)',
        heal: heal.list({ site, open: true }).map(t => ({ id: t.id, routine: t.routine, kind: t.kind, status: t.status })),
      }
    },

    'site.note': async (p, ctx) => {
      const raw = str(p.site), note = str(p.note)
      if (!raw || !note) return { ok: false, error: 'site and note are required' }
      if (findSecrets(note).length) return { ok: false, error: 'that note holds a secret; notes are for lessons, not data' }
      const site = siteName(raw)
      ctx.d.sites.addNote(site, ctx.d.guard.scrub(note), ctx.agent)
      ctx.meta.site = site
      return { ok: true, summary: `noted on ${site}` }
    },

    'heal.list': async (p, ctx) => {
      const site = str(p.site) ? siteName(str(p.site)!) : undefined
      const tickets = heal.list({ site, open: true }).map(t => ({ ...t, evidence: { ...t.evidence, snapshot: t.evidence.snapshot.slice(0, 6000) }, routineYaml: ctx.d.sites.routineText(t.site, t.routine) }))
      return { ok: true, tickets, summary: `${tickets.length} open ticket(s)` }
    },

    'heal.propose': async (p, ctx) => {
      const t = heal.get(String(p.id ?? ''))
      if (!t || !['open', 'failed', 'testing'].includes(t.status)) return { ok: false, error: 'no open heal ticket with that id — heal_list shows them' }
      if (t.kind !== 'broken') return { ok: false, error: 'this ticket already holds a tested fix; the user decides in the control room' }
      const r = parseRoutine(String(p.routine ?? ''))
      if (typeof r === 'string') return { ok: false, error: `the routine does not parse: ${r}` }
      if (r.name !== t.routine || siteName(r.site) !== t.site) return { ok: false, error: `the fix must keep name ${t.routine} and site ${t.site}` }
      const fixed: Routine = { ...r, version: t.version + 1, updated: new Date().toISOString() }
      heal.save({ ...t, status: 'testing', proposal: { yaml: dumpRoutine(fixed), note: str(p.note), by: ctx.agent, at: Date.now() } })
      // The fix is tried as a dry run: nothing is sent; it has to get past the broken step and keep its expectations.
      const test = await runRoutine(ctx, fixed, { tab: p.tab, browser: p.browser, shadow: true, by: `${ctx.agent} (heal test)`, tickets: false, closeAfter: p.tab == null }, null)
      const passed = !test.error
      const summaryText = passed ? `dry run passed${test.shadow?.stoppedAt ? ` (stopped before ${test.shadow.stoppedAt}, as a dry run does)` : ''}` : `dry run failed: ${test.error}`
      const saved = heal.save({ ...heal.get(t.id)!, status: passed ? 'ready' : 'failed', proposal: { yaml: dumpRoutine(fixed), note: str(p.note), by: ctx.agent, at: Date.now(), test: { ok: passed, summary: summaryText } } })
      bridgeEvents.emit('heal', { id: t.id, status: saved.status })
      return { ok: passed, id: t.id, status: saved.status, test: { ...test, data: undefined }, summary: passed ? 'the fix passed its dry run; the user will see it in the control room and decide' : summaryText, ...(passed ? {} : { error: summaryText }) }
    },
  }

  const room: Record<string, Method> = {
    'sites.list': async (_p, ctx) => ({
      ok: true,
      sites: ctx.d.sites.sites().map(site => {
        const names = ctx.d.sites.routineNames(site)
        const h = ctx.d.sites.health(site).routines
        return { site, pack: ctx.d.sites.packs?.forSite(site)?.name, routines: names.length, broken: names.filter(n => h[n]?.broken).length, rules: !!ctx.d.sites.policyText(site).trim(), notes: !!ctx.d.sites.notes(site).trim(), heal: heal.list({ site, open: true }).length, lastRun: Math.max(0, ...names.flatMap(n => h[n]?.runs.map(r => r.at) ?? [])) || undefined }
      }),
    }),
    'site.get': async (p, ctx) => {
      const site = siteName(String(p.site ?? ''))
      return { ok: true, site, ...packOf(ctx, site), rules: ctx.d.sites.policyText(site), notes: ctx.d.sites.notes(site), routines: ctx.d.sites.routineNames(site).map(n => ({ ...summary(ctx, site, n), yaml: ctx.d.sites.routineText(site, n), history: ctx.d.sites.history(site, n).map(h => h.version) })), health: ctx.d.sites.health(site), heal: heal.list({ site }) }
    },
    'packs.list': async (_p, ctx) => ({
      ok: true,
      dir: ctx.d.sites.packs?.installedDir,
      builtIn: ctx.d.sites.packs?.builtInDir,
      packs: (ctx.d.sites.packs?.list() ?? []).map(p => ({ ...p, routines: ctx.d.sites.packs!.routineNames(p.site), adapter: !!ctx.d.sites.packs!.adapter(p.site), notes: !!ctx.d.sites.packs!.notes(p.site).trim() })),
    }),
    'policy.save': async (p, ctx) => {
      const err = ctx.d.sites.savePolicy(siteName(String(p.site ?? '')), String(p.text ?? ''))
      return err ? { ok: false, error: err } : { ok: true }
    },
    'notes.save': async (p, ctx) => { ctx.d.sites.saveNotes(siteName(String(p.site ?? '')), String(p.text ?? '')); return { ok: true } },
    'routine.saveText': async (p, ctx) => {
      const r = parseRoutine(String(p.text ?? ''))
      if (typeof r === 'string') return { ok: false, error: r }
      const site = siteName(r.site)
      const old = ctx.d.sites.routineText(site, r.name)
      const prev = old ? parseRoutine(old) : null
      const version = prev && typeof prev !== 'string' ? prev.version + 1 : 1
      ctx.d.sites.saveRoutine(site, r.name, dumpRoutine({ ...r, version, updated: new Date().toISOString() }), version)
      bridgeEvents.emit('routine', { site, name: r.name, change: 'edited' })
      return { ok: true, version }
    },
    'routine.retire': async (p, ctx) => {
      const ok = ctx.d.sites.retireRoutine(siteName(String(p.site ?? '')), String(p.name ?? ''))
      bridgeEvents.emit('routine', { site: p.site, name: p.name, change: 'retired' })
      return { ok }
    },
    'routine.rollback': async (p, ctx) => {
      const site = siteName(String(p.site ?? '')), name = String(p.name ?? '')
      const h = ctx.d.sites.history(site, name).find(x => x.version === Number(p.version))
      if (!h) return { ok: false, error: 'no such version' }
      const cur = load(ctx, site, name)
      const r = parseRoutine(h.text)
      if (typeof r === 'string') return { ok: false, error: r }
      const version = (typeof cur === 'string' ? r.version : cur.version) + 1
      ctx.d.sites.saveRoutine(site, name, dumpRoutine({ ...r, version, updated: new Date().toISOString() }), version)
      return { ok: true, version }
    },
    'routine.runNow': async (p, ctx) => agent['routine.run']({ ...p, name: String(p.site) + '/' + String(p.name) }, ctx),
    'heal.all': async () => ({ ok: true, tickets: heal.list() }),
    'heal.apply': async (p, ctx) => {
      const t = heal.get(String(p.id ?? ''))
      if (!t?.proposal || t.status !== 'ready') return { ok: false, error: 'this ticket has no tested fix to apply' }
      const r = parseRoutine(t.proposal.yaml)
      if (typeof r === 'string') return { ok: false, error: r }
      const cur = load(ctx, t.site, t.routine)
      const version = Math.max(r.version, (typeof cur === 'string' ? 0 : cur.version) + 1)
      ctx.d.sites.saveRoutine(t.site, t.routine, dumpRoutine({ ...r, version, updated: new Date().toISOString() }), version)
      ctx.d.sites.recordRun(t.site, t.routine, { at: Date.now(), ok: true, ms: 0, by: 'heal applied' }, null)
      heal.close(t.id, 'applied')
      bridgeEvents.emit('heal', { id: t.id, status: 'applied' })
      return { ok: true, version }
    },
    'heal.dismiss': async (p) => {
      const t = heal.close(String(p.id ?? ''), 'dismissed')
      bridgeEvents.emit('heal', { id: p.id, status: 'dismissed' })
      return { ok: !!t }
    },
  }
  return { agent, room }
}

/**
 * Canaries: read-only routines with `canary: { every }` run as dry runs on
 * their schedule in a background tab, so a broken site is found before the
 * user needs the routine. One at a time, only while a browser is linked.
 */
export function startCanaries(ctx: () => CallCtx, heal: HealStore, checkEveryMs = 60_000): () => void {
  let running = false
  const tick = async () => {
    const c = ctx()
    if (running || !c.d.settings.canaries || !connections().length) return
    running = true
    try {
      for (const site of c.d.sites.sites()) {
        for (const name of c.d.sites.routineNames(site)) {
          const r = load(c, site, name)
          if (typeof r === 'string' || !r.canary) continue
          const every = everyMs(r.canary.every)
          const last = c.d.sites.health(site).routines[name]?.runs.filter(x => x.by === 'canary').at(-1)
          if (!every || (last && Date.now() - last.at < every)) continue
          const out = await runRoutine(c, r, { shadow: true, by: 'canary', closeAfter: true }, heal)
          bridgeEvents.emit('health', { site, name, ok: out.ok, error: out.error })
          if (!out.ok && !out.heal) {
            heal.open({ site, routine: name, version: r.version, kind: 'broken', error: `canary: ${out.error ?? 'failed'}`, evidence: { url: r.start ?? site, snapshot: '' } })
          }
        }
      }
    } catch { /* the next tick tries again */ } finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, checkEveryMs)
  return () => clearInterval(timer)
}
