/**
 * Background key regression: Ctrl+B on a running shell card moves that call to
 * the background instead of toggling the side panel.
 *
 * The park itself happens inside the core bash tool (a local patch publishes a
 * per-call ticket on `globalThis`); this suite pins the TUI half of the
 * contract with the seam stubbed:
 *
 *  - the key asks the harness to park, and the toast names the parked
 *    command; a key with nothing waiting falls through to the panel;
 *  - a backend with no park seam keeps the panel key and says nothing;
 *  - the running card carries the hint, a settled one does not.
 *
 * Runs the real Chat useInput path over fake stdin; assertions read the
 * headless terminal screen and the channel stub's recorder.
 *
 * Run: node --import tsx/esm scripts/verify-tool-park.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh' // 中文文案断言必须在 i18n import 前固定语言。

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { t }, { comboDisplay, primaryComboString }, { settled, sleep, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/i18n.js'),
    import('../src/utils/keymap.js'),
    import('./lib/term-test.mjs'),
  ])
const instances = (await import('../src/ink/instances.js')).default

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const T0 = 1_700_000_000_000
const CTRL_B = '\x02'
const HINT = t('tool-running-park-hint', { key: comboDisplay(primaryComboString('sidePanel'), true) })

/** One tool row, in the shape the projector publishes. */
function toolRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    kind: 'tool',
    text: '',
    tool: {
      callId: 'call-1',
      name: 'bash',
      argsText: '{"command":"bats suite.bats"}',
      status: 'running',
      startedAt: T0,
      callView: { card: 'terminal', title: 'bats suite.bats', description: 'Run the suite' },
      ...overrides,
    },
  }
}

function makeChannel(rows: readonly unknown[], jobControl: unknown): Record<string, unknown> {
  return {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'tool-park probe',
    agentId: 'probe',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/code/x',
    displayCwd: 'C:/code/x',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'idle',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode(): void {},
    turnStart: T0,
    lastUserText: '',
    pending: [],
    commandList: [],
    commandCompletions: () => [],
    notifications: [],
    activityEnabled: false,
    contextBarEnabled: false,
    activityFrames: [],
    goal: undefined,
    todos: [],
    loadedContext: undefined,
    traceEvents: () => [],
    subscribe: () => () => {},
    submit: (): void => {},
    cancel: (): void => {},
    clear: (): void => {},
    notify: (text: string): void => { notices.push(text) },
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: (): void => {},
    stageImage: () => Promise.resolve(''),
    lastUsage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    contextWindow: 1_000_000,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    tps: undefined,
    tpsSamples: [],
    reasoningEffort: 'high',
    agentPreset: 'standard',
    workspaceLabel: undefined,
    ...(jobControl === undefined ? {} : { jobControl }),
  }
}

function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdin = new FakeStdin()
  const screen = (): string => viewportLines(term, rows).join('\n')
  return { term, stdout: new FakeStdout(), stdin, screen }
}

async function mount(harness: ReturnType<typeof makeHarness>, channel: Record<string, unknown>) {
  const instance = await render(
    React.createElement(Chat, {
      channel: channel as never,
      questionStore: new QuestionStore() as never,
      onExit: () => {},
      fullscreen: false,
      trajectorySeen: true,
    }),
    {
      stdout: harness.stdout as never,
      stdin: harness.stdin as never,
      stderr: harness.stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  return instance
}

let notices: string[] = []

/** Mount one transcript state, press Ctrl+B once, report what the key did. */
async function press(rows: readonly unknown[], jobControl: unknown, parked: { callId: string; command: string } | null = { callId: 'call-1', command: 'bats suite.bats' }) {
  notices = []
  const parks: Array<{ callId: string; command: string } | null> = []
  const control = jobControl === 'passthrough'
    ? { kill: () => false, parkAny: () => { parks.push(parked); return parked } }
    : jobControl
  const harness = makeHarness(100, 30)
  const instance = await mount(harness, makeChannel(rows, control))
  // 固定窗:探针 卡片绘制与键盘处理器挂上之间没有可观测完成条件。
  await sleep(120)
  const before = harness.screen()
  harness.stdin.write(CTRL_B)
  // 固定窗:探针 键后重绘没有可观测完成条件（车位是桩，不产生行变化）。
  await sleep(160)
  const after = harness.screen()
  instance.unmount()
  instances.delete(process.stdout)
  harness.term.dispose()
  // 固定窗:pacing 卸载/dispose 收尾
  await sleep(40)
  return { before, after, parks, notices: [...notices] }
}

const RUNNING = toolRow({})
const SETTLED = toolRow({ id: 1, status: 'ok', resultView: { card: 'terminal', output: 'ok', exitCode: 0 } })
const BACKGROUND_CARD = toolRow({
  callView: { card: 'generic', title: 'bats suite.bats', kind: 'execute' },
})

// ── a running shell card is the target ─────────────────────────────────────
{
  const { after, parks, notices } = await press([RUNNING], 'passthrough')
  check('Ctrl+B asks the harness to park one call', parks.length === 1, JSON.stringify(parks))
  check('the toast names the command', notices.some(text => text.includes('bats suite.bats')), JSON.stringify(notices))
  check('the running card advertises the key', after.includes(HINT), after.split('\n').find(line => line.includes('Running')) ?? '')
}

// ── nothing waits: the key keeps its panel job ─────────────────────────────
{
  const { parks, notices } = await press([RUNNING], 'passthrough', null)
  check('a key with nothing waiting still asks the harness', parks.length === 1, JSON.stringify(parks))
  check('nothing waiting raises no toast', notices.length === 0, JSON.stringify(notices))
}

// ── a settled card carries no hint ─────────────────────────────────────────
{
  const { after } = await press([SETTLED], 'passthrough', null)
  check('a settled card drops the hint', !after.includes(HINT))
}

// ── a run_in_background card carries no hint either ────────────────────────
{
  const { after } = await press([BACKGROUND_CARD], 'passthrough', null)
  check('a background job card advertises nothing to park', !after.includes(HINT))
}

// ── a backend without the seam keeps the panel key ────────────────────────
{
  const { parks, notices } = await press([RUNNING], { kill: () => false })
  check('a backend without park is left alone', parks.length === 0, JSON.stringify(parks))
  check('a backend without park says nothing', notices.length === 0, JSON.stringify(notices))
}

console.log(failed === 0 ? '\nAll tool-park checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
