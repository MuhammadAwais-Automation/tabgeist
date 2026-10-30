import { render, type ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'

/**
 * The control room: what agents are doing, what waits for the user, everything
 * they did (with pictures), what was learned per site, and the heal queue.
 * Every read and write goes through /api with the room's session cookie.
 * Look and feel: design/tokens.css (a railway signal box; lamps carry meaning).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any
type Done = (m: string, bad?: boolean) => void

async function api(method: string, params: Record<string, unknown> = {}): Promise<Any> {
  const r = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) })
  if (r.status === 401) throw Object.assign(new Error('signed out'), { signedOut: true })
  return r.json()
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const when = (at: number) => { const d = new Date(at); return d.toDateString() === new Date().toDateString() ? time(at) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
const ago = (at?: number) => { if (!at) return 'never'; const s = Math.round((Date.now() - at) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago` }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const isToday = (at: number) => new Date(at).toDateString() === new Date().toDateString()

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private window */ } },
}

function applyTheme(t: string | null): void {
  if (t === 'night' || t === 'day') document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
}
applyTheme(store.get('bas-theme'))

function Lamp({ c, pulse }: { c?: 'amber' | 'green' | 'red' | 'white'; pulse?: boolean }) {
  return <span class={`lamp ${c ?? ''} ${pulse ? 'pulse' : ''}`} aria-hidden="true" />
}

/** The mark: a browser tab with a ghost's hem and one amber lamp for an eye (design/brand). */
function Mark({ size = 30 }: { size?: number }) {
  return <img src="/icon-128.png" width={size} height={size} alt="" style="display:block;border-radius:22%;box-shadow:0 0 0 1px var(--rule-strong)" />
}

function Head({ title, children, actions }: { title: string; children?: ComponentChildren; actions?: ComponentChildren }) {
  return <header class="page-head"><h1>{title}</h1>{children && <p>{children}</p>}{actions && <div class="row">{actions}</div>}</header>
}

