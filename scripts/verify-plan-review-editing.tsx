/**
 * Plan-review feedback-row editing regression: the decision card's input row
 * must take the same terminal editing contract as the questionnaire answer
 * field (one shared editor — see src/components/questions/useAnswerField.ts),
 * because the two panels had drifted apart once already.
 *
 * Covers the macOS/readline key set (Alt/Option+←/→ and Ctrl+←/→ word jumps,
 * Ctrl+A/E line edges, Ctrl+W/Option+Backspace/Ctrl+U deletions), the
 * multi-line keys (Shift+Enter, Option+Enter, Ctrl+J) that must NEVER submit,
 * the caret-anchored window that keeps the decision rows and the hint on a
 * 24-row terminal, code-point safety, and the two protocol edges: plain
 * Enter sends the feedback as keep-planning, and Approve with a pending
 * feedback is refused instead of shipping a `custom` plan-mode would read as
 * "keep planning".
 *
 * Drives the real useInput path with fake stdin; output is captured raw and
 * ANSI-stripped (no xterm dependency beyond the headless emulator).
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { AskUserQuestionPanel }, { render }, { settle, settled, sleep, viewportLines, findText }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 24
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _e: BufferEncoding, cb: () => void) { cb() }
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

const question = {
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: '## Step 1\n\nDo the thing.',
  options: [
    { label: 'Approve', description: 'Leave plan mode.' },
    { label: 'Keep planning', description: 'Stay in plan mode.' },
  ],
  intent: { kind: 'plan-review' as const, approve: 'Approve' },
}

let lastAnswer: { selected?: string[]; custom?: string } | undefined
let cancelCount = 0
let app: { rerender(el: unknown): Promise<unknown>; unmount(): Promise<void> } | null = null
let seq = 0
async function mount(): Promise<void> {
  seq++
  lastAnswer = undefined
  const element = React.createElement(AskUserQuestionPanel, {
    key: `plan-review-editing-${seq}`,
    question,
    position: 1,
    total: 1,
    answered: 0,
    onAnswer: (selection: { selected?: string[]; custom?: string }) => { lastAnswer = selection },
    onCancel: () => { cancelCount++ },
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
  await settle(() => screen().includes('Approve') && screen().includes('Keep planning'))
}

/** One key group, then a pacing window: caret moves are not observable. */
async function feed(sequence: string): Promise<void> {
  stdin.write(sequence)
  await sleep(120) // 固定窗:pacing 按键分组之间，语义由下一次插入/提交断言
}

/** Type into the row and wait until the text is actually painted. */
async function type(text: string): Promise<void> {
  stdin.write(text)
  await settle(() => screen().includes(text))
  await sleep(80) // 固定窗:pacing 让插入后的 React 批次落定，再做下一组按键
}

const custom = (): string | undefined => lastAnswer?.custom
const selected = (): string[] => lastAnswer?.selected ?? []

async function submitAndRead(): Promise<void> {
  stdin.write('\r')
  await settled(() => lastAnswer !== undefined)
}

// ── 1. Ctrl+W deletes the previous word ─────────────────────────────
await mount()
await type('foo bar baz')
await feed('\x17')
await feed('Q')
await submitAndRead()
check('1: Ctrl+W deletes the previous word', custom() === 'foo bar Q', JSON.stringify(custom()))

// ── 2. Option+Backspace deletes the previous word ───────────────────
await mount()
await type('foo bar baz')
await feed('\x1b\x7f')
await submitAndRead()
check('2: Option+Backspace deletes the previous word', custom() === 'foo bar', JSON.stringify(custom()))

// ── 3. Ctrl+U deletes the line prefix; empty feedback keeps planning ─
await mount()
await type('one two')
await feed('\x15')
await submitAndRead()
check('3: Ctrl+U clears the line, an empty feedback is plain keep-planning',
  custom() === undefined && selected().includes('Keep planning'),
  JSON.stringify(lastAnswer))

// ── 4. Ctrl+A / Ctrl+E line edges ───────────────────────────────────
await mount()
await type('one two')
await feed('\x01')
await feed('X')
await submitAndRead()
check('4a: Ctrl+A moves the caret to the line start', custom() === 'Xone two', JSON.stringify(custom()))

await mount()
await type('one two')
await feed('\x01')
await feed('\x05')
await feed('Y')
await submitAndRead()
check('4b: Ctrl+E moves the caret to the line end', custom() === 'one twoY', JSON.stringify(custom()))

