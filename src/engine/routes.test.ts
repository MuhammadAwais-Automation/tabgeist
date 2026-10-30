import { describe, expect, it } from 'vitest'
import { fillRoute, redactUrl, replayRefusal, siteOf, summarizeRequests } from './routes'

describe('redactUrl', () => {
  it('hides secret-looking query values and keeps the rest', () => {
    expect(redactUrl('https://www.linkedin.com/voyager/api/search?q=ai&csrfToken=abc&count=10'))
      .toBe('https://www.linkedin.com/voyager/api/search?q=ai&csrfToken=%E2%80%A6&count=10')
    expect(redactUrl('not a url')).toBe('')
  })
})

describe('replayRefusal', () => {
  const page = 'https://www.linkedin.com/feed/'
  it('allows https GET urls on the same site, subdomains included', () => {
    expect(replayRefusal('https://www.linkedin.com/voyager/api/me', page)).toBeNull()
    expect(replayRefusal('https://api.linkedin.com/v2/me', page)).toBeNull()
  })

  it('refuses other sites, plain http and redacted values', () => {
    expect(replayRefusal('https://evil.example.com/x', page)).toMatch(/not part of/)
    expect(replayRefusal('http://www.linkedin.com/x', page)).toMatch(/https/)
    expect(replayRefusal(redactUrl('https://www.linkedin.com/x?token=1'), page)).toMatch(/redacted/)
  })

  it('compares sites by the last two labels', () => {
    expect(siteOf('www.reddit.com')).toBe('reddit.com')
    expect(siteOf('gql.reddit.com')).toBe('reddit.com')
  })
})

describe('summarizeRequests', () => {
  it('keeps data calls only, GET first, without duplicates', () => {
    const out = summarizeRequests([
      { method: 'POST', url: 'https://x.com/track', type: 'Fetch', status: 204 },
      { method: 'GET', url: 'https://x.com/api/feed?page=1', type: 'XHR', status: 200, mime: 'application/json', bytes: 900 },
      { method: 'GET', url: 'https://x.com/api/feed?page=1', type: 'XHR', status: 200 },
      { method: 'GET', url: 'https://x.com/logo.png', type: 'Image', status: 200 },
    ])
    expect(out.map(r => `${r.method} ${r.url}`)).toEqual(['GET https://x.com/api/feed?page=1', 'POST https://x.com/track'])
  })
})

describe('fillRoute', () => {
  it('url-encodes values and names a missing variable', () => {
    expect(fillRoute('https://x.com/search?q={{q}}', { q: 'ai jobs & more' })).toEqual({ url: 'https://x.com/search?q=ai%20jobs%20%26%20more' })
    expect(fillRoute('https://x.com/u/{{id}}', {})).toEqual({ missing: 'id' })
  })
})
