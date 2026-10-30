// Fixture pages for the end-to-end suite: one page per hard web pattern.
// Served on two origins (127.0.0.1 and localhost) so a frame from the other one
// is a real cross-site iframe. Every page writes what happened into #out, which
// the scenarios read back to check the action really landed.
import { createServer } from 'node:http'
import { CORE_PAGES, coreRoute } from './site-core.mjs'

const shell = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui,sans-serif;margin:20px}button{margin:4px}#out{padding:6px;background:#eef}
.tile{display:inline-block;width:90px;height:70px;margin:4px;background:#ccd;text-align:center;line-height:70px}
.layer{position:fixed;inset:60px auto auto 60px;background:#fff;border:1px solid #888;padding:12px}
</style></head><body><h1>${title}</h1>${body}<p id="out">nothing yet</p>
<script>const out = t => { document.getElementById('out').textContent = t }
${script}</script></body></html>`

export const PAGES = {
  ...CORE_PAGES,
  '/': shell('Fixtures', '<p>Tabgeist end-to-end fixtures.</p>'),

  '/form': shell('Form', `
    <form onsubmit="event.preventDefault(); out('saved ' + new FormData(this).get('name') + ' / ' + this.city.value + ' / ' + this.terms.checked)">
      <label>Full name <input name="name"></label>
      <label>City <select name="city"><option>Lahore</option><option>Karachi</option><option>Multan</option></select></label>
      <label><input type="checkbox" name="terms"> I agree</label>
      <button>Save draft</button>
    </form>
    <label>Notes <textarea id="notes" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();out('enter: '+this.value)}"></textarea></label>`),

  '/shadow': shell('Shadow DOM', `<search-box aria-label="Search products"></search-box>`, `
    customElements.define('search-box', class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' })
        r.innerHTML = '<input><button>Go</button>'
        r.querySelector('button').onclick = () => out('searched ' + r.querySelector('input').value)
      }
    })`),

  '/frames': shell('Frames', `
    <iframe title="Same site" src="/frame-inner" width="320" height="110"></iframe>
    <iframe title="Other site" id="xs" width="320" height="110"></iframe>`, `
    document.getElementById('xs').src = location.protocol + '//' + (location.hostname === 'localhost' ? '127.0.0.1' : 'localhost') + ':' + location.port + '/frame-inner'
    addEventListener('message', e => out('frame says ' + e.data))`),
  '/frame-inner': `<!doctype html><body><button onclick="parent.postMessage(location.hostname + ' clicked', '*')">Press inside frame</button></body>`,

  // 200 rows, only the ones on screen exist in the DOM (like WhatsApp, Slack, X).
  '/virtual': shell('Virtual list', `<div id="box" role="list" aria-label="Messages" style="height:300px;overflow:auto;position:relative;border:1px solid #999">
      <div id="spacer" style="height:6000px"></div></div>`, `
    const box = document.getElementById('box'), H = 30, N = 200
    const draw = () => {
      for (const r of [...box.querySelectorAll('.row')]) r.remove()
      const first = Math.floor(box.scrollTop / H), last = Math.min(N, first + 12)
      for (let i = first; i < last; i++) {
        const d = document.createElement('div'); d.className = 'row'; d.setAttribute('role', 'listitem')
        d.style.cssText = 'position:absolute;top:' + i * H + 'px;height:' + H + 'px'
        d.textContent = 'Message ' + (i + 1) + ' of ' + N
        box.appendChild(d)
      }
    }
    box.onscroll = draw; draw()`),

  // Tiles with no listener of their own: the grid catches the click (event delegation).
  '/gallery': shell('Gallery', `<div id="grid" role="list" aria-label="Media">${
    Array.from({ length: 8 }, (_, i) => `<div class="tile" role="listitem">${i % 2 ? `<img alt="Photo ${i + 1}" src="/pic.svg?${i}" width="60">` : `0:${10 + i}`}</div>`).join('')}</div>`, `
    document.getElementById('grid').addEventListener('click', e => {
      const t = e.target.closest('.tile'); if (t) out('opened tile ' + ([...t.parentNode.children].indexOf(t) + 1))
    })`),

  // A dialog with a menu open inside it, and a listbox on the page under both.
  '/layers': shell('Layers', `
    <div role="listbox" aria-label="Sort order" style="width:200px"><div role="option">Newest</div><div role="option">Oldest</div></div>
    <button onclick="document.getElementById('dlg').hidden=false">Open settings</button>
    <div id="dlg" role="dialog" aria-label="Settings" class="layer" hidden style="width:360px;height:220px">
      <button onclick="document.getElementById('mnu').hidden=false">More options</button>
      <div id="mnu" role="menu" aria-label="Options" class="layer" hidden style="inset:120px auto auto 120px;z-index:2">
        <div role="menuitem" tabindex="-1" onclick="out('picked Rename')">Rename</div>
        <div role="menuitem" tabindex="-1" onclick="out('picked Duplicate')">Duplicate</div>
      </div>
    </div>`),

  // The file starts seconds after the click, like WhatsApp decrypting a video or a server building a zip.
  '/download': shell('Download', `<button onclick="out('preparing'); setTimeout(() => { const a = document.createElement('a'); a.href = '/report.csv'; a.download = 'report.csv'; document.body.appendChild(a); a.click(); out('started') }, 4000)">Download report</button>
    <p><img id="logo" alt="Company logo" src="/pic.svg?logo" width="80"></p>`),

  '/drag': shell('Drag and drop', `
    <label>Volume <input type="range" min="0" max="10" value="0" oninput="out('volume ' + this.value)" style="width:300px"></label>
    <div id="drop" aria-label="Drop files here" role="region" style="margin-top:20px;width:300px;height:100px;border:2px dashed #888">Drop files here</div>
    <ul><li draggable="true" id="a" aria-label="Card A">Card A</li><li id="lane" aria-label="Done lane" style="height:50px;border:1px solid #aaa">Done lane</li></ul>`, `
    const drop = document.getElementById('drop')
    drop.ondragover = e => e.preventDefault()
    drop.ondrop = e => { e.preventDefault(); out('dropped ' + [...e.dataTransfer.files].map(f => f.name).join(',')) }
    document.getElementById('a').ondragstart = e => e.dataTransfer.setData('text/plain', 'Card A')
    const lane = document.getElementById('lane')
    lane.ondragover = e => e.preventDefault()
    lane.ondrop = e => { e.preventDefault(); out('moved ' + e.dataTransfer.getData('text/plain') + ' to Done') }`),

  // Nothing here has a role or a ref: only a point on the picture can be clicked.
  '/canvas': shell('Canvas', `<canvas id="c" width="300" height="200" style="border:1px solid #000"></canvas>`, `
    const c = document.getElementById('c'), g = c.getContext('2d')
    g.fillStyle = '#d33'; g.beginPath(); g.arc(220, 100, 30, 0, 7); g.fill()
    c.onclick = e => { const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
      out(Math.hypot(x - 220, y - 100) < 30 ? 'hit the red dot' : 'missed at ' + Math.round(x) + ',' + Math.round(y)) }
    c.oncontextmenu = e => { e.preventDefault(); out('context menu on canvas') }`),

  // The label shrinks a moment after load, as chat rows do when their preview text changes.
  '/live': shell('Live labels', `<button id="b" onclick="out('opened chat')">Sara Khan, 3 unread messages, click to open</button>
    <button id="d" ondblclick="out('double clicked')">Edit title</button>`, `
    setTimeout(() => { document.getElementById('b').textContent = 'Sara Khan' }, 1500)`),

  // Outbound buttons: the engine must stop and ask before these run.
  '/risky': shell('Risky', `<textarea aria-label="Message"></textarea>
    <button onclick="out('message sent')">Send</button>
    <button onclick="out('item deleted')">Delete item</button>
    <button onclick="out('opened picker')">Choose a GIF</button>`),

  '/hover': shell('Hover', `<style>#m{display:none}#h:hover #m{display:block}</style>
    <div id="h" style="width:220px"><button>Account menu</button><div id="m"><a href="#settings" onclick="out('settings opened')">Settings page</a></div></div>`),

  // Text that arrives late, and a spinner that goes away: for wait conditions.
  '/slow': shell('Slow', `<button onclick="document.getElementById('sp').hidden=false; setTimeout(() => { document.getElementById('sp').hidden=true; out('Order ready') }, 2500)">Prepare order</button>
    <p id="sp" hidden>Loading…</p>`),

  '/paste': shell('Paste', `<div id="box" contenteditable="true" aria-label="Compose" style="min-height:60px;border:1px solid #888"></div>`, `
    document.getElementById('box').addEventListener('paste', e => {
      const files = [...e.clipboardData.files].map(f => f.name + ' ' + f.type)
      out(files.length ? 'pasted file ' + files.join(',') : 'pasted text ' + e.clipboardData.getData('text/plain'))
    })`),

  '/long': shell('Long page', Array.from({ length: 1500 }, (_, i) => `<p><a href="#p${i}">Link ${i}</a> <button>Action ${i}</button></p>`).join('')),
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#69c"/></svg>'

export function startSite(port = 0) {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (await coreRoute(req, res, path)) return
    if (path === '/report.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' })
      return res.end('a,b\n1,2\n')
    }
    if (path === '/pic.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(SVG) }
    const page = PAGES[path]
    if (!page) { res.writeHead(404); return res.end('no fixture ' + path) }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  // Loopback only: the fixtures are for this machine's browser.
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}
