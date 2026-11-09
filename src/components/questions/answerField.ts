/**
 * The answer-field editing contract, shared by the questionnaire's free-text
 * row and the plan-review feedback row. One implementation on purpose: the
 * two panels had already drifted once (8d49f79b gave the questionnaire
 * macOS/readline keys and multi-line input; the plan review kept the older
 * single-line editor). Pure code-point math only — React state, the refs and
 * the clipboard transport live in useAnswerField.
 *
 * Every offset here is a CODE-POINT index (`[...s]`), never a UTF-16 one:
 * ←/→/⌫/Del and a paste boundary must never split a surrogate pair.
 */

import { flattenPasteInline } from '../../dsh-adapter/sanitize.js'

/** Paste cap for one answer field, in code points. Typing is naturally
 *  bounded; a stray Ctrl+V of a file/log must not inflate the row or ship a
 *  megabyte answer. Generous on purpose — the inline error names the bound. */
export const ANSWER_PASTE_MAX_POINTS = 8000

export interface AnswerValue {
  readonly text: string
  readonly cursor: number
}

/** The answer's code points. Every offset below indexes THIS array. */
export function pointsOf(text: string): string[] {
  return [...text]
}

export function insertAt(value: AnswerValue, chunk: string): AnswerValue {
  const points = pointsOf(value.text)
  const at = value.cursor
  points.splice(at, 0, ...chunk)
  return { text: points.join(''), cursor: at + pointsOf(chunk).length }
}

/** Append at the tail — typing on an option row has no visible caret. */
export function appendAtTail(value: AnswerValue, chunk: string): AnswerValue {
  const text = value.text + chunk
  return { text, cursor: pointsOf(text).length }
}

export function backspaceAt(value: AnswerValue): AnswerValue {
  const points = pointsOf(value.text)
  const at = value.cursor
  if (at <= 0) return value
  points.splice(at - 1, 1)
  return { text: points.join(''), cursor: at - 1 }
}

export function deleteAt(value: AnswerValue): AnswerValue {
  const points = pointsOf(value.text)
  const at = value.cursor
  if (at >= points.length) return value
  points.splice(at, 1)
  return { text: points.join(''), cursor: at }
}

export function insertNewlineAt(value: AnswerValue): AnswerValue {
  return insertAt(value, '\n')
}

export function caretTo(value: AnswerValue, next: number): AnswerValue {
  const length = pointsOf(value.text).length
  return { text: value.text, cursor: Math.max(0, Math.min(length, next)) }
}

/** Drop [start, end) and park the caret at `start`. */
export function deleteRange(value: AnswerValue, start: number, end: number): AnswerValue {
  if (start >= end) return value
  const points = pointsOf(value.text)
  return { text: points.slice(0, start).concat(points.slice(end)).join(''), cursor: start }
}

const isSpace = (point: string | undefined): boolean => point === undefined || /\s/u.test(point)

/** Previous whitespace-delimited word start (readline Alt+B / Ctrl+W). */
export function wordStart(text: string, cursor: number): number {
  const points = pointsOf(text)
  let at = Math.min(cursor, points.length)
  while (at > 0 && isSpace(points[at - 1])) at -= 1
  while (at > 0 && !isSpace(points[at - 1])) at -= 1
  return at
}

/** Next whitespace-delimited word start (readline Alt+F). */
export function wordEnd(text: string, cursor: number): number {
  const points = pointsOf(text)
  let at = Math.min(cursor, points.length)
  while (at < points.length && !isSpace(points[at])) at += 1
  while (at < points.length && isSpace(points[at])) at += 1
  return at
}

/** Start of the caret's logical line. */
export function lineStart(text: string, cursor: number): number {
  const points = pointsOf(text)
  let at = Math.min(cursor, points.length)
  while (at > 0 && points[at - 1] !== '\n') at -= 1
  return at
}

/** End of the caret's logical line (the newline itself, or the text end). */
export function lineEnd(text: string, cursor: number): number {
  const points = pointsOf(text)
  let at = Math.min(cursor, points.length)
  while (at < points.length && points[at] !== '\n') at += 1
  return at
}

