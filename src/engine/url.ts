/**
 * What the agent typed as an address: a full http(s) url, a bare host, or words
 * to search. javascript: and the like are refused (null).
 */
export function normalizeUrl(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (s === 'about:blank') return s
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^localhost:\d+/i.test(s)) {
    try {
      const u = new URL(s)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
    } catch { return null }
  }
  const looksLikeHost = !/\s/.test(s) && (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?(\/.*)?$/i.test(s))
  if (looksLikeHost) {
    try { return new URL(`${/^localhost/i.test(s) ? 'http' : 'https'}://${s}`).toString() } catch { return null }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

export function hostLabel(url: string): string {
  try { return new URL(url).host.replace(/^www\./, '') } catch { return url }
}
