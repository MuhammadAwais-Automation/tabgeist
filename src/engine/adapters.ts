import { withDebugger } from './capture'
import type { PageTarget } from './target'

/**
 * A site adapter reads the data a web app already holds in the page (its
 * decrypted store) where nothing useful crosses the network — WhatsApp's
 * socket is encrypted end to end. It is a plain JS object:
 *
 *   ({ ops: { chats: { about: 'recent chats', run: async ({ limit }) => [...] } } })
 *
 * It runs in the page's own world, so it sees what the app sees; only Tabgeist's
 * built-in adapters and files the user put in sites/<site>/adapter.js run,
 * never code an agent sends. Ops only read.
 */

export interface AdapterOp { name: string; about: string }

export type AdapterResult =
  | { ok: true; data: unknown }
  | { ok: true; ops: AdapterOp[] }
  | { ok: false; error: string }

const TIMEOUT = 25_000

/** The page-side wrapper: lists the ops when `op` is null, else runs one and returns its value. */
export function adapterExpression(source: string, op: string | null, args: Record<string, unknown>): string {
  return `(async () => {
    const A = (${source})
    if (!A || typeof A !== 'object' || !A.ops) return { error: 'the adapter has no ops' }
    const op = ${JSON.stringify(op)}
    if (op === null) return { ops: Object.keys(A.ops).map(k => ({ name: k, about: String(A.ops[k].about || '') })) }
    const o = A.ops[op]
    if (!o || typeof o.run !== 'function') return { error: 'no op "' + op + '" — ops: ' + Object.keys(A.ops).join(', ') }
    try { return { data: await o.run(${JSON.stringify(args)}) } } catch (e) { return { error: String((e && e.message) || e) } }
  })()`
}

export async function runAdapter(wc: PageTarget, source: string, op: string | null, args: Record<string, unknown> = {}): Promise<AdapterResult> {
  const expression = adapterExpression(source, op, args)
  const r = await withDebugger(wc, send => Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise(res => setTimeout(() => res({ timedOut: true }), TIMEOUT)),
  ])) as { result?: { value?: { error?: string; ops?: AdapterOp[]; data?: unknown } }; exceptionDetails?: { text?: string; exception?: { description?: string } }; timedOut?: boolean }
  if (r.timedOut) return { ok: false, error: `the adapter took more than ${TIMEOUT / 1000} s` }
  if (r.exceptionDetails) return { ok: false, error: `the adapter threw: ${r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'error'}` }
  const v = r.result?.value
  if (!v) return { ok: false, error: 'the adapter returned nothing' }
  if (v.error) return { ok: false, error: v.error }
  if (op === null) return { ok: true, ops: v.ops ?? [] }
  return { ok: true, data: v.data ?? null }
}

const flat = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => x == null || typeof x !== 'object' || (Array.isArray(x) && x.every(y => typeof y !== 'object')))

/**
 * What an agent reads from an op: a list of flat records becomes a table (the
 * field names once, then one tab-separated line per record), which carries
 * the same data in far fewer characters than JSON. Anything else stays JSON;
 * an object's list fields become tables under their name.
 */
export function forAgent(data: unknown): string {
  const cell = (x: unknown) => (x == null ? '' : Array.isArray(x) ? x.join(', ') : String(x)).replace(/[\t\r\n]+/g, ' ')
  const table = (rows: Record<string, unknown>[]) => {
    const cols = [...new Set(rows.flatMap(r => Object.keys(r)))]
    return [cols.join('\t'), ...rows.map(r => cols.map(c => cell(r[c])).join('\t'))].join('\n')
  }
  const isTable = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every(flat)
  if (isTable(data)) return table(data)
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>
    const lists = Object.keys(o).filter(k => isTable(o[k]))
    if (lists.length) {
      const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !lists.includes(k)))
      return [JSON.stringify(rest), ...lists.map(k => `\n${k}:\n${table(o[k] as Record<string, unknown>[])}`)].join('\n')
    }
  }
  return JSON.stringify(data)
}
