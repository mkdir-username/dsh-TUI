import React from 'react'
import { Box, ScrollBox, Text, type ScrollBoxHandle, useApp, useInput, useTerminalImages, useTerminalSize } from '../ui.js'
import { afterNextTerminalFlush } from '../ink/flush-tick.js'
import { sanitizeEditableText } from '../utils/inputPaste.js'
import { getLang, subscribeLang, t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { HintLine } from './design-system/HintLine.js'
import { CLAUDE_GIRL_ASSETS, MAID_ASSETS, MaidPortrait, useMaidPortraits } from './maidPortrait.js'
import { getActiveBrand } from '../branding.js'
import { WhaleGirlHappyArt } from './WhaleGirl.js'
import { useTerminalBackground } from './design-system/ThemeProvider.js'
import type { WhaleCouponNotice } from '../dsh-adapter/oauth/bonus.js'
import type { AccountNotificationNotice } from '../dsh-adapter/oauth/account-notifications.js'

/** Art slot width — the pixel whale fallback is 40 columns wide, and the
 * raster portrait fits inside the same slot so the card width never moves. */
const ART_COLUMNS = 40
/** Art slot height: 18 rows (confetti 3 + whale 13 in the celebration), and
 * the text column is pinned to the same height (see the column's comment). */
const ART_ROWS = 18
/** Text column width: every copy line, button and hint stays on ONE row
 * (the "排版不舒适" report: no stranded `⭐`, no mid-sentence breaks). */
const TEXT_COLUMNS = 48
/** Portrait + text side by side need this many columns (art 40 + gap 2 +
 * text 48 + card chrome 6); below that the card drops the art and stacks
 * text at the narrower width. */
const MIN_ART_COLUMNS = 98
/** Card height with the art (18 art rows + 2 border rows); terminals shorter
 * than this + 2 margin rows get the text-only card. */
const MIN_ART_ROWS = 23

/** Stars in two sparse rows: an always-lit anchor star plus twinkling ones
 * whose phase differs per column, so each frame lights a third of them. */
const CONFETTI_GLYPHS = ['✦', '✧'] as const
const CONFETTI_COLORS = ['warning', 'accent', 'activity'] as const
const CONFETTI_FRAMES = 3
const CONFETTI_ROWS = 2
const CONFETTI_ANCHOR_STRIDE = 7

type ConfettiRun = { readonly text: string; readonly color: (typeof CONFETTI_COLORS)[number] | undefined }

const CONFETTI: readonly (readonly (readonly ConfettiRun[])[])[] =
  Array.from({ length: CONFETTI_FRAMES }, (_, frameIndex) =>
    Array.from({ length: CONFETTI_ROWS }, (_, row) => {
      const runs: { text: string; color: ConfettiRun['color'] }[] = []
      let current: ConfettiRun['color'] = undefined
      let buffer = ''
      for (let column = 0; column < ART_COLUMNS; column++) {
        const anchor = column % CONFETTI_ANCHOR_STRIDE === 0
        const twinkle = !anchor
          && column % 2 === 0
          && (column / 2 + row) % CONFETTI_FRAMES === frameIndex
        const glyph = anchor ? CONFETTI_GLYPHS[0] : twinkle ? CONFETTI_GLYPHS[1] : ' '
        const color = anchor
          ? CONFETTI_COLORS[0]
          : twinkle
            ? (column / 2) % 2 === 0 ? CONFETTI_COLORS[1] : CONFETTI_COLORS[2]
            : undefined
        if (color !== current) {
          if (buffer !== '') runs.push({ text: buffer, color: current })
          buffer = ''
          current = color
        }
        buffer += glyph
      }
      if (buffer !== '') runs.push({ text: buffer, color: current })
      return runs
    }))

/** One confetti band, advancing a frame every 160ms while it is mounted. */
function Confetti({ width }: { width: number }): React.ReactNode {
  const frame = useConfettiFrame()
  const rows = CONFETTI[frame] ?? CONFETTI[0]!
  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      {rows.map((runs, index) => (
        <Text key={index} wrap="truncate-end">
          {runs.map((run, runIndex) => (
            <Text key={runIndex} color={run.color}>{run.text}</Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

function useConfettiFrame(): number {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame(previous => (previous + 1) % CONFETTI_FRAMES)
    }, 220)
    ;(timer as { unref?: () => void }).unref?.()
    return () => { clearInterval(timer) }
  }, [])
  return frame
}

function couponExpiry(expiresAt: string): { month: string; day: string; time: string } | null {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string): string | undefined => parts.find(item => item.type === type)?.value
  const month = part('month')
  const day = part('day')
  const hour = part('hour')
  const minute = part('minute')
  return month === undefined || day === undefined || hour === undefined || minute === undefined
    ? null : { month, day, time: `${hour}:${minute}` }
}

type CouponCardNotice = Pick<WhaleCouponNotice, 'orderId' | 'amount' | 'currency' | 'expiresAt'>

/** One existing account-notice lane, with server copy when no coupon data exists. */
export function WhaleCouponPrompt(props: {
  readonly notice: WhaleCouponNotice | AccountNotificationNotice
  readonly onShown: (orderId: string) => void
  readonly onClose: () => void
}): React.ReactNode {
  const notice = props.notice
  if (notice.kind !== 'account-notification') return <LegacyWhaleCouponPrompt {...props} notice={notice} />
  if (notice.amount !== undefined && notice.currency !== undefined && notice.expiresAt !== undefined) {
    // Keep the store's snapshot identity: allocating a presentation object here
    // would re-arm the write receipt on every unrelated Chat commit.
    return <LegacyWhaleCouponPrompt {...props} notice={notice as CouponCardNotice} />
  }
  return <ServerAccountNotice {...props} notice={notice} />
}

function LegacyWhaleCouponPrompt({
  notice,
  onShown,
  onClose,
}: {
  readonly notice: CouponCardNotice
  readonly onShown: (orderId: string) => void
  readonly onClose: () => void
}): React.ReactNode {
  const lang = React.useSyncExternalStore(subscribeLang, getLang)
  const { columns, rows } = useTerminalSize()
  const imagesAvailable = useTerminalImages()
  const portraits = useMaidPortraits(true, getActiveBrand() === 'claude' ? CLAUDE_GIRL_ASSETS : MAID_ASSETS)
  const background = useTerminalBackground()
  const withArt = columns >= MIN_ART_COLUMNS && rows >= MIN_ART_ROWS
  const textColumns = withArt ? TEXT_COLUMNS : Math.max(1, Math.min(TEXT_COLUMNS, columns - 6))
  const cardColumns = withArt ? 96 : Math.min(columns, textColumns + 6)
  const cardRows = withArt ? ART_ROWS + 2 : Math.min(rows, 15)
  const left = Math.max(0, Math.floor((columns - cardColumns) / 2))
  const bottom = Math.max(0, Math.min(Math.floor((rows - cardRows) / 2), rows - cardRows))
  const amount = notice.amount.replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '')
  const unit = lang === 'zh' ? notice.currency === 'CNY' ? '元' : '美元' : notice.currency
  const expiry = couponExpiry(notice.expiresAt)

  const { stdout } = useApp()
  // Register during mutation so even synchronous commits capture this card.
  // A queued write is not presentation: wait for its successful completion.
  // Register once per snapshot identity: an unrelated commit with a fresh
  // parent callback must not re-arm the receipt, but a refreshed same-id
  // snapshot must (the store rejects an ack carrying the previous snapshot).
  const receipt = React.useRef({ onShown, orderId: notice.orderId })
  receipt.current.onShown = onShown
  receipt.current.orderId = notice.orderId
  React.useInsertionEffect(() => afterNextTerminalFlush(stdout,
    () => receipt.current.onShown(receipt.current.orderId)), [stdout, notice])
  useInput((_input, key) => {
    if (key.return || key.escape) onClose()
  })

  return (
    <>
      <Box position="absolute" bottom={0} left={0} width="100%" height={rows}
        flexShrink={0} backdrop="dim" onClick={onClose} />
      <Box position="absolute" left={left} bottom={bottom} width={cardColumns} height={cardRows}
        flexDirection="column" flexShrink={0} overflow="hidden" backgroundColor={background} opaque
        onClick={event => { event.stopImmediatePropagation() }}>
        <Box flexDirection="row" gap={2} alignItems="center" justifyContent="center"
          borderStyle="round" borderColor="inactive" paddingX={2} backgroundColor={background}>
          {withArt && (
            <Box width={ART_COLUMNS} height={ART_ROWS} flexShrink={0} flexDirection="column"
              alignItems="center" justifyContent="center" backgroundColor={background} opaque>
              <Confetti width={ART_COLUMNS} />
              {imagesAvailable && portraits?.happy !== undefined
                ? <MaidPortrait source={portraits.happy} maxColumns={ART_COLUMNS}
                    maxRows={ART_ROWS - CONFETTI_ROWS} presentation="preview" />
                : <WhaleGirlHappyArt source={portraits?.happy} width={ART_COLUMNS} />}
            </Box>
          )}
          <Box flexDirection="column" width={textColumns} {...(withArt ? { height: ART_ROWS } : {})}>
            <Text color="accent" bold wrap="truncate-end">{t('coupon-modal-title')}</Text>
            <Box height={1} />
            <Text color="success" bold wrap="wrap">{t('coupon-modal-received', { amount, unit })}</Text>
            {expiry !== null && (
              <>
                <Box height={1} />
                <Text wrap="wrap">{t('coupon-modal-expiry', expiry)}</Text>
              </>
            )}
            <Box flexGrow={1} />
            <Divider width={textColumns} />
            <Text dimColor wrap="truncate-end"><HintLine text={t('coupon-modal-hint')} /></Text>
          </Box>
        </Box>
      </Box>
    </>
  )
}

/** Server-authored account text uses the existing account-notice modal lane. */
function ServerAccountNotice({ notice, onShown, onClose }: {
  readonly notice: AccountNotificationNotice
  readonly onShown: (id: string) => void
  readonly onClose: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const { stdout } = useApp()
  const background = useTerminalBackground()
  const scroll = React.useRef<ScrollBoxHandle | null>(null)
  const width = Math.max(1, Math.min(columns, 72))
  const height = Math.max(1, Math.min(rows, 20))
  // Mutation-phase registration precedes even the synchronous test renderer's
  // resetAfterCommit. The callback requires a real write, never a timer guess;
  // it re-arms only when this snapshot changes (a language refresh keeps the
  // same id) and reads the latest callback through the ref.
  const receipt = React.useRef({ onShown, orderId: notice.orderId })
  receipt.current.onShown = onShown
  receipt.current.orderId = notice.orderId
  React.useInsertionEffect(() => afterNextTerminalFlush(stdout,
    () => receipt.current.onShown(receipt.current.orderId)), [stdout, notice])
  useInput((_input, key, event) => {
    event.stopImmediatePropagation()
    if (key.return || key.escape) onClose()
    else if (key.upArrow || key.wheelUp || key.pageUp) scroll.current?.scrollBy(key.pageUp ? -Math.max(1, height - 5) : -3)
    else if (key.downArrow || key.wheelDown || key.pageDown) scroll.current?.scrollBy(key.pageDown ? Math.max(1, height - 5) : 3)
  })
  const accountAction = notice.actions.find(action => action.target.type === 'app_route')
  const dismiss = notice.actions.find(action => action.target.type === 'dismiss')
  return <>
    <Box position="absolute" bottom={0} left={0} width="100%" height={rows} backdrop="dim" onClick={onClose} />
    <Box position="absolute" left={Math.max(0, Math.floor((columns - width) / 2))}
      bottom={Math.max(0, Math.floor((rows - height) / 2))} width={width} height={height}
      flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}
      backgroundColor={background} opaque overflow="hidden" onClick={event => event.stopImmediatePropagation()}>
      <Box flexShrink={0}><Text bold color="accent" wrap="truncate-end">{sanitizeEditableText(notice.title)}</Text></Box>
      <ScrollBox ref={scroll} flexDirection="column" flexGrow={1} height={Math.max(1, height - 5)}>
        <Text wrap="wrap">{sanitizeEditableText(notice.body)}</Text>
        {accountAction !== undefined && <Text dimColor wrap="wrap">{t('account-notice-account-route', { label: sanitizeEditableText(accountAction.label) })}</Text>}
      </ScrollBox>
      <Box flexShrink={0}><Text dimColor wrap="wrap">{t('account-notice-hint', { label: dismiss === undefined ? t('account-notice-close') : sanitizeEditableText(dismiss.label) })}</Text></Box>
    </Box>
  </>
}
