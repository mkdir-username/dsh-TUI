/**
 * The questionnaire panel — ask-user-question UI for the
 * DSH user-interaction seam. One question per panel (progress header, header
 * chip, wrapped question text, optional detail, option list with focus
 * pointer and multi-select checkmarks), styled in the dsh-tui mist-blue
 * design language.
 *
 * The list's last row IS the free-text input (issue #9): no Tab, no mode
 * switch — the view never changes. Typing while focused on a real option
 * appends into that input row (single-select also attaches the option's
 * label, so the answer can carry both `selected` and `custom`); focusing
 * the input row itself and typing gives a pure custom answer.
 * Local /provider model lists additionally offer a Tab capability editor;
 * ordinary questionnaires retain the inline-answer behavior.
 *
 * The answer field is a real terminal line editor with the macOS habits the
 * composer and the launchpad already carry: Alt/Option+←/→ (Ghostty sends
 * them as ESC b / ESC f, the parser folds those into meta+←/→) and
 * Ctrl+←/→ jump by whitespace-delimited words, Ctrl+A/E and Home/End move
 * to the edge of the current line, Ctrl+W and Option+Backspace delete the
 * previous word, Ctrl+U deletes to the line start, Ctrl+↑/↓ move the caret
 * between lines. Shift+Enter, Option+Enter and Ctrl+J insert a newline, so
 * an answer may span several lines; a bare Enter still submits and Ctrl+K
 * stays the panel fold. The field paints a caret-anchored window of at most
 * ANSWER_FIELD_MAX_LINES logical lines, so a long answer can never push the
 * option list and the key hint off screen (#1664).
 *
 * Paste works on the input row like the composer: Ctrl+V/Alt+V (the keymap
 * `paste` binding, remappable in /settings) reads the system clipboard,
 * and a terminal bracketed paste (Ctrl+Shift+V / right-click / terminals
 * that intercept Ctrl+V) inserts its chunk — newlines and control chars are
 * flattened to spaces (typing is what creates a line break), pasted content
 * never submits the panel. Editing
 * state (value + caret) lives in refs mutated synchronously per event: a
 * terminal delivers one stdin chunk as several key events inside a single
 * React batch, and the clipboard read resolves asynchronously — state
 * queued by one event is invisible to the next, and a paste must land at
 * the caret the user actually sees. The caret counts CODE POINTS (`[...s]`
 * iteration, same contract as the plugin InputDialog), so an emoji can
 * never be split into a lone surrogate by ←/→/⌫/Del or a paste boundary.
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, ScrollBox, useInput, useTerminalSize, type ScrollBoxHandle } from '../../ui.js'
import wrapText from '../../ink/wrap-text.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useDeclaredCursor, useNativeCursor } from '../../ink/hooks/use-declared-cursor.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../terminal-utils/figures.js'
import type { QuestionDraft, QuestionIntentView, QuestionSelection } from '../../channel/questions.js'
import type { ProviderModelEditor as ModelEditor } from '../../adapter/ports/channel-settings.js'
import { PlanReviewPanel } from './PlanReviewPanel.js'
import { ProviderModelEditor } from './ProviderModelEditor.js'
import { QuestionMinimizedBar } from './QuestionMinimizedBar.js'
import { isMod, isPlainReturnInput } from '../../utils/modifiers.js'
import { actionMatches, comboDisplay, effectiveComboDisplay, primaryComboString } from '../../utils/keymap.js'
import { flattenPasteInline } from '../../dsh-adapter/sanitize.js'
import { readClipboard, type ClipboardRead } from '../../utils/clipboard.js'
import { createHyperlink } from '../../terminal-utils/hyperlink.js'
import { listWindow } from '../listWindow.js'
import { clipPreviewRows, pagePreview } from '../previewRows.js'

/** Unmodified arrows switch questions; Ctrl/Alt/Super/Shift stay caret motion. */
function isPlainArrow(key: { ctrl?: boolean; meta?: boolean; super?: boolean; shift?: boolean }): boolean {
  return key.ctrl !== true && key.meta !== true && key.super !== true && key.shift !== true
}

const CHECKED = '◉'
const UNCHECKED = '○'
const PENCIL = '✎'
/** One masked code point of a secret answer (`question.secret`). */
const SECRET_MASK = '•'

/**
 * Paste cap for one answer field, in code points. Typing is naturally
 * bounded (humans cannot type unboundedly) and the protocol places no
 * limit on `custom`, but a stray Ctrl+V of a file/log must not inflate the
 * panel to hundreds of wrapped rows (every keystroke then re-lays them
 * out) or ship a megabyte answer. Deliberately generous — anything past it
 * is an accident, and the inline error says exactly that. Twin constant in
 * PlanReviewPanel (the two panels share the same input contract).
 */
const ANSWER_PASTE_MAX_POINTS = 8000

/**
 * Preview caps (#1664): each field contributes at most these rows to the
 * shared body viewport, keeping the option list and key hint on screen. A
 * short terminal shrinks them further through QUESTION_CHROME_ROWS — the
 * rows the chrome and the panel scaffolding need before any preview text.
 */
const QUESTION_PREVIEW_MAX_ROWS = 6
const QUESTION_CHROME_ROWS = 20

/**
 * Visible-height cap for a multi-line answer, in logical lines. Typing is
 * the only way to create a break, but a stray repeated Shift+Enter (or a
 * handoff from a future editor) must not grow the field into the option
 * list and the key hint: the field paints a caret-anchored window of this
 * many lines and charges the real row count to the layout budget below.
 * Shrinks further on short terminals through `answerMaxLines`.
 */
const ANSWER_FIELD_MAX_LINES = 6

