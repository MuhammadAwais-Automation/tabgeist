// The real daemon for the end-to-end suite, with the test.* methods on and every
// browser paired without asking (the suite's own throwaway Chrome). Data lives in
// TABGEIST_HOME (a temp folder), never in the user's ~/.tabgeist.
import { join } from 'node:path'
import { createDaemon } from '../src/main'

const port = Number(process.env.TABGEIST_PORT) || 47999
const d = await createDaemon({ port, test: true, autoPair: process.env.TABGEIST_E2E_PAIRING !== 'ask', uiDir: process.env.TABGEIST_UI_DIR || join(process.cwd(), 'dist', 'ui'), canaryCheckMs: 2000 })
console.log(`daemon on ${d.port}`)
