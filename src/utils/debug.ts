import { appendFileSync } from 'node:fs'
import { DATA_DIR } from './paths.js'
import { join } from 'node:path'

/**
 * Debug logger for the renderer. Writes to stderr only when
 * `DSH_TUI_DEBUG` is set, so normal runs stay quiet.
 * @param message - The message to log.
 * @param fields - Optional JSON-serialized fields appended to the line.
 */
export function logForDebugging(message: string, fields?: Record<string, unknown>): void {
  if (!process.env.DSH_TUI_DEBUG) return
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
  process.stderr.write(`[dsh-tui] ${message}${suffix}\n`)
}

/**
 * Mouse-chain diagnostics: appends to `~/.dsh-tui/mouse-debug.log` when
 * `DSH_TUI_DEBUG_MOUSE` is set. Unlike logForDebugging (stderr), a file
 * keeps the fullscreen alt screen unpolluted and survives the session for
 * post-mortem reading. Every append is try/catch-guarded — diagnostics
 * must never take the UI down.
 * @param message - Stage name (e.g. 'mouse arrive', 'dispatchClick').
 * @param fields - Optional JSON-serialized fields appended to the line.
 */
export function logMouseDebug(message: string, fields?: Record<string, unknown>): void {
  if (!process.env.DSH_TUI_DEBUG_MOUSE) return
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
  try {
    const line = `${new Date().toISOString()} ${message}${suffix}\n`
    // 0600 on creation: the log mirrors UI activity, incl. message content
    appendFileSync(join(DATA_DIR, 'mouse-debug.log'), line, { mode: 0o600 })
  } catch {
    // ignore — see doc comment
  }
}

/**
 * Lifecycle breadcrumb: always appends to `~/.dsh-tui/lifecycle.log`.
 *
 * Why a file and not stderr: a TUI that quits without a signal and without a
 * funnel request (stdin went away, or an in-app exit) otherwise leaves nothing
 * behind — the session records `turn/end interrupted` but not what caused it,
 * and the terminal keeps no log. Exit is rare enough that the file stays small.
 * @param message - Stage name (e.g. 'app: exit requested').
 * @param fields - Optional JSON-serialized fields appended to the line.
 */
export function logLifecycle(message: string, fields?: Record<string, unknown>): void {
  try {
    const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
    appendFileSync(
      join(DATA_DIR, 'lifecycle.log'),
      `${new Date().toISOString()} pid=${process.pid} ${message}${suffix}\n`,
      { mode: 0o600 },
    )
  } catch {
    // Diagnostics must never take the UI down.
  }
}