export type AskUserQuestionPanelProps = {
  /** The question to render (from the QuestionStore snapshot). */
  readonly question: {
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
    readonly multiSelect?: boolean
    /** Hide the trailing free-text input row for pure option questions
     *  (local wizards, e.g. /provider). Ignored when there are no options —
     *  a text-only question would otherwise be unanswerable. */
    readonly hideCustomInput?: boolean
    /** Pre-checked option labels (multi-select) / default-focused option
     *  (single-select) shown on first display, before any saved draft — e.g.
     *  the models already enabled on a provider being edited. */
    readonly defaultSelected?: readonly string[]
    /** A URL the question is about (an MCP server's sign-in page): one line
     *  under the detail, an OSC 8 hyperlink where the terminal supports it
     *  (plain otherwise; a scheme that is not http(s)/file/mailto shows
     *  nothing — the notice row still names it). */
    readonly link?: string
    /** A secret answer (a token, a password): the input row shows one `•`
     *  per typed code point; the submitted answer is the real text. */
    readonly secret?: boolean
    /** Local /provider draft editor. Ordinary model-facing asks carry none. */
    readonly modelEditor?: ModelEditor
    /** Presentation intent tag (rc.6): 'plan-review' switches to the
     *  decision-card layout, 'approval' stays on the generic questionnaire
     *  (its option labels carry the decision); an intent never changes the
     *  protocol. */
    readonly intent?: QuestionIntentView
  }
  /** 1-based position within the batch (progress header). */
  readonly position: number
  /** Total questions in the batch (progress header). */
  readonly total: number
  /** Questions answered before the current one. */
  readonly answered: number
  /** Previously saved answer or draft, restored when returning to this item. */
  readonly initialDraft?: QuestionDraft
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc on the first question / Ctrl+C — aborts the whole ask. */
  readonly onCancel: () => void
  /**
   * Esc, when the host wants to decide back-vs-cancel from the live store.
   * A same-batch → then Esc still runs on the panel mounted for question 1,
   * whose `onBack` is absent; this callback sees that → already advanced.
   */
  readonly onEscape?: (draft: QuestionDraft) => void
  /** Esc / ← on later questions — navigates to the previous question. */
  readonly onBack?: (draft: QuestionDraft) => void
  /**
   * → — navigates to the next question without submitting. On the free-text
   * row this only fires when the caret is already at the end, so ←/→ keep
   * editing the answer.
   */
  readonly onForward?: (draft: QuestionDraft) => void
  /**
   * Test seam: clipboard reader for the Ctrl+V paste arm. Defaults to the
   * real cross-platform reader (PowerShell/pbpaste/wl-paste…); headless
   * verification injects a fake so paste outcomes are deterministic.
   */
  readonly readClipboardOverride?: () => Promise<ClipboardRead>
  /**
   * Manual collapse (question panel fold, default Ctrl+K): while
   * collapsed the panel STAYS MOUNTED — draft refs survive, the fold
   * branch sits after every hook — and renders the two-line minimized
   * bar instead, with editing/caret layers gated off. Its own input
   * handler keeps Esc/Ctrl+C as "expand", never cancel, while folded.
   */
  readonly collapsed?: boolean
  /** Expand back from the minimized bar (fold key / Esc / mouse click). */
  readonly onExpand?: () => void
  /** Fold from the expanded panel (fold key / header-row click). */
  readonly onToggleFold?: () => void
  /** True when mouse tracking is on: mouse-only affordances (the
   *  multi-select submit row) render only then — inline hosts have no
   *  pointer, so an unclickable row would just eat a line. */
  readonly fullscreen?: boolean
}