function Facts({ items }: { items: (ComponentChildren | false | null | undefined)[] }) {
  const shown = items.filter(x => x !== false && x != null && x !== '')
  return shown.length ? <ul class="facts">{shown.map(x => <li>{x}</li>)}</ul> : null
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
function useToast(): [Any, Done] {
  const [t, setT] = useState<Any>(null)
  return [t, (text, bad = false) => { setT({ text, bad }); clearTimeout(toastTimer); toastTimer = setTimeout(() => setT(null), 4000) }]
}

function Preview({ items }: { items?: { label: string; value: string }[] }) {
  if (!items?.length) return null
  return <dl class="kv">{items.map(p => [<dt>{p.label}</dt>, <dd>{p.value}</dd>])}</dl>
}

// ── Now ──

function Approval({ a, done }: { a: Any; done: Done }) {
  const answer = async (allow: boolean, grant?: string) => { const r = await api('approval.answer', { approvalId: a.approvalId, allow, grant }); done(r.ok ? (allow ? 'Allowed' : 'Denied') : r.error, !r.ok) }
  return (
    <article class="signal" aria-label={`Waiting for your yes: ${a.title}`}>
      <div>
        <div>
          <h3><Lamp c="amber" pulse />{a.title}</h3>
          <Facts items={[a.agent && <>asked by <b>{a.agent}</b></>, a.site && <>on <b>{a.site}</b></>, a.browser, a.kind, time(a.at)]} />
        </div>
        {a.detail && <p class="detail">{a.detail}</p>}
        <Preview items={a.preview} />
        <div class="row">
          <button class="btn allow" onClick={() => answer(true, 'once')}>Allow once</button>
          {a.grantable && <button class="btn" onClick={() => answer(true, 'site')}>Allow on {a.site} for 15 min</button>}
          <button class="btn deny" onClick={() => answer(false)}>Deny</button>
        </div>
      </div>
    </article>
  )
}

function Question({ q, done }: { q: Any; done: Done }) {
  const [text, setText] = useState('')
  const reply = async (r: Any) => { const x = await api('question.answer', { askId: q.askId, ...r }); done(x.ok ? 'Answered' : x.error, !x.ok) }
  return (
    <article class="signal" aria-label={`A question: ${q.question}`}>
      <div>
        <div><h3><Lamp c="amber" pulse />{q.question}</h3><Facts items={[q.browser, time(q.at)]} /></div>
        {q.choices?.length
          ? <div class="row">{q.choices.map((c: string) => <button class="btn" onClick={() => reply({ text: c })}>{c}</button>)}</div>
          : <form class="answer" onSubmit={e => { e.preventDefault(); if (text) void reply({ text }) }}>
            <input class="field" type={q.secret ? 'password' : 'text'} value={text} onInput={e => setText((e.target as HTMLInputElement).value)} placeholder={q.secret ? 'Hidden, never written to the log' : 'Your answer'} aria-label="Your answer" autocomplete="off" />
            <button class="btn solid" disabled={!text}>Send answer</button>
          </form>}
        <div class="row"><button class="btn quiet small" onClick={() => reply({ done: true })}>I did it myself</button><button class="btn quiet small" onClick={() => reply({ skipped: true })}>Skip</button></div>
      </div>
    </article>
  )
}

function Pairing({ p, done }: { p: Any; done: Done }) {
  return (
    <article class="signal" aria-label="A browser wants to link">
      <div class="pair">
        <div class="code" aria-label={`Code ${p.code.split('').join(' ')}`}>{p.code.slice(0, 3)} {p.code.slice(3)}</div>
        <div style="flex:1;min-width:220px">
          <h3>{p.browser} “{p.label}” wants to link</h3>
          <p class="detail">Link it only if this same code is showing in that browser's side panel right now.</p>
        </div>
        <div class="row">
          <button class="btn allow" onClick={async () => { const r = await api('pairing.approve', { code: p.code }); done(r.ok ? 'Browser linked' : r.error, !r.ok) }}>Link this browser</button>
          <button class="btn deny" onClick={async () => { await api('pairing.deny', { code: p.code }); done('Link refused') }}>Refuse</button>
        </div>
      </div>
    </article>
  )
}

function Now({ s, entries, done }: { s: Any; entries: Any[]; done: Done }) {
  const today = entries.filter(e => isToday(e.at))
  const failed = today.filter(e => !e.ok).length
  const sites = new Set(today.map(e => e.site).filter(Boolean)).size
  const agents = new Set(today.map(e => e.agent).filter(Boolean)).size
  const waiting = s.pairings.length + s.approvals.length + s.questions.length
  const lastByTab = new Map<string, Any>()
  for (const l of s.activity) if (l.tabId != null) lastByTab.set(`${l.browser}#${l.tabId}`, l)
  const siteByTab = new Map<string, string>()
  for (const e of [...entries].reverse()) if (e.tab != null && e.site) siteByTab.set(`${e.browser}#${e.tab}`, e.site)
  return (
    <>
      <Head title="Now">What your agents are doing in your browsers, and what waits for your yes.</Head>

      <section aria-labelledby="waiting">
        <h2 id="waiting">Waiting for you {waiting > 0 && <small>{waiting}</small>}</h2>
        {waiting === 0
          ? <div class="clear"><Lamp c="green" />Nothing is waiting. Sending, paying, deleting and uploading stop here until you say yes.</div>
          : <div class="signals">
            {s.pairings.map((p: Any) => <Pairing p={p} done={done} />)}
            {s.questions.map((q: Any) => <Question q={q} done={done} />)}
            {s.approvals.map((a: Any) => <Approval a={a} done={done} />)}
          </div>}
      </section>

      <h2>Today</h2>
      <ul class="today">
        <li><b>{today.length}</b>{today.length === 1 ? 'step' : 'steps'}</li>
        <li class={failed ? 'red' : ''}><b>{failed}</b>failed</li>
        <li><b>{sites}</b>{sites === 1 ? 'site' : 'sites'}</li>
        <li><b>{agents}</b>{agents === 1 ? 'agent' : 'agents'}</li>
      </ul>

      <h2>Lines <small>tabs an agent is using</small></h2>
      {s.leases.length === 0
        ? <div class="empty">No agent is using a tab right now. Tabs an agent opens show up here, and in an amber tab group in the browser.</div>
        : <div class="plate flush">{s.leases.map((l: Any) => {
          const last = lastByTab.get(l.key)
          return (
            <div class={`track ${l.busy ? 'busy' : ''}`}>
              <Lamp c={l.busy ? 'white' : 'green'} />
              <b>{siteByTab.get(l.key) ?? 'a new tab'}</b>
              <span class="line" aria-hidden="true" />
              <span class="what">{l.busy ? 'working…' : last ? `${last.kind}: ${last.text}` : 'idle'}</span>
              <span class="who">{l.client}, {l.key.split('#')[0]}</span>
            </div>
          )
        })}</div>}

      <h2>Log <small>newest first</small></h2>
      {s.activity.length === 0
        ? <div class="empty">Nothing yet. Connect an agent with <code>tabgeist setup</code>, then ask it to open a page.</div>
        : <ol class="plate flush log">{[...s.activity].reverse().slice(0, 80).map((l: Any) => (
          <li><time>{time(l.at)}</time><Lamp c={l.ok ? undefined : 'red'} /><span class="kind">{l.kind}</span><span class="text">{l.text}</span><span class="agent">{l.agent ?? l.browser}</span></li>
        ))}</ol>}
    </>
  )
}

// ── Timeline ──

async function exportSession(id: string, entries: Any[], brand: string): Promise<void> {
  const img = async (name: string) => {
    const r = await fetch(`/shots/${name}`)
    if (!r.ok) return ''
    const b = await r.blob()
    return await new Promise<string>(res => { const f = new FileReader(); f.onload = () => res(String(f.result)); f.readAsDataURL(b) })
  }
  const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const rows: string[] = []
  for (const [i, e] of entries.entries()) {
    const pic = e.shot ? await img(e.shot) : ''
    rows.push(`<section class="${e.ok ? '' : 'bad'}"><b class="no">${i + 1}</b><h3>${esc(e.method.replace('browser.', ''))}</h3><p class="meta">${esc(new Date(e.at).toLocaleString())}, ${e.ms} ms${e.site ? `, ${esc(e.site)}` : ''}</p>${e.input ? `<code>${esc(e.input)}</code>` : ''}<p>${esc(e.summary)}</p>${(e.approvals ?? []).map((a: Any) => `<p class="ap ${a.allow ? 'ok' : 'no'}">${a.allow ? 'Allowed' : 'Denied'}: ${esc(a.title)} (${esc(a.by ?? '')})</p>`).join('')}${pic ? `<img src="${pic}" alt="">` : ''}</section>`)
  }
  const css = 'body{font:15px/1.5 system-ui,sans-serif;background:#0f1a21;color:#e9eae3;max-width:860px;margin:32px auto;padding:0 16px}h1{font-size:28px;margin:0}section{position:relative;border:1px solid #253844;border-radius:10px;padding:12px 16px 12px 60px;margin:12px 0;background:#15232c}section.bad{border-color:#ec5d53}.no{position:absolute;left:14px;top:12px;width:30px;height:30px;border-radius:50%;border:2px solid #5d7886;display:grid;place-items:center;font-size:12px}h3{margin:0;font-size:15px}.meta{color:#718389;font-size:12px;margin:2px 0 0}code{display:block;color:#a9b6bb;font:12px ui-monospace,monospace;white-space:pre-wrap;margin-top:6px}img{max-width:100%;border-radius:6px;margin-top:8px}.ap.ok{color:#5cc98f}.ap.no{color:#ec5d53}'
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(brand)} replay ${esc(id)}</title><style>${css}</style><h1>${esc(brand)} replay</h1><p>Session ${esc(id)}, ${entries.length} steps. Secrets were fogged when they were recorded.</p>${rows.join('')}`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  a.download = `${brand.toLowerCase()}-replay-${id}.html`
  a.click()
}

function Timeline({ brand }: { brand: string }) {
  const [sessions, setSessions] = useState<Any[] | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [steps, setSteps] = useState<Any[]>([])
  useEffect(() => { void api('timeline.sessions').then(r => { setSessions(r.sessions ?? []); if (r.sessions?.[0]) setPick(p => p ?? r.sessions[0].session) }) }, [])
  useEffect(() => { if (pick) void api('timeline.session', { session: pick }).then(r => setSteps(r.entries ?? [])) }, [pick])
  return (
    <>
      <Head title="Timeline" actions={pick && steps.length > 0 && <button class="btn" onClick={() => exportSession(pick, steps, brand)}>Export this replay as HTML</button>}>
        Every step every agent took, with a picture of the page after it. It stays on this computer.
      </Head>
      {sessions === null ? <div class="empty">Loading…</div> : sessions.length === 0 ? <div class="empty">No agent sessions yet. They appear here as soon as an agent reads or acts in a tab.</div> : (
        <div class="panes">
          <nav class="picker" aria-label="Sessions">{sessions.map(s => (
            <button class="pick" aria-current={s.session === pick} onClick={() => setPick(s.session)}>
              <Lamp c={s.failed ? 'red' : 'green'} />
              <b>{s.agent}</b>
              <Facts items={[when(s.to), plural(s.steps, 'step'), s.failed > 0 && <span style="color:var(--red)">{s.failed} failed</span>, s.sites.slice(0, 2).join(', ')]} />
            </button>))}</nav>
          <ol class="replay" style="list-style:none;margin:0">{steps.map((e, i) => (
            <li class={`station ${e.ok ? '' : 'bad'}`}>
              <span class="no">{i + 1}</span>
              <div class="plate">
                <div class="spread"><h3>{e.method.replace('browser.', '').replace('.', ' ')}</h3><Facts items={[time(e.at), `${e.ms} ms`, e.site]} /></div>
                {e.input && <div class="input">{e.input}</div>}
                <p>{e.summary}</p>
                {(e.approvals?.length > 0 || e.routine) && <div class="row" style="margin-top:var(--s2)">
                  {e.approvals?.map((a: Any) => <span class={`state ${a.allow ? 'green' : 'red'}`}><Lamp c={a.allow ? 'green' : 'red'} />{a.allow ? 'Allowed' : 'Denied'}: {a.title} ({a.by})</span>)}
                  {e.routine && <span class="state">routine {e.routine}</span>}
                </div>}
                {e.shot && <img loading="lazy" src={`/shots/${e.shot}`} alt={`The page after step ${i + 1}`} onError={ev => { (ev.currentTarget as HTMLImageElement).hidden = true }} />}
              </div>
            </li>))}</ol>
        </div>)}
    </>
  )
}

// ── Sites ──

function Upcoming({ title, what, children }: { title: string; what: string; children: ComponentChildren }) {
  return (
    <div class="plate">
      <div class="spread" style="margin-bottom:var(--s3)"><h3>{title}</h3><span class="badge-soon"><Lamp />Upcoming</span></div>
      <p class="lead" style="margin-bottom:var(--s3)">{what}</p>
      <div class="soon-plate" style="grid-template-columns:1fr">{children}</div>
    </div>
  )
}

function Site({ site, done }: { site: string; done: Done }) {
  const [d, setD] = useState<Any>(null)
  const [tab, setTab] = useState('routines')
  const [rules, setRules] = useState('')
  const [notes, setNotes] = useState('')
  const load = () => api('site.get', { site }).then(r => { setD(r); setRules(r.rules); setNotes(r.notes) })
  useEffect(() => { setD(null); void load() }, [site])
  if (!d) return <div class="empty">Loading {site}…</div>
  const run = async (name: string, shadow: boolean) => { done(`${shadow ? 'Dry run of' : 'Running'} ${name}…`); const r = await api('routine.runNow', { site, name, shadow }); done(r.ok ? `${name}: ${r.summary}` : `${name}: ${r.error}`, !r.ok); void load() }
  const tabs: [string, string][] = [['routines', `Routines (${d.routines.length})`], ['rules', 'Your rules'], ['notes', 'Notes'], ['health', 'Health'], ['pack', 'Pack']]
  return (
    <div>
      <h2 style="margin-top:0">{site}</h2>
      <div class="tabs" role="tablist">{tabs.map(([k, label]) => <button role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}</div>

      {tab === 'routines' && (d.routines.length === 0
        ? <div class="empty"><b>No routines yet.</b> When a task works, the agent saves it with <code>routine_save</code>, and it can then run here again without the agent.</div>
        : d.routines.map((r: Any) => (
          <div class={`plate ${r.broken ? 'bad' : ''}`}>
            <div class="spread">
              <div>
                <h3>{r.name} <span class="state">v{r.version}</span></h3>
                <Facts items={[r.description ?? plural(r.steps, 'step'), plural(r.runs, 'run'), r.okRate != null && `${r.okRate}% ok`, `last run ${r.lastRun ? ago(Date.parse(r.lastRun.at)) : 'never'}`]} />
                <div class="row" style="margin-top:var(--s2)">
                  {r.broken ? <span class="state red"><Lamp c="red" />Broken</span> : <span class="state green"><Lamp c="green" />Working</span>}
                  {r.api > 0 && <span class="state">Uses the site's own data</span>}
                  {r.from === 'pack' && <span class="state">From the {d.pack?.name} pack</span>}
                  {r.canary && <span class="state">Checked {r.canary}</span>}
                </div>
              </div>
              <div class="row"><button class="btn" onClick={() => run(r.name, true)}>Dry run</button><button class="btn solid" onClick={() => run(r.name, false)}>Run now</button></div>
            </div>
            <details><summary>Steps and earlier versions</summary>
              <pre class="yaml">{r.yaml}</pre>
              <div class="row" style="margin-top:var(--s3)">
                {r.history.map((v: number) => <button class="btn small" onClick={async () => { const x = await api('routine.rollback', { site, name: r.name, version: v }); done(x.ok ? `Back to v${v} (saved as v${x.version})` : x.error, !x.ok); void load() }}>Restore v{v}</button>)}
                <button class="btn deny small" onClick={async () => { if (confirm(`Retire ${r.name}? It moves to routines/.retired; nothing is deleted.`)) { await api('routine.retire', { site, name: r.name }); done(`${r.name} retired`); void load() } }}>Retire</button>
              </div>
            </details>
          </div>)))}

      {tab === 'rules' && (<div class="plate">
        <p class="lead">Your rules for {site}. Agents can read them but never change them. <code>block</code> never happens, <code>ask</code> always asks, <code>allow</code> skips the card, <code>limits</code> caps approved steps, <code>outbound</code> lists other domains this site may send data to, <code>never_to</code> lists people, numbers or emails nothing is ever sent to.</p>
        <textarea class="field" style="margin-top:var(--s3)" aria-label={`Rules for ${site}`} value={rules} onInput={e => setRules((e.target as HTMLTextAreaElement).value)} placeholder={"block: ['click:*delete account*']\nask: ['click:*archive*']\nallow: ['click:button \"save draft\"']\nlimits: { send: 5/h }\noutbound: []\nnever_to: ['Ali Khan', '+92 300 1234567']"} />
        <div class="row end" style="margin-top:var(--s3)"><button class="btn solid" onClick={async () => { const r = await api('policy.save', { site, text: rules }); done(r.ok ? 'Rules saved' : r.error, !r.ok) }}>Save rules</button></div>
      </div>)}

      {tab === 'notes' && (<div class="plate">
        <p class="lead">What agents learned about {site}. They read this before working here; edit it freely.</p>
        <textarea class="field" style="margin-top:var(--s3)" aria-label={`Notes for ${site}`} value={notes} onInput={e => setNotes((e.target as HTMLTextAreaElement).value)} />
        <div class="row end" style="margin-top:var(--s3)"><button class="btn solid" onClick={async () => { await api('notes.save', { site, text: notes }); done('Notes saved') }}>Save notes</button></div>
      </div>)}

      {tab === 'health' && (() => {
        const runs = Object.entries(d.health.routines ?? {}).flatMap(([name, h]: [string, Any]) => h.runs.map((r: Any) => ({ ...r, name }))).sort((a: Any, b: Any) => b.at - a.at)
        return runs.length === 0 ? <div class="empty">No runs yet.</div> : (
          <ol class="plate flush log">{runs.map((r: Any) => (
            <li><time>{when(r.at)}</time><Lamp c={r.ok ? 'green' : 'red'} /><span class="kind">{r.shadow ? 'dry run' : 'run'}</span><span class="text"><b>{r.name}</b>{r.healed ? `, ${plural(r.healed, 'step')} healed` : ''}{r.error ? `: ${r.error}` : ''}</span><span class="agent">{r.by}, {r.ms} ms</span></li>
          ))}</ol>)
      })()}

      {tab === 'pack' && (d.pack ? <>
        <PackPlate p={{ ...d.pack, site }} />
        {d.pack.notes && <div class="plate"><h3>What it tells agents</h3><pre class="yaml">{d.pack.notes}</pre></div>}
        <PackSoon />
      </> : <div class="empty"><b>No pack for {site}.</b> A pack is a folder with a <code>pack.json</code> and, as needed, an <code>adapter.js</code>, <code>notes.md</code> and <code>routines/</code>. Install one with <code>tabgeist pack add &lt;folder&gt;</code>.</div>)}
    </div>
  )
}

function Sites({ done }: { done: Done }) {
  const [list, setList] = useState<Any[] | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  useEffect(() => { void api('sites.list').then(r => { setList(r.sites ?? []); if (r.sites?.[0]) setPick(p => p ?? r.sites[0].site) }) }, [])
  return (
    <>
      <Head title="Sites">Routines, your rules and what agents learned, site by site. They are plain files in <code>~/.tabgeist/sites</code> you can read, edit and back up.</Head>
      {list === null ? <div class="empty">Loading…</div> : list.length === 0 ? <div class="empty"><b>Nothing learned yet.</b> A site shows up here once an agent saves a routine or a note there, or once you add rules for it.</div> : (
        <div class="panes">
          <nav class="picker" aria-label="Sites">{list.map(s => (
            <button class="pick" aria-current={s.site === pick} onClick={() => setPick(s.site)}>
              <Lamp c={s.broken ? 'red' : s.heal ? 'amber' : s.routines ? 'green' : undefined} />
              <b>{s.site}</b>
              <Facts items={[plural(s.routines, 'routine'), s.pack && `${s.pack} pack`, s.broken > 0 && `${s.broken} broken`, s.heal > 0 && `${s.heal} to heal`, s.rules && 'rules', s.lastRun && `ran ${ago(s.lastRun)}`]} />
            </button>))}</nav>
          <div>{pick && <Site site={pick} done={done} />}</div>
        </div>)}
    </>
  )
}

// ── Heal ──

const HEAL_STATUS: Record<string, [string, 'amber' | 'green' | 'red' | undefined]> = {
  open: ['Needs a fix', 'red'], proposed: ['Fix proposed, testing', 'amber'], ready: ['Fix tested, waiting for you', 'amber'],
  failed: ['The proposed fix failed its dry run', 'red'], applied: ['Fixed', 'green'], dismissed: ['Dismissed', undefined],
}
const isOpen = (t: Any) => !['applied', 'dismissed'].includes(t.status)

function Heal({ done, onChange }: { done: Done; onChange: () => void }) {
  const [tickets, setTickets] = useState<Any[] | null>(null)
  const load = () => api('heal.all').then(r => { setTickets(r.tickets ?? []); onChange() })
  useEffect(() => { void load() }, [])
  if (tickets === null) return <><Head title="Heal" /><div class="empty">Loading…</div></>
  const open = tickets.filter(isOpen)
  const closed = tickets.filter(t => !isOpen(t)).slice(0, 10)
  const card = (t: Any) => {
    const [label, c] = HEAL_STATUS[t.status] ?? [t.status, undefined]
    return (
      <div class={`plate ${c === 'red' ? 'bad' : ''}`}>
        <div class="spread">
          <div>
            <h3>{t.routine} <span class="state">on {t.site}, v{t.version}</span></h3>
            <Facts items={[t.kind === 'drift' ? 'The page changed; the routine still found its way' : 'The routine could not finish', ago(t.at)]} />
          </div>
          <span class={`state ${c ?? ''}`}><Lamp c={c} pulse={t.status === 'ready'} />{label}</span>
        </div>
        {t.error && <p class="lead" style="margin-top:var(--s3)">{t.error}</p>}
        {t.proposal && <div style="margin-top:var(--s4)">
          <h3>Proposed fix <small style="font-weight:400;color:var(--ink-3)">by {t.proposal.by}</small></h3>
          {t.proposal.note && <p class="lead">{t.proposal.note}</p>}
          {t.proposal.test && <p class={`state ${t.proposal.test.ok ? 'green' : 'red'}`} style="margin-top:var(--s2)"><Lamp c={t.proposal.test.ok ? 'green' : 'red'} />{t.proposal.test.ok ? 'Dry run passed' : 'Dry run failed'}: {t.proposal.test.summary}</p>}
          <details><summary>The new routine</summary><pre class="yaml">{t.proposal.yaml}</pre></details>
        </div>}
        {!t.proposal && t.status === 'open' && <p class="lead" style="margin-top:var(--s3)">Waiting for an agent to propose a fix. Ask yours: “fix the broken {t.routine} routine on {t.site}”.</p>}
        {t.evidence?.shot && <img style="display:block;max-width:440px;width:100%;border-radius:var(--r-control);border:1px solid var(--rule);margin-top:var(--s3)" src={`/shots/${t.evidence.shot}`} alt="The page when the routine broke" onError={ev => { (ev.currentTarget as HTMLImageElement).hidden = true }} />}
        {isOpen(t) && <div class="row end" style="margin-top:var(--s4)">
          <button class="btn quiet" onClick={async () => { await api('heal.dismiss', { id: t.id }); done('Dismissed'); void load() }}>Dismiss</button>
          <button class="btn allow" disabled={t.status !== 'ready'} onClick={async () => { const r = await api('heal.apply', { id: t.id }); done(r.ok ? `Routine replaced, now v${r.version}` : r.error, !r.ok); void load() }}>Replace the routine</button>
        </div>}
      </div>
    )
  }
  return (
    <>
      <Head title="Heal">Routines that met a changed site. A fix is dry-run first, and nothing replaces a routine until you press Replace.</Head>
      {open.length === 0 ? <div class="clear"><Lamp c="green" />Every routine is healthy.</div> : open.map(card)}
      {closed.length > 0 && <><h2>Closed</h2>{closed.map(card)}</>}
    </>
  )
}

// ── Settings ──

function ThemePick() {
  const [t, setT] = useState(store.get('bas-theme') ?? 'auto')
  const pickT = (v: string) => { setT(v); store.set('bas-theme', v === 'auto' ? null : v); applyTheme(v === 'auto' ? null : v) }
  return <div class="theme" role="group" aria-label="Colours">{[['auto', 'Auto'], ['night', 'Night'], ['day', 'Day']].map(([k, l]) => <button aria-pressed={t === k} onClick={() => pickT(k)}>{l}</button>)}</div>
}

function Settings({ s, done }: { s: Any; done: Done }) {
  const set = async (k: string, v: boolean) => { await api('settings.save', { [k]: v }); done('Saved') }
  const toggles: [string, string, string][] = [
    ['strictNavigation', 'Ask before new sites', 'An agent opening a site no agent has visited yet waits for your yes.'],
    ['shots', 'Pictures in the timeline', 'A small picture of the page after every agent step, kept on this computer. Taken in the background; agents never wait for it.'],
    ['canaries', 'Daily checks', 'Read-only routines with a schedule are dry-run in the background, so a changed site shows up in Heal before you need it.'],
  ]
  return (
    <>
      <Head title="Settings">How careful agents must be, which browsers are linked, and what you allowed for a while.</Head>
      <h2>Safety</h2>
      <div class="plate">{toggles.map(([k, t, m]) => <label class="settings-row"><div><b>{t}</b><p>{m}</p></div><input class="switch" type="checkbox" checked={!!s.settings[k]} onChange={e => set(k, (e.target as HTMLInputElement).checked)} /></label>)}</div>

      <h2>Linked browsers</h2>
      {s.paired.length === 0 ? <div class="empty">None yet. Load the extension; its side panel shows a code to approve on the Now page.</div> : (
        <div class="plate flush rows">{s.paired.map((p: Any) => {
          const on = s.browsers.some((b: Any) => b.label === p.label)
          return <div><Lamp c={on ? 'green' : undefined} /><div><b>{p.label}</b><Facts items={[p.browser, on ? 'connected' : `last seen ${ago(p.lastSeen)}`, `linked ${when(p.at)}`]} /></div>
            <button class="btn deny small" onClick={async () => { if (confirm(`Unlink ${p.label}? It will need a new code to link again.`)) { await api('pairing.remove', { id: p.id }); done('Browser unlinked') } }}>Unlink</button></div>
        })}</div>)}

      <h2>Allowed for a while</h2>
      {s.grants.length === 0 ? <div class="empty">Nothing. When you answer “Allow on this site for 15 min”, it shows here until it runs out.</div> : (
        <div class="plate flush rows">{s.grants.map((g: Any) => (
          <div><Lamp c="amber" /><div><b>{g.kind.replace(':', ' ')}</b> on {g.site}<Facts items={[g.browser, `until ${time(g.until)}`, `${g.left} left`]} /></div><button class="btn small" onClick={async () => { await api('grants.revoke', { id: g.id }); done('Permission revoked') }}>Revoke</button></div>))}</div>)}

      <h2>Look</h2>
      <div class="plate"><div class="settings-row"><div><b>Colours</b><p>Night is the default. Auto follows your system.</p></div><ThemePick /></div>
        <div class="settings-row"><div><b>Design reference</b><p>The colours, type and parts this room is built from.</p></div><a class="btn small" href="#design">Open the reference</a></div></div>

      <h2>Connect an agent</h2>
      <div class="plate"><p class="lead">Run <code>tabgeist setup</code> in a terminal for the exact command for Claude Code, Codex or Cursor. Agents start this program by themselves when they need it.</p></div>
    </>
  )
}

// ── Packs ──

function PackPlate({ p }: { p: Any }) {
  return (
    <div class="plate">
      <div class="spread">
        <div>
          <h3>{p.name} <span class="state">v{p.version}</span></h3>
          <Facts items={[p.site, p.from === 'installed' ? 'Installed by you' : 'Comes with Tabgeist']} />
        </div>
        <span class="state green"><Lamp c="green" />In use</span>
      </div>
      {p.about && <p class="lead" style="margin-top:var(--s3)">{p.about}</p>}
      <div class="row" style="margin-top:var(--s3)">
        {p.adapter && <span class="state">Reads the app's own data</span>}
        {p.routines?.length > 0 && <span class="state">{plural(p.routines.length, 'routine')}</span>}
        {(p.notes === true || (typeof p.notes === 'string' && p.notes.trim())) && <span class="state">Notes for agents</span>}
      </div>
    </div>
  )
}

function PackSoon() {
  return (
    <Upcoming title="Next for packs" what="Packs grow from readers into everything a site needs.">
      <ul>
        <li><b>Actions</b> such as downloading a photo or sending a file, each still waiting for your yes.</li>
        <li><b>Daily checks</b> that notice when the site changed and open a fix in Heal.</li>
        <li><b>A list of packs others made</b>, to browse here and add with one click, the code shown to you first.</li>
      </ul>
    </Upcoming>
  )
}

function Packs() {
  const [d, setD] = useState<Any>(null)
  useEffect(() => { void api('packs.list').then(setD) }, [])
  return (
    <>
      <Head title="Packs">Everything one site needs, in one folder: a reader for the app's own data, notes for agents, ready routines. Your own rules, notes and routines for a site always win over its pack.</Head>
      {!d ? <div class="empty">Loading…</div> : d.packs.length === 0 ? <div class="empty">No packs yet.</div> : d.packs.map((p: Any) => <PackPlate p={p} />)}
      <div class="plate">
        <h3>Add or update a pack</h3>
        <p class="lead" style="margin-top:var(--s2)">From a folder on this computer or a public git repository, in a terminal. A newer version replaces the old one, which is kept in <code>{d?.dir ?? '~/.tabgeist/packs'}/.history</code>. Agents cannot install packs. Read the <code>adapter.js</code> of a pack someone else wrote: it runs in your signed-in pages.</p>
        <pre class="yaml">tabgeist pack add &lt;folder or git URL&gt;</pre>
        <h3 style="margin-top:var(--s5)">Make your own</h3>
        <p class="lead" style="margin-top:var(--s2)">Starts a folder with a starter reader and the routines you saved for that site. Your agent fills it in with the tabgeist-pack skill. To share it, put the folder on GitHub.</p>
        <pre class="yaml">tabgeist pack new &lt;site&gt;</pre>
        <h3 style="margin-top:var(--s5)">Experimental</h3>
        <p class="lead" style="margin-top:var(--s2)">Packs for apps whose terms forbid automation are not on by default. <b>WhatsApp</b> reads chats and messages without opening them; it only reads, but your account is your risk.</p>
        <pre class="yaml">tabgeist pack add "{d?.builtIn ?? '<install>/packs'}/experimental/whatsapp"</pre>
      </div>
      <PackSoon />
    </>
  )
}

// ── Upcoming sections ──

const SOON: Record<string, { title: string; lead: string; plan: [string, string][]; today: string }> = {
  automations: {
    title: 'Automations', lead: 'Your manual tasks, done for you every day.',
    plan: [['Schedules', 'run a routine every morning, or every Monday'], ['Triggers', 'run when a new message arrives or a number crosses a line'], ['Outputs', 'send the result to a file, a sheet, or a message to you'], ['Dry runs first', 'see what a new automation would do before it does anything']],
    today: 'Routines already replay without an agent: open Sites, pick a site, press Run now.',
  },
  agents: {
    title: 'Agents', lead: 'Which AI agents are connected, and what each may do.',
    plan: [['Connected agents', 'Claude Code, Codex, Cursor, with when each last worked'], ['Read or act', 'let one agent only read while another may act'], ['Per site', 'a different permission for every site'], ['Revoke', 'cut an agent off in one click']],
    today: 'Every step already names its agent in Timeline, and the log on Now shows who did what.',
  },
  teach: {
    title: 'Teach', lead: 'Show it once by hand, and it becomes a routine.',
    plan: [['Record', 'do the task yourself while Tabgeist watches the page'], ['Review', 'see the steps it understood, and fix any'], ['Make it general', 'mark what changes each time, like a name or a date'], ['Save', 'it joins the site\'s routines and can be scheduled']],
    today: 'Agents save a routine after a task works (routine_save); you find it under Sites.',
  },
  savings: {
    title: 'Savings', lead: 'The time and AI cost your routines and data reads saved.',
    plan: [['Time', 'minutes saved compared with doing it by hand'], ['AI cost', 'tokens not spent because a routine ran without the agent'], ['Per site and routine', 'which ones pay off most'], ['Monthly', 'a short report you can share']],
    today: 'Timeline already records how long every step took.',
  },
}

function Soon({ k }: { k: string }) {
  const x = SOON[k]
  return (
    <>
      <Head title={x.title}>{x.lead}</Head>
      <div class="plate soon-plate">
        <div>
          <div class="row" style="margin-bottom:var(--s4)"><span class="badge-soon"><Lamp />Upcoming</span></div>
          <h3>What it will do</h3>
          <ul>{x.plan.map(([b, t]) => <li><b>{b}</b>: {t}</li>)}</ul>
        </div>
        <div>
          <h3>Works today</h3>
          <p class="lead">{x.today}</p>
        </div>
      </div>
    </>
  )
}

// ── Design reference ──

function Design() {
  const colours: [string, string][] = [['--bg', 'Room'], ['--panel', 'Plate'], ['--raise', 'Raised'], ['--sunk', 'Well'], ['--rule', 'Rule'], ['--ink', 'Lettering'], ['--ink-2', 'Second ink'], ['--ink-3', 'Third ink'], ['--track', 'Track'], ['--amber', 'Waiting for you'], ['--green', 'Clear'], ['--red', 'Stop'], ['--white', 'Occupied']]
  const sizes: [string, string, number][] = [['--t-xxl', 'Page title', 800], ['--t-xl', 'Big number', 750], ['--t-l', 'Section', 700], ['--t-m', 'Body text', 400], ['--t-s', 'Controls and lists', 500], ['--t-xs', 'Facts and times', 400]]
  return (
    <>
      <Head title="Design reference">A signal box: agents run on lines, you keep the signals. Every lamp colour means one thing, everywhere. Source: <code>design/tokens.css</code>.</Head>
      <h2>Colours</h2>
      <div class="swatches">{colours.map(([v, n]) => <div class="swatch"><i style={`background:var(${v})`} /><div><b>{n}</b><code>{v}</code></div></div>)}</div>
      <h2>Lamps</h2>
      <div class="plate rows flush">
        <div><Lamp c="amber" pulse /><span><b>Amber</b>: waiting for you. The only light that moves.</span><span /></div>
        <div><Lamp c="green" /><span><b>Green</b>: clear, done, healthy, allowed.</span><span /></div>
        <div><Lamp c="red" /><span><b>Red</b>: stop, failed, broken, denied.</span><span /></div>
        <div><Lamp c="white" /><span><b>White</b>: occupied, an agent is working on this line now.</span><span /></div>
        <div><Lamp /><span><b>Unlit</b>: idle, or not built yet.</span><span /></div>
      </div>
      <h2>Type <small>Overpass, from the Highway Gothic road signs; Overpass Mono for machine text only</small></h2>
      <div class="plate scale">{sizes.map(([v, n, w]) => <div><code>{v}</code><span style={`font-size:var(${v});font-weight:${w};line-height:1.2`}>{n}</span></div>)}
        <div><code>--mono</code><span class="mono">[e33] button "Send" = typed by the agent</span></div></div>
      <h2>Controls</h2>
      <div class="plate"><div class="row">
        <button class="btn allow">Allow once</button><button class="btn">Allow on this site for 15 min</button><button class="btn deny">Deny</button>
        <button class="btn solid">Run now</button><button class="btn">Dry run</button><button class="btn quiet">Dismiss</button><button class="btn small">Small</button>
        <input class="switch" type="checkbox" checked aria-label="Example switch" /><input class="field" placeholder="A field" aria-label="Example field" />
      </div></div>
      <h2>Rules</h2>
      <div class="plate"><ul class="lead" style="margin:0;padding-left:1.2em;display:grid;gap:var(--s2)">
        <li>Colour only from lamps and the states they stand for, never as decoration.</li>
        <li>Sentence case everywhere. No all-caps labels and no text glued with dots or dashes: list facts side by side.</li>
        <li>Plates group what acts together. Numbers only where the content is a real sequence, like the steps of a replay.</li>
        <li>Buttons say what happens: “Replace the routine”, not “Submit”, and the toast repeats the same words.</li>
        <li>Empty states say what to do next. Errors say what happened and how to fix it.</li>
        <li>Mono only for what a machine reads or types.</li>
      </ul></div>
    </>
  )
}

// ── App ──

const WORKING: [string, string][] = [['now', 'Now'], ['timeline', 'Timeline'], ['sites', 'Sites'], ['packs', 'Packs'], ['heal', 'Heal'], ['settings', 'Settings']]
const UPCOMING: [string, string][] = [['automations', 'Automations'], ['agents', 'Agents'], ['teach', 'Teach'], ['savings', 'Savings']]
const VIEWS = new Set([...WORKING, ...UPCOMING].map(([k]) => k).concat('design'))
const viewFromHash = () => { const h = location.hash.slice(1); return h === 'live' ? 'now' : VIEWS.has(h) ? h : 'now' }

function App() {
  const [brand, setBrand] = useState('Tabgeist')
  const [s, setS] = useState<Any>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [entries, setEntries] = useState<Any[]>([])
  const [heal, setHeal] = useState(0)
  const [view, setView] = useState(viewFromHash())
  const [toast, say] = useToast()
  const refresh = () => api('room.state').then(r => setS(r)).catch(e => { if (e.signedOut) setSignedOut(true) })
  const refreshHeal = () => api('heal.all').then(r => setHeal((r.tickets ?? []).filter(isOpen).length)).catch(() => {})
  useEffect(() => {
    void fetch('/health').then(r => r.json()).then(h => setBrand(h.name)).catch(() => {})
    void refresh()
    void refreshHeal()
    void api('timeline.recent', { limit: 300 }).then(r => setEntries(r.entries ?? [])).catch(() => {})
    const es = new EventSource('/api/events')
    let t: ReturnType<typeof setTimeout> | undefined
    const soon = () => { clearTimeout(t); t = setTimeout(refresh, 120) }
    for (const n of ['activity', 'approval', 'approvalDone', 'ask', 'askDone', 'pairing', 'pairingDone', 'connections', 'busy', 'routine', 'health']) es.addEventListener(n, soon)
    es.addEventListener('heal', () => { soon(); void refreshHeal() })
    es.addEventListener('timeline', (e: MessageEvent) => setEntries(x => [JSON.parse(e.data), ...x].slice(0, 500)))
    es.onerror = () => { void refresh() }
    const onHash = () => setView(viewFromHash())
    addEventListener('hashchange', onHash)
    return () => { es.close(); removeEventListener('hashchange', onHash) }
  }, [])
  const waiting = s ? s.approvals.length + s.questions.length + s.pairings.length : 0
  useEffect(() => {
    if (location.hash.slice(1) !== view) location.hash = view
    const label = [...WORKING, ...UPCOMING].find(([k]) => k === view)?.[1] ?? 'Design reference'
    document.title = `${waiting ? `(${waiting}) ` : ''}${label}, ${brand}`
  }, [view, brand, waiting])

  if (signedOut) return (
    <div class="center"><div class="plate"><Mark size={36} />
      <h1>This room is closed</h1>
      <p>The control room opens only from your own computer. Run <code>tabgeist open</code> in a terminal, or press Open control room in the extension's side panel.</p></div></div>)
  if (!s) return <div class="center"><div class="clear"><Lamp c="amber" pulse />Connecting to {brand} on this computer…</div></div>
  const done: Done = (m, bad) => { say(m, bad); void refresh() }
  const lever = ([k, label]: [string, string], soon = false) => {
    const n = k === 'now' ? waiting : k === 'heal' ? heal : 0
    const c = k === 'now' && waiting ? 'amber' : k === 'heal' && heal ? 'red' : view === k ? 'white' : undefined
    return <button class={`lever ${soon ? 'soon' : ''}`} aria-current={view === k ? 'page' : undefined} onClick={() => setView(k)}>
      <Lamp c={c} pulse={k === 'now' && waiting > 0} /><span>{label}</span>{n > 0 && <span class={`n ${k === 'heal' ? 'red' : ''}`}>{n}</span>}</button>
  }
  return (
    <div class="room">
      <aside class="rail">
        <div class="mark"><Mark /><div><b>{brand}</b><small>Control room</small></div></div>
        <nav class="levers" aria-label="Sections">
          {WORKING.map(x => lever(x))}
          <p>Upcoming</p>
          {UPCOMING.map(x => lever(x, true))}
        </nav>
        <div class="lines">
          {s.browsers.length === 0
            ? <div><Lamp />No browser linked</div>
            : s.browsers.map((b: Any) => <div><Lamp c={s.leases.some((l: Any) => l.busy && l.key.startsWith(`${b.label}#`)) ? 'white' : 'green'} /><span class="who">{b.label}</span></div>)}
          <div>Local only, on 127.0.0.1</div>
          <ThemePick />
        </div>
      </aside>
      <main id="main">
        {view === 'now' && <Now s={s} entries={entries} done={done} />}
        {view === 'timeline' && <Timeline brand={brand} />}
        {view === 'sites' && <Sites done={done} />}
        {view === 'packs' && <Packs />}
        {view === 'heal' && <Heal done={done} onChange={() => void refreshHeal()} />}
        {view === 'settings' && <Settings s={s} done={done} />}
        {view === 'design' && <Design />}
        {SOON[view] && <Soon k={view} />}
      </main>
      {toast && <div class="toast" role="status"><Lamp c={toast.bad ? 'red' : 'green'} />{toast.text}</div>}
    </div>
  )
}

render(<App />, document.getElementById('app')!)
