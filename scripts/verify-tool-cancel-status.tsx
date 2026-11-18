/**
 * Cancelled tool calls are cancellations, not failures.
 *
 * A user cancel closes the turn (`turn/end {aborted, user}`) and the DSH batch
 * answers every call that never started with a synthetic
 * `ABORTED_BEFORE_DISPATCH` result; a body or pre-execute hook that observed
 * the abort keeps the thrown cancel cause (`{kind:'user'}`) and, once the core
 * patch lands, carries `ABORTED` in `error.info`. The transcript is the user's
 * account of what happened: those rows must read as cancelled (no red ✗, no
 * "AbortError: …" banner), while a real failure keeps its failure look.
 *
 * Pins the three layers that can drop the identity:
 *   - translator: `tool/result.error` → `AgentEvent.tool.result.errorInfo`;
 *   - projector: `errorInfo` → `ToolRow.status = 'cancelled'` + `cancelKind`;
 *   - card: rendered glyph/body.
 * The negative cases (a real tool failure, a plain ok result) catch an
 * over-eager classification that would hide actual errors.
 *
 * Run: node --import tsx/esm scripts/verify-tool-cancel-status.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

import type { AgentEvent } from '../src/agent/events.js'
import type { ToolRow } from '../src/adapter/ports/channel-view.js'

// The language is resolved when i18n loads and the renderer reads the env at
// import time, so every app import happens after the pins above.
const [
  { Writable },
  React,
  { Terminal: XTerm },
  { render },
  { AssistantToolUseMessage },
  { setLang, t },
  { settled },
  { createProjectorHarness },
  { createDshTranslator },
  { extractEntries },
  { buildTrajectory },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('./lib/projector-harness.js'),
  import('../src/dsh-adapter/backend/translate.js'),
  import('../src/dsh-adapter/sessionTree.js'),
  import('../src/dsh-adapter/trajectory/index.js'),
])

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

// ── 1. Translator keeps the structured identity ──────────────────────────
{
  const deps = { tools: () => undefined, scope: () => ({}), attachments: () => undefined }
  const translate = (code: string) => {
    const translator = createDshTranslator(deps)
    const event = {
      type: 'tool/result',
      seq: 7,
      time: 1_000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
          isError: true,
        },
        error: { name: 'AbortError', code },
      },
    } as unknown as Parameters<ReturnType<typeof createDshTranslator>['translateEvent']>[0]
    return translator.translateEvent(event).find(item => item.type === 'tool.result')
  }
  const aborted = translate('ABORTED_BEFORE_DISPATCH')
  check('translator: error.code → errorInfo.code', aborted?.type === 'tool.result' && aborted.errorInfo?.code === 'ABORTED_BEFORE_DISPATCH')
  check('translator: error.name → errorInfo.name', aborted?.type === 'tool.result' && aborted.errorInfo?.name === 'AbortError')
  // A result with no structured error keeps no identity (no invented code).
  const translator = createDshTranslator(deps)
  const plain = translator.translateEvent({
    type: 'tool/result',
    seq: 8,
    time: 1_001,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'c2' },
        toolCallId: 'c2',
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      },
    },
  } as unknown as Parameters<ReturnType<typeof createDshTranslator>['translateEvent']>[0]).find(item => item.type === 'tool.result')
  check('translator: unstructured error stays unstructured', plain?.type === 'tool.result' && plain.errorInfo === undefined)
}

// ── 2. Projector classifies cancellation, keeps real failures ────────────
const callEvent = (callId: string): AgentEvent => ({
  type: 'tool.call', seq: 1, turn: 1, step: 1, callId, name: 'write',
  argsJson: '{"file_path":"/tmp/brief.json"}', time: 1_000,
})
const resultEvent = (callId: string, errorInfo?: { name?: string; code?: string }): AgentEvent => ({
  type: 'tool.result', seq: 2, turn: 1, step: 1, callId, isError: true, time: 1_200,
  content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
  text: '',
  errorText: 'AbortError: ABORTED_BEFORE_DISPATCH — Error: tool call aborted before dispatch',
  ...(errorInfo === undefined ? {} : { errorInfo }),
})
const toolRowOf = (callId: string, errorInfo?: { name?: string; code?: string }): ToolRow | undefined => {
  const harness = createProjectorHarness()
  harness.apply([callEvent(callId), resultEvent(callId, errorInfo)])
  return harness.state.rows.find(row => row.kind === 'tool')?.tool
}

{
  const before = toolRowOf('c1', { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' })
  check('projector: before-dispatch skip → cancelled', before?.status === 'cancelled' && before.cancelKind === 'before-dispatch')
  const after = toolRowOf('c2', { name: 'AbortError', code: 'ABORTED' })
  check('projector: aborted body → cancelled(after-dispatch)', after?.status === 'cancelled' && after.cancelKind === 'after-dispatch')
  const real = toolRowOf('c3', { name: 'FsError', code: 'FS_NOT_OBSERVED' })
  check('projector: real failure keeps error', real?.status === 'error' && real.cancelKind === undefined)
  const plain = toolRowOf('c4')
  check('projector: unstructured error keeps error', plain?.status === 'error')
}

// ── 3. Tree and trajectory carry the same verdict ─────────────────────────
{
  const wireLog = [
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{"file_path":"/tmp/brief.json"}' } },
    {
      type: 'tool/result', seq: 2, time: 2,
      data: {
        turn: 1, step: 1,
        message: {
          role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1',
          content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }], isError: true,
        },
        error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
      },
    },
  ]
  const entries = extractEntries('s1', wireLog as unknown as Parameters<typeof extractEntries>[1])
  check('session tree: cancelled, not failed', entries.find(entry => entry.kind === 'tool')?.toolStatus === 'cancelled')

  const build = buildTrajectory(wireLog as unknown as Parameters<typeof buildTrajectory>[0])
  const node = build.nodes.find(item => item.kind === 'tool')
  check('trajectory: cancelled node', node?.status === 'cancelled')
  check('trajectory: cancelled is not an error count', build.state.counts.errors === 0)
}

// ── 4. Card: no failure banner for a cancellation ────────────────────────
function makeRig(cols: number, rows = 30) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  return { term, stdout: new FakeStdout() }
}
function screenOf(term: XTerm): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out.join('\n')
}

const base: ToolRow = { callId: 'c1', name: 'write', argsText: '{"file_path":"/tmp/brief.json"}', status: 'ok', startedAt: 0, durationMs: 400 }
const cancelled: ToolRow = { ...base, status: 'cancelled', cancelKind: 'before-dispatch', errorText: 'AbortError: ABORTED_BEFORE_DISPATCH — Error: tool call aborted before dispatch' }
const failed: ToolRow = { ...base, status: 'error', errorText: 'FsError: FS_NOT_OBSERVED — cannot modify "/tmp/brief.json"' }

async function renderTool(tool: ToolRow): Promise<string> {
  const rig = makeRig(90)
  const app = await render(
    React.createElement(AssistantToolUseMessage, { tool, marginTopOnTurn: false, verbose: false }),
    { stdout: rig.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  await settled(() => screenOf(rig.term).includes('brief.json'))
  const screen = screenOf(rig.term)
  app.unmount()
  return screen
}

{
  const screen = await renderTool(cancelled)
  check('card: cancelled row keeps the call header', screen.includes('brief.json'))
  check('card: no failure glyph', !screen.includes('✗'))
  check('card: no AbortError banner', !screen.includes('AbortError'))
  check('card: localized cancellation line', screen.includes(t('tool-cancelled-before-dispatch')))

  const after = await renderTool({ ...cancelled, cancelKind: 'after-dispatch' })
  check('card: after-dispatch line', after.includes(t('tool-cancelled-after-dispatch')))

  const errorScreen = await renderTool(failed)
  check('card: real failure still red ✗', errorScreen.includes('✗'))
  check('card: real failure still shows its text', errorScreen.includes('FS_NOT_OBSERVED'))

  setLang('en')
  const english = await renderTool(cancelled)
  check('card: en copy', english.includes(t('tool-cancelled-before-dispatch')))
  setLang('zh')
}

console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
