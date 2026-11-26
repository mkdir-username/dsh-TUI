/**
 * Background key regression: Ctrl+B (⌘B) on a running shell card moves that
 * call to the background; with nothing waiting the same key is the side-panel
 * toggle it used to be.
 *
 * The park itself happens inside the core bash tool (a local patch publishes a
 * per-call ticket on `globalThis`); this suite pins the TUI half of the
 * contract with the seam stubbed:
 *
 *  - the key asks the harness to park, and the toast names the parked
 *    command; a key with nothing waiting is consumed silently — no toast;
 *  - a parked call never touches the side panel, an empty park falls through
 *    to the toggle (wide fullscreen only — a narrow split has no panel);
 *  - a backend with no park seam says nothing;
 *  - the running card carries the hint, a settled one does not.
 *
 * Runs the real Chat useInput path over fake stdin; assertions read the
 * headless terminal screen and the channel stub's recorder.
 *
 * Run: node --import tsx/esm scripts/verify-tool-park.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh' // 中文文案断言必须在 i18n import 前固定语言。

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { t }, { comboDisplay, primaryComboString }, { settled, sleep, viewportLines }, { parkAnyDelegation, parkAnyToolCall, parkAnyWorkflow }] =
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
    import('../src/dsh-adapter/tool-park.js'),
  ])
const instances = (await import('../src/ink/instances.js')).default

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const T0 = 1_700_000_000_000
const CTRL_B = '\x02'
const prefs = await import('../src/tuiDisplayPrefs.js')
const HINT = t('tool-running-park-hint', { key: comboDisplay(primaryComboString('toolPark'), true) })

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

async function mount(harness: ReturnType<typeof makeHarness>, channel: Record<string, unknown>, fullscreen = false) {
  const instance = await render(
    React.createElement(Chat, {
      channel: channel as never,
      questionStore: new QuestionStore() as never,
      onExit: () => {},
      fullscreen,
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
async function press(rows: readonly unknown[], jobControl: unknown, parked: { callId: string; command: string } | null = { callId: 'call-1', command: 'bats suite.bats' }, layout: { cols?: number; rows?: number; fullscreen?: boolean } = {}, resetPanel = true, taps = 1, bytes = CTRL_B) {
  notices = []
  const parks: Array<{ callId: string; command: string } | null> = []
  const control = jobControl === 'passthrough'
    ? { kill: () => false, parkAny: () => { parks.push(parked); return parked } }
    : jobControl
  if (resetPanel) prefs.applySidePanelOpen(false)
  const harness = makeHarness(layout.cols ?? 100, layout.rows ?? 30)
  const instance = await mount(harness, makeChannel(rows, control), layout.fullscreen === true)
  // 固定窗:探针 卡片绘制与键盘处理器挂上之间没有可观测完成条件。
  await sleep(120)
  const before = harness.screen()
  for (let tap = 0; tap < taps; tap += 1) {
    harness.stdin.write(bytes)
    // 固定窗:探针 键后重绘没有可观测完成条件（车位是桩，不产生行变化）。
    await sleep(160)
  }
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

// ── nothing waits: the key falls through to the side-panel toggle ─────────
{
  const { parks, notices } = await press([RUNNING], 'passthrough', null)
  check('a key with nothing waiting still asks the harness', parks.length === 1, JSON.stringify(parks))
  check('nothing waiting raises no toast', notices.length === 0, JSON.stringify(notices))
  check('an empty park keeps the panel closed at narrow width', !prefs.getSidePanelOpen())
  // 宽屏 fullscreen 下侧栏本来可分栏：空 park 不再吞键，同一个字节交给开关。
  const wide = { cols: 120, rows: 30, fullscreen: true }
  await press([RUNNING], 'passthrough', null, wide)
  check('an empty park opens the side panel', prefs.getSidePanelOpen())
  // 三态开关走完一个来回必须留在同一个挂载里：重挂会重置焦点位。
  await press([RUNNING], 'passthrough', null, wide, true, 2)
  check('a second tap in the same mount closes it', !prefs.getSidePanelOpen())
  // Ghostty шлёт ⌘B как CSI-u с битом super (9 = 1 + 8). The ctrl↔Cmd alias
  // is a macOS rule (isMod): on other platforms the super bit must NOT reach
  // the Ctrl+B toggle, so the parser test pins both sides of that contract.
  await press([RUNNING], 'passthrough', null, wide, true, 1, '\x1b[98;9u')
  if (process.platform === 'darwin') {
    check('⌘B through the kitty encoding opens the panel too', prefs.getSidePanelOpen())
  } else {
    check('⌘B is not the panel toggle off macOS', !prefs.getSidePanelOpen())
  }
  await press([RUNNING], 'passthrough', undefined, wide)
  check('a parked call never touches the panel', !prefs.getSidePanelOpen())
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

// ── the production UI projection keeps the optional park seam ─────────────
// The suites above hand `jobControl` straight to Chat, but production reads
// it through `createChannelUi`, which forwards only the methods it knows.
// A dropped `parkAny` makes the background key fall through to the panel on
// a running call — the exact symptom this suite exists to prevent.
{
  const { createChannelUi, createChannelUiLease } = await import('../src/adapter/channel/ui.js')
  const lease = createChannelUiLease(() => true)
  const parkedCall = { callId: 'call-7', command: 'sleep 300' }
  const live = createChannelUi(makeChannel([RUNNING], { kill: () => false, parkAny: () => parkedCall }) as never, 'new', lease)
  check('the UI view forwards parkAny', typeof live.jobControl?.parkAny === 'function')
  check('the forwarded call reaches the backend', live.jobControl?.parkAny?.()?.callId === 'call-7')
  const releasedWait = { callId: 'call-8', jobId: 'bash-2' }
  const liveWait = createChannelUi(makeChannel([RUNNING], { kill: () => false, parkWait: () => releasedWait }) as never, 'new', lease)
  check('the UI view forwards parkWait', typeof liveWait.jobControl?.parkWait === 'function')
  check('the forwarded wait reaches the backend', liveWait.jobControl?.parkWait?.()?.jobId === 'bash-2')
  const bare = createChannelUi(makeChannel([RUNNING], { kill: () => false }) as never, 'new', lease)
  check('a backend without the seam keeps no parkAny', bare.jobControl?.parkAny === undefined)
  check('a backend without the seam keeps no parkWait', bare.jobControl?.parkWait === undefined)
  lease.dispose()
}


// ── a waiting job_output is a wait: the same key releases it ───────────────
{
  const WAITING = toolRow({
    name: 'job_output',
    argsText: '{"job_id":"bash-1","wait":true}',
    callView: { card: 'read', title: 'Read output from background job bash-1' },
  })
  const PLAIN_READ = toolRow({
    name: 'job_output',
    argsText: '{"job_id":"bash-1"}',
    callView: { card: 'read', title: 'Read output from background job bash-1' },
  })
  const waits: Array<{ callId: string; jobId: string }> = []
  const parks: Array<{ callId: string; command: string }> = []
  const control = {
    kill: () => false,
    parkWait: () => {
      const wait = { callId: 'call-2', jobId: 'bash-1' }
      waits.push(wait)
      return wait
    },
    parkAny: () => {
      const park = { callId: 'call-1', command: 'bats suite.bats' }
      parks.push(park)
      return park
    },
  }
  const WAIT_TOAST = t('job-wait-park-started', { id: 'bash-1' })
  const waiting = await press([WAITING], control)
  check('a waiting job_output card advertises the background key', waiting.after.includes(HINT), waiting.after.split('\n').find(line => line.includes('job_output')) ?? '')
  check('the key releases the wait first', waits.length === 1 && parks.length === 0, `${waits.length} waits / ${parks.length} parks`)
  check('the wait toast names the job and says nothing more', waiting.notices.length === 1 && waiting.notices[0] === WAIT_TOAST, JSON.stringify(waiting.notices))
  const plain = await press([PLAIN_READ], control, null)
  check('a job_output without wait advertises nothing', !plain.after.includes(HINT))
}

// ── a delegated child is the same kind of wait ─────────────────────────────
// The delegation plugin publishes `dsh.delegate-park`; the TUI asks it exactly
// like the two core seams. A dropped seam turns Ctrl+B into a side-panel toggle
// on a running delegation — the very symptom this section exists to prevent.
{
  const DELEGATION = toolRow({
    name: 'delegate',
    argsText: '{"description":"долгая задача","prompt":"go"}',
    callView: { card: 'generic', title: 'долгая задача', kind: 'execute' },
  })
  const key = Symbol.for('dsh.delegate-park')
  const installed = { requestAny: () => ({ callId: 'call-9', description: 'долгая задача' }) }
  ;(globalThis as Record<PropertyKey, unknown>)[key] = installed
  const calls: Array<{ callId: string; command: string }> = []
  const control = {
    kill: () => false,
    parkAny: () => {
      const parked = parkAnyToolCall() ?? parkAnyDelegation()
      if (parked !== null) calls.push(parked)
      return parked
    },
  }
  const seeded = await press([DELEGATION], control)
  check('a running delegation card advertises the background key', seeded.after.includes(HINT), seeded.after.split('\n').find(line => line.includes('долгая задача')) ?? '')
  check('the key asks the delegation seam', calls.length === 1 && calls[0]?.callId === 'call-9', JSON.stringify(calls))
  check('the toast names the delegated task', seeded.notices.some(text => text.includes('долгая задача')), JSON.stringify(seeded.notices))
  check('a parked delegation never touches the panel', !prefs.getSidePanelOpen())
  delete (globalThis as Record<PropertyKey, unknown>)[key]
  check('the delegation seam reads nothing without a hub', parkAnyDelegation() === null)
  check('a bash ticket still wins over a delegation ticket', parkAnyToolCall() === null)
  // Nothing to park: the very same byte must go back to being the panel toggle.
  const empty = await press([DELEGATION], control, null, { cols: 120, rows: 30, fullscreen: true })
  check('an empty delegation park opens the side panel', prefs.getSidePanelOpen())
  check('an empty delegation park raises no toast', empty.notices.length === 0, JSON.stringify(empty.notices))
}

// ── a foreground workflow is the same kind of wait ─────────────────────────
// The core patch publishes `dsh.workflow-park` while the tool waits for the
// batch; the TUI asks it after the two core seams and the delegation ticket,
// because a workflow is the rarest of the four.
{
  const WORKFLOW = toolRow({
    name: 'workflow',
    argsText: '{"script":"return 1","meta":{"name":"audit-sweep","description":"Audit the tree"}}',
    callView: { card: 'generic', title: 'workflow: audit-sweep', kind: 'execute' },
  })
  const key = Symbol.for('dsh.workflow-park')
  const installed = { requestAny: () => ({ callId: 'call-7', label: 'audit-sweep' }) }
  ;(globalThis as Record<PropertyKey, unknown>)[key] = installed
  const calls: Array<{ callId: string; command: string }> = []
  const control = {
    kill: () => false,
    parkAny: () => {
      const parked = parkAnyToolCall() ?? parkAnyDelegation() ?? parkAnyWorkflow()
      if (parked !== null) calls.push(parked)
      return parked
    },
  }
  const seeded = await press([WORKFLOW], control)
  check('a running workflow card advertises the background key', seeded.after.includes(HINT), seeded.after.split('\n').find(line => line.includes('audit-sweep')) ?? '')
  check('the key asks the workflow seam', calls.length === 1 && calls[0]?.callId === 'call-7', JSON.stringify(calls))
  check('the toast names the workflow', seeded.notices.some(text => text.includes('audit-sweep')), JSON.stringify(seeded.notices))
  delete (globalThis as Record<PropertyKey, unknown>)[key]
  check('the workflow seam reads nothing without a hub', parkAnyWorkflow() === null)
}

console.log(failed === 0 ? '\nAll tool-park checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
