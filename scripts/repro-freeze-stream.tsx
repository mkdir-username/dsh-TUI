/**
 * repro-freeze-stream — воспроизведение фриза dsh-tui без пользователя и без
 * живого окна: транскрипт масштаба большой сессии + анимационный драйвер на
 * каждом кадре (16 мс, как спиннер/таймер хода) + канал с проекцией чтения,
 * как у настоящего ChannelUi.
 *
 * Порог фриза: кадр дороже 8 мс при 16 мс каденции — это ≥50% ядра только на
 * перерисовку, и любая вторая нагрузка (rail-ховер, стриминг дельты) добивает
 * до 100%, после чего ввод встаёт в очередь и TUI «зависает».
 *
 * Run: node --import tsx/esm scripts/repro-freeze-stream.tsx
 * Env: N (число ходов, по умолчанию 750 = 3000 строк), NOPROJ=1 — без проекции.
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
  { createChannelReadView, markChannelReadDirty },
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
const FRAME_MS = Number(process.env.FRAME_MS ?? 16)
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 2500)
const FREEZE_MS = Number(process.env.FREEZE_MS ?? 8)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

const md = (n: number) => `#### 段 ${n}\n\n- 要点一：解析输入并构建 AST\n- 要点二：遍历节点做常量折叠\n\n\`\`\`ts\nexport function fold${n}(n: Node) { return n }\n\`\`\``
const rows: any[] = []
let id = 0
for (let turn = 1; turn <= TURNS; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `第 ${turn} 轮：把模块 ${turn} 的解析器补完并给测试。` })
  rows.push({ id: ++id, kind: 'reasoning', text: `思考 ${turn}：`.padEnd(900, '先看结构再看边界；空输入、深层嵌套、循环引用。') })
  rows.push({
    id: ++id, kind: 'tool', text: '',
    tool: {
      callId: `t${turn}`, name: 'Read',
      argsText: `{"file_path": "/src/mod${turn}.ts"}`, argsFull: '{}',
      status: 'ok', startedAt: 0, durationMs: 20,
      resultText: Array.from({ length: 12 }, (_, i) => `line ${i}: module ${turn} ok`).join('\n'),
    },
  })
  rows.push({ id: ++id, kind: 'assistant', text: md(turn) })
}

const read = createChannelReadView(() => {})
let channelVersion = 0
const listeners = new Set<() => void>()
const raw: any = {
  whaleIdle: false, version: 0, rows, status: 'idle', sessionTitle: 'repro', agentId: 'repro',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8', agentPreset: undefined, subagents: [], lastUserText: `问题 ${TURNS}`,
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
const channel = process.env.NOPROJ === '1'
  ? raw
  : new Proxy(raw, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value === 'function') return value.bind(target)
      return read(value, channelVersion)
    },
  })

let frameCount = 0
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  {
    stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: () => { frameCount++ },
  },
)
await sleep(1500)

// PROFILE=1 — снять CPU-профиль ТОЛЬКО окна измерения (без шума загрузки tsx).
let inspectorSession: any = null
const profilePath = process.env.PROFILE_PATH ?? '/tmp/repro-freeze.cpuprofile'
if (process.env.PROFILE === '1') {
  const { Session } = await import('node:inspector/promises')
  inspectorSession = new Session()
  inspectorSession.connect()
  await inspectorSession.post('Profiler.enable')
  await inspectorSession.post('Profiler.setSamplingInterval', { interval: 500 })
  await inspectorSession.post('Profiler.start')
}

const lastRow = rows[rows.length - 1]!
const before = process.cpuUsage()
const startedAt = performance.now()
frameCount = 0
while (performance.now() - startedAt < WINDOW_MS) {
  channelVersion += 1
  raw.version = channelVersion
  markChannelReadDirty(lastRow)
  markChannelReadDirty(rows)
  for (const cb of listeners) cb()
  await sleep(FRAME_MS)
}
await sleep(200)
if (inspectorSession !== null) {
  const { profile } = await inspectorSession.post('Profiler.stop')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(profilePath, JSON.stringify(profile))
  inspectorSession.disconnect()
  console.log(`profile=${profilePath}`)
}
const used = process.cpuUsage(before)
const wall = (performance.now() - startedAt) / 1000
const cpuMs = (used.user + used.system) / 1e3
const perFrame = cpuMs / Math.max(1, frameCount)
const frozen = perFrame > FREEZE_MS
console.log(`rows=${rows.length} turns=${TURNS} projection=${process.env.NOPROJ === '1' ? 'off' : 'on'}`)
console.log(`frames=${frameCount} wall=${wall.toFixed(1)}s cpu=${cpuMs.toFixed(0)}ms → ${(cpuMs / (wall * 1000) * 100).toFixed(0)}% of a core`)
console.log(`cpu/frame=${perFrame.toFixed(1)}ms budget=${FRAME_MS}ms threshold=${FREEZE_MS}ms → ${frozen ? 'FREEZE REPRODUCED' : 'no freeze at this size'}`)
await inst.unmount()
process.exit(frozen ? 0 : 1)
