/**
 * Read-only view of the TUI cross-process mount ledger.
 *
 * The authoritative writer and schema live in `src/sessionMounts.ts`
 * (`~/.dsh-tui/session-mounts.json`, version 1, `owners: [{ pid, startedAt,
 * sessionIds }]`). The CLI cannot import that module — `cli/` is a
 * build-free ESM layer whose only allowed imports are `node:*` and its own
 * files (`cli/test/boundary.test.mjs`) — so this is the read-only subset the
 * automation surface needs, kept next to the DSH adapter because "who is
 * driving this log" is what decides whether a write is safe.
 *
 * Two readings, on purpose: {@link readSessionOwners} is for display (damage
 * reads as "nobody mounted"), {@link readSessionOwnersStrict} is for decisions
 * ("cannot read the ledger" must never pass for "it is free").
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MOUNTS_FILE = 'session-mounts.json'
// Must match MOUNTS_VERSION in src/sessionMounts.ts.
const MOUNTS_VERSION = 1

/** Ledger path for a home directory. */
export function ledgerPath(home = homedir()) {
  return join(home, '.dsh-tui', MOUNTS_FILE)
}

/** Whether a pid is still alive; `EPERM` means another user's live process. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try { process.kill(pid, 0) } catch (error) { return error?.code === 'EPERM' }
  return true
}

function parseOwner(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const { pid, startedAt, sessionIds } = value
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  if (!Array.isArray(sessionIds)) return undefined
  return { pid, startedAt, sessionIds: sessionIds.filter(id => typeof id === 'string' && id.length > 0) }
}

/**
 * Read the ledger for DECIDING. A missing file is a genuinely empty ledger;
 * anything else that does not parse as a version-1 document is a refusal, and
 * callers must treat it as "cannot verify".
 * @param options.home - user home directory holding `.dsh-tui`.
 * @returns live owners by session id, or a refusal with a sentence naming what is wrong.
 */
export function readSessionOwnersStrict({ home = homedir() } = {}) {
  const path = ledgerPath(home)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, owners: new Map() }
    return { ok: false, detail: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { ok: false, detail: `${path} is not valid JSON` } }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, detail: `${path} is not a ledger document` }
  if (parsed.version !== MOUNTS_VERSION) return { ok: false, detail: `${path} has unknown version ${JSON.stringify(parsed.version)}` }
  if (!Array.isArray(parsed.owners)) return { ok: false, detail: `${path} has no owners array` }
  const owners = new Map()
  for (const record of parsed.owners) {
    const owner = parseOwner(record)
    if (owner === undefined) return { ok: false, detail: `${path} has a record whose shape is wrong` }
    if (!pidAlive(owner.pid)) continue
    for (const sessionId of owner.sessionIds) {
      const existing = owners.get(sessionId)
      // The protocol forbids two live owners; keep the one that started last.
      if (existing === undefined || existing.startedAt < owner.startedAt) owners.set(sessionId, owner)
    }
  }
  return { ok: true, owners }
}

/**
 * Read the ledger for DISPLAY: any damage reads as an empty ledger, dead
 * owners are dropped.
 * @param options.home - user home directory holding `.dsh-tui`.
 * @returns live owners by session id.
 */
export function readSessionOwners({ home = homedir() } = {}) {
  const result = readSessionOwnersStrict({ home })
  return result.ok ? result.owners : new Map()
}

/** Owner of one session id, or `undefined` when nobody holds it. */
export function ownerOf(owners, sessionId) {
  return owners.get(sessionId)
}
