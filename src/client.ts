import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND, DEFAULT_PORT, envVar } from './brand'
import { daemonToken, paths, readJson } from './daemon/home'

/**
 * How the CLI and the MCP shim reach the daemon: HTTP on 127.0.0.1 with the
 * bearer token from ~/.tabgeist/token. `ensure` starts the daemon in the background
 * when nothing answers, so an agent's first tool call just works.
 */

export function daemonPort(): number {
  return Number(envVar('PORT')) || readJson<{ port?: number }>(paths.daemon(), {}).port || DEFAULT_PORT
}

export class DaemonClient {
  constructor(readonly port = daemonPort(), private readonly from: 'agent' | 'cli' = 'agent') {}

  get base(): string { return `http://127.0.0.1:${this.port}` }

  async health(): Promise<{ ok: boolean; pid?: number; version?: string } | null> {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1500) })
      return r.ok ? await r.json() as { ok: boolean; pid?: number; version?: string } : null
    } catch { return null }
  }

  /** Starts `<cli> start` detached when the daemon is not up, then waits for it (10 s). */
  async ensure(cliFile = process.argv[1]): Promise<string | null> {
    if (await this.health()) return null
    mkdirSync(paths.home(), { recursive: true })
    const log = openSync(join(paths.home(), 'daemon.log'), 'a')
    const child = spawn(process.execPath, [cliFile, 'start'], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, [`${BRAND.env}_PORT`]: String(this.port) }, windowsHide: true })
    child.unref()
    closeSync(log)
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200))
      if (await this.health()) return null
    }
    return `the ${BRAND.name} daemon did not start; see ${join(paths.home(), 'daemon.log')}`
  }

  async call(method: string, params: Record<string, unknown> = {}, who: { agent?: string; session?: string } = {}): Promise<Record<string, unknown>> {
    const send = () => fetch(`${this.base}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemonToken()}` },
      body: JSON.stringify({ method, params, from: this.from, ...who }),
    })
    let r: Response
    try { r = await send() } catch {
      const err = await this.ensure()
      if (err) return { ok: false, error: err }
      r = await send()
    }
    if (r.status === 401) return { ok: false, error: `the daemon refused the token (${paths.token()} changed?) — restart it: ${BRAND.slug} stop, then ${BRAND.slug} start` }
    return await r.json() as Record<string, unknown>
  }
}
