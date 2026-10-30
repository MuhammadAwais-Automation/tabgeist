// The end-to-end suite: fixture site + bridge + a throwaway Chrome with the extension.
//
//   node e2e/run.mjs                 one pass of the regular scenarios
//   node e2e/run.mjs --soak 20       20 passes (long run: flakiness, leaks, slowdowns)
//   node e2e/run.mjs --features      also the scenarios of features still being built
//   node e2e/run.mjs --only drag     scenarios whose name contains "drag"
//   node e2e/run.mjs --headed        show the browser
//   node e2e/run.mjs --bench         the README benchmarks (e2e/bench.mjs; needs the internet)
//
// Writes e2e/out/report-<time>.json and prints a summary; exit code 1 on any failure.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchChrome } from './launch.mjs'
import { SCENARIOS } from './scenarios.mjs'
import { CORE } from './scenarios-core.mjs'
import { BENCH } from './bench.mjs'
import { startSite } from './site.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const soak = Number(opt('soak') ?? 1)
const only = opt('only')
const port = Number(opt('port') ?? 47999)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })
const tmp = mkdtempSync(join(tmpdir(), 'tabgeist-e2e-files-'))
const home = join(tmp, 'home')
// The control room the daemon serves is the built one.
execFileSync(process.execPath, [join(here, '..', 'scripts', 'build.mjs')], { stdio: 'ignore' })

// The bridge is TypeScript from electron/chrome: bundle it once for plain node.
// Some modules on the import path also serve the Electron app; outside Electron they get an empty stand-in.
const ELECTRON_NAMES = ['app', 'session', 'shell', 'BrowserWindow', 'BrowserView', 'WebContentsView', 'webContents', 'ipcMain', 'dialog',
  'Notification', 'nativeImage', 'clipboard', 'screen', 'Menu', 'Tray', 'protocol', 'net', 'powerMonitor', 'powerSaveBlocker',
  'globalShortcut', 'systemPreferences', 'desktopCapturer', 'utilityProcess', 'MessageChannelMain', 'nativeTheme', 'safeStorage']
const noElectron = {
  name: 'no-electron',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: [...ELECTRON_NAMES.map(n => `export const ${n} = new Proxy(function () {}, { get: () => () => undefined })`), 'export default {}'].join(';'),
      loader: 'js',
    }))
  },
}
await build({ entryPoints: [join(here, 'bridge.ts')], outfile: join(outDir, 'bridge.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [noElectron], logLevel: 'error' })
const bridge = spawn(process.execPath, [join(outDir, 'bridge.mjs')], {
  env: { ...process.env, TABGEIST_PORT: String(port), TABGEIST_HOME: home, TABGEIST_DOWNLOADS: join(tmp, 'downloads'), TABGEIST_UI_DIR: join(here, '..', 'dist', 'ui') },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error(`bridge exited ${c}`))) })

const { server, port: sitePort } = await startSite()
const site = `http://127.0.0.1:${sitePort}`

const token = readFileSync(join(home, 'token'), 'utf8').trim()
async function rpc(method, params = {}, agent = 'e2e') {
  const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, agent, session: `${agent}-e2e`, from: agent === 'e2e' ? 'test' : 'agent' }) })
  return r.json()
}

const chrome = await launchChrome({ extPath: resolve(here, '..', 'extension'), port, headless: !flag('headed') })
// Whatever ends this run (Ctrl+C, a crash, a stop from outside) takes Chrome and the bridge with it.
const cleanup = () => { chrome.close(); bridge.kill() }
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130))
for (let i = 0; i < 60 && !(await rpc('browser.status')).connected; i++) await sleep(500)
if (!(await rpc('browser.status')).connected) { console.error('the extension did not connect'); chrome.close(); bridge.kill(); process.exit(1) }

class Failure extends Error {}

