import { describe, expect, it } from 'vitest'
import { confirmReason } from './safety'

describe('confirmReason', () => {
  it('asks before clicks that send, post, pay or delete', () => {
    for (const name of ['Send', 'Post', 'Pay now', 'Delete chat', 'Submit', 'Place order', 'Publish']) {
      expect(confirmReason({ action: 'click' }, { role: 'button', name })).toMatch(/confirm: true/)
    }
  })

  it('lets harmless clicks through', () => {
    for (const name of ['Search', 'Next', 'Open menu', 'Sender settings']) {
      expect(confirmReason({ action: 'click' }, { role: 'button', name })).toBeNull()
    }
    expect(confirmReason({ action: 'click' }, { role: 'heading', name: 'Delete' })).toBeNull()
  })

  it('asks before Enter or a newline in a text field, but not in search', () => {
    expect(confirmReason({ action: 'key', key: 'Enter' }, { role: 'textbox', name: 'Type a message' })).toMatch(/Enter/)
    expect(confirmReason({ action: 'key', key: 'Enter' })).toMatch(/Enter/)
    expect(confirmReason({ action: 'type', text: 'hi\n' }, { role: 'textbox', name: 'Message' })).toMatch(/Enter/)
    expect(confirmReason({ action: 'key', key: 'Enter' }, { role: 'searchbox', name: '' })).toBeNull()
    expect(confirmReason({ action: 'key', key: 'Enter' }, { role: 'combobox', name: 'Search Reddit' })).toBeNull()
    expect(confirmReason({ action: 'type', text: 'hi' }, { role: 'textbox', name: 'Message' })).toBeNull()
    expect(confirmReason({ action: 'key', key: 'Escape' })).toBeNull()
  })
})

describe('upload', () => {
  it('always asks before putting local files on a site', () => {
    expect(confirmReason({ action: 'upload' }, { role: 'button', name: 'Add photo' })).toMatch(/uploading/)
  })
})

describe('reactions, likes, stickers and GIFs', () => {
  it('asks before anything other people will see', () => {
    expect(confirmReason({ action: 'click' }, { role: 'button', name: 'Send a Like' })).toMatch(/may send/)
    expect(confirmReason({ action: 'click' }, { role: 'button', name: 'Reaction button state: no reaction' })).toMatch(/may send/)
    expect(confirmReason({ action: 'click' }, { role: 'button', name: 'Moodies Animated yellow face emoji, crying with laughter. sticker' })).toMatch(/may send/)
    expect(confirmReason({ action: 'click' }, { role: 'menuitemradio', name: '❤' })).toMatch(/reacts/)
    expect(confirmReason({ action: 'click' }, { role: 'menuitemradio', name: '👍🏽' })).toMatch(/reacts/)
  })

  it('lets an emoji picker only insert into the text box', () => {
    expect(confirmReason({ action: 'click' }, { role: 'button', name: '😂' })).toBeNull()
    expect(confirmReason({ action: 'click' }, { role: 'button', name: 'Choose an emoji' })).toBeNull()
    expect(confirmReason({ action: 'click' }, { role: 'button', name: 'Choose a GIF' })).toBeNull()
    expect(confirmReason({ action: 'click' }, { role: 'button', name: 'Choose a sticker' })).toBeNull()
  })
})

describe('new mouse actions', () => {
  it('asks before a drop of local files and a risky double-click', () => {
    expect(confirmReason({ action: 'drop' }, { role: 'generic', name: 'Drag photos here' })).toMatch(/uploading/)
    expect(confirmReason({ action: 'paste', files: ['C:/a.png'] }, { role: 'textbox', name: 'Message' })).toMatch(/uploading/)
    expect(confirmReason({ action: 'paste', text: 'hello' }, { role: 'textbox', name: 'Message' })).toBeNull()
    expect(confirmReason({ action: 'dblclick' }, { role: 'button', name: 'Send' })).toMatch(/may send/)
    expect(confirmReason({ action: 'rightclick' }, { role: 'button', name: 'Send' })).toBeNull()
    expect(confirmReason({ action: 'drag' }, { role: 'slider', name: 'Volume' })).toBeNull()
  })
})
