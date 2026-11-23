/**
 * A live stream must not move a reader who scrolled up off the bottom.
 *
 * The reported shape: the agent is writing (the bottom boundary keeps moving),
 * the reader wheels up to hold a previous answer in the viewport, and the text
 * jumps 1-3 rows. The covered scroll paths are a SHRINK above the viewport
 * (verify-scroll-fold-anchor*), a streaming measurement artifact
 * (verify-post-shrink-anchor) or a remeasured estimate (verify-scroll-anchor-*).
 * This is the mirror case: real GROWTH above a manual reader while the turn is
 * still live — a thinking card still streaming over the answer, a tool card
 * settling — plus that growth landing INSIDE a wheel gesture, the window where
 * the anchor's position guards suspend.
 *
 * Asserted invariants:
 *   - a still reader: the row owning the viewport top keeps its terminal row
 *     byte for byte across every painted frame, the paint never disagrees with
 *     the committed position, and the mount window never leaves a blank band;
 *   - a wheel gesture: one notch down then one up nets zero rows, so the
 *     tracked line lands back on the exact row it started on — growth that
 *     happened above the reader during the gesture contributes nothing on top
 *     of it.
 *
 * The run fails unless the growth landed in a MOUNTED row above the viewport
 * (an unmounted row freezes its estimate, so nothing can move there) and the
 * gesture case actually moved the viewport, so neither case can pass vacuously.
 *
 * Run: node --import tsx/esm scripts/verify-scroll-hold-wheel-streaming.tsx
 * Imports src/; no compiled lib/ required. DSH_TEST_COLUMNS=60 tests narrow.
 */
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import type { Channel, ChatRow } from '../src/dsh-adapter/channel.js'
import type { AnchorTraceNote, ListGeometryNote, ScrollGeometryNote } from '../src/ink/geometry-trace.js'

const TRACE = join(tmpdir(), `dsh-scroll-hold-${process.pid}.jsonl`)
process.env.DSH_TUI_GEOMETRY_TRACE = TRACE

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])

const COLS = Number(process.env.DSH_TEST_COLUMNS ?? 100), ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const screens: string[][] = []

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), () => { screens.push(viewportLines(term)); cb() }) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// History: 12-line answers so a turn's own body owns the viewport top and the
// previous turn's answer stays inside the mount window (OVERSCAN_LINES = 8).
const TALL_LINES = 12
const rows: ChatRow[] = []
let nextId = 1
for (let turn = 1; turn <= 20; turn++) {
  rows.push({ id: nextId++, kind: 'user', text: `Question ${turn}` })
  rows.push({
    id: nextId++, kind: 'assistant',
    text: Array.from({ length: TALL_LINES }, (_, i) => `Answer ${turn} line ${i + 1} of the body`).join('\n'),
  })
}

const listeners = new Set<() => void>()
const channel = {
  // Probe determinism: the welcome whale's idle animation stays out of the
  // measurement window.
  whaleIdle: false,
  version: 0,
  rows,
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  mode: { plan: false },
  reasoningEffort: 'max',
  effortLevels: [],
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: true,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: Date.now(),
  // The reader's real settings (`dsh-tui`): smooth reveal on (row heights move
  // every frame) and thinking kept expanded until the turn ends, so the block
  // above the answer is still growing while the answer streams.
  smoothStreaming: true,
  thinkingFold: 'full',
  pending: [],
  commandList: [],
  notifications: [],
  subagents: [],
  lastUserText: 'Question 20',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

type GeometryFrame = {
  frame: number
  cause: string
  scroll: ScrollGeometryNote[]
  list: ListGeometryNote | null
  anchor?: AnchorTraceNote | null
}
function traceFrames(): GeometryFrame[] {
  try {
    return readFileSync(TRACE, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as GeometryFrame)
  } catch { return [] }
}
/** Last frame that actually painted a ScrollBox (trailing frames may be other paints). */
function lastNoteFrame(): GeometryFrame | undefined {
  const frames = traceFrames()
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.scroll.length > 0) return frames[i]
  }
  return undefined
}
/** Last published mount window: the render pass notes it, paints without a
 *  list change carry `null`, so the newest non-null note is the live one. */
