import { randomBytes } from 'node:crypto'
import { sameSecret } from './home'

/**
 * Who may talk to the daemon.
 * - Everything checks Host: a page on evil.com that rebinds its DNS to
 *   127.0.0.1 still sends `Host: evil.com` and is refused.
 * - Agents (the MCP shim, the CLI) send the bearer token from ~/.tabgeist/token.
 * - The control room is a page in the browser: it gets a session cookie from a
 *   one-time login link the daemon opens itself, so the link is never printed
 *   where an agent reads it. Its writes must also come from its own origin.
 */

export function hostOk(host: string | undefined, port: number): boolean {
  if (!host) return false
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
}

export function originOk(origin: string | undefined, port: number): boolean {
  if (!origin) return false
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin.toLowerCase())
}

export function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  return !!m && sameSecret(m[1], token)
}

export const COOKIE = 'tabgeist_room'

export function cookieValue(header: string | undefined, name = COOKIE): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

const LINK_MS = 2 * 60_000

/** One-time login links and the sessions they open (memory only: a restart signs the room out). */
export class RoomAuth {
  private readonly links = new Map<string, number>()
  private readonly sessions = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  link(): string {
    const once = randomBytes(24).toString('hex')
    this.links.set(once, this.now() + LINK_MS)
    return once
  }

  /** Spends a login link; returns the new session id, or null. */
  redeem(once: string | null): string | null {
    if (!once) return null
    const until = this.links.get(once)
    this.links.delete(once)
    if (!until || until < this.now()) return null
    const session = randomBytes(24).toString('hex')
    this.sessions.add(session)
    return session
  }

  ok(cookieHeader: string | undefined): boolean {
    const v = cookieValue(cookieHeader)
    return !!v && this.sessions.has(v)
  }
}