function helpers(opened, metrics) {
  const h = {
    site, tmp, home, port, token, rpc, sleep,
    ok(cond, msg) { if (!cond) throw new Failure(msg || 'assertion failed') },
    metric(name, v) { metrics[name] = v },
    async open(path) {
      const r = await rpc('browser.open', { url: site + path })
      h.ok(r.ok, `open ${path}: ${r.error}`)
      opened.push(r.tab.id)
      return r.tab.id
    },
    async snap(tab, extra = {}) {
      const r = await rpc('browser.snapshot', { tab, ...extra })
      h.ok(r.ok, `snapshot: ${r.error}`)
      return r.text
    },
    /** Refs of lines `[e12] role "name…"` whose name contains `name`. */
    refs(text, role, name) {
      return [...text.matchAll(/^\[(e\d+)\] (\S+) "(.*?)"/gm)].filter(m => m[2] === role && m[3].includes(name)).map(m => m[1])
    },
    ref(text, role, name) {
      const r = h.refs(text, role, name)[0]
      h.ok(r, `no ${role} "${name}" in the snapshot:\n${text.slice(0, 1500)}`)
      return r
    },
    /** chrome.act, answering every approval it raises with `policy`; returns the receipt and the approvals asked. */
    async act(tab, params, policy = 'deny') {
      const asked = [], answered = new Set()
      let done = false
      const watcher = (async () => {
        while (!done) {
          for (const a of await rpc('test.approvals')) {
            if (answered.has(a.approvalId)) continue
            answered.add(a.approvalId)
            asked.push(a.title)
            await rpc('test.answer', { approvalId: a.approvalId, allow: policy === 'allow' })
          }
          await sleep(100)
        }
      })()
      try { return { receipt: await rpc('browser.act', { tab, ...params }), asked } } finally { done = true; await watcher }
    },
    out: tab => rpc('test.eval', { tab, expr: "document.getElementById('out')?.textContent ?? ''" }),
    async untilOut(tab, test, ms = 6000) {
      let o = ''
      for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) { o = await h.out(tab); if (test(o)) return o }
      throw new Failure(`page said "${o}"`)
    },
    expectOut: (tab, want, ms) => h.untilOut(tab, o => o === want, ms).catch(e => { throw new Failure(`expected "${want}", ${e.message}`) }),
    rect: (tab, sel) => rpc('test.eval', { tab, expr: `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()` }),
  }
  return h
}

// --keep: start everything, run nothing, and stay up for poking at it by hand.
if (flag('keep')) {
  console.log(`kept: bridge http://127.0.0.1:${port}/  fixtures ${site}/  (Ctrl+C to stop)`)
  await new Promise(() => {})
}

const chosen = (flag('bench') ? BENCH : [...SCENARIOS, ...CORE]).filter(s => (flag('features') || !s.feature) && (!only || s.name.includes(only)))
const results = chosen.map(s => ({ name: s.name, feature: !!s.feature, pass: 0, fail: 0, ms: [], errors: [], metrics: {} }))
const started = Date.now()

for (let pass = 1; pass <= soak; pass++) {
  for (const [i, s] of chosen.entries()) {
    const res = results[i], opened = []
    const t0 = Date.now()
    try {
      await s.run(helpers(opened, res.metrics))
      res.pass++
    } catch (e) {
      res.fail++
      if (res.errors.length < 5) res.errors.push(`pass ${pass}: ${e instanceof Failure ? '' : 'CRASH '}${e.message}`)
    }
    res.ms.push(Date.now() - t0)
    for (const tab of opened) await rpc('browser.closeTab', { tab }).catch(() => {})
  }
  const failed = results.filter(r => r.fail).length
  console.log(`pass ${pass}/${soak}: ${chosen.length - failed} ok, ${failed} with failures so far (${Math.round((Date.now() - started) / 1000)} s)`)
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
console.log('\nscenario'.padEnd(78) + 'pass  fail   p50 ms   max ms')
for (const r of results) {
  console.log(`${r.feature ? '[feature] ' : ''}${r.name}`.slice(0, 76).padEnd(78) + `${String(r.pass).padStart(4)}  ${String(r.fail).padStart(4)}  ${String(pct(r.ms, 0.5)).padStart(7)}  ${String(Math.max(...r.ms)).padStart(7)}`)
  for (const e of r.errors) console.log(`    ✗ ${e.split('\n')[0].slice(0, 200)}`)
}
if (flag('bench')) for (const r of results) { console.log(`
${r.name}`); for (const [k, v] of Object.entries(r.metrics)) console.log(`  ${k.padEnd(12)} ${String(v.calls).padStart(2)} call(s)  ${String(v.chars).padStart(7)} chars (~${Math.round(v.chars / 4)} tokens)  ${String(v.ms).padStart(6)} ms${v.found && v.found !== '0/0' ? `  has ${v.found}` : ''}`) }
const report = { at: new Date().toISOString(), soak, seconds: Math.round((Date.now() - started) / 1000), results }
const file = join(outDir, `report-${report.at.replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify(report, null, 2))
console.log(`\nreport: ${file}`)

chrome.close(); bridge.kill(); server.close()
process.exit(results.some(r => r.fail && !r.feature) ? 1 : 0)
