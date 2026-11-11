/**
 * Questionnaire numbering + digit quick-pick regression.
 * Run: node --import tsx/esm scripts/verify-question-numbering.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { AskUserQuestionPanel }, { render }, { settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 30
let term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private readonly target: InstanceType<typeof XTerm>) {
    super()
  }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
    this.target.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
const stdin = new FakeStdin()
const screen = (): string => viewportLines(term, ROWS).join('\n')
const inputRow = (): string => screen().split('\n').find(line => line.includes('✎')) ?? ''

let answer: { selected?: string[]; custom?: string } | undefined
type AppLike = { unmount(): void }
let app: AppLike | null = null
let seq = 0

async function mount(question: unknown, ready: string): Promise<void> {
  seq += 1
  if (app !== null) {
    app.unmount()
    app = null
  }
  term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const element = React.createElement(AskUserQuestionPanel, {
    key: `numbering-${seq}`,
    question,
    position: 1,
    total: 1,
    answered: 0,
    onAnswer: (selection: { selected?: string[]; custom?: string }) => { answer = selection },
    onCancel: () => {},
  })
  app = await render(element, {
    stdout: new FakeStdout(term),
    stdin,
    stderr: new FakeStderr(),
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  }) as unknown as AppLike
  await settled(() => screen().includes(ready))
}

let failures = 0
function check(name: string, ok: boolean, extra?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || extra === undefined ? '' : ` — ${extra}`}`)
  if (!ok) failures += 1
}
const pickOne = (labels: string[]) => ({ question: 'Pick one', options: labels.map(label => ({ label })) })

// A1–A2: numbering + single-select quick-pick
await mount(pickOne(['Alpha', 'Beta', 'Gamma']), 'Pick one')
check('A1 options are numbered 1) 2) 3)',
  screen().includes('1)') && screen().includes('2)') && screen().includes('3)'), screen())
stdin.write('2')
check('A2 digit 2 answers Beta immediately',
  await settled(() => answer?.selected?.[0] === 'Beta'), JSON.stringify(answer))

// A3–A5: multi-select toggles
answer = undefined
await mount({ question: 'Pick many', multiSelect: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] }, 'Pick many')
stdin.write('1')
check('A3 digit 1 checks Alpha', await settled(() => screen().includes('[✓]')), screen())
stdin.write('1')
check('A4 digit 1 again unchecks Alpha', await settled(() => !screen().includes('[✓]')), screen())
stdin.write('1')
await settled(() => screen().includes('[✓]'))
stdin.write('\r')
check('A5 Enter submits the digit-checked set',
  await settled(() => answer?.selected?.[0] === 'Alpha'), JSON.stringify(answer))

// A6–A7: pending text keeps digits as text
answer = undefined
await mount(pickOne(['Alpha', 'Beta', 'Gamma']), 'Pick one')
stdin.write('note ')
await settled(() => screen().includes('note'))
stdin.write('2')
check('A6 pending text keeps the digit as text',
  await settled(() => screen().includes('note 2')), screen())
check('A7 pending-text digit does not submit', answer === undefined, JSON.stringify(answer))

// A8: the answer row itself always types digits
answer = undefined
await mount(pickOne(['Alpha', 'Beta']), 'Pick one')
stdin.write('\t')
await sleep(120) // 固定窗:pacing 等焦点落到输入行
stdin.write('2')
check('A8a digit lands in the answer field', await settled(() => inputRow().includes('2')), inputRow())
stdin.write('\r')
check('A8b the typed digit is the custom answer',
  await settled(() => answer?.custom === '2'), JSON.stringify(answer))

// A9–A10: numbers beyond 9 render; 1–9 still pick
answer = undefined
await mount({ question: 'Pick one', hideCustomInput: true, options: Array.from({ length: 12 }, (_, i) => ({ label: `Opt ${i + 1}` })) }, 'Pick one')
check('A9 numbers reach 10) 11) 12)',
  ['10)', '11)', '12)'].every(number => screen().includes(number)), screen())
stdin.write('9')
check('A10a digit 9 answers the ninth option',
  await settled(() => answer?.selected?.[0] === 'Opt 9'), JSON.stringify(answer))
check('A10b digit 9 leaves the ninth row focused and visible',
  await settled(() => screen().split('\n').some(line => line.includes('Opt 9') && line.includes('❯'))), screen())

// A11: a windowed list keeps the digit-picked row visible
answer = undefined
await mount({
  question: 'Pick provider',
  hideCustomInput: true,
  options: Array.from({ length: 36 }, (_, i) => ({
    label: `Provider ${String(i + 1).padStart(2, '0')}`,
    description: 'desc',
  })),
}, 'Pick provider')
stdin.write('9')
check('A11a digit 9 answers in a windowed list',
  await settled(() => answer?.selected?.[0] === 'Provider 09'), JSON.stringify(answer))
check('A11b the picked row stays visible in a windowed list',
  await settled(() => screen().split('\n').some(line => line.includes('Provider 09') && line.includes('❯'))), screen())

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('question numbering: all checks passed')