function lastList(): ListGeometryNote | null {
  const frames = traceFrames()
  for (let i = frames.length - 1; i >= 0; i--) {
    const note = frames[i]!.list
    if (note !== null && note !== undefined) return note
  }
  return null
}
/** The body text of a viewport row, gutter columns trimmed away. */
function bodyKey(line: string): string { return line.trimStart().slice(0, 40) }
/** First visible history body line: turn number, line-in-turn, terminal row. */
function topBodyMarker(screen: readonly string[]): { turn: number; line: number; row: number } | null {
  for (let i = 0; i < screen.length; i++) {
    const match = /Answer (\d+) line (\d+)/.exec(screen[i] ?? '')
    if (match) return { turn: Number(match[1]), line: Number(match[2]), row: i }
  }
  return null
}
function dumpFrames(observations: readonly GeometryFrame[], label: string): void {
  console.log(`    --- ${label}`)
  for (const frame of observations) {
    for (const note of frame.scroll) {
      const l = frame.list
      const a = frame.anchor
      console.log(`    f${frame.frame} ${frame.cause} top=${note.scrollTop} render=${note.renderScrollTop} ` +
        `H=${note.scrollHeight} max=${note.maxScroll} sticky=${note.sticky ? 1 : 0} cur=${note.cur}` +
        (l ? ` | list ${l.start}..${l.end}/${l.rowCount} tp=${l.topPad} bp=${l.bottomPad}` : '') +
        (a ? ` | anchor id=${a.rowId} prev=${a.prevTop} measured=${a.measuredTop} pred=${a.predicted} applied=${a.applied} drop=${a.drop} draining=${a.draining}` : ''))
    }
  }
}

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel as unknown as Channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: new FakeStderr() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
)
await sleep(1200) // 固定窗:pacing — first screen settles (the trace only notes frames whose scroll geometry changed)

// Live turn: a streaming reasoning block ABOVE a streaming answer, so the block
// the reader has just scrolled past keeps growing over them.
const reasoning: ChatRow = { id: nextId++, kind: 'reasoning', text: 'Reasoning HEAD', streaming: true }
const stream: ChatRow = { id: nextId++, kind: 'assistant', text: 'A-HEAD', streaming: true }
channel.rows.push(reasoning)
channel.rows.push(stream)
bump()
await sleep(600) // 固定窗:pacing — the streaming rows settle into their first layout
for (let i = 0; i < 4; i++) {
  reasoning.text += `\nReasoning body ${i + 1}`
  stream.text += `\nA-HEAD body ${i + 1}`
  bump()
  await sleep(150) // 固定窗:pacing — each priming line paints on its own frame
}
await sleep(400) // 固定窗:pacing — priming tail settles before the measured window

/** Wheel notch at the transcript's centre. 64 = up, 65 = down (SGR buttons). */
function wheelUp(): void { stdin.write('\x1b[<64;50;30M') }
function wheelDown(): void { stdin.write('\x1b[<65;50;30M') }

stdin.write('\x1b[1;5F') // Ctrl+End → jump to the bottom
await sleep(700) // 固定窗:pacing — the jump lands before the park walk starts

// Park the viewport top on the FIRST body line of a turn's answer: the turn
// BEFORE it then ends two rows above the viewport — mounted, and growing it is
// the pure "content above the reader grew" case this probe exists for.
let parked = false
for (let attempt = 0; attempt < 4 && !parked; attempt++) {
  wheelUp()
  await sleep(700) // 固定窗:pacing — each notch settles before the screen is read again
  const marker = topBodyMarker(viewportLines(term))
  if (marker !== null && marker.line === 1 && marker.turn >= 2) parked = true
}
const parkedMarker = topBodyMarker(viewportLines(term))
check('the viewport top parks on a turn answer first line', parked, JSON.stringify(parkedMarker))
if (!parked || parkedMarker === null) {
  await instance.unmount()
  rmSync(TRACE, { force: true })
  process.exit(1)
}

