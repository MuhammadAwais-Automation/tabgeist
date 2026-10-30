import { pickBrowser, type Connection, type Decision } from '../bridge/bridge'
import type { Method } from './browser'

/**
 * test.* methods for the e2e suite, registered only with TABGEIST_TEST=1: answer
 * approvals, pair browsers and look at a page directly, the way a user would
 * in the side panel or the control room.
 */

interface Deps {
  answerApproval(id: string, d: Decision): boolean
  pendingApprovals(): Record<string, unknown>[]
  pendingPairings(): { code: string }[]
  approvePairing(code: string): unknown
  link(): string
}

async function onTab<T>(p: Record<string, unknown>, fn: (send: (m: string, q?: unknown, s?: string) => Promise<unknown>) => Promise<T>): Promise<T | { error: string }> {
  const c = pickBrowser(p.browser)
  if (typeof c === 'string') return { error: c }
  const t = await (c as Connection).tab(p.tab)
  if (typeof t === 'string') return { error: t }
  t.debugger.attach()
  try { return await fn((m, q, s) => t.debugger.sendCommand(m, q ?? {}, s)) } finally { t.debugger.detach() }
}

export function testMethods(x: Deps): Record<string, Method> {
  return {
    'test.approvals': async () => x.pendingApprovals(),
    'test.answer': async p => ({ ok: x.answerApproval(String(p.approvalId), { allow: p.allow === true, grant: p.grant === 'site' ? 'site' : 'once', by: 'test' }) }),
    'test.pairings': async () => x.pendingPairings(),
    'test.pair': async p => x.approvePairing(String(p.code)),
    'test.loginLink': async () => ({ ok: true, url: x.link() }),
    'test.eval': p => onTab(p, async send => {
      const r = await send('Runtime.evaluate', { expression: String(p.expr), returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown } }
      return r.result?.value ?? null
    }),
    /** One raw CDP command on the tab, through the extension like the engine sends it. */
    'test.cdp': p => onTab(p, async send => {
      try { return await send(String(p.method), p.params ?? {}, typeof p.sessionId === 'string' ? p.sessionId : undefined) } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
    }),
  }
}
