# Tabgeist: AI agents in your own browser

Open-source system that lets any AI agent work in the user's own signed-in Chrome/Edge:
MV3 extension + always-on local daemon + MCP shim + local web control room + site packs.
How it fits together and the threat model: `docs/architecture.md`.

## Rules
- Brand strings live only in `src/brand.ts` (and the extension's manifest/strings).
- Node 22+, TypeScript strict, ESM. Runtime deps stay few (MCP SDK, ws, yaml, zod); the UI is Preact bundled by esbuild.
- Safety first: risky steps are approved in the browser or the control room, never by the agent. Nothing listens beyond 127.0.0.1. Agents never get a way to run their own code in a page: adapters come only from packs the user installed.
- Packs only read (see `skills/tabgeist-pack/SKILL.md`).
- Every feature ships with unit tests, plus an e2e scenario when it touches the browser (`npm run e2e`, throwaway Chrome profile, never the user's own).
- The look follows `design/README.md` and `design/tokens.css`.

## Commands
`npm test` · `npm run typecheck` · `npm run build` · `npm run e2e` (`--only <name>`, `--soak N`, `--headed`) · `tabgeist pack try <folder> <url> [op] [json]`
