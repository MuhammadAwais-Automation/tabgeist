import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { BRAND } from './brand'
import { DaemonClient } from './client'
import { paths, readJson } from './daemon/home'
import { siteName } from './sites/store'

const HELP = `${BRAND.name} — ${BRAND.long} ${BRAND.version}

  ${BRAND.slug} start [--port N] [--detach]   run the daemon (the extension, agents and the control room connect to it)
  ${BRAND.slug} stop                          stop the daemon
  ${BRAND.slug} status                        is it running, which browsers are linked
  ${BRAND.slug} open                          open the control room in your browser
  ${BRAND.slug} mcp                           MCP server on stdio, for your agent (starts the daemon when needed)
  ${BRAND.slug} setup [--dry-run] [--print]   add it to Claude Code, Codex and Cursor, install the skills, open the extension page
  ${BRAND.slug} update                        install the newest version and run setup again
  ${BRAND.slug} routines [site]               saved routines and their health
  ${BRAND.slug} run <name> [--shadow] [--var key=value ...]
  ${BRAND.slug} heal                          broken routines waiting for a fix
  ${BRAND.slug} pack [list]                   the site packs in use
  ${BRAND.slug} pack new <site> [folder]      start a pack for a site, with your routines for it
  ${BRAND.slug} pack add <folder|git URL> [--force]   install or update a pack
  ${BRAND.slug} pack try <folder> <url> [op] [json]   run a pack's adapter on a public page, in a throwaway browser
  ${BRAND.slug} call <method> [json]          any daemon method (for scripts)

Data lives in ${paths.home()}. Nothing listens beyond 127.0.0.1.`

const here = dirname(fileURLToPath(import.meta.url))
const cliFile = fileURLToPath(import.meta.url)

