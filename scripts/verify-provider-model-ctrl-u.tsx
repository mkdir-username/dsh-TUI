/**
 * /provider capability form: Ctrl+U is the readline "delete to line start",
 * not "clear the whole field". On a single-line field that means the prefix
 * BEFORE the caret goes and the suffix stays — typing `1234`, Home, →→,
 * Ctrl+U leaves `34`.
 *
 * Run: node --import tsx/esm scripts/verify-provider-model-ctrl-u.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { ProviderModelEditor }, { settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/ProviderModelEditor.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

let failures = 0
const check = (name: string, ok: boolean, extra?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && extra !== undefined ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

const saved: Array<Record<string, unknown>> = []
const editor = {
  reasoningEditable: true,
  read: () => ({
    values: { contextWindow: 1234, maxTokens: 1000, reasoningEfforts: { high: 'gateway-high' }, input: ['text'] as const },
    defaults: {},
  }),
  save: (_model: string, values: Record<string, unknown>) => { saved.push(values) },
  edited: () => false,
}

const stdin = new FakeStdin()
const app = await render(
  React.createElement(ProviderModelEditor, {
    model: 'model-a',
    editor: editor as never,
    onClose: () => {},
    onAbort: () => {},
  }),
  {
    stdout: new FakeStdout() as never,
    stdin: stdin as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
await sleep(200) // 固定窗:pacing 首帧布局与输入注册

// Home, then →→: the caret sits after `12`, the suffix `34` must survive.
stdin.write('\x1b[H')
await sleep(80) // 固定窗:pacing 光标移动不可观测
stdin.write('\x1b[C')
await sleep(80) // 固定窗:pacing
stdin.write('\x1b[C')
await sleep(80) // 固定窗:pacing
stdin.write('\x15')
await sleep(120) // 固定窗:pacing 编辑批次落定
stdin.write('\x13') // Ctrl+S saves the draft
const didSave = await settled(() => saved.length > 0)
check('1: Ctrl+S saves the draft', didSave)
check('2: Ctrl+U deletes only the prefix before the caret',
  (saved[0]?.contextWindow as number | undefined) === 34,
  JSON.stringify(saved[0]?.contextWindow))

await app.unmount()
term.dispose()
if (failures > 0) {
  console.log(`\n${failures} provider-model Ctrl+U check(s) FAILED`)
  process.exit(1)
}
console.log('\nProvider-model Ctrl+U keeps the suffix')
process.exit(0)
