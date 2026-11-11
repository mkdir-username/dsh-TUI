/**
 * verify-transcript-delta-cost — цена кадра дельты на масштабе большой сессии.
 *
 * Дельта = изменилось содержимое одной строки, массив строк получил новую
 * идентичность (так работает проекция чтения канала). Дорогая дельта — это
 * фриз: кадр не влезает в 16 мс драйвера, очередь ввода не успевает.
 *
 * Кейсы 1–3 проверяют, что быстрый путь не ломает видимое окно; группировка
 * job-строк и превью rail — в scripts/verify-jobs-transcript-group.tsx и
 * scripts/verify-timeline-rail.tsx.
 *
 * Run: node --import tsx/esm scripts/verify-transcript-delta-cost.tsx
 * Env: N (ходов, 750 = 3000 строк), WINDOW_MS (окно замера), BUDGET_MS, FRAME_MS,
 *      NOPROJ=1 — контроль без проекции чтения канала (пол 7.7 мс).
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
  { settled },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/adapter/channel/read-view.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 120, ROWS = 40
const TURNS = Number(process.env.N ?? 750)
const FRAME_MS = Number(process.env.FRAME_MS ?? 16)
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 2000)
// 12 ms = измеренный пол верного пути (11.6: рост текста требует ре-рендера
// строки и пере-замера высоты) плюс запас. До фикса зависимостей эффекта было
// 18.0 — гейт стережёт именно этот класс регресса.
const BUDGET = Number(process.env.BUDGET_MS ?? 12)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

const md = (n: number) => `#### 段 ${n}\n\n- 要点一：解析输入并构建 AST\n\n\`\`\`ts\nexport function fold${n}(n: Node) { return n }\n\`\`\``
const rows: any[] = []
let id = 0
for (let turn = 1; turn <= TURNS; turn++) {
  rows.push({ id: ++id, kind: 'user', text: `第 ${turn} 轮：把模块 ${turn} 的解析器补完并给测试。` })
  rows.push({ id: ++id, kind: 'reasoning', text: `思考 ${turn}：`.padEnd(200, '边界。') })
  rows.push({ id: ++id, kind: 'tool', text: '', tool: { callId: `t${turn}`, name: 'Read', argsText: `{"file_path": "/src/mod${turn}.ts"}`, argsFull: '{}', status: 'ok', startedAt: 0, durationMs: 20, resultText: `line 0: module ${turn} ok` } })
  rows.push({ id: ++id, kind: 'assistant', text: md(turn) })
}
// хвост транскрипта — он и виден: две строки под кейсы, последняя — поток
const case2Row = { id: ++id, kind: 'assistant', text: '«CASE2-OLD-TEXT»', streaming: false }
const streamRow: any = { id: ++id, kind: 'assistant', text: '流 CASE1-START', streaming: true }
rows.push(case2Row, streamRow)
const case3Row = { id: ++id, kind: 'user', text: '«CASE3-KIND»' }

const read = createChannelReadView(() => {})
let channelVersion = 0
const listeners = new Set<() => void>()
const raw: any = {
  whaleIdle: false, version: 0, rows, status: 'idle', sessionTitle: 'delta', agentId: 'delta',
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
const channel = process.env.NOPROJ === '1' ? raw : new Proxy(raw, {
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

const screen = (): string => {
  const out: string[] = []
  for (let i = 0; i < ROWS; i++) out.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '')
  return out.join('\n')
}
const failures: string[] = []
const check = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}`)
  if (!ok) failures.push(name)
}
const delta = async (mutate: () => void): Promise<void> => {
  mutate()
  markChannelReadDirty(rows)
  channelVersion += 1
  raw.version = channelVersion
  for (const cb of listeners) cb()
  await sleep(FRAME_MS * 2) // 固定窗:pacing дельта ставится в очередь кадра драйвера
}

// кейс 1: рост текста стримящейся строки виден в том же кадре
streamRow.text = '流 CASE1-START CASE1-GROWTH'
await delta(() => { markChannelReadDirty(streamRow) })
check('case1: рост текста стримящейся строки доехал до экрана', await settled(() => screen().includes('CASE1-GROWTH')))

// кейс 2: осевшая пустая assistant-строка исчезает из окна
case2Row.text = ''
case2Row.streaming = false
await delta(() => { markChannelReadDirty(case2Row) })
check('case2: осевшая пустая assistant-строка убрана из окна', await settled(() => !screen().includes('CASE2-OLD-TEXT')))

// кейс 3: строка на том же индексе заменена другим видом — окно показывает новую
rows[rows.length - 1] = case3Row
await delta(() => { markChannelReadDirty(case3Row) })
check('case3: замена строки другим kind/id видна в окне', await settled(() => screen().includes('CASE3-KIND')))

// бюджет кадра дельты: стриминг assistant-строки, 16 мс-драйвер, окно замера
const budgetRow: any = { id: ++id, kind: 'assistant', text: '流 BUDGET-START', streaming: true }
rows.push(budgetRow)
await delta(() => { markChannelReadDirty(budgetRow) })
const before = process.cpuUsage()
const startedAt = performance.now()
frames = 0
let appended = ''
while (performance.now() - startedAt < WINDOW_MS) {
  appended += 'x'
  budgetRow.text = `流 BUDGET-START ${appended}`
  markChannelReadDirty(budgetRow)
  markChannelReadDirty(rows)
  channelVersion += 1
  raw.version = channelVersion
  for (const cb of listeners) cb()
  await sleep(FRAME_MS) // 固定窗:墙钟 каденция драйвера — предмет замера
}
await sleep(200) // 固定窗:墙钟 профиль закрывается после последнего кадра
const used = process.cpuUsage(before)
const cpuMs = (used.user + used.system) / 1e3
const perFrame = cpuMs / Math.max(1, frames)
const withinBudget = perFrame <= BUDGET
console.log(`rows=${rows.length} frames=${frames} cpu=${cpuMs.toFixed(0)}ms`)
console.log(`cpu/frame=${perFrame.toFixed(1)}ms budget=${BUDGET}ms → ${withinBudget ? 'PASS' : 'FAIL'}`)
await inst.unmount()
process.exit(failures.length === 0 && withinBudget ? 0 : 1)
