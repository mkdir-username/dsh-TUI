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

/** One parked call: the ticket's id and the label it was handed. */
export interface ParkedToolCall {
  readonly callId: string
  /**
   * What the toast names: the command a shell call runs, or the description a
   * delegated task was started with. Both read as "the work moved to the
   * background" in the same sentence, so the card and the toast keep one shape.
   */
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

/**
 * The `job_output` wait rendezvous — the second half of the same human seam.
 *
 * A wait on a background job is not a shell call, so the bash ticket above
 * never sees it: the core tool parks its own AbortController and publishes the
 * ticket under a symbol of its own (`patch-dsh-job-wait-park.mjs`). Both
 * tickets follow one contract: ask once, the wait ends, the producer keeps
 * running.
 */
export const JOB_WAIT_PARK = Symbol.for('dsh.job-wait-park')

export interface ParkedWait {
  readonly callId: string
  readonly jobId: string
}

/** Hub the core patch installs; `requestAny` is the only method used here. */
interface JobWaitHub {
  requestAny?: () => { callId?: unknown; jobId?: unknown } | null | undefined
}

/**
 * End the oldest in-flight `job_output` wait.
 * @returns the released call and the job it was reading, or null when nothing
 *   waits: no core patch, no `wait: true` call in flight, or a wait that
 *   already returned.
 */
export function parkAnyJobWait(): ParkedWait | null {
  const hub = Reflect.get(globalThis, JOB_WAIT_PARK) as JobWaitHub | undefined
  if (hub === undefined || typeof hub.requestAny !== 'function') return null
  try {
    const parked = hub.requestAny()
    if (parked == null || typeof parked.callId !== 'string' || typeof parked.jobId !== 'string') return null
    return { callId: parked.callId, jobId: parked.jobId }
  } catch {
    return null
  }
}

/**
 * The delegation plugin's ticket — the third producer on the same human seam.
 *
 * A `delegate` call waits for its child inside the plugin, not inside a core
 * tool, and it holds a delegation slot until the child settles. The plugin
 * publishes this ticket only while the call waits; asking once makes the call
 * return an ack at once, keeps the child running (and its slot held), and
 * delivers the real handoff as a message when the child finishes. Same
 * contract as the two tickets above: ask once, the wait ends, the producer
 * keeps running.
 */
export const DELEGATE_PARK = Symbol.for('dsh.delegate-park')

/** Hub the delegation plugin installs; `requestAny` is the only method used here. */
interface DelegateParkHub {
  requestAny?: () => { callId?: unknown; description?: unknown } | null | undefined
}

/**
 * Move the oldest waiting delegation to the background.
 * @returns the parked call (its id and the task description), or null when
 *   nothing waits: no delegation plugin, or a call that has not started yet
 *   (a call still queued for a slot has no ticket).
 */
export function parkAnyDelegation(): ParkedToolCall | null {
  const hub = Reflect.get(globalThis, DELEGATE_PARK) as DelegateParkHub | undefined
  if (hub === undefined || typeof hub.requestAny !== 'function') return null
  try {
    const parked = hub.requestAny()
    if (parked == null || typeof parked.callId !== 'string') return null
    return { callId: parked.callId, command: typeof parked.description === 'string' ? parked.description : '' }
  } catch {
    return null
  }
}
