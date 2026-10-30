import { describe, expect, it } from 'vitest'
import { cleanText, clip, parseReadRequest, stitch } from './read'

describe('parseReadRequest', () => {
  it('defaults to 5 pages and 20000 characters', () => {
    expect(parseReadRequest({ region: ' Conversation with Ali ' })).toEqual({ ref: undefined, region: 'Conversation with Ali', selector: undefined, item: false, load: undefined, pages: 5, maxChars: 20000 })
  })

  it('refuses a bad load, pages or maxChars', () => {
    expect(parseReadRequest({ load: 'up' })).toMatch(/load: older/)
    expect(parseReadRequest({ pages: 0 })).toMatch(/pages/)
    expect(parseReadRequest({ pages: 31 })).toMatch(/pages/)
    expect(parseReadRequest({ maxChars: 10 })).toMatch(/maxChars/)
  })
})

describe('cleanText', () => {
  it('drops invisible characters and runs of blank lines but keeps one break', () => {
    expect(cleanText('﻿Ali\n\n\n\n  Han   bro \n​\nYou: hello  ')).toBe('Ali\n\nHan bro\n\nYou: hello')
  })

  it('drops a line that the next line repeats with who and when', () => {
    expect(cleanText('hello\n\nMessage sent 20:30 by You: hello\nhello again')).toBe('Message sent 20:30 by You: hello\nhello again')
    expect(cleanText('ok\nok')).toBe('ok\nok')
  })
})

describe('clip', () => {
  it('keeps the newest end of a chat and the start of anything else', () => {
    expect(clip('abcdef', 3, true)).toEqual({ text: 'def', truncated: true })
    expect(clip('abcdef', 3, false)).toEqual({ text: 'abc', truncated: true })
    expect(clip('ab', 3, false)).toEqual({ text: 'ab', truncated: false })
  })
})

describe('stitch', () => {
  const j = (...lines: string[]) => lines.join('\n')

  it('joins screens of a virtual list in page order, each shared line once', () => {
    // Scrolling up a chat: every screen is further up, and shares a few lines with the one below it.
    const screens = [j('m7', 'm8', 'm9', 'm10'), j('m5', 'm6', 'm7', 'm8', 'm9'), j('m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7')]
    expect(stitch(screens, true)).toBe(j('m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'))
    expect(stitch([j('a', 'b', 'c', 'd'), j('b', 'c', 'd', 'e', 'f')], false)).toBe(j('a', 'b', 'c', 'd', 'e', 'f'))
  })

  it('keeps a list that only grows as is, and does not merge one repeated short line', () => {
    expect(stitch([j('a', 'b', 'c'), j('a', 'b', 'c', 'd', 'e')], false)).toBe(j('a', 'b', 'c', 'd', 'e'))
    expect(stitch([j('hi', 'ok'), j('ok', 'bye', 'see you')], false)).toBe(j('hi', 'ok', 'ok', 'bye', 'see you'))
  })
})
