# Build plan: core to 100 %, then packaging + naming

Name **Tabgeist** (chosen 2026-10-30; was the working name BAS), CLI `tabgeist`, home `~/.tabgeist`.
Everything brand-related lives in `src/brand.ts` and the extension strings (`scripts/rename.mjs`).

**Promise:** any AI agent works in your own signed-in Chrome/Edge; risky steps wait for your
click and the agent cannot skip it; every step leaves a receipt; what worked once becomes a
routine that replays without a model, runs API-first, and heals itself when the site changes,
with your approval.

## Architecture

```
agent (Claude Code, Codex, Cursor)
  └─ `tabgeist mcp` (stdio MCP)  ──HTTP + token──▶  tabgeist daemon (127.0.0.1:47900, always on)
                                                ├─ /extension  WebSocket ◀── MV3 extension (paired)
                                                ├─ /rpc        tools (browser, routines, sites, heal)
                                                ├─ /api,/events control room data + live SSE
                                                └─ /           control room UI (local web)
~/.tabgeist/  token · paired.json · settings.json · timeline/*.jsonl · shots/ · sites/<site>/{routines/*.yaml, policy.yaml, memory.md, health.json} · packs/<name>/ · heal/*.json
```

## Milestones (each ends green: typecheck, unit tests, e2e)

### M1: Daemon, auth, pairing, MCP shim, CLI
- [x] daemon HTTP server: extension WS, `/rpc` (bearer token), UI auth (cookie from a one-time login link), Host/Origin checks against DNS rebinding and CSRF
- [x] extension pairing: an unpaired browser gets a 6-digit code, the user approves in the control room, and the extension keeps a pair token
- [x] `tabgeist mcp`: stdio MCP that talks to the daemon, starts it when it is not running, names its client (agent) for the timeline and leases
- [x] CLI: start, stop, status, open, mcp, setup, routines, run, heal, call (pairing is approved only in the control room, on purpose; canaries run by themselves; replay export is in the control room)
- [x] tab leases: one agent per tab at a time, others queue (30 s) or get "leased by X"

### M2: Safety
- [x] multilingual risk words + structural checks (form with password/payment fields)
- [x] richer approval cards: element, typed text, files, site, agent (form field values: later)
- [x] scoped grants: once / this action on this site for 15 min (max N) / deny
- [x] per-site `policy.yaml`: block / ask / allow rules, rate limits ("send: 3/h"), allowed outbound domains
- [x] exfiltration gate (Fetch interception): cross-site writes and any request carrying a fogged secret or read text are held for approval
- [x] navigation gate: a URL carrying a secret or a long chunk of read text asks first
- [x] secret fog: cards, keys, tokens, one-time codes in read/snapshot become `{{secret:N}}`; typed back only on the site they came from
- [x] prompt-injection cleaning in read (hidden text, zero-width characters, comments)
- [x] extension: CDP method allow-list, no `identity.email`

### M3: Learning
- [x] fingerprint v2 + Scrapling-style similarity relocation (no LLM) after exact refind fails
- [x] routine format v2 (YAML): goto / act / api / read / wait / expect, params, capabilities
- [x] record → save routine (with parameters) from what the agent just did
- [x] API compiler: same-site GET data requests seen during a run become `api` steps, API first, UI fallback
- [x] shadow mode: run with every write blocked and risky steps skipped, report "would have"
- [x] verified end state: `expect` on routines and on `chrome_act`
- [x] self-heal: relocation → heal ticket (evidence) → agent proposes a fix → shadow test → user replaces in the control room (versioned, rollback)
- [x] canary: read-only routines on a schedule, site health
- [x] site memory: notes per site, shown to the agent on first touch

### M4: Observability
- [x] timeline (JSONL per day): every call, agent, tab, site, receipt, approvals, screenshot after acts
- [x] replay export: one self-contained, redacted HTML file per session

### M5: Control room UI + side panel
- [x] control room (Preact, night theme, amber): Live, Approvals, Timeline/replay, Sites (routines, policy, memory, health), Heal queue, Settings (pairing, grants, browsers)
- [x] side panel redesign in the same theme: pairing code, rich approvals with grant choices, questions, agent tabs, live log, link to the control room

### M6: Quality
- [x] unit tests for every new module
- [x] e2e scenarios for every feature (pairing, gates, fog, routines, relocation, API compile, shadow, heal, canary, timeline, UI smoke)
- [x] soak run, then fix flakes
- [x] docs/architecture.md and threat model updated

### Later (after the core)
Packaging (README, docs site, agent skill, `server.json`, npm, Web Store), naming, logo,
Electron + multi-account.

## Status (2026-10-29)
Core done: 127 unit tests, 30 e2e scenarios, soak 3x30 = 90/90 green, typecheck clean.
Left for later by choice: packaging (README, docs site, agent skill, server.json, npm, Web Store),
the final name (`node scripts/rename.mjs "Name" slug --new-key`), logo, Electron + multi-account.
