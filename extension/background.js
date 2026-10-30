// The extension: links this browser profile to the daemon on this computer.
// The daemon sends requests (tabs, CDP commands); this worker runs them with the
// chrome.* APIs and sends back results and events. Nothing leaves the machine:
// the only connection is ws://127.0.0.1. A new browser shows a 6-digit code the
// user approves in the control room; after that it keeps a pair token.

const BRAND = 'Tabgeist'
const GROUP_TITLE = BRAND
const DEFAULT_PORT = 47900
const LOG_MAX = 200

// The only DevTools commands the daemon may send through this extension: what the
// engine needs to read and act on a page, nothing that reads cookies or storage,
// changes the browser or touches other profiles.
const CDP_ALLOWED = new Set([
  'Accessibility.enable', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree',
  'DOM.describeNode', 'DOM.enable', 'DOM.focus', 'DOM.getBoxModel', 'DOM.getDocument', 'DOM.getFrameOwner', 'DOM.querySelectorAll', 'DOM.resolveNode', 'DOM.scrollIntoViewIfNeeded', 'DOM.setFileInputFiles',
  'DOMSnapshot.captureSnapshot',
  'Fetch.continueRequest', 'Fetch.disable', 'Fetch.enable', 'Fetch.failRequest',
  'IO.close', 'IO.read',
  'Input.dispatchDragEvent', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Input.insertText', 'Input.setInterceptDrags',
  'Network.enable', 'Network.getResponseBody', 'Network.loadNetworkResource',
  'Overlay.enable', 'Overlay.hideHighlight', 'Overlay.highlightNode',
  'Page.captureScreenshot', 'Page.enable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.handleJavaScriptDialog', 'Page.setInterceptFileChooserDialog',
  'Runtime.callFunctionOn', 'Runtime.evaluate',
  'Target.attachToTarget', 'Target.detachFromTarget', 'Target.getTargets', 'Target.setAutoAttach',
])

const state = {
  connected: false,
  paired: false,
  /** A 6-digit code while this browser waits for the user's approval; 'denied' after a no. */
  pairing: null,
  profile: 'default',
  log: [],
  approvals: [],
  questions: [],
  busy: new Set(),
}

let ws = null
let backoff = 1000
let retryTimer = null
const attached = new Set()

// ── Connection ────────────────────────────────────────────────────────────────

function browserName() {
  const brands = navigator.userAgentData?.brands?.map(b => b.brand) ?? []
  return brands.some(b => /edge/i.test(b)) ? 'Edge' : brands.some(b => /brave/i.test(b)) ? 'Brave' : 'Chrome'
}

/** This profile's name in the daemon: chosen by the user in the side panel, else "Chrome 4f2a". */
async function profileName() {
  const { profileLabel } = await chrome.storage.local.get('profileLabel')
  if (profileLabel) return profileLabel
  const label = `${browserName()} ${crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0')}`
  await chrome.storage.local.set({ profileLabel: label })
  return label
}

// Set before the first await: the worker starts connect() from several places at
// once (startup, install, the alarm), and two sockets must never both say hello.
let connecting = false

