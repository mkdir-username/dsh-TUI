/**
 * Regression: while the `/` completion menu is open, ↑/↓ move the LIST — the
 * draft's caret never moves.
 *
 * Contract (`docs/interaction.en.md`, `Up/Down` row: "Select menu items; in
 * ordinary input, browse history or move through multiline text"; and
 * `docs/contributing.en.md`, Interaction And Commands: "The prompt owns text
 * editing only when no overlay is active").
 *
 * Real drafts are rarely one plain line: Shift+Enter makes them multiline, and
 * a paste of ≥6 lines / ≥600 chars folds into an atomic `▸ 12 lines・…` block.
 * The arrow handler used to run the fold-block and caret branches BEFORE the
 * menu branch, so in those drafts the key moved the caret instead: it stepped
 * out of the `/…` run, the menu closed, and the next press stepped back and
 * reopened it — the selected row never moved (the reported "the bar in the
 * input moves, the list does not").
 *
 * Each case boots its own process: instances of the headless renderer share
 * the process-level alt-screen state, and a second instance's first frame can
 * land on the previous one's border row (see verify-command-completion).
 *
 * Reverse check: put the menu branch back after the caret branches in
 * `PromptInput.tsx` — the multiline and fold-block cases go red: the card
 * disappears and the declared caret jumps (fold block: from the tail end back
 * to the block head, i.e. the reported "the bar in the input moves").
 *
 * Run: `node --import tsx/esm scripts/verify-command-menu-arrows.tsx`
 */
import './lib/fake-home.mjs' // must stay first: DATA_DIR resolves at import time

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'

const { spawnSync } = await import('node:child_process')
const { fileURLToPath } = await import('node:url')

const ROWS = 30
const COLUMNS = 100
/** The catalog from the reported screen: `/mode` matches all five. */
const COMMANDS = [
  { name: 'model', description: 'Show the active model' },
  { name: 'demo-video', description: 'Project demo video' },
  { name: 'memory-undo-rule', description: 'Undo a generated rule' },
  { name: 'deep-modules', description: 'Module surface analysis' },
  { name: 'module-decompose', description: 'Split a module in place' },
]
const PASTED = Array.from({ length: 12 }, (_unused, index) => `pasted line ${index + 1} of the audit note`).join('\n')
/** The tail of the reported draft: a sentence followed by the `/mode` run. */
const TAIL = ' Deep grill holds up, the infrastructure is critical + MUST use /mode'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, Box },
  { PromptInput },
  { completeCommands },
  { settle, settled, viewportLines },
  instances,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/instances.js').then(module => module.default),
])

/** Composer stub: the command catalog only, no running turn. */
function makeChannel() {
  const runs: string[] = []
  const submitted: string[] = []
  return {
    working: false,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: COMMANDS,
    commandCompletions: (input: string) => completeCommands(input, COMMANDS),
    notifications: [],
    pending: [],
    contextWindow: undefined,
    ready: true,
    notify() {},
    submit(text: string) { submitted.push(text) },
    steer(text: string) { submitted.push(text) },
    removePending() { return false },
    cancel() {},
    interruptAndDeliver() { return 0 },
    listFiles: async () => [],
    runs,
    submitted,
  }
}

async function boot() {
  const term = new XTerm({ cols: COLUMNS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      term.write(String(chunk), callback)
    },
  })
  stdout.columns = COLUMNS
  stdout.rows = ROWS
  stdout.isTTY = true
  const stderr = new Writable({ write: (_chunk, _encoding, callback) => { callback() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const channel = makeChannel()
  // The card grows UP from the composer (`OverlayAbove bottom:'100%'`), so the
  // prompt needs the screen bottom or a bare render clips the card at the top.
  const tree = React.createElement(
    AlternateScreen,
    null,
    React.createElement(
      Box,
      { flexDirection: 'column', height: '100%' },
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: (name: string) => { channel.runs.push(name); return true },
        selectionActive: false,
      }),
    ),
  )
  const instance = await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })
  const ink = instances.get(stdout)
  instances.set(process.stdout, ink)
  instance.rerender(tree)
  ink?.setAltScreenActive(true, true)
  // The app declares the terminal cursor on the caret, so its cell is the
  // caret's position: an arrow that must not move the caret must leave this
  // pair untouched (no fixed-window wait needed to see a caret move).
  const caret = (): { x: number, y: number } => ({
    x: term.buffer.active.cursorX,
    y: term.buffer.active.cursorY,
  })
  return { stdin, channel, instance, lines: () => viewportLines(term), caret }
}

/** Frame row of the folded-paste chip (`▸ 12 lines・…`); -1 = no block. */
function chipRow(lines: readonly string[]): number {
  return lines.findIndex(line => line.includes('▸ ') && line.includes(' lines'))
}

