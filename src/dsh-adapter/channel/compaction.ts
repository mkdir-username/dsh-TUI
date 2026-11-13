import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ManualCompactionStage } from '../../adapter/ports/channel-view.js'
import { t } from '../../i18n.js'
import { WORKING_GATE_NOTICES } from '../../commands.js'
import { dispatchTuiDecision, normalizeCancelDecision } from '../extension-events.js'
import { serviceForAgent } from '../presets.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'
import { isTokenDelta, tokenDeltaChars } from './usage.js'

interface ManualCompaction {
  controller: AbortController
  settled: Promise<void>
  row: ChannelState['compaction']
}

interface CompactCycle {
  stage: ManualCompactionStage
  preparation: AbortController
  /** The user stopped the cycle from the status row. */
  cancelRequested?: boolean
}

type CompactionState = Pick<ChannelState, 'agentId' | 'agentBindingGeneration' | 'cwd' | 'working' | 'compaction' | 'manualCompactionStage' | 'emit' | 'emitStream'>
type Notify = ChannelState['notify']

/** The activation result shape the verdict reads (structural: the subagents
 *  service is a host service, not a package dependency). */
interface RestructPlanResult {
  readonly stopReason?: string
  readonly diagnostic?: string
  readonly output?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>
}
interface SubagentsService {
  getProvider(name: string): unknown
  startActivation(request: {
    readonly provider: string
    readonly label: string
    readonly request: { readonly prompt: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>; readonly parent: Agent }
    readonly signal: AbortSignal
    readonly delivery: 'caller'
  }): Promise<{ readonly result: Promise<RestructPlanResult>; readonly dispose?: () => Promise<void> }>
}

/** `Agent.runMaintenance` (DSH 0.2+): a non-turn phase that keeps waking input
 *  in the inbox until the task settles. Nullish on older hosts. */
type MaintenanceRunner = <T>(task: (signal: AbortSignal) => Promise<T>) => Promise<T>
const maintenanceOf = (agent: Agent): MaintenanceRunner | undefined => {
  const run = (agent as { runMaintenance?: MaintenanceRunner }).runMaintenance
  return typeof run === 'function'
    ? <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => Reflect.apply(run, agent, [task])
    : undefined
}
/** The compaction engine claims its own maintenance span before summarizing;
 *  inside the cycle's span that second claim would throw. Forward the whole
 *  agent and run only that method inline in the phase the cycle already owns. */
const heldCompactionAgent = (agent: Agent, signal: AbortSignal): Agent => new Proxy(agent, {
  get(target, property) {
    if (property === 'runMaintenance') {
      return <T>(task: (taskSignal: AbortSignal) => Promise<T>): Promise<T> => task(signal)
    }
    return Reflect.get(target, property, target)
  },
})

/** One manual compaction transaction per live agent, including agents parked
 * by `/bg`. `settle` aborts the transaction of the FOREGROUND binding — the
 * session a switch is leaving — so returning to a compacting background session
 * keeps it running while navigating to a different one still settles it. */
