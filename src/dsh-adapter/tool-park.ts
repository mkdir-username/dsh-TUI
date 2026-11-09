/**
 * "Move this run to the background" — the human's side of the park seam.
 *
 * A foreground shell call is parked on its job inside the core bash tool: it
 * registers the process as a job at its start and stops waiting only when the
 * wait horizon expires, so the call returns a `promoted` result and the
 * command keeps running as a job. `ctx.jobs` offers no detach, so a local
 * core patch (`patch-dsh-tool-park.mjs`) publishes the rendezvous below on
 * `globalThis`: one ticket per tool-call id, attached exactly while that call
 * waits, asked once by this module.
 *
 * A global symbol rather than a Cordis service: both sides already share this
 * process, the patched package must not import this one, and a
 * context-isolated event would not reach the agent's scope. `Symbol.for`
 * keeps the rendezvous stable across copies of the patch.
 */
export const TOOL_PARK = Symbol.for('dsh.tool-park')

/** Hub the core patch installs; `request` is the only method used here. */
interface ToolParkHub {
  request?: (callId: string) => unknown
}

/**
 * Move one in-flight tool call to the background.
 * @param callId - the call whose card is on screen, as the transcript names it.
 * @returns true when a waiting call took the request; false when nothing waits
 *   (no patch, an unknown call, or a process that has not spawned yet).
 */
export function parkToolCall(callId: string): boolean {
  if (callId === '') return false
  const hub = Reflect.get(globalThis, TOOL_PARK) as ToolParkHub | undefined
  if (hub === undefined || typeof hub.request !== 'function') return false
  try {
    return hub.request(callId) === true
  } catch {
    return false
  }
}