async function connect() {
  if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return
  connecting = true
  clearTimeout(retryTimer)
  let sock
  try {
    const { port } = await chrome.storage.local.get('port')
    sock = new WebSocket(`ws://127.0.0.1:${port || DEFAULT_PORT}/extension`)
  } finally { connecting = false }
  ws = sock
  sock.onopen = async () => {
    // Replaced while opening (a new port, a reconnect): this one is not ours any more.
    if (ws !== sock) { sock.close(); return }
    backoff = 1000
    state.profile = await profileName()
    const { pairToken } = await chrome.storage.local.get('pairToken')
    sock.send(JSON.stringify({ type: 'hello', profile: state.profile, browser: browserName(), version: chrome.runtime.getManifest().version, pairToken: pairToken || undefined }))
    state.connected = true
    changed()
  }
  sock.onmessage = e => {
    if (ws !== sock) return
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (typeof msg.id === 'number' && msg.method) void answer(sock, msg)
    else if (msg.event) onEvent(msg)
  }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    state.connected = false
    state.paired = false
    state.busy.clear()
    for (const tabId of attached) chrome.debugger.detach({ tabId }).catch(() => {})
    attached.clear()
    changed()
    retryTimer = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 30_000)
  }
  sock.onerror = () => { /* onclose follows */ }
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// A service worker sleeps after 30 s idle; the alarm wakes it to reconnect, the
// ping keeps an open socket (and the worker) alive.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== 'keepalive') return
  if (ws?.readyState === WebSocket.OPEN) send({ type: 'ping' })
  else void connect()
})
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  void connect()
})
void connect()

// ── Requests from the daemon ─────────────────────────────────────────────────

// The reply goes back on the socket the request came in on: the daemon matches it by id there.
async function answer(sock, msg) {
  let reply
  try {
    reply = { id: msg.id, ok: true, result: await handle(msg.method, msg.params ?? {}) }
  } catch (e) {
    reply = { id: msg.id, ok: false, error: e?.message ?? String(e) }
  }
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply))
}

async function agentGroupIds() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE })
  const working = await chrome.tabGroups.query({ title: `${GROUP_TITLE} · working` })
  return new Set([...groups, ...working].map(g => g.id))
}

function info(tab, agentGroups) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    status: tab.status,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    discarded: tab.discarded,
    agent: agentGroups.has(tab.groupId),
    busy: state.busy.has(tab.id),
  }
}

function waitComplete(tabId, ms = 20_000) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); clearInterval(poll); chrome.tabs.onUpdated.removeListener(on); resolve() }
    const on = (id, change) => { if (id === tabId && change.status === 'complete') done() }
    const t = setTimeout(done, ms)
    // Apps like Gmail stay "loading" for a long time in a background tab though they are usable:
    // after a few seconds a real title is enough (the tab's status still says loading).
    const start = Date.now()
    const poll = setInterval(() => {
      if (Date.now() - start < 5000) return
      chrome.tabs.get(tabId).then(tab => { if (tab.title && tab.title !== tab.url && !tab.url.includes(tab.title)) done() }, done)
    }, 1000)
    chrome.tabs.onUpdated.addListener(on)
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') done() }, done)
  })
}

async function tabInfo(tabId) {
  return info(await chrome.tabs.get(tabId), await agentGroupIds())
}

async function openTab(url, active, room) {
  let win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
  if (!win) win = await chrome.windows.create({ focused: false, state: 'minimized' })
  // The control room is the user's own tab, not the agent's: no group, in front.
  if (room) {
    const tab = await chrome.tabs.create({ url, active: true, windowId: win.id })
    await chrome.windows.update(win.id, { focused: true }).catch(() => {})
    return info(tab, new Set())
  }
  const tab = await chrome.tabs.create({ url, active: !!active, windowId: win.id })
  // Agent tabs live in one group per window, are never discarded, and stay
  // muted: focus emulation makes sites like YouTube autoplay with sound.
  await chrome.tabs.update(tab.id, { muted: true }).catch(() => {})
  const groups = await agentGroupIds()
  const [group] = (await chrome.tabGroups.query({ windowId: win.id })).filter(g => groups.has(g.id))
  if (group) await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id })
  else {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: win.id } })
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'orange', collapsed: false })
  }
  await chrome.tabs.update(tab.id, { autoDiscardable: false })
  await waitComplete(tab.id)
  return tabInfo(tab.id)
}

