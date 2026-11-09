/**
 * React half of the shared answer-field contract: owns the text/caret pair,
 * the clipboard transport and the key dispatch; the panels paint their row.
 *
 * Editing state lives in refs mutated SYNCHRONOUSLY per stdin event — one
 * terminal chunk arrives as several key events inside a single React batch,
 * and the clipboard read resolves asynchronously — with useState mirrors that
 * only re-render. The caret counts CODE POINTS (see answerField.ts).
 */

import React from 'react'
import type { Key } from '../../ui.js'
import { t } from '../../i18n.js'
import { isMod, isPlainReturnInput } from '../../utils/modifiers.js'
import { readClipboard, type ClipboardRead } from '../../utils/clipboard.js'
import {
  ANSWER_PASTE_MAX_POINTS,
  appendAtTail,
  backspaceAt,
  caretTo,
  deleteAt,
  deleteRange,
  insertAt,
  insertNewlineAt,
  lineEnd,
  lineStart,
  lineStep,
  pasteInto,
  pointsOf,
  wordEnd,
  wordStart,
  type AnswerValue,
  type PasteOutcome,
} from './answerField.js'

/** The panel-side intents the field cannot decide itself. */
export interface AnswerFieldHost {
  /** Plain ↑/↓ on the field row — the panel moves the row focus. */
  onMoveFocus?(delta: 1 | -1): void
  /** Plain Enter — the panel submits. */
  onSubmit(): void
  /** Plain ← at the text head / → at the tail (question navigation). */
  onBack?(): void
  onForward?(): void
  /** The buffer became empty (drop an attached option label). */
  onEmpty?(): void
  /** A text/caret edit landed (clear an inline error). */
  onEdit?(): void
}

export interface AnswerField {
  readonly text: string
  readonly cursor: number
  readonly textRef: React.MutableRefObject<string>
  readonly cursorRef: React.MutableRefObject<number>
  /** Append at the tail (typing on an option row). */
  append(chunk: string): void
  /** Delete the character before the caret (option-row Backspace). */
  backspace(): void
  /** Every key the field owns; the caller's row branch consumes them all. */
  handleKey(input: string, key: Key, host: AnswerFieldHost): void
  insertPasted(raw: string, atCaret: boolean, onAppended?: () => void): PasteOutcome
  pasteFromClipboard(
    atCaret: boolean,
    onError: (message: string | null) => void,
    onAppended?: () => void,
  ): void
}

const changed = (before: AnswerValue, next: AnswerValue): boolean =>
  before.text !== next.text || before.cursor !== next.cursor

