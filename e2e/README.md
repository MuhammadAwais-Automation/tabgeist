# End-to-end suite: the browser extension on real Chrome

Runs the agent's own browser tools (`chrome.snapshot`, `chrome.read`, `chrome.act`, …) against a
local fixture site in a **throwaway Chrome profile** with the extension loaded. Your own browser,
accounts and your running Tabgeist are never touched.

```bash
npm run e2e                          # one pass (about a minute)
npm run e2e:soak                     # 20 passes: flakiness, leaks, slowdowns
node e2e/run.mjs --only drag         # scenarios whose name contains "drag"
node e2e/run.mjs --headed            # watch it in a visible window
node e2e/run.mjs --keep              # start everything, run nothing, poke it by hand:
node e2e/rpc.mjs chrome.snapshot '{"tab": 123}'
```

Needs Google Chrome (set `CHROME_PATH` if it is not in the usual place). Results: a summary on
screen and `e2e/out/report-<time>.json` (pass/fail, timings and the first errors per scenario).

## How it works

| File | Job |
|---|---|
| `site.mjs` | Fixture pages, one per hard web pattern. Each page writes what happened into `#out`. Served on 127.0.0.1; frames from `localhost` are real cross-site iframes. |
| `bridge.ts` | The bridge and `chrome.*` methods from `electron/chrome/` on their own port, without Electron (bundled with esbuild at start). Adds `test.approvals`, `test.answer`, `test.eval`, `test.cdp`. |
| `launch.mjs` | Chrome on a temp profile; a copy of `extension/` with the test port built in, loaded over the DevTools pipe (branded Chrome ignores `--load-extension`). |
| `scenarios.mjs` | The scenarios. Each opens fixture pages, acts only through the agent's tools, and checks `#out`. |
| `run.mjs` | Starts the three, runs the scenarios (`--soak N` times), answers approvals by each scenario's policy, writes the report. |

## What is covered

Forms (type, select, check, submit, Enter), shadow DOM, same-site and cross-site iframes, virtual
lists read in full, gallery tiles whose wrapper catches the click, the popup on top of other layers,
a download that starts seconds after the click, sliders, files dropped on a drop zone, native HTML5
drag-and-drop, clicks and right-clicks at a point on a canvas, labels that change after the snapshot,
double-click, hover menus, approvals (deny / allow / not asked for a picker / an agent's
`confirm: true` cannot skip them), wait for text to appear or go, paste of text and of an image
file, a 3000-control page, screenshots and reading.

## Adding a scenario

1. Add a page to `PAGES` in `site.mjs` that reproduces the pattern and writes the outcome to `#out`.
2. Add an entry to `SCENARIOS`: open the page, find refs with `h.ref(snapshot, role, name)`, act with
   `h.act(tab, params, 'allow' | 'deny')`, check with `h.expectOut(tab, text)`.
3. Run `node e2e/run.mjs --only "<name>"`, then the whole suite.

A scenario for something not built yet can carry `feature: true`; it then runs only with `--features`.
