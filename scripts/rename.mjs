// Renames the product everywhere it is written: node scripts/rename.mjs "Name" slug [--new-key]
//   Name   shown to people (side panel, control room, approval cards), e.g. "Squire"
//   slug   CLI command, MCP server name, ~/.slug folder, env prefix (SLUG_PORT), e.g. squire
//   --new-key  also gives the extension a new id (a new product should not share the old one)
// Prints every file it changed. Run the tests afterwards: npm test && npm run e2e
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, slug, flag] = process.argv.slice(2)
if (!name || !slug || !/^[a-z][a-z0-9-]{1,20}$/.test(slug)) {
  console.error('usage: node scripts/rename.mjs "Name" slug [--new-key]   (slug: lowercase letters, digits, dash)')
  process.exit(2)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV = slug.toUpperCase().replace(/-/g, '_')

const brandText = readFileSync(join(root, 'src/brand.ts'), 'utf8')
const cur = {
  name: /name: '([^']+)'/.exec(brandText)[1],
  slug: /slug: '([^']+)'/.exec(brandText)[1],
  env: /env: '([^']+)'/.exec(brandText)[1],
}

const changed = []
function edit(file, fn) {
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  const after = fn(before)
  if (after !== before) { writeFileSync(path, after); changed.push(file) }
}

edit('src/brand.ts', s => s
  .replace(/name: '[^']+'/, `name: '${name}'`)
  .replace(/slug: '[^']+'/, `slug: '${slug}'`)
  .replace(/env: '[^']+'/, `env: '${ENV}'`)
  .replace(/group: '[^']+'/, `group: '${name}'`))
edit('src/daemon/auth.ts', s => s.replace(/COOKIE = '[^']+'/, `COOKIE = '${slug.replace(/-/g, '_')}_room'`))
for (const f of ['src/daemon/core.test.ts', 'src/daemon/server.test.ts']) edit(f, s => s.replaceAll(`${cur.slug.replace(/-/g, '_')}_room`, `${slug.replace(/-/g, '_')}_room`))
edit('extension/background.js', s => s.replace(/const BRAND = '[^']+'/, `const BRAND = '${name}'`))
edit('extension/sidepanel.html', s => s.replaceAll(`<title>${cur.name}</title>`, `<title>${name}</title>`).replaceAll(`id="brand">${cur.name}<`, `id="brand">${name}<`).replaceAll(`${cur.slug} open`, `${slug} open`))
edit('extension/sidepanel.js', s => s.replaceAll(`"${cur.slug} start"`, `"${slug} start"`))
edit('extension/manifest.json', s => { const m = JSON.parse(s); m.name = name; m.action.default_title = name; return JSON.stringify(m, null, 2) + '\n' })
edit('package.json', s => { const p = JSON.parse(s); p.name = slug; p.bin = { [slug]: 'dist/cli.mjs' }; return JSON.stringify(p, null, 2) + '\n' })
edit('ui/main.tsx', s => s.replaceAll(`useState('${cur.name}')`, `useState('${name}')`).replaceAll(`${cur.slug} open`, `${slug} open`).replaceAll(`${cur.slug} setup`, `${slug} setup`).replaceAll(`~/.${cur.slug}/`, `~/.${slug}/`))
for (const f of ['e2e/run.mjs', 'e2e/bridge.ts']) edit(f, s => s.replaceAll(`${cur.env}_`, `${ENV}_`))

if (flag === '--new-key') {
  const { key, id } = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/new-extension-key.mjs')], { encoding: 'utf8' }))
  edit('extension/manifest.json', s => { const m = JSON.parse(s); m.key = key; return JSON.stringify(m, null, 2) + '\n' })
  edit('src/bridge/bridge.ts', s => s.replace(/PINNED_IDS = \['[a-p]{32}'\]/, `PINNED_IDS = ['${id}']`))
  edit('src/bridge/bridge.test.ts', s => s.replace(/chrome-extension:\/\/[a-p]{32}', ''\)\)\.toBe\(true\)/, `chrome-extension://${id}', '')).toBe(true)`))
  console.log(`new extension id: ${id}`)
}

console.log(`renamed ${cur.name} (${cur.slug}) → ${name} (${slug}); env prefix ${ENV}_`)
for (const f of changed) console.log(`  ${f}`)
console.log('\nStill by hand: README/docs wording, the extension icons, and the folder name if wanted.')
