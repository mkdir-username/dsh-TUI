/**
 * perf-commit-cost — цена ОДНОГО коммита Chat на живой форме сессии.
 *
 * Зачем: живой фриз (сессия 6a020c9b) держал 85–99% ядра при нуле событий, а
 * профиль горячего окна показывал полный ре-рендер: MessageList, Chat, yoga
 * layoutNode и `copy` из `channel/read-view.js`. Синтетический канал без
 * проекции эту цену не воспроизводит, поэтому здесь канал обёрнут так же, как
 * `ChannelUi`: каждое чтение свойства идёт через createChannelReadView, а
 * версия/грязные строки бампаются как при стриминге.
 *
 * Run: N=3000 node --import tsx/esm scripts/probe-commit-cost.tsx
 * Env: N (turn count), FRAME_MS (animation tick), WINDOW_MS, HOVER=1 (rail hover)
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
const TURNS = Number(process.env.N ?? 300)
const FRAME_MS = Number(process.env.FRAME_MS ?? 16)
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 2000)
const HOVER = process.env.HOVER === '1'
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
const EDIT_BODY = Array.from({ length: 2000 }, (_, i) => `+  const line${i} = "патч ${i}";`).join('\n')
const rows: any[] = []
let id = 0
for (let turn = 1; turn <= TURNS; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `第 ${turn} 轮：把模块 ${turn} 的解析器补完并给测试。` })
  rows.push({ id: ++id, kind: 'reasoning', text: `思考 ${turn}：`.padEnd(900, '先看结构再看边界；空输入、深层嵌套、循环引用。') })
  rows.push({
    id: ++id, kind: 'tool', text: '',
    tool: {
      callId: `t${turn}`, name: turn % 25 === 0 ? 'Edit' : 'Read',
      argsText: turn % 25 === 0
        ? `{"file_path": "/src/mod${turn}.ts", "new_string": "- Main clone …"}`
        : `{"file_path": "/src/mod${turn}.ts"}`,
      argsFull: '{}', status: turn === TURNS ? 'running' : 'ok', startedAt: 0, durationMs: 20,
      resultText: turn % 25 === 0
        ? EDIT_BODY
        : Array.from({ length: 12 }, (_, i) => `line ${i}: module ${turn} ok`).join('\n'),
    },
  })
  rows.push({ id: ++id, kind: 'assistant', text: md(turn) })
}

// Канал как живой ChannelUi: чтение каждого свойства проходит через
// createChannelReadView, версия бампается на стриминговом кадре.
const read = createChannelReadView(() => {})
let channelVersion = 0
const listeners = new Set<() => void>()
const raw: any = {
  whaleIdle: false,
  version: 0,
  rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
  tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main',
  working: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0,
  pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false, sandbox: undefined },
  activityFrames: 'moon8', agentPreset: undefined,
  subagents: [{ id: 'restruct-plan', name: 'restruct-plan', status: 'running', startedAt: Date.now() - 18 * 60_000, tokens: 1345, tools: 32 }],
  lastUserText: `问题 ${TURNS}`,
  scrollGutter: 'timeline',
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => Promise.resolve([]),
  deleteSession: () => Promise.resolve(true), renameSessionTo: () => Promise.resolve(true),
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [], pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
}
// NOPROJ=1 — контроль: тот же прогон без проекции чтения (сколько стоит
// именно read-view, а не сам ре-рендер).
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
const frameMs: number[] = []
const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
  </AlternateScreen>,
  {
    stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: (f: any) => { frameCount++; frameMs.push(f.durationMs ?? 0) },
  },
)
await sleep(1500)

// Стриминговый кадр: версия + грязная последняя строка + notify подписчиков.
const lastRow = rows[rows.length - 1]!
// MODE=stream — стриминговый кадр (версия + грязная строка), как дельта от
// бэкенда; MODE=anim — кадр анимации (локальный setState подписчика), версия
// канала не меняется: проекция обязана переиспользовать снапшот.
const MODE = process.env.MODE ?? 'stream'
const bump = () => {
  if (MODE === 'stream') {
    channelVersion += 1
    raw.version = channelVersion
    markChannelReadDirty(lastRow)
    markChannelReadDirty(rows)
  }
  for (const cb of listeners) cb()
}

const before = process.cpuUsage()
const startedAt = performance.now()
frameCount = 0
frameMs.length = 0
if (HOVER) {
  // rail hover: 2 колонки у правого края.
  for (let i = 0; i < 40; i++) {
    stdin.write(`\x1b[<35;120;${6 + (i % 24)}M`)
    await sleep(FRAME_MS)
  }
} else {
  while (performance.now() - startedAt < WINDOW_MS) {
    bump()
    await sleep(FRAME_MS)
  }
}
await sleep(300)
const used = process.cpuUsage(before)
const wall = (performance.now() - startedAt) / 1000
const cpu = (used.user + used.system) / 1e6
const sorted = [...frameMs].sort((a, b) => a - b)
const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
console.log(`rows=${rows.length} turns=${TURNS} mode=${HOVER ? 'hover' : MODE} window=${wall.toFixed(1)}s frames=${frameCount}`)
console.log(`cpu=${(cpu / wall * 100).toFixed(0)}% of a core  frame p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms max=${(sorted.at(-1) ?? 0).toFixed(1)}ms`)
console.log(`cpu per frame=${(cpu / Math.max(1, frameCount) * 1000).toFixed(1)}ms  heap=${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB`)
await inst.unmount()
process.exit(0)