export function createManualCompaction(
  ctx: Context,
  state: CompactionState,
  deps: {
    owner: Pick<ChannelOwner, 'current' | 'signal' | 'own'>
    agent(): Agent
    withDecisionPending<T>(name: string, pending: Promise<T>): Promise<T>
    notify: Notify
    /** Park every model-bound line while the cycle runs (the shared hold). */
    holdCompact?(scope: { readonly agentId: string; readonly generation: number }): number
    /** Cycle finished: hand the parked lines over in order. */
    releaseCompact?(): void
    /** Session replaced: keep the rows, deliver nothing. */
    abandonCompact?(): void
  },
) {
  const active = new Map<Agent, ManualCompaction>()
  const cycles = new WeakMap<Agent, CompactCycle>()
  let holdOwner: CompactCycle | undefined

  const closeCycle = (agent: Agent, cycle: CompactCycle): void => {
    if (cycles.get(agent) !== cycle) return
    cycles.delete(agent)
    if (deps.agent() === agent) {
      state.manualCompactionStage = undefined
      state.emit()
    }
  }
  const holdInputs = (cycle: CompactCycle): void => {
    holdOwner = cycle
    deps.holdCompact?.({ agentId: state.agentId, generation: state.agentBindingGeneration })
  }
  const abandonHold = (): void => {
    holdOwner = undefined
    deps.abandonCompact?.()
  }
  deps.owner.own(() => { state.manualCompactionStage = undefined })

  const cancelled = new WeakSet<AbortController>()
  /** Aborts the user asked for (Esc / Ctrl+C) rather than an ownership change:
   *  only those are reported as a cancellation instead of a failure. */
  const userCancelled = new WeakSet<AbortController>()
  deps.owner.own(ctx.on('agent/disposed', ({ agent }) => {
    const cycle = cycles.get(agent)
    if (cycle !== undefined) {
      if (holdOwner === cycle) abandonHold()
      closeCycle(agent, cycle)
      cycle.preparation.abort(new Error('agent disposed'))
    }
    const transaction = active.get(agent)
    if (transaction === undefined) return
    active.delete(agent)
    cancelled.add(transaction.controller)
    transaction.controller.abort(new Error('agent disposed'))
  }))

  const settle = async (): Promise<void> => {
    const agent = deps.agent()
    const cycle = cycles.get(agent)
    if (cycle !== undefined) {
      closeCycle(agent, cycle)
      cycle.preparation.abort(new Error('session switch'))
    }
    abandonHold()
    const transaction = active.get(agent)
    if (cycle !== undefined || transaction !== undefined) {
      deps.notify(t('compact-cancelled-switch'), { color: 'warning', timeoutMs: 4000 })
    }
    if (transaction === undefined) return
    active.delete(agent)
    cancelled.add(transaction.controller)
    transaction.controller.abort(new Error('session switch'))
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        transaction.settled,
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 3000) }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  /** Grammar: /compact runs restruct-plan first, /compact --pure is the plain
   *  compaction. */
  function parseCompactInput(rawInput: string | undefined): { kind: 'pure' } | { kind: 'error'; text: string } | { kind: 'restruct' } {
    const args = String(rawInput ?? '').trim()
    if (args === '--pure' || args === '+pure' || args === 'pure') return { kind: 'pure' }
    if (args !== '') return { kind: 'error', text: 'Usage: /compact [--pure]' }
    return { kind: 'restruct' }
  }
  /** The fork must end on a restruct-plan verdict marker; anything else means
   *  the knowledge was not written down, and the compaction is blocked. */
  function restructPlanVerdict(result: RestructPlanResult): { ok: true; notice: string } | { ok: false; reason: string } {
    const text = (result.output ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n')
      .trim()
    const last = text.split('\n').filter(line => line.trim() !== '').pop() ?? ''
    // Human-shaped markers: `RP_SKIP: reason`, `**RP_DONE x**`, a list item. Requiring
    // one exact space after the token blocked the compaction on a colon.
    if (result.stopReason === 'completed' && /^\s*(?:[*_`>+-]+\s*)?RP_(DONE|SKIP)\b/i.test(last)) return { ok: true, notice: `compact-rp: ${last}` }
    const why = result.stopReason === 'completed'
      ? 'форк закончился без маркера RP_DONE/RP_SKIP'
      : `форк завершился аварийно (${result.stopReason ?? 'unknown'}${result.diagnostic !== undefined ? ': ' + result.diagnostic : ''})`
    return {
      ok: false,
      reason: `compact-rp: ${why}. Сжатие остановлено, знание не потеряно. Без restruct-plan: /compact --pure`,
    }
  }
  /** The child's own terminal error, for the notice: an in-process fork settles
   *  with `stopReason: 'error'` and no diagnostic, and the durable child log is
   *  the one place the provider failure text lives. Missing agent/log/event
   *  leaves the notice as before — never worse. */
  function diagnosticOfChild(ctx: Context, activation: { readonly childId?: unknown }): string | undefined {
    const agents = (ctx as Context & {
      agents?: { get?(id: unknown): { session?: { snapshotEvents?(): readonly { readonly type: string; readonly data?: unknown }[] } } | undefined }
    }).agents
    const child = activation.childId === undefined ? undefined : agents?.get?.(activation.childId)
    const events = child?.session?.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== 'turn/end') continue
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason
      return reason?.kind === 'error' && typeof reason.error?.message === 'string' ? reason.error.message : undefined
    }
    return undefined
  }
  const RP_PROMPT = 'Пользователь набрал /compact: это его явная команда выполнить restruct-plan сейчас, до сжатия контекста. Ты — форк этой сессии, запущенный TUI, история диалога тебе видна. Вызови Skill restruct-plan для плана .dev/<slug>/, над которым шла работа, и запиши на диск всё, что знает только диалог: прогресс, грабли, тупики, проверенные факты. Перед записью в .dev/ прочитай каталог плана — его сторожит гейт dev-docs. Вопросов не задавай, ответить некому. Ничего не коммить и не пушить. Последней строкой ответа выведи ровно RP_DONE <slug> или RP_SKIP <причина>.'
  const RP_TIMEOUT_MS = 15 * 60 * 1000
  /** `activation.result` settles only when the child finishes: a fork that hangs
   *  (or ignores its abort) would otherwise keep the cycle, and with it the whole
   *  agent hold, waiting long past `RP_TIMEOUT_MS`. The cycle's own signals end
   *  the wait; the child is released separately. */
  const settledOrAborted = async <T>(result: Promise<T>, signal: AbortSignal): Promise<T> => {
    let detach = (): void => {}
    try {
      return await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          const fail = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('restruct-plan aborted'))
          if (signal.aborted) return fail()
          signal.addEventListener('abort', fail, { once: true })
          detach = () => signal.removeEventListener('abort', fail)
        }),
      ])
    } finally {
      detach()
    }
  }
  async function runRestructPlan(ctx: Context, agent: Agent, preparation: AbortSignal): Promise<{ ok: true; notice: string } | { ok: false; reason: string }> {
    const subagents = (ctx.get('subagents') ?? (agent.ctx as Context).get('subagents')) as SubagentsService | undefined
    if (subagents === undefined) return { ok: false, reason: 'compact-rp: сервис subagents не смонтирован. Без restruct-plan: /compact --pure' }
    if (subagents.getProvider('fork') === undefined) return { ok: false, reason: 'compact-rp: провайдер «fork» не смонтирован. Без restruct-plan: /compact --pure' }
    const signal = AbortSignal.any([deps.owner.signal, preparation, AbortSignal.timeout(RP_TIMEOUT_MS)])
    let activation: { readonly result: Promise<RestructPlanResult>; readonly dispose?: () => Promise<void>; readonly childId?: unknown } | undefined
    try {
      activation = await subagents.startActivation({
        provider: 'fork',
        label: 'restruct-plan',
        request: { prompt: [{ type: 'text', text: RP_PROMPT }], parent: agent },
        signal,
        delivery: 'caller',
      })
      const result = await settledOrAborted(activation.result, signal)
      return restructPlanVerdict({ ...result, diagnostic: result.diagnostic ?? diagnosticOfChild(ctx, activation) })
    } catch (error: unknown) {
      if (activation !== undefined && signal.aborted) {
        // The fork kept its own request after the abort (live probe 2026-11-12),
        // so stop it: the cycle is over and `dispose` is the only handle left.
        void activation.dispose?.().catch(() => {})
        const why = signal.reason instanceof Error ? signal.reason.message : 'отмена'
        return { ok: false, reason: `compact-rp: restruct-plan прерван (${why}). Сжатие остановлено. Без restruct-plan: /compact --pure` }
      }
      return {
        ok: false,
        reason: `compact-rp: restruct-plan не запустился (${error instanceof Error ? error.message : String(error)}). Сжатие остановлено. Без restruct-plan: /compact --pure`,
      }
    }
  }
  /** A turn may start while the fork runs: the compaction waits for idle
   *  instead of being thrown away. */
  const IDLE_WAIT_MS = 5 * 60 * 1000
  const IDLE_POLL_MS = 250
  const waitUntilIdle = (current: () => boolean): Promise<boolean> => new Promise((resolve) => {
    const deadline = Date.now() + IDLE_WAIT_MS
    const tick = (): void => {
      if (!current()) return resolve(false)
      if (!state.working) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, IDLE_POLL_MS).unref?.()
    }
    tick()
  })
  const compact = (rawInput = ''): void => {
    const input = parseCompactInput(rawInput)
    if (input.kind === 'error') {
      deps.notify(input.text, { color: 'warning', timeoutMs: 8000 })
      return
    }
    if (!deps.owner.current() || deps.owner.signal.aborted) return
    const originAgent = deps.agent()
    if (state.working) {
      deps.notify(t(WORKING_GATE_NOTICES.compact), { color: 'warning' })
      return
    }
    if (cycles.has(originAgent)) {
      deps.notify('compact-rp: /compact уже выполняется', { color: 'warning', timeoutMs: 4000 })
      return
    }
    const cycle: CompactCycle = {
      preparation: new AbortController(),
      stage: { phase: input.kind === 'pure' ? 'checking' : 'restruct-plan', startedAt: Date.now(), cancellable: true },
    }
    cycles.set(originAgent, cycle)
    holdInputs(cycle)
    state.manualCompactionStage = cycle.stage
    state.emit()

    const current = () => deps.owner.current() && deps.agent() === originAgent && cycles.get(originAgent) === cycle
    const finish = (): void => {
      closeCycle(originAgent, cycle)
      if (holdOwner !== cycle) return
      holdOwner = undefined
      try { deps.releaseCompact?.() } catch {}
    }
    const run = async (): Promise<void> => {
      // The decision gates the WHOLE cycle: the restruct-plan fork writes to
      // disk, so a vetoed /compact must not start it. Asking before the agent
      // is held also keeps a slow dialog from freezing the session.
      const decision = await deps.withDecisionPending('tui/compact', dispatchTuiDecision(ctx, 'tui/compact', {
        sessionId: state.agentId,
        cwd: state.cwd,
      }, normalizeCancelDecision))
      if (!current()) return
      if (decision !== undefined) {
        deps.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
        return
      }
      if (originAgent.status === 'running' || (deps.agent() === originAgent && state.working)) {
        deps.notify(t(WORKING_GATE_NOTICES.compact), { color: 'warning' })
        return
      }
      /** True when the cycle must stop before the next step: the binding moved
       *  or the user cancelled the preparation. */
      const stopped = (): boolean => {
        if (!current()) return true
        if (cycle.cancelRequested === true) {
          deps.notify(t('compact-cancelled'))
          return true
        }
        return cycle.preparation.signal.aborted
      }
      const cycleTask = async (holdSignal: AbortSignal | undefined): Promise<void> => {
        if (input.kind === 'restruct') {
          const verdict = await runRestructPlan(
            ctx,
            originAgent,
            holdSignal === undefined
              ? cycle.preparation.signal
              : AbortSignal.any([cycle.preparation.signal, holdSignal]),
          )
          if (stopped()) return
          if (!verdict.ok) {
            deps.notify(verdict.reason, { color: 'error', timeoutMs: 12000 })
            return
          }
          deps.notify(verdict.notice)
          if (holdSignal === undefined && state.working) {
            // A host without runMaintenance: a turn that started while the
            // fork ran still has to finish before the summary.
            // Esc and Ctrl+C hand the key to the running turn first, so this row
            // must not advertise a cancel it cannot deliver.
            cycle.stage = { ...cycle.stage, phase: 'wait-idle', cancellable: false }
            state.manualCompactionStage = cycle.stage
            state.emit()
            if (!await waitUntilIdle(() => current() && !cycle.preparation.signal.aborted)) {
              if (cycle.cancelRequested === true) deps.notify(t('compact-cancelled'))
              else if (current()) deps.notify(`compact-rp: ход не освободился за ${IDLE_WAIT_MS / 60000} минут — сжатие отменено. Повтори /compact`, { color: 'warning', timeoutMs: 12000 })
              return
            }
            if (stopped()) return
          }
          cycle.stage = { ...cycle.stage, phase: 'checking', cancellable: true }
          state.manualCompactionStage = cycle.stage
          state.emit()
        }
        if (stopped()) return
        await compactNow(originAgent, cycle, holdSignal)
      }
      const maintenance = maintenanceOf(originAgent)
      if (maintenance === undefined) {
        await cycleTask(undefined)
        return
      }
      let held: Promise<void>
      try {
        // Throws synchronously while a turn or another maintenance owns the
        // agent; nothing was started in that case.
        held = maintenance(cycleTask)
      } catch {
        deps.notify(t(WORKING_GATE_NOTICES.compact), { color: 'warning' })
        return
      }
      await held
    }
    void run().catch((error: unknown) => {
      if (current()) {
        deps.notify(`compact-rp: ${error instanceof Error ? error.message : String(error)}`, { color: 'error', timeoutMs: 12000 })
      }
    }).finally(finish)
  }
  const compactNow = (originAgent: Agent, cycle: CompactCycle, holdSignal?: AbortSignal): Promise<void> => {
    if (active.has(originAgent)) return Promise.resolve()
    const compactService = serviceForAgent<{
      compactNow(agent: unknown, signal: AbortSignal): Promise<unknown>
    }>(ctx, originAgent, 'compaction')
    if (!compactService) {
      deps.notify(t('compact-unavailable'), { color: 'warning' })
      return Promise.resolve()
    }
    if (state.working) {
      deps.notify(t(WORKING_GATE_NOTICES.compact), { color: 'warning' })
      return Promise.resolve()
    }
    const controller = new AbortController()
    const operationSignal = holdSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, holdSignal])
    const transaction: ManualCompaction = { controller, settled: Promise.resolve(), row: undefined }
    const isLive = () => deps.owner.current()
      && !deps.owner.signal.aborted
      && cycles.get(originAgent) === cycle
      && !cancelled.has(controller)
    const isCurrent = () => isLive() && deps.agent() === originAgent
    let disposeStream: (() => void) | undefined
    let disposeEnd: (() => void) | undefined
    const releaseOwner = deps.owner.own(() => {
      cancelled.add(controller)
      controller.abort(new Error('channel lifetime ended'))
      try { disposeStream?.() } finally { disposeEnd?.() }
    })
    let finished = false
    const settled = (async () => {
      try {
        if (originAgent.status === 'running' || (isCurrent() && state.working)) {
          if (isCurrent()) deps.notify(t(WORKING_GATE_NOTICES.compact), { color: 'warning' })
          return
        }
        const row = {
          startedAt: cycle.stage.startedAt,
          phase: 'prefill' as const,
          outputChars: 0,
          cancellable: true,
        }
        transaction.row = row
        // The native row masks this stage until the bracket closes. The
        // service still has to flush the checkpoint after compaction/end.
        cycle.stage = { ...cycle.stage, phase: 'finalizing' }
        if (isCurrent()) {
          state.manualCompactionStage = cycle.stage
          state.compaction = row
          state.emit()
        }
        // Unlike the foreground stream subscription, this observer stays with
        // the transaction across rebinds. The feed delegates manual progress
        // here so a chunk is counted once, including after returning from /bg.
        disposeStream = ctx.on('llm/stream', (options, next) => {
          const stream = next()
          if (!isLive() || options.purpose !== 'compaction' || options.sessionId === undefined
            || String(options.sessionId) !== String(originAgent.session.id)) return stream
          return (async function* () {
            for await (const chunk of stream) {
              if (isLive() && transaction.row !== undefined && isTokenDelta(chunk)) {
                transaction.row = { ...transaction.row, phase: 'summary', outputChars: transaction.row.outputChars + tokenDeltaChars(chunk) }
                if (isCurrent()) {
                  state.compaction = transaction.row
                  state.emitStream()
                }
              }
              yield chunk
            }
          })()
        })
        disposeEnd = ctx.on('session/event', (session, event) => {
          // Older hosts carry the bracket as legacy events outside the
          // current SessionEvent union, just like the DSH translator accepts.
          if (session !== originAgent.session || (event as { type: string }).type !== 'compaction/end') return
          // Retire the row HERE as well. Clearing only the transaction row
          // would defeat the identity check in the `finally` below and leave a
          // stale cancellable row whenever the projector does not also fold
          // this event (a host whose translator drops the legacy bracket).
          if (isCurrent() && state.compaction === transaction.row) {
            state.compaction = undefined
            state.emit()
          }
          transaction.row = undefined
        })
        try {
          // Compact the entry agent, never a later binding read after await.
          const result = await compactService.compactNow(
            holdSignal === undefined ? originAgent : heldCompactionAgent(originAgent, operationSignal),
            operationSignal,
          )
          if (!isCurrent()) return
          deps.notify(result ? t('compact-done') : t('compact-nothing'))
        } catch (error: unknown) {
          if (userCancelled.has(controller)) {
            if (isCurrent()) deps.notify(t('compact-cancelled'))
            return
          }
          if (!isCurrent() || cancelled.has(controller)) return
          if ((error as { code?: unknown }).code === 'persistence') {
            deps.notify(t('compact-flush-failed'), { color: 'warning', timeoutMs: 12000 })
            return
          }
          deps.notify(
            t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
            { color: 'error', timeoutMs: 8000 },
          )
        }
      } catch (error: unknown) {
        // dispatch is normally isolated, but do not create an unhandled
        // rejection if an embedder's pending wrapper fails.
        if (!isCurrent()) return
        deps.notify(
          t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
      } finally {
        finished = true
        // The durable `compaction/end` event already cleared the row on every
        // path that reached the host; this covers the ones that never did
        // (vetoed decision, unavailable service, a throw before the bracket).
        if (deps.agent() === originAgent && state.compaction !== undefined && state.compaction === transaction.row) {
          state.compaction = undefined
          state.emit()
        }
        if (active.get(originAgent) === transaction) active.delete(originAgent)
        releaseOwner()
      }
    })()
    // Install before the decision await so a switch/fork settles a pending
    // decision too, rather than letting it start compaction after its seed.
    // A synchronous embedder failure is already handled by the IIFE above.
    transaction.settled = settled
    if (!finished) active.set(originAgent, transaction)
    // The /compact chain waits for the END of the compaction, not for the
    // moment its transaction was installed.
    return transaction.settled
  }

  /** Abort the in-flight manual compaction the user asked to stop. */
  const cancel = (): void => {
    const agent = deps.agent()
    const transaction = active.get(agent)
    if (transaction !== undefined) {
      userCancelled.add(transaction.controller)
      transaction.controller.abort(new Error('user cancelled compaction'))
      return
    }
    const cycle = cycles.get(agent)
    if (cycle === undefined) return
    // The fork and the pre-transaction prefill are stopped through the
    // cycle's own signal; the summary has its transaction branch above.
    cycle.cancelRequested = true
    cycle.preparation.abort(new Error('user cancelled compaction'))
  }

  /** Rebinding restores only the foreground agent's live work. */
  const restore = (): void => {
    const agent = deps.agent()
    const cycle = cycles.get(agent)
    const stage = cycle?.stage
    const transaction = active.get(agent)
    if (cycle !== undefined) holdInputs(cycle)
    if (state.manualCompactionStage === stage && transaction === undefined) return
    state.manualCompactionStage = stage
    if (transaction !== undefined) state.compaction = transaction.row
    state.emit()
  }

  return { compact, settle, cancel, restore, ownsProgress: () => active.get(deps.agent())?.row !== undefined }
}
