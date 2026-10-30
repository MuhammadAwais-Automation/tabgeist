// WhatsApp Web keeps chats, messages and contacts decrypted in its own module
// registry: window.require('WAWebCollections') (Chat, Msg, Contact). Chat ids
// on current builds are @lid (no phone number); names come from Contact.
// Media bodies hold a base64 thumbnail, so only the type and caption are kept.
(() => {
  function store() {
    if (typeof window.require !== 'function') throw new Error('WhatsApp is still loading, or not signed in (no module registry yet) — wait and try again')
    const S = window.require('WAWebCollections')
    if (!S || !S.Chat) throw new Error('WhatsApp is still loading its chats — wait and try again')
    return S
  }

  function all(coll) {
    if (!coll) return []
    try { if (typeof coll.getModelsArray === 'function') return coll.getModelsArray() || [] } catch (e) {}
    return coll.models || []
  }

  function nameOf(S, id, pushname) {
    if (!id) return null
    try {
      const k = S.Contact.get(id)
      if (k && (k.name || k.pushname || k.formattedName)) return String(k.name || k.pushname || k.formattedName)
      const c = S.Chat.get(id)
      if (c && (c.name || c.formattedTitle)) return String(c.name || c.formattedTitle)
    } catch (e) {}
    return pushname ? String(pushname) : null
  }

  const chatName = (S, c) => nameOf(S, String(c.id), null) || c.formattedTitle || c.name || String(c.id)
  const when = t => (t ? new Date(t * 1000).toISOString() : null)

  function msg(S, m) {
    const fromMe = !!(m.id && m.id.fromMe)
    // In a group 'author' is the person and 'from' the group; one's own messages are just "You".
    const sender = m.author ? String(m.author) : m.from ? String(m.from) : null
    return {
      id: m.id && m.id.id ? String(m.id.id) : null,
      time: when(m.t),
      from: fromMe ? 'You' : nameOf(S, sender, m.notifyName) || sender,
      fromMe,
      type: m.type,
      text: m.type === 'chat' && typeof m.body === 'string' ? m.body : null,
      caption: typeof m.caption === 'string' && m.caption ? m.caption : null,
    }
  }

  function chatInfo(S, c) {
    const id = String(c.id)
    const ms = all(c.msgs)
    const last = ms.length ? msg(S, ms[ms.length - 1]) : null
    return {
      id,
      name: chatName(S, c),
      group: id.endsWith('@g.us'),
      unread: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
      time: when(c.t),
      t: c.t || 0,
      pinned: !!c.pin,
      archived: !!c.archive,
      muted: !!(c.mute && c.mute.isMuted),
      last: last && { from: last.from, type: last.type, text: last.text ? last.text.slice(0, 160) : last.caption, time: last.time },
    }
  }

  function findChat(S, chat) {
    if (!chat) throw new Error('chat: a chat name or id (from the chats op)')
    const q = String(chat).trim()
    const byId = S.Chat.get(q)
    if (byId) return byId
    const chats = all(S.Chat)
    const low = q.toLowerCase()
    const exact = chats.filter(c => chatName(S, c).toLowerCase() === low)
    if (exact.length === 1) return exact[0]
    const part = exact.length ? exact : chats.filter(c => chatName(S, c).toLowerCase().includes(low))
    if (part.length === 1) return part[0]
    if (!part.length) throw new Error('no chat named "' + q + '" — the chats op lists them')
    throw new Error('"' + q + '" fits ' + part.length + ' chats: ' + part.slice(0, 8).map(c => chatName(S, c) + ' (' + String(c.id) + ')').join(', ') + ' — pass the id')
  }

  return {
    ops: {
      chats: {
        about: 'recent chats, newest first: { limit=30, unread=false (only unread), query (part of a name) } → [{ id, name, group, unread, time, pinned, archived, muted, last }]',
        run: async ({ limit = 30, unread = false, query } = {}) => {
          const S = store()
          let list = all(S.Chat).map(c => chatInfo(S, c))
          if (unread) list = list.filter(c => c.unread > 0)
          if (query) list = list.filter(c => (c.name || '').toLowerCase().includes(String(query).toLowerCase()))
          list.sort((a, b) => b.t - a.t)
          return list.slice(0, Math.min(Number(limit) || 30, 500)).map(({ t, ...c }) => c)
        },
      },
      messages: {
        about: 'messages of one chat, oldest first, without opening it (stays unread): { chat (name or id), limit=50, older=false (fetch earlier history too) } → { chat, messages: [{ id, time, from, fromMe, type, text, caption }], more }',
        run: async ({ chat, limit = 50, older = false } = {}) => {
          const S = store()
          const c = findChat(S, chat)
          const want = Math.min(Number(limit) || 50, 1000)
          let L = null
          try { L = window.require('WAWebChatLoadMessages') } catch (e) {}
          const count = () => all(c.msgs).length
          const newest = () => all(c.msgs).reduce((t, m) => Math.max(t, m.t || 0), 0)
          // A chat not opened in this session may hold only its last message.
          if (L && typeof L.loadRecentMsgs === 'function' && (count() < 2 || (c.t || 0) > newest())) {
            try { await L.loadRecentMsgs({ chat: c }) } catch (e) {}
          }
          let more = true
          for (let i = 0; L && typeof L.loadEarlierMsgs === 'function' && (older || count() < want) && i < 10; i++) {
            const before = count()
            try { await L.loadEarlierMsgs({ chat: c }) } catch (e) { break }
            if (count() === before) { more = false; break }
            if (!older && count() >= want) break
          }
          const msgs = all(c.msgs).slice().sort((a, b) => (a.t || 0) - (b.t || 0))
          return { chat: { id: String(c.id), name: chatName(S, c) }, messages: msgs.slice(-want).map(m => msg(S, m)), more: more && msgs.length >= want }
        },
      },
    },
  }
})()
