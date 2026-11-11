import type { SelectionState } from './selection.js'

/** The slice of `ScrollBoxHandle` the drag auto-scroller drives. */
export type DragAutoScrollHandle = {
  scrollBy: (dy: number) => void
  getScrollTop: () => number
  getScrollHeight: () => number
  getPendingDelta: () => number
  getViewportTop: () => number
  getViewportHeight: () => number
  getViewportLeft: () => number
  getViewportRight: () => number
}

export type DragAutoScrollScheduler = {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
}

export type DragAutoScrollerDeps = {
  handle: DragAutoScrollHandle
  getState: () => SelectionState | null
  subscribe: (cb: () => void) => () => void
  scheduler?: DragAutoScrollScheduler
  intervalMs?: number
  step?: number
  accelerateAfterMs?: number
  acceleratedStep?: number
}

export type DragAutoScroller = {
  dispose: () => void
  isActive: () => boolean
}

const DEFAULT_INTERVAL_MS = 50
const DEFAULT_STEP = 1
const DEFAULT_ACCELERATE_AFTER_MS = 600
const DEFAULT_ACCELERATED_STEP = 3
const NO_OP_TICKS_TO_STOP = 2

const defaultScheduler: DragAutoScrollScheduler = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const id: ReturnType<typeof setInterval> = setInterval(fn, ms)
    // The TUI keeps stdin ref'd; the drag timer must not hold the process
    // open while a pointer rests on an edge.
    if (typeof id === 'object' && id !== null && 'unref' in id) id.unref()
    return id
  },
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
}

/**
 * Which way a drag at `focusRow` should scroll the viewport. The row is a
 * screen-buffer row, the same space as `ScrollBoxHandle.getViewportTop()`.
 * The edges are inclusive: a pointer drawn onto the first or last visible
 * row keeps scrolling without leaving the box.
 * @param focusRow - current pointer row in screen-buffer space.
 * @param viewportTop - first visible content row.
 * @param viewportHeight - visible row count.
 * @returns +1 at the bottom edge, -1 at the top edge, 0 inside.
 */
export function edgeScrollDirection(
  focusRow: number,
  viewportTop: number,
  viewportHeight: number,
): -1 | 0 | 1 {
  if (viewportHeight <= 0) return 0
  const bottomRow = viewportTop + viewportHeight - 1
  if (focusRow >= bottomRow) return 1
  if (focusRow <= viewportTop) return -1
  return 0
}

/**
 * Keep a transcript scrolling while a text-selection drag rests on a viewport
 * edge. The renderer already translates an active selection for every scroll
 * delta (`pendingScrollDelta` drains become follow-scroll events; ink.tsx
 * shifts the anchor and captures rows about to leave the viewport), so a tick
 * only drives `scrollBy` and lets that existing machinery do the selection
 * bookkeeping.
 *
 * Starts only for an active drag anchored inside this viewport — row AND
 * column: with a split sidebar both panes share rows and register themselves
 * as selection panes, so `paneId`/`fence` are present even for a chat drag.
 * A gesture that began on a noSelect cell (scrollbar gutter, panel chrome)
 * sets `includeNoSelectCells` and is ignored. Stops on release, on leaving
 * the edge, on a scroll boundary, after two ticks that moved nothing, and on
 * dispose.
 * @param deps - scroll handle, selection accessors, and tuning knobs.
 * @returns a disposable controller; `isActive()` reports whether it is ticking.
 */
export function createDragAutoScroller(deps: DragAutoScrollerDeps): DragAutoScroller {
  const scheduler = deps.scheduler ?? defaultScheduler
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const step = deps.step ?? DEFAULT_STEP
  const accelerateAfterMs = deps.accelerateAfterMs ?? DEFAULT_ACCELERATE_AFTER_MS
  const acceleratedStep = deps.acceleratedStep ?? DEFAULT_ACCELERATED_STEP

  let timer: unknown = null
  let startedAt = 0
  let noOpTicks = 0
  let disposed = false
  // Raw pointer row captured on a selection change. The follow machinery
  // shifts `focus` together with the text on every scroll frame, so reading
  // `focus` from a tick would walk the "pointer" out of the edge band after a
  // row or two; the mutation event is the only place the row is still the
  // mouse position.
  let pointerRow: number | null = null

  const stop = (): void => {
    if (timer === null) return
    scheduler.clearInterval(timer)
    timer = null
    noOpTicks = 0
    pointerRow = null
    const state = deps.getState()
    if (state) state.autoScrolling = false
  }

  const tick = (): void => {
    const state = deps.getState()
    if (!state?.isDragging || pointerRow === null) {
      stop()
      return
    }
    const viewportTop = deps.handle.getViewportTop()
    const viewportHeight = deps.handle.getViewportHeight()
    const direction = edgeScrollDirection(pointerRow, viewportTop, viewportHeight)
    if (direction === 0) {
      stop()
      return
    }

    // scrollBy accumulates into pendingScrollDelta and the renderer drains it
    // a frame later, so the committed scrollTop alone cannot tell whether the
    // last notch landed. At the boundary of travel the notch is a no-op; stop
    // before the accumulator grows debt in the opposite direction.
    const maxScroll = Math.max(0, deps.handle.getScrollHeight() - viewportHeight)
    const scrollTop = deps.handle.getScrollTop()
    const pending = deps.handle.getPendingDelta()
    const atBoundary = direction > 0
      ? scrollTop >= maxScroll && pending >= 0
      : scrollTop <= 0 && pending <= 0
    if (atBoundary) {
      stop()
      return
    }

    const amount = scheduler.now() - startedAt >= accelerateAfterMs ? acceleratedStep : step
    state.autoScrolling = true
    // The follow shift moves BOTH endpoints with the text, so a held pointer
    // would otherwise walk away from the edge as the selection scrolls. Pin
    // the moving end back to the pointer row before each notch: the anchor
    // keeps tracking its text, the focus stays where the mouse is.
    if (state.focus && state.focus.row !== pointerRow) {
      state.focus = { col: state.focus.col, row: pointerRow }
      state.virtualFocusRow = undefined
    }
    const before = scrollTop + pending
    deps.handle.scrollBy(direction * amount)
    const after = deps.handle.getScrollTop() + deps.handle.getPendingDelta()
    if (after === before) {
      noOpTicks += 1
      if (noOpTicks >= NO_OP_TICKS_TO_STOP) stop()
      return
    }
    noOpTicks = 0
  }

  const sync = (): void => {
    if (disposed) return
    const state = deps.getState()
    const focus = state?.focus
    const anchor = state?.anchor
    if (!state?.isDragging || !focus || !anchor || state.includeNoSelectCells === true) {
      stop()
      return
    }
    const viewportTop = deps.handle.getViewportTop()
    const viewportHeight = deps.handle.getViewportHeight()
    const viewportLeft = deps.handle.getViewportLeft()
    const viewportRight = deps.handle.getViewportRight()
    const bottomRow = viewportTop + viewportHeight - 1
    const anchorInViewport = anchor.row >= viewportTop && anchor.row <= bottomRow
      && anchor.col >= viewportLeft && anchor.col <= viewportRight
    if (!anchorInViewport || edgeScrollDirection(focus.row, viewportTop, viewportHeight) === 0) {
      stop()
      return
    }
    pointerRow = focus.row
    if (timer !== null) return
    startedAt = scheduler.now()
    noOpTicks = 0
    timer = scheduler.setInterval(tick, intervalMs)
  }

  const unsubscribe = deps.subscribe(sync)
  sync()

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      stop()
      unsubscribe()
    },
    isActive: () => timer !== null,
  }
}
