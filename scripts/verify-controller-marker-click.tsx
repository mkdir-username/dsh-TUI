/**
 * verify-controller-marker-click — клик по строке вердикта контролёра в чате.
 *
 * Строка `⚖ Контролёр №N` несёт `action: { command: 'handoff-rate', input: 'N' }`
 * (см. src/channel/projection.ts). Регрессия монтирует настоящий Chat с такой
 * строкой и шлёт SGR press+release в её ячейку: клик обязан дойти до
 * `channel.runExternalCommandOutcome('handoff-rate', 'N')` — того же пути, что у
 * набранной команды. Без этого маркер остаётся декоративным текстом.
 *
 * 运行：node --import tsx/esm scripts/verify-controller-marker-click.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { completeCommands, LOCAL_COMMANDS }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])

const COLS = 100
const ROWS = 30
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new FakeStdout()
const stderr = new FakeStderr()
const stdin = new FakeStdin()

function screenLines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}
/** SGR клик: press+release в одну клетку (1-indexed). */
function clickCell(col1: number, row1: number): void {
  stdin.write(`\x1b[<0;${col1};${row1}M`)
  stdin.write(`\x1b[<0;${col1};${row1}m`)
}

const calls: Array<{ name: string; input: string }> = []
const listeners = new Set<() => void>()
const markerRow = {
  id: 1,
  kind: 'notice',
  text: '⚖ Контролёр №4: MISSED_ACTION 0.9 · клик — оценить',
  action: { command: 'handoff-rate', input: '4' },
}
const channel: any = {
  whaleIdle: false,
  version: 0,
  rows: [markerRow],
  status: 'idle',
  ready: true,
  agentBindingGeneration: 0,
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
  commandList: [...LOCAL_COMMANDS, { name: 'handoff-rate', description: 'Оценить вердикт контролёра', external: true }],
  notifications: [],
  mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8',
  agentPreset: undefined,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
  pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
  runExternalCommandOutcome: (name: string, rawInput: string) => {
    calls.push({ name, input: rawInput })
    return Promise.resolve({ kind: 'success', text: 'окно оценки для блока №4', consumeDraft: false })
  },
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

const lines = screenLines()
const rowIdx = lines.findIndex(l => l.includes('Контролёр'))
check('маркер контролёра виден в чате', rowIdx >= 0, rowIdx >= 0 ? `строка ${rowIdx}: ${lines[rowIdx]!.trim()}` : '')
if (rowIdx < 0) {
  console.log('=== экран ===')
  for (const [i, l] of lines.entries()) if (l.trim()) console.log(`${String(i).padStart(2)} |${l}`)
  process.exit(1)
}
check('до клика команда не вызывалась', calls.length === 0, JSON.stringify(calls))

// Клик по заголовку строки: та же клетка, что видит человек.
const col1 = lines[rowIdx]!.indexOf('Контролёр') + 1
clickCell(col1, rowIdx + 1)
await sleep(500)

check('клик по строке вызвал handoff-rate 4',
  calls.length === 1 && calls[0]!.name === 'handoff-rate' && calls[0]!.input === '4',
  JSON.stringify(calls))

// Второй клик — повторный вход, а не потерянный: окно оценки открывается снова.
clickCell(col1, rowIdx + 1)
await sleep(500)
check('повторный клик снова вызвал handoff-rate 4',
  calls.length === 2 && calls[1]!.input === '4', JSON.stringify(calls))

await inst.unmount()
console.log(failed === 0 ? 'verify-controller-marker-click: all checks passed' : `verify-controller-marker-click: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
