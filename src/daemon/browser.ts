import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { askApproval, askUser, busy, connections, note, pickBrowser, type Connection, type Decision } from '../bridge/bridge'
import type { ChromeTab, TabInfo } from '../bridge/chromeTab'
import { withDebugger } from '../engine/capture'
import { withNetGate, type GateLog } from '../safety/netgate'
import { hostLabel, normalizeUrl } from '../engine/url'
import { kindOf } from './grants'
import { recording } from './recording'
import { recorder } from '../engine/actions'
import { paths } from './home'
import type { DaemonState } from './state'

/**
 * The browser tools agents call (browser_* over MCP): the user's own Chrome or
 * Edge through the paired extension, run by the perception engine. Every call
 * holds the tab's lease, and risky steps are approved in the browser or the
 * control room, never by the agent.
 */

/** Web apps that allow one open tab per browser; browser_open reuses that tab. */
export const ONE_TAB = new Set(['web.whatsapp.com'])

/** Who is calling, and what the timeline should know about the call. */
export interface CallCtx {
  d: DaemonState
  agent: string
  session: string
  from: 'agent' | 'room' | 'cli' | 'test'
  meta: { site?: string; tab?: number; browser?: string; shot?: string; approvals?: { title: string; allow: boolean; by?: string }[]; routine?: string }
}

export type Method = (p: Record<string, unknown>, ctx: CallCtx) => Promise<unknown>

type Resolved = { c: Connection; t: ChromeTab; release: () => void }

async function resolve(p: Record<string, unknown>, ctx: CallCtx): Promise<Resolved | { error: string }> {
  const c = pickBrowser(p.browser)
  if (typeof c === 'string') return { error: c }
  const t = await c.tab(p.tab)
  if (typeof t !== 'string' && isRoom(t.getURL(), ctx.d.port)) return { error: ROOM_ONLY }
  if (typeof t === 'string') return { error: t }
  const key = `${c.label}#${t.tabId}`
  const busyErr = await ctx.d.leases.acquire(key, ctx.agent)
  if (busyErr) return { error: busyErr }
  ctx.meta.browser = c.label
  ctx.meta.tab = t.tabId
  ctx.meta.site = hostLabel(t.getURL())
  return { c, t, release: () => ctx.d.leases.release(key, ctx.agent) }
}

/** Runs `fn` on the resolved tab and always lets the lease go. */
async function onTab(p: Record<string, unknown>, ctx: CallCtx, fn: (r: Resolved) => Promise<unknown>): Promise<unknown> {
  const r = await resolve(p, ctx)
  if ('error' in r) return { ok: false, error: r.error }
  try { return await fn(r) } finally { r.release() }
}

function line(r: { ok: boolean; action: string; target?: string; error?: string; steps?: number }): string {
  return `${r.steps != null ? `${r.steps} step(s): ` : ''}${r.action}${r.target ? ` ${r.target}` : ''}${r.error ? ` — ${r.error}` : ''}`
}

const SHOTS_KEEP = 1500

export const shotName = (): string => `${Date.now()}-${randomBytes(3).toString('hex')}.jpg`

/** A small picture of the page after a step, for the timeline; never fails the step. */
export async function stepShot(t: ChromeTab, name = shotName()): Promise<string | undefined> {
  try {
    const data = await withDebugger(t, async send => {
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 40 }) as { data: string }
      return r.data
    })
    const dir = paths.shots()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), Buffer.from(data, 'base64'))
    const all = readdirSync(dir).filter(f => f.endsWith('.jpg')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - SHOTS_KEEP))) rmSync(join(dir, old), { force: true })
    return name
  } catch { return undefined }
}

/**
 * Asks the user about one risky step, unless a live grant for this kind of step
 * on this site already covers it. A "for 15 minutes on this site" answer
 * becomes a grant.
 */
