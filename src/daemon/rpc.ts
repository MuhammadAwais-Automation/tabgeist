import { answerApproval, answerQuestion, approvePairing, connections, denyPairing, pendingApprovals, pendingPairings, pendingQuestions, recentActivity } from '../bridge/bridge'
import { browserMethods, type CallCtx, type Method } from './browser'
import type { TimelineEntry } from './timeline'
import { siteKey } from '../safety/fog'

/**
 * One dispatch for every caller. Agents (MCP shim, CLI with the bearer token)
 * reach only `agentMethods`; the control room also reaches `roomMethods`, which
 * answer approvals, pair browsers and change grants: an agent can never approve
 * its own step.
 */

const agentMethods: Record<string, Method> = { ...browserMethods }

const roomMethods: Record<string, Method> = {
  'room.state': async (_p, ctx) => ({
    ok: true,
    browsers: connections().map(c => ({ label: c.label, browser: c.browser, extension: c.extVersion })),
    paired: ctx.d.pairing.list(),
    pairings: pendingPairings(),
    approvals: pendingApprovals(),
    questions: pendingQuestions(),
    activity: recentActivity().slice(-100),
    grants: ctx.d.grants.list(),
    leases: ctx.d.leases.list(),
    settings: ctx.d.settings,
  }),
  'approval.answer': async (p) => {
    const ok = answerApproval(String(p.approvalId ?? ''), { allow: p.allow === true, grant: p.grant === 'site' ? 'site' : 'once', by: 'control-room' })
    return ok ? { ok: true } : { ok: false, error: 'that approval is no longer waiting' }
  },
  'question.answer': async (p) => {
    const ok = answerQuestion(String(p.askId ?? ''), { text: typeof p.text === 'string' ? p.text : undefined, done: p.done === true, skipped: p.skipped === true })
    return ok ? { ok: true } : { ok: false, error: 'that question is no longer waiting' }
  },
  'pairing.approve': async (p) => approvePairing(String(p.code ?? '')),
  'pairing.deny': async (p) => ({ ok: denyPairing(String(p.code ?? '')) }),
  'pairing.remove': async (p, ctx) => ({ ok: ctx.d.pairing.remove(String(p.id ?? '')) }),
  'grants.revoke': async (p, ctx) => ({ ok: ctx.d.grants.revoke(String(p.id ?? '')) }),
  'grants.clear': async (_p, ctx) => { ctx.d.grants.clear(); return { ok: true } },
  'settings.save': async (p, ctx) => {
    const next: Record<string, boolean> = {}
    for (const k of ['shots', 'strictNavigation', 'canaries'] as const) if (typeof p[k] === 'boolean') next[k] = p[k] as boolean
    return { ok: true, settings: ctx.d.saveSettings(next) }
  },
  'timeline.recent': async (p, ctx) => ({ ok: true, entries: ctx.d.timeline.recent({ limit: Number(p.limit) || 200, session: str(p.session), site: str(p.site), agent: str(p.agent) }) }),
  'timeline.sessions': async (_p, ctx) => ({ ok: true, sessions: ctx.d.timeline.sessions() }),
  'timeline.session': async (p, ctx) => ({ ok: true, entries: ctx.d.timeline.session(String(p.session ?? '')) }),
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Registers more methods (routines, sites, heal, …) from their own modules. */
export function addMethods(kind: 'agent' | 'room', methods: Record<string, Method>): void {
  Object.assign(kind === 'agent' ? agentMethods : roomMethods, methods)
}

export function methodNames(kind: 'agent' | 'room'): string[] {
  return Object.keys(kind === 'agent' ? agentMethods : { ...agentMethods, ...roomMethods }).sort()
}

/** Calls nobody needs in the timeline: the room's own polling and status checks. */
const QUIET = /^(room\.|timeline\.|browser\.status$|grants\.|settings\.|pairing\.|test\.)/
/** The control room looking around is not a step; what the person does there (run, replace, save) is. */
const ROOM_READS = /^(heal\.(all|list)|(sites|packs)\.list|site\.(get|notes)|routine\.(list|get))$/

/** One line about what was asked, for the timeline. */
export function describeInput(method: string, p: Record<string, unknown>): string | undefined {
  const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))
  const step = (q: Record<string, unknown>) => [q.action, q.ref ?? (q.x != null ? `(${q.x}, ${q.y})` : ''), q.text != null ? `"${s(q.text).slice(0, 80)}"` : '', q.key ?? '', q.value ?? ''].filter(Boolean).join(' ')
  switch (method) {
    case 'browser.act': return Array.isArray(p.steps) ? (p.steps as Record<string, unknown>[]).map(step).join(' → ') : step(p)
    case 'browser.open': case 'browser.navigate': return s(p.url || p.go)
    case 'browser.read': return [p.ref, p.region, p.selector, p.load ? `load ${s(p.load)}` : ''].filter(Boolean).map(s).join(' ') || 'main'
    case 'browser.snapshot': return [p.scope, p.within ? `within ${s(p.within)}` : '', p.diff ? 'diff' : ''].filter(Boolean).map(s).join(' ') || 'viewport'
    case 'browser.askUser': return s(p.question)
    default: {
      const keys = Object.keys(p).filter(k => !['browser', 'tab'].includes(k))
      return keys.length ? keys.map(k => `${k}=${s(p[k]).slice(0, 60)}`).join(' ') : undefined
    }
  }
}

