# Tabgeist browser extension

Lets your AI agent read and work in **your own** Chrome or Edge tabs, with every account you are
already signed in to. It talks only to the Tabgeist daemon on this computer (`ws://127.0.0.1:47900`);
nothing is sent anywhere else.

## Install

`tabgeist setup` opens the extensions page and puts this folder's path on your clipboard. Then:

1. Turn on **Developer mode** (top right on `chrome://extensions`, left side on `edge://extensions`).
2. **Load unpacked** → paste the path → Select folder.
3. The side panel (click the toolbar icon) shows a 6-digit code. Approve it in the control room
   (`tabgeist open`). The badge goes away once the browser is linked.

The `key` in `manifest.json` pins the extension id to `ihdiobmpbpecigcaoaijgnebdhkdfbne`, the id the
daemon accepts. A store build gets another id: add it to `TABGEIST_EXTENSION_IDS` (comma-separated).
The daemon's port is 47900 by default; another one can be set in the side panel.

## What you see

- **Agent tabs** open in an orange **Tabgeist** tab group, in the background. A glow and an
  "agent working" chip show which tab the agent is in right now.
- **Side panel**: Allow / Deny cards for risky steps (send, post, pay, delete, upload, reactions),
  questions only you can answer (a one-time code, a PIN, a choice; secret answers stay out of the
  log), every step the agent takes, and the agent's tabs.
- A system notification when something waits for you.

## Permissions and why

| Permission | Used for |
|---|---|
| `debugger` | Reading a page's accessibility tree and acting on it (clicks, typing, drag) through the DevTools protocol, and reading the JSON a page fetched. Chrome shows its "is debugging this browser" bar while it is attached; it lets go after a few idle seconds. Only an allow-list of DevTools commands passes. |
| `tabs`, `tabGroups` | Listing tabs, opening the agent's tabs in the Tabgeist group, closing only those. |
| `<all_urls>` host access, `scripting` | The agent can work on any site you ask it to; the glow is drawn with `scripting`. |
| `sidePanel`, `notifications` | Approvals, questions and the live log. |
| `downloads` | Telling the agent which files a click downloaded. |
| `storage`, `alarms` | The port setting; waking the worker to keep the link to the daemon. |

## Files

| File | Job |
|---|---|
| `background.js` | Service worker: the link to the daemon, tab and debugger requests, CDP events, the tab group, approvals and questions. |
| `sidepanel.html/.css/.js` | The side panel. `tokens.css` and `fonts/` are copied from `design/` by the build. |
| `manifest.json` | MV3 manifest. |

How it fits together and the threat model: [`docs/architecture.md`](../docs/architecture.md).
Tests: [`e2e/README.md`](../e2e/README.md). Store zip: `npm run ext:zip`.
