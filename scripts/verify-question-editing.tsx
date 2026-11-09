/**
 * Questionnaire answer-field editing regression: the free-text row of the
 * ask_user_question panel must take the same terminal editing keys the
 * composer and the launchpad already carry on macOS —
 *
 *  - word jumps: Alt/Option+←/→ (`\x1b[1;3D/C`, and Ghostty's literal
 *    ESC b / ESC f), Ctrl+←/→ (`\x1b[1;5D/C`);
 *  - line edges: Ctrl+A/E (`\x01`/`\x05`) and Home/End, line-scoped once an
 *    answer spans several lines;
 *  - deletions: Ctrl+W (`\x17`) and Option+Backspace (`\x1b\x7f`, plus the
 *    CSI-u/legacy-meta spellings) take the previous word, Ctrl+U takes the
 *    line prefix;
 *  - caret motion between lines: Ctrl+↑/↓ (`\x1b[1;5A/B`), while plain ↑/↓
 *    keep navigating the option list and Alt+↑/↓ keep scrolling the body;
 *  - newlines: Shift+Enter (`\x1b[13;2u`), Option+Enter (`\x1b\r`) and
 *    Ctrl+J (`\x1b[106;5u`) insert a break and NEVER submit; a bare Enter
 *    still submits and Ctrl+K stays the panel fold;
 *  - a multi-line answer paints a caret-anchored window (the option list and
 *    the key hint must stay on screen), and a secret answer masks its points
 *    while keeping the breaks.
 *
 * Drives the real useInput path with fake stdin; output is captured raw and
 * ANSI-stripped (no xterm dependency beyond the headless emulator).
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh' // 中文文案断言必须在 i18n import 前固定语言。

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { AskUserQuestionPanel }, { render }, { settle, settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/ui.js'),
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
/** The real terminal screen, line by line. */
function screen(): string {
  return viewportLines(term, ROWS).join('\n')
}

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, extra?: string) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures++
    if (extra !== undefined) results.push(`      actual: ${extra.slice(0, 300)}`)
  }
}

let lastAnswer: unknown = undefined
let cancelCount = 0
let backCount = 0
let forwardCount = 0
let foldCount = 0
let mountSeq = 0
type AppLike = { rerender(el: unknown): unknown; unmount(): void }
let app: AppLike | null = null

/** (Re)mount a fresh panel (new key → fresh instance + fresh editing state). */
async function mount(
  question: unknown,
  extras: { onBack?: boolean; onForward?: boolean; onToggleFold?: boolean } = {},
): Promise<void> {
  mountSeq++
  const element = React.createElement(AskUserQuestionPanel, {
    key: `editing-q${mountSeq}`,
    question,
    position: 1,
    total: 1,
    answered: 0,
    onAnswer: (selection: unknown) => { lastAnswer = selection },
    onCancel: () => { cancelCount++ },
    ...(extras.onBack === true ? { onBack: () => { backCount++ } } : {}),
    ...(extras.onForward === true ? { onForward: () => { forwardCount++ } } : {}),
    ...(extras.onToggleFold === true ? { onToggleFold: () => { foldCount++ } } : {}),
  })
  if (app === null) {
    app = await render(element, {
      stdout,
      stdin,
      stderr: new FakeStderr(),
      debug: true,
      exitOnCtrlC: false,
    }) as unknown as AppLike
  } else {
    await app.rerender(element)
  }
}

/** One key group, then a pacing window: caret moves are not observable. */
async function feed(sequence: string): Promise<void> {
  stdin.write(sequence)
  await sleep(120) // 固定窗:pacing 按键分组之间，语义由下一次插入/提交断言
}

const answerCustom = (): string | undefined => {
  const answer = lastAnswer as { selected?: string[]; custom?: string } | undefined
  return answer?.custom
}
const answerSelected = (): string[] => {
  const answer = lastAnswer as { selected?: string[] } | undefined
  return answer?.selected ?? []
}
const textQuestion = { question: '还有别的要说吗？' }
const optionQuestion = {
  question: '你有 API Key 吗？',
  options: [{ label: '我有' }, { label: '我没有' }],
}

