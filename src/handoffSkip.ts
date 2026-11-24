/**
 * The chat-scoped `/hs` flag (handoff-skip): the TUI's half of a contract with
 * the DSH Stop hooks. The hooks never ask the TUI — they read one file, and
 * this module is its only writer.
 *
 *   ~/.claude/.state/hs-mode/<session>.hs
 *     line 1  once | on
 *     line 2  epoch SECONDS; 0 for `on` (no expiry)
 *
 * `once` covers the turn in progress (the step the user is in), `on` covers
 * every later turn until `/hs --off`. A missing, unreadable or expired file is
 * `off`: the controller must never be silenced by a stale token.
 *
 * The hook half is `~/.claude/hooks/_hs-mode.sh`; both sides read this format.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type HandoffSkipMode = 'off' | 'once' | 'on'

export const HANDOFF_SKIP_DIR = join(homedir(), '.claude', '.state', 'hs-mode')
/** A one-shot token outlives a turn by orders of magnitude, never a day. */
export const ONCE_TTL_SEC = 2 * 60 * 60
// Session ids are uuids; a dash-only body keeps `..` and slashes out of the path.
const SAFE_ID = /^[0-9a-f][0-9a-f-]{7,63}$/u

function normalize(sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string') return undefined
  const id = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return SAFE_ID.test(id) ? id : undefined
}

export function handoffSkipPath(sessionId: string | undefined, dir: string = HANDOFF_SKIP_DIR): string | undefined {
  const id = normalize(sessionId)
  return id === undefined ? undefined : join(dir, `${id}.hs`)
}

export function readHandoffSkip(sessionId: string | undefined, now: number = Date.now(), dir: string = HANDOFF_SKIP_DIR): HandoffSkipMode {
  const path = handoffSkipPath(sessionId, dir)
  if (path === undefined) return 'off'
  try {
    const [mode, expiry] = readFileSync(path, 'utf8').split('\n')
    if (mode === 'on') return 'on'
    if (mode !== 'once') return 'off'
    const until = Number(expiry)
    return Number.isFinite(until) && until > Math.floor(now / 1000) ? 'once' : 'off'
  } catch {
    return 'off'
  }
}

export function writeHandoffSkip(sessionId: string | undefined, mode: 'once' | 'on', now: number = Date.now(), dir: string = HANDOFF_SKIP_DIR): boolean {
  const path = handoffSkipPath(sessionId, dir)
  if (path === undefined) return false
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // A hook may read at any instant: write a sibling and rename, so it never
    // sees half a file.
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${mode}\n${mode === 'once' ? Math.floor(now / 1000) + ONCE_TTL_SEC : 0}\n`, { mode: 0o600 })
    renameSync(temp, path)
    return true
  } catch {
    return false
  }
}

export function clearHandoffSkip(sessionId: string | undefined, dir: string = HANDOFF_SKIP_DIR): void {
  const path = handoffSkipPath(sessionId, dir)
  if (path === undefined) return
  // A missing file is the goal: the caller is clearing, not probing.
  rmSync(path, { force: true })
}
