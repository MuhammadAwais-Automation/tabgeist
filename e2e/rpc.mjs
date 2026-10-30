// One call to a running e2e bridge (started with `node e2e/run.mjs --keep`), for poking by hand:
//   node e2e/rpc.mjs chrome.snapshot '{"tab": 123}'      (port: E2E_PORT, default 47999)
const [method, raw] = process.argv.slice(2)
const r = await fetch(`http://127.0.0.1:${process.env.E2E_PORT || 47999}/`, { method: 'POST', body: JSON.stringify({ method, params: raw ? JSON.parse(raw) : {} }) })
const out = await r.json()
console.log(typeof out?.text === 'string' ? `${out.text}\n${JSON.stringify({ ...out, text: undefined })}` : JSON.stringify(out, null, 1))
