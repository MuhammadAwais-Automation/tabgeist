// YouTube puts each page's data in the HTML as ytInitialData and
// ytInitialPlayerResponse. In the open tab those go stale after in-app
// navigation, so the adapter fetches the page again from the same origin
// (with the user's session) and reads them from there.
(() => {
  const t = x => (x == null ? null : typeof x === 'string' ? x : x.simpleText || x.content || (x.runs ? x.runs.map(r => r.text).join('') : null))

  function blob(html, name) {
    const i = html.indexOf(name + ' = ')
    if (i < 0) return null
    const start = html.indexOf('{', i)
    // Walk to the matching brace, minding strings.
    let depth = 0, inStr = false, esc = false
    for (let j = start; j < html.length; j++) {
      const c = html[j]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, j + 1))
    }
    return null
  }

  async function page(path) {
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) throw new Error('open youtube.com first')
    const r = await fetch(path, { credentials: 'include' })
    if (!r.ok) throw new Error('YouTube answered ' + r.status + ' for ' + path)
    const html = await r.text()
    return { data: blob(html, 'ytInitialData'), player: blob(html, 'ytInitialPlayerResponse') }
  }

  // Every video card on a page, old renderers and the newer lockup view model alike.
  function cards(root, limit) {
    const out = [], shorts = [], seen = new Set()
    const add = v => { if (v.id && !seen.has(v.id)) { seen.add(v.id); (v.length === 'short' ? shorts : out).push(v) } }
    const walk = o => {
      if (!o || typeof o !== 'object' || out.length >= limit) return
      if (o.continuationItemRenderer) return
      if (Array.isArray(o)) { o.forEach(walk); return }
      const r = o.videoRenderer || o.gridVideoRenderer || o.compactVideoRenderer || o.playlistVideoRenderer
      if (r && r.videoId) {
        add({
          id: r.videoId,
          title: t(r.title),
          channel: t(r.ownerText || r.shortBylineText || r.longBylineText),
          views: t(r.viewCountText),
          published: t(r.publishedTimeText),
          length: t(r.lengthText),
          url: 'https://www.youtube.com/watch?v=' + r.videoId,
        })
        return
      }
      const l = o.lockupViewModel
      if (l && l.contentId && /VIDEO/.test(l.contentType || '')) {
        const m = l.metadata && l.metadata.lockupMetadataViewModel
        const rows = (m && m.metadata && m.metadata.contentMetadataViewModel && m.metadata.contentMetadataViewModel.metadataRows) || []
        // The short text ("7.1M") drops the word; the accessibility label keeps it ("7.1 million views").
        const parts = rows.flatMap(row => (row.metadataParts || []).map(p => p.accessibilityLabel || t(p.text))).filter(Boolean)
        const views = parts.find(p => /view|watching/i.test(p)) || null
        const published = parts.find(p => /ago|streamed|premiere/i.test(p)) || null
        const len = /"text":"(\d+(?::\d\d)+)"/.exec(JSON.stringify(l.contentImage || {}))
        add({ id: l.contentId, title: m && t(m.title), channel: parts.find(p => p !== views && p !== published) || null, views, published, length: len ? len[1] : null, url: 'https://www.youtube.com/watch?v=' + l.contentId })
        return
      }
      const s = o.reelItemRenderer || o.shortsLockupViewModel
      if (s && (s.videoId || (s.onTap && s.onTap.innertubeCommand && s.onTap.innertubeCommand.reelWatchEndpoint))) {
        const id = s.videoId || s.onTap.innertubeCommand.reelWatchEndpoint.videoId
        add({ id, title: t(s.headline) || (s.overlayMetadata && t(s.overlayMetadata.primaryText)), channel: null, views: (s.overlayMetadata && t(s.overlayMetadata.secondaryText)) || t(s.viewCountText), published: null, length: 'short', url: 'https://www.youtube.com/shorts/' + id })
        return
      }
      for (const k in o) walk(o[k])
    }
    walk(root)
    // Regular videos first: a Shorts shelf often sits at the top of search results.
    return out.concat(shorts).slice(0, limit)
  }

  const idOf = v => {
    const s = String(v || '')
    const m = /(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/.exec(s)
    return m ? m[1] : /^[\w-]{11}$/.test(s) ? s : null
  }

  return {
    ops: {
      video: {
        about: 'one video: { id (or a video URL; default: the open video) } → { id, title, channel, channelId, views, length, published, category, keywords, description }',
        run: async ({ id } = {}) => {
          const v = idOf(id) || idOf(location.href)
          if (!v) throw new Error('id: a video id or URL, or open a video first')
          const { player } = await page('/watch?v=' + v)
          const d = player && player.videoDetails
          if (!d) throw new Error('no details for ' + v + (player && player.playabilityStatus ? ' (' + player.playabilityStatus.status + ')' : ''))
          const mf = (player.microformat && player.microformat.playerMicroformatRenderer) || {}
          return {
            id: d.videoId, title: d.title, channel: d.author, channelId: d.channelId,
            views: Number(d.viewCount) || 0, length: Number(d.lengthSeconds) || 0, live: !!d.isLiveContent,
            published: mf.publishDate || null, category: mf.category || null,
            keywords: d.keywords || [], description: d.shortDescription || '',
          }
        },
      },
      search: {
        about: 'search results: { query, limit=20 } → [{ id, title, channel, views, published, length, url }]',
        run: async ({ query, limit = 20 } = {}) => {
          if (!query) throw new Error('query: what to search for')
          const { data } = await page('/results?search_query=' + encodeURIComponent(query))
          return cards(data, Math.min(Number(limit) || 20, 100))
        },
      },
      videos: {
        about: 'the videos on a YouTube page: { path (default: the open page, e.g. "/", "/@channel/videos", "/playlist?list=…", "/feed/subscriptions"), limit=30 } → [{ id, title, channel, views, published, length, url }]',
        run: async ({ path, limit = 30 } = {}) => {
          const p = path ? String(path) : location.pathname + location.search
          if (!p.startsWith('/')) throw new Error('path: starts with /, like /@channel/videos')
          const { data } = await page(p)
          return cards(data, Math.min(Number(limit) || 30, 200))
        },
      },
    },
  }
})()