const beforeFrame = lastNoteFrame()
const before = beforeFrame?.scroll.at(-1)
if (before === undefined) {
  check('geometry trace is available', false, 'no scroll note captured (is DSH_TUI_GEOMETRY_TRACE in effect?)')
  await instance.unmount()
  rmSync(TRACE, { force: true })
  process.exit(1)
}
check('the wheel-up broke the follow', before.sticky === false)

// The victim: the answer of the turn the parked one follows. It is the row
// directly above the parked prompt, so its appended lines land above the
// viewport top.
const victimTurn = parkedMarker.turn - 1
const victimIndex = channel.rows.findIndex(row => row.kind === 'assistant' && row.text.startsWith(`Answer ${victimTurn} line`))
const victim = channel.rows[victimIndex]
const parkList = lastList()
const mountedAbove = victim !== undefined && parkList !== null &&
  victimIndex >= parkList.start && victimIndex < parkList.end
check('the previous answer is mounted (its estimate tracks measurement)', mountedAbove,
  parkList ? `window ${parkList.start}..${parkList.end}, victim=${victimIndex}` : 'list note missing')
if (victim === undefined || !mountedAbove) {
  await instance.unmount()
  rmSync(TRACE, { force: true })
  process.exit(1)
}
const growAbove = (label: string): void => {
  victim.text += `\n${label} ADDED ${victim.text.split('\n').length + 1}`
}

// --- case 1: growth above landing inside a wheel gesture -------------------
// One notch down buys the distance the gesture needs: the victim's bottom must
// stay ABOVE the viewport top on the up-stroke, so appended lines never enter
// the viewport (rows under new content legitimately move; that is not the drift
// this case is about). Each round then returns to the parked position, so the
// tracked line has to keep the exact row it started on — while every round
// drops one more growth step into whatever interleaving the drain produces.
wheelDown()
await sleep(700) // 固定窗:pacing — the down notch settles before the gesture baseline
const gestureStartScreen = viewportLines(term)
const gestureStartRow = topBodyMarker(gestureStartScreen)?.row ?? -1
// A concrete visible line, tracked by text: the topmost body line changes as
// the view scrolls, so the delta has to be measured on one fixed line.
const gestureKey = bodyKey(gestureStartScreen[gestureStartRow] ?? '')
const gestureList = lastList()
check('the previous answer is still mounted at the gesture start',
  gestureList !== null && victimIndex >= gestureList.start && victimIndex < gestureList.end,
  gestureList ? `window ${gestureList.start}..${gestureList.end}, victim=${victimIndex}` : 'list note missing')
let frameMark = traceFrames().length
let screenMark = screens.length
const ROUNDS = 4
for (let round = 1; round <= ROUNDS; round++) {
  wheelUp()
  growAbove(`GROW-C${round}`)
  stream.text += `\nA-HEAD gesture ${round}`
  bump()
  await sleep(260) // 固定窗:pacing — the growth lands in the commit that follows the drain
  wheelDown()
  await sleep(260) // 固定窗:pacing — the down notch returns to the same park for the next round
}
await sleep(700) // 固定窗:pacing — the gesture settles before the final read
const gestureFrames = traceFrames().slice(frameMark)
const gestureNotes = gestureFrames.flatMap(frame => frame.scroll)
// The drain is the whole point, and it may land before the commit that would
// report it as pending — so prove it by the position actually moving, not by a
// flag. A gesture case that never moved would pass vacuously.
check('the gesture actually moved the viewport', gestureNotes.some(note => note.scrollTop !== before.scrollTop),
  `top=${gestureNotes.map(note => note.scrollTop).join(',')}`)
