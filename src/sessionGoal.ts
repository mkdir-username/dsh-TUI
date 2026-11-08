/**
 * The session goal for the footer's status row.
 *
 * Read by the session the footer already belongs to
 * (`channel.sessionRef.sessionId`), never by a pid walk: in dsh the walk misses
 * before the first hook run and the old fallback returned another session's
 * goal (incident 2026-11-06). Nothing is shown when the file is missing, broken
 * or the id could step outside the tasks dir — a finished goal (`status: done`)
 * stays visible, because the footer marks it ✅ instead of dropping it.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TASKS_DIR = join(homedir(), '.claude', 'sessions', '.tasks')

// Session ids are uuids; a dash-only body keeps `..` and slashes out of the path.
const SAFE_ID = /^[0-9a-f][0-9a-f-]{7,63}$/u

export function readSessionGoal(sessionId: string | undefined, dir: string = TASKS_DIR): string | undefined {
  if (typeof sessionId !== 'string') return undefined
  const id = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  if (!SAFE_ID.test(id)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${id}.task`), 'utf8')) as { task?: unknown }
    const task = parsed?.task
    if (typeof task !== 'string') return undefined
    const text = task.trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** `⌛ goal` while the turn runs, `✅ goal` once the session has stopped. */
export function sessionStatusLine(text: string | undefined, working: boolean): string | undefined {
  if (typeof text !== 'string') return undefined
  const goal = text.trim()
  if (goal === '') return undefined
  return `${working ? '⌛' : '✅'} ${goal}`
}