export function useAnswerField(
  initialText: string,
  options: { readonly readClipboard?: () => Promise<ClipboardRead> } = {},
): AnswerField {
  const [text, setText] = React.useState(initialText)
  const [cursor, setCursor] = React.useState(() => pointsOf(initialText).length)
  const textRef = React.useRef(initialText)
  const cursorRef = React.useRef(pointsOf(initialText).length)
  /** True while the component is mounted (async clipboard continuation
   *  guard: the panel can unmount when the user answers first). */
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => { mountedRef.current = false }, [])
  /** True while a clipboard read is in flight (ignore repeat Ctrl+V). */
  const pasteBusyRef = React.useRef(false)
  const clipboardReader = options.readClipboard ?? readClipboard

  /** Single choke point: refs first (the next key of the same stdin batch
   *  must see them), then the state mirrors so the render sees the value. */
  const commit = (next: AnswerValue, host?: AnswerFieldHost): void => {
    const emptied = textRef.current !== '' && next.text === ''
    textRef.current = next.text
    cursorRef.current = next.cursor
    setText(next.text)
    setCursor(next.cursor)
    if (emptied) host?.onEmpty?.()
  }
  /** A text edit that also clears an inline error — the same points the
   *  panels cleared before the extraction (typing, newline, word/line
   *  deletions), and only when the edit actually changed something. */
  const edit = (before: AnswerValue, next: AnswerValue, host?: AnswerFieldHost): void => {
    if (!changed(before, next)) return
    commit(next, host)
    host?.onEdit?.()
  }

  const append = (chunk: string): void => {
    commit(appendAtTail({ text: textRef.current, cursor: cursorRef.current }, chunk))
  }
  const backspace = (): void => {
    commit(backspaceAt({ text: textRef.current, cursor: cursorRef.current }))
  }

  const insertPasted = (raw: string, atCaret: boolean, onAppended?: () => void): PasteOutcome => {
    const result = pasteInto({ text: textRef.current, cursor: cursorRef.current }, raw, atCaret)
    if (result.outcome !== 'ok') return result.outcome
    commit(result.value)
    if (!atCaret) onAppended?.()
    return 'ok'
  }

  const pasteFromClipboard = (
    atCaret: boolean,
    onError: (message: string | null) => void,
    onAppended?: () => void,
  ): void => {
    if (pasteBusyRef.current) return
    pasteBusyRef.current = true
    void clipboardReader()
      .then(content => {
        if (!mountedRef.current) return
        if (content === null || content.kind === 'unavailable') {
          onError(t(content === null ? 'input-clipboard-empty' : 'input-clipboard-unavailable'))
          return
        }
        if (content.kind !== 'text') {
          // File/image offers have no text form in an answer field.
          onError(t('question-paste-not-text'))
          return
        }
        if (content.text === '') {
          onError(t('input-clipboard-empty'))
          return
        }
        const outcome = insertPasted(content.text, atCaret, onAppended)
        onError(outcome === 'too-long' ? t('question-paste-too-long', { n: ANSWER_PASTE_MAX_POINTS }) : null)
      })
      .catch(() => {
        if (mountedRef.current) onError(t('input-clipboard-read-failed'))
      })
      .finally(() => {
        pasteBusyRef.current = false
      })
  }

  const handleKey = (input: string, key: Key, host: AnswerFieldHost): void => {
    const value = (): AnswerValue => ({ text: textRef.current, cursor: cursorRef.current })
    // Shift+Enter / Option+Enter / Ctrl+J break the answer into a new line
    // and never submit it. A bare Enter still submits below.
    if (key.return && (key.shift || key.meta)) {
      const before = value()
      edit(before, insertNewlineAt(before), host)
      return
    }
    if (key.ctrl && !key.shift && !key.meta && !key.super && input === 'j') {
      const before = value()
      edit(before, insertNewlineAt(before), host)
      return
    }
    // Word jumps: Alt/Option+←/→ and Ctrl+←/→. Ghostty hands Option+arrows
    // as ESC b / ESC f, which is why the literal b/f arm exists.
    const escapeJump = key.meta && !key.ctrl && (input === 'b' || input === 'f')
    if (escapeJump || ((isMod(key) || key.meta) && (key.leftArrow || key.rightArrow))) {
      const before = value()
      const back = escapeJump ? input === 'b' : key.leftArrow === true
      const next = back ? wordStart(before.text, before.cursor) : wordEnd(before.text, before.cursor)
      commit(caretTo(before, next))
      return
    }
    // Line edges: Ctrl+A/E (Home/End are line-scoped below).
    if (isMod(key) && input === 'a') {
      const before = value()
      commit(caretTo(before, lineStart(before.text, before.cursor)))
      return
    }
    if (isMod(key) && input === 'e') {
      const before = value()
      commit(caretTo(before, lineEnd(before.text, before.cursor)))
      return
    }
    // Deletions: Ctrl+W / Option+Backspace take the previous word, Ctrl+U
    // takes the line prefix.
    if ((isMod(key) && input === 'w') || (key.meta && key.backspace)) {
      const before = value()
      edit(before, deleteRange(before, wordStart(before.text, before.cursor), before.cursor), host)
      return
    }
    if (isMod(key) && input === 'u') {
      const before = value()
      edit(before, deleteRange(before, lineStart(before.text, before.cursor), before.cursor), host)
      return
    }
    // Caret motion between lines is Ctrl+↑/↓: plain ↑/↓ navigate the rows.
    if (isMod(key) && (key.upArrow || key.downArrow)) {
      const before = value()
      commit(caretTo(before, lineStep(before.text, before.cursor, key.upArrow ? -1 : 1)))
      return
    }
    if (key.upArrow) {
      host.onMoveFocus?.(-1)
      return
    }
    if (key.downArrow) {
      host.onMoveFocus?.(1)
      return
    }
    if (isPlainReturnInput(input, key)) {
      host.onSubmit()
      return
    }
    if (key.backspace) {
      commit(backspaceAt(value()), host)
      return
    }
    if (key.delete) {
      commit(deleteAt(value()), host)
      return
    }
    if (key.leftArrow) {
      // Plain ← at the head of the answer switches questions; anywhere else
      // (and modified arrows) stays a caret step.
      const before = value()
      if (!key.ctrl && !key.meta && !key.super && !key.shift && before.cursor === 0 && host.onBack !== undefined) {
        host.onBack()
        return
      }
      commit(caretTo(before, before.cursor - 1))
      return
    }
    if (key.rightArrow) {
      const before = value()
      const length = pointsOf(before.text).length
      if (!key.ctrl && !key.meta && !key.super && !key.shift && before.cursor >= length && host.onForward !== undefined) {
        host.onForward()
        return
      }
      commit(caretTo(before, before.cursor + 1))
      return
    }
    if (key.home) {
      const before = value()
      commit(caretTo(before, lineStart(before.text, before.cursor)))
      return
    }
    if (key.end) {
      const before = value()
      commit(caretTo(before, lineEnd(before.text, before.cursor)))
      return
    }
    if (!key.ctrl && !key.meta && !key.super && input) {
      // Ordinary typing at the live caret (a text run may carry several
      // characters in one event — e.g. an unbracketed terminal paste).
      const before = value()
      edit(before, insertAt(before, input), host)
    }
  }

  return { text, cursor, textRef, cursorRef, append, backspace, handleKey, insertPasted, pasteFromClipboard }
}
