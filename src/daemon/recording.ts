/**
 * What routine_save needs to know about a tab beyond the engine's step
 * recorder: where the agent's work there began (the page it opened or went
 * to), and the site's own data calls seen on the way (API-first candidates).
 */

export interface SeenCall { method: string; url: string; status?: number; mime?: string }

const starts = new Map<string, string>()
const calls = new Map<string, SeenCall[]>()

export const recording = {
  /** A new page in the tab: the next routine starts here. */
  begin(tabKey: string, url: string): void {
    starts.set(tabKey, url)
    calls.set(tabKey, [])
  },
  /** The first act in a tab nobody opened or navigated: start where it is. */
  touch(tabKey: string, url: string): void {
    if (!starts.has(tabKey)) recording.begin(tabKey, url)
  },
  saw(tabKey: string, list: SeenCall[]): void {
    const all = [...(calls.get(tabKey) ?? []), ...list.filter(c => c.method === 'GET')]
    calls.set(tabKey, all.slice(-60))
  },
  start(tabKey: string): string | undefined { return starts.get(tabKey) },
  calls(tabKey: string): SeenCall[] { return calls.get(tabKey) ?? [] },
}
