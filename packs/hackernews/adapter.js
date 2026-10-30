// Hacker News pages are plain HTML; the adapter fetches them from the same
// origin (with the user's session) and parses them, so it works from any HN page.
(() => {
  const LISTS = ['news', 'newest', 'front', 'ask', 'show', 'best', 'active']

  async function page(path) {
    if (!/(^|\.)ycombinator\.com$/.test(location.hostname)) throw new Error('open news.ycombinator.com first')
    const r = await fetch(path, { credentials: 'include' })
    if (!r.ok) throw new Error('Hacker News answered ' + r.status + ' for ' + path)
    return new DOMParser().parseFromString(await r.text(), 'text/html')
  }

  const num = s => { const m = /\d+/.exec(s || ''); return m ? Number(m[0]) : 0 }
  const text = el => (el ? el.textContent.trim() : null)
  // A parsed (not rendered) page has no innerText layout: paragraphs are made by hand.
  const para = el => {
    if (!el) return null
    const c = el.cloneNode(true)
    c.querySelectorAll('.reply').forEach(r => r.remove())
    c.querySelectorAll('p').forEach(p => p.prepend('\n\n'))
    return c.textContent.trim() || null
  }
  // .age carries "2026-10-29T12:00:00 1730203200": the ISO time, then the epoch.
  const time = el => { const t = el && el.getAttribute('title'); return t ? t.split(' ')[0] : null }

  function story(row) {
    const sub = row.nextElementSibling
    const link = row.querySelector('.titleline > a')
    const comments = sub ? [...sub.querySelectorAll('a')].map(a => a.textContent).find(t => /comment|discuss/.test(t)) : null
    const href = link ? link.getAttribute('href') : null
    return {
      id: Number(row.id),
      rank: num(text(row.querySelector('.rank'))),
      title: text(link),
      url: href ? new URL(href, location.origin).toString() : null,
      site: text(row.querySelector('.sitestr')),
      points: num(text(sub && sub.querySelector('.score'))),
      by: text(sub && sub.querySelector('.hnuser')),
      time: time(sub && sub.querySelector('.age')),
      comments: comments && /\d/.test(comments) ? num(comments) : 0,
    }
  }

  return {
    ops: {
      stories: {
        about: 'a story list: { list="news" (news|newest|front|ask|show|best|active), page=1, limit=30 } → [{ id, rank, title, url, site, points, by, time, comments }]',
        run: async ({ list = 'news', page: p = 1, limit = 30 } = {}) => {
          if (!LISTS.includes(list)) throw new Error('list: one of ' + LISTS.join(', '))
          const doc = await page('/' + list + '?p=' + Math.max(1, Number(p) || 1))
          return [...doc.querySelectorAll('tr.athing:not(.comtr)')].map(story).slice(0, Math.min(Number(limit) || 30, 100))
        },
      },
      comments: {
        about: 'one story with its comment thread, in page order: { id, limit=200 } → { story, text, comments: [{ id, by, time, depth, text }] }',
        run: async ({ id, limit = 200 } = {}) => {
          if (!/^\d+$/.test(String(id || ''))) throw new Error('id: the story id (from the stories op)')
          const doc = await page('/item?id=' + id)
          const head = doc.querySelector('.fatitem tr.athing')
          if (!head) throw new Error('no item ' + id)
          const body = doc.querySelector('.fatitem .toptext')
          const comments = [...doc.querySelectorAll('tr.athing.comtr')].slice(0, Math.min(Number(limit) || 200, 1000)).map(c => ({
            id: Number(c.id),
            by: text(c.querySelector('.hnuser')),
            time: time(c.querySelector('.age')),
            depth: Number((c.querySelector('td.ind') && c.querySelector('td.ind').getAttribute('indent')) || 0),
            text: para(c.querySelector('.commtext')) || '[deleted]',
          }))
          return { story: story(head), text: para(body), comments }
        },
      },
    },
  }
})()
