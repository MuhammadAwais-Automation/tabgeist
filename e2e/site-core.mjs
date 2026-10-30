// Fixture pages for the system's own features: secrets, leaks, rules, routines
// that meet a changed page, API-first data, writes for shadow runs, other languages.

const shell = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui,sans-serif;margin:20px}button{margin:4px}#out{padding:6px;background:#eef}</style></head>
<body><h1>${title}</h1>${body}<p id="out">nothing yet</p>
<script>const out = t => { document.getElementById('out').textContent = t }
${script}</script></body></html>`

/** What the fixture server received last on /api/send (the scenarios read it back). */
export const received = { last: null, count: 0 }

export const CORE_PAGES = {
  '/secrets': shell('Secrets', `<p>Your verification code is 482913.</p><p>Card on file 4111 1111 1111 1111.</p>
    <label>Code <input id="c" aria-label="Code"></label><button onclick="out('verified ' + document.getElementById('c').value)">Verify</button>`),
  '/leak': shell('Inbox', `<main><p>Private note: quarterly revenue for the Lahore office was four point two million rupees this quarter.</p></main>`),
  '/rules': shell('Account', `<button onclick="out('archived')">Archive</button><button onclick="out('account deleted')">Delete account</button><button onclick="out('saved draft')">Save draft</button>`),
  '/shop': shell('Shop', `<div id="form"></div>`, `
    const v = new URLSearchParams(location.search).get('v') || '1'
    const box = document.getElementById('form')
    if (v === '3') box.innerHTML = '<p>We moved search. <a href="/">Browse instead</a></p>'
    else box.innerHTML = '<input aria-label="Product" id="q"> <button id="' + (v === '2' ? 'go-search' : 'search') + '" data-testid="' + (v === '2' ? 'catalog-search' : 'search-btn') + '">' + (v === '2' ? 'Search catalog' : 'Search') + '</button>'
    const b = box.querySelector('button')
    if (b) b.onclick = () => out('results for ' + document.getElementById('q').value)
  `),
  '/prices': shell('Prices', `<button onclick="load()">Load prices</button><ul id="list"></ul>`, `
    async function load() { const r = await fetch('/api/items'); const d = await r.json(); document.getElementById('list').innerHTML = d.items.map(i => '<li>' + i.name + ': ' + i.price + '</li>').join(''); out(d.items.length + ' prices') }
  `),
  '/mail': shell('Mail', `<textarea aria-label="Message"></textarea><button onclick="send()">Send</button>`, `
    async function send() { const text = document.querySelector('textarea').value
      try { const r = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); out(r.ok ? 'sent ' + text : 'failed') } catch { out('blocked') } }
  `),
  '/enviar': shell('Correo', `<button onclick="out('enviado')">Enviar</button><button onclick="out('borrador')">Guardar borrador</button>`),
}

/** Extra routes: JSON for API-first runs, a POST sink for shadow and grant scenarios. */
export async function coreRoute(req, res, path) {
  if (path === '/api/items') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ items: [{ name: 'Tea', price: 350 }, { name: 'Rice', price: 410 }, { name: 'Oil', price: 720 }] }))
    return true
  }
  if (path === '/api/send' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    received.last = body
    received.count++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
    return true
  }
  if (path === '/api/received') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(received))
    return true
  }
  return false
}
