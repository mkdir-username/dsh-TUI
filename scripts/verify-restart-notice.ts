/**
 * 重启后的收尾提示：替换进程是被叫回来继续的，不是会话结束。
 *
 * 重启时宿主用 `aborted/disposed` 关掉当前回合，投影在回放里把它画成一行
 * notice。`/restart`、`restart_session` 的替换进程会把这一行读作
 * 「Session restarted」：进程回来了、继续干活；而崩溃后的恢复仍如实写
 * 「Session stopped」——那是真的停过。
 *
 *  - 重启启动（restartResume）且被关的回合是回放的最后一条 → restarted；
 *  - 同一个回放没有重启标记 → stopped（E3 的语义不变）；
 *  - 停止的回合已经旧了（不是这次重启造成的）→ stopped；
 *  - 重启后的后续回放（回合不再是最后一条）→ 文案不翻回 stopped；
 *  - 重启进程里后来又停了一个回合 → 新的那行仍是 stopped。
 *
 * Run: node --import tsx/esm scripts/verify-restart-notice.ts
 */
process.env.DSH_TUI_LANG = 'zh'

const [{ createChannelProjection }, { createInitialChannelView }, { t }] = await Promise.all([
  import('../src/channel/projection.js'),
  import('../src/dsh-adapter/channel/state.js'),
  import('../src/i18n.js'),
])

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1
    console.log(`PASS ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function freshView() {
  return createInitialChannelView(
    { model: 'm', provider: 'p', cwd: '/fixture' },
    { agentId: 'a', sessionId: 's', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture' },
  )
}

function projectorFor(restartResume?: boolean) {
  const state = { ...freshView(), emit: () => undefined } as Parameters<typeof createChannelProjection>[0]
  const projector = createChannelProjection(state, {
    rowIds: { value: 0 },
    resetContextWarning: () => undefined,
    checkContextWarning: () => undefined,
    notify: () => () => undefined,
    jobs: { onOutputSeen: () => undefined, onStarted: () => undefined },
    inputConvergence: { cancelInFlight: false },
    selectionAttached: () => undefined,
    ...(restartResume === undefined ? {} : { restartResume }),
  })
  const notices = (): string[] => state.rows.filter(row => row.kind === 'notice').map(row => row.text)
  return { state, projector, notices }
}

const disposedTurn = (turn: number, time: number) =>
  [{ type: 'turn.start' as const, turn, origin: 'user' as const, time }, { type: 'turn.end' as const, turn, reason: { kind: 'aborted' as const, cause: 'disposed' as const }, time }]

// ── A: the restart itself ──────────────────────────────────────────────
{
  const { projector, notices } = projectorFor(true)
  projector.apply(disposedTurn(1, Date.now()), { replay: true })
  check('a restart boot reads the cancelled turn as restarted', notices().join('|') === t('session-restarted'), notices())
}
{
  const { projector, notices } = projectorFor()
  projector.apply(disposedTurn(1, Date.now()), { replay: true })
  check('a plain boot (crash resume) still says the session stopped', notices().join('|') === t('session-stopped'), notices())
}
{
  const { projector, notices } = projectorFor(true)
  projector.apply(disposedTurn(1, Date.now() - 11 * 60 * 1000), { replay: true })
  check('an old disposed turn is not this restart: it reads as stopped', notices().join('|') === t('session-stopped'), notices())
}

// ── B: later replays and later teardowns ───────────────────────────────
{
  const { projector, notices } = projectorFor(true)
  const boot = disposedTurn(1, Date.now())
  projector.apply(boot, { replay: true })
  const rebind = [
    ...boot,
    { type: 'turn.start' as const, turn: 2, origin: 'user' as const, time: Date.now() + 1 },
    { type: 'turn.end' as const, turn: 2, reason: { kind: 'completed' as const }, time: Date.now() + 2 },
  ]
  projector.apply(rebind, { replay: true })
  check('a later replay keeps the restart wording (it does not flip back to stopped)',
    notices().includes(t('session-restarted')) && !notices().includes(t('session-stopped')), notices())
}
{
  const { projector, notices } = projectorFor(true)
  projector.apply(disposedTurn(1, Date.now()), { replay: true })
  projector.apply([{ type: 'turn.start', turn: 2, origin: 'user', time: Date.now() + 1 }], { replay: false })
  projector.apply([{ type: 'turn.end', turn: 2, reason: { kind: 'aborted', cause: 'disposed' }, time: Date.now() + 2 }], { replay: false })
  check('a teardown that happens after the restart is still reported as stopped',
    notices().join('|') === `${t('session-restarted')}|${t('session-stopped')}`, notices())
}

console.log(`\nverify-restart-notice: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