const gestureScreen = viewportLines(term)
const gestureRowAfter = gestureScreen.map(line => bodyKey(line)).indexOf(gestureKey)
check('up 3 / down 3 nets zero rows — growth adds nothing',
  gestureStartRow >= 0 && gestureRowAfter === gestureStartRow,
  `row ${gestureStartRow} -> ${gestureRowAfter} (expect ${gestureStartRow})`)
const grownLeaked = gestureScreen.some(line => line.includes('GROW-C'))
check('the growth stayed above the viewport during the gesture', !grownLeaked,
  grownLeaked ? 'grown lines entered the viewport — placement no longer proves the above-viewport case' : '')
check('the gesture never re-pinned the follow', !gestureNotes.some(note => note.sticky))

// --- case 2: growth above a still reader -----------------------------------
// The wheel is parked now: any row displacement is drift the reader never asked
// for, so the row owning the viewport top must keep its terminal row.
const baselineScreen = viewportLines(term)
const baselineMarker = topBodyMarker(baselineScreen)
check('the baseline body anchor is visible', baselineMarker !== null)
const baselineRow = baselineMarker?.row ?? -1
const baselineKey = bodyKey(baselineScreen[baselineRow] ?? '')
frameMark = traceFrames().length
screenMark = screens.length
for (let step = 1; step <= 3; step++) {
  growAbove(`GROW-A${step}`)
  stream.text += `\nA-HEAD tail ${step}`
  reasoning.text += `\nReasoning tail ${step}`
  bump()
  await sleep(180) // 固定窗:pacing — each growth step paints before the next (the window asserts one invariant throughout)
}
await sleep(400) // 固定窗:pacing — the correction converges before the final read

const holdFrames = traceFrames().slice(frameMark)
const holdNotes = holdFrames.flatMap(frame => frame.scroll)
check('the growth frames were observed', holdNotes.some(note => note.scrollHeight > before.scrollHeight),
  `H ${before.scrollHeight} -> ${holdNotes.at(-1)?.scrollHeight ?? before.scrollHeight}`)
const stickyBack = holdNotes.find(note => note.sticky)
check('the follow was not re-pinned', stickyBack === undefined,
  stickyBack ? `sticky@H=${stickyBack.scrollHeight}` : `frames=${holdNotes.length}`)
// Growth ABOVE the reader legitimately moves the content coordinate by its
// amount — the compensation follows it so the ROWS do not move. What may never
// happen is a frame whose paint disagrees with the committed position.
const paintDisagreed = holdNotes.find(note => note.renderScrollTop !== note.scrollTop)
check('the paint never disagrees with the committed position', paintDisagreed === undefined,
  paintDisagreed ? `top=${paintDisagreed.scrollTop} render=${paintDisagreed.renderScrollTop}` : `frames=${holdNotes.length}`)
const holdScreens = screens.slice(screenMark)
check('the xterm body anchor is byte-identical frame to frame',
  holdScreens.length > 0 && holdScreens.every(frame => bodyKey(frame[baselineRow] ?? '') === baselineKey),
  `row=${baselineRow} ${baselineKey}`)
// The correction has to have RUN: a probe that never saw the anchor move would
// pass vacuously (that is what an unmounted victim looks like).
const appliedFrames = holdFrames.filter(frame => (frame.anchor?.applied ?? 0) !== 0)
check('the anchor correction actually ran', appliedFrames.length > 0, `${appliedFrames.length} frames`)
// Window coverage: the viewport top must not sit inside the topPad spacer.
let bandFrame: GeometryFrame | undefined
for (const frame of holdFrames) {
  const listNote = frame.list
  if (listNote === null || listNote === undefined || listNote.sticky) continue
  for (const note of frame.scroll) {
    const band = listNote.base + listNote.topPad - note.renderScrollTop
    if (band > 0 && note.renderScrollTop !== note.clampMin && bandFrame === undefined) bandFrame = frame
  }
}
check('no blank band (the window covers the painted position)', bandFrame === undefined,
  bandFrame ? `f${bandFrame.frame}` : `frames=${holdNotes.length}`)