// ── 1. Word jumps: Alt+← (xterm CSI), Ctrl+←, and Ghostty's ESC b. ─────
for (const [label, sequence] of [
  ['Alt+← (CSI meta)', '\x1b[1;3D'],
  ['Ctrl+← (CSI ctrl)', '\x1b[1;5D'],
  ['Ghostty ESC b', '\x1bb'],
] as const) {
  lastAnswer = undefined
  await mount(textQuestion)
  await settle(() => screen().includes('还有别的要说吗？'))
  stdin.write('alpha beta gamma')
  await settle(() => screen().includes('alpha beta gamma'))
  await feed(sequence)
  await feed('X')
  stdin.write('\r')
  check(`1[${label}]: caret lands on the previous word start`,
    await settled(() => answerCustom() === 'alpha beta Xgamma'), JSON.stringify(answerCustom()))
}

// ── 2. Word jumps forward: Ctrl+→ from the text head walks one word. ──
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('alpha beta')
await settle(() => screen().includes('alpha beta'))
stdin.write('\x01') // Ctrl+A → line start
await sleep(120) // 固定窗:pacing 光标移动不可观测
await feed('\x1b[1;5C') // Ctrl+→ → the NEXT word's start (readline alt+F)
await feed('X')
stdin.write('\r')
check('2a: Ctrl+→ steps to the next word start (readline alt+F)',
  await settled(() => answerCustom() === 'alpha Xbeta'), JSON.stringify(answerCustom()))

// ── 2b. Ctrl+E goes to the line end, Home/End are line-scoped. ────────
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('one')
await feed('\x1b[13;2u') // Shift+Enter → newline
stdin.write('two')
await settle(() => screen().includes('two'))
stdin.write('\x01') // Ctrl+A → start of "two"
await sleep(120) // 固定窗:pacing
await feed('X')
await feed('\x1b[F') // End → end of "two" (line-scoped)
await feed('Y')
await feed('\x1b[H') // Home → start of "two" again
await feed('Z')
stdin.write('\r')
check('2b: Ctrl+A/Home/End are line-scoped in a multi-line answer',
  await settled(() => answerCustom() === 'one\nZXtwoY'), JSON.stringify(answerCustom()))

// ── 3. Deletions: Ctrl+W, Option+Backspace, Ctrl+U. ───────────────────
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('foo bar baz')
await settle(() => screen().includes('foo bar baz'))
await feed('\x17') // Ctrl+W
await feed('Q')
stdin.write('\r')
check('3a: Ctrl+W deletes the previous word',
  await settled(() => answerCustom() === 'foo bar Q'), JSON.stringify(answerCustom()))

lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('foo bar baz')
await settle(() => screen().includes('foo bar baz'))
await feed('\x1b\x7f') // Option+Backspace (ESC DEL)
await feed('Q')
stdin.write('\r')
check('3b: Option+Backspace deletes the previous word',
  await settled(() => answerCustom() === 'foo bar Q'), JSON.stringify(answerCustom()))

lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('left right')
await settle(() => screen().includes('left right'))
await feed('\x15') // Ctrl+U → delete "left right" from the line start
stdin.write('tail')
await sleep(120) // 固定窗:pacing 提交与输入分开送达（一个 chunk 的 text+CR 是管道行契约，不是本用例）
stdin.write('\r')
check('3c: Ctrl+U deletes to the line start only',
  await settled(() => answerCustom() === 'tail'), JSON.stringify(answerCustom()))

// ── 4. Newlines never submit; the answer carries the break. ───────────
for (const [label, sequence] of [
  ['Shift+Enter (CSI-u)', '\x1b[13;2u'],
  ['Option+Enter (ESC CR)', '\x1b\r'],
  ['Ctrl+J (CSI-u)', '\x1b[106;5u'],
] as const) {
  lastAnswer = undefined
  await mount(textQuestion)
  await settle(() => screen().includes('还有别的要说吗？'))
  stdin.write('first')
  await settle(() => screen().includes('first'))
  await feed(sequence)
  stdin.write('second')
  await sleep(250) // 固定窗:探针 — a submit would leave no panel state to poll
  check(`4[${label}]: the newline does not submit`, lastAnswer === undefined, JSON.stringify(lastAnswer))
  stdin.write('\r')
  check(`4[${label}]: Enter submits the two-line answer`,
    await settled(() => answerCustom() === 'first\nsecond'), JSON.stringify(answerCustom()))
}

