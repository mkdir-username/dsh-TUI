import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PendingMessage } from '../../adapter/ports/channel-view.js'
import type { ChannelState, ComposerImageRef } from './types.js'
import type { UserTextOrigin } from './input-delivery.js'

export const COMPACT_HOLD_ROW = 'compact-hold-'

/** The pending list and its repaint: the hold owns rows in the composer,
 *  so it needs both halves of that view. */
type HoldView = Pick<ChannelState, 'pending' | 'emit'>

/** A model-bound line parked while the manual /compact cycle runs. */
type ParkedLine = {
  readonly id: string
  readonly text: string
  readonly placement: PendingMessage['placement']
  readonly images: readonly ComposerImageRef[]
  readonly origin: UserTextOrigin
  readonly attach?: UserMessage
}

/**
 * Input queue of the manual /compact cycle (restruct-plan in the session fork
 * plus compaction). While the cycle runs, everything bound for the model is
 * parked as a docked composer row and not delivered; `queueUserMessages()`
 * — the "send the queue" path — hands the backlog over in order once the whole
 * cycle finished. A row the user takes back (↑ / Alt+↑) leaves the queue: only
 * what is still parked is delivered.
 */
export function createCompactHold({ state, notify, current, enqueue }: {
  state: () => HoldView
  notify: ChannelState['notify']
  current: (origin: UserTextOrigin) => boolean
  enqueue: (text: string, placement: PendingMessage['placement'], images: readonly ComposerImageRef[], origin: UserTextOrigin, attach?: UserMessage) => void
}) {
  let scope: { readonly agentId: string; readonly generation: number } | null = null
  let queue: ParkedLine[] | null = null

  const parked = (id: string): boolean => state().pending.some(item => item.id === id)

  const dropRow = (id: string): void => {
    const view = state()
    if (!view.pending.some(item => item.id === id)) return
    view.pending = view.pending.filter(item => item.id !== id)
    view.emit()
  }

  /** Hand the queue over after the whole /compact cycle. Returns how many were
   *  delivered: rows the user took back, and rows of a foreign (already
   *  replaced) session, are not sent. */
  const queueUserMessages = (): number => {
    const items = queue ?? []
    queue = null
    scope = null
    if (items.length === 0) return 0
    let sent = 0
    let kept = 0
    for (const item of items) {
      if (!parked(item.id)) continue
      if (!current(item.origin)) {
        kept += 1
        continue
      }
      dropRow(item.id)
      enqueue(item.text, 'followup', item.images, item.origin, item.attach)
      sent += 1
    }
    if (sent > 0) notify(`/compact завершён — отправляю очередь (${sent})`, { timeoutMs: 4000 })
    if (kept > 0) {
      notify(`/compact: ${kept} сообщ. осталось в очереди — сессия сменилась, отправь вручную`, {
        color: 'warning',
        timeoutMs: 8000,
      })
    }
    return sent
  }

  return {
    active: (): boolean => queue !== null,
    queueUserMessages,
    /** Only the installed session/generation parks: another live session keeps
     *  delivering while a background /compact finishes. */
    owns(agentId: string, generation: number): boolean {
      return queue !== null && scope !== null && scope.agentId === agentId && scope.generation === generation
    },
    install(nextScope?: { readonly agentId: string; readonly generation: number }): number {
      if (queue === null) queue = []
      if (nextScope !== undefined) scope = nextScope
      return queue.length
    },
    park({ text, placement, images, origin, attach }: {
      text: string
      placement: PendingMessage['placement']
      images: readonly ComposerImageRef[]
      origin: UserTextOrigin
      attach?: UserMessage
    }): boolean {
      if (queue === null) return false
      const id = `${COMPACT_HOLD_ROW}${randomUUID()}`
      const row: PendingMessage = {
        id,
        text,
        placement: 'followup',
        images: [...images],
        docked: true,
        heldCompact: true,
        ...(origin.attachedContexts === undefined || origin.attachedContexts.length === 0
          ? {}
          : { contexts: origin.attachedContexts }),
      }
      queue.push({ id, text, placement, images, origin, attach })
      const view = state()
      view.pending = [...view.pending, row]
      view.emit()
      notify(`/compact идёт — сообщение в очереди (${queue.length}); отправлю после сжатия`, { timeoutMs: 3000 })
      return true
    },
    /** Session switch: the queue is not delivered, the rows stay in the composer. */
    abandon(): number {
      const size = queue?.length ?? 0
      queue = null
      scope = null
      return size
    },
  }
}
