// Benchmarks for the README: how much an agent has to read, and how long it
// takes, the usual way (screen text or the page map) against a pack op or a
// saved routine. Public sites are read logged out, in the throwaway browser.
//   node e2e/run.mjs --bench
// Characters are what the agent's model has to take in; a token is about 4.

const chars = r => JSON.stringify(r).length

async function timed(fn) { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t } }

async function openUrl(h, url) {
  const r = await h.rpc('browser.open', { url })
  h.ok(r.ok, `open ${url}: ${r.error}`)
  await h.sleep(3500)
  return r.tab.id
}

/** One way of getting the same answer: tool calls made, characters returned, milliseconds. */
async function way(h, calls) {
  let n = 0, c = 0, ms = 0, text = ''
  for (const call of calls) { const { r, ms: t } = await timed(call); n++; c += chars(r); ms += t; text += r.text ?? ''; h.ok(r.ok !== false, JSON.stringify(r).slice(0, 300)) }
  return { calls: n, chars: c, ms, text }
}

/** How many of the items (by a field the screen shows too) a way's text holds. */
function found(w, items, key) {
  const norm = x => x.replace(/\s+/g, ' ')
  const text = norm(w.text)
  const want = items.map(i => norm(String(i[key] ?? '')).trim().slice(0, 40)).filter(Boolean)
  return { ...w, text: undefined, found: `${want.filter(x => text.includes(x)).length}/${want.length}` }
}

async function items(h, t, op, args) {
  const r = await h.rpc('browser.read', { tab: t, data: true, op, args, raw: true, maxChars: 100000 })
  return JSON.parse(r.text)
}

export const BENCH = [
  {
    name: 'bench: Hacker News front page, 30 stories with points and comments',
    bench: true,
    async run(h) {
      const t = await openUrl(h, 'https://news.ycombinator.com/')
      const all = await items(h, t, 'stories', { limit: 30 })
      h.metric('screen text', found(await way(h, [() => h.rpc('browser.read', { tab: t })]), all, 'title'))
      h.metric('page map', found(await way(h, [() => h.rpc('browser.snapshot', { tab: t })]), all, 'title'))
      h.metric('pack op', found(await way(h, [() => h.rpc('browser.read', { tab: t, data: true, op: 'stories', args: { limit: 30 } })]), all, 'title'))
    },
  },
  {
    name: 'bench: Hacker News, the top story\'s whole comment thread',
    bench: true,
    async run(h) {
      const t = await openUrl(h, 'https://news.ycombinator.com/')
      const top = await h.rpc('browser.read', { tab: t, data: true, op: 'stories', args: { limit: 1 }, raw: true })
      const id = JSON.parse(top.text)[0].id
      // The usual way: open the thread and read it, loading further down as needed.
      const thread = (await items(h, t, 'comments', { id, limit: 1000 })).comments.map(c => ({ start: c.text.slice(0, 40) }))
      h.metric('screen text', found(await way(h, [() => h.rpc('browser.navigate', { tab: t, url: `https://news.ycombinator.com/item?id=${id}` }), () => h.rpc('browser.read', { tab: t, load: 'more', pages: 10, maxChars: 100000 })]), thread, 'start'))
      h.metric('pack op', found(await way(h, [() => h.rpc('browser.read', { tab: t, data: true, op: 'comments', args: { id, limit: 1000 }, maxChars: 100000 })]), thread, 'start'))
    },
  },
  {
    name: 'bench: YouTube search, 20 results with channel, views and length',
    bench: true,
    async run(h) {
      const t = await openUrl(h, 'https://www.youtube.com/results?search_query=browser+automation+mcp')
      const all = await items(h, t, 'search', { query: 'browser automation mcp', limit: 20 })
      h.metric('screen text', found(await way(h, [() => h.rpc('browser.read', { tab: t, load: 'more', pages: 2 })]), all, 'title'))
      h.metric('page map', found(await way(h, [() => h.rpc('browser.snapshot', { tab: t })]), all, 'title'))
      h.metric('pack op', found(await way(h, [() => h.rpc('browser.read', { tab: t, data: true, op: 'search', args: { query: 'browser automation mcp', limit: 20 } })]), all, 'title'))
    },
  },
  {
    name: 'bench: a two-step form task, by the agent and as a saved routine',
    bench: true,
    async run(h) {
      const t = await h.open('/shop')
      let ref = {}
      // The agent: look at the page, act, check the result. Each call is also a model turn.
      h.metric('agent', found(await way(h, [
        async () => { const s = await h.rpc('browser.snapshot', { tab: t }); ref = { box: h.ref(s.text, 'textbox', 'Product'), go: h.ref(s.text, 'button', 'Search') }; return s },
        () => h.rpc('browser.act', { tab: t, steps: [{ action: 'type', ref: ref.box, text: 'green tea' }, { action: 'click', ref: ref.go }] }),
        () => h.rpc('browser.read', { tab: t }),
      ]), [], 'x'))
      const name = `bench.shop.${Date.now()}`
      await h.rpc('routine.save', { tab: t, name, params: { 'green tea': 'product' }, expect: [{ text: 'results for' }] })
      h.metric('routine', found(await way(h, [() => h.rpc('routine.run', { name, vars: { product: 'rice' }, tab: t })]), [], 'x'))
      await h.rpc('routine.retire', { site: '127.0.0.1', name })
    },
  },
]
