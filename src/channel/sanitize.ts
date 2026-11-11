/**
 * The render-path sanitization contract for plugin-supplied text — the
 * single implementation behind every managed-UI seam (dialogs, status line,
 * entry renderers, rewind modes, decision notices). TUI-PROP-009 Track A
 * makes these rules normative, so they live in exactly one place:
 *
 * - C0/C1 control chars are stripped (replaced by a space) — plugin text
 *   must never smuggle escape sequences onto the screen;
 * - whitespace collapses to single spaces (render paths are single-line);
 * - width is capped in terminal CELLS (never string.length) with an
 *   ellipsis.
 *
 * Non-scalar input is DROPPED, never `String()`-coerced — `String({})`
 * would put "[object Object]" on the render path. Scalars
 * (string/number/boolean) coerce through String() first.
 */

import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

/**
 * Memo for {@link cleanRenderText}: render paths ask for the SAME text every
 * frame (the sticky prompt header, a dialog label), and the sanitize regexes
 * plus the prefix measurement are not free — a live profile of the frozen
 * session put `stringWidthJavaScript` at ~13% self-time through this call.
 * Bounded by entry count and total chars, so a session cannot grow it.
 */
const CLEAN_CACHE_MAX_ENTRIES = 512
const CLEAN_CACHE_MAX_CHARS = 200_000
/** Inputs longer than this are measured but not retained as keys. */
const CLEAN_CACHE_MAX_INPUT = 4096
const cleanCache = new Map<string, string>()
let cleanCacheChars = 0

/** Remember one sanitized result; bounded by entries and total chars. */
function remember(key: string, result: string): string {
  if (key.length > CLEAN_CACHE_MAX_INPUT) return result
  if (cleanCache.size >= CLEAN_CACHE_MAX_ENTRIES) {
    const oldest = cleanCache.keys().next().value
    if (oldest !== undefined) {
      cleanCacheChars -= oldest.length + (cleanCache.get(oldest)?.length ?? 0)
      cleanCache.delete(oldest)
    }
  }
  cleanCache.set(key, result)
  cleanCacheChars += key.length + result.length
  while (cleanCacheChars > CLEAN_CACHE_MAX_CHARS && cleanCache.size > 1) {
    const oldest = cleanCache.keys().next().value
    if (oldest === undefined) break
    cleanCacheChars -= oldest.length + (cleanCache.get(oldest)?.length ?? 0)
    cleanCache.delete(oldest)
  }
  return result
}

/**
 * Either return the sanitized line whole (its real width fits `maxCells`) or
 * cut it to `maxCells` with an ellipsis.
 *
 * The old loop measured every prefix of the WHOLE string (O(n²)) and measured
 * the full width up front — ~1ms per call on a 20k-char line, on a path
 * renderers hit every frame. The bounded walk here accumulates per-cluster
 * widths (additive in the terminal model) and stops once the budget is spent,
 * so long lines cost O(maxCells) rather than O(n). "Fits" stays exact: the
 * walk only returns the line whole when every cluster was accepted, which also
 * covers zero-width runs that are longer than the cell budget. The cut is
 * finalized by an exact code-point refinement from the accepted prefix —
 * prefix width is monotone in length, so it lands on the same maximal prefix
 * the per-prefix loop produced.
 */
function fitOrCut(flat: string, maxCells: number): string {
  let out = ''
  let width = 0
  let whole = true
  for (const { segment } of getGraphemeSegmenter().segment(flat)) {
    if (segment === '') continue
    const segmentWidth = stringWidth(segment)
    if (width + segmentWidth > maxCells) {
      whole = false
      break
    }
    out += segment
    width += segmentWidth
  }
  if (whole) return flat
  // Trim the accepted prefix back to the ellipsis budget (`maxCells - 1`)
  // before extending: a prefix that exactly fills `maxCells` has no room for
  // the ellipsis, and the reference cut then stops one cluster earlier.
  const segments = out === '' ? [] : Array.from(getGraphemeSegmenter().segment(out), part => part.segment)
  while (segments.length > 0 && stringWidth(segments.join('')) > maxCells - 1) segments.pop()
  let exact = segments.join('')
  for (const ch of Array.from(flat.slice(exact.length))) {
    if (stringWidth(exact + ch) > maxCells - 1) break
    exact += ch
  }
  return `${exact}…`
}

/** Sanitize an already-string value for the render path. */
export function cleanRenderText(value: string, maxCells: number): string {
  const cacheKey = maxCells <= CLEAN_CACHE_MAX_INPUT ? `${maxCells}\u0000${value}` : ''
  if (cacheKey !== '') {
    const cached = cleanCache.get(cacheKey)
    if (cached !== undefined) return cached
  }
  // Remove complete ANSI control sequences before stripping control bytes.
  // Otherwise an SGR such as ESC[31m becomes the visible garbage "[31m".
  const withoutAnsi = value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  // eslint-disable-next-line no-control-regex -- deliberate: sanitize untrusted render-path text
  const flat = withoutAnsi.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  const result = fitOrCut(flat, maxCells)
  return cacheKey === '' ? result : remember(cacheKey, result)
}