// ── 5. Word jumps: Alt+← (CSI), Ctrl+→ ──────────────────────────────
await mount()
await type('alpha beta gamma')
await feed('\x1b[1;3D')
await feed('X')
await submitAndRead()
check('5a: Alt+← jumps to the previous word start', custom() === 'alpha beta Xgamma', JSON.stringify(custom()))

await mount()
await type('alpha beta')
await feed('\x01')
await feed('\x1b[1;5C')
await feed('X')
await submitAndRead()
check('5b: Ctrl+→ steps to the next word start', custom() === 'alpha Xbeta', JSON.stringify(custom()))

// ── 6. Shift+Enter inserts a break and never submits ────────────────
await mount()
await type('one')
await feed('\x1b[13;2u')
await type('two')
const submittedByNewline = lastAnswer !== undefined
await submitAndRead()
check('6a: Shift+Enter inserts a newline and never submits',
  !submittedByNewline && custom() === 'one\ntwo', JSON.stringify(custom()))

// ── 7. Ctrl+J (CSI-u) inserts a break ───────────────────────────────
await mount()
await type('one')
await feed('\x1b[106;5u')
await type('two')
await submitAndRead()
check('7: Ctrl+J inserts a newline', custom() === 'one\ntwo', JSON.stringify(custom()))

// ── 8. Multi-line paint keeps the decisions and the hint on screen ──
await mount()
await type('one')
await feed('\x1b[13;2u')
await type('two')
const oneAt = findText(term, 'one')
const twoAt = findText(term, 'two')
const multiScreen = screen()
check('8: a multi-line feedback paints on separate rows',
  oneAt !== undefined && twoAt !== undefined && oneAt.row !== twoAt.row,
  `one=${JSON.stringify(oneAt)} two=${JSON.stringify(twoAt)}`)
check('8: the decision rows and the hint stay on screen',
  multiScreen.includes('Approve') && multiScreen.includes('Keep planning') && multiScreen.includes('↑/↓ 选择'))
if (!multiScreen.includes('Approve') || !multiScreen.includes('↑/↓ 选择')) {
  results.push(`      screen:\n${multiScreen}`)
}

// ── 9. The caret-anchored window scrolls the answer, not the card ───
await mount()
for (let line = 1; line <= 8; line++) {
  if (line > 1) await feed('\x1b[13;2u')
  await type(`ZZ${line}`)
}
const windowed = screen()
check('9a: the first lines scroll out of the painted window', !windowed.includes('ZZ1'), windowed)
check('9b: the caret line stays visible', windowed.includes('ZZ8'))
check('9c: the decision rows stay visible with a long answer',
  windowed.includes('Approve') && windowed.includes('Keep planning') && windowed.includes('↑/↓ 选择'))

// ── 10. Code-point safety: an emoji is one step ─────────────────────
await mount()
await type('beta 👍')
await feed('\x1b[1;3D')
await feed('X')
await submitAndRead()
check('10: word jump never splits an emoji',
  custom() === 'beta X👍' && !(custom() ?? '').includes('\uFFFD'), JSON.stringify(custom()))

// ── 11. Plain Enter sends the feedback as keep-planning ─────────────
await mount()
await type('please add tests')
await submitAndRead()
check('11: Enter sends the feedback as keep-planning',
  custom() === 'please add tests' && JSON.stringify(selected()) === JSON.stringify(['Keep planning']),
  JSON.stringify(lastAnswer))

// ── 12. Approve with pending feedback is refused ────────────────────
await mount()
await type('pending feedback')
await feed('\x1b[A') // ↑ to the option rows
await feed('\x1b[A') // ↑ to Approve
await feed('\r')
await sleep(150) // 固定窗:探针 断言「不得提交」，对已成立条件轮询会立即返回等于没测
check('12a: Approve with pending feedback does not submit', lastAnswer === undefined, JSON.stringify(lastAnswer))
check('12b: …and the panel names the reason', screen().includes('请先清空反馈再批准'), screen())

// ── 13. Esc still cancels ───────────────────────────────────────────
await mount()
const beforeCancel = cancelCount
await feed('\x1b')
check('13: Esc cancels the review', cancelCount === beforeCancel + 1)

await app?.unmount()
console.log(results.join('\n'))
term.dispose()
if (failures > 0) {
  console.log(`\n${failures} plan-review editing check(s) FAILED`)
  process.exit(1)
}
console.log('\nPlan-review answer field verified')
process.exit(0)
