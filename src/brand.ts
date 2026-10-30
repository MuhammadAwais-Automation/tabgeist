import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The product's name in one place (Tabgeist, chosen 2026-10-30). Renaming again
 * means scripts/rename.mjs: this file, the extension's manifest/strings and package.json.
 */
export const BRAND = {
  /** Shown to people: side panel, control room, approval cards. */
  name: 'Tabgeist',
  long: 'AI agents in your own browser',
  /** CLI command, MCP server name, folder under the home directory. */
  slug: 'tabgeist',
  /** Prefix of environment variables. */
  env: 'TABGEIST',
  /** The extension's tab group title. */
  group: 'Tabgeist',
  version: '0.1.0',
} as const

export const DEFAULT_PORT = 47900

/** Everything the system keeps on this computer: routines, timeline, pairing, settings. */
export function homeDir(): string {
  return process.env[`${BRAND.env}_HOME`] || join(homedir(), `.${BRAND.slug}`)
}

export function envVar(name: string): string | undefined {
  return process.env[`${BRAND.env}_${name}`]
}
