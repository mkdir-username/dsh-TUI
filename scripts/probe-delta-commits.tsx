/**
 * probe-delta-commits — сколько коммитов React делает одна дельта канала.
 *
 * Дельта = версия канала выросла и одна строка помечена грязной (стриминг).
 * Пока зависимость эффекта держалась на идентичности `channel.rows`, проекция
 * давала новый массив на каждую дельту, эффект перезапускался и второй раз
 * звал setState: `MessageList` рендерился 2.05 раза на дельту (счёт —
 * инструментовкой компонента в спайке Task 1), кадр стоил вдвое дороже.
 * Ключ по id последней строки вернул один рендер. Эта проба меряет то, что
 * видно снаружи: цену кадра и число кадров на дельту.
 *
 * Run: node --import tsx/esm scripts/probe-delta-commits.tsx
 * Env: N (ходов, 750 = 3000 строк), WINDOW_MS, FRAME_MS, NOPROJ=1 — контроль.
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
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 2000)
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
  rows.push({ id: ++id, kind: 'tool', text: '', tool: { callId: `t${turn}`, name: 'Read', argsText: '{}', argsFull: '{}', status: 'ok', startedAt: 0, durationMs: 20, resultText: 'ok' } })
  rows.push({ id: ++id, kind: 'assistant', text: `#### 段 ${turn}\n\n- 要点\n` })
}
const streamRow: any = { id: ++id, kind: 'assistant', text: '流 START', streaming: true }
rows.push(streamRow)

const read = createChannelReadView(() => {})
let channelVersion = 0
const listeners = new Set<() => void>()
const raw: any = {
  whaleIdle: true, version: 0, rows, status: 'idle', sessionTitle: 'probe', agentId: 'probe',
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
const channel = process.env.NOPROJ === '1'
  ? raw
  : new Proxy(raw, {
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

frames = 0
let deltas = 0
const before = process.cpuUsage()
const startedAt = performance.now()
while (performance.now() - startedAt < WINDOW_MS) {
  streamRow.text = `流 START ${'x'.repeat(deltas % 40)}`
  markChannelReadDirty(streamRow)
  markChannelReadDirty(rows)
  channelVersion += 1
  raw.version = channelVersion
  for (const cb of listeners) cb()
  deltas += 1
  await sleep(FRAME_MS) // 固定窗:墙钟 каденция драйвера — предмет замера
}
await sleep(200) // 固定窗:墙钟 хвост после последней дельты
const used = process.cpuUsage(before)
const cpuMs = (used.user + used.system) / 1e3
console.log(`rows=${rows.length} deltas=${deltas} frames=${frames} projection=${process.env.NOPROJ === '1' ? 'off' : 'on'}`)
console.log(`frames/delta=${(frames / Math.max(1, deltas)).toFixed(2)} cpu/frame=${(cpuMs / Math.max(1, frames)).toFixed(1)}ms`)
await inst.unmount()
process.exit(0)