export function AskUserQuestionPanel({
  question,
  position,
  total,
  answered,
  initialDraft,
  onAnswer,
  onCancel,
  onEscape,
  onBack,
  onForward,
  readClipboardOverride,
  collapsed = false,
  onExpand,
  onToggleFold,
  fullscreen = false,
}: AskUserQuestionPanelProps): React.ReactNode {
  // Plan-mode's exit_plan_mode ask carries a presentation intent: render
  // the plan decision card instead of the generic questionnaire. The
  // branch precedes every hook so hook order stays stable per remount key.
  const intent = question.intent
  if (intent?.kind === 'plan-review') {
    // Spread with the narrowed intent: the decision card's contract is the
    // plan-review variant, not the union the questionnaire accepts.
    return <PlanReviewPanel
      question={{ ...question, intent }}
      onAnswer={onAnswer}
      onCancel={onCancel}
      readClipboardOverride={readClipboardOverride}
    />
  }
  const options = question.options ?? []
  const multiSelect = question.multiSelect === true
  const hideCustomInput = intent?.kind === 'approval' || (question.hideCustomInput === true && options.length > 0)
  const modelEditor = typeof question.modelEditor?.read === 'function'
    && typeof question.modelEditor.save === 'function' && typeof question.modelEditor.edited === 'function'
    ? question.modelEditor : undefined
  const [editingModel, setEditingModel] = React.useState<string | null>(null)
  // Opening Tab and later keys may share one stdin batch. Stop the list
  // synchronously, before the nested editor has had a chance to mount.
  const editingRef = React.useRef(false)
  const { columns: terminalColumns, rows: terminalRows } = useTerminalSize()
  /** Rows: the real options plus the inline input row at the tail. */
  const rowCount = options.length + (hideCustomInput ? 0 : 1)
  // A saved draft wins over the wizard's default selection (returning to a
  // question must restore exactly what the user last had, including an
  // explicit empty answer); the defaults only apply on first display.
  const initialSelected = initialDraft !== undefined
    ? initialDraft.selected
    : question.defaultSelected ?? []
  const initialCustom = hideCustomInput ? '' : initialDraft?.custom ?? ''
  const selectedIndices = options
    .map((option, index) => initialSelected.includes(option.label) ? index : -1)
    .filter(index => index >= 0)
  const initialFocus = initialCustom !== '' && selectedIndices.length === 0 && !hideCustomInput
    ? options.length
    : selectedIndices[0] ?? 0
  const [focusIndex, setFocusIndex] = React.useState(initialFocus)
  const [checked, setChecked] = React.useState<ReadonlySet<number>>(
    () => new Set(multiSelect ? selectedIndices : []),
  )
  // Same stdin batch, same closure: Space / ↑ / ↓ must be visible to a
  // following → before React commits. Refs are the draft source; state
  // only repaints.
  const focusRef = React.useRef(initialFocus)
  const checkedRef = React.useRef<ReadonlySet<number>>(new Set(multiSelect ? selectedIndices : []))
  const [customText, setCustomText] = React.useState(initialCustom)
  const [customCursor, setCustomCursor] = React.useState(() => [...initialCustom].length)
  // Synchronous source of truth for the handlers (see the module header):
  // keys of one stdin batch share a single React update, and the clipboard
  // read resolves asynchronously — the state mirrors exist only to re-render.
  const textRef = React.useRef(initialCustom)
  const cursorRef = React.useRef([...initialCustom].length)
  /** Single choke point for every text/caret mutation: refs first, then the
   *  state mirrors so the render sees the committed value. */
  const applyText = (nextText: string, nextCursor: number): void => {
    textRef.current = nextText
    cursorRef.current = nextCursor
    setCustomText(nextText)
    setCustomCursor(nextCursor)
  }
  /** True while the component is mounted (async clipboard continuation
   *  guard: the panel can unmount when the user answers before the read
   *  resolves). */
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => { mountedRef.current = false }, [])
  /** True while a clipboard read is in flight (ignore repeat Ctrl+V). */
  const pasteBusyRef = React.useRef(false)
  const clipboardReader = readClipboardOverride ?? readClipboard
  /** Single-select label captured by typing on a focused option — submitted
   *  together with the custom text when the input row itself is Entered. */
  const [attached, setAttached] = React.useState<string | null>(
    () => initialCustom !== '' && !multiSelect ? (initialSelected[0] ?? null) : null,
  )
  const attachedRef = React.useRef<string | null>(
    initialCustom !== '' && !multiSelect ? (initialSelected[0] ?? null) : null,
  )
  const placeFocus = (index: number): void => {
    focusRef.current = index
    setFocusIndex(index)
  }
  const placeChecked = (next: ReadonlySet<number>): void => {
    checkedRef.current = next
    setChecked(next)
  }
  const toggleCheckedAt = (index: number): void => {
    const next = new Set(checkedRef.current)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    placeChecked(next)
  }
  const placeAttached = (value: string | null): void => {
    attachedRef.current = value
    setAttached(value)
  }
  const onInputRow = (): boolean => !hideCustomInput && focusRef.current === options.length
  const [error, setError] = React.useState<string | null>(null)
  const bodyScrollRef = React.useRef<ScrollBoxHandle | null>(null)

  const inputFocused = !hideCustomInput && focusIndex === options.length
  // Chat chrome + panel scaffolding consume twelve rows before the option
  // list: status line, outer/divider/question/list/hint spacing and content.
  // Optional header/detail/input/error rows are charged explicitly. Long
  // lists then use fixed one/two-line rows so listWindow's budget is exact;
  // short questionnaires retain their existing wrapped presentation.
  const linkText = question.link === undefined || question.link === '' ? '' : createHyperlink(question.link)
  // The question and its detail are preview text above the option list, and
  // `wrap` re-flows every long line: counting source lines undercounts the
  // rows they really take, and neither text had a cap — a long question
  // pushed the options and the hint off screen with nothing left to answer
  // (#1664). Pre-wrap to the panel's content width, fold past the cap, and
  // charge the REAL row count to the option budget below.
  const contentCells = Math.max(8, terminalColumns - 4)
  const previewMaxRows = Math.max(2, Math.min(
    QUESTION_PREVIEW_MAX_ROWS,
    terminalRows - QUESTION_CHROME_ROWS,
  ))
  const questionView = clipPreviewRows(question.question, contentCells, previewMaxRows)
  const questionBlockRows = questionView.rows.length + (questionView.omitted > 0 ? 1 : 0)
  // The question's unused allowance flows to the detail — but only the rows
  // the terminal frees up beyond the chrome floor. On a terminal already at
  // that floor every preview row is contested, and the cap is what keeps the
  // option list and the hint on screen; above it a one-line question must not
  // fold the detail against a budget the question never needed.
  const sparePreviewRows = Math.max(
    0,
    terminalRows - QUESTION_CHROME_ROWS - questionBlockRows,
  )
  const detailMaxRows = Math.max(2, Math.min(
    QUESTION_PREVIEW_MAX_ROWS,
    previewMaxRows + sparePreviewRows,
  ))
  const detailView = question.detail === undefined
    ? undefined
    : clipPreviewRows(question.detail, contentCells, detailMaxRows)
  const detailRows = detailView === undefined
    ? (linkText === '' ? 0 : 2)
    : detailView.rows.length + (detailView.omitted > 0 ? 1 : 0) + 1 + (linkText === '' ? 0 : 1)
  // One viewport keeps the question and its detail independently reachable:
  // a question without a detail must still be readable beyond its preview.
  const bodyRows = questionView.rows.length + questionView.omitted
    + (detailView === undefined ? 0 : detailView.rows.length + detailView.omitted)
    + (question.detail !== undefined || linkText !== '' ? 1 : 0)
    + (linkText === '' ? 0 : wrapText(linkText, contentCells, 'wrap').split('\n').length)
  const previewRows = questionBlockRows + detailRows
  const bodyScrollRows = bodyRows > previewRows ? Math.max(1, previewRows - 1) : 0
  const submitRows = multiSelect && fullscreen && (checked.size > 0 || textRef.current !== '') ? 2 : 0
  // ── Answer field geometry (the multi-line window) ──────────────────
  // The caret counts code points (module header), so every offset below is a
  // code-point index — a line start is a point index, never a UTF-16 one.
  // Only the caret's OWN window is painted: the field must never grow into
  // the option list and the hint, and the caret is always inside the window.
  const answerMaxLines = Math.max(3, Math.min(
    ANSWER_FIELD_MAX_LINES,
    terminalRows - QUESTION_CHROME_ROWS - 2,
  ))
  const answerPoints = [...textRef.current]
  const answerLineStarts: number[] = [0]
  answerPoints.forEach((point, index) => {
    if (point === '\n') answerLineStarts.push(index + 1)
  })
  let answerCaretLine = 0
  while (
    answerCaretLine + 1 < answerLineStarts.length
    && answerLineStarts[answerCaretLine + 1]! <= cursorRef.current
  ) {
    answerCaretLine += 1
  }
  const answerWindowStartLine = answerLineStarts.length <= answerMaxLines
    ? 0
    : Math.max(0, Math.min(
        answerCaretLine - answerMaxLines + 1,
        answerLineStarts.length - answerMaxLines,
      ))
  const answerWindowStart = answerLineStarts[answerWindowStartLine] ?? 0
  // A full window drops the newline that opened the next, unpainted line.
  const answerWindowEnd = answerWindowStartLine + answerMaxLines < answerLineStarts.length
    ? answerLineStarts[answerWindowStartLine + answerMaxLines]! - 1
    : answerPoints.length
  const answerWindowPoints = answerPoints.slice(answerWindowStart, answerWindowEnd)
  // A secret answer masks its points but KEEPS the line breaks: the caret
  // must still land on the row the user typed it on.
  const answerWindowMasked = question.secret === true
    ? answerWindowPoints.map(point => point === '\n' ? '\n' : SECRET_MASK)
    : answerWindowPoints
  const answerCaret = cursorRef.current - answerWindowStart
  // The caret cell: a newline has no glyph to invert, so the caret sits on
  // the blank cell that closes its line.
  const answerCaretGlyph = answerCaret < answerWindowMasked.length && answerWindowMasked[answerCaret] !== '\n'
    ? answerWindowMasked[answerCaret]!
    : ' '
  // Honest height: the painted window — not a constant `1` — is what the
  // option window has to leave room for. Wrapping is measured at the field's
  // real content width (pointer + pencil + margin + label + colon reserved).
  const answerFieldCells = Math.max(
    8,
    contentCells - 3 - stringWidth(
      `${t('question-custom-tab')}${attached === null ? '' : t('question-attached-label', { label: attached })}：`,
    ),
  )
  const answerText = answerWindowMasked.join('')
  const answerRows = hideCustomInput
    ? 0
    : Math.max(1, wrapText(answerText === '' ? ' ' : answerText, answerFieldCells, 'wrap').split('\n').length)
  const reservedRows = 12
    + (question.header === undefined ? 0 : 1)
    + (questionBlockRows - 1)
    + detailRows
    + answerRows
    + (error === null ? 0 : 2)
    + submitRows
  const optionBudget = Math.max(terminalRows - reservedRows, 2)
  const optionHeights = options.map(option => option.description === undefined ? 1 : 2)
  const optionLabels = options.map(option =>
    option.label + (modelEditor?.edited(option.label) ? ` ${t('provider-model-edited')}` : ''))
  // Non-windowed rows wrap at their actual text width. Reducing the preview
  // must not disable windowing just because a multiline description was
  // counted as one line. Windowed rows below still have fixed 1/2-row heights.
  const optionCells = Math.max(1, contentCells - 3)
  const wrappedOptionRows = options.reduce((sum, option, index) =>
    sum + wrapText(optionLabels[index]!, optionCells, 'wrap').split('\n').length
      + (option.description === undefined ? 0 : wrapText(option.description, optionCells, 'wrap').split('\n').length), 0)
  const windowedOptions = wrappedOptionRows > optionBudget
  const optionFocus = Math.min(focusIndex, Math.max(options.length - 1, 0))
  const optionWindow = windowedOptions
    ? listWindow(optionHeights, optionFocus, optionBudget)
    : { start: 0, end: options.length }

  // Park the native terminal cursor on the custom-answer caret: terminal
  // emulators render IME preedit (pinyin) at the physical cursor, so without
  // this declaration CJK composition appears at the screen's bottom row
  // instead of inline at the input (same mechanism as PromptInput's value
  // box). Active whenever the input row is visible — typing on an option row
  // also lands in this input, so the IME anchor must follow even when the
  // row itself is not focused. The ref rides on the caret Text itself (all
  // three visual variants): its nodeCache rect IS the caret cell, so (0, 0)
  // stays exact under CJK widths and line wrapping without any
  // layout-affecting wrapper Box.
  const nativeCursor = useNativeCursor()
  const caretRef = useDeclaredCursor({
    line: 0, column: 0,
    active: !hideCustomInput && !collapsed && editingModel === null,
    visible: nativeCursor && inputFocused,
  })

  const moveFocus = (delta: 1 | -1): void => {
    if (rowCount <= 1) return
    placeFocus((focusRef.current + delta + rowCount) % rowCount)
    setError(null)
  }

  /** Append at the text tail (option-row typing has no visible cursor). */
  const appendText = (text: string): void => {
    applyText(textRef.current + text, cursorRef.current + [...text].length)
    setError(null)
  }

  /** Drop the character before the caret; empty text drops the attach. */
  const backspaceText = (): void => {
    const points = [...textRef.current]
    const at = cursorRef.current
    if (at <= 0) return
    points.splice(at - 1, 1)
    const next = points.join('')
    if (next === '') placeAttached(null)
    applyText(next, at - 1)
  }

  /**
   * Paste-path entry shared by both transports (bracketed-paste chunk and
   * the async clipboard read). Single-line field: newlines and control
   * chars flatten to spaces; a chunk with nothing visible (blank lines or
   * stray controls only) inserts nothing, and one past the cap is refused
   * (never truncated — the user must see that text was dropped). Where the
   * text lands mirrors plain typing — at the caret while the input row is
   * focused, appended at the tail (and the option's label attached,
   * single-select) when typing on an option row would append.
   * @returns 'ok' | 'empty' (nothing visible to insert) | 'too-long'
   */
  const insertPastedText = (raw: string, atCaret: boolean): 'ok' | 'empty' | 'too-long' => {
    const text = flattenPasteInline(raw)
    if (text.trim() === '') return 'empty'
    if ([...text].length > ANSWER_PASTE_MAX_POINTS) return 'too-long'
    const points = [...textRef.current]
    const at = atCaret ? cursorRef.current : points.length
    points.splice(at, 0, ...text)
    applyText(points.join(''), at + [...text].length)
    if (!atCaret && !multiSelect) placeAttached(options[focusRef.current]?.label ?? null)
    return 'ok'
  }

  /** Inline error for an over-cap paste (shared by both transports). */
  const pasteTooLongError = (): string =>
    t('question-paste-too-long', { n: ANSWER_PASTE_MAX_POINTS })

  /** Ctrl+V/Alt+V arm: read the system clipboard and insert its text. */
  const pasteFromClipboard = (): void => {
    if (pasteBusyRef.current) return
    pasteBusyRef.current = true
    // Option-row typing appends at the tail; capture which semantics the
    // keypress asked for — the read resolves later, after the user may
    // have moved focus or typed (the refs make either safe).
    const atCaret = inputFocused
    void clipboardReader()
      .then(content => {
        if (!mountedRef.current) return
        if (content === null || content.kind === 'unavailable') {
          setError(t(content === null ? 'input-clipboard-empty' : 'input-clipboard-unavailable'))
          return
        }
        if (content.kind !== 'text') {
          // File/image offers have no text form in an answer field.
          setError(t('question-paste-not-text'))
          return
        }
        if (content.text === '') {
          setError(t('input-clipboard-empty'))
          return
        }
        const result = insertPastedText(content.text, atCaret)
        setError(result === 'too-long' ? pasteTooLongError() : null)
      })
      .catch(() => {
        if (mountedRef.current) setError(t('input-clipboard-read-failed'))
      })
      .finally(() => {
        pasteBusyRef.current = false
      })
  }

  const checkedLabels = (): string[] =>
    [...checkedRef.current].sort((a, b) => a - b).map(index => options[index]?.label)
      .filter((label): label is string => label !== undefined)

  /** Enter on a real option: the option(s) plus whatever the input row holds. */
  const submitOptions = (): void => {
    const text = textRef.current.trim()
    if (multiSelect) {
      const selected = checkedLabels()
      if (selected.length === 0 && text === '') {
        setError(t('question-select-or-answer'))
        return
      }
      onAnswer({ selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }
    const label = options[focusRef.current]?.label
    if (label === undefined) {
      setError(t('question-select-or-answer'))
      return
    }
    onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }

  /** Enter on the input row itself: the text, plus the attached label (or
   *  the checked labels for multi-select) when there is one. */
  const submitInput = (): void => {
    const text = textRef.current.trim()
    if (multiSelect) {
      const selected = checkedLabels()
      if (selected.length === 0 && text === '') {
        setError(t('question-answer-or-check'))
        return
      }
      onAnswer({ selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }
    if (text === '') {
      setError(t('question-type-answer-first'))
      return
    }
    onAnswer({ selected: attachedRef.current !== null ? [attachedRef.current] : [], custom: text })
  }

  /** Capture the visible answer state before navigating away. */
  const currentDraft = (): QuestionDraft => {
    const selected = multiSelect
      ? checkedLabels()
      : onInputRow()
        ? (attachedRef.current === null ? [] : [attachedRef.current])
        : (() => {
            const label = options[focusRef.current]?.label
            return label === undefined ? [] : [label]
          })()
    return {
      selected,
      ...(textRef.current !== '' ? { custom: textRef.current } : {}),
    }
  }

  const openModelEditor = (model: string, event: { stopImmediatePropagation(): void }): void => {
    editingRef.current = true
    setEditingModel(model)
    event.stopImmediatePropagation()
  }
  const manualModelAtCaret = (): string => {
    const points = [...textRef.current]
    const isSeparator = (char: string | undefined): boolean => char === undefined || /[,，\s]/u.test(char)
    let at = Math.min(cursorRef.current, points.length)
    if (at === points.length || isSeparator(points[at])) at -= 1
    while (at >= 0 && isSeparator(points[at])) at -= 1
    if (at < 0) return ''
    let start = at
    let end = at + 1
    while (start > 0 && !isSeparator(points[start - 1])) start -= 1
    while (end < points.length && !isSeparator(points[end])) end += 1
    return points.slice(start, end).join('')
  }

  useInput((input, key, event) => {
    if (editingRef.current) {
      event.stopImmediatePropagation()
      return
    }
    // The mounted panel owns folding, just like answering: hidden asks
    // cannot steal approval/dialog keys, and an interrupting questionnaire
    // still works when Chat yields to an underlying screen's open flag.
    if (onToggleFold !== undefined && actionMatches('questionFold', input, key)) {
      onToggleFold()
      event.stopImmediatePropagation()
      return
    }
    if (collapsed) {
      if (key.escape || (key.ctrl && input === 'c')) {
        onExpand?.()
        event.stopImmediatePropagation()
      }
      return
    }
    if (bodyScrollRows > 0) {
      const up = actionMatches('questionDetailUp', input, key)
      const down = actionMatches('questionDetailDown', input, key)
      if (up || down) {
        pagePreview(bodyScrollRef.current, up ? -1 : 1)
        event.stopImmediatePropagation()
        return
      }
    }
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }
    if (key.escape) {
      if (onEscape !== undefined) onEscape(currentDraft())
      else if (onBack !== undefined) onBack(currentDraft())
      else onCancel()
      return
    }

    // ── Paste ─────────────────────────────────────────────────────────
    // A bracketed paste (terminal Ctrl+Shift+V / right-click / a terminal
    // that intercepts Ctrl+V) arrives as ONE chunk flagged isPasted. Where
    // it lands mirrors plain typing: on an option row it appends at the
    // tail (and attaches the option's label, single-select), on the input
    // row it inserts at the caret. It never submits — a chunk that is all
    // line breaks is text, not an Enter press (isPlainReturnInput refuses
    // pastes; the flattened text may also be empty → nothing to insert).
    if (key.isPasted === true) {
      if (!hideCustomInput && input !== '') {
        const result = insertPastedText(input, inputFocused)
        setError(result === 'too-long' ? pasteTooLongError() : null)
      }
      return
    }
    // Clipboard paste (default Ctrl+V / Alt+V — the keymap `paste`
    // binding, remappable in /settings): raw mode hands the key to the
    // app, so the clipboard is read here (mirrors the composer's arm).
    if (actionMatches('paste', input, key)) {
      if (!hideCustomInput) pasteFromClipboard()
      return
    }

    if (onInputRow()) {
      if (key.tab && modelEditor !== undefined) {
        const manualModel = manualModelAtCaret()
        if (manualModel !== '') {
          openModelEditor(manualModel, event)
          return
        }
        placeFocus(0)
        event.stopImmediatePropagation()
        return
      }
      // ── macOS / readline editing (the composer's key contract) ────────
      // The caret and every offset below are CODE POINTS: the array is the
      // one the render slices, so an emoji is one step and a word scan can
      // never land inside a surrogate pair.
      const points = [...textRef.current]
      const at = cursorRef.current
      const lineStartAt = (): number => {
        let index = at
        while (index > 0 && points[index - 1] !== '\n') index -= 1
        return index
      }
      const lineEndAt = (): number => {
        let index = at
        while (index < points.length && points[index] !== '\n') index += 1
        return index
      }
      // Readline's whitespace-delimited rule (Alt+B/F, Ctrl+W): the same one
      // inputWordBoundary.ts applies for the composer, spelled on points.
      const wordBackAt = (): number => {
        let index = at
        while (index > 0 && /\s/u.test(points[index - 1]!)) index -= 1
        while (index > 0 && !/\s/u.test(points[index - 1]!)) index -= 1
        return index
      }
      const wordForwardAt = (): number => {
        let index = at
        while (index < points.length && !/\s/u.test(points[index]!)) index += 1
        while (index < points.length && /\s/u.test(points[index]!)) index += 1
        return index
      }
      const moveCaretTo = (next: number): void => {
        applyText(textRef.current, Math.max(0, Math.min([...textRef.current].length, next)))
      }
      /** Drop [start, end) in code points and park the caret at `start`. */
      const deleteAnswerRange = (start: number, end: number): void => {
        if (start >= end) return
        const live = [...textRef.current]
        const next = live.slice(0, start).concat(live.slice(end)).join('')
        if (next === '') placeAttached(null)
        applyText(next, start)
        setError(null)
      }
      const insertAnswerNewline = (): void => {
        const live = [...textRef.current]
        const caret = cursorRef.current
        live.splice(caret, 0, '\n')
        applyText(live.join(''), caret + 1)
        setError(null)
      }
      /** ±1 logical line at the same column, clamped at the text edges. */
      const lineStepCaret = (delta: -1 | 1): number => {
        const start = lineStartAt()
        const column = at - start
        if (delta === -1) {
          if (start === 0) return at
          const prevEnd = start - 1
          let prevStart = prevEnd
          while (prevStart > 0 && points[prevStart - 1] !== '\n') prevStart -= 1
          return prevStart + Math.min(column, prevEnd - prevStart)
        }
        const end = lineEndAt()
        if (end >= points.length) return at
        const nextStart = end + 1
        let nextEnd = nextStart
        while (nextEnd < points.length && points[nextEnd] !== '\n') nextEnd += 1
        return nextStart + Math.min(column, nextEnd - nextStart)
      }
      // Shift+Enter / Option+Enter / Ctrl+J break the answer into a new line
      // and never submit it. A bare Enter still submits below, and Ctrl+K
      // stays the panel fold (matched before this branch).
      if (key.return && (key.shift || key.meta)) {
        insertAnswerNewline()
        return
      }
      if (key.ctrl && !key.shift && !key.meta && !key.super && input === 'j') {
        insertAnswerNewline()
        return
      }
      // Word jumps: Alt/Option+←/→ and Ctrl+←/→. Ghostty hands Option+arrows
      // as ESC b / ESC f (most terminals' parser folds those into meta+←/→;
      // the literal b/f arm covers the rest), which is why both spellings
      // are matched — same pair as the launchpad.
      const escapeJump = key.meta && !key.ctrl && (input === 'b' || input === 'f')
      if (escapeJump || ((isMod(key) || key.meta) && (key.leftArrow || key.rightArrow))) {
        const back = escapeJump ? input === 'b' : key.leftArrow === true
        moveCaretTo(back ? wordBackAt() : wordForwardAt())
        return
      }
      // Line edges: Ctrl+A/E, plus the Cmd+←/→ that Ghostty delivers as
      // Ctrl+A/E. Home/End are line-scoped in a multi-line answer.
      if (isMod(key) && input === 'a') {
        moveCaretTo(lineStartAt())
        return
      }
      if (isMod(key) && input === 'e') {
        moveCaretTo(lineEndAt())
        return
      }
      // Deletions: Ctrl+W / Option+Backspace take the previous word, Ctrl+U
      // takes the line prefix (Ctrl+K stays fold — see the module header).
      if ((isMod(key) && input === 'w') || (key.meta && key.backspace)) {
        deleteAnswerRange(wordBackAt(), at)
        return
      }
      if (isMod(key) && input === 'u') {
        deleteAnswerRange(lineStartAt(), at)
        return
      }
      // Caret motion between lines is Ctrl+↑/↓: plain ↑/↓ keep navigating the
      // list and Alt+↑/↓ keep scrolling the question body (both documented).
      if (isMod(key) && (key.upArrow || key.downArrow)) {
        moveCaretTo(lineStepCaret(key.upArrow ? -1 : 1))
        return
      }
      if (key.upArrow) {
        moveFocus(-1)
        return
      }
      if (key.downArrow) {
        moveFocus(1)
        return
      }
      if (isPlainReturnInput(input, key)) {
        submitInput()
        return
      }
      if (key.backspace && !key.meta) {
        backspaceText()
        return
      }
      if (key.delete) {
        const live = [...textRef.current]
        const caret = cursorRef.current
        if (caret < live.length) {
          live.splice(caret, 1)
          const next = live.join('')
          if (next === '') placeAttached(null)
          applyText(next, caret)
        }
        return
      }
      if (key.leftArrow) {
        // Plain ← at the start of the answer switches questions; anywhere
        // else (and modified arrows) stays a caret step.
        if (isPlainArrow(key) && cursorRef.current === 0 && onBack !== undefined) {
          onBack(currentDraft())
          return
        }
        applyText(textRef.current, Math.max(0, cursorRef.current - 1))
        return
      }
      if (key.rightArrow) {
        const length = [...textRef.current].length
        if (isPlainArrow(key) && cursorRef.current >= length && onForward !== undefined) {
          onForward(currentDraft())
          return
        }
        applyText(textRef.current, Math.min(length, cursorRef.current + 1))
        return
      }
      // Home/End are line-scoped like the composer's: one logical line is
      // the editing unit of a multi-line answer (a single-line answer is
      // unchanged — its line IS the whole text).
      if (key.home) {
        moveCaretTo(lineStartAt())
        return
      }
      if (key.end) {
        moveCaretTo(lineEndAt())
        return
      }
      if (!key.ctrl && !key.meta && !key.super && input) {
        // Ordinary typing at the live caret (a text run may carry several
        // characters in one event — e.g. an unbracketed terminal paste).
        const live = [...textRef.current]
        const caret = cursorRef.current
        live.splice(caret, 0, ...input)
        applyText(live.join(''), caret + [...input].length)
        setError(null)
      }
      return
    }

    // A real option row.
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    if (key.leftArrow && isPlainArrow(key)) {
      if (onBack !== undefined) onBack(currentDraft())
      return
    }
    if (key.rightArrow && isPlainArrow(key)) {
      if (onForward !== undefined) onForward(currentDraft())
      return
    }
    if (key.tab && !key.shift && !key.ctrl && !key.meta && !key.super && modelEditor !== undefined) {
      const model = options[focusRef.current]?.label
      if (model !== undefined) {
        openModelEditor(model, event)
      }
      return
    }
    if (key.tab && !hideCustomInput) {
      placeFocus(options.length)
      setError(null)
      return
    }
    if (input === ' ' && multiSelect) {
      toggleCheckedAt(focusRef.current)
      return
    }
    if (isPlainReturnInput(input, key)) {
      submitOptions()
      return
    }
    if (key.backspace) {
      // Edit the input row without leaving the option list.
      if (!hideCustomInput && textRef.current !== '') backspaceText()
      return
    }
    // Typing on an option appends into the input row; single-select also
    // attaches this option's label so Enter carries label + text (#9).
    if (!hideCustomInput && !key.ctrl && !key.meta && !key.super && input) {
      appendText(input)
      if (!multiSelect) placeAttached(options[focusRef.current]?.label ?? null)
    }
  })

  const remaining = total - answered
  /** Fold shortcut label for the hint row (follows /settings remaps). */
  const foldCombo = effectiveComboDisplay('questionFold')
  const headerTitle = ` ${t('question-header-progress', { position, total, remaining: remaining > 1 ? t('question-remaining-more', { n: remaining }) : '' })} `
  /** First line of the question body for the minimized bar (whitespace
   *  flattened the same way windowedOptions flattens labels). */
  const questionText = question.question.split('\n')[0]?.replace(/\s+/gu, ' ').trim() ?? ''

  // The caret counts code points (see the module header), so the visual
  // split indexes the painted window's point array — never raw UTF-16
  // offsets, which could land inside a surrogate pair. A caret parked ON a
  // newline keeps that newline in the tail: the inverted blank cell closes
  // the line, and the painted line break must not collapse under it.
  const caretOnNewline = inputFocused
    && answerCaret < answerWindowMasked.length
    && answerWindowMasked[answerCaret] === '\n'
  const caretTailStart = inputFocused && answerCaret < answerWindowMasked.length && !caretOnNewline
    ? answerCaret + 1
    : answerCaret
  /** Mouse: click the input row to focus it (same as Tab). */
  const focusInputRow = (): void => {
    if (hideCustomInput) return
    placeFocus(options.length)
    setError(null)
  }
  /**
   * Mouse: click an option row. Multi-select toggles the checkmark (same as
   * Space); single-select answers immediately with that option plus any
   * typed text (same as focusing the row and pressing Enter) — one click =
   * one answer, matching ApprovalPanel's click semantics.
   */
  const clickOption = (index: number): void => {
    if (multiSelect) {
      toggleCheckedAt(index)
      return
    }
    const label = options[index]?.label
    if (label === undefined) return
    const text = textRef.current.trim()
    onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  /** Header row hover — the row doubles as the mouse fold/unfold affordance. */
  const [headerHovered, setHeaderHovered] = React.useState(false)
  /** Mouse submit row hover (multi-select: clicking submits the checked set). */
  const [submitHovered, setSubmitHovered] = React.useState(false)
  const renderInputRow = (): React.ReactNode => (
    <Box
      flexDirection="row"
      marginTop={inputFocused ? 1 : 0}
      onClick={focusInputRow}
      onMouseEnter={() => setHoverIndex(options.length)}
      onMouseLeave={() => setHoverIndex(current => (current === options.length ? -1 : current))}
      backgroundColor={hoverIndex === options.length && !inputFocused ? 'userMessageBackgroundHover' : undefined}
    >
      <Box width={1} flexShrink={0}>
        <Text color={inputFocused ? 'accent' : undefined} bold={inputFocused}>
          {inputFocused ? POINTER : ' '}
        </Text>
      </Box>
      <Box width={1} flexShrink={0}>
        <Text color={inputFocused ? 'accent' : 'suggestion'}>{PENCIL}</Text>
      </Box>
      <Box flexDirection="row" marginLeft={1}>
        <Text bold={inputFocused} color={inputFocused ? 'accent' : 'suggestion'}>
          {t('question-custom-tab')}
        </Text>
        {attached !== null && (
          <Text color="suggestion">{t('question-attached-label', { label: attached })}</Text>
        )}
        <Text dimColor>：</Text>
        {customText === '' && !inputFocused ? (
          // The IME anchor must sit on a cell styled exactly like the answer
          // text the user is about to commit: the terminal draws the preedit
          // at the physical cursor USING THAT CELL'S STYLE, so an anchor over
          // the dim placeholder turned pinyin dim, and one on the suggestion-
          // colored caret turned it blue (reported from a real session).
          // Hence a bare leading cell takes the anchor — no color prop, same
          // "terminal default foreground" the typed run gets — and the
          // placeholder starts one column later.
          <>
            <Text ref={caretRef}>{' '}</Text>
            <Text dimColor>{t('question-direct-input')}</Text>
          </>
        ) : (
          <>
            <Text wrap="wrap">{answerWindowMasked.slice(0, answerCaret).join('')}</Text>
            {/* Leave the native caret's glyph plain so the terminal can
                animate it and paint IME preedit with the input's style. */}
            {inputFocused
              ? <Text ref={caretRef} inverse={!nativeCursor}>{answerCaretGlyph}</Text>
              : <Text ref={caretRef}>▏</Text>}
            <Text wrap="wrap">{answerWindowMasked.slice(inputFocused ? caretTailStart : answerCaret).join('')}</Text>
          </>
        )}
      </Box>
    </Box>
  )

  const renderOptions = (): React.ReactNode => (
    <Box flexDirection="column" marginTop={1}>
      {options.slice(optionWindow.start, optionWindow.end).map((option, index) => {
        const absoluteIndex = optionWindow.start + index
        const focused = absoluteIndex === focusIndex
        const selected = multiSelect ? checked.has(absoluteIndex) : focused
        const pointer = focused
          ? POINTER
          : absoluteIndex === optionWindow.start && optionWindow.start > 0
            ? '↑'
            : absoluteIndex === optionWindow.end - 1 && optionWindow.end < options.length
              ? '↓'
              : ' '
        const optionLabel = optionLabels[absoluteIndex]!
        const label = windowedOptions ? optionLabel.replace(/\s+/gu, ' ').trim() : optionLabel
        const description = windowedOptions
          ? option.description?.replace(/\s+/gu, ' ').trim()
          : option.description
        return (
          <Box
            key={`${absoluteIndex}:${option.label}`}
            flexDirection="row"
            marginTop={!windowedOptions && focused ? 1 : 0}
            onClick={() => clickOption(absoluteIndex)}
            onMouseEnter={() => setHoverIndex(absoluteIndex)}
            onMouseLeave={() => setHoverIndex(current => (current === absoluteIndex ? -1 : current))}
            backgroundColor={hoverIndex === absoluteIndex && !focused ? 'userMessageBackgroundHover' : undefined}
          >
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'accent' : undefined} bold={focused}>
                {pointer}
              </Text>
            </Box>
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'accent' : undefined} bold={selected}>
                {selected ? (multiSelect ? CHECKED : '●') : UNCHECKED}
              </Text>
            </Box>
            <Box flexDirection="column" marginLeft={1}>
              <Text
                bold={focused || selected}
                color={focused ? 'accent' : undefined}
                wrap={windowedOptions ? 'truncate' : 'wrap'}
              >
                {label}
              </Text>
              {description !== undefined && (
                <Text dimColor wrap={windowedOptions ? 'truncate' : 'wrap'}>
                  {description}
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
      {hideCustomInput ? null : renderInputRow()}
      {submitRows > 0 && (
        <Box
          flexDirection="row"
          height={1}
          marginTop={1}
          onClick={submitOptions}
          onMouseEnter={() => setSubmitHovered(true)}
          onMouseLeave={() => setSubmitHovered(false)}
          backgroundColor={submitHovered ? 'userMessageBackgroundHover' : undefined}
        >
          <Text color="accent">✓ </Text>
          <Text dimColor>{t('question-submit-selection')}</Text>
        </Box>
      )}
    </Box>
  )

  const hintParts = inputFocused
    ? [
        t('question-hint-type'),
        ...(modelEditor === undefined ? [] : [t('provider-model-edit-hint')]),
        t('question-hint-paste', { key: comboDisplay(primaryComboString('paste')) }),
        t('question-hint-enter'),
        t('question-hint-newline'),
        ...(options.length > 0 ? [t('question-hint-back')] : []),
        onBack === undefined ? t('question-hint-esc') : t('question-hint-previous'),
        ...(onBack !== undefined || onForward !== undefined ? [t('question-hint-switch-input')] : []),
        ...(onBack === undefined ? [] : [t('question-hint-cancel')]),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
        t('question-fold-hint', { combo: foldCombo }),
      ]
    : [
        t('question-hint-select'),
        ...(multiSelect ? [t('question-hint-multi')] : []),
        ...(modelEditor === undefined ? [] : [t('provider-model-edit-hint')]),
        ...(hideCustomInput ? [] : [t('question-hint-paste', { key: comboDisplay(primaryComboString('paste')) }), t('question-hint-attach')]),
        t('question-hint-enter'),
        onBack === undefined ? t('question-hint-esc') : t('question-hint-previous'),
        ...(onBack !== undefined || onForward !== undefined ? [t('question-hint-switch')] : []),
        ...(onBack === undefined ? [] : [t('question-hint-cancel')]),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
        t('question-fold-hint', { combo: foldCombo }),
      ]

  // Folded: render only the minimized bar. This branch sits AFTER every
  // hook (and after the intent early-return), so folding never reorders
  // hooks and the draft refs above stay alive for the expand.
  if (collapsed) {
    return <QuestionMinimizedBar progress={headerTitle} questionText={questionText} onExpand={onExpand ?? (() => {})} />
  }

  if (editingModel !== null && modelEditor !== undefined) {
    return <ProviderModelEditor
      model={editingModel}
      editor={modelEditor}
      onClose={() => {
        editingRef.current = false
        setEditingModel(null)
      }}
      onAbort={onCancel}
      readClipboardOverride={readClipboardOverride}
    />
  }

  const body = (
    <>
      <Text bold wrap="wrap">{question.question}</Text>
      {(question.detail !== undefined || linkText !== '') && (
        <Box flexDirection="column" marginTop={1}>
          {question.detail !== undefined && <Text dimColor italic wrap="wrap">{question.detail}</Text>}
          {linkText !== '' && <Text wrap="wrap">{linkText}</Text>}
        </Box>
      )}
    </>
  )

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Box
        flexDirection="column"
        onClick={onToggleFold}
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
        backgroundColor={headerHovered ? 'userMessageBackgroundHover' : undefined}
      >
        <Divider color="permission" title={`▾${headerTitle}`} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {question.header !== undefined && (
          <Text color="suggestion" bold>
            ◈ {question.header}
          </Text>
        )}
        {bodyScrollRows > 0 ? (
          <>
            <ScrollBox ref={bodyScrollRef} flexDirection="column" height={bodyScrollRows} flexShrink={0}>
              {body}
            </ScrollBox>
            <Text dimColor wrap="truncate-end">
              {t('question-detail-scroll', {
                count: bodyRows - bodyScrollRows,
                up: effectiveComboDisplay('questionDetailUp'),
                down: effectiveComboDisplay('questionDetailDown'),
              })}
            </Text>
          </>
        ) : body}
      </Box>
      {renderOptions()}
      {error !== null && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{hintParts.join(' · ')}</Text>
      </Box>
    </Box>
  )
}
