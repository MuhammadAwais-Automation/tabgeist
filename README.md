# Tabgeist

**AI agents in your own browser.** Tabgeist lets Claude Code, Codex, Cursor or any MCP agent work in the Chrome or Edge you already use, signed in as you, while you keep the signals: risky steps wait for your click, every step leaves a receipt, and a task that worked once becomes a routine that runs again without the AI.

Everything runs on your computer. Nothing listens beyond `127.0.0.1`, and no page, cookie or password goes to a server of ours. There is no server of ours.

<!-- demo: 60 s video goes here -->

## Why another browser tool

Most browser agents start a fresh, logged-out browser, or drive yours with nobody watching. Tabgeist was built around three questions:

| | Usual browser agents | Tabgeist |
|---|---|---|
| **Which browser?** | A new headless one: log in again, solve captchas | Your own Chrome or Edge, every account already signed in. Agent tabs sit in their own tab group |
| **Who decides?** | The agent, or a prompt that asks it nicely | You. Send, post, pay, delete and upload wait for your click in the browser. The agent cannot approve, and a denied step stays denied |
| **What happens next time?** | The AI does every click again | Save it once as a routine. It replays without the AI, through the site's own data calls where it can. When the site changes a little it finds its way; when it changes a lot, the agent proposes a fix and you decide |

## What the agent gets

| Tool | What it does |
|---|---|
| `browser_tabs`, `browser_open`, `browser_navigate`, `browser_close_tab` | Find or open tabs |
| `browser_snapshot` | The page as a short map of controls with refs (`within: "popup"` for menus) |
| `browser_read` | The text people see. `data: true` gives the JSON the site fetched, or a **pack** op: the app's own data |
| `browser_act` | Click, type, select, drag, upload, like a person (real mouse and keys) |
| `browser_screenshot`, `browser_download`, `browser_ask_user` | Pictures, files, and questions only you can answer (codes, PINs) |
| `routine_save`, `routine_run`, `routine_list` | Turn what worked into a routine; run it again |
| `site_notes`, `site_note` | What earlier agents learned about a site, and your rules for it |
| `heal_list`, `heal_propose` | Routines a site change broke, and fixes the agent proposes (you decide) |

## Install

Windows 10/11, Node 22+, Chrome or Edge. macOS and Linux should work but are not tested yet.

```bash
npm install -g tabgeist
tabgeist setup
```

From the source instead: `git clone https://github.com/MuhammadAwais-Automation/tabgeist`, then `npm install`, `npm run build`, `node dist/cli.mjs setup`.

`setup` adds Tabgeist to Claude Code, Codex and Cursor (whichever you have), installs its two skills, starts the daemon and opens your browser's extensions page with the extension folder on your clipboard. Then, once:

1. Turn on **Developer mode** → **Load unpacked** → paste the folder.
2. The side panel shows a 6-digit code: approve it in the control room that `setup` opened.
3. Restart your agent and ask it to do something in your browser.

`tabgeist update` installs the newest version and runs `setup` again. Run `setup` again any time; it only changes what is missing.

## Packs: a site's own data, not the screen

Reading the screen is slow and lossy: a page shows what fits, a feed loads as you scroll. Most apps already hold the exact data. A **pack** is a small folder per site that reads it, so the agent gets clean rows in one call and the tab does not move.

| Pack | Reads |
|---|---|
| `youtube` | a video's details, search results, the videos on any page (home, channel, playlist, subscriptions) |
| `hackernews` | story lists, whole comment threads |
| `whatsapp` *(experimental, add it yourself)* | chats and messages without opening them, so they stay unread |

```bash
tabgeist pack                              # packs in use
tabgeist pack new <site> [folder]          # start one, with your saved routines for that site
tabgeist pack try <folder> <url> [op]      # run it on a public page, in a throwaway browser
tabgeist pack add <folder | git URL>       # install or update one
```

Packs only read. Any action still goes through the normal tools and your click. Packs are code that runs in your page, so they come only from you: the ones that ship with Tabgeist, and folders or repositories you add. An agent can call a pack's ops, but it can never install a pack or send its own code. Your own rules, notes and routines for a site always win over its pack.

