import { useEffect } from 'react'
import type { ScrollBoxHandle } from '../components/ScrollBox.js'
import { createDragAutoScroller } from '../drag-autoscroll.js'
import { useSelection } from './use-selection.js'

/**
 * Keep the transcript scrolling while a fullscreen text-selection drag rests
 * on the top or bottom viewport edge. The controller is inert outside
 * alt-screen: `useSelection()` reports no selection and an empty
 * subscription there, so nothing arms.
 * @param handle - the transcript ScrollBox handle, or null before mount.
 */
export function useDragAutoScroller(handle: ScrollBoxHandle | null): void {
  const { getState, subscribe } = useSelection()
  useEffect(() => {
    if (!handle) return
    const scroller = createDragAutoScroller({ handle, getState, subscribe })
    return () => scroller.dispose()
  }, [handle, getState, subscribe])
}
