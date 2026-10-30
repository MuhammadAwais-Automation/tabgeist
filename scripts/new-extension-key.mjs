// Makes a new manifest `key` (public key only) and prints the extension id it pins.
// The id is what src/bridge/bridge.ts PINNED_IDS lists. Run once per product name.
import { createHash, generateKeyPairSync } from 'node:crypto'
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const der = publicKey.export({ type: 'spki', format: 'der' })
const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('')
console.log(JSON.stringify({ key: der.toString('base64'), id }))