async function handle(method, p) {
  if (!state.paired) throw new Error('this browser is not paired yet')
  switch (method) {
    case 'tabs.list': {
      const groups = await agentGroupIds()
      return (await chrome.tabs.query({})).map(t => info(t, groups))
    }
    case 'tabs.open': return openTab(p.url, p.active, p.room === true)
    case 'tabs.navigate': {
      if (p.url) await chrome.tabs.update(p.tabId, { url: p.url })
      else if (p.go === 'back') await chrome.tabs.goBack(p.tabId)
      else if (p.go === 'forward') await chrome.tabs.goForward(p.tabId)
      else await chrome.tabs.reload(p.tabId)
      await new Promise(r => setTimeout(r, 300))
      await waitComplete(p.tabId)
      return tabInfo(p.tabId)
    }
    case 'tabs.close': {
      const tab = await chrome.tabs.get(p.tabId)
      if (!(await agentGroupIds()).has(tab.groupId)) throw new Error(`only tabs the agent opened (the ${GROUP_TITLE} tab group) can be closed by the agent`)
      await chrome.tabs.remove(p.tabId)
      return {}
    }
    case 'cdp.attach': {
      if (!attached.has(p.tabId)) {
        await chrome.debugger.attach({ tabId: p.tabId }, '1.3')
        attached.add(p.tabId)
      }
      // A tab in the background or a minimised window still acts as focused and is not discarded.
      await chrome.debugger.sendCommand({ tabId: p.tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      await chrome.tabs.update(p.tabId, { autoDiscardable: false }).catch(() => {})
      return {}
    }
    case 'cdp.detach': {
      if (attached.delete(p.tabId)) await chrome.debugger.detach({ tabId: p.tabId }).catch(() => {})
      return {}
    }
    case 'downloads.since': {
      // Files the page started (a Download button, an invoice link) since the action began.
      const items = await chrome.downloads.search({ startedAfter: new Date(p.since).toISOString(), orderBy: ['startTime'] })
      return items.map(d => ({ file: d.filename, url: d.finalUrl || d.url, state: d.state, bytes: d.bytesReceived, mime: d.mime }))
    }
    case 'cdp.send': {
      if (!CDP_ALLOWED.has(p.method)) throw new Error(`${p.method} is not allowed through this extension`)
      const target = p.sessionId ? { tabId: p.tabId, sessionId: p.sessionId } : { tabId: p.tabId }
      return chrome.debugger.sendCommand(target, p.method, p.params)
    }
    default: throw new Error(`unknown method ${method}`)
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || !attached.has(source.tabId)) return
  send({ event: 'cdp', tabId: source.tabId, sessionId: source.sessionId, method, params })
})
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return
  attached.delete(source.tabId)
  send({ event: 'cdpDetached', tabId: source.tabId })
})
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!('status' in change || 'url' in change || 'title' in change)) return
  send({ event: 'tab', tab: info(tab, await agentGroupIds()) })
  // A page that navigated loses the overlay; put it back while the agent works there.
  if (change.status === 'complete' && state.busy.has(tabId)) void glow(tabId, true)
})
chrome.tabs.onRemoved.addListener(tabId => {
  attached.delete(tabId)
  state.busy.delete(tabId)
  send({ event: 'tabRemoved', tabId })
})

// ── Events from the daemon ───────────────────────────────────────────────────

function onEvent(msg) {
  switch (msg.event) {
    case 'pairing':
      state.pairing = msg.code
      state.paired = false
      break
    case 'paired':
      void chrome.storage.local.set({ pairToken: msg.pairToken })
      state.pairing = null
      break
    case 'pairingDenied':
      void chrome.storage.local.remove('pairToken')
      state.pairing = 'denied'
      break
    case 'welcome':
      state.paired = true
      state.pairing = null
      state.log = msg.log ?? []
      state.approvals = msg.approvals ?? []
      state.questions = msg.questions ?? []
      for (const a of state.approvals) notifyApproval(a)
      for (const q of state.questions) notifyQuestion(q)
      break
    case 'ask':
      state.questions.push(msg)
      notifyQuestion(msg)
      break
    case 'askDone':
      state.questions = state.questions.filter(q => q.askId !== msg.askId)
      chrome.notifications.clear(`ask:${msg.askId}`).catch(() => {})
      break
    case 'activity':
      state.log.push(msg.line)
      if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX)
      break
    case 'busy':
      if (msg.busy) state.busy.add(msg.tabId)
      else state.busy.delete(msg.tabId)
      void glow(msg.tabId, msg.busy)
      void groupTitle()
      break
    case 'approval':
      state.approvals.push(msg)
      notifyApproval(msg)
      break
    case 'approvalDone':
      state.approvals = state.approvals.filter(a => a.approvalId !== msg.approvalId)
      chrome.notifications.clear(`approval:${msg.approvalId}`).catch(() => {})
      break
    default: return
  }
  changed()
}

