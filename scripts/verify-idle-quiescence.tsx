/**
 * verify-idle-quiescence — простой транскрипта после взаимодействия с rail.
 *
 * Симптом, ради которого гейт заведён: после бурста колеса по боковому rail
 * сессия продолжала крутить кадры и держала ядро на 85–99% уже без событий в
 * журнале сессии. Здесь проверяется обратное: бурст закончился — кадров нет,
 * CPU почти ноль.
 *
 * Run: node --import tsx/esm scripts/verify-idle-quiescence.tsx
 * Env: N (ходов, 750 = 3000 строк), IDLE_MS (окно простоя), BURST (событий колеса).
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { LOCAL_COMMANDS, completeCommands },
  { createChannelReadView },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/adapter/channel/read-view.js'),
])

const COLS = 120, ROWS = 40
const TURNS = Number(process.env.N ?? 750)
const IDLE_MS = Number(process.env.IDLE_MS ?? 1000)
const BURST = Number(process.env.BURST ?? 60)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

const rows: any[] = []
let id = 0
for (let turn = 1; turn <= TURNS; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `第 ${turn} 轮：把模块 ${turn} 的解析器补完并给测试。` })
  rows.push({ id: ++id, kind: 'reasoning', text: `思考 ${turn}：`.padEnd(400, '边界。') })
  rows.push({ id: ++id, kind: 'tool', text: '', tool: { callId: `t${turn}`, name: 'Read', argsText: `{"file_path": "/src/mod${turn}.ts"}`, argsFull: '{}', status: 'ok', startedAt: 0, durationMs: 20, resultText: `line 0: module ${turn} ok` } })
  rows.push({ id: ++id, kind: 'assistant', text: `#### 段 ${turn}\n\n- 要点\n` })
}

const read = createChannelReadView(() => {})
let channelVersion = 0
const listeners = new Set<() => void>()
const raw: any = {
  whaleIdle: true, version: 0, rows, status: 'idle', sessionTitle: 'idle', agentId: 'idle',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: 'Q', scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
const channel = new Proxy(raw, {
  get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver)
    if (typeof value === 'function') return value.bind(target)
    return read(value, channelVersion)
  },
})

let frames = 0
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false, onFrame: () => { frames++ } },
)
await sleep(1500) // 固定窗:pacing первая сборка и замер окна виртуализации

// Бурст колеса по rail (последние две колонки терминала), как у живой сессии.
const railCol = COLS - 2
for (let i = 0; i < BURST; i++) {
  const up = i % 2 === 0
  stdin.emit('data', Buffer.from(`\x1b[<${up ? 64 : 65};${railCol};20M`))
  await sleep(8) // 固定窗:pacing шаг между событиями колеса
}
await sleep(250) // 固定窗:pacing хвост после последнего события колеса

frames = 0
const before = process.cpuUsage()
await sleep(IDLE_MS) // 固定窗:墙钟 окно простоя — сам предмет проверки
const used = process.cpuUsage(before)
const cpuMs = (used.user + used.system) / 1e3
const cpuPercent = (cpuMs / IDLE_MS) * 100
const quiet = frames <= 1 && cpuPercent <= 5
console.log(`rows=${rows.length} burst=${BURST} idleMs=${IDLE_MS}`)
console.log(`idleFrames=${frames} cpu=${cpuPercent.toFixed(1)}% → ${quiet ? 'PASS' : 'FAIL'}`)
await inst.unmount()
process.exit(quiet ? 0 : 1)
