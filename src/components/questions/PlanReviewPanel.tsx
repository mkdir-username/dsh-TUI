/**
 * The plan-review panel — exit-plan-mode decision card
 * for the DSH user-interaction seam. plan-mode's `exit_plan_mode` tool asks
 * through `ctx.userQuestions` with `intent: { kind: 'plan-review',
 * approve }`: the plan markdown arrives in `detail`, the approve/decline
 * choices in `options` (labels verbatim — the protocol answers with the
 * asker's own labels).
 *
 * Protocol-exact answer mapping (dsh-plan-mode):
 * - Approve: `{ selected: [intent.approve] }` — custom MUST be absent, or
 *   plan-mode treats it as keep-planning-with-feedback. An asker may name
 *   further approving options (`intent.approveAlso`, e.g. Claude's "approve,
 *   but keep asking for edits"): they follow the same clean-answer rule.
 * - Keep planning / feedback: `{ selected: [declineLabel], custom? }` where
 *   declineLabel is `intent.decline` when the asker names it, else the first
 *   option that does not approve (dsh-plan-mode names none).
 * - Esc / Ctrl+C: the store rejects with ASK_CANCELLED, which plan-mode
 *   reads as "the user dismissed the review to speak instead".
 *
 * The feedback row is the questionnaire's answer field: the SAME shared
 * editor (useAnswerField) owns text, caret, the clipboard transport and the
 * key dispatch, so the macOS/readline keys and the multi-line input can
 * never drift between the two panels again. Paste works like the composer:
 * Ctrl+V/Alt+V (the keymap `paste` binding) reads the system clipboard, and
 * a bracketed paste inserts its chunk — newlines/control chars flatten to
 * spaces, and pasted content NEVER picks an option or approves (a pasted
 * digit or a chunk of line breaks is text, not a quick-pick or an Enter).
 * The caret counts code points, so an emoji can never be split by
 * ←/→/⌫/Del, and a multi-line answer paints a caret-anchored window.
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, useInput, ScrollBox, useTerminalSize, type ScrollBoxHandle } from '../../ui.js'
import wrapText from '../../ink/wrap-text.js'
import { useDeclaredCursor, useNativeCursor } from '../../ink/hooks/use-declared-cursor.js'
import { Divider } from '../design-system/Divider.js'
import { Markdown } from '../Markdown.js'
import { POINTER } from '../../terminal-utils/figures.js'
import type { QuestionIntentView, QuestionSelection } from '../../channel/questions.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { actionMatches, comboDisplay, primaryComboString } from '../../utils/keymap.js'
import type { ClipboardRead } from '../../utils/clipboard.js'
import { ANSWER_PASTE_MAX_POINTS, answerWindow, caretSplit } from './answerField.js'
import { useAnswerField } from './useAnswerField.js'

const PENCIL = '✎'

/**
 * Visible-height cap for a multi-line feedback, in logical lines — twin of
 * AskUserQuestionPanel's ANSWER_FIELD_MAX_LINES: the field paints a
 * caret-anchored window of this many lines and charges the real row count
 * to the layout budget below, so a long answer can never push the decision
 * rows off screen. Shrinks further on short terminals through
 * `answerMaxLines`.
 */
const ANSWER_FIELD_MAX_LINES = 6

export type PlanReviewPanelProps = {
  /** The plan-review question (intent.kind === 'plan-review'). */
  readonly question: {
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
    readonly intent?: Extract<QuestionIntentView, { readonly kind: 'plan-review' }>
  }
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc / Ctrl+C — dismissed to speak instead (ASK_CANCELLED). */
  readonly onCancel: () => void
  /**
   * Test seam: clipboard reader for the Ctrl+V paste arm. Defaults to the
   * real cross-platform reader; headless verification injects a fake.
   */
  readonly readClipboardOverride?: () => Promise<ClipboardRead>
}