/** ±1 logical line at the same column, clamped at the text edges. */
export function lineStep(text: string, cursor: number, delta: -1 | 1): number {
  const points = pointsOf(text)
  const at = Math.min(cursor, points.length)
  const start = lineStart(text, at)
  const column = at - start
  if (delta === -1) {
    if (start === 0) return at
    const prevEnd = start - 1
    let prevStart = prevEnd
    while (prevStart > 0 && points[prevStart - 1] !== '\n') prevStart -= 1
    return prevStart + Math.min(column, prevEnd - prevStart)
  }
  const end = lineEnd(text, at)
  if (end >= points.length) return at
  const nextStart = end + 1
  let nextEnd = nextStart
  while (nextEnd < points.length && points[nextEnd] !== '\n') nextEnd += 1
  return nextStart + Math.min(column, nextEnd - nextStart)
}

export type PasteOutcome = 'ok' | 'empty' | 'too-long'

/** Paste-path entry shared by both transports (bracketed chunk and the async
 *  clipboard read): newlines and control chars flatten to spaces, a chunk
 *  with nothing visible inserts nothing, one past the cap is refused (never
 *  truncated — the user must see that text was dropped). Where the text
 *  lands mirrors plain typing: at the caret, or appended at the tail when the
 *  keypress came from an option row. */
export function pasteInto(
  value: AnswerValue,
  raw: string,
  atCaret: boolean,
): { outcome: PasteOutcome; value: AnswerValue } {
  const text = flattenPasteInline(raw)
  if (text.trim() === '') return { outcome: 'empty', value }
  if (pointsOf(text).length > ANSWER_PASTE_MAX_POINTS) return { outcome: 'too-long', value }
  const at = atCaret ? value.cursor : pointsOf(value.text).length
  return { outcome: 'ok', value: insertAt({ text: value.text, cursor: at }, text) }
}

/** The painted slice of a multi-line answer: a caret-anchored window of at
 *  most `maxLines` logical lines, so a long answer can never push the option
 *  list and the key hint off screen. */
export interface AnswerWindow {
  /** First code-point index of the painted window. */
  readonly start: number
  /** One past the last painted code-point index. */
  readonly end: number
  /** Caret index relative to `start`. */
  readonly caret: number
  /** Logical lines in the whole answer. */
  readonly lineCount: number
  /** The caret sits on a painted newline (the cell closes that line). */
  readonly caretOnNewline: boolean
}

export function answerWindow(points: readonly string[], cursor: number, maxLines: number): AnswerWindow {
  const lineStarts: number[] = [0]
  points.forEach((point, index) => {
    if (point === '\n') lineStarts.push(index + 1)
  })
  let caretLine = 0
  while (caretLine + 1 < lineStarts.length && lineStarts[caretLine + 1]! <= cursor) caretLine += 1
  const startLine = lineStarts.length <= maxLines
    ? 0
    : Math.max(0, Math.min(caretLine - maxLines + 1, lineStarts.length - maxLines))
  const start = lineStarts[startLine] ?? 0
  // A full window drops the newline that opened the next, unpainted line.
  const end = startLine + maxLines < lineStarts.length
    ? lineStarts[startLine + maxLines]! - 1
    : points.length
  const caret = cursor - start
  return {
    start,
    end,
    caret,
    lineCount: lineStarts.length,
    caretOnNewline: start + caret < points.length && points[start + caret] === '\n',
  }
}

/** The caret cell split: head, the inverted cell glyph, tail. A caret on a
 *  newline has no glyph to invert, so it sits on the blank cell that closes
 *  the line and the newline stays in the tail. An unfocused field keeps its
 *  thin caret character before the whole tail. */
export interface CaretSplit {
  readonly head: string
  readonly glyph: string
  readonly tail: string
}

export function caretSplit(points: readonly string[], caret: number, focused: boolean): CaretSplit {
  const at = Math.max(0, Math.min(caret, points.length))
  const head = points.slice(0, at).join('')
  if (!focused) return { head, glyph: '▏', tail: points.slice(at).join('') }
  const onNewline = at < points.length && points[at] === '\n'
  const glyph = at < points.length && !onNewline ? points[at]! : ' '
  return { head, glyph, tail: points.slice(onNewline ? at : at + 1).join('') }
}