export async function approve(ctx: CallCtx, c: Connection, t: ChromeTab, ask: { action: string; target?: string; reason: string; preview?: { label: string; value: string }[]; kind?: string }): Promise<Decision> {
  const site = hostLabel(t.getURL())
  const scope = { browser: c.label, site, kind: ask.kind ?? kindOf(ask.action, ask.target) }
  const title = `${ask.action} ${ask.target ?? ''}`.trim()
  // The user's limits for this site count every approved risky step, granted or clicked.
  const name = /"(.*)"/.exec(ask.target ?? '')?.[1] ?? ask.target
  if (ctx.d.grants.use(scope)) {
    const limited = ctx.d.guard.limit(site, name)
    if (limited) { ctx.meta.approvals = [...(ctx.meta.approvals ?? []), { title, allow: false, by: 'limit' }]; return { allow: false, by: 'control-room', limit: limited } }
    ctx.meta.approvals = [...(ctx.meta.approvals ?? []), { title, allow: true, by: 'grant' }]
    return { allow: true, by: 'control-room' }
  }
  const d = await askApproval(c, t.tabId, {
    title,
    detail: ask.reason.replace(/ — ask the user first, then repeat with confirm: true$/, ''),
    site,
    kind: scope.kind.split(':')[0],
    preview: ask.preview,
    grantable: true,
    agent: ctx.agent,
  })
  if (d.allow) {
    const limited = ctx.d.guard.limit(site, name)
    if (limited) { ctx.meta.approvals = [...(ctx.meta.approvals ?? []), { title, allow: false, by: 'limit' }]; return { allow: false, by: d.by, limit: limited } }
  }
  if (d.allow && d.grant === 'site') ctx.d.grants.allow(scope)
  ctx.meta.approvals = [...(ctx.meta.approvals ?? []), { title, allow: d.allow, by: d.by }]
  return d
}

/** Opening an address: the user's rules, secrets and read text in the url, strict navigation. */
/** The control room is the user's: agents may not open, read or click in it (they would approve their own steps). */
export const ROOM_ONLY = 'that is the control room; only the user works there'
export function isRoom(url: string, port: number): boolean {
  try { const u = new URL(url); return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) === port } catch { return false }
}

export async function navigationOk(ctx: CallCtx, c: Connection, tabId: number, url: string, fromSite?: string): Promise<string | null> {
  if (isRoom(url, ctx.d.port)) return ROOM_ONLY
  const v = ctx.d.guard.navigation(url, fromSite, ctx.d.settings.strictNavigation)
  if (!v) return null
  if ('block' in v) return v.block
  const d = await askApproval(c, tabId, { title: `open ${hostLabel(url)}`, detail: v.ask, site: hostLabel(url), kind: 'navigate', preview: [{ label: 'Address', value: ctx.d.guard.scrub(url).slice(0, 400) }], agent: ctx.agent })
  ctx.meta.approvals = [...(ctx.meta.approvals ?? []), { title: `open ${hostLabel(url)}`, allow: d.allow, by: d.by }]
  return d.allow ? null : `the user did not allow opening ${hostLabel(url)} (${v.ask}); do not try another way`
}

/** What the user sees about a risky step: the element and what the agent typed on the way there. */
function previewOf(reqs: { action: string; text?: string; key?: string; files?: string[] }[], at: number, target?: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  if (target) out.push({ label: 'Element', value: target })
  const typed = reqs.slice(0, at + 1).filter(r => r.text).map(r => r.text!).join(' ⏎ ')
  if (typed) out.push({ label: 'Text', value: typed.length > 400 ? `${typed.slice(0, 400)}…` : typed })
  const files = reqs[at]?.files
  if (files?.length) out.push({ label: 'Files', value: files.join('\n') })
  if (reqs[at]?.key) out.push({ label: 'Key', value: reqs[at].key! })
  return out
}

