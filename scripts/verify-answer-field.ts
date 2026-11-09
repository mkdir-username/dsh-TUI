/**
 * The shared answer-field contract, pinned as pure code-point math: word and
 * line motion, the ±1-line caret step, the paste cap/flatten rules, the
 * caret-anchored multi-line window, and the caret cell split.
 *
 * Run: node --import tsx/esm scripts/verify-answer-field.ts
 */
const field = await import('../src/components/questions/answerField.js')

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures += 1
}

const value = (text: string, cursor = [...text].length) => ({ text, cursor })

// ── Words: whitespace-delimited, code-point safe ─────────────────────
check('1a: wordStart walks to the previous word start', field.wordStart('alpha beta gamma', 16) === 11)
check('1b: wordEnd walks past the next word and its gap', field.wordEnd('alpha beta gamma', 0) === 6)
check('1c: caret and deletion step over an emoji as one code point',
  field.backspaceAt(value('a👍b', 2)).text === 'ab'
  && field.caretTo(value('👍', 2), 1).cursor === 1
  && field.insertAt(value('👍b', 0), 'X').text === 'X👍b')

check('1d: ←/→ step over a whole emoji',
  field.previousPoint('a👍b', 3) === 1 && field.nextPoint('a👍b', 1) === 3
  && field.previousPoint('a👍b', 0) === 0 && field.nextPoint('a👍b', 4) === 4)

// ── Lines: edges and the ±1-line caret step ──────────────────────────
check('2a: lineStart/lineEnd stay inside the caret line',
  field.lineStart('one\ntwo\nthree', 6) === 4 && field.lineEnd('one\ntwo\nthree', 6) === 7)
check('2b: lineStep keeps the column and clamps at short lines',
  field.lineStep('abcdef\nxy\nabcdef', 4, 1) === 9 && field.lineStep('abcdef\nxy\nabcdef', 9, -1) === 2)
check('2c: lineStep at the edges is a no-op', field.lineStep('one', 0, -1) === 0 && field.lineStep('one', 3, 1) === 3)

// ── Paste: flatten, cap, landing ─────────────────────────────────────
const flat = field.pasteInto(value('ab', 1), 'x\r\ny\tz', true)
check('3a: paste flattens newlines and controls to spaces', flat.outcome === 'ok' && flat.value.text === 'ax  y zb')
check('3b: a paste past the cap is refused, never truncated',
  field.pasteInto(value(''), 'x'.repeat(field.ANSWER_PASTE_MAX_POINTS + 1), true).outcome === 'too-long')
check('3c: a blank paste inserts nothing', field.pasteInto(value('ab'), ' \r\n ', true).outcome === 'empty')
check('3d: an option-row paste appends at the tail', field.pasteInto(value('ab', 0), 'Z', false).value.text === 'abZ')

// ── The multi-line window ────────────────────────────────────────────
const win = field.answerWindow([...'one\ntwo\nthree'], 9, 2)
check('4a: the window keeps the caret line and drops the opening newline',
  win.start === 4 && win.end === 13 && win.caret === 5)
check('4b: a short answer paints whole', (() => {
  const whole = field.answerWindow([...'one\ntwo'], 3, 6)
  return whole.start === 0 && whole.end === 7 && whole.caret === 3
})())

// ── The caret cell ───────────────────────────────────────────────────
const onNewline = field.caretSplit([...'ab\ncd'], 2, true)
check('5a: a caret on a newline closes the line with a blank cell',
  onNewline.head === 'ab' && onNewline.glyph === ' ' && onNewline.tail === '\ncd')
const atEnd = field.caretSplit([...'ab'], 2, true)
check('5b: a caret at the end is a blank cell with an empty tail',
  atEnd.head === 'ab' && atEnd.glyph === ' ' && atEnd.tail === '')
const idle = field.caretSplit([...'ab'], 1, false)
check('5c: an unfocused field keeps the caret character in the tail',
  idle.head === 'a' && idle.glyph === '▏' && idle.tail === 'b')

if (failures > 0) {
  console.log(`\n${failures} answer-field check(s) FAILED`)
  process.exit(1)
}
console.log('\nAnswer-field contract verified')
