// End-to-end scenarios for the system's own features: secret fog, the
// exfiltration and navigation gates, site rules, grants, other languages,
// routines (save, replay, similarity, heal, API-first, dry runs, canaries),
// the timeline and the control room. Same helpers as scenarios.mjs.

/** Runs fn while answering every approval it raises: 'deny', 'once' or 'site'. */
async function answering(h, policy, fn) {
  const asked = [], seen = new Set()
  let done = false
  const watcher = (async () => {
    while (!done) {
      for (const a of await h.rpc('test.approvals')) {
        if (seen.has(a.approvalId)) continue
        seen.add(a.approvalId)
        asked.push(a)
        await h.rpc('test.answer', { approvalId: a.approvalId, allow: policy !== 'deny', grant: policy === 'site' ? 'site' : 'once' })
      }
      await h.sleep(100)
    }
  })()
  try { return { result: await fn(), asked } } finally { done = true; await watcher }
}

const otherSite = h => h.site.replace('127.0.0.1', 'localhost')
/** Routine names new on every pass, so a soak run never meets the last pass's routines. */
const uniq = base => `${base}-${Math.random().toString(36).slice(2, 7)}`
const received = async h => (await fetch(`${h.site}/api/received`)).json()

export const CORE = [
  {
    name: 'fog: a code and a card stay hidden; typed back only on their own site',
    async run(h) {
      const t = await h.open('/secrets')
      const r = await h.rpc('browser.read', { tab: t })
      h.ok(r.ok && !r.text.includes('482913') && !r.text.includes('4111'), `secrets reached the agent: ${r.text}`)
      const code = /code is (\{\{secret:\d+\}\})/.exec(r.text)?.[1]
      h.ok(code, `no fogged code in: ${r.text}`)
      const s = await h.snap(t)
      const a = await h.act(t, { steps: [{ action: 'type', ref: h.ref(s, 'textbox', 'Code'), text: code }, { action: 'click', ref: h.ref(s, 'button', 'Verify') }] })
      h.ok(a.receipt.ok, a.receipt.error)
      await h.expectOut(t, 'verified 482913')
      const tl = await h.rpc('timeline.recent', { limit: 20 })
      h.ok(!JSON.stringify(tl).includes('482913'), 'the real code reached the timeline')
      const other = await h.rpc('browser.open', { url: `${otherSite(h)}/secrets` })
      h.ok(other.ok, other.error)
      const s2 = await h.snap(other.tab.id)
      const b = await h.act(other.tab.id, { action: 'type', ref: h.ref(s2, 'textbox', 'Code'), text: code })
      await h.rpc('browser.closeTab', { tab: other.tab.id })
      h.ok(!b.receipt.ok && /can only be typed there/.test(b.receipt.error), `typed on another site: ${JSON.stringify(b.receipt)}`)
    },
  },
  {
    name: 'exfiltration: an address carrying read text to another site asks; a no stops it',
    async run(h) {
      const t = await h.open('/leak')
      const r = await h.rpc('browser.read', { tab: t })
      h.ok(r.ok, r.error)
      const url = `${otherSite(h)}/?q=${encodeURIComponent('quarterly revenue for the Lahore office was four point two million')}`
      const { result, asked } = await answering(h, 'deny', () => h.rpc('browser.navigate', { tab: t, url }))
      h.ok(asked.length === 1 && asked[0].kind === 'navigate', `asked ${JSON.stringify(asked.map(a => a.kind))}`)
      h.ok(!result.ok && /did not allow/.test(result.error), JSON.stringify(result))
      const plain = await h.rpc('browser.navigate', { tab: t, url: `${otherSite(h)}/rules` })
      h.ok(plain.ok, `a plain address was refused: ${plain.error}`)
    },
  },
  {
    name: 'rules: block never runs, ask asks for a harmless button, others pass',
    async run(h) {
      const saved = await h.rpc('policy.save', { site: '127.0.0.1', text: "block: ['click:*delete account*']\nask: ['click:*archive*']" })
      h.ok(saved.ok, saved.error)
      try {
        const t = await h.open('/rules')
        const s = await h.snap(t)
        const del = await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Delete account') }, 'allow')
        h.ok(!del.receipt.ok && /rules for this site block/.test(del.receipt.error) && del.asked.length === 0, JSON.stringify(del))
        h.ok((await h.out(t)) === 'nothing yet', 'the blocked click happened')
        const arc = await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Archive') }, 'allow')
        h.ok(arc.asked.length === 1, `archive asked ${arc.asked.length}`)
        await h.expectOut(t, 'archived')
        const draft = await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Save draft') })
        h.ok(draft.receipt.ok && draft.asked.length === 0, JSON.stringify(draft))
      } finally { await h.rpc('policy.save', { site: '127.0.0.1', text: '' }) }
    },
  },
  {
    name: 'languages: Enviar asks first, Guardar borrador does not',
    async run(h) {
      const t = await h.open('/enviar')
      const s = await h.snap(t)
      const send = await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Enviar') }, 'deny')
      h.ok(send.asked.length === 1 && !send.receipt.ok, JSON.stringify(send))
      const draft = await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Guardar borrador') })
      h.ok(draft.asked.length === 0, 'the draft button asked')
      await h.expectOut(t, 'borrador')
    },
  },
  {
    name: 'grants: "allow 15 min on this site" covers the next Send without a card',
    async run(h) {
      const t = await h.open('/mail')
      const before = (await received(h)).count
      let s = await h.snap(t)
      const first = await answering(h, 'site', () => h.rpc('browser.act', { tab: t, steps: [{ action: 'type', ref: h.ref(s, 'textbox', 'Message'), text: 'hello', clear: true }, { action: 'click', ref: h.ref(s, 'button', 'Send') }] }))
      h.ok(first.asked.length === 1 && first.result.ok, JSON.stringify(first))
      await h.expectOut(t, 'sent hello')
      s = await h.snap(t)
      const second = await answering(h, 'deny', () => h.rpc('browser.act', { tab: t, steps: [{ action: 'type', ref: h.ref(s, 'textbox', 'Message'), text: 'again', clear: true }, { action: 'click', ref: h.ref(s, 'button', 'Send') }] }))
      h.ok(second.asked.length === 0 && second.result.ok, `the grant did not cover it: ${JSON.stringify(second)}`)
      await h.expectOut(t, 'sent again')
      h.ok((await received(h)).count === before + 2, 'both messages should have reached the site')
      const state = await h.rpc('room.state')
      h.ok(state.grants.length >= 1, 'no grant listed')
      await h.rpc('grants.clear')
    },
  },
  {
    name: 'routine: save, replay, the page changes (similarity), breaks (heal), a fix is dry-run and applied',
    async run(h) {
      const shop = uniq('shop.search')
      const t = await h.open('/shop')
      let s = await h.snap(t)
      await h.act(t, { steps: [{ action: 'type', ref: h.ref(s, 'textbox', 'Product'), text: 'green tea' }, { action: 'click', ref: h.ref(s, 'button', 'Search') }] })
      await h.expectOut(t, 'results for green tea')
      const saved = await h.rpc('routine.save', { tab: t, name: shop, params: { 'green tea': 'product' }, expect: [{ text: 'results for' }] })
      h.ok(saved.ok && saved.params.includes('product'), JSON.stringify(saved))
      const run1 = await h.rpc('routine.run', { name: shop, vars: { product: 'rice' }, tab: t })
      h.ok(run1.ok && run1.healed.length === 0, JSON.stringify(run1))
      await h.expectOut(t, 'results for rice')

      await h.rpc('browser.navigate', { tab: t, url: `${h.site}/shop?v=2` })
      const run2 = await h.rpc('routine.run', { name: shop, vars: { product: 'oil' }, tab: t })
      h.ok(run2.ok && run2.healed.length === 1 && run2.heal, `similarity: ${JSON.stringify(run2)}`)
      await h.expectOut(t, 'results for oil')
      const drift = await h.rpc('heal.apply', { id: run2.heal })
      h.ok(drift.ok && drift.version === 2, JSON.stringify(drift))

      await h.rpc('browser.navigate', { tab: t, url: `${h.site}/shop?v=3` })
      const run3 = await h.rpc('routine.run', { name: shop, vars: { product: 'salt' }, tab: t })
      h.ok(!run3.ok && run3.heal, `should break with a ticket: ${JSON.stringify(run3)}`)
      const list = await h.rpc('heal.list')
      const ticket = list.tickets.find(x => x.id === run3.heal)
      h.ok(ticket && ticket.evidence.snapshot.includes('Browse instead'), 'the ticket lacks the page as it is now')

      const fix = JSON.stringify({ name: shop, site: '127.0.0.1', params: { product: { default: 'tea' } }, steps: [{ goto: `${h.site}/shop?v=2` }, { act: 'type', target: { role: 'textbox', name: 'Product' }, text: '{{product}}' }, { act: 'click', target: { role: 'button', name: 'Search catalog' } }], expect: [{ text: 'results for' }] })
      const proposed = await h.rpc('heal.propose', { id: run3.heal, routine: fix, tab: t, note: 'search moved to the catalog page' })
      h.ok(proposed.ok && proposed.status === 'ready', JSON.stringify(proposed))
      const applied = await h.rpc('heal.apply', { id: run3.heal })
      h.ok(applied.ok, JSON.stringify(applied))
      const run4 = await h.rpc('routine.run', { name: shop, vars: { product: 'sugar' }, tab: t })
      h.ok(run4.ok, JSON.stringify(run4))
      await h.expectOut(t, 'results for sugar')
    },
  },
  {
    name: 'API-first: a read-only routine runs through the site\'s own data call, no clicks',
    async run(h) {
      const prices = uniq('prices.load')
      const t = await h.open('/prices')
      const s = await h.snap(t)
      await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Load prices') })
      await h.expectOut(t, '3 prices')
      const saved = await h.rpc('routine.save', { tab: t, name: prices, expect: [{ text: '3 prices' }] })
      h.ok(saved.ok && saved.apiFirst, JSON.stringify(saved))
      const run = await h.rpc('routine.run', { name: prices, tab: t })
      h.ok(run.ok && run.via === 'api' && run.data.data1.items.length === 3, JSON.stringify(run))
    },
  },
  {
    name: 'dry run: the write is blocked and the run stops before Send',
    async run(h) {
      const mail = uniq('mail.send')
      const t = await h.open('/mail')
      const s = await h.snap(t)
      const sent = await h.act(t, { steps: [{ action: 'type', ref: h.ref(s, 'textbox', 'Message'), text: 'weekly report', clear: true }, { action: 'click', ref: h.ref(s, 'button', 'Send') }] }, 'allow')
      h.ok(sent.receipt.ok, sent.receipt.error)
      const saved = await h.rpc('routine.save', { tab: t, name: mail, last: 2, params: { 'weekly report': 'text' } })
      h.ok(saved.ok, JSON.stringify(saved))
      const before = (await received(h)).count
      const { result, asked } = await answering(h, 'deny', () => h.rpc('routine.run', { name: mail, vars: { text: 'dry' }, shadow: true, tab: t }))
      h.ok(result.ok && /Send/.test(result.shadow?.stoppedAt ?? '') && asked.length === 0, JSON.stringify(result))
      h.ok((await received(h)).count === before, 'a dry run reached the site')
    },
  },
  {
    name: 'canary: a scheduled read-only routine is dry-run in the background',
    async run(h) {
      const yaml = JSON.stringify({ name: 'prices.canary', site: '127.0.0.1', start: `${h.site}/prices`, steps: [{ act: 'click', target: { role: 'button', name: 'Load prices' } }], expect: [{ text: '3 prices' }], canary: { every: '5m' } })
      const saved = await h.rpc('routine.saveText', { text: yaml })
      h.ok(saved.ok, JSON.stringify(saved))
      let runs = []
      for (let i = 0; i < 60 && !runs.length; i++) {
        await h.sleep(500)
        const site = await h.rpc('site.get', { site: '127.0.0.1' })
        runs = (site.health.routines['prices.canary']?.runs ?? []).filter(r => r.by === 'canary')
      }
      h.ok(runs.length && runs[0].ok && runs[0].shadow, `canary runs: ${JSON.stringify(runs)}`)
      await h.rpc('routine.retire', { site: '127.0.0.1', name: 'prices.canary' })
    },
  },
  {
    name: 'timeline: calls are recorded per agent, with a picture after acts',
    async run(h) {
      const t = await h.open('/rules')
      const s = await h.snap(t)
      await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Save draft') })
      const tl = await h.rpc('timeline.recent', { limit: 30 })
      const act = tl.entries.find(e => e.method === 'browser.act' && e.input?.includes('click'))
      h.ok(act && act.agent === 'e2e' && act.shot && act.site === '127.0.0.1', JSON.stringify(act))
      const sessions = await h.rpc('timeline.sessions')
      h.ok(sessions.sessions.some(x => x.agent === 'e2e' && x.steps > 0), 'no e2e session')
    },
  },
  {
    name: 'control room: opens for the user; agents cannot open, read or click it; no cookie, no data',
    async run(h) {
      const opened = await h.rpc('room.open')
      h.ok(opened.ok && opened.opened === 'browser', JSON.stringify(opened))
      let room
      for (let i = 0; i < 20 && !room; i++) {
        await h.sleep(250)
        room = (await h.rpc('browser.tabs')).browsers[0].tabs.find(x => x.url.includes(`127.0.0.1:${h.port}`))
      }
      h.ok(room, 'the room tab did not open')
      let text = ''
      for (let i = 0; i < 30 && !text.includes('Timeline'); i++) { await h.sleep(200); text = String(await h.rpc('test.eval', { tab: room.id, expr: 'document.body.innerText' })) }
      h.ok(text.includes('Live') && text.includes('Timeline') && text.includes('Heal'), `room shows: ${text.slice(0, 300)}`)
      const snap = await h.rpc('browser.snapshot', { tab: room.id })
      h.ok(!snap.ok && /control room/.test(snap.error), `an agent read the room: ${JSON.stringify(snap).slice(0, 200)}`)
      const nav = await h.rpc('browser.open', { url: `http://127.0.0.1:${h.port}/` })
      h.ok(!nav.ok && /control room/.test(nav.error), 'an agent opened the room')
      const api = await fetch(`http://127.0.0.1:${h.port}/api/rpc`, { method: 'POST', body: '{"method":"room.state"}' })
      h.ok(api.status === 401, `api without a cookie answered ${api.status}`)
      const agentRoom = await h.rpc('approval.answer', { approvalId: 'x', allow: true }, 'sneaky-agent')
      h.ok(/control room|no longer waiting/.test(agentRoom.error ?? ''), JSON.stringify(agentRoom))
      await h.rpc('test.eval', { tab: room.id, expr: 'window.close()' })
    },
  },
]
