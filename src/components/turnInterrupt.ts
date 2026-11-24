/**
 * One Esc ladder for stopping a running turn, shared by the two input layers
 * that can see the key: Chat's global handler (which normally owns it) and the
 * composer (`PromptInput`, which receives it whenever the global layer yields
 * the keyboard or lags a beat behind).
 *
 * Why a module: the composer used to own only idle meanings (clear the draft,
 * then `Esc again to rewind`), so a live turn reaching it could never be
 * stopped — repeated presses just opened the rewind picker while the turn ran
 * on. Both layers now call this one decision, so "Esc stops" cannot depend on
 * which of them happened to receive the key.
 *
 * Queued messages keep the Claude Code meaning: the interrupt aborts the turn
 * and DOCKS the previews; the composer's dock hint offers `↑` to edit one or
 * `⏎` to send them all, and nothing re-delivers on its own.
 */
import { t } from '../i18n.js'

/** The slice of the channel this decision reads; both layers satisfy it. */
export interface TurnInterruptChannel {
  readonly working: boolean
  readonly cancelPending: boolean
  readonly pending: readonly { readonly docked?: boolean }[]
  cancel(): void
  interruptAndDock(): number
  notify(text: string, options?: { readonly color?: 'warning'; readonly timeoutMs?: number }): void
}

/**
 * Apply Esc's stop meaning to the turn in flight.
 * @param channel - live channel state; an idle channel makes this a no-op.
 * @param options - `stuck` adds the watchdog's stronger wording once the abort
 *   has been pending long enough that the turn looks wedged.
 * @returns true when Esc was consumed as a stop, so the caller must not arm or
 *   run any idle meaning (clear the draft, rewind) for this press.
 */
export function interruptTurnFromEscape(
  channel: TurnInterruptChannel,
  options: { readonly stuck?: boolean } = {},
): boolean {
  if (!channel.working && !channel.cancelPending) return false
  // Docking starts its own interrupt; when it docked nothing (everything
  // already parked) the turn still needs its plain abort.
  const undocked = channel.pending.some(item => item.docked !== true)
  if (undocked) {
    if (channel.interruptAndDock() === 0 && !channel.cancelPending) channel.cancel()
    return true
  }
  if (channel.cancelPending) {
    // The abort is already in flight: `cancel()`/`interruptAndDock()` ignore
    // repeats by contract, so answer the press instead of swallowing it. Past
    // the watchdog window the turn is wedged and the warning names `/restart`
    // (allowed mid-turn) as the way out.
    channel.notify(t(options.stuck === true ? 'interrupt-stuck' : 'interrupt-pending'), {
      color: 'warning',
      timeoutMs: options.stuck === true ? 10_000 : 4_000,
    })
    return true
  }
  channel.cancel()
  return true
}
