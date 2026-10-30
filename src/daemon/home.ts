import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homeDir } from '../brand'

/** Where everything lives under ~/.tabgeist (or TABGEIST_HOME). */
export const paths = {
  home: () => homeDir(),
  token: () => join(homeDir(), 'token'),
  paired: () => join(homeDir(), 'paired.json'),
  settings: () => join(homeDir(), 'settings.json'),
  timeline: () => join(homeDir(), 'timeline'),
  shots: () => join(homeDir(), 'shots'),
  sites: () => join(homeDir(), 'sites'),
  packs: () => join(homeDir(), 'packs'),
  heal: () => join(homeDir(), 'heal'),
  daemon: () => join(homeDir(), 'daemon.json'),
}

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}

/** Written to a temp file first, so a crash never leaves half a file. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Constant-time string comparison for secrets. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The daemon's bearer token: made once, readable only by this user, shared by the CLI and the MCP shim. */
export function daemonToken(): string {
  const file = paths.token()
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (t.length >= 32) return t
  }
  const t = randomBytes(32).toString('hex')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, t, { encoding: 'utf8', mode: 0o600 })
  return t
}