// --- case 2b: the same reader, growth arriving as a burst ------------------
// The cases above grow one line and wait. A real answer appends faster than a
// Yoga pass can remeasure the rows it moved, so the anchor correction reads a
// stale top for the very row it is compensating. Same reader, same invariant,
// token cadence instead of the probe's.
const burstBaseline = viewportLines(term)
const burstMarker = topBodyMarker(burstBaseline)
check('the burst baseline body anchor is visible', burstMarker !== null)
const burstRow = burstMarker?.row ?? -1
const burstKey = bodyKey(burstBaseline[burstRow] ?? '')
frameMark = traceFrames().length
screenMark = screens.length
for (let step = 1; step <= 8; step++) {
  growAbove(`GROW-B${step}`)
  stream.text += `\nA-HEAD burst ${step}`
  bump()
  await sleep(10) // 固定窗:pacing — token cadence: appends land faster than the layout pass
}
await sleep(500) // 固定窗:pacing — the burst settles before the final read
const burstFrames = traceFrames().slice(frameMark)
const burstNotes = burstFrames.flatMap(frame => frame.scroll)
check('the burst actually grew the content',
  burstNotes.some(note => note.scrollHeight > (burstNotes[0]?.scrollHeight ?? 0)),
  `H ${burstNotes[0]?.scrollHeight ?? 0} -> ${burstNotes.at(-1)?.scrollHeight ?? 0}`)
const burstSticky = burstNotes.find(note => note.sticky)
check('a burst never re-pins the follow', burstSticky === undefined,
  burstSticky ? `sticky@H=${burstSticky.scrollHeight}` : `frames=${burstNotes.length}`)
const burstRun = burstFrames.filter(frame => (frame.anchor?.applied ?? 0) !== 0)
check('the burst produced anchor corrections', burstRun.length > 0, `${burstRun.length} frames`)
const burstScreen = viewportLines(term)
const burstRowAfter = burstScreen.map(line => bodyKey(line)).indexOf(burstKey)
check('the tracked line holds its row through the burst', burstRow === -1 ? false : burstRowAfter === burstRow,
  `row ${burstRow} -> ${burstRowAfter} (expect ${burstRow})`)

// --- case 3: control — at the bottom the follow still works ----------------
stdin.write('\x1b[1;5F') // Ctrl+End → jump to the bottom
await sleep(700) // 固定窗:pacing — the jump lands before the control baseline
const controlFrame = lastNoteFrame()
check('returning to the bottom re-engages the follow', controlFrame?.scroll.at(-1)?.sticky === true)
const controlTop = controlFrame?.scroll.at(-1)?.scrollTop ?? 0
frameMark = traceFrames().length
for (let step = 1; step <= 3; step++) {
  stream.text += `\nA-HEAD control ${step}`
  bump()
  await sleep(180) // 固定窗:pacing — each control growth paints before the next
}
await sleep(400) // 固定窗:pacing — the control window settles
const controlNotes = traceFrames().slice(frameMark).flatMap(frame => frame.scroll)
check('the follow stays pinned at the bottom', controlNotes.length > 0 && controlNotes.every(note => note.sticky))
check('the follow position advances with the content', (controlNotes.at(-1)?.scrollTop ?? 0) > controlTop,
  `${controlTop} -> ${controlNotes.at(-1)?.scrollTop ?? controlTop}`)

if (failed > 0) {
  dumpFrames(gestureFrames, 'gesture frames')
  dumpFrames(holdFrames, 'still-reader frames')
}
console.log('\nRendered screen:\n' + viewportLines(term).join('\n'))

await instance.unmount()
rmSync(TRACE, { force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
