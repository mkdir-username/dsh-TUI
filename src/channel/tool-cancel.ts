/**
 * Cancellation identity of a settled tool call.
 *
 * A user cancel ends the turn and the DSH tool pipeline records what happened
 * to every call it owned: a call that never started (the batch stopped
 * dispatching) settles as `ABORTED_BEFORE_DISPATCH`, a call whose body was
 * already running settles as `ABORTED`. Both are the cancellation itself, not
 * a tool failure — the transcript says "cancelled", the failure path keeps the
 * red card and the error pointer.
 *
 * The codes are the DSH wire values (`dsh-tools` contracts); the channel layer
 * stays backend-neutral, so they are spelled here once instead of importing
 * the vendor package.
 */
import type { ToolErrorIdentity } from '../agent/events.js'

/** The call never reached its body: the scheduler skipped it after the abort. */
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'
/** The call's body had started; cancellation superseded its outcome. */
export const TOOL_ABORTED = 'ABORTED'

/** Which side of dispatch a cancellation landed on. */
export type ToolCancellation = 'before-dispatch' | 'after-dispatch'

/**
 * Classify a settled call's structured failure identity.
 * @param info - the backend's `tool/result.error` identity, when it logged one.
 * @returns the cancellation kind, or undefined for a real failure.
 */
export function toolCancellationOf(info: ToolErrorIdentity | undefined): ToolCancellation | undefined {
  if (info?.code === TOOL_ABORTED_BEFORE_DISPATCH) return 'before-dispatch'
  if (info?.code === TOOL_ABORTED) return 'after-dispatch'
  return undefined
}
