/**
 * Rewind picker layout regression: two-line checkpoints, real hidden
 * counters, adaptive viewport, width-aware previews.
 * Run: node --import tsx/esm scripts/verify-rewind-layout.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { RewindPicker }, { render }, { settled, viewportLines }, { stringWidth }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/components/RewindPicker.js'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/stringWidth.js'),
])

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
const stdin = new FakeStdin()
let term = new XTerm({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true })
type AppLike = { unmount(): void }
let app: AppLike | null = null
let failures = 0

const check = (name: string, ok: boolean, extra?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || extra === undefined ? '' : ` — ${extra.slice(0, 300)}`}`)
  if (!ok) failures += 1
}
const lines = (): string[] => viewportLines(term)
const screen = (): string => lines().join('\n')
const lineIndex = (needle: string): number => lines().findIndex(line => line.includes(needle))

type PickerProps = React.ComponentProps<typeof RewindPicker>

async function mount(cols: number, rows: number, props: Partial<PickerProps>): Promise<void> {
  if (app !== null) {
    app.unmount()
    app = null
  }
  term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class Out extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    constructor(private readonly target: InstanceType<typeof XTerm>) { super() }
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
      this.target.write(String(chunk), cb)
    }
  }
  class Err extends Writable {
    isTTY = true
    _write(_chunk: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
  }
  const element = React.createElement(RewindPicker, {
    rows: [], focusIndex: 0, confirmRow: null, ...props,
  })
  app = await render(element, {
    stdout: new Out(term),
    stdin,
    stderr: new Err(),
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  }) as unknown as AppLike
  await settled(() => screen().includes('Rewind'))
}

const rows = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  kind: 'user' as const,
  text: `Message ${String(40 - i).padStart(2, '0')}`,
}))
const visibleCount = (): number => lines().filter(line => /Message \d\d/.test(line)).length

// B1–B7: 30 rows, newest checkpoint focused
await mount(100, 30, { rows, focusIndex: 0 })
const y0 = lineIndex('Message 40')
check('B1 title is rendered', screen().includes('Rewind'), screen())
check('B2 focused row carries the pointer', (lines()[y0] ?? '').includes('❯'), lines()[y0])
check('B3 metadata line follows the message', (lines()[y0 + 1] ?? '').includes('last message')
  && (lines()[y0 + 1] ?? '').includes('40 of 40'), lines()[y0 + 1])
check('B4 a blank gap separates checkpoints', (lines()[y0 + 2] ?? '').trim() === ''
  && (lines()[y0 + 3] ?? '').includes('Message 39'), `${JSON.stringify(lines()[y0 + 2])} / ${lines()[y0 + 3]}`)
check('B5 hidden rows below are counted', screen().includes(`↓ ${40 - visibleCount()} more`),
  `${40 - visibleCount()} / ${screen()}`)
check('B6 no above-counter at the top', !screen().includes('↑'), screen())
check('B7 footer stays under the list', screen().includes('Enter to select') && screen().includes('Esc to exit'), screen())

// B8: a middle focus shows both counters and keeps the row visible
await mount(100, 30, { rows, focusIndex: 20 })
check('B8a middle focus shows both counters', screen().includes('↑') && screen().includes('↓'), screen())
check('B8b the focused checkpoint is visible',
  (lines().find(line => line.includes('Message 20')) ?? '').includes('❯'), screen())

// B9: the oldest message hides the below-counter
await mount(100, 30, { rows, focusIndex: 39 })
check('B9 oldest focus counts hidden rows above only',
  screen().includes('↑') && !screen().includes('↓'), screen())

// B10: narrow terminal: no line is wider than the screen
await mount(40, 30, { rows, focusIndex: 0 })
check('B10 narrow columns do not overflow',
  lines().every(line => stringWidth(line) <= 40), String(Math.max(...lines().map(stringWidth))))

// B11: unicode preview truncates by display cells
const unicodeRows = [{ id: 1, kind: 'user' as const, text: 'Привет 世界 🚀 '.repeat(20) }]
await mount(40, 30, { rows: unicodeRows, focusIndex: 0 })
check('B11 unicode preview stays inside the width',
  lines().every(line => stringWidth(line) <= 40), String(Math.max(...lines().map(stringWidth))))

// B12–B13: short terminal keeps the title, one checkpoint and the footer
await mount(100, 16, { rows, focusIndex: 0 })
check('B12 short terminal keeps title, a checkpoint and the footer',
  screen().includes('Rewind') && screen().includes('Message 40') && screen().includes('Enter to select'), screen())
check('B13 short terminal stays inside the screen',
  lines().filter(line => line.trim() !== '').length <= 16, screen())

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('rewind layout: list checks passed')
