import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * The learning tools: routines (what worked once, replayed without a model,
 * API-first, healed when the site changes), site notes and heal tickets.
 * Each forwards to one daemon method.
 */

type Call = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

function text(value: unknown) {
  const failed = !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(failed ? { isError: true } : {}) }
}

const TAB = z.union([z.number().int(), z.string()]).describe('Tab id from browser_tabs, or part of its url or title.')
const BROWSER = z.string().optional().describe('Which connected browser profile. Omit when only one is connected.')

export function registerMoreTools(server: McpServer, call: Call): void {
  server.registerTool('routine_save', {
    description: 'Save what you just did in a tab (the browser_act steps that worked) as a routine, so it runs again later without you deciding each click: routine_run replays it, first through the site\'s own API when one was seen, else by finding each element again (even after small page changes). Turn values that change between runs into params: {"Ali Raza": "name"} makes the typed text "Ali Raza" a {{name}} param. Add expect so a run proves it worked.',
    inputSchema: {
      tab: TAB,
      browser: BROWSER,
      name: z.string().regex(/^[\w.-]{1,60}$/).describe('Short name: letters, digits, dot, dash, underscore (e.g. invoices.unpaid).'),
      description: z.string().max(300).optional().describe('What the routine does, in one sentence.'),
      last: z.number().int().min(1).max(50).optional().describe('Only the last N steps (default: every step since you opened or reached this page).'),
      params: z.record(z.string(), z.string()).optional().describe('Typed text to turn into params: { "the literal text": "paramName" }.'),
      expect: z.array(z.object({ text: z.string().optional(), url: z.string().optional(), gone: z.string().optional() })).max(5).optional().describe('What must be true after a run: text on the page, a url part, or text that must be gone.'),
      start: z.string().optional().describe('Path to open first (e.g. /invoices). Default: the page where the steps started.'),
    },
    annotations: { openWorldHint: false },
  }, async (args) => text(await call('routine.save', args)))

  server.registerTool('routine_list', {
    description: 'Routines saved for a site (or all sites): name, params, steps, health (last runs, broken or not).',
    inputSchema: { site: z.string().optional().describe('example.com; omit for all sites.') },
    annotations: { readOnlyHint: true },
  }, async (args) => text(await call('routine.list', args)))

  server.registerTool('routine_run', {
    description: 'Run a saved routine in a tab (opens one when no tab is given). Risky steps still wait for the user\'s click. shadow: true is a dry run: nothing is sent or saved on the site (writes are blocked, risky steps skipped) and the result says what would have happened. The result has the data API steps fetched, which steps healed themselves, and whether every expect held. A step that cannot be found opens a heal ticket: see heal_list.',
    inputSchema: {
      name: z.string().describe('Routine name, or site/name.'),
      tab: TAB.optional(),
      browser: BROWSER,
      vars: z.record(z.string(), z.string()).optional().describe('Values for the routine\'s params.'),
      shadow: z.boolean().optional().describe('Dry run: block every write, skip risky steps, report what would have happened.'),
    },
    annotations: { openWorldHint: true },
  }, async (args) => text(await call('routine.run', args)))

  server.registerTool('site_notes', {
    description: 'What was learned about a site before you: notes from earlier agents, its routines and their health, and the user\'s rules for it (what is blocked or always asks). Read it before working on a site you have not seen in this session.',
    inputSchema: { site: z.string().describe('example.com, or a url.') },
    annotations: { readOnlyHint: true },
  }, async (args) => text(await call('site.notes', args)))

  server.registerTool('site_note', {
    description: 'Add one short lesson about a site for the next agent (and you, next time): where something is, what to avoid, how long it takes. Not for personal data.',
    inputSchema: { site: z.string().describe('example.com, or a url.'), note: z.string().min(3).max(500) },
    annotations: { openWorldHint: false },
  }, async (args) => text(await call('site.note', args)))

  server.registerTool('heal_list', {
    description: 'Routines that broke because a site changed, with what is known: the step that failed, what the page looks like now, the requests it made. Fix one with heal_propose.',
    inputSchema: { site: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async (args) => text(await call('heal.list', args)))

  server.registerTool('heal_propose', {
    description: 'Propose a fixed routine for a heal ticket: the new steps (same format as routine_list shows). It is dry-run (shadow) right away in a tab; if every expect holds, the user sees it in the control room and decides to replace the old version. You never replace it yourself.',
    inputSchema: {
      id: z.string().describe('Heal ticket id from heal_list.'),
      routine: z.string().describe('The whole fixed routine as YAML (same shape as before, with the broken steps changed).'),
      note: z.string().max(300).optional().describe('What changed on the site and what you fixed.'),
      tab: TAB.optional(),
      browser: BROWSER,
    },
    annotations: { openWorldHint: true },
  }, async (args) => text(await call('heal.propose', args)))

  server.registerTool('open_control_room', {
    description: 'Open the control room for the user (in their browser): live view, approvals, timeline, sites, routines, heal queue. Use when the user asks to see what agents did or to manage routines.',
    inputSchema: {},
    annotations: { openWorldHint: false },
  }, async () => text(await call('room.open', {})))
}