export const browserMethods: Record<string, Method> = {
  'browser.status': async () => {
    const all = connections()
    return { ok: true, connected: all.length > 0, browsers: all.map(c => ({ browser: c.label, app: c.browser, extension: c.extVersion })) }
  },

  'browser.tabs': async (p) => {
    const one = typeof p.browser === 'string' && p.browser.trim() ? pickBrowser(p.browser) : null
    if (typeof one === 'string') return { ok: false, error: one }
    const list = one ? [one] : connections()
    if (!list.length) return { ok: false, error: pickBrowser() as string }
    const browsers = await Promise.all(list.map(async c => ({ browser: c.label, tabs: await c.request('tabs.list') as TabInfo[] })))
    return { ok: true, browsers }
  },

  'browser.open': async (p, ctx) => {
    const c = pickBrowser(p.browser)
    if (typeof c === 'string') return { ok: false, error: c }
    const url = typeof p.url === 'string' ? normalizeUrl(p.url) : ''
    if (!url) return { ok: false, error: 'url is required (http or https)' }
    const refused = await navigationOk(ctx, c, -1, url)
    if (refused) return { ok: false, error: refused }
    // Apps that run in one tab per browser: a second tab only shows "open in another window".
    const host = new URL(url).hostname
    if (ONE_TAB.has(host)) {
      const open = (await c.request('tabs.list') as TabInfo[]).filter(x => { try { return new URL(x.url).hostname === host } catch { return false } })
      const tab = open.find(x => x.agent) ?? open[0]
      if (tab) {
        ctx.d.guard.visit(hostLabel(tab.url))
        recording.begin(`${c.label}#${tab.id}`, tab.url)
        ctx.meta.browser = c.label
        ctx.meta.tab = tab.id
        ctx.meta.site = hostLabel(tab.url)
        note(c, tab.id, 'open', `reused the open ${host} tab`, true, ctx.agent)
        return { ok: true, tab, reused: true, note: `${host} runs in one tab per browser, so this is the tab already open${tab.agent ? '' : " (the user's own; it stays where it is)"}. Move inside the app instead of opening it again.` }
      }
    }
    const tab = await c.request('tabs.open', { url, active: p.active === true }) as TabInfo
    ctx.d.guard.visit(hostLabel(tab.url || url))
    recording.begin(`${c.label}#${tab.id}`, tab.url || url)
    ctx.meta.browser = c.label
    ctx.meta.tab = tab.id
    ctx.meta.site = hostLabel(tab.url || url)
    note(c, tab.id, 'open', `opened ${url}`, true, ctx.agent)
    return { ok: true, tab }
  },

  'browser.navigate': (p, ctx) => onTab(p, ctx, async ({ c, t }) => {
    const go = typeof p.go === 'string' ? p.go : undefined
    const url = typeof p.url === 'string' && p.url.trim() ? normalizeUrl(p.url) : undefined
    if (!url && !(go && ['back', 'forward', 'reload'].includes(go))) return { ok: false, error: 'give url, or go: back | forward | reload' }
    if (url) {
      const refused = await navigationOk(ctx, c, t.tabId, url, hostLabel(t.getURL()))
      if (refused) return { ok: false, error: refused }
    }
    const tab = await c.request('tabs.navigate', { tabId: t.tabId, url, go }) as TabInfo
    ctx.d.guard.visit(hostLabel(tab.url))
    if (url) { recording.begin(`${c.label}#${t.tabId}`, tab.url); recorder.forget(t.id) }
    t.update(tab)
    ctx.meta.site = hostLabel(tab.url)
    note(c, t.tabId, 'navigate', url ? `went to ${url}` : go!, true, ctx.agent)
    return { ok: true, tab }
  }),

  'browser.closeTab': (p, ctx) => onTab(p, ctx, async ({ c, t }) => {
    await c.request('tabs.close', { tabId: t.tabId })
    note(c, t.tabId, 'close', `closed ${t.getTitle() || t.getURL()}`, true, ctx.agent)
    return { ok: true }
  }),

  'browser.snapshot': (p, ctx) => onTab(p, ctx, async ({ c, t }) => {
    const { narrowMap, snapshotPage, stateFor } = await import('../engine/capture')
    const { diffMaps, formatSummary } = await import('../engine/serialize')
    const prev = stateFor(t).last
    const map = await busy(c, t.tabId, () => snapshotPage(t))
    note(c, t.tabId, 'snapshot', `read ${map.title || map.url} (${map.items.length} items, ${map.ms ?? 0} ms)`, true, ctx.agent)
    const meta = { tab: t.tabId, ms: map.ms, iframes: map.iframes ?? 0 }
    const site = hostLabel(map.url)
    ctx.d.guard.visit(site)
    const fog = (s: string) => ctx.d.guard.shown(s, site)
    if (typeof p.within === 'string' && p.within.trim()) {
      const part = await busy(c, t.tabId, () => narrowMap(t, map, p.within as string))
      if (typeof part === 'string') return { ok: false, error: part, ...meta }
      return { ok: true, url: map.url, ...meta, within: part.container.ref, text: fog(formatSummary(part.map, { scope: 'viewport' })) }
    }
    if (p.diff === true) { const d = diffMaps(prev, map); return { ok: true, url: map.url, ...meta, ...d, text: fog(d.text) } }
    return { ok: true, url: map.url, ...meta, text: fog(formatSummary(map, { scope: p.scope === 'all' ? 'all' : 'viewport', prev: prev?.url === map.url ? prev : null })) }
  }),

  'browser.screenshot': (p, ctx) => onTab(p, ctx, async ({ c, t }) => {
    const { screenshot } = await import('../engine/shot')
    const ref = typeof p.ref === 'string' && p.ref.trim() ? p.ref.trim() : undefined
    const shot = await busy(c, t.tabId, () => screenshot(t, { ref, full: p.full === true }))
    if (typeof shot === 'string') return { ok: false, error: shot }
    note(c, t.tabId, 'screenshot', ref ? `pictured ${ref}` : 'pictured the page', true, ctx.agent)
    return { ok: true, tab: t.tabId, ...shot }
  }),

  'browser.download': (p, ctx) => {
    const ref = typeof p.ref === 'string' && p.ref.trim() ? p.ref.trim() : undefined
    const url = typeof p.url === 'string' && p.url.trim() ? p.url.trim() : undefined
    if (!ref && !url) return Promise.resolve({ ok: false, error: 'give ref (an image, video or link from the snapshot) or url' })
    return onTab(p, ctx, async ({ c, t }) => {
      const { saveFromPage } = await import('../engine/fetchFile')
      const out = await busy(c, t.tabId, () => saveFromPage(t, { ref, url }))
      if (typeof out === 'string') { note(c, t.tabId, 'download', out, false, ctx.agent); return { ok: false, error: out } }
      note(c, t.tabId, 'download', `saved ${out.file} (${Math.round(out.bytes / 1024)} KB)`, true, ctx.agent)
      return { ok: true, tab: t.tabId, ...out }
    })
  },

  'browser.askUser': async (p, ctx) => {
    const c = pickBrowser(p.browser)
    if (typeof c === 'string') return { ok: false, error: c }
    const question = typeof p.question === 'string' ? p.question.trim() : ''
    if (!question) return { ok: false, error: 'question is required' }
    const secret = p.secret === true
    const choices = Array.isArray(p.choices) ? p.choices.filter((x): x is string => typeof x === 'string').slice(0, 6) : []
    const tabId = typeof p.tab === 'number' ? p.tab : undefined
    note(c, tabId, 'ask', question, true, ctx.agent)
    const a = await askUser(c, question, { tabId, secret, choices })
    note(c, tabId, 'answer', a.skipped ? 'no answer' : a.done ? 'the user did it' : secret ? 'answered (hidden)' : `answered "${a.text ?? ''}"`, !a.skipped, ctx.agent)
    if (a.skipped) return { ok: false, error: 'the user did not answer (skipped or 5 minutes passed) — do not guess; tell them what is waiting' }
    return { ok: true, ...(a.done ? { done: true, note: 'the user did it themselves — take a new snapshot to see the result' } : { answer: a.text ?? '' }) }
  },

  'browser.read': async (p, ctx) => {
    const { parseReadRequest, readPage } = await import('../engine/read')
    const req = parseReadRequest(p)
    if (typeof req === 'string') return { ok: false, error: req }
    return onTab(p, ctx, async ({ c, t }) => {
      if (req.data) {
        const site = hostLabel(t.getURL())
        ctx.d.guard.visit(site)
        const { adapterFor } = await import('../sites/adapters')
        const adapter = adapterFor(ctx.d.sites, site)
        if (req.op) {
          if (!adapter) return { ok: false, error: `no adapter for ${site} — use data: true without op (the network JSON), or read the text`, tab: t.tabId }
          const { runAdapter, forAgent } = await import('../engine/adapters')
          const { clip } = await import('../engine/read')
          const r = await busy(c, t.tabId, () => runAdapter(t, adapter.source, req.op!, req.args))
          if (!r.ok) { note(c, t.tabId, 'read', `${req.op}: ${r.error}`, false, ctx.agent); return { ...r, tab: t.tabId } }
          const data = 'data' in r ? r.data : null
          const full = req.raw ? JSON.stringify(data) : forAgent(data)
          const { text, truncated } = clip(full, req.maxChars ?? 20_000, false)
          note(c, t.tabId, 'read', `read ${req.op} from the ${site} adapter (${full.length} characters)`, true, ctx.agent)
          return { ok: true, url: t.getURL(), op: req.op, text: ctx.d.guard.shown(text, site), chars: full.length, truncated, tab: t.tabId }
        }
        const { readData } = await import('../engine/data')
        const d = await busy(c, t.tabId, () => readData(t, req))
        note(c, t.tabId, 'read', d.ok ? `read ${d.responses} data answer(s) (${d.fresh} new${req.reload ? ', after a reload' : ''})` : d.error!, d.ok, ctx.agent)
        // A site with an adapter says so: its ops are often the better way in.
        let ops: { name: string; about: string }[] | undefined
        if (adapter) {
          const { runAdapter } = await import('../engine/adapters')
          const l = await runAdapter(t, adapter.source, null).catch(() => null)
          if (l?.ok && 'ops' in l) ops = l.ops
        }
        const hint = ops ? { adapter: { ops, use: 'browser_read with data: true, op: "<name>", args: {...}' } } : {}
        if (!d.ok && ops) return { ok: false, error: `no JSON came over the network here; this site has an adapter — use op: ${ops.map(o => o.name).join(' / ')}`, ...hint, tab: t.tabId }
        return { ...d, ...(d.text ? { text: ctx.d.guard.shown(d.text, site) } : {}), ...hint, tab: t.tabId }
      }
      const out = await busy(c, t.tabId, () => readPage(t, req))
      note(c, t.tabId, 'read', out.ok ? `read ${out.chars} characters${out.loaded ? ` after loading ${out.loaded} screen(s)` : ''}` : out.error!, out.ok, ctx.agent)
      const site = hostLabel(t.getURL())
      ctx.d.guard.visit(site)
      return { ...out, ...(out.text ? { text: ctx.d.guard.shown(out.text, site) } : {}), tab: t.tabId }
    })
  },

  'browser.act': (p, ctx) => onTab(p, ctx, async ({ c, t }) => {
    const { actOnPage, parseActRequests } = await import('../engine/actions')
    // The agent's own confirm is always dropped: a risky step is approved by the user, in the
    // browser or the control room, or by a grant the user gave there.
    const site = hostLabel(t.getURL())
    // A {{secret:N}} the agent saw is typed as the real value, and only on the site it came from.
    const unfog = (v: unknown) => {
      if (typeof v !== 'string') return v
      const r = ctx.d.guard.fog.reveal(v, site)
      if ('error' in r) throw new Error(r.error)
      return r.text
    }
    const steps = Array.isArray(p.steps) ? p.steps as Record<string, unknown>[] : undefined
    let real: Record<string, unknown>
    try {
      real = { ...p, text: unfog(p.text), ...(steps ? { steps: steps.map(s => (s && typeof s === 'object' ? { ...s, text: unfog(s.text) } : s)) } : {}) }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    const strip = (q: unknown) => (q && typeof q === 'object' ? { ...(q as Record<string, unknown>), confirm: false } : q)
    let reqs = parseActRequests({ ...real, confirm: false, ...(Array.isArray(real.steps) ? { steps: (real.steps as unknown[]).map(strip) } : {}) })
    if (typeof reqs === 'string') return { ok: false, error: reqs }
    // Approval cards show what the agent sent ({{secret:N}} stays fogged there).
    const shown = parseActRequests({ ...p, confirm: false })
    const all = typeof shown === 'string' ? reqs : shown
    // The page's data calls are always watched: they become a routine's API-first steps.
    const opts = { network: true, highlight: true, judge: ctx.d.guard.judge(site) }
    const tabKey = `${c.label}#${t.tabId}`
    recording.touch(tabKey, t.getURL())
    const gate = {
      site, shadow: false, outbound: ctx.d.sites.policy(site).outbound, fog: ctx.d.guard.fog, exfil: ctx.d.guard.exfil,
      ask: async (card: { title: string; detail: string; preview: { label: string; value: string }[]; kind: string }) => {
        const d = await askApproval(c, t.tabId, { ...card, site, agent: ctx.agent })
        ctx.meta.approvals = [...(ctx.meta.approvals ?? []), { title: card.title, allow: d.allow, by: d.by }]
        return d.allow
      },
    }
    const held: GateLog['held'] = []
    const run = async (list: typeof reqs & object) => {
      const [r, log] = await withNetGate(t, gate, () => actOnPage(t, list, opts))
      held.push(...log.held)
      return r
    }
    const started = Date.now()
    const first = reqs
    let receipt = await busy(c, t.tabId, () => run(first))
    let ran = receipt.steps ?? (receipt.ok ? 1 : 0)
    let offset = 0
    // Only the step the user allowed is confirmed, so a later risky step asks again.
    while (receipt.needsConfirm) {
      const at = (receipt.failedStep ?? 1) - 1
      const d = await approve(ctx, c, t, { action: reqs[at]?.action ?? receipt.action, target: receipt.target, reason: receipt.error ?? '', preview: previewOf(all, offset + at, receipt.target) })
      if (!d.allow) {
        receipt = { ...receipt, error: `${receipt.error?.replace(/ — ask the user first, then repeat with confirm: true$/, '') ?? 'needs approval'} — ${d.limit ?? 'the user did not allow it'}; do not retry unless they ask` }
        break
      }
      offset += at
      reqs = reqs.slice(at).map((q, i) => (i === 0 ? { ...q, confirm: true } : q))
      const next = reqs
      receipt = await busy(c, t.tabId, () => run(next))
      ran += receipt.steps ?? (receipt.ok ? 1 : 0)
      if (receipt.steps != null) receipt.steps = ran
    }
    if (held.length) (receipt as typeof receipt & { held?: typeof held }).held = held
    recording.saw(tabKey, receipt.requests ?? [])
    if (p.network !== true) { delete receipt.requests; delete receipt.sockets }
    // Downloads the page started itself.
    type Dl = { file: string; url: string; state: string; bytes: number }
    const since = () => c.request('downloads.since', { since: started - 500 }, 5000).catch(() => []) as Promise<Dl[]>
    let files = await since()
    // A "Download" / "Save" / "Export" click often starts its file seconds later (decrypting, building a zip or PDF):
    // wait for it here, so the agent does not click again and get a second copy.
    if (!files.length && receipt.ok && /download|export|save (as|file|image|photo|picture|video|media|attachment|pdf|to )/i.test(receipt.target ?? '')) {
      for (let waited = 0; waited < 20_000 && !files.length; waited += 1000) {
        await new Promise(res => setTimeout(res, 1000))
        files = await since()
      }
      if (!files.length) receipt.warning = 'no download started within 20 s; check with browser_screenshot before clicking again (a second click may save a second copy)'
    }
    if (files.length) receipt.downloads = files.map(f => ({ file: f.file, url: f.url.startsWith('data:') ? 'data: URL' : f.url.split('?')[0], state: f.state, bytes: f.bytes }))
    ctx.meta.site = hostLabel(t.getURL())
    // The picture is for the person's timeline, not the agent: the answer does not wait for it.
    if (ctx.d.settings.shots) { ctx.meta.shot = shotName(); void stepShot(t, ctx.meta.shot) }
    note(c, t.tabId, 'act', line(receipt), receipt.ok, ctx.agent)
    return { ...receipt, ...(receipt.diff ? { diff: { ...receipt.diff, text: ctx.d.redact(receipt.diff.text) } } : {}), tab: t.tabId }
  }),
}
