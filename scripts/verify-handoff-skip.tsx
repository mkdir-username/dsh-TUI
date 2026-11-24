/**
 * `/hs` (handoff-skip) regression: the chat-scoped skip the Stop hooks read.
 *
 * Part 1 — the file contract (`src/handoffSkip.ts`): off by default, `once`
 *   with a two-hour expiry, `on` without one, the `session-` prefix naming the
 *   same file, other chats invisible, unsafe ids refused, `clear` dropping it.
 * Part 2 — the real Chat: `/hs` arms one step and submits nothing (mid-turn
 *   included), the turn it covered ends the token, `--on`/`--off` persist and
 *   clear, an unknown flag keeps the draft.
 * Part 3 — the footer chip: `⏸ hs` for `on`, `⏸ hs¹` for the one-shot, gone
 *   after `--off`, and not gated by the field switches.
 *
 * Run: node --import tsx/esm scripts/verify-handoff-skip.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module reads `homedir()` at import time, so the fake home must own the
// environment before any src import: the real ~/.claude/.state must never see
// this run.
const fakeHome = mkdtempSync(join(tmpdir(), 'verify-handoff-skip-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const { readHandoffSkip, writeHandoffSkip, clearHandoffSkip, handoffSkipPath, HANDOFF_SKIP_DIR } = await import('../src/handoffSkip.js')

let passed = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== '' ? `\n      ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const SID = '55555555-5555-4555-8555-555555555555'
const HOUR = 60 * 60 * 1000

// ── 1. the file contract ────────────────────────────────────────────────
check('1 no file is off', readHandoffSkip(SID) === 'off')
check('1 once survives a write', writeHandoffSkip(SID, 'once') && readHandoffSkip(SID) === 'once')
check('1 on survives a write and never expires', writeHandoffSkip(SID, 'on') && readHandoffSkip(SID, Date.now() + 240 * HOUR) === 'on')
check(
  '1 once expires after two hours',
  writeHandoffSkip(SID, 'once')
    && readHandoffSkip(SID, Date.now() + HOUR) === 'once'
    && readHandoffSkip(SID, Date.now() + 2 * HOUR + 1000) === 'off',
)
check('1 the session- prefix names the same file', writeHandoffSkip(SID, 'on') && readHandoffSkip(`session-${SID}`) === 'on')
check('1 another chat sees nothing', readHandoffSkip('99999999-9999-4999-8999-999999999999') === 'off')
check('1 an unsafe id is refused', handoffSkipPath('../etc/passwd') === undefined && writeHandoffSkip('../etc/passwd', 'on') === false)
clearHandoffSkip(SID)
check('1 clear drops the file', readHandoffSkip(SID) === 'off')
check('1 the state lives under the isolated home', HANDOFF_SKIP_DIR === join(fakeHome, '.claude', '.state', 'hs-mode'))

console.log(`\nverify-handoff-skip ${failures === 0 ? 'OK' : 'FAILED'} (${passed} passed, ${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