/** One line about what happened, for the timeline. */
export function describeResult(method: string, r: Record<string, unknown>): string {
  if (r.ok === false) return String(r.error ?? 'failed')
  switch (method) {
    case 'browser.act': return [`${r.action ?? ''} ${r.target ?? ''}`.trim(), r.navigated ? `→ ${r.url}` : '', Array.isArray(r.announce) ? (r.announce as string[]).join('; ') : ''].filter(Boolean).join(' · ') || 'done'
    case 'browser.read': return `read ${r.chars ?? 0} characters`
    case 'browser.snapshot': return `map of ${r.url ?? 'the page'}`
    case 'browser.open': case 'browser.navigate': return `at ${(r.tab as { url?: string } | undefined)?.url ?? ''}`
    default: return typeof r.summary === 'string' ? r.summary : 'ok'
  }
}

export interface Caller { from: CallCtx['from']; agent: string; session: string }

/** Runs a method for a caller and writes the call to the timeline. */
export async function dispatch(d: CallCtx['d'], method: string, params: Record<string, unknown>, who: Caller): Promise<unknown> {
  const roomish = who.from === 'room' || who.from === 'test'
  const fn = agentMethods[method] ?? (roomish ? roomMethods[method] : undefined)
  if (!fn) return { ok: false, error: roomMethods[method] ? `${method} can only be done by the user in the control room` : `no method ${method}` }
  const ctx: CallCtx = { d, agent: who.agent, session: who.session, from: who.from, meta: {} }
  const started = Date.now()
  let result: Record<string, unknown>
  try {
    result = (await fn(params ?? {}, ctx) ?? { ok: true }) as Record<string, unknown>
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!QUIET.test(method) && !(who.from === 'room' && ROOM_READS.test(method))) {
    const entry: Omit<TimelineEntry, 'id' | 'at'> = {
      session: who.session,
      agent: who.agent,
      method,
      input: describeInput(method, params ?? {}),
      ok: result.ok !== false,
      ms: Date.now() - started,
      summary: describeResult(method, result),
      ...(result.ok === false && typeof result.error === 'string' ? { error: result.error } : {}),
      ...(ctx.meta.browser ? { browser: ctx.meta.browser } : {}),
      ...(ctx.meta.tab != null ? { tab: ctx.meta.tab } : {}),
      ...(ctx.meta.site ? { site: siteKey(ctx.meta.site) } : {}),
      ...(ctx.meta.shot ? { shot: ctx.meta.shot } : {}),
      ...(ctx.meta.approvals?.length ? { approvals: ctx.meta.approvals } : {}),
      ...(ctx.meta.routine ? { routine: ctx.meta.routine } : {}),
    }
    try { d.timeline.add(entry) } catch { /* a full disk must not fail the call */ }
  }
  // The agent learns who let a risky step through (or stopped it), not just that it ran.
  if (ctx.meta.approvals?.length) result = { ...result, approvals: ctx.meta.approvals }
  return result
}
