import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'tabgeist-setup-'))
vi.mock('node:os', async orig => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home }))
// No agent CLIs on this "machine", and nothing is spawned.
vi.mock('node:child_process', async orig => ({ ...(await orig<typeof import('node:child_process')>()), spawnSync: () => ({ status: 1, stdout: '', stderr: '' }), spawn: () => ({ unref() {} }) }))

const { setup } = await import('./setup')
const root = join(import.meta.dirname, '..')

describe('setup', () => {
  it('adds itself to Cursor without touching other servers, copies the skills, and is safe to run again', () => {
    mkdirSync(join(home, '.cursor'))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    const first = setup({ cli: 'C:/t/dist/cli.mjs', root, dry: false })
    expect(first.map(s => [s.what.split(':')[0], s.done])).toEqual([
      ['Claude Code', 'skipped'], ['Codex', 'skipped'], ['Cursor', 'added'], ['Claude Code', 'added'], ['Codex', 'skipped'], [expect.stringMatching(/^Extension/), expect.any(String)],
    ])
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers).toEqual({ other: { command: 'x' }, tabgeist: { command: 'node', args: ['C:/t/dist/cli.mjs', 'mcp'] } })
    expect(readFileSync(join(home, '.claude', 'skills', 'tabgeist-pack', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: tabgeist-pack/)
    const again = setup({ cli: 'C:/t/dist/cli.mjs', root, dry: false })
    expect(again.find(s => s.what.startsWith('Cursor'))?.done).toBe('already')
    expect(again.find(s => s.what.startsWith('Claude Code: skills'))?.done).toBe('updated')
  })

  it('leaves a Cursor file it cannot parse alone', () => {
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ // a comment\n}')
    expect(setup({ cli: 'C:/t/dist/cli.mjs', root, dry: false }).find(s => s.what.startsWith('Cursor'))).toMatchObject({ done: 'failed', note: expect.stringMatching(/by hand/) })
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{ // a comment\n}')
  })

  it('does not send a linked browser to the extensions page again', () => {
    expect(setup({ cli: 'C:/t/dist/cli.mjs', root, dry: false, linked: true }).at(-1)).toMatchObject({ what: expect.stringMatching(/^Extension/), done: 'already' })
  })
})