/**
 * Sanitize untrusted plugin text destined for a MULTI-LINE block (a
 * `pushLocal` report): the same per-line strip as {@link cleanRenderText},
 * but newlines are structure here, not whitespace to fold. Blank rows are
 * dropped so one reported line stays one transcript row.
 */
export function cleanBlockLines(value: string, maxCells: number): string[] {
  return value.split(/\r?\n/u).map(line => cleanRenderText(line, maxCells)).filter(line => line !== '')
}

/** Bounded, local-only registry output. Explicit command blocks keep the
 * existing cleanBlockLines contract; reports retain indentation and empty rows. */
export function cleanCommandReport(value: string): { lines: string[]; truncated: boolean } {
  const maxCodeUnits = 65_536
  const maxLines = 200
  const maxCells = 4000
  // A trailing line terminator (`\n`, `\r\n` or a lone `\r`) is not an empty
  // reported row; leaving the `\r` behind would charge a cell/unit to the last
  // line (clipping a 4000-cell line or faking a 64K truncation).
  const raw = value.replace(/\r\n$|[\r\n]$/u, '')
  let bounded = raw.slice(0, maxCodeUnits)
  // Do not split a Unicode scalar at the allocation boundary.
  if (bounded.length < raw.length && /[\uD800-\uDBFF]$/u.test(bounded)) bounded = bounded.slice(0, -1)
  let truncated = bounded.length < raw.length
  const rows = bounded.split(/\r?\n/u)
  if (rows.length > maxLines) truncated = true
  const lines = rows.slice(0, maxLines).map(row => {
    const plain = flattenPasteInline(row)
    if (stringWidth(plain) <= maxCells) return plain
    truncated = true
    let clipped = ''
    let cells = 0
    for (const { segment } of getGraphemeSegmenter().segment(plain)) {
      const width = stringWidth(segment)
      if (cells + width > maxCells - 1) break
      clipped += segment
      cells += width
    }
    return `${clipped}…`
  })
  return { lines: raw === '' ? [] : lines, truncated }
}

/**
 * Sanitize an untrusted (possibly non-string) value. Non-scalars — objects,
 * arrays, functions, symbols, null/undefined — yield '' so the caller takes
 * its drop/refuse path; scalars coerce then sanitize.
 */
export function cleanScalarText(value: unknown, maxCells: number): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
  return cleanRenderText(String(value), maxCells)
}

/**
 * Truncate to a cell budget WITHOUT ellipsis, whitespace folding, or any
 * other mutation — the editing-path counterpart of {@link cleanRenderText}.
 * An input panel caps what the user types/pastes; inserting '…' or
 * collapsing their spaces would corrupt text they can still edit.
 */
export function capCells(value: string, maxCells: number): string {
  if (stringWidth(value) <= maxCells) return value
  let out = ''
  for (const ch of value) {
    if (stringWidth(out + ch) > maxCells) break
    out += ch
  }
  return out
}

/** C0/C1 control chars → space, nothing else touched. The single-line
 *  input panel flattens pasted chunks with this (newlines become spaces —
 *  the panel has no second row for them). */
export function flattenInline(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberate: sanitize untrusted render-path text
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
}

/**
 * Single-line field ingress for terminal/clipboard paste: strip COMPLETE
 * ANSI/OSC sequences first (paste content is user-controlled bytes — a
 * smuggled ESC[… would otherwise break out of the render path), then flatten
 * every remaining C0/C1 control char to a space. Unlike {@link flattenInline},
 * this never leaves `[31m`-style residue behind; the two regexes mirror
 * {@link cleanRenderText}'s strip, and the final pass covers the rest.
 */
export function flattenPasteInline(value: string): string {
  const withoutAnsi = value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  return flattenInline(withoutAnsi)
}

/** Bidi overrides/isolates and invisible separators: invisible, and a single
 *  U+202E next to a host field (`#sessionId`, cwd) can flip the displayed
 *  direction of the text that follows it. Footer fields sit immediately
 *  beside those provenance tags, so they strip this class first.
 *
 *  The joiners U+200C (ZWNJ) and U+200D (ZWJ) are deliberately NOT in it:
 *  they are orthographic (Persian, Indic) and compose emoji sequences, so
 *  stripping them would rewrite the plugin's text and inflate its cell
 *  width (a ZWJ family emoji measures 2 cells, 6 without the joiners). */
const BIDI_AND_INVISIBLE_MARKS = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu

/**
 * Footer-field ingress: the common render cleanup PLUS bidi controls and
 * invisible separators. Kept separate from {@link cleanRenderText} so the
 * existing managed-UI callers keep their exact behaviour. Non-scalars yield
 * '' (the caller decides between refuse and clear); scalars coerce then
 * sanitize.
 */
export function cleanStatusFieldText(value: unknown, maxCells: number): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
  return cleanRenderText(String(value).replace(BIDI_AND_INVISIBLE_MARKS, ''), maxCells)
}

/** Toast-bound plugin text (veto reasons, handled notices, rewind summaries)
 *  and single-line transcript notices are render-path data too: same
 *  sanitization, toast-width cap. */
export const NOTICE_CELLS = 200
