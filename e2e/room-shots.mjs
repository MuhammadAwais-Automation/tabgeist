// Pictures of the control room with real data, for design review: a throwaway
// daemon and headless Chrome (never the user's), a few agent steps on the
// fixture site, one Send left waiting for approval, then every page at desktop
// and phone width, night and day. Run: node e2e/room-shots.mjs  →  e2e/out/room/*.png
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChrome } from './launch.mjs'
import { startSite } from './site.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out', 'room')
mkdirSync(out, { recursive: true })
const port = 47996
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'tabgeist-room-shots-'))
const home = join(tmp, 'home')

execFileSync(process.execPath, [join(here, '..', 'scripts', 'build.mjs')], { stdio: 'ignore' })
const stub = { name: 'no-electron', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}', loader: 'js' })) } }
await build({ entryPoints: [join(here, 'bridge.ts')], outfile: join(here, 'out', 'bridge.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [stub], logLevel: 'error' })
const bridge = spawn(process.execPath, [join(here, 'out', 'bridge.mjs')], {
  env: { ...process.env, TABGEIST_PORT: String(port), TABGEIST_HOME: home, TABGEIST_DOWNLOADS: join(tmp, 'downloads'), TABGEIST_UI_DIR: join(here, '..', 'dist', 'ui') },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error(`bridge exited ${c}`))) })
const { server, port: sitePort } = await startSite()
const site = `http://127.0.0.1:${sitePort}`
const token = readFileSync(join(home, 'token'), 'utf8').trim()
const rpc = async (method, params = {}, agent = 'claude-code') => (await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, agent, session: `${agent}-shots`, from: 'test' }) })).json()
const chrome = await launchChrome({ extPath: resolve(here, '..', 'extension'), port, headless: true })
const quit = () => { chrome.close(); bridge.kill(); server.close() }
process.on('exit', quit)
for (let i = 0; i < 60 && !(await rpc('browser.status')).connected; i++) await sleep(500)

const ref = (text, role, name) => [...text.matchAll(/^\[(e\d+)\] (\S+) "(.*?)"/gm)].find(m => m[2] === role && m[3].includes(name))?.[1]

try {
  // Some real work, so every page has something to show.
  const form = (await rpc('browser.open', { url: `${site}/form` })).tab.id
  const s1 = (await rpc('browser.snapshot', { tab: form })).text
  const box = [...s1.matchAll(/^\[(e\d+)\] textbox/gm)][0]?.[1]
  if (box) await rpc('browser.act', { tab: form, action: 'type', ref: box, text: 'Ayesha Khan' })
  await rpc('browser.read', { tab: form })
  await rpc('routine.save', { tab: form, name: 'fill-contact-form' })
  await rpc('site.note', { tab: form, note: 'The contact form needs the name first; the country list loads after a second.' })
  await rpc('browser.act', { tab: form, action: 'click', ref: 'e999' }, 'codex')
  const risky = (await rpc('browser.open', { url: `${site}/risky` })).tab.id
  const s2 = (await rpc('browser.snapshot', { tab: risky })).text
  await rpc('browser.act', { tab: risky, action: 'type', ref: ref(s2, 'textbox', 'Message'), text: 'Salam Hamza, the invoice is attached. Please check it today.' })
  // Left waiting: the Now page shows it as a signal.
  const pending = rpc('browser.act', { tab: risky, action: 'click', ref: ref(s2, 'button', 'Send') })
  await sleep(1500)

  const room = (await rpc('browser.open', { url: `${site}/` })).tab.id
  const { url } = await rpc('test.loginLink')
  await rpc('test.eval', { tab: room, expr: `location.href = ${JSON.stringify(url)}` })
  await sleep(2500)
  const shot = async (name, view, { width = 1280, height = 900, theme = 'night' } = {}) => {
    await rpc('test.cdp', { tab: room, method: 'Emulation.setDeviceMetricsOverride', params: { width, height, deviceScaleFactor: 1, mobile: width < 600 } })
    await rpc('test.eval', { tab: room, expr: `localStorage.setItem('bas-theme', ${JSON.stringify(theme)}); document.documentElement.dataset.theme = ${JSON.stringify(theme)}; location.hash = ${JSON.stringify(view)}; true` })
    await sleep(900)
    const r = await rpc('test.cdp', { tab: room, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false } })
    if (!r?.data) { console.error(name, r); return }
    writeFileSync(join(out, `${name}.png`), Buffer.from(r.data, 'base64'))
    console.log('saved', name)
  }
  for (const v of ['now', 'timeline', 'sites', 'heal', 'settings', 'packs', 'design']) await shot(`${v}-night`, v)
  for (const v of ['now', 'sites']) await shot(`${v}-day`, v, { theme: 'day' })
  // The side panel and the phone layout, through the test browser's own CDP pipe
  // (chrome.debugger may not touch extension pages or emulate a device).
  const page = async (url, width, height) => {
    const { targetId } = await chrome.cdp('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await chrome.cdp('Target.attachToTarget', { targetId, flatten: true })
    await chrome.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sessionId)
    await chrome.cdp('Page.navigate', { url }, sessionId)
    await sleep(2500)
    return async (name, theme, expr = '') => {
      await chrome.cdp('Runtime.evaluate', { expression: `localStorage.setItem('bas-theme', '${theme}'); document.documentElement.dataset.theme = '${theme}'; ${expr}; true` }, sessionId)
      await sleep(700)
      const r = await chrome.cdp('Page.captureScreenshot', { format: 'png' }, sessionId)
      writeFileSync(join(out, `${name}.png`), Buffer.from(r.data, 'base64'))
      console.log('saved', name)
    }
  }
  const side = await page(`chrome-extension://${chrome.extId}/sidepanel.html`, 380, 860)
  await side('sidepanel-night', 'night')
  await side('sidepanel-day', 'day')
  const phone = await page(`http://127.0.0.1:${port}/#now`, 390, 844)
  await phone('now-phone', 'night')
  await phone('now-phone-menu', 'night', 'scrollTo(0, 99999)')
  for (const a of await rpc('test.approvals')) await rpc('test.answer', { approvalId: a.approvalId, allow: false })
  await pending
} finally {
  quit()
  process.exit(0)
}