// ── 5. Ctrl+↑/↓ move the caret; plain ↑/↓ still navigate the list. ────
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('upper')
await feed('\x1b[13;2u')
stdin.write('lower')
await settle(() => screen().includes('lower'))
await feed('\x1b[1;5A') // Ctrl+↑ → the "upper" line, same column
await feed('X')
stdin.write('\r')
check('5a: Ctrl+↑ moves the caret to the previous line at the same column',
  await settled(() => answerCustom() === 'upperX\nlower'), JSON.stringify(answerCustom()))

lastAnswer = undefined
await mount(optionQuestion)
await settle(() => screen().includes('你有 API Key 吗？'))
stdin.write('\t') // focus the custom answer row
await sleep(120) // 固定窗:pacing 等焦点落到输入行
await feed('\x1b[A') // plain ↑ → back to the last option
stdin.write('\r')
check('5b: plain ↑ still navigates the option list (the answer is the option)',
  await settled(() => answerSelected()[0] === '我没有' && answerCustom() === undefined),
  JSON.stringify(lastAnswer))

// ── 6. Plain ← at the head still switches to the previous question. ───
lastAnswer = undefined
backCount = 0
await mount(textQuestion, { onBack: true })
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('\x1b[D') // ← at caret 0
check('6a: plain ← at the text head still goes to the previous question',
  await settled(() => backCount === 1), String(backCount))
check('6b: the switch does not answer the panel', lastAnswer === undefined)

// ── 7. Ctrl+K stays the panel fold, never a kill-line. ────────────────
lastAnswer = undefined
foldCount = 0
await mount(textQuestion, { onToggleFold: true })
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('keep me')
await settle(() => screen().includes('keep me'))
await feed('\x0b') // Ctrl+K → fold
check('7a: Ctrl+K folds the panel', await settled(() => foldCount === 1), String(foldCount))

// ── 8. A long answer paints a caret-anchored window: the option list and
//       the hint stay on screen, the caret's own line is visible. ─────
lastAnswer = undefined
await mount(optionQuestion)
await settle(() => screen().includes('你有 API Key 吗？'))
stdin.write('\t') // focus the custom answer row
await sleep(120) // 固定窗:pacing 等焦点落到输入行
for (let line = 1; line <= 8; line++) {
  stdin.write(`L${line}`)
  await sleep(60) // 固定窗:pacing 每行按键，否则同 chunk 合并
  if (line < 8) await feed('\x1b[13;2u')
}
check('8a: the caret line stays painted in the window',
  await settled(() => screen().includes('L8')), screen())
check('8b: the first lines scroll out of the field window',
  !screen().includes('L1') && screen().includes('L3'), screen())
check('8c: the key hint survives a long answer', screen().includes('Enter 提交'), screen())
check('8d: the option list survives a long answer', screen().includes('我有'), screen())
for (let step = 0; step < 7; step++) await feed('\x1b[1;5A') // Ctrl+↑ back to the first line
await feed('M')
check('8e: the window follows the caret back to the first line',
  await settled(() => screen().includes('L1M') && !screen().includes('L8')), screen())

// ── 9. A secret answer masks its points but keeps the line break. ─────
lastAnswer = undefined
await mount({ question: '口令是什么？', secret: true })
await settle(() => screen().includes('口令是什么？'))
stdin.write('top secret')
await settle(() => screen().includes('••••••••••'))
await feed('\x1b[13;2u')
stdin.write('tail')
await sleep(250) // 固定窗:探针
check('9a: a secret newline does not submit', lastAnswer === undefined, JSON.stringify(lastAnswer))
check('9b: the secret stays masked (mask kept per code point, break included)',
  !screen().includes('top secret') && screen().includes('••••'), screen())
stdin.write('\r')
check('9c: the submitted secret keeps the raw newline',
  await settled(() => answerCustom() === 'top secret\ntail'), JSON.stringify(answerCustom()))

// ── 10. A one-line answer still submits with a bare Enter (regression). ─
lastAnswer = undefined
await mount(textQuestion)
await settle(() => screen().includes('还有别的要说吗？'))
stdin.write('plain answer')
await settle(() => screen().includes('plain answer'))
stdin.write('\r')
check('10a: a bare Enter still submits a one-line answer',
  await settled(() => answerCustom() === 'plain answer'), JSON.stringify(answerCustom()))

app?.unmount()
await sleep(100) // 固定窗:pacing 等卸载收尾写完，无可观测完成条件
console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
