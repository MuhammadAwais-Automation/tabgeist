import { PairingStore, type PairingFile } from '../bridge/pairing'
import { RoomAuth } from './auth'
import { Grants } from './grants'
import { paths, readJson, sha256, writeJson } from './home'
import { Leases } from './leases'
import { Timeline } from './timeline'
import { Guard } from '../safety/guard'
import { SiteStore } from '../sites/store'
import { PackStore } from '../sites/packs'

/** What the user can switch in the control room. */
export interface Settings {
  /** A small picture of the page after every act, for the timeline and replays. */
  shots: boolean
  /** Ask before opening or navigating to a site no agent visited yet. */
  strictNavigation: boolean
  /** Run canary routines on their schedule. */
  canaries: boolean
}

export const DEFAULT_SETTINGS: Settings = { shots: true, strictNavigation: false, canaries: true }

/** Everything the daemon holds while it runs; one per process. */
export interface DaemonState {
  port: number
  token: string
  /** TABGEIST_TEST=1: the e2e suite's test.* methods are on. */
  test: boolean
  pairing: PairingStore
  grants: Grants
  leases: Leases
  timeline: Timeline
  room: RoomAuth
  settings: Settings
  sites: SiteStore
  guard: Guard
  /** Redacts secrets from text that is stored (secret fog). */
  redact: (s: string) => string
  saveSettings(next: Partial<Settings>): Settings
}

let current: DaemonState | null = null

export function daemon(): DaemonState {
  if (!current) throw new Error('the daemon is not running in this process')
  return current
}

export function hasDaemon(): boolean { return current != null }

export function createState(opts: { port: number; token: string; test?: boolean; leases?: Leases; sitesDir?: string; packsDir?: string }): DaemonState {
  const sites = new SiteStore(opts.sitesDir ?? paths.sites(), new PackStore(opts.packsDir ?? paths.packs()))
  const guard = new Guard(sites)
  const redact = (s: string) => guard.scrub(s)
  const state: DaemonState = {
    port: opts.port,
    token: opts.token,
    test: !!opts.test,
    pairing: new PairingStore({
      load: () => readJson<PairingFile>(paths.paired(), { browsers: {} }),
      save: f => writeJson(paths.paired(), f),
      hash: sha256,
    }),
    grants: new Grants(),
    leases: opts.leases ?? new Leases(),
    timeline: new Timeline(paths.timeline(), s => state.redact(s)),
    room: new RoomAuth(),
    settings: { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(paths.settings(), {}) },
    sites,
    guard,
    redact,
    saveSettings(next) {
      state.settings = { ...state.settings, ...next }
      writeJson(paths.settings(), state.settings)
      return state.settings
    },
  }
  current = state
  return state
}
