/**
 * A wheel-up must detach the follow even when there is nothing to scroll yet.
 *
 * The reported shape: the reader wheels up to hold the answer they are reading,
 * and every line the agent appends moves their viewport down by one row. The
 * detach is lost because the view is measured, not remembered: while the
 * transcript still FITS the viewport `maxScroll` is 0, so the wheel cannot move
 * the view, the positional at-bottom check reads `scrollTop >= prevMaxScroll`
 * as true, and the next growth frame re-pins `stickyScroll`. From then on the
 * follow advances with the content and the reader cannot leave.
 *
 * Asserted invariants:
 *   - the follow stays broken from the wheel until the reader returns to the
 *     bottom on purpose (End): no frame in between is sticky;
 *   - the row the reader anchored on keeps its terminal row while the answer
 *     overflows the viewport;
 *   - the paint never uses a negative scrollTop (the wheel debt of a view that
 *     cannot scroll must not leak into the frame).
 *
 * Run: node --import tsx/esm scripts/verify-scroll-detach-when-fitting.tsx
 * Imports src/; no compiled lib/ required. DSH_TEST_COLUMNS=70 tests narrow.
 */
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import type { Channel, ChatRow } from '../src/dsh-adapter/channel.js'
import type { ScrollGeometryNote } from '../src/ink/geometry-trace.js'

const TRACE = join(tmpdir(), `dsh-scroll-detach-${process.pid}.jsonl`)
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

// A short conversation: three answer lines per turn, all of it inside a
// 40-row viewport — the state the reader was in when the wheel was lost.
const rows: ChatRow[] = [
  { id: 1, kind: 'user', text: 'Explain the plan' },
  { id: 2, kind: 'assistant', text: 'Plan line 1 of the answer\nPlan line 2 of the answer\nPlan line 3 of the answer' },
]

const listeners = new Set<() => void>()
const channel = {
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
  smoothStreaming: true,
  thinkingFold: 'full',
  pending: [],
  commandList: [],
  notifications: [],
  subagents: [],
  lastUserText: 'Explain the plan',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

type GeometryFrame = { frame: number; cause: string; scroll: ScrollGeometryNote[] }
function traceFrames(): GeometryFrame[] {
  try {
    return readFileSync(TRACE, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as GeometryFrame)
  } catch { return [] }
}
function frameNotes(from: number): ScrollGeometryNote[] {
  return traceFrames().slice(from).flatMap(frame => frame.scroll)
}
function bodyKey(line: string): string { return line.trimStart().slice(0, 40) }
function trackedRow(screen: readonly string[], key: string): number {
  return screen.map(line => bodyKey(line)).indexOf(key)
}

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const instance = await render(
  <AlternateScreen>
    <Chat channel={channel as unknown as Channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: new FakeStderr() as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
)
await sleep(1200) // 固定窗:pacing — the short transcript settles into its first layout

const startNotes = frameNotes(0)
check('the short transcript fits the viewport', (startNotes.at(-1)?.maxScroll ?? -1) === 0,
  `maxScroll=${startNotes.at(-1)?.maxScroll} H=${startNotes.at(-1)?.scrollHeight}`)

// The live turn is already open when the reader leaves: the turn header (the
// prompt row and the working line) is a layout change ABOVE the transcript, and
// letting it land first keeps the measured window free of a legitimate shift.
channel.rows.push({ id: 3, kind: 'user', text: 'Go on' })
const live: ChatRow = { id: 4, kind: 'assistant', text: 'Live answer line 1', streaming: true }
channel.rows.push(live)
bump()
await sleep(400) // 固定窗:pacing — the turn header lands before the measured window

// The reader scrolls up to hold the answer. Nothing can move: the content is
// shorter than the viewport, so this gesture only carries intent.
const beforeScreen = viewportLines(term)
const anchorKey = bodyKey(beforeScreen.find(line => line.includes('Plan line')) ?? '')
check('the answer body is on screen', anchorKey.length > 0, anchorKey)
stdin.write('\x1b[<64;50;10M') // wheel up
await sleep(400) // 固定窗:pacing — the notch settles before the live turn starts
const wheelFrame = traceFrames().length
const wheelNote = frameNotes(0).at(-1)
check('the wheel broke the follow', wheelNote?.sticky === false, `sticky=${wheelNote?.sticky}`)

// The live turn then writes past the viewport: the answer grows from a few
// lines to forty, so the transcript starts to scroll under a reader who has
// already said "not now".
// The first appended line settles the streaming row's own frame (its bullet and
// first body line), a one-time layout change above the transcript. Everything
// after it is the case under test: the reader's line must not move again.
live.text += '\nLive answer line 2'
bump()
await sleep(150) // 固定窗:pacing — the streaming row's frame settles before the baseline
const baselineScreen = viewportLines(term)
const baselineRow = trackedRow(baselineScreen, anchorKey)
const violations: string[] = []
for (let step = 3; step <= 40; step++) {
  live.text += `\nLive answer line ${step}`
  bump()
  await sleep(10) // 固定窗:pacing — token cadence: appends land faster than the layout pass
  const row = trackedRow(viewportLines(term), anchorKey)
  if (row !== baselineRow) violations.push(`${step}:${row}`)
}
await sleep(500) // 固定窗:pacing — the turn settles before the final read

const liveNotes = frameNotes(wheelFrame)
check('the live answer now overflows the viewport', (liveNotes.at(-1)?.maxScroll ?? 0) > 0,
  `maxScroll=${liveNotes.at(-1)?.maxScroll} H=${liveNotes.at(-1)?.scrollHeight}`)
const repinned = liveNotes.find(note => note.sticky)
check('the follow stays broken while the answer overflows', repinned === undefined,
  repinned ? `sticky@H=${repinned.scrollHeight}` : `frames=${liveNotes.length}`)
const negative = liveNotes.find(note => note.renderScrollTop < 0 || note.scrollTop < 0)
check('the paint never uses a negative position', negative === undefined,
  negative ? `top=${negative.scrollTop} render=${negative.renderScrollTop}` : '')
check('the reader keeps their line while the answer grows', violations.length === 0,
  violations.length > 0 ? `moved at ${violations.slice(0, 4).join(', ')} (baseline row ${baselineRow})` : `row ${baselineRow}, 38 appends`)

// Returning on purpose is what re-engages the follow — not content growth.
stdin.write('\x1b[1;5F') // Ctrl+End
await sleep(700) // 固定窗:pacing — the jump lands before the read
const backNotes = frameNotes(wheelFrame)
check('End re-engages the follow', backNotes.at(-1)?.sticky === true, `sticky=${backNotes.at(-1)?.sticky}`)

if (failed > 0) {
  console.log('    --- frames after the wheel')
  for (const frame of traceFrames().slice(wheelFrame)) {
    for (const note of frame.scroll) {
      console.log(`    f${frame.frame} ${frame.cause} top=${note.scrollTop} render=${note.renderScrollTop} ` +
        `H=${note.scrollHeight} max=${note.maxScroll} sticky=${note.sticky ? 1 : 0} atBottom=${note.atBottom ? 1 : 0}`)
    }
  }
}
console.log('\nRendered screen:\n' + viewportLines(term).join('\n'))

await instance.unmount()
rmSync(TRACE, { force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
