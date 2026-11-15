/**
 * Pointer → caret mapping for terminal text fields, shared by the composer
 * and the questionnaire/plan-review answer rows.
 *
 * The renderer wraps text itself (grapheme-safe, CJK-width aware), so a click's
 * (row, column) only has a meaning together with the exact same row boundaries.
 * `wrapGraphemeRows` is that boundary function; `clickToCursorOffset` walks it
 * back to a UTF-16 offset. Producers with their own break rules (the composer
 * keeps `[Image #N]` tokens unbreakable) inject `rowsFor`.
 */

import { getGraphemeSegmenter } from './intl.js'
import { stringWidth } from '../ink/stringWidth.js'

/** Offset range [start, end) of one painted row inside its logical line. */
export type WrapRow = { start: number; end: number }

/**
 * Grapheme word-wrap for one logical line: break at the last space when the
 * row overflows; hard-wrap a word that cannot fit; never split a cluster
 * (ZWJ emoji, combining sequences, CJK wide cells stay whole).
 * @param isBreakAllowed - extra veto for a break at `line[offset - 1]` (the
 *   composer uses it to keep `[Image #N]` tokens whole).
 */
export function wrapGraphemeRows(
  line: string,
  width: number,
  isBreakAllowed?: (line: string, offset: number) => boolean,
): WrapRow[] {
  if (line === '') return [{ start: 0, end: 0 }]
  const rows: WrapRow[] = []
  const segmenter = getGraphemeSegmenter()
  let rowStart = 0
  let currentWidth = 0
  let offset = 0
  let lastBreak = -1
  for (const { segment } of segmenter.segment(line)) {
    const w = stringWidth(segment)
    while (currentWidth + w > width && offset > rowStart) {
      if (lastBreak > rowStart) {
        rows.push({ start: rowStart, end: lastBreak })
        rowStart = lastBreak
        currentWidth = stringWidth(line.slice(rowStart, offset))
        lastBreak = -1
      } else {
        rows.push({ start: rowStart, end: offset })
        rowStart = offset
        currentWidth = 0
        lastBreak = -1
      }
    }
    currentWidth += w
    offset += segment.length
    if (segment === ' ' && (isBreakAllowed === undefined || isBreakAllowed(line, offset))) {
      lastBreak = offset
    }
  }
  rows.push({ start: rowStart, end: offset })
  return rows
}

/**
 * Inverse of the renderer's wrap: map a click position (visual row index +
 * visual column) back to a UTF-16 offset in the original text. Uses the same
 * row boundaries the paint used, so every visual row's start offset is known
 * exactly. Within the clicked row the caret snaps to the boundary nearest the
 * click — or, for double-click word selection, to the grapheme under the cell.
 * @param rowsFor - row boundaries for one logical line (defaults to
 *   {@link wrapGraphemeRows} at `width`).
 */
export function clickToCursorOffset(
  text: string,
  width: number,
  visualLine: number,
  visualCol: number,
  snapWithin: 'nearest' | 'grapheme-start' = 'nearest',
  rowsFor: (line: string, width: number) => WrapRow[] = wrapGraphemeRows,
): number {
  const segmenter = getGraphemeSegmenter()
  let row = 0
  let lineBase = 0
  for (const line of text.split('\n')) {
    for (const r of rowsFor(line, width)) {
      if (row === visualLine) {
        let currentWidth = 0
        let local = 0
        for (const { segment } of segmenter.segment(line.slice(r.start, r.end))) {
          const w = stringWidth(segment)
          // Caret positioning uses the nearest edge. Double-click selection
          // instead needs the grapheme UNDER the cell: on the second cell of a
          // CJK/emoji glyph, nearest-edge would point after the glyph (and the
          // final glyph would select nothing).
          if (snapWithin === 'grapheme-start' && currentWidth + w > visualCol) {
            return lineBase + r.start + local
          }
          if (currentWidth + w / 2 > visualCol) return lineBase + r.start + local
          if (currentWidth + w > visualCol) return lineBase + r.start + local + segment.length
          currentWidth += w
          local += segment.length
        }
        return lineBase + r.end
      }
      row++
    }
    lineBase += line.length + 1
  }
  return lineBase
}