async function groupTitle() {
  const working = state.busy.size > 0
  for (const id of await agentGroupIds()) {
    await chrome.tabGroups.update(id, { title: working ? `${GROUP_TITLE} · working` : GROUP_TITLE }).catch(() => {})
  }
}

// The agent's tab glows and shows a small chip while it works. Hidden from the
// page's accessibility tree (aria-hidden) and from the mouse (pointer-events: none).
const glowTimers = new Map()
async function glow(tabId, on) {
  clearTimeout(glowTimers.get(tabId))
  if (!on) {
    // Short linger so a burst of steps does not flicker.
    glowTimers.set(tabId, setTimeout(() => void paint(tabId, false), 1500))
    return
  }
  await paint(tabId, true)
}

async function paint(tabId, on) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [on, BRAND],
    func: (show, brand) => {
      const ID = '__bas_agent_glow'
      let host = document.getElementById(ID)
      if (!show) { host?.remove(); return }
      if (host) return
      host = document.createElement('div')
      host.id = ID
      host.setAttribute('aria-hidden', 'true')
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
      const root = host.attachShadow({ mode: 'closed' })
      root.innerHTML = `<style>
        .edge{position:fixed;inset:0;border-radius:6px;box-shadow:inset 0 0 0 2px rgba(245,165,36,.85),inset 0 0 28px rgba(245,165,36,.3);animation:pulse 2.4s ease-in-out infinite}
        .chip{position:fixed;top:10px;right:12px;display:flex;align-items:center;gap:7px;padding:5px 11px 5px 9px;border-radius:999px;background:#0e1116;color:#fde7b0;font:600 12px/1.2 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);border:1px solid rgba(245,165,36,.35)}
        .dot{width:8px;height:8px;border-radius:50%;background:#f5a524;animation:blink 1s ease-in-out infinite}
        @keyframes pulse{50%{box-shadow:inset 0 0 0 2px rgba(245,165,36,.5),inset 0 0 40px rgba(245,165,36,.18)}}
        @keyframes blink{50%{opacity:.35}}
        @media (prefers-reduced-motion:reduce){.edge,.dot{animation:none}}
      </style><div class="edge"></div><div class="chip"><span class="dot"></span>${brand} agent working</div>`
      document.documentElement.appendChild(host)
    },
  }).catch(() => { /* chrome:// pages, the Web Store and PDFs cannot be scripted */ })
}

// ── Questions (one-time codes, PINs, choices only the user can give) ─────────

function notifyQuestion(q) {
  chrome.notifications.create(`ask:${q.askId}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${BRAND} needs you`,
    message: `${q.question}\nOpen the ${BRAND} side panel (toolbar icon) to answer.`.slice(0, 300),
    requireInteraction: true,
    priority: 2,
  }).catch(() => {})
}

function answerQuestion(askId, reply) {
  send({ event: 'answer', askId, ...reply })
  state.questions = state.questions.filter(q => q.askId !== askId)
  chrome.notifications.clear(`ask:${askId}`).catch(() => {})
  changed()
}

// ── Approvals ─────────────────────────────────────────────────────────────────

