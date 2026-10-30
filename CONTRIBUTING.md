# Contributing to Tabgeist

Thanks for helping. The most useful things right now, in order:

1. **A pack for a site you use.** It needs no changes to Tabgeist itself.
2. **A bug report with a replay.** The control room's timeline can save a session as one HTML file. Read it before attaching: it shows what the agent read and typed.
3. **Fixes to the core** (daemon, extension, control room).

Windows is the tested platform. Reports and fixes for macOS and Linux are very welcome.

## Run it from the source

```bash
git clone https://github.com/MuhammadAwais-Automation/tabgeist && cd tabgeist
npm install
npm run build
node dist/cli.mjs setup    # adds the MCP server and skills to your agents, opens the extensions page
```

Load `extension/` unpacked (Developer mode → Load unpacked) and approve the code in the control room. After you change `extension/`, press reload on its card. After you change `src/`, run `npm run build` and `node dist/cli.mjs stop`; the next agent call starts the new daemon.

## Before a pull request

```bash
npm run typecheck
npm test        # unit tests
npm run e2e     # the real extension in a throwaway Chrome
```

All three must pass. Tests and the e2e run must never touch a real browser profile or `~/.tabgeist`; use temp folders and the throwaway browser the e2e already starts.

## Making a pack

```bash
node dist/cli.mjs pack new example.com packs/example
node dist/cli.mjs pack try packs/example https://example.com/ <op> '{"limit":5}'
```

The rules are in [`skills/tabgeist-pack/SKILL.md`](skills/tabgeist-pack/SKILL.md), and an agent with that skill can do most of the work. In short:

- **Only read.** No op clicks, posts, sends or changes anything. Actions go through `browser_act`, where the user approves them.
- **Same origin only.** Fetch the site's own paths. Never send data elsewhere or load scripts.
- **Plain, small data out**, with a `limit` on every op and errors that say what to do.
- **Bump `version`** in `pack.json` on every change.

Two ways to publish a pack:

- **Your own repository** (`tabgeist-pack-<site>`). People install it with `tabgeist pack add <repo URL>`. Best for sites only some people use, or packs you want to update on your own schedule.
- **A pull request adding it to `packs/`.** It then ships with Tabgeist. Packs here must work logged out on a public page (so the e2e can test them) or come with a clear note on how they were tested. Sites whose terms forbid automation go in `packs/experimental/`, off by default.

## Changes to the core

- Keep the safety model intact: risky steps wait for the user, agents cannot reach the control room, page text is data. If a change touches any of that, say how in the pull request. [`docs/architecture.md`](docs/architecture.md) has the threat model.
- Match the code around you: small functions, plain names, a comment only where the reason is not obvious.
- UI text is short, plain and in sentence case. The design system is in [`design/README.md`](design/README.md).

## Reporting a security problem

Do not open a public issue. Use GitHub's private vulnerability reporting on this repository.
