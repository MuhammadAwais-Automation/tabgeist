// End-to-end scenarios: each opens a fixture page in the test Chrome, works it only
// through the agent's own tools (chrome.snapshot / read / act / ...), and checks
// the page's #out line to prove the action really happened.
//
// `feature: true` marks a scenario for a capability that is still being built;
// it runs with --features and is reported apart from the regular suite.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SCENARIOS = [
  {
    name: 'form: type, select, check, submit, Enter key',
    async run(h) {
      const t = await h.open('/form')
      const s = await h.snap(t)
      const r = await h.act(t, { steps: [
        { action: 'type', ref: h.ref(s, 'textbox', 'Full name'), text: 'Ali Raza' },
        { action: 'select', ref: h.ref(s, 'combobox', 'City'), value: 'Karachi' },
        { action: 'click', ref: h.ref(s, 'checkbox', 'I agree') },
        { action: 'click', ref: h.ref(s, 'button', 'Save draft') },
      ] })
      h.ok(r.receipt.ok, `act failed: ${r.receipt.error}`)
      await h.expectOut(t, 'saved Ali Raza / Karachi / true')
      // Enter may send a message: it asks first.
      const e = await h.act(t, { steps: [{ action: 'type', ref: h.ref(s, 'textbox', 'Notes'), text: 'hello' }, { action: 'key', key: 'Enter' }] }, 'allow')
      h.ok(e.asked.length === 1, `Enter should ask first (asked ${e.asked.length})`)
      await h.expectOut(t, 'enter: hello')
    },
  },
  {
    name: 'shadow DOM: input named from its host',
    async run(h) {
      const t = await h.open('/shadow')
      const s = await h.snap(t)
      await h.act(t, { steps: [{ action: 'type', ref: h.ref(s, 'textbox', 'Search products'), text: 'shoes' }, { action: 'click', ref: h.ref(s, 'button', 'Go') }] })
      await h.expectOut(t, 'searched shoes')
    },
  },
  {
    name: 'frames: same-site and cross-site iframe buttons',
    async run(h) {
      const t = await h.open('/frames')
      const s = await h.snap(t)
      const refs = h.refs(s, 'button', 'Press inside frame')
      h.ok(refs.length === 2, `expected 2 frame buttons, saw ${refs.length}`)
      const seen = []
      for (const ref of refs) {
        const r = await h.act(t, { action: 'click', ref })
        h.ok(r.receipt.ok, `click in frame failed: ${r.receipt.error}`)
        seen.push(await h.untilOut(t, o => o.startsWith('frame says') && !seen.includes(o)))
      }
      h.ok(seen.some(o => o.includes('127.0.0.1')) && seen.some(o => o.includes('localhost')), `frames answered: ${seen.join(' | ')}`)
    },
  },
  {
    name: 'virtual list: every row once, in order',
    async run(h) {
      const t = await h.open('/virtual')
      const r = await h.rpc('browser.read', { tab: t, region: 'Messages', load: 'more', pages: 30, maxChars: 100000 })
      h.ok(r.ok, r.error)
      const lines = r.text.split('\n').filter(l => /^Message \d+ of 200$/.test(l))
      const missing = [], twice = []
      for (let k = 1; k <= 200; k++) {
        const n = lines.filter(l => l === `Message ${k} of 200`).length
        if (n === 0) missing.push(k); else if (n > 1) twice.push(k)
      }
      h.ok(!missing.length && !twice.length, `missing ${missing.slice(0, 10)} (${missing.length}), twice ${twice.slice(0, 10)} (${twice.length})`)
      h.ok(lines.every((l, i) => l === `Message ${i + 1} of 200`), 'rows out of order')
    },
  },
  {
    name: 'gallery: tiles whose click the grid catches',
    async run(h) {
      const t = await h.open('/gallery')
      const s = await h.snap(t)
      h.ok(s.includes('click via parent'), 'tiles not listed as click via parent')
      await h.act(t, { action: 'click', ref: h.ref(s, 'listitem', 'Photo 4') })
      await h.expectOut(t, 'opened tile 4')
    },
  },
  {
    name: 'layers: within popup is the menu on top, not the dialog or listbox',
    async run(h) {
      const t = await h.open('/layers')
      let s = await h.snap(t)
      await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Open settings') })
      s = await h.snap(t)
      await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'More options') })
      const w = await h.rpc('browser.snapshot', { tab: t, within: 'popup' })
      h.ok(w.ok, w.error)
      h.ok(w.text.includes('Rename') && !w.text.includes('Newest') && !w.text.includes('More options'), `popup listed:\n${w.text}`)
      await h.act(t, { action: 'click', ref: h.ref(w.text, 'menuitem', 'Rename') })
      await h.expectOut(t, 'picked Rename')
    },
  },
  {
    name: 'download: a file that starts 4 s after the click is in the receipt',
    async run(h) {
      const t = await h.open('/download')
      const s = await h.snap(t)
      const r = await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Download report') })
      h.ok(r.receipt.downloads?.length >= 1, `no download in receipt (warning: ${r.receipt.warning ?? '-'})`)
      const d = await h.rpc('browser.download', { tab: t, url: `${h.site}/pic.svg?e2e` })
      h.ok(d.ok && d.bytes > 0, `chrome.download: ${d.error}`)
    },
  },
  {
    name: 'drag and drop: slider, files onto a drop zone',
    async run(h) {
      const t = await h.open('/drag')
      const s = await h.snap(t)
      await h.act(t, { action: 'click', ref: h.ref(s, 'slider', 'Volume') })
      await h.untilOut(t, o => /^volume \d+$/.test(o))
      const file = join(h.tmp, 'e2e-drop.txt')
      writeFileSync(file, 'drop me')
      const box = await h.rect(t, '#drop')
      const r = await h.act(t, { action: 'drop', x: box.x + 50, y: box.y + 50, files: [file] }, 'allow')
      h.ok(r.asked.length === 1, `drop should ask first (asked ${r.asked.length})`)
      await h.expectOut(t, 'dropped e2e-drop.txt')
    },
  },
  {
    name: 'html5 drag: card onto a lane (native draggable)',
    async run(h) {
      const t = await h.open('/drag')
      const a = await h.rect(t, '#a'), lane = await h.rect(t, '#lane')
      await h.act(t, { action: 'drag', x: a.x + 10, y: a.y + 5, toX: lane.x + 20, toY: lane.y + 20 })
      await h.expectOut(t, 'moved Card A to Done')
    },
  },
  {
    name: 'canvas: click and right-click at a point',
    async run(h) {
      const t = await h.open('/canvas')
      const c = await h.rect(t, '#c')
      await h.act(t, { action: 'click', x: c.x + 220, y: c.y + 100 })
      await h.expectOut(t, 'hit the red dot')
      await h.act(t, { action: 'rightclick', x: c.x + 50, y: c.y + 50 })
      await h.expectOut(t, 'context menu on canvas')
    },
  },
  {
    name: 'live labels: a label that shrank still clicks; double-click',
    async run(h) {
      const t = await h.open('/live')
      const s = await h.snap(t)
      const b = h.ref(s, 'button', 'Sara Khan')
      await h.sleep(2000)
      const r = await h.act(t, { action: 'click', ref: b })
      h.ok(r.receipt.ok, `click after rename failed: ${r.receipt.error}`)
      await h.expectOut(t, 'opened chat')
      await h.act(t, { action: 'dblclick', ref: h.ref(s, 'button', 'Edit title') })
      await h.expectOut(t, 'double clicked')
    },
  },
  {
    name: 'approvals: Send asks; deny keeps the page, allow runs it; a picker does not ask',
    async run(h) {
      const t = await h.open('/risky')
      const s = await h.snap(t)
      const send = h.ref(s, 'button', 'Send')
      let r = await h.act(t, { action: 'click', ref: send }, 'deny')
      h.ok(!r.receipt.ok && r.asked.length === 1, 'Send ran without asking, or did not report the denial')
      h.ok(await h.out(t) === 'nothing yet', 'Send ran although denied')
      r = await h.act(t, { action: 'click', ref: send, confirm: true }, 'deny')
      h.ok(r.asked.length === 1 && await h.out(t) === 'nothing yet', 'confirm: true from the agent skipped the browser approval')
      r = await h.act(t, { action: 'click', ref: send }, 'allow')
      await h.expectOut(t, 'message sent')
      r = await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Choose a GIF') }, 'deny')
      h.ok(r.asked.length === 0, 'opening a picker asked for approval')
      await h.expectOut(t, 'opened picker')
    },
  },
  {
    name: 'hover: reveal a menu, then click inside it',
    async run(h) {
      const t = await h.open('/hover')
      let s = await h.snap(t)
      await h.act(t, { action: 'hover', ref: h.ref(s, 'button', 'Account menu') })
      s = await h.snap(t)
      await h.act(t, { action: 'click', ref: h.ref(s, 'link', 'Settings page') })
      await h.expectOut(t, 'settings opened')
    },
  },
  {
    name: 'slow page: risky-sounding button asks, result arrives later',
    async run(h) {
      const t = await h.open('/slow')
      const s = await h.snap(t)
      const r = await h.act(t, { action: 'click', ref: h.ref(s, 'button', 'Prepare order') }, 'allow')
      h.ok(r.asked.length === 1, '"order" should ask first')
      await h.act(t, { action: 'wait', ms: 3000 })
      await h.expectOut(t, 'Order ready')
    },
  },
  {
    name: 'wait for: text appears, spinner goes away',
    async run(h) {
      const t = await h.open('/slow')
      const s = await h.snap(t)
      await h.act(t, { steps: [{ action: 'click', ref: h.ref(s, 'button', 'Prepare order') }, { action: 'wait', text: 'Order ready' }] }, 'allow')
      await h.expectOut(t, 'Order ready')
      const r = await h.act(t, { action: 'wait', gone: 'Loading', ms: 5000 })
      h.ok(r.receipt.ok, r.receipt.error)
    },
  },
  {
    name: 'paste: text into a compose box',
    async run(h) {
      const t = await h.open('/paste')
      const s = await h.snap(t)
      await h.act(t, { action: 'paste', ref: h.ref(s, 'textbox', 'Compose'), text: 'hello paste' })
      await h.expectOut(t, 'pasted text hello paste')
    },
  },
  {
    name: 'paste: an image file asks first, then arrives as a pasted file',
    async run(h) {
      const t = await h.open('/paste')
      const s = await h.snap(t)
      const file = join(h.tmp, 'e2e-paste.png')
      writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
      const r = await h.act(t, { action: 'paste', ref: h.ref(s, 'textbox', 'Compose'), files: [file] }, 'allow')
      h.ok(r.asked.length === 1, `pasting a file should ask first (asked ${r.asked.length})`)
      await h.expectOut(t, 'pasted file e2e-paste.png image/png')
    },
  },
  {
    name: 'long page: 3000 controls snapshot in time',
    async run(h) {
      const t = await h.open('/long')
      const r = await h.rpc('browser.snapshot', { tab: t })
      h.ok(r.ok, r.error)
      h.metric('long-page snapshot ms', r.ms)
      h.ok(r.ms < 6000, `snapshot took ${r.ms} ms`)
    },
  },
  {
    name: 'screenshot and read',
    async run(h) {
      const t = await h.open('/form')
      const r = await h.rpc('browser.screenshot', { tab: t })
      h.ok(r.ok && r.bytes > 1000, `screenshot: ${r.error}`)
      const rd = await h.rpc('browser.read', { tab: t, region: 'main' })
      h.ok(rd.ok && rd.text.includes('Full name'), `read: ${rd.error ?? rd.text}`)
    },
  },
]
