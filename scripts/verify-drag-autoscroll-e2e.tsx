/**
 * verify-drag-autoscroll-e2e — drag-to-edge auto-scroll through the real Chat
 * tree and real SGR mouse sequences (issue: select-and-copy beyond viewport).
 *
 * Scenario: fullscreen Chat, transcript parked at the sticky bottom. Press on
 * a visible row, drag the pointer onto the first visible row and HOLD — the
 * transcript keeps scrolling up, the selection grows over rows that were
 * outside the viewport at drag start — then release. The OSC 52 payload must
 * contain a mid-history marker that was not on screen before the drag.
 *
 * Run: node --import tsx/esm scripts/verify-drag-autoscroll-e2e.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
// Pure OSC 52 path: skip the wl-copy/xclip probe chain so the assertion only
// depends on stdout frames.
process.env.SSH_CONNECTION = 'headless-e2e'
delete process.env.TMUX

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
])
const { default: instances } = await import('../src/ink/instances.js')
const { stringWidth } = await import('../src/ink/stringWidth.js')

const COLS = 100
const ROWS = 40
const { sleep, settled } = termTest
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const writes: string[] = []
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    writes.push(String(chunk))
    term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) {
    cb()
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const stderr = new FakeStderr()

// Mid-history marker: invisible while the transcript is parked at the sticky
// bottom, so its arrival in the copied payload can only come from the
// auto-scroll. Line 3 of its message, so a one-row scroll cannot reveal it.
const HMARK = 'ZZAUTOSCROLL_MARKER_ABCDE'
// Early marker: far above the initial viewport, so a long hold ends on the
// transcript head where this row is NOT on screen. It can only reach the
// payload through the scrolled-off accumulator — a copy frozen at the final
// viewport never contains it.
const DMARK = 'ZZAUTOSCROLL_EARLY_10'
const T0 = Date.now() - 600_000
const chatRows: any[] = []
for (let i = 0; i < 60; i++) {
  chatRows.push({ id: i * 2, kind: 'user', text: `用户消息 ${i}：帮我看一下这个场景`, time: T0 + i * 8000 })
  const text = i === 30
    ? `历史标记行：${HMARK} 其后是普通内容。`
    : i === 10
      ? `早段标记行：${DMARK} 其后是普通内容。`
      : `助手回复 ${i}：${'分析内容。'.repeat(6)}`
  chatRows.push({ id: i * 2 + 1, kind: 'assistant', text, time: T0 + i * 8000 + 3000 })
}

const listeners = new Set<() => void>()
const notifications: string[] = []
const channel: any = {
  whaleIdle: false,
  version: 0,
  rows: chatRows,
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  reasoningEffort: 'max',
  effortLevels: [],
  tokens: { input: 0, output: 0 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  pending: [],
  commandList: LOCAL_COMMANDS,
  notifications,
  mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8',
  agentPreset: undefined,
  subagents: [],
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: (message: unknown) => {
    notifications.push(String(message))
  },
  listModels: () => Promise.resolve([]),
  listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true),
  renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
  pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}

const tree = (
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>
)
const inst = await render(tree, {
  stdout: stdout as any,
  stdin: stdin as any,
  stderr: stderr as any,
  exitOnCtrlC: false,
  patchConsole: false,
})
// useSelection/useCopyOnSelect resolve the Ink instance by process.stdout; the
// fake stdout needs an alias before the hooks can bind to the real instance.
instances.set(process.stdout, instances.get(stdout)!)
inst.rerender(tree)

// 固定窗:pacing 等首帧——React 树首次渲染与鼠标/选取 hook 挂接无单一可观测条件。
await sleep(900)

function screenLines(): string[] {
  return termTest.viewportLines(term, ROWS)
}
function osc52Payloads(): string[] {
  return [...writes.join('').matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)/g)]
    .map((m) => Buffer.from(m[1]!, 'base64').toString('utf8'))
}

const initial = screenLines()
check('mid-history marker is outside the initial viewport', !initial.some((l) => l.includes(HMARK)))
check('early marker is outside the initial viewport', !initial.some((l) => l.includes(DMARK)))

// Press on a visible row well inside the transcript, drag onto the first
// visible row, hold there past the initial viewport's worth of rows, then
// release. The final screen is the transcript head, so neither marker is
// visible at release: both can only arrive through the scrolled-off
// accumulator. A selection frozen at the final viewport fails this.
const pressRow = 4
stdin.write(`\x1b[<0;4;${pressRow + 1}M`)
// 固定窗:pacing 鼠标 press→motion 步间。
await sleep(80)
stdin.write(`\x1b[<32;4;1M`)
// 固定窗:探针 按住顶边约 5 s：前 600 ms 每 50 ms 一行，之后每 50 ms 三行。
await sleep(5000)
stdin.write(`\x1b[<0;4;1m`)

const reached = await settled(
  () => osc52Payloads().some((p) => p.includes(HMARK) && p.includes(DMARK)),
  { timeoutMs: 5000 },
)
check(
  'long hold copies rows the selection scrolled past the viewport',
  reached,
  `payloads=${JSON.stringify(osc52Payloads().map((p) => p.slice(0, 80)))} notes=${JSON.stringify(notifications)}`,
)
const copied = osc52Payloads().at(-1) ?? ''
check(
  'copied range spans more than one viewport',
  copied.length > 2000,
  `len=${copied.length} start=${JSON.stringify(copied.slice(0, 60))}`,
)
// Reading order + completeness: the selection must run from the final
// viewport's first row down through every row it scrolled past (user
// messages are numbered, so gaps or reversals are visible in the payload).
const messageNumbers = [...copied.matchAll(/用户消息 (\d+)：/g)].map((m) => Number(m[1]))
check(
  'copied rows are in reading order',
  messageNumbers.every((n, i) => i === 0 || n > messageNumbers[i - 1]!),
  `numbers=${JSON.stringify(messageNumbers.slice(0, 8))}…${JSON.stringify(messageNumbers.slice(-4))}`,
)
check(
  'copy covers the whole scrolled range',
  new Set(messageNumbers).size >= 20,
  `distinct=${new Set(messageNumbers).size}`,
)

// The timer must be gone after release: no further scroll-driven frame writes
// that change the transcript's first row.
const topAfterRelease = screenLines()[0]
// 固定窗:探针  после release 250 мс достаточно, чтобы успевший тик изменил строку.
await sleep(250)
check('no scroll ticks after release', screenLines()[0] === topAfterRelease)

await inst.unmount()
if (failed > 0) {
  console.error(`\nverify-drag-autoscroll-e2e: ${failed} failure(s)`)
  process.exit(1)
}
console.log('\nverify-drag-autoscroll-e2e: all checks passed')