function print(v: unknown): void {
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  const client = new DaemonClient(undefined, 'cli')
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const err = await client.ensure(cliFile)
    if (err) { console.error(err); return { ok: false, error: err } }
    return client.call(method, params, { agent: 'cli', session: `cli-${process.pid}` })
  }

  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h':
      print(HELP)
      return 0

    case 'start': {
      const { values } = parseArgs({ args: rest, options: { port: { type: 'string' }, detach: { type: 'boolean' } } })
      if (values.port) process.env[`${BRAND.env}_PORT`] = values.port
      if (values.detach) {
        const c = new DaemonClient(values.port ? Number(values.port) : undefined, 'cli')
        const err = await c.ensure(cliFile)
        if (err) { console.error(err); return 1 }
        print(`${BRAND.name} is running on 127.0.0.1:${c.port}`)
        return 0
      }
      const { createDaemon } = await import('./main')
      const uiDir = join(here, 'ui')
      const d = await createDaemon({ uiDir: existsSync(uiDir) ? uiDir : undefined })
      console.error(`${BRAND.name} ${BRAND.version} on 127.0.0.1:${d.port} — data in ${paths.home()}`)
      const stop = () => { void d.close().then(() => process.exit(0)) }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      return -1
    }

    case 'stop': {
      const info = readJson<{ pid?: number }>(paths.daemon(), {})
      const h = await client.health()
      const pid = h?.pid ?? info.pid
      if (!pid || !h) { print(`${BRAND.name} is not running`); return 0 }
      try { process.kill(pid) } catch { /* already gone */ }
      print(`stopped ${BRAND.name} (pid ${pid})`)
      return 0
    }

    case 'status': {
      const h = await client.health()
      if (!h) { print(`${BRAND.name} is not running — "${BRAND.slug} start" (or any agent tool call starts it)`); return 1 }
      const s = await client.call('browser.status', {}, { agent: 'cli', session: `cli-${process.pid}` })
      print({ running: true, port: client.port, pid: h.pid, version: h.version, ...s })
      return 0
    }

    case 'open': {
      const r = await rpc('room.open')
      print(r.ok ? `opened the control room in your ${r.opened === 'browser' ? 'linked browser' : 'default browser'}` : r)
      return r.ok ? 0 : 1
    }

    case 'mcp': {
      const { runMcp } = await import('./mcp/stdio')
      await runMcp()
      return -1
    }

    case 'setup': {
      const { values } = parseArgs({ args: rest, options: { print: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } })
      const root = join(here, '..'), extDir = join(root, 'extension')
      const loadExt = [
        `Load the extension (once): on the page that opened, turn on Developer mode → Load unpacked → paste the folder`,
        `  ${extDir}`,
        `Then approve the browser's 6-digit code in the control room ("${BRAND.slug} open").`,
      ]
      if (values.print) {
        const cmdLine = `node "${cliFile}" mcp`
        print([
          `Add ${BRAND.name} to your agent (it starts the daemon by itself):`,
          '',
          `  Claude Code:  claude mcp add -s user ${BRAND.slug} -- ${cmdLine}`,
          `  Codex:        codex mcp add ${BRAND.slug} -- ${cmdLine}`,
          `  Cursor / others (mcp.json):`,
          JSON.stringify({ mcpServers: { [BRAND.slug]: { command: 'node', args: [cliFile, 'mcp'] } } }, null, 2).replace(/^/gm, '    '),
          `  Skills: copy ${join(root, 'skills')}/* into your agent's skills folder.`,
          '',
          ...loadExt,
        ].join('\n'))
        return 0
      }
      const { setup } = await import('./setup')
      const dry = !!values['dry-run']
      // A browser that is already linked has the extension: no extension page, no steps to show for it.
      const linked = !!(await client.health()) && (await client.call('browser.status', {}, { agent: 'cli', session: `cli-${process.pid}` })).connected === true
      const steps = setup({ cli: cliFile, root, dry, linked })
      const err = dry ? null : await client.ensure(cliFile)
      steps.push(err ? { what: 'Daemon', done: 'failed', note: err } : { what: `Daemon on 127.0.0.1:${client.port}`, done: dry ? 'skipped' : 'already' })
      if (!dry && !err && !linked) { const r = await client.call('room.open', {}, { agent: 'cli', session: `cli-${process.pid}` }); steps.push({ what: 'Control room', done: r.ok ? 'added' : 'failed', note: r.ok ? undefined : String(r.error) }) }
      const mark = { added: '+', updated: '~', already: '=', skipped: '-', failed: '!' } as const
      print([
        `${BRAND.name} setup${dry ? ' (dry run: nothing changed)' : ''}`,
        '',
        ...steps.map(s => `  ${mark[s.done]} ${s.what}${s.done === 'already' ? ' (already there)' : ''}${s.note ? ` — ${s.note}` : ''}`),
        '',
        ...(linked ? [] : [...loadExt, '(The folder path is on your clipboard.)']),
        'Restart your agent so it picks up the new tools and skills.',
      ].join('\n'))
      return steps.some(s => s.done === 'failed') ? 1 : 0
    }

    case 'update': {
      // npm replaces the files in place, so the extension keeps its folder and id; it only needs a reload.
      const r = spawnSync(`npm install -g ${BRAND.slug}@latest`, { shell: true, stdio: 'inherit' })
      if (r.status !== 0) return 1
      // The old daemon is stopped; setup starts the new one.
      const info = await client.health()
      if (info?.pid) { try { process.kill(info.pid) } catch { /* gone */ } }
      const again = spawnSync(`${BRAND.slug} setup`, { shell: true, stdio: 'inherit' })
      print('Updated. Reload the extension (the ↻ on its card in the extensions page) to finish.')
      return again.status ?? 0
    }

    case 'routines': {
      const r = await rpc('routine.list', rest[0] ? { site: rest[0] } : {})
      print(r)
      return r.ok === false ? 1 : 0
    }

    case 'run': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { shadow: { type: 'boolean' }, var: { type: 'string', multiple: true }, tab: { type: 'string' } } })
      if (!positionals[0]) { console.error(`usage: ${BRAND.slug} run <name> [--shadow] [--var key=value]`); return 2 }
      const vars = Object.fromEntries((values.var ?? []).map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)] }))
      const r = await rpc('routine.run', { name: positionals[0], vars, shadow: !!values.shadow, ...(values.tab ? { tab: values.tab } : {}) })
      print(r)
      return r.ok === false ? 1 : 0
    }

    case 'heal': {
      const r = await rpc('heal.list')
      print(r)
      return r.ok === false ? 1 : 0
    }

    case 'pack': {
      // Runs here, not in the daemon: installing code that runs in your pages is something you do, never an agent.
      const { PackStore } = await import('./sites/packs')
      const packs = new PackStore(paths.packs())
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { force: { type: 'boolean' } } })
      const [sub = 'list', folder] = positionals
      if (sub === 'list') {
        const list = packs.list()
        print(list.length ? list.map(p => `${p.name} ${p.version}  ${p.site}  (${p.from})\n  ${p.about}`).join('\n') : 'no packs')
        return 0
      }
      if (sub === 'new' && folder) {
        const { newPack } = await import('./sites/packs')
        let site = folder
        try { site = siteName(folder) } catch { /* newPack says what is wrong */ }
        const r = newPack(folder, positionals[2] ?? `tabgeist-pack-${site.split('.')[0]}`, paths.sites())
        if (!r.ok) { console.error(r.error); return 1 }
        print([
          `Started a pack in ${r.dir}`,
          r.routines.length ? `  with your routines for ${site}: ${r.routines.join(', ')} (read them first: they may hold your own values)` : `  (no saved routines for ${site} yet)`,
          '',
          `Write its ops in adapter.js (ask your agent: it has the tabgeist-pack skill), then:`,
          `  ${BRAND.slug} pack try ${r.dir} ${/^https?:/.test(folder) ? folder : `https://${folder}/`}   on a public page`,
          `  ${BRAND.slug} pack add ${r.dir}                    to use it yourself`,
          `To share it, put the folder on GitHub; others run "${BRAND.slug} pack add <its URL>".`,
        ].join('\n'))
        return 0
      }
      if (sub === 'add' && folder) {
        // A git URL is cloned to a temp folder first; installing is still a copy of plain files.
        const fromGit = /^(https:\/\/|git@)\S+$/.test(folder)
        let dir = folder
        if (fromGit) {
          dir = mkdtempSync(join(tmpdir(), `${BRAND.slug}-pack-`))
          // Never stop to ask for a password: a pack to share is a public repository.
          const g = spawnSync('git', ['clone', '--depth', '1', '--', folder, dir], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
          if (g.status !== 0) { console.error(`could not clone ${folder}: ${(g.stderr || g.error?.message || '').trim().split('\n').pop()}`); return 1 }
        }
        const r = packs.install(dir, !!values.force)
        if (fromGit) rmSync(dir, { recursive: true, force: true })
        if (!r.ok) { console.error(r.error); return 1 }
        print(`${r.replaced ? `updated ${r.pack.name} ${r.replaced} → ${r.pack.version}` : `installed ${r.pack.name} ${r.pack.version}`} for ${r.pack.site}, in ${r.pack.dir}`)
        if (existsSync(join(r.pack.dir, 'adapter.js'))) print(`Its adapter.js runs in your signed-in ${r.pack.site} pages. If someone else wrote it, read it: it should only read, and only from ${r.pack.site}.`)
        return 0
      }
      if (sub === 'try' && folder && positionals[2]) {
        const { tryPack } = await import('./sites/try')
        const r = await tryPack(folder, positionals[2], positionals[3] ?? null, positionals[4] ? JSON.parse(positionals[4]) as Record<string, unknown> : {})
        print(r.result)
        console.error(`\n${r.ok ? 'ok' : 'failed'} in ${r.ms} ms, ${JSON.stringify(r.result ?? null).length} characters`)
        return r.ok ? 0 : 1
      }
      console.error(`usage: ${BRAND.slug} pack [list] | pack new <site> [folder] | pack add <folder|git URL> [--force] | pack try <folder> <url> [op] [json]`)
      return 2
    }

    case 'call': {
      if (!rest[0]) { console.error(`usage: ${BRAND.slug} call <method> [json]`); return 2 }
      const r = await rpc(rest[0], rest[1] ? JSON.parse(rest[1]) as Record<string, unknown> : {})
      print(r)
      return r.ok === false ? 1 : 0
    }

    default:
      console.error(`unknown command "${cmd}"\n\n${HELP}`)
      return 2
  }
}

main(process.argv.slice(2)).then(code => { if (code >= 0) process.exit(code) }, e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
