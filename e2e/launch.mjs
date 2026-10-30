// Starts Chrome on a throwaway profile with the unpacked extension, pointed at the
// e2e bridge port. Branded Chrome 137+ ignores --load-extension, so the extension is
// loaded over the DevTools pipe (Extensions.loadUnpacked). Never touches the
// user's own profile: everything lives in a temp folder that is deleted afterwards.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

export function findChrome() {
  const exe = CANDIDATES.find(p => p && existsSync(p))
  if (!exe) throw new Error('Chrome not found: set CHROME_PATH')
  return exe
}

/** @returns {Promise<{ downloads: string, close: () => void, exited: Promise<number|null> }>} */
export async function launchChrome({ extPath, port, headless = true }) {
  const root = mkdtempSync(join(tmpdir(), 'tabgeist-e2e-'))
  const profile = join(root, 'profile'), downloads = join(root, 'downloads'), ext = join(root, 'extension')
  // A copy that talks to the test port from its first connect: the original would
  // first reach port 47900, which may be the user's own running Tabgeist.
  cpSync(extPath, ext, { recursive: true })
  const bg = join(ext, 'background.js')
  // Approvals raise system notifications; in a test run they would chime on the desktop every few seconds.
  const quiet = 'chrome.notifications.create = () => Promise.resolve("")\n'
  writeFileSync(bg, quiet + readFileSync(bg, 'utf8').replace(/const DEFAULT_PORT = \d+/, `const DEFAULT_PORT = ${port}`))
  const args = ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--window-size=1280,900']
  if (headless) args.push('--headless=new')
  const p = spawn(findChrome(), [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const toChrome = p.stdio[3], fromChrome = p.stdio[4]
  let buf = '', next = 1
  const waits = new Map()
  fromChrome.on('data', d => {
    buf += d.toString()
    for (let i; (i = buf.indexOf('\0')) >= 0;) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
      if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id) }
    }
  })
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => { waits.delete(id); reject(new Error(`${method} timed out`)) }, 15000)
    waits.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result) })
    toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
  })
  const exited = new Promise(r => p.on('exit', r))
  const close = () => { try { p.kill() } catch { /* gone */ } setTimeout(() => rmSync(root, { recursive: true, force: true }), 1500) }

  let extId
  try {
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true })
    await call('Extensions.loadUnpacked', { path: ext })
    // The worker starts a moment after loading; point it at the e2e bridge.
    let sw
    for (let i = 0; i < 40 && !sw; i++) {
      const { targetInfos } = await call('Target.getTargets')
      sw = targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/background.js'))
      if (!sw) await new Promise(r => setTimeout(r, 250))
    }
    if (!sw) throw new Error('the extension service worker did not start')
    extId = new URL(sw.url).host
    const { sessionId } = await call('Target.attachToTarget', { targetId: sw.targetId, flatten: true })
    await call('Runtime.evaluate', { expression: `chrome.storage.local.set({ port: ${port} })`, awaitPromise: true }, sessionId)
  } catch (e) {
    close()
    throw e
  }
  return { downloads, close, exited, extId, cdp: call }
}
