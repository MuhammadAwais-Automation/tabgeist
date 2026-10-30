import { startDaemon, type DaemonOptions, type RunningDaemon } from './daemon/server'
import { addMethods } from './daemon/rpc'
import { paths } from './daemon/home'
import { HealStore } from './routines/heal'
import { routineMethods, startCanaries } from './routines/methods'

/** The daemon with every module plugged in: browser tools, safety, routines, heal, canaries. */
export async function createDaemon(o: DaemonOptions & { canaryCheckMs?: number } = {}): Promise<RunningDaemon> {
  const heal = new HealStore(paths.heal())
  let stopCanaries = () => {}
  const d = await startDaemon({
    ...o,
    setup: async state => {
      const m = routineMethods(heal)
      addMethods('agent', m.agent)
      addMethods('room', m.room)
      stopCanaries = startCanaries(() => ({ d: state, agent: 'canary', session: 'canary', from: 'agent', meta: {} }), heal, o.canaryCheckMs)
      await o.setup?.(state)
    },
  })
  return { ...d, close: async () => { stopCanaries(); await d.close() } }
}
