/**
 * `/hs` (handoff-skip) regression: the chat-scoped skip the Stop hooks read.
 *
 * Part 1 — the file contract (`src/handoffSkip.ts`): off by default, `once`
 *   with a two-hour expiry, `on` without one, the `session-` prefix naming the
 *   same file, other chats invisible, unsafe ids refused, `clear` dropping it.
 * Part 2 — the real Chat: `/hs` arms one step and submits nothing (mid-turn
 *   included), the turn it covered ends the token, `--on`/`--off` persist and
 *   clear, an unknown flag keeps the draft.
 * Part 3 — the footer chip: `⏸ hs` for `on`, `⏸ hs¹` for the one-shot, gone
 *   after `--off`.
 *
 * Run: node --import tsx/esm scripts/verify-handoff-skip.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module reads `homedir()` at import time, so the fake home must own the
// environment before any src import: the real ~/.claude/.state must never see
// this run.
const fakeHome = mkdtempSync(join(tmpdir(), 'verify-handoff-skip-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const { readHandoffSkip, writeHandoffSkip, clearHandoffSkip, handoffSkipPath, HANDOFF_SKIP_DIR } = await import('../src/handoffSkip.js')

let passed = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== '' ? `\n      ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const SID = '55555555-5555-4555-8555-555555555555'
const HOUR = 60 * 60 * 1000

// ── 1. the file contract ────────────────────────────────────────────────
check('1 no file is off', readHandoffSkip(SID) === 'off')
check('1 once survives a write', writeHandoffSkip(SID, 'once') && readHandoffSkip(SID) === 'once')
check('1 on survives a write and never expires', writeHandoffSkip(SID, 'on') && readHandoffSkip(SID, Date.now() + 240 * HOUR) === 'on')
check(
  '1 once expires after two hours',
  writeHandoffSkip(SID, 'once')
    && readHandoffSkip(SID, Date.now() + HOUR) === 'once'
    && readHandoffSkip(SID, Date.now() + 2 * HOUR + 1000) === 'off',
)
check('1 the session- prefix names the same file', writeHandoffSkip(SID, 'on') && readHandoffSkip(`session-${SID}`) === 'on')
check('1 another chat sees nothing', readHandoffSkip('99999999-9999-4999-8999-999999999999') === 'off')
check('1 an unsafe id is refused', handoffSkipPath('../etc/passwd') === undefined && writeHandoffSkip('../etc/passwd', 'on') === false)
clearHandoffSkip(SID)
check('1 clear drops the file', readHandoffSkip(SID) === 'off')
check('1 the state lives under the isolated home', HANDOFF_SKIP_DIR === join(fakeHome, '.claude', '.state', 'hs-mode'))

// ── 2. the command over a real Chat ─────────────────────────────────────
const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  ui,
  { Chat },
  { QuestionStore },
  { ApprovalStore },
  { createChannel },
  { t },
  { default: instances },
  { settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
])
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentInput, AgentSession, SubmitPlacement } from '../src/agent/session.js'

interface Harness {
  readonly channel: ReturnType<typeof createChannel>
  readonly submits: { input: AgentInput; placement: SubmitPlacement }[]
  emit(events: readonly AgentEvent[]): void
  screen(): string
  typeLine(text: string): Promise<void>
  enter(): Promise<void>
  unmount(): Promise<void>
}

async function mountChat(backendId = 'dsh'): Promise<Harness> {
  const submits: { input: AgentInput; placement: SubmitPlacement }[] = []
  const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  const session: AgentSession = {
    ref: { backendId, sessionId: SID },
    cwd: process.cwd(),
    status: 'idle',
    capabilities: { native: {} },
    history: () => Promise.resolve([]),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    submit(input, placement) { submits.push({ input, placement }); return Promise.resolve({ accepted: true }) },
    cancel: () => Promise.resolve({ stillQueued: [] }),
    dispose: () => Promise.resolve(),
  }
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, session, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })
  const COLS = 100
  const ROWS = 34
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const instance = await ui.render(
    React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  const screen = (): string => viewportLines(term, ROWS).join('\n')
  // 固定窗:pacing the key handlers attach after the first frame.
  await sleep(300)
  return {
    channel,
    submits,
    emit: events => { for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync' }) },
    screen,
    typeLine: async text => {
      for (const char of text) stdin.write(char)
      // 固定窗:pacing the prompt applies typed characters on its own render tick.
      await sleep(80)
    },
    enter: async () => {
      stdin.write('\r')
      // 固定窗:pacing Enter dispatches on the next render tick.
      await sleep(120)
    },
    unmount: async () => { instance.unmount(); await sleep(50) }, // 固定窗:pacing unmount settles before the next harness mounts
  }
}

const h = await mountChat()
const toasts = (): string => h.channel.notifications.map(item => item.text).join(' | ')

await h.typeLine('/hs')
await h.enter()
check(
  '2 /hs arms one step and submits nothing',
  await settled(() => toasts().includes(t('hs-armed'))) && h.submits.length === 0 && readHandoffSkip(SID) === 'once',
  `${toasts()} / submits=${h.submits.length} / mode=${readHandoffSkip(SID)}`,
)

h.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: Date.now() }])
await h.typeLine('/hs')
await h.enter()
check(
  '2 mid-turn /hs runs as a command and never steers',
  h.submits.length === 0 && readHandoffSkip(SID) === 'once',
  `submits=${h.submits.length} / mode=${readHandoffSkip(SID)}`,
)
h.emit([{ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: Date.now() }])
check('2 the turn it covered ends the one-shot', await settled(() => readHandoffSkip(SID) === 'off'), `mode=${readHandoffSkip(SID)}`)

await h.typeLine('/hs --on')
await h.enter()
check('2 --on persists across a turn boundary', await settled(() => readHandoffSkip(SID) === 'on') && h.submits.length === 0, `mode=${readHandoffSkip(SID)}`)
h.emit([{ type: 'turn.start', turn: 2, origin: 'user', time: Date.now() }])
h.emit([{ type: 'turn.end', turn: 2, reason: { kind: 'completed' }, time: Date.now() }])
check('2 … and survives the next turn', await settled(() => readHandoffSkip(SID) === 'on'), `mode=${readHandoffSkip(SID)}`)

await h.typeLine('/hs --off')
await h.enter()
check('2 --off clears it', await settled(() => readHandoffSkip(SID) === 'off') && toasts().includes(t('hs-off')), `${toasts()} / mode=${readHandoffSkip(SID)}`)

await h.typeLine('/hs --bogus')
await h.enter()
check(
  '2 an unknown flag keeps the draft and writes nothing',
  await settled(() => toasts().includes(t('hs-usage'))) && h.screen().includes('/hs --bogus') && readHandoffSkip(SID) === 'off',
  `${toasts()} / mode=${readHandoffSkip(SID)}`,
)
check('2 nothing ever reached the model', h.submits.length === 0, `submits=${h.submits.length}`)

await h.unmount()

// Another kernel has no DSH hook bridge: the command answers with the reason
// and never writes a file nothing would read.
const other = await mountChat('claude')
await other.typeLine('/hs --on')
await other.enter()
const otherToasts = other.channel.notifications.map(item => item.text).join(' | ')
check(
  '2 a non-DSH kernel is refused with the reason, nothing written',
  await settled(() => otherToasts.includes(t('hs-dsh-only'))) && readHandoffSkip(SID) === 'off' && other.submits.length === 0,
  `${otherToasts} / mode=${readHandoffSkip(SID)} / submits=${other.submits.length}`,
)
await other.unmount()

console.log(`\nverify-handoff-skip ${failures === 0 ? 'OK' : 'FAILED'} (${passed} passed, ${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
