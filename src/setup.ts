import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BRAND } from './brand'
import { BROWSERS } from './sites/try'

/**
 * `tabgeist setup`: everything that can be done from here in one go, and safe
 * to run again (it is also how an update reaches the agents):
 *   the MCP server in Claude Code, Codex and Cursor (whichever are installed),
 *   the skills in their skills folders, the daemon, and the extension page.
 * Loading the unpacked extension and approving its code stay with the user.
 */

export interface SetupStep { what: string; done: 'added' | 'updated' | 'already' | 'skipped' | 'failed'; note?: string }

const sh = (cmd: string) => spawnSync(cmd, { shell: true, encoding: 'utf8', windowsHide: true })
const has = (bin: string) => sh(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`).status === 0

/** An agent CLI with `mcp get/add/remove` (Claude Code, Codex). */
function cliAgent(label: string, bin: string, scope: string, cli: string, dry: boolean): SetupStep {
  if (!has(bin)) return { what: `${label}: MCP server`, done: 'skipped', note: `${bin} not found` }
  const get = sh(`${bin} mcp get ${BRAND.slug}`)
  const current = get.status === 0 ? `${get.stdout}` : ''
  const want = cli.replace(/\\/g, '/')
  if (current && current.replace(/\\/g, '/').includes(want)) return { what: `${label}: MCP server`, done: 'already' }
  if (dry) return { what: `${label}: MCP server`, done: current ? 'updated' : 'added', note: 'dry run' }
  if (current) sh(`${bin} mcp remove ${scope} ${BRAND.slug}`)
  const add = sh(`${bin} mcp add ${scope} ${BRAND.slug} -- node "${cli}" mcp`)
  return add.status === 0
    ? { what: `${label}: MCP server`, done: current ? 'updated' : 'added' }
    : { what: `${label}: MCP server`, done: 'failed', note: (add.stderr || add.stdout).trim().split('\n')[0] }
}

/** Cursor reads ~/.cursor/mcp.json; only our own entry is touched. */
function cursor(cli: string, dry: boolean): SetupStep {
  const dir = join(homedir(), '.cursor'), file = join(dir, 'mcp.json')
  if (!existsSync(dir)) return { what: 'Cursor: MCP server', done: 'skipped', note: 'Cursor not found' }
  let j: { mcpServers?: Record<string, unknown> } = {}
  if (existsSync(file)) {
    try { j = JSON.parse(readFileSync(file, 'utf8')) } catch { return { what: 'Cursor: MCP server', done: 'failed', note: `${file} is not plain JSON; add it by hand` } }
  }
  const entry = { command: 'node', args: [cli, 'mcp'] }
  const before = j.mcpServers?.[BRAND.slug]
  if (JSON.stringify(before) === JSON.stringify(entry)) return { what: 'Cursor: MCP server', done: 'already' }
  if (!dry) writeFileSync(file, JSON.stringify({ ...j, mcpServers: { ...j.mcpServers, [BRAND.slug]: entry } }, null, 2) + '\n', 'utf8')
  return { what: 'Cursor: MCP server', done: before ? 'updated' : 'added', ...(dry ? { note: 'dry run' } : {}) }
}

/** Copies skills/<name> into each agent's skills folder (Claude Code, Codex) that exists. */
function skills(from: string, dry: boolean): SetupStep[] {
  const names = existsSync(from) ? readdirSync(from).filter(n => existsSync(join(from, n, 'SKILL.md'))) : []
  const homes: [string, string][] = [['Claude Code', join(homedir(), '.claude')], ['Codex', join(homedir(), '.codex')]]
  return homes.map(([label, home]) => {
    if (!existsSync(home)) return { what: `${label}: skills`, done: 'skipped', note: `${home} not found` }
    const dest = join(home, 'skills')
    const fresh = names.filter(n => !existsSync(join(dest, n)))
    if (!dry) { mkdirSync(dest, { recursive: true }); for (const n of names) cpSync(join(from, n), join(dest, n), { recursive: true, force: true }) }
    return { what: `${label}: skills ${names.join(', ')}`, done: fresh.length === names.length ? 'added' : 'updated', ...(dry ? { note: 'dry run' } : {}) }
  })
}

/** The extension folder goes on the clipboard and the browser's extensions page opens. */
function extensionPage(extDir: string, dry: boolean): SetupStep {
  const exe = BROWSERS.find(p => p && existsSync(p))
  if (dry) return { what: 'Extension page', done: 'skipped', note: 'dry run' }
  if (process.platform === 'win32') spawnSync('clip', { input: extDir, shell: true, windowsHide: true })
  if (!exe) return { what: 'Extension page', done: 'skipped', note: 'no Chrome or Edge found' }
  const page = /msedge/i.test(exe) ? 'edge://extensions' : 'chrome://extensions'
  spawn(exe, [page], { detached: true, stdio: 'ignore' }).unref()
  return { what: `Extension page (${page})`, done: 'added' }
}

/** `linked`: a browser with the extension is already linked, so its page is not opened again. */
export function setup(o: { cli: string; root: string; dry: boolean; linked?: boolean }): SetupStep[] {
  return [
    cliAgent('Claude Code', 'claude', '-s user', o.cli, o.dry),
    cliAgent('Codex', 'codex', '', o.cli, o.dry),
    cursor(o.cli, o.dry),
    ...skills(join(o.root, 'skills'), o.dry),
    o.linked ? { what: 'Extension (a browser is linked)', done: 'already' } : extensionPage(join(o.root, 'extension'), o.dry),
  ]
}
