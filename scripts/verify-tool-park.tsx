/**
 * Background key regression: Ctrl+B (⌘B) on a running shell card moves that
 * call to the background; with nothing waiting the key does nothing. The side
 * panel has its own combo (⌘/ on macOS, Ctrl+/ elsewhere) and never shares the
 * byte with the park.
 *
 * The park itself happens inside the core bash tool (a local patch publishes a
 * per-call ticket on `globalThis`); this suite pins the TUI half of the
 * contract with the seam stubbed:
 *
 *  - the key asks the harness to park, and the toast names the parked
 *    command; a key with nothing waiting is consumed silently — no toast;
 *  - the park key never reaches the side panel: a parked call, an empty park
 *    and ⌘B all leave it closed, while ⌘/ toggles the split;
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

function makeChannel(rows: readonly unknown[], jobControl: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
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

/** Mount one transcript state WITHOUT a keypress and let the auto-background
 *  policy act on its own. `until` polls the seam's answer — the policy runs on
 *  its own timer, so the wait is "until it parked", not a fixed window. The
 *  negative cases pass no predicate: they wait one observation window and the
 *  caller asserts the invariant (nothing was asked). */
async function autoRun(rows: readonly unknown[], jobControl: unknown, overrides: Record<string, unknown>, until?: () => boolean) {
  notices = []
  const harness = makeHarness(100, 30)
  const instance = await mount(harness, makeChannel(rows, jobControl, overrides))
  const reached = until === undefined
    // 固定窗:探针 the policy must NOT ask here — silence is the invariant, so
    // polling a condition that must stay false would mean nothing.
    ? (await sleep(320), true)
    : await settled(until)
  const screen = harness.screen()
  instance.unmount()
  instances.delete(process.stdout)
  harness.term.dispose()
  // 固定窗:pacing 卸载/dispose 收尾
  await sleep(40)
  return { screen, notices: [...notices], reached }
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

// ── nothing waits: the park key is inert, the panel has its own combo ─────
{
  const { parks, notices } = await press([RUNNING], 'passthrough', null)
  check('a key with nothing waiting still asks the harness', parks.length === 1, JSON.stringify(parks))
  check('nothing waiting raises no toast', notices.length === 0, JSON.stringify(notices))
  check('an empty park keeps the panel closed at narrow width', !prefs.getSidePanelOpen())
  // At a wide fullscreen width the panel CAN split, so this is where the old
  // fallthrough showed: an empty park still must not touch it.
  const wide = { cols: 120, rows: 30, fullscreen: true }
  await press([RUNNING], 'passthrough', null, wide)
  check('an empty park leaves the side panel closed', !prefs.getSidePanelOpen())
  // Ghostty sends ⌘B as CSI-u with the super bit (9 = 1 + 8). Park and panel
  // no longer share a byte, so ⌘B opens the panel on no platform.
  await press([RUNNING], 'passthrough', null, wide, true, 1, '\x1b[98;9u')
  check('⌘B leaves the side panel closed', !prefs.getSidePanelOpen())
  // ⌘/ is the same kitty encoding for codepoint 47 ('/') with the super bit;
  // Ctrl+/ arrives as codepoint 47 with the ctrl bit (5 = 1 + 4), no mac alias.
  await press([RUNNING], 'passthrough', null, wide, true, 2, '\x1b[47;9u')
  check('⌘/ opens the panel and a second tap in the same mount closes it', !prefs.getSidePanelOpen())
  await press([RUNNING], 'passthrough', null, wide, true, 1, '\x1b[47;9u')
  if (process.platform === 'darwin') {
    check('⌘/ through the kitty encoding opens the panel', prefs.getSidePanelOpen())
  } else {
    check('⌘/ is not the panel toggle off macOS', !prefs.getSidePanelOpen())
  }
  await press([RUNNING], 'passthrough', null, wide, true, 1, '\x1b[47;5u')
  check('Ctrl+/ opens the panel on every platform', prefs.getSidePanelOpen())
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
  // Nothing to park: the very same byte stays inert instead of opening the
  // panel — the side panel has its own combo and is unrelated to this wait.
  const empty = await press([DELEGATION], control, null, { cols: 120, rows: 30, fullscreen: true })
  check('an empty delegation park leaves the side panel closed', !prefs.getSidePanelOpen())
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

// ── the background key is policy for child runs, not only a keypress ──────
// Settings `dsh-tui.autoBackground` (on by default): a waiting delegation or
// foreground workflow is moved to the background by the TUI itself, so the
// turn never sits on a child while the human hunts for Ctrl+B. The seam is
// asked by KIND — a foreground shell wait and a job_output wait keep their own
// exits — and the policy asks nothing when no child run holds the turn.
{
  const DELEGATION = toolRow({
    name: 'delegate',
    argsText: '{"description":"долгая задача","prompt":"go"}',
    callView: { card: 'generic', title: 'долгая задача', kind: 'execute' },
  })
  const delegateKey = Symbol.for('dsh.delegate-park')
  let tickets: Array<{ callId: string; description: string }> = [{ callId: 'call-auto', description: 'долгая задача' }]
  ;(globalThis as Record<PropertyKey, unknown>)[delegateKey] = {
    requestAny: () => tickets.shift() ?? null,
  }
  const parks: Array<{ callId: string; command: string }> = []
  let workflowParks = 0
  const control = {
    kill: () => false,
    parkAny: () => null,
    parkDelegation: () => {
      const parked = parkAnyDelegation()
      if (parked !== null) parks.push(parked)
      return parked
    },
    parkWorkflow: () => {
      const parked = parkAnyWorkflow()
      if (parked !== null) workflowParks += 1
      return parked
    },
  }
  const auto = await autoRun([DELEGATION], control, { working: true, autoBackground: true }, () => parks.length > 0)
  check('the auto-background policy asks the delegation seam without a key',
    auto.reached && parks.length === 1 && parks[0]?.callId === 'call-auto', JSON.stringify(parks))
  check('the automatic park names the delegated task once',
    auto.notices.filter(text => text.includes('долгая задача')).length === 1, JSON.stringify(auto.notices))

  // Off is the manual world: the same running card asks nothing.
  const parkedBefore = parks.length
  await autoRun([DELEGATION], control, { working: true, autoBackground: false })
  check('autoBackground off leaves the wait to the key', parks.length === parkedBefore, JSON.stringify(parks))

  // An idle turn has no wait to move: the policy must not ask at all.
  await autoRun([DELEGATION], control, { working: false, autoBackground: true })
  check('an idle turn asks nothing', parks.length === parkedBefore, JSON.stringify(parks))

  // A foreground shell wait is NOT a child run: the policy never ends it.
  let shellAsks = 0
  const shellKey = Symbol.for('dsh.tool-park')
  ;(globalThis as Record<PropertyKey, unknown>)[shellKey] = { requestAny: () => { shellAsks += 1; return { callId: 'call-1', command: 'bats suite.bats' } } }
  await autoRun([RUNNING], control, { working: true, autoBackground: true })
  check('a foreground shell wait is left alone by the policy', shellAsks === 0, `${shellAsks} asks`)
  delete (globalThis as Record<PropertyKey, unknown>)[shellKey]

  // A workflow is the same kind of child run: the policy asks ITS seam.
  const WORKFLOW = toolRow({
    name: 'workflow',
    argsText: '{"script":"return 1","meta":{"name":"audit-sweep","description":"Audit the tree"}}',
    callView: { card: 'generic', title: 'workflow: audit-sweep', kind: 'execute' },
  })
  const workflowKey = Symbol.for('dsh.workflow-park')
  // A ticket answers once, exactly like the core patch's hub: the repeated
  // tick of the running card must not park the same run twice.
  let workflowTicket = true
  ;(globalThis as Record<PropertyKey, unknown>)[workflowKey] = {
    requestAny: () => {
      if (!workflowTicket) return null
      workflowTicket = false
      return { callId: 'call-w', label: 'audit-sweep' }
    },
  }
  const autoWorkflow = await autoRun([WORKFLOW], control, { working: true, autoBackground: true }, () => workflowParks > 0)
  check('the policy moves a foreground workflow too, once',
    autoWorkflow.reached && workflowParks === 1, `${workflowParks} workflow parks`)
  delete (globalThis as Record<PropertyKey, unknown>)[workflowKey]
  delete (globalThis as Record<PropertyKey, unknown>)[delegateKey]
  check('a delegation seam with no hub is not asked', parkAnyDelegation() === null)
}

// ── the UI facade forwards the kind-narrowed park seams ───────────────────
// The live channel a screen sees is a facade (`createChannelUi`): it re-exposes
// ONLY the methods declared in its effects table. A seam added to the control
// but not to the facade is invisible at runtime while every stub-based test
// stays green — the 2026-11-27 live check saw a waiting ticket in the hub, a
// running card, and `channel.jobControl.parkDelegation === undefined`.
{
  const [{ createChannelUi, createChannelUiLease }] = await Promise.all([import('../src/adapter/channel/ui.js')])
  const calls: string[] = []
  const control = {
    kill: () => false,
    parkAny: () => ({ callId: 'call-any', command: 'bash' }),
    parkWait: () => ({ callId: 'call-wait', jobId: 'job-1' }),
    parkDelegation: () => { calls.push('delegation'); return { callId: 'call-del', command: 'долгая задача' } },
    parkWorkflow: () => { calls.push('workflow'); return { callId: 'call-wf', command: 'audit-sweep' } },
  }
  const facade = createChannelUi({ version: 1, jobControl: control } as never, 'new', createChannelUiLease(() => true))
  const view = facade.jobControl as unknown as Record<string, unknown>
  const delegation = typeof view.parkDelegation === 'function' ? (view.parkDelegation as () => { callId: string } | null)() : null
  check('the UI facade forwards parkDelegation',
    delegation !== null && delegation.callId === 'call-del', Object.keys(view).join(','))
  const workflow = typeof view.parkWorkflow === 'function' ? (view.parkWorkflow as () => { callId: string } | null)() : null
  check('the UI facade forwards parkWorkflow',
    workflow !== null && workflow.callId === 'call-wf', JSON.stringify(calls))
  // A backend whose control has only kill must not grow a park seam through
  // the facade — the key's fallthrough depends on the absence being real.
  const bare = createChannelUi({ version: 1, jobControl: { kill: () => false } } as never, 'new', createChannelUiLease(() => true))
  const bareView = bare.jobControl as unknown as Record<string, unknown>
  check('a control without the seams stays bare behind the facade',
    !('parkAny' in bareView) && !('parkDelegation' in bareView) && !('parkWorkflow' in bareView),
    Object.keys(bareView).join(','))
}

console.log(failed === 0 ? '\nAll tool-park checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
