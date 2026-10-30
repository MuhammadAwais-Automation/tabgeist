import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adapterExpression } from '../engine/adapters'

/**
 * `tabgeist pack try`: runs one op of a pack's adapter on a public page in a
 * throwaway headless Chrome or Edge (a temp profile, never the user's), so a
 * pack can be built and checked before it is installed. Pages that need the
 * user's login are tried after `pack add`, through an agent.
 */

export const BROWSERS = [
  process.env.CHROME_PATH,
  join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
]

export async function tryPack(dir: string, url: string, op: string | null, args: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; ms: number }> {
  const exe = BROWSERS.find(p => p && existsSync(p))
  if (!exe) throw new Error('no Chrome or Edge found: set CHROME_PATH')
  const source = readFileSync(join(dir, 'adapter.js'), 'utf8')
  const profile = mkdtempSync(join(tmpdir(), 'tabgeist-try-'))
  const p = spawn(exe, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const to = p.stdio[3] as NodeJS.WritableStream, from = p.stdio[4] as NodeJS.ReadableStream
  let buf = '', next = 1
  const waits = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>()
  from.on('data', (d: Buffer) => {
    buf += d.toString()
    for (let i; (i = buf.indexOf('\0')) >= 0;) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
      if (m.id && waits.has(m.id)) { waits.get(m.id)!(m); waits.delete(m.id) }
    }
  })
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string, ms = 30_000) => new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const id = next++
    const timer = setTimeout(() => { waits.delete(id); reject(new Error(`${method} timed out`)) }, ms)
    waits.set(id, m => { clearTimeout(timer); if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result) })
    to.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
  })
  try {
    const { targetId } = await call('Target.createTarget', { url })
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
    await call('Page.enable', {}, sessionId)
    // Let the app start (its scripts and stores), as a person would before reading.
    await new Promise(r => setTimeout(r, 4000))
    const t0 = Date.now()
    const r = await call('Runtime.evaluate', { expression: adapterExpression(source, op, args), awaitPromise: true, returnByValue: true }, sessionId, 60_000)
    const ms = Date.now() - t0
    if (r.exceptionDetails) return { ok: false, result: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text, ms }
    const v = r.result?.value ?? {}
    return { ok: !v.error, result: v.error ?? v.ops ?? v.data, ms }
  } finally {
    p.kill()
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500).unref()
  }
}