export function PlanReviewPanel({
  question,
  onAnswer,
  onCancel,
  readClipboardOverride,
}: PlanReviewPanelProps): React.ReactNode {
  const options = question.options ?? []
  const approveLabel = question.intent?.approve ?? options[0]?.label
  const approveAlso = question.intent?.approveAlso ?? []
  const approves = (label: string | undefined): boolean => label !== undefined && (label === approveLabel || approveAlso.includes(label))
  const declineLabel = question.intent?.decline ?? options.find(option => !approves(option.label))?.label
  /** Rows: the asker's options plus the feedback input row at the tail. */
  const rowCount = options.length + 1
  const [focusIndex, setFocusIndex] = React.useState(0)
  const inputFocused = focusIndex === options.length
  const [error, setError] = React.useState<string | null>(null)
  // The feedback row's editing contract is shared with the questionnaire's
  // answer field (see useAnswerField): refs mutated synchronously per stdin
  // event, code-point caret, clipboard transport.
  const field = useAnswerField('', { readClipboard: readClipboardOverride })
  const { columns: terminalColumns, rows: terminalRows } = useTerminalSize()
  // Chat chrome (status line) + panel scaffolding (divider, question,
  // spacings, hint) consume twelve rows before the plan body — same
  // constant as AskUserQuestionPanel. Option/feedback/error rows are
  // charged on top so a long markdown detail cannot push them off-screen.
  // A definite `height` (not just maxHeight) is required: otherwise the
  // ScrollBox grows with the markdown and scrollBy is a no-op.
  const contentCells = Math.max(8, terminalColumns - 4)
  // Pointer + pencil + margin: the feedback text starts three cells in.
  const answerFieldCells = Math.max(8, contentCells - 3)
  const baseOptionRows = options.reduce(
    (sum, option) => sum + (option.description === undefined ? 1 : 2),
    0,
  ) + 1 /* extra gap on the focused row */ + 1 /* feedback row */
  const baseReserved = 12 + baseOptionRows + (error === null ? 0 : 2)
  // A short terminal keeps a one-line field: the window may only grow when
  // the rows exist for it (the questionnaire's rule, same editor).
  const answerMaxLines = Math.max(1, Math.min(ANSWER_FIELD_MAX_LINES, terminalRows - baseReserved))
  const answerPoints = [...field.text]
  const answerWin = answerWindow(answerPoints, field.cursor, answerMaxLines)
  const answerPainted = answerPoints.slice(answerWin.start, answerWin.end)
  const answerSplit = caretSplit(answerPainted, answerWin.caret, inputFocused)
  // Honest height: the painted window — not a constant `1` — is what the
  // plan-body viewport has to leave room for.
  const answerRows = Math.max(1, wrapText(
    answerPainted.length === 0 ? ' ' : answerPainted.join(''),
    answerFieldCells,
    'wrap',
  ).split('\n').length)
  const reservedRows = baseReserved + (answerRows - 1)
  // Floor at zero, not four: on a short terminal the decision rows fill the
  // budget and no plan-body rows remain. Forcing four here would re-inflate
  // the panel past the viewport and push the controls off-screen again — the
  // exact regression this panel exists to prevent. When nothing remains, the
  // body viewport is omitted entirely (a zero-height ScrollBox is neither
  // readable nor a useful wheel target).
  const detailMax = Math.max(0, terminalRows - reservedRows)
  const detailScrollRef = React.useRef<ScrollBoxHandle | null>(null)

  // Park the native terminal cursor on the feedback caret so IME preedit
  // (pinyin) renders inline at the input instead of the screen's bottom row
  // (same mechanism as AskUserQuestionPanel / PromptInput). Always active —
  // typing on an option row also lands in the feedback buffer. The ref rides
  // on the caret Text itself (all visual variants): its nodeCache rect IS
  // the caret cell, so (0, 0) stays exact under wrapping without a
  // layout-affecting wrapper Box.
  const nativeCursor = useNativeCursor()
  const caretRef = useDeclaredCursor({ line: 0, column: 0, active: true, visible: nativeCursor && inputFocused })

  const moveFocus = (delta: 1 | -1): void => {
    setFocusIndex(index => (index + delta + rowCount) % rowCount)
    setError(null)
  }

  /** A tail paste mirrors option-row typing: the input row takes focus. */
  const focusAfterPaste = (): void => {
    setFocusIndex(options.length)
  }

  /** The decline answer: the other option's label when the asker named one,
   *  else an empty selection (plan-mode reads any non-approve as decline). */
  const declineSelected = (): string[] => declineLabel !== undefined ? [declineLabel] : []

  /** Enter on an option row. Approve with feedback in the buffer is an
   *  error — the protocol would silently read it as keep-planning. */
  const submitOption = (index: number): void => {
    const label = options[index]?.label
    if (label === undefined) return
    const text = field.textRef.current.trim()
    if (approves(label) && text !== '') {
      setError(t('plan-review-approve-needs-empty'))
      return
    }
    if (approves(label)) {
      onAnswer({ selected: [label] })
      return
    }
    onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }

  /** Enter on the feedback row: text routes to keep-planning-with-feedback;
   *  empty is a plain keep-planning. */
  const submitFeedback = (): void => {
    const text = field.textRef.current.trim()
    onAnswer({ selected: declineSelected(), ...(text !== '' ? { custom: text } : {}) })
  }

  useInput((input, key, event) => {
    // Steal the wheel while this panel is mounted so Chat's fallback cannot
    // scroll the transcript. Position-first already hits the ScrollBox when
    // the pointer is over it; this covers the option/hint rows and any
    // dispatchWheelAt miss. Up/Down stay on the decision rows.
    if (key.wheelUp || key.wheelDown) {
      detailScrollRef.current?.scrollBy(key.wheelUp ? -3 : 3)
      event.stopImmediatePropagation()
      return
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }

    // ── Paste ─────────────────────────────────────────────────────────
    // A bracketed paste arrives as ONE chunk flagged isPasted. Where it
    // lands mirrors plain typing: at the caret on the feedback row, else
    // appended at the tail with the feedback row focused. It NEVER picks
    // an option — a pasted digit or an all-line-breaks chunk is text, not
    // a quick-pick or an Enter press (isPlainReturnInput refuses pastes).
    if (key.isPasted === true) {
      if (input !== '') {
        const result = field.insertPasted(input, inputFocused, focusAfterPaste)
        setError(result === 'too-long' ? t('question-paste-too-long', { n: ANSWER_PASTE_MAX_POINTS }) : null)
      }
      return
    }
    // Clipboard paste (default Ctrl+V / Alt+V — the keymap `paste`
    // binding, remappable in /settings): raw mode hands the key to the
    // app, so the clipboard is read here (mirrors the composer's arm).
    if (actionMatches('paste', input, key)) {
      field.pasteFromClipboard(inputFocused, setError, focusAfterPaste)
      return
    }

    if (inputFocused) {
      field.handleKey(input, key, { onMoveFocus: moveFocus, onSubmit: submitFeedback })
      return
    }

    // An option row.
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    if (isPlainReturnInput(input, key)) {
      submitOption(focusIndex)
      return
    }
    if (key.backspace) {
      if (field.text !== '') field.backspace()
      return
    }
    if (!key.ctrl && !key.meta && input) {
      // Number quick-pick submits the option outright — but only with an
      // empty buffer; with feedback pending, digits are feedback chars.
      const digit = /^[1-9]$/.test(input) ? Number(input) : 0
      if (field.text === '' && digit >= 1 && digit <= options.length) {
        submitOption(digit - 1)
        return
      }
      field.append(input)
      setFocusIndex(options.length)
      setError(null)
    }
  }, { isActive: true })

  /** Mouse: click a decision row = focus it + submit (same as Enter). */
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  const clickOption = (index: number): void => {
    setFocusIndex(index)
    submitOption(index)
  }
  /** Mouse: click the feedback row to focus it. */
  const focusFeedbackRow = (): void => {
    setFocusIndex(options.length)
    setError(null)
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider
        color="permission"
        title={` ${question.header ?? t('plan-review-fallback-header')} `}
      />
      <Box flexDirection="column" marginTop={1}>
        <Text bold wrap="wrap">
          {question.question}
        </Text>
        {question.detail !== undefined && detailMax > 0 && (
          <Box flexDirection="column" marginTop={1} height={detailMax} flexShrink={0}>
            <ScrollBox ref={detailScrollRef} flexDirection="column" flexGrow={1} height={detailMax}>
              <Markdown>{question.detail}</Markdown>
            </ScrollBox>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const focused = index === focusIndex
          const isApprove = approves(option.label)
          return (
            <Box
              key={option.label}
              flexDirection="row"
              marginTop={focused ? 1 : 0}
              onClick={() => clickOption(index)}
              onMouseEnter={() => setHoverIndex(index)}
              onMouseLeave={() => setHoverIndex(current => (current === index ? -1 : current))}
              backgroundColor={hoverIndex === index && !focused ? 'userMessageBackgroundHover' : undefined}
            >
              <Box width={1} flexShrink={0}>
                <Text color={focused ? 'accent' : undefined} bold={focused}>
                  {focused ? POINTER : ' '}
                </Text>
              </Box>
              <Box flexDirection="column" marginLeft={1}>
                <Text
                  bold={focused}
                  color={focused || isApprove ? 'accent' : undefined}
                  wrap="wrap"
                >
                  {index + 1}. {option.label}
                </Text>
                {option.description !== undefined && (
                  <Text dimColor wrap="wrap">
                    {option.description}
                  </Text>
                )}
              </Box>
            </Box>
          )
        })}
        <Box
          flexDirection="row"
          marginTop={inputFocused ? 1 : 0}
          onClick={focusFeedbackRow}
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
            {field.text === '' && !inputFocused ? (
              // Same IME contract as AskUserQuestionPanel's input row: the
              // anchor cell must carry the plain answer-text style, because
              // the terminal renders the preedit with THAT cell's attributes.
              // A dim placeholder under the anchor made pinyin dim, and the
              // suggestion-colored caret made it blue (reported on the ask
              // panel; this panel shares the input contract).
              <>
                <Text ref={caretRef}>{' '}</Text>
                <Text dimColor>{t('plan-review-feedback-placeholder')}</Text>
              </>
            ) : (
              <>
                <Text wrap="wrap">{answerSplit.head}</Text>
                <Text ref={caretRef} inverse={!nativeCursor && inputFocused}>{answerSplit.glyph}</Text>
                <Text wrap="wrap">{answerSplit.tail}</Text>
              </>
            )}
          </Box>
        </Box>
      </Box>
      {error !== null && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{t('plan-review-hint', {
          paste: comboDisplay(primaryComboString('paste')),
          newline: t('question-hint-newline'),
        })}</Text>
      </Box>
    </Box>
  )
}
