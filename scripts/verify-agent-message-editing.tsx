/**
 * AgentMessageComposer editing regression: the user→child send box is a
 * single-line text field and must take the same terminal editing contract as
 * the shared answer field — Alt/Option+←/→ and Ctrl+←/→ word jumps, Ctrl+A/E
 * line edges, Ctrl+W / Option+Backspace / Ctrl+U deletions, code-point caret
 * steps. Shift+Enter is NOT a newline here: a single-line box must not insert
 * a stray CR, and it must never submit.
 *
 * Drives the real component with fake stdin; the submitted text is asserted
 * through the control stub.
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { AgentMessageComposer }, { settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/AgentMessageComposer.js'),
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

const submitted: string[] = []
let focusCalls: boolean[] = []
const target = { agentId: 'agent-1', name: 'worker' }
const control = {
  via: 'dsh',
  steer: true,
  listTargets: () => Promise.resolve([]),
  submit: (input: { text: string }) => {
    submitted.push(input.text)
    return Promise.resolve({ ok: true, intentId: `intent-${submitted.length}`, state: 'queued' })
  },
  messages: () => [],
}

let app: { rerender(el: unknown): Promise<unknown>; unmount(): Promise<void> } | null = null
let seq = 0
async function mount(): Promise<void> {
  seq++
  submitted.length = 0
  focusCalls = []
  const element = React.createElement(AgentMessageComposer, {
    key: `agent-message-editing-${seq}`,
    target,
    control,
    messages: [],
    focused: true,
    onFocusChange: (focused: boolean) => { focusCalls.push(focused) },
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
  await settled(() => screen().includes('worker'))
}

/** One key group, then a pacing window: caret moves are not observable. */
async function feed(sequence: string): Promise<void> {
  stdin.write(sequence)
  await sleep(140) // 固定窗:pacing 按键分组之间，语义由提交文本断言
}

/** Type and wait until the glyphs are painted (a batch may still be settling). */
async function type(text: string): Promise<void> {
  stdin.write(text)
  await sleep(120) // 固定窗:pacing 让插入后的批次落定，再做下一组按键
}

async function submitAndRead(): Promise<string | undefined> {
  const before = submitted.length
  stdin.write('\r')
  const got = await settled(() => submitted.length > before)
  return got ? submitted[submitted.length - 1] : undefined
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

// ── 5. Word jump never splits an emoji ──────────────────────────────
await mount()
await type('beta 👍')
await feed('\x1b[1;3D')
await type('X')
const emojiSubmit = await submitAndRead()
check('5: word jump never splits an emoji', emojiSubmit === 'beta X👍' && !(emojiSubmit ?? '').includes('\uFFFD'))

// ── 6. Shift+Enter is not a newline and never submits ───────────────
await mount()
await type('one')
await feed('\x1b[13;2u')
await type('two')
check('6a: Shift+Enter does not submit', submitted.length === 0, JSON.stringify(submitted))
check('6b: Shift+Enter inserts no stray control character', (await submitAndRead()) === 'onetwo')

// ── 7. A successful send clears the field ───────────────────────────
await mount()
await type('first')
await submitAndRead()
await settled(() => !screen().includes('first'))
await type('second')
const second = await submitAndRead()
check('7: the box is empty after a send', second === 'second', `submitted=${JSON.stringify(submitted)} screen=${screen()}`)

// ── 8. Esc hands focus back and keeps the draft ─────────────────────
await mount()
await type('draft')
await feed('\x1b')
check('8: Esc returns focus to the scene', focusCalls.includes(false))

// ── 9. An emoji draft is painted whole ──────────────────────────────
// The caret counts code points, the render must slice by them too: a
// UTF-16 slice splits the pair and the row paints nothing at all.
await mount()
await type('👍')
const painted = await settled(() => screen().includes('👍'))
check('9: an emoji draft is painted in the box', painted, screen())

await app?.unmount()
console.log(results.join('\n'))
term.dispose()
if (failures > 0) {
  console.log(`\n${failures} agent-message editing check(s) FAILED`)
  process.exit(1)
}
console.log('\nAgent-message composer edits by code points')
process.exit(0)