function notifyApproval(a) {
  chrome.notifications.create(`approval:${a.approvalId}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${BRAND} asks: allow this?`,
    message: `${a.title}${a.site ? ` on ${a.site}` : ''}${a.detail ? `\n${a.detail}` : ''}`.slice(0, 300),
    buttons: [{ title: 'Allow once' }, { title: 'Deny' }],
    requireInteraction: true,
    priority: 2,
  }).catch(() => {})
}

function answerApproval(approvalId, allow, grant) {
  send({ event: 'approval', approvalId, allow, grant: allow && grant === 'site' ? 'site' : 'once' })
  state.approvals = state.approvals.filter(a => a.approvalId !== approvalId)
  chrome.notifications.clear(`approval:${approvalId}`).catch(() => {})
  changed()
}

chrome.notifications.onButtonClicked.addListener((id, button) => {
  if (id.startsWith('approval:')) answerApproval(id.slice(9), button === 0, 'once')
})
chrome.notifications.onClicked.addListener(id => {
  if (!id.startsWith('ask:')) return
  const q = state.questions.find(x => `ask:${x.askId}` === id)
  if (q?.tabId != null) chrome.tabs.update(q.tabId, { active: true }).then(t => chrome.windows.update(t.windowId, { focused: true })).catch(() => {})
})
chrome.notifications.onClosed.addListener((id, byUser) => {
  if (byUser && id.startsWith('approval:')) answerApproval(id.slice(9), false)
})

// ── Side panel ────────────────────────────────────────────────────────────────

function changed() {
  const n = state.approvals.length + state.questions.length
  const badge = n ? String(n) : state.pairing && state.pairing !== 'denied' ? '•' : state.connected && state.paired ? '' : '!'
  chrome.action.setBadgeText({ text: badge }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: n || state.pairing ? '#f5a524' : '#5b6472' }).catch(() => {})
  chrome.runtime.sendMessage({ type: 'bas:update' }).catch(() => { /* panel closed */ })
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'bas:state') {
    void (async () => {
      const groups = await agentGroupIds()
      const tabs = (await chrome.tabs.query({})).filter(t => groups.has(t.groupId) || state.busy.has(t.id)).map(t => info(t, groups))
      const { port } = await chrome.storage.local.get('port')
      reply({ brand: BRAND, connected: state.connected, paired: state.paired, pairing: state.pairing, profile: state.profile, log: state.log.slice(-80), approvals: state.approvals, questions: state.questions, tabs, port: port || DEFAULT_PORT })
    })()
    return true
  }
  if (msg?.type === 'bas:answer') answerApproval(msg.approvalId, msg.allow === true, msg.grant)
  if (msg?.type === 'bas:reply') answerQuestion(msg.askId, { text: msg.text, done: msg.done === true, skipped: msg.skipped === true })
  if (msg?.type === 'bas:room') send({ event: 'openRoom' })
  if (msg?.type === 'bas:focus') {
    chrome.tabs.update(msg.tabId, { active: true }).then(t => chrome.windows.update(t.windowId, { focused: true })).catch(() => {})
  }
  if (msg?.type === 'bas:port') {
    // Reconnect even when the port did not change (storage.onChanged would not fire).
    void chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT }).then(reconnect)
  }
  if (msg?.type === 'bas:label' && typeof msg.label === 'string' && msg.label.trim()) {
    // A new name is a new profile for the daemon: pair it again under that name.
    void chrome.storage.local.set({ profileLabel: msg.label.trim().slice(0, 40) }).then(reconnect)
  }
  return false
})

// A new port (side panel, or set by a setup tool) reconnects right away.
chrome.storage.onChanged.addListener((change, area) => {
  if (area === 'local' && 'port' in change) reconnect()
})

function reconnect() {
  const old = ws
  ws = null
  old?.close()
  state.connected = false
  state.paired = false
  backoff = 1000
  changed()
  void connect()
}
