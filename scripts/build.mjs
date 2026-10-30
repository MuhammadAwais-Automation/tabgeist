// Builds dist/cli.mjs (the daemon, the MCP shim and the CLI in one file; packages
// stay in node_modules) and dist/ui (the control room). Run: npm run build
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ui = join(root, 'dist', 'ui')

await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: join(root, 'dist', 'cli.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
  banner: { js: '#!/usr/bin/env node' }, logLevel: 'warning',
})

mkdirSync(ui, { recursive: true })
await build({
  entryPoints: [join(root, 'ui', 'main.tsx')],
  outfile: join(ui, 'app.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome120', minify: true,
  jsx: 'automatic', jsxImportSource: 'preact', logLevel: 'warning',
})
for (const f of ['index.html', 'app.css', 'favicon.png', 'icon-128.png']) copyFileSync(join(root, 'ui', f), join(ui, f))

// One design system for both faces: the tokens and fonts go to the control room and the extension.
const fonts = { 'overpass.woff2': '@fontsource-variable/overpass/files/overpass-latin-wght-normal.woff2', 'overpass-mono.woff2': '@fontsource-variable/overpass-mono/files/overpass-mono-latin-wght-normal.woff2' }
for (const dir of [ui, join(root, 'extension')]) {
  mkdirSync(join(dir, 'fonts'), { recursive: true })
  copyFileSync(join(root, 'design', 'tokens.css'), join(dir, 'tokens.css'))
  for (const [name, from] of Object.entries(fonts)) copyFileSync(join(root, 'node_modules', from), join(dir, 'fonts', name))
}
console.log('built dist/cli.mjs and dist/ui')
