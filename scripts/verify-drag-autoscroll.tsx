/**
 * verify-drag-autoscroll — regression for drag-to-edge auto-scroll.
 *
 * During a fullscreen text-selection drag, holding the pointer on the top or
 * bottom row of the transcript viewport must keep scrolling the transcript so
 * the selection can grow past the original viewport. The controller here is
 * pure: the Ink renderer already translates an active selection for every
 * scroll delta (render-node-to-output records pendingScrollDelta drains as
 * followScrolls; ink.tsx shifts the anchor and captures rows about to leave),
 * so a tick only has to call `handle.scrollBy(±step)`.
 *
 * Run: node --import tsx/esm scripts/verify-drag-autoscroll.tsx
 */
import assert from 'node:assert/strict'
import { createDragAutoScroller, edgeScrollDirection } from '../src/ink/drag-autoscroll.js'
import { createSelectionState, type SelectionState } from '../src/ink/selection.js'

let failures = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`FAIL ${name}`)
    console.error(`      expected: ${e}`)
    console.error(`      actual:   ${a}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

/** Selection with the mouse down at `anchorRow` and the pointer at `focusRow`. */
function dragging(anchorRow: number, focusRow: number, extra: Partial<SelectionState> = {}): SelectionState {
  const state = createSelectionState()
  state.anchor = { row: anchorRow, col: 3 }
  state.focus = { row: focusRow, col: 5 }
  state.isDragging = true
  return Object.assign(state, extra)
}

type FakeHandleOptions = {
  viewportTop?: number
  viewportHeight?: number
  viewportLeft?: number
  viewportRight?: number
  scrollHeight?: number
  /** Committed scrollTop the fake starts at. */
  startTop?: number
  /** When set, scrollBy is a no-op and scrollTop never moves. */
  frozen?: boolean
}

function fakeHandle(options: FakeHandleOptions = {}) {
  const viewportTop = options.viewportTop ?? 2
  const viewportHeight = options.viewportHeight ?? 10
  const viewportLeft = options.viewportLeft ?? 0
  const viewportRight = options.viewportRight ?? 19
  const scrollHeight = options.scrollHeight ?? 100
  let scrollTop = options.startTop ?? 0
  let pending = 0
  const calls: number[] = []
  return {
    calls,
    scrollBy(dy: number) {
      calls.push(dy)
      if (options.frozen === true) return
      const max = Math.max(0, scrollHeight - viewportHeight)
      scrollTop = Math.min(max, Math.max(0, scrollTop + Math.trunc(dy)))
    },
    getScrollTop: () => scrollTop,
    getScrollHeight: () => scrollHeight,
    getPendingDelta: () => pending,
    getViewportTop: () => viewportTop,
    getViewportHeight: () => viewportHeight,
    getViewportLeft: () => viewportLeft,
    getViewportRight: () => viewportRight,
  }
}

/** Deterministic clock + interval capture; `runTicks(n)` fires the callback. */
function fakeScheduler() {
  let now = 0
  let callback: (() => void) | null = null
  let cleared = false
  return {
    now: () => now,
    setInterval: (fn: () => void) => {
      callback = fn
      cleared = false
      return 1
    },
    clearInterval: () => {
      callback = null
      cleared = true
    },
    advance(ms: number) {
      now += ms
    },
    runTick() {
      callback?.()
    },
    isArmed: () => callback !== null && !cleared,
  }
}

function selectionSource(state: SelectionState) {
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    mutate(fn: () => void) {
      fn()
      for (const cb of listeners) cb()
    },
  }
}

// ── edgeScrollDirection ──────────────────────────────────────────────────────

check('T1 bottom edge is inclusive', edgeScrollDirection(11, 2, 10), 1)
check('T1 just above the bottom edge', edgeScrollDirection(10, 2, 10), 0)
check('T1 top edge is inclusive', edgeScrollDirection(2, 2, 10), -1)
check('T1 inside the viewport', edgeScrollDirection(6, 2, 10), 0)
check('T1 no viewport height', edgeScrollDirection(6, 2, 0), 0)

// ── start / stop ────────────────────────────────────────────────────────────

{
  const state = dragging(4, 11)
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T2 dragging on the bottom edge arms the timer', scroller.isActive(), true)
  scheduler.runTick()
  check('T2 bottom edge scrolls down by one row', handle.calls, [1])
  scroller.dispose()
  check('T2 dispose stops the timer', scroller.isActive(), false)
  check('T2 dispose unhooks the interval', scheduler.isArmed(), false)
}

{
  const state = dragging(8, 2)
  const source = selectionSource(state)
  const handle = fakeHandle({ startTop: 5 })
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T3 dragging on the top edge arms the timer', scroller.isActive(), true)
  scheduler.runTick()
  check('T3 top edge scrolls up by one row', handle.calls, [-1])
  scroller.dispose()
}

{
  const state = dragging(4, 6)
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T4 pointer inside the viewport does not arm', scroller.isActive(), false)
  source.mutate(() => {
    state.focus = { row: 11, col: 5 }
  })
  check('T4 moving into the bottom edge arms', scroller.isActive(), true)
  source.mutate(() => {
    state.focus = { row: 6, col: 5 }
  })
  check('T4 leaving the edge stops', scroller.isActive(), false)
  const before = handle.calls.length
  scheduler.runTick()
  check('T4 no tick after leaving the edge', handle.calls.length, before)
  scroller.dispose()
}

{
  const state = dragging(4, 11)
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  source.mutate(() => {
    state.isDragging = false
  })
  check('T5 release stops the timer', scroller.isActive(), false)
  const before = handle.calls.length
  scheduler.runTick()
  check('T5 no scroll after release', handle.calls.length, before)
  scroller.dispose()
}

{
  // With a split sidebar the chat pane registers itself as a selection pane,
  // so paneId/fence appear on chat drags too — they must not disarm.
  const state = dragging(4, 11, { paneId: 'x-chat', fence: { colStart: 0, colEnd: 79 } })
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T6 chat drag with paneId/fence still arms', scroller.isActive(), true)
  scheduler.runTick()
  check('T6 chat drag with paneId/fence scrolls', handle.calls, [1])
  scroller.dispose()
}

{
  // Same rows, different columns: a drag inside the side panel must not move
  // the transcript.
  const state = dragging(4, 11, { paneId: 'x-panel', anchor: { row: 4, col: 40 } })
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T6 drag anchored in another column does not scroll the transcript', scroller.isActive(), false)
  scroller.dispose()
}

{
  const state = dragging(4, 11, { includeNoSelectCells: true })
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T6 noSelect gesture does not auto-scroll', scroller.isActive(), false)
  scroller.dispose()
}

{
  // The follow shift moves focus with the text; the next tick must still
  // scroll from the remembered pointer row.
  const state = dragging(4, 11)
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  scheduler.runTick()
  state.focus = { row: 10, col: 5 }
  scheduler.runTick()
  check('T6 follow-shifted focus still scrolls from the pointer row', handle.calls, [1, 1])
  scroller.dispose()
}

{
  const state = dragging(1, 11)
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T6 anchor outside the viewport does not auto-scroll', scroller.isActive(), false)
  scroller.dispose()
}

// ── acceleration ────────────────────────────────────────────────────────────

{
  const state = dragging(4, 11)
  const source = selectionSource(state)
  const handle = fakeHandle({ scrollHeight: 1000 })
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  scheduler.runTick()
  scheduler.advance(300)
  scheduler.runTick()
  check('T7 before the acceleration delay: step 1', handle.calls, [1, 1])
  scheduler.advance(400)
  scheduler.runTick()
  check('T7 after 600ms: step 3', handle.calls, [1, 1, 3])
  scroller.dispose()
}

// ── boundary ────────────────────────────────────────────────────────────────

{
  const state = dragging(4, 11)
  const source = selectionSource(state)
  const handle = fakeHandle({ frozen: true })
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  scheduler.runTick()
  check('T8 a no-op tick keeps the timer armed', scroller.isActive(), true)
  scheduler.runTick()
  check('T8 two no-op ticks stop the timer', scroller.isActive(), false)
  scroller.dispose()
}

{
  const state = dragging(4, 11)
  const source = selectionSource(state)
  const handle = fakeHandle({ scrollHeight: 12, startTop: 2 })
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  scheduler.runTick()
  check('T8 at the scroll bottom the timer stops', scroller.isActive(), false)
  check('T8 at the scroll bottom nothing is scrolled', handle.calls, [])
  scroller.dispose()
}

{
  const state = dragging(4, 2)
  const source = selectionSource(state)
  const handle = fakeHandle({ startTop: 0 })
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  scheduler.runTick()
  check('T8 at the scroll top the timer stops', scroller.isActive(), false)
  check('T8 at the scroll top nothing is scrolled', handle.calls, [])
  scroller.dispose()
}

// ── defensive cases ─────────────────────────────────────────────────────────

{
  const state = createSelectionState()
  const source = selectionSource(state)
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T9 no selection does not arm', scroller.isActive(), false)
  scroller.dispose()
}

{
  const source = { getState: () => null, subscribe: () => () => {} }
  const handle = fakeHandle()
  const scheduler = fakeScheduler()
  const scroller = createDragAutoScroller({ handle, getState: source.getState, subscribe: source.subscribe, scheduler })
  check('T9 null state does not arm', scroller.isActive(), false)
  scroller.dispose()
}

if (failures > 0) {
  console.error(`\nverify-drag-autoscroll: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-drag-autoscroll: all checks passed')
