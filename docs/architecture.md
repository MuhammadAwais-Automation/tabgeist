# Architecture and threat model

## Pieces

| Piece | Where | Job |
|---|---|---|
| Extension (MV3) | `extension/` | Runs the daemon's tab and DevTools requests in the user's own browser profile; side panel for pairing, approvals, questions, live log |
| Daemon | `src/daemon/`, `src/main.ts` | Always on at `127.0.0.1:47900`: the extension's WebSocket, agents' `/rpc`, the control room (`/`, `/api`, `/events`) |
| Engine | `src/engine/` | Reads pages (accessibility tree + DOM snapshot), acts like a person (CDP input), receipts, routines' element finding |
| Safety | `src/safety/` | Secret fog, exfiltration watch and network gate, site rules and limits, navigation checks |
| Learning | `src/routines/`, `src/sites/` | Routine format, runner (API-first, similarity relocation, dry runs, expectations), heal tickets, canaries, site notes |
| Packs | `src/sites/packs.ts`, `packs/` | One folder per site: `pack.json`, `adapter.js` (reads the app's own data in the page), `notes.md`, `routines/`. Shipped ones in `packs/`, the user's in `~/.tabgeist/packs` (`tabgeist pack add <folder>`). The user's own files in `sites/<site>/` win over the pack |
| MCP shim | `src/mcp/` | `tabgeist mcp`: one per agent, forwards tools to the daemon and starts it when needed |
| Control room | `ui/` | Live, approvals, timeline and replay export, sites (routines, rules, notes, health), heal queue, settings |

Everything the system keeps is a plain file under `~/.tabgeist`: `token`, `paired.json`, `settings.json`,
`timeline/<day>.jsonl`, `shots/`, `sites/<site>/{policy.yaml, memory.md, adapter.js, routines/, health.json}`, `packs/<name>/` (+ `.history/`), `heal/`.

## A risky step, end to end

1. The agent calls `browser_act` with a click on `button "Send"`.
2. The daemon takes the tab's lease (one agent per tab) and reveals any `{{secret:N}}` that belongs to this site.
3. The engine checks that the ref still names the same element. Then it asks, in order: the site's rules (block, ask, allow), the built-in checks (risk words in 14 languages, forms holding passwords or cards, Enter in a message box).
4. A risky step stops with `needsConfirm`. The daemon asks the user in the side panel and the control room (and with a notification), unless a live grant covers this kind of step on this site. The site's limits count every approved step.
5. The step runs under the network gate. A request that carries a fogged secret, or text read on another site, waits for the user. In a dry run every write is blocked.
6. The receipt (what changed, announcements, downloads, held requests) goes back to the agent. The timeline records the call, the agent, the approvals and a picture.

## Threat model

**Protected against:**

- **A web page talking to the daemon.** Only the pinned extension origin may open the WebSocket, and every HTTP request must carry `Host: 127.0.0.1:<port>`, which defeats DNS rebinding. The control room's writes need its own origin and its cookie.
- **A local program posing as the extension.** The manifest key is public, so the origin check is not enough. A browser is also paired: its 6-digit code must be approved in the control room. Unpaired sockets can only say hello.
- **An agent approving its own steps.** Approvals, pairing, grants, rules and heal decisions are room-only methods. Agents reach `/rpc` with the token, and that path cannot call them. Agents cannot open, read or click the control room tab, and the login link is never printed where they read it.
- **Prompt injection that tries to move data.**
  - Text read on one site cannot go to another site without a yes: addresses are checked, and so are requests made during acts.
  - A fogged secret only types back on its own site.
  - Hidden page text (see-through, microscopic, off screen, aria-hidden, zero-width or bidi characters) never reaches the agent.
- **An agent planting code in the page.** Adapters run in the page with the user's session, so only code the user put on disk runs: shipped packs, `tabgeist pack add` (a terminal command, no daemon method) and `sites/<site>/adapter.js`. Agents can call an adapter's ops but never send code.
- **A broken or changed site.** Routines find elements by attribute, then role and name, then similarity. A miss opens a heal ticket instead of a guess. Fixes are dry-run, and only the user replaces a routine.

**Out of scope (documented, not solved):**

- **Malware running as the user.** It can read `~/.tabgeist/token`, the extension's storage or the browser's cookies directly.
- **A page that leaks data by itself** (its own scripts) while an agent only reads.
- **WebSocket frames.** They cannot be held, so chat apps that send over a socket rely on the step approval, which always comes first.
- **Requests from cross-site iframes.** The network gate watches the page's own session; the iframe's own session is not intercepted.
