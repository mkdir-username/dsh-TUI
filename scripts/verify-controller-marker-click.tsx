/**
 * verify-controller-marker-click — клик по строке вердикта контролёра в чате.
 *
 * Строка `⚖ Контролёр №N` несёт `action: { command: 'handoff-rate', input: 'N' }`
 * (см. src/channel/projection.ts). Регрессия монтирует настоящий Chat с такой
 * строкой и шлёт SGR press+release в её ячейку. Реальный реестр DSH должен
 * выполнить `handoff-rate` с номером из строки при каждом клике.
 *
 * 运行：node --import tsx/esm scripts/verify-controller-marker-click.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { completeCommands, LOCAL_COMMANDS }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
])
const [{ Context }, { CommandRuntime }, { Session, SessionId }, { createExternalCommandInvoker }, { createComposerImages }, { createChannelOwner }] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-commands'),
  import('@deepseek-ai/dsh-session'),
  import('../src/dsh-adapter/channel/external-commands.js'),
  import('../src/dsh-adapter/channel/composer-images.js'),
  import('../src/dsh-adapter/channel/owner.js'),
])

const COLS = 68
const ROWS = 44
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

const calls: string[] = []
const notifications: string[] = []
const ctx = new Context()
const commands = new CommandRuntime(ctx)
const session = Session.create(SessionId('controller-marker-click'))
const agent = { id: session.id, session, ctx }
const owner = createChannelOwner()
const unregister = commands.register({
  name: 'handoff-rate',
  description: 'Rate the controller verdict',
  handler({ rawInput }) {
    calls.push(rawInput.trim())
    return { kind: 'success' }
  },
})
const { invoke } = createExternalCommandInvoker(ctx, {
  commandService: commands,
  runtime: { mode: 'legacy', slices: [] },
  agent: () => agent as never,
  capture: () => 0,
  bindingCurrent: () => true,
  allows: () => true,
  composer: createComposerImages(ctx, owner, { generation: () => 0 }),
  attachments: () => undefined,
  notify: text => notifications.push(text),
})
const listeners = new Set<() => void>()
const markerRow = {
  id: 1,
  kind: 'notice',
  text: 'Почему: [точная причина](literal) ' + 'проверка '.repeat(8) + 'перенос\n\n'
    + 'Действие: продолжить\nДлинная строка ' + 'x'.repeat(1020) + ' Длинный хвост\n'
    + 'Последняя строка',
  controllerTitle: '⚖ Контролёр №4: MISSED_ACTION 0.9 · клик — оценить',
  action: { command: 'handoff-rate', input: '4 @0' },
  seq: 0,
}
const channel: any = {
  whaleIdle: false,
  version: 0,
  rows: [
    { id: 0, kind: 'assistant', text: 'Ответ до контролёра' },
    markerRow,
    { id: 2, kind: 'assistant', text: 'Ответ после контролёра' },
  ],
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
  notify: (text: string) => notifications.push(text),
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
  pushLocal: () => {},
  commandCompletions: (input: string) => completeCommands(input),
  runExternalCommandOutcome: invoke,
}

const inst = await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

const lines = screenLines()
const rowIdx = lines.findIndex(l => l.includes('⚖ Контролёр'))
check('маркер контролёра виден в чате', rowIdx >= 0, rowIdx >= 0 ? `строка ${rowIdx}: ${lines[rowIdx]!.trim()}` : '')
if (rowIdx < 0) {
  console.log('=== экран ===')
  for (const [i, l] of lines.entries()) if (l.trim()) console.log(`${String(i).padStart(2)} |${l}`)
  process.exit(1)
}
check('до клика команда не вызывалась', calls.length === 0, JSON.stringify(calls))

const whyIdx = lines.findIndex(l => l.includes('Почему: [точная причина](literal)'))
const wrapIdx = lines.findIndex(l => l.includes('перенос'))
const actionIdx = lines.findIndex(l => l.includes('Действие: продолжить'))
const tailIdx = lines.findIndex(l => l.includes('Последняя строка'))
const beforeIdx = lines.findIndex(l => l.includes('Ответ до контролёра'))
const afterIdx = lines.findIndex(l => l.includes('Ответ после контролёра'))
check('до клика видны причина, перенос, действие и конец между ответами',
  beforeIdx >= 0 && beforeIdx < rowIdx && rowIdx < whyIdx && whyIdx < wrapIdx
    && wrapIdx < actionIdx && actionIdx < tailIdx && tailIdx < afterIdx)
check('сверхдлинная строка свёрнута', !lines.some(l => l.includes('Длинный хвост')))

if (whyIdx >= 0) {
  clickCell(lines[whyIdx]!.indexOf('Почему') + 1, whyIdx + 1)
  await sleep(650)
}
check('клик по телу раскрывает длинную строку без вызова оценки',
  screenLines().some(l => l.includes('Длинный хвост')) && calls.length === 0, JSON.stringify(calls))

const clickedLines = screenLines()
const clickedRow = clickedLines.findIndex(l => l.includes('⚖ Контролёр'))
const col1 = clickedLines[clickedRow]!.indexOf('Контролёр') + 1
clickCell(col1, clickedRow + 1)
await sleep(650)

check('клик по заголовку вызвал handoff-rate 4 @0',
  calls.length === 1 && calls[0] === '4 @0', JSON.stringify(calls))

clickCell(col1, clickedRow + 1)
await sleep(500)
check('повторный клик снова вызвал handoff-rate 4 @0',
  calls.length === 2 && calls[1] === '4 @0', JSON.stringify(calls))
check('оба клика прошли без уведомлений', notifications.length === 0, JSON.stringify(notifications))

stdin.write('\x0f')
await sleep(200)
stdin.write('/')
await sleep(200)
stdin.write('Контролёр №4')
await sleep(250)
const searchLine = screenLines().find(line => line.includes('/Контролёр №4'))
check('поиск по заголовку находит один блок контролёра', searchLine?.includes('1/1') === true, searchLine)

await inst.unmount()
unregister()
owner.dispose()
console.log(failed === 0 ? 'verify-controller-marker-click: all checks passed' : `verify-controller-marker-click: ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
