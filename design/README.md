# Tabgeist design system

One look for both faces of Tabgeist: the control room (`ui/`) and the extension side panel (`extension/`).
`design/tokens.css` is the only source. `npm run build` copies it, with the fonts, into `dist/ui/` and `extension/`.
The live reference is the control room at `#design`.

## The idea: a signal box

Agents run on lines (tabs). The person keeps the signals: nothing risky passes until they pull the lever.
Every visual choice comes from that room, so nothing is decoration:

| Signal box | In Tabgeist |
| --- | --- |
| Lamps on the panel | State, and the only carrier of colour |
| Track diagram | Agent tabs (Lines on Now) and the replay of a session |
| Levers | The section rail, and Allow / Deny |
| Enamelled plates | Panels that group what acts together |
| Signage lettering | Overpass, a descendant of Highway Gothic |

## Lamps

| Lamp | Means | Where |
| --- | --- | --- |
| Amber (pulses) | Waiting for you | approvals, questions, link codes, a tested fix |
| Green | Clear: done, healthy, allowed | linked browsers, working routines |
| Red | Stop: failed, broken, denied | failed steps, broken routines |
| White | Occupied: an agent is working here now | busy tabs |
| Unlit | Idle, or not built yet | Upcoming sections |

Amber is the only light that moves. Nothing else animates on its own.

## Type

- **Overpass** (variable, 100–900) for everything people read.
- **Overpass Mono** only for what a machine reads or types: refs, agent input, YAML, codes.
- Scale (Bringhurst): 12, 13, 15, 18, 24, 36 px, as `--t-xs` … `--t-xxl`.
- Sentence case. No all-caps labels.

## Space and shape

- 4 px grid: `--s1` (4) … `--s7` (48).
- Shape follows rank: controls `--r-control` (6), plates `--r-plate` (10), lamps round.
- Plates are separated by tone and a rule, not by shadows.

## Night and day

Night (enamel slate) is the default. Day is cool porcelain, with the lamps darkened for contrast.
`Auto` follows the system; the room's choice is stored in the browser only.

## Writing rules

- Buttons say what happens ("Replace the routine", "Link this browser"), and the toast repeats those words.
- Facts sit side by side (`.facts`), never glued together with dots or dashes.
- Empty states say what to do next. Errors say what happened and how to fix it.
- Numbers only for real sequences (the steps of a replay).
- Things not built yet are marked **Upcoming**, with what works today. Never fake UI.

## Parts (in tokens.css)

`.lamp` (`.amber .green .red .white .pulse`), `.btn` (`.allow .deny .solid .quiet .small`), `.field`, `.switch`, `.state`, `.kv`.
Room-only parts live in `ui/app.css`; side-panel-only parts in `extension/sidepanel.css`.

## Checking a change

`node e2e/room-shots.mjs` starts a throwaway daemon and headless Chrome (never your own browser), does a few agent steps,
leaves one Send waiting, and saves every page (night, day, phone, side panel) to `e2e/out/room/`.
