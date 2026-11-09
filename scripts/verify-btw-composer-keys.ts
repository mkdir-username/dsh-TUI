/**
 * BtwComposer key contract: the btw thread's ask box is a single-line field
 * whose draft lives in the thread store (shared by the side panel and the
 * fullscreen scene), so it consumes the shared answer-field CORE
 * (src/components/questions/answerField.ts) instead of the React hook.
 *
 * Pins the macOS/readline layer (Alt/Ctrl+←/→ word jumps, Ctrl+A/E, Ctrl+W /
 * Option+Backspace, Ctrl+U), the forward Delete, code-point stepping, and the
 * existing single-line rules (Esc/Tab/↑ exit focus, plain Enter submits,
 * Shift+←/→ stay with the host, a pasted line-break chunk is text).
 *
 * Run: node --import tsx/esm scripts/verify-btw-composer-keys.ts
 */
const { btwComposerKey } = await import('../src/components/sidePanel/btw/BtwComposer.js')

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures += 1
}

type State = { text: string; caret: number }
type Key = Record<string, boolean>
const stateOf = (result: { state?: State } | null): State | undefined => result?.state

// ── Word jumps ───────────────────────────────────────────────────────
check('1a: Alt+← jumps to the previous word start',
  stateOf(btwComposerKey({ text: 'alpha beta gamma', caret: 16 }, '', { meta: true, leftArrow: true }))?.caret === 11)
check('1b: Ctrl+← jumps to the previous word start',
  stateOf(btwComposerKey({ text: 'alpha beta gamma', caret: 16 }, '', { ctrl: true, leftArrow: true }))?.caret === 11)
check('1c: Ctrl+→ jumps to the next word start',
  stateOf(btwComposerKey({ text: 'alpha beta', caret: 0 }, '', { ctrl: true, rightArrow: true }))?.caret === 6)
check('1d: Ghostty ESC b is a word jump',
  stateOf(btwComposerKey({ text: 'alpha beta', caret: 10 }, 'b', { meta: true }))?.caret === 6)

// ── Deletions ────────────────────────────────────────────────────────
check('2a: Ctrl+W deletes the previous word',
  stateOf(btwComposerKey({ text: 'foo bar baz', caret: 11 }, 'w', { ctrl: true }))?.text === 'foo bar ')
check('2b: Option+Backspace deletes the previous word',
  stateOf(btwComposerKey({ text: 'foo bar baz', caret: 11 }, '', { meta: true, backspace: true }))?.text === 'foo bar ')
check('2c: Ctrl+U deletes the line prefix',
  stateOf(btwComposerKey({ text: 'one two', caret: 7 }, 'u', { ctrl: true }))?.text === '')
check('2d: Delete removes the code point AFTER the caret',
  stateOf(btwComposerKey({ text: 'ab👍c', caret: 2 }, '', { delete: true }))?.text === 'abc')
check('2e: Backspace removes the whole emoji before the caret',
  stateOf(btwComposerKey({ text: 'a👍b', caret: 3 }, '', { backspace: true }))?.text === 'ab')

// ── Line edges ───────────────────────────────────────────────────────
check('3a: Ctrl+A goes to the line start',
  stateOf(btwComposerKey({ text: 'one two', caret: 7 }, 'a', { ctrl: true }))?.caret === 0)
check('3b: Ctrl+E goes to the line end',
  stateOf(btwComposerKey({ text: 'one two', caret: 0 }, 'e', { ctrl: true }))?.caret === 7)

// ── Emoji word jump then typing ──────────────────────────────────────
{
  const jumped = stateOf(btwComposerKey({ text: 'beta 👍', caret: 6 }, '', { meta: true, leftArrow: true }))
  const typed = jumped === undefined ? undefined : stateOf(btwComposerKey(jumped, 'X', {}))
  check('4: word jump lands on the emoji start and typing lands before it',
    jumped?.caret === 5 && typed?.text === 'beta X👍', JSON.stringify({ jumped, typed }))
}

// ── Existing single-line rules stay ──────────────────────────────────
check('5a: Esc exits the edit focus', btwComposerKey({ text: 'x', caret: 1 }, '', { escape: true })?.exitFocus === true)
check('5b: ↑ exits the edit focus', btwComposerKey({ text: 'x', caret: 1 }, '', { upArrow: true })?.exitFocus === true)
check('5c: plain Enter submits', btwComposerKey({ text: 'x', caret: 1 }, '\r', { return: true })?.submit === true)
check('5d: a pasted line-break chunk is text, not Enter',
  btwComposerKey({ text: 'x', caret: 1 }, '\n', { isPasted: true })?.submit !== true)
check('5e: Shift+← stays with the host', btwComposerKey({ text: 'x', caret: 1 }, '', { shift: true, leftArrow: true }) === null)
check('5f: ← at the head stays with the host', btwComposerKey({ text: 'x', caret: 0 }, '', { leftArrow: true }) === null)
check('5g: Home/End are absolute in a single line',
  stateOf(btwComposerKey({ text: 'one', caret: 2 }, '', { home: true }))?.caret === 0
  && stateOf(btwComposerKey({ text: 'one', caret: 1 }, '', { end: true }))?.caret === 3)
check('5h: typing inserts at the caret',
  stateOf(btwComposerKey({ text: 'ac', caret: 1 }, 'b', {}))?.text === 'abc')

if (failures > 0) {
  console.log(`\n${failures} btw-composer key check(s) FAILED`)
  process.exit(1)
}
console.log('\nBtw composer key contract verified')
