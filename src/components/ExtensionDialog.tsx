/**
 * The managed plugin dialog (`ctx.tuiDialogs`) — one panel rendering the
 * store's current snapshot in the chat chrome (the slot approval/question
 * panels occupy). Three kinds share one component:
 *
 * - `select`  — focus list (↑/↓, windowed), Enter settles the option id
 * - `confirm` — two rows (confirm/cancel), Enter settles the boolean
 * - `input`   — single-line text edit, Enter settles the text
 *
 * Esc (and Ctrl+C) always cancels — the plugin's promise resolves with the
 * cancelled value. The panel owns the keyboard through its own useInput,
 * the same contract as ApprovalPanel/AskUserQuestionPanel: Chat's global
 * handler early-returns while a snapshot is pending.
 *
 * Two input-pipeline rules shape every handler below:
 *
 * - BATCHED KEYS: a terminal delivers one stdin chunk as several key events
 *   inside a single React batch (Down+Enter arrives together), so state
 *   queued by the first event is NOT visible to the second. Every piece of
 *   editing state the handlers act on (focus, value, cursor) therefore
 *   lives in a ref mutated SYNCHRONOUSLY per event; the useState mirror
 *   only exists to re-render.
 * - CODE POINTS: cursor movement and deletion step over whole code points
 *   (`[...s]` iteration, same contract as the transcript search box), so an
 *   emoji can never be split into a lone surrogate.
 *
 * All text arrives pre-sanitized from TuiDialogRuntime (control chars
 * stripped, cell-width capped); the panel still renders everything through
 * ListItem's single-line truncation.
 */

import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { SearchBox } from './SearchBox.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { actionMatches } from '../utils/keymap.js'
import { readClipboard } from '../utils/clipboard.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'
import { INPUT_CELLS, type TuiDialogAnswer, type TuiDialogSnapshot } from '../dsh-adapter/dialogs.js'
import { useAnswerField } from './questions/useAnswerField.js'

export type ExtensionDialogProps = {
  /** The pending dialog (TuiDialogStore snapshot; `key` remounts per dialog). */
  readonly dialog: TuiDialogSnapshot
  readonly onDecide: (value: TuiDialogAnswer) => void
  readonly onCancel: () => void
}

export function ExtensionDialog({ dialog, onDecide, onCancel }: ExtensionDialogProps): React.ReactNode {
  switch (dialog.kind) {
    case 'select':
      return <SelectDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
    case 'confirm':
      return <ConfirmDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
    case 'input':
      return <InputDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
  }
}

function SelectDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'select' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  // Synchronous source of truth for the handlers (see the module header):
  // Down+Enter in one stdin chunk must move AND read the new focus.
  const focusRef = React.useRef(0)
  const moveFocus = (delta: number): void => {
    const next = (focusRef.current + delta + dialog.options.length) % dialog.options.length
    focusRef.current = next
    setFocusIndex(next)
  }
  const { rows: terminalRows } = useTerminalSize()

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
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
    // A bracketed paste that is all line breaks is pasted content, never an
    // Enter press — the key carries isPasted, and isPlainReturnInput
    // refuses pastes before the plain-return test.
    if (isPlainReturnInput(input, key)) {
      const option = dialog.options[focusRef.current]
      if (option !== undefined) onDecide(option.id)
    }
  }, { isActive: true })

  // Row budget mirrors the rewind picker: a described option costs 2 rows,
  // a bare one 1; frame rows: Pane 2 + title 2 + footer 1 + slack.
  const { start, end } = listWindow(
    dialog.options.map(option => (option.description === undefined ? 1 : 2)),
    focusIndex,
    Math.max(terminalRows - 10, 2),
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
        </Box>
        {dialog.options.slice(start, end).map((option, index) => {
          const absoluteIndex = start + index
          return (
            <ListItem
              key={option.id}
              isFocused={absoluteIndex === focusIndex}
              description={option.description}
              showScrollUp={absoluteIndex === start && start > 0}
              showScrollDown={absoluteIndex === end - 1 && end < dialog.options.length}
              // Click = decide this option (same as Enter on it).
              onClick={() => onDecide(option.id)}
            >
              {option.label}
            </ListItem>
          )
        })}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-select-exit')} />
      </Text>
    </Pane>
  )
}

function ConfirmDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'confirm' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  // Synchronous source of truth for the handlers (see the module header):
  // Right+Enter in one stdin chunk must settle the NEW row, not the old.
  const focusRef = React.useRef(0)
  const labels = [
    dialog.confirmLabel || t('ext-dialog-yes'),
    dialog.cancelLabel || t('ext-dialog-no'),
  ]
  const moveFocus = (delta: number): void => {
    const next = (focusRef.current + delta + labels.length) % labels.length
    focusRef.current = next
    setFocusIndex(next)
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow || key.leftArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow || key.rightArrow) {
      moveFocus(1)
      return
    }
    // A bracketed paste that is all line breaks is pasted content, never an
    // Enter press — the key carries isPasted, and isPlainReturnInput
    // refuses pastes before the plain-return test.
    if (isPlainReturnInput(input, key)) {
      onDecide(focusRef.current === 0)
    }
  }, { isActive: true })

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
          {dialog.message !== undefined && <Text dimColor>{dialog.message}</Text>}
        </Box>
        {labels.map((label, index) => (
          <ListItem
            key={label}
            isFocused={index === focusIndex}
            // Click = decide this row (same as Enter on it).
            onClick={() => onDecide(index === 0)}
          >
            {label}
          </ListItem>
        ))}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-select-exit')} />
      </Text>
    </Pane>
  )
}

function InputDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'input' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  // The value is the shared single-line answer field: refs mutated
  // synchronously per key (a batched chunk must compose), code-point caret,
  // the macOS/readline contract — plus the display-cell cap this dialog has
  // always enforced (typing past it is refused, paste is truncated).
  const field = useAnswerField(dialog.initial, { multiline: false, maxCells: INPUT_CELLS })

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    // A bracketed paste that is all line breaks is inserted as text, never
    // submitted — the key carries isPasted, and isPlainReturnInput refuses
    // pastes before the plain-return test.
    if (isPlainReturnInput(input, key)) {
      onDecide(field.textRef.current)
      return
    }
    if (key.isPasted === true) {
      if (input !== '') field.insertPasted(input, true)
      return
    }
    // Clipboard paste (default Ctrl+V / Alt+V — the keymap `paste` binding):
    // read failures stay silent (the dialog has no notice channel).
    if (actionMatches('paste', input, key)) {
      field.pasteFromClipboard(true, () => {})
      return
    }
    field.handleKey(input, key, { onSubmit: () => onDecide(field.textRef.current) })
  }, { isActive: true })

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
        </Box>
        <SearchBox
          query={field.text}
          cursorOffset={[...field.text].slice(0, field.cursor).join('').length}
          placeholder={dialog.placeholder ?? ''}
          placeholderAlign="left"
          prefix=""
          borderless
          isFocused
          isTerminalFocused
        />
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-ext-dialog-input')} />
      </Text>
    </Pane>
  )
}
