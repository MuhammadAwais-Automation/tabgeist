// Packs extension/ into dist/tabgeist-extension-<version>.zip for the Chrome Web Store / Edge Add-ons.
// The store assigns its own id and refuses a manifest `key`, so the zip has none; the
// unpacked folder keeps it, which pins the id the daemon accepts during development.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ext = join(root, 'extension')
const files = {}
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.md')) continue
    else files[relative(ext, p).replace(/\\/g, '/')] = new Uint8Array(readFileSync(p))
  }
}
walk(ext)

const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
delete manifest.key
files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2))

mkdirSync(join(root, 'dist'), { recursive: true })
const out = join(root, 'dist', `tabgeist-extension-${manifest.version}.zip`)
writeFileSync(out, zipSync(files, { level: 9 }))
console.log(`${out} (${Object.keys(files).length} files). A store build gets its own id: add it to TABGEIST_EXTENSION_IDS.`)