### Make your own, share it

1. `tabgeist pack new linkedin.com` starts a folder: `pack.json`, a starter `adapter.js`, `notes.md`, and the routines you saved for that site.
2. Ask your agent to fill it in. The `tabgeist-pack` skill teaches it to find where the data lives, write the ops, and test them with `pack try`.
3. `tabgeist pack add <folder>` to use it yourself.
4. To share it, push the folder to a public GitHub repository. Anyone can then run `tabgeist pack add https://github.com/you/tabgeist-pack-linkedin`. Read a pack's `adapter.js` before you add someone else's: it runs in your signed-in pages.

Routines travel the same way: a pack's `routines/` folder. Read yours before sharing, since a routine can hold values you typed.

WhatsApp's terms forbid automation, and accounts have been banned for unofficial clients. The WhatsApp pack only reads, but your account is your risk. That is why it is not on by default.

## Numbers

Measured by `node e2e/run.mjs --bench` in a throwaway Chrome, logged out. Characters are what the agent's model has to read; a token is about four.

| Task | Way | Calls | Size | Time | Got |
|---|---|---|---|---|---|
| Hacker News front page | screen text | 1 | 4.5k chars | 15 ms | 29/30 stories |
| | page map | 1 | 5.8k | 0.25 s | 20/30 |
| | **pack** | 1 | 5.5k | 0.3 s | **30/30**, with ids, links, exact points |
| A 150-comment HN thread | open + read by scrolling | 2 | 32.7k | 4.0 s | 150/150 |
| | **pack** | 1 | 31.8k | **0.7 s** | 150/150, with depth |
| YouTube search, 20 results | screen text | 1 | 7.7k | 0.4 s | 10/20 |
| | page map | 1 | 3.9k | 0.3 s | 4/20 |
| | **pack** | 1 | **3.5k** | 1.1 s | **18–20/20**, with channel, views, length |
| A two-step form task | agent: look, act, check | 3 | 0.7k | 1.7 s | 3 model turns |
| | **routine** | 1 | 0.4k | 2.0 s | **no model turns** when you or a schedule run it |

The honest reading: a pack is not always smaller than the screen, but it is complete, exact and often much faster. The big saving is routines. A model turn re-reads the whole conversation, so a task the agent never has to think about again costs nothing the next hundred times.

## Safety

- **Approvals the agent cannot skip.** Risky steps are found by what they do (the button's words in many languages, the form, the network request), not by asking the agent. They wait for your click in the browser or the control room. Agents cannot open, read or click the control room.
- **Your rules per site.** `block`, `ask`, `allow`, limits like `send: 5/h`, which other domains a site may send data to, and `never_to`: people, numbers or emails nothing is ever sent to. Tabgeist reads who a message goes to from the page itself (the chat's header, the email's recipients), so the agent cannot talk its way past it.
- **Secret fog.** Passwords, one-time codes and card numbers reach the agent as `{{secret:N}}`. It can type one back on the same site, never elsewhere.
- **Data does not wander.** Text read on one site cannot be sent to another without your yes. Hidden page text (invisible, off-screen, zero-width) never reaches the agent.
- **Receipts.** Every step lands in a timeline with what was asked, what happened, who approved it and a picture after each action.

What it does not protect against, and why: [`docs/architecture.md`](docs/architecture.md).

## Where your data lives

Plain files in `~/.tabgeist` you can read, edit and back up: `sites/<site>/` (your rules, notes, routines, health), `packs/`, `timeline/`, `shots/`, `heal/`. The control room (`tabgeist open`) shows all of it.

## Develop

```bash
npm install
npm test            # unit tests
npm run typecheck
npm run build       # dist/cli.mjs and the control room
npm run e2e         # the real extension in a throwaway Chrome, never your profile
```

How the pieces fit and the threat model: [`docs/architecture.md`](docs/architecture.md). The design system: [`design/README.md`](design/README.md). Packs, fixes and bug reports: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
