// Side panel: linking this browser, what agents do here, and what waits for the user.

const $ = id => document.getElementById(id)

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag)
  Object.assign(n, props)
  for (const k of kids) if (k != null && k !== '') n.append(k)
  return n
}

const hhmm = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const msg = m => chrome.runtime.sendMessage(m)

function approvalCard(a) {
  const allow = el('button', { className: 'btn allow', type: 'button', textContent: 'Allow once' })
  const site = el('button', { className: 'btn', type: 'button', textContent: `Allow${a.site ? ` on ${a.site}` : ''} for 15 min`, title: 'The same kind of step on this site passes without asking for 15 minutes (at most 10 times)' })
  const deny = el('button', { className: 'btn deny', type: 'button', textContent: 'Deny' })
  allow.onclick = () => msg({ type: 'bas:answer', approvalId: a.approvalId, allow: true, grant: 'once' })
  site.onclick = () => msg({ type: 'bas:answer', approvalId: a.approvalId, allow: true, grant: 'site' })
  deny.onclick = () => msg({ type: 'bas:answer', approvalId: a.approvalId, allow: false })
  const preview = (a.preview ?? []).length
    ? el('dl', { className: 'kv' }, ...a.preview.flatMap(p => [el('dt', { textContent: p.label }), el('dd', { textContent: p.value })]))
    : ''
  return el('div', { className: 'signal' }, el('div', {},
    el('div', { className: 'title' }, el('span', { className: 'lamp amber pulse' }), a.title),
    el('div', { className: 'meta', textContent: [a.agent && `asked by ${a.agent}`, a.site && `on ${a.site}`].filter(Boolean).join(', ') }),
    a.detail ? el('div', { className: 'detail', textContent: a.detail }) : '',
    preview,
    el('div', { className: 'row' }, allow, ...(a.grantable ? [site] : []), deny)))
}

function questionCard(q) {
  const reply = r => msg({ type: 'bas:reply', askId: q.askId, ...r })
  const input = el('input', { className: 'field', type: q.secret ? 'password' : 'text', placeholder: q.secret ? 'Hidden, never written to the log' : 'Your answer', autocomplete: 'off', ariaLabel: 'Your answer' })
  input.onkeydown = e => { if (e.key === 'Enter' && input.value) reply({ text: input.value }) }
  const send = el('button', { className: 'btn solid', type: 'button', textContent: 'Send answer' })
  send.onclick = () => { if (input.value) reply({ text: input.value }) }
  const did = el('button', { className: 'btn quiet small', type: 'button', textContent: 'I did it myself' })
  did.onclick = () => reply({ done: true })
  const skip = el('button', { className: 'btn quiet small', type: 'button', textContent: 'Skip' })
  skip.onclick = () => reply({ skipped: true })
  const choices = (q.choices ?? []).map(c => { const b = el('button', { className: 'btn', type: 'button', textContent: c }); b.onclick = () => reply({ text: c }); return b })
  return el('div', { className: 'signal' }, el('div', {},
    el('div', { className: 'title' }, el('span', { className: 'lamp amber pulse' }), q.question),
    choices.length ? el('div', { className: 'row' }, ...choices) : el('div', { className: 'row' }, input, send),
    el('div', { className: 'row' }, did, skip)))
}

async function render() {
  const s = await msg({ type: 'bas:state' }).catch(() => null)
  if (!s) return
  document.title = s.brand
  $('brand').textContent = s.brand
  $('profile').textContent = s.profile
  const waiting = s.connected && !s.paired
  const refused = s.pairing === 'denied'
  $('status-text').textContent = s.paired ? 'Linked' : waiting ? (refused ? 'Refused' : 'Waiting for you') : 'Offline'
  const tone = s.paired ? 'green' : waiting ? (refused ? 'red' : 'amber') : ''
  $('status').className = `state ${tone}`
  $('status').firstElementChild.className = `lamp ${tone}${tone === 'amber' ? ' pulse' : ''}`
  $('help').textContent = s.paired
    ? 'Linked to the daemon on this computer. Nothing is sent anywhere else.'
    : s.connected ? 'Approve the code above in the control room.' : 'Start it on this computer ("tabgeist start", or any agent tool call starts it); this panel connects by itself.'
  if (document.activeElement !== $('port')) $('port').value = s.port

  const code = s.pairing && s.pairing !== 'denied' ? s.pairing : null
  $('pair-wrap').hidden = !waiting
  $('code').textContent = code ? `${code.slice(0, 3)} ${code.slice(3)}` : s.pairing === 'denied' ? 'refused' : '––– –––'

  const qs = s.questions ?? []
  $('questions-wrap').hidden = qs.length === 0
  // Keep what the user is typing: rebuild only when the set of questions changed.
  const qKey = qs.map(q => q.askId).join(',')
  if ($('questions').dataset.key !== qKey) {
    $('questions').dataset.key = qKey
    $('questions').replaceChildren(...qs.map(questionCard))
  }

  const aKey = s.approvals.map(a => a.approvalId).join(',')
  $('approvals-wrap').hidden = s.approvals.length === 0
  if ($('approvals').dataset.key !== aKey) {
    $('approvals').dataset.key = aKey
    $('approvals').replaceChildren(...s.approvals.map(approvalCard))
  }

  $('tabs-empty').hidden = s.tabs.length > 0
  $('tabs-count').textContent = s.tabs.length ? String(s.tabs.length) : ''
  $('tabs').replaceChildren(...s.tabs.map(t => {
    const li = el('li', { tabIndex: 0, title: 'Show this tab' },
      el('span', { className: `lamp ${t.busy ? 'white' : 'green'}` }),
      el('div', { className: 't' }, el('b', { textContent: t.title || t.url }), el('span', { textContent: t.busy ? 'working…' : t.url })))
    li.onclick = () => msg({ type: 'bas:focus', tabId: t.id })
    li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.onclick() } }
    return li
  }))

  $('log-empty').hidden = s.log.length > 0
  const log = $('log')
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30
  log.replaceChildren(...s.log.map(l => el('li', { className: l.ok ? '' : 'bad' },
    el('time', { textContent: hhmm(l.at) }),
    el('div', {}, el('span', { className: 'k', textContent: l.kind }), l.text, l.agent ? el('span', { className: 'a', textContent: l.agent }) : ''))))
  if (atBottom) log.scrollTop = log.scrollHeight
}

$('room').onclick = () => msg({ type: 'bas:room' })
$('save-port').onclick = () => {
  $('help').textContent = `Connecting on port ${$('port').value}…`
  void msg({ type: 'bas:port', port: $('port').value })
  setTimeout(render, 2500)
}
$('profile').onclick = () => {
  const label = prompt('Name this browser (shown to agents and in the control room). It will be linked again under the new name.', $('profile').textContent)
  if (label && label.trim()) void msg({ type: 'bas:label', label })
}

let pending = null
chrome.runtime.onMessage.addListener(m => {
  if (m?.type !== 'bas:update') return
  // Bursts of updates (a busy agent) redraw at most every 150 ms.
  if (pending) return
  pending = setTimeout(() => { pending = null; void render() }, 150)
})
void render()
setInterval(render, 5000)
