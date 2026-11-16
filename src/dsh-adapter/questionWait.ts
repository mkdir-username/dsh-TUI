/**
 * Timed-wait claim over the DSH user-questions seam (`ctx.userQuestions`).
 *
 * A foreground ask carries `wait: { callId, timed: true }`, and the host counts
 * its deadline down only while no answer UI holds a claim (`attachWait`); the
 * documented contract asks a timed answerer to attach before starting its own
 * countdown. The questionnaire therefore holds the claim from the moment the
 * ask is on screen and runs its own idle window: every touch re-arms that
 * window, so typing or moving between options is work, not idleness. When the
 * window runs out the claim is dropped and the host — its own deadline long
 * past — settles the ask as pending, exactly like an unattended question.
 *
 * The idle window is the ask's own remaining foreground window, read from the
 * host's first frame: no second timeout setting appears, and a question nobody
 * touches still expires when the asker meant it to.
 */

import type { QuestionActivityObserver, QuestionRequest } from '../channel/questions.js'

/** The slice of the host service this module drives (no vendor types). */
export interface TimedWaitService {
  attachWait(agent: unknown, callId: string, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>
}

/** The protocol fields the neutral store passes through untouched. */
interface TimedAsk {
  readonly wait?: { readonly callId?: string; readonly timed?: boolean }
  readonly agent?: unknown
}

export interface QuestionWaitClaimOptions {
  /** Test seam for the idle window (defaults to the process timers). */
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  /** Quiet diagnostics; never stdout while the TUI owns the terminal. */
  readonly log?: (message: string) => void
}

interface Claim {
  readonly request: QuestionRequest
  readonly controller: AbortController
  /** Idle window, captured from the host's first frame when the claim lands. */
  windowMs: number
  timer: unknown
  released: boolean
}

/**
 * Build the claim when the host exposes `attachWait`, or `undefined` so an
 * older host simply keeps its plain deadline.
 * @param service - The host `userQuestions` service (structurally).
 * @param options - Timer and logging seams.
 */
export function createQuestionWaitClaim(
  service: unknown,
  options: QuestionWaitClaimOptions = {},
): QuestionWaitClaim | undefined {
  const attach = (service as { attachWait?: unknown } | undefined)?.attachWait
  return typeof attach === 'function' ? new QuestionWaitClaim(service as TimedWaitService, options) : undefined
}

/**
 * Holds one timed ask's host wait for as long as the user keeps working on it.
 * The store drives it: `active` on every change of the ask on screen, `touch`
 * on each keystroke or click. Releasing is always safe — an answered ask has
 * already settled, and an idle one is settled by the host on release.
 */
export class QuestionWaitClaim implements QuestionActivityObserver {
  private readonly schedule: (callback: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void
  private readonly log: (message: string) => void
  private claim: Claim | undefined
  /** Last ask reported by the store, so the same ask is never claimed twice. */
  private last: QuestionRequest | undefined

  constructor(private readonly port: TimedWaitService, options: QuestionWaitClaimOptions = {}) {
    this.schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
    this.cancel = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.log = options.log ?? (() => {})
  }

  active(request: QuestionRequest | undefined): void {
    if (request === this.last) return
    this.last = request
    this.release(this.claim)
    if (request === undefined) return
    const timed = request as QuestionRequest & TimedAsk
    const callId = timed.wait?.callId
    if (timed.wait?.timed !== true || callId === undefined || timed.agent === undefined) return
    const claim: Claim = {
      request,
      controller: new AbortController(),
      windowMs: 0,
      timer: undefined,
      released: false,
    }
    this.claim = claim
    void this.attach(claim, callId, timed.agent)
  }

  touch(): void {
    const claim = this.claim
    // Before the host's first frame there is no window to re-arm: attaching
    // lands the claim and arms it from the ask's own remaining time.
    if (claim === undefined || claim.windowMs <= 0) return
    this.arm(claim)
  }

  dispose(): void {
    this.last = undefined
    this.release(this.claim)
  }

  private async attach(claim: Claim, callId: string, agent: unknown): Promise<void> {
    try {
      const frames = this.port.attachWait(agent, callId, claim.controller.signal)
      const first = await frames[Symbol.asyncIterator]().next()
      // A newer ask replaced this one, or it was released while attaching.
      if (this.claim !== claim || claim.released) return
      const remainingMs = first.done === true ? undefined : first.value?.remainingMs
      // No frames means the host wait was already over: nothing to hold.
      if (remainingMs === undefined || !Number.isFinite(remainingMs) || remainingMs <= 0) {
        this.release(claim)
        return
      }
      claim.windowMs = remainingMs
      this.arm(claim)
    } catch (error) {
      if (this.claim === claim) this.claim = undefined
      this.log(`dsh-tui: timed question claim unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  private arm(claim: Claim): void {
    if (claim.released) return
    this.cancel(claim.timer)
    claim.timer = this.schedule(() => this.expire(claim), claim.windowMs)
  }

  /** The idle window ran out: drop the claim, the host settles the ask as pending. */
  private expire(claim: Claim): void {
    if (this.claim !== claim) return
    this.log(`dsh-tui: timed question idle for ${claim.windowMs} ms, releasing the wait`)
    this.release(claim)
  }

  private release(claim: Claim | undefined): void {
    if (claim === undefined) return
    if (this.claim === claim) this.claim = undefined
    if (claim.released) return
    claim.released = true
    this.cancel(claim.timer)
    claim.controller.abort(new Error('the timed question claim closed'))
  }
}
