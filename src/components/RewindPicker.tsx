import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import type { ChatRow } from '../dsh-adapter/channel.js'
import type { TuiRewindMode } from '../dsh-adapter/extension-events.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'
import { useOverlayListRows } from './OverlayAbove.js'

/** One checkpoint: the message line plus its dim metadata line. */
const ROW_HEIGHT = 2
/** Air between checkpoints — the whole list is a wall of text without it. */
const ROW_GAP = 1
/** Same visible cap as Claude Code's rewind selector; the rest hides behind
 *  the counters instead of painting the entire history. */
const MAX_VISIBLE = 7
/** Normal chrome: overlay wrapper 1 + Pane 2 + title block 3 + footer 2. */
const LIST_FRAME_ROWS = 8
/** Compact chrome below ~20 terminal rows: wrapper 1 + Pane 2 + title 1 +
 *  footer 1. The subtitle and the footer margin are secondary. */
const LIST_FRAME_COMPACT_ROWS = 5

/**
 * Double-Esc rewind picker (double-tap Esc rewinds the selected message and/or
 * conversation to a previous point in time: lists the user's past messages
 * newest-first; selecting one and confirming rewinds the conversation to
 * that point (the message comes back into the input for re-editing).
 *
 * The confirm pane has two shapes: the plain one (Enter rewinds), and —
 * when a plugin answered the tui/rewind-prompt decision with extra modes —
 * a choice list whose option zero is always the built-in conversation-only
 * rewind, followed by the plugin's modes (e.g. "also restore files").
 */
