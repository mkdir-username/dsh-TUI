/**
 * Managed-dialog input field regression: the plugin `tuiDialogs.input` box is
 * a single-line text field and must take the same terminal editing contract
 * as the shared answer field — Alt/Option+←/→ and Ctrl+←/→ word jumps,
 * Ctrl+A/E line edges, Ctrl+W / Option+Backspace / Ctrl+U deletions, code-point
 * caret steps — while keeping its own display-cell cap (INPUT_CELLS): typing
 * past the cap is refused, paste is truncated.
 *
 * Drives the real ExtensionDialog with fake stdin; the decided value is
 * asserted through the callback.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { ExtensionDialog }, { INPUT_CELLS }, { settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/ExtensionDialog.js'),
  import('../src/dsh-adapter/dialogs.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 20
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
const stdout = new FakeStdout()
const stdin = new FakeStdin()
const screen = (): string => viewportLines(term, ROWS).join('\n')

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, extra?: string): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
  if (!ok && extra !== undefined) results.push(`      actual: ${extra.slice(0, 300)}`)
}

const dialog = { key: 'dialog-1', kind: 'input' as const, title: 'Package name', placeholder: 'name', initial: '' }
let decided: string | undefined
let cancelled = 0
let app: { rerender(el: unknown): Promise<unknown>; unmount(): Promise<void> } | null = null
let seq = 0
async function mount(): Promise<void> {
  seq++
  decided = undefined
  cancelled = 0
  const element = React.createElement(ExtensionDialog, {
    key: `extension-input-${seq}`,
    dialog,
    onDecide: (value: string) => { decided = value },
    onCancel: () => { cancelled++ },
  })
  if (app === null) {
    app = await render(element, {
      stdout,
      stdin,
      stderr: new FakeStderr(),
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    }) as never
  } else {
    await app.rerender(element)
  }
  await settled(() => screen().includes('Package name'))
}

/** One key group, then a pacing window: caret moves are not observable. */
async function feed(sequence: string): Promise<void> {
  stdin.write(sequence)
  await sleep(140) // 固定窗:pacing 按键分组之间，语义由提交值断言
}

async function type(text: string): Promise<void> {
  stdin.write(text)
  await sleep(120) // 固定窗:pacing 让插入后的批次落定，再做下一组按键
}

async function submitAndRead(): Promise<string | undefined> {
  stdin.write('\r')
  await settled(() => decided !== undefined)
  return decided
}

// ── 1. Alt+← jumps by words ─────────────────────────────────────────
await mount()
await type('alpha beta gamma')
await feed('\x1b[1;3D')
await type('X')
check('1: Alt+← lands on the previous word start', (await submitAndRead()) === 'alpha beta Xgamma')

// ── 2. Ctrl+W deletes the previous word ─────────────────────────────
await mount()
await type('foo bar baz')
await feed('\x17')
await type('Q')
check('2: Ctrl+W deletes the previous word', (await submitAndRead()) === 'foo bar Q')

// ── 3. Ctrl+A / Ctrl+E line edges ───────────────────────────────────
await mount()
await type('one two')
await feed('\x01')
await type('X')
check('3a: Ctrl+A moves to the line start', (await submitAndRead()) === 'Xone two')

await mount()
await type('one two')
await feed('\x01')
await feed('\x05')
await type('Y')
check('3b: Ctrl+E moves to the line end', (await submitAndRead()) === 'one twoY')

// ── 4. Ctrl+U clears the line ───────────────────────────────────────
await mount()
await type('one two')
await feed('\x15')
await type('Z')
check('4: Ctrl+U deletes the line prefix', (await submitAndRead()) === 'Z')

// ── 5. Emoji backspace removes the whole code point ─────────────────
await mount()
await type('👍')
await feed('\x7f')
await type('X')
const emoji = await submitAndRead()
check('5: ⌫ removes the whole emoji', emoji === 'X' && !(emoji ?? '').includes('\uFFFD'), JSON.stringify(emoji))

// ── 6. The cell cap survives the migration ──────────────────────────
await mount()
await type('x'.repeat(INPUT_CELLS))
await type('y')
const capped = await submitAndRead()
check('6a: typing at the cap still inserts the accepted chunk', capped?.length === INPUT_CELLS, String(capped?.length))
check('6b: typing past the cap is refused', capped?.endsWith('y') === false)

// ── 7. A bracketed paste flattens its line breaks ───────────────────
await mount()
stdin.write('\x1b[200~a\r\nb\x1b[201~')
await sleep(150) // 固定窗:pacing 粘贴块解析后落定
check('7: a pasted chunk flattens to one line', (await submitAndRead()) === 'a  b')

// ── 8. Esc still cancels ────────────────────────────────────────────
await mount()
await feed('\x1b')
check('8: Esc cancels the dialog', cancelled === 1)

await app?.unmount()
console.log(results.join('\n'))
term.dispose()
if (failures > 0) {
  console.log(`\n${failures} extension input editing check(s) FAILED`)
  process.exit(1)
}
console.log('\nExtension dialog input edits by code points')
process.exit(0)
