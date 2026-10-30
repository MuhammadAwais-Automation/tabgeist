---
name: tabgeist-pack
description: Build, test and update a Tabgeist pack for one website, so agents can read that site's data directly instead of reading the screen. Use when the user asks to make a pack or adapter for a site, when a site Tabgeist reads often has no pack, or when a pack's adapter broke after the site changed.
---

# Building a Tabgeist pack

A pack is one folder per site. Only `pack.json` is required:

```
<name>/
  pack.json      { "name": "<name>", "version": "0.1.0", "site": "<domain.com>", "about": "<one sentence>" }
  adapter.js     reads the site's data inside the page (only when needed, see step 2)
  notes.md       short lessons for agents working on this site
  routines/      ready routines (*.yaml, the format routine_list shows)
```

The user's own rules, notes and routines for a site always win over its pack, so a pack never needs to know about them.

Start with `tabgeist pack new <site> [folder]`: it writes `pack.json`, a starter `adapter.js` with one working op, `notes.md`, and copies the user's saved routines for that site into `routines/`. Replace the starter op with the real ones.

## 1. Find where the data lives

On the site, in the user's browser:

- `browser_read` with `data: true`, after the page shows what you want. Look at what came back.
- **The data is in that JSON** (most modern sites) → you may not need an adapter. A routine that fetches it (`routine_save` after the clicks) or a note saying which call holds it may be enough. Prefer that: it breaks less.
- **The page fetches it as HTML** (Hacker News, many older sites), **or it sits in the page's own store or in a script tag** (YouTube's `ytInitialData`, WhatsApp's module store) → write an adapter.

## 2. Write adapter.js

One expression that evaluates to `{ ops: { <name>: { about, run } } }`. It runs inside the page, in its own world, signed in as the user.

```js
// What this reads and where it comes from, in one or two lines.
(() => {
  async function page(path) {
    if (!/(^|\.)example\.com$/.test(location.hostname)) throw new Error('open example.com first')
    const r = await fetch(path, { credentials: 'include' })
    if (!r.ok) throw new Error('example.com answered ' + r.status + ' for ' + path)
    return new DOMParser().parseFromString(await r.text(), 'text/html')
  }
  return {
    ops: {
      orders: {
        about: 'recent orders: { limit=20 } → [{ id, date, total, status }]',
        run: async ({ limit = 20 } = {}) => { /* ... */ },
      },
    },
  }
})()
```

Rules (a pack is code that runs with the user's session; people must be able to trust it at a glance):

- **Only read.** No op clicks, posts, sends, deletes or changes settings. Actions belong to `browser_act`, where the user approves them.
- **Same origin only.** `fetch` the site's own paths. Never send anything to another domain, never load scripts.
- **Plain data out.** Return small JSON: ids, names, text, numbers, times, URLs. No HTML, no base64, no tokens, cookies or auth headers.
- **Fetch fresh** rather than trusting globals that single-page apps leave stale after navigation.
- **Every op takes a `limit`** with a sane default and a hard cap.
- **Errors say what to do**: "open example.com first", "id: the order id (from the orders op)".
- `about` gives the inputs with defaults and the output shape, like the example.

## 3. Test it

- Public pages: `tabgeist pack try <folder> <url>` lists the ops; `tabgeist pack try <folder> <url> <op> '<json args>'` runs one in a throwaway headless browser (never the user's profile). Iterate until every op returns clean data.
- Pages that need the user's login: ask the user, then `tabgeist pack add <folder>` and call the op with `browser_read` (`data: true, op, args`) in their browser.
- Check the output against what the page shows: counts, names, the newest item.

## 4. Notes and install

- `notes.md`: three to six lines. Which op answers which question, ids to pass, what the pack does not do.
- Installing is the user's call: show them the folder, then they run (or allow you to run) `tabgeist pack add <folder>`. A newer `version` replaces the old one, which is kept in `~/.tabgeist/packs/.history`. Bump the version on every change.
- Sharing: the user pushes the folder to a public repository; others run `tabgeist pack add <repo URL>`. Before that, read `routines/` with them for values they typed (names, addresses, message text) and take those out or turn them into variables.

## When a pack breaks

The site changed. `tabgeist pack try` (or the op in the browser) shows the error. Read the page again with `browser_read data: true` or the HTML, fix the selector or path, bump the patch version, test, and ask the user to `pack add` it again.
