/**
 * "Move this run to the background" — the human's side of the park seam.
 *
 * A foreground shell call is parked on its job inside the core bash tool: it
 * registers the process as a job at its start and stops waiting only when the
 * wait horizon expires, so the call returns a `promoted` result and the
 * command keeps running as a job. `ctx.jobs` offers no detach, so a local
 * core patch (`patch-dsh-tool-park.mjs`) publishes the rendezvous below on
 * `globalThis`: one ticket per waiting call, asked once by this module.
 *
 * The request names no call. There is normally exactly one foreground call
 * holding the turn, and the harness — not the transcript — knows which one is
 * waiting; matching a row's card shape here would tie the key to a
 * presentation detail that drifts.
 *
 * A global symbol rather than a Cordis service: both sides already share this
 * process, the patched package must not import this one, and a
 * context-isolated event would not reach the agent's scope. `Symbol.for`
 * keeps the rendezvous stable across copies of the patch.
 */
export const TOOL_PARK = Symbol.for('dsh.tool-park')

/** One parked call: the ticket's id and the command it was handed. */
export interface ParkedToolCall {
  readonly callId: string
  readonly command: string
}

/** Hub the core patch installs; `requestAny` is the only method used here. */
interface ToolParkHub {
  requestAny?: () => { callId?: unknown; command?: unknown } | null | undefined
}

/**
 * Move the oldest in-flight foreground tool call to the background.
 * @returns the parked call (its id and the command it runs), or null when
 *   nothing waits: no core patch, or a process that has not spawned yet.
 */
export function parkAnyToolCall(): ParkedToolCall | null {
  const hub = Reflect.get(globalThis, TOOL_PARK) as ToolParkHub | undefined
  if (hub === undefined || typeof hub.requestAny !== 'function') return null
  try {
    const parked = hub.requestAny()
    if (parked == null || typeof parked.callId !== 'string') return null
    return { callId: parked.callId, command: typeof parked.command === 'string' ? parked.command : '' }
  } catch {
    return null
  }
}