/** The card is up: its title row or the `│ ❯ name` selected row is painted. */
function cardOpen(lines: readonly string[]): boolean {
  return lines.some(line => line.includes('commands · '))
    || lines.some(line => /^\u2502\s+\u276f\s+\S/u.test(line))
}

/** Name of the selected card row (`│ ❯ name …`). */
function selectedName(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /^\u2502\s+\u276f\s+(\S+)/u.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

/** True when some frame row shows `text` (box fill read back as blanks). */
function draftHas(lines: readonly string[], text: string): boolean {
  return lines.some(line => line.replace(/─/gu, ' ').includes(text))
}

/** Row of the composer line carrying the expand affordance. */
function composerRow(lines: readonly string[]): number {
  return lines.findIndex(line => line.includes('⛶'))
}

/** Sentinel typed after an arrow: it lands wherever the caret really is. */
function sentinelAboveChip(lines: readonly string[], sentinel: string): boolean {
  const at = lines.findIndex(line => line.includes(sentinel))
  const chip = chipRow(lines)
  return at >= 0 && chip >= 0 && at < chip
}

/** Fresh composer per case (see the header note on shared alt-screen state). */
async function withComposer(run: (composer: Awaited<ReturnType<typeof boot>>) => Promise<void>): Promise<void> {
  const composer = await boot()
  try {
    await run(composer)
  } finally {
    composer.instance.unmount()
  }
}

const CASES = {
  /** Baseline: a single-line draft already handed the arrows to the menu. */
  async 'single-line'(): Promise<void> {
    await withComposer(async composer => {
      composer.stdin.write('/')
      check('single line: `/` opens the menu',
        await settled(() => cardOpen(composer.lines())),
        JSON.stringify(composer.lines().filter(line => line.includes('❯'))))
      const before = composer.lines()
      const selectedBefore = selectedName(before)
      const inputRow = composerRow(before)
      const inputBefore = inputRow < 0 ? '' : before[inputRow]
      const caretBefore = composer.caret()
      composer.stdin.write('\x1b[B')
      check('single line: down moves to the next item',
        await settled(() => {
          const now = selectedName(composer.lines())
          return now !== undefined && now !== selectedBefore
        }),
        JSON.stringify({ before: selectedBefore, after: selectedName(composer.lines()) }))
      const after = composer.lines()
      check('single line: down leaves the input row untouched',
        inputRow >= 0 && after[inputRow] === inputBefore,
        JSON.stringify({ before: inputBefore, after: after[inputRow] }))
      check('single line: down does not move the caret',
        composer.caret().x === caretBefore.x && composer.caret().y === caretBefore.y,
        JSON.stringify({ before: caretBefore, after: composer.caret() }))
    })
  },

  /** Multiline draft: ↑ used to walk the caret to the previous line. */
  async multiline(): Promise<void> {
    await withComposer(async composer => {
      composer.stdin.write('line one\x1b[13;2u')
      composer.stdin.write('run /')
      check('multiline: the run on the caret line opens the menu',
        await settled(() => cardOpen(composer.lines())),
        JSON.stringify(composer.lines().filter(line => line.includes('run') || line.includes('commands'))))
      const selectedBefore = selectedName(composer.lines())
      const caretBefore = composer.caret()
      composer.stdin.write('\x1b[A')
      check('multiline: up moves the list and keeps the menu open',
        await settled(() => cardOpen(composer.lines())
          && selectedName(composer.lines()) !== undefined
          && selectedName(composer.lines()) !== selectedBefore),
        JSON.stringify({ before: selectedBefore, after: selectedName(composer.lines()) }))
      check('multiline: up does not move the caret',
        composer.caret().x === caretBefore.x && composer.caret().y === caretBefore.y,
        JSON.stringify({ before: caretBefore, after: composer.caret() }))
      composer.stdin.write('Z')
      check('multiline: the caret stays on its line after up',
        await settled(() => draftHas(composer.lines(), 'run /Z')),
        JSON.stringify(composer.lines().filter(line => line.includes('line one') || line.includes('run'))))
    })
  },

  /** The reported screen: a folded paste chip plus a `/mode` tail. */
  async 'fold-block'(): Promise<void> {
    await withComposer(async composer => {
      composer.stdin.write(`\x1b[200~${PASTED}\x1b[201~`)
      check('fold block: the paste folds into a `▸ N lines` chip',
        await settled(() => chipRow(composer.lines()) >= 0),
        JSON.stringify(composer.lines().filter(line => line.includes('▸'))))
      composer.stdin.write(TAIL)
      check('fold block: the `/mode` tail opens the menu',
        await settled(() => cardOpen(composer.lines())),
        JSON.stringify(composer.lines().filter(line => line.includes('mode') || line.includes('commands'))))
      const selectedBefore = selectedName(composer.lines())
      const chipBefore = chipRow(composer.lines())
      const caretBefore = composer.caret()
      composer.stdin.write('\x1b[A')
      check('fold block: up moves the list, the menu stays open, the caret stays put',
        await settled(() => cardOpen(composer.lines())
          && selectedName(composer.lines()) !== undefined
          && selectedName(composer.lines()) !== selectedBefore),
        JSON.stringify({
          before: selectedBefore,
          after: selectedName(composer.lines()),
          open: cardOpen(composer.lines()),
        }))
      check('fold block: up does not move the caret',
        composer.caret().x === caretBefore.x && composer.caret().y === caretBefore.y,
        JSON.stringify({ before: caretBefore, after: composer.caret() }))
      check('fold block: the chip and the tail text are untouched by up',
        chipRow(composer.lines()) === chipBefore && draftHas(composer.lines(), '/mode'),
        JSON.stringify({ chipBefore, chipAfter: chipRow(composer.lines()) }))
      composer.stdin.write('Z')
      check('fold block: the caret stays at the tail after up',
        await settled(() => draftHas(composer.lines(), '/modeZ')),
        JSON.stringify(composer.lines().filter(line => line.includes('mode') || line.includes('pasted line 1'))))
    })
  },

  /** Wrap-around is unchanged: a full cycle returns to the same row. */
  async wrap(): Promise<void> {
    await withComposer(async composer => {
      composer.stdin.write('/')
      await settled(() => cardOpen(composer.lines()))
      const start = selectedName(composer.lines())
      composer.stdin.write('\x1b[A'.repeat(COMMANDS.length))
      check('up wraps the list back to the same item',
        await settled(() => selectedName(composer.lines()) === start),
        JSON.stringify({ start, after: selectedName(composer.lines()) }))
    })
  },

  /** Without a menu the fold-block caret walk must keep working. */
  async 'fold-block-caret'(): Promise<void> {
    await withComposer(async composer => {
      composer.stdin.write(`\x1b[200~${PASTED}\x1b[201~`)
      await settled(() => chipRow(composer.lines()) >= 0)
      composer.stdin.write('\x1b[A')
      // The declared caret is the observable completion of the move: the
      // caret leaves the tail and lands on the row above the chip.
      await settle(() => composer.caret().y < chipRow(composer.lines()))
      composer.stdin.write('Q')
      check('no menu: up still steps the caret onto the block head',
        await settled(() => sentinelAboveChip(composer.lines(), 'Q')),
        JSON.stringify(composer.lines().filter(line => line.includes('Q') || line.includes('▸'))))
    })
  },

  /** Esc closes the menu; the next arrow edits the draft again. */
  async escape(): Promise<void> {
    await withComposer(async composer => {
      composer.stdin.write(`\x1b[200~${PASTED}\x1b[201~`)
      await settled(() => chipRow(composer.lines()) >= 0)
      composer.stdin.write(TAIL)
      await settled(() => cardOpen(composer.lines()))
      composer.stdin.write('\x1b')
      check('Esc closes only the menu, the draft and the chip stay',
        await settled(() => !cardOpen(composer.lines()) && draftHas(composer.lines(), '/mode')),
        JSON.stringify(composer.lines().filter(line => line.includes('mode') || line.includes('commands'))))
      composer.stdin.write('\x1b[A')
      await settle(() => composer.caret().y < chipRow(composer.lines()))
      composer.stdin.write('Q')
      check('after Esc up edits the draft again',
        await settled(() => sentinelAboveChip(composer.lines(), 'Q')),
        JSON.stringify(composer.lines().filter(line => line.includes('Q') || line.includes('▸'))))
    })
  },
} satisfies Record<string, () => Promise<void>>

const caseId = process.argv[2]
if (caseId !== undefined) {
  const run = CASES[caseId as keyof typeof CASES]
  if (run === undefined) {
    console.error(`unknown case: ${caseId} (known: ${Object.keys(CASES).join(', ')})`)
    process.exit(2)
  }
  await run()
  console.log(failed === 0 ? `case ${caseId} OK` : `case ${caseId}: ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

// Parent: one process per case, so no case sees another one's alt-screen
// leftovers. Output is relayed verbatim; a child's non-zero exit is a failure.
const self = fileURLToPath(import.meta.url)
for (const name of Object.keys(CASES)) {
  const child = spawnSync(process.execPath, ['--import', 'tsx/esm', self, name], {
    encoding: 'utf8',
    env: process.env,
  })
  // The child's unmount leaves terminal control sequences on its stdout; keep
  // the checks readable and drop the rest.
  const stripAnsi = (text: string): string => text
    .replace(/\x1b\[[0-9;?<>=]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[=>]/gu, '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .join('\n')
  const output = stripAnsi(`${child.stdout ?? ''}${child.stderr ?? ''}`)
  if (output !== '') console.log(output)
  if (child.status !== 0) failed += 1
}
console.log(failed === 0 ? 'verify-command-menu-arrows OK' : `verify-command-menu-arrows: ${failed} case(s) failed`)
process.exit(failed === 0 ? 0 : 1)