export function RewindPicker({
  rows,
  focusIndex,
  confirmRow,
  modes = null,
  modeIndex = 0,
  busy = false,
  onPickRow,
  onConfirm,
  onPickMode,
}: {
  rows: readonly ChatRow[]
  focusIndex: number
  confirmRow: ChatRow | null
  /** Plugin-offered rewind modes (tui/rewind-prompt); null = plain confirm. */
  modes?: readonly TuiRewindMode[] | null
  /** Focused option in the modes list (0 = conversation-only). */
  modeIndex?: number
  /** True while the plugin decision is in flight. */
  busy?: boolean
  /**
   * Mouse pick on a list row (fullscreen): sets focus only — rewind is a
   * high-risk invisible-confirm operation, so stepping into the confirm
   * state stays an explicit keyboard Enter.
   */
  onPickRow?: (index: number) => void
  /** Mouse click on the plain confirm row: executes the rewind directly —
   *  the confirm pane itself is the explicit confirmation layer. */
  onConfirm?: () => void
  /** Mouse pick on a modes-list option: executes that mode directly. */
  onPickMode?: (index: number) => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  // Frame 0 hands back the overlay's usable height untouched: the adaptive
  // parts (compact chrome, confirm preview rows) read the same number.
  const overlayRows = useOverlayListRows(0)
  const compact = overlayRows < 12
  const modeListRows = useOverlayListRows(6)
  // Rows for the checkpoint list itself. The list chrome is counted by real
  // rows (wrapper 1 + Pane 2 + title block 3 + footer 2; compact 5), and the
  // busy line is its own row. Counters are reserved below, after the first
  // window tells how many sides actually hide rows.
  const listFrame = (compact ? LIST_FRAME_COMPACT_ROWS : LIST_FRAME_ROWS)
    + (confirmRow === null && busy ? 1 : 0)
  const listRows = Math.min(
    useOverlayListRows(listFrame),
    MAX_VISIBLE * (ROW_HEIGHT + ROW_GAP) - ROW_GAP,
  )
  const heights = rows.map(() => ROW_HEIGHT)
  const fit = (budget: number) => listWindow(heights, focusIndex, Math.max(2, budget), ROW_GAP)
  let listWin = fit(listRows)
  const reserved = (listWin.start > 0 ? 1 : 0) + (listWin.end < rows.length ? 1 : 0)
  if (reserved > 0) listWin = fit(listRows - reserved)
  const hiddenAbove = listWin.start
  const hiddenBelow = rows.length - listWin.end
  const contentCells = Math.max(8, columns - 4)
  // ListItem paints the pointer plus one gap cell before the text.
  const listTextCells = Math.max(8, contentCells - 2)
  if (confirmRow !== null) {
    if (modes !== null) {
      // Plugin modes: a described choice list (one extra row per
      // description), windowed like the message list below.
      const rowCosts = [2, ...modes.map(mode => (mode.description === undefined ? 1 : 2))]
      const { start, end } = listWindow(rowCosts, modeIndex, modeListRows)
      const options: readonly { key: string; label: string; description?: string }[] = [
        { key: 'conversation', label: t('rewind-mode-default'), description: t('rewind-confirm-desc') },
        ...modes.map(mode => ({
          key: mode.id,
          label: mode.label,
          ...(mode.description === undefined ? {} : { description: mode.description }),
        })),
      ]
      return (
        <Pane color="permission">
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color="remember" bold>
                {t('rewind-confirm-title')}
              </Text>
              <Text dimColor>{preview(confirmRow.text)}</Text>
            </Box>
            {options.slice(start, end).map((option, index) => {
              const absoluteIndex = start + index
              return (
                <ListItem
                  key={option.key}
                  isFocused={absoluteIndex === modeIndex}
                  description={option.description}
                  showScrollUp={absoluteIndex === start && start > 0}
                  showScrollDown={absoluteIndex === end - 1 && end < options.length}
                  onClick={onPickMode === undefined ? undefined : () => onPickMode(absoluteIndex)}
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
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>
              {t('rewind-confirm-title')}
            </Text>
          </Box>
          <ListItem isFocused={false} description={t('rewind-confirm-desc')} onClick={onConfirm}>
            {preview(confirmRow.text)}
          </ListItem>
          <Text dimColor italic>
            <HintLine text={t('hint-rewind-back')} />
          </Text>
        </Box>
      </Pane>
    )
  }

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={compact ? 0 : 1} flexDirection="column">
          <Text color="accent" bold>
            {t('rewind-title')}
          </Text>
          {!compact && <Text dimColor>{t('rewind-subtitle')}</Text>}
        </Box>
        {rows.length === 0 ? (
          <ListItem isFocused={false}>{t('rewind-empty')}</ListItem>
        ) : (
          <>
            {hiddenAbove > 0 && (
              <Text dimColor wrap="truncate-end">{t('rewind-more-above', { n: hiddenAbove })}</Text>
            )}
            <Box flexDirection="column" gap={ROW_GAP}>
              {rows.slice(listWin.start, listWin.end).map((row, index) => {
                const absoluteIndex = listWin.start + index
                return (
                  <ListItem
                    key={row.id}
                    isFocused={absoluteIndex === focusIndex}
                    focusColor="accent"
                    description={metaFor(rows, absoluteIndex)}
                    onClick={
                      onPickRow !== undefined && !busy
                        ? () => onPickRow(absoluteIndex)
                        : undefined
                    }
                  >
                    {oneLine(row.text, listTextCells)}
                  </ListItem>
                )
              })}
            </Box>
            {hiddenBelow > 0 && (
              <Text dimColor wrap="truncate-end">{t('rewind-more-below', { n: hiddenBelow })}</Text>
            )}
          </>
        )}
        {busy && <Text dimColor>{t('rewind-waiting-plugins')}</Text>}
      </Box>
      <Box marginTop={compact ? 0 : 1}>
        <Text dimColor italic>
          <HintLine text={t('hint-select-exit')} />
        </Text>
      </Box>
    </Pane>
  )
}

/** Checkpoint metadata: chronological position, plus the newest marker. */
function metaFor(rows: readonly ChatRow[], index: number): string {
  const position = t('rewind-row-position', { n: rows.length - index, total: rows.length })
  return index === 0 ? `${t('rewind-last-message')} · ${position}` : position
}

/** One-line, width-aware preview: flatten breaks, truncate by display cells. */
function oneLine(text: string, cells: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat === '' || stringWidth(flat) <= cells) return flat
  return `${truncateToWidth(flat, Math.max(1, cells - 1))}…`
}

/** One-line preview of a message (newlines flattened, capped). */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
}
